// scripts/warehouse-system/warehouse-dnd.js
// ----------------------------------------------------------------------------
// ONI Warehouse — Drag & Drop (Planning only)
// - Custom ghost drag (no HTML5 drag)
// - Drop to opposite side -> quantity prompt
// - Writes planned move into payload.plan.itemMoves[]
// - Calls onChange() to rerender UI preview
// ----------------------------------------------------------------------------

import { WarehouseDebug } from "./warehouse-debug.js";

export class WarehouseDnD {
  static init(root, payload, { onChange } = {}) {
    if (!root) return;

    // Prevent double-binding
    if (payload.ui._dndBound) return;
    payload.ui._dndBound = true;

    payload.ui.activeTab = payload.ui.activeTab ?? { actor: "weapon", storage: "weapon" };

    const state = {
      dragging: false,
      originSlot: null,
      originSide: null,
      originUuid: null,
      originName: null,
      originType: null,
      originQty: 1,
      ghostEl: null
    };

    const makeGhost = (imgSrc) => {
      const g = document.createElement("img");
      g.className = "wh-ghost";
      g.src = imgSrc;
      g.style.position = "fixed";
      g.style.zIndex = "1000000";
      g.style.width = "44px";
      g.style.height = "44px";
      g.style.opacity = "0.65";
      g.style.pointerEvents = "none";
      g.style.borderRadius = "10px";
      g.style.boxShadow = "0 10px 25px rgba(0,0,0,0.35)";
      document.body.appendChild(g);
      return g;
    };

    const moveGhost = (ev) => {
      if (!state.ghostEl) return;
      const pad = 10;
      state.ghostEl.style.left = `${ev.clientX + pad}px`;
      state.ghostEl.style.top = `${ev.clientY + pad}px`;
    };

    const killGhost = () => {
      if (state.ghostEl?.parentNode) state.ghostEl.parentNode.removeChild(state.ghostEl);
      state.ghostEl = null;
    };

    const isValidDropTarget = (el) => {
      // We accept dropping anywhere inside the other side panel
      return !!el?.closest?.(".wh-panel");
    };

    const findDropSide = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const panel = el?.closest?.(".wh-panel");
      const side = panel?.dataset?.side;
      return side === "actor" || side === "storage" ? side : null;
    };

    const getVirtualQty = (side, itemUuid) => {
      // Start from snapshot, then apply planned moves
      const snapList = side === "actor" ? (payload.snapshot.actorItems ?? []) : (payload.snapshot.storageItems ?? []);
      const base = snapList.find(it => (it.itemUuid ?? it.uuid) === itemUuid);
      const baseQty = Number(base?.qty ?? 1);

      const moves = payload.plan?.itemMoves ?? [];
      let delta = 0;

      for (const m of moves) {
        if (m.itemUuid !== itemUuid) continue;

        if (m.from === side) delta -= Number(m.qty ?? 0);
        if (m.to === side) delta += Number(m.qty ?? 0);
      }

      return Math.max(0, baseQty + delta);
    };

    const pushPlannedMove = ({ from, to, itemUuid, itemName, itemType, qty }) => {
      payload.plan.itemMoves = payload.plan.itemMoves ?? [];

      payload.plan.itemMoves.push({
        id: crypto.randomUUID?.() ?? Math.random().toString(16).slice(2),
        ts: Date.now(),
        userId: payload.ctx.userId,
        from,
        to,
        itemUuid,
        itemName,
        itemType,
        qty
      });

      payload.plan.lastEditedAt = Date.now();
      payload.plan.lastEditedBy = payload.ctx.userId;

      WarehouseDebug.log(payload, "DND", "Planned move added", {
        from, to, itemName, itemUuid, qty,
        totalMoves: payload.plan.itemMoves.length
      });
    };

    const promptQuantity = async ({ max, defaultValue = 1 }) => {
      const safeMax = Math.max(1, Number(max ?? 1));
      const safeDefault = Math.min(safeMax, Math.max(1, Number(defaultValue ?? 1)));

      return await new Promise((resolve) => {
        const dlg = new Dialog({
          title: "Move Quantity",
          content: `
            <div style="display:flex; flex-direction:column; gap:10px;">
              <div>How many do you want to move?</div>
              <input class="wh-qty-input" type="number" min="1" max="${safeMax}" step="1" value="${safeDefault}"
                     style="width: 120px; padding: 6px 8px; border-radius: 8px;">
              <div style="opacity:0.75; font-size:12px;">Max: ${safeMax}</div>
            </div>
          `,
          buttons: {
            ok: {
              icon: '<i class="fas fa-check"></i>',
              label: "Confirm",
              callback: (html) => {
                const el = html[0].querySelector(".wh-qty-input");
                const v = Math.floor(Number(el?.value ?? safeDefault));
                const finalV = Math.max(1, Math.min(safeMax, Number.isFinite(v) ? v : safeDefault));
                resolve({ ok: true, qty: finalV });
              }
            },
            cancel: {
              icon: '<i class="fas fa-times"></i>',
              label: "Cancel",
              callback: () => resolve({ ok: false })
            }
          },
          default: "ok",
          close: () => resolve({ ok: false })
        }, { width: 360 });

        dlg.render(true);
      });
    };

    const beginDrag = (ev, slot) => {
      const side = slot.dataset.side;
      const uuid = slot.dataset.itemUuid;
      const name = slot.dataset.itemName;
      const type = slot.dataset.itemType;

      // Determine current available qty in planning space
      const available = getVirtualQty(side, uuid);
      if (available <= 0) {
        WarehouseDebug.warn(payload, "DND", "Drag blocked (qty=0)", { side, uuid, name });
        return;
      }

      state.dragging = true;
      state.originSlot = slot;
      state.originSide = side;
      state.originUuid = uuid;
      state.originName = name;
      state.originType = type;
      state.originQty = available;

      const imgEl = slot.querySelector("img");
      const imgSrc = imgEl?.src ?? "";

      state.ghostEl = makeGhost(imgSrc);
      moveGhost(ev);

      WarehouseDebug.log(payload, "DND", "Drag start", {
        side,
        uuid,
        name,
        available
      });
    };

    const endDrag = async (ev) => {
      if (!state.dragging) return;

      const dropSide = findDropSide(ev);
      const from = state.originSide;
      const to = dropSide;

      WarehouseDebug.log(payload, "DND", "Drag end", { from, to, name: state.originName });

      killGhost();
      state.dragging = false;

      // Drop invalid or same side -> do nothing
      if (!to || to === from) return;

      // Gate: compute max from the planning inventory
      const max = getVirtualQty(from, state.originUuid);
      if (max <= 0) {
        WarehouseDebug.warn(payload, "DND", "Drop blocked: no qty left in planning space", {
          from, to, uuid: state.originUuid
        });
        return;
      }

      // Prompt quantity
      const q = await promptQuantity({ max, defaultValue: 1 });
      if (!q.ok) {
        WarehouseDebug.log(payload, "DND", "Quantity cancelled", {});
        return;
      }

      // Add planned move
      pushPlannedMove({
        from,
        to,
        itemUuid: state.originUuid,
        itemName: state.originName,
        itemType: state.originType,
        qty: q.qty
      });

      // Notify rerender
      onChange?.();

      ui.notifications?.info?.(`Planned: Move ${q.qty} × ${state.originName}`);
    };

    // Pointer event wiring (delegation)
    root.addEventListener("pointerdown", (ev) => {
      const slot = ev.target?.closest?.(".oni-inv-slot.oni-item");
      if (!slot) return;

      // Left click only
      if (ev.button !== 0) return;

      // Prevent selecting text / dragging images
      ev.preventDefault();

      beginDrag(ev, slot);
      root.setPointerCapture?.(ev.pointerId);
    });

    root.addEventListener("pointermove", (ev) => {
      if (!state.dragging) return;
      moveGhost(ev);
    });

    root.addEventListener("pointerup", async (ev) => {
      if (!state.dragging) return;
      await endDrag(ev);
      root.releasePointerCapture?.(ev.pointerId);
    });

    root.addEventListener("pointercancel", () => {
      if (!state.dragging) return;
      killGhost();
      state.dragging = false;
      WarehouseDebug.warn(payload, "DND", "Drag cancelled", {});
    });

    // Safety cleanup if user closes dialog mid-drag
    window.addEventListener("blur", () => {
      if (!state.dragging) return;
      killGhost();
      state.dragging = false;
    });
  }
}
