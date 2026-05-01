// ============================================================================
// ActiveEffectManager-ui.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - GM UI for applying/removing Active Effects through ActiveEffectManager-api.
// - Uses dynamic registry when available.
// - Uses field catalogue for custom modifier key suggestions when available.
// - Does NOT hardcode effect names.
// - Does NOT touch legacy condition booleans like isSlow/isDazed.
// - Actor-first: can apply effects to actors even when they have no token.
//
// Public API:
//   FUCompanion.api.activeEffectManager.ui.open()
//   FUCompanion.api.activeEffectManager.openUI()
//
// Depends on:
//   ActiveEffectManager-registry.js
//   ActiveEffectManager-field-catalogue.js
//   ActiveEffectManager-api.js
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:UI]";
  const DEBUG = true;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

  const STYLE_ID = "oni-active-effect-manager-ui-style";

  let ACTIVE_DIALOG = null;

  // --------------------------------------------------------------------------
  // API helpers
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager = globalThis.FUCompanion.api.activeEffectManager || {};
    return globalThis.FUCompanion.api.activeEffectManager;
  }

  function getManagerApi() {
    return globalThis.FUCompanion?.api?.activeEffectManager ?? null;
  }

  function getRegistryApi() {
    const root = globalThis.FUCompanion?.api ?? {};
    return (
      root.activeEffectManager?.registry ??
      root.activeEffectRegistry ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.registry ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectRegistry ??
      null
    );
  }

  function getFieldCatalogueApi() {
    const root = globalThis.FUCompanion?.api ?? {};
    return (
      root.activeEffectManager?.fieldCatalogue ??
      root.activeEffectManager?.fieldCatalog ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.fieldCatalogue ??
      game.modules?.get?.(MODULE_ID)?.api?.activeEffectManager?.fieldCatalog ??
      null
    );
  }

  // --------------------------------------------------------------------------
  // General helpers
  // --------------------------------------------------------------------------

  function clone(value, fallback = null) {
    try {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    } catch (_e) {}

    try {
      return structuredClone(value);
    } catch (_e) {}

    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_e) {}

    return fallback;
  }

  function safeString(value, fallback = "") {
    const s = String(value ?? "").trim();
    return s.length ? s : fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeHtmlRoot(htmlOrElement) {
    if (!htmlOrElement) return null;
    if (htmlOrElement instanceof HTMLElement) return htmlOrElement;
    if (htmlOrElement[0] instanceof HTMLElement) return htmlOrElement[0];
    if (htmlOrElement.element instanceof HTMLElement) return htmlOrElement.element;
    if (htmlOrElement.element?.[0] instanceof HTMLElement) return htmlOrElement.element[0];
    return null;
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (value instanceof Set) return Array.from(value);
    return [value];
  }

  function uniq(values) {
    return Array.from(
      new Set(
        asArray(values)
          .filter(v => v != null && String(v).trim() !== "")
          .map(String)
      )
    );
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function randomId(prefix = "aem") {
    const id =
      foundry?.utils?.randomID?.(8) ??
      Math.random().toString(36).slice(2, 10);

    return `${prefix}-${id}`;
  }

  function selectedTokenActors() {
    return Array.from(canvas?.tokens?.controlled ?? [])
      .map(t => t.actor)
      .filter(Boolean);
  }

  function selectedTokenActorUuids() {
    return uniq(selectedTokenActors().map(a => a.uuid));
  }

  function getAllActorsForSelection() {
    return Array.from(game.actors ?? [])
      .filter(actor => {
        try {
          return game.user?.isGM || actor.testUserPermission?.(game.user, "OWNER");
        } catch (_e) {
          return false;
        }
      })
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function modeValue(name) {
    const modes = CONST?.ACTIVE_EFFECT_MODES ?? {};
    const fallback = {
      CUSTOM: 0,
      MULTIPLY: 1,
      ADD: 2,
      DOWNGRADE: 3,
      UPGRADE: 4,
      OVERRIDE: 5
    };

    return modes[name] ?? fallback[name] ?? 0;
  }

  function modeOptionsHtml(selected = modeValue("ADD")) {
    const modes = [
      ["CUSTOM", modeValue("CUSTOM")],
      ["MULTIPLY", modeValue("MULTIPLY")],
      ["ADD", modeValue("ADD")],
      ["DOWNGRADE", modeValue("DOWNGRADE")],
      ["UPGRADE", modeValue("UPGRADE")],
      ["OVERRIDE", modeValue("OVERRIDE")]
    ];

    return modes.map(([label, value]) => {
      const sel = Number(selected) === Number(value) ? "selected" : "";
      return `<option value="${Number(value)}" ${sel}>${escapeHtml(label)} (${Number(value)})</option>`;
    }).join("");
  }

  function compactError(e) {
    return String(e?.message ?? e);
  }

  function shortSource(entry = {}) {
    return [
      entry.sourceType,
      entry.sourceName
    ].filter(Boolean).join(" • ");
  }

  // --------------------------------------------------------------------------
  // Styling
  // --------------------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .oni-aem {
        color: #16130e;
        font-family: var(--font-primary);
      }

      .oni-aem * {
        box-sizing: border-box;
      }

      .oni-aem .aem-grid-main {
        display: grid;
        grid-template-columns: 1.05fr 1.35fr;
        gap: 10px;
      }

      .oni-aem .aem-card {
        background: rgba(255,255,255,.66);
        border: 1px solid rgba(60,45,25,.25);
        border-radius: 9px;
        padding: 8px;
        margin-bottom: 8px;
        box-shadow: 0 1px 2px rgba(0,0,0,.08);
      }

      .oni-aem h3 {
        margin: 0 0 7px 0;
        padding-bottom: 4px;
        font-size: 14px;
        border-bottom: 1px solid rgba(60,45,25,.25);
      }

      .oni-aem h4 {
        margin: 8px 0 5px 0;
        font-size: 12px;
      }

      .oni-aem label {
        display: block;
        font-weight: 700;
        font-size: 12px;
        margin: 5px 0 2px;
      }

      .oni-aem input,
      .oni-aem select,
      .oni-aem textarea {
        width: 100%;
      }

      .oni-aem select[multiple] {
        min-height: 150px;
      }

      .oni-aem button {
        cursor: pointer;
      }

      .oni-aem button:disabled {
        cursor: wait;
        opacity: .65;
      }

      .oni-aem .aem-row {
        display: flex;
        gap: 6px;
        align-items: center;
      }

      .oni-aem .aem-row > * {
        flex: 1;
      }

      .oni-aem .aem-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }

      .oni-aem .aem-actions-3 {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 6px;
      }

      .oni-aem .aem-mini {
        font-size: 11px;
        opacity: .75;
        line-height: 1.25;
      }

      .oni-aem .aem-effect-list {
        max-height: 265px;
        overflow: auto;
        border: 1px solid rgba(60,45,25,.18);
        border-radius: 7px;
        background: rgba(255,255,255,.45);
      }

      .oni-aem .aem-effect-row {
        display: grid;
        grid-template-columns: 30px 1fr auto;
        gap: 7px;
        align-items: center;
        padding: 5px 6px;
        border-bottom: 1px solid rgba(60,45,25,.12);
      }

      .oni-aem .aem-effect-row:last-child {
        border-bottom: none;
      }

      .oni-aem .aem-effect-row:hover {
        background: rgba(0,0,0,.06);
      }

      .oni-aem .aem-icon {
        width: 26px;
        height: 26px;
        object-fit: cover;
        border: none;
        border-radius: 5px;
        background: rgba(0,0,0,.08);
      }

      .oni-aem .aem-effect-name {
        font-weight: 700;
        line-height: 1.1;
      }

      .oni-aem .aem-effect-meta {
        font-size: 10px;
        opacity: .65;
        line-height: 1.15;
      }

      .oni-aem .aem-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin: 2px;
        padding: 3px 6px;
        border-radius: 999px;
        background: rgba(0,0,0,.12);
        border: 1px solid rgba(0,0,0,.12);
        font-size: 11px;
      }

      .oni-aem .aem-pill img {
        width: 16px;
        height: 16px;
        border: none;
        border-radius: 3px;
      }

      .oni-aem .aem-pill button {
        width: 18px;
        height: 18px;
        min-height: 18px;
        line-height: 14px;
        padding: 0;
        border-radius: 50%;
      }

      .oni-aem .aem-selected-list {
        min-height: 54px;
        max-height: 140px;
        overflow: auto;
        padding: 4px;
        border: 1px solid rgba(60,45,25,.18);
        border-radius: 7px;
        background: rgba(255,255,255,.45);
      }

      .oni-aem .aem-category-tabs {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 5px;
        margin-bottom: 6px;
      }

      .oni-aem .aem-category-tabs button.active {
        background: rgba(40,34,26,.88);
        color: white;
      }

      .oni-aem .aem-mod-row {
        display: grid;
        grid-template-columns: 1.3fr .8fr .7fr .5fr 28px;
        gap: 5px;
        align-items: end;
        margin-bottom: 5px;
      }

      .oni-aem .aem-output {
        width: 100%;
        min-height: 105px;
        font-family: monospace;
        font-size: 11px;
        color: #111;
        background: rgba(255,255,255,.82);
      }

      .oni-aem .aem-warning {
        background: rgba(120, 55, 0, .12);
        border: 1px solid rgba(120, 55, 0, .25);
        padding: 6px;
        border-radius: 7px;
        font-size: 11px;
      }

      .oni-aem .aem-empty {
        padding: 10px;
        opacity: .65;
        text-align: center;
      }
    `;

    document.head.appendChild(style);
  }

  // --------------------------------------------------------------------------
  // Rendering helpers
  // --------------------------------------------------------------------------

  function actorOptionsHtml(selectedUuids = []) {
    const selected = new Set(selectedUuids);

    return getAllActorsForSelection().map(actor => {
      const sel = selected.has(actor.uuid) ? "selected" : "";
      return `<option value="${escapeHtml(actor.uuid)}" ${sel}>${escapeHtml(actor.name)} — ${escapeHtml(actor.uuid)}</option>`;
    }).join("");
  }

  function categoryButtonHtml(category, label, state) {
    const active = state.categoryFilter === category ? "active" : "";
    return `<button type="button" class="${active}" data-aem-action="set-category" data-category="${escapeHtml(category)}">${escapeHtml(label)}</button>`;
  }

  function effectListHtml(state) {
    const q = String(state.search ?? "").trim().toLowerCase();
    const cat = state.categoryFilter;

    let rows = state.registryEntries ?? [];

    if (cat && cat !== "All") {
      rows = rows.filter(e => e.category === cat);
    }

    if (q) {
      rows = rows.filter(e => {
        const text = [
          e.name,
          e.category,
          e.sourceType,
          e.sourceName,
          ...(e.tags ?? []),
          ...(e.statuses ?? [])
        ].join(" ").toLowerCase();

        return text.includes(q);
      });
    }

    rows = rows.slice(0, 120);

    if (!rows.length) {
      return `<div class="aem-empty">No effects found.</div>`;
    }

    return rows.map(entry => {
      const img = entry.img || entry.icon || "icons/svg/aura.svg";
      const category = entry.category || "Other";
      const source = shortSource(entry);

      return `
        <div class="aem-effect-row">
          <img class="aem-icon" src="${escapeHtml(img)}">
          <div>
            <div class="aem-effect-name">${escapeHtml(entry.name)}</div>
            <div class="aem-effect-meta">${escapeHtml(category)}${source ? " • " + escapeHtml(source) : ""}</div>
          </div>
          <button
            type="button"
            data-aem-action="add-registry-effect"
            data-registry-id="${escapeHtml(entry.registryId)}"
          >Add</button>
        </div>
      `;
    }).join("");
  }

  function selectedEffectsHtml(state) {
    if (!state.selectedEffects.length) {
      return `<div class="aem-empty">No selected effects yet.</div>`;
    }

    return state.selectedEffects.map(sel => {
      const img = sel.img || "icons/svg/aura.svg";
      const kind = sel.kind === "custom" ? "Custom" : "Preset";

      return `
        <span class="aem-pill" title="${escapeHtml(kind)}">
          <img src="${escapeHtml(img)}">
          <b>${escapeHtml(sel.name)}</b>
          <small>${escapeHtml(sel.category || "Other")}</small>
          <button type="button" data-aem-action="remove-selected-effect" data-selected-id="${escapeHtml(sel.id)}">×</button>
        </span>
      `;
    }).join("");
  }

  function fieldDatalistHtml(state) {
    const entries = state.fieldEntries ?? [];

    return `
      <datalist id="aem-field-key-list">
        ${entries.map(entry => {
          const label = `${entry.label || entry.key} — ${entry.category || "Other"} — ${entry.valueKind || "unknown"}`;
          return `<option value="${escapeHtml(entry.activeEffectKey || entry.key)}" label="${escapeHtml(label)}"></option>`;
        }).join("")}
      </datalist>
    `;
  }

  function modifierRowsHtml(state) {
    if (!state.customRows.length) {
      state.customRows.push({
        id: randomId("mod"),
        key: "",
        mode: modeValue("ADD"),
        value: "1",
        priority: 20
      });
    }

    return state.customRows.map(row => `
      <div class="aem-mod-row" data-mod-row-id="${escapeHtml(row.id)}">
        <div>
          <label>Key</label>
          <input
            type="text"
            name="customChangeKey"
            list="aem-field-key-list"
            value="${escapeHtml(row.key)}"
            data-row-field="key"
            placeholder="damage_receiving_mod_all"
          >
        </div>

        <div>
          <label>Mode</label>
          <select name="customChangeMode" data-row-field="mode">
            ${modeOptionsHtml(row.mode)}
          </select>
        </div>

        <div>
          <label>Value</label>
          <input
            type="text"
            name="customChangeValue"
            value="${escapeHtml(row.value)}"
            data-row-field="value"
            placeholder="1"
          >
        </div>

        <div>
          <label>Priority</label>
          <input
            type="number"
            name="customChangePriority"
            value="${escapeHtml(row.priority)}"
            data-row-field="priority"
          >
        </div>

        <button
          type="button"
          title="Remove row"
          data-aem-action="remove-modifier-row"
          data-row-id="${escapeHtml(row.id)}"
        >×</button>
      </div>
    `).join("");
  }

  function renderMainContent(state) {
    return `
      <div class="oni-aem">
        <div class="aem-grid-main">
          <div>
            <div class="aem-card">
              <h3>Targets</h3>

              <div class="aem-actions">
                <button type="button" data-aem-action="use-selected-tokens">Use Selected Tokens</button>
                <button type="button" data-aem-action="clear-targets">Clear</button>
              </div>

              <label>Actors</label>
              <select name="targetActorUuids" multiple>
                ${actorOptionsHtml(state.targetActorUuids)}
              </select>

              <div class="aem-mini">
                This applies effects directly to Actors, so the target does not need to have a token on the scene.
              </div>
            </div>

            <div class="aem-card">
              <h3>Apply Options</h3>

              <label>Duplicate Behavior</label>
              <select name="duplicateMode">
                <option value="skip" ${state.duplicateMode === "skip" ? "selected" : ""}>Skip if already exists</option>
                <option value="replace" ${state.duplicateMode === "replace" ? "selected" : ""}>Replace existing</option>
                <option value="stack" ${state.duplicateMode === "stack" ? "selected" : ""}>Stack duplicate</option>
                <option value="remove" ${state.duplicateMode === "remove" ? "selected" : ""}>Remove existing instead</option>
                <option value="ask" ${state.duplicateMode === "ask" ? "selected" : ""}>Ask each time</option>
              </select>

              <div class="aem-row">
                <label>
                  <input type="checkbox" name="overrideDuration" ${state.overrideDuration ? "checked" : ""}>
                  Override duration
                </label>
                <label>
                  <input type="checkbox" name="silent" ${state.silent ? "checked" : ""}>
                  Silent
                </label>
              </div>

              <div class="aem-row">
                <div>
                  <label>Rounds</label>
                  <input type="number" name="durationRounds" value="${escapeHtml(state.durationRounds)}">
                </div>
                <div>
                  <label>Turns</label>
                  <input type="number" name="durationTurns" value="${escapeHtml(state.durationTurns)}">
                </div>
              </div>
            </div>

            <div class="aem-card">
              <h3>Selected Effects</h3>
              <div class="aem-selected-list" data-aem-selected-list>
                ${selectedEffectsHtml(state)}
              </div>

              <div class="aem-actions" style="margin-top:6px;">
                <button type="button" data-aem-action="apply-selected">Apply Selected</button>
                <button type="button" data-aem-action="clear-selected-effects">Clear Effects</button>
              </div>
            </div>

            <div class="aem-card">
              <h3>Output</h3>
              <textarea class="aem-output" readonly data-aem-output>${escapeHtml(state.outputText || "")}</textarea>
            </div>
          </div>

          <div>
            <div class="aem-card">
              <h3>Effect Registry</h3>

              <div class="aem-actions-3">
                <button type="button" data-aem-action="refresh-registry">Refresh</button>
                <button type="button" data-aem-action="refresh-registry-compendiums">Refresh + Compendiums</button>
                <button type="button" data-aem-action="debug-registry">Debug</button>
              </div>

              <label>Search</label>
              <input type="text" name="effectSearch" value="${escapeHtml(state.search)}" placeholder="Search effect name, source, tag...">

              <div class="aem-category-tabs">
                ${categoryButtonHtml("All", "All", state)}
                ${categoryButtonHtml("Buff", "Buff", state)}
                ${categoryButtonHtml("Debuff", "Debuff", state)}
                ${categoryButtonHtml("Other", "Other", state)}
              </div>

              <div class="aem-effect-list" data-aem-effect-list>
                ${effectListHtml(state)}
              </div>

              <div class="aem-mini">
                Registry entries are scanned from Foundry data. Add more preset effects to your game, then press Refresh.
              </div>
            </div>

            <div class="aem-card">
              <h3>Custom Active Effect Builder</h3>

              ${fieldDatalistHtml(state)}

              <div class="aem-row">
                <div>
                  <label>Name</label>
                  <input type="text" name="customName" value="${escapeHtml(state.customName)}" placeholder="Defense Boost">
                </div>

                <div>
                  <label>Category</label>
                  <select name="customCategory">
                    <option value="Buff" ${state.customCategory === "Buff" ? "selected" : ""}>Buff</option>
                    <option value="Debuff" ${state.customCategory === "Debuff" ? "selected" : ""}>Debuff</option>
                    <option value="Other" ${state.customCategory === "Other" ? "selected" : ""}>Other</option>
                  </select>
                </div>
              </div>

              <label>Icon</label>
              <input type="text" name="customIcon" value="${escapeHtml(state.customIcon)}" placeholder="icons/svg/aura.svg">

              <label>Status IDs / Marker Tags</label>
              <input type="text" name="customStatuses" value="${escapeHtml(state.customStatuses)}" placeholder="Optional, comma-separated. Example: bleed, mark">

              <label>Description</label>
              <textarea name="customDescription" rows="2" placeholder="Optional description">${escapeHtml(state.customDescription)}</textarea>

              <h4>Modifier Rows</h4>
              <div data-aem-modifier-rows>
                ${modifierRowsHtml(state)}
              </div>

              <div class="aem-actions-3">
                <button type="button" data-aem-action="add-modifier-row">Add Row</button>
                <button type="button" data-aem-action="refresh-fields">Refresh Fields</button>
                <button type="button" data-aem-action="preview-custom">Preview</button>
              </div>

              <div class="aem-actions" style="margin-top:6px;">
                <button type="button" data-aem-action="add-custom-marker">Add Marker Effect</button>
                <button type="button" data-aem-action="add-custom-modifier">Add Modifier Effect</button>
              </div>

              <div class="aem-warning" style="margin-top:6px;">
                Custom marker effects can have no changes. Custom modifier effects use the rows above.
                Old legacy keys like <code>isSlow</code> are intentionally not suggested.
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function updateOutput(root, state, data) {
    const text =
      typeof data === "string"
        ? data
        : JSON.stringify(data, null, 2);

    state.outputText = text;

    const out = root?.querySelector?.("[data-aem-output]");
    if (out) out.value = text;
  }

  function readCommonStateFromDom(root, state) {
    state.targetActorUuids = Array.from(root.querySelector('[name="targetActorUuids"]')?.selectedOptions ?? [])
      .map(o => o.value)
      .filter(Boolean);

    state.duplicateMode = root.querySelector('[name="duplicateMode"]')?.value ?? state.duplicateMode;
    state.overrideDuration = !!root.querySelector('[name="overrideDuration"]')?.checked;
    state.silent = !!root.querySelector('[name="silent"]')?.checked;

    state.durationRounds = root.querySelector('[name="durationRounds"]')?.value ?? state.durationRounds;
    state.durationTurns = root.querySelector('[name="durationTurns"]')?.value ?? state.durationTurns;

    state.search = root.querySelector('[name="effectSearch"]')?.value ?? state.search;

    state.customName = root.querySelector('[name="customName"]')?.value ?? state.customName;
    state.customCategory = root.querySelector('[name="customCategory"]')?.value ?? state.customCategory;
    state.customIcon = root.querySelector('[name="customIcon"]')?.value ?? state.customIcon;
    state.customStatuses = root.querySelector('[name="customStatuses"]')?.value ?? state.customStatuses;
    state.customDescription = root.querySelector('[name="customDescription"]')?.value ?? state.customDescription;

    syncModifierRowsFromDom(root, state);
  }

  function syncModifierRowsFromDom(root, state) {
    const rows = Array.from(root.querySelectorAll("[data-mod-row-id]"));

    state.customRows = rows.map(row => {
      const id = row.dataset.modRowId || randomId("mod");
      const key = row.querySelector('[data-row-field="key"]')?.value ?? "";
      const mode = Number(row.querySelector('[data-row-field="mode"]')?.value ?? modeValue("ADD"));
      const value = row.querySelector('[data-row-field="value"]')?.value ?? "";
      const priority = Number(row.querySelector('[data-row-field="priority"]')?.value ?? 20);

      return {
        id,
        key,
        mode,
        value,
        priority
      };
    });
  }

  function rerender(root, state) {
    const holder = root.querySelector("[data-aem-root-holder]");
    if (!holder) return;

    holder.innerHTML = renderMainContent(state);
  }

  // --------------------------------------------------------------------------
  // Data loading
  // --------------------------------------------------------------------------

  async function refreshRegistry(state, { includeCompendiums = false } = {}) {
    const registry = getRegistryApi();

    if (!registry) {
      state.registryEntries = [];
      return {
        ok: false,
        reason: "registry_api_not_found"
      };
    }

    const sampleActorUuid = state.targetActorUuids?.[0] ?? null;

    if (typeof registry.refresh === "function") {
      await registry.refresh({
        scanCompendiums: !!includeCompendiums,
        sampleActorUuid
      });
    }

    const entries = typeof registry.getAll === "function"
      ? registry.getAll({ cloneResult: false })
      : [];

    state.registryEntries = Array.isArray(entries) ? entries : [];

    return {
      ok: true,
      count: state.registryEntries.length
    };
  }

  async function refreshFields(state) {
    const catalogue = getFieldCatalogueApi();

    if (!catalogue) {
      state.fieldEntries = [];
      return {
        ok: false,
        reason: "field_catalogue_api_not_found"
      };
    }

    const actorUuid = state.targetActorUuids?.[0] ?? null;

    if (typeof catalogue.refresh === "function") {
      await catalogue.refresh({
        actorUuid,
        includeLegacyConditionKeys: false,
        includeReadOnly: false,
        suggestionsOnly: false
      });
    }

    const entries =
      typeof catalogue.getRecommended === "function"
        ? catalogue.getRecommended({ cloneResult: false })
        : typeof catalogue.getAll === "function"
          ? catalogue.getAll({ cloneResult: false })
          : [];

    state.fieldEntries = Array.isArray(entries) ? entries : [];

    return {
      ok: true,
      count: state.fieldEntries.length
    };
  }

  function findRegistryEntry(state, registryId) {
    return (state.registryEntries ?? []).find(e => String(e.registryId) === String(registryId)) ?? null;
  }

  // --------------------------------------------------------------------------
  // Custom effect builder
  // --------------------------------------------------------------------------

  function parseStatuses(raw) {
    return String(raw ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }

  function getGlobalDurationFromState(state) {
    if (!state.overrideDuration) return null;

    const rounds = Number(state.durationRounds);
    const turns = Number(state.durationTurns);

    const duration = {};

    if (Number.isFinite(rounds)) duration.rounds = rounds;
    if (Number.isFinite(turns)) duration.turns = turns;

    return duration;
  }

  function buildCustomEffectData(state, { includeChanges = true } = {}) {
    const name = safeString(state.customName, "Custom Active Effect");
    const img = safeString(state.customIcon, "icons/svg/aura.svg");
    const category = safeString(state.customCategory, "Other");

    const changes = includeChanges
      ? state.customRows
          .map(row => ({
            key: safeString(row.key),
            mode: Number(row.mode ?? modeValue("ADD")),
            value: String(row.value ?? ""),
            priority: Number(row.priority ?? 20)
          }))
          .filter(row => row.key)
      : [];

    const duration = getGlobalDurationFromState(state) ?? {
      rounds: 3,
      turns: 0
    };

    return {
      name,
      label: name,
      img,
      icon: img,
      disabled: false,
      transfer: false,
      description: state.customDescription ?? "",
      changes,
      statuses: parseStatuses(state.customStatuses),
      duration,
      flags: {
        [MODULE_ID]: {
          category,
          customActiveEffect: true,
          activeEffectManager: {
            managed: true,
            custom: true,
            sourceCategory: category,
            createdFromUi: true,
            createdAt: nowIso()
          }
        }
      }
    };
  }

  function addSelectedRegistryEffect(state, entry) {
    if (!entry) return;

    state.selectedEffects.push({
      id: randomId("selected"),
      kind: "registry",
      registryId: entry.registryId,
      name: entry.name,
      img: entry.img || entry.icon || "icons/svg/aura.svg",
      category: entry.category || "Other"
    });
  }

  function addSelectedCustomEffect(state, effectData, category = "Other") {
    state.selectedEffects.push({
      id: randomId("selected"),
      kind: "custom",
      effectData,
      name: effectData.name,
      img: effectData.img || effectData.icon || "icons/svg/aura.svg",
      category
    });
  }

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  async function applySelected(root, state) {
    const manager = getManagerApi();

    if (!manager?.applyEffects) {
      updateOutput(root, state, {
        ok: false,
        reason: "active_effect_manager_api_not_found"
      });
      return;
    }

    if (!state.targetActorUuids.length) {
      updateOutput(root, state, {
        ok: false,
        reason: "no_target_actors",
        hint: "Choose at least one actor first."
      });
      return;
    }

    if (!state.selectedEffects.length) {
      updateOutput(root, state, {
        ok: false,
        reason: "no_selected_effects",
        hint: "Add at least one effect first."
      });
      return;
    }

    const effects = state.selectedEffects.map(sel => {
      if (sel.kind === "registry") return sel.registryId;
      return {
        effectData: clone(sel.effectData, {})
      };
    });

    const duration = getGlobalDurationFromState(state);

    const result = await manager.applyEffects({
      actorUuids: state.targetActorUuids,
      effects,
      duplicateMode: state.duplicateMode,
      duration,
      silent: state.silent,
      renderChat: true,
      playFx: true
    });

    updateOutput(root, state, result);
  }

  async function removeSelectedByName(root, state) {
    const manager = getManagerApi();

    if (!manager?.removeEffects) {
      updateOutput(root, state, {
        ok: false,
        reason: "active_effect_manager_api_not_found"
      });
      return;
    }

    const names = state.selectedEffects.map(e => e.name).filter(Boolean);

    const result = await manager.removeEffects({
      actorUuids: state.targetActorUuids,
      names,
      silent: state.silent,
      renderChat: true
    });

    updateOutput(root, state, result);
  }

  // --------------------------------------------------------------------------
  // Main open function
  // --------------------------------------------------------------------------

  async function open() {
    if (!game.user?.isGM) {
      ui.notifications?.warn?.("Active Effect Manager UI is GM-only.");
      return null;
    }

    injectStyle();

    if (ACTIVE_DIALOG) {
      try {
        ACTIVE_DIALOG.bringToTop?.();
        return ACTIVE_DIALOG;
      } catch (_e) {}
    }

    const initialTargets = selectedTokenActorUuids();

    const state = {
      targetActorUuids: initialTargets,

      registryEntries: [],
      fieldEntries: [],

      selectedEffects: [],

      categoryFilter: "All",
      search: "",

      duplicateMode: "skip",
      overrideDuration: true,
      durationRounds: 3,
      durationTurns: 0,
      silent: false,

      customName: "Custom Active Effect",
      customCategory: "Buff",
      customIcon: "icons/svg/aura.svg",
      customStatuses: "",
      customDescription: "",
      customRows: [
        {
          id: randomId("mod"),
          key: "",
          mode: modeValue("ADD"),
          value: "1",
          priority: 20
        }
      ],

      outputText: ""
    };

    try {
      await refreshRegistry(state, { includeCompendiums: false });
    } catch (e) {
      warn("Initial registry refresh failed.", e);
      state.outputText = JSON.stringify({
        registryRefreshFailed: compactError(e)
      }, null, 2);
    }

    try {
      await refreshFields(state);
    } catch (e) {
      warn("Initial field catalogue refresh failed.", e);
    }

    const dialog = new Dialog({
      title: "Active Effect Manager",
      content: `
        <div data-aem-root-holder>
          ${renderMainContent(state)}
        </div>
      `,
      buttons: {
        close: {
          label: "Close"
        }
      },
      default: "close",
      render: (html) => {
        const root = normalizeHtmlRoot(html);
        if (!root) return;

        const holder = root.querySelector("[data-aem-root-holder]");
        if (!holder) return;

        holder.addEventListener("input", (ev) => {
          const target = ev.target;
          if (!target) return;

          readCommonStateFromDom(root, state);

          if (target.name === "effectSearch") {
            rerender(root, state);
          }
        });

        holder.addEventListener("change", async (ev) => {
          const target = ev.target;
          if (!target) return;

          readCommonStateFromDom(root, state);

          if (target.name === "targetActorUuids") {
            try {
              await refreshFields(state);
            } catch (e) {
              warn("Field refresh after target change failed.", e);
            }

            rerender(root, state);
          }
        });

        holder.addEventListener("click", async (ev) => {
          const btn = ev.target.closest?.("[data-aem-action]");
          if (!btn) return;

          ev.preventDefault();
          ev.stopPropagation();

          const action = btn.dataset.aemAction;

          try {
            btn.disabled = true;
            readCommonStateFromDom(root, state);

            if (action === "use-selected-tokens") {
              state.targetActorUuids = selectedTokenActorUuids();
              await refreshFields(state);
              rerender(root, state);
              return;
            }

            if (action === "clear-targets") {
              state.targetActorUuids = [];
              rerender(root, state);
              return;
            }

            if (action === "set-category") {
              state.categoryFilter = btn.dataset.category || "All";
              rerender(root, state);
              return;
            }

            if (action === "refresh-registry") {
              const result = await refreshRegistry(state, { includeCompendiums: false });
              updateOutput(root, state, result);
              rerender(root, state);
              return;
            }

            if (action === "refresh-registry-compendiums") {
              const result = await refreshRegistry(state, { includeCompendiums: true });
              updateOutput(root, state, result);
              rerender(root, state);
              return;
            }

            if (action === "debug-registry") {
              const registry = getRegistryApi();
              const report =
                registry?.getLastReport?.() ??
                {
                  ok: false,
                  reason: "registry_api_not_found"
                };

              console.groupCollapsed(`${TAG} Registry Debug`);
              console.log(report);
              console.groupEnd();

              updateOutput(root, state, report);
              return;
            }

            if (action === "add-registry-effect") {
              const entry = findRegistryEntry(state, btn.dataset.registryId);
              addSelectedRegistryEffect(state, entry);
              rerender(root, state);
              return;
            }

            if (action === "remove-selected-effect") {
              const id = btn.dataset.selectedId;
              state.selectedEffects = state.selectedEffects.filter(e => e.id !== id);
              rerender(root, state);
              return;
            }

            if (action === "clear-selected-effects") {
              state.selectedEffects = [];
              rerender(root, state);
              return;
            }

            if (action === "add-modifier-row") {
              state.customRows.push({
                id: randomId("mod"),
                key: "",
                mode: modeValue("ADD"),
                value: "1",
                priority: 20
              });
              rerender(root, state);
              return;
            }

            if (action === "remove-modifier-row") {
              const id = btn.dataset.rowId;
              state.customRows = state.customRows.filter(r => r.id !== id);
              if (!state.customRows.length) {
                state.customRows.push({
                  id: randomId("mod"),
                  key: "",
                  mode: modeValue("ADD"),
                  value: "1",
                  priority: 20
                });
              }
              rerender(root, state);
              return;
            }

            if (action === "refresh-fields") {
              const result = await refreshFields(state);
              updateOutput(root, state, result);
              rerender(root, state);
              return;
            }

            if (action === "preview-custom") {
              const effectData = buildCustomEffectData(state, { includeChanges: true });
              updateOutput(root, state, {
                ok: true,
                preview: effectData
              });
              return;
            }

            if (action === "add-custom-marker") {
              const effectData = buildCustomEffectData(state, { includeChanges: false });
              addSelectedCustomEffect(state, effectData, state.customCategory);
              rerender(root, state);
              return;
            }

            if (action === "add-custom-modifier") {
              const effectData = buildCustomEffectData(state, { includeChanges: true });

              if (!effectData.changes.length) {
                updateOutput(root, state, {
                  ok: false,
                  reason: "no_modifier_rows",
                  hint: "Add at least one modifier row, or use Add Marker Effect instead."
                });
                return;
              }

              addSelectedCustomEffect(state, effectData, state.customCategory);
              rerender(root, state);
              return;
            }

            if (action === "apply-selected") {
              await applySelected(root, state);
              return;
            }

          } catch (e) {
            err("UI action failed.", {
              action,
              error: e
            });

            updateOutput(root, state, {
              ok: false,
              action,
              error: compactError(e)
            });
          } finally {
            btn.disabled = false;
          }
        });
      },
      close: () => {
        ACTIVE_DIALOG = null;
      }
    }, {
      width: 980,
      height: "auto",
      resizable: true
    });

    ACTIVE_DIALOG = dialog;
    dialog.render(true);

    return dialog;
  }

  // --------------------------------------------------------------------------
  // Expose API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.1.0",
    open,
    reopen: () => {
      try {
        ACTIVE_DIALOG?.close?.();
      } catch (_e) {}
      ACTIVE_DIALOG = null;
      return open();
    },
    getActiveDialog: () => ACTIVE_DIALOG
  };

  const root = ensureApiRoot();
  root.ui = api;
  root.openUI = open;

  try {
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod) {
      mod.api = mod.api || {};
      mod.api.activeEffectManager = mod.api.activeEffectManager || {};
      mod.api.activeEffectManager.ui = api;
      mod.api.activeEffectManager.openUI = open;
    }
  } catch (e) {
    warn("Could not expose UI API on module object.", e);
  }

  Hooks.once("ready", () => {
    const root = ensureApiRoot();
    root.ui = api;
    root.openUI = open;

    log("Ready. Active Effect Manager UI installed.", {
      open: "FUCompanion.api.activeEffectManager.ui.open()"
    });
  });
})();