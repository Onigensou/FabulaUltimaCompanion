// ============================================================================
// ONI — Chat Button Final Layout Manager (Foundry VTT v12)
// ----------------------------------------------------------------------------
// Purpose:
// - Final authoritative layout pass for all custom chat-bar buttons
// - Prevent rare edge cases where separate auto-dock scripts collapse together
// - Especially helpful on GM client where extra GM-only buttons exist
//
// How it works:
// - Runs AFTER the individual button scripts
// - Finds all known chat buttons by ID
// - Repositions them in one deterministic shared pass
// - Recomputes #chat-message padding-right from the final arrangement
//
// Important:
// - Load this script AFTER all chat button scripts in module.json
// ============================================================================

(() => {
  const GLOBAL_KEY = "__ONI_CHAT_BUTTON_FINAL_LAYOUT__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const CFG = {
    SIZE_PX: 30,
    GAP_PX: 6,
    BASE_RIGHT_PX: 6,
    BASE_BOTTOM_PX: 6,
    MAX_COLS: 12,
    MAX_ROWS: 4,

    // Final deterministic order, left-to-right from the user's perspective
    BUTTONS: [
      { id: "oni-chat-open-character-btn", order: 10, gmOnly: false },
      { id: "oni-chat-open-party-btn", order: 20, gmOnly: false },
      { id: "oni-chat-open-trade-btn", order: 30, gmOnly: false },
      { id: "oni-chat-emote-config-btn", order: 40, gmOnly: false },
      { id: "oni-chat-scene-network-btn", order: 50, gmOnly: true }
    ]
  };

  const state = {
    installed: true,
    ready: false,
    timer: null,
    chatObserver: null,
    bodyObserver: null,
    observedChatForm: null
  };

  const log = (...args) => console.log("[ONI ChatBtnFinalLayout]", ...args);

  function getChatForm() {
    return document.querySelector("#chat-form");
  }

  function getChatMessage() {
    return document.querySelector("#chat-message");
  }

  function rectsOverlap(a, b) {
    return !(
      a.right <= b.left ||
      a.left >= b.right ||
      a.bottom <= b.top ||
      a.top >= b.bottom
    );
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

  function isElementVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none") return false;
    if (cs.visibility === "hidden") return false;
    if (el.hidden) return false;
    return true;
  }

  function getManagedIds() {
    return new Set(CFG.BUTTONS.map(b => b.id));
  }

  function getExternalObstacles(chatForm, ignoreIds = new Set()) {
    const obstacles = [];
    const formRect = chatForm.getBoundingClientRect();
    const all = Array.from(chatForm.querySelectorAll("*"));

    for (const el of all) {
      if (!(el instanceof HTMLElement)) continue;
      if (ignoreIds.has(el.id)) continue;
      if (el.id === "chat-message") continue;
      if (!isElementVisible(el)) continue;

      const cs = getComputedStyle(el);
      if (cs.position !== "absolute") continue;

      const r = el.getBoundingClientRect();
      const w = r.width;
      const h = r.height;

      if (w < 18 || h < 18) continue;
      if (w > 120 || h > 120) continue;

      const nearRight = (formRect.right - r.right) < 280;
      const nearBottom = (formRect.bottom - r.bottom) < 240;
      if (!nearRight || !nearBottom) continue;

      obstacles.push({ el, rect: r });
    }

    return obstacles;
  }

  function getActiveManagedButtons() {
    return CFG.BUTTONS
      .filter(def => {
        if (def.gmOnly && !game.user?.isGM) return false;

        const el = document.getElementById(def.id);
        if (!el) return false;
        if (!isElementVisible(el)) return false;

        return true;
      })
      .map(def => ({
        ...def,
        el: document.getElementById(def.id)
      }))
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return String(a.id).localeCompare(String(b.id));
      });
  }

  function applyFinalLayout() {
    const chatForm = getChatForm();
    const chatMessage = getChatMessage();
    if (!chatForm || !chatMessage) return false;

    const managedButtons = getActiveManagedButtons();
    if (!managedButtons.length) return false;

    const chatFormRect = chatForm.getBoundingClientRect();

    // Reserve space for non-managed absolute UI that may also live in chat-form
    const externalObstacles = getExternalObstacles(chatForm, getManagedIds()).map(o => o.rect);

    const takenRects = [...externalObstacles];
    const placedRects = [];

    for (const entry of managedButtons) {
      const btn = entry.el;
      let chosen = null;

      for (let row = 0; row < CFG.MAX_ROWS && !chosen; row++) {
        for (let col = 0; col < CFG.MAX_COLS && !chosen; col++) {
          const rightPx = CFG.BASE_RIGHT_PX + col * (CFG.SIZE_PX + CFG.GAP_PX);
          const bottomPx = CFG.BASE_BOTTOM_PX + row * (CFG.SIZE_PX + CFG.GAP_PX);
          const cand = candidateRect(chatFormRect, rightPx, bottomPx, CFG.SIZE_PX);

          const overlaps = takenRects.some(r => rectsOverlap(cand, r));
          if (!overlaps) {
            chosen = { rightPx, bottomPx, row, col, rect: cand };
          }
        }
      }

      if (!chosen) {
        const rightPx = CFG.BASE_RIGHT_PX;
        const bottomPx = CFG.BASE_BOTTOM_PX + (CFG.SIZE_PX + CFG.GAP_PX);
        chosen = {
          rightPx,
          bottomPx,
          row: 1,
          col: 0,
          rect: candidateRect(chatFormRect, rightPx, bottomPx, CFG.SIZE_PX)
        };
      }

      btn.style.right = `${chosen.rightPx}px`;
      btn.style.bottom = `${chosen.bottomPx}px`;
      btn.style.zIndex = "20";

      takenRects.push(chosen.rect);
      placedRects.push({
        id: entry.id,
        order: entry.order,
        row: chosen.row,
        col: chosen.col,
        rightPx: chosen.rightPx,
        bottomPx: chosen.bottomPx,
        rect: chosen.rect
      });
    }

    // Final authoritative input padding
    const inputRect = chatMessage.getBoundingClientRect();
    let neededInset = 0;

    for (const r of takenRects) {
      const verticalOverlap = !(
        r.bottom <= inputRect.top ||
        r.top >= inputRect.bottom
      );
      if (!verticalOverlap) continue;

      const inset = chatFormRect.right - r.left;
      if (inset > neededInset) neededInset = inset;
    }

    if (neededInset > 0) {
      chatMessage.style.setProperty(
        "padding-right",
        `${Math.ceil(neededInset + 8)}px`,
        "important"
      );
    }

    log("Final layout applied.", placedRects);
    return true;
  }

  function scheduleLayout(delay = 0) {
    if (state.timer) clearTimeout(state.timer);

    state.timer = setTimeout(() => {
      state.timer = null;
      applyFinalLayout();
    }, Math.max(0, Number(delay) || 0));
  }

  function observeChatForm() {
    const chatForm = getChatForm();
    if (!chatForm) return false;

    if (state.observedChatForm === chatForm && state.chatObserver) return true;

    if (state.chatObserver) {
      try {
        state.chatObserver.disconnect();
      } catch (_) {}
      state.chatObserver = null;
    }

    state.observedChatForm = chatForm;

    state.chatObserver = new MutationObserver(() => {
      scheduleLayout(20);
    });

    state.chatObserver.observe(chatForm, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden"]
    });

    return true;
  }

  function observeBodyForChatReplacement() {
    if (state.bodyObserver) return;

    state.bodyObserver = new MutationObserver(() => {
      observeChatForm();
      scheduleLayout(20);
    });

    state.bodyObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function destroy() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    try {
      state.chatObserver?.disconnect();
    } catch (_) {}
    try {
      state.bodyObserver?.disconnect();
    } catch (_) {}

    state.chatObserver = null;
    state.bodyObserver = null;
    state.observedChatForm = null;
  }

  const api = {
    installed: true,
    applyFinalLayout,
    scheduleLayout,
    destroy
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", () => {
    observeChatForm();
    observeBodyForChatReplacement();

    scheduleLayout(0);
    scheduleLayout(100);
    scheduleLayout(300);

    state.ready = true;
    log("Ready.");
  });

  Hooks.on("renderSidebarTab", () => {
    observeChatForm();
    scheduleLayout(30);
    scheduleLayout(120);
  });

  window.addEventListener("resize", () => {
    scheduleLayout(30);
  }, { passive: true });

  Hooks.once("shutdown", () => {
    destroy();
  });
})();