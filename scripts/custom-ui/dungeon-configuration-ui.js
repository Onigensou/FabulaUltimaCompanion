// ============================================================================
// FabulaUltimaCompanion — Dungeon Configuration UI (Scene Config Tab) [Module]
// ----------------------------------------------------------------------------
// File: scripts/custom-ui/dungeon-configuration-ui.js
//
// What it does:
// - Adds a "Dungeon Configuration" tab into Scene Configuration (Foundry v12)
// - Stores data into Scene flags under THIS MODULE scope:
//     flags.fabula-ultima-companion.oniDungeon.*
//
// Why module scope:
// - getFlag(scope, key) requires a valid active scope in v12.
// - "world" works, but module scope is cleaner + namespaced.
//
// Backward compatibility:
// - Prefill reads from (in order):
//   1) flags.fabula-ultima-companion.oniDungeon (new)
//   2) flags.world.oniDungeon (from your macro v2/v3)
//   3) flags.oniDungeon (legacy v1)
// - When GM presses "Save Changes", values are saved into module scope.
//
// Includes:
// - Battle: Encounter Table, Enemies Table, Battle Map, Battle BGM, Boss BGM
// - Event: Skill Check Event, Clock Event
// - Loot: Weapon/Armor/Accessory/Consumable/Item/Treasure
// - Moves "Save Changes" button to bottom of the window
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const ROOT_KEY  = "oniDungeon"; // stored at: flags.<MODULE_ID>.oniDungeon

  const TAB_ID = "oni-dungeon-config";
  const STYLE_ID = "oni-dungeon-config-style";
  const MARKER_ATTR = "data-oni-dungeon-config";
  const SAVE_MOVED_ATTR = "data-oni-save-moved";

  const DEBUG = true;
  const log  = (...a) => DEBUG && console.log("[DungeonConfigUI]", ...a);
  const warn = (...a) => DEBUG && console.warn("[DungeonConfigUI]", ...a);

  // -----------------------------
  // CSS
  // -----------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      a.item[${MARKER_ATTR}] i { margin-right: 6px; }

      .oni-dungeon-wrap { padding: 10px 8px; }
      .oni-dungeon-wrap h3 { margin: 10px 0 6px; }
      .oni-dungeon-wrap h3:first-child { margin-top: 0; }

      .oni-dungeon-subtle {
        opacity: .85;
        font-size: 12px;
        margin: 6px 0 10px;
      }

      .oni-dungeon-wrap .form-group .form-fields input[type="text"] { width: 100%; }

      .oni-dungeon-actions {
        display:flex;
        gap:8px;
        flex-wrap:wrap;
        margin-top: 10px;
      }

      .oni-save-footer {
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid var(--color-border-light-primary, #9993);
      }
    `;
    document.head.appendChild(style);
  }

  // -----------------------------
  // Utility
  // -----------------------------
  function getRoot(html, app) {
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

  function safeGet(obj, path, fallback = "") {
    try {
      const parts = path.split(".");
      let cur = obj;
      for (const p of parts) cur = cur?.[p];
      return (cur === undefined || cur === null) ? fallback : cur;
    } catch {
      return fallback;
    }
  }

  // Read from module scope first, then fallbacks from your macro versions
  function readDungeonData(scene) {
    const mod = scene?.flags?.[MODULE_ID]?.[ROOT_KEY];
    if (mod && Object.keys(mod).length) return mod;

    const world = scene?.flags?.world?.[ROOT_KEY];
    if (world && Object.keys(world).length) return world;

    const legacy = scene?.flags?.[ROOT_KEY];
    if (legacy && Object.keys(legacy).length) return legacy;

    return {};
  }

  function fillFromFlags(scene, tabPanel) {
    const data = readDungeonData(scene);

    // Battle
    tabPanel.querySelector(`input[name="flags.${MODULE_ID}.${ROOT_KEY}.encounterTable"]`).value = safeGet(data, "encounterTable", "");
    tabPanel.querySelector(`input[name="flags.${MODULE_ID}.${ROOT_KEY}.enemiesTable"]`).value   = safeGet(data, "enemiesTable", "");
    tabPanel.querySelector(`input[name="flags.${MODULE_ID}.${ROOT_KEY}.battleMap"]`).value      = safeGet(data, "battleMap", "");
    tabPanel.querySelector(`input[name="flags.${MODULE_ID}.${ROOT_KEY}.battleBGM"]`).value      = safeGet(data, "battleBGM", "");
    tabPanel.querySelector(`input[name="flags.${MODULE_ID}.${ROOT_KEY}.bossBGM"]`).value        = safeGet(data, "bossBGM", "");

    // Event
    tabPanel.querySelector(`input[name="flags.${MODULE_ID}.${ROOT_KEY}.event.skillCheckEvent"]`).value = safeGet(data, "event.skillCheckEvent", "");
    tabPanel.querySelector(`input[name="flags.${MODULE_ID}.${ROOT_KEY}.event.clockEvent"]`).value      = safeGet(data, "event.clockEvent", "");

    // Loot
    tabPanel.querySelector(`input[name="flags.${MODULE_ID}.${ROOT_KEY}.loot.weapon"]`).value     = safeGet(data, "loot.weapon", "");
    tabPanel.querySelector(`input[name="flags.${MODULE_ID}.${ROOT_KEY}.loot.armor"]`).value      = safeGet(data, "loot.armor", "");
    tabPanel.querySelector(`input[name="flags.${MODULE_ID}.${ROOT_KEY}.loot.accessory"]`).value  = safeGet(data, "loot.accessory", "");
    tabPanel.querySelector(`input[name="flags.${MODULE_ID}.${ROOT_KEY}.loot.consumable"]`).value = safeGet(data, "loot.consumable", "");
    tabPanel.querySelector(`input[name="flags.${MODULE_ID}.${ROOT_KEY}.loot.item"]`).value       = safeGet(data, "loot.item", "");
    tabPanel.querySelector(`input[name="flags.${MODULE_ID}.${ROOT_KEY}.loot.treasure"]`).value   = safeGet(data, "loot.treasure", "");
  }

  // Move "Save Changes" (submit) to bottom of the window
  function moveSaveToBottom(root) {
    try {
      const form = root.querySelector("form");
      if (!form) return { ok: false, reason: "no form" };

      if (form.querySelector(`[${SAVE_MOVED_ATTR}="1"]`)) return { ok: true, reason: "already moved" };

      const submitBtn = root.querySelector(`button[type="submit"]`);
      if (!submitBtn) return { ok: false, reason: "no submit button found" };

      let wrapper =
        submitBtn.closest(".form-group") ||
        submitBtn.closest(".form-fields") ||
        submitBtn.closest("header") ||
        submitBtn.closest("section") ||
        submitBtn.closest("div") ||
        submitBtn;

      wrapper.setAttribute(SAVE_MOVED_ATTR, "1");
      wrapper.classList?.add?.("oni-save-footer");
      form.appendChild(wrapper);

      return { ok: true, reason: "moved" };
    } catch (e) {
      return { ok: false, reason: e?.message ?? String(e) };
    }
  }

  // -----------------------------
  // Inject UI
  // -----------------------------
  function inject(app, html) {
    const root = getRoot(html, app);
    if (!root) return { ok: false, reason: "no root" };

    // Dedupe per-window
    if (root.querySelector(`a.item[${MARKER_ATTR}]`) || root.querySelector(`.tab[${MARKER_ATTR}]`)) {
      const saveRes = moveSaveToBottom(root);
      return { ok: true, reason: "already injected", saveRes };
    }

    const nav =
      root.querySelector(`nav.sheet-tabs.tabs[data-group="main"]`) ||
      root.querySelector(`nav.sheet-tabs.tabs`) ||
      root.querySelector(`nav.sheet-tabs`);
    if (!nav) return { ok: false, reason: "no nav" };

    const existingTab =
      root.querySelector(`.tab[data-group="main"][data-tab]`) ||
      root.querySelector(`.tab[data-tab]`);

    let tabParent = existingTab?.parentElement ?? null;
    if (!tabParent) tabParent = root.querySelector(`section.sheet-body`) || root.querySelector(`.sheet-body`) || root.querySelector(`form`);
    if (!tabParent) return { ok: false, reason: "no tab parent" };

    ensureStyle();

    const groupName = nav.dataset.group || "main";

    // Add tab button
    const tabBtn = document.createElement("a");
    tabBtn.className = "item";
    tabBtn.dataset.tab = TAB_ID;
    tabBtn.setAttribute(MARKER_ATTR, "1");
    tabBtn.innerHTML = `<i class="fas fa-dungeon"></i> Dungeon Configuration`;
    nav.appendChild(tabBtn);

    // Create tab panel
    const tabPanel = document.createElement("div");
    tabPanel.className = "tab";
    tabPanel.dataset.tab = TAB_ID;
    tabPanel.dataset.group = groupName;
    tabPanel.setAttribute(MARKER_ATTR, "1");

    tabPanel.innerHTML = `
      <div class="oni-dungeon-wrap">
        <div class="oni-dungeon-subtle">
          Paste UUIDs (recommended). Saved into <b>Scene Flags</b>:
          <code>flags.${MODULE_ID}.${ROOT_KEY}</code>
          <br>
          <span style="opacity:.8">
            Reads legacy too: <code>flags.world.${ROOT_KEY}</code> / <code>flags.${ROOT_KEY}</code>
            (saving will migrate into module flags)
          </span>
        </div>

        <h3>Battle</h3>

        <div class="form-group">
          <label>Encounter Table</label>
          <div class="form-fields">
            <input type="text" name="flags.${MODULE_ID}.${ROOT_KEY}.encounterTable" placeholder="RollTable UUID (encounter groups)" />
          </div>
          <p class="notes">Table of encounter “groups” (may contain randomized enemies inside).</p>
        </div>

        <div class="form-group">
          <label>Enemies Table</label>
          <div class="form-fields">
            <input type="text" name="flags.${MODULE_ID}.${ROOT_KEY}.enemiesTable" placeholder="RollTable UUID (individual enemies)" />
          </div>
          <p class="notes">Table of “possible enemies on this map” (individual monsters).</p>
        </div>

        <div class="form-group">
          <label>Battle Map</label>
          <div class="form-fields">
            <input type="text" name="flags.${MODULE_ID}.${ROOT_KEY}.battleMap" placeholder="Scene UUID (battle scene)" />
          </div>
          <p class="notes">JRPG style: exploration scene links to a separate battle scene.</p>
        </div>

        <div class="form-group">
          <label>Battle BGM</label>
          <div class="form-fields">
            <input type="text" name="flags.${MODULE_ID}.${ROOT_KEY}.battleBGM" placeholder="Playlist Sound name (string for now)" />
          </div>
        </div>

        <div class="form-group">
          <label>Boss BGM</label>
          <div class="form-fields">
            <input type="text" name="flags.${MODULE_ID}.${ROOT_KEY}.bossBGM" placeholder="Playlist Sound name (string for now)" />
          </div>
        </div>

        <h3>Event</h3>

        <div class="form-group">
          <label>Skill Check Event</label>
          <div class="form-fields">
            <input type="text" name="flags.${MODULE_ID}.${ROOT_KEY}.event.skillCheckEvent" placeholder="RollTable UUID" />
          </div>
        </div>

        <div class="form-group">
          <label>Clock Event</label>
          <div class="form-fields">
            <input type="text" name="flags.${MODULE_ID}.${ROOT_KEY}.event.clockEvent" placeholder="RollTable UUID" />
          </div>
        </div>

        <h3>Loot</h3>

        <div class="form-group"><label>Weapon</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${ROOT_KEY}.loot.weapon" placeholder="RollTable UUID" /></div></div>
        <div class="form-group"><label>Armor</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${ROOT_KEY}.loot.armor" placeholder="RollTable UUID" /></div></div>
        <div class="form-group"><label>Accessory</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${ROOT_KEY}.loot.accessory" placeholder="RollTable UUID" /></div></div>
        <div class="form-group"><label>Consumable</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${ROOT_KEY}.loot.consumable" placeholder="RollTable UUID" /></div></div>
        <div class="form-group"><label>Item</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${ROOT_KEY}.loot.item" placeholder="RollTable UUID" /></div></div>
        <div class="form-group"><label>Treasure</label><div class="form-fields"><input type="text" name="flags.${MODULE_ID}.${ROOT_KEY}.loot.treasure" placeholder="RollTable UUID" /></div></div>

        <div class="oni-dungeon-actions">
          <button type="button" class="oni-dungeon-log">
            <i class="fas fa-terminal"></i> Log Current Scene Dungeon Data
          </button>

          <button type="button" class="oni-dungeon-clear">
            <i class="fas fa-eraser"></i> Clear Fields (this window)
          </button>
        </div>

        <p class="notes">Remember: data is saved only when you press <b>Save Changes</b>.</p>
      </div>
    `;

    tabParent.appendChild(tabPanel);

    // Prefill
    try { fillFromFlags(app?.object, tabPanel); }
    catch (e) { warn("fillFromFlags failed:", e); }

    // Buttons
    tabPanel.querySelector(".oni-dungeon-log")?.addEventListener("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const scene = app?.object;
      const data = readDungeonData(scene);
      log("Scene:", scene?.name, "Dungeon Data =", foundry?.utils?.duplicate ? foundry.utils.duplicate(data) : data);

      try {
        const gf = scene?.getFlag?.(MODULE_ID, ROOT_KEY);
        log(`getFlag('${MODULE_ID}','${ROOT_KEY}') =`, gf);
      } catch (e) {
        warn("getFlag test failed:", e);
      }

      ui.notifications?.info?.("Logged to console: Dungeon Data");
    });

    tabPanel.querySelector(".oni-dungeon-clear")?.addEventListener("click", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      tabPanel.querySelectorAll(`input[name^="flags.${MODULE_ID}.${ROOT_KEY}."]`).forEach(i => i.value = "");
      ui.notifications?.warn?.("Cleared fields (not saved yet). Click Save Changes to commit.");
    });

    const bindRes = bindTabs(app, root);
    const saveRes = moveSaveToBottom(root);

    // Open our tab
    try { app?.activateTab?.(TAB_ID); } catch {}

    const ok = !!root.querySelector(`a.item[data-tab="${TAB_ID}"]`) && !!root.querySelector(`.tab[data-tab="${TAB_ID}"]`);
    log("Injected.", { ok, scene: app?.object?.name, bindRes, saveRes });

    return { ok, bindRes, saveRes };
  }

  // -----------------------------
  // Hook
  // -----------------------------
  Hooks.once("ready", () => {
    log("READY: dungeon-configuration-ui loaded.");
    Hooks.on("renderSceneConfig", (app, html) => {
      const res = inject(app, html);
      if (DEBUG) log("renderSceneConfig ->", res);
    });

    // Optional tiny API (handy later)
    window.oni = window.oni || {};
    window.oni.DungeonConfig = {
      MODULE_ID,
      ROOT_KEY,
      read(scene = canvas.scene) {
        return readDungeonData(scene);
      }
    };
  });
})();
