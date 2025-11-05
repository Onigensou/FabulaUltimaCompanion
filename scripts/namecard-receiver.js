// scripts/namecard-receiver.js
// Shows JRPG-style NameCards on THIS client. Listens to module socket.
// Exposes: window.FUCompanion.api.showNameCardLocal(title, options)

(() => {
  window.FUCompanion = window.FUCompanion || { api: {} };

  const STYLE_ID = "oni-namecard-style";
  const LAYER_ID = "oni-namecard-layer";

  // --- Only run in active combat ---
  function isCombatActive() {
    const c = game?.combat;
    // Works across v10+; "started" true after first turn, round>0 also indicates active
    return !!(c && (c.started || (c.round ?? 0) > 0));
  }

  // ---------- Bootstrap CSS + Layer (idempotent) ----------
  function ensureBootstrap() {
    if (!document.getElementById(STYLE_ID)) {
      const css = `
#${LAYER_ID} {
  position: fixed;
  inset: 0 0 auto 0;
  top: 8px;
  width: 100%;
  pointer-events: none;
  z-index: 9999;
}

.oni-namecard {
  position: absolute;
  transform-origin: top left;
  overflow: visible;
  pointer-events: none;
}

.oni-namecard__plate {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: 10px;
  background: rgba(0,0,0,0.55);
  border: 1px solid rgba(255,255,255,0.15);
  box-shadow: 0 6px 24px rgba(0,0,0,0.35);
}

.oni-namecard__title {
  font-weight: 700;
  font-size: 22px;
  letter-spacing: 0.3px;
  color: #fff;
  text-shadow: 0 2px 2px rgba(0,0,0,0.6);
  white-space: nowrap;
}

.oni-namecard__fadeL,
.oni-namecard__fadeR {
  width: 32px; height: 100%;
  pointer-events: none;
}

.oni-namecard__fadeL {
  background: linear-gradient(90deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.35) 100%);
  border-top-left-radius: 10px;
  border-bottom-left-radius: 10px;
}

.oni-namecard__fadeR {
  background: linear-gradient(270deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.35) 100%);
  border-top-right-radius: 10px;
  border-bottom-right-radius: 10px;
}

.oni-namecard--enter { opacity: 0; transform: translateY(-12px) scale(0.98); }
.oni-namecard--show  { opacity: 1; transform: translateY(0) scale(1);    transition: all var(--oni-in-ms, 300ms) cubic-bezier(.2,.9,.2,1); }
.oni-namecard--hide  { opacity: 0; transform: translateY(-8px) scale(0.98); transition: all var(--oni-out-ms, 300ms) ease-in; }
      `;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = css;
      document.head.appendChild(style);
    }

    if (!document.getElementById(LAYER_ID)) {
      const layer = document.createElement("div");
      layer.id = LAYER_ID;
      document.body.appendChild(layer);
    }
  }

  // ---------- Utilities ----------
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function px(n) { return `${Math.round(n)}px`; }

  // ---------- Local render ----------
  async function showNameCardLocal(title, opts = {}) {
    // do nothing if combat isn't active
    if (!isCombatActive()) return;

    ensureBootstrap();

    const {
      inMs = 350,
      holdMs = 1500,
      outMs = 400,

      xAlign = "left",        // "left" | "center" | "right"
      offsetX = 570,          // px
      offsetY = 100,          // px

      fixedWidth = 640,       // px
      autoWidth = false,      // if true, width grows with text
      cardScale = 0.20,       // overall scale
      maxFontPx = 28,
      minFontPx = 16,
      emoji = "",             // optional leading icon/emoji
    } = opts;

    const layer = document.getElementById(LAYER_ID);
    if (!layer) return;

    // Remove any prior card (keep only one at a time)
    Array.from(layer.querySelectorAll(".oni-namecard")).forEach(el => el.remove());

    // Root
    const root = document.createElement("div");
    root.className = "oni-namecard oni-namecard--enter";
    root.style.setProperty("--oni-in-ms", `${inMs}ms`);
    root.style.setProperty("--oni-out-ms", `${outMs}ms`);

    // Card (plate)
    const plate = document.createElement("div");
    plate.className = "oni-namecard__plate";

    const fadeL = document.createElement("div");
    fadeL.className = "oni-namecard__fadeL";

    const fadeR = document.createElement("div");
    fadeR.className = "oni-namecard__fadeR";

    const titleEl = document.createElement("div");
    titleEl.className = "oni-namecard__title";
    titleEl.textContent = (emoji ? `${emoji} ` : "") + (title ?? "");

    // Auto width or fixed width
    const widthPx = autoWidth ? "auto" : px(fixedWidth);
    plate.style.width = widthPx;

    // Font clamp
    const fontPx = clamp(titleEl.textContent.length > 24 ? maxFontPx - 4 : maxFontPx, minFontPx, maxFontPx);
    titleEl.style.fontSize = px(fontPx);

    // Build DOM
    plate.appendChild(fadeL);
    plate.appendChild(titleEl);
    plate.appendChild(fadeR);
    root.appendChild(plate);
    layer.appendChild(root);

    // Placement + scale
    root.style.transformOrigin = "top left";
    root.style.scale = String(cardScale);

    // X alignment
    const docW = window.innerWidth || document.documentElement.clientWidth || 1920;
    let x = offsetX;
    if (xAlign === "center") x = docW / 2 - (autoWidth ? 0 : fixedWidth / 2) - 0;
    if (xAlign === "right")  x = docW - (autoWidth ? 0 : fixedWidth) - offsetX;
    root.style.left = px(x);
    root.style.top  = px(offsetY);

    // Animate in
    // Wait a frame then switch to --show
    requestAnimationFrame(() => {
      root.classList.remove("oni-namecard--enter");
      root.classList.add("oni-namecard--show");
    });

    // Hold, then animate out and remove
    const totalMs = inMs + holdMs;
    setTimeout(() => {
      root.classList.remove("oni-namecard--show");
      root.classList.add("oni-namecard--hide");
      setTimeout(() => root.remove(), outMs + 25);
    }, totalMs);
  }

  // expose local API
  window.FUCompanion.api.showNameCardLocal = showNameCardLocal;

  // listen for socket broadcasts
  Hooks.once("ready", () => {
    game.socket?.on?.("module.fabula-ultima-companion", (data) => {
      if (!data || data.type !== "namecard") return;

      // ignore incoming messages if combat isn't active on THIS client
      if (!isCombatActive()) return;

      const { title, options } = data;
      showNameCardLocal(title, options);
    });
  });
})();
