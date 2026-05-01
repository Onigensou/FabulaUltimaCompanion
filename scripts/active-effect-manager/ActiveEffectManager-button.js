// ============================================================================
// ActiveEffectManager-button.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Adds a GM-only "AE" button near the chat controls.
// - Clicking it opens the Active Effect Manager UI.
// - This script does not apply/remove effects directly.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:Button]";
  const DEBUG = true;

  const BUTTON_ID = "oni-active-effect-manager-chat-button";
  const STYLE_ID = "oni-active-effect-manager-button-style";

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // --------------------------------------------------------------------------
  // API root
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager = globalThis.FUCompanion.api.activeEffectManager || {};
    return globalThis.FUCompanion.api.activeEffectManager;
  }

  function getManagerRoot() {
    return globalThis.FUCompanion?.api?.activeEffectManager ?? null;
  }

  // --------------------------------------------------------------------------
  // Style
  // --------------------------------------------------------------------------

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BUTTON_ID} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;

        min-width: 34px;
        height: 28px;
        padding: 0 8px;
        margin: 2px;

        border-radius: 7px;
        border: 1px solid rgba(255,255,255,.24);

        background: rgba(24, 20, 18, .95);
        color: #f7efe2;

        font-size: 12px;
        font-weight: 800;
        letter-spacing: .02em;

        cursor: pointer;
        box-shadow: 0 1px 4px rgba(0,0,0,.35);
      }

      #${BUTTON_ID}:hover {
        background: rgba(58, 45, 34, .98);
        color: #ffffff;
        border-color: rgba(255,255,255,.38);
      }

      #${BUTTON_ID}:active {
        transform: translateY(1px);
      }

      #${BUTTON_ID}.missing-ui {
        background: rgba(90, 20, 20, .95);
      }
    `;

    document.head.appendChild(style);
  }

  // --------------------------------------------------------------------------
  // DOM placement
  // --------------------------------------------------------------------------

  function findChatButtonContainer() {
    return (
      document.querySelector("#chat-controls") ??
      document.querySelector("#chat-form") ??
      document.querySelector("#chat") ??
      document.querySelector("#ui-right") ??
      null
    );
  }

  function findPreferredInsertBeforeTarget() {
    return (
      document.querySelector("#oni-exp-awarder-chat-button") ??
      document.querySelector("[data-oni-exp-awarder]") ??
      document.querySelector(".oni-exp-awarder-button") ??
      null
    );
  }

  function openManagerUi() {
    const root = getManagerRoot();

    const open =
      root?.ui?.open ??
      root?.openUI ??
      null;

    if (typeof open !== "function") {
      ui.notifications?.warn?.("Active Effect Manager UI is not loaded yet.");
      warn("UI API missing. Make sure ActiveEffectManager-ui.js is loaded before ActiveEffectManager-button.js.");
      return;
    }

    return open();
  }

  function createButton() {
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.type = "button";
    btn.innerHTML = "AE";
    btn.title = "Open Active Effect Manager";
    btn.dataset.oniActiveEffectManagerButton = "1";

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openManagerUi();
    });

    return btn;
  }

  function installButton() {
    if (!game.user?.isGM) return false;

    injectStyle();

    const existing = document.getElementById(BUTTON_ID);
    if (existing) return true;

    const container = findChatButtonContainer();

    if (!container) {
      warn("Could not find chat button container yet.");
      return false;
    }

    const btn = createButton();

    const beforeTarget = findPreferredInsertBeforeTarget();

    if (beforeTarget?.parentElement) {
      beforeTarget.parentElement.insertBefore(btn, beforeTarget);
    } else {
      container.prepend(btn);
    }

    log("Installed Active Effect Manager chat button.");

    return true;
  }

  function scheduleInstall(delayMs = 50) {
    setTimeout(() => {
      try {
        installButton();
      } catch (e) {
        warn("Scheduled button install failed.", e);
      }
    }, delayMs);
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.1.0",
    installButton,
    scheduleInstall,
    open: openManagerUi,
    buttonId: BUTTON_ID
  };

  const root = ensureApiRoot();
  root.button = api;
  root.installButton = installButton;

  try {
    const mod = game.modules?.get?.(MODULE_ID);
    if (mod) {
      mod.api = mod.api || {};
      mod.api.activeEffectManager = mod.api.activeEffectManager || {};
      mod.api.activeEffectManager.button = api;
      mod.api.activeEffectManager.installButton = installButton;
    }
  } catch (e) {
    warn("Could not expose button API on module object.", e);
  }

  // --------------------------------------------------------------------------
  // Hooks
  // --------------------------------------------------------------------------

  Hooks.once("ready", () => {
    const root = ensureApiRoot();
    root.button = api;
    root.installButton = installButton;

    scheduleInstall(50);
    scheduleInstall(400);
    scheduleInstall(1200);

    log("Ready. Active Effect Manager button script installed.");
  });

  Hooks.on("renderChatLog", () => {
    scheduleInstall(50);
  });

  Hooks.on("collapseSidebar", () => {
    scheduleInstall(100);
  });

  Hooks.on("renderSidebarTab", (_app, _html, data) => {
    if (data?.tabName === "chat") {
      scheduleInstall(50);
    }
  });
})();