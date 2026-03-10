// ============================================
// JRPG Targeting System - Session Controller
// File: jrpg-targeting-session.js
// Foundry VTT V12
// ============================================

import {
  GLOBALS,
  MODES,
  NOTIFICATIONS,
  RESULT_STATUS,
  TARGET_CATEGORIES,
  UI
} from "./jrpg-targeting-constants.js";

import {
  createJRPGTargetingDebugger,
  makeJRPGTargetingRunId
} from "./jrpg-targeting-debug.js";

import {
  getJRPGSkillTargetFromAction,
  parseJRPGTargetingText
} from "./jrpg-targeting-parser.js";

import {
  buildJRPGTargetRulesSummary,
  countJRPGBasicTargets,
  doesJRPGModeAllowManualSelection,
  getJRPGAutoSelectedTargets,
  getJRPGEligibleSceneTokens,
  normalizeJRPGTargetCollection,
  validateJRPGTargetAttempt,
  validateJRPGTargetConfirmation
} from "./jrpg-targeting-rules.js";

import {
  clearJRPGActiveTargetingSession,
  clearJRPGTargetingSessionForUser,
  getJRPGActiveTargetingSession,
  setJRPGActiveTargetingSession,
  setJRPGTargetingSessionForUser,
  storeJRPGCancelledTargets,
  storeJRPGConfirmedTargets
} from "./jrpg-targeting-store.js";

import {
  createJRPGTargetingUI,
  destroyActiveJRPGTargetingUI
} from "./jrpg-targeting-ui.js";

const dbg = createJRPGTargetingDebugger("Session");

/* -------------------------------------------- */
/* Internal helpers                             */
/* -------------------------------------------- */

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return Array.from(value);
  if (typeof value[Symbol.iterator] === "function") return Array.from(value);
  return [value];
}

function compactArray(value) {
  return toArray(value).filter(Boolean);
}

function getCurrentUser() {
  return game.user ?? null;
}

function getCurrentUserId() {
  return getCurrentUser()?.id ?? null;
}

function getCanvasView() {
  return canvas?.app?.view ?? null;
}

function isCanvasReady() {
  return Boolean(canvas?.ready && canvas?.tokens);
}

function swallowEvent(event, label = "EVENT", runId = "") {
  try {
    dbg.logRun(runId, `${label} SWALLOWED`, {
      type: event?.type,
      button: event?.button,
      key: event?.key
    });

    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
  } catch (err) {
    dbg.errorRun(runId, `${label} SWALLOW FAILED`, err);
  }
}

function notifyInfo(message) {
  ui?.notifications?.info?.(message);
}

function notifyWarn(message) {
  ui?.notifications?.warn?.(message);
}

function notifyError(message) {
  ui?.notifications?.error?.(message);
}

function getTokenName(token) {
  return token?.name ?? token?.document?.name ?? token?.actor?.name ?? "(Unknown Token)";
}

function getTokenUuid(token) {
  return token?.document?.uuid ?? token?.uuid ?? null;
}

function getTokenActor(token) {
  return token?.actor ?? token?.document?.actor ?? null;
}

function getTokenDocument(token) {
  return token?.document ?? token ?? null;
}

function getTokenInfo(token) {
  if (!token) return null;

  return {
    tokenName: getTokenName(token),
    tokenId: token?.id ?? token?.document?.id ?? null,
    tokenUuid: getTokenUuid(token),
    actorName: getTokenActor(token)?.name ?? null,
    actorId: getTokenActor(token)?.id ?? null,
    actorUuid: getTokenActor(token)?.uuid ?? null,
    disposition: getTokenDocument(token)?.disposition ?? null,
    x: token?.x ?? token?.object?.x ?? null,
    y: token?.y ?? token?.object?.y ?? null,
    w: token?.w ?? token?.object?.w ?? null,
    h: token?.h ?? token?.object?.h ?? null
  };
}

function getSceneTokens() {
  return compactArray(canvas?.tokens?.placeables ?? []).filter((token) => {
    if (!token?.visible) return false;
    if (token?.document?.hidden) return false;
    return true;
  });
}

function getUserTargets(user = getCurrentUser()) {
  return Array.from(user?.targets ?? []);
}

function clearUserTargets({
  user = getCurrentUser(),
  reason = "cleanup",
  runId = ""
} = {}) {
  const targets = getUserTargets(user);

  dbg.logRun(runId, "CLEAR TARGETS START", {
    reason,
    count: targets.length,
    targets: targets.map(getTokenInfo)
  });

  for (const token of targets) {
    try {
      token.setTarget(false, {
        user,
        releaseOthers: false,
        groupSelection: true
      });
    } catch (err) {
      dbg.errorRun(runId, "UNTARGET FAILED", { token: getTokenInfo(token), err });
    }
  }

  dbg.logRun(runId, "CLEAR TARGETS END");
}

function setTokenTarget(token, targeted, user = getCurrentUser()) {
  token?.setTarget?.(Boolean(targeted), {
    user,
    releaseOthers: false,
    groupSelection: true
  });
}

function getCanvasPointFromEvent(event) {
  const view = getCanvasView();
  const rect = view.getBoundingClientRect();

  const px = (event.clientX - rect.left) * (view.width / rect.width);
  const py = (event.clientY - rect.top) * (view.height / rect.height);

  const screenPoint = new PIXI.Point(px, py);
  const worldPoint = canvas.stage.worldTransform.applyInverse(screenPoint);

  return {
    x: worldPoint.x,
    y: worldPoint.y,
    px,
    py
  };
}

function getTokenAtCanvasPoint(x, y) {
  const tokens = [...getSceneTokens()].reverse();

  return tokens.find((token) => {
    return (
      x >= token.x &&
      x <= token.x + token.w &&
      y >= token.y &&
      y <= token.y + token.h
    );
  }) ?? null;
}

async function resolveSelfTargetToken({
  sourceActorUuid = null,
  runId = ""
} = {}) {
  dbg.logRun(runId, "RESOLVE SELF TARGET START", {
    sourceActorUuid
  });

  if (!sourceActorUuid) {
    dbg.warnRun(runId, "RESOLVE SELF TARGET FAILED - Missing sourceActorUuid");
    return null;
  }

  let sourceDoc = null;

  try {
    sourceDoc = await fromUuid(sourceActorUuid);
  } catch (err) {
    dbg.errorRun(runId, "RESOLVE SELF TARGET fromUuid FAILED", {
      sourceActorUuid,
      err
    });
    return null;
  }

  if (!sourceDoc) {
    dbg.warnRun(runId, "RESOLVE SELF TARGET FAILED - Source document not found", {
      sourceActorUuid
    });
    return null;
  }

  // If the UUID already resolves to a TokenDocument.
  if (sourceDoc?.documentName === "Token") {
    const token = sourceDoc?.object ?? sourceDoc;
    dbg.logRun(runId, "RESOLVE SELF TARGET -> TokenDocument", {
      token: getTokenInfo(token)
    });
    return token;
  }

  // If the UUID resolves to a synthetic actor owned by a token.
  if (sourceDoc?.parent?.documentName === "Token") {
    const token = sourceDoc.parent?.object ?? sourceDoc.parent;
    dbg.logRun(runId, "RESOLVE SELF TARGET -> Synthetic Actor Parent Token", {
      token: getTokenInfo(token)
    });
    return token;
  }

  // If the resolved actor has a token reference.
  if (sourceDoc?.token) {
    const token = sourceDoc.token?.object ?? sourceDoc.token;
    if (token) {
      dbg.logRun(runId, "RESOLVE SELF TARGET -> Actor.token", {
        token: getTokenInfo(token)
      });
      return token;
    }
  }

  // Fallback: search visible scene tokens by actor id / actor uuid.
  const sceneTokens = getSceneTokens();
  const sourceActorId = sourceDoc?.id ?? null;
  const resolvedActorUuid = sourceDoc?.uuid ?? null;

  const matched = sceneTokens.find((token) => getTokenActor(token)?.uuid === sourceActorUuid)
    ?? sceneTokens.find((token) => getTokenActor(token)?.uuid === resolvedActorUuid)
    ?? sceneTokens.find((token) => getTokenActor(token)?.id === sourceActorId)
    ?? null;

  dbg.logRun(runId, "RESOLVE SELF TARGET FALLBACK RESULT", {
    matched: getTokenInfo(matched)
  });

  return matched;
}

function buildResolvedResult({
  status,
  sessionId,
  userId,
  parsedTargeting,
  rawSkillTarget,
  tokens = []
} = {}) {
  const finalTokens = normalizeJRPGTargetCollection(tokens);
  const finalActors = compactArray(finalTokens.map((token) => getTokenActor(token)));

  return {
    ok: status === RESULT_STATUS.CONFIRMED,
    confirmed: status === RESULT_STATUS.CONFIRMED,
    cancelled: status === RESULT_STATUS.CANCELLED,
    status,

    sessionId: sessionId ?? null,
    userId: userId ?? null,

    rawSkillTarget: rawSkillTarget ?? "",
    normalizedSkillTarget: parsedTargeting?.normalized ?? "",
    mode: parsedTargeting?.mode ?? null,
    category: parsedTargeting?.category ?? TARGET_CATEGORIES.CREATURE,
    promptText: parsedTargeting?.promptText ?? "",

    selectedCount: finalTokens.length,

    tokens: finalTokens,
    actors: finalActors,

    tokenUuids: finalTokens.map((t) => getTokenUuid(t)).filter(Boolean),
    actorUuids: finalActors.map((a) => a?.uuid).filter(Boolean)
  };
}

function buildActiveSessionSnapshot(instance) {
  return {
    sessionId: instance.sessionId,
    runId: instance.runId,
    userId: instance.userId,
    started: instance.state.started,
    active: instance.state.active,
    promptText: instance.parsedTargeting?.promptText ?? "",
    mode: instance.parsedTargeting?.mode ?? null,
    category: instance.parsedTargeting?.category ?? null,
    rawSkillTarget: instance.rawSkillTarget,
    sourceActorUuid: instance.sourceActorUuid ?? null
  };
}

/* -------------------------------------------- */
/* Session Class                                */
/* -------------------------------------------- */

export class JRPGTargetingSession {
  constructor(options = {}) {
    this.sessionId = options.sessionId || makeJRPGTargetingRunId("TGT");
    this.runId = this.sessionId;

    this.userId = options.userId ?? getCurrentUserId();
    this.action = options.action ?? null;
    this.sourceActorUuid = options.sourceActorUuid ?? null;

    this.rawSkillTarget = typeof options.skillTarget === "string"
      ? options.skillTarget
      : getJRPGSkillTargetFromAction(this.action);

    this.parsedTargeting = options.parsedTargeting ?? parseJRPGTargetingText(this.rawSkillTarget);
    this.rulesSummary = buildJRPGTargetRulesSummary(this.parsedTargeting);

    this.uiSettings = options.uiSettings ?? {};
    this.uiTitleText = options.uiTitleText || this.parsedTargeting?.promptText || UI.TEXT.DEFAULT_TITLE;

    this.uiInstance = null;
    this.selfTargetToken = null;

    this.hooks = {
      targetToken: null
    };

    this.listeners = {
      pointerdown: null,
      pointerup: null,
      click: null,
      dblclick: null,
      contextmenu: null,
      keydown: null
    };

    this.state = {
      started: false,
      active: false,
      resolved: false,
      destroyed: false
    };

    this.result = null;

    this.resultPromise = new Promise((resolve) => {
      this._resolveResult = resolve;
    });

    dbg.logRun(this.runId, "CTOR", {
      userId: this.userId,
      rawSkillTarget: this.rawSkillTarget,
      sourceActorUuid: this.sourceActorUuid,
      parsedTargeting: this.parsedTargeting,
      rulesSummary: this.rulesSummary
    });
  }

  /* ---------------------------------------- */
  /* Base getters                             */
  /* ---------------------------------------- */

  isLocalUserSession() {
    return this.userId === getCurrentUserId();
  }

  getSelectedTargets() {
    return getUserTargets(getCurrentUser());
  }

  getEligibleSceneTargets() {
    if (this.parsedTargeting?.mode === MODES.SELF) {
      return this.selfTargetToken ? [this.selfTargetToken] : [];
    }

    return getJRPGEligibleSceneTokens({
      sceneTokens: getSceneTokens(),
      parsedTargeting: this.parsedTargeting
    });
  }

  updateCountUI() {
    if (!this.uiInstance) return;

    const count = countJRPGBasicTargets(this.getSelectedTargets());
    this.uiInstance.updateCount(count);

    dbg.logRun(this.runId, "UI COUNT UPDATED", { count });
  }

  createSessionSnapshot() {
    return buildActiveSessionSnapshot(this);
  }

  /* ---------------------------------------- */
  /* Startup                                  */
  /* ---------------------------------------- */

  async start() {
    dbg.logRun(this.runId, "START");

    if (!isCanvasReady()) {
      notifyError("Canvas is not ready.");
      this.failAndResolve("Canvas is not ready.");
      return this.resultPromise;
    }

    if (!this.isLocalUserSession()) {
      const message = "This client is not the active targeting user.";
      notifyWarn(message);
      this.failAndResolve(message);
      return this.resultPromise;
    }

    const existing = getJRPGActiveTargetingSession();
    if (existing?.sessionId && existing.sessionId !== this.sessionId) {
      dbg.warnRun(this.runId, "EXISTING ACTIVE SESSION DETECTED", existing);
      notifyWarn(NOTIFICATIONS.ACTIVE_SESSION_EXISTS);
      this.failAndResolve(NOTIFICATIONS.ACTIVE_SESSION_EXISTS);
      return this.resultPromise;
    }

    this.state.started = true;
    this.state.active = true;

    globalThis[GLOBALS.ACTIVE_SESSION_KEY] = this;

    setJRPGActiveTargetingSession(this.createSessionSnapshot());
    setJRPGTargetingSessionForUser(this.userId, this.createSessionSnapshot());

    await destroyActiveJRPGTargetingUI({ animate: false }).catch(() => {});

    this.uiInstance = createJRPGTargetingUI({
      instanceId: this.sessionId,
      sessionId: this.sessionId,
      userId: this.userId,
      titleText: this.uiTitleText,
      countText: UI.TEXT.DEFAULT_COUNT_ZERO,
      settings: this.uiSettings
    });

    this.uiInstance
      .setConfirmHandler(async () => this.confirm())
      .setCancelHandler(async () => this.cancel("cancel_button"));

    await this.uiInstance.show({ animate: true });

    clearUserTargets({
      user: getCurrentUser(),
      reason: "enter_targeting_mode",
      runId: this.runId
    });

    this.installHooks();

    if (doesJRPGModeAllowManualSelection(this.parsedTargeting)) {
      this.installCanvasListeners();
    } else {
      dbg.logRun(this.runId, "MANUAL SELECTION DISABLED FOR THIS MODE");
    }

    this.installKeyboardListener();
    await this.applyAutoSelectIfNeeded();

    this.updateCountUI();

    notifyInfo("Targeting mode is now active.");

    dbg.logRun(this.runId, "TARGETING MODE ACTIVE", {
      rulesSummary: this.rulesSummary
    });

    return this.resultPromise;
  }

  failAndResolve(message = "Targeting session failed.") {
    const result = {
      ok: false,
      confirmed: false,
      cancelled: true,
      status: RESULT_STATUS.CANCELLED,
      sessionId: this.sessionId,
      userId: this.userId,
      error: message,
      rawSkillTarget: this.rawSkillTarget,
      normalizedSkillTarget: this.parsedTargeting?.normalized ?? "",
      mode: this.parsedTargeting?.mode ?? null,
      category: this.parsedTargeting?.category ?? TARGET_CATEGORIES.CREATURE,
      promptText: this.parsedTargeting?.promptText ?? "",
      selectedCount: 0,
      tokens: [],
      actors: [],
      tokenUuids: [],
      actorUuids: []
    };

    this.resolveResult(result);
  }

  /* ---------------------------------------- */
  /* Hooks / listeners                        */
  /* ---------------------------------------- */

  installHooks() {
    this.hooks.targetToken = Hooks.on("targetToken", (user, token, targeted) => {
      if (!this.state.active) return;
      if (user?.id !== this.userId) return;

      dbg.logRun(this.runId, "HOOK targetToken", {
        userId: user?.id,
        targeted,
        token: getTokenInfo(token),
        currentTargets: this.getSelectedTargets().map(getTokenInfo)
      });

      this.updateCountUI();
    });

    dbg.logRun(this.runId, "HOOKS INSTALLED");
  }

  removeHooks() {
    if (this.hooks.targetToken) {
      Hooks.off("targetToken", this.hooks.targetToken);
      this.hooks.targetToken = null;
    }

    dbg.logRun(this.runId, "HOOKS REMOVED");
  }

  installCanvasListeners() {
    const view = getCanvasView();
    if (!view) return;

    this.listeners.pointerdown = (event) => this.onCanvasPointerDown(event);
    this.listeners.pointerup = (event) => this.onCanvasPointerUp(event);
    this.listeners.click = (event) => this.onCanvasClick(event);
    this.listeners.dblclick = (event) => this.onCanvasDblClick(event);
    this.listeners.contextmenu = (event) => this.onCanvasContextMenu(event);

    view.addEventListener("pointerdown", this.listeners.pointerdown, true);
    view.addEventListener("pointerup", this.listeners.pointerup, true);
    view.addEventListener("click", this.listeners.click, true);
    view.addEventListener("dblclick", this.listeners.dblclick, true);
    view.addEventListener("contextmenu", this.listeners.contextmenu, true);

    dbg.logRun(this.runId, "CANVAS LISTENERS INSTALLED");
  }

  removeCanvasListeners() {
    const view = getCanvasView();
    if (!view) return;

    if (this.listeners.pointerdown) view.removeEventListener("pointerdown", this.listeners.pointerdown, true);
    if (this.listeners.pointerup) view.removeEventListener("pointerup", this.listeners.pointerup, true);
    if (this.listeners.click) view.removeEventListener("click", this.listeners.click, true);
    if (this.listeners.dblclick) view.removeEventListener("dblclick", this.listeners.dblclick, true);
    if (this.listeners.contextmenu) view.removeEventListener("contextmenu", this.listeners.contextmenu, true);

    this.listeners.pointerdown = null;
    this.listeners.pointerup = null;
    this.listeners.click = null;
    this.listeners.dblclick = null;
    this.listeners.contextmenu = null;

    dbg.logRun(this.runId, "CANVAS LISTENERS REMOVED");
  }

  installKeyboardListener() {
    this.listeners.keydown = (event) => this.onKeyDown(event);
    window.addEventListener("keydown", this.listeners.keydown, true);

    dbg.logRun(this.runId, "KEYBOARD LISTENER INSTALLED");
  }

  removeKeyboardListener() {
    if (this.listeners.keydown) {
      window.removeEventListener("keydown", this.listeners.keydown, true);
      this.listeners.keydown = null;
    }

    dbg.logRun(this.runId, "KEYBOARD LISTENER REMOVED");
  }

  /* ---------------------------------------- */
  /* Event handlers                           */
  /* ---------------------------------------- */

  onCanvasPointerDown(event) {
    if (!this.state.active) return;

    if (event.button !== 0) {
      dbg.logRun(this.runId, "POINTERDOWN IGNORED (not left click)", {
        button: event.button
      });
      return;
    }

    swallowEvent(event, "POINTERDOWN", this.runId);

    let point = null;
    let token = null;

    try {
      point = getCanvasPointFromEvent(event);
      token = getTokenAtCanvasPoint(point.x, point.y);
    } catch (err) {
      dbg.errorRun(this.runId, "POINTERDOWN PROCESS FAILED", err);
      return;
    }

    dbg.logRun(this.runId, "POINTERDOWN HIT TEST", {
      point,
      token: getTokenInfo(token)
    });

    if (!token) return;

    const validation = validateJRPGTargetAttempt({
      parsedTargeting: this.parsedTargeting,
      currentTargets: this.getSelectedTargets(),
      candidateToken: token
    });

    if (!validation.ok) {
      if (validation.notification) notifyWarn(validation.notification);
      dbg.warnRun(this.runId, "TARGET ATTEMPT BLOCKED", {
        validation,
        token: getTokenInfo(token)
      });
      return;
    }

    try {
      if (validation.action === "untarget") {
        setTokenTarget(token, false, getCurrentUser());
      } else {
        setTokenTarget(token, true, getCurrentUser());
      }
    } catch (err) {
      dbg.errorRun(this.runId, "TARGET TOGGLE FAILED", {
        validation,
        token: getTokenInfo(token),
        err
      });
      return;
    }

    dbg.logRun(this.runId, "TARGET TOGGLE OK", {
      action: validation.action,
      token: getTokenInfo(token),
      currentTargets: this.getSelectedTargets().map(getTokenInfo)
    });

    this.updateCountUI();
  }

  onCanvasPointerUp(event) {
    if (!this.state.active) return;
    swallowEvent(event, "POINTERUP", this.runId);
  }

  onCanvasClick(event) {
    if (!this.state.active) return;
    swallowEvent(event, "CLICK", this.runId);
  }

  onCanvasDblClick(event) {
    if (!this.state.active) return;
    swallowEvent(event, "DBLCLICK", this.runId);
  }

  onCanvasContextMenu(event) {
    if (!this.state.active) return;
    swallowEvent(event, "CONTEXTMENU", this.runId);
  }

  onKeyDown(event) {
    if (!this.state.active) return;

    if (event.key === "Escape") {
      dbg.logRun(this.runId, "ESC PRESSED -> CANCEL");
      swallowEvent(event, "ESCAPE", this.runId);
      this.cancel("escape_cancel");
    }
  }

  /* ---------------------------------------- */
  /* Mode-specific setup                      */
  /* ---------------------------------------- */

  async applyAutoSelectIfNeeded() {
    if (this.parsedTargeting?.mode === MODES.SELF) {
      this.selfTargetToken = await resolveSelfTargetToken({
        sourceActorUuid: this.sourceActorUuid,
        runId: this.runId
      });

      if (!this.selfTargetToken) {
        dbg.warnRun(this.runId, "SELF AUTO-SELECT FAILED", {
          sourceActorUuid: this.sourceActorUuid
        });
        notifyWarn("No valid self target found.");
        return;
      }

      dbg.logRun(this.runId, "SELF AUTO-SELECT START", {
        token: getTokenInfo(this.selfTargetToken)
      });

      try {
        setTokenTarget(this.selfTargetToken, true, getCurrentUser());
      } catch (err) {
        dbg.errorRun(this.runId, "SELF AUTO-SELECT TARGET FAILED", {
          token: getTokenInfo(this.selfTargetToken),
          err
        });
        notifyWarn("No valid self target found.");
        return;
      }

      this.updateCountUI();

      dbg.logRun(this.runId, "SELF AUTO-SELECT END", {
        currentTargets: this.getSelectedTargets().map(getTokenInfo)
      });

      return;
    }

    const autoTargets = getJRPGAutoSelectedTargets({
      parsedTargeting: this.parsedTargeting,
      sceneTokens: getSceneTokens()
    });

    if (!autoTargets.length) {
      dbg.logRun(this.runId, "AUTO-SELECT NONE", {
        mode: this.parsedTargeting?.mode
      });

      if (!doesJRPGModeAllowManualSelection(this.parsedTargeting)) {
        notifyWarn(`No valid ${this.parsedTargeting?.category ?? "creature"} targets found.`);
      }

      return;
    }

    dbg.logRun(this.runId, "AUTO-SELECT START", {
      count: autoTargets.length,
      targets: autoTargets.map(getTokenInfo)
    });

    for (const token of autoTargets) {
      try {
        setTokenTarget(token, true, getCurrentUser());
      } catch (err) {
        dbg.errorRun(this.runId, "AUTO-SELECT FAILED", {
          token: getTokenInfo(token),
          err
        });
      }
    }

    this.updateCountUI();

    dbg.logRun(this.runId, "AUTO-SELECT END", {
      currentTargets: this.getSelectedTargets().map(getTokenInfo)
    });
  }

  /* ---------------------------------------- */
  /* Confirm / cancel                         */
  /* ---------------------------------------- */

  async confirm() {
    if (!this.state.active) return false;

    const selectedTargets = this.getSelectedTargets();
    const eligibleSceneTargets = this.getEligibleSceneTargets();

    const validation = validateJRPGTargetConfirmation({
      parsedTargeting: this.parsedTargeting,
      selectedTargets,
      eligibleSceneTokens: eligibleSceneTargets
    });

    dbg.logRun(this.runId, "CONFIRM ATTEMPT", {
      validation,
      selectedTargets: selectedTargets.map(getTokenInfo),
      eligibleTargets: eligibleSceneTargets.map(getTokenInfo)
    });

    if (!validation.ok) {
      if (validation.notification) notifyWarn(validation.notification);
      return false;
    }

    const result = buildResolvedResult({
      status: RESULT_STATUS.CONFIRMED,
      sessionId: this.sessionId,
      userId: this.userId,
      parsedTargeting: this.parsedTargeting,
      rawSkillTarget: this.rawSkillTarget,
      tokens: selectedTargets
    });

    storeJRPGConfirmedTargets({
      userId: this.userId,
      sessionId: this.sessionId,
      parsedTargeting: this.parsedTargeting,
      rawSkillTarget: this.rawSkillTarget,
      normalizedSkillTarget: this.parsedTargeting?.normalized ?? "",
      promptText: this.parsedTargeting?.promptText ?? "",
      tokens: result.tokens,
      actors: result.actors
    });

    await this.exit({
      reason: "confirm",
      status: RESULT_STATUS.CONFIRMED,
      notice: NOTIFICATIONS.TARGETING_CONFIRMED,
      preserveResult: result
    });

    return true;
  }

  async cancel(reason = "cancelled") {
    if (!this.state.active && this.state.resolved) return false;

    dbg.logRun(this.runId, "CANCEL", { reason });

    storeJRPGCancelledTargets({
      userId: this.userId,
      sessionId: this.sessionId,
      parsedTargeting: this.parsedTargeting,
      rawSkillTarget: this.rawSkillTarget,
      normalizedSkillTarget: this.parsedTargeting?.normalized ?? "",
      promptText: this.parsedTargeting?.promptText ?? ""
    });

    const result = buildResolvedResult({
      status: RESULT_STATUS.CANCELLED,
      sessionId: this.sessionId,
      userId: this.userId,
      parsedTargeting: this.parsedTargeting,
      rawSkillTarget: this.rawSkillTarget,
      tokens: []
    });

    await this.exit({
      reason,
      status: RESULT_STATUS.CANCELLED,
      notice: NOTIFICATIONS.TARGETING_CANCELLED,
      preserveResult: result
    });

    return true;
  }

  /* ---------------------------------------- */
  /* Exit / cleanup                           */
  /* ---------------------------------------- */

  async exit({
    reason = "normal_exit",
    status = RESULT_STATUS.CANCELLED,
    notice = NOTIFICATIONS.TARGETING_ENDED,
    preserveResult = null
  } = {}) {
    if (this.state.destroyed) return;

    dbg.logRun(this.runId, "EXIT START", {
      reason,
      status
    });

    this.state.active = false;

    try {
      this.removeHooks();
      this.removeCanvasListeners();
      this.removeKeyboardListener();

      await this.uiInstance?.destroy?.({ animate: true });
      this.uiInstance = null;

      clearUserTargets({
        user: getCurrentUser(),
        reason,
        runId: this.runId
      });

      clearJRPGTargetingSessionForUser(this.userId);

      const active = getJRPGActiveTargetingSession();
      if (active?.sessionId === this.sessionId) {
        clearJRPGActiveTargetingSession();
      }

      if (globalThis[GLOBALS.ACTIVE_SESSION_KEY]?.sessionId === this.sessionId) {
        delete globalThis[GLOBALS.ACTIVE_SESSION_KEY];
      }

      this.selfTargetToken = null;
      this.state.destroyed = true;

      const result = preserveResult ?? buildResolvedResult({
        status,
        sessionId: this.sessionId,
        userId: this.userId,
        parsedTargeting: this.parsedTargeting,
        rawSkillTarget: this.rawSkillTarget,
        tokens: []
      });

      this.resolveResult(result);

      if (notice) {
        if (status === RESULT_STATUS.CONFIRMED) notifyInfo(notice);
        else notifyInfo(notice);
      }
    } catch (err) {
      dbg.errorRun(this.runId, "EXIT CLEANUP FAILED", err);

      const result = preserveResult ?? {
        ok: false,
        confirmed: false,
        cancelled: true,
        status: RESULT_STATUS.CANCELLED,
        error: String(err?.message ?? err),
        sessionId: this.sessionId,
        userId: this.userId,
        rawSkillTarget: this.rawSkillTarget,
        normalizedSkillTarget: this.parsedTargeting?.normalized ?? "",
        mode: this.parsedTargeting?.mode ?? null,
        category: this.parsedTargeting?.category ?? TARGET_CATEGORIES.CREATURE,
        promptText: this.parsedTargeting?.promptText ?? "",
        selectedCount: 0,
        tokens: [],
        actors: [],
        tokenUuids: [],
        actorUuids: []
      };

      this.resolveResult(result);
    }

    dbg.logRun(this.runId, "EXIT END");
  }

  resolveResult(result) {
    if (this.state.resolved) return;

    this.state.resolved = true;
    this.result = result;

    dbg.logRun(this.runId, "RESOLVE RESULT", {
      ok: result?.ok,
      status: result?.status,
      selectedCount: result?.selectedCount
    });

    this._resolveResult?.(result);
  }
}

/* -------------------------------------------- */
/* Factory helpers                              */
/* -------------------------------------------- */

export function createJRPGTargetingSession(options = {}) {
  return new JRPGTargetingSession(options);
}

export async function startJRPGTargetingSession(options = {}) {
  const session = createJRPGTargetingSession(options);
  const result = await session.start();
  return result;
}

export default {
  JRPGTargetingSession,
  createJRPGTargetingSession,
  startJRPGTargetingSession
};
