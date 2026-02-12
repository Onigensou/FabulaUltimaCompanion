/* ============================================================================
 * FabulaUltimaCompanion — Idle Animation System (UI)
 * File: scripts/idle-animation/idle-animation-ui.js
 * Foundry VTT v12
 *
 * Tabs:
 * - Prototype Token Config (Actor → Prototype Token): EDIT + SAVE (source of truth)
 * - Token Config (Token → Configure): READ-ONLY mirror (copies prototype setting)
 * ============================================================================ */

(() => {
  const TAG = "[ONI][IdleAnim][UI]";
  const API_KEY = "__ONI_IDLE_ANIM_API__";
  const INSTALLED_KEY = "__ONI_IDLE_ANIM_UI_INSTALLED__";

  if (globalThis[INSTALLED_KEY]) return;
  globalThis[INSTALLED_KEY] = true;

  if (globalThis.ONI_IDLE_ANIM_DEBUG === undefined) globalThis.ONI_IDLE_ANIM_DEBUG = true;
  function dbg(...args) { if (globalThis.ONI_IDLE_ANIM_DEBUG) console.log(TAG, ...args); }
  function warn(...args) { console.warn(TAG, ...args); }
  function err(...args) { console.error(TAG, ...args); }

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
    let $nav = $html.find('nav.sheet-tabs.tabs[data-group="main"]').first();
    if ($nav.length) return $nav;
    $nav = $html.find("nav.sheet-tabs").first();
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

  // Prototype Token Config detector (reliable in v12)
  // Prototype token sheet is TokenConfig with app.id like "TokenConfig-Actor.<ACTOR_ID>"
  function isPrototypeTokenConfig(app) {
    return app?.constructor?.name === "TokenConfig"
      && typeof app?.id === "string"
      && app.id.startsWith("TokenConfig-Actor.");
  }

  // "Normal" Token Config: TokenConfig but NOT the prototype one
  function isNormalTokenConfig(app) {
    return app?.constructor?.name === "TokenConfig"
      && !isPrototypeTokenConfig(app);
  }

  // Resolve SOURCE actor (directory actor) no matter linked/unlinked
  function resolveSourceActor(app) {
    const doc = getDoc(app);
    const sourceActorId = doc?.actorId ?? app?.token?.document?.actorId ?? null;
    const actor = sourceActorId ? game.actors?.get(sourceActorId) : null;
    return { actor, sourceActorId, doc };
  }

  function buildPanelHTML({ readOnly, titleExtra }) {
    const roAttr = readOnly ? "disabled" : "";
    const roStyle = readOnly ? "opacity:0.85;" : "";

    const info = readOnly
      ? `<p style="margin: 0 0 10px 0; opacity: 0.85;">
           This page mirrors the Actor's <b>Prototype Token</b> idle animation settings.
           To change these preferences, go to <b>Actor → Prototype Token</b>.
         </p>`
      : `<p style="margin: 0 0 10px 0; opacity: 0.85;">
           Set the Actor’s default idle animation behavior. Any token spawned from this Actor will auto-apply.
         </p>`;

    return $(`
      <div class="tab"
           data-tab="oni-idle-animation"
           data-group="main"
           data-oni-idle-anim="panel">
        <div style="padding: 10px; ${roStyle}">
          <h3 style="margin: 0 0 6px 0;">Idle Animation ${titleExtra ?? ""}</h3>
          ${info}

          <div class="form-group">
            <label>Float</label>
            <div class="form-fields">
              <input type="checkbox" ${roAttr} name="oniIdleAnim.float" data-oni-idle-field="float"/>
            </div>
            <p class="hint">Uses TokenMagic transform filter (cos/sin oscillation).</p>
          </div>

          <div class="form-group">
            <label>Bounce</label>
            <div class="form-fields">
              <input type="checkbox" ${roAttr} name="oniIdleAnim.bounce" data-oni-idle-field="bounce"/>
            </div>
            <p class="hint">Uses a lightweight PIXI mesh scale breathing effect. Synced to all clients.</p>
          </div>

          ${readOnly ? `
            <hr/>
            <p style="margin: 0; font-size: 12px; opacity: 0.85;">
              🔒 Read-only here. Edit in <b>Prototype Token</b>.
            </p>
          ` : ""}

          <hr/>
          <p style="margin:0; font-size:12px; opacity:0.8;">
            <strong>Debug:</strong> globalThis.ONI_IDLE_ANIM_DEBUG =
            <code>${String(!!globalThis.ONI_IDLE_ANIM_DEBUG)}</code>
          </p>
        </div>
      </div>
    `);
  }

  Hooks.on("renderTokenConfig", async (app, $html) => {
    const api = getAPI();
    if (!api) return;

    try {
      // Avoid duplicates on rerender
      if ($html.find('[data-oni-idle-anim="tab"]').length) return;

      const root = ensureRoot($html, app);
      const { actor, sourceActorId, doc } = resolveSourceActor(app);

      if (!actor) {
        dbg("No SOURCE actor found for TokenConfig, skipping UI injection.", {
          sourceActorId,
          appId: app?.id,
          title: app?.title
        });
        return;
      }

      const prototypeMode = isPrototypeTokenConfig(app);
      const normalMode = isNormalTokenConfig(app);

      // We only care about these two; if some other config uses TokenConfig, skip
      if (!prototypeMode && !normalMode) return;

      const readOnly = normalMode; // token config is read-only mirror

      dbg("TokenConfig render detected", {
        prototypeMode,
        normalMode,
        appId: app?.id,
        title: app?.title,
        sourceActorId,
        actorName: actor.name,
        actorLink: doc?.actorLink
      });

      const TAB_ID = "oni-idle-animation";
      const GROUP = "main";

      const $nav = findNav($html);
      const $tabRoot = findTabRoot($html);

      if (!$nav || !$tabRoot) {
        warn("Could not find suitable nav/tab root to inject into.");
        return;
      }

      // NAV BUTTON
      const labelSuffix = prototypeMode ? "" : "";
      const $btn = $(`
        <a class="item"
           data-tab="${TAB_ID}"
           data-group="${GROUP}"
           data-oni-idle-anim="tab">
          <i class="fas fa-wand-magic-sparkles"></i> Idle Animation${labelSuffix}
        </a>
      `);
      $nav.append($btn);

      // PANEL
      const $panel = buildPanelHTML({
        readOnly,
        titleExtra: prototypeMode ? "(Prototype)" : "(Token)"
      });
      $tabRoot.append($panel);

      // Rebind tabs (prevents “bounce back” issue)
      const res = bindTabs(app, root);
      dbg("bindTabs()", res);

      // Prefill from ACTOR FLAG (prototype source of truth)
      const cfg = await api.getActorConfig(actor);
      $panel.find('[data-oni-idle-field="float"]').prop("checked", !!cfg.float);
      $panel.find('[data-oni-idle-field="bounce"]').prop("checked", !!cfg.bounce);

      dbg("Prefill from actor flags", { actor: actor.name, sourceActorId, cfg, readOnly });

      // SUBMIT behavior:
      // - Prototype: SAVE actor flag, apply, sync
      // - Token config: DO NOT SAVE, but re-apply (mirror) on update
      const $form = $html.find("form");
      if ($form.length && !$form.attr("data-oni-idle-submit-bound")) {
        $form.attr("data-oni-idle-submit-bound", "1");

        $form.on("submit", async () => {
          try {
            if (prototypeMode) {
              const next = api.normalizeConfig({
                float: $panel.find('[data-oni-idle-field="float"]').is(":checked"),
                bounce: $panel.find('[data-oni-idle-field="bounce"]').is(":checked")
              });

              dbg("Prototype Token submit -> SAVE actor flag + apply + sync", {
                actor: actor.name,
                sourceActorId,
                next
              });

              await api.setActorConfig(actor, next);
              await api.applySourceActorConfigToAllTokens(actor.id);
              api.emitSocketApply(actor.id);
              return;
            }

            // Normal token config: mirror only
            dbg("TokenConfig submit -> mirror mode (no save). Re-applying actor config.", {
              actor: actor.name,
              sourceActorId
            });

            await api.applySourceActorConfigToAllTokens(actor.id);
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

  dbg("Idle Animation UI loaded (prototype + token mirror mode).");
})();
