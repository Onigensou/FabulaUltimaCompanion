// fabula-ultima-companion
// Injects "Idle Animation" tab into TokenConfig
// Adds two checkboxes that SAVE into token flags automatically
// (because of the input "name=flags.<moduleId>....")

import { OniIdleAnimManager } from "./idle-animation-manager.js";

export function registerIdleAnimTokenConfigTab() {
  const TAG = "[ONI][IdleAnimTab]";
  const MODULE_ID = OniIdleAnimManager.MODULE_ID;
  const TAB_ID = "oni-idle-animation";
  const GROUP = "main";

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
      // Prevent duplicates on rerender
      if ($html.find('[data-oni-idle-anim="tab"]').length) return;

      const $nav = ensureTabNav($html);
      const $tabRoot = ensureTabContentRoot($html);
      if (!$nav || !$tabRoot) return;

      // Button in the nav row
      const $btn = $(`
        <a class="item" data-tab="${TAB_ID}" data-group="${GROUP}" data-oni-idle-anim="tab">
          <i class="fas fa-person-running"></i> Idle Animation
        </a>
      `);
      $nav.append($btn);

      // IMPORTANT:
      // Use "name=flags.<moduleId>...." so Foundry saves it automatically on Update Token.
      // These will become:
      // flags["fabula-ultima-companion"].idleAnim.float
      // flags["fabula-ultima-companion"].idleAnim.bounce
      const $panel = $(`
        <div class="tab" data-tab="${TAB_ID}" data-group="${GROUP}" data-oni-idle-anim="panel">
          <div style="padding: 8px;">
            <h3 style="margin: 0 0 6px 0;">Idle Animation</h3>
            <p class="hint" style="margin: 0 0 12px 0;">
              Toggle idle animations for this token. These settings save into token flags when you press <b>Update Token</b>.
            </p>

            <div class="form-group">
              <label>Float</label>
              <div class="form-fields">
                <input type="checkbox"
                  name="flags.${MODULE_ID}.idleAnim.float"
                  data-dtype="Boolean"
                />
              </div>
              <p class="hint">Uses TokenMagic transform oscillation (if TokenMagic is installed).</p>
            </div>

            <div class="form-group">
              <label>Bounce</label>
              <div class="form-fields">
                <input type="checkbox"
                  name="flags.${MODULE_ID}.idleAnim.bounce"
                  data-dtype="Boolean"
                />
              </div>
              <p class="hint">Lightweight breathing/bobbing effect via PIXI ticker.</p>
            </div>

          </div>
        </div>
      `);

      $tabRoot.append($panel);

      // Reinitialize tabs so the new tab is clickable
      const rootEl = $html[0];
      const navEl =
        rootEl.querySelector('nav.sheet-tabs.tabs[data-group="main"]') ||
        rootEl.querySelector("nav.sheet-tabs");

      if (navEl) {
        new Tabs({
          navSelector: navEl,
          contentSelector: rootEl,
          initial: "identity" // safe default in TokenConfig
        });
      }

      console.log(`${TAG} Injected Idle Animation tab.`);
    } catch (err) {
      console.error(`${TAG} Failed to inject tab`, err);
    }
  });
}
