// ============================================================================
// ActiveEffectManager-chat.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Render clean grouped chat cards for ActiveEffectManager API results.
// - Handles apply/remove/toggle/modify reports.
// - Does not apply or remove effects by itself.
// - API calls this automatically through:
//     FUCompanion.api.activeEffectManager.chat.renderResults(report, options)
//
// Public API:
//   FUCompanion.api.activeEffectManager.chat.renderResults(report, options)
//   FUCompanion.api.activeEffectManager.chat.renderPreview(report, options)
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:Chat]";
  const DEBUG = true;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err = (...a) => console.error(TAG, ...a);

  // --------------------------------------------------------------------------
  // API root
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager = globalThis.FUCompanion.api.activeEffectManager || {};
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
  // Helpers
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

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (value instanceof Set) return Array.from(value);
    return [value];
  }

  function titleCase(value) {
    const s = safeString(value, "unknown");
    return s
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, m => m.toUpperCase());
  }

  function effectNameFromResult(row = {}) {
    return safeString(
      row?.effect?.name ??
      row?.created?.name ??
      row?.removed?.[0]?.name ??
      row?.before?.name ??
      row?.after?.name ??
      "Active Effect"
    );
  }

  function effectImgFromResult(row = {}) {
    return safeString(
      row?.effect?.img ??
      row?.created?.img ??
      row?.removed?.[0]?.img ??
      row?.before?.img ??
      row?.after?.img ??
      "icons/svg/aura.svg"
    );
  }

  function actorNameFromResult(row = {}) {
    return safeString(
      row?.actor?.name ??
      row?.actorName ??
      "Unknown Actor"
    );
  }

  function actorUuidFromResult(row = {}) {
    return safeString(
      row?.actor?.uuid ??
      row?.actorUuid ??
      ""
    );
  }

  function getReportAction(report = {}) {
    return safeString(report.action, "apply").toLowerCase();
  }

  function getMainTitle(report = {}) {
    const action = getReportAction(report);

    if (action === "apply") return "Active Effects Applied";
    if (action === "remove") return "Active Effects Removed";
    if (action === "toggle") return "Active Effects Toggled";
    if (action === "modify") return "Active Effect Modified";

    return "Active Effect Manager";
  }

  function getSubtitle(report = {}) {
    const counts = report.counts ?? {};
    const parts = [];

    if (counts.applied) parts.push(`${counts.applied} applied`);
    if (counts.replaced) parts.push(`${counts.replaced} replaced`);
    if (counts.stacked) parts.push(`${counts.stacked} stacked`);
    if (counts.removed) parts.push(`${counts.removed} removed`);
    if (counts.skipped) parts.push(`${counts.skipped} skipped`);
    if (counts.failed) parts.push(`${counts.failed} failed`);

    if (!parts.length && counts.total !== undefined) {
      parts.push(`${counts.total} result${Number(counts.total) === 1 ? "" : "s"}`);
    }

    if (report.runId) parts.push(`Run: ${report.runId}`);

    return parts.join(" • ");
  }

  function statusClass(status) {
    const s = safeString(status).toLowerCase();

    if (["applied", "replaced", "stacked"].includes(s)) return "good";
    if (["removed"].includes(s)) return "removed";
    if (["skipped"].includes(s)) return "skip";
    if (["failed"].includes(s)) return "bad";

    return "neutral";
  }

  function statusLabel(row = {}) {
    const status = safeString(row.status, "unknown");

    if (status === "applied") return "Applied";
    if (status === "replaced") return "Replaced";
    if (status === "stacked") return "Stacked";
    if (status === "removed") return "Removed";
    if (status === "skipped") {
      if (row.reason === "duplicate_exists") return "Skipped: Already Exists";
      if (row.reason === "no_matching_effects") return "Skipped: No Match";
      return "Skipped";
    }
    if (status === "failed") return "Failed";

    return titleCase(status);
  }

  function reasonText(row = {}) {
    const reason = safeString(row.reason);
    const error = safeString(row.error);

    if (error) return error;

    if (!reason) return "";

    const map = {
      duplicate_exists: "A matching effect already exists.",
      duplicate_removed: "Existing duplicate was removed.",
      no_matching_effects: "No matching effects found.",
      no_permission: "No permission to modify this actor.",
      toggle_on: "Toggled on.",
      toggle_off: "Toggled off."
    };

    return map[reason] ?? titleCase(reason);
  }

  function styleBlock() {
    return `
      <style>
        .oni-aem-chat {
          --aem-bg: rgba(20, 18, 16, .92);
          --aem-panel: rgba(255, 255, 255, .08);
          --aem-line: rgba(255, 255, 255, .18);
          --aem-text: #f7efe2;
          --aem-muted: rgba(247, 239, 226, .72);
          --aem-good: #8ee89b;
          --aem-skip: #ffd47a;
          --aem-bad: #ff8b8b;
          --aem-remove: #9bc7ff;

          color: var(--aem-text);
          background:
            linear-gradient(135deg, rgba(60,48,38,.95), rgba(20,18,16,.96));
          border: 1px solid rgba(255,255,255,.2);
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 3px 10px rgba(0,0,0,.35);
          font-family: var(--font-primary);
        }

        .oni-aem-chat .aem-head {
          padding: 10px 12px;
          background: rgba(0,0,0,.28);
          border-bottom: 1px solid var(--aem-line);
        }

        .oni-aem-chat .aem-title {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 16px;
          font-weight: 800;
          letter-spacing: .02em;
        }

        .oni-aem-chat .aem-title-icon {
          width: 26px;
          height: 26px;
          object-fit: cover;
          border: 0;
          border-radius: 6px;
          background: rgba(255,255,255,.12);
        }

        .oni-aem-chat .aem-subtitle {
          margin-top: 3px;
          font-size: 11px;
          color: var(--aem-muted);
        }

        .oni-aem-chat .aem-body {
          padding: 9px;
        }

        .oni-aem-chat .aem-actor-block {
          background: var(--aem-panel);
          border: 1px solid var(--aem-line);
          border-radius: 10px;
          margin-bottom: 8px;
          overflow: hidden;
        }

        .oni-aem-chat .aem-actor-name {
          padding: 6px 8px;
          font-weight: 800;
          background: rgba(0,0,0,.22);
          border-bottom: 1px solid var(--aem-line);
        }

        .oni-aem-chat .aem-effect-row {
          display: grid;
          grid-template-columns: 28px 1fr auto;
          gap: 7px;
          align-items: center;
          padding: 6px 8px;
          border-bottom: 1px solid rgba(255,255,255,.1);
        }

        .oni-aem-chat .aem-effect-row:last-child {
          border-bottom: none;
        }

        .oni-aem-chat .aem-effect-icon {
          width: 24px;
          height: 24px;
          object-fit: cover;
          border: 0;
          border-radius: 5px;
          background: rgba(255,255,255,.12);
        }

        .oni-aem-chat .aem-effect-name {
          font-weight: 750;
          line-height: 1.15;
        }

        .oni-aem-chat .aem-effect-note {
          margin-top: 2px;
          color: var(--aem-muted);
          font-size: 10px;
          line-height: 1.2;
        }

        .oni-aem-chat .aem-status {
          white-space: nowrap;
          font-size: 10px;
          font-weight: 800;
          padding: 3px 6px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,.2);
          background: rgba(255,255,255,.1);
        }

        .oni-aem-chat .aem-status.good {
          color: var(--aem-good);
          border-color: rgba(142,232,155,.45);
          background: rgba(142,232,155,.12);
        }

        .oni-aem-chat .aem-status.skip {
          color: var(--aem-skip);
          border-color: rgba(255,212,122,.45);
          background: rgba(255,212,122,.12);
        }

        .oni-aem-chat .aem-status.bad {
          color: var(--aem-bad);
          border-color: rgba(255,139,139,.45);
          background: rgba(255,139,139,.12);
        }

        .oni-aem-chat .aem-status.removed {
          color: var(--aem-remove);
          border-color: rgba(155,199,255,.45);
          background: rgba(155,199,255,.12);
        }

        .oni-aem-chat .aem-empty {
          padding: 10px;
          color: var(--aem-muted);
          text-align: center;
        }

        .oni-aem-chat details {
          margin-top: 8px;
          background: rgba(0,0,0,.18);
          border: 1px solid rgba(255,255,255,.14);
          border-radius: 8px;
          padding: 5px 7px;
        }

        .oni-aem-chat summary {
          cursor: pointer;
          font-size: 11px;
          color: var(--aem-muted);
        }

        .oni-aem-chat pre {
          max-height: 220px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
          font-size: 10px;
          color: var(--aem-text);
        }
      </style>
    `;
  }

  // --------------------------------------------------------------------------
  // Group/render rows
  // --------------------------------------------------------------------------

  function groupResultsByActor(results = []) {
    const groups = new Map();

    for (const row of results) {
      const actorName = actorNameFromResult(row);
      const actorUuid = actorUuidFromResult(row);
      const key = actorUuid || actorName;

      if (!groups.has(key)) {
        groups.set(key, {
          actorName,
          actorUuid,
          rows: []
        });
      }

      groups.get(key).rows.push(row);
    }

    return Array.from(groups.values());
  }

  function renderEffectRow(row = {}) {
    const name = effectNameFromResult(row);
    const img = effectImgFromResult(row);
    const label = statusLabel(row);
    const cls = statusClass(row.status);
    const note = reasonText(row);

    const removedCount = Array.isArray(row.removed) ? row.removed.length : 0;
    const duplicateCount = Array.isArray(row.duplicates) ? row.duplicates.length : 0;

    const extras = [];

    if (removedCount > 1) extras.push(`${removedCount} effects removed`);
    if (duplicateCount && row.status !== "skipped") extras.push(`${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} found`);
    if (row.created?.uuid) extras.push(`Created: ${row.created.uuid}`);

    const noteLine = [note, ...extras].filter(Boolean).join(" • ");

    return `
      <div class="aem-effect-row">
        <img class="aem-effect-icon" src="${escapeHtml(img)}">
        <div>
          <div class="aem-effect-name">${escapeHtml(name)}</div>
          ${noteLine ? `<div class="aem-effect-note">${escapeHtml(noteLine)}</div>` : ""}
        </div>
        <div class="aem-status ${escapeHtml(cls)}">${escapeHtml(label)}</div>
      </div>
    `;
  }

  function renderActorBlock(group = {}) {
    const rows = group.rows ?? [];

    return `
      <div class="aem-actor-block">
        <div class="aem-actor-name">
          ${escapeHtml(group.actorName || "Unknown Actor")}
        </div>
        ${rows.length ? rows.map(renderEffectRow).join("") : `<div class="aem-empty">No results.</div>`}
      </div>
    `;
  }

  function renderModifyReport(report = {}) {
    const actor = report.actor ?? {};
    const before = report.before ?? {};
    const after = report.after ?? {};

    const row = {
      status: report.ok ? "applied" : "failed",
      actor,
      effect: {
        name: after.name ?? before.name ?? "Active Effect",
        img: after.img ?? before.img ?? "icons/svg/aura.svg"
      },
      reason: report.ok ? "modified" : report.reason,
      error: report.error
    };

    return renderActorBlock({
      actorName: actor.name ?? "Unknown Actor",
      actorUuid: actor.uuid ?? "",
      rows: [row]
    });
  }

  function renderReportContent(report = {}, options = {}) {
    const action = getReportAction(report);
    const title = getMainTitle(report);
    const subtitle = getSubtitle(report);

    const results = asArray(report.results);

    let body = "";

    if (action === "modify") {
      body = renderModifyReport(report);
    } else if (results.length) {
      const groups = groupResultsByActor(results);
      body = groups.map(renderActorBlock).join("");
    } else {
      body = `<div class="aem-empty">No effect results.</div>`;
    }

    const showDebug = options.showDebug === true || DEBUG === true;

    return `
      ${styleBlock()}
      <div class="oni-aem-chat">
        <div class="aem-head">
          <div class="aem-title">
            <img class="aem-title-icon" src="icons/svg/aura.svg">
            <span>${escapeHtml(title)}</span>
          </div>
          ${subtitle ? `<div class="aem-subtitle">${escapeHtml(subtitle)}</div>` : ""}
        </div>

        <div class="aem-body">
          ${body}

          ${showDebug ? `
            <details>
              <summary>Debug Report</summary>
              <pre>${escapeHtml(JSON.stringify(compactReportForDebug(report), null, 2))}</pre>
            </details>
          ` : ""}
        </div>
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

    const content = renderReportContent(report, options);

    const speaker = ChatMessage.getSpeaker({
      alias: "Active Effect Manager"
    });

    const messageData = {
      speaker,
      content,
      flags: {
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

    log("Rendered chat result.", {
      messageId: msg?.id,
      runId: report.runId,
      action: report.action
    });

    return msg;
  }

  async function renderPreview(report = {}, options = {}) {
    const content = renderReportContent(report, {
      ...options,
      showDebug: true
    });

    return await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({
        alias: "Active Effect Manager Preview"
      }),
      content,
      flags: {
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
    version: "0.1.0",
    renderResults,
    renderPreview,

    _internal: {
      renderReportContent,
      renderEffectRow,
      renderActorBlock,
      groupResultsByActor,
      compactReportForDebug
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    exposeApi(api);

    log("Ready. Active Effect Manager Chat API installed.", {
      api: "FUCompanion.api.activeEffectManager.chat.renderResults(report)"
    });
  });
})();