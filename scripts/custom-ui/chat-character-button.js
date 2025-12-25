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
  };

  const log = (...args) => console.log("[ONI ChatCharBtn]", ...args);

  function injectCss() {
    if (document.getElementById(CFG.STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = CFG.STYLE_ID;
    style.textContent = `
/* ========== ONI Chat Character Button ========== */
#chat-form { position: relative; }

#${CFG.BUTTON_ID} {
  width: 30px; height: 30px;
  min-width: 30px; min-height: 30px;

  position: absolute;
  right: 6px;
  bottom: 6px;
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

/* Prevent overlap with typing */
#chat-message { padding-right: 42px !important; }
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

    const chatForm = document.querySelector("#chat-form");
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
    if (ok) log("Button ready.");
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
