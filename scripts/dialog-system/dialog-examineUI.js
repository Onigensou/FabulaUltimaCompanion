/**
 * FU Dialog Test — Install UI (MODULE VERSION) — Foundry VTT v12
 * -----------------------------------------------------------------------------
 * What this does:
 * - Installs a socket listener on every client (GM + players)
 * - When the GM (or a controller script) broadcasts a SHOW payload over the module channel,
 *   this client renders a JRPG-style dialog bubble over the matching token.
 *
 * Drop this file into your module and include it in module.json "scripts".
 *
 * Notes:
 * - Safe to auto-run every session: it de-dupes installation using a global store.
 * - Uses channel: module.fabula-ultima-companion (change MODULE_ID if your module id differs)
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
    const MSG_SHOW = "FU_DIALOG_TEST_SHOW_V1";
    const MSG_PING = "FU_DIALOG_TEST_PING_V1";

    // DOM ids / globals
    const STYLE_ID = "fu-dialog-test-style";
    const LAYER_ID = "fu-dialog-test-layer";
    const STORE_KEY = "__FU_DIALOG_TEST_UI__";

    // Dedupe tuning: keep only the newest N bubbleIds
    const SEEN_LIMIT = 500;

    const log  = (...a) => DEBUG && console.log("%c[FU Dialog:UI]", "color:#7dd3fc", ...a);
    const warn = (...a) => console.warn("%c[FU Dialog:UI]", "color:#fbbf24", ...a);
    const err  = (...a) => console.error("%c[FU Dialog:UI]", "color:#fb7185", ...a);

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
    });

    function rememberSeen(id) {
      if (!id) return;
      if (store.seen.has(id)) return;
      store.seen.add(id);
      store.seenOrder.push(id);

      // prune oldest
      while (store.seenOrder.length > SEEN_LIMIT) {
        const old = store.seenOrder.shift();
        store.seen.delete(old);
      }
    }

    function ensureCSS() {
      if (document.getElementById(STYLE_ID)) return;

      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
#${LAYER_ID} { position: fixed; inset: 0; pointer-events: none; z-index: 100000;
  font-family: "Signika", system-ui, sans-serif; }
.fu-test-bubble { position: absolute; pointer-events: auto; max-width: min(520px, 92vw); min-width: 380px;
  background: #e8e0cf; color: #2b261f; border-radius: 18px; box-shadow: 0 8px 16px rgba(0,0,0,.35);
  overflow: hidden; transform-origin: 64px calc(100% + 12px); }
.fu-test-enter { animation: fuTestGrow .18s ease-out both; }
.fu-test-exit  { animation: fuTestShrink .15s ease-in both; }
@keyframes fuTestGrow { from { transform: scale(.75); opacity:0 } to { transform:scale(1); opacity:1 } }
@keyframes fuTestShrink { from { transform: scale(1); opacity:1 } to { transform:scale(.75); opacity:0 } }
.fu-test-head { padding: 12px 16px 6px; font-weight: 700; font-size: 1.05rem; }
.fu-test-body { padding: 0 16px 14px; font-size: 1.05rem; line-height: 1.5; min-height: 2.7em; white-space: pre-wrap; }
.fu-test-tail { position:absolute; bottom:-16px; left:48px; width:0;height:0;
  border-left:14px solid transparent; border-right:14px solid transparent; border-top:16px solid #e8e0cf;
  filter: drop-shadow(0 -2px 0 rgba(0,0,0,.08)); }
.fu-test-mode-shout { background: #fffdf6; box-shadow: 0 0 0 3px #15110a, 0 10px 16px rgba(0,0,0,.35); }
.fu-test-mode-think { background: #fffdf6; box-shadow: 0 0 0 3px #15110a, 0 8px 14px rgba(0,0,0,.28); }
.fu-test-mode-shout .fu-test-tail { display:none; }
.fu-test-mode-think .fu-test-tail { display:none; }
.fu-test-hint { padding: 0 16px 12px; font-size: .85rem; opacity: .75; }
      `;
      document.head.appendChild(style);
      log("CSS injected:", STYLE_ID);
    }

    function ensureLayer() {
      let layer = document.getElementById(LAYER_ID);
      if (!layer) {
        layer = document.createElement("div");
        layer.id = LAYER_ID;
        document.body.appendChild(layer);
        log("Layer created:", LAYER_ID);
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

    async function renderBubble(payload, { remote = false } = {}) {
      ensureCSS();
      const layer = ensureLayer();

      const mySceneId = canvas?.scene?.id;
      log("renderBubble", { remote, mySceneId, sceneId: payload.sceneId, tokenId: payload.tokenId });

      // Only show if the receiving client is on the same scene as payload
      if (!mySceneId || mySceneId !== payload.sceneId) {
        log("scene mismatch -> ignore", { mySceneId, sceneId: payload.sceneId });
        return;
      }

      const token = getCanvasToken(payload.tokenId);
      if (!token) {
        warn("token not found on this client canvas", payload.tokenId);
        return;
      }

      const bubbleId = payload.bubbleId ?? `fu-${Math.random().toString(36).slice(2)}`;
      const mode = payload.mode ?? "normal";
      const speed = Math.max(1, Number(payload.speed ?? 28));

      const el = document.createElement("div");
      el.className = "fu-test-bubble fu-test-enter";
      if (mode === "shout") el.classList.add("fu-test-mode-shout");
      if (mode === "think") el.classList.add("fu-test-mode-think");
      el.dataset.bubbleId = bubbleId;

      el.innerHTML = `
        <div class="fu-test-head">${htmlEscape(payload.name ?? token.document?.name ?? "Speaker")}</div>
        <div class="fu-test-body"><span class="fu-test-typed"></span></div>
        <div class="fu-test-hint">(Click: fast-forward / close)</div>
        <div class="fu-test-tail"></div>
      `;
      layer.appendChild(el);

      const typedEl = el.querySelector(".fu-test-typed");

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

      function tick() {
        if (!el.isConnected) return;

        if (fast) { typedEl.textContent = full; done = true; return; }

        const step = Math.max(1, Math.round(60 / speed));
        if ((i % step) === 0 && i < full.length) typedEl.textContent = full.slice(0, i + 1);
        i++;

        if (typedEl.textContent.length >= full.length) { done = true; return; }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);

      function close() {
        el.classList.remove("fu-test-enter");
        el.classList.add("fu-test-exit");
        const finish = () => { el.removeEventListener("animationend", finish); cleanup(); };
        el.addEventListener("animationend", finish);
      }

      const onClick = () => {
        if (!done) { fast = true; typedEl.textContent = full; done = true; return; }
        close();
      };
      el.addEventListener("click", onClick);

      const autoMs = Math.max(1200, Math.ceil((full.length / speed) * 1000) + 1400);
      const autoTimer = setTimeout(() => close(), autoMs);

      function cleanup() {
        try {
          clearTimeout(autoTimer);
          el.removeEventListener("click", onClick);
          Hooks.off("canvasPan", onPan);
          window.removeEventListener("resize", onResize);
          canvas.app.ticker.remove(place);
          el.remove();

          const lyr = document.getElementById(LAYER_ID);
          if (lyr && !lyr.children.length) lyr.remove();
        } catch (_) {}
      }
    }

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

          // ✅ PING debug
          if (data.type === MSG_PING) {
            if (DEBUG) ui.notifications?.info(`FU Dialog PING received by ${game.user.name}`);
            log("PING received ✅", data.payload);
            return;
          }

          // ✅ SHOW bubble
          if (data.type !== MSG_SHOW) return;
          const payload = data.payload;
          if (!payload) return;

          if (payload.bubbleId && store.seen.has(payload.bubbleId)) {
            log("de-dupe ignore", payload.bubbleId);
            return;
          }
          if (payload.bubbleId) rememberSeen(payload.bubbleId);

          if (!canvas?.ready) {
            const ok = await waitCanvasReady(3000);
            log("waitCanvasReady:", ok);
          }

          await renderBubble(payload, { remote: true });
        } catch (e) {
          err("SOCKET HANDLER ERROR:", e);
        }
      };

      game.socket.on(CHANNEL, store.handler);
      store.installed = true;

      log("Listener installed ✅", { channel: CHANNEL, showType: MSG_SHOW, pingType: MSG_PING, userId: game.user.id });
      if (DEBUG) ui.notifications?.info(`FU Dialog UI installed on this client: ${game.user.name}`);
    }

    // expose small API for other scripts/macros
    globalThis.FU_DIALOG_UI = {
      installListener,
      renderBubble,
      CHANNEL,
      MSG_SHOW,
      MSG_PING,
      MODULE_ID,
    };

    installListener();
  })();
});
