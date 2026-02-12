/* ============================================================================
 * FabulaUltimaCompanion — Idle Animation System (UI)
 * File: scripts/idle-animation/idle-animation-ui.js
 * Foundry VTT v12
 *
 * Responsibilities:
 * - Inject an "Idle Animation" tab into Token Config
 * - Provide 2 checkboxes: Float, Bounce
 * - On "Update Token" submit:
 *    - Save config to ACTOR flag (global persistence)
 *    - Apply animations immediately
 *    - Sync across all clients via socket
 * ============================================================================ */

(() => {
  const TAG = "[ONI][IdleAnim][UI]";
  const API_KEY = "__ONI_IDLE_ANIM_API__";
  const INSTALLED_KEY = "__ONI_IDLE_ANIM_UI_INSTALLED__";

  if (globalThis[INSTALLED_KEY]) return;
  globalThis[INSTALLED_KEY] = true;

  // DEBUG uses the same toggle as logic
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

  function getAPI() {
    const api = globalThis[API_KEY];
    if (!api) warn("Logic API not found yet. Check module.json load order (logic first).");
    return api;
  }

  function ensureRoot(html, app) {
    if (html instanceof HTMLElement) return html;
    if (html?.[0] instanceof HTMLElement) return html[0];
    if (app?.element?.[0] instanceof HTMLElement) return app.element[0];
    if (app?.element instanceof HTMLElement) return app.element;
    return null;
  }

  function bindTabs(app, root) {
    // Use the SAME safe pattern from your dungeon config UI
    try {
      const tabs = app?._tabs;
      if (!tabs) return { ok: false, reason: "no app._tabs" };
      if (Array.isArray(tabs)) tabs.forEach(t => t?.bind?.(root));
      else Object.values(tabs).forEach(t => t?.bind?.(root));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e?.message ?? String(e) };
    }
  }

  function findNav($html) {
    let $nav = $html.find('nav.sheet-tabs.tabs[data-group="main"]');
    if ($nav.length) return $nav;
    $nav = $html.find("nav.sheet-tabs");
    if ($nav.length) return $nav;
    return null;
  }

  function findTabRoot($html) {
    const $existingTabs = $html.find('.tab[data-group="main"]');
    if ($existingTabs.length) {
      const $parent = $existingTabs.first().parent();
      return $parent?.length ? $parent : null;
    }
    const $form = $html.find("form");
    return $form.length ? $form : null;
  }

  function getDoc(app) {
    return app?.document ?? app?.object?.document ?? null;
  }

  Hooks.on("renderTokenConfig", async (app, $html) => {
    const api = getAPI();
    if (!api) return;

    try {
      // Avoid duplicate injection on re-render
      if ($html.find('[data-oni-idle-anim="tab"]').length) return;

      const root = ensureRoot($html, app);
      const doc = getDoc(app);

// Always prefer the SOURCE actor from Actors Directory (works for linked + unlinked)
const sourceActorId = doc?.actorId ?? app?.token?.document?.actorId ?? null;
const actor = sourceActorId ? game.actors?.get(sourceActorId) : null;

if (!actor) {
  dbg("No SOURCE actor found for TokenConfig, skipping UI injection.", {
    sourceActorId,
    docActorId: doc?.actorId,
    hasDocActor: !!doc?.actor,
    hasAppTokenActor: !!app?.token?.actor
  });
  return;
}

      const TAB_ID = "oni-idle-animation";
      const GROUP = "main";

      const $nav = findNav($html);
      const $tabRoot = findTabRoot($html);

      if (!$nav || !$tabRoot) {
        warn("Could not find suitable nav/tab root to inject into.");
        return;
      }

      // ---- NAV BUTTON
      const $btn = $(
        `<a class="item"
            data-tab="${TAB_ID}"
            data-group="${GROUP}"
            data-oni-idle-anim="tab">
          <i class="fas fa-wand-magic-sparkles"></i> Idle Animation
        </a>`
      );

      $nav.append($btn);

      // ---- PANEL
      const $panel = $(`
        <div class="tab"
             data-tab="${TAB_ID}"
             data-group="${GROUP}"
             data-oni-idle-anim="panel">
          <div style="padding: 10px;">
            <h3 style="margin: 0 0 6px 0;">Idle Animation</h3>
            <p style="margin: 0 0 10px 0; opacity: 0.85;">
              Configure idle animation presets for this Actor. Any new token spawned from this Actor will auto-apply.
            </p>

            <div class="form-group">
              <label>Float</label>
              <div class="form-fields">
                <input type="checkbox" name="oniIdleAnim.float" data-oni-idle-field="float"/>
              </div>
              <p class="hint">Uses TokenMagic transform filter (cos/sin oscillation).</p>
            </div>

            <div class="form-group">
              <label>Bounce</label>
              <div class="form-fields">
                <input type="checkbox" name="oniIdleAnim.bounce" data-oni-idle-field="bounce"/>
              </div>
              <p class="hint">Uses a lightweight PIXI mesh scale breathing effect. Synced to all clients.</p>
            </div>

            <hr/>
            <p style="margin:0; font-size:12px; opacity:0.8;">
              <strong>Debug:</strong> globalThis.ONI_IDLE_ANIM_DEBUG = <code>${String(!!globalThis.ONI_IDLE_ANIM_DEBUG)}</code>
            </p>
          </div>
        </div>
      `);

      $tabRoot.append($panel);

      // ---- IMPORTANT: RE-BIND EXISTING TOKEN CONFIG TABS (prevents “bounce back” bug)
      const res = bindTabs(app, root);
      dbg("bindTabs()", res);

      // ---- PREFILL FROM ACTOR FLAGS
      const cfg = await api.getActorConfig(actor);
      $panel.find('[data-oni-idle-field="float"]').prop("checked", !!cfg.float);
      $panel.find('[data-oni-idle-field="bounce"]').prop("checked", !!cfg.bounce);

      dbg("Injected tab + prefilling from actor flag", {
        actor: actor.name,
        actorId: actor.id,
        cfg
      });

      // ---- ON SUBMIT (Update Token): save + apply + sync
      // We bind once per renderTokenConfig instance
      const $form = $html.find("form");
      if ($form.length && !$form.attr("data-oni-idle-submit-bound")) {
        $form.attr("data-oni-idle-submit-bound", "1");

        $form.on("submit", async () => {
          try {
            const next = api.normalizeConfig({
              float: $panel.find('[data-oni-idle-field="float"]').is(":checked"),
              bounce: $panel.find('[data-oni-idle-field="bounce"]').is(":checked")
            });

            dbg("TokenConfig submit detected -> saving actor flag + applying", {
              actor: actor.name,
              actorId: actor.id,
              next
            });

            // 1) Save globally on Actor
           await api.setActorConfig(actor, next);

// Apply locally (this client) using SOURCE actor id matching
await api.applySourceActorConfigToAllTokens(actor.id);

// Sync across all clients
api.emitSocketApply(actor.id);
          } catch (e) {
            err("Submit handler failed", e);
          }
        });
      }
    } catch (e) {
      err("renderTokenConfig injection failed", e);
    }
  });

  dbg("Idle Animation UI loaded.");
})();
