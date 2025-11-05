// scripts/namecard-receiver.js
// Shows JRPG-style NameCards on THIS client. Uses socketlib with a shared t0
// for perfect multi-client sync, warms (caches) at combat start, and cleans up on end.
// Exposes: window.FUCompanion.api.showNameCardLocal(title, options)

(() => {
  const MODULE_ID  = "fabula-ultima-companion";
  const ACTION_KEY = "FU_NAMECARD_SHOW";
  const STYLE_ID   = "oni-namecard-style";
  const LAYER_ID   = "oni-namecard-layer";
  const FLAG       = "__FU_NAMECARD_READY_v2";

  window.FUCompanion = window.FUCompanion || { api: {} };

  // ---- tiny per-tab cache (track combats we warmed) ----
  const CACHE_NS = "FU_NAMECARD_CACHE";
  function bag() {
    globalThis[CACHE_NS] ??= {
      __createdAt: Date.now(),
      __combatReady: new Set(),
      get size() { return this.__combatReady.size; }
    };
    return globalThis[CACHE_NS];
  }

  // ---------- Bootstrap CSS + Layer (idempotent) ----------
  function ensureBootstrap() {
    if (!document.getElementById(STYLE_ID)) {
      const css = `
#${LAYER_ID} {
  position: fixed; inset: 0 0 auto 0; top: 8px; width: 100%;
  display: grid; place-items: start center;
  pointer-events: none; z-index: 999999;
}
.oni-namecard { pointer-events: none; opacity: 0; will-change: transform, opacity;
  position: relative; border-radius: var(--oni-radius, 12px);
  padding: 6px 18px; transform-origin: center center; }
.oni-namecard__plate { position:absolute; inset:0; border-radius:var(--oni-radius,12px);
  background: rgba(var(--oni-bg-r), var(--oni-bg-g), var(--oni-bg-b), var(--oni-plate-alpha,.55));
  border:1px solid var(--oni-border, rgba(255,255,255,.10));
  box-shadow:var(--oni-shadow,0 10px 22px rgba(0,0,0,.35));
  backdrop-filter:blur(var(--oni-blur,1.5px)) saturate(105%);
  -webkit-backdrop-filter:blur(var(--oni-blur,1.5px)) saturate(105%);
  filter: drop-shadow(0 1px 0 rgba(0,0,0,.18)); pointer-events:none;
}
.oni-namecard__plate::before, .oni-namecard__plate::after {
  content:""; position:absolute; left:0; right:0; height:var(--oni-line-th,2px);
  background: linear-gradient(90deg, rgba(0,0,0,0) 0%, var(--oni-accent,#d9b56f) 12%, var(--oni-accent,#d9b56f) 88%, rgba(0,0,0,0) 100%);
  border-radius:999px; box-shadow: 0 0 6px rgba(217,181,111,.45);
}
.oni-namecard__plate::before { top: var(--oni-line-gap, 2px); }
.oni-namecard__plate::after  { bottom: var(--oni-line-gap, 2px); }
.oni-namecard__plate[data-mask="1"]{
  --oni-fade: 12%;
  -webkit-mask-image:linear-gradient(to right, transparent var(--oni-fade), #000 calc(var(--oni-fade)+1%), #000 calc(100% - var(--oni-fade) - 1%), transparent 100%);
  mask-image:linear-gradient(to right, transparent var(--oni-fade), #000 calc(var(--oni-fade)+1%), #000 calc(100% - var(--oni-fade) - 1%), transparent 100%);
}
.oni-namecard__titlewrap{ position:relative; z-index:1; display:flex; align-items:center; justify-content:center; width:100%; overflow:hidden; white-space:nowrap; }
.oni-namecard__line{ display:inline-flex; align-items:baseline; gap: var(--oni-icongap, 8px); transform-origin:center center; }
.oni-namecard__icon{ display:inline-block; line-height:1; transform-origin:center center; }
.oni-namecard__text{ display:inline-block; line-height:1.05; font-weight:var(--oni-weight,900); letter-spacing:var(--oni-track,.06em); transform-origin:center center; font-family:var(--oni-font,system-ui,sans-serif); }
@keyframes oni-in { from{opacity:0; transform: var(--oni-enter-transform, translateY(-16px)) scale(.99);} to{opacity:1; transform: translate(0,0) scale(1);} }
@keyframes oni-out{ from{opacity:1; transform: translate(0,0) scale(1);} to{opacity:0; transform: var(--oni-exit-transform, translateY(-14px)) scale(.99);} }
@media (prefers-reduced-motion: reduce){ .oni-namecard{ animation:none !important; transition:none !important; } }
      `.trim();
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

  // ---------- Helpers ----------
  const clamp01 = v => Math.max(0, Math.min(1, Number(v||0)));
  const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  function hexToRgb(hex){
    const h = String(hex||"").replace("#","");
    if (h.length !== 6) return null;
    const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
    if ([r,g,b].some(n=>Number.isNaN(n))) return null; return { r,g,b };
  }
  function measureWidth(el){ return Math.ceil(el.getBoundingClientRect().width); }
  function applyTextFill(el, textOpt){
    if (Array.isArray(textOpt) && textOpt.length >= 2){
      el.style.background = `linear-gradient(180deg, ${textOpt.join(", ")})`;
      el.style.webkitBackgroundClip = "text"; el.style.backgroundClip = "text";
      el.style.webkitTextFillColor = "transparent"; el.style.color = "transparent";
    } else {
      el.style.removeProperty("background"); el.style.removeProperty("-webkit-background-clip");
      el.style.removeProperty("background-clip"); el.style.removeProperty("-webkit-text-fill-color");
      el.style.color = String(textOpt || "#f5f3ee");
    }
  }
  function applyTextStroke(el, px=0, color="transparent"){
    const size = Number(px||0);
    if (size > 0) el.style.webkitTextStroke = `${size}px ${color}`;
    else el.style.removeProperty("-webkit-text-stroke");
  }
  function hexOrRgba(col, alpha="1"){
    if (String(col).startsWith("#")){
      const rgb = hexToRgb(col);
      if (!rgb) return `rgba(255,255,255,${alpha})`;
      return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
    }
    return col;
  }
  // No-glow when strength = 0
  function applyTextGlow(el, glowColor="#ffffff", strength=1){
    const s = Math.max(0, Math.min(1, Number(strength || 0)));
    if (s <= 0) { el.style.textShadow = "none"; return; }
    const a1 = (0.35*s).toFixed(2);
    const a2 = (0.35*s).toFixed(2);
    const aGlow1 = (0.45*s).toFixed(2);
    const aGlow2 = (0.32*s).toFixed(2);
    el.style.textShadow =
      `0 1px 0 rgba(0,0,0,${a1}),
       0 2px 6px rgba(0,0,0,${a2}),
       0 0 6px ${hexOrRgba(glowColor, aGlow1)},
       0 0 14px ${hexOrRgba(glowColor, aGlow2)}`;
  }

  // ---- Warm the layer once so layout/font work is done before first show ----
  async function warmOnce() {
    ensureBootstrap();
    const layer = document.getElementById(LAYER_ID);
    if (!layer) return;

    const card = document.createElement("div");
    card.className = "oni-namecard";
    card.style.width = "480px";
    card.style.opacity = "0";
    card.style.transform = "translateY(-9999px)";

    const plate = document.createElement("div"); plate.className = "oni-namecard__plate";
    const wrap  = document.createElement("div"); wrap.className  = "oni-namecard__titlewrap";
    const line  = document.createElement("span"); line.className = "oni-namecard__line";
    const text  = document.createElement("span"); text.className = "oni-namecard__text"; text.textContent = "Warmup";
    line.appendChild(text); wrap.appendChild(line);
    card.appendChild(plate); card.appendChild(wrap);
    layer.appendChild(card);
    await new Promise(r => requestAnimationFrame(r));
    card.remove();
  }

  // ---------- Local draw function ----------
  async function showNameCardLocal(title, opts = {}) {
    ensureBootstrap();

    const layer = document.getElementById(LAYER_ID);
    if (!layer) return;

    // Defaults (safe)
    const o = Object.assign({
      inMs: 350, holdMs: 1500, outMs: 400,
      xAlign: "center", offsetX: 0, offsetY: 8,
      fixedWidth: 640, autoWidth: false, cardScale: 1.0,
      maxFontPx: 28, minFontPx: 16,
      plateOpacity: 0.55, bg: "#000000", border: "rgba(255,255,255,.10)",
      text: "#ffffff", accent: "#d9b56f", glowColor: "#ffffff", dropShadow: "0 10px 22px rgba(0,0,0,.35)",
      radius: 12, blurPx: 1.5, lineThickness: 2, lineGap: 2, edgeFade: 0.12, maskEdges: true,
      letterSpacing: 0.06, fontWeight: 900, upperCase: false, textShadowStrength: 0.0,
      fontFamily: "system-ui, sans-serif", textStrokePx: 0.0, textStrokeColor: "rgba(0,0,0,0.55)",
      showIcon: true, actionType: "skill", iconOverride: "", iconGapPx: 10, iconScale: 0.93,
      enterFrom: "up", easingIn: "cubic-bezier(.22,.9,.24,1)", easingOut: "cubic-bezier(.2,.7,.4,1)"
    }, opts || {});

    const ACTION_ICONS = { skill:"💥", offensiveSpell:"⚡️", spell:"📕", attack:"⚔️", passive:"📜" };
    const PAD_X = 18;

    window._oniNameCardQueue = window._oniNameCardQueue || Promise.resolve();
    const work = async () => {
      const card = document.createElement("div");
      card.className = "oni-namecard";

      if (o.autoWidth) { card.style.width = "max-content"; card.style.maxWidth = "92vw"; }
      else { card.style.width = `${o.fixedWidth}px`; card.style.maxWidth = "92vw"; }

      const xMap = { left: "start", center: "center", right: "end" };
      card.style.justifySelf = (xMap[o.xAlign] ?? "center");
      card.style.marginTop = `${o.offsetY|0}px`;
      if (o.xAlign === "left") card.style.marginLeft = `${o.offsetX|0}px`;
      else if (o.xAlign === "right") card.style.marginRight = `${o.offsetX|0}px`;
      else card.style.transform = `scale(${o.cardScale ?? 1}) translateX(${o.offsetX|0}px)`;

      const rgb = hexToRgb(o.bg) || { r:0,g:0,b:0 };
      card.style.setProperty("--oni-radius", `${o.radius}px`);
      card.style.setProperty("--oni-border", o.border);
      card.style.setProperty("--oni-shadow", o.dropShadow);
      card.style.setProperty("--oni-accent", o.accent);
      card.style.setProperty("--oni-blur", `${o.blurPx}px`);
      card.style.setProperty("--oni-line-th", `${o.lineThickness}px`);
      card.style.setProperty("--oni-line-gap", `${o.lineGap}px`);
      card.style.setProperty("--oni-bg-r", rgb.r);
      card.style.setProperty("--oni-bg-g", rgb.g);
      card.style.setProperty("--oni-bg-b", rgb.b);
      card.style.setProperty("--oni-plate-alpha", `${clamp01(o.plateOpacity)}`);

      const plate = document.createElement("div");
      plate.className = "oni-namecard__plate";
      plate.dataset.mask = o.maskEdges ? "1" : "0";
      if (o.maskEdges) plate.style.setProperty("--oni-fade", `${Math.round(clamp01(o.edgeFade)*100)}%`);

      const wrap = document.createElement("div");
      wrap.className = "oni-namecard__titlewrap";

      const line = document.createElement("span");
      line.className = "oni-namecard__line";
      line.style.setProperty("--oni-icongap", `${o.iconGapPx|0}px`);

      const iconStr = (o.iconOverride && String(o.iconOverride).trim()) || ACTION_ICONS[o.actionType] || "";
      let iconEl = null;
      if (o.showIcon && iconStr) {
        iconEl = document.createElement("span");
        iconEl.className = "oni-namecard__icon";
        iconEl.textContent = iconStr;
        iconEl.style.fontSize = `${o.maxFontPx * (o.iconScale ?? 1)}px`;
      }

      const text = document.createElement("span");
      text.className = "oni-namecard__text";
      text.textContent = o.upperCase ? String(title).toUpperCase() : String(title);
      text.style.fontSize = `${o.maxFontPx}px`;
      text.style.setProperty("--oni-weight", String(o.fontWeight|0));
      text.style.setProperty("--oni-track", `${o.letterSpacing}em`);
      text.style.setProperty("--oni-font", o.fontFamily);

      applyTextFill(text, o.text);
      applyTextStroke(text, o.textStrokePx, o.textStrokeColor);
      applyTextGlow(text, o.glowColor, o.textShadowStrength);

      if (iconEl) line.appendChild(iconEl);
      line.appendChild(text);
      wrap.appendChild(line);
      card.appendChild(plate);
      card.appendChild(wrap);
      document.getElementById(LAYER_ID).appendChild(card);

      await nextFrame();

      const available = card.clientWidth - PAD_X*2;
      const fullWidth = measureWidth(line);
      let scale = fullWidth > 0 ? Math.min(1, available / fullWidth) : 1;
      const minScale = (o.minFontPx / o.maxFontPx);
      if (scale < minScale) {
        text.style.fontSize = `${o.minFontPx}px`;
        if (iconEl) iconEl.style.fontSize = `${o.minFontPx * (o.iconScale ?? 1)}px`;
        await nextFrame();
        const wMin = measureWidth(line);
        scale = wMin > 0 ? Math.min(1, available / wMin) : 1;
      }
      line.style.transform = `scale(${scale})`;

      const dir = String(o.enterFrom||"up").toLowerCase();
      const inVec  = dir === "down" ? "translateY(16px)" : dir === "left" ? "translateX(-22px)" : dir === "right"? "translateX(22px)" : "translateY(-16px)";
      const outVec = dir === "down" ? "translateY(14px)" : dir === "left" ? "translateX(-18px)" : dir === "right"? "translateX(18px)" : "translateY(-14px)";
      card.style.setProperty("--oni-enter-transform", inVec);
      card.style.setProperty("--oni-exit-transform",  outVec);

      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const easeIn  = String(o.easingIn  || "cubic-bezier(.22,.9,.24,1)");
      const easeOut = String(o.easingOut || "cubic-bezier(.2,.7,.4,1)");
      if (!reduced) {
        card.style.animation = `oni-in ${o.inMs}ms ${easeIn} forwards`;
        await wait(o.inMs + 20);
        await wait(o.holdMs);
        card.style.animation = `oni-out ${o.outMs}ms ${easeOut} forwards`;
        await wait(o.outMs + 60);
      } else {
        card.style.opacity = "1";
        await wait(o.holdMs);
        card.style.opacity = "0";
        await wait(120);
      }
      card.remove();
    };
    window._oniNameCardQueue = window._oniNameCardQueue.then(work).catch(console.warn);
    return window._oniNameCardQueue;
  }

  // expose local API
  window.FUCompanion.api.showNameCardLocal = showNameCardLocal;

  // ---- Combat hooks: preload/warm & cleanup ----
  Hooks.on("combatStart", async (combat) => {
    try {
      const cId = combat?.id ?? null;
      if (!cId) return;
      const b = bag();
      if (b.__combatReady.has(cId)) return;   // already warmed
      await warmOnce();
      b.__combatReady.add(cId);
      if (game.user?.isGM) console.log("[NameCard] Warmed at combatStart:", cId);
    } catch (e) {
      console.warn("[NameCard] warm error:", e);
    }
  });

  function _cleanup(combat, reason) {
    try {
      const cId = combat?.id ?? null;
      if (!cId) return;
      bag().__combatReady.delete(cId);
      if (game.user?.isGM) console.log("[NameCard] Cleared warm cache via", reason, "combatId:", cId);
    } catch (e) {
      console.warn("[NameCard] cleanup error:", e);
    }
  }
  Hooks.on("combatEnd",    (combat) => _cleanup(combat, "combatEnd"));
  Hooks.on("deleteCombat", (combat) => _cleanup(combat, "deleteCombat"));
  Hooks.on("updateCombat", (combat, changed) => {
    if (Object.prototype.hasOwnProperty.call(changed, "active") && changed.active === false) {
      _cleanup(combat, "updateCombat(active=false)");
    }
  });

  // ---- Socketlib receiver: wait for shared t0, only show during active combat ----
  if (!window[FLAG]) {
    Hooks.once("ready", () => {
      try {
        const sockMod = game.modules.get("socketlib");
        if (!sockMod?.active || !window.socketlib) {
          ui.notifications.error("NameCard: socketlib not found/active.");
          return;
        }
        const socket = socketlib.registerModule(MODULE_ID);

        socket.register(ACTION_KEY, async (payload) => {
          try {
            const myId = game.user?.id;
            if (Array.isArray(payload?.allowedUserIds) && myId && !payload.allowedUserIds.includes(myId)) return;

            // Only show during combat (per your spec)
            if (!game.combat?.active) return;

            const t0 = Number(payload?.t0) || Date.now();
            const waitMs = Math.max(0, t0 - Date.now());
            if (waitMs) await new Promise(r => setTimeout(r, waitMs));

            const title   = payload?.title ?? "—";
            const options = payload?.options ?? {};
            await showNameCardLocal(title, options);
          } catch (e) {
            console.warn("[NameCard] Receiver error:", e);
          }
        });

        window[FLAG] = true;
        console.log("[NameCard] Receiver+Cache installed.");
      } catch (err) {
        console.error("[NameCard] Receiver failed to install:", err);
      }
    });
  }
})();
