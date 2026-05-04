// ============================================================================
// ActiveEffectManager-key-suggestions.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Global Smart Suggestions for ALL native Active Effect Configuration windows.
// - Works when an Active Effect sheet is opened from:
//     1. Active Effect Manager native builder
//     2. Actor sheet embedded effects
//     3. Item sheet embedded effects
//     4. Any normal Foundry ActiveEffectConfig / CSB CustomActiveEffectConfig window
// - Suggests CSB-style short keys such as "defense", "bonus_defense",
//   "damage_receiving_mod_all", etc.
//
// Depends on:
// - ActiveEffectManager-field-catalog.js
//
// Public API:
//   FUCompanion.api.activeEffectKeySuggestions.status()
//   FUCompanion.api.activeEffectKeySuggestions.refresh(actorOrUuid, options)
//   FUCompanion.api.activeEffectKeySuggestions.installIntoSheet(app, html, options)
//   FUCompanion.api.activeEffectKeySuggestions.getSuggestions(query, options)
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][AEKeySuggest]";
  const PATCH_KEY = "__ONI_ACTIVE_EFFECT_KEY_SUGGESTIONS_GLOBAL_V1__";

  const DEBUG = false;

  const STYLE_ID = "oni-aem-native-key-suggestion-style";
  const DROPDOWN_CLASS = "oni-aem-native-key-suggestion-dropdown";

  // Keep this compatible with your current CSB ActiveEffect setup.
  // "short" => defense
  // "path"  => system.props.defense
  const SUGGESTION_VALUE_MODE = "short";

  const CFG = {
    enabled: true,
    limit: 12,
    cacheMs: 8000,
    hookNames: [
      "renderActiveEffectConfig",
      "renderCustomActiveEffectConfig"
    ],
    refreshOnRender: true,
    includeLegacyConditionKeys: false,
    includeReadOnly: false,
    suggestionsOnly: false
  };

  if (globalThis[PATCH_KEY]) {
    console.warn(TAG, "Already installed. Skipping duplicate install.");
    return;
  }

  globalThis[PATCH_KEY] = true;

  const log = (...args) => DEBUG && console.log(TAG, ...args);
  const warn = (...args) => console.warn(TAG, ...args);

  const STATE = {
    installed: false,
    hookIds: [],
    dropdown: null,
    activeField: null,
    activeRows: [],
    activeIndex: 0,
    refreshCache: new Map(),
    sheetSessions: new WeakMap(),
    lastInstallCount: 0,
    lastRefreshReport: null
  };

  // --------------------------------------------------------------------------
  // Namespace / API
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    return globalThis.FUCompanion.api;
  }

  function exposeApi(api) {
    const root = ensureApiRoot();

    root.activeEffectKeySuggestions = api;
    root.activeEffectSmartSuggestions = api;

    // Friendly bridge alias under activeEffectManager too.
    root.activeEffectManager = root.activeEffectManager || {};
    root.activeEffectManager.keySuggestions = api;
    root.activeEffectManager.smartSuggestions = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);

      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectKeySuggestions = api;
        mod.api.activeEffectSmartSuggestions = api;
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.keySuggestions = api;
        mod.api.activeEffectManager.smartSuggestions = api;
      }
    } catch (e) {
      warn("Could not expose API on module object.", e);
    }
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
  // Small helpers
  // --------------------------------------------------------------------------

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

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (value instanceof Set) return Array.from(value);
    return [value];
  }

  function compactError(e) {
    return String(e?.message ?? e);
  }

  function cssEscape(value) {
    try {
      if (globalThis.CSS?.escape) return CSS.escape(String(value ?? ""));
    } catch (_e) {}

    return String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function normalizeHtmlRoot(htmlOrElement) {
    if (!htmlOrElement) return null;
    if (htmlOrElement instanceof HTMLElement) return htmlOrElement;
    if (htmlOrElement[0] instanceof HTMLElement) return htmlOrElement[0];
    if (htmlOrElement.element instanceof HTMLElement) return htmlOrElement.element;
    if (htmlOrElement.element?.[0] instanceof HTMLElement) return htmlOrElement.element[0];
    return null;
  }

  function documentFromSheet(app) {
    return app?.document ?? app?.object ?? null;
  }

  function actorFromDocument(doc) {
    if (!doc) return null;
    if (doc.documentName === "Actor") return doc;
    if (doc.actor?.documentName === "Actor") return doc.actor;
    if (doc.parent?.documentName === "Actor") return doc.parent;
    if (doc.parent?.actor?.documentName === "Actor") return doc.parent.actor;
    return null;
  }

  async function resolveActor(actorOrUuid = null) {
    if (!actorOrUuid) return null;

    if (typeof actorOrUuid !== "string") {
      return actorFromDocument(actorOrUuid) ?? actorOrUuid;
    }

    try {
      const doc = await fromUuid(actorOrUuid);
      return actorFromDocument(doc) ?? doc ?? null;
    } catch (_e) {
      return null;
    }
  }

  function getSelectedOrFallbackActor() {
    const selectedToken = canvas?.tokens?.controlled?.[0] ?? null;
    if (selectedToken?.actor) return selectedToken.actor;

    if (game.user?.character) return game.user.character;

    return Array.from(game.actors ?? []).find(actor => {
      try {
        return game.user?.isGM || actor.testUserPermission?.(game.user, "OWNER");
      } catch (_e) {
        return false;
      }
    }) ?? null;
  }

  async function resolveSuggestionActor(appOrActor = null, options = {}) {
    const direct = await resolveActor(options.actor ?? options.actorUuid ?? appOrActor);
    if (direct?.documentName === "Actor") return direct;

    const docActor = actorFromDocument(documentFromSheet(appOrActor));
    if (docActor) return docActor;

    const fromSheetDocument = actorFromDocument(appOrActor?.document ?? appOrActor?.object);
    if (fromSheetDocument) return fromSheetDocument;

    return getSelectedOrFallbackActor();
  }

  function getSheetRoot(app, html) {
    return normalizeHtmlRoot(html) ??
      normalizeHtmlRoot(app?.element) ??
      document.getElementById(app?.id) ??
      document.querySelector(`[data-appid="${app?.appId}"]`) ??
      document.querySelector(`#app-${app?.appId}`) ??
      null;
  }

  // --------------------------------------------------------------------------
  // CSS / dropdown
  // --------------------------------------------------------------------------

  function ensureStyle() {
    let style = document.getElementById(STYLE_ID);
    if (style) return style;

    style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${DROPDOWN_CLASS} {
        position: fixed;
        z-index: 9999999;
        display: none;
        min-width: 260px;
        max-width: 460px;
        max-height: 260px;
        overflow: auto;
        padding: 5px;
        border: 1px solid rgba(40, 32, 24, .34);
        border-radius: 8px;
        background: rgba(248, 242, 224, .98);
        box-shadow: 0 10px 28px rgba(0,0,0,.28);
        color: #1f1a14;
        font-family: var(--font-primary, "Signika"), sans-serif;
      }

      .${DROPDOWN_CLASS} .aem-suggest-head {
        padding: 4px 6px 6px;
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: .04em;
        opacity: .62;
      }

      .${DROPDOWN_CLASS} .aem-suggest-row {
        display: grid;
        gap: 2px;
        padding: 6px 7px;
        border-radius: 6px;
        cursor: pointer;
      }

      .${DROPDOWN_CLASS} .aem-suggest-row:hover,
      .${DROPDOWN_CLASS} .aem-suggest-row.active {
        background: rgba(65, 50, 32, .14);
      }

      .${DROPDOWN_CLASS} .aem-suggest-key {
        font-family: monospace;
        font-size: 12px;
        font-weight: 900;
        color: #15110c;
        overflow-wrap: anywhere;
      }

      .${DROPDOWN_CLASS} .aem-suggest-meta {
        font-size: 10px;
        opacity: .7;
        line-height: 1.2;
      }
    `;

    document.head.appendChild(style);
    return style;
  }

  function hideDropdown() {
    const dropdown = STATE.dropdown;
    if (!dropdown) return;

    dropdown.style.display = "none";
    dropdown.innerHTML = "";
    dropdown.__oniAeSuggestions = [];
    dropdown.__oniAeField = null;
    STATE.activeField = null;
    STATE.activeRows = [];
    STATE.activeIndex = 0;
  }

  function getDropdown() {
    if (STATE.dropdown?.isConnected) return STATE.dropdown;

    const dropdown = document.createElement("div");
    dropdown.className = DROPDOWN_CLASS;
    dropdown.dataset.globalAeKeySuggestions = "1";
    document.body.appendChild(dropdown);

    dropdown.addEventListener("mousedown", ev => {
      const row = ev.target.closest?.(".aem-suggest-row");
      if (!row) return;

      ev.preventDefault();
      ev.stopPropagation();

      chooseSuggestion(Number(row.dataset.suggestionIndex ?? 0) || 0);
    });

    document.addEventListener("mousedown", ev => {
      if (dropdown.contains(ev.target)) return;
      if (STATE.activeField?.contains?.(ev.target)) return;
      hideDropdown();
    });

    window.addEventListener("resize", hideDropdown);
    window.addEventListener("scroll", hideDropdown, true);

    STATE.dropdown = dropdown;
    return dropdown;
  }

  // --------------------------------------------------------------------------
  // Field catalogue / suggestion rows
  // --------------------------------------------------------------------------

  function normalizeSuggestionEntry(entry = {}) {
    const key = safeString(
      SUGGESTION_VALUE_MODE === "path"
        ? entry.propPath
        : entry.activeEffectKey ?? entry.key
    );

    if (!key) return null;

    return {
      key,
      rawKey: safeString(entry.key ?? entry.activeEffectKey, key),
      label: safeString(entry.label, key),
      category: safeString(entry.category, "Other"),
      valueKind: safeString(entry.valueKind, "unknown"),
      source: safeString(entry.source, ""),
      currentValue: entry.currentValue,
      recommendedChange: entry.recommendedChange ?? null,
      entry
    };
  }

  function scoreLocalSuggestion(query, entry = {}) {
    const q = safeString(query).toLowerCase();
    if (!q) return entry.isRecommended ? 80 : 0;

    const text = [
      entry.key,
      entry.activeEffectKey,
      entry.propPath,
      entry.label,
      entry.category,
      entry.valueKind,
      ...(entry.section ?? [])
    ].join(" ").toLowerCase();

    let score = 0;
    const key = safeString(entry.key ?? entry.activeEffectKey).toLowerCase();
    const label = safeString(entry.label).toLowerCase();

    if (key === q) score += 1000;
    if (label === q) score += 900;
    if (key.includes(q)) score += 700;
    if (label.includes(q)) score += 600;
    if (text.includes(q)) score += 300;

    const parts = q.split(/[\s._-]+/g).filter(Boolean);
    for (const part of parts) {
      if (key.includes(part)) score += 120;
      if (label.includes(part)) score += 90;
      if (text.includes(part)) score += 40;
    }

    if (entry.isRecommended) score += 80;
    if (entry.isLegacyConditionKey) score -= 1000;
    if (entry.isReadOnly) score -= 500;

    return score;
  }

  async function refresh(actorOrUuid = null, options = {}) {
    const catalogue = getFieldCatalogueApi();

    if (!catalogue) {
      const report = {
        ok: false,
        reason: "field_catalogue_api_not_found",
        entries: []
      };
      STATE.lastRefreshReport = report;
      return report;
    }

    const actor = await resolveSuggestionActor(actorOrUuid, options);
    const actorUuid = actor?.uuid ?? null;
    const cacheKey = actorUuid ?? "fallback";
    const now = Date.now();

    const cached = STATE.refreshCache.get(cacheKey);
    const cacheMs = Number(options.cacheMs ?? CFG.cacheMs) || 0;

    if (!options.force && cached && now - cached.refreshedAt < cacheMs) {
      const report = {
        ok: true,
        cached: true,
        actorUuid,
        actorName: actor?.name ?? null,
        count: cached.entries.length,
        entries: cached.entries
      };
      STATE.lastRefreshReport = report;
      return report;
    }

    try {
      if (typeof catalogue.refresh === "function") {
        await catalogue.refresh({
          actorUuid,
          includeLegacyConditionKeys: options.includeLegacyConditionKeys ?? CFG.includeLegacyConditionKeys,
          includeReadOnly: options.includeReadOnly ?? CFG.includeReadOnly,
          suggestionsOnly: options.suggestionsOnly ?? CFG.suggestionsOnly
        });
      }

      const entries =
        typeof catalogue.getRecommended === "function"
          ? catalogue.getRecommended({ cloneResult: false })
          : typeof catalogue.getAll === "function"
            ? catalogue.getAll({ cloneResult: false })
            : [];

      const cleanEntries = Array.isArray(entries) ? entries : [];

      STATE.refreshCache.set(cacheKey, {
        actorUuid,
        actorName: actor?.name ?? null,
        refreshedAt: now,
        entries: cleanEntries
      });

      const report = {
        ok: true,
        cached: false,
        actorUuid,
        actorName: actor?.name ?? null,
        count: cleanEntries.length,
        entries: cleanEntries
      };

      STATE.lastRefreshReport = report;
      return report;
    } catch (e) {
      const report = {
        ok: false,
        reason: "field_catalogue_refresh_failed",
        error: compactError(e),
        actorUuid,
        actorName: actor?.name ?? null,
        entries: cached?.entries ?? []
      };

      STATE.lastRefreshReport = report;
      warn("Field catalogue refresh failed.", report);
      return report;
    }
  }

  function getSessionEntries(options = {}) {
    const session = options.session ?? null;
    if (Array.isArray(session?.fieldEntries)) return session.fieldEntries;

    const actorUuid = options.actor?.uuid ?? options.actorUuid ?? null;
    if (actorUuid && STATE.refreshCache.has(actorUuid)) {
      return STATE.refreshCache.get(actorUuid).entries ?? [];
    }

    const fallback = STATE.refreshCache.get("fallback");
    if (fallback) return fallback.entries ?? [];

    // Last resort: use whatever the catalogue currently has.
    const catalogue = getFieldCatalogueApi();

    try {
      const rows =
        typeof catalogue?.getRecommended === "function"
          ? catalogue.getRecommended({ cloneResult: false })
          : typeof catalogue?.getAll === "function"
            ? catalogue.getAll({ cloneResult: false })
            : [];

      return Array.isArray(rows) ? rows : [];
    } catch (_e) {
      return [];
    }
  }

  function getSuggestions(query = "", options = {}) {
    const catalogue = getFieldCatalogueApi();
    const q = safeString(query);
    const limit = Number(options.limit ?? CFG.limit) || CFG.limit;

    try {
      if (typeof catalogue?.getSuggestions === "function") {
        const rows = catalogue.getSuggestions(q, {
          limit,
          cloneResult: false
        });

        if (Array.isArray(rows) && rows.length) {
          return rows
            .map(normalizeSuggestionEntry)
            .filter(Boolean)
            .slice(0, limit);
        }
      }
    } catch (_e) {}

    return getSessionEntries(options)
      .map(entry => ({
        entry,
        score: scoreLocalSuggestion(q, entry)
      }))
      .filter(row => row.score > 0 || !q)
      .sort((a, b) => b.score - a.score)
      .map(row => normalizeSuggestionEntry(row.entry))
      .filter(Boolean)
      .slice(0, limit);
  }

  // --------------------------------------------------------------------------
  // Input detection / dropdown binding
  // --------------------------------------------------------------------------

  function rowLooksLikeChangeRow(input, root) {
    const row = input.closest?.("tr, .form-group, .form-fields, .effect-change, .changes-list, li, fieldset") ?? null;
    if (!row) return false;

    const names = Array.from(row.querySelectorAll?.("input, textarea, select") ?? [])
      .map(el => String(el.getAttribute("name") ?? ""));

    const hasChangeNames = names.some(name => /(^|\.|\[)changes(\.|\[|\])/i.test(name));
    const hasValueOrMode = names.some(name => /(\.|\[)(mode|value|priority)(\]|$|\.)/i.test(name));

    if (hasChangeNames && hasValueOrMode) return true;

    const labelText = [
      input.closest?.("label")?.textContent ?? "",
      input.id ? root?.querySelector?.(`label[for="${cssEscape(input.id)}"]`)?.textContent ?? "" : "",
      row.textContent ?? ""
    ].join(" ").toLowerCase();

    return /attribute\s*key|data\s*key|change\s*key|effect\s*key/.test(labelText) && hasValueOrMode;
  }

  function isActiveEffectChangeKeyInput(input, root) {
    if (!input || input.disabled || input.readOnly) return false;

    const name = String(input.getAttribute("name") ?? "");
    const placeholder = String(input.getAttribute("placeholder") ?? "");
    const aria = String(input.getAttribute("aria-label") ?? "");
    const title = String(input.getAttribute("title") ?? "");
    const text = [name, placeholder, aria, title].join(" ").toLowerCase();

    // Native Foundry/CSB rows usually look like changes.0.key or changes[0][key].
    const explicitChangeKey =
      /(^|\.|\[)changes(\.|\[|\])/i.test(name) &&
      /(\.|\[)key(\]|$|\.)/i.test(name);

    if (explicitChangeKey) return true;

    // Some custom ActiveEffect sheets use a simpler field name, but only trust it
    // if the surrounding row also contains value/mode/priority controls.
    const simpleKey =
      /^key$/i.test(name) ||
      /\.key$/i.test(name) ||
      /\[key\]$/i.test(name) ||
      /attribute key|data key|change key/.test(text);

    return simpleKey && rowLooksLikeChangeRow(input, root);
  }

  function findAttributeKeyFields(root) {
    const candidates = Array.from(root?.querySelectorAll?.("input, textarea") ?? []);
    return candidates.filter(input => isActiveEffectChangeKeyInput(input, root));
  }

  function renderDropdown(field, rows) {
    const dropdown = getDropdown();

    if (!field || !rows.length) {
      hideDropdown();
      return;
    }

    STATE.activeField = field;
    STATE.activeRows = rows;
    STATE.activeIndex = 0;

    dropdown.__oniAeSuggestions = rows;
    dropdown.__oniAeField = field;

    dropdown.innerHTML = `
      <div class="aem-suggest-head">Active Effect Key Suggestions</div>
      ${rows.map((row, index) => `
        <div
          class="aem-suggest-row ${index === 0 ? "active" : ""}"
          data-suggestion-index="${index}"
          data-suggestion-key="${escapeHtml(row.key)}"
        >
          <div class="aem-suggest-key">${escapeHtml(row.key)}</div>
          <div class="aem-suggest-meta">
            ${escapeHtml(row.label)}
            ${row.category ? " • " + escapeHtml(row.category) : ""}
            ${row.valueKind ? " • " + escapeHtml(row.valueKind) : ""}
          </div>
        </div>
      `).join("")}
    `;

    const rect = field.getBoundingClientRect();
    const maxLeft = Math.max(6, window.innerWidth - 470);
    const left = Math.min(Math.max(6, rect.left), maxLeft);

    dropdown.style.left = `${left}px`;
    dropdown.style.top = `${Math.max(6, rect.bottom + 4)}px`;
    dropdown.style.minWidth = `${Math.max(260, rect.width)}px`;
    dropdown.style.display = "block";
  }

  function refreshDropdownForField(field, session) {
    const rows = getSuggestions(field.value, {
      session,
      actor: session?.actor,
      actorUuid: session?.actor?.uuid,
      limit: CFG.limit
    });

    renderDropdown(field, rows);
  }

  function updateActiveRow() {
    const dropdown = STATE.dropdown;
    if (!dropdown) return;

    const rows = Array.from(dropdown.querySelectorAll?.(".aem-suggest-row") ?? []);

    for (const row of rows) row.classList.remove("active");

    const active = rows[STATE.activeIndex];
    active?.classList.add("active");
    active?.scrollIntoView?.({ block: "nearest" });
  }

  function moveActive(dir) {
    const total = STATE.activeRows.length;
    if (!total) return;

    STATE.activeIndex = Math.max(0, Math.min(total - 1, STATE.activeIndex + dir));
    updateActiveRow();
  }

  function chooseSuggestion(index = STATE.activeIndex) {
    const field = STATE.activeField ?? STATE.dropdown?.__oniAeField ?? null;
    const row = STATE.activeRows[index] ?? STATE.dropdown?.__oniAeSuggestions?.[index] ?? null;

    if (!field || !row) return false;

    field.value = row.key;

    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));

    hideDropdown();

    try {
      field.focus();
    } catch (_e) {}

    return true;
  }

  function bindField(field, session) {
    // Use the same dataset key as the old AEM native builder so both systems
    // cannot bind the same input twice.
    if (!field || field.dataset.oniAemNativeSuggestBound) return false;

    field.dataset.oniAemNativeSuggestBound = "1";
    field.dataset.oniAeKeySuggestGlobal = "1";
    field.setAttribute("autocomplete", "off");

    field.addEventListener("focus", () => refreshDropdownForField(field, session));
    field.addEventListener("click", () => refreshDropdownForField(field, session));
    field.addEventListener("input", () => refreshDropdownForField(field, session));

    field.addEventListener("keydown", ev => {
      const dropdown = STATE.dropdown;
      const open = dropdown?.style?.display === "block";
      if (!open || STATE.activeField !== field) return;

      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        moveActive(1);
        return;
      }

      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        moveActive(-1);
        return;
      }

      if (ev.key === "Enter" || ev.key === "Tab") {
        if (STATE.activeRows.length) {
          ev.preventDefault();
          chooseSuggestion(STATE.activeIndex);
        }
        return;
      }

      if (ev.key === "Escape") {
        hideDropdown();
      }
    });

    return true;
  }

  function bindFields(root, session) {
    const fields = findAttributeKeyFields(root);
    let bound = 0;

    for (const field of fields) {
      if (bindField(field, session)) bound++;
    }

    STATE.lastInstallCount = fields.length;

    return {
      ok: true,
      fields: fields.length,
      newlyBound: bound
    };
  }

  // --------------------------------------------------------------------------
  // Sheet install / lifecycle
  // --------------------------------------------------------------------------

  function patchSheetClose(app, session) {
    if (!app?.close || app.__oniAeKeySuggestClosePatched) return;

    const originalClose = app.close.bind(app);

    app.__oniAeKeySuggestClosePatched = true;
    app.__oniAeKeySuggestOriginalClose = originalClose;

    app.close = async function patchedActiveEffectKeySuggestionClose(...args) {
      try {
        session.observer?.disconnect?.();

        if (STATE.activeField && session.root?.contains?.(STATE.activeField)) {
          hideDropdown();
        }
      } catch (_e) {}

      return await originalClose(...args);
    };
  }

  function getOrCreateSession(app, root) {
    let session = STATE.sheetSessions.get(app);

    if (!session) {
      session = {
        app,
        root,
        actor: null,
        fieldEntries: [],
        observer: null,
        refreshing: false
      };

      STATE.sheetSessions.set(app, session);
      patchSheetClose(app, session);
    }

    session.root = root ?? session.root;
    return session;
  }

  async function installIntoSheet(app, html, options = {}) {
    if (!CFG.enabled && options.force !== true) {
      return {
        ok: false,
        reason: "disabled"
      };
    }

    const root = getSheetRoot(app, html);

    if (!root) {
      return {
        ok: false,
        reason: "sheet_root_not_found"
      };
    }

    ensureStyle();
    getDropdown();

    const session = getOrCreateSession(app, root);
    session.actor = await resolveSuggestionActor(app, options);

    const firstBind = bindFields(root, session);

    if (CFG.refreshOnRender || options.forceRefresh) {
      session.refreshing = true;

      const report = await refresh(session.actor, {
        ...options,
        force: !!options.forceRefresh
      });

      session.refreshing = false;
      session.fieldEntries = report.entries ?? [];
    }

    const secondBind = bindFields(root, session);

    if (!session.observer) {
      session.observer = new MutationObserver(() => {
        bindFields(root, session);
      });

      session.observer.observe(root, {
        childList: true,
        subtree: true
      });
    }

    log("Installed global key suggestions into ActiveEffect sheet.", {
      sheet: app?.constructor?.name,
      actor: session.actor?.name,
      fields: secondBind.fields,
      newlyBound: firstBind.newlyBound + secondBind.newlyBound,
      suggestions: session.fieldEntries.length
    });

    return {
      ok: true,
      sheet: app?.constructor?.name ?? null,
      actorUuid: session.actor?.uuid ?? null,
      actorName: session.actor?.name ?? null,
      fields: secondBind.fields,
      fieldSuggestions: session.fieldEntries.length
    };
  }

  function installHooks() {
    if (STATE.installed) return;

    for (const hookName of CFG.hookNames) {
      const id = Hooks.on(hookName, (app, html, data) => {
        installIntoSheet(app, html, { data }).catch(e => {
          warn(`Could not install key suggestions from ${hookName}.`, e);
        });

        // Some custom sheets render late/dynamically. These delayed passes make
        // the feature reliable after users add new change rows.
        setTimeout(() => {
          installIntoSheet(app, html, { data }).catch(() => {});
        }, 80);

        setTimeout(() => {
          installIntoSheet(app, html, { data }).catch(() => {});
        }, 350);
      });

      STATE.hookIds.push({ hookName, id });
    }

    STATE.installed = true;

    log("Installed global ActiveEffect key suggestion hooks.", CFG.hookNames);
  }

  function uninstallHooks() {
    for (const row of STATE.hookIds.splice(0)) {
      try {
        Hooks.off(row.hookName, row.id);
      } catch (_e) {}
    }

    STATE.installed = false;
  }

  function status() {
    return {
      ok: true,
      enabled: CFG.enabled,
      installed: STATE.installed,
      hooks: STATE.hookIds.map(row => row.hookName),
      dropdownConnected: !!STATE.dropdown?.isConnected,
      lastInstallCount: STATE.lastInstallCount,
      lastRefreshReport: STATE.lastRefreshReport
        ? {
            ok: STATE.lastRefreshReport.ok,
            cached: !!STATE.lastRefreshReport.cached,
            reason: STATE.lastRefreshReport.reason ?? null,
            actorUuid: STATE.lastRefreshReport.actorUuid ?? null,
            actorName: STATE.lastRefreshReport.actorName ?? null,
            count: STATE.lastRefreshReport.count ?? STATE.lastRefreshReport.entries?.length ?? 0,
            error: STATE.lastRefreshReport.error ?? null
          }
        : null,
      fieldCatalogueLoaded: !!getFieldCatalogueApi()
    };
  }

  function setEnabled(enabled = true) {
    CFG.enabled = !!enabled;
    if (!CFG.enabled) hideDropdown();
    return status();
  }

  const api = {
    version: "1.0.0",
    status,
    setEnabled,
    installHooks,
    uninstallHooks,
    installIntoSheet,
    refresh,
    getSuggestions,
    findAttributeKeyFields,
    hideDropdown,
    _internal: {
      CFG,
      STATE,
      getFieldCatalogueApi,
      normalizeSuggestionEntry,
      scoreLocalSuggestion,
      isActiveEffectChangeKeyInput,
      bindFields
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    installHooks();
  });
})();