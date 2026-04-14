// scripts/action-execution-core.js
// Foundry VTT V12
// Shared GM-side action resolution core for both:
//   1) manual Action Card confirm flow
//   2) future Auto Passive / Auto Reaction flow
//
// Design goal:
// - Keep chat/UI concerns OUTSIDE this file.
// - Keep the real execution/commit logic INSIDE this file.
// - Expose a stable API other scripts can call.
//
// Public API:
//   await window.FUCompanion.api.actionExecution.execute({
//     actionContext     : <ActionDataComputation payload>,
//     args              : <optional execution args>,
//     chatMsgId         : <optional chat message id>,
//     executionMode     : "manualCard" | "autoPassive",
//     confirmingUserId  : <optional user id>,
//     skipVisualFeedback: false
//   });
//
// Notes:
// - This script does NOT grey out buttons, stamp chat cards, or emit sockets.
//   That remains the responsibility of applyDamage-button.js.
// - Passive visual feedback is future-safe: if a passive visual API exists later,
//   this core will call it. If not, it safely skips.

(() => {
  const API_ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  API_ROOT.api = API_ROOT.api || {};

  const TAG = "[ONI][ActionExecute]";
  const DEBUG = true; // set false when stable

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => DEBUG && console.warn(TAG, ...a);
  const err = (...a) => DEBUG && console.error(TAG, ...a);
  const gateLog = (...a) => DEBUG && console.log(PASSIVE_GATE_TAG, ...a);
  const gateWarn = (...a) => DEBUG && console.warn(PASSIVE_GATE_TAG, ...a);

  const MODULE_NS = "fabula-ultima-companion";

  const PASSIVE_GATE_TAG = "[ONI][PassiveGate]";
  const PASSIVE_ROOT_TTL_MS = 12000;
  const PASSIVE_GRACE_LOCK_MS = 1200;
  const _passiveCoreRootLedger = new Map();   // rootKey -> { createdAt, touchedAt, fired:Set<string> }
  const _passiveCoreGraceLocks = new Map();   // passiveIdentity -> expiresAt

  const safeString = (v, d = "") => {
    const s = (v ?? "").toString().trim();
    return s.length ? s : d;
  };

  const cloneArray = (a) => Array.isArray(a) ? [...a] : [];
  const numberish = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  function ensurePayloadShape(payload) {
    const p = payload ?? {};
    p.core = p.core || {};
    p.meta = p.meta || {};
    p.advPayload = p.advPayload || {};
    if (!Array.isArray(p.targets)) p.targets = [];
    if (!Array.isArray(p.originalTargetUUIDs)) p.originalTargetUUIDs = [];
    return p;
  }

  function resolveSavedTargetUUIDs(actionContext) {
    const topOriginal = cloneArray(actionContext?.originalTargetUUIDs).filter(Boolean).map(String);
    if (topOriginal.length) return { uuids: topOriginal, source: "actionContext.originalTargetUUIDs" };

    const metaOriginal = cloneArray(actionContext?.meta?.originalTargetUUIDs).filter(Boolean).map(String);
    if (metaOriginal.length) return { uuids: metaOriginal, source: "actionContext.meta.originalTargetUUIDs" };

    const topTargets = cloneArray(actionContext?.targets).filter(Boolean).map(String);
    if (topTargets.length) return { uuids: topTargets, source: "actionContext.targets" };

    return { uuids: [], source: "none" };
  }

  function readDefenseLike(props, preferMagic = false) {
    const p = props ?? {};
    const hard = preferMagic
      ? ["magic_defense", "current_mdef", "mdef"]
      : ["defense", "current_def", "def"];

    for (const k of hard) {
      const n = numberish(p[k]);
      if (n !== null) return n;
    }

    const isBanned = (k) => /(^|_)mod($|_)/i.test(k);
    const keys = Object.keys(p);

    const rePhys = /(^|_)(current_)?(def|guard|armor)($|_)/i;
    const reMag = /(^|_)(current_)?(m(def|agic.*def)|magic.*resist|spirit)($|_)/i;
    const rx = preferMagic ? reMag : rePhys;

    for (const k of keys) {
      if (isBanned(k)) continue;
      const n = numberish(p[k]);
      if (n === null) continue;
      if (rx.test(k)) return n;
    }
    return 0;
  }

  function passiveCleanup() {
    const now = Date.now();

    for (const [rootKey, entry] of _passiveCoreRootLedger.entries()) {
      const touchedAt = Number(entry?.touchedAt || entry?.createdAt || 0);
      if ((now - touchedAt) > PASSIVE_ROOT_TTL_MS) {
        _passiveCoreRootLedger.delete(rootKey);
        gateLog("CORE CLEAR EXPIRED ROOT KEY", { rootKey, touchedAt, ageMs: now - touchedAt });
      }
    }

    for (const [passiveIdentity, expiresAt] of _passiveCoreGraceLocks.entries()) {
      if (now >= Number(expiresAt || 0)) {
        _passiveCoreGraceLocks.delete(passiveIdentity);
      }
    }
  }

  function passiveToUniqueArray(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(v => String(v)))];
  }

  function getPassiveOrigin(actionContext) {
    return actionContext?.meta?.passiveOrigin ?? actionContext?.passiveOrigin ?? null;
  }

  function getPassiveGateContext({ actionContext, executionMode }) {
    const origin = getPassiveOrigin(actionContext);
    const meta = actionContext?.meta ?? {};
    const core = actionContext?.core ?? {};

    const isPassiveExecution =
      executionMode === "autoPassive" ||
      meta?.executionMode === "autoPassive" ||
      meta?.isPassiveExecution === true;

    if (!isPassiveExecution) return { enabled: false, reason: "not_auto_passive", origin: null };

    const rootKey = safeString(origin?.rootKey);
    const passiveIdentity = safeString(
      origin?.passiveIdentity ??
      meta?.passiveIdentity ??
      [
        safeString(meta?.attackerActorUuid ?? meta?.attackerUuid ?? "(no-attacker)", "(no-attacker)"),
        safeString(meta?.passiveItemUuid ?? meta?.itemUuid ?? core?.skillUuid ?? core?.itemUuid ?? "(no-item)", "(no-item)"),
        safeString(origin?.rowSignature ?? meta?.passiveRowIndex ?? "(no-row)", "(no-row)")
      ].join("::")
    );
    const ancestry = passiveToUniqueArray(origin?.ancestry ?? []);

    return {
      enabled: !!rootKey && !!passiveIdentity,
      rootKey,
      passiveIdentity,
      ancestry,
      origin,
      reason: (!!rootKey && !!passiveIdentity) ? "ok" : "missing_origin_bits"
    };
  }

  function touchPassiveCoreRoot(rootKey) {
    const now = Date.now();
    let entry = _passiveCoreRootLedger.get(rootKey);
    if (!entry) {
      entry = { createdAt: now, touchedAt: now, fired: new Set() };
      _passiveCoreRootLedger.set(rootKey, entry);
      gateLog("CORE REGISTER ROOT EVENT", { rootKey, createdAt: now });
    } else {
      entry.touchedAt = now;
    }
    return entry;
  }

  function checkPassiveCoreGate({ actionContext, executionMode, runId }) {
    passiveCleanup();

    const ctx = getPassiveGateContext({ actionContext, executionMode });
    if (!ctx.enabled) {
      if (ctx.reason === "missing_origin_bits") {
        gateWarn("CORE PASSIVE GATE BYPASS (missing origin bits)", {
          runId,
          executionMode,
          reason: ctx.reason,
          origin: ctx.origin ?? null
        });
      }
      return { ok: true, bypassed: true, reason: ctx.reason, ctx };
    }

    const now = Date.now();
    const graceUntil = Number(_passiveCoreGraceLocks.get(ctx.passiveIdentity) || 0);
    if (graceUntil && now < graceUntil) {
      gateWarn("CORE BLOCK REENTRY GRACE LOCK", {
        runId,
        rootKey: ctx.rootKey,
        passiveIdentity: ctx.passiveIdentity,
        msRemaining: graceUntil - now
      });
      return { ok: false, reason: "grace_lock", ctx };
    }

    if (ctx.ancestry.includes(ctx.passiveIdentity)) {
      gateWarn("CORE BLOCK REENTRY ANCESTRY", {
        runId,
        rootKey: ctx.rootKey,
        passiveIdentity: ctx.passiveIdentity,
        ancestry: ctx.ancestry
      });
      return { ok: false, reason: "ancestry_loop", ctx };
    }

    const rootEntry = touchPassiveCoreRoot(ctx.rootKey);
    if (rootEntry.fired.has(ctx.passiveIdentity)) {
      gateWarn("CORE BLOCK REENTRY SAME EVENT", {
        runId,
        rootKey: ctx.rootKey,
        passiveIdentity: ctx.passiveIdentity
      });
      return { ok: false, reason: "same_root_event", ctx };
    }

    rootEntry.fired.add(ctx.passiveIdentity);
    rootEntry.touchedAt = now;
    _passiveCoreGraceLocks.set(ctx.passiveIdentity, now + PASSIVE_GRACE_LOCK_MS);

    gateLog("CORE ALLOW FIRST PASSIVE FIRE", {
      runId,
      rootKey: ctx.rootKey,
      passiveIdentity: ctx.passiveIdentity,
      graceLockMs: PASSIVE_GRACE_LOCK_MS
    });

    return { ok: true, ctx };
  }

  async function resolveActorFromUuid(attackerUuid) {
    const doc = await fromUuid(attackerUuid).catch(() => null);
    return (
      doc?.actor ??
      (doc?.documentName === "Actor" ? doc : null) ??
      (doc?.documentName === "Token" ? doc.actor : null) ??
      (doc?.documentName === "TokenDocument" ? doc.actor : null) ??
      null
    );
  }

  async function resolveTokenDocFromUuidish(uuidish) {
    try {
      if (!uuidish) return null;
      const doc = await fromUuid(uuidish).catch(() => null);
      if (!doc) return null;

      if (doc?.documentName === "Token" || doc?.documentName === "TokenDocument") {
        return doc;
      }

      if (doc?.token?.document?.documentName === "Token" || doc?.token?.document?.documentName === "TokenDocument") {
        return doc.token.document;
      }

      if (doc?.token?.documentName === "Token" || doc?.token?.documentName === "TokenDocument") {
        return doc.token;
      }

      const actor =
        doc?.actor ??
        (doc?.documentName === "Actor" ? doc : null) ??
        null;

      if (actor) {
        try {
          const active = actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? [];
          if (active?.[0]?.document) return active[0].document;
          if (active?.[0]) return active[0];
        } catch (_err) {}

        try {
          const protoObj = actor.token?.object ?? actor.prototypeToken?.object ?? null;
          if (protoObj?.document) return protoObj.document;
          const protoDoc = actor.token?.document ?? actor.prototypeToken ?? null;
          if (protoDoc?.documentName === "Token" || protoDoc?.documentName === "TokenDocument") return protoDoc;
        } catch (_err) {}
      }

      return null;
    } catch {
      return null;
    }
  }

  function hasMeaningfulRichText(raw) {
    const stripped = String(raw ?? "").replace(/<[^>]*>/g, "").trim();
    return stripped.length > 0;
  }

  function getResolutionTargetUUIDs(actionContext, args = {}) {
    const argTargets = cloneArray(args?.originalTargetUUIDs).filter(Boolean).map(String);
    if (argTargets.length) return argTargets;

    return resolveSavedTargetUUIDs(actionContext).uuids;
  }

  async function buildSourceSnapshot(actionContext, mergedArgs) {
    const payload = actionContext ?? {};
    const meta = payload?.meta ?? {};
    const advPayload = payload?.advPayload ?? {};

    const tokenCandidates = [
      mergedArgs?.attackerUuid,
      meta?.attackerTokenUuid,
      meta?.attackerUuid,
      advPayload?.attackerUuid,
      payload?.attackerUuid
    ].filter(Boolean);

    let tokenDoc = null;
    for (const c of tokenCandidates) {
      tokenDoc = await resolveTokenDocFromUuidish(c);
      if (tokenDoc) break;
    }

    const actorCandidates = [
      meta?.attackerActorUuid,
      payload?.attackerActorUuid,
      advPayload?.attackerActorUuid,
      meta?.attackerUuid,
      mergedArgs?.attackerUuid
    ].filter(Boolean);

    let actor = tokenDoc?.actor ?? null;
    if (!actor) {
      for (const c of actorCandidates) {
        actor = await resolveActorFromUuid(c);
        if (actor) break;
      }
    }

    if (!tokenDoc && actor) {
      try {
        const active = actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? [];
        tokenDoc = active?.[0]?.document ?? active?.[0] ?? null;
      } catch (_) {}
    }

    const disposition = Number(tokenDoc?.disposition ?? tokenDoc?.document?.disposition ?? 0);

    return {
      tokenDoc: tokenDoc ?? null,
      tokenUuid: tokenDoc?.uuid ?? tokenDoc?.document?.uuid ?? null,
      tokenId: tokenDoc?.id ?? tokenDoc?.document?.id ?? null,
      actor: actor ?? null,
      actorUuid: actor?.uuid ?? null,
      actorName: actor?.name ?? meta?.attackerName ?? mergedArgs?.attackerName ?? "Unknown",
      disposition
    };
  }

  async function buildTargetSnapshots(uuidList = []) {
    const out = [];

    for (const uuid of (Array.isArray(uuidList) ? uuidList : [])) {
      const doc = await fromUuid(uuid).catch(() => null);
      const tokenDoc =
        (doc?.documentName === "Token" || doc?.documentName === "TokenDocument")
          ? doc
          : (doc?.token?.document ?? doc?.token ?? null);

      const actor =
        tokenDoc?.actor ??
        doc?.actor ??
        (doc?.documentName === "Actor" ? doc : null) ??
        null;

      const disposition = Number(tokenDoc?.disposition ?? tokenDoc?.document?.disposition ?? 0);

      out.push({
        requestedUuid: uuid ?? null,
        tokenDoc: tokenDoc ?? null,
        tokenUuid: tokenDoc?.uuid ?? tokenDoc?.document?.uuid ?? ((doc?.documentName === "Token" || doc?.documentName === "TokenDocument") ? doc?.uuid : null),
        tokenId: tokenDoc?.id ?? tokenDoc?.document?.id ?? doc?.id ?? null,
        actor: actor ?? null,
        actorUuid: actor?.uuid ?? null,
        actorName: actor?.name ?? tokenDoc?.name ?? doc?.name ?? null,
        disposition
      });
    }

    return out;
  }

  async function defenseForUuid(uuid, useMagic) {
    try {
      const d = await fromUuid(uuid);
      const a = d?.actor ?? (d?.type === "Actor" ? d : null);
      const props = a?.system?.props ?? a?.system ?? {};
      return readDefenseLike(props, useMagic);
    } catch {
      return 0;
    }
  }

  async function spendNormalizedCosts(actionContext, runId) {
    try {
      const meta = actionContext?.meta ?? {};
      const costs = meta?.costsNormalized;
      const attackerUuid = meta?.attackerUuid;

      if (!attackerUuid || !Array.isArray(costs) || !costs.length) {
        log(runId, "RESOURCE SPEND skipped", {
          attackerUuid,
          hasCosts: Array.isArray(costs),
          count: Array.isArray(costs) ? costs.length : 0
        });
        return { ok: true, spent: [] };
      }

      const actor = await resolveActorFromUuid(attackerUuid);
      if (!actor) {
        ui.notifications?.error("Action execution: cannot resolve attacker to spend resource.");
        return { ok: false, reason: "attacker_not_found" };
      }

      const patch = {};
      const spent = [];
      for (const c of costs) {
        const curPath = `system.props.${c.curKey}`;
        const curVal = Number(getProperty(actor, curPath) ?? 0) || 0;
        const req = Number(c.req || 0) || 0;
        const next = Math.max(0, curVal - req);
        patch[curPath] = next;
        spent.push({
          label: c.label ?? c.type ?? "Unknown",
          req,
          curVal,
          next,
          path: curPath
        });
      }

      if (Object.keys(patch).length) {
        await actor.update(patch);
      }

      log(runId, "RESOURCE SPEND done", { attacker: actor.name, spent });
      return { ok: true, spent };
    } catch (e) {
      err(runId, "RESOURCE SPEND failed", e);
      ui.notifications?.error("Action execution: resource spend failed. See console.");
      return { ok: false, reason: "resource_spend_failed", error: e };
    }
  }

  async function consumeItemIfNeeded(actionContext, runId) {
    const attackerUuid = actionContext?.meta?.attackerUuid ?? null;
    const itemUsage = actionContext?.itemUsage ?? actionContext?.meta?.itemUsage ?? null;

    if (!attackerUuid || !itemUsage?.itemUuid) {
      log(runId, "ITEM CONSUME skipped", {
        hasAttacker: !!attackerUuid,
        hasItemUsage: !!itemUsage
      });
      return { ok: true, skipped: true };
    }

    try {
      const actor = await resolveActorFromUuid(attackerUuid);
      if (!actor) return { ok: false, reason: "attacker_not_found" };

      let item = null;
      if (itemUsage.itemId && actor.items.has(itemUsage.itemId)) item = actor.items.get(itemUsage.itemId);
      if (!item && itemUsage.itemUuid) item = actor.items.find(i => i.uuid === itemUsage.itemUuid);
      if (!item) return { ok: true, skipped: true, reason: "item_not_found" };

      const props = item.system?.props ?? {};
      const isUnique = !!props.isUnique;
      if (isUnique) return { ok: true, skipped: true, reason: "unique_item_not_consumed" };

      let currentQty = Number(props.item_quantity ?? 0);
      if (!Number.isFinite(currentQty)) currentQty = 0;
      if (currentQty <= 0) return { ok: true, skipped: true, reason: "non_positive_qty" };

      const newQty = currentQty - 1;
      if (newQty > 0) {
        await item.update({ "system.props.item_quantity": newQty });
      } else {
        await actor.deleteEmbeddedDocuments("Item", [item.id]);
      }

      log(runId, "ITEM CONSUME done", {
        actor: actor.name,
        item: item.name,
        oldQty: currentQty,
        newQty: Math.max(0, newQty)
      });
      return { ok: true, itemName: item.name };
    } catch (e) {
      err(runId, "ITEM CONSUME failed", e);
      ui.notifications?.warn("Item consumption failed — see console for details.");
      return { ok: false, reason: "item_consume_failed", error: e };
    }
  }

  function shouldShowDefaultNamecard(actionContext) {
    const payload = actionContext || {};
    const core = payload.core || {};
    const meta = payload.meta || {};
    const advPayload = payload.advPayload || {};

    const listType = safeString(meta.listType);
    const skillTypeRaw = safeString(core.skillTypeRaw).toLowerCase();
    const sourceTypeRaw = safeString(advPayload.sourceType).toLowerCase();

    const isAttackish = (listType === "Attack") || (sourceTypeRaw === "weapon");
    const isSpellish = !!meta.isSpellish;
    const isActive = (listType === "Active");
    const isPassive = (skillTypeRaw === "passive");

    return !isAttackish && (isSpellish || isActive || isPassive);
  }

  async function resolveDisposition(attackerUuid) {
    try {
      if (!attackerUuid) return 0;
      const doc = await fromUuid(attackerUuid);
      const tok = (doc?.documentName === "Token") ? doc : (doc?.token ?? null);
      return Number(tok?.disposition ?? 0);
    } catch {
      return 0;
    }
  }

  function buildDefaultNamecardOptions(disposition, actionType = "skill") {
    const THEMES = {
      hostile: { bg: "#000000", accent: "#ff5a5a", text: ["#ffffff", "#ffd6d6"], glowColor: "#ffffff" },
      friendly: { bg: "#000000", accent: "#7fb5ff", text: ["#ffffff", "#d7e9ff"], glowColor: "#ffffff" },
      neutral: { bg: "#000000", accent: "#ffd866", text: ["#ffffff", "#fff1b3"], glowColor: "#ffffff" },
      secret: { bg: "#000000", accent: "#a0a4a8", text: ["#ffffff", "#e5e7ea"], glowColor: "#ffffff" }
    };

    const d = Number.isFinite(disposition) ? Math.trunc(Number(disposition)) : 0;
    const theme =
      (d === -2) ? THEMES.secret :
      (d === -1) ? THEMES.hostile :
      (d === 1) ? THEMES.friendly :
      THEMES.neutral;

    return {
      actionType,
      bg: theme.bg,
      accent: theme.accent,
      text: theme.text,
      glowColor: theme.glowColor,
      border: "rgba(255,255,255,.10)",
      dropShadow: "0 10px 22px rgba(0,0,0,.35)",
      maskEdges: true,
      edgeFade: 0.12,

      xAlign: "center",
      offsetX: 0,
      offsetY: 100,
      fixedWidth: 640,
      autoWidth: false,
      cardScale: 0.20,

      inMs: 350,
      holdMs: 1500,
      outMs: 400,
      enterFrom: "left",

      maxFontPx: 28,
      minFontPx: 16,
      letterSpacing: 0.06,
      fontWeight: 0,
      upperCase: false,
      fontFamily: "Pixel Operator, system-ui, sans-serif",
      textShadowStrength: 0.0,
      textStrokePx: 0.1,
      textStrokeColor: "rgba(0,0,0,0.55)",
      showIcon: true,
      iconScale: 0.93,
      iconGapPx: 10,

      baselineVh: 900,
      scaleMin: 0.80,
      scaleMax: 1.50,
      scaleMode: "vh"
    };
  }

  async function runVisualFeedback({ actionContext, executionMode, skipVisualFeedback, runId }) {
    if (skipVisualFeedback) {
      log(runId, "VISUAL skipped by option");
      return;
    }

    const core = actionContext?.core || {};
    const meta = actionContext?.meta || {};
    const title = safeString(core.skillName, "—");
    const attackerUuid = meta?.attackerUuid ?? null;

    if (executionMode === "autoPassive") {
      const passiveApi =
        API_ROOT.api?.passiveCard?.broadcast ||
        API_ROOT.api?.passiveCardBroadcast ||
        null;

      if (passiveApi) {
        try {
          await passiveApi({
            title,
            attackerUuid,
            actionContext,
            executionMode
          });
          log(runId, "VISUAL passive-card broadcast done", { title, attackerUuid });
          return;
        } catch (e) {
          warn(runId, "VISUAL passive-card broadcast failed", e);
        }
      }

      log(runId, "VISUAL passive-card API not available yet; skipped", { title, attackerUuid });
      return;
    }

    if (!shouldShowDefaultNamecard(actionContext)) {
      log(runId, "VISUAL default namecard skipped by action type", { title });
      return;
    }

    if (!API_ROOT.api?.namecardBroadcast) {
      log(runId, "VISUAL namecard API missing; skipped", { title });
      return;
    }

    let actionType = "skill";
    if (meta.isSpellish && safeString(meta.listType) === "Offensive Spell") actionType = "offensiveSpell";
    else if (meta.isSpellish) actionType = "spell";
    else if (safeString(core.skillTypeRaw).toLowerCase() === "passive") actionType = "passive";

    const disp = await resolveDisposition(attackerUuid);
    const options = buildDefaultNamecardOptions(disp, actionType);

    await API_ROOT.api.namecardBroadcast({ title, options });
    log(runId, "VISUAL namecard broadcast done", { title, attackerUuid, actionType });
  }

  async function executeCustomLogicResolution(actionContext, args, chatMsg, runId) {
    const clResMacroName = "CustomLogic-Resolution";
    const clResRaw = safeString(actionContext?.customLogicResolutionRaw ?? actionContext?.meta?.customLogicResolutionRaw);
    const hasCLRes = !!clResRaw;

    log(runId, "CUSTOM LOGIC (resolution) inspect", {
      hasCLRes,
      clResLen: clResRaw.length,
      preview: clResRaw.slice(0, 140)
    });

    if (!hasCLRes) return { ok: true, skipped: true };

    const cl = game.macros.getName(clResMacroName);
    if (!cl) {
      warn(runId, "CUSTOM LOGIC (resolution) macro missing", { clResMacroName });
      return { ok: false, skipped: true, reason: "custom_logic_macro_missing" };
    }

    const targets = getResolutionTargetUUIDs(actionContext, args);

    // Backward compatibility with older resolution logic that reads from payload.
    actionContext.__confirmArgs = args;
    actionContext.__confirmChatMsgId = chatMsg?.id ?? null;

    await cl.execute({
      __AUTO: true,
      __PAYLOAD: actionContext,
      __ARGS: args,
      __TARGETS: targets,
      __CHAT_MSG: chatMsg ?? null
    });

    log(runId, "CUSTOM LOGIC (resolution) done", {
      lastRun: actionContext?.meta?.__customLogicResolution?.lastRun ?? null,
      err: actionContext?.meta?.__customLogicResolution?.error ?? null
    });

    return { ok: true };
  }

  async function executePassiveLogicResolution(actionContext, args, chatMsg, runId) {
    const macroName = "PassiveLogic-Resolution";

    const attackerUuid =
      actionContext?.meta?.attackerActorUuid ??
      actionContext?.attackerActorUuid ??
      actionContext?.meta?.attackerUuid ??
      actionContext?.attackerUuid ??
      args?.attackerUuid ??
      null;

    if (!attackerUuid) {
      log(runId, "PASSIVE LOGIC (resolution) skipped — no attacker uuid");
      return { ok: true, skipped: true, reason: "no_attacker_uuid" };
    }

    const actor = await resolveActorFromUuid(attackerUuid);
    if (!actor) {
      warn(runId, "PASSIVE LOGIC (resolution) skipped — attacker actor not found", { attackerUuid });
      return { ok: true, skipped: true, reason: "attacker_not_found" };
    }

    const hasPassiveResolution = Array.from(actor.items ?? []).some(it => {
      const raw = it?.system?.props?.passive_logic_resolution ?? "";
      return hasMeaningfulRichText(raw);
    });

    log(runId, "PASSIVE LOGIC (resolution) inspect", {
      attackerUuid,
      actorName: actor?.name ?? null,
      hasPassiveResolution,
      itemCount: Array.from(actor.items ?? []).length
    });

    if (!hasPassiveResolution) {
      return { ok: true, skipped: true, reason: "no_passive_resolution_scripts" };
    }

    const macro = game.macros.getName(macroName);
    if (!macro) {
      warn(runId, "PASSIVE LOGIC (resolution) macro missing", { macroName });
      return { ok: false, skipped: true, reason: "passive_logic_resolution_macro_missing" };
    }

    const targets = getResolutionTargetUUIDs(actionContext, args);

    // Backward compatibility with older resolution logic that reads from payload.
    actionContext.__confirmArgs = args;
    actionContext.__confirmChatMsgId = chatMsg?.id ?? null;

    await macro.execute({
      __AUTO: true,
      __PAYLOAD: actionContext,
      __ARGS: args,
      __TARGETS: targets,
      __CHAT_MSG: chatMsg ?? null
    });

    log(runId, "PASSIVE LOGIC (resolution) done", {
      lastRun: actionContext?.meta?.__passiveLogicResolution?.lastRun ?? null,
      err: actionContext?.meta?.__passiveLogicResolution?.error ?? null
    });

    return { ok: true };
  }

  async function execute({
    actionContext,
    args = {},
    chatMsgId = null,
    executionMode = "manualCard",
    confirmingUserId = null,
    skipVisualFeedback = false
  } = {}) {
    const runId = `AX-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    if (!game.user?.isGM) {
      warn(runId, "execute called on non-GM client; aborting");
      return { ok: false, reason: "gm_only" };
    }

    const payload = ensurePayloadShape(foundry.utils.deepClone(actionContext ?? {}));
    const chatMsg = chatMsgId ? (game.messages.get(chatMsgId) ?? null) : null;

    if (!payload?.meta || !payload?.core) {
      ui.notifications?.error("Action execution: Missing action payload.");
      return { ok: false, reason: "missing_payload" };
    }

    const mergedArgs = {
      advMacroName: "AdvanceDamage",
      missMacroName: "Miss",
      aeMacroName: "ApplyActiveEffect",
      animMacroName: "ActionAnimationHandler",
      advPayload: payload?.advPayload ?? {},
      elementType: payload?.meta?.elementType ?? "physical",
      isSpellish: !!payload?.meta?.isSpellish,
      hasAccuracy: !!payload?.accuracy,
      accuracyTotal: payload?.accuracy?.total ?? null,
      weaponType: payload?.core?.weaponType ?? "",
      attackRange: payload?.meta?.attackRange ?? "Melee",
      attackerName: payload?.meta?.attackerName ?? payload?.core?.attackerName ?? "Unknown",
      aeDirectives: Array.isArray(payload?.meta?.activeEffects) ? payload.meta.activeEffects : [],
      attackerUuid: payload?.meta?.attackerUuid ?? null,
      originalTargetUUIDs: resolveSavedTargetUUIDs(payload).uuids,
      chatMsgId,
      hasDamageSection:
        (payload?.meta?.hasDamageSection !== undefined)
          ? !!payload.meta.hasDamageSection
          : true,
      autoHit:
        (payload?.advPayload?.autoHit === true) ||
        (payload?.advPayload?.isCrit === true) ||
        (payload?.accuracy?.isCrit === true)
    };

    Object.assign(mergedArgs, args || {});

    log(runId, "START", {
      executionMode,
      confirmingUserId,
      chatMsgId,
      skillName: payload?.core?.skillName ?? null,
      attackerUuid: mergedArgs.attackerUuid,
      attackerName: mergedArgs.attackerName,
      targetsSource: resolveSavedTargetUUIDs(payload).source,
      targetsCount: Array.isArray(mergedArgs.originalTargetUUIDs) ? mergedArgs.originalTargetUUIDs.length : 0,
      hasAccuracy: !!mergedArgs.hasAccuracy,
      accuracyTotal: mergedArgs.accuracyTotal,
      hasDamageSection: !!mergedArgs.hasDamageSection,
      isSpellish: !!mergedArgs.isSpellish,
      elementType: mergedArgs.elementType
    });

    const passiveGateResult = checkPassiveCoreGate({
      actionContext: payload,
      executionMode,
      runId
    });

    if (!passiveGateResult?.ok) {
      warn(runId, "BLOCKED by passive core gate", {
        executionMode,
        reason: passiveGateResult?.reason ?? "blocked",
        rootKey: passiveGateResult?.ctx?.rootKey ?? null,
        passiveIdentity: passiveGateResult?.ctx?.passiveIdentity ?? null
      });
      return {
        ok: true,
        skipped: true,
        reason: `passive_core_gate_${passiveGateResult?.reason ?? "blocked"}`,
        executionMode,
        chatMsgId: chatMsgId ?? null,
        confirmingUserId: confirmingUserId ?? null,
        rootKey: passiveGateResult?.ctx?.rootKey ?? null,
        passiveIdentity: passiveGateResult?.ctx?.passiveIdentity ?? null
      };
    }

    try {
      await executeCustomLogicResolution(payload, mergedArgs, chatMsg, runId);
      await executePassiveLogicResolution(payload, mergedArgs, chatMsg, runId);

      if (mergedArgs.__abortConfirm) {
        const abortReason = safeString(
          mergedArgs.__abortReason ??
          payload?.meta?.__abortResolutionReason ??
          "Resolution cancelled."
        );

        warn(runId, "ABORT confirm before apply", {
          abortReason
        });

        return {
          ok: false,
          reason: "confirm_aborted",
          abortReason,
          executionMode,
          chatMsgId: chatMsgId ?? null,
          confirmingUserId: confirmingUserId ?? null
        };
      }

      const spendResult = await spendNormalizedCosts(payload, runId);
      if (!spendResult.ok) return { ok: false, reason: spendResult.reason ?? "resource_spend_failed" };

      const consumeResult = await consumeItemIfNeeded(payload, runId);
      if (consumeResult.ok === false) {
        warn(runId, "ITEM CONSUME soft-failed; continuing", consumeResult);
      }

      await runVisualFeedback({
        actionContext: payload,
        executionMode,
        skipVisualFeedback,
        runId
      });

      const adv = game.macros.getName(mergedArgs.advMacroName);
      const miss = game.macros.getName(mergedArgs.missMacroName);
      const ae = game.macros.getName(mergedArgs.aeMacroName);
      const anim = game.macros.getName(mergedArgs.animMacroName);

      log(runId, "MACROS", {
        advFound: !!adv,
        missFound: !!miss,
        aeFound: !!ae,
        animFound: !!anim
      });

      if (mergedArgs.hasDamageSection && !adv) {
        ui.notifications?.error(`AdvanceDamage macro "${mergedArgs.advMacroName}" not found or no permission.`);
        return { ok: false, reason: "advance_damage_macro_missing" };
      }

      const savedUUIDs = Array.isArray(mergedArgs.originalTargetUUIDs)
        ? mergedArgs.originalTargetUUIDs.filter(Boolean).map(String)
        : [];

      if (!savedUUIDs.length) {
        ui.notifications?.warn("No saved targets on this action.");
        warn(runId, "ABORT no saved targets");
        return { ok: false, reason: "no_saved_targets" };
      }

      const elemKey = safeString(mergedArgs.elementType || "physical", "physical").toLowerCase();
      const isHealing = /^(heal|healing|recovery|restore|restoration)$/i.test(elemKey);
      const accTotal = mergedArgs.hasAccuracy ? Number(mergedArgs.accuracyTotal) : NaN;

      const explicitAutoHit =
        (mergedArgs.autoHit === true) ||
        (mergedArgs.advPayload?.autoHit === true) ||
        (mergedArgs.advPayload?.isCrit === true) ||
        (payload?.accuracy?.isCrit === true);

      const treatAutoHit = (!mergedArgs.hasAccuracy) || explicitAutoHit;

      const missUUIDs = [];
      const hitUUIDs = [];

      if (!isHealing && !treatAutoHit) {
        for (const u of savedUUIDs) {
          const usedDefense = await defenseForUuid(u, !!mergedArgs.isSpellish);
          const isHit = Number.isFinite(usedDefense) && Number.isFinite(accTotal)
            ? (accTotal >= usedDefense)
            : true;
          if (isHit) hitUUIDs.push(u);
          else missUUIDs.push(u);
        }
      } else {
        hitUUIDs.push(...savedUUIDs);
      }

      log(runId, "HIT/MISS split", {
        savedCount: savedUUIDs.length,
        hitCount: hitUUIDs.length,
        missCount: missUUIDs.length,
        isHealing,
        treatAutoHit,
        accTotal
      });

      const prevTargets = Array.from(game.user?.targets ?? []).map(t => t.id);

      try {
        if (ae && mergedArgs.aeDirectives.length && savedUUIDs.length) {
          log(runId, "AE on_attack begin", {
            directives: mergedArgs.aeDirectives.length,
            targets: savedUUIDs.length
          });

          await ae.execute({
            __AUTO: true,
            __PAYLOAD: {
              directives: mergedArgs.aeDirectives,
              attackerUuid: mergedArgs.attackerUuid,
              targetUUIDs: savedUUIDs,
              trigger: "on_attack",
              accTotal,
              isSpellish: !!mergedArgs.isSpellish,
              weaponType: mergedArgs.weaponType
            }
          });

          log(runId, "AE on_attack done");
        }

        if (missUUIDs.length && miss) {
          const missTargetSnapshots = await buildTargetSnapshots(missUUIDs);
          const missIds = missTargetSnapshots
            .map(s => s?.tokenId ?? null)
            .filter(Boolean);

          if (missIds.length) {
            const sourceSnapshot = await buildSourceSnapshot(payload, mergedArgs);
            const missDefenseUsed =
              (missUUIDs.length === 1)
                ? await defenseForUuid(missUUIDs[0], !!mergedArgs.isSpellish)
                : null;

            const missPayload = {
              attackerName: mergedArgs.attackerName,
              attackerUuid: sourceSnapshot?.tokenUuid ?? mergedArgs.attackerUuid ?? "",
              attackerActorUuid: sourceSnapshot?.actorUuid ?? payload?.meta?.attackerActorUuid ?? null,

              sourceUuid: sourceSnapshot?.tokenUuid ?? mergedArgs.attackerUuid ?? "",
              sourceTokenUuid: sourceSnapshot?.tokenUuid ?? null,
              sourceActorUuid: sourceSnapshot?.actorUuid ?? payload?.meta?.attackerActorUuid ?? null,
              attackerDisposition: Number(sourceSnapshot?.disposition ?? 0),

              targetIds: missIds,
              targetUUIDs: missTargetSnapshots.map(s => s.tokenUuid).filter(Boolean),
              targetActorUUIDs: missTargetSnapshots.map(s => s.actorUuid).filter(Boolean),
              targetDispositions: missTargetSnapshots.map(s => ({
                tokenUuid: s.tokenUuid ?? null,
                actorUuid: s.actorUuid ?? null,
                disposition: Number(s.disposition ?? 0)
              })),
              targetNames: missTargetSnapshots.map(s => s.actorName ?? null).filter(Boolean),

              elementType: elemKey,
              isSpellish: !!mergedArgs.isSpellish,
              weaponType: mergedArgs.weaponType,
              attackRange: mergedArgs.attackRange,
              accuracyTotal: accTotal,
              defenseUsed: Number.isFinite(missDefenseUsed) ? missDefenseUsed : null,

              actionContext: payload,
              actionCardMsgId: chatMsgId ?? null,
              originalTargetUUIDs: cloneArray(payload?.originalTargetUUIDs),
              originalTargetActorUUIDs: cloneArray(payload?.originalTargetActorUUIDs),

              // Small explicit debug packet for miss-path tracing
              __executionDebug: {
                runId,
                branch: "miss",
                savedUUIDs: [...savedUUIDs],
                missUUIDs: [...missUUIDs],
                hitUUIDs: [...hitUUIDs],
                sourceSnapshot: {
                  tokenUuid: sourceSnapshot?.tokenUuid ?? null,
                  actorUuid: sourceSnapshot?.actorUuid ?? null,
                  disposition: Number(sourceSnapshot?.disposition ?? 0)
                },
                targetSnapshots: missTargetSnapshots.map(s => ({
                  tokenUuid: s.tokenUuid ?? null,
                  actorUuid: s.actorUuid ?? null,
                  disposition: Number(s.disposition ?? 0)
                }))
              }
            };

            log(runId, "MISS targeting", {
              missIds,
              missUUIDs,
              sourceSnapshot: {
                tokenUuid: sourceSnapshot?.tokenUuid ?? null,
                actorUuid: sourceSnapshot?.actorUuid ?? null,
                disposition: Number(sourceSnapshot?.disposition ?? 0)
              },
              targetSnapshots: missTargetSnapshots.map(s => ({
                tokenUuid: s.tokenUuid ?? null,
                actorUuid: s.actorUuid ?? null,
                disposition: Number(s.disposition ?? 0)
              }))
            });

            await game.user.updateTokenTargets(missIds, { releaseOthers: true });
            await miss.execute({
              __AUTO: true,
              __PAYLOAD: missPayload
            });
            log(runId, "MISS macro done");
          }
        }

        if (hitUUIDs.length) {
          const hitIds = (await Promise.all(hitUUIDs.map(async (u) => {
            const d = await fromUuid(u).catch(() => null);
            return d?.id ?? d?.document?.id ?? null;
          }))).filter(Boolean);

          if (hitIds.length) {
            log(runId, "HIT targeting", { hitIdsCount: hitIds.length });
            await game.user.updateTokenTargets(hitIds, { releaseOthers: true });

            if (ae && mergedArgs.aeDirectives.length && hitUUIDs.length) {
              log(runId, "AE on_hit begin", {
                directives: mergedArgs.aeDirectives.length,
                targets: hitUUIDs.length
              });

              await ae.execute({
                __AUTO: true,
                __PAYLOAD: {
                  directives: mergedArgs.aeDirectives,
                  attackerUuid: mergedArgs.attackerUuid,
                  targetUUIDs: hitUUIDs,
                  trigger: "on_hit",
                  accTotal,
                  isSpellish: !!mergedArgs.isSpellish,
                  weaponType: mergedArgs.weaponType
                }
              });

              log(runId, "AE on_hit done");
            }

            if (mergedArgs.hasDamageSection) {
              const advUniversalPayload = {
                ...mergedArgs.advPayload,
                targetIds: hitIds,
                actionContext: payload,
                actionCardMsgId: chatMsgId ?? null
              };

              log(runId, "AdvanceDamage begin", {
                macro: mergedArgs.advMacroName,
                targetIds: hitIds.length
              });

              await adv.execute({ __AUTO: true, __PAYLOAD: advUniversalPayload });
              log(runId, "AdvanceDamage done");
            } else {
              const animScriptRaw =
                safeString(mergedArgs.advPayload?.animationScriptRaw) ||
                safeString(payload?.meta?.animationScriptRaw) ||
                safeString(mergedArgs.advPayload?.animationScript) ||
                safeString(payload?.meta?.animationScript);

              const animTimingOpt =
                mergedArgs.advPayload?.animation_damage_timing_options ??
                payload?.meta?.animation_damage_timing_options ??
                "default";

              const animTimingOffset =
                Number(
                  mergedArgs.advPayload?.animation_damage_timing_offset ??
                  payload?.meta?.animation_damage_timing_offset ??
                  0
                ) || 0;

              log(runId, "VFX-only branch", {
                animFound: !!anim,
                macro: mergedArgs.animMacroName,
                hasAnimScriptRaw: !!animScriptRaw,
                timingOpt: animTimingOpt,
                timingOffset: animTimingOffset,
                targetsUuidCount: hitUUIDs.length
              });

              if (anim) {
                const vfxPayload = {
                  ...mergedArgs.advPayload,
                  attackerUuid: mergedArgs.attackerUuid,
                  targets: hitUUIDs,
                  animationPurpose: "vfx_only",
                  animationScriptRaw: animScriptRaw,
                  animation_damage_timing_options: animTimingOpt,
                  animation_damage_timing_offset: animTimingOffset,
                  actionContext: payload,
                  actionCardMsgId: chatMsgId ?? null
                };

                const used = await anim.execute({ __AUTO: true, __PAYLOAD: vfxPayload });
                log(runId, "ActionAnimationHandler done", { used: !!used });
              } else {
                warn(runId, "VFX-only animation macro not found; skipping", {
                  macro: mergedArgs.animMacroName
                });
              }
            }
          }
        }
      } finally {
        await game.user.updateTokenTargets(prevTargets, { releaseOthers: true });
      }

      const summary = {
        ok: true,
        executionMode,
        chatMsgId: chatMsgId ?? null,
        confirmingUserId: confirmingUserId ?? null,
        hitUUIDs,
        missUUIDs,
        savedTargetUUIDs: savedUUIDs,
        treatAutoHit,
        isHealing,
        spentCosts: spendResult.spent ?? []
      };

      log(runId, "COMPLETE", summary);
      return summary;
    } catch (e) {
      err(runId, "FAILED", e);
      ui.notifications?.error("Action execution failed. See console.");
      return { ok: false, reason: "exception", error: e };
    }
  }

  API_ROOT.api.actionExecution = {
    execute
  };

  log("API registered", {
    path: "window.FUCompanion.api.actionExecution.execute"
  });
})();