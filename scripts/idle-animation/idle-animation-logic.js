/* ============================================================================
 * FabulaUltimaCompanion — Idle Animation System (LOGIC)
 * File: scripts/idle-animation/idle-animation-logic.js
 * Foundry VTT v12
 *
 * Responsibilities:
 * - Save/load idle animation config on ACTOR flags (global persistence)
 * - Apply/remove idle animations on Tokens
 * - Sync behavior across all clients via module socket
 * - Auto-apply when:
 *    - canvas becomes ready
 *    - a new token is spawned
 *    - a token is refreshed (mesh recreated)
 *
 * Animations:
 * - Float  : TokenMagic transform filter (based on your Idle Float.js)
 * - Bounce : PIXI transform bobbing (based on your DEMO Token Idle animation.js)
 * ============================================================================ */

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][IdleAnim][Logic]";

  // --------------------------------------------------------------------------
  // DEBUG TOGGLE
  // --------------------------------------------------------------------------
  // Turn ON/OFF logs by running in console:
  //   globalThis.ONI_IDLE_ANIM_DEBUG = true;  (or false)
  //
  if (globalThis.ONI_IDLE_ANIM_DEBUG === undefined) globalThis.ONI_IDLE_ANIM_DEBUG = true;

  function dbg(...args) {
    if (!globalThis.ONI_IDLE_ANIM_DEBUG) return;
    console.log(TAG, ...args);
  }
  function warn(...args) {
    console.warn(TAG, ...args);
  }
  function err(...args) {
    console.error(TAG, ...args);
  }

  // --------------------------------------------------------------------------
  // GLOBAL API (NO IMPORTS)
  // --------------------------------------------------------------------------
  const API_KEY = "__ONI_IDLE_ANIM_API__";
  if (globalThis[API_KEY]) {
    dbg("API already installed, skipping re-init.");
    return;
  }

  // --------------------------------------------------------------------------
  // ACTOR FLAG STORAGE
  // --------------------------------------------------------------------------
  const FLAG_KEY = "idleAnimation"; // flags.fabula-ultima-companion.idleAnimation

  function normalizeConfig(cfg) {
    return {
      float: !!cfg?.float,
      bounce: !!cfg?.bounce
    };
  }

  async function getActorConfig(actor) {
    if (!actor) return normalizeConfig(null);
    const cfg = actor.getFlag(MODULE_ID, FLAG_KEY);
    return normalizeConfig(cfg);
  }

  async function setActorConfig(actor, cfg) {
    if (!actor) return;
    const next = normalizeConfig(cfg);
    dbg("Saving actor config", { actor: actor.name, actorId: actor.id, next });
    await actor.setFlag(MODULE_ID, FLAG_KEY, next);
    return next;
  }

  // --------------------------------------------------------------------------
  // TOKEN RESOLUTION HELPERS
  // --------------------------------------------------------------------------
  function getTokenById(tokenId) {
    try {
      return canvas?.tokens?.get?.(tokenId) ?? null;
    } catch {
      return null;
    }
  }

  function getTokensForActor(actorId) {
    if (!canvas?.ready) return [];
    const list = canvas.tokens?.placeables ?? [];
    return list.filter(t => t?.actor?.id === actorId);
  }

  // --------------------------------------------------------------------------
  // FLOAT (TokenMagic) — based on your Idle Float.js
  // --------------------------------------------------------------------------
  const FLOAT_FILTER_ID = "oniIdleFloat"; // stable ID so we can remove/update

  function hasTokenMagic() {
    return !!globalThis.TokenMagic;
  }

  async function applyFloat(token) {
    if (!token?.document) return;

    if (!hasTokenMagic()) {
      warn("Float requested, but TokenMagic is not available. Install/enable Token Magic FX.");
      return;
    }

    // Based on your Idle Float.js filter shape
    const params = [{
      filterType: "transform",
      filterId: FLOAT_FILTER_ID,
      padding: 50,
      animated: {
        translationX: {
          animType: "sinOscillation",
          val1: -0,
          val2: +0,
          loopDuration: 1400
        },
        translationY: {
          animType: "cosOscillation",
          val1: -0.05,
          val2: +0.05,
          loopDuration: 3000
        }
      }
    }];

    try {
      // TokenMagic has multiple APIs depending on version; we’ll be defensive.
      if (typeof TokenMagic.addUpdateFilters === "function") {
        await TokenMagic.addUpdateFilters(token, params);
        dbg("Float applied via TokenMagic.addUpdateFilters()", { token: token.name, tokenId: token.id });
        return;
      }

      // Fallback: some builds expose addUpdateFiltersOnSelected only
      if (typeof TokenMagic.addUpdateFiltersOnSelected === "function") {
        // We do NOT want to change user selection, so we do a safe temporary control swap.
        const wasControlled = token.controlled;
        const previously = canvas.tokens.controlled.map(t => t.id);

        // Control this token only
        canvas.tokens.releaseAll();
        token.control({ releaseOthers: true });

        await TokenMagic.addUpdateFiltersOnSelected(params);

        // Restore previous control state
        canvas.tokens.releaseAll();
        for (const id of previously) canvas.tokens.get(id)?.control({ releaseOthers: false });
        if (!wasControlled) token.release?.();

        dbg("Float applied via TokenMagic.addUpdateFiltersOnSelected() fallback", { token: token.name, tokenId: token.id });
        return;
      }

      warn("TokenMagic is present, but no known addUpdateFilters API was found.");
    } catch (e) {
      err("Failed to apply Float", e);
    }
  }

  async function removeFloat(token) {
    if (!token?.document) return;
    if (!hasTokenMagic()) return;

    try {
      if (typeof TokenMagic.deleteFilters === "function") {
        // Try removing just our filter id if supported
        try {
          await TokenMagic.deleteFilters(token, FLOAT_FILTER_ID);
          dbg("Float removed via TokenMagic.deleteFilters(token, filterId)", { token: token.name, tokenId: token.id });
          return;
        } catch {
          // If that signature fails, try deleting all filters (last resort)
          await TokenMagic.deleteFilters(token);
          dbg("Float removed via TokenMagic.deleteFilters(token) fallback", { token: token.name, tokenId: token.id });
          return;
        }
      }

      if (typeof TokenMagic.deleteFiltersOnSelected === "function") {
        // Same safe temporary control swap
        const wasControlled = token.controlled;
        const previously = canvas.tokens.controlled.map(t => t.id);

        canvas.tokens.releaseAll();
        token.control({ releaseOthers: true });

        await TokenMagic.deleteFiltersOnSelected();

        canvas.tokens.releaseAll();
        for (const id of previously) canvas.tokens.get(id)?.control({ releaseOthers: false });
        if (!wasControlled) token.release?.();

        dbg("Float removed via TokenMagic.deleteFiltersOnSelected() fallback", { token: token.name, tokenId: token.id });
        return;
      }
    } catch (e) {
      err("Failed to remove Float", e);
    }
  }

  // --------------------------------------------------------------------------
  // BOUNCE (PIXI transform bobbing) — based on your DEMO script
  // --------------------------------------------------------------------------
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

      // stop ticker if nothing left
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

    g.active.set(token.id, {
      original,
      baseScaleY: token.mesh.scale.y,
      phaseOffsetMs
    });

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
    // If a token mesh got rebuilt (refreshToken), re-apply our stored transform state safely
    const g = bounceState();
    const st = g.active.get(token?.id);
    if (!st) return;
    if (!token?.mesh) return;

    // Re-anchor and update baseScaleY to current mesh scale
    token.mesh.anchor.set(0.5, 1.0);
    st.baseScaleY = token.mesh.scale.y;

    dbg("Bounce refreshed on token mesh rebuild", { token: token.name, tokenId: token.id });
  }

  // --------------------------------------------------------------------------
  // APPLY / REMOVE CONFIG ON A TOKEN
  // --------------------------------------------------------------------------
  async function applyConfigToToken(token, cfg) {
    if (!token) return;
    const config = normalizeConfig(cfg);

    dbg("Applying config to token", {
      token: token.name,
      tokenId: token.id,
      actor: token.actor?.name,
      actorId: token.actor?.id,
      config
    });

    // Float
    if (config.float) await applyFloat(token);
    else await removeFloat(token);

    // Bounce
    if (config.bounce) startBounce(token);
    else stopBounce(token);
  }

  async function applyActorConfigToAllTokens(actorId) {
    const actor = game.actors?.get(actorId);
    if (!actor) return;

    const cfg = await getActorConfig(actor);
    const tokens = getTokensForActor(actorId);

    dbg("Applying actor config to all tokens", {
      actor: actor.name,
      actorId,
      cfg,
      tokenCount: tokens.length
    });

    for (const t of tokens) await applyConfigToToken(t, cfg);
  }

  // --------------------------------------------------------------------------
  // SOCKET SYNC
  // --------------------------------------------------------------------------
  const SOCKET_EVENT = "idleAnimApply"; // our message type

  function emitSocketApply(actorId) {
    // Tell ALL clients to re-apply this actor’s config to their local token meshes
    try {
      game.socket.emit(`module.${MODULE_ID}`, {
        type: SOCKET_EVENT,
        actorId
      });
      dbg("Socket emit -> apply", { actorId });
    } catch (e) {
      err("Socket emit failed", e);
    }
  }

  function installSocketListener() {
    // Install once
    const KEY = "__ONI_IDLE_ANIM_SOCKET__";
    if (globalThis[KEY]) return;
    globalThis[KEY] = true;

    game.socket.on(`module.${MODULE_ID}`, async (payload) => {
      try {
        if (!payload || payload.type !== SOCKET_EVENT) return;
        const actorId = payload.actorId;
        dbg("Socket receive <- apply", payload);

        // Apply locally on this client
        await applyActorConfigToAllTokens(actorId);
      } catch (e) {
        err("Socket handler error", e);
      }
    });

    dbg("Socket listener installed:", `module.${MODULE_ID}`);
  }

  // --------------------------------------------------------------------------
  // HOOKS: AUTO-APPLY
  // --------------------------------------------------------------------------
  function installHooks() {
    // When canvas loads, apply to everything visible
    Hooks.on("canvasReady", async () => {
      try {
        dbg("canvasReady -> applying idle configs to all tokens");
        const tokens = canvas.tokens?.placeables ?? [];
        const actorIds = new Set(tokens.map(t => t?.actor?.id).filter(Boolean));

        for (const actorId of actorIds) await applyActorConfigToAllTokens(actorId);
      } catch (e) {
        err("canvasReady apply failed", e);
      }
    });

    // When new token is created, auto-apply its actor config
    Hooks.on("createToken", async (doc) => {
      try {
        if (!canvas?.ready) return;
        const token = getTokenById(doc.id);
        const actorId = token?.actor?.id ?? doc.actorId;
        if (!actorId) return;

        dbg("createToken -> auto-apply", { tokenId: doc.id, actorId });
        await applyActorConfigToAllTokens(actorId);
      } catch (e) {
        err("createToken apply failed", e);
      }
    });

    // When token mesh refreshes, restore bounce if active
    Hooks.on("refreshToken", (token) => {
      try {
        refreshBounceToken(token);
      } catch (e) {
        err("refreshToken handler failed", e);
      }
    });

    dbg("Hooks installed.");
  }

  // --------------------------------------------------------------------------
  // PUBLIC API for UI script (NO IMPORTS)
  // --------------------------------------------------------------------------
  globalThis[API_KEY] = {
    MODULE_ID,
    TAG,

    normalizeConfig,
    getActorConfig,
    setActorConfig,

    applyConfigToToken,
    applyActorConfigToAllTokens,

    emitSocketApply
  };

  // --------------------------------------------------------------------------
  // INIT
  // --------------------------------------------------------------------------
  Hooks.once("ready", () => {
    dbg("System ready -> installing socket + hooks");
    installSocketListener();
    installHooks();
  });

  dbg("Idle Animation LOGIC loaded.");
})();
