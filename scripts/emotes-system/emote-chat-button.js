/**
 * emote-chat-button.js
 * Fabula Ultima Companion - Emote System Chat Button
 * Foundry VTT v12
 *
 * Purpose:
 * - Add an "Emote Configuration" button beside the chat input bar
 * - Open the Emote config window when clicked
 * - Auto-dock around other chat buttons to avoid overlap
 *
 * Notes:
 * - Available to all users
 * - Uses local-only click sound
 * - Uses EmoteSystem API / EmoteConfigApp if available
 *
 * Globals:
 *   globalThis.__ONI_EMOTE_CHAT_BUTTON__
 *
 * API:
 *   FUCompanion.api.EmoteChatButton
 */

(() => {
  const GLOBAL_KEY = "__ONI_EMOTE_CHAT_BUTTON__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "emote";

    const CFG = {
    BUTTON_ID: "oni-chat-emote-config-btn",
    STYLE_ID: "oni-chat-emote-config-btn-style",

    SIZE_PX: 30,
    GAP_PX: 6,

    ICON_URL: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Emotes%20Icon/Emote_Happy.png",

    BASE_RIGHT_PX: 6,
    BASE_BOTTOM_PX: 6,

    MAX_COLS: 12,
    MAX_ROWS: 4,

    SOUND_URL:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",
    VOLUME: 0.8,

    TITLE: "Emote Configuration",
    ARIA_LABEL: "Open Emote Configuration"
  };

  const state = {
    installed: true,
    ready: false,
    resizeHandler: null,
    redockTimer: null
  };

  function getDebug() {
    const dbg = globalThis.__ONI_EMOTE_DEBUG__;
    if (dbg?.installed) return dbg;

    const noop = () => {};
    return {
      log: noop,
      info: noop,
      verbose: noop,
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      group: noop,
      groupCollapsed: noop,
      table: noop,
      divider: noop,
      startTimer: noop,
      endTimer: () => null
    };
  }

  function getEmoteApi() {
    return globalThis.__ONI_EMOTE_API__
      ?? globalThis.FUCompanion?.api?.EmoteSystem
      ?? null;
  }

  const DBG = getDebug();

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function rectsOverlap(a, b) {
    return !(
      a.right <= b.left ||
      a.left >= b.right ||
      a.bottom <= b.top ||
      a.top >= b.bottom
    );
  }

  function injectCss() {
    if (document.getElementById(CFG.STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = CFG.STYLE_ID;
    style.textContent = `
/* ========== ONI Chat Emote Config Button ========== */
#chat-form { position: relative; }

#${CFG.BUTTON_ID} {
  width: ${CFG.SIZE_PX}px;
  height: ${CFG.SIZE_PX}px;
  min-width: ${CFG.SIZE_PX}px;
  min-height: ${CFG.SIZE_PX}px;

  position: absolute;
  right: ${CFG.BASE_RIGHT_PX}px;
  bottom: ${CFG.BASE_BOTTOM_PX}px;
  z-index: 20;

  display: inline-flex;
  align-items: center;
  justify-content: center;

  padding: 0;
  margin: 0;

  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.18);
  background: rgba(0,0,0,0.35);
  box-shadow: 0 1px 2px rgba(0,0,0,0.35);
  cursor: pointer;
}

#${CFG.BUTTON_ID}:hover {
  filter: brightness(1.12);
  background: rgba(0,0,0,0.48);
}

#${CFG.BUTTON_ID}:active {
  transform: translateY(1px);
}

#${CFG.BUTTON_ID} img {
  width: 20px;
  height: 20px;
  object-fit: contain;
  display: block;
  pointer-events: none;
}
`;
    document.head.appendChild(style);
  }

  async function playClickSoundLocalOnly() {
    try {
      await AudioHelper.play(
        {
          src: CFG.SOUND_URL,
          volume: CFG.VOLUME,
          loop: false
        },
        false
      );
    } catch (err) {
      DBG.warn("ChatButton", "Click sound failed to play", {
        error: err?.message ?? err
      });
    }
  }

  function getChatForm() {
    return document.querySelector("#chat-form");
  }

  function candidateRect(chatFormRect, rightPx, bottomPx, sizePx) {
    const left = chatFormRect.right - rightPx - sizePx;
    const top = chatFormRect.bottom - bottomPx - sizePx;

    return {
      left,
      top,
      right: left + sizePx,
      bottom: top + sizePx,
      width: sizePx,
      height: sizePx
    };
  }

  function getAbsoluteObstacles(chatForm, ignoreIds = new Set()) {
    const obstacles = [];
    const formRect = chatForm.getBoundingClientRect();
    const all = Array.from(chatForm.querySelectorAll("*"));

    for (const el of all) {
      if (!(el instanceof HTMLElement)) continue;
      if (ignoreIds.has(el.id)) continue;
      if (el.id === "chat-message") continue;

      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (cs.position !== "absolute") continue;

      const r = el.getBoundingClientRect();
      const w = r.width;
      const h = r.height;

      if (w < 18 || h < 18) continue;
      if (w > 90 || h > 90) continue;

      const nearRight = (formRect.right - r.right) < 260;
      const nearBottom = (formRect.bottom - r.bottom) < 220;
      if (!nearRight || !nearBottom) continue;

      obstacles.push({ el, rect: r });
    }

    return obstacles;
  }

  function autoDockButton() {
    const chatForm = getChatForm();
    const btn = document.getElementById(CFG.BUTTON_ID);
    const chatMessage = document.querySelector("#chat-message");

    if (!chatForm || !btn || !chatMessage) return false;

    const chatFormRect = chatForm.getBoundingClientRect();
    const ignore = new Set([CFG.BUTTON_ID]);
    const obstacles = getAbsoluteObstacles(chatForm, ignore).map(o => o.rect);

    let chosen = null;

    for (let row = 0; row < CFG.MAX_ROWS && !chosen; row++) {
      for (let col = 0; col < CFG.MAX_COLS && !chosen; col++) {
        const rightPx = CFG.BASE_RIGHT_PX + col * (CFG.SIZE_PX + CFG.GAP_PX);
        const bottomPx = CFG.BASE_BOTTOM_PX + row * (CFG.SIZE_PX + CFG.GAP_PX);
        const cand = candidateRect(chatFormRect, rightPx, bottomPx, CFG.SIZE_PX);

        const overlaps = obstacles.some(o => rectsOverlap(cand, o));
        if (!overlaps) {
          chosen = { rightPx, bottomPx, rect: cand, row, col };
        }
      }
    }

    if (!chosen) {
      chosen = {
        rightPx: CFG.BASE_RIGHT_PX,
        bottomPx: CFG.BASE_BOTTOM_PX + (CFG.SIZE_PX + CFG.GAP_PX),
        rect: candidateRect(
          chatFormRect,
          CFG.BASE_RIGHT_PX,
          CFG.BASE_BOTTOM_PX + (CFG.SIZE_PX + CFG.GAP_PX),
          CFG.SIZE_PX
        ),
        row: 1,
        col: 0
      };
    }

    btn.style.right = `${chosen.rightPx}px`;
    btn.style.bottom = `${chosen.bottomPx}px`;

    const inputRect = chatMessage.getBoundingClientRect();
    const updatedObstacles = getAbsoluteObstacles(chatForm, new Set()).map(o => o.rect);

    const relevant = updatedObstacles.filter(r => {
      const verticalOverlap = !(
        r.bottom <= inputRect.top ||
        r.top >= inputRect.bottom
      );
      return verticalOverlap;
    });

    let neededInset = 0;
    for (const r of relevant) {
      const inset = chatFormRect.right - r.left;
      if (inset > neededInset) neededInset = inset;
    }

    if (neededInset > 0) {
      const finalPad = Math.ceil(neededInset + 8);
      chatMessage.style.setProperty("padding-right", `${finalPad}px`, "important");
    }

    DBG.verbose("ChatButton", "Auto-docked Emote chat button", {
      rightPx: chosen.rightPx,
      bottomPx: chosen.bottomPx,
      row: chosen.row,
      col: chosen.col
    });

    return true;
  }

  function scheduleRedock(delay = 0) {
    if (state.redockTimer) clearTimeout(state.redockTimer);

    state.redockTimer = setTimeout(() => {
      state.redockTimer = null;
      autoDockButton();
    }, Math.max(0, Number(delay) || 0));
  }

  async function onClickOpenConfig() {
    const emoteApi = getEmoteApi();

    if (!emoteApi?.openConfig) {
      ui.notifications?.warn?.("Emote configuration is not available yet.");
      DBG.warn("ChatButton", "Emote config open failed because EmoteSystem API is unavailable");
      return;
    }

    try {
      await emoteApi.openConfig();
      await playClickSoundLocalOnly();

      DBG.verbose("ChatButton", "Opened Emote configuration from chat button", {
        userId: game.user?.id ?? null,
        userName: game.user?.name ?? null
      });
    } catch (err) {
      DBG.error("ChatButton", "Failed to open Emote configuration", {
        error: err?.message ?? err
      });
      ui.notifications?.error?.("Failed to open Emote configuration. Check console.");
    }
  }

  function ensureButton() {
    if (document.getElementById(CFG.BUTTON_ID)) return true;

    const chatForm = getChatForm();
    if (!chatForm) return false;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = CFG.BUTTON_ID;
    btn.title = CFG.TITLE;
    btn.setAttribute("aria-label", CFG.ARIA_LABEL);

    const icon = document.createElement("img");
    icon.src = CFG.ICON_URL;
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");

    btn.appendChild(icon);
    btn.addEventListener("click", onClickOpenConfig);

    chatForm.appendChild(btn);
    return true;
  }

  function installResizeListener() {
    if (state.resizeHandler) return;

    state.resizeHandler = () => {
      scheduleRedock(0);
    };

    window.addEventListener("resize", state.resizeHandler, { passive: true });
  }

  function removeResizeListener() {
    if (!state.resizeHandler) return;
    window.removeEventListener("resize", state.resizeHandler);
    state.resizeHandler = null;
  }

  function installOrReattach() {
    injectCss();

    const ok = ensureButton();
    if (!ok) return false;

    installResizeListener();

    scheduleRedock(0);
    scheduleRedock(50);
    scheduleRedock(250);

    DBG.verbose("ChatButton", "Emote chat button ready", {
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    });

    return true;
  }

  function destroy() {
    if (state.redockTimer) {
      clearTimeout(state.redockTimer);
      state.redockTimer = null;
    }

    removeResizeListener();

    try {
      document.getElementById(CFG.BUTTON_ID)?.remove();
    } catch (_) {}

    DBG.verbose("ChatButton", "Emote chat button destroyed");
  }

  function getSnapshot() {
    const btn = document.getElementById(CFG.BUTTON_ID);

    return {
      installed: true,
      ready: state.ready,
      buttonPresent: !!btn,
      buttonId: CFG.BUTTON_ID,
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null,
      buttonRight: btn?.style?.right ?? null,
      buttonBottom: btn?.style?.bottom ?? null
    };
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,
    CFG,

    installOrReattach,
    autoDockButton,
    scheduleRedock,
    destroy,
    getSnapshot
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.EmoteChatButton = api;
    } catch (err) {
      console.warn("[Emote:ChatButton] Failed to attach API to FUCompanion.api", err);
    }

    installOrReattach();
    state.ready = true;

    DBG.verbose("Bootstrap", "emote-chat-button.js ready", {
      moduleId: MODULE_ID,
      systemId: SYSTEM_ID,
      snapshot: getSnapshot()
    });
  });

  Hooks.on("renderSidebarTab", () => {
    installOrReattach();
  });
})();