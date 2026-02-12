// fabula-ultima-companion
// Idle Animation Manager (Float + Bounce)
// - Reads from token flags:
//   flags["fabula-ultima-companion"].idleAnim = { float: boolean, bounce: boolean }
// - Applies visuals locally on each client when a token updates
// - Designed to be safe, idempotent, and not nuke other TokenMagic filters

export const OniIdleAnimManager = (() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][IdleAnim]";
  const FLAG_PATH = "idleAnim";

  // ---------------------------
  // Bounce (mesh ticker system)
  // ---------------------------
  const BOUNCE_NS = "__ONI_IDLE_BOUNCE__";
  const BOUNCE_AMP = 0.025;      // same as your demo
  const BOUNCE_PERIOD_MS = 2500; // same as your demo

  function getBounceState() {
    const g = (globalThis[BOUNCE_NS] = globalThis[BOUNCE_NS] || {
      active: new Map(),  // tokenId -> { original, baseScaleY, phaseOffsetMs }
      tickerFn: null,
      timeMs: 0
    });
    return g;
  }

  function ensureBounceTicker() {
    const g = getBounceState();
    if (g.tickerFn) return;

    if (!canvas?.ready) return;

    g.timeMs = 0;
    g.tickerFn = () => {
      g.timeMs += canvas.app.ticker.deltaMS;
      const twoPi = Math.PI * 2;

      for (const [tokenId, st] of g.active) {
        const token = canvas.tokens?.get(tokenId);
        if (!token?.mesh) {
          g.active.delete(tokenId);
          continue;
        }

        const phase = ((g.timeMs + st.phaseOffsetMs) % BOUNCE_PERIOD_MS) / BOUNCE_PERIOD_MS;
        const scaleY = 1 + BOUNCE_AMP * Math.sin(phase * twoPi);

        token.mesh.scale.y = st.baseScaleY * scaleY;
      }

      // stop ticker if nothing active
      if (!g.active.size) {
        canvas.app.ticker.remove(g.tickerFn);
        g.tickerFn = null;
      }
    };

    canvas.app.ticker.add(g.tickerFn);
  }

  function startBounce(token) {
    if (!token?.mesh) return;
    const g = getBounceState();
    if (g.active.has(token.id)) return; // already running

    const original = {
      anchorX: token.mesh.anchor.x,
      anchorY: token.mesh.anchor.y,
      scaleX: token.mesh.scale.x,
      scaleY: token.mesh.scale.y
    };

    // bottom-center anchor: “breath” expands upward
    token.mesh.anchor.set(0.5, 1.0);

    const phaseOffsetMs = Math.floor(Math.random() * BOUNCE_PERIOD_MS);

    g.active.set(token.id, {
      original,
      baseScaleY: token.mesh.scale.y,
      phaseOffsetMs
    });

    ensureBounceTicker();
  }

  function stopBounce(token) {
    const g = getBounceState();
    const st = g.active.get(token.id);
    if (!st) return;

    if (token?.mesh) {
      token.mesh.anchor.set(st.original.anchorX, st.original.anchorY);
      token.mesh.scale.set(st.original.scaleX, st.original.scaleY);
    }
    g.active.delete(token.id);
  }

  // ---------------------------
  // Float (TokenMagic filter)
  // ---------------------------
  const FLOAT_FILTER_ID = "oniIdleFloat";

  function hasTokenMagic() {
    return !!globalThis.TokenMagic;
  }

  async function applyFloat(token, enabled) {
    // If TokenMagic isn’t installed, we just skip (no hard error).
    if (!hasTokenMagic()) {
      if (enabled) console.warn(`${TAG} Float requested but TokenMagic not found.`);
      return;
    }

    // We only touch OUR filterId so we don't delete other module effects.
    // NOTE: TokenMagic API can differ depending on version.
    const tm = globalThis.TokenMagic;

    // Build params based on your Idle Float style (transform oscillation).
    // (The file you provided uses translationY cosOscillation etc.) :contentReference[oaicite:2]{index=2}
    const params = [{
      filterType: "transform",
      filterId: FLOAT_FILTER_ID,
      padding: 50,
      animated: {
        translationX: { animType: "sinOscillation", val1: 0, val2: 0, loopDuration: 1400 },
        translationY: { animType: "cosOscillation", val1: -0.05, val2: 0.05, loopDuration: 3000 }
      }
    }];

    try {
      if (enabled) {
        // Prefer token-targeted API if available
        if (typeof tm.addUpdateFilters === "function") {
          await tm.addUpdateFilters(token, params);
        } else if (typeof tm.addUpdateFiltersOnSelected === "function") {
          // fallback: temporarily control token (not ideal, but works in many setups)
          const wasControlled = token.controlled;
          if (!wasControlled) token.control({ releaseOthers: false });
          await tm.addUpdateFiltersOnSelected(params);
          if (!wasControlled) token.release();
        } else {
          console.warn(`${TAG} TokenMagic API not recognized; cannot apply Float.`);
        }
      } else {
        // remove only our filter
        if (typeof tm.deleteFilters === "function") {
          await tm.deleteFilters(token, FLOAT_FILTER_ID);
        } else if (typeof tm.deleteFiltersOnSelected === "function") {
          const wasControlled = token.controlled;
          if (!wasControlled) token.control({ releaseOthers: false });
          await tm.deleteFiltersOnSelected(FLOAT_FILTER_ID);
          if (!wasControlled) token.release();
        } else if (typeof tm.deleteFiltersOnToken === "function") {
          await tm.deleteFiltersOnToken(token, FLOAT_FILTER_ID);
        } else {
          // last-resort: if we only have "deleteFiltersOnSelected" with no filter id support,
          // we do NOT call it (would delete other people's effects).
          console.warn(`${TAG} No safe TokenMagic delete method found for filterId=${FLOAT_FILTER_ID}.`);
        }
      }
    } catch (err) {
      console.error(`${TAG} Float apply/remove failed`, err);
    }
  }

  // ---------------------------
  // Public: apply for token doc
  // ---------------------------
  function readFlags(doc) {
    const f = doc?.flags?.[MODULE_ID]?.[FLAG_PATH] ?? {};
    return {
      float: !!f.float,
      bounce: !!f.bounce
    };
  }

  async function applyFromDoc(doc) {
    if (!canvas?.ready) return;

    // Only applies to tokens on the canvas
    const token = canvas.tokens?.get(doc.id);
    if (!token) return;

    const { float, bounce } = readFlags(doc);

    // Bounce (mesh)
    if (bounce) startBounce(token);
    else stopBounce(token);

    // Float (TokenMagic)
    await applyFloat(token, float);
  }

  // In case tokens refresh or canvas reloads, reapply to all tokens
  async function applyAllOnCanvas() {
    if (!canvas?.ready) return;
    for (const token of canvas.tokens?.placeables ?? []) {
      await applyFromDoc(token.document);
    }
  }

  return {
    MODULE_ID,
    readFlags,
    applyFromDoc,
    applyAllOnCanvas
  };
})();
