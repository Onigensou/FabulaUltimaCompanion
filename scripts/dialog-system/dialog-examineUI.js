/**
 * ONI Dialog + Examine UI — MODULE VERSION (DEBUG + PORTRAIT RESTORE) — Foundry VTT v12
 * -----------------------------------------------------------------------------
 * Fixes in this version:
 * - GM can see Examine "!" even when payload.targetUserIds only lists players
 *   (because game.users.players excludes the GM by default).
 * - Restores the portrait-first dialog bubble style (left portrait + paper panel).
 *
 * Install:
 * - Put this file in your module: scripts/dialog-system/dialog-examineUI.js
 * - Add to module.json "scripts": ["scripts/dialog-system/dialog-examineUI.js"]
 *
 * Socket messages supported:
 * - Examine indicator:
 *     type: "ONI_EXAMINE_ICON_V1"
 *     payload: {
 *       sceneId, tokenId, tileId, mode:"enter"|"exit",
 *       speakerName?, text?, speed?, bubbleMode?,
 *       iconOffsetY?, iconAnchor?,
 *       targetUserIds?  // optional (recommended). If present, only those users render it.
 *     }
 *
 * - Dialog bubble (optional external use):
 *     type: "ONI_DIALOG_SHOW_V1"  (also accepts legacy "FU_DIALOG_TEST_SHOW_V1")
 *     payload: { sceneId, tokenId, name?, text, speed?, mode?, bubbleId?, targetUserIds? }
 */

Hooks.once("ready", () => {
  (async () => {
    // =======================
    // TOP CONFIG (EDIT ME)
    // =======================
    const DEBUG = true; // keep TRUE while testing

    const MODULE_ID = "fabula-ultima-companion"; // MUST match module.json id
    const CHANNEL   = `module.${MODULE_ID}`;

    // ✅ If true: GM will render UI even if targetUserIds does not include GM.
    // This matches your expectation: GM should also see the "!" indicator.
    const GM_ALWAYS_SEES_UI = true;

    // Dialog visual tuners
    const PORTRAIT_SIZE = 128;
    const BUBBLE_MAX_WIDTH = 520;
    const BUBBLE_MIN_WIDTH = 420;

    // =======================
    // INTERNALS
    // =======================
    const TAG = "[ONI][DialogUI]";
    const log  = (...a) => DEBUG && console.log(TAG, ...a);
    const warn = (...a) => console.warn(TAG, ...a);
    const err  = (...a) => console.error(TAG, ...a);

    const MSG_DIALOG_SHOW = "ONI_DIALOG_SHOW_V1";
    const MSG_DIALOG_SHOW_LEGACY = "FU_DIALOG_TEST_SHOW_V1";
    const MSG_EXAMINE_ICON = "ONI_EXAMINE_ICON_V1";
    const MSG_PING = "ONI_DIALOG_UI_PING_V2";

    const STORE_KEY = "__ONI_DIALOG_EXAMINE_UI_V2__";
    const store = (globalThis[STORE_KEY] ??= {
      installed: false,
      handler: null,

      // dedupe for bubbles (bubbleId)
      seen: new Set(),
      seenOrder: [],
      SEEN_LIMIT: 800,

      // examine icons: byToken[tokenId][tileId] = { handle }
      examineByToken: {},
    });

    function rememberSeen(id) {
      if (!id) return;
      if (store.seen.has(id)) return;
      store.seen.add(id);
      store.seenOrder.push(id);
      while (store.seenOrder.length > store.SEEN_LIMIT) {
        const old = store.seenOrder.shift();
        store.seen.delete(old);
      }
    }

    function htmlEscape(v) {
      const d = document.createElement("div");
      d.textContent = (v ?? "").toString();
      return d.innerHTML;
    }

    function shouldRenderForMe(payload) {
      const list = payload?.targetUserIds;

      // ✅ Key fix: GM isn't in game.users.players, so the sender often omits GM from targetUserIds.
      // If you want GM to still see the UI, allow it here.
      if (game.user.isGM && GM_ALWAYS_SEES_UI) {
        log("shouldRenderForMe: GM override -> true", { me: game.user.id, list });
        return true;
      }

      if (Array.isArray(list) && list.length) {
        const ok = list.includes(game.user.id);
        log("shouldRenderForMe: targetUserIds present", { me: game.user.id, ok, list });
        return ok;
      }

      log("shouldRenderForMe: no targetUserIds -> true");
      return true;
    }

    async function waitCanvasReady(timeoutMs = 4000) {
      const start = Date.now();
      while (!canvas?.ready) {
        await new Promise(r => setTimeout(r, 50));
        if (Date.now() - start > timeoutMs) break;
      }
      const ok = !!canvas?.ready;
      log("waitCanvasReady()", { ok, timeoutMs, elapsedMs: Date.now() - start });
      return ok;
    }

    function getCanvasToken(tokenId) {
      return (
        canvas?.tokens?.get?.(tokenId) ??
        canvas?.tokens?.placeables?.find?.(p => p?.document?.id === tokenId || p?.id === tokenId) ??
        null
      );
    }

    function canvasToScreenPoint(canvasX, canvasY) {
      const pt = new PIXI.Point(canvasX, canvasY);
      const global = canvas.app.stage.toGlobal(pt);
      const rect = canvas.app.view.getBoundingClientRect();
      return { x: rect.left + global.x, y: rect.top + global.y };
    }

    // =======================
    // CSS + Layers
    // =======================
    const D_STYLE_ID = "oni-dialog-style-v2";
    const D_LAYER_ID = "oni-dialog-layer-v2";
    const E_STYLE_ID = "oni-examine-style-v2";
    const E_LAYER_ID = "oni-examine-layer-v2";

    function ensureDialogCSS() {
      if (document.getElementById(D_STYLE_ID)) return;

      const style = document.createElement("style");
      style.id = D_STYLE_ID;
      style.textContent = `
#${D_LAYER_ID} { position: fixed; inset: 0; pointer-events: none; z-index: 100000;
  font-family: "Cinzel","Signika",var(--font-primary,"Signika"),system-ui,sans-serif; }
.oni-bubble { position: absolute; pointer-events: auto; display: flex; align-items: stretch;
  max-width: min(${BUBBLE_MAX_WIDTH}px, 92vw); min-width: ${BUBBLE_MIN_WIDTH}px; }
.oni-enter { animation: oniGrow .18s ease-out both; }
.oni-exit  { animation: oniShrink .15s ease-in both; }
@keyframes oniGrow   { from { transform: scale(.72); opacity: 0 } to { transform: scale(1); opacity: 1 } }
@keyframes oniShrink { from { transform: scale(1);   opacity: 1 } to { transform: scale(.72); opacity: 0 } }

.oni-left { border-radius: 18px 0 0 18px; padding: 6px; display:flex; align-items:center; justify-content:center; }
.oni-left img { width: ${PORTRAIT_SIZE}px; height:${PORTRAIT_SIZE}px; object-fit: contain; border-radius: 14px; }

.oni-paper { position: relative; flex: 1; background: #e8e0cf; color: #2b261f;
  border-radius: 0 18px 18px 18px; overflow: hidden; box-shadow: 0 6px 10px rgba(0,0,0,.45); }
.oni-paper::before {
  content:""; position:absolute; inset:0; pointer-events:none;
  background:
    radial-gradient(1200px 600px at 0% 0%, rgba(255,255,255,.35), transparent 70%),
    radial-gradient(800px 400px at 100% 0%, rgba(255,255,255,.25), transparent 70%),
    radial-gradient(1000px 800px at 50% 120%, rgba(0,0,0,.06), transparent 60%);
  mix-blend-mode: multiply; opacity:.6;
}
.oni-name { font-weight:700; font-size:1.05rem; margin:12px 16px 6px; position:relative; z-index:1; }
.oni-text { font-size:1.05rem; line-height:1.5; margin:0 16px 14px; white-space: pre-wrap; min-height:2.7em; position:relative; z-index:1; }
.oni-hint { margin:0 16px 12px; font-size:.85rem; opacity:.72; position:relative; z-index:1; }
.oni-tail { position:absolute; bottom:-16px; left:44px; width:0; height:0;
  border-left:14px solid transparent; border-right:14px solid transparent; border-top:16px solid #e8e0cf; }

.oni-mode-shout .oni-tail { display:none; }
.oni-mode-think .oni-tail { display:none; }
.oni-mode-shout .oni-paper { box-shadow: 0 0 0 3px #15110a, 0 10px 16px rgba(0,0,0,.35); background:#fffdf6; }
.oni-mode-think .oni-paper { box-shadow: 0 0 0 3px #15110a, 0 8px 14px rgba(0,0,0,.28); background:#fffdf6; }
      `;
      document.head.appendChild(style);
      log("Dialog CSS injected", D_STYLE_ID);
    }

    function ensureDialogLayer() {
      let layer = document.getElementById(D_LAYER_ID);
      if (!layer) {
        layer = document.createElement("div");
        layer.id = D_LAYER_ID;
        document.body.appendChild(layer);
        log("Dialog layer created", D_LAYER_ID);
      }
      return layer;
    }

    function ensureExamineCSS() {
      if (document.getElementById(E_STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = E_STYLE_ID;
      style.textContent = `
#${E_LAYER_ID}{ position: fixed; inset:0; pointer-events:none; z-index: 100001; }
.oni-ex-btn{
  position:absolute; pointer-events:auto;
  width:34px; height:34px; display:grid; place-items:center;
  background:rgba(255,255,255,.95);
  border:2px solid rgba(0,0,0,.75);
  border-radius:999px;
  box-shadow:0 6px 10px rgba(0,0,0,.35);
  cursor:pointer; user-select:none;
  transform-origin:50% 100%;
}
.oni-ex-btn .mark{
  font-family:"Cinzel","Signika",var(--font-primary,"Signika"),system-ui,sans-serif;
  font-weight:900; font-size:20px; line-height:1;
  color:rgba(20,16,10,.95);
  transform: translateY(-1px);
}
.oni-ex-enter{ animation: oniExIn .16s ease-out both; }
@keyframes oniExIn{ from{ transform:scale(.75); opacity:0 } to{ transform:scale(1); opacity:1 } }
.oni-ex-exit{ animation: oniExOut .14s ease-in both; }
@keyframes oniExOut{ from{ transform:scale(1); opacity:1 } to{ transform:scale(.78); opacity:0 } }
.oni-ex-hidden{ opacity:0 !important; transform: scale(.92) !important; pointer-events:none !important; }
      `;
      document.head.appendChild(style);
      log("Examine CSS injected", E_STYLE_ID);
    }

    function ensureExamineLayer() {
      let layer = document.getElementById(E_LAYER_ID);
      if (!layer) {
        layer = document.createElement("div");
        layer.id = E_LAYER_ID;
        document.body.appendChild(layer);
        log("Examine layer created", E_LAYER_ID);
      }
      return layer;
    }

    // =======================
    // Dialog Bubble UI (portrait restored)
    // =======================
    function resolvePortraitSrc(token) {
      return (
        token?.actor?.img ||
        token?.document?.texture?.src ||
        token?.document?.texture?.img ||
        token?.texture?.src ||
        "icons/svg/mystery-man.svg"
      );
    }

    async function renderDialogBubble(payload, { source = "socket", onClose = null } = {}) {
      ensureDialogCSS();
      const layer = ensureDialogLayer();

      const mySceneId = canvas?.scene?.id;
      if (!mySceneId) { warn("renderDialogBubble: no canvas.scene.id"); return; }
      if (mySceneId !== payload.sceneId) {
        log("renderDialogBubble: scene mismatch -> ignore", { mySceneId, sceneId: payload.sceneId });
        return;
      }

      const token = getCanvasToken(payload.tokenId);
      if (!token) {
        warn("renderDialogBubble: token not found", { tokenId: payload.tokenId });
        return;
      }

      const portraitSrc = payload.portraitSrc || resolvePortraitSrc(token);

      const bubbleId = payload.bubbleId ?? `oni-${Math.random().toString(36).slice(2)}`;
      const mode = payload.mode ?? "normal";
      const speed = Math.max(1, Number(payload.speed ?? 28));

      log("renderDialogBubble START", { source, bubbleId, mode, speed, tokenId: payload.tokenId });

      const el = document.createElement("div");
      el.className = "oni-bubble oni-enter";
      if (mode === "shout") el.classList.add("oni-mode-shout");
      if (mode === "think") el.classList.add("oni-mode-think");
      el.dataset.bubbleId = bubbleId;

      el.innerHTML = `
        <div class="oni-left"><img alt="portrait" src="${htmlEscape(portraitSrc)}"/></div>
        <div class="oni-paper">
          <div class="oni-name">${htmlEscape(payload.name ?? token.document?.name ?? "Speaker")}</div>
          <div class="oni-text"><span class="oni-typed"></span></div>
          <div class="oni-hint">(Click: fast-forward / close)</div>
          <div class="oni-tail"></div>
        </div>
      `;
      layer.appendChild(el);

      const typedEl = el.querySelector(".oni-typed");
      const full = String(payload.text ?? "");

      let closed = false;
      let done = false;
      let fast = false;
      let i = 0;

      // Position near token (similar to your earlier UI placement)
      function place() {
        if (!el.isConnected) return;

        const center = token.center;
        const { x, y } = canvasToScreenPoint(center.x, center.y);

        const rect = el.getBoundingClientRect();
        let left = x - Math.min(160, rect.width * 0.25);
        let top  = y - (token.h ?? 100) - rect.height - 28;

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

      let autoTimer = null;

      function cleanup() {
        if (closed) return;
        closed = true;

        try { if (autoTimer) clearTimeout(autoTimer); } catch (_) {}
        try {
          Hooks.off("canvasPan", onPan);
          window.removeEventListener("resize", onResize);
          canvas.app.ticker.remove(place);
        } catch (_) {}

        try { el.remove(); } catch (_) {}
        try {
          const lyr = document.getElementById(D_LAYER_ID);
          if (lyr && !lyr.children.length) lyr.remove();
        } catch (_) {}

        try { onClose?.(); } catch (_) {}
        log("renderDialogBubble CLEANUP", { bubbleId });
      }

      function close() {
        if (!el.isConnected) return cleanup();
        el.classList.remove("oni-enter");
        el.classList.add("oni-exit");
        el.addEventListener("animationend", cleanup, { once: true });
        setTimeout(cleanup, 240);
      }

      el.addEventListener("click", () => {
        if (!done) {
          fast = true;
          typedEl.textContent = full;
          done = true;
          return;
        }
        close();
      });

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

      const autoMs = Math.max(1200, Math.ceil((full.length / speed) * 1000) + 1600);
      autoTimer = setTimeout(() => close(), autoMs);

      return { close };
    }

    // =======================
    // Examine Indicator UI
    // =======================
    async function showExamineIcon(payload) {
      ensureExamineCSS();
      const layer = ensureExamineLayer();

      const mySceneId = canvas?.scene?.id;
      if (!mySceneId) { warn("showExamineIcon: no canvas.scene.id"); return; }
      if (mySceneId !== payload.sceneId) {
        log("showExamineIcon: scene mismatch -> ignore", { mySceneId, sceneId: payload.sceneId });
        return;
      }

      const token = getCanvasToken(payload.tokenId);
      if (!token) {
        warn("showExamineIcon: token not found", { tokenId: payload.tokenId });
        return;
      }

      const tileId = String(payload.tileId ?? "unknown");
      store.examineByToken[payload.tokenId] ??= {};
      const slot = (store.examineByToken[payload.tokenId][tileId] ??= { handle: null });

      if (slot.handle?.btn?.isConnected) {
        log("showExamineIcon: already exists -> skip", { tokenId: payload.tokenId, tileId });
        return;
      }

      log("showExamineIcon START", { tokenId: payload.tokenId, tileId });

      const btn = document.createElement("div");
      btn.className = "oni-ex-btn oni-ex-enter";
      btn.title = payload.title ?? "Examine";
      btn.innerHTML = `<div class="mark">!</div>`;
      layer.appendChild(btn);

      let lastBubble = null;

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
      const onUpdateToken = (doc) => { if (doc?.id === payload.tokenId) placeBtn(); };

      Hooks.on("canvasPan", onPan);
      window.addEventListener("resize", onResize);
      Hooks.on("updateToken", onUpdateToken);
      canvas.app.ticker.add(placeBtn, undefined, PIXI.UPDATE_PRIORITY.LOW);
      placeBtn();

      const showIcon = () => btn.isConnected && btn.classList.remove("oni-ex-hidden");
      const hideIcon = () => btn.isConnected && btn.classList.add("oni-ex-hidden");

      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        log("Examine icon CLICK", { tokenId: payload.tokenId, tileId });

        hideIcon();
        try { lastBubble?.close?.(); } catch (_) {}

        const speakerName =
          (payload.speakerName && String(payload.speakerName).trim()) ||
          token.document?.name ||
          token.name ||
          "Speaker";

        const text = String(payload.text ?? "…");
        const speed = Math.max(1, Number(payload.speed ?? 28));
        const mode  = payload.bubbleMode ?? "normal";

        lastBubble = await renderDialogBubble({
          sceneId: payload.sceneId,
          tokenId: payload.tokenId,
          name: speakerName,
          text,
          speed,
          mode,
          bubbleId: payload.bubbleId ?? `ex-${payload.tokenId}-${tileId}-${Date.now()}`
        }, { source: "examine-click", onClose: () => showIcon() });
      });

      async function cleanup(animateOut = true) {
        log("showExamineIcon CLEANUP start", { tokenId: payload.tokenId, tileId, animateOut });

        try { lastBubble?.close?.(); } catch (_) {}

        try {
          Hooks.off("canvasPan", onPan);
          window.removeEventListener("resize", onResize);
          Hooks.off("updateToken", onUpdateToken);
          canvas.app.ticker.remove(placeBtn);
        } catch (_) {}

        if (!btn.isConnected) return;

        if (!animateOut) {
          try { btn.remove(); } catch (_) {}
          return;
        }

        btn.classList.remove("oni-ex-enter");
        btn.classList.add("oni-ex-exit");
        await new Promise(r => setTimeout(r, 180));
        try { btn.remove(); } catch (_) {}

        try {
          const lyr = document.getElementById(E_LAYER_ID);
          if (lyr && !lyr.children.length) lyr.remove();
        } catch (_) {}
      }

      slot.handle = { btn, cleanup };
      log("showExamineIcon DONE", { tokenId: payload.tokenId, tileId });
    }

    async function hideExamineIcon(payload) {
      const mySceneId = canvas?.scene?.id;
      if (!mySceneId) return;
      if (mySceneId !== payload.sceneId) return;

      const tileId = String(payload.tileId ?? "unknown");
      const slot = store.examineByToken?.[payload.tokenId]?.[tileId];
      if (!slot?.handle) {
        log("hideExamineIcon: no handle found", { tokenId: payload.tokenId, tileId });
        return;
      }

      log("hideExamineIcon START", { tokenId: payload.tokenId, tileId });
      await slot.handle.cleanup(true);
      slot.handle = null;
      log("hideExamineIcon DONE", { tokenId: payload.tokenId, tileId });
    }

    // =======================
    // Socket Listener install
    // =======================
    function installListener() {
      log("installListener() begin", {
        installed: store.installed,
        hasSocket: !!game?.socket,
        hasOn: typeof game?.socket?.on === "function",
        user: { id: game.user.id, name: game.user.name, isGM: game.user.isGM },
        channel: CHANNEL
      });

      if (!game?.socket?.on) {
        err("game.socket.on missing; cannot install listener");
        return;
      }

      // remove old handler if hot-reloaded
      if (store.installed && store.handler) {
        try { game.socket.off(CHANNEL, store.handler); } catch (_) {}
        store.installed = false;
        store.handler = null;
        log("installListener(): removed previous handler");
      }

      store.handler = async (data) => {
        try {
          log("SOCKET RECEIVE", data);

          if (!data || typeof data !== "object") return;

          // ping
          if (data.type === MSG_PING) {
            log("PING received", data.payload);
            return;
          }

          // Ensure canvas is ready for any UI
          if (!canvas?.ready) await waitCanvasReady(4000);

          // Examine indicator
          if (data.type === MSG_EXAMINE_ICON) {
            const payload = data.payload;
            log("EXAMINE message received", payload);
            if (!payload) return;

            if (!shouldRenderForMe(payload)) {
              log("EXAMINE ignored (not target user)");
              return;
            }

            const mode = String(payload.mode ?? "").toLowerCase();
            if (mode === "enter") return await showExamineIcon(payload);
            if (mode === "exit")  return await hideExamineIcon(payload);

            warn("EXAMINE payload missing/unknown mode. Expected enter/exit.", payload);
            return;
          }

          // Dialog bubble
          if (data.type === MSG_DIALOG_SHOW || data.type === MSG_DIALOG_SHOW_LEGACY) {
            const payload = data.payload;
            log("DIALOG message received", { type: data.type, payload });
            if (!payload) return;

            if (!shouldRenderForMe(payload)) {
              log("DIALOG ignored (not target user)");
              return;
            }

            if (payload.bubbleId && store.seen.has(payload.bubbleId)) {
              log("DIALOG dedupe ignore", payload.bubbleId);
              return;
            }
            if (payload.bubbleId) rememberSeen(payload.bubbleId);

            await renderDialogBubble(payload, { source: "socket" });
            return;
          }

          log("SOCKET ignored: unknown type", data.type);
        } catch (e) {
          err("SOCKET HANDLER ERROR", e);
        }
      };

      game.socket.on(CHANNEL, store.handler);
      store.installed = true;

      log("installListener() DONE ✅", { channel: CHANNEL, types: [MSG_DIALOG_SHOW, MSG_EXAMINE_ICON, MSG_PING] });
    }

    // Debug API
    globalThis.ONI_DIALOG_EXAMINE_UI = {
      MODULE_ID,
      CHANNEL,
      MSG_DIALOG_SHOW,
      MSG_DIALOG_SHOW_LEGACY,
      MSG_EXAMINE_ICON,
      MSG_PING,
      GM_ALWAYS_SEES_UI,
      installListener,
      renderDialogBubble,
      showExamineIcon,
      hideExamineIcon
    };

    installListener();

    // self-ping to confirm listener is alive on each client
    if (DEBUG) {
      try {
        game.socket.emit(CHANNEL, { type: MSG_PING, payload: { from: game.user.id, name: game.user.name, isGM: game.user.isGM, at: Date.now() } });
      } catch (e) {
        warn("self-ping emit failed", e);
      }
    }
  })();
});
