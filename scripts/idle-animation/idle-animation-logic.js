/* ============================================================================
 * FabulaUltimaCompanion — Idle Animation System (LOGIC)
 * File: scripts/idle-animation/idle-animation-logic.js
 * Foundry VTT v12
 *
 * Two-layer config:
 *  1) Actor default (Prototype Token) -> Actor flag
 *  2) Token override (Token Config)   -> TokenDocument flag
 *
 * Apply rules:
 *  - If token has override -> use override
 *  - Else -> use actor default
 *
 * Spawn timing:
 *  - Token document creation happens before token object is drawn.
 *  - We apply visuals when token is actually drawn (drawToken), with retry queue.
 *    (This matches your spawn hook probe intent.) :contentReference[oaicite:3]{index=3}
 *
 * Float:
 *  - Re-implemented to match your Idle Float script: uses TokenMagic
 *    addUpdateFiltersOnSelected / deleteFiltersOnSelected via temporary control. :contentReference[oaicite:4]{index=4}
 * ============================================================================ */

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][IdleAnim][Logic]";

  // DEBUG TOGGLE
  if (globalThis.ONI_IDLE_ANIM_DEBUG === undefined) globalThis.ONI_IDLE_ANIM_DEBUG = true;
  function dbg(...args) { if (globalThis.ONI_IDLE_ANIM_DEBUG) console.log(TAG, ...args); }
  function warn(...args) { console.warn(TAG, ...args); }
  function err(...args) { console.error(TAG, ...args); }

  // GLOBAL API (NO IMPORTS)
  const API_KEY = "__ONI_IDLE_ANIM_API__";
  if (globalThis[API_KEY]) {
    dbg("API already installed, skipping re-init.");
    return;
  }

  // FLAGS
  const ACTOR_FLAG_KEY = "idleAnimation";          // flags.<module>.idleAnimation
  const TOKEN_OVERRIDE_FLAG_KEY = "idleAnimToken"; // flags.<module>.idleAnimToken (per-token override)

  function normalizeConfig(cfg) {
    return { float: !!cfg?.float, bounce: !!cfg?.bounce };
  }

  // ----------------------------
  // ACTOR DEFAULT (prototype)
  // ----------------------------
  async function getActorDefaultConfig(actor) {
    if (!actor) return normalizeConfig(null);
    return normalizeConfig(actor.getFlag(MODULE_ID, ACTOR_FLAG_KEY));
  }

  async function setActorDefaultConfig(actor, cfg) {
    if (!actor) return;
    const next = normalizeConfig(cfg);
    dbg("Saving ACTOR default config", { actor: actor.name, actorId: actor.id, next });
    await actor.setFlag(MODULE_ID, ACTOR_FLAG_KEY, next);
    return next;
  }

  // ----------------------------
  // TOKEN OVERRIDE
  // ----------------------------
  async function getTokenOverrideConfig(tokenDocOrToken) {
    const doc = tokenDocOrToken?.document ?? tokenDocOrToken;
    if (!doc) return null;
    const cfg = doc.getFlag?.(MODULE_ID, TOKEN_OVERRIDE_FLAG_KEY);
    if (!cfg) return null;
    return normalizeConfig(cfg);
  }

  async function setTokenOverrideConfig(tokenDocOrToken, cfg) {
    const doc = tokenDocOrToken?.document ?? tokenDocOrToken;
    if (!doc) return;
    const next = normalizeConfig(cfg);
    dbg("Saving TOKEN override config", { tokenId: doc.id, name: doc.name, next });
    await doc.setFlag(MODULE_ID, TOKEN_OVERRIDE_FLAG_KEY, next);
    return next;
  }

  async function clearTokenOverrideConfig(tokenDocOrToken) {
    const doc = tokenDocOrToken?.document ?? tokenDocOrToken;
    if (!doc) return;
    dbg("Clearing TOKEN override config", { tokenId: doc.id, name: doc.name });
    await doc.unsetFlag(MODULE_ID, TOKEN_OVERRIDE_FLAG_KEY);
  }

  // ----------------------------
  // EFFECTIVE CONFIG (token view)
  // ----------------------------
  async function getEffectiveConfigForToken(token) {
    const sourceActorId = token?.document?.actorId;
    const actor = sourceActorId ? game.actors?.get(sourceActorId) : null;

    const override = await getTokenOverrideConfig(token);
    if (override) return { config: override, source: "tokenOverride" };

    const base = await getActorDefaultConfig(actor);
    return { config: base, source: "actorDefault" };
  }

  // ----------------------------
  // TOKEN RESOLUTION
  // ----------------------------
  function getTokenById(tokenId) {
    try { return canvas?.tokens?.get?.(tokenId) ?? null; }
    catch { return null; }
  }

  function getTokensForSourceActor(sourceActorId) {
    if (!canvas?.ready) return [];
    const list = canvas.tokens?.placeables ?? [];
    return list.filter(t => t?.document?.actorId === sourceActorId);
  }

  // ==========================================================================
  // FLOAT (TokenMagic) — re-implemented to match your Idle Float.js approach
  // (temporary control + addUpdateFiltersOnSelected / deleteFiltersOnSelected) :contentReference[oaicite:5]{index=5}
  // ==========================================================================
  const FLOAT_FILTER_ID = "oniIdleFloat";

  function hasTokenMagic() {
    return !!globalThis.TokenMagic
      && (typeof TokenMagic.addUpdateFiltersOnSelected === "function");
  }

  async function withTempControl(token, fn) {
    // Controls token temporarily so OnSelected APIs work, then restore controls.
    const previously = canvas.tokens.controlled.map(t => t.id);
    const wasControlled = token.controlled;

    try {
      canvas.tokens.releaseAll();
      token.control({ releaseOthers: true });
      await fn();
    } finally {
      canvas.tokens.releaseAll();
      for (const id of previously) canvas.tokens.get(id)?.control({ releaseOthers: false });
      if (!wasControlled) token.release?.();
    }
  }

  async function applyFloat(token) {
    if (!token?.document) return;

    if (!hasTokenMagic()) {
      warn("Float requested, but TokenMagic.addUpdateFiltersOnSelected is not available.");
      return;
    }

    // Directly based on your Idle Float.js params (transform filter) :contentReference[oaicite:6]{index=6}
    const params = [{
      filterType: "transform",
      filterId: FLOAT_FILTER_ID,
      padding: 50,
      animated: {
        translationX: { animType: "sinOscillation", val1: -0, val2: +0, loopDuration: 1400 },
        translationY: { animType: "cosOscillation", val1: -0.05, val2: +0.05, loopDuration: 3000 }
      }
    }];

    try {
      await withTempControl(token, async () => {
        await TokenMagic.addUpdateFiltersOnSelected(params);
      });

      dbg("Float applied (OnSelected)", { token: token.name, tokenId: token.id });
    } catch (e) {
      err("Failed to apply Float", e);
    }
  }

  async function removeFloat(token) {
    if (!token?.document) return;

    if (!globalThis.TokenMagic) return;

    try {
      // Prefer targeted removal if available
      if (typeof TokenMagic.deleteFilters === "function") {
        try {
          await TokenMagic.deleteFilters(token, FLOAT_FILTER_ID);
          dbg("Float removed via TokenMagic.deleteFilters(token, filterId)", { token: token.name, tokenId: token.id });
          return;
        } catch {
          // ignore and fallback to OnSelected
        }
      }

      if (typeof TokenMagic.deleteFiltersOnSelected === "function") {
        await withTempControl(token, async () => {
          // Many builds only support deleteFiltersOnSelected() (no args) like your script :contentReference[oaicite:7]{index=7}
          await TokenMagic.deleteFiltersOnSelected();
        });

        dbg("Float removed (OnSelected fallback)", { token: token.name, tokenId: token.id });
        return;
      }
    } catch (e) {
      err("Failed to remove Float", e);
    }
  }

  // ==========================================================================
  // BOUNCE (PIXI)
  // ==========================================================================
  const BOUNCE_NS = "__ONI_IDLE_BOUNCE__";
  const BOUNCE_AMP = 0.025;
  const BOUNCE_PERIOD_MS = 2500;

  function bounceState() {
    return (globalThis[BOUNCE_NS] = globalThis[BOUNCE_NS] || {
      active: new Map(), // tokenId -> state
      tickerFn: null,
      timeMs: 0
    });
  }

  function ensureBounceTicker() {
    const g = bounceState();
    if (g.tickerFn) return;

    g.timeMs = 0;
    g.tickerFn = () => {
      if (!canvas?.ready) return;

      g.timeMs += canvas.app.ticker.deltaMS;
      const twoPi = Math.PI * 2;

      for (const [id, st] of g.active) {
        const token = canvas.tokens.get(id);
        if (!token || !token.mesh) {
          g.active.delete(id);
          continue;
        }
        const phase = ((g.timeMs + st.phaseOffsetMs) % BOUNCE_PERIOD_MS) / BOUNCE_PERIOD_MS;
        const scaleY = 1 + BOUNCE_AMP * Math.sin(phase * twoPi);
        token.mesh.scale.y = st.baseScaleY * scaleY;
      }

      if (!g.active.size) {
        canvas.app.ticker.remove(g.tickerFn);
        g.tickerFn = null;
        dbg("Bounce ticker stopped (no active tokens).");
      }
    };

    canvas.app.ticker.add(g.tickerFn);
    dbg("Bounce ticker started.");
  }

  function startBounce(token) {
    if (!token?.mesh) return;
    const g = bounceState();
    if (g.active.has(token.id)) return;

    const original = {
      anchorX: token.mesh.anchor.x,
      anchorY: token.mesh.anchor.y,
      scaleX: token.mesh.scale.x,
      scaleY: token.mesh.scale.y
    };

    token.mesh.anchor.set(0.5, 1.0);
    const phaseOffsetMs = Math.floor(Math.random() * BOUNCE_PERIOD_MS);

    g.active.set(token.id, { original, baseScaleY: token.mesh.scale.y, phaseOffsetMs });
    ensureBounceTicker();
    dbg("Bounce started", { token: token.name, tokenId: token.id });
  }

  function stopBounce(token) {
    const g = bounceState();
    const st = g.active.get(token?.id);
    if (!st) return;

    if (token?.mesh) {
      token.mesh.anchor.set(st.original.anchorX, st.original.anchorY);
      token.mesh.scale.set(st.original.scaleX, st.original.scaleY);
    }

    g.active.delete(token.id);
    dbg("Bounce stopped", { token: token.name, tokenId: token.id });
  }

  function refreshBounceToken(token) {
    const g = bounceState();
    const st = g.active.get(token?.id);
    if (!st) return;
    if (!token?.mesh) return;

    token.mesh.anchor.set(0.5, 1.0);
    st.baseScaleY = token.mesh.scale.y;
    dbg("Bounce refreshed (mesh rebuild)", { token: token.name, tokenId: token.id });
  }

  // ----------------------------
  // APPLY CONFIG
  // ----------------------------
  async function applyConfigToToken(token, cfg) {
    if (!token) return;
    const config = normalizeConfig(cfg);

    dbg("Applying config to token", {
      token: token.name,
      tokenId: token.id,
      sourceActorId: token?.document?.actorId,
      config
    });

    // Float
    if (config.float) await applyFloat(token);
    else await removeFloat(token);

    // Bounce
    if (config.bounce) startBounce(token);
    else stopBounce(token);
  }

  async function applyEffectiveConfigToToken(token) {
    if (!token) return;
    const { config, source } = await getEffectiveConfigForToken(token);
    dbg("applyEffectiveConfigToToken()", { tokenId: token.id, token: token.name, source, config });
    await applyConfigToToken(token, config);
  }

  async function applyActorToAllTokens(sourceActorId) {
    const tokens = getTokensForSourceActor(sourceActorId);
    dbg("applyActorToAllTokens()", { sourceActorId, tokenCount: tokens.length });

    for (const t of tokens) {
      await applyEffectiveConfigToToken(t); // respects per-token override automatically
    }
  }

  // ==========================================================================
  // SPAWN APPLY QUEUE (timing fix)
  // - createToken can fire before canvas token object exists
  // - drawToken confirms token object exists and is drawn
  // - we also do retries in case mesh isn't ready on first draw
  // ==========================================================================
  const APPLY_QUEUE = new Map(); // tokenId -> { tries, reason, scheduled }

  function queueApplyToken(tokenId, reason) {
    if (!tokenId) return;
    const cur = APPLY_QUEUE.get(tokenId) ?? { tries: 0, reason, scheduled: false };
    cur.reason = reason;
    APPLY_QUEUE.set(tokenId, cur);

    if (!cur.scheduled) {
      cur.scheduled = true;
      setTimeout(() => processQueue(), 0);
    }

    dbg("queueApplyToken()", { tokenId, reason, tries: cur.tries });
  }

  async function processQueue() {
    for (const [tokenId, st] of APPLY_QUEUE) {
      const token = getTokenById(tokenId);

      // Token object not ready yet
      if (!token) {
        st.tries++;
        st.scheduled = false;
        if (st.tries < 10) {
          APPLY_QUEUE.set(tokenId, st);
          setTimeout(() => queueApplyToken(tokenId, st.reason + " -> retry(no token)"), 50);
        } else {
          APPLY_QUEUE.delete(tokenId);
          warn("Spawn apply gave up (token never appeared).", { tokenId, reason: st.reason });
        }
        continue;
      }

      // If mesh isn't ready yet, retry (TokenMagic cares about visuals being ready)
      if (!token.mesh) {
        st.tries++;
        st.scheduled = false;
        if (st.tries < 10) {
          APPLY_QUEUE.set(tokenId, st);
          setTimeout(() => queueApplyToken(tokenId, st.reason + " -> retry(no mesh)"), 50);
        } else {
          APPLY_QUEUE.delete(tokenId);
          warn("Spawn apply gave up (mesh never appeared).", { tokenId, reason: st.reason });
        }
        continue;
      }

      // Good to apply now
      APPLY_QUEUE.delete(tokenId);
      try {
        dbg("processQueue -> applying effective config", { tokenId, reason: st.reason });
        await applyEffectiveConfigToToken(token);
      } catch (e) {
        err("processQueue apply failed", e);
      }
    }
  }

  // ==========================================================================
  // SOCKET SYNC
  // ==========================================================================
  const SOCKET_EVENT = "idleAnimSync";

  function emitSocketApplyActor(actorId) {
    try {
      game.socket.emit(`module.${MODULE_ID}`, { type: SOCKET_EVENT, mode: "applyActor", actorId });
      dbg("Socket emit -> applyActor", { actorId });
    } catch (e) {
      err("Socket emit failed", e);
    }
  }

  function emitSocketApplyToken(tokenId) {
    try {
      game.socket.emit(`module.${MODULE_ID}`, { type: SOCKET_EVENT, mode: "applyToken", tokenId });
      dbg("Socket emit -> applyToken", { tokenId });
    } catch (e) {
      err("Socket emit failed", e);
    }
  }

  function installSocketListener() {
    const KEY = "__ONI_IDLE_ANIM_SOCKET__";
    if (globalThis[KEY]) return;
    globalThis[KEY] = true;

    game.socket.on(`module.${MODULE_ID}`, async (payload) => {
      try {
        if (!payload || payload.type !== SOCKET_EVENT) return;

        if (payload.mode === "applyActor") {
          dbg("Socket receive <- applyActor", payload);
          await applyActorToAllTokens(payload.actorId);
          return;
        }

        if (payload.mode === "applyToken") {
          dbg("Socket receive <- applyToken", payload);
          queueApplyToken(payload.tokenId, "socket.applyToken");
          return;
        }
      } catch (e) {
        err("Socket handler error", e);
      }
    });

    dbg("Socket listener installed:", `module.${MODULE_ID}`);
  }

  // ==========================================================================
  // HOOKS: AUTO APPLY
  // ==========================================================================
  function installHooks() {
    Hooks.on("canvasReady", async () => {
      try {
        dbg("canvasReady -> applying effective configs to all tokens");
        const tokens = canvas.tokens?.placeables ?? [];
        for (const t of tokens) await applyEffectiveConfigToToken(t);
      } catch (e) {
        err("canvasReady apply failed", e);
      }
    });

    // Document created (may fire before token object exists)
    Hooks.on("createToken", async (doc) => {
      try {
        dbg("createToken -> queued auto-apply", {
          tokenId: doc.id,
          name: doc.name,
          actorId: doc.actorId,
          actorLink: doc.actorLink
        });
        queueApplyToken(doc.id, "createToken");
      } catch (e) {
        err("createToken handler failed", e);
      }
    });

    // Some operations fire createTokenDocument instead
    Hooks.on("createTokenDocument", async (doc) => {
      try {
        dbg("createTokenDocument -> queued auto-apply", {
          tokenId: doc.id,
          name: doc.name,
          actorId: doc.actorId
        });
        queueApplyToken(doc.id, "createTokenDocument");
      } catch (e) {
        err("createTokenDocument handler failed", e);
      }
    });

    // The BEST signal for “token exists on canvas now” (your probe includes this) :contentReference[oaicite:8]{index=8}
    Hooks.on("drawToken", (tokenObj) => {
      try {
        const tokenId = tokenObj?.id ?? tokenObj?.document?.id;
        dbg("drawToken -> queued auto-apply", { tokenId, name: tokenObj?.name });
        queueApplyToken(tokenId, "drawToken");
      } catch (e) {
        err("drawToken handler failed", e);
      }
    });

    Hooks.on("refreshToken", (token) => {
      try {
        refreshBounceToken(token);
        // If refresh rebuilds mesh, re-apply float safely too (optional but helps)
        queueApplyToken(token.id, "refreshToken");
      } catch (e) {
        err("refreshToken handler failed", e);
      }
    });

    dbg("Hooks installed (createToken/createTokenDocument/drawToken/refreshToken).");
  }

  // ----------------------------
  // PUBLIC API for UI
  // ----------------------------
  globalThis[API_KEY] = {
    MODULE_ID,
    TAG,

    normalizeConfig,

    // actor default (prototype)
    getActorDefaultConfig,
    setActorDefaultConfig,

    // token override
    getTokenOverrideConfig,
    setTokenOverrideConfig,
    clearTokenOverrideConfig,

    // apply
    applyConfigToToken,
    applyEffectiveConfigToToken,
    applyActorToAllTokens,

    // sockets
    emitSocketApplyActor,
    emitSocketApplyToken
  };

  Hooks.once("ready", () => {
    dbg("System ready -> installing socket + hooks");
    installSocketListener();
    installHooks();
  });

  dbg("Idle Animation LOGIC loaded.");
})();
