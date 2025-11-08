// scripts/resource-ui-manager.js
// ────────────────────────────────────────────────────────────────────────────
// Player Resource HUD (Multi-member, DEMO styling, animations)
// • Builds up to 4 party HUD cards on combat start; tears down on end.
// • Party membership read from Database Actor via db-resolver.js API.
// • Visuals and behavior reference your Demo_ResourceUI.js.
// ────────────────────────────────────────────────────────────────────────────
(() => {
  const MOD   = "fabula-ultima-companion";
  const NS    = "FU_ResourceHUD";
  const WRAP  = "oni-playerhud-wrap";     // keep DEMO ids so CSS matches mental model
  const STYLE = "oni-playerhud-style";
  const LINK  = "oni-playerhud-fonts";

  // Namespace
  window[NS] = window[NS] || { mounted:false, cards:new Map(), unhooks:[] };

  // ===== System paths (same as DEMO) ========================================
  const HP_VALUE_PATH = "system.props.current_hp";
  const HP_MAX_PATH   = "system.props.max_hp";
  const MP_VALUE_PATH = "system.props.current_mp";
  const MP_MAX_PATH   = "system.props.max_mp";
  const IP_VALUE_PATH = "system.props.current_ip";
  const IP_MAX_PATH   = "system.props.max_ip";           // optional
  const ZP_VALUE_PATH = "system.props.zero_power_value"; // max always 6
  const ZP_MAX_CONST  = 6;

  // ===== Fonts / palette (from DEMO defaults) ===============================
  const FONT_UI  = "Signika";
  const FONT_NUM = "Cinzel";
  const FONT_ZP  = "Silkscreen";

  const PALETTE = {
    text: "#ffffff",
    textDim: "rgba(255,255,255,.86)",
    topRGB: "18,18,20",
    botRGB: "12,12,14",
    opac:   0.88,
    border: "rgba(255,255,255,0.12)",
    hpGoodA: "#6bd66b",
    hpGoodB: "#2fbf71",
    tick: "rgba(255,255,255,.12)",
    shadow: "0 12px 28px rgba(0,0,0,0.45)",
    mpA: "#5aa8ff",
    mpB: "#2e7bd6",
    zpA: "#ffd95a",
    zpB: "#ff9c2e",
    hp50: "#a2e33a",
    hp25: "#ffb84a",
    hp10: "#ff5a5a"
  };

  // ===== Small utils =========================================================
  const gp = (o,p)=>{ try { return getProperty(o,p); } catch { return undefined; } };
  const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
  const clamp01 = (x)=>clamp(x,0,1);
  const fmt = x => new Intl.NumberFormat().format(Math.max(0, Math.floor(Number(x)||0)));
  const normalizeId = (id) => (id ? String(id).replace(/^Actor\./i,"").trim() : id); // <-- strip `Actor.`

  function getPair(actor, valuePath, maxPath, fallbackMax = null) {
    const value = Number(gp(actor, valuePath));
    let max = Number(gp(actor, maxPath));
    if (!Number.isFinite(max)) max = fallbackMax;
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null;
    return { value, max };
  }
  const getHP = (a)=> getPair(a, HP_VALUE_PATH, HP_MAX_PATH);
  const getMP = (a)=> getPair(a, MP_VALUE_PATH, MP_MAX_PATH) || { value:0, max:1 };
  const getZP = (a)=> {
    const v = Number(gp(a, ZP_VALUE_PATH));
    if (!Number.isFinite(v)) return { value:0, max: ZP_MAX_CONST };
    return { value: Math.max(0,v), max: ZP_MAX_CONST };
  };
  function getIP(actor) {
    const v = Number(gp(actor, IP_VALUE_PATH));
    let m = Number(gp(actor, IP_MAX_PATH));
    if (!Number.isFinite(m) || m <= 0) m = 6;
    if (!Number.isFinite(v)) return { value: 0, max: m };
    return { value: clamp(v,0,m), max: m };
  }

  // ===== Party from Database Actor ==========================================
  async function getActivePartyFromDatabase() {
    const API = window.FUCompanion?.api;
    if (!API?.getCurrentGameDb) return [];
    const { db, source } = await API.getCurrentGameDb();
    if (!db) return [];
    const src = source ?? db;

    const slots = [1,2,3,4].map(i=>{
      const rawId   = gp(src, `system.props.member_id_${i}`) || gp(src, `system.props.party_member_${i}_id`) || null;
      const name    = gp(src, `system.props.member_name_${i}`) || gp(src, `system.props.party_member_${i}`) || null;
      return { idx:i, id: normalizeId(rawId), name: name ? String(name).trim() : null };
    });

    return slots.filter(s => s.id || s.name);
  }

  // ===== Which combatants get a card? =======================================
  function choosePartyCombatants(combat, partyList) {
    const out = [];
    if (!combat) return out;
    const all = combat.combatants?.contents ?? [];

    for (const slot of partyList) {
      let match = null;
      if (slot.id) {
        match = all.find(c => normalizeId(c.actor?.id) === slot.id || normalizeId(c.actor?.uuid?.split(".").pop()) === slot.id);
      }
      if (!match && slot.name) {
        match = all.find(c => (c.actor?.name === slot.name) || (c.token?.name === slot.name) || (c.name === slot.name));
      }
      if (match?.actor) out.push({ slot: slot.idx, combatant: match, actor: match.actor, token: match.token });
    }
    out.sort((a,b)=>a.slot-b.slot);
    return out.slice(0,4);
  }

  // ===== Styles / wrapper (EXACT Demo vibe) =================================
  function ensureFontLink(){
    const families = [
      "family=" + encodeURIComponent(`${FONT_UI}:wght@400;600;700;900`),
      "family=" + encodeURIComponent(`${FONT_NUM}:wght@400;700;900`),
      "family=" + encodeURIComponent(`${FONT_ZP}:wght@400;700`)
    ].join("&");
    const href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
    let link = document.getElementById(LINK);
    if (!link) { link = document.createElement("link"); link.id = LINK; link.rel = "stylesheet"; document.head.appendChild(link); }
    if (link.href !== href) link.href = href;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE)) return;
    ensureFontLink();

    const css = `
#${WRAP}{
  --hud-font-ui: "${FONT_UI}", system-ui, sans-serif;
  --hud-font-num: "${FONT_NUM}", "${FONT_UI}", monospace;
  --hud-font-zp:  "${FONT_ZP}", "${FONT_UI}", monospace;
  --hud-text: ${PALETTE.text};
  --hud-text-dim: ${PALETTE.textDim};
  --hud-top: ${PALETTE.topRGB};
  --hud-bot: ${PALETTE.botRGB};
  --hud-op: ${PALETTE.opac};
  --hud-border: ${PALETTE.border};
  --hud-hp-a: ${PALETTE.hpGoodA};
  --hud-hp-b: ${PALETTE.hpGoodB};
  --hud-mp-a: ${PALETTE.mpA};
  --hud-mp-b: ${PALETTE.mpB};
  --hud-zp-a: ${PALETTE.zpA};
  --hud-zp-b: ${PALETTE.zpB};
  --hud-tick: ${PALETTE.tick};
}

#${WRAP}{
  position: fixed;
  left: 1.25rem;
  bottom: 1.25rem;
  z-index: 50;               /* below Foundry windows */
  pointer-events: none;
  display: grid;
  grid-auto-flow: column;
  gap: 0.6rem;               /* card spacing */
  transform-origin: bottom left;
}

/* Card layout = [portrait] [panel] ; transparent, no black wrapper */
.fu-card{
  pointer-events: auto;
  display: inline-flex; align-items: flex-start; gap: .6rem;
  opacity: 0; transform: translateX(-24px);
  transition: opacity 420ms ease, transform 420ms ease;
}
.fu-card.appear{ opacity: 1; transform: translateX(0); }

/* NO-CROP floating portrait (bigger than panel) */
.fu-portrait{
  filter: drop-shadow(0 18px 32px rgba(0,0,0,.55));
  pointer-events: none;
}
.fu-portrait img{
  display:block; width:auto; height:auto;
  max-width:  min(18vmin, 220px);
  max-height: min(18vmin, 220px);
  object-fit: contain; border:none; outline:none;
}

/* Translucent rounded panel */
.fu-panel{
  position: relative;
  min-width: 22rem; max-width: 28rem;
  background:
    linear-gradient(180deg,
      rgba(var(--hud-top), var(--hud-op)),
      rgba(var(--hud-bot), var(--hud-op)));
  border: none; border-radius: .9rem; padding: 1rem;
  box-shadow: ${PALETTE.shadow}; backdrop-filter: blur(3px);
  overflow: hidden;
}

/* Header */
.fu-top{ display:flex; align-items:center; gap:.5rem; margin-bottom:.12rem; }
.fu-name{
  font-family: var(--hud-font-ui);
  font-size: .95rem; font-weight: 700; letter-spacing: .02em;
  color: var(--hud-text-dim);
  text-shadow: 0 1px 2px rgba(0,0,0,.95), 0 2px 6px rgba(0,0,0,.45), 0 0 1px rgba(0,0,0,.85);
  flex:1 1 auto;
}
.fu-ip{ display:flex; gap:6px; }
.fu-ip i{ width:12px; height:12px; border-radius:999px; background:rgba(255,255,255,.25); box-shadow:0 0 0 1px rgba(0,0,0,.25) inset; }
.fu-ip i.on{ background:#ffb84a; }

/* Big HP + mini MP on same row */
.fu-hpbig{
  position: relative; margin:.05rem 0 .45rem 0;
  font-family: var(--hud-font-num);
  font-size: 2.25rem; font-weight: 400; letter-spacing: .5px;
  color: var(--hud-text);
  text-shadow: 0 2px 3px rgba(0,0,0,.95), 0 4px 10px rgba(0,0,0,.45), 0 0 1px rgba(0,0,0,.85);
}
.fu-mpmini{ position:absolute; right:.5rem; bottom:.1rem; display:flex; align-items:baseline; gap:.4rem; }
.fu-mpmini .tag{ font-family: var(--hud-font-ui); font-weight:700; font-size:.85rem; color:var(--hud-text-dim); text-shadow:0 1px 2px rgba(0,0,0,.95), 0 0 1px rgba(0,0,0,.85); }
.fu-mpmini .num{ font-family: var(--hud-font-num); font-size:1.26rem; color:var(--hud-text); text-shadow:0 2px 3px rgba(0,0,0,.95), 0 4px 10px rgba(0,0,0,.45), 0 0 1px rgba(0,0,0,.85); }

/* Bars */
.fu-bar{
  position: relative; height:1rem; border-radius:.6rem; overflow:hidden;
  border:1px solid rgba(255,255,255,.20);
  background:linear-gradient(180deg, rgba(0,0,0,.45), rgba(0,0,0,.65));
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.65);
}
.fu-fill{ position:absolute; left:0; top:0; bottom:0; width:0%;
  background:linear-gradient(90deg, var(--hud-hp-a), var(--hud-hp-b));
  transition: width 240ms ease, background 120ms linear;
}
.fu-ticks{ position:absolute; inset:0; pointer-events:none; opacity:.25;
  background-image:repeating-linear-gradient(to right, var(--hud-tick) 0 1px, transparent 1px 12px);
}
.fu-mp{ height:.65rem; margin-top:.25rem; }
.fu-mp .fu-fill{ background:linear-gradient(90deg, var(--hud-mp-a), var(--hud-mp-b)); }
.fu-zp{ height:.65rem; }
.fu-zp .fu-fill{ background:linear-gradient(90deg, var(--hud-zp-a), var(--hud-zp-b)); }
.fu-zprow{ display:flex; align-items:center; gap:.5rem; margin-top:.25rem; }
.fu-zp .fu-fill.glow{ filter: drop-shadow(0 0 6px rgba(80,140,255,.65)) drop-shadow(0 0 12px rgba(80,140,255,.35)); animation: zpGlow 1.2s ease-in-out infinite alternate; }
@keyframes zpGlow{ 0%{box-shadow:0 0 0 rgba(80,140,255,0)} 100%{box-shadow:0 0 22px rgba(80,140,255,.55)} }
.fu-flash{ animation: fillFlash .35s ease; }
@keyframes fillFlash{ 0%{filter:brightness(1.15)} 100%{filter:brightness(1)} }
    `;

    const st = document.createElement("style");
    st.id = STYLE;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function ensureWrap(){
    let wrap = document.getElementById(WRAP);
    if (!wrap){
      wrap = document.createElement("div");
      wrap.id = WRAP;
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  function setWrapScale(cardCount){
    const wrap = ensureWrap();
    const vmin = Math.min(window.innerWidth, window.innerHeight);
    let base = clamp(vmin / 1080, 0.75, 1.15);
    const factor = (cardCount >= 4) ? 0.78 : (cardCount === 3 ? 0.85 : 1.00);
    wrap.style.transform = `scale(${(base*factor).toFixed(4)})`;
  }

  // ===== Card creation (match DEMO DOM) =====================================
  function ipDotsHTML(max, value){
    const dots = [];
    for (let i=0;i<max;i++) dots.push(`<i class="${i<value?'on':''}"></i>`);
    return dots.join("");
  }

  function colorizeHP(fillEl, value, max){
    const p = clamp01(value/max);
    if (p <= 0.10)      fillEl.style.background = `linear-gradient(90deg, ${PALETTE.hp10}, #ff7676)`;
    else if (p <= 0.25) fillEl.style.background = `linear-gradient(90deg, ${PALETTE.hp25}, #ff9a5c)`;
    else if (p <= 0.50) fillEl.style.background = `linear-gradient(90deg, ${PALETTE.hp50}, #89e14a)`;
    else                fillEl.style.background = `linear-gradient(90deg, var(--hud-hp-a), var(--hud-hp-b))`;
  }

  function animateNumber(el, from, to, ms = 420){
    if (!el) return;
    const start = performance.now(), diff = to-from;
    function step(now){
      const t = Math.min(1,(now-start)/ms);
      const eased = t<0.5 ? 2*t*t : 1 - Math.pow(-2*t+2,2)/2;
      el.textContent = fmt(from + diff*eased);
      if (t<1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function createCard(actor, token){
    const wrap = ensureWrap();
    const card = document.createElement("div");
    card.className = "fu-card";

    const portraitSrc = actor?.img || actor?.prototypeToken?.texture?.src || token?.texture?.src || "";

    const hp = getHP(actor);
    if (!hp) return null;
    const mp = getMP(actor);
    const zp = getZP(actor);
    const ip = getIP(actor);

    // Build inner
    card.innerHTML = `
      <div class="fu-portrait"><img src="${portraitSrc}" alt=""></div>
      <div class="fu-panel">
        <div class="fu-top">
          <div class="fu-name">${token?.name || actor?.name || "—"}</div>
          <div class="fu-ip">${ipDotsHTML(ip.max, ip.value)}</div>
        </div>

        <div class="fu-hpbig">
          <span class="hp-cur">${fmt(hp.value)}</span> / <span class="hp-max">${fmt(hp.max)}</span>
          <div class="fu-mpmini"><span class="tag">MP</span><span class="num">${fmt(mp.value)}</span></div>
        </div>

        <div class="fu-bar fu-hp"><div class="fu-fill hp-fill"></div><div class="fu-ticks"></div></div>
        <div class="fu-bar fu-mp"><div class="fu-fill mp-fill"></div></div>
        <div class="fu-zprow"><div class="fu-zplabel" style="font-family:var(--hud-font-zp);font-weight:700;letter-spacing:.06em;">ZP</div>
          <div class="fu-bar fu-zp" style="flex:1 1 auto; min-width:6rem;"><div class="fu-fill zp-fill"></div></div>
        </div>
      </div>
    `;
    wrap.appendChild(card);
    requestAnimationFrame(()=>card.classList.add("appear")); // slide/fade in

    // Init fills
    const hpFill = card.querySelector(".hp-fill");
    const mpFill = card.querySelector(".mp-fill");
    const zpFill = card.querySelector(".zp-fill");
    const hpCur  = card.querySelector(".hp-cur");
    const hpMax  = card.querySelector(".hp-max");
    const mpNum  = card.querySelector(".fu-mpmini .num");
    const ipRow  = card.querySelector(".fu-ip");

    const setBar = (el, v, m)=>{ el.style.width = `${clamp01(v/m)*100}%`; el.classList.remove("fu-flash"); void el.offsetWidth; el.classList.add("fu-flash"); };

    colorizeHP(hpFill, hp.value, hp.max);
    setBar(hpFill, hp.value, hp.max);
    setBar(mpFill, mp.value, mp.max);
    setBar(zpFill, zp.value, zp.max);
    zpFill.classList.toggle("glow", zp.value >= zp.max);

    // Store refs for live updates
    return {
      el: card,
      hpFill, mpFill, zpFill,
      hpCur,  hpMax,  mpNum,
      ipRow
    };
  }

  function updateCard(card, actor){
    if (!card) return;
    const hp = getHP(actor); if (hp){
      const oldCur = Number(card.hpCur?.textContent?.replace(/,/g,"")) || 0;
      animateNumber(card.hpCur, oldCur, hp.value, 420);
      if (card.hpMax) card.hpMax.textContent = fmt(hp.max);
      colorizeHP(card.hpFill, hp.value, hp.max);
      card.hpFill.style.width = `${clamp01(hp.value/hp.max)*100}%`;
      card.hpFill.classList.remove("fu-flash"); void card.hpFill.offsetWidth; card.hpFill.classList.add("fu-flash");
    }
    const mp = getMP(actor); if (mp){
      if (card.mpNum){
        const old = Number(card.mpNum.textContent?.replace(/,/g,"")) || 0;
        animateNumber(card.mpNum, old, mp.value, 420);
      }
      card.mpFill.style.width = `${clamp01(mp.value/mp.max)*100}%`;
      card.mpFill.classList.remove("fu-flash"); void card.mpFill.offsetWidth; card.mpFill.classList.add("fu-flash");
    }
    const zp = getZP(actor); if (zp){
      card.zpFill.style.width = `${clamp01(zp.value/zp.max)*100}%`;
      card.zpFill.classList.remove("fu-flash"); void card.zpFill.offsetWidth; card.zpFill.classList.add("fu-flash");
      card.zpFill.classList.toggle("glow", zp.value >= zp.max);
    }
    const ip = getIP(actor);
    if (ip && card.ipRow){
      card.ipRow.innerHTML = ipDotsHTML(ip.max, ip.value);
    }
  }

  function destroyCards(){
    for (const { el } of window[NS].cards.values()){ try { el.remove(); } catch{} }
    window[NS].cards.clear();
  }

  // ===== Build / Teardown ====================================================
  async function buildHudForCombat(combat){
    teardown(); // safety
    ensureStyle(); ensureWrap();

    const party = await getActivePartyFromDatabase();
    const selected = choosePartyCombatants(combat, party);
    if (!selected.length) return;

    for (const entry of selected){
      const card = createCard(entry.actor, entry.combatant.token ?? entry.actor?.prototypeToken);
      if (!card) continue;
      window[NS].cards.set(entry.actor.id, card);

      // Live updates
      const h1 = Hooks.on("updateActor", (updated, diff) => {
        if (updated?.id !== entry.actor.id) return;
        const live = game.actors?.get(entry.actor.id);
        if (typeof diff?.name === "string") {
          const el = card.el.querySelector(".fu-name");
          if (el) el.textContent = diff.name;
        }
        if (live) updateCard(card, live);
      });
      const h2 = Hooks.on("updateToken", (doc, change) => {
        if (normalizeId(doc?.actor?.id) !== normalizeId(entry.actor.id)) return;
        if (typeof change?.name === "string") {
          const el = card.el.querySelector(".fu-name");
          if (el) el.textContent = change.name || doc?.actor?.name;
        }
        const live = doc.actor;
        if (live) updateCard(card, live);
      });
      window[NS].unhooks.push(()=>Hooks.off("updateActor", h1), ()=>Hooks.off("updateToken", h2));
    }

    setWrapScale(window[NS].cards.size);
  }

  function teardown(){
    for (const fn of window[NS].unhooks){ try{ fn(); } catch{} }
    window[NS].unhooks = [];
    destroyCards();
  }

  // ===== Hook wiring (with extra cleanup guards) ============================
  function installHooksOnce(){
    if (window[NS].mounted) return;

    const hStart = Hooks.on("combatStart", (combat)=> buildHudForCombat(combat));
    const hEnd   = Hooks.on("combatEnd",   ()=> teardown());
    const hDel   = Hooks.on("deleteCombat",()=> teardown());
    const hUpd   = Hooks.on("updateCombat",(c, diff)=> { if (diff?.started === false) teardown(); });
    const hCanvasDown = Hooks.on("canvasTearDown", ()=> teardown());
    const hCanvasReady= Hooks.on("canvasReady", ()=> {
      const c = game.combat;
      if (c?.started || (c?.round ?? 0) > 0) buildHudForCombat(c);
    });

    window[NS].unhooks.push(
      ()=>Hooks.off("combatStart", hStart),
      ()=>Hooks.off("combatEnd",   hEnd),
      ()=>Hooks.off("deleteCombat",hDel),
      ()=>Hooks.off("updateCombat",hUpd),
      ()=>Hooks.off("canvasTearDown", hCanvasDown),
      ()=>Hooks.off("canvasReady", hCanvasReady),
    );

    window[NS].mounted = true;
  }

  Hooks.once("ready", () => installHooksOnce());
})();
