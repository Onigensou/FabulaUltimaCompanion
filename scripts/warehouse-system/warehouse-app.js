// scripts/warehouse-system/warehouse-app.js
// ----------------------------------------------------------------------------
// ONI Warehouse — UI (Demo-style Tabs + 7x7 Grid)
// - 2 panels: Actor | Storage
// - Each panel has tabs (by item_type) + 7x7 grid
// - Filters OUT skills by requiring system.props.item_type (or itemType on snapshot)
// - Tooltip fixed (color + decode + enrich + event delegation)
// - Zenit deposit/withdraw is still "plan-only" (no commit yet)
// ----------------------------------------------------------------------------

import { WarehouseDebug } from "./warehouse-debug.js";
import { WarehouseAPI } from "./warehouse-api.js";
import { WarehousePayloadManager } from "./warehouse-payloadManager.js";

export class WarehouseApp {
  static APP_FLAG = "ONI_WAREHOUSE_APP_OPEN";

  // Match the demo category set / order (you can tweak labels anytime)
  static CATEGORIES = [
    { key: "weapon",     label: "⚔️ Weapon" },
    { key: "accessory",  label: "Accessory" },
    { key: "shield",     label: "🛡️ Shield" },
    { key: "armor",      label: "🥋 Armor" },
    { key: "consumable", label: "🍖 Consumable" },
    { key: "recipe",     label: "📖 Recipe" },
    { key: "key",        label: "🔑 Key Item" }
  ];

  static GRID_SIZE = 7;
  static SLOTS = WarehouseApp.GRID_SIZE * WarehouseApp.GRID_SIZE;

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

  static async _enrichMaybe(html) {
    const raw = String(html ?? "").trim();
    if (!raw) return "";
    try {
      return await TextEditor.enrichHTML(raw, { async: true, secrets: false, documents: true, links: true });
    } catch {
      return raw;
    }
  }

  // Decode an HTML-escaped string back into raw HTML
  static _decodeHtml(escaped) {
    const t = document.createElement("textarea");
    t.innerHTML = String(escaped ?? "");
    return t.value ?? "";
  }

  // --------------------------------------------------------------------------
  // FILTER: treat "real items" as those that have item_type
  // (Skills don’t have system.props.item_type)
  // --------------------------------------------------------------------------
  static _getItemType(it) {
    const t =
      it?.itemType ??
      it?.system?.props?.item_type ??
      it?.system?.item_type ??
      it?.type ??
      "";
    return String(t ?? "").toLowerCase().trim();
  }

  static _isWarehouseItem(it) {
    const t = WarehouseApp._getItemType(it);
    return !!t; // must be non-empty
  }

  static _getItemDesc(it) {
    // Prefer snapshot-provided desc if present
    const desc =
      it?.desc ??
      it?.system?.props?.description ??
      it?.system?.description?.value ??
      it?.system?.description ??
      "";
    return String(desc ?? "");
  }

  static _getQty(it) {
    let qty = it?.qty ?? it?.system?.props?.item_quantity ?? 1;
    qty = Number.isFinite(qty) ? qty : Number(qty);
    if (!Number.isFinite(qty)) qty = 1;
    return qty;
  }

  // Normalize snapshot item into a UI record
  static _normalizeSnapshotItem(it) {
    const type = WarehouseApp._getItemType(it);
    return {
      itemUuid: it?.itemUuid ?? it?.uuid ?? "",
      name: it?.name ?? "Unnamed",
      img: it?.img ?? "icons/svg/item-bag.svg",
      type,
      qty: WarehouseApp._getQty(it),
      desc: WarehouseApp._getItemDesc(it)
    };
  }

  static _groupByCategory(items) {
    const byCat = Object.fromEntries(WarehouseApp.CATEGORIES.map(c => [c.key, []]));
    for (const raw of items ?? []) {
      if (!WarehouseApp._isWarehouseItem(raw)) continue;
      const it = WarehouseApp._normalizeSnapshotItem(raw);
      if (!byCat[it.type]) continue; // ignore unknown types for now (same as demo)
      byCat[it.type].push(it);
    }
    return byCat;
  }

  static _buildGridHTML(items, side, catKey) {
    const shown = (items ?? []).slice(0, WarehouseApp.SLOTS);
    const cells = [];

    for (let idx = 0; idx < WarehouseApp.SLOTS; idx++) {
      const it = shown[idx];
      if (!it) {
        cells.push(`<div class="oni-inv-slot oni-empty" data-side="${side}" data-cat="${catKey}" data-idx="${idx}"></div>`);
        continue;
      }

      const qtyBadge = (it.qty > 1)
        ? `<div class="oni-qty">${it.qty}</div>`
        : (it.qty === 0 ? `<div class="oni-qty oni-zero">0</div>` : ``);

      // Store tooltip data (ESCAPED) and decode later for tooltip
      const nameEsc = WarehouseApp._escapeHtml(it.name);
      const descEsc = WarehouseApp._escapeHtml(it.desc);
      const uuidEsc = WarehouseApp._escapeHtml(it.itemUuid);

      cells.push(`
        <div class="oni-inv-slot oni-item"
             data-side="${side}"
             data-cat="${catKey}"
             data-item-uuid="${uuidEsc}"
             data-item-name="${nameEsc}"
             data-item-desc="${descEsc}">
          <img class="oni-icon" src="${WarehouseApp._escapeHtml(it.img)}" draggable="false"/>
          ${qtyBadge}
        </div>
      `);
    }

    return `
      <div class="oni-grid-wrap">
        <div class="oni-grid">${cells.join("")}</div>
      </div>
    `;
  }

  static _buildPanelHTML(payload, side) {
    const isActor = side === "actor";

    const name = WarehouseApp._escapeHtml(
      isActor ? (payload?.ctx?.actorName ?? "Actor") : (payload?.ctx?.storageName ?? "Storage")
    );

    const zenit = Number(
      isActor ? (payload?.snapshot?.actorZenit ?? 0) : (payload?.snapshot?.storageZenit ?? 0)
    );

    const items = isActor ? (payload?.snapshot?.actorItems ?? []) : (payload?.snapshot?.storageItems ?? []);

    // Debug count (helps verify skill filtering)
    const totalRaw = Array.isArray(items) ? items.length : 0;
    const totalFiltered = (items ?? []).filter(WarehouseApp._isWarehouseItem).length;
    const removed = totalRaw - totalFiltered;
    if (removed > 0) {
      WarehouseDebug.log(payload, "UI", "Filtered out non-warehouse entries (likely Skills)", { side, removed });
    }

    const byCat = WarehouseApp._groupByCategory(items);

    // Tabs + Panels
    const tabButtons = WarehouseApp.CATEGORIES.map((c, idx) => `
      <button type="button"
              class="oni-tab ${idx === 0 ? "active" : ""}"
              data-side="${side}"
              data-tab="${c.key}">
        ${c.label}
      </button>
    `).join("");

    const tabPanels = WarehouseApp.CATEGORIES.map((c, idx) => `
      <section class="oni-panel ${idx === 0 ? "active" : ""}" data-side="${side}" data-panel="${c.key}">
        ${WarehouseApp._buildGridHTML(byCat[c.key], side, c.key)}
      </section>
    `).join("");

    // Actor-only zenit controls (plan)
    const deposit = Number(payload?.plan?.zenit?.depositToStorage ?? 0);
    const withdraw = Number(payload?.plan?.zenit?.withdrawFromStorage ?? 0);

    const zenitControls = isActor ? `
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
    ` : `
      <div class="wh-hint">Planned transfers are not committed until Confirm.</div>
    `;

    return `
      <section class="wh-panel" data-side="${side}">
        <div class="wh-title">
          <span>${name}</span>
          <span class="wh-zenit">Zenit: <b>${zenit}</b></span>
        </div>

        <div class="oni-tabs" data-side="${side}">
          ${tabButtons}
        </div>

        <div class="oni-panels" data-side="${side}">
          ${tabPanels}
        </div>

        ${zenitControls}
      </section>
    `;
  }

  static _buildHtml(payload) {
    const actorPanel = WarehouseApp._buildPanelHTML(payload, "actor");
    const storagePanel = WarehouseApp._buildPanelHTML(payload, "storage");

    return `
      <div class="wh-root" data-payload-id="${WarehouseApp._escapeHtml(payload?.meta?.payloadId ?? "")}">
        <style>
          /* Overall layout */
          .wh-root { display: flex; gap: 12px; user-select: none; }
          .wh-panel {
            width: 420px;
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 10px;
            padding: 10px;
            background: rgba(0,0,0,0.20);
          }
          .wh-title {
            font-weight: 800;
            font-size: 14px;
            margin-bottom: 6px;
            opacity: 0.9;
            display:flex;
            justify-content:space-between;
            align-items:center;
          }
          .wh-zenit { font-size: 13px; opacity: 0.9; }
          .wh-zenit b { font-size: 14px; }

          /* ===== Demo-style tabs ===== */
          .oni-tabs {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 6px;
            margin-bottom: 8px;
          }
          .oni-tab {
            border: 1px solid rgba(0,0,0,0.18);
            background: rgba(255,255,255,0.55);
            padding: 4px 6px;
            height: 26px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 11px;
            line-height: 1;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            white-space: nowrap;
          }
          .oni-tab.active {
            background: rgba(255,255,255,0.92);
            border-color: rgba(0,0,0,0.32);
            font-weight: 800;
            box-shadow: 0 0 0 2px rgba(255,255,255,0.35) inset;
          }

          .oni-panel { display: none; }
          .oni-panel.active { display: block; }

          /* ===== Demo-style 7x7 grid ===== */
          .oni-grid {
            display: grid;
            grid-template-columns: repeat(7, 44px);
            grid-auto-rows: 44px;
            gap: 6px;
            padding: 6px;
            border: 1px solid rgba(0,0,0,0.18);
            border-radius: 12px;
            background: rgba(255,255,255,0.45);
          }

          .oni-inv-slot {
            position: relative;
            width: 44px;
            height: 44px;
            border-radius: 10px;
            border: 1px solid rgba(0,0,0,0.18);
            background: rgba(255,255,255,0.30);
            overflow: hidden;
          }

          .oni-inv-slot.oni-item {
            cursor: pointer;
            background: rgba(255,255,255,0.65);
          }

          .oni-inv-slot.oni-item:hover {
            outline: 2px solid rgba(255,255,255,0.9);
            box-shadow: 0 0 0 2px rgba(0,0,0,0.12) inset;
            transform: translateY(-1px);
          }

          .oni-icon {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
            pointer-events: none;
          }

          .oni-qty {
            position: absolute;
            right: 3px;
            bottom: 3px;
            min-width: 16px;
            height: 16px;
            padding: 0 4px;
            border-radius: 999px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: 900;
            background: rgba(0,0,0,0.72);
            color: white;
            line-height: 1;
            pointer-events: none;
          }
          .oni-qty.oni-zero { background: rgba(120,0,0,0.78); }

          /* Zenit controls */
          .wh-zenit-controls { display:flex; gap: 10px; margin-top: 10px; }
          .wh-field { flex: 1; display:flex; flex-direction:column; gap: 4px; }
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

          /* Tooltip (fixed: color!) */
          .oni-tooltip {
            position: fixed;
            z-index: 100000;
            max-width: 340px;
            padding: 8px 10px;
            border-radius: 10px;
            border: 1px solid rgba(0,0,0,0.25);
            background: rgba(20,20,20,0.92);
            color: #ffffff; /* IMPORTANT FIX */
            box-shadow: 0 10px 25px rgba(0,0,0,0.35);
            display: none;
            pointer-events: none;
          }
          .oni-tooltip .t-name {
            font-weight: 900;
            margin-bottom: 6px;
            font-size: 13px;
          }
          .oni-tooltip .t-desc {
            font-size: 12px;
            opacity: 0.95;
          }
          .oni-tooltip .t-desc p { margin: 0 0 6px 0; }
          .oni-tooltip .t-desc ul { margin: 0 0 6px 18px; }
        </style>

        ${actorPanel}
        ${storagePanel}

        <!-- shared tooltip -->
        <div class="oni-tooltip" id="whTooltip">
          <div class="t-name"></div>
          <div class="t-desc"></div>
        </div>
      </div>
    `;
  }

  static _bindTabs(root) {
    const tabBtns = [...root.querySelectorAll(".oni-tab")];
    const panels = [...root.querySelectorAll(".oni-panel")];

    const activateTab = (side, key) => {
      for (const b of tabBtns) {
        const sameSide = b.dataset.side === side;
        if (!sameSide) continue;
        b.classList.toggle("active", b.dataset.tab === key);
      }
      for (const p of panels) {
        const sameSide = p.dataset.side === side;
        if (!sameSide) continue;
        p.classList.toggle("active", p.dataset.panel === key);
      }
    };

    for (const b of tabBtns) {
      b.addEventListener("click", () => activateTab(b.dataset.side, b.dataset.tab));
    }
  }

  static _bindTooltip(root, payload) {
    const tip = root.querySelector("#whTooltip");
    const tipName = tip?.querySelector(".t-name");
    const tipDesc = tip?.querySelector(".t-desc");
    if (!tip || !tipName || !tipDesc) return;

    const moveTip = (ev) => {
      const pad = 14;
      const rect = tip.getBoundingClientRect();
      let x = ev.clientX + pad;
      let y = ev.clientY + pad;

      if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
      if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;

      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    };

    const hideTip = () => {
      tip.style.display = "none";
      tipName.textContent = "";
      tipDesc.innerHTML = "";
    };

    const showTip = async (ev, slot) => {
      const nameEsc = slot.dataset.itemName ?? "Item";
      const descEsc = slot.dataset.itemDesc ?? "";

      // nameEsc is already plain text-safe (escaped), so textContent is fine:
      tipName.textContent = WarehouseApp._decodeHtml(nameEsc) || "Item";

      // descEsc may contain HTML; decode then enrich
      const decodedHtml = WarehouseApp._decodeHtml(descEsc);
      const finalHtml = await WarehouseApp._enrichMaybe(decodedHtml);
      tipDesc.innerHTML = finalHtml || `<em>No description.</em>`;

      tip.style.display = "block";
      moveTip(ev);

      WarehouseDebug.log(payload, "TIP", "Tooltip show", {
        name: tipName.textContent,
        hasDesc: !!decodedHtml
      });
    };

    // Demo-style event delegation (works even when grids change / tabs switch)
    root.addEventListener("mouseenter", (ev) => {
      const slot = ev.target.closest(".oni-inv-slot.oni-item");
      if (!slot) return;
      showTip(ev, slot);
    }, true);

    root.addEventListener("mousemove", (ev) => {
      if (tip.style.display === "none") return;
      moveTip(ev);
    }, true);

    root.addEventListener("mouseleave", (ev) => {
      const slot = ev.target.closest(".oni-inv-slot.oni-item");
      if (!slot) return;
      hideTip();
    }, true);

    root.addEventListener("wheel", hideTip, { passive: true });
    root.addEventListener("mousedown", hideTip);
  }

  static _bindZenit(root, payload) {
    const depositEl = root.querySelector(".wh-input-deposit");
    const withdrawEl = root.querySelector(".wh-input-withdraw");

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

  static _bindAll(htmlObj, payload) {
    const root = htmlObj?.[0]?.querySelector?.(".wh-root");
    if (!root) return;

    this._bindTabs(root);
    this._bindTooltip(root, payload);
    this._bindZenit(root, payload);
  }

  static async open(payload) {
    payload = WarehousePayloadManager.getOrCreate(payload?.meta?.initial ?? payload ?? {});
    payload.ui.instanceId = payload.ui.instanceId ?? this._uid();

    await WarehouseAPI.resolveContext(payload);
    await WarehouseAPI.buildSnapshot(payload);

    if (payload?.gates?.ok === false) {
      WarehouseDebug.warn(payload, "UI", "Not opening UI because gates.ok=false", { errors: payload.gates.errors });
      return payload;
    }

    payload.ui.renderCount = (payload.ui.renderCount ?? 0) + 1;
    const content = this._buildHtml(payload);

    WarehouseDebug.log(payload, "UI", "Opening Warehouse UI", {
      instanceId: payload.ui.instanceId,
      renderCount: payload.ui.renderCount
    });

    const dlg = new Dialog(
      {
        title: "Warehouse — Item Withdraw",
        content,
        buttons: {
          confirm: {
            icon: '<i class="fas fa-check"></i>',
            label: "Confirm",
            callback: () => {
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
        render: (html) => {
          payload.ui.appId = dlg?.appId ?? payload.ui.appId;
          this._bindAll(html, payload);
        },
        close: () => {
          WarehouseDebug.log(payload, "UI", "Dialog closed", { instanceId: payload.ui.instanceId });
        }
      },
      { width: 920, height: "auto", resizable: true }
    );

    dlg.render(true);
    return payload;
  }
}
