// ============================================================================
// ActiveEffectManager-ui.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Clean polished UI version:
// - Target list auto-builds on open from party DB + selected token actors.
// - Selected Effects stays badge-style.
// - Apply Options is collapsed by default and sits below Selected Effects.
// - Debug tools/output are collapsed by default at the bottom.
// - Custom Active Effect Builder opens as a separate JRPG-style dialog.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:UI]";
  const DEBUG = true;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

  const STYLE_ID = "oni-active-effect-manager-ui-style";
  const FALLBACK_IMG = "icons/svg/mystery-man.svg";

  let ACTIVE_DIALOG = null;
  let BUILDER_DIALOG = null;

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

  function getDbResolverApi() {
    return globalThis.FUCompanion?.api?.getCurrentGameDb ?? null;
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

  function compactError(e) {
    return String(e?.message ?? e);
  }

  function shortSource(entry = {}) {
    return [entry.sourceType, entry.sourceName].filter(Boolean).join(" • ");
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

  // --------------------------------------------------------------------------
  // Target helpers
  // --------------------------------------------------------------------------

  function normalizeActorRef(ref) {
    const raw = safeString(ref);
    if (!raw) return "";
    if (raw.startsWith("Actor.")) return raw;
    if (raw.startsWith("Scene.")) return raw;
    if (raw.includes(".")) return raw;
    return `Actor.${raw}`;
  }

  async function resolveActorFromRef(ref) {
    const uuid = normalizeActorRef(ref);
    if (!uuid) return null;

    try {
      const doc = await fromUuid(uuid);
      if (!doc) return null;
      if (doc.documentName === "Actor") return doc;
      if (doc.actor) return doc.actor;
      if (doc.object?.actor) return doc.object.actor;
      if (doc.document?.actor) return doc.document.actor;
      return null;
    } catch (_e) {
      return null;
    }
  }

  function actorImg(actor, fallback = FALLBACK_IMG) {
    return (
      actor?.img ??
      actor?.prototypeToken?.texture?.src ??
      actor?.token?.texture?.src ??
      fallback
    );
  }

  function selectedCanvasTokens() {
    return Array.from(canvas?.tokens?.controlled ?? []).filter(t => t?.actor);
  }

  function makeTargetRow({ actor, actorUuid, actorName, img, source = "Target", selected = false, note = "" } = {}) {
    const uuid = actorUuid ?? actor?.uuid ?? "";
    const name = actorName ?? actor?.name ?? "Unknown Actor";

    return {
      id: uuid || randomId("target"),
      actorUuid: uuid,
      actorName: name,
      img: img ?? actorImg(actor),
      source,
      note,
      selected: !!selected
    };
  }

  function mergeTargetRows(rows = []) {
    const byUuid = new Map();

    for (const row of rows) {
      if (!row?.actorUuid) continue;

      const existing = byUuid.get(row.actorUuid);
      if (!existing) {
        byUuid.set(row.actorUuid, { ...row });
        continue;
      }

      existing.selected = existing.selected || row.selected;
      existing.img = existing.img || row.img;
      existing.note = existing.note || row.note;

      const sourceSet = new Set(
        String(`${existing.source || ""}|${row.source || ""}`)
          .split("|")
          .map(s => s.trim())
          .filter(Boolean)
      );
      existing.source = Array.from(sourceSet).join(" • ");
    }

    return Array.from(byUuid.values());
  }

  function syncTargetRowsSelection(state) {
    const selected = new Set(state.targetActorUuids ?? []);
    state.targetRows = (state.targetRows ?? []).map(row => ({
      ...row,
      selected: selected.has(row.actorUuid)
    }));
  }

  function setSelectedTargetsFromRows(state, rows) {
    state.targetRows = mergeTargetRows(rows);
    state.targetActorUuids = state.targetRows
      .filter(r => r.selected)
      .map(r => r.actorUuid)
      .filter(Boolean);
  }

  async function loadSelectedTokenTargets() {
    const tokens = selectedCanvasTokens();

    return tokens.map(token => {
      const textureSrc =
        token?.document?.texture?.src ??
        token?.texture?.src ??
        actorImg(token.actor);

      return makeTargetRow({
        actor: token.actor,
        img: textureSrc,
        source: "Selected Token",
        selected: true,
        note: token.name ?? ""
      });
    });
  }

  async function loadPartyMemberTargets() {
    const getCurrentGameDb = getDbResolverApi();
    if (typeof getCurrentGameDb !== "function") return [];

    let resolved = null;
    try {
      resolved = await getCurrentGameDb();
    } catch (e) {
      warn("DB Resolver failed.", e);
      return [];
    }

    const db = resolved?.source ?? resolved?.db ?? null;
    const props = db?.system?.props ?? {};
    if (!db) return [];

    const rows = [];

    for (let i = 1; i <= 12; i++) {
      const name = safeString(props[`member_name_${i}`]);
      const id = safeString(props[`member_id_${i}`]);
      const sprite = safeString(props[`member_sprite_${i}`]);

      if (!id && !name) continue;

      const actor = await resolveActorFromRef(id);
      if (!actor && !id) continue;

      rows.push(makeTargetRow({
        actor,
        actorUuid: actor?.uuid ?? normalizeActorRef(id),
        actorName: actor?.name ?? name,
        img: sprite || actorImg(actor),
        source: "Party Member",
        selected: false,
        note: name
      }));
    }

    return rows;
  }

  async function loadAvailableTargets() {
    const selectedRows = await loadSelectedTokenTargets();
    const partyRows = await loadPartyMemberTargets();
    return mergeTargetRows([...selectedRows, ...partyRows]);
  }

  async function reloadTargets(state) {
    const rows = await loadAvailableTargets();
    setSelectedTargetsFromRows(state, rows);
    state.targetSourceLabel = "Target list includes current party members and selected token actors.";
    return rows;
  }

  // --------------------------------------------------------------------------
  // Styling
  // --------------------------------------------------------------------------

  function injectStyle() {
    const old = document.getElementById(STYLE_ID);
    if (old) old.remove();

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
        grid-template-columns: 0.9fr 1.45fr;
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

      .oni-aem .aem-target-summary {
        margin: 6px 0;
        padding: 6px 8px;
        border-radius: 8px;
        background: rgba(0,0,0,.06);
        font-size: 11px;
        line-height: 1.25;
      }

      .oni-aem .aem-target-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
        gap: 7px;
        max-height: 235px;
        overflow: auto;
        padding: 4px;
        border: 1px solid rgba(60,45,25,.18);
        border-radius: 8px;
        background: rgba(255,255,255,.38);
      }

      .oni-aem .aem-target-card {
        position: relative;
        min-height: 118px;
        padding: 6px;
        margin: 0;
        border-radius: 10px;
        border: 1px solid rgba(60,45,25,.22);
        background: rgba(255,255,255,.62);
        cursor: pointer;
        display: grid;
        grid-template-rows: 64px auto;
        gap: 5px;
        transition: transform 120ms ease, background 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
      }

      .oni-aem .aem-target-card:hover {
        transform: translateY(-1px);
        background: rgba(255,255,255,.82);
        border-color: rgba(70,50,25,.45);
      }

      .oni-aem .aem-target-card.selected {
        background: rgba(239, 225, 181, .88);
        border-color: rgba(150,105,30,.72);
        box-shadow: 0 0 0 2px rgba(180,125,35,.20) inset;
      }

      .oni-aem .aem-target-card input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
      }

      .oni-aem .aem-target-img-wrap {
        width: 100%;
        height: 64px;
        border-radius: 8px;
        overflow: hidden;
        background: rgba(0,0,0,.10);
        display: grid;
        place-items: center;
      }

      .oni-aem .aem-target-img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: top center;
        border: 0;
      }

      .oni-aem .aem-target-name {
        font-weight: 800;
        font-size: 12px;
        text-align: center;
        line-height: 1.12;
        min-height: 27px;
        display: grid;
        place-items: center;
      }

      .oni-aem .aem-target-source {
        font-size: 10px;
        opacity: .65;
        text-align: center;
        line-height: 1.1;
      }

      .oni-aem .aem-effect-list {
        max-height: 445px;
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

      .oni-aem .aem-selected-list {
        min-height: 54px;
        max-height: 140px;
        overflow: auto;
        padding: 4px;
        border: 1px solid rgba(60,45,25,.18);
        border-radius: 7px;
        background: rgba(255,255,255,.45);
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

      .oni-aem .aem-empty {
        padding: 10px;
        opacity: .65;
        text-align: center;
      }

      .oni-aem .aem-builder-launch {
        margin-top: 8px;
      }

      .oni-aem .aem-apply-compact {
        padding: 0;
        overflow: hidden;
      }

      .oni-aem .aem-apply-details > summary {
        cursor: pointer;
        list-style: none;
        padding: 8px;
        font-weight: 850;
        border-radius: 8px;
        user-select: none;
      }

      .oni-aem .aem-apply-details > summary::-webkit-details-marker {
        display: none;
      }

      .oni-aem .aem-apply-details > summary::before {
        content: "▶";
        display: inline-block;
        margin-right: 6px;
        font-size: 10px;
        transform: translateY(-1px);
      }

      .oni-aem .aem-apply-details[open] > summary::before {
        content: "▼";
      }

      .oni-aem .aem-apply-details > summary:hover {
        background: rgba(0,0,0,.055);
      }

      .oni-aem .aem-apply-details-body {
        padding: 0 8px 8px 8px;
      }

      .oni-aem .aem-apply-grid {
        display: grid;
        grid-template-columns: 1.4fr 0.9fr;
        gap: 8px;
        align-items: end;
      }

      .oni-aem .aem-duration-mini {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 5px;
      }

      .oni-aem .aem-toggle-row {
        display: flex;
        gap: 6px;
        margin-top: 7px;
      }

      .oni-aem .aem-toggle-pill {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        padding: 5px 6px;
        border-radius: 8px;
        border: 1px solid rgba(60,45,25,.20);
        background: rgba(255,255,255,.45);
        font-size: 11px;
        font-weight: 700;
        cursor: pointer;
      }

      .oni-aem .aem-toggle-pill input {
        width: auto;
        margin: 0;
      }

      .oni-aem .aem-inline-label {
        font-size: 11px;
        opacity: .82;
        margin-bottom: 2px;
      }

      .oni-aem .aem-apply-details-note {
        margin-top: 5px;
        font-size: 11px;
        opacity: .68;
        line-height: 1.25;
      }

      .oni-aem details.aem-debug {
        margin-top: 8px;
      }

      .oni-aem details.aem-debug > summary {
        cursor: pointer;
        font-weight: 700;
        padding: 4px 2px;
        user-select: none;
      }

      .oni-aem .aem-debug-inner {
        margin-top: 8px;
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

      /* JRPG-style custom builder dialog */
      .oni-aem .aem-builder-shell {
        display: grid;
        gap: 8px;
      }

      .oni-aem .aem-builder-hero {
        position: relative;
        overflow: hidden;
        border-radius: 12px;
        border: 1px solid rgba(80, 58, 30, .34);
        background:
          linear-gradient(135deg, rgba(48, 38, 28, .92), rgba(18, 16, 15, .94)),
          radial-gradient(circle at top left, rgba(255, 226, 142, .25), transparent 40%);
        color: #f7efe2;
        padding: 12px;
        box-shadow: 0 3px 10px rgba(0,0,0,.22);
      }

      .oni-aem .aem-builder-hero::after {
        content: "";
        position: absolute;
        inset: auto -30px -50px auto;
        width: 170px;
        height: 170px;
        border-radius: 999px;
        background: rgba(255,255,255,.055);
        pointer-events: none;
      }

      .oni-aem .aem-builder-hero-main {
        position: relative;
        display: grid;
        grid-template-columns: 58px 1fr;
        gap: 10px;
        align-items: center;
        z-index: 1;
      }

      .oni-aem .aem-builder-icon-preview {
        width: 58px;
        height: 58px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,.22);
        background: rgba(255,255,255,.10);
        object-fit: cover;
        box-shadow: 0 2px 6px rgba(0,0,0,.28);
      }

      .oni-aem .aem-builder-title {
        font-size: 18px;
        font-weight: 900;
        letter-spacing: .02em;
        line-height: 1.05;
      }

      .oni-aem .aem-builder-subtitle {
        margin-top: 3px;
        color: rgba(247,239,226,.74);
        font-size: 11px;
        line-height: 1.25;
      }

      .oni-aem .aem-builder-type-row {
        position: relative;
        z-index: 1;
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        margin-top: 10px;
      }

      .oni-aem .aem-builder-chip {
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,.16);
        background: rgba(255,255,255,.09);
        color: rgba(247,239,226,.86);
        padding: 5px 7px;
        text-align: center;
        font-size: 11px;
        font-weight: 800;
      }

      .oni-aem .aem-builder-chip.buff {
        border-color: rgba(108, 232, 135, .35);
        background: rgba(108, 232, 135, .13);
      }

      .oni-aem .aem-builder-chip.debuff {
        border-color: rgba(255, 116, 136, .35);
        background: rgba(255, 116, 136, .13);
      }

      .oni-aem .aem-builder-chip.other {
        border-color: rgba(255, 211, 106, .35);
        background: rgba(255, 211, 106, .13);
      }

      .oni-aem .aem-builder-section {
        border-radius: 11px;
        border: 1px solid rgba(60,45,25,.20);
        background: rgba(255,255,255,.62);
        padding: 9px;
      }

      .oni-aem .aem-builder-section-title {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 7px;
        padding-bottom: 5px;
        border-bottom: 1px solid rgba(60,45,25,.18);
        font-weight: 900;
        font-size: 13px;
      }

      .oni-aem .aem-builder-section-title .mark {
        width: 22px;
        height: 22px;
        display: inline-grid;
        place-items: center;
        border-radius: 7px;
        background: rgba(40,34,26,.86);
        color: white;
        font-size: 12px;
      }

      .oni-aem .aem-builder-form-grid {
        display: grid;
        grid-template-columns: 1.1fr .75fr;
        gap: 8px;
      }

      .oni-aem .aem-builder-dialog label {
        font-size: 11px;
        opacity: .88;
      }

      .oni-aem .aem-builder-dialog input,
      .oni-aem .aem-builder-dialog select,
      .oni-aem .aem-builder-dialog textarea {
        border-radius: 6px;
      }

      .oni-aem .aem-builder-dialog .aem-mod-row {
        display: grid;
        grid-template-columns: 1.25fr .75fr .65fr .5fr 28px;
        gap: 5px;
        align-items: end;
        margin-bottom: 5px;
        padding: 6px;
        border-radius: 8px;
        border: 1px solid rgba(60,45,25,.16);
        background: rgba(255,255,255,.46);
      }

      .oni-aem .aem-builder-command-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 7px;
        margin-top: 8px;
      }

      .oni-aem .aem-builder-command-row button {
        min-height: 32px;
        font-weight: 850;
      }

      .oni-aem .aem-builder-primary {
        background: rgba(48, 42, 34, .90);
        color: white;
        border-color: rgba(255,255,255,.22);
      }

      .oni-aem .aem-builder-primary:hover {
        background: rgba(68, 58, 44, .96);
      }

      .oni-aem .aem-builder-secondary {
        background: rgba(255,255,255,.55);
      }

      .oni-aem .aem-builder-preview-wrap {
        border-radius: 10px;
        border: 1px solid rgba(60,45,25,.18);
        background: rgba(0,0,0,.06);
        padding: 7px;
      }

      .oni-aem .aem-builder-preview {
        min-height: 92px;
        max-height: 180px;
        font-family: monospace;
        font-size: 11px;
        color: #111;
        background: rgba(255,255,255,.86);
      }

      .oni-aem .aem-builder-hint {
        margin-top: 5px;
        font-size: 11px;
        opacity: .72;
        line-height: 1.25;
      }
    `;

    document.head.appendChild(style);
  }

  // --------------------------------------------------------------------------
  // Rendering helpers
  // --------------------------------------------------------------------------

  function categoryButtonHtml(category, label, state) {
    const active = state.categoryFilter === category ? "active" : "";
    return `<button type="button" class="${active}" data-aem-action="set-category" data-category="${escapeHtml(category)}">${escapeHtml(label)}</button>`;
  }

  function targetCardsHtml(state) {
    const rows = state.targetRows ?? [];

    if (!rows.length) {
      return `<div class="aem-empty">No available targets found.</div>`;
    }

    return rows.map(row => {
      const checked = row.selected ? "checked" : "";
      const selected = row.selected ? "selected" : "";

      return `
        <label class="aem-target-card ${selected}" title="${escapeHtml(row.actorName)}">
          <input
            type="checkbox"
            name="targetActorUuids"
            value="${escapeHtml(row.actorUuid)}"
            ${checked}
          >
          <div class="aem-target-img-wrap">
            <img class="aem-target-img" src="${escapeHtml(row.img || FALLBACK_IMG)}">
          </div>
          <div>
            <div class="aem-target-name">${escapeHtml(row.actorName)}</div>
            <div class="aem-target-source">${escapeHtml(row.source || "Target")}</div>
          </div>
        </label>
      `;
    }).join("");
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

  function fieldDatalistHtml(entries = []) {
    return `
      <datalist id="aem-field-key-list-builder">
        ${entries.map(entry => {
          const label = `${entry.label || entry.key} — ${entry.category || "Other"} — ${entry.valueKind || "unknown"}`;
          return `<option value="${escapeHtml(entry.activeEffectKey || entry.key)}" label="${escapeHtml(label)}"></option>`;
        }).join("")}
      </datalist>
    `;
  }

  function modifierRowsHtml(rows = []) {
    const safeRows = rows.length
      ? rows
      : [{
          id: randomId("mod"),
          key: "",
          mode: modeValue("ADD"),
          value: "1",
          priority: 20
        }];

    return safeRows.map(row => `
      <div class="aem-mod-row" data-mod-row-id="${escapeHtml(row.id)}">
        <div>
          <label>Key</label>
          <input
            type="text"
            name="customChangeKey"
            list="aem-field-key-list-builder"
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
          data-aem-builder-action="remove-modifier-row"
          data-row-id="${escapeHtml(row.id)}"
        >×</button>
      </div>
    `).join("");
  }

  function renderApplyOptionsDetails(state) {
    return `
      <div class="aem-card aem-apply-compact">
        <details class="aem-apply-details">
          <summary>Apply Options</summary>

          <div class="aem-apply-details-body">
            <div class="aem-apply-grid">
              <div>
                <div class="aem-inline-label">Duplicate</div>
                <select name="duplicateMode">
                  <option value="skip" ${state.duplicateMode === "skip" ? "selected" : ""}>Skip existing</option>
                  <option value="replace" ${state.duplicateMode === "replace" ? "selected" : ""}>Replace existing</option>
                  <option value="stack" ${state.duplicateMode === "stack" ? "selected" : ""}>Stack duplicate</option>
                  <option value="remove" ${state.duplicateMode === "remove" ? "selected" : ""}>Remove instead</option>
                  <option value="ask" ${state.duplicateMode === "ask" ? "selected" : ""}>Ask each time</option>
                </select>
              </div>

              <div>
                <div class="aem-inline-label">Duration</div>
                <div class="aem-duration-mini">
                  <input
                    type="number"
                    name="durationRounds"
                    value="${escapeHtml(state.durationRounds)}"
                    title="Rounds"
                    placeholder="Rounds"
                  >
                  <input
                    type="number"
                    name="durationTurns"
                    value="${escapeHtml(state.durationTurns)}"
                    title="Turns"
                    placeholder="Turns"
                  >
                </div>
              </div>
            </div>

            <div class="aem-toggle-row">
              <label class="aem-toggle-pill">
                <input type="checkbox" name="overrideDuration" ${state.overrideDuration ? "checked" : ""}>
                Override Duration
              </label>

              <label class="aem-toggle-pill">
                <input type="checkbox" name="silent" ${state.silent ? "checked" : ""}>
                Silent
              </label>
            </div>

            <div class="aem-apply-details-note">
              These are advanced options. Default behavior is usually fine for normal use.
            </div>
          </div>
        </details>
      </div>
    `;
  }

  function renderMainContent(state) {
    const selectedCount = (state.targetActorUuids ?? []).length;

    return `
      <div class="oni-aem">
        <div class="aem-grid-main">
          <div>
            <div class="aem-card">
              <h3>Targets</h3>

              <div class="aem-target-summary">
                <b>${selectedCount}</b> target${selectedCount === 1 ? "" : "s"} selected.
                <br>${escapeHtml(state.targetSourceLabel || "Target list loaded automatically.")}
              </div>

              <div class="aem-target-grid" data-aem-target-grid>
                ${targetCardsHtml(state)}
              </div>

              <div class="aem-mini">
                Select one or more portraits. Selected scene token actors are included automatically when the window opens.
                If you change token selection later, close and reopen this UI to refresh the list.
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

            ${renderApplyOptionsDetails(state)}
          </div>

          <div>
            <div class="aem-card">
              <h3>Effect Registry</h3>

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

              <div class="aem-builder-launch">
                <button type="button" data-aem-action="open-custom-builder">Open Custom Effect Builder</button>
              </div>

              <div class="aem-mini" style="margin-top:6px;">
                Add preset effects from the registry, or open the builder to create a custom one.
              </div>
            </div>
          </div>
        </div>

        <div class="aem-card">
          <details class="aem-debug">
            <summary>Debug</summary>
            <div class="aem-debug-inner">
              <div class="aem-actions-3">
                <button type="button" data-aem-action="refresh-registry">Refresh</button>
                <button type="button" data-aem-action="refresh-registry-compendiums">Refresh + Compendiums</button>
                <button type="button" data-aem-action="debug-registry">Debug</button>
              </div>

              <label style="margin-top:8px;">Output</label>
              <textarea class="aem-output" readonly data-aem-output>${escapeHtml(state.outputText || "")}</textarea>
            </div>
          </details>
        </div>
      </div>
    `;
  }

  function updateOutput(root, state, data) {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    state.outputText = text;

    const out = root?.querySelector?.("[data-aem-output]");
    if (out) out.value = text;
  }

  function readCommonStateFromDom(root, state) {
    state.targetActorUuids = Array.from(root.querySelectorAll('[name="targetActorUuids"]:checked'))
      .map(el => el.value)
      .filter(Boolean);

    syncTargetRowsSelection(state);

    state.duplicateMode = root.querySelector('[name="duplicateMode"]')?.value ?? state.duplicateMode;
    state.overrideDuration = !!root.querySelector('[name="overrideDuration"]')?.checked;
    state.silent = !!root.querySelector('[name="silent"]')?.checked;

    state.durationRounds = root.querySelector('[name="durationRounds"]')?.value ?? state.durationRounds;
    state.durationTurns = root.querySelector('[name="durationTurns"]')?.value ?? state.durationTurns;

    state.search = root.querySelector('[name="effectSearch"]')?.value ?? state.search;
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
      return { ok: false, reason: "registry_api_not_found" };
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

    return { ok: true, count: state.registryEntries.length };
  }

  async function refreshFields(state) {
    const catalogue = getFieldCatalogueApi();

    if (!catalogue) {
      state.fieldEntries = [];
      return { ok: false, reason: "field_catalogue_api_not_found" };
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

    return { ok: true, count: state.fieldEntries.length };
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

  function buildCustomEffectData(builderState, parentState, { includeChanges = true } = {}) {
    const name = safeString(builderState.customName, "Custom Active Effect");
    const img = safeString(builderState.customIcon, "icons/svg/aura.svg");
    const category = safeString(builderState.customCategory, "Other");

    const changes = includeChanges
      ? builderState.customRows
          .map(row => ({
            key: safeString(row.key),
            mode: Number(row.mode ?? modeValue("ADD")),
            value: String(row.value ?? ""),
            priority: Number(row.priority ?? 20)
          }))
          .filter(row => row.key)
      : [];

    const duration = getGlobalDurationFromState(parentState) ?? {
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
      description: builderState.customDescription ?? "",
      changes,
      statuses: parseStatuses(builderState.customStatuses),
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

  function readBuilderStateFromDom(root, builderState) {
    builderState.customName = root.querySelector('[name="customName"]')?.value ?? builderState.customName;
    builderState.customCategory = root.querySelector('[name="customCategory"]')?.value ?? builderState.customCategory;
    builderState.customIcon = root.querySelector('[name="customIcon"]')?.value ?? builderState.customIcon;
    builderState.customStatuses = root.querySelector('[name="customStatuses"]')?.value ?? builderState.customStatuses;
    builderState.customDescription = root.querySelector('[name="customDescription"]')?.value ?? builderState.customDescription;

    const rows = Array.from(root.querySelectorAll("[data-mod-row-id]"));
    builderState.customRows = rows.map(row => {
      const id = row.dataset.modRowId || randomId("mod");
      const key = row.querySelector('[data-row-field="key"]')?.value ?? "";
      const mode = Number(row.querySelector('[data-row-field="mode"]')?.value ?? modeValue("ADD"));
      const value = row.querySelector('[data-row-field="value"]')?.value ?? "";
      const priority = Number(row.querySelector('[data-row-field="priority"]')?.value ?? 20);

      return { id, key, mode, value, priority };
    });

    if (!builderState.customRows.length) {
      builderState.customRows = [{
        id: randomId("mod"),
        key: "",
        mode: modeValue("ADD"),
        value: "1",
        priority: 20
      }];
    }
  }

  function renderBuilderContent(builderState) {
    const previewIcon = safeString(builderState.customIcon, "icons/svg/aura.svg");
    const name = safeString(builderState.customName, "Custom Active Effect");
    const category = safeString(builderState.customCategory, "Other");
    const catClass = category.toLowerCase() === "buff"
      ? "buff"
      : category.toLowerCase() === "debuff"
        ? "debuff"
        : "other";

    return `
      <div class="oni-aem aem-builder-dialog">
        ${fieldDatalistHtml(builderState.fieldEntries ?? [])}

        <div class="aem-builder-shell">
          <div class="aem-builder-hero">
            <div class="aem-builder-hero-main">
              <img class="aem-builder-icon-preview" src="${escapeHtml(previewIcon)}">
              <div>
                <div class="aem-builder-title">${escapeHtml(name)}</div>
                <div class="aem-builder-subtitle">
                  Build a real Active Effect document. Add it to the main queue when ready.
                </div>
              </div>
            </div>

            <div class="aem-builder-type-row">
              <div class="aem-builder-chip ${escapeHtml(catClass)}">${escapeHtml(category)}</div>
              <div class="aem-builder-chip">Marker or Modifier</div>
              <div class="aem-builder-chip">${builderState.customRows?.length ?? 0} Modifier Row(s)</div>
            </div>
          </div>

          <div class="aem-builder-section">
            <div class="aem-builder-section-title">
              <span class="mark">1</span>
              Effect Identity
            </div>

            <div class="aem-builder-form-grid">
              <div>
                <label>Name</label>
                <input type="text" name="customName" value="${escapeHtml(builderState.customName)}" placeholder="Defense Boost">
              </div>

              <div>
                <label>Category</label>
                <select name="customCategory">
                  <option value="Buff" ${builderState.customCategory === "Buff" ? "selected" : ""}>Buff</option>
                  <option value="Debuff" ${builderState.customCategory === "Debuff" ? "selected" : ""}>Debuff</option>
                  <option value="Other" ${builderState.customCategory === "Other" ? "selected" : ""}>Other</option>
                </select>
              </div>
            </div>

            <label>Icon</label>
            <input type="text" name="customIcon" value="${escapeHtml(builderState.customIcon)}" placeholder="icons/svg/aura.svg">

            <label>Status IDs / Marker Tags</label>
            <input type="text" name="customStatuses" value="${escapeHtml(builderState.customStatuses)}" placeholder="Optional, comma-separated. Example: bleed, mark">

            <label>Description</label>
            <textarea name="customDescription" rows="2" placeholder="Optional description">${escapeHtml(builderState.customDescription)}</textarea>
          </div>

          <div class="aem-builder-section">
            <div class="aem-builder-section-title">
              <span class="mark">2</span>
              Modifier Rows
            </div>

            <div data-aem-builder-modifier-rows>
              ${modifierRowsHtml(builderState.customRows)}
            </div>

            <div class="aem-actions-3" style="margin-top:7px;">
              <button type="button" data-aem-builder-action="add-modifier-row">+ Add Row</button>
              <button type="button" data-aem-builder-action="refresh-fields">Refresh Fields</button>
              <button type="button" data-aem-builder-action="preview-custom">Preview</button>
            </div>

            <div class="aem-builder-hint">
              Modifier rows are optional if you are creating a marker effect. For stat changes, use the field suggestions.
            </div>
          </div>

          <div class="aem-builder-section">
            <div class="aem-builder-section-title">
              <span class="mark">3</span>
              Add to Queue
            </div>

            <div class="aem-builder-command-row">
              <button
                type="button"
                class="aem-builder-secondary"
                data-aem-builder-action="add-custom-marker"
              >
                Add Marker Effect
              </button>

              <button
                type="button"
                class="aem-builder-primary"
                data-aem-builder-action="add-custom-modifier"
              >
                Add Modifier Effect
              </button>
            </div>

            <div class="aem-warning" style="margin-top:7px;">
              Marker effects can have no changes. Modifier effects use the rows above.
              Legacy keys like <code>isSlow</code> are intentionally not suggested.
            </div>
          </div>

          <div class="aem-builder-section">
            <details>
              <summary><b>Preview / Debug</b></summary>
              <div class="aem-builder-preview-wrap" style="margin-top:7px;">
                <textarea class="aem-builder-preview" readonly data-aem-builder-preview>${escapeHtml(builderState.previewText || "")}</textarea>
              </div>
            </details>
          </div>
        </div>
      </div>
    `;
  }

  function rerenderBuilder(root, builderState) {
    const holder = root.querySelector("[data-aem-builder-root-holder]");
    if (!holder) return;
    holder.innerHTML = renderBuilderContent(builderState);
  }

  function setBuilderPreview(root, builderState, data) {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    builderState.previewText = text;

    const el = root.querySelector("[data-aem-builder-preview]");
    if (el) el.value = text;
  }

  async function openCustomBuilderDialog(parentState, parentRoot) {
    if (BUILDER_DIALOG) {
      try {
        BUILDER_DIALOG.bringToTop?.();
        return BUILDER_DIALOG;
      } catch (_e) {}
    }

    const builderState = {
      customName: parentState.customName ?? "Custom Active Effect",
      customCategory: parentState.customCategory ?? "Buff",
      customIcon: parentState.customIcon ?? "icons/svg/aura.svg",
      customStatuses: parentState.customStatuses ?? "",
      customDescription: parentState.customDescription ?? "",
      customRows: clone(parentState.customRows, []) ?? [],
      fieldEntries: clone(parentState.fieldEntries, []) ?? [],
      previewText: ""
    };

    if (!builderState.customRows.length) {
      builderState.customRows = [{
        id: randomId("mod"),
        key: "",
        mode: modeValue("ADD"),
        value: "1",
        priority: 20
      }];
    }

    const dialog = new Dialog({
      title: "Custom Active Effect Builder",
      content: `
        <div data-aem-builder-root-holder>
          ${renderBuilderContent(builderState)}
        </div>
      `,
      buttons: {
        close: {
          label: "Close"
        }
      },
      render: (html) => {
        const root = normalizeHtmlRoot(html);
        if (!root) return;

        const holder = root.querySelector("[data-aem-builder-root-holder]");
        if (!holder) return;

        holder.addEventListener("input", () => {
          readBuilderStateFromDom(root, builderState);
        });

        holder.addEventListener("change", () => {
          readBuilderStateFromDom(root, builderState);
        });

        holder.addEventListener("click", async (ev) => {
          const btn = ev.target.closest?.("[data-aem-builder-action]");
          if (!btn) return;

          ev.preventDefault();
          ev.stopPropagation();

          const action = btn.dataset.aemBuilderAction;

          try {
            btn.disabled = true;
            readBuilderStateFromDom(root, builderState);

            if (action === "add-modifier-row") {
              builderState.customRows.push({
                id: randomId("mod"),
                key: "",
                mode: modeValue("ADD"),
                value: "1",
                priority: 20
              });
              rerenderBuilder(root, builderState);
              return;
            }

            if (action === "remove-modifier-row") {
              const id = btn.dataset.rowId;
              builderState.customRows = builderState.customRows.filter(r => r.id !== id);

              if (!builderState.customRows.length) {
                builderState.customRows.push({
                  id: randomId("mod"),
                  key: "",
                  mode: modeValue("ADD"),
                  value: "1",
                  priority: 20
                });
              }

              rerenderBuilder(root, builderState);
              return;
            }

            if (action === "refresh-fields") {
              parentState.fieldEntries = parentState.fieldEntries || [];
              await refreshFields(parentState);
              builderState.fieldEntries = clone(parentState.fieldEntries, []) ?? [];
              setBuilderPreview(root, builderState, {
                ok: true,
                fieldCount: builderState.fieldEntries.length
              });
              rerenderBuilder(root, builderState);
              return;
            }

            if (action === "preview-custom") {
              const effectData = buildCustomEffectData(builderState, parentState, { includeChanges: true });
              setBuilderPreview(root, builderState, {
                ok: true,
                preview: effectData
              });
              return;
            }

            if (action === "add-custom-marker") {
              const effectData = buildCustomEffectData(builderState, parentState, { includeChanges: false });

              parentState.customName = builderState.customName;
              parentState.customCategory = builderState.customCategory;
              parentState.customIcon = builderState.customIcon;
              parentState.customStatuses = builderState.customStatuses;
              parentState.customDescription = builderState.customDescription;
              parentState.customRows = clone(builderState.customRows, []) ?? [];

              addSelectedCustomEffect(parentState, effectData, builderState.customCategory);
              rerender(parentRoot, parentState);
              dialog.close();
              return;
            }

            if (action === "add-custom-modifier") {
              const effectData = buildCustomEffectData(builderState, parentState, { includeChanges: true });

              if (!effectData.changes.length) {
                setBuilderPreview(root, builderState, {
                  ok: false,
                  reason: "no_modifier_rows",
                  hint: "Add at least one modifier row, or use Add Marker Effect instead."
                });
                return;
              }

              parentState.customName = builderState.customName;
              parentState.customCategory = builderState.customCategory;
              parentState.customIcon = builderState.customIcon;
              parentState.customStatuses = builderState.customStatuses;
              parentState.customDescription = builderState.customDescription;
              parentState.customRows = clone(builderState.customRows, []) ?? [];

              addSelectedCustomEffect(parentState, effectData, builderState.customCategory);
              rerender(parentRoot, parentState);
              dialog.close();
              return;
            }
          } catch (e) {
            setBuilderPreview(root, builderState, {
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
        BUILDER_DIALOG = null;
      }
    }, {
      width: 720,
      height: "auto",
      resizable: true
    });

    BUILDER_DIALOG = dialog;
    dialog.render(true);
    return dialog;
  }

  // --------------------------------------------------------------------------
  // Apply action
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
        hint: "Choose at least one target portrait first."
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
      return { effectData: clone(sel.effectData, {}) };
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

    const state = {
      targetRows: [],
      targetActorUuids: [],
      targetSourceLabel: "",

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
      customRows: [{
        id: randomId("mod"),
        key: "",
        mode: modeValue("ADD"),
        value: "1",
        priority: 20
      }],

      outputText: ""
    };

    try {
      await reloadTargets(state);
    } catch (e) {
      warn("Initial target load failed.", e);
      state.targetSourceLabel = `Target load failed: ${compactError(e)}`;
    }

    try {
      await refreshRegistry(state, { includeCompendiums: false });
    } catch (e) {
      warn("Initial registry refresh failed.", e);
      state.outputText = JSON.stringify({ registryRefreshFailed: compactError(e) }, null, 2);
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
              const report = registry?.getLastReport?.() ?? {
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

            if (action === "open-custom-builder") {
              await openCustomBuilderDialog(state, root);
              return;
            }

            if (action === "apply-selected") {
              await applySelected(root, state);
              return;
            }
          } catch (e) {
            err("UI action failed.", { action, error: e });

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
    version: "0.4.0",
    open,
    reopen: () => {
      try {
        ACTIVE_DIALOG?.close?.();
      } catch (_e) {}
      ACTIVE_DIALOG = null;
      return open();
    },
    getActiveDialog: () => ACTIVE_DIALOG,
    reloadTargets
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