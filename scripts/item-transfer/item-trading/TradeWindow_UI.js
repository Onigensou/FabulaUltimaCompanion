// ============================================================================
// DEMO_TradeWindow_UI
// UI for shared Trade Window – Foundry VTT v12
//
// UPDATED (Quantity support):
//  - Drag-drop now prompts quantity via ItemTransferQuantityUI if available
//  - Offer list displays "xN"
// ============================================================================

(() => {
  console.log("[OniTradeWindow_UI] BOOT file parsed. user:", game?.user?.id, "isGM:", game?.user?.isGM);

  const install = () => {
    const NS     = "__OniTradeWindow__";
    const GLOBAL = (globalThis[NS] = globalThis[NS] || {});

    const readAllSessions = GLOBAL.readAllSessions;
    const requestOp       = GLOBAL.requestOp;
    const esc             = GLOBAL.esc || ((v) => String(v ?? ""));

    if (!readAllSessions || !requestOp) {
      console.warn(
        "[OniTradeWindow_UI] Core helpers not available yet. " +
        "Make sure DEMO_TradeWindow_Core is loaded on this client."
      );
    }

    console.log(
      "=== [OniTradeWindow_UI] Install on user",
      game.user.id,
      "isGM:",
      game.user.isGM,
      "==="
    );

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    function normalizePositiveInt(n, fallback = 1) {
      const x = Number(n);
      if (!Number.isFinite(x)) return fallback;
      const i = Math.floor(x);
      return i > 0 ? i : fallback;
    }

    async function promptQuantityIfAvailable(itemName) {
      const QuantityUI = globalThis.oni?.ItemTransferQuantityUI;
      if (!QuantityUI || typeof QuantityUI.promptQuantity !== "function") return 1;

      try {
        const qty = await QuantityUI.promptQuantity({
          title: "Trade Quantity",
          label: `How many <strong>${esc(itemName)}</strong> do you want to offer?`,
          min: 1,
          max: 9999,
          defaultValue: 1
        });

        return normalizePositiveInt(qty, 1);
      } catch (err) {
        console.warn("[OniTradeWindow_UI] Quantity prompt cancelled or failed.", err);
        return null;
      }
    }

    async function buildOfferItemFromDragData(dragData) {
      if (!dragData) return null;

      // In Foundry, dragData typically includes: { type, uuid, ... }
      const uuid = dragData.uuid;
      if (!uuid) return null;

      const doc = await fromUuid(uuid);
      if (!doc) return null;

      const itemName = doc.name ?? "Unknown Item";
      const img = doc.img ?? null;

      // Quantity prompt (if available)
      const qty = await promptQuantityIfAvailable(itemName);
      if (qty == null) return null;

      return {
        itemUuid: uuid,
        itemName,
        img,
        quantity: qty
      };
    }

    function isLocalUserInitiator(app) {
      return game.user.id === app.initiatorUserId;
    }

    function getLocalSide(app) {
      return isLocalUserInitiator(app) ? "initiator" : "target";
    }

    function getOtherSide(app) {
      return isLocalUserInitiator(app) ? "target" : "initiator";
    }

    function formatZenit(n) {
      const x = Math.max(0, Math.floor(Number(n) || 0));
      return x.toString();
    }

    // ---------------------------------------------------------------------------
    // Application
    // ---------------------------------------------------------------------------

    class OniTradeWindowApp extends Application {
      constructor({
        requestId,
        initiatorUserId,
        targetUserId,
        initiatorName,
        targetName,
        initiatorActorUuid,
        targetActorUuid
      }) {
        super();

        this.requestId = requestId;
        this.initiatorUserId = initiatorUserId;
        this.targetUserId = targetUserId;
        this.initiatorName = initiatorName;
        this.targetName = targetName;
        this.initiatorActorUuid = initiatorActorUuid;
        this.targetActorUuid = targetActorUuid;

        this.localSide = getLocalSide(this);

        this._lastSessionJson = null;
      }

      static get defaultOptions() {
        const opts = super.defaultOptions;
        opts.id = "oni-trade-window";
        opts.title = "Trade";
        opts.width = 720;
        opts.height = 540;
        opts.resizable = true;
        opts.classes = ["oni-trade-window"];
        return opts;
      }

      async getData() {
        const sessions = (await readAllSessions?.()) ?? {};
        const session = sessions?.[this.requestId] ?? null;

        return {
          requestId: this.requestId,
          session
        };
      }

      async onSessionUpdated() {
        // Re-render only if data changed to reduce spam
        const data = await this.getData();
        const json = JSON.stringify(data.session ?? null);

        if (json === this._lastSessionJson) return;
        this._lastSessionJson = json;

        this.render(false);
      }

      activateListeners(html) {
        super.activateListeners(html);

        const root = html[0];

        // Drag target for local offer list
        const offerDropZone = root.querySelector(".oni-trade-offer-dropzone");
        if (offerDropZone) {
          offerDropZone.addEventListener("dragover", (ev) => {
            ev.preventDefault();
          });

          offerDropZone.addEventListener("drop", async (ev) => {
            ev.preventDefault();

            let dragData = null;
            try {
              dragData = JSON.parse(ev.dataTransfer.getData("text/plain"));
            } catch (err) {
              console.warn("[OniTradeWindow_UI] Failed to parse drag data.", err);
              return;
            }

            const offerItem = await buildOfferItemFromDragData(dragData);
            if (!offerItem) return;

            await requestOp({
              requestId: this.requestId,
              op: "addOfferItem",
              side: this.localSide,
              initiatorUserId: this.initiatorUserId,
              targetUserId: this.targetUserId,
              initiatorName: this.initiatorName,
              targetName: this.targetName,
              initiatorActorUuid: this.initiatorActorUuid,
              targetActorUuid: this.targetActorUuid,
              offerItem
            });
          });
        }

        // Remove offer item buttons (local side only)
        root.querySelectorAll("[data-oni-remove-offer]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const idx = Number(btn.getAttribute("data-oni-remove-offer"));
            if (!Number.isFinite(idx)) return;

            await requestOp({
              requestId: this.requestId,
              op: "removeOfferItem",
              side: this.localSide,
              initiatorUserId: this.initiatorUserId,
              targetUserId: this.targetUserId,
              initiatorName: this.initiatorName,
              targetName: this.targetName,
              initiatorActorUuid: this.initiatorActorUuid,
              targetActorUuid: this.targetActorUuid,
              idx
            });
          });
        });

        // Confirm
        const btnConfirm = root.querySelector(".oni-trade-confirm");
        if (btnConfirm) {
          btnConfirm.addEventListener("click", async () => {
            await requestOp({
              requestId: this.requestId,
              op: "setConfirmed",
              side: this.localSide,
              initiatorUserId: this.initiatorUserId,
              targetUserId: this.targetUserId,
              initiatorName: this.initiatorName,
              targetName: this.targetName,
              initiatorActorUuid: this.initiatorActorUuid,
              targetActorUuid: this.targetActorUuid,
              value: true
            });

            // If both confirmed, ask GM to finalize
            await requestOp({
              requestId: this.requestId,
              op: "finalize",
              initiatorUserId: this.initiatorUserId,
              targetUserId: this.targetUserId,
              initiatorName: this.initiatorName,
              targetName: this.targetName,
              initiatorActorUuid: this.initiatorActorUuid,
              targetActorUuid: this.targetActorUuid
            });
          });
        }

        // Cancel
        const btnCancel = root.querySelector(".oni-trade-cancel");
        if (btnCancel) {
          btnCancel.addEventListener("click", async () => {
            await requestOp({
              requestId: this.requestId,
              op: "cancel",
              side: this.localSide,
              initiatorUserId: this.initiatorUserId,
              targetUserId: this.targetUserId,
              initiatorName: this.initiatorName,
              targetName: this.targetName,
              initiatorActorUuid: this.initiatorActorUuid,
              targetActorUuid: this.targetActorUuid
            });
          });
        }

        // Zenit input
        const zenitInput = root.querySelector(".oni-trade-zenit-input");
        if (zenitInput) {
          zenitInput.addEventListener("change", async () => {
            const amt = Math.max(0, Math.floor(Number(zenitInput.value) || 0));

            await requestOp({
              requestId: this.requestId,
              op: "setZenitOffer",
              side: this.localSide,
              initiatorUserId: this.initiatorUserId,
              targetUserId: this.targetUserId,
              initiatorName: this.initiatorName,
              targetName: this.targetName,
              initiatorActorUuid: this.initiatorActorUuid,
              targetActorUuid: this.targetActorUuid,
              amount: amt
            });
          });
        }
      }

      async _renderInner(data) {
        const session = data?.session ?? null;

        const initiatorName = esc(session?.initiatorName ?? this.initiatorName ?? "Initiator");
        const targetName    = esc(session?.targetName ?? this.targetName ?? "Target");

        const localSide = this.localSide;
        const otherSide = getOtherSide(this);

        const offersLocal = session?.offers?.[localSide] ?? [];
        const offersOther = session?.offers?.[otherSide] ?? [];

        const zenitLocal = formatZenit(session?.zenit?.[localSide] ?? 0);
        const confirmedInitiator = !!session?.confirmed?.initiator;
        const confirmedTarget    = !!session?.confirmed?.target;
        const cancelledBySide    = session?.cancelledBy ?? null;
        const settled            = !!session?.settled;

        // Root
        const root = document.createElement("div");
        root.classList.add("oni-trade-root");

        // Header
        const header = document.createElement("div");
        header.classList.add("oni-trade-header");
        header.innerHTML = `
          <div class="oni-trade-title">
            <strong>Trade</strong>
          </div>
          <div class="oni-trade-partners">
            <span>${initiatorName}</span>
            <span style="margin:0 6px;">⇄</span>
            <span>${targetName}</span>
          </div>
        `;

        // Body (two columns)
        const body = document.createElement("div");
        body.classList.add("oni-trade-body");

        const colLocal = document.createElement("div");
        colLocal.classList.add("oni-trade-col");

        const colOther = document.createElement("div");
        colOther.classList.add("oni-trade-col");

        // Local column
        const localLabel = document.createElement("div");
        localLabel.classList.add("oni-trade-col-title");
        localLabel.innerHTML = `<strong>Your Offer</strong>`;

        const localDrop = document.createElement("div");
        localDrop.classList.add("oni-trade-offer-dropzone");
        localDrop.innerHTML = `<em>Drop items here</em>`;

        const localList = document.createElement("div");
        localList.classList.add("oni-trade-offer-list");

        offersLocal.forEach((o, idx) => {
          const row = document.createElement("div");
          row.classList.add("oni-trade-offer-row");

          const img = document.createElement("img");
          img.classList.add("oni-trade-offer-img");
          img.src = o.img ?? "icons/svg/item-bag.svg";

          const name = document.createElement("div");
          name.classList.add("oni-trade-offer-name");
          const qty = normalizePositiveInt(o.quantity, 1);
          name.innerHTML = `${esc(o.itemName ?? "Item")} <span class="oni-trade-offer-qty">x${qty}</span>`;

          const remove = document.createElement("button");
          remove.type = "button";
          remove.classList.add("oni-trade-offer-remove");
          remove.setAttribute("data-oni-remove-offer", String(idx));
          remove.textContent = "✕";

          row.append(img, name, remove);
          localList.append(row);
        });

        // Zenit input row
        const zenitRow = document.createElement("div");
        zenitRow.classList.add("oni-trade-zenit-row");
        zenitRow.innerHTML = `
          <label class="oni-trade-zenit-label"><strong>Zenit</strong></label>
        `;

        const zenitInput = document.createElement("input");
        zenitInput.type = "number";
        zenitInput.classList.add("oni-trade-zenit-input");
        zenitInput.min = "0";
        zenitInput.step = "1";
        zenitInput.value = zenitLocal;

        zenitRow.append(zenitInput);

        // Buttons
        const btnRow = document.createElement("div");
        btnRow.classList.add("oni-trade-btn-row");

        const btnConfirm = document.createElement("button");
        btnConfirm.type = "button";
        btnConfirm.classList.add("oni-trade-confirm");
        btnConfirm.textContent = "Confirm";

        const btnCancel = document.createElement("button");
        btnCancel.type = "button";
        btnCancel.classList.add("oni-trade-cancel");
        btnCancel.textContent = "Cancel";

        btnRow.append(btnConfirm, btnCancel);

        colLocal.append(localLabel, localDrop, localList, zenitRow, btnRow);

        // Other column
        const otherLabel = document.createElement("div");
        otherLabel.classList.add("oni-trade-col-title");
        otherLabel.innerHTML = `<strong>Their Offer</strong>`;

        const otherList = document.createElement("div");
        otherList.classList.add("oni-trade-offer-list");

        offersOther.forEach((o) => {
          const row = document.createElement("div");
          row.classList.add("oni-trade-offer-row");

          const img = document.createElement("img");
          img.classList.add("oni-trade-offer-img");
          img.src = o.img ?? "icons/svg/item-bag.svg";

          const name = document.createElement("div");
          name.classList.add("oni-trade-offer-name");
          const qty = normalizePositiveInt(o.quantity, 1);
          name.innerHTML = `${esc(o.itemName ?? "Item")} <span class="oni-trade-offer-qty">x${qty}</span>`;

          row.append(img, name);
          otherList.append(row);
        });

        const otherZenit = document.createElement("div");
        otherZenit.classList.add("oni-trade-zenit-row");
        const otherZenitVal = formatZenit(session?.zenit?.[otherSide] ?? 0);
        otherZenit.innerHTML = `<label class="oni-trade-zenit-label"><strong>Zenit</strong></label><div>${otherZenitVal}</div>`;

        colOther.append(otherLabel, otherList, otherZenit);

        body.append(colLocal, colOther);

        // Footer status
        const footer = document.createElement("div");
        footer.classList.add("oni-trade-footer");

        if (cancelledBySide) {
          footer.classList.add("oni-trade-status-cancel");
          const who =
            cancelledBySide === "initiator"
              ? initiatorName
              : cancelledBySide === "target"
              ? targetName
              : "Someone";
          footer.innerHTML = `Trade has been cancelled by <strong>${esc(who)}</strong>.`;
        } else if (settled) {
          footer.classList.add("oni-trade-status-ok");
          footer.textContent = "Trade completed. Items and Zenit have been transferred.";
        } else if (confirmedInitiator && confirmedTarget) {
          footer.classList.add("oni-trade-status-ok");
          footer.textContent = "Both sides have confirmed. Finalizing trade...";
        } else {
          footer.classList.add("oni-trade-status-wait");
          footer.textContent = "Drag items into your side, set your Zenit offer, and confirm when ready.";
        }

        root.append(header, body, footer);
        return $(root);
      }
    }

    GLOBAL.AppClass = OniTradeWindowApp;
    GLOBAL.uiInstalled = true;
    console.log("[OniTradeWindow_UI] AppClass registered into __OniTradeWindow__.");
  };

  Hooks.once("ready", () => {
    console.log("[OniTradeWindow_UI] READY -> installing. user:", game.user?.id, "isGM:", game.user?.isGM, "hasSocket:", !!game.socket);
    install();
  });
})();
