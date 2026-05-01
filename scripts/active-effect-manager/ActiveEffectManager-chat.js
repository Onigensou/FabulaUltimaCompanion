// ============================================================================
// ActiveEffectManager-chat.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Render compact grouped chat cards for ActiveEffectManager API results.
// - One manager operation = one chat card.
// - Each applied/removed/skipped/failed result = one row inside that card.
// - Hides default Foundry speaker/header wrapper, like Treasure/Obtain cards.
// - Buff card outline = blue.
// - Debuff card outline = red.
// - Mixed/Other card outline = neutral/gold.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:Chat]";
  const DEBUG = false;

  const STYLE_ID = "oni-active-effect-manager-chat-style";
  const CHAT_CSS_CLASS = "oni-aem-chat-msg";

  const MAX_VISIBLE_ROWS_BEFORE_SCROLL = 12;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // --------------------------------------------------------------------------
  // API root
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager =
      globalThis.FUCompanion.api.activeEffectManager || {};
    return globalThis.FUCompanion.api.activeEffectManager;
  }

  function exposeApi(api) {
    const root = ensureApiRoot();
    root.chat = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.chat = api;
      }
    } catch (e) {
      warn("Could not expose chat API on module object.", e);
    }
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

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function safeString(value, fallback = "") {
    const s = String(value ?? "").trim();
    return s.length ? s : fallback;
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (value instanceof Set) return Array.from(value);
    return [value];
  }

  function titleCase(value) {
    return safeString(value, "unknown")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, m => m.toUpperCase());
  }

  function normalizeCategory(value) {
    const s = safeString(value, "Other").toLowerCase();

    if (s === "buff") return "Buff";
    if (s === "debuff") return "Debuff";
    return "Other";
  }

  function effectNameFromRow(row = {}) {
    return safeString(
      row?.effect?.name ??
      row?.created?.name ??
      row?.removed?.[0]?.name ??
      row?.before?.name ??
      row?.after?.name ??
      row?.effectName ??
      row?.name ??
      "Active Effect"
    );
  }

  function effectImgFromRow(row = {}) {
    return safeString(
      row?.effect?.img ??
      row?.effect?.icon ??
      row?.created?.img ??
      row?.created?.icon ??
      row?.removed?.[0]?.img ??
      row?.removed?.[0]?.icon ??
      row?.before?.img ??
      row?.after?.img ??
      row?.img ??
      row?.icon ??
      "icons/svg/aura.svg"
    );
  }

  function actorNameFromRow(row = {}) {
    return safeString(
      row?.actor?.name ??
      row?.actorName ??
      row?.targetActorName ??
      "Unknown Actor"
    );
  }

  function actorUuidFromRow(row = {}) {
    return safeString(
      row?.actor?.uuid ??
      row?.actorUuid ??
      row?.targetActorUuid ??
      ""
    );
  }

  function categoryFromFlags(effectLike = {}) {
    const flags = effectLike?.flags?.[MODULE_ID] ?? {};

    return safeString(
      flags?.category ??
      flags?.activeEffectManager?.sourceCategory ??
      flags?.activeEffectManager?.category ??
      ""
    );
  }

  function categoryFromRow(row = {}) {
    const direct = safeString(
      row?.effect?.identity?.category ??
      row?.effect?.category ??
      row?.category ??
      ""
    );

    if (direct) return normalizeCategory(direct);

    const fromCreated = categoryFromFlags(row?.created);
    if (fromCreated) return normalizeCategory(fromCreated);

    const fromBefore = categoryFromFlags(row?.before);
    if (fromBefore) return normalizeCategory(fromBefore);

    const fromAfter = categoryFromFlags(row?.after);
    if (fromAfter) return normalizeCategory(fromAfter);

    const fromRemoved = categoryFromFlags(row?.removed?.[0]);
    if (fromRemoved) return normalizeCategory(fromRemoved);

    return "Other";
  }

  function statusFromRow(row = {}) {
    return safeString(row.status, row.ok === false ? "failed" : "applied").toLowerCase();
  }

  function statusLabel(row = {}) {
    const status = statusFromRow(row);

    if (status === "applied") return "Applied";
    if (status === "replaced") return "Replaced";
    if (status === "stacked") return "Stacked";
    if (status === "removed") return "Removed";
    if (status === "skipped") return "Skipped";
    if (status === "failed") return "Failed";

    return titleCase(status);
  }

  function reasonText(row = {}) {
    const reason = safeString(row.reason);
    const error = safeString(row.error);

    if (error) return error;
    if (!reason) return "";

    const map = {
      duplicate_exists: "Already exists",
      duplicate_removed: "Removed duplicate",
      no_matching_effects: "No match",
      no_permission: "No permission",
      toggle_on: "Toggled on",
      toggle_off: "Toggled off"
    };

    return map[reason] ?? titleCase(reason);
  }

  function getRows(report = {}) {
    const rows = asArray(report.results);

    // Normal apply/remove/toggle flow.
    if (rows.length) return rows;

    // Fallback for modify-style reports.
    if (report.action === "modify") {
      return [{
        ok: report.ok,
        status: report.ok ? "applied" : "failed",
        actor: report.actor,
        before: report.before,
        after: report.after,
        reason: report.reason,
        error: report.error
      }];
    }

    return [];
  }

  function getActionLabel(report = {}) {
    const action = safeString(report.action, "apply").toLowerCase();

    if (action === "remove") return "Active Effects Removed";
    if (action === "toggle") return "Active Effects Updated";
    if (action === "modify") return "Active Effect Modified";

    return "Active Effects Applied";
  }

  function classifyCard(report = {}) {
    const rows = getRows(report)
      .filter(row => row?.ok !== false)
      .filter(row => ["applied", "replaced", "stacked", "removed"].includes(statusFromRow(row)));

    const categories = rows.map(categoryFromRow).filter(Boolean);

    if (!categories.length) return "other";

    const allBuff = categories.every(c => c === "Buff");
    const allDebuff = categories.every(c => c === "Debuff");

    if (allBuff) return "buff";
    if (allDebuff) return "debuff";

    if (categories.some(c => c === "Buff") && categories.some(c => c === "Debuff")) {
      return "mixed";
    }

    return "other";
  }

  function countRows(report = {}) {
    const rows = getRows(report);

    const counts = {
      total: rows.length,
      applied: 0,
      replaced: 0,
      stacked: 0,
      removed: 0,
      skipped: 0,
      failed: 0
    };

    for (const row of rows) {
      const status = statusFromRow(row);
      if (status in counts) counts[status]++;
    }

    return counts;
  }

  function compactSummary(report = {}) {
    const counts = countRows(report);
    const parts = [];

    if (counts.applied) parts.push(`${counts.applied} applied`);
    if (counts.replaced) parts.push(`${counts.replaced} replaced`);
    if (counts.stacked) parts.push(`${counts.stacked} stacked`);
    if (counts.removed) parts.push(`${counts.removed} removed`);
    if (counts.skipped) parts.push(`${counts.skipped} skipped`);
    if (counts.failed) parts.push(`${counts.failed} failed`);

    if (!parts.length) parts.push(`${counts.total} result${counts.total === 1 ? "" : "s"}`);

    return parts.join(" • ");
  }

  function statusClass(row = {}) {
    const status = statusFromRow(row);

    if (["applied", "replaced", "stacked"].includes(status)) return "good";
    if (status === "removed") return "removed";
    if (status === "skipped") return "skip";
    if (status === "failed") return "bad";

    return "neutral";
  }

  function categoryClass(row = {}) {
    const category = categoryFromRow(row);

    if (category === "Buff") return "buff";
    if (category === "Debuff") return "debuff";
    return "other";
  }

  // --------------------------------------------------------------------------
  // CSS
  // --------------------------------------------------------------------------

  function ensureCss() {
    const old = document.getElementById(STYLE_ID);
    if (old) old.remove();

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
/* -------------------------------------------------------------------------
   Active Effect Manager compact chat card
   ------------------------------------------------------------------------- */

/* Hide default Foundry message chrome, like Treasure/Obtain cards. */
.chat-message.${CHAT_CSS_CLASS},
.chat-message:has(.oni-aem-chat-card) {
  background: transparent !important;
  border: none !important;
  box-shadow: none !important;
  padding: 0 !important;
}

.chat-message.${CHAT_CSS_CLASS} header.message-header,
.chat-message:has(.oni-aem-chat-card) header.message-header,
.chat-message.${CHAT_CSS_CLASS} .message-metadata,
.chat-message:has(.oni-aem-chat-card) .message-metadata,
.chat-message.${CHAT_CSS_CLASS} .message-controls,
.chat-message:has(.oni-aem-chat-card) .message-controls {
  display: none !important;
}

.chat-message.${CHAT_CSS_CLASS} .message-content,
.chat-message:has(.oni-aem-chat-card) .message-content {
  padding: 0 !important;
  margin: 0 !important;
}

/* Main card */
.oni-aem-chat-card {
  --aem-border: rgba(80, 55, 28, .45);
  --aem-accent: rgba(80, 55, 28, .75);
  --aem-soft: rgba(80, 55, 28, .10);

  border: 2px solid var(--aem-border);
  border-left-width: 7px;
  border-radius: 10px;
  background:
    linear-gradient(180deg, rgba(250, 245, 232, .98), rgba(232, 224, 207, .98));
  box-shadow: 0 2px 6px rgba(0,0,0,.24);
  overflow: hidden;
  color: #1f1a14;
  font-family: var(--font-primary, "Signika"), sans-serif;
}

.oni-aem-chat-card.type-buff {
  --aem-border: rgba(64, 132, 210, .95);
  --aem-accent: rgba(64, 132, 210, .95);
  --aem-soft: rgba(64, 132, 210, .12);
}

.oni-aem-chat-card.type-debuff {
  --aem-border: rgba(190, 54, 64, .95);
  --aem-accent: rgba(190, 54, 64, .95);
  --aem-soft: rgba(190, 54, 64, .12);
}

.oni-aem-chat-card.type-mixed {
  --aem-border: rgba(132, 85, 180, .95);
  --aem-accent: rgba(132, 85, 180, .95);
  --aem-soft: rgba(132, 85, 180, .12);
}

.oni-aem-chat-card.type-other {
  --aem-border: rgba(158, 111, 42, .90);
  --aem-accent: rgba(158, 111, 42, .90);
  --aem-soft: rgba(158, 111, 42, .12);
}

/* Header */
.oni-aem-chat-head {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 7px 9px;
  background: rgba(255,255,255,.55);
  border-bottom: 1px solid rgba(60,45,25,.14);
}

.oni-aem-chat-symbol {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  background: var(--aem-soft);
  border: 1px solid rgba(0,0,0,.10);
  font-size: 15px;
  line-height: 1;
}

.oni-aem-chat-title {
  min-width: 0;
}

.oni-aem-chat-title-main {
  font-weight: 900;
  font-size: 13px;
  line-height: 1.12;
}

.oni-aem-chat-title-sub {
  margin-top: 2px;
  font-size: 10px;
  opacity: .68;
  line-height: 1.15;
}

.oni-aem-chat-count {
  min-width: 26px;
  height: 22px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--aem-accent);
  color: white;
  font-weight: 900;
  font-size: 11px;
  box-shadow: 0 1px 2px rgba(0,0,0,.18);
}

/* Row list */
.oni-aem-chat-rows {
  display: grid;
  gap: 0;
  max-height: ${MAX_VISIBLE_ROWS_BEFORE_SCROLL * 43}px;
  overflow: auto;
}

.oni-aem-chat-row {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  gap: 8px;
  align-items: center;
  min-height: 40px;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(60,45,25,.12);
}

.oni-aem-chat-row:last-child {
  border-bottom: none;
}

.oni-aem-chat-row:nth-child(even) {
  background: rgba(255,255,255,.26);
}

.oni-aem-chat-row-icon {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 5px;
  object-fit: cover;
  background: rgba(0,0,0,.08);
  box-shadow: 0 0 0 1px rgba(0,0,0,.14);
}

.oni-aem-chat-row-main {
  min-width: 0;
}

.oni-aem-chat-row-line {
  font-size: 12px;
  line-height: 1.18;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.oni-aem-chat-actor {
  font-weight: 900;
}

.oni-aem-chat-effect {
  font-weight: 900;
}

.oni-aem-chat-row-note {
  margin-top: 2px;
  font-size: 10px;
  opacity: .62;
  line-height: 1.15;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.oni-aem-chat-tags {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 3px;
}

.oni-aem-chat-chip {
  height: 17px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid rgba(0,0,0,.12);
  background: rgba(0,0,0,.06);
  font-size: 9px;
  font-weight: 900;
  line-height: 1;
  white-space: nowrap;
}

.oni-aem-chat-chip.buff {
  color: rgb(28, 78, 145);
  background: rgba(64, 132, 210, .14);
  border-color: rgba(64, 132, 210, .28);
}

.oni-aem-chat-chip.debuff {
  color: rgb(138, 26, 34);
  background: rgba(190, 54, 64, .14);
  border-color: rgba(190, 54, 64, .28);
}

.oni-aem-chat-chip.other {
  color: rgb(118, 78, 24);
  background: rgba(158, 111, 42, .13);
  border-color: rgba(158, 111, 42, .25);
}

.oni-aem-chat-chip.good {
  color: rgb(35, 104, 50);
  background: rgba(72, 170, 86, .15);
  border-color: rgba(72, 170, 86, .25);
}

.oni-aem-chat-chip.removed {
  color: rgb(28, 78, 145);
  background: rgba(64, 132, 210, .14);
  border-color: rgba(64, 132, 210, .28);
}

.oni-aem-chat-chip.skip {
  color: rgb(120, 82, 22);
  background: rgba(210, 152, 55, .14);
  border-color: rgba(210, 152, 55, .25);
}

.oni-aem-chat-chip.bad {
  color: rgb(138, 26, 34);
  background: rgba(190, 54, 64, .14);
  border-color: rgba(190, 54, 64, .28);
}

/* Footer */
.oni-aem-chat-foot {
  padding: 5px 9px 7px;
  font-size: 10px;
  opacity: .64;
  line-height: 1.15;
  border-top: 1px solid rgba(60,45,25,.10);
  background: rgba(255,255,255,.30);
}

.oni-aem-chat-debug {
  margin: 6px 8px 8px;
  font-size: 10px;
}

.oni-aem-chat-debug summary {
  cursor: pointer;
  font-weight: 800;
}

.oni-aem-chat-debug pre {
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 10px;
  background: rgba(255,255,255,.55);
  border: 1px solid rgba(0,0,0,.12);
  border-radius: 6px;
  padding: 6px;
}
    `;
    document.head.appendChild(style);
  }

  // --------------------------------------------------------------------------
  // Render helpers
  // --------------------------------------------------------------------------

  function renderRow(row = {}) {
    const actorName = actorNameFromRow(row);
    const actorUuid = actorUuidFromRow(row);

    const effectName = effectNameFromRow(row);
    const effectImg = effectImgFromRow(row);

    const category = categoryFromRow(row);
    const categoryCls = categoryClass(row);

    const status = statusLabel(row);
    const statusCls = statusClass(row);

    const reason = reasonText(row);
    const actorTitle = actorUuid ? ` title="${escapeHtml(actorUuid)}"` : "";

    return `
      <div class="oni-aem-chat-row">
        <img class="oni-aem-chat-row-icon" src="${escapeHtml(effectImg)}" alt="${escapeHtml(effectName)}">

        <div class="oni-aem-chat-row-main">
          <div class="oni-aem-chat-row-line"${actorTitle}>
            <span class="oni-aem-chat-actor">${escapeHtml(actorName)}</span>
            <span> — </span>
            <span class="oni-aem-chat-effect">${escapeHtml(effectName)}</span>
          </div>
          ${reason ? `<div class="oni-aem-chat-row-note">${escapeHtml(reason)}</div>` : ""}
        </div>

        <div class="oni-aem-chat-tags">
          <span class="oni-aem-chat-chip ${escapeHtml(categoryCls)}">${escapeHtml(category)}</span>
          <span class="oni-aem-chat-chip ${escapeHtml(statusCls)}">${escapeHtml(status)}</span>
        </div>
      </div>
    `;
  }

  function renderRows(report = {}) {
    const rows = getRows(report);

    if (!rows.length) {
      return `
        <div class="oni-aem-chat-row">
          <img class="oni-aem-chat-row-icon" src="icons/svg/aura.svg" alt="Active Effect">
          <div class="oni-aem-chat-row-main">
            <div class="oni-aem-chat-row-line">
              <span class="oni-aem-chat-effect">No effect results.</span>
            </div>
          </div>
          <div class="oni-aem-chat-tags">
            <span class="oni-aem-chat-chip other">Other</span>
          </div>
        </div>
      `;
    }

    return rows.map(renderRow).join("");
  }

  function renderReportContent(report = {}, options = {}) {
    ensureCss();

    const cardType = classifyCard(report);
    const rows = getRows(report);
    const counts = countRows(report);

    const title = getActionLabel(report);
    const subtitle = compactSummary(report);

    const runId = safeString(report.runId);
    const footerParts = [];

    if (rows.length > MAX_VISIBLE_ROWS_BEFORE_SCROLL) {
      footerParts.push(`${rows.length} rows. Scroll inside the card to view all results.`);
    }

    if (runId) {
      footerParts.push(`Run: ${runId}`);
    }

    const showDebug = options.showDebug === true;

    return `
      <div class="oni-aem-chat-card type-${escapeHtml(cardType)}">
        <div class="oni-aem-chat-head">
          <div class="oni-aem-chat-symbol">💫</div>

          <div class="oni-aem-chat-title">
            <div class="oni-aem-chat-title-main">${escapeHtml(title)}</div>
            <div class="oni-aem-chat-title-sub">${escapeHtml(subtitle)}</div>
          </div>

          <div class="oni-aem-chat-count">${escapeHtml(counts.total)}</div>
        </div>

        <div class="oni-aem-chat-rows">
          ${renderRows(report)}
        </div>

        ${footerParts.length ? `
          <div class="oni-aem-chat-foot">
            ${escapeHtml(footerParts.join(" • "))}
          </div>
        ` : ""}

        ${showDebug ? `
          <details class="oni-aem-chat-debug">
            <summary>Debug Report</summary>
            <pre>${escapeHtml(JSON.stringify(compactReportForDebug(report), null, 2))}</pre>
          </details>
        ` : ""}
      </div>
    `;
  }

  function compactReportForDebug(report = {}) {
    return {
      ok: report.ok,
      action: report.action,
      runId: report.runId,
      counts: report.counts,
      options: report.options,
      actors: report.actors,
      errors: report.errors,
      createdAt: report.createdAt
    };
  }

  // --------------------------------------------------------------------------
  // Chat creation
  // --------------------------------------------------------------------------

  async function renderResults(report = {}, options = {}) {
    if (!report || typeof report !== "object") {
      warn("renderResults received invalid report.", report);
      return null;
    }

    if (options.silent === true || report?.options?.silent === true) {
      log("Skipping chat render due to silent option.", {
        runId: report.runId
      });
      return null;
    }

    ensureCss();

    const content = renderReportContent(report, options);

    const messageData = {
      user: game.user?.id,
      speaker: null,
      type: CONST?.CHAT_MESSAGE_TYPES?.OTHER ?? 0,
      content,
      flags: {
        core: {
          cssClass: CHAT_CSS_CLASS
        },
        [MODULE_ID]: {
          activeEffectManagerChat: true,
          activeEffectManagerReport: clone(report, {}),
          runId: report.runId ?? null,
          action: report.action ?? null
        }
      }
    };

    if (Array.isArray(options.whisper) && options.whisper.length) {
      messageData.whisper = options.whisper;
    }

    if (options.blind === true) {
      messageData.blind = true;
    }

    const msg = await ChatMessage.create(messageData);

    log("Rendered compact chat result.", {
      messageId: msg?.id,
      runId: report.runId,
      action: report.action,
      rowCount: getRows(report).length
    });

    return msg;
  }

  async function renderPreview(report = {}, options = {}) {
    ensureCss();

    const content = renderReportContent(report, {
      ...options,
      showDebug: true
    });

    return await ChatMessage.create({
      user: game.user?.id,
      speaker: null,
      type: CONST?.CHAT_MESSAGE_TYPES?.OTHER ?? 0,
      content,
      flags: {
        core: {
          cssClass: CHAT_CSS_CLASS
        },
        [MODULE_ID]: {
          activeEffectManagerPreview: true,
          previewReport: clone(report, {})
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.2.0",

    renderResults,
    renderPreview,

    ensureCss,

    _internal: {
      renderReportContent,
      renderRows,
      renderRow,
      compactReportForDebug,
      getRows,
      classifyCard,
      countRows
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    ensureCss();
    exposeApi(api);

    log("Ready. Active Effect Manager Chat API installed.", {
      api: "FUCompanion.api.activeEffectManager.chat.renderResults(report)"
    });
  });

  Hooks.on("renderChatLog", () => {
    ensureCss();
  });
})();