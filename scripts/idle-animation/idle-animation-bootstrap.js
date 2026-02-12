/**
 * fabula-ultima-companion — Idle Animation System (BOOTSTRAP)
 * Loaded via module.json "scripts" (no imports)
 *
 * Features:
 * - Inject "Idle Animation" tab into TokenConfig
 * - Two booleans saved via token flags when user clicks "Update Token":
 *   flags.fabula-ultima-companion.idleAnim.float
 *   flags.fabula-ultima-companion.idleAnim.bounce
 * - Applies animations for all clients (token updates sync automatically)
 *
 * Notes:
 * - Float uses TokenMagic if present (safe no-op if missing)
 * - Bounce uses PIXI mesh ticker (no dependencies)
 */

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][IdleAnim]";
  const TAB_ID = "oni-idle-animation";
  const GROUP = "main";
  const FLOAT_FILTER_ID = "oniIdleFloat";

  // ---------------------------
  // Helpers: flags
  // ---------------------------
  function readFlags(doc) {
    const f = doc?.flags?.[MODULE_ID]?.idleAnim ?? {};
    return { float: !!f.float, bounce: !!f.bounce };
  }

  // ---------------------------
  // Bounce system (PIXI ticker)
  // ---------------------------
  const BOUNCE_NS = "__ONI_IDLE_BOUNCE__";
  const BOUNCE_AMP = 0.025;
  const BOUNCE_PERIOD_MS = 2500;

  function getBounceState() {
    return (globalThis[BOUNCE_NS] = globalThis[BOUNCE_NS] || {
      active: new Map(), // tokenId -> { original, baseScaleY, phaseOffsetMs }
      tickerFn: null,
      timeMs: 0
    });
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
  // Float system (TokenMagic)
  // ---------------------------
  function hasTokenMagic() {
    return !!globalThis.TokenMagic;
  }

  async function applyFloat(token, enabled) {
    if (!hasTokenMagic()) {
      if (enabled) console.warn(`${TAG} Float requested but TokenMagic not found.`);
      return;
    }

    const tm = globalThis.TokenMagic;

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
        if (typeof tm.addUpdateFilters === "function") {
          await tm.addUpdateFilters(token, params);
        } else if (typeof tm.addUpdateFiltersOnSelected === "function") {
          const wasControlled = token.controlled;
          if (!wasControlled) token.control({ releaseOthers: false });
          await tm.addUpdateFiltersOnSelected(params);
          if (!wasControlled) token.release();
        } else {
          console.warn(`${TAG} TokenMagic API not recognized; cannot apply Float.`);
        }
      } else {
        // remove only OUR filterId (don't break other effects)
        if (typeof tm.deleteFilters === "function") {
          await tm.deleteFilters(token, FLOAT_FILTER_ID);
        } else if (typeof tm.deleteFiltersOnToken === "function") {
          await tm.deleteFiltersOnToken(token, FLOAT_FILTER_ID);
        } else if (typeof tm.deleteFiltersOnSelected === "function") {
          const wasControlled = token.controlled;
          if (!wasControlled) token.control({ releaseOthers: false });
          await tm.deleteFiltersOnSelected(FLOAT_FILTER_ID);
          if (!wasControlled) token.release();
        } else {
          console.warn(`${TAG} No safe TokenMagic delete method found for filterId=${FLOAT_FILTER_ID}.`);
        }
      }
    } catch (err) {
      console.error(`${TAG} Float apply/remove failed`, err);
    }
  }

  // ---------------------------
  // Apply from token doc
  // ---------------------------
  async function applyFromDoc(doc) {
    if (!canvas?.ready) return;
    const token = canvas.tokens?.get(doc.id);
    if (!token) return;

    const { float, bounce } = readFlags(doc);

    if (bounce) startBounce(token);
    else stopBounce(token);

    await applyFloat(token, float);
  }

  async function applyAllOnCanvas() {
    if (!canvas?.ready) return;
    for (const token of canvas.tokens?.placeables ?? []) {
      await applyFromDoc(token.document);
    }
  }

  // ---------------------------
  // TokenConfig Tab Injection
  // ---------------------------
  function ensureTabNav($html) {
    let $nav = $html.find('nav.sheet-tabs.tabs[data-group="main"]');
    if ($nav.length) return $nav;
    $nav = $html.find("nav.sheet-tabs");
    return $nav.length ? $nav : null;
  }

  function ensureTabContentRoot($html) {
    const $existingTabs = $html.find('.tab[data-group="main"]');
    if ($existingTabs.length) return $existingTabs.first().parent();
    const $form = $html.find("form");
    return $form.length ? $form : null;
  }

  Hooks.on("renderTokenConfig", (app, $html) => {
    try {
      if ($html.find('[data-oni-idle-anim="tab"]').length) return;

      const $nav = ensureTabNav($html);
      const $tabRoot = ensureTabContentRoot($html);
      if (!$nav || !$tabRoot) return;

      const $btn = $(`
        <a class="item" data-tab="${TAB_ID}" data-group="${GROUP}" data-oni-idle-anim="tab">
          <i class="fas fa-person-running"></i> Idle Animation
        </a>
      `);
      $nav.append($btn);

      // IMPORTANT: "name=flags.<moduleId>...." makes Foundry save on Update Token automatically
      const $panel = $(`
        <div class="tab" data-tab="${TAB_ID}" data-group="${GROUP}" data-oni-idle-anim="panel">
          <div style="padding: 8px;">
            <h3 style="margin: 0 0 6px 0;">Idle Animation</h3>
            <p class="hint" style="margin: 0 0 12px 0;">
              Toggle idle animations for this token. Press <b>Update Token</b> to apply.
            </p>

            <div class="form-group">
              <label>Float</label>
              <div class="form-fields">
                <input type="checkbox"
                  name="flags.${MODULE_ID}.idleAnim.float"
                  data-dtype="Boolean"
                />
              </div>
              <p class="hint">Uses TokenMagic (if installed).</p>
            </div>

            <div class="form-group">
              <label>Bounce</label>
              <div class="form-fields">
                <input type="checkbox"
                  name="flags.${MODULE_ID}.idleAnim.bounce"
                  data-dtype="Boolean"
                />
              </div>
              <p class="hint">Uses a lightweight PIXI mesh bobbing effect.</p>
            </div>
          </div>
        </div>
      `);

      $tabRoot.append($panel);

      // Reinitialize tabs so Foundry recognizes the new tab
      const rootEl = $html[0];
      const navEl =
        rootEl.querySelector('nav.sheet-tabs.tabs[data-group="main"]') ||
        rootEl.querySelector("nav.sheet-tabs");

      if (navEl) {
        new Tabs({
          navSelector: navEl,
          contentSelector: rootEl,
          initial: "identity"
        });
      }

      console.log(`${TAG} Injected Idle Animation tab into TokenConfig.`);
    } catch (err) {
      console.error(`${TAG} Failed injecting Idle Animation tab`, err);
    }
  });

  // ---------------------------
  // Hooks: apply when saved & when canvas loads
  // ---------------------------
  Hooks.on("updateToken", async (doc) => {
    try {
      await applyFromDoc(doc);
    } catch (e) {
      console.error(`${TAG} updateToken apply failed`, e);
    }
  });

  Hooks.on("canvasReady", async () => {
    try {
      await applyAllOnCanvas();
    } catch (e) {
      console.error(`${TAG} canvasReady applyAll failed`, e);
    }
  });

  console.log(`${TAG} Idle Animation bootstrap loaded.`);
})();
