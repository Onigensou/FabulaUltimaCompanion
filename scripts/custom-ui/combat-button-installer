/**
 * [CombatButton] Button Installer — Foundry VTT v12 (Module-friendly)
 * -----------------------------------------------------------------------------
 * What this does:
 * - Installs a small floating "Combat Button" (⚔️) on the client UI
 * - GM only (players will not see it)
 * - Click behavior:
 *    - If combat is NOT active on the current scene -> run BattleInit Manager
 *    - If combat IS active on the current scene     -> run BattleEnd Manager
 *
 * Module tips:
 * - Recommended: auto-run this on "ready" in your module.
 * - This script is safe to run multiple times; it cleans up old hooks/UI.
 */

(() => {
  const TAG = "[ONI][CombatButton]";
  const STATE_KEY = "__ONI_COMBATBTN_STATE__";

  // ---------------------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------------------
  const CFG = {
    // If you later expose module API functions, set this to your module id.
    // If you don't want API support, you can leave it as-is (still works).
    moduleId: "fabula-ultima-companion",

    // Macro names (must match EXACTLY your macro list) — fallback if API not found
    battleInitManagerMacroName: "BattleInit — BattleInit Manager",
    battleEndManagerMacroName: "[BattleEnd: Manager]",

    // GM-only button
    gmOnly: true,

    // Placement (matched to your CheckRoller style)
    // CheckRoller is: right=313, bottom=38, size=60
    // Put this ABOVE it:
    offsetRightPx: 313,
    offsetBottomPx: 110, // ~38 + 60 + 12

    // Visual
    sizePx: 60,
    zIndex: 81,
    iconText: "⚔️",

    // Tooltip labels
    labelStart: "Start Battle",
    labelEnd: "End Battle",

    // Optional click sound
    clickSound: null,

    // If true: small console logs. Keep false in production.
    debug: false,
  };

  // ---------------------------------------------------------------------------
  // DOM ids/classes (collision-safe)
  // ---------------------------------------------------------------------------
  const DOM = {
    ROOT_ID: "oni-combatbtn-root",
    BTN_ID: "oni-combatbtn",
    STYLE_ID: "oni-combatbtn-style",
  };

  // ---------------------------------------------------------------------------
  // Shared state bucket (prevents duplicate hooks + makes cleanup easy)
  // ---------------------------------------------------------------------------
  const STATE = (globalThis[STATE_KEY] ??= {
    hooks: [],
    installed: false,
  });

  const log = (...args) => {
    if (CFG.debug) console.log(TAG, ...args);
  };

  const cleanupHooks = () => {
    if (!Array.isArray(STATE.hooks)) STATE.hooks = [];
    for (const rec of STATE.hooks) {
      try {
        Hooks.off(rec.hook, rec.fn);
      } catch (_) {}
    }
    STATE.hooks = [];
  };

  const cleanupUI = () => {
    try { document.getElementById(DOM.ROOT_ID)?.remove(); } catch (_) {}
    try { document.getElementById(DOM.STYLE_ID)?.remove(); } catch (_) {}
  };

  // ---------------------------------------------------------------------------
  // Guards: GM-only (also cleans up UI on non-GM clients)
  // ---------------------------------------------------------------------------
  if (CFG.gmOnly && !game.user?.isGM) {
    cleanupHooks();
    cleanupUI();
    STATE.installed = false;
    log("Non-GM client: button removed/disabled.");
    return;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const getMacroByNameOrNull = (name) => game.macros?.getName?.(name) ?? null;

  const getCombatStateOnActiveScene = () => {
    const activeScene = canvas?.scene ?? null;
    const activeSceneId = activeScene?.id ?? null;

    const combats = game.combats?.contents ?? [];
    const matches = activeSceneId ? combats.filter(c => c.scene?.id === activeSceneId) : [];

    // Prefer: a combat that is "started"
    const picked =
      matches.find(c => (typeof c.started === "boolean" ? c.started : Number(c.round ?? 0) > 0)) ??
      // Fallback: combat marked active (if available)
      matches.find(c => (typeof c.active === "boolean" ? c.active : false)) ??
      // Fallback: any combat with combatants
      matches.find(c => (c.combatants?.size ?? 0) > 0) ??
      null;

    return {
      sceneId: activeSceneId,
      sceneName: activeScene?.name ?? "(no scene)",
      hasCombat: !!picked,
      combat: picked,
      matchCount: matches.length,
    };
  };

  const ensureStyle = () => {
    let style = document.getElementById(DOM.STYLE_ID);
    if (style) return style;

    style = document.createElement("style");
    style.id = DOM.STYLE_ID;
    style.textContent = `
      /* [CombatButton] Floating Button */
      #${DOM.ROOT_ID} {
        position: fixed;
        right: ${CFG.offsetRightPx}px;
        bottom: ${CFG.offsetBottomPx}px;
        z-index: ${CFG.zIndex};
        pointer-events: none; /* only button gets clicks */
      }

      #${DOM.BTN_ID} {
        pointer-events: auto;
        width: ${CFG.sizePx}px;
        height: ${CFG.sizePx}px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.22);
        background: rgba(18, 18, 22, 0.86);
        box-shadow:
          0 10px 24px rgba(0,0,0,0.35),
          0 2px 0 rgba(255,255,255,0.06) inset;
        display: grid;
        place-items: center;
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        transform: translateZ(0);
        transition: transform 120ms ease, background 120ms ease, border-color 120ms ease, opacity 120ms ease;
        position: relative;
      }

      #${DOM.BTN_ID}:hover {
        transform: translateY(-1px) scale(1.02);
        background: rgba(28, 28, 34, 0.92);
        border-color: rgba(255,255,255,0.32);
      }

      #${DOM.BTN_ID}:active {
        transform: translateY(0px) scale(0.99);
      }

      #${DOM.BTN_ID} .oni-combatbtn-icon {
        font-size: 22px;
        line-height: 1;
        filter: drop-shadow(0 2px 2px rgba(0,0,0,0.45));
      }

      #${DOM.BTN_ID} .oni-combatbtn-tip {
        position: absolute;
        right: 0;
        bottom: calc(100% + 10px);
        background: rgba(10,10,12,0.92);
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 10px;
        padding: 8px 10px;
        font-size: 12px;
        color: rgba(255,255,255,0.9);
        white-space: nowrap;
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 120ms ease, transform 120ms ease;
        pointer-events: none;
        box-shadow: 0 10px 24px rgba(0,0,0,0.35);
      }

      #${DOM.BTN_ID}:hover .oni-combatbtn-tip {
        opacity: 1;
        transform: translateY(0);
      }

      /* Optional: when combat is active, give a slight "alert" border */
      #${DOM.BTN_ID}[data-mode="end"] {
        border-color: rgba(255, 140, 140, 0.40);
      }
    `;
    document.head.appendChild(style);
    return style;
  };

  const ensureRoot = () => {
    let root = document.getElementById(DOM.ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = DOM.ROOT_ID;
      document.body.appendChild(root);
    }
    return root;
  };

  // API-first, macro-fallback runner
  const runBattleInit = async () => {
    const api = game.modules.get(CFG.moduleId)?.api;
    if (api?.battleInitManager && typeof api.battleInitManager === "function") {
      return api.battleInitManager();
    }

    const m = getMacroByNameOrNull(CFG.battleInitManagerMacroName);
    if (!m) {
      ui?.notifications?.error?.(`Combat Button: Macro not found: "${CFG.battleInitManagerMacroName}"`);
      console.error(`${TAG} Macro not found:`, CFG.battleInitManagerMacroName);
      return;
    }
    return m.execute();
  };

  const runBattleEnd = async () => {
    const api = game.modules.get(CFG.moduleId)?.api;
    if (api?.battleEndManager && typeof api.battleEndManager === "function") {
      return api.battleEndManager();
    }

    const m = getMacroByNameOrNull(CFG.battleEndManagerMacroName);
    if (!m) {
      ui?.notifications?.error?.(`Combat Button: Macro not found: "${CFG.battleEndManagerMacroName}"`);
      console.error(`${TAG} Macro not found:`, CFG.battleEndManagerMacroName);
      return;
    }
    return m.execute();
  };

  const buildButton = () => {
    const root = ensureRoot();
    root.innerHTML = "";

    const btn = document.createElement("div");
    btn.id = DOM.BTN_ID;
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("aria-label", "Combat Button");

    btn.innerHTML = `
      <div class="oni-combatbtn-tip"></div>
      <div class="oni-combatbtn-icon">${CFG.iconText}</div>
    `;

    const tipEl = btn.querySelector(".oni-combatbtn-tip");

    const refreshState = () => {
      const st = getCombatStateOnActiveScene();
      btn.dataset.mode = st.hasCombat ? "end" : "start";
      if (tipEl) tipEl.textContent = st.hasCombat ? CFG.labelEnd : CFG.labelStart;
      log("refreshState", { mode: btn.dataset.mode, scene: st.sceneName, matchCount: st.matchCount });
    };

    const onClick = async (ev) => {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();

      refreshState();

      if (CFG.clickSound) {
        try {
          AudioHelper.play({ src: CFG.clickSound, volume: 0.6, autoplay: true, loop: false }, true);
        } catch (_) {}
      }

      try {
        if (btn.dataset.mode === "end") {
          await runBattleEnd();
        } else {
          await runBattleInit();
        }
      } catch (e) {
        console.error(`${TAG} Button click error:`, e);
        ui?.notifications?.error?.("Combat Button: An error occurred. Check console.");
      } finally {
        refreshState();
      }
    };

    const onKeyDown = (ev) => {
      if (ev.key === "Enter" || ev.key === " ") onClick(ev);
    };

    btn.addEventListener("click", onClick);
    btn.addEventListener("keydown", onKeyDown);
    btn.addEventListener("mouseenter", refreshState);

    root.appendChild(btn);
    refreshState();

    // --- Hook refresh (no polling) ---
    cleanupHooks();

    const hook = (hookName, fn) => {
      Hooks.on(hookName, fn);
      STATE.hooks.push({ hook: hookName, fn });
    };

    hook("createCombat", refreshState);
    hook("updateCombat", refreshState);
    hook("deleteCombat", refreshState);

    // IMPORTANT for your system: when you move scenes, refresh immediately
    hook("canvasReady", refreshState);

    return btn;
  };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  const boot = () => {
    // Always clean then re-install (safe for module reloads)
    cleanupUI();
    ensureStyle();
    buildButton();
    STATE.installed = true;
    log("Installed");
  };

  if (game.ready) boot();
  else Hooks.once("ready", boot);
})();
