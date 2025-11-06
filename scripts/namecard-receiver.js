// scripts/namecard-receiver.js
// Shows JRPG-style NameCards on THIS client. Listens to module socket.
// Exposes: window.FUCompanion.api.showNameCardLocal(title, options)

(() => {
  window.FUCompanion = window.FUCompanion || { api: {} };

  const STYLE_ID = "oni-namecard-style";
  const LAYER_ID = "oni-namecard-layer";

  // ───────────────────────────────────────────────────────────
  // Per-client base font sizing (from your screenshot method)
  // Sets document body's font-size; all Namecard measurements use em.
  function setFonts() {
    const size = { height: window.innerHeight, width: window.innerWidth };
    const ratio = size.width / size.height;
    const max = 2;
    const factor = 1.98;
    const w = (ratio > max) ? (size.height * factor) : size.width;
    const widthInt = parseInt(w);
    document.body.setAttribute('style', 'font-size:' + (widthInt / 26) + 'px');
    window.fontSize = widthInt / 26;
  }
  // Run once now and again on resize/zoom
  function bindFontResizer() {
    setFonts();
    window.addEventListener('resize', setFonts);
    // visualViewport catches pinch-zoom on some browsers
    window.visualViewport?.addEventListener?.('resize', setFonts);
  }
  bindFontResizer();
  // ───────────────────────────────────────────────────────────
  // ---------- Bootstrap CSS + Layer (idempotent) ----------
  function ensureBootstrap() {
    if (!document.getElementById(STYLE_ID)) {
      const css = `
#${LAYER_ID} {
  position: fixed; inset: 0 0 auto 0; top: 0.5em; width: 100%;
  display: grid; place-items: start center;
  pointer-events: none; z-index: 999999;
}
.oni-namecard {
  pointer-events: none; opacity: 0; will-change: transform, opacity;
  position: relative; border-radius: var(--oni-radius, 0.75em);
  padding: 0.375em 1.125em; transform-origin: center center;
}
.oni-namecard__plate {
  position:absolute; inset:0; border-radius:var(--oni-radius,0.75em);
  background: rgba(var(--oni-bg-r), var(--oni-bg-g), var(--oni-bg-b), var(--oni-plate-alpha,.55));
  border:0.0625em solid var(--oni-border, rgba(255,255,255,.10));
  box-shadow:var(--oni-shadow,0 0.625em 1.375em rgba(0,0,0,.35));
  backdrop-filter:blur(var(--oni-blur,0.09375em)) saturate(105%);
  -webkit-backdrop-filter:blur(var(--oni-blur,0.09375em)) saturate(105%);
  filter: drop-shadow(0 0.0625em 0 rgba(0,0,0,.18));
  pointer-events:none;
}
.oni-namecard__plate::before, .oni-namecard__plate::after {
  content:""; position:absolute; left:0; right:0; height:var(--oni-line-th,0.125em);
  background: linear-gradient(90deg, rgba(0,0,0,0) 0%, var(--oni-accent,#d9b56f) 12%, var(--oni-accent,#d9b56f) 88%, rgba(0,0,0,0) 100%);
  border-radius:999em; box-shadow: 0 0 0.375em rgba(217,181,111,.45);
}
.oni-namecard__plate::before { top: var(--oni-line-gap, 0.125em); }
.oni-namecard__plate::after  { bottom: var(--oni-line-gap, 0.125em); }
.oni-namecard__plate[data-mask="1"]{
  --oni-fade: 12%;
  -webkit-mask-image:linear-gradient(to right, transparent var(--oni-fade), #000 calc(var(--oni-fade)+1%), #000 calc(100% - var(--oni-fade) - 1%), transparent 100%);
  mask-image:linear-gradient(to right, transparent var(--oni-fade), #000 calc(var(--oni-fade)+1%), #000 calc(100% - var(--oni-fade) - 1%), transparent 100%);
}
.oni-namecard__titlewrap{ position:relative; z-index:1; display:flex; align-items:center; justify-content:center; width:100%; overflow:hidden; white-space:nowrap; }
.oni-namecard__line{ display:inline-flex; align-items:baseline; gap: var(--oni-icongap, 0.5em); transform-origin:center center; }
.oni-namecard__icon{ display:inline-block; line-height:1; transform-origin:center center; }
.oni-namecard__text{ display:inline-block; line-height:1.05; font-weight:var(--oni-weight,900); letter-spacing:var(--oni-track,.06em); transform-origin:center center; font-family:var(--oni-font,system-ui,sans-serif); }
@keyframes oni-in { from{opacity:0; transform: var(--oni-enter-transform, translateY(-1em)) scale(.99);} to{opacity:1; transform: translate(0,0) scale(1);} }
@keyframes oni-out{ from{opacity:1; transform: translate(0,0) scale(1);} to{opacity:0; transform: var(--oni-exit-transform, translateY(-0.875em)) scale(.99);} }
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

  // --- NEW: Per-client scale helper ---------------------------------
  // Uses viewport height (CSS px) as the normalizer so OS scaling and browser zoom
  // are naturally accounted for. You can tune baselineVh / min / max in options.
  function getClientScale({ baselineVh = 900, min = 0.75, max = 1.40, mode = "vh" } = {}) {
    // mode "vh": scale by viewport height ratio
    // (visualViewport is best, falls back to innerHeight)
    const vv = window.visualViewport;
    const cssH = (vv && vv.height) ? vv.height : window.innerHeight;

    let s = 1;
    if (mode === "vh") {
      s = cssH > 0 ? (cssH / Number(baselineVh)) : 1;
    } else {
      // future modes could be added here (e.g., "vw", "minDim")
      s = 1;
    }

    // Clamp to avoid extremes
    s = Math.max(min, Math.min(max, s));
    return s;
  }
  // -------------------------------------------------------------------
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
  // REPLACE the whole applyTextGlow() helper with this:
function applyTextGlow(el, glowColor="#ffffff", strength=1){
  const s = Math.max(0, Math.min(1, Number(strength || 0)));
  const a1 = (0.35*s).toFixed(2);
  const a2 = (0.35*s).toFixed(2);
  const aGlow1 = (0.45*s).toFixed(2);
  const aGlow2 = (0.32*s).toFixed(2);

  // If strength is 0, disable textShadow entirely to avoid any residual glow
  if (s <= 0) { el.style.textShadow = "none"; return; }

  el.style.textShadow =
    `0 1px 0 rgba(0,0,0,${a1}),
     0 2px 6px rgba(0,0,0,${a2}),
     0 0 6px ${hexOrRgba(glowColor, aGlow1)},
     0 0 14px ${hexOrRgba(glowColor, aGlow2)}`;
}

// Add this tiny helper (if your file doesn’t already have it near applyTextGlow):
function hexOrRgba(col, alpha="1"){
  if (String(col).startsWith("#")){
    const rgb = hexToRgb(col);
    if (!rgb) return `rgba(255,255,255,${alpha})`;
    return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
  }
  return col;
}

  // ---------- Local draw function ----------
  async function showNameCardLocal(title, opts = {}) {
    ensureBootstrap();

    const layer = document.getElementById(LAYER_ID);
    if (!layer) return;

    // Defaults (safe)
        // Helpers to convert legacy px options to em (based on current body font-size)
function _bodyEm(px) {
  const base = parseFloat(getComputedStyle(document.body).fontSize || "16");
  return px / base;
}

const o = Object.assign({
  inMs: 350, holdMs: 1500, outMs: 400,

  // Placement (em)
  xAlign: "center",
  offsetXEm: 0,          // use these new em options going forward
  offsetYEm: 0.5,

  // Width (em)
  fixedWidthEm: 40,      // ≈ 40em wide card by default
  autoWidth: false,
  cardScale: 1.0,

  // Typography (em)
  maxFontEm: 1.75,       // ≈ 28px if base is 16px
  minFontEm: 1.0,

  // Visual palette
  plateOpacity: 0.55, bg: "#000000", border: "rgba(255,255,255,.10)",
  text: "#ffffff", accent: "#d9b56f", glowColor: "#ffffff",
  dropShadow: "0 0.625em 1.375em rgba(0,0,0,.35)",

  // Sizes (em)
  radiusEm: 0.75,
  blurEm: 0.09375,       // ≈ 1.5px @ 16px base
  lineThicknessEm: 0.125,
  lineGapEm: 0.125,
  edgeFade: 0.12, maskEdges: true,

  // Font details
  letterSpacing: 0.06, fontWeight: 900, upperCase: false, textShadowStrength: 0.0,
  fontFamily: "system-ui, sans-serif",
  // We avoid text stroke (px-only) to honor the "no px" rule:
  textStrokeEm: 0, textStrokeColor: "rgba(0,0,0,0)",

  // Icon
  showIcon: true, actionType: "skill", iconOverride: "", iconGapEm: 0.625, iconScale: 0.93,

  // Motion
  enterFrom: "up", easingIn: "cubic-bezier(.22,.9,.24,1)", easingOut: "cubic-bezier(.2,.7,.4,1)",

  // Per-client scaling (kept; multiplies on top of em layout if you like)
  baselineVh: 900, scaleMin: 0.75, scaleMax: 1.40, scaleMode: "vh"
}, opts || {});

// Backward compatibility: if legacy px options are supplied, convert them to em
if (o.offsetXEm === undefined && o.offsetX !== undefined) o.offsetXEm = _bodyEm(o.offsetX);
if (o.offsetYEm === undefined && o.offsetY !== undefined) o.offsetYEm = _bodyEm(o.offsetY);
if (o.fixedWidthEm === undefined && o.fixedWidth !== undefined) o.fixedWidthEm = _bodyEm(o.fixedWidth);
if (o.maxFontEm === undefined && o.maxFontPx !== undefined) o.maxFontEm = _bodyEm(o.maxFontPx);
if (o.minFontEm === undefined && o.minFontPx !== undefined) o.minFontEm = _bodyEm(o.minFontPx);
if (o.iconGapEm === undefined && o.iconGapPx !== undefined) o.iconGapEm = _bodyEm(o.iconGapPx);

const PAD_X_EM = 1.125; // internal left/right padding in em

// Width in em
if (o.autoWidth) { card.style.width = "max-content"; card.style.maxWidth = "92vw"; }
else { card.style.width = `${o.fixedWidthEm}em`; card.style.maxWidth = "92vw"; }

// Per-client scale then em offsets
const clientScale = getClientScale({ baselineVh: o.baselineVh, min: o.scaleMin, max: o.scaleMax, mode: o.scaleMode });
const finalScale  = (o.cardScale ?? 1) * clientScale;
const offX        = o.offsetXEm || 0;
const offY        = o.offsetYEm || 0;

const xMap = { left: "start", center: "center", right: "end" };
card.style.justifySelf = (xMap[o.xAlign] ?? "center");
card.style.marginTop = `${offY}em`;

if (o.xAlign === "left") {
  card.style.marginLeft = `${offX}em`;
  card.style.transform  = `scale(${finalScale})`;
} else if (o.xAlign === "right") {
  card.style.marginRight = `${offX}em`;
  card.style.transform   = `scale(${finalScale})`;
} else {
  card.style.transform = `scale(${finalScale}) translateX(${offX}em)`;
}

// CSS custom properties (em)
card.style.setProperty("--oni-radius", `${o.radiusEm}em`);
card.style.setProperty("--oni-border", o.border);
card.style.setProperty("--oni-shadow", o.dropShadow);
card.style.setProperty("--oni-accent", o.accent);
card.style.setProperty("--oni-blur", `${o.blurEm}em`);
card.style.setProperty("--oni-line-th", `${o.lineThicknessEm}em`);
card.style.setProperty("--oni-line-gap", `${o.lineGapEm}em`);

// icon/text sizing in em
line.style.setProperty("--oni-icongap", `${o.iconGapEm}em`);

if (o.showIcon && iconStr) {
  iconEl.style.fontSize = `${o.maxFontEm * (o.iconScale ?? 1)}em`;
}

text.style.fontSize = `${o.maxFontEm}em`;
text.style.setProperty("--oni-weight", String(o.fontWeight|0));
text.style.setProperty("--oni-track", `${o.letterSpacing}em`);
text.style.setProperty("--oni-font", o.fontFamily);

// We skip text stroke (px-only). Keep glow if you want:
applyTextFill(text, o.text);
applyTextGlow(text, o.glowColor, o.textShadowStrength);

// Auto-fit scaling calc: we can still measure widths in pixels;
// CSS will convert em widths to device pixels for the DOM rect.
const available = card.clientWidth - (PAD_X_EM * 2 * parseFloat(getComputedStyle(document.body).fontSize || "16"));
const fullWidth = measureWidth(line);
let scale = fullWidth > 0 ? Math.min(1, available / fullWidth) : 1;
const minScale = (o.minFontEm / o.maxFontEm);
if (scale < minScale) {
  text.style.fontSize = `${o.minFontEm}em`;
  if (iconEl) iconEl.style.fontSize = `${o.minFontEm * (o.iconScale ?? 1)}em`;
  await nextFrame();
  const wMin = measureWidth(line);
  scale = wMin > 0 ? Math.min(1, available / wMin) : 1;
}
line.style.transform = `scale(${scale})`;

// Enter/exit vectors in em
const dir = String(o.enterFrom||"up").toLowerCase();
const inVec  = (dir === "down") ? "translateY(1em)" :
               (dir === "left") ? "translateX(-1.375em)" :
               (dir === "right")? "translateX(1.375em)" : "translateY(-1em)";
const outVec = (dir === "down") ? "translateY(0.875em)" :
               (dir === "left") ? "translateX(-1.125em)" :
               (dir === "right")? "translateX(1.125em)" : "translateY(-0.875em)";
card.style.setProperty("--oni-enter-transform", inVec);
card.style.setProperty("--oni-exit-transform",  outVec);
    
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
      if (!reduced) {
        card.style.animation = `oni-in ${o.inMs}ms cubic-bezier(.22,.9,.24,1) forwards`;
        await wait(o.inMs + 20);
        await wait(o.holdMs);
        card.style.animation = `oni-out ${o.outMs}ms cubic-bezier(.2,.7,.4,1) forwards`;
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

  // listen for socket broadcasts
  Hooks.once("ready", () => {
    game.socket?.on?.("module.fabula-ultima-companion", (data) => {
      if (!data || data.type !== "namecard") return;
      const { title, options } = data;
      showNameCardLocal(title, options);
    });
  });
})();
