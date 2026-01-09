/**
 * Dialog + Examine UI (MODULE VERSION) — Foundry VTT v12
 * -----------------------------------------------------------------------------
 * What this does:
 * - Installs a socket listener on every client (GM + players)
 * - Supports TWO UI features via socket messages:
 *
 *   (A) Dialog Bubble:
 *       type: "FU_DIALOG_TEST_SHOW_V1"
 *       payload: { sceneId, tokenId, name?, text, speed?, mode?, bubbleId?, targetUserIds? }
 *
 *   (B) Examine Indicator (! button):
 *       type: "ONI_EXAMINE_ICON_V1"
 *       payload: { sceneId, tokenId, tileId, mode:"enter"|"exit", speakerName?, text?, speed?, bubbleMode?, targetUserIds? }
 *
 * - Safe to auto-run every session: it de-dupes installation using a global store.
 *
 * IMPORTANT:
 * - MODULE_ID must match your module.json "id".
 */

/* eslint-disable no-unused-vars */

Hooks.once("ready", () => {
  (async () => {
    // =======================
    // Inline tuners
    // =======================
    const DEBUG = false;

    // ✅ Must match your module id in module.json
    const MODULE_ID = "fabula-ultima-companion";
    const CHANNEL = `module.${MODULE_ID}`;

    // Socket message types
    const MSG_DIALOG_SHOW = "FU_DIALOG_TEST_SHOW_V1";
    const MSG_PING        = "FU_DIALOG_TEST_PING_V1";
    const MSG_EXAMINE     = "ONI_EXAMINE_ICON_V1";

    // DOM ids / globals
    const STYLE_ID = "oni-dialog-style-v1";
    const LAYER_ID = "oni-dialog-layer-v1";

    const EX_STYLE_ID = "oni-examine-style-v1";
    const EX_LAYER_ID = "oni-examine-layer-v1";

    const STORE_KEY = "__ONI_DIALOG_EXAMINE_UI__";

    // Dedupe tuning
    const SEEN_LIMIT = 600;

    const log  = (...a) => DEBUG && console.log("%c[ONI UI]", "color:#7dd3fc", ...a);
    const warn = (...a) => console.warn("%c[ONI UI]", "color:#fbbf24", ...a);
    const err  = (...a) => console.error("%c[ONI UI]", "color:#fb7185", ...a);

    function htmlEscape(v) {
      const d = document.createElement("div");
      d.textContent = (v ?? "").toString();
      return d.innerHTML;
    }

    const store = (globalThis[STORE_KEY] ??= {
      installed: false,
      handler: null,

      // bubbleId dedupe
      seen: new Set(),
      seenOrder: [],

      // examine icons by tokenId -> tileId -> handle
      examine: { byToken: {} },
    });

    function rememberSeen(id) {
      if (!id) return;
      if (store.seen.has(id)) return;
      store.seen.add(id);
      store.seenOrder.push(id);
      while (store.seenOrder.length > SEEN_LIMIT) {
        const old = store.seenOrder.shift();
        store.seen.delete(old);
      }
    }

    function ensureDialogCSS() {
      if (document.getElementById(STYLE_ID)) return;

      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
#${LAYER_ID} { position: fixed; inset: 0; pointer-events: none; z-index: 100000;
  font-family: "Signika", system-ui, sans-serif; }
.oni-bubble { position: absolute; pointer-events: auto; max-width: min(520px, 92vw); min-width: 380px;
  background: #e8e0cf; color: #2b261f; border-radius: 18px; box-shadow: 0 8px 16px rgba(0,0,0,.35);
  overflow: hidden; transform-origin: 64px calc(100% + 12px); }
.oni-enter { animation: oniGrow .18s ease-out both; }
.oni-exit  { animation: oniShrink .15s ease-in both; }
@keyframes oniGrow { from { transform: scale(.75); opacity:0 } to { transform:scale(1); opacity:1 } }
@keyframes oniShrink { from { transform: scale(1); opacity:1 } to { transform:scale(.75); opacity:0 } }
.oni-head { padding: 12px 16px 6px; font-weight: 700; font-size: 1.05rem; }
.oni-body { padding: 0 16px 14px; font-size: 1.05rem; line-height: 1.5; min-height: 2.7em; white-space: pre-wrap; }
.oni-tail { position:absolute; bottom:-16px; left:48px; width:0;height:0;
  border-left:14px solid transparent; border-right:14px solid transparent; border-top:16px solid #e8e0cf;
  filter: drop-shadow(0 -2px 0 rgba(0,0,0,.08)); }
.oni-mode-shout { background: #fffdf6; box-shadow: 0 0 0 3px #15110a, 0 10px 16px rgba(0,0,0,.35); }
.oni-mode-think { background: #fffdf6; box-shadow: 0 0 0 3px #15110a, 0 8px 14px rgba(0,0,0,.28); }
.oni-mode-shout .oni-tail { display:none; }
.oni-mode-think .oni-tail { display:none; }
.oni-hint { padding: 0 16px 12px; font-size: .85rem; opacity: .75; }
      `;
      document.head.appendChild(style);
      log("Dialog CSS injected:", STYLE_ID);
    }

    function ensureDialogLayer() {
      let layer = document.getElementById(LAYER_ID);
      if (!layer) {
        layer = document.createElement("div");
        layer.id = LAYER_ID;
        document.body.appendChild(layer);
        log("Dialog layer created:", LAYER_ID);
      }
      return layer;
    }

    function ensureExamineCSS() {
      if (document.getElementById(EX_STYLE_ID)) return;

      const style = document.createElement("style");
      style.id = EX_STYLE_ID;
      style.textContent = `
#${EX_LAYER_ID}{ position: fixed; inset: 0; pointer-events: none; z-index: 100001; }
.oni-ex-btn{
  position: absolute; pointer-events: auto;
  width: 34px; height: 34px; display: grid; place-items: center;
  background: rgba(255,255,255,0.95);
  border: 2px solid rgba(0,0,0,0.75);
  border-radius: 999px;
  box-shadow: 0 6px 10px rgba(0,0,0,0.35);
  cursor: pointer; user-select: none;
  transform-origin: 50% 100%;
}
.oni-ex-btn .mark{
  font-family: "Cinzel","Signika",var(--font-primary,"Signika"),system-ui,sans-serif;
  font-weight: 900; font-size: 20px; line-height: 1;
  color: rgba(20,16,10,0.95);
  transform: translateY(-1px);
}
.oni-ex-enter{ animation: oniExIn .16s ease-out both; }
@keyframes oniExIn{ from{ transform: scale(0.75); opacity: 0; } to{ transform: scale(1.00); opacity: 1; } }
.oni-ex-exit{ animation: oniExOut .14s ease-in both; }
@keyframes oniExOut{ from{ transform: scale(1.00); opacity: 1; } to{ transform: scale(0.78); opacity: 0; } }
.oni-ex-hidden{ opacity: 0 !important; transform: scale(0.92) !important; pointer-events: none !important; }
      `;
      document.head.appendChild(style);
      log("Examine CSS injected:", EX_STYLE_ID);
    }

    function ensureExamineLayer() {
      let layer = document.getElementById(EX_LAYER_ID);
      if (!layer) {
        layer = document.createElement("div");
        layer.id = EX_LAYER_ID;
        document.body.appendChild(layer);
        log("Examine layer created:", EX_LAYER_ID);
      }
      return layer;
    }

    function getCanvasToken(tokenId) {
      return canvas?.tokens?.get?.(tokenId) ?? canvas?.tokens?.placeables?.find?.(t => t?.document?.id === tokenId);
    }

    function canvasToScreenPoint(canvasX, canvasY) {
      const pt = new PIXI.Point(canvasX, canvasY);
      const global = canvas.app.stage.toGlobal(pt);
      const rect = canvas.app.view.getBoundingClientRect();
      return { x: rect.left + global.x, y: rect.top + global.y };
    }

    async function waitCanvasReady(timeoutMs = 3000) {
      const start = Date.now();
      while (!canvas?.ready) {
        await new Promise(r => setTimeout(r, 50));
        if (Date.now() - start > timeoutMs) break;
      }
      return !!canvas?.ready;
    }

    function shouldRenderForMe(payload) {
      // If targetUserIds is present, only render for those users.
      const list = payload?.targetUserIds;
      if (Array.isArray(list) && list.length) return list.includes(game.user.id);
      return true; // default: render for everyone on the scene
    }

    // =========================================================================
    // Dialog Bubble renderer (returns a close() handle)
    // =========================================================================
    async function renderDialogBubble(payload, { remote = false, onClose = null } = {}) {
      ensureDialogCSS();
      const layer = ensureDialogLayer();

      const mySceneId = canvas?.scene?.id;
      log("renderDialogBubble", { remote, mySceneId, sceneId: payload.sceneId, tokenId: payload.tokenId });

      // Only show if the receiving client is on the same scene as payload
      if (!mySceneId || mySceneId !== payload.sceneId) return;

      const token = getCanvasToken(payload.tokenId);
      if (!token) {
        warn("Dialog: token not found on this client canvas", payload.tokenId);
        return;
      }

      const bubbleId = payload.bubbleId ?? `oni-${Math.random().toString(36).slice(2)}`;
      const mode = payload.mode ?? "normal";
      const speed = Math.max(1, Number(payload.speed ?? 28));

      const el = document.createElement("div");
      el.className = "oni-bubble oni-enter";
      if (mode === "shout") el.classList.add("oni-mode-shout");
      if (mode === "think") el.classList.add("oni-mode-think");
      el.dataset.bubbleId = bubbleId;

      el.innerHTML = `
        <div class="oni-head">${htmlEscape(payload.name ?? token.document?.name ?? "Speaker")}</div>
        <div class="oni-body"><span class="oni-typed"></span></div>
        <div class="oni-hint">(Click: fast-forward / close)</div>
        <div class="oni-tail"></div>
      `;
      layer.appendChild(el);

      const typedEl = el.querySelector(".oni-typed");

      function place() {
        if (!el.isConnected) return;

        const center = token.center;
        const { x, y } = canvasToScreenPoint(center.x, center.y);

        const rect = el.getBoundingClientRect();
        let left = x - 120;
        let top  = y - (token.h ?? 100) - rect.height - 22;

        left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
        top  = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8));

        el.style.left = `${left}px`;
        el.style.top  = `${top}px`;
      }

      const onPan = () => place();
      const onResize = () => place();
      Hooks.on("canvasPan", onPan);
      window.addEventListener("resize", onResize);
      canvas.app.ticker.add(place, undefined, PIXI.UPDATE_PRIORITY.LOW);
      place();

      const full = String(payload.text ?? "");
      let i = 0, done = false, fast = false;

      let closed = false;

      function cleanup() {
        if (closed) return;
        closed = true;
        try {
          Hooks.off("canvasPan", onPan);
          window.removeEventListener("resize", onResize);
          canvas.app.ticker.remove(place);
        } catch (_) {}
        try { el.remove(); } catch (_) {}
        try {
          const lyr = document.getElementById(LAYER_ID);
          if (lyr && !lyr.children.length) lyr.remove();
        } catch (_) {}
        try { onClose?.(); } catch (_) {}
      }

      function close() {
        if (!el.isConnected) return cleanup();
        el.classList.remove("oni-enter");
        el.classList.add("oni-exit");
        el.addEventListener("animationend", cleanup, { once: true });
        setTimeout(cleanup, 240);
      }

      const onClick = () => {
        if (!done) { fast = true; typedEl.textContent = full; done = true; return; }
        close();
      };
      el.addEventListener("click", onClick);

      function tick() {
        if (!el.isConnected || closed) return;
        if (fast) { typedEl.textContent = full; done = true; return; }

        const step = Math.max(1, Math.round(60 / speed));
        if ((i % step) === 0 && i < full.length) typedEl.textContent = full.slice(0, i + 1);
        i++;

        if (typedEl.textContent.length >= full.length) { done = true; return; }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);

      const autoMs = Math.max(1200, Math.ceil((full.length / speed) * 1000) + 1400);
      const autoTimer = setTimeout(() => close(), autoMs);

      // Ensure autoTimer clears on cleanup
      const oldCleanup = cleanup;
      const cleanupWrapped = () => { try { clearTimeout(autoTimer); } catch (_) {} oldCleanup(); };

      // monkey-patch local cleanup reference used by close()
      cleanup = cleanupWrapped;

      return { close };
    }

    // =========================================================================
    // Examine Indicator renderer (shows/hides per token+tile)
    // =========================================================================
    async function showExamineIcon(payload) {
      ensureExamineCSS();
      const layer = ensureExamineLayer();

      const mySceneId = canvas?.scene?.id;
      if (!mySceneId || mySceneId !== payload.sceneId) return;

      const token = getCanvasToken(payload.tokenId);
      if (!token) {
        warn("Examine: token not found on this client canvas", payload.tokenId);
        return;
      }

      const tileId = payload.tileId ?? "unknown";
      store.examine.byToken[payload.tokenId] ??= {};
      const slot = (store.examine.byToken[payload.tokenId][tileId] ??= { handle: null });

      // Already exists
      if (slot.handle?.btn?.isConnected) return;

      const btn = document.createElement("div");
      btn.className = "oni-ex-btn oni-ex-enter";
      btn.title = "Examine";
      btn.innerHTML = `<div class="mark">!</div>`;
      layer.appendChild(btn);

      let lastBubble = null;

      const hideIcon = () => btn.isConnected && btn.classList.add("oni-ex-hidden");
      const showIcon = () => btn.isConnected && btn.classList.remove("oni-ex-hidden");

      // Position tuning
      const ICON_OFFSET_Y = Number(payload.iconOffsetY ?? 10);
      const ICON_ANCHOR   = Number(payload.iconAnchor ?? 1.05);

      function placeBtn() {
        if (!btn.isConnected) return;

        const center = token.center;
        const { x, y } = canvasToScreenPoint(center.x, center.y);

        const rect = btn.getBoundingClientRect();
        const topY = y - (token.h ?? 100) * ICON_ANCHOR - ICON_OFFSET_Y;

        btn.style.left = `${x - rect.width / 2}px`;
        btn.style.top  = `${topY - rect.height}px`;
      }

      const onPan = () => placeBtn();
      const onResize = () => placeBtn();
      Hooks.on("canvasPan", onPan);
      window.addEventListener("resize", onResize);
      canvas.app.ticker.add(placeBtn, undefined, PIXI.UPDATE_PRIORITY.LOW);
      placeBtn();

      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        hideIcon();
        try { lastBubble?.close?.(); } catch (_) {}

        const speakerName =
          (payload.speakerName && String(payload.speakerName).trim()) ||
          token.document?.name ||
          token.name ||
          "Speaker";

        const text = String(payload.text ?? "…");
        const speed = Math.max(1, Number(payload.speed ?? 28));
        const bubbleMode = payload.bubbleMode ?? payload.mode ?? "normal";

        lastBubble = await renderDialogBubble({
          sceneId: payload.sceneId,
          tokenId: payload.tokenId,
          name: speakerName,
          text,
          speed,
          mode: bubbleMode,
          bubbleId: payload.bubbleId ?? `ex-${payload.tokenId}-${tileId}-${Date.now()}`
        }, { remote: false, onClose: () => showIcon() });
      });

      async function cleanup(animateOut = true) {
        try { lastBubble?.close?.(); } catch (_) {}

        try {
          Hooks.off("canvasPan", onPan);
          window.removeEventListener("resize", onResize);
          canvas.app.ticker.remove(placeBtn);
        } catch (_) {}

        if (!btn.isConnected) return;

        if (!animateOut) { try { btn.remove(); } catch (_) {} return; }

        btn.classList.remove("oni-ex-enter");
        btn.classList.add("oni-ex-exit");
        await new Promise(r => setTimeout(r, 180));
        try { btn.remove(); } catch (_) {}
        try {
          const lyr = document.getElementById(EX_LAYER_ID);
          if (lyr && !lyr.children.length) lyr.remove();
        } catch (_) {}
      }

      slot.handle = { btn, cleanup };
      log("Examine icon created", { tokenId: payload.tokenId, tileId });
    }

    async function hideExamineIcon(payload) {
      const mySceneId = canvas?.scene?.id;
      if (!mySceneId || mySceneId !== payload.sceneId) return;

      const tileId = payload.tileId ?? "unknown";
      const slot = store.examine.byToken?.[payload.tokenId]?.[tileId];
      if (!slot?.handle) return;

      await slot.handle.cleanup(true);
      slot.handle = null;
      log("Examine icon removed", { tokenId: payload.tokenId, tileId });
    }

    // =========================================================================
    // Socket Listener
    // =========================================================================
    function installListener() {
      log("installListener()", { alreadyInstalled: store.installed, channel: CHANNEL, user: game.user.name });

      if (!game?.socket?.on) {
        err("game.socket.on missing; socket not available?");
        if (DEBUG) ui.notifications?.error("Socket not available on this client.");
        return;
      }

      // remove old handler if reloaded
      if (store.installed && store.handler) {
        try { game.socket.off(CHANNEL, store.handler); } catch (_) {}
        store.installed = false;
        store.handler = null;
        log("old handler removed");
      }

      store.handler = async (data) => {
        try {
          log("SOCKET RECEIVE raw:", data);
          if (!data || typeof data !== "object") return;

          // PING debug
          if (data.type === MSG_PING) {
            if (DEBUG) ui.notifications?.info(`UI PING received by ${game.user.name}`);
            return;
          }

          // EXAMINE indicator
          if (data.type === MSG_EXAMINE) {
            const payload = data.payload;
            if (!payload) return;
            if (!shouldRenderForMe(payload)) return;

            if (!canvas?.ready) await waitCanvasReady(3000);

            const mode = String(payload.mode ?? "").toLowerCase();
            if (mode === "enter") await showExamineIcon(payload);
            if (mode === "exit")  await hideExamineIcon(payload);
            return;
          }

          // Dialog bubble
          if (data.type === MSG_DIALOG_SHOW) {
            const payload = data.payload;
            if (!payload) return;
            if (!shouldRenderForMe(payload)) return;

            if (payload.bubbleId && store.seen.has(payload.bubbleId)) return;
            if (payload.bubbleId) rememberSeen(payload.bubbleId);

            if (!canvas?.ready) await waitCanvasReady(3000);

            await renderDialogBubble(payload, { remote: true });
            return;
          }
        } catch (e) {
          err("SOCKET HANDLER ERROR:", e);
        }
      };

      game.socket.on(CHANNEL, store.handler);
      store.installed = true;

      log("Listener installed ✅", {
        channel: CHANNEL,
        types: [MSG_DIALOG_SHOW, MSG_EXAMINE, MSG_PING],
        userId: game.user.id
      });

      if (DEBUG) ui.notifications?.info(`Dialog/Examine UI installed: ${game.user.name}`);
    }

    // Small API for other scripts/macros (optional)
    globalThis.ONI_DIALOG_EXAMINE_UI = {
      CHANNEL,
      MODULE_ID,
      MSG_DIALOG_SHOW,
      MSG_EXAMINE,
      MSG_PING,
      renderDialogBubble,
      showExamineIcon,
      hideExamineIcon,
      installListener
    };

    installListener();
  })();
});
