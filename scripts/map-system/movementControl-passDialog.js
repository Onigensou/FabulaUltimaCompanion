/**
 * movementControl-passDialog.js
 * Fabula Ultima Companion - Movement Control Pass Controller Dialog UI
 * Foundry VTT v12
 *
 * Purpose:
 * - Mount a small "Pass" button beside the controller badge
 * - Only show the button to the current Main Controller or GM override
 * - Open a dialog with a dropdown of eligible controller users
 * - Call the Movement Control API to pass controller status
 *
 * Notes:
 * - Pure UI layer
 * - Relies on:
 *   - movementControl-api.js
 *   - movementControl-controllerBadge.js
 *
 * Globals:
 *   globalThis.__ONI_MOVEMENT_CONTROL_PASS_DIALOG__
 *
 * API:
 *   FUCompanion.api.MovementControlPassDialog
 */

(() => {
  const GLOBAL_KEY = "__ONI_MOVEMENT_CONTROL_PASS_DIALOG__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "movementControl";

  const FABULA_ROOT_KEY = "oniFabula";
  const GENERAL_KEY = "general";
  const CAMERA_FOLLOW_KEY = "cameraFollowToken";

  const STYLE_ID = "oni-movement-control-pass-dialog-style";
  const BUTTON_ID = "oni-movement-control-pass-button";
  const DIALOG_ID = "oni-movement-control-pass-dialog";

  const state = {
    installed: true,
    ready: false,
    destroyed: false,

    button: null,
    dialogApp: null,

    refreshTimer: null,
    mountedHost: null
  };

  function getDebug() {
    const dbg = globalThis.__ONI_MOVEMENT_CONTROL_DEBUG__;
    if (dbg?.installed) return dbg;

    const noop = () => {};
    return {
      log: noop,
      info: noop,
      verbose: noop,
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      group: noop,
      groupCollapsed: noop,
      table: noop,
      divider: noop,
      startTimer: noop,
      endTimer: () => null
    };
  }

  function getMovementAPI() {
    return globalThis.__ONI_MOVEMENT_CONTROL_API__
      ?? globalThis.FUCompanion?.api?.MovementControl
      ?? null;
  }

  function getBadgeAPI() {
    return globalThis.__ONI_MOVEMENT_CONTROL_CONTROLLER_BADGE__
      ?? globalThis.FUCompanion?.api?.MovementControlControllerBadge
      ?? null;
  }

  const DBG = getDebug();

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

function hasText(value) {
  return cleanString(value).length > 0;
}

function escapeHtml(value) {
  return cleanString(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

  function safeGet(obj, path, fallback = undefined) {
    try {
      const parts = String(path).split(".");
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return fallback;
        cur = cur[p];
      }
      return cur === undefined ? fallback : cur;
    } catch {
      return fallback;
    }
  }

  function getSceneCameraFollowEnabled(scene) {
    const fab = scene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY];
    const raw = safeGet(fab, `${GENERAL_KEY}.${CAMERA_FOLLOW_KEY}`, false);

    if (typeof raw === "boolean") return raw;
    if (typeof raw === "number") return raw !== 0;
    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(s)) return true;
      if (["false", "0", "no", "n", "off"].includes(s)) return false;
    }

    return false;
  }

  function isActiveForScene() {
    return !!canvas?.ready && !!canvas?.scene && getSceneCameraFollowEnabled(canvas.scene);
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID} {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.16);
        background:
          linear-gradient(180deg, rgba(42, 52, 68, 0.98) 0%, rgba(24, 31, 42, 0.98) 100%);
        color: #f4f8ff;
        min-height: 32px;
        padding: 6px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.02em;
        line-height: 1;
        cursor: pointer;
        box-shadow:
          0 6px 16px rgba(0,0,0,0.24),
          inset 0 1px 0 rgba(255,255,255,0.08);
        pointer-events: auto;
        transition:
          transform 100ms ease,
          filter 100ms ease,
          opacity 100ms ease;
      }

      #${BUTTON_ID}:hover {
        filter: brightness(1.08);
        transform: translateY(-1px);
      }

      #${BUTTON_ID}:active {
        transform: translateY(0);
        filter: brightness(0.98);
      }

      #${BUTTON_ID}[hidden] {
        display: none !important;
      }

      .oni-mc-pass-dialog {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .oni-mc-pass-dialog__note {
        font-size: 13px;
        line-height: 1.45;
        color: #d8dee9;
      }

      .oni-mc-pass-dialog__field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .oni-mc-pass-dialog__label {
        font-size: 12px;
        font-weight: 700;
        color: #f5f7fb;
      }

      .oni-mc-pass-dialog__select {
        width: 100%;
        min-height: 34px;
      }

      .oni-mc-pass-dialog__meta {
        font-size: 12px;
        color: #9fb1c7;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureButton() {
    ensureStyles();

    if (state.button?.isConnected) return state.button;

    const existing = document.getElementById(BUTTON_ID);
    if (existing) existing.remove();

    const button = document.createElement("button");
    button.type = "button";
    button.id = BUTTON_ID;
    button.textContent = "Pass";
    button.hidden = true;
    button.addEventListener("click", onPassButtonClick);

    state.button = button;

    DBG.verbose("PassDialog", "Created pass button");
    return button;
  }

  function mountButton() {
    const badgeAPI = getBadgeAPI();
    const host = badgeAPI?.getHostElement?.() ?? null;
    const button = ensureButton();

    if (!host) {
      DBG.verbose("PassDialog", "mountButton skipped because badge host is unavailable");
      return false;
    }

    if (state.mountedHost !== host || !button.isConnected) {
      host.appendChild(button);
      state.mountedHost = host;

      DBG.verbose("PassDialog", "Mounted pass button into badge host");
    }

    return true;
  }

  function unmountButton() {
    try {
      state.button?.remove();
    } catch (_) {}

    state.mountedHost = null;
  }

  function setButtonVisible(visible) {
    const button = ensureButton();
    button.hidden = !visible;
  }

  function setButtonEnabled(enabled) {
    const button = ensureButton();
    button.disabled = !enabled;
    button.style.opacity = enabled ? "1" : "0.65";
    button.style.cursor = enabled ? "pointer" : "default";
  }

  async function getUiState() {
    const api = getMovementAPI();
    if (!api) {
      return {
        active: false,
        canPass: false,
        canPassReason: "apiUnavailable",
        currentController: null,
        eligibleControllers: []
      };
    }

    if (!isActiveForScene()) {
      return {
        active: false,
        canPass: false,
        canPassReason: "sceneInactive",
        currentController: null,
        eligibleControllers: []
      };
    }

    let currentController = null;
    let canPass = { ok: false, reason: "unknown" };
    let eligibleControllers = [];

    try {
      currentController = await api.getCurrentControllerUser();
      canPass = await api.canCurrentUserPassControl();
      eligibleControllers = await api.getEligibleControllers({
        onlineOnly: true,
        includeGM: false
      });
    } catch (err) {
      DBG.warn("PassDialog", "Failed to build UI state", {
        error: err?.message ?? err
      });

      return {
        active: true,
        canPass: false,
        canPassReason: "uiStateError",
        currentController: null,
        eligibleControllers: []
      };
    }

    const filteredEligible = (eligibleControllers ?? []).filter(row => {
      return cleanString(row?.userId) !== cleanString(currentController?.userId);
    });

    return {
      active: true,
      canPass: !!canPass?.ok,
      canPassReason: canPass?.reason ?? "unknown",
      currentController,
      eligibleControllers: filteredEligible
    };
  }

  async function refresh({ reason = "manual" } = {}) {
    if (state.destroyed) return;

    const mounted = mountButton();
    if (!mounted) {
      setButtonVisible(false);
      return;
    }

    const uiState = await getUiState();

    if (!uiState.active) {
      setButtonVisible(false);
      closeDialog();
      DBG.verbose("PassDialog", "Pass button hidden because system is inactive", { reason });
      return;
    }

    const shouldShow = uiState.canPass;
    const hasTargets = (uiState.eligibleControllers?.length ?? 0) > 0;

    setButtonVisible(shouldShow);
    setButtonEnabled(shouldShow && hasTargets);

    if (state.button) {
      if (!hasTargets && shouldShow) {
        state.button.title = "No other eligible player is available right now.";
      } else if (uiState.canPassReason === "gmOverride") {
        state.button.title = "GM override: pass control to another eligible player.";
      } else {
        state.button.title = "Pass main controller status to another eligible player.";
      }
    }

    DBG.verbose("PassDialog", "Pass button refreshed", {
      reason,
      shouldShow,
      hasTargets,
      currentControllerUserId: uiState.currentController?.userId ?? null,
      currentControllerUserName: uiState.currentController?.userName ?? null,
      eligibleCount: uiState.eligibleControllers?.length ?? 0,
      canPassReason: uiState.canPassReason
    });
  }

  function scheduleRefresh(reason = "scheduled", delay = 0) {
    if (state.destroyed) return;

    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      refresh({ reason });
    }, Math.max(0, Number(delay) || 0));
  }

  async function buildDialogData() {
    const api = getMovementAPI();
    if (!api) return null;

    const currentController = await api.getCurrentControllerUser();
    const canPass = await api.canCurrentUserPassControl();
    const eligibleControllers = await api.getEligibleControllers({
      onlineOnly: true,
      includeGM: false
    });

    const targets = (eligibleControllers ?? []).filter(row => {
      return cleanString(row?.userId) !== cleanString(currentController?.userId);
    });

    return {
      canPass,
      currentController,
      targets
    };
  }

  function buildDialogContent(data) {
    const currentControllerName = cleanString(data?.currentController?.userName) || "Unknown";
    const targets = Array.isArray(data?.targets) ? data.targets : [];

    const optionsHtml = targets.map(row => {
      const userId = cleanString(row?.userId);
      const userName = cleanString(row?.userName) || "Unknown User";
      const actorName = cleanString(row?.linkedActorName || row?.partyMemberActorName || "");
      const slotText = row?.partyMemberSlot != null ? `Slot ${row.partyMemberSlot}` : "";

      const metaParts = [slotText, actorName].filter(Boolean);
      const label = metaParts.length > 0
        ? `${userName} — ${metaParts.join(" • ")}`
        : userName;

      return `<option value="${escapeHtml(userId)}">${escapeHtml(label)}</option>`;
    }).join("");

    return `
      <div class="oni-mc-pass-dialog">
        <div class="oni-mc-pass-dialog__note">
          Current Controller: <strong>${escapeHtml(currentControllerName)}</strong><br>
          Choose which eligible player should become the new Main Controller.
        </div>

        <div class="oni-mc-pass-dialog__field">
          <label class="oni-mc-pass-dialog__label" for="oni-mc-pass-dialog-target">Pass control to</label>
          <select id="oni-mc-pass-dialog-target" class="oni-mc-pass-dialog__select">
            ${optionsHtml}
          </select>
        </div>

        <div class="oni-mc-pass-dialog__meta">
          The selected player will become the new Main Controller, and the central party token will update to match their linked actor.
        </div>
      </div>
    `;
  }

  function closeDialog() {
    try {
      state.dialogApp?.close?.();
    } catch (_) {}

    state.dialogApp = null;
  }

  async function performPass(targetUserId) {
    const api = getMovementAPI();
    if (!api) {
      ui.notifications?.warn("Movement Control API is not available.");
      return { ok: false, reason: "apiUnavailable" };
    }

    const cleanTargetUserId = cleanString(targetUserId);
    if (!cleanTargetUserId) {
      ui.notifications?.warn("Please choose a target player.");
      return { ok: false, reason: "missingTargetUserId" };
    }

    try {
      let result = null;

      if (game.user?.isGM) {
        result = await api.forceSetController(cleanTargetUserId, {
          source: "passDialogGM"
        });
      } else {
        result = await api.requestPassController(cleanTargetUserId, {
          source: "passDialogPlayer"
        });
      }

      if (!result?.ok) {
        const reason = cleanString(result?.reason) || "requestFailed";
        ui.notifications?.warn(`Could not pass control. (${reason})`);

        DBG.warn("PassDialog", "performPass failed", {
          targetUserId: cleanTargetUserId,
          result
        });

        scheduleRefresh("performPassFailed", 100);
        return result;
      }

      if (game.user?.isGM) {
        ui.notifications?.info("Main Controller updated.");
      } else {
        ui.notifications?.info("Controller pass request sent.");
      }

      DBG.verbose("PassDialog", "performPass succeeded", {
        targetUserId: cleanTargetUserId,
        result
      });

      scheduleRefresh("performPassSuccess", 150);
      return result;
    } catch (err) {
      ui.notifications?.error("Failed to pass control.");
      DBG.error("PassDialog", "performPass threw an error", {
        targetUserId: cleanTargetUserId,
        error: err?.message ?? err
      });

      scheduleRefresh("performPassException", 150);
      return { ok: false, reason: "exception", error: err };
    }
  }

  async function openDialog() {
    const data = await buildDialogData();

    if (!data?.canPass?.ok) {
      ui.notifications?.warn("You are not allowed to pass control right now.");
      scheduleRefresh("openDialogDenied", 0);
      return;
    }

    if (!Array.isArray(data.targets) || data.targets.length === 0) {
      ui.notifications?.warn("No other eligible player is available to receive control.");
      scheduleRefresh("openDialogNoTargets", 0);
      return;
    }

    closeDialog();

    state.dialogApp = new Dialog({
      title: "Pass Main Controller",
      content: buildDialogContent(data),
      buttons: {
        confirm: {
          label: "Confirm",
          callback: async (html) => {
            const targetUserId = html.find("#oni-mc-pass-dialog-target").val();
            await performPass(targetUserId);
          }
        },
        cancel: {
          label: "Cancel"
        }
      },
      default: "confirm",
      render: (html) => {
        html.closest(".app").attr("id", DIALOG_ID);
      },
      close: () => {
        state.dialogApp = null;
        scheduleRefresh("dialogClosed", 50);
      }
    });

    state.dialogApp.render(true);

    DBG.verbose("PassDialog", "Opened pass dialog", {
      currentControllerUserId: data.currentController?.userId ?? null,
      currentControllerUserName: data.currentController?.userName ?? null,
      targetCount: data.targets.length
    });
  }

  async function onPassButtonClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    await openDialog();
  }

  function destroy() {
    state.destroyed = true;

    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    state.refreshTimer = null;

    closeDialog();
    unmountButton();

    state.button = null;
    state.mountedHost = null;

    DBG.verbose("PassDialog", "Pass dialog UI destroyed");
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,

    refresh,
    scheduleRefresh,
    openDialog,
    closeDialog,
    destroy
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.MovementControlPassDialog = api;
    } catch (err) {
      console.warn("[MovementControl:PassDialog] Failed to attach API to FUCompanion.api", err);
    }

    state.ready = true;
    scheduleRefresh("ready", 100);

    DBG.verbose("PassDialog", "movementControl-passDialog.js ready", {
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    });
  });

  Hooks.on("canvasReady", () => {
    scheduleRefresh("canvasReady", 80);
  });

  Hooks.on("renderPlayerList", () => {
    scheduleRefresh("renderPlayerList", 40);
  });

  Hooks.on("updateScene", (scene) => {
    if (scene?.id !== canvas?.scene?.id) return;
    scheduleRefresh("updateScene", 40);
  });

  Hooks.on("updateActor", () => {
    scheduleRefresh("updateActor", 40);
  });

  Hooks.on("updateUser", () => {
    scheduleRefresh("updateUser", 40);
  });

  Hooks.on("controlToken", () => {
    scheduleRefresh("controlToken", 40);
  });

  Hooks.once("shutdown", () => {
    destroy();
  });
})();
