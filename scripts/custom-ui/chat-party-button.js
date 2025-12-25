// ============================================================================
// ONI — Chat Sidebar "Party Sheet" Button (Foundry VTT v12) — Module Script
// ----------------------------------------------------------------------------
// Adds an icon button to the bottom-right of the chat input bar.
// Click => opens the "party" sheet (Database Actor) via db-resolver public API:
//   window.FUCompanion.api.getCurrentGameDb()
// Plays LOCAL sound only.
// ============================================================================

(() => {
  const CFG = {
    BUTTON_ID: "oni-chat-open-party-btn",
    STYLE_ID: "oni-chat-open-party-btn-style",

    // Reuse the same icon (change if you want later)
    IMG_URL:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/FFXIVIcons%20MainCommand%20(Others)/03_MainCommands/06/pvp_team.png",

    SOUND_URL:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BattleCursor_4.wav",

    VOLUME: 0.8,

    // If you already have the Character button at bottom-right,
    // this shifts the Party button left so they don't overlap.
    RIGHT_OFFSET_PX: 44, // 6px(base) + ~38px spacing
    BOTTOM_OFFSET_PX: 6,
  };

  const log = (...args) => console.log("[ONI ChatPartyBtn]", ...args);

  function injectCss() {
    if (document.getElementById(CFG.STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = CFG.STYLE_ID;
    style.textContent = `
/* ========== ONI Chat Party Button ========== */
#chat-form { position: relative; }

#${CFG.BUTTON_ID} {
  width: 30px; height: 30px;
  min-width: 30px; min-height: 30px;

  position: absolute;
  right: ${CFG.RIGHT_OFFSET_PX}px;
  bottom: ${CFG.BOTTOM_OFFSET_PX}px;
  z-index: 5;

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

/* Give extra right padding so multiple buttons don't overlap your typing */
#chat-message { padding-right: 84px !important; }
`;
    document.head.appendChild(style);
  }

  async function playOpenSoundLocalOnly() {
    try {
      await AudioHelper.play(
        { src: CFG.SOUND_URL, volume: CFG.VOLUME, loop: false },
        false // LOCAL ONLY (no broadcast)
      );
    } catch (err) {
      console.warn("[ONI ChatPartyBtn] Sound failed to play:", err);
    }
  }

  /**
   * Party sheet = Database Actor from db-resolver public API:
   * window.FUCompanion.api.getCurrentGameDb()
   *
   * Returned object includes:
   * - db: the database Actor
   * - source: optional token override actor (synthetic) for per-scene props
   */
  async function resolvePartyActorToOpen() {
    const api = window.FUCompanion?.api;
    if (!api?.getCurrentGameDb) {
      ui.notifications.warn(
        "Party button: db-resolver API not found. Load db-resolver.js before this script."
      );
      return null;
    }

    const data = await api.getCurrentGameDb();
    const db = data?.db ?? null;
    const source = data?.source ?? null;

    // Prefer "source" if present (token override), else db
    return source || db;
  }

  async function onClickOpenParty() {
    const actor = await resolvePartyActorToOpen();
    if (!actor) return;

    try {
      actor.sheet.render(true);
      await playOpenSoundLocalOnly();
    } catch (err) {
      console.error("[ONI ChatPartyBtn] Failed to open party sheet:", err);
      ui.notifications.error("Failed to open Party sheet. Check console.");
    }
  }

  function ensureButton() {
    if (document.getElementById(CFG.BUTTON_ID)) return true;

    const chatForm = document.querySelector("#chat-form");
    if (!chatForm) return false;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = CFG.BUTTON_ID;
    btn.title = "Open Party Sheet";
    btn.setAttribute("aria-label", "Open Party Sheet");

    const img = document.createElement("img");
    img.src = CFG.IMG_URL;
    img.alt = "Party";

    btn.appendChild(img);
    btn.addEventListener("click", onClickOpenParty);

    chatForm.appendChild(btn);
    return true;
  }

  function installOrReattach() {
    injectCss();
    const ok = ensureButton();
    if (ok) log("Button ready.");
  }

  Hooks.once("ready", () => {
    log("Module script loaded on ready.");
    installOrReattach();
  });

  Hooks.on("renderSidebarTab", () => {
    installOrReattach();
  });
})();
