/**
 * fabula-ultima-companion — Idle Animation System (BOOTSTRAP)
 * Loaded via module.json "scripts" (no imports)
 *
 * Fixes & upgrades:
 * - FIX: TokenConfig tab no longer "bounces" back to Identity after first use
 *        (we do NOT re-initialize Tabs with forced initial="identity")
 * - CHANGE: settings are persisted on the *Actor* flags (so respawned tokens keep it)
 * - NEW: when a new Token for the actor is spawned, apply idle animation immediately
 *
 * Debugging:
 * - Set `globalThis.ONI_IDLE_ANIM_DEBUG = true` in console to enable verbose logs.
 */

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][IdleAnim]";
  const TAB_ID = "oni-idle-animation";
  const GROUP = "main";
  const FLOAT_FILTER_ID = "oniIdleFloat";

  // Toggle at runtime: globalThis.ONI_IDLE_ANIM_DEBUG = true/false
  const isDebug = () => !!globalThis.ONI_IDLE_ANIM_DEBUG;
  const dlog = (...args) => {
    if (isDebug()) console.log(TAG, ...args);
  };

  // ---------------------------
  // Flags: Actor persisted, Token mirrored (compat)
  // ---------------------------
  const FLAG_PATH = "idleAnim"; // flags[MODULE_ID].idleAnim

  function readIdleAnimSettings(tokenDoc) {
    // Token flags (legacy / per-token override)
    const tf = tokenDoc?.flags?.[MODULE_ID]?.[FLAG_PATH];
    const tokenHasAny =
      tf && (typeof tf.float !== "undefined" || typeof tf.bounce !== "undefined");

    // Actor flags (persisted)
    const af = tokenDoc?.actor?.flags?.[MODULE_ID]?.[FLAG_PATH];

    const src = tokenHasAny ? "token" : "actor";
    const f = tokenHasAny ? tf : af;

    const out = { float: !!f?.float, bounce: !!f?.bounce, source: src };
    dlog("readIdleAnimSettings", { tokenId: tokenDoc?.id, actorId: tokenDoc?.actor?.id, ...out });
    return out;
  }

  async function writeActorIdleAnimSettings(actor, settings) {
    if (!actor) return;
    try {
      const prev = actor.flags?.[MODULE_ID]?.[FLAG_PATH] ?? {};
      const next = { ...prev, float: !!settings.float, bounce: !!settings.bounce };

      // Skip no-op writes
      if (prev.float === next.float && prev.bounce === next.bounce) {
        dlog("writeActorIdleAnimSettings: no-op", { actorId: actor.id, next });
        return;
      }

      dlog("writeActorIdleAnimSettings: setFlag", { actorId: actor.id, next });
      await actor.setFlag(MODULE_ID, FLAG_PATH, next);
    } catch (err) {
      console.error(`${TAG} Failed writing actor flags`, err);
    }
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

    dlog("startBounce", { tokenId: token.id });
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
    dlog("stopBounce", { tokenId: token.id });
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
        dlog("applyFloat: enable", { tokenId: token?.id });
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
        dlog("applyFloat: disable", { tokenId: token?.id });
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
  // Apply from token doc (read settings from actor/token)
  // ---------------------------
  async function applyFromDoc(doc, reason = "unknown") {
    if (!canvas?.ready) return;
    const token = canvas.tokens?.get(doc.id);
    if (!token) return;

    const { float, bounce, source } = readIdleAnimSettings(doc);

    dlog("applyFromDoc", { reason, tokenId: doc.id, actorId: doc.actor?.id, float, bounce, source });

    if (bounce) startBounce(token);
    else stopBounce(token);

    await applyFloat(token, float);
  }

  async function applyAllOnCanvas(reason = "applyAll") {
    if (!canvas?.ready) return;
    dlog("applyAllOnCanvas", { reason, count: canvas.tokens?.placeables?.length ?? 0 });

    for (const token of canvas.tokens?.placeables ?? []) {
      await applyFromDoc(token.document, reason);
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
    const $existingTabs = $html.find(`.tab[data-group="${GROUP}"]`);
    if ($existingTabs.length) return $existingTabs.first().parent();
    const $form = $html.find("form");
    return $form.length ? $form : null;
  }

  // IMPORTANT: DO NOT create a new Tabs() controller here.
  // TokenConfig already has its own tabs controller; recreating it can cause
  // weird behavior like the tab snapping back to "identity".
  function rebindFoundryTabsIfPossible(app, $html) {
    const root = $html?.[0];
    if (!root) return;

    const candidates = [];

    if (app?._tabs) {
      if (Array.isArray(app._tabs)) candidates.push(...app._tabs);
      else if (typeof app._tabs === "object") {
        if (app._tabs[GROUP]) candidates.push(app._tabs[GROUP]);
        if (app._tabs.tabs?.[GROUP]) candidates.push(app._tabs.tabs[GROUP]);
        for (const v of Object.values(app._tabs)) candidates.push(v);
      }
    }

    const seen = new Set();
    for (const t of candidates) {
      if (!t || seen.has(t)) continue;
      seen.add(t);

      if (typeof t.bind === "function") {
        try {
          t.bind(root);
          dlog("rebindFoundryTabsIfPossible: bound existing tabs controller");
          return;
        } catch (e) {
          dlog("rebindFoundryTabsIfPossible: bind failed", e);
        }
      }
    }

    dlog("rebindFoundryTabsIfPossible: no compatible tabs controller found");
  }

  Hooks.on("renderTokenConfig", (app, $html) => {
    try {
      if ($html.find('[data-oni-idle-anim="tab"]').length) return;

      const tokenDoc = app?.object; // TokenDocument
      dlog("renderTokenConfig", { tokenId: tokenDoc?.id, actorId: tokenDoc?.actor?.id });

      const $nav = ensureTabNav($html);
      const $tabRoot = ensureTabContentRoot($html);
      if (!$nav || !$tabRoot) return;

      const $btn = $(`
        <a class="item" data-tab="${TAB_ID}" data-group="${GROUP}" data-oni-idle-anim="tab">
          <i class="fas fa-person-running"></i> Idle Animation
        </a>
      `);
      $nav.append($btn);

      // Bind inputs to Token flags so TokenConfig can submit them.
      // On updateToken, we propagate them to Actor flags (persistent).
      const $panel = $(`
        <div class="tab" data-tab="${TAB_ID}" data-group="${GROUP}" data-oni-idle-anim="panel">
          <div style="padding: 8px;">
            <h3 style="margin: 0 0 6px 0;">Idle Animation</h3>
            <p class="hint" style="margin: 0 0 12px 0;">
              These settings are <b>saved on the Actor</b>. Press <b>Update Token</b> to apply.
            </p>

            <div class="form-group">
              <label>Float</label>
              <div class="form-fields">
                <input type="checkbox"
                  name="flags.${MODULE_ID}.${FLAG_PATH}.float"
                  data-dtype="Boolean"
                  data-oni-idle-anim="float"
                />
              </div>
              <p class="hint">Uses TokenMagic (if installed).</p>
            </div>

            <div class="form-group">
              <label>Bounce</label>
              <div class="form-fields">
                <input type="checkbox"
                  name="flags.${MODULE_ID}.${FLAG_PATH}.bounce"
                  data-dtype="Boolean"
                  data-oni-idle-anim="bounce"
                />
              </div>
              <p class="hint">Uses a lightweight PIXI mesh bobbing effect.</p>
            </div>

            <hr/>

            <p class="hint" style="margin: 8px 0 0 0;">
              Debug: set <code>globalThis.ONI_IDLE_ANIM_DEBUG = true</code> in console to see logs.
            </p>
          </div>
        </div>
      `);

      $tabRoot.append($panel);

      // Prefill from Actor (or Token override if present)
      const s = readIdleAnimSettings(tokenDoc);
      $panel.find('[data-oni-idle-anim="float"]').prop("checked", !!s.float);
      $panel.find('[data-oni-idle-anim="bounce"]').prop("checked", !!s.bounce);

      rebindFoundryTabsIfPossible(app, $html);

      dlog("Injected Idle Animation tab into TokenConfig");
    } catch (err) {
      console.error(`${TAG} Failed injecting Idle Animation tab`, err);
    }
  });

  // ---------------------------
  // Hooks: propagate + apply
  // ---------------------------
  Hooks.on("updateToken", async (doc, change) => {
    try {
      // If our flags changed on the Token, mirror them to the Actor flags
      const changed = change?.flags?.[MODULE_ID]?.[FLAG_PATH];

      if (changed && doc?.actor) {
        const float =
          typeof changed.float === "undefined"
            ? doc.flags?.[MODULE_ID]?.[FLAG_PATH]?.float
            : changed.float;

        const bounce =
          typeof changed.bounce === "undefined"
            ? doc.flags?.[MODULE_ID]?.[FLAG_PATH]?.bounce
            : changed.bounce;

        dlog("updateToken: detected flag change", { tokenId: doc.id, actorId: doc.actor.id, float, bounce });
        await writeActorIdleAnimSettings(doc.actor, { float, bounce });
      } else {
        dlog("updateToken: no relevant flag change", { tokenId: doc?.id });
      }

      await applyFromDoc(doc, "updateToken");
    } catch (e) {
      console.error(`${TAG} updateToken apply failed`, e);
    }
  });

  Hooks.on("createToken", async (doc) => {
    try {
      dlog("createToken", { tokenId: doc?.id, actorId: doc?.actor?.id });
      await applyFromDoc(doc, "createToken");
    } catch (e) {
      console.error(`${TAG} createToken apply failed`, e);
    }
  });

  Hooks.on("updateActor", async (actor, change) => {
    try {
      const changed = change?.flags?.[MODULE_ID]?.[FLAG_PATH];
      if (!changed) return;
      if (!canvas?.ready) return;

      dlog("updateActor: idle flags changed", { actorId: actor.id, changed });

      // Apply to all tokens of this actor on the current canvas
      for (const token of canvas.tokens?.placeables ?? []) {
        if (token.document?.actor?.id === actor.id) {
          await applyFromDoc(token.document, "updateActor");
        }
      }
    } catch (e) {
      console.error(`${TAG} updateActor apply failed`, e);
    }
  });

  Hooks.on("canvasReady", async () => {
    try {
      await applyAllOnCanvas("canvasReady");
    } catch (e) {
      console.error(`${TAG} canvasReady applyAll failed`, e);
    }
  });

  console.log(`${TAG} Idle Animation bootstrap loaded. (debug=${!!globalThis.ONI_IDLE_ANIM_DEBUG})`);
})();
