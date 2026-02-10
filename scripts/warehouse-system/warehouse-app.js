// scripts/warehouse-system/warehouse-app.js
// ----------------------------------------------------------------------------
// ONI Warehouse — UI (planning layer)
// - 2 panels: Actor Inventory | Storage Inventory
// - Zenit + Deposit/Withdraw inputs (planning only)
// - Tooltip on hover (name + description)
// - Filters OUT "Skill" objects by requiring system.props.item_type
// - Categorizes items by item_type (like your demo inventory UI)
// ----------------------------------------------------------------------------

import { WarehouseDebug } from "./warehouse-debug.js";
import { WarehouseAPI } from "./warehouse-api.js";
import { WarehousePayloadManager } from "./warehouse-payloadManager.js";

export class WarehouseApp {
  static APP_FLAG = "ONI_WAREHOUSE_APP_OPEN";

  // Item type ordering + labels (adjust labels anytime)
  static ITEM_TYPE_ORDER = [
    "weapon",
    "armor",
    "shield",
    "accessory",
    "consumable",
    "key",
    "material",
    "recipe",
    "misc"
  ];

  static ITEM_TYPE_LABELS = {
    weapon: "Weapons",
    armor: "Armor",
    shield: "Shields",
    accessory: "Accessories",
    consumable: "Consumables",
    key: "Key Items",
    material: "Materials",
    recipe: "Recipes",
    misc: "Misc"
  };

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

  // --------------------------------------------------------------------------
  // FILTER: real warehouse items only
  // Rule: must have system.props.item_type (skills don’t)
  // --------------------------------------------------------------------------
  static _isWarehouseItem(it) {
    const itemType =
      it?.itemType ??
      it?.system?.props?.item_type ??
      it?.system?.item_type ??
      "";

    // Most reliable: system.props.item_type exists and is non-empty
    const hasItemType = !!(it?.system?.props?.item_type ?? it?.itemType);

    // Defensive: also exclude obvious skill-ish shapes if they somehow have item_type
    const hasSkillType = !!it?.system?.props?.skill_type;

    return hasItemType && !hasSkillType && String(itemType).trim().length > 0;
  }

  static _getItemType(it) {
    const t =
      it?.itemType ??
      it?.system?.props?.item_type ??
      it?.system?.item_type ??
      it?.type ??
      "";
    return String(t ?? "").toLowerCase().trim();
  }

  static _getItemDesc(it) {
    // Your sample item object stores description at system.props.description
    const desc =
      it?.system?.props?.description ??
      it?.system?.description?.value ??
      it?.system?.description ??
      "";
    return String(desc ?? "");
  }

  static _renderItemSlot(it, side) {
    const name = this._escapeHtml(it?.name ?? "");
    const img = this._escapeHtml(it?.img ?? "icons/svg/item-bag.svg");
    const qty = Number(it?.qty ?? 1);
    const uuid = this._escapeHtml(it?.itemUuid ?? "");
    const itemType = this._escapeHtml(this._getItemType(it));

    // Tooltip data:
    const rawDesc = this._getItemDesc(it);
    const desc = this._escapeHtml(rawDesc);

    return `
      <div class="wh-slot"
           data-side="${side}"
           data-item-uuid="${uuid}"
           data-item-type="${itemType}"
           data-tip-name="${name}"
           data-tip-desc="${desc}">
        <img class="wh-icon" src="${img}" alt="${name}">
        ${qty > 1 ? `<div class="wh-qty">${qty}</div>` : ``}
      </div>
    `;
  }

  static _groupItemsByType(items) {
    const groups = {};
    for (const it of items) {
      const t = this._getItemType(it) || "misc";
      groups[t] = groups[t] ?? [];
      groups[t].push(it);
    }
    return groups;
  }

  static _renderCategorizedGrid(items, side) {
    const filtered = (items ?? []).filter((it) => this._isWarehouseItem(it));

    // Debug: show what got filtered out
    const removed = (items ?? []).length - filtered.length;
    if (removed > 0) {
      WarehouseDebug.log(
        globalThis.__WAREHOUSE_PAYLOAD,
        "UI",
        "Filtered out non-warehouse entries (likely Skills)",
        { side, removed }
      );
    }

    const groups = this._groupItemsByType(filtered);

    // Build in desired order, then append any unknown types at the end
    const known = this.ITEM_TYPE_ORDER.filter((k) => groups[k]?.length);
    const unknown = Object.keys(groups)
      .filter((k) => !this.ITEM_TYPE_ORDER.includes(k))
      .sort((a, b) => a.localeCompare(b));

    const orderedTypes = [...known, ...unknown];

    if (orderedTypes.length === 0) {
      return `<div style="opacity:0.7;font-size:12px;">(No items)</div>`;
    }

    return orderedTypes
      .map((typeKey) => {
        const label = this._escapeHtml(this.ITEM_TYPE_LABELS[typeKey] ?? typeKey);
        const slots = groups[typeKey]
          .map((it) => this._renderItemSlot(it, side))
          .join("");

        return `
          <div class="wh-cat-block">
            <div class="wh-cat-title">${label}</div>
            <div class="wh-cat-grid">${slots}</div>
          </div>
        `;
      })
      .join("");
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

    const actorGrid = this._renderCategorizedGrid(actorItems, "actor");
    const storageGrid = this._renderCategorizedGrid(storageItems, "storage");

    return `
      <div class="wh-root" data-payload-id="${this._escapeHtml(payload?.meta?.payloadId ?? "")}">
        <style>
          .wh-root { display: flex; gap: 12px; }
          .wh-panel {
            width: 420px;
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 10px;
            padding: 10px;
            background: rgba(0,0,0,0.20);
            position: relative;
          }
          .wh-title { font-weight: 700; font-size: 16px; margin-bottom: 8px; display:flex; justify-content:space-between; align-items:center; }
          .wh-zenit { font-size: 13px; opacity: 0.9; }
          .wh-zenit b { font-size: 14px; }

          /* Category blocks */
          .wh-cat-block { margin-bottom: 10px; }
          .wh-cat-title {
            font-size: 12px;
            font-weight: 700;
            opacity: 0.85;
            margin: 6px 0 6px 2px;
            letter-spacing: 0.3px;
          }
          .wh-cat-grid {
            display: grid;
            grid-template-columns: repeat(8, 44px);
            gap: 6px;
            padding: 6px;
            border-radius: 10px;
            background: rgba(255,255,255,0.08);
            min-height: 54px;
          }

          /* Slots */
          .wh-slot {
            width: 44px; height: 44px;
            border-radius: 8px;
            border: 1px solid rgba(255,255,255,0.12);
            background: rgba(0,0,0,0.25);
            position: relative;
            cursor: default;
            user-select: none;
          }
          .wh-slot:hover { outline: 2px solid rgba(255,255,255,0.18); }
          .wh-icon { width: 100%; height: 100%; border-radius: 8px; object-fit: cover; }
          .wh-qty {
            position: absolute;
            right: 3px; bottom: 2px;
            font-size: 12px;
            font-weight: 800;
            text-shadow: 0 2px 2px rgba(0,0,0,0.8);
          }

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

          /* Tooltip */
          .wh-tooltip {
            position: fixed;
            z-index: 999999;
            max-width: 320px;
            pointer-events: none;
            padding: 8px 10px;
            border-radius: 10px;
            background: rgba(10,10,10,0.92);
            border: 1px solid rgba(255,255,255,0.12);
            box-shadow: 0 8px 20px rgba(0,0,0,0.35);
            display: none;
          }
          .wh-tooltip .t-name { font-weight: 800; font-size: 13px; margin-bottom: 4px; }
          .wh-tooltip .t-desc { font-size: 12px; opacity: 0.9; line-height: 1.25; white-space: pre-wrap; }
        </style>

        <!-- Tooltip node -->
        <div class="wh-tooltip">
          <div class="t-name"></div>
          <div class="t-desc"></div>
        </div>

        <!-- LEFT: ACTOR -->
        <section class="wh-panel">
          <div class="wh-title">
            <span>${actorName}</span>
            <span class="wh-zenit">Zenit: <b class="wh-actor-zenit">${actorZenit}</b></span>
          </div>

          <div class="wh-grid wh-grid-actor">
            ${actorGrid}
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
            ${storageGrid}
          </div>

          <div class="wh-hint">Planned transfers are not committed until Confirm.</div>
        </section>
      </div>
    `;
  }

  static _bindTooltip(rootEl, payload) {
    const tip = rootEl.querySelector(".wh-tooltip");
    if (!tip) return;

    const nameEl = tip.querySelector(".t-name");
    const descEl = tip.querySelector(".t-desc");

    const show = (ev, slot) => {
      const name = slot?.dataset?.tipName ?? "";
      const desc = slot?.dataset?.tipDesc ?? "";

      nameEl.textContent = name;
      descEl.textContent = desc;

      tip.style.display = "block";
      this._moveTooltip(ev);
      WarehouseDebug.log(payload, "TIP", "Tooltip show", { name, hasDesc: !!desc });
    };

    const hide = () => {
      tip.style.display = "none";
    };

    rootEl.addEventListener("mousemove", (ev) => {
      if (tip.style.display !== "block") return;
      this._moveTooltip(ev);
    });

    rootEl.querySelectorAll(".wh-slot").forEach((slot) => {
      slot.addEventListener("mouseenter", (ev) => show(ev, slot));
      slot.addEventListener("mouseleave", hide);
    });
  }

  static _moveTooltip(ev) {
    const tip = document.querySelector(".wh-tooltip");
    if (!tip) return;

    const pad = 14;
    const x = ev.clientX + pad;
    const y = ev.clientY + pad;

    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  static _bindListeners(html, payload) {
    const root = html[0];

    // Zenit inputs → planning layer only
    const depositEl = root?.querySelector?.(".wh-input-deposit");
    const withdrawEl = root?.querySelector?.(".wh-input-withdraw");

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

    // Tooltip
    this._bindTooltip(root, payload);
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
        render: (htmlObj) => {
          payload.ui.appId = dlg?.appId ?? payload.ui.appId;
          this._bindListeners(htmlObj, payload);
        },
        close: () => {
          WarehouseDebug.log(payload, "UI", "Dialog closed", { instanceId: payload.ui.instanceId });
        }
      },
      { width: 900, height: "auto", resizable: true }
    );

    dlg.render(true);
    return payload;
  }
}
