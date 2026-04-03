/**
 * [ONI] Event System — Execute Core
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-executeCore.js
 *
 * What this does:
 * - Auto-installs after Foundry is ready
 * - Reads Tile flags from flags.oni-event-system.*
 * - Scans for nearby Event Tiles
 * - Shows a single "!" interact button above the party actor
 * - Uses nearest valid Event Tile as the current candidate
 * - Sends execution requests to GM through fabula-ultima-companion socket
 * - Executes event rows in strict sequence, waiting for each row to finish
 *
 * Polished updates in this version:
 * - Icon styling mirrors your old examine UI
 * - Button placement uses doc-based token position
 * - Uses desired/show/hide state logic to reduce UI flicker
 * - Repositions immediately on move update + schedules follow-up scans
 * - Temporarily despawns the "!" icon while the event sequence is running
 *
 * Requires:
 * - event-constants.js
 * - event-debug.js
 * - event-eventRegistry.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][ExecuteCore]";

  // ------------------------------------------------------------
  // Global namespace + guard
  // ------------------------------------------------------------
  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};

  if (window.oni.EventSystem.Core?.installed) {
    console.log(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const D = window.oni.EventSystem.Debug;
  const EventRegistry = window.oni.EventSystem.EventRegistry;

  if (!C) {
    console.error(INSTALL_TAG, "Missing Constants. Load event-constants.js first.");
    return;
  }

  if (!EventRegistry) {
    console.error(INSTALL_TAG, "Missing EventRegistry. Load event-eventRegistry.js first.");
    return;
  }

  const DEBUG_SCOPE = "ExecuteCore";
  const CHANNELS = Array.isArray(C.SOCKET_CHANNELS)
    ? C.SOCKET_CHANNELS
    : ["module.fabula-ultima-companion"];

  const MSG_EXECUTE_REQ = C.MSG_EVENT_EXECUTE_REQ || "ONI_EVENT_EXECUTE_REQ_V1";
  const MSG_EXECUTE_START = "ONI_EVENT_EXECUTE_START_V1";
  const MSG_EXECUTE_DONE = C.MSG_EVENT_EXECUTE_DONE || "ONI_EVENT_EXECUTE_DONE_V1";
  const MSG_EXECUTE_ERROR = C.MSG_EVENT_EXECUTE_ERROR || "ONI_EVENT_EXECUTE_ERROR_V1";

  const FALLBACK_DEBUG = {
    log: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    verboseLog: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    warn: (...args) => console.warn(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    error: (...args) => console.error(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    group: (...args) => {
      console.groupCollapsed(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args);
      return true;
    },
    groupEnd: () => console.groupEnd()
  };

  const DBG = D || FALLBACK_DEBUG;

  // ------------------------------------------------------------
  // Runtime execution state
  // ------------------------------------------------------------
  // GM authoritative running tiles
  const gmActiveExecutions = new Set();

  // Client-side suppression set
  // If a tile is currently running, hide/suppress the "!" icon until it finishes.
  const clientRunningTiles = new Set();

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------
  function stringOrEmpty(value) {
    return String(value ?? "").trim();
  }

  function worldToScreen(x, y) {
    const wt = canvas?.app?.stage?.worldTransform || canvas?.stage?.worldTransform;
    if (!wt) return { x, y };
    return {
      x: (x * wt.a) + wt.tx,
      y: (y * wt.d) + wt.ty
    };
  }

  function getTileRect(tileLike) {
    const d = tileLike?.document ?? tileLike;
    return {
      left: Number(d?.x ?? 0),
      top: Number(d?.y ?? 0),
      width: Number(d?.width ?? 0),
      height: Number(d?.height ?? 0),
      right: Number(d?.x ?? 0) + Number(d?.width ?? 0),
      bottom: Number(d?.y ?? 0) + Number(d?.height ?? 0)
    };
  }

  function getAuthoritativeTokenCenterPx(token, overrideXY = null) {
    const doc = token?.document;
    const baseX = overrideXY?.x ?? doc?.x ?? token?.x ?? 0;
    const baseY = overrideXY?.y ?? doc?.y ?? token?.y ?? 0;
    const w = token?.w ?? 0;
    const h = token?.h ?? 0;
    return { x: baseX + (w / 2), y: baseY + (h / 2) };
  }

  function pointToRectDistance(point, rect) {
    const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
    const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
    return Math.hypot(dx, dy);
  }

  function normalizeBoolean(raw, fallback = false) {
    if (raw === true || raw === false) return raw;
    if (raw === 1 || raw === 0) return !!raw;

    if (typeof raw === "string") {
      const s = raw.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(s)) return true;
      if (["false", "0", "no", "n", "off"].includes(s)) return false;
    }

    return fallback;
  }

  function normalizeProximityPx(raw, fallback = C.DEFAULT_PROXIMITY_PX ?? 0) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(C.MIN_PROXIMITY_PX ?? 0, Math.round(n));
  }

  function findEventConfigObject(tileDoc) {
    const flags = tileDoc?.flags ?? {};

    for (const [scope, scopeObj] of Object.entries(flags)) {
      if (!scopeObj || typeof scopeObj !== "object") continue;

      for (const [key, val] of Object.entries(scopeObj)) {
        if (val && typeof val === "object" && ("isEventTile" in val)) {
          return { scope, key, data: val };
        }
      }

      if ("isEventTile" in scopeObj) {
        return { scope, key: null, data: scopeObj };
      }
    }

    return { scope: null, key: null, data: null };
  }

  function normalizeEventRows(rawRows) {
    let rows = rawRows;

    if (typeof rows === "string") {
      try {
        rows = JSON.parse(rows);
      } catch (_) {
        rows = [];
      }
    }

    if (!Array.isArray(rows)) rows = [];

    return rows.map((row) => {
      const requestedType = String(row?.type || C.DEFAULT_ROW_TYPE || "showText");
      const safeType = EventRegistry.has(requestedType)
        ? requestedType
        : (C.DEFAULT_ROW_TYPE || C.EVENT_TYPES?.SHOW_TEXT || "showText");

      const baseRow = EventRegistry.makeDefaultRow(safeType);

      const merged = foundry.utils.mergeObject(
        foundry.utils.deepClone(baseRow),
        foundry.utils.deepClone(row ?? {}),
        { inplace: false, overwrite: true }
      );

      merged.id = String(merged.id || foundry.utils.randomID());
      merged.type = safeType;

      return merged;
    });
  }

  function readEventData(tileLike) {
    const doc = tileLike?.document ?? tileLike;
    const found = findEventConfigObject(doc);
    const data = found?.data ?? {};

    return {
      isEventTile: normalizeBoolean(data?.isEventTile, false),
      isHidden: !!doc?.hidden,
      proximityPx: normalizeProximityPx(data?.proximityPx, C.DEFAULT_PROXIMITY_PX ?? 0),
      eventRows: normalizeEventRows(data?.eventRows ?? []),
      _scope: found?.scope ?? null,
      _raw: data
    };
  }

  function markTileRunning(tileId) {
    const safeTileId = String(tileId || "");
    if (!safeTileId) return;
    clientRunningTiles.add(safeTileId);
  }

  function unmarkTileRunning(tileId) {
    const safeTileId = String(tileId || "");
    if (!safeTileId) return;
    clientRunningTiles.delete(safeTileId);
  }

  function isTileRunningAnywhere(tileId) {
    const safeTileId = String(tileId || "");
    if (!safeTileId) return false;
    return gmActiveExecutions.has(safeTileId) || clientRunningTiles.has(safeTileId);
  }

  async function resolveCurrentDbContext() {
    try {
      const api = window.FUCompanion?.api;
      if (!api?.getCurrentGameDb) {
        DBG.verboseLog(DEBUG_SCOPE, "FUCompanion DB resolver not available.");
        return { db: null, source: null };
      }

      const cache = await api.getCurrentGameDb();
      return {
        db: cache?.db ?? null,
        source: cache?.source ?? null
      };
    } catch (e) {
      DBG.warn(DEBUG_SCOPE, "Failed resolving current DB context:", e);
      return { db: null, source: null };
    }
  }

  async function resolvePartyToken() {
    if (!canvas?.ready) return null;

    const controlled = canvas.tokens?.controlled?.[0] ?? null;
    if (controlled) {
      DBG.verboseLog(DEBUG_SCOPE, "Party token resolved from controlled token.", {
        tokenId: controlled.id,
        tokenName: controlled.name
      });
      return controlled;
    }

    const { db, source } = await resolveCurrentDbContext();
    if (!db) return null;

    const tokens = canvas.tokens?.placeables ?? [];
    const dbToken =
      tokens.find(t => t?.actor?.id === db.id) ||
      (source ? tokens.find(t => t?.actor?.id === source.id) : null) ||
      tokens.find(t => String(t?.name || "").trim() === String(db?.name || "").trim()) ||
      tokens.find(t => String(t?.actor?.name || "").trim() === String(db?.name || "").trim()) ||
      null;

    if (dbToken) {
      DBG.verboseLog(DEBUG_SCOPE, "Party token resolved from FUCompanion DB fallback.", {
        tokenId: dbToken.id,
        tokenName: dbToken.name
      });
    }

    return dbToken;
  }

  async function checkProximityForTile(tileLike, partyToken, overrideXY = null) {
    const data = readEventData(tileLike);
    const point = getAuthoritativeTokenCenterPx(partyToken, overrideXY);
    const rect = getTileRect(tileLike);
    const d = pointToRectDistance(point, rect);

    return {
      ok: d <= data.proximityPx,
      distance: d,
      proximityPx: data.proximityPx
    };
  }

  function buildRuntimeContext({ tileDoc, requesterId, partyToken }) {
    return {
      sceneId: canvas?.scene?.id ?? tileDoc?.parent?.id ?? null,
      tileId: tileDoc?.id ?? null,
      requesterId: requesterId ?? game?.user?.id ?? null,
      userId: requesterId ?? game?.user?.id ?? null,
      tokenId: partyToken?.id ?? null,
      actorId: partyToken?.actor?.id ?? null,
      partyToken,
      partyActor: partyToken?.actor ?? null
    };
  }

  function emitSocketMessage(type, payload) {
    for (const ch of CHANNELS) {
      try {
        game.socket.emit(ch, { type, payload });
        DBG.verboseLog(DEBUG_SCOPE, "Socket emit ok.", { channel: ch, type, payload });
        return true;
      } catch (e) {
        DBG.warn(DEBUG_SCOPE, "Socket emit failed on channel.", { channel: ch, type, error: e });
      }
    }
    return false;
  }

  // ------------------------------------------------------------
  // UI
  // ------------------------------------------------------------
  const CSS_ID = C.STYLE_ID_RUNTIME || "oni-event-runtime-style";

  function ensureCSS() {
    if (document.getElementById(CSS_ID)) return;

    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = `
#${C.UI_LAYER_ID || "oni-event-ui-layer"} {
  position: fixed;
  left: 0;
  top: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 90;
}

.${C.INTERACT_BUTTON_CLASS || "oni-event-btn"} {
  position: absolute;
  pointer-events: auto;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  background: rgba(255,255,255,0.95);
  border: 2px solid rgba(0,0,0,0.75);
  border-radius: 999px;
  box-shadow: 0 6px 10px rgba(0,0,0,0.35);
  cursor: pointer;
  user-select: none;
  transform: translate(-50%, -50%) scale(0.75);
  transform-origin: 50% 100%;
  opacity: 0;
  transition:
    transform 160ms ease-out,
    opacity 160ms ease-out;
}

.${C.INTERACT_BUTTON_CLASS || "oni-event-btn"} .mark {
  font-family: "Cinzel","Signika",var(--font-primary,"Signika"),system-ui,sans-serif;
  font-weight: 900;
  font-size: 20px;
  line-height: 1;
  color: rgba(20,16,10,0.95);
  transform: translateY(-1px);
}

.${C.INTERACT_BUTTON_CLASS || "oni-event-btn"}.is-visible {
  transform: translate(-50%, -50%) scale(1);
  opacity: 1;
}

.${C.INTERACT_BUTTON_CLASS || "oni-event-btn"}.is-hiding {
  transform: translate(-50%, -50%) scale(0.78);
  opacity: 0;
  transition:
    transform 140ms ease-in,
    opacity 140ms ease-in;
}

.${C.INTERACT_BUTTON_CLASS || "oni-event-btn"}:hover {
  transform: translate(-50%, -50%) scale(1.06);
}

.${C.INTERACT_BUTTON_CLASS || "oni-event-btn"}:active {
  transform: translate(-50%, -50%) scale(0.98);
}
    `;
    document.head.appendChild(style);
  }

  class EventUI {
    constructor(core) {
      this.core = core;
      this.layer = null;
      this.button = null;

      this.currentTileId = null;
      this.currentTokenId = null;

      this.desiredVisible = false;
      this.state = "hidden";
      this.hideTimer = null;
      this.opening = false;

      this._tickerFn = null;
    }

    start() {
      if (this.layer) return;

      ensureCSS();

      this.layer = document.createElement("div");
      this.layer.id = C.UI_LAYER_ID || "oni-event-ui-layer";
      document.body.appendChild(this.layer);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = C.INTERACT_BUTTON_CLASS || "oni-event-btn";
      btn.title = "Interact";
      btn.innerHTML = `<div class="mark">${C.INTERACT_BUTTON_TEXT || "!"}</div>`;

      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        const tileId = this.currentTileId;
        if (!tileId) return;
        if (this.opening) return;

        this.opening = true;
        btn.disabled = true;

        try {
          await this.core.requestExecute(tileId);
        } finally {
          setTimeout(() => {
            this.opening = false;
            if (this.button) this.button.disabled = false;
          }, 350);
        }
      });

      this.layer.appendChild(btn);
      this.button = btn;

      this._tickerFn = () => {
        if (!this.desiredVisible) return;
        if (!this.currentTokenId) return;

        const token = canvas?.tokens?.get?.(this.currentTokenId) || null;
        if (!token) return;

        const override = this.core._getOverride(this.currentTokenId);
        this.placeForToken(token, override ? { x: override.x, y: override.y } : null);
      };

      try {
        canvas.app.ticker.add(this._tickerFn, undefined, PIXI.UPDATE_PRIORITY.LOW);
      } catch (_) {}

      DBG.verboseLog(DEBUG_SCOPE, "Runtime UI started.");
    }

    stop() {
      if (this.hideTimer) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }

      try {
        if (this._tickerFn) canvas.app.ticker.remove(this._tickerFn);
      } catch (_) {}

      this.button?.remove();
      this.layer?.remove();

      this.button = null;
      this.layer = null;
      this.currentTileId = null;
      this.currentTokenId = null;
      this.desiredVisible = false;
      this.state = "hidden";
      this.opening = false;
      this._tickerFn = null;

      DBG.verboseLog(DEBUG_SCOPE, "Runtime UI stopped.");
    }

    showForCandidate(candidate, partyToken, overrideXY = null) {
      if (!this.button || !partyToken) return;

      this.currentTileId = candidate?.tileId ?? null;
      this.currentTokenId = partyToken.id;
      this.desiredVisible = true;
      this.button.title = candidate?.tileName ? `Interact: ${candidate.tileName}` : "Interact";

      this.placeForToken(partyToken, overrideXY);
      this._show();
    }

    hide() {
      this.desiredVisible = false;
      this.currentTileId = null;
      this._hide();
    }

    _show() {
      if (!this.button) return;
      if (this.state === "shown" || this.state === "showing") return;

      if (this.state === "hiding") {
        if (this.hideTimer) clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }

      this.state = "showing";
      this.button.classList.remove("is-hiding");

      requestAnimationFrame(() => {
        if (!this.button) return;
        this.button.classList.add("is-visible");
        this.state = "shown";
      });
    }

    _hide() {
      if (!this.button) return;
      if (this.state === "hidden" || this.state === "hiding") return;

      this.state = "hiding";
      this.button.classList.remove("is-visible");
      this.button.classList.add("is-hiding");

      this.hideTimer = setTimeout(() => {
        if (this.desiredVisible) {
          this.button?.classList.remove("is-hiding");
          this.button?.classList.add("is-visible");
          this.state = "shown";
          this.hideTimer = null;
          return;
        }

        this.button?.classList.remove("is-hiding");
        this.state = "hidden";
        this.hideTimer = null;
      }, 160);
    }

    placeForToken(token, overrideXY = null) {
      if (!this.button || !token) return;

      const center = getAuthoritativeTokenCenterPx(token, overrideXY);
      const screen = worldToScreen(center.x, center.y);

      // Slightly raised spawn point
      const verticalOffset = Math.max(54, Math.round((token.h / 2) + 63));
      const finalX = screen.x;
      const finalY = screen.y - verticalOffset;

      this.button.style.left = `${finalX}px`;
      this.button.style.top = `${finalY}px`;
    }
  }

  // ------------------------------------------------------------
  // GM execution
  // ------------------------------------------------------------
  async function gmExecuteEventTile({ sceneId, tileId, requesterId }) {
    const safeTileId = String(tileId || "");
    const safeSceneId = String(sceneId || "");

    const grouped = !!DBG.group?.(DEBUG_SCOPE, `GM Execute Tile [${safeTileId}]`, true);
    DBG.log(DEBUG_SCOPE, "Execution request received.", {
      sceneId: safeSceneId,
      tileId: safeTileId,
      requesterId
    });

    try {
      const scene = game.scenes?.get(safeSceneId);
      if (!scene) {
        DBG.warn(DEBUG_SCOPE, "Scene not found.", { sceneId: safeSceneId });
        return { ok: false, reason: "sceneNotFound", tileId: safeTileId };
      }

      const tileDoc = scene.tiles?.get(safeTileId);
      if (!tileDoc) {
        DBG.warn(DEBUG_SCOPE, "Tile not found.", { tileId: safeTileId, sceneId: safeSceneId });
        return { ok: false, reason: "tileNotFound", tileId: safeTileId };
      }

      if (tileDoc.hidden) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked because tile is hidden.", { tileId: safeTileId });
        return { ok: false, reason: "tileHidden", tileId: safeTileId };
      }

      const data = readEventData(tileDoc);

      if (!data.isEventTile) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked because tile is not an Event Tile.", { tileId: safeTileId });
        return { ok: false, reason: "notEventTile", tileId: safeTileId };
      }

      if (!Array.isArray(data.eventRows) || !data.eventRows.length) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked because tile has no event rows.", { tileId: safeTileId });
        return { ok: false, reason: "noEventRows", tileId: safeTileId };
      }

      if (gmActiveExecutions.has(safeTileId)) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked because tile is already running.", { tileId: safeTileId });
        return { ok: false, reason: "alreadyExecuting", tileId: safeTileId };
      }

      const partyToken = await resolvePartyToken();
      if (!partyToken) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked because no party token could be resolved.", { tileId: safeTileId });
        return { ok: false, reason: "noPartyToken", tileId: safeTileId };
      }

      const proximity = await checkProximityForTile(tileDoc, partyToken, null);
      if (!proximity.ok) {
        DBG.warn(DEBUG_SCOPE, "Execution blocked by proximity check.", {
          tileId: safeTileId,
          distance: Math.round(proximity.distance),
          proximityPx: proximity.proximityPx
        });
        return { ok: false, reason: "outOfRange", tileId: safeTileId, proximity };
      }

      gmActiveExecutions.add(safeTileId);
      markTileRunning(safeTileId);

      emitSocketMessage(MSG_EXECUTE_START, {
        sceneId: safeSceneId,
        tileId: safeTileId,
        requesterId
      });

      const context = buildRuntimeContext({
        tileDoc,
        requesterId,
        partyToken
      });

      DBG.log(DEBUG_SCOPE, "Beginning event sequence.", {
        tileId: safeTileId,
        rowCount: data.eventRows.length,
        proximityPx: data.proximityPx
      });
      DBG.verboseLog(DEBUG_SCOPE, "Execution context:", context);
      DBG.verboseLog(DEBUG_SCOPE, "Event rows:", data.eventRows);

      for (let i = 0; i < data.eventRows.length; i += 1) {
        const row = data.eventRows[i];
        const rowContext = {
          ...context,
          rowIndex: i,
          rowNumber: i + 1,
          totalRows: data.eventRows.length
        };

        DBG.log(DEBUG_SCOPE, "Executing row.", {
          tileId: safeTileId,
          rowIndex: i,
          rowNumber: i + 1,
          rowId: row?.id ?? null,
          type: row?.type ?? null
        });

        const result = await EventRegistry.executeRow(row, rowContext);

        DBG.verboseLog(DEBUG_SCOPE, "Row result:", result);

        if (!result?.ok) {
          DBG.warn(DEBUG_SCOPE, "Sequence stopped because a row failed.", {
            tileId: safeTileId,
            rowIndex: i,
            rowId: row?.id ?? null,
            result
          });

          emitSocketMessage(MSG_EXECUTE_ERROR, {
            sceneId: safeSceneId,
            tileId: safeTileId,
            requesterId,
            rowIndex: i,
            rowId: row?.id ?? null,
            result
          });

          return {
            ok: false,
            reason: "rowFailed",
            tileId: safeTileId,
            rowIndex: i,
            rowId: row?.id ?? null,
            result
          };
        }
      }

      DBG.log(DEBUG_SCOPE, "Event sequence finished.", {
        tileId: safeTileId,
        rowCount: data.eventRows.length
      });

      emitSocketMessage(MSG_EXECUTE_DONE, {
        sceneId: safeSceneId,
        tileId: safeTileId,
        requesterId
      });

      return {
        ok: true,
        tileId: safeTileId,
        sceneId: safeSceneId
      };
    } catch (e) {
      DBG.error(DEBUG_SCOPE, "GM execution failed.", e);

      emitSocketMessage(MSG_EXECUTE_ERROR, {
        sceneId: safeSceneId,
        tileId: safeTileId,
        requesterId,
        error: String(e?.message || e)
      });

      return {
        ok: false,
        reason: "exception",
        tileId: safeTileId,
        error: e
      };
    } finally {
      gmActiveExecutions.delete(safeTileId);
      unmarkTileRunning(safeTileId);
      if (grouped) DBG.groupEnd?.();
    }
  }

  // ------------------------------------------------------------
  // Core
  // ------------------------------------------------------------
  const core = {
    installed: true,
    running: false,

    ui: null,
    _hooks: [],
    _socketFn: null,
    _posOverrides: new Map(),
    _scanQueued: false,
    _activeCandidate: null,
    _followupScanTimers: [],

    getActiveCandidate() {
      return this._activeCandidate ? foundry.utils.deepClone(this._activeCandidate) : null;
    },

    _setOverride(tokenId, x, y) {
      this._posOverrides.set(String(tokenId), {
        x: Number(x),
        y: Number(y),
        ts: Date.now()
      });
    },

    _getOverride(tokenId) {
      const key = String(tokenId || "");
      const o = this._posOverrides.get(key);
      if (!o) return null;

      const ttl = Number(C.POS_OVERRIDE_TTL_MS ?? 800);
      if ((Date.now() - o.ts) > ttl) {
        this._posOverrides.delete(key);
        return null;
      }

      return o;
    },

    _cleanupOverrides() {
      const ttl = Number(C.POS_OVERRIDE_TTL_MS ?? 800);
      const now = Date.now();

      for (const [tokenId, o] of this._posOverrides.entries()) {
        if ((now - o.ts) > ttl) this._posOverrides.delete(tokenId);
      }
    },

    _clearFollowupScans() {
      for (const t of this._followupScanTimers) {
        try { clearTimeout(t); } catch (_) {}
      }
      this._followupScanTimers = [];
    },

    _scheduleFollowupScans(reasonBase = "followup") {
      this._clearFollowupScans();

      const delays = [80, 180, 320, 520];
      for (const ms of delays) {
        const timer = setTimeout(() => {
          this._queueScan(`${reasonBase}:${ms}ms`);
        }, ms);
        this._followupScanTimers.push(timer);
      }
    },

    _queueScan(reason = "unknown") {
      if (this._scanQueued) return;
      this._scanQueued = true;

      requestAnimationFrame(() => {
        requestAnimationFrame(async () => {
          this._scanQueued = false;
          await this.scan(reason);
        });
      });
    },

    async scan(reason = "scan") {
      try {
        if (!canvas?.ready) return;
        if (!this.running) return;

        this._cleanupOverrides();

        const partyToken = await resolvePartyToken();
        if (!partyToken) {
          this._activeCandidate = null;
          this.ui?.hide();
          DBG.verboseLog(DEBUG_SCOPE, "Scan aborted: no party token.", { reason });
          return;
        }

        const ov = this._getOverride(partyToken.id);
        const partyCenter = getAuthoritativeTokenCenterPx(
          partyToken,
          ov ? { x: ov.x, y: ov.y } : null
        );

        const tiles = canvas.tiles?.placeables ?? [];
        let best = null;

        for (const tile of tiles) {
          const data = readEventData(tile);
          if (!data.isEventTile) continue;
          if (data.isHidden) continue;
          if (!Array.isArray(data.eventRows) || !data.eventRows.length) continue;
          if (isTileRunningAnywhere(tile.id)) continue;

          const rect = getTileRect(tile);
          const d = pointToRectDistance(partyCenter, rect);

          if (d > data.proximityPx) continue;

          if (!best || d < best.distance) {
            best = {
              tileId: tile.id,
              tileName: tile.document?.name || tile.name || "Event Tile",
              distance: d,
              proximityPx: data.proximityPx
            };
          }
        }

        this._activeCandidate = best;

        if (best) {
          this.ui?.showForCandidate(
            best,
            partyToken,
            ov ? { x: ov.x, y: ov.y } : null
          );
        } else {
          this.ui?.hide();
        }

        DBG.verboseLog(DEBUG_SCOPE, "Scan result.", {
          reason,
          partyTokenId: partyToken.id,
          override: ov ?? null,
          activeCandidate: best
        });
      } catch (e) {
        DBG.error(DEBUG_SCOPE, "scan failed:", e);
      }
    },

    async requestExecute(tileId) {
      const safeTileId = String(tileId || "");

      try {
        const sceneId = canvas?.scene?.id;
        if (!sceneId || !safeTileId) return;

        DBG.log(DEBUG_SCOPE, "requestExecute called.", {
          sceneId,
          tileId: safeTileId,
          userId: game?.user?.id ?? null,
          isGM: !!game?.user?.isGM
        });

        // Immediate local suppression for snappier UX.
        markTileRunning(safeTileId);
        if (this._activeCandidate?.tileId === safeTileId) {
          this._activeCandidate = null;
          this.ui?.hide();
        }

        if (game?.user?.isGM) {
          await gmExecuteEventTile({
            sceneId,
            tileId: safeTileId,
            requesterId: game.user.id
          });
          this._queueScan("after-gm-execute");
          return;
        }

        const emitted = emitSocketMessage(MSG_EXECUTE_REQ, {
          sceneId,
          tileId: safeTileId,
          requesterId: game?.user?.id ?? null
        });

        if (!emitted) {
          unmarkTileRunning(safeTileId);
          this._queueScan("requestExecuteEmitFailed");
        }
      } catch (e) {
        unmarkTileRunning(safeTileId);
        DBG.error(DEBUG_SCOPE, "requestExecute failed:", e);
      }
    },

    async start() {
      if (this.running) return;

      if (!canvas?.ready) {
        DBG.warn(DEBUG_SCOPE, "start() called before canvas is ready.");
        return;
      }

      this.ui = new EventUI(this);
      this.ui.start();

      this._socketFn = async (msg) => {
        try {
          if (!msg?.type) return;

          if (msg.type === MSG_EXECUTE_REQ) {
            DBG.verboseLog(DEBUG_SCOPE, "Socket RX execute request.", msg);
            if (!game?.user?.isGM) return;

            await gmExecuteEventTile(msg.payload);
            this._queueScan("after-socket-execute");
            return;
          }

          if (msg.type === MSG_EXECUTE_START) {
            DBG.verboseLog(DEBUG_SCOPE, "Socket RX execute start.", msg);

            const runningTileId = String(msg?.payload?.tileId || "");
            if (runningTileId) {
              markTileRunning(runningTileId);

              if (this._activeCandidate?.tileId === runningTileId) {
                this._activeCandidate = null;
                this.ui?.hide();
              }
            }

            this._queueScan("after-execute-start");
            return;
          }

          if (msg.type === MSG_EXECUTE_DONE) {
            DBG.verboseLog(DEBUG_SCOPE, "Socket RX execute done.", msg);

            const finishedTileId = String(msg?.payload?.tileId || "");
            if (finishedTileId) {
              unmarkTileRunning(finishedTileId);
            }

            this._queueScan("after-execute-done");
            return;
          }

          if (msg.type === MSG_EXECUTE_ERROR) {
            DBG.warn(DEBUG_SCOPE, "Socket RX execute error.", msg);

            const erroredTileId = String(msg?.payload?.tileId || "");
            if (erroredTileId) {
              unmarkTileRunning(erroredTileId);
            }

            this._queueScan("after-execute-error");
            return;
          }
        } catch (e) {
          DBG.error(DEBUG_SCOPE, "Socket handler error:", e);
        }
      };

      for (const ch of CHANNELS) {
        try {
          game.socket.on(ch, this._socketFn);
          DBG.verboseLog(DEBUG_SCOPE, "Socket listener installed.", { channel: ch });
        } catch (e) {
          DBG.warn(DEBUG_SCOPE, "Failed installing socket listener.", { channel: ch, error: e });
        }
      }

      const onUpdateToken = async (tokenDoc, changes) => {
        const moved = ("x" in changes) || ("y" in changes);
        if (!moved) return;

        const partyToken = await resolvePartyToken();
        if (!partyToken) return;
        if (String(tokenDoc.id) !== String(partyToken.id)) return;

        const afterX = ("x" in changes) ? changes.x : tokenDoc.x;
        const afterY = ("y" in changes) ? changes.y : tokenDoc.y;

        this._setOverride(tokenDoc.id, afterX, afterY);

        // Reposition immediately using authoritative doc coords
        this.ui?.placeForToken(partyToken, { x: afterX, y: afterY });

        // Immediate + delayed rescans to reduce spawn/hide drift during token slide
        this._queueScan("updateToken(move)");
        this._scheduleFollowupScans("updateTokenFollowup");
      };

      const onCreateToken = () => this._queueScan("createToken");
      const onDeleteToken = () => this._queueScan("deleteToken");
      const onCreateTile = () => this._queueScan("createTile");
      const onDeleteTile = () => this._queueScan("deleteTile");
      const onUpdateTile = () => this._queueScan("updateTile");
      const onControlToken = () => this._queueScan("controlToken");
      const onCanvasPan = async () => {
        const partyToken = await resolvePartyToken();
        if (!partyToken) return;
        const ov = this._getOverride(partyToken.id);
        this.ui?.placeForToken(partyToken, ov ? { x: ov.x, y: ov.y } : null);
      };
      const onCanvasReady = () => this._queueScan("canvasReady");
      const onResize = async () => {
        const partyToken = await resolvePartyToken();
        if (!partyToken) return;
        const ov = this._getOverride(partyToken.id);
        this.ui?.placeForToken(partyToken, ov ? { x: ov.x, y: ov.y } : null);
      };

      Hooks.on("updateToken", onUpdateToken);
      Hooks.on("createToken", onCreateToken);
      Hooks.on("deleteToken", onDeleteToken);
      Hooks.on("createTile", onCreateTile);
      Hooks.on("deleteTile", onDeleteTile);
      Hooks.on("updateTile", onUpdateTile);
      Hooks.on("controlToken", onControlToken);
      Hooks.on("canvasPan", onCanvasPan);
      Hooks.on("canvasReady", onCanvasReady);
      window.addEventListener("resize", onResize);

      this._hooks.push(["updateToken", onUpdateToken]);
      this._hooks.push(["createToken", onCreateToken]);
      this._hooks.push(["deleteToken", onDeleteToken]);
      this._hooks.push(["createTile", onCreateTile]);
      this._hooks.push(["deleteTile", onDeleteTile]);
      this._hooks.push(["updateTile", onUpdateTile]);
      this._hooks.push(["controlToken", onControlToken]);
      this._hooks.push(["canvasPan", onCanvasPan]);
      this._hooks.push(["canvasReady", onCanvasReady]);
      this._hooks.push(["resize", onResize]);

      this.running = true;

      await this.scan("start");

      DBG.log(DEBUG_SCOPE, "Event System started.", {
        channels: CHANNELS,
        buttonText: C.INTERACT_BUTTON_TEXT || "!",
        defaultProximityPx: C.DEFAULT_PROXIMITY_PX ?? 0
      });
    },

    async stop() {
      if (!this.running) return;

      for (const ch of CHANNELS) {
        try {
          game.socket.off(ch, this._socketFn);
        } catch (_) {}
      }

      for (const [evt, fn] of this._hooks) {
        try {
          if (evt === "resize") window.removeEventListener("resize", fn);
          else Hooks.off(evt, fn);
        } catch (_) {}
      }

      this._hooks = [];
      this._posOverrides.clear();
      this._scanQueued = false;
      this._activeCandidate = null;
      this._clearFollowupScans();
      clientRunningTiles.clear();

      this.ui?.stop();
      this.ui = null;

      this.running = false;

      DBG.log(DEBUG_SCOPE, "Event System stopped.");
    }
  };

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  window.oni.EventSystem.Core = core;

  // ------------------------------------------------------------
  // Auto boot
  // ------------------------------------------------------------
  function boot() {
    if (canvas?.ready) {
      core.start();
    } else {
      Hooks.once("canvasReady", () => core.start());
    }
  }

  Hooks.once("ready", () => {
    DBG.verboseLog(DEBUG_SCOPE, "Boot on ready.");
    boot();
  });

  console.log(INSTALL_TAG, "Installed. API: window.oni.EventSystem.Core");
})();
