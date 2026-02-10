// scripts/warehouse-system/warehouse-app.js
// ----------------------------------------------------------------------------
// ONI Warehouse — UI Skeleton (no DnD yet, no commit yet)
// - Renders 2 panels: Actor Inventory | Storage Inventory
// - Shows Zenit + Deposit/Withdraw fields
// - Confirm/Cancel buttons (Confirm is placeholder for now)
// ----------------------------------------------------------------------------

import { WarehouseDebug } from "./warehouse-debug.js";
import { WarehouseAPI } from "./warehouse-api.js";
import { WarehousePayloadManager } from "./warehouse-payloadManager.js";

export class WarehouseApp {
  static APP_FLAG = "ONI_WAREHOUSE_APP_OPEN";

  static _uid() {
    return Math.random().toString(16).slice(2, 10);
  }

  static _escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  static _renderItemSlot(it, side) {
    const name = this._escapeHtml(it?.name ?? "");
    const img = this._escapeHtml(it?.img ?? "icons/svg/item-bag.svg");
    const qty = Number(it?.qty ?? 1);
    const uuid = this._escapeHtml(it?.itemUuid ?? "");

    // data-side tells us where it is (actor vs storage) for future DnD
    return `
      <div class="wh-slot" data-side="${side}" data-item-uuid="${uuid}" title="${name}">
        <img class="wh-icon" src="${img}" alt="${name}">
        ${qty > 1 ? `<div class="wh-qty">${qty}</div>` : ``}
      </div>
    `;
  }

  static _buildHtml(payload) {
    const actorName = this._escapeHtml(payload?.ctx?.actorName ?? "Actor");
    const storageName = this._escapeHtml(payload?.ctx?.storageName ?? "Storage");

    const actorZenit = Number(payload?.snapshot?.actorZenit ?? 0);
    const storageZenit = Number(payload?.snapshot?.storageZenit ?? 0);

    const deposit = Number(payload?.plan?.zenit?.depositToStorage ?? 0);
    const withdraw = Number(payload?.plan?.zenit?.withdrawFromStorage ?? 0);

    const actorItems = Array.isArray(payload?.snapshot?.actorItems) ? payload.snapshot.actorItems : [];
    const storageItems = Array.isArray(payload?.snapshot?.storageItems) ? payload.snapshot.storageItems : [];

    const actorGrid = actorItems.map((it) => this._renderItemSlot(it, "actor")).join("");
    const storageGrid = storageItems.map((it) => this._renderItemSlot(it, "storage")).join("");

    return `
      <div class="wh-root" data-payload-id="${this._escapeHtml(payload?.meta?.payloadId ?? "")}">
        <style>
          /* Minimal skeleton styling (we'll replace with RO style CSS later) */
          .wh-root { display: flex; gap: 12px; }
          .wh-panel {
            width: 420px;
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 10px;
            padding: 10px;
            background: rgba(0,0,0,0.20);
          }
          .wh-title { font-weight: 700; font-size: 16px; margin-bottom: 8px; display:flex; justify-content:space-between; align-items:center; }
          .wh-zenit { font-size: 13px; opacity: 0.9; }
          .wh-zenit b { font-size: 14px; }
          .wh-grid {
            display: grid;
            grid-template-columns: repeat(8, 44px);
            gap: 6px;
            padding: 8px;
            border-radius: 10px;
            border: 1px solid rgba(255,255,255,0.10);
            background: rgba(0,0,0,0.18);
            min-height: 280px;
          }
          .wh-slot {
            width: 44px; height: 44px;
            border-radius: 8px;
            border: 1px solid rgba(255,255,255,0.10);
            background: rgba(0,0,0,0.15);
            position: relative;
            overflow: hidden;
            cursor: default;
          }
          .wh-slot:hover { outline: 2px solid rgba(255,255,255,0.12); }
          .wh-icon { width: 100%; height: 100%; object-fit: cover; display:block; }
          .wh-qty {
            position: absolute;
            right: 3px; bottom: 2px;
            font-size: 12px;
            padding: 0px 5px;
            border-radius: 999px;
            background: rgba(0,0,0,0.70);
            border: 1px solid rgba(255,255,255,0.14);
          }
          .wh-zenit-controls {
            margin-top: 10px;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
          }
          .wh-field { display:flex; flex-direction:column; gap: 4px; }
          .wh-field label { font-size: 12px; opacity: 0.85; }
          .wh-field input {
            width: 100%;
            padding: 6px 8px;
            border-radius: 8px;
            border: 1px solid rgba(255,255,255,0.12);
            background: rgba(0,0,0,0.25);
            color: inherit;
          }
          .wh-hint { margin-top: 8px; font-size: 12px; opacity: 0.75; }
        </style>

        <!-- LEFT: ACTOR -->
        <section class="wh-panel">
          <div class="wh-title">
            <span>${actorName}</span>
            <span class="wh-zenit">Zenit: <b class="wh-actor-zenit">${actorZenit}</b></span>
          </div>

          <div class="wh-grid wh-grid-actor">
            ${actorGrid || `<div style="opacity:0.7;font-size:12px;">(No items)</div>`}
          </div>

          <div class="wh-zenit-controls">
            <div class="wh-field">
              <label>Deposit to Storage</label>
              <input class="wh-input-deposit" type="number" min="0" step="1" value="${deposit}">
            </div>
            <div class="wh-field">
              <label>Withdraw from Storage</label>
              <input class="wh-input-withdraw" type="number" min="0" step="1" value="${withdraw}">
            </div>
          </div>

          <div class="wh-hint">Drag & Drop comes next. For now: UI preview only.</div>
        </section>

        <!-- RIGHT: STORAGE -->
        <section class="wh-panel">
          <div class="wh-title">
            <span>${storageName}</span>
            <span class="wh-zenit">Zenit: <b class="wh-storage-zenit">${storageZenit}</b></span>
          </div>

          <div class="wh-grid wh-grid-storage">
            ${storageGrid || `<div style="opacity:0.7;font-size:12px;">(No items)</div>`}
          </div>

          <div class="wh-hint">Planned transfers are not committed until Confirm.</div>
        </section>
      </div>
    `;
  }

  static _bindListeners(html, payload) {
    // Zenit inputs → write into payload.plan (planning layer only)
    const depositEl = html[0]?.querySelector?.(".wh-input-deposit");
    const withdrawEl = html[0]?.querySelector?.(".wh-input-withdraw");

    const clamp0 = (n) => Math.max(0, Number.isFinite(n) ? n : 0);

    depositEl?.addEventListener("input", () => {
      const v = clamp0(parseInt(depositEl.value ?? "0", 10));
      payload.plan.zenit.depositToStorage = v;
      payload.plan.zenit.lastEditedAt = Date.now();
      payload.plan.zenit.lastEditedBy = payload.ctx.userId;
      WarehouseDebug.log(payload, "ZENIT", "Deposit changed", { depositToStorage: v });
    });

    withdrawEl?.addEventListener("input", () => {
      const v = clamp0(parseInt(withdrawEl.value ?? "0", 10));
      payload.plan.zenit.withdrawFromStorage = v;
      payload.plan.zenit.lastEditedAt = Date.now();
      payload.plan.zenit.lastEditedBy = payload.ctx.userId;
      WarehouseDebug.log(payload, "ZENIT", "Withdraw changed", { withdrawFromStorage: v });
    });
  }

  static async open(payload) {
    payload = WarehousePayloadManager.getOrCreate(payload?.meta?.initial ?? payload ?? {});
    payload.ui.instanceId = payload.ui.instanceId ?? this._uid();

    // Ensure ctx+snapshot are ready
    await WarehouseAPI.resolveContext(payload);
    await WarehouseAPI.buildSnapshot(payload);

    if (payload?.gates?.ok === false) {
      WarehouseDebug.warn(payload, "UI", "Not opening UI because gates.ok=false", { errors: payload.gates.errors });
      return payload;
    }

    payload.ui.renderCount = (payload.ui.renderCount ?? 0) + 1;

    const html = this._buildHtml(payload);

    WarehouseDebug.log(payload, "UI", "Opening Warehouse UI", {
      instanceId: payload.ui.instanceId,
      renderCount: payload.ui.renderCount
    });

    const dlg = new Dialog({
      title: "Warehouse — Item Withdraw",
      content: html,
      buttons: {
        confirm: {
          icon: '<i class="fas fa-check"></i>',
          label: "Confirm",
          callback: () => {
            // Placeholder: commit comes later
            WarehouseDebug.log(payload, "UI", "Confirm pressed (placeholder)", {
              plannedMoves: payload.plan?.itemMoves?.length ?? 0,
              zenitPlan: payload.plan?.zenit
            });
            ui.notifications?.info?.("Warehouse: Confirm (placeholder). Commit stage comes next.");
          }
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: "Cancel",
          callback: () => {
            WarehouseDebug.log(payload, "UI", "Cancel pressed", { instanceId: payload.ui.instanceId });
          }
        }
      },
      default: "confirm",
      render: (htmlObj) => {
        // save dialog id reference for future
        payload.ui.appId = dlg?.appId ?? payload.ui.appId;
        this._bindListeners(htmlObj, payload);
      },
      close: () => {
        WarehouseDebug.log(payload, "UI", "Dialog closed", { instanceId: payload.ui.instanceId });
      }
    }, {
      width: 900,
      height: "auto",
      resizable: true
    });

    dlg.render(true);
    return payload;
  }
}
