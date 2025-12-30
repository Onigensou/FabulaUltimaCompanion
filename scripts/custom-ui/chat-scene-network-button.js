// ============================================================================
// ONI — Chat Sidebar "Scene Network Switch" Button (Foundry VTT v12) — Module Script
// ----------------------------------------------------------------------------
// Adds a GM-only icon button to the bottom-right of the chat input bar.
// Click => opens "Scene Network Switcher" dialog (reads current scene links).
//
// NEW: Auto-dock placement to avoid overlapping other chat-bar buttons.
// - Scans existing absolute-position UI in #chat-form
// - Places the door button in the first free "slot" (col/row grid)
// - Adjusts #chat-message padding-right ONLY if needed (and only for GM)
//
// Data source (current scene):
// flags.fabula-ultima-companion.oniFabula.sceneNetwork  (JSON string)
// Example: [{"name":"Overworld","id":"Scene.xxxxxx"}, ...]
//
// Switch behavior:
// - Preload scene first: await game.scenes.preload(targetScene.id)
// - Activate scene:      await targetScene.activate()   (switches all clients)
// - View on GM:          await targetScene.view()
// ============================================================================

(() => {
  const CFG = {
    MODULE_ID: "fabula-ultima-companion",

    BUTTON_ID: "oni-chat-scene-network-btn",
    STYLE_ID: "oni-chat-scene-network-btn-style",

    // Door icon requested by Oni
    IMG_URL: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/door.png",

    // Chat bar button size/spacing
    SIZE_PX: 30,
    GAP_PX: 6,

    // Anchor (bottom-right base point)
    BASE_RIGHT_PX: 6,
    BASE_BOTTOM_PX: 6,

    // How many "slots" we try before giving up
    MAX_COLS: 10,
    MAX_ROWS: 4,

    // Preload + switch settings
    USE_PRELOAD: true,
    PRELOAD_NOTIFY: false,
    PRELOAD_PAUSE_MS: 150,

    // Dialog sizing
    DIALOG_WIDTH: 980,
    GRID_MAX_HEIGHT: 680
  };

  const log = (...args) => console.log("[ONI SceneNetBtn]", ...args);

  // ---------------------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------------------
  function injectCss() {
    if (document.getElementById(CFG.STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = CFG.STYLE_ID;
    style.textContent = `
/* ========== ONI Chat Scene Network Button (GM only) ========== */
#chat-form { position: relative; }

#${CFG.BUTTON_ID} {
  width: ${CFG.SIZE_PX}px; height: ${CFG.SIZE_PX}px;
  min-width: ${CFG.SIZE_PX}px; min-height: ${CFG.SIZE_PX}px;

  position: absolute;
  right: ${CFG.BASE_RIGHT_PX}px;   /* will be overridden by JS auto-dock */
  bottom: ${CFG.BASE_BOTTOM_PX}px; /* will be overridden by JS auto-dock */
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
`;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Auto-dock logic (avoid overlap)
  // ---------------------------------------------------------------------------
  function rectsOverlap(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }

  function getAbsoluteObstacles(chatForm, ignoreIds = new Set()) {
    const obstacles = [];
    const formRect = chatForm.getBoundingClientRect();

    // Find elements inside chatForm that are "button-like" and absolute-positioned
    const all = Array.from(chatForm.querySelectorAll("*"));

    for (const el of all) {
      if (!(el instanceof HTMLElement)) continue;

      if (ignoreIds.has(el.id)) continue;

      // Skip the input itself
      if (el.id === "chat-message") continue;

      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (cs.position !== "absolute") continue;

      const r = el.getBoundingClientRect();

      // Ignore tiny stuff / weird elements
      const w = r.width;
      const h = r.height;
      if (w < 18 || h < 18) continue;
      if (w > 80 || h > 80) continue;

      // Must be near the bottom-right area of chat-form (so we don't treat random abs elements elsewhere)
      const nearRight = (formRect.right - r.right) < 220;
      const nearBottom = (formRect.bottom - r.bottom) < 220;
      if (!nearRight || !nearBottom) continue;

      obstacles.push({ el, rect: r });
    }

    return obstacles;
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

  function autoDockButton() {
    if (!game.user?.isGM) return;

    const chatForm = document.querySelector("#chat-form");
    const btn = document.getElementById(CFG.BUTTON_ID);
    const chatMessage = document.querySelector("#chat-message");
    if (!chatForm || !btn || !chatMessage) return;

    // Ensure the button is measurable (must be in DOM first)
    const chatFormRect = chatForm.getBoundingClientRect();

    // Collect obstacles (including other custom buttons)
    const ignore = new Set([CFG.BUTTON_ID]);
    const obstacles = getAbsoluteObstacles(chatForm, ignore).map(o => o.rect);

    // Try parking slots from bottom-right going left, then up
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

    // Fallback if somehow everything is packed
    if (!chosen) {
      chosen = {
        rightPx: CFG.BASE_RIGHT_PX,
        bottomPx: CFG.BASE_BOTTOM_PX + (CFG.SIZE_PX + CFG.GAP_PX),
        rect: candidateRect(chatFormRect, CFG.BASE_RIGHT_PX, CFG.BASE_BOTTOM_PX + (CFG.SIZE_PX + CFG.GAP_PX), CFG.SIZE_PX),
        row: 1,
        col: 0
      };
    }

    // Apply position
    btn.style.right = `${chosen.rightPx}px`;
    btn.style.bottom = `${chosen.bottomPx}px`;

    // Now adjust typing padding ONLY if any obstacle overlaps the input vertically
    // (including our button if it sits over the input)
    const inputRect = chatMessage.getBoundingClientRect();
    const updatedObstacles = getAbsoluteObstacles(chatForm, new Set()).map(o => o.rect);

    const relevant = updatedObstacles.filter(r => {
      const verticalOverlap = !(r.bottom <= inputRect.top || r.top >= inputRect.bottom);
      return verticalOverlap;
    });

    let neededInset = 0;
    for (const r of relevant) {
      // How far from the right edge is the left side of this obstacle
      const inset = chatFormRect.right - r.left;
      if (inset > neededInset) neededInset = inset;
    }

    if (neededInset > 0) {
      // Add a little breathing room
      const finalPad = Math.ceil(neededInset + 8);
      chatMessage.style.setProperty("padding-right", `${finalPad}px`, "important");
    }
  }

  // ---------------------------------------------------------------------------
  // Button injection (GM only)
  // ---------------------------------------------------------------------------
  function ensureButton() {
    if (!game.user?.isGM) return false;

    if (document.getElementById(CFG.BUTTON_ID)) return true;

    const chatForm = document.querySelector("#chat-form");
    if (!chatForm) return false;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = CFG.BUTTON_ID;
    btn.title = "Scene Network";
    btn.setAttribute("aria-label", "Open Scene Network");

    const img = document.createElement("img");
    img.src = CFG.IMG_URL;
    img.alt = "Scene Network";

    btn.appendChild(img);
    btn.addEventListener("click", () => openSceneNetworkSwitcher());

    chatForm.appendChild(btn);

    // After it exists, dock it
    autoDockButton();
    return true;
  }

  function installOrReattach() {
    if (!game.user?.isGM) return;
    injectCss();
    const ok = ensureButton();
    if (ok) {
      // Re-dock after a tick in case other modules inject after us
      setTimeout(() => autoDockButton(), 50);
      setTimeout(() => autoDockButton(), 250);
      log("Button ready (auto-docked).");
    }
  }

  // ---------------------------------------------------------------------------
  // Scene Network Switcher (dialog)
  // ---------------------------------------------------------------------------
  async function openSceneNetworkSwitcher() {
    if (!game.user?.isGM) return;

    const currentScene = canvas?.scene;
    if (!currentScene) {
      ui.notifications?.error?.("Scene Network: No active scene found.");
      return;
    }

    const fabulaData = await currentScene.getFlag(CFG.MODULE_ID, "oniFabula") || {};
    const rawNetwork = fabulaData.sceneNetwork ?? "[]";

    let links = [];
    try {
      links = Array.isArray(rawNetwork) ? rawNetwork : JSON.parse(String(rawNetwork || "[]"));
    } catch (e) {
      console.warn("[SceneNetworkSwitcher] Failed to parse sceneNetwork JSON:", rawNetwork, e);
      ui.notifications?.error?.("Scene Network: sceneNetwork data is invalid JSON.");
      return;
    }

    links = (links || [])
      .map(r => ({ name: String(r?.name ?? "").trim(), id: String(r?.id ?? "").trim() }))
      .filter(r => r.name || r.id);

    if (!links.length) {
      ui.notifications?.info?.("Scene Network: No linked scenes found on this scene.");
      return;
    }

    async function resolveSceneById(idString) {
      const id = String(idString || "").trim();
      if (!id) return null;

      try {
        if (id.startsWith("Scene.") || id.includes(".")) {
          const doc = await fromUuid(id);
          if (doc?.documentName === "Scene") return doc;
        }
      } catch (e) {}

      const byId = game.scenes?.get(id);
      if (byId) return byId;

      const byName = game.scenes?.find(s => s?.name === id);
      if (byName) return byName;

      return null;
    }

    function sceneThumb(scene) {
      return scene?.thumb ?? scene?.thumbnail ?? scene?.img ?? "icons/svg/map.svg";
    }

    function escapeHtml(str) {
      return String(str ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    const resolved = [];
    for (const link of links) {
      const target = await resolveSceneById(link.id);
      resolved.push({
        displayName: link.name || target?.name || "(Unnamed)",
        idInput: link.id,
        scene: target,
        thumb: target ? sceneThumb(target) : "icons/svg/hazard.svg",
        ok: !!target
      });
    }

    if (!resolved.some(r => r.ok)) {
      ui.notifications?.error?.("Scene Network: None of the linked IDs match any Scene.");
      console.warn("[SceneNetworkSwitcher] All linked scenes missing:", resolved);
      return;
    }

    let selectedIndex = -1;

    function setSelected(htmlRoot, idx) {
      const items = htmlRoot.find(".oni-net-item");
      items.removeClass("selected").attr("aria-pressed", "false");

      const target = htmlRoot.find(`.oni-net-item[data-index="${idx}"]`);
      if (!target.length) return;

      target.addClass("selected").attr("aria-pressed", "true");
      selectedIndex = Number(idx);
    }

    function getSelectedEntry(htmlRoot) {
      if (selectedIndex >= 0 && resolved[selectedIndex]) return resolved[selectedIndex];

      const selectedEl = htmlRoot.find(".oni-net-item.selected").first();
      if (!selectedEl.length) return null;

      const idx = Number(selectedEl.attr("data-index"));
      if (Number.isNaN(idx)) return null;
      return resolved[idx] ?? null;
    }

    const style = `
      <style>
        .oni-net-dialog { display: flex; flex-direction: column; gap: 10px; }
        .oni-net-hint { opacity: .85; font-size: 12px; }

        .oni-net-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          max-height: ${CFG.GRID_MAX_HEIGHT}px;
          overflow: auto;
          padding-right: 4px;
        }

        .oni-net-item {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 10px;
          border-radius: 12px;
          border: 2px solid var(--color-border-light-primary, #9993);
          background: rgba(0,0,0,0.02);
          cursor: pointer;
          user-select: none;
          transition: filter 0.08s ease, box-shadow 0.08s ease;
        }

        .oni-net-item:hover { filter: brightness(1.03); }
        .oni-net-item:active { filter: brightness(0.98); }

        .oni-net-item.disabled {
          opacity: .45;
          filter: grayscale(0.6);
          cursor: not-allowed;
        }

        .oni-net-item.selected {
          border-color: var(--color-border-highlight, #d9d7cb);
          box-shadow: 0 0 0 2px var(--color-border-highlight, #d9d7cb) inset;
          background: rgba(217,215,203,0.10);
        }

        .oni-net-thumb {
          width: 100%;
          height: 170px;
          object-fit: cover;
          border-radius: 10px;
          border: 1px solid var(--color-border-light-primary, #9993);
          background: rgba(0,0,0,0.03);
        }

        .oni-net-name { font-weight: 700; line-height: 1.1; font-size: 14px; }
        .oni-net-sub  { opacity: .75; font-size: 11px; margin-top: 4px; word-break: break-all; }

        @media (max-width: 820px) {
          .oni-net-grid { grid-template-columns: 1fr; }
          .oni-net-thumb { height: 190px; }
        }
      </style>
    `;

    const itemsHtml = resolved.map((r, idx) => {
      const disabledClass = r.ok ? "" : "disabled";
      const label = escapeHtml(r.displayName);
      const idLine = escapeHtml(r.idInput || "(no id)");
      const thumb = escapeHtml(r.thumb);

      return `
        <div class="oni-net-item ${disabledClass}" data-index="${idx}" role="button" aria-pressed="false" tabindex="0">
          <img class="oni-net-thumb" src="${thumb}" />
          <div>
            <div class="oni-net-name">${label}</div>
            <div class="oni-net-sub">ID: ${idLine}${r.ok ? "" : " (not found)"}</div>
          </div>
        </div>
      `;
    }).join("");

    const content = `
      ${style}
      <div class="oni-net-dialog">
        <div class="oni-net-hint">
          Current Scene: <b>${escapeHtml(currentScene.name)}</b><br/>
          Click a scene card to select it, then press <b>Switch Scene</b>.
        </div>
        <div class="oni-net-grid">
          ${itemsHtml}
        </div>
      </div>
    `;

    const dlg = new Dialog({
      title: "Scene Network — Switch Scene",
      content,
      buttons: {
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" },
        go: {
          icon: '<i class="fas fa-exchange-alt"></i>',
          label: "Switch Scene",
          callback: async (html) => {
            const entry = getSelectedEntry(html);
            if (!entry) return ui.notifications?.warn?.("Pick a scene first.");
            if (!entry.scene) return ui.notifications?.error?.("That linked scene could not be found.");

            const targetScene = entry.scene;

            if (CFG.USE_PRELOAD) {
              try {
                if (CFG.PRELOAD_NOTIFY) ui.notifications?.info?.(`Preloading: ${targetScene.name}…`);
                await game.scenes.preload(targetScene.id);
                await wait(CFG.PRELOAD_PAUSE_MS);
              } catch (e) {
                console.warn("[SceneNetworkSwitcher] Preload failed (continuing anyway):", e);
                ui.notifications?.warn?.("Preload failed (continuing). Check console if you see hitching.");
              }
            }

            try {
              await targetScene.activate();
              await targetScene.view();
              ui.notifications?.info?.(`Switched to: ${targetScene.name}`);
            } catch (e) {
              console.error("[SceneNetworkSwitcher] Activate/View failed:", e);
              ui.notifications?.error?.("Failed to switch scenes. Check console.");
            }
          }
        }
      },
      default: "go",
      render: (html) => {
        const firstOkIndex = resolved.findIndex(r => r.ok);
        if (firstOkIndex >= 0) setSelected(html, firstOkIndex);

        html.on("click", ".oni-net-item", (ev) => {
          const el = $(ev.currentTarget);
          if (el.hasClass("disabled")) return;
          const idx = Number(el.attr("data-index"));
          if (!Number.isNaN(idx)) setSelected(html, idx);
        });

        html.on("keydown", ".oni-net-item", (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          const el = $(ev.currentTarget);
          if (el.hasClass("disabled")) return;
          const idx = Number(el.attr("data-index"));
          if (!Number.isNaN(idx)) setSelected(html, idx);
        });
      }
    }, { width: CFG.DIALOG_WIDTH });

    dlg.render(true);
  }

  // ---------------------------------------------------------------------------
  // Hooks
  // ---------------------------------------------------------------------------
  Hooks.once("ready", () => {
    if (!game.user?.isGM) return;
    installOrReattach();

    // expose for debug / other scripts
    window.oni = window.oni || {};
    window.oni.SceneNetworkSwitcher = { open: openSceneNetworkSwitcher };
  });

  Hooks.on("renderSidebarTab", () => {
    // Re-attach on chat re-render
    if (!game.user?.isGM) return;
    installOrReattach();
  });

  // Also re-dock when the sidebar is resized (this prevents new overlaps)
  window.addEventListener("resize", () => {
    if (!game.user?.isGM) return;
    setTimeout(() => autoDockButton(), 50);
  });
})();
