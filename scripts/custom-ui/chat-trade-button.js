// ============================================================================
// ONI — Chat Sidebar "Trade" Button (Foundry VTT v12) — Module Script
// ----------------------------------------------------------------------------
// Adds an icon button to the bottom-right of the chat input bar.
// Click => calls window["oni.TradeStartTrade"].startTrade()
// (This is the same entrypoint described in your Item Trading docs.)
// ============================================================================

(() => {
  const CFG = {
    BUTTON_ID: "oni-chat-open-trade-btn",
    STYLE_ID: "oni-chat-open-trade-btn-style",

    IMG_URL:
      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Skill%20Icon/Elsword/Lithia/GemblissPassive1.png",

    // Placement (assumes you already have 2 buttons at 6px and 44px)
    RIGHT_OFFSET_PX: 82,
    BOTTOM_OFFSET_PX: 6,

    // Optional: keep your chat input padded enough for 3 buttons
    CHAT_PAD_RIGHT_PX: 126,
  };

  const log = (...args) => console.log("[ONI ChatTradeBtn]", ...args);

  function injectCss() {
    if (document.getElementById(CFG.STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = CFG.STYLE_ID;
    style.textContent = `
/* ========== ONI Chat Trade Button ========== */
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

/* Prevent overlap with typing (3 buttons) */
#chat-message { padding-right: ${CFG.CHAT_PAD_RIGHT_PX}px !important; }
`;
    document.head.appendChild(style);
  }

  async function onClickTrade() {
    const api = window["oni.TradeStartTrade"];

    if (!api?.startTrade) {
      ui.notifications?.error?.(
        "OniTrade: StartTrade API not found. Is the module enabled / scripts loaded?"
      );
      console.error("[ONI ChatTradeBtn] Missing window['oni.TradeStartTrade'].");
      return;
    }

    // Extra helpful debug: the docs recommend Trade_ModuleListener be installed before trading
    // (so the socket handler exists). :contentReference[oaicite:1]{index=1}
    const listenerInstalled = !!window.__OniTradeModule__?.installed;
    log("Click: startTrade()", { listenerInstalled });

    try {
      await api.startTrade(); // entrypoint described in docs :contentReference[oaicite:2]{index=2}
    } catch (err) {
      console.error("[ONI ChatTradeBtn] startTrade failed:", err);
      ui.notifications?.error?.("OniTrade: startTrade failed. Check console.");
    }
  }

  function ensureButton() {
    if (document.getElementById(CFG.BUTTON_ID)) return true;

    const chatForm = document.querySelector("#chat-form");
    if (!chatForm) return false;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = CFG.BUTTON_ID;
    btn.title = "Item Trading";
    btn.setAttribute("aria-label", "Item Trading");

    const img = document.createElement("img");
    img.src = CFG.IMG_URL;
    img.alt = "Trade";

    btn.appendChild(img);
    btn.addEventListener("click", onClickTrade);

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
