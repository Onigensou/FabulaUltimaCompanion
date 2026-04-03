/**
 * [ONI] Event System — Show Text — Execute
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-showText-execute.js
 *
 * What this does:
 * - Executes one "Show Text" event row
 * - Resolves the speaker using event-showText-speakerResolver.js
 * - Tries to hand off the text to your existing JRPG dialog system
 * - Waits until the dialog is finished before resolving
 * - Falls back to a simple Foundry dialog if no JRPG dialog bridge is found
 *
 * Exposes API to:
 *   window.oni.EventSystem.ShowText.Execute
 *
 * Requires:
 * - event-constants.js
 * - event-debug.js
 * - event-showText-speakerResolver.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][ShowText][Execute]";

  // ------------------------------------------------------------
  // Global namespace + guard
  // ------------------------------------------------------------
  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};
  window.oni.EventSystem.ShowText = window.oni.EventSystem.ShowText || {};

  if (window.oni.EventSystem.ShowText.Execute?.installed) {
    console.log(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const D = window.oni.EventSystem.Debug;
  const SpeakerResolver = window.oni.EventSystem.ShowText.SpeakerResolver;

  if (!C) {
    console.error(INSTALL_TAG, "Missing Constants. Load event-constants.js first.");
    return;
  }

  if (!SpeakerResolver) {
    console.error(INSTALL_TAG, "Missing SpeakerResolver. Load event-showText-speakerResolver.js first.");
    return;
  }

  const DEBUG_SCOPE = "ShowTextExecute";

  const FALLBACK_DEBUG = {
    log: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    verboseLog: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    warn: (...args) => console.warn(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    error: (...args) => console.error(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args)
  };

  const DBG = D || FALLBACK_DEBUG;

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------
  function stringOrEmpty(value) {
    return String(value ?? "").trim();
  }

  function normalizeRow(row = {}) {
    return {
      id: stringOrEmpty(row.id) || foundry.utils.randomID(),
      type: C.normalizeEventType ? C.normalizeEventType(row.type) : String(row.type || C.DEFAULT_ROW_TYPE),
      speaker: stringOrEmpty(row.speaker || C.DEFAULT_SHOW_TEXT_SPEAKER || C.SPECIAL_SPEAKER_SELF),
      text: String(row.text ?? C.DEFAULT_SHOW_TEXT_MESSAGE ?? ""),
      bubbleMode: stringOrEmpty(row.bubbleMode || "normal") || "normal",
      speed: Number.isFinite(Number(row.speed)) ? Number(row.speed) : 28
    };
  }

  function buildExecutionContext(context = {}) {
    return {
      ...context,
      sceneId: stringOrEmpty(context.sceneId) || canvas?.scene?.id || null,
      userId: stringOrEmpty(context.userId || game?.user?.id) || null,
      tileId: stringOrEmpty(context.tileId),
      tokenId: stringOrEmpty(context.tokenId || context.partyTokenId),
      actorId: stringOrEmpty(context.actorId || context.partyActorId),
      partyToken: context.partyToken || null,
      partyActor: context.partyActor || null
    };
  }

  function buildDialogPayload(row, speakerResult, context) {
    return {
      rowId: row.id,
      eventType: C.EVENT_TYPES?.SHOW_TEXT || "showText",
      tileId: context.tileId || null,
      sceneId: context.sceneId || null,
      userId: context.userId || null,

      speakerInput: row.speaker,
      speakerName: speakerResult?.speakerName || C.SPECIAL_SPEAKER_SELF,

      text: row.text,
      html: row.text,

      bubbleMode: row.bubbleMode,
      speed: row.speed,

      token: speakerResult?.token || null,
      actor: speakerResult?.actor || null,
      tokenUuid: speakerResult?.tokenUuid || null,
      actorUuid: speakerResult?.actorUuid || null,

      // Extra meta for future flexibility
      meta: {
        matchedBy: speakerResult?.matchedBy || null,
        resolutionMode: speakerResult?.mode || null
      }
    };
  }

  function escapeHTML(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function localizeTitle(speakerName) {
    const safe = stringOrEmpty(speakerName);
    return safe || C.SPECIAL_SPEAKER_SELF || "Speaker";
  }

  // ------------------------------------------------------------
  // Adapter 1:
  // Explicit context bridge
  // Best option if event-executeCore later injects your own dialog runner.
  // ------------------------------------------------------------
  async function tryContextBridge(payload, context) {
    try {
      if (typeof context?.runShowText === "function") {
        DBG.verboseLog(DEBUG_SCOPE, "Using context.runShowText bridge.");
        await context.runShowText(payload, context);
        return { ok: true, adapter: "context.runShowText" };
      }

      if (typeof context?.showTextRunner === "function") {
        DBG.verboseLog(DEBUG_SCOPE, "Using context.showTextRunner bridge.");
        await context.showTextRunner(payload, context);
        return { ok: true, adapter: "context.showTextRunner" };
      }

      if (typeof context?.dialogRunner === "function") {
        DBG.verboseLog(DEBUG_SCOPE, "Using context.dialogRunner bridge.");
        await context.dialogRunner(payload, context);
        return { ok: true, adapter: "context.dialogRunner" };
      }
    } catch (e) {
      DBG.error(DEBUG_SCOPE, "Context dialog bridge failed:", e);
      throw e;
    }

    return { ok: false };
  }

  // ------------------------------------------------------------
  // Adapter 2:
  // Optional shared bridge under window.oni.EventSystem.DialogBridge
  // This lets you wire your JRPG text system later without rewriting this file.
  // ------------------------------------------------------------
  async function tryEventSystemBridge(payload, context) {
    try {
      const bridge = window.oni?.EventSystem?.DialogBridge;

      if (bridge && typeof bridge.showText === "function") {
        DBG.verboseLog(DEBUG_SCOPE, "Using EventSystem DialogBridge.");
        await bridge.showText(payload, context);
        return { ok: true, adapter: "window.oni.EventSystem.DialogBridge.showText" };
      }
    } catch (e) {
      DBG.error(DEBUG_SCOPE, "EventSystem DialogBridge failed:", e);
      throw e;
    }

    return { ok: false };
  }

  // ------------------------------------------------------------
  // Adapter 3:
  // FUCompanion bridge if you later decide to expose one there
  // ------------------------------------------------------------
  async function tryFUCompanionBridge(payload, context) {
    try {
      const api = window.FUCompanion?.api;

      if (typeof api?.showEventText === "function") {
        DBG.verboseLog(DEBUG_SCOPE, "Using FUCompanion.api.showEventText.");
        await api.showEventText(payload, context);
        return { ok: true, adapter: "window.FUCompanion.api.showEventText" };
      }

      if (typeof api?.showDialogText === "function") {
        DBG.verboseLog(DEBUG_SCOPE, "Using FUCompanion.api.showDialogText.");
        await api.showDialogText(payload, context);
        return { ok: true, adapter: "window.FUCompanion.api.showDialogText" };
      }

      if (typeof api?.jrpgDialogShow === "function") {
        DBG.verboseLog(DEBUG_SCOPE, "Using FUCompanion.api.jrpgDialogShow.");
        await api.jrpgDialogShow(payload, context);
        return { ok: true, adapter: "window.FUCompanion.api.jrpgDialogShow" };
      }
    } catch (e) {
      DBG.error(DEBUG_SCOPE, "FUCompanion bridge failed:", e);
      throw e;
    }

    return { ok: false };
  }

  // ------------------------------------------------------------
  // Adapter 4:
  // Fallback simple Foundry dialog
  // This guarantees the sequence can still wait correctly even
  // before your JRPG dialog bridge is wired in.
  // ------------------------------------------------------------
  async function showFallbackDialog(payload) {
    const title = localizeTitle(payload.speakerName);
    const content = `
      <div class="oni-event-show-text-fallback" style="line-height:1.5;">
        <div style="font-weight:800; margin-bottom:8px;">${escapeHTML(title)}</div>
        <div>${payload.html || ""}</div>
      </div>
    `;

    // Foundry v12 can still use Dialog.confirm reliably.
    return new Promise((resolve) => {
      try {
        new Dialog({
          title,
          content,
          buttons: {
            ok: {
              icon: '<i class="fas fa-check"></i>',
              label: "Continue",
              callback: () => resolve({ ok: true, adapter: "Dialog" })
            }
          },
          default: "ok",
          close: () => resolve({ ok: true, adapter: "Dialog" })
        }).render(true);
      } catch (e) {
        DBG.error(DEBUG_SCOPE, "Fallback Dialog render failed:", e);
        ui.notifications?.warn?.("[Event System] Failed to show fallback dialog. See console.");
        resolve({ ok: false, adapter: "Dialog", error: e });
      }
    });
  }

  async function runDialogAdapters(payload, context) {
    // Order matters:
    // 1. explicit runtime bridge
    // 2. shared EventSystem bridge
    // 3. FUCompanion bridge
    // 4. fallback dialog

    let result = await tryContextBridge(payload, context);
    if (result.ok) return result;

    result = await tryEventSystemBridge(payload, context);
    if (result.ok) return result;

    result = await tryFUCompanionBridge(payload, context);
    if (result.ok) return result;

    DBG.warn(DEBUG_SCOPE, "No JRPG dialog bridge found. Falling back to simple Foundry Dialog.");
    return showFallbackDialog(payload);
  }

  // ------------------------------------------------------------
  // Main executor
  // ------------------------------------------------------------
  const Execute = {
    installed: true,

    async execute(rawRow = {}, rawContext = {}) {
      const row = normalizeRow(rawRow);
      const context = buildExecutionContext(rawContext);

      DBG.group?.(DEBUG_SCOPE, `Execute Show Text [${row.id}]`, true);
      DBG.log(DEBUG_SCOPE, "Raw row:", rawRow);
      DBG.verboseLog(DEBUG_SCOPE, "Normalized row:", row);
      DBG.verboseLog(DEBUG_SCOPE, "Execution context:", context);

      try {
        const speakerResult = await SpeakerResolver.resolve(row.speaker, context);

        if (!speakerResult?.ok) {
          const fallbackSpeaker = {
            ok: true,
            speakerName: C.SPECIAL_SPEAKER_SELF,
            matchedBy: "executeFallback",
            mode: "fallback",
            token: null,
            actor: null,
            tokenUuid: null,
            actorUuid: null
          };

          DBG.warn(DEBUG_SCOPE, "Speaker resolution failed cleanly. Using fallback speaker.", {
            requestedSpeaker: row.speaker,
            fallbackSpeaker
          });

          const payload = buildDialogPayload(row, fallbackSpeaker, context);
          const dialogResult = await runDialogAdapters(payload, context);

          DBG.log(DEBUG_SCOPE, "Show Text completed with fallback speaker.", {
            rowId: row.id,
            adapter: dialogResult?.adapter || null
          });

          return {
            ok: true,
            rowId: row.id,
            type: row.type,
            adapter: dialogResult?.adapter || null,
            payload
          };
        }

        const payload = buildDialogPayload(row, speakerResult, context);

        DBG.log(DEBUG_SCOPE, "Final Show Text payload:", {
          rowId: payload.rowId,
          speakerName: payload.speakerName,
          matchedBy: payload.meta?.matchedBy,
          adapterCandidates: [
            "context bridge",
            "EventSystem DialogBridge",
            "FUCompanion bridge",
            "fallback Dialog"
          ]
        });

        DBG.verboseLog(DEBUG_SCOPE, "Payload full dump:", payload);

        const dialogResult = await runDialogAdapters(payload, context);

        DBG.log(DEBUG_SCOPE, "Show Text completed.", {
          rowId: row.id,
          adapter: dialogResult?.adapter || null,
          speakerName: payload.speakerName
        });

        return {
          ok: true,
          rowId: row.id,
          type: row.type,
          adapter: dialogResult?.adapter || null,
          payload
        };
      } catch (e) {
        DBG.error(DEBUG_SCOPE, "Show Text execution failed:", e);

        return {
          ok: false,
          rowId: row.id,
          type: row.type,
          error: e
        };
      } finally {
        DBG.groupEnd?.();
      }
    }
  };

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  window.oni.EventSystem.ShowText.Execute = Execute;

  console.log(INSTALL_TAG, "Installed.");
})();
