// ============================================================================
// ONI — Chat Sidebar "Character Sheet" Button (Foundry VTT v12) — Module Script
// ----------------------------------------------------------------------------
// Adds an icon button to the bottom-right of the chat input bar.
// Click => opens game.user.character sheet + plays LOCAL sound.
// ============================================================================

(() => {
  const CFG = {
  BUTTON_ID: "oni-chat-open-character-btn",
  STYLE_ID: "oni-chat-open-character-btn-style",

  IMG_URL:
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20MainCommand%20(Others)/03_MainCommands/01/character.png",

  // UPDATED SOUND:
  SOUND_URL:
    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",

  VOLUME: 0.8,

  // Auto-dock layout
  SIZE_PX: 30,
  GAP_PX: 6,
  BASE_RIGHT_PX: 6,
  BASE_BOTTOM_PX: 6,
  MAX_COLS: 12,
  MAX_ROWS: 4,
};

  const log = (...args) => console.log("[ONI ChatCharBtn]", ...args);

  const state = {
  resizeHandler: null,
  redockTimer: null
};

function getChatForm() {
  return document.querySelector("#chat-form");
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
        chosen = { rightPx, bottomPx, row, col };
      }
    }
  }

  if (!chosen) {
    chosen = {
      rightPx: CFG.BASE_RIGHT_PX,
      bottomPx: CFG.BASE_BOTTOM_PX + (CFG.SIZE_PX + CFG.GAP_PX),
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

  log("Auto-docked.", chosen);
  return true;
}

function scheduleRedock(delay = 0) {
  if (state.redockTimer) clearTimeout(state.redockTimer);

  state.redockTimer = setTimeout(() => {
    state.redockTimer = null;
    autoDockButton();
  }, Math.max(0, Number(delay) || 0));
}

function installResizeListener() {
  if (state.resizeHandler) return;

  state.resizeHandler = () => {
    scheduleRedock(0);
  };

  window.addEventListener("resize", state.resizeHandler, { passive: true });
}

  function injectCss() {
    if (document.getElementById(CFG.STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = CFG.STYLE_ID;
    style.textContent = `
/* ========== ONI Chat Character Button ========== */
#chat-form { position: relative; }

#${CFG.BUTTON_ID} {
  width: ${CFG.SIZE_PX}px; height: ${CFG.SIZE_PX}px;
  min-width: ${CFG.SIZE_PX}px; min-height: ${CFG.SIZE_PX}px;

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

#${CFG.BUTTON_ID}:active { transform: translateY(1px); }

#${CFG.BUTTON_ID} img {
  width: 22px;
  height: 22px;
  display: block;
  pointer-events: none;
}

/* Prevent overlap with typing */
`;
    document.head.appendChild(style);
  }

  async function playOpenSoundLocalOnly() {
    try {
      // LOCAL ONLY (no broadcast)
      await AudioHelper.play(
        { src: CFG.SOUND_URL, volume: CFG.VOLUME, loop: false },
        false
      );
    } catch (err) {
      console.warn("[ONI ChatCharBtn] Sound failed to play:", err);
    }
  }

  async function onClickOpenCharacter() {
    const actor = game.user?.character;

    if (!actor) {
      ui.notifications.warn(
        "No linked Character found (User Configuration → Character)."
      );
      return;
    }

    try {
      actor.sheet.render(true);
      await playOpenSoundLocalOnly();
    } catch (err) {
      console.error("[ONI ChatCharBtn] Failed to open sheet:", err);
      ui.notifications.error("Failed to open your character sheet. Check console.");
    }
  }

  function ensureButton() {
    // already exists
    if (document.getElementById(CFG.BUTTON_ID)) return true;

    const chatForm = getChatForm();
    if (!chatForm) return false;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = CFG.BUTTON_ID;
    btn.title = "Open Character Sheet";
    btn.setAttribute("aria-label", "Open Character Sheet");

    const img = document.createElement("img");
    img.src = CFG.IMG_URL;
    img.alt = "Character";

    btn.appendChild(img);
    btn.addEventListener("click", onClickOpenCharacter);

    chatForm.appendChild(btn);
    return true;
  }

function installOrReattach() {
  injectCss();
  const ok = ensureButton();
  if (!ok) return false;

  installResizeListener();

  scheduleRedock(0);
  scheduleRedock(50);
  scheduleRedock(250);

  log("Button ready (auto-docked).");
  return true;
}

  // Install on ready, and re-attach if sidebar tab re-renders
  Hooks.once("ready", () => {
    log("Module script loaded on ready.");
    installOrReattach();
  });

  Hooks.on("renderSidebarTab", () => {
    // Chat sidebar can re-render; re-attach if needed
    installOrReattach();
  });
})();
