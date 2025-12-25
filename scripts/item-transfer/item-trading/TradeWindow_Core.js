// ============================================================================
// DEMO_TradeWindow_Core
// Core logic for shared Trade Window – Foundry VTT v12
//
//  - Manages trade sessions in scene flags.
//  - Handles socket communication and GM-as-server behaviour.
//  - Finalizes trades by calling ItemTransferCore.transfer() on the GM.
//  - Exposes a namespace on globalThis: __OniTradeWindow__
//
// The actual UI (Application class, DOM, drag & drop) lives in
// DEMO_TradeWindow_UI, which registers its App class into this namespace.
//
// UPDATED (Quantity support):
//  - addOfferItem now includes item.quantity
//  - offers stack by itemUuid when possible
//  - finalize uses offer.quantity instead of always 1
// ============================================================================

(() => {
  console.log("[OniTradeWindow_Core] BOOT file parsed. user:", game?.user?.id, "isGM:", game?.user?.isGM);

  const install = () => {
    const NS         = "__OniTradeWindow__";
    const FLAG_SCOPE = "world";
    const FLAG_KEY   = "oniTradeSessions";  // { [requestId]: sessionData }

    const MODULE_ID  = "fabula-ultima-companion";
    const CHANNEL    = `module.${MODULE_ID}`;

    const isGM  = () => game.user?.isGM;
    const scene = () => canvas?.scene;

    // Simple escaper for HTML
    const esc = (v) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    // Guard: need socket
    if (!game.socket) {
      console.error("[OniTradeWindow_Core] game.socket is NOT available on user", game.user?.id);
      ui.notifications?.error?.("OniTradeWindow_Core: game.socket is not available.");
      return;
    }

    const GLOBAL = (globalThis[NS] = globalThis[NS] || {});
    GLOBAL.apps       = GLOBAL.apps || {};
    GLOBAL.AppClass   = GLOBAL.AppClass || null;  // set by UI script
    GLOBAL.readAllSessions = GLOBAL.readAllSessions || null;
    GLOBAL.requestOp       = GLOBAL.requestOp || null;
    GLOBAL.esc             = GLOBAL.esc || esc;

    console.log(
      "=== [OniTradeWindow_Core] Install on user",
      game.user.id,
      "isGM:",
      game.user.isGM,
      "==="
    );

    // ---------------------------------------------------------------------------
    // Scene flag helpers
    // ---------------------------------------------------------------------------
    async function readSessions() {
      const s = scene();
      if (!s) return {};
      return (s.getFlag(FLAG_SCOPE, FLAG_KEY) ?? {});
    }

    async function writeSessions(sessions) {
      const s = scene();
      if (!s) return;
      await s.setFlag(FLAG_SCOPE, FLAG_KEY, sessions);
    }

    async function getSession(requestId) {
      const sessions = await readSessions();
      return sessions?.[requestId] ?? null;
    }

    async function setSession(requestId, sessionData) {
      const sessions = await readSessions();
      sessions[requestId] = sessionData;
      await writeSessions(sessions);
    }

    async function deleteSession(requestId) {
      const sessions = await readSessions();
      if (sessions && sessions[requestId]) {
        delete sessions[requestId];
        await writeSessions(sessions);
      }
    }

    // ---------------------------------------------------------------------------
    // Session model
    // ---------------------------------------------------------------------------
    function makeEmptySession({
      requestId,
      initiatorUserId,
      targetUserId,
      initiatorName,
      targetName,
      initiatorActorUuid,
      targetActorUuid
    }) {
      return {
        requestId,
        createdAt: Date.now(),

        initiatorUserId,
        targetUserId,
        initiatorName,
        targetName,
        initiatorActorUuid,
        targetActorUuid,

        offers: {
          initiator: [],
          target: []
        },

        zenit: {
          initiator: 0,
          target: 0
        },

        confirmed: {
          initiator: false,
          target: false
        },

        cancelledBy: null,
        settled: false
      };
    }

    // ---------------------------------------------------------------------------
    // Offer helpers (Quantity support)
    // ---------------------------------------------------------------------------
    function normalizePositiveInt(n, fallback = 1) {
      const x = Number(n);
      if (!Number.isFinite(x)) return fallback;
      const i = Math.floor(x);
      return i > 0 ? i : fallback;
    }

    function addOfferItem(session, side, offerItem) {
      const qty = normalizePositiveInt(offerItem?.quantity, 1);

      const list = session.offers[side] || [];
      const itemUuid = offerItem.itemUuid ?? null;

      // Stack by itemUuid when possible
      if (itemUuid) {
        const found = list.find((o) => o.itemUuid === itemUuid);
        if (found) {
          found.quantity = normalizePositiveInt(found.quantity, 1) + qty;
          return;
        }
      }

      list.push({
        itemUuid: offerItem.itemUuid ?? null,
        itemName: offerItem.itemName ?? "Unknown Item",
        img: offerItem.img ?? null,
        quantity: qty
      });
      session.offers[side] = list;
    }

    function removeOfferItem(session, side, idx) {
      const list = session.offers[side] || [];
      if (idx < 0 || idx >= list.length) return;
      list.splice(idx, 1);
      session.offers[side] = list;
    }

    function setZenitOffer(session, side, amount) {
      const amt = Math.max(0, Math.floor(Number(amount) || 0));
      session.zenit[side] = amt;
    }

    function setConfirmed(session, side, value) {
      session.confirmed[side] = !!value;
    }

    // ---------------------------------------------------------------------------
    // Public API: read all sessions
    // ---------------------------------------------------------------------------
    async function readAllSessions() {
      return await readSessions();
    }

    // ---------------------------------------------------------------------------
    // Operation routing (GM-as-server)
    // ---------------------------------------------------------------------------
    async function requestOp(payload) {
      // Everyone sends requests to GM; GM applies authoritative changes
      game.socket.emit(CHANNEL, {
        type: "OniTradeWindow_Op",
        payload
      });
    }

    async function applyOpAsGM(payload) {
      const {
        requestId,
        op,
        side,
        initiatorUserId,
        targetUserId,
        initiatorName,
        targetName,
        initiatorActorUuid,
        targetActorUuid
      } = payload;

      if (!requestId || !op) return;

      if (op === "initSession") {
        const session = makeEmptySession({
          requestId,
          initiatorUserId,
          targetUserId,
          initiatorName,
          targetName,
          initiatorActorUuid,
          targetActorUuid
        });

        await setSession(requestId, session);

        game.socket.emit(CHANNEL, {
          type: "OniTradeWindow_SessionUpdated",
          payload: { requestId }
        });

        return;
      }

      // For all other ops, load existing session
      const session = await getSession(requestId);
      if (!session) return;

      // If cancelled/settled, ignore further ops
      if (session.cancelledBy || session.settled) {
        return;
      }

      // Any change resets confirmations (classic MMO trade window behavior)
      if (
        op === "addOfferItem" ||
        op === "removeOfferItem" ||
        op === "setZenitOffer"
      ) {
        session.confirmed.initiator = false;
        session.confirmed.target = false;
      }

      switch (op) {
        case "addOfferItem": {
          if (!side) return;
          const offerItem = payload.offerItem;
          if (!offerItem) return;
          addOfferItem(session, side, offerItem);
          break;
        }

        case "removeOfferItem": {
          if (!side) return;
          const idx = Number(payload.idx);
          if (!Number.isFinite(idx)) return;
          removeOfferItem(session, side, idx);
          break;
        }

        case "setZenitOffer": {
          if (!side) return;
          setZenitOffer(session, side, payload.amount);
          break;
        }

        case "setConfirmed": {
          if (!side) return;
          setConfirmed(session, side, payload.value);
          break;
        }

        case "cancel": {
          if (!side) return;
          session.cancelledBy = side;
          break;
        }

        case "finalize": {
          // Only finalize if both confirmed
          if (!(session.confirmed.initiator && session.confirmed.target)) {
            return;
          }

          // Mark settled first to prevent double-finalize
          session.settled = true;

          // Execute transfers on GM
          await finalizeTradeOnGM(session);
          break;
        }

        default:
          break;
      }

      await setSession(requestId, session);

      game.socket.emit(CHANNEL, {
        type: "OniTradeWindow_SessionUpdated",
        payload: { requestId }
      });
    }

    // ---------------------------------------------------------------------------
    // Finalization (GM only)
    // ---------------------------------------------------------------------------
    async function finalizeTradeOnGM(session) {
      const initiatorActor = await fromUuid(session.initiatorActorUuid);
      const targetActor    = await fromUuid(session.targetActorUuid);

      if (!initiatorActor || !targetActor) {
        console.error("[OniTradeWindow_Core] finalize failed, actors not found", {
          initiatorActorUuid: session.initiatorActorUuid,
          targetActorUuid: session.targetActorUuid
        });
        return;
      }

      const ItemTransferCore = globalThis.oni?.ItemTransferCore;
      if (!ItemTransferCore || typeof ItemTransferCore.transfer !== "function") {
        console.error("[OniTradeWindow_Core] ItemTransferCore.transfer not available.");
        return;
      }

      // 1) Items: initiator -> target
      for (const offer of session.offers.initiator || []) {
        if (!offer.itemUuid) continue;
        await ItemTransferCore.transfer({
          sourceActorUuid: session.initiatorActorUuid,
          targetActorUuid: session.targetActorUuid,
          itemUuid: offer.itemUuid,
          quantity: normalizePositiveInt(offer.quantity, 1),
          reason: "trade"
        });
      }

      // 2) Items: target -> initiator
      for (const offer of session.offers.target || []) {
        if (!offer.itemUuid) continue;
        await ItemTransferCore.transfer({
          sourceActorUuid: session.targetActorUuid,
          targetActorUuid: session.initiatorActorUuid,
          itemUuid: offer.itemUuid,
          quantity: normalizePositiveInt(offer.quantity, 1),
          reason: "trade"
        });
      }

      // 3) Zenit: initiator -> target
      const ZenitHandler = globalThis.oni?.ZenitHandler;
      if (ZenitHandler && typeof ZenitHandler.transferZenit === "function") {
        const zi = Math.max(0, Math.floor(Number(session.zenit.initiator) || 0));
        if (zi > 0) {
          await ZenitHandler.transferZenit({
            sourceActorUuid: session.initiatorActorUuid,
            targetActorUuid: session.targetActorUuid,
            amount: zi,
            reason: "trade"
          });
        }

        // 4) Zenit: target -> initiator
        const zt = Math.max(0, Math.floor(Number(session.zenit.target) || 0));
        if (zt > 0) {
          await ZenitHandler.transferZenit({
            sourceActorUuid: session.targetActorUuid,
            targetActorUuid: session.initiatorActorUuid,
            amount: zt,
            reason: "trade"
          });
        }
      } else {
        console.warn("[OniTradeWindow_Core] ZenitHandler.transferZenit not available; skipping zenit transfer.");
      }

      // Optional: cleanup session
      // await deleteSession(session.requestId);
    }

    // ---------------------------------------------------------------------------
    // Socket handler
    // ---------------------------------------------------------------------------
    const socketHandler = async (data) => {
      if (!data || typeof data !== "object") return;
      const { type, payload } = data;
      if (!type) return;

      switch (type) {
        case "OniTradeWindow_Op": {
          // Only GM applies ops
          if (!isGM()) return;
          await applyOpAsGM(payload);
          break;
        }

        case "OniTradeWindow_SessionUpdated": {
          const requestId = payload?.requestId;
          if (!requestId) return;

          // Notify local UI instance if open
          const app = GLOBAL.apps?.[requestId];
          if (app && typeof app.onSessionUpdated === "function") {
            try {
              await app.onSessionUpdated();
            } catch (err) {
              console.error("[OniTradeWindow_Core] app.onSessionUpdated error:", err);
            }
          }
          break;
        }

        default:
          break;
      }
    };

    game.socket.on(CHANNEL, socketHandler);

    // ---------------------------------------------------------------------------
    // Public API: open the trade window for a session (called when trade accepted)
    // ---------------------------------------------------------------------------
    GLOBAL.openTradeWindowForSession = async ({
      requestId,
      initiatorUserId,
      targetUserId,
      initiatorName,
      targetName,
      initiatorActorUuid,
      targetActorUuid
    }) => {
      const AppClass = GLOBAL.AppClass;
      if (!AppClass) {
        ui.notifications?.warn?.("OniTradeWindow: UI not installed yet.");
        console.warn("[OniTradeWindow_Core] GLOBAL.AppClass is null. Did TradeWindow_UI load?");
        return;
      }

      let app = GLOBAL.apps[requestId];
      if (app && app instanceof AppClass) {
        app.bringToTop();
        return;
      }

      app = new AppClass({
        requestId,
        initiatorUserId,
        targetUserId,
        initiatorName,
        targetName,
        initiatorActorUuid,
        targetActorUuid
      });

      GLOBAL.apps[requestId] = app;
      app.render(true);

      requestOp({
        requestId,
        op: "initSession",
        initiatorUserId,
        targetUserId,
        initiatorName,
        targetName,
        initiatorActorUuid,
        targetActorUuid
      });
    };

    GLOBAL.readAllSessions = readAllSessions;
    GLOBAL.requestOp       = requestOp;
    GLOBAL.esc             = esc;

    console.log("[OniTradeWindow_Core] API installed at globalThis.__OniTradeWindow__.");
    GLOBAL.installed = true;
  };

  Hooks.once("ready", () => {
    console.log("[OniTradeWindow_Core] READY -> installing. user:", game.user?.id, "isGM:", game.user?.isGM, "hasSocket:", !!game.socket);
    install();
  });
})();
