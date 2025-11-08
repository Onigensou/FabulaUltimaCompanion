// scripts/resource-ui-manager.js
// ────────────────────────────────────────────────────────────────────────────
// Conflict-safe Player Resource HUD (DEMO look, animations, multi-member)
// • New namespace, ids, classes, and function names to avoid collisions.
// • Still reads party from Database via db-resolver.js (unchanged external API).
// • Handles Actor.<ID> copies, live updates, consistent scaling, clean teardown.
// ────────────────────────────────────────────────────────────────────────────
(() => {
  // ——— Unique namespace & ids (renamed) ————————————————————————————————
  const HUD_NS        = "OniHud2";                  // window[HUD_NS] namespace
  const ROOT_ID       = "oni2-hud-root";
  const STYLE_ID      = "oni2-hud-style";
  const FONTLINK_ID   = "oni2-hud-fonts";

  // Init namespace container
  window[HUD_NS] = window[HUD_NS] || { active:false, cards:new Map(), off:[] };

  // ——— System paths (same logic as your demo) ——————————————
  const PATH_HP_VAL   = "system.props.current_hp";
  const PATH_HP_MAX   = "system.props.max_hp";
  const PATH_MP_VAL   = "system.props.current_mp";
  const PATH_MP_MAX   = "system.props.max_mp";
  const PATH_IP_VAL   = "system.props.current_ip";
  const PATH_IP_MAX   = "system.props.max_ip";
  const PATH_ZP_VAL   = "system.props.zero_power_value";
  const ZP_MAX_CONST  = 6;

  // ——— Fonts & palette (demo vibe) ———————————————————————
  const UI_FONT   = "Signika";
  const NUM_FONT  = "Cinzel";
  const ZP_FONT   = "Silkscreen";

  const TONE = {
    text: "#ffffff",
    textDim: "rgba(255,255,255,.86)",
    topRGB: "18,18,20",
    botRGB: "12,12,14",
    opac:   0.78,
    border: "rgba(255,255,255,0.12)",
    hpA: "#6bd66b",
    hpB: "#2fbf71",
    mpA: "#5aa8ff",
    mpB: "#2e7bd6",
    zpA: "#ffd95a",
    zpB: "#ff9c2e",
    hp50: "#a2e33a",
    hp25: "#ffb84a",
    hp10: "#ff5a5a",
    shadow: "0 12px 28px rgba(0,0,0,0.45)",
    tick: "rgba(255,255,255,.12)"
  };

  // ——— Small helpers (renamed) ————————————————————————————
  const pick = (o,p)=>{ try { return getProperty(o,p); } catch { return undefined; } };
  const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
  const pct   = (v,m)=>`${(clamp(v/m,0,1)*100).toFixed(4)}%`;
  const nice  = x => new Intl.NumberFormat().format(Math.max(0, Math.floor(Number(x)||0)));
  const stripActorPrefix = id => id ? String(id).replace(/^Actor\./i,"").trim() : id;

  const pair = (actor, vPath, mPath, fallback=null) => {
    const v = Number(pick(actor, vPath));
    let   m = Number(pick(actor, mPath));
    if (!Number.isFinite(m)) m = fallback;
    if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return null;
    return { v, m };
  };

  const readHP = a => pair(a, PATH_HP_VAL, PATH_HP_MAX);
  const readMP = a => pair(a, PATH_MP_VAL, PATH_MP_MAX) || { v:0, m:1 };
  const readZP = a => {
    const v = Number(pick(a, PATH_ZP_VAL));
    return { v: Number.isFinite(v) ? Math.max(0,v) : 0, m: ZP_MAX_CONST };
  };
  function readIP(a){
    const v = Number(pick(a, PATH_IP_VAL));
    let m = Number(pick(a, PATH_IP_MAX));
    if (!Number.isFinite(m) || m <= 0) m = 6;
    return { v: Number.isFinite(v) ? clamp(v,0,m) : 0, m };
  }

  // ——— Database → party slots (renamed) ————————————————————
  async function fetchPartySlots(){
    const API = window.FUCompanion?.api; // external API kept as-is
    if (!API?.getCurrentGameDb) return [];
    const { db, source } = await API.getCurrentGameDb();
    if (!db) return [];
    const src = source ?? db;

    return [1,2,3,4].map(i => {
      const rawId = pick(src, `system.props.member_id_${i}`) || pick(src, `system.props.party_member_${i}_id`);
      const name  = pick(src, `system.props.member_name_${i}`) || pick(src, `system.props.party_member_${i}`);
      return { slot:i, id: stripActorPrefix(rawId), name: name ? String(name).trim() : null };
    }).filter(s => s.id || s.name);
  }

  // ——— Match combatants (renamed) ———————————————————————————
  function mapPartyToCombat(combat, roster){
    const chosen = [];
    const all = combat?.combatants?.contents ?? [];
    for (const s of roster){
      let hit = null;
      if (s.id){
        hit = all.find(c =>
          stripActorPrefix(c.actor?.id) === s.id ||
          stripActorPrefix(c.actor?.uuid?.split(".").pop()) === s.id
        );
      }
      if (!hit && s.name){
        hit = all.find(c => (c.actor?.name === s.name) || (c.token?.name === s.name) || (c.name === s.name));
      }
      if (hit?.actor) chosen.push({ slot:s.slot, combatant:hit, actor:hit.actor, token:hit.token });
    }
    chosen.sort((a,b)=>a.slot-b.slot);
    return chosen.slice(0,4);
  }

  // ——— Fonts & styles (renamed classes/ids) ————————————————
  function mountFonts(){
    const families = [
      "family=" + encodeURIComponent(`${UI_FONT}:wght@400;600;700;900`),
      "family=" + encodeURIComponent(`${NUM_FONT}:wght@400;700;900`),
      "family=" + encodeURIComponent(`${ZP_FONT}:wght@400;700`)
    ].join("&");
    const href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
    let link = document.getElementById(FONTLINK_ID);
    if (!link) { link = document.createElement("link"); link.id = FONTLINK_ID; link.rel = "stylesheet"; document.head.appendChild(link); }
    if (link.href !== href) link.href = href;
  }

  function injectStyles(){
    if (document.getElementById(STYLE_ID)) return;
    mountFonts();

    const css = `
#${ROOT_ID}{
  --ui-font: "${UI_FONT}", system-ui, sans-serif;
  --num-font: "${NUM_FONT}", "${UI_FONT}", monospace;
  --zp-font:  "${ZP_FONT}", "${UI_FONT}", monospace;
  --txt: ${TONE.text};
  --txt-dim: ${TONE.textDim};
  --top: ${TONE.topRGB};
  --bot: ${TONE.botRGB};
  --op: ${TONE.opac};
  --hp-a: ${TONE.hpA};
  --hp-b: ${TONE.hpB};
  --mp-a: ${TONE.mpA};
  --mp-b: ${TONE.mpB};
  --zp-a: ${TONE.zpA};
  --zp-b: ${TONE.zpB};
  --tick: ${TONE.tick};
}

#${ROOT_ID}{
  position: fixed;
  left: 1.25rem;
  bottom: 1.25rem;
  z-index: 50;
  pointer-events: none;
  display: grid;
  grid-auto-flow: column;
  gap: 0.6rem;
  transform-origin: bottom left;
}

/* Card (new class names) */
.oni2-card{
  pointer-events: auto;
  display: inline-flex; align-items: flex-start; gap: .6rem;
  opacity: 0; transform: translateX(-24px);
  transition: opacity 420ms ease, transform 420ms ease;
}
.oni2-card.oni2-appear{ opacity:1; transform: translateX(0); }

/* Floating portrait */
.oni2-portrait{ filter: drop-shadow(0 18px 32px rgba(0,0,0,.55)); pointer-events:none; }
.oni2-portrait img{ display:block; width:auto; height:auto; max-width:min(18vmin,220px); max-height:min(18vmin,220px); object-fit:contain; }

/* Translucent panel */
.oni2-panel{
  position: relative;
  min-width: 22rem; max-width: 28rem;
  background: linear-gradient(180deg, rgba(var(--top), var(--op)), rgba(var(--bot), var(--op)));
  border: none; border-radius: .9rem; padding: 1rem;
  box-shadow: ${TONE.shadow}; backdrop-filter: blur(3px);
  overflow: hidden;
}

/* Top row */
.oni2-top{ display:flex; align-items:center; gap:.5rem; margin-bottom:.12rem; }
.oni2-name{
  font-family: var(--ui-font); font-size: .95rem; font-weight:700; letter-spacing:.02em;
  color:#fff; transform: skewX(-8deg);
  text-shadow: 0 1px 2px rgba(0,0,0,.95), 0 2px 6px rgba(0,0,0,.45), 0 0 1px rgba(0,0,0,.85);
  flex:1 1 auto;
}
.oni2-ip{ display:flex; gap:6px; }
.oni2-ip i{ width:12px; height:12px; border-radius:999px; background:rgba(255,255,255,.25); box-shadow:0 0 0 1px rgba(0,0,0,.25) inset; }
.oni2-ip i.on{ background:#ffb84a; }

/* Big HP line + mini MP */
.oni2-hpbig{
  position: relative; margin:.05rem 0 .45rem 0;
  font-family: var(--num-font);
  font-size: 2.25rem; font-weight: 400; letter-spacing:.5px;
  color:#fff;
  text-shadow: 0 2px 3px rgba(0,0,0,.95), 0 4px 10px rgba(0,0,0,.45), 0 0 1px rgba(0,0,0,.85);
}
.oni2-mpmini{ position:absolute; right:.5rem; bottom:.1rem; display:flex; align-items:baseline; gap:.4rem; }
.oni2-mpmini .tag{
  font-family: var(--ui-font); font-weight:700; font-size:.85rem; color:var(--txt-dim);
  text-shadow: 0 1px 2px rgba(0,0,0,.95), 0 0 1px rgba(0,0,0,.85);
}
.oni2-mpmini .num{
  font-family: var(--num-font); font-size:1.26rem; color:#fff;
  text-shadow: 0 2px 3px rgba(0,0,0,.95), 0 4px 10px rgba(0,0,0,.45), 0 0 1px rgba(0,0,0,.85);
}

/* Bars */
.oni2-bar{
  position: relative; height:1rem; border-radius:.6rem; overflow:hidden;
  border:1px solid rgba(255,255,255,.20);
  background:linear-gradient(180deg, rgba(0,0,0,.45), rgba(0,0,0,.65));
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.65);
}
.oni2-fill{ position:absolute; left:0; top:0; bottom:0; width:0%;
  background:linear-gradient(90deg, var(--hp-a), var(--hp-b));
  transition: width 240ms ease, background 120ms linear;
}
.oni2-ticks{ position:absolute; inset:0; pointer-events:none; opacity:.25;
  background-image:repeating-linear-gradient(to right, var(--tick) 0 1px, transparent 1px 12px);
}
.oni2-mp{ height:.65rem; margin-top:.25rem; }
.oni2-mp .oni2-fill{ background:linear-gradient(90deg, var(--mp-a), var(--mp-b)); }
.oni2-zp{ height:.65rem; }
.oni2-zp .oni2-fill{ background:linear-gradient(90deg, var(--zp-a), var(--zp-b)); }
.oni2-zprow{ display:flex; align-items:center; gap:.5rem; margin-top:.25rem; }
.oni2-zplabel{
  font-family: var(--zp-font); font-weight:700; letter-spacing:.06em; color:#fff;
  text-shadow: 0 2px 3px rgba(0,0,0,.95), 0 0 1px rgba(0,0,0,.85); user-select:none;
}
.oni2-zp .oni2-fill.oni2-glow{
  filter: drop-shadow(0 0 6px rgba(80,140,255,.65)) drop-shadow(0 0 12px rgba(80,140,255,.35));
  animation: oni2ZpGlow 1.2s ease-in-out infinite alternate;
}
@keyframes oni2ZpGlow{ 0%{box-shadow:0 0 0 rgba(80,140,255,0)} 100%{box-shadow:0 0 22px rgba(80,140,255,.55)} }
.oni2-flash{ animation: oni2FillFlash .35s ease; }
@keyframes oni2FillFlash{ 0%{filter:brightness(1.15)} 100%{filter:brightness(1)} }
    `;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function mountRoot(){
    let root = document.getElementById(ROOT_ID);
    if (!root){
      root = document.createElement("div");
      root.id = ROOT_ID;
      document.body.appendChild(root);
    }
    return root;
  }

  function scaleRootForCards(count){
    const root = mountRoot();
    const vmin = Math.min(window.innerWidth, window.innerHeight);
    let base = clamp(vmin / 1080, 0.75, 1.15);
    const factor = (count >= 4) ? 0.78 : (count === 3 ? 0.85 : 1.00);
    root.style.transform = `scale(${(base*factor).toFixed(4)})`;
  }

  // ——— Rendering helpers (renamed) ——————————————————————————
  const dotRow = (max, val)=> Array.from({length:max}, (_,i)=>`<i class="${i<val?'on':''}"></i>`).join("");

  function tintHp(fillEl, v, m){
    const p = Math.max(0, Math.min(1, v/m));
    if (p <= 0.10)      fillEl.style.background = `linear-gradient(90deg, ${TONE.hp10}, #ff7676)`;
    else if (p <= 0.25) fillEl.style.background = `linear-gradient(90deg, ${TONE.hp25}, #ff9a5c)`;
    else if (p <= 0.50) fillEl.style.background = `linear-gradient(90deg, ${TONE.hp50}, #89e14a)`;
    else                fillEl.style.background = `linear-gradient(90deg, var(--hp-a), var(--hp-b))`;
  }

  function glideNumber(node, from, to, ms=420){
    if (!node) return;
    const t0 = performance.now(), d = to - from;
    function loop(t){
      const n = Math.min(1, (t - t0) / ms);
      const ease = n < .5 ? 2*n*n : 1 - Math.pow(-2*n+2,2)/2;
      node.textContent = nice(from + d*ease);
      if (n < 1) requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  function makeCard(actor, token){
    const root = mountRoot();
    const card = document.createElement("div");
    card.className = "oni2-card";

    const portrait = actor?.img || actor?.prototypeToken?.texture?.src || token?.texture?.src || "";

    const hp = readHP(actor); if (!hp) return null;
    const mp = readMP(actor);
    const zp = readZP(actor);
    const ip = readIP(actor);

    card.innerHTML = `
      <div class="oni2-portrait"><img src="${portrait}" alt=""></div>
      <div class="oni2-panel">
        <div class="oni2-top">
          <div class="oni2-name">${token?.name || actor?.name || "—"}</div>
          <div class="oni2-ip">${dotRow(ip.m, ip.v)}</div>
        </div>

        <div class="oni2-hpbig">
          <span class="oni2-hpcur">${nice(hp.v)}</span> / <span class="oni2-hpmax">${nice(hp.m)}</span>
          <div class="oni2-mpmini"><span class="tag">MP</span><span class="num">${nice(mp.v)}</span></div>
        </div>

        <div class="oni2-bar oni2-hp"><div class="oni2-fill oni2-hpfill"></div><div class="oni2-ticks"></div></div>
        <div class="oni2-bar oni2-mp"><div class="oni2-fill oni2-mpfill"></div></div>
        <div class="oni2-zprow"><div class="oni2-zplabel">ZP</div>
          <div class="oni2-bar oni2-zp" style="flex:1 1 auto; min-width:6rem;"><div class="oni2-fill oni2-zpfill"></div></div>
        </div>
      </div>
    `;
    root.appendChild(card);
    requestAnimationFrame(()=>card.classList.add("oni2-appear"));

    // references
    const hpFill = card.querySelector(".oni2-hpfill");
    const mpFill = card.querySelector(".oni2-mpfill");
    const zpFill = card.querySelector(".oni2-zpfill");
    const hpCur  = card.querySelector(".oni2-hpcur");
    const hpMax  = card.querySelector(".oni2-hpmax");
    const mpNum  = card.querySelector(".oni2-mpmini .num");
    const ipRow  = card.querySelector(".oni2-ip");

    const flash = el => { el.classList.remove("oni2-flash"); void el.offsetWidth; el.classList.add("oni2-flash"); };

    tintHp(hpFill, hp.v, hp.m);
    hpFill.style.width = pct(hp.v, hp.m); flash(hpFill);
    mpFill.style.width = pct(mp.v, mp.m); flash(mpFill);
    zpFill.style.width = pct(zp.v, zp.m); flash(zpFill);
    zpFill.classList.toggle("oni2-glow", zp.v >= zp.m);

    return { el:card, hpFill, mpFill, zpFill, hpCur, hpMax, mpNum, ipRow };
  }

  function refreshCard(slot, card, actor){
    if (!card) return;
    const hp = readHP(actor); if (hp){
      const cur = Number(card.hpCur?.textContent?.replace(/,/g,"")) || 0;
      glideNumber(card.hpCur, cur, hp.v, 420);
      if (card.hpMax) card.hpMax.textContent = nice(hp.m);
      tintHp(card.hpFill, hp.v, hp.m);
      card.hpFill.style.width = pct(hp.v, hp.m);
      card.hpFill.classList.remove("oni2-flash"); void card.hpFill.offsetWidth; card.hpFill.classList.add("oni2-flash");
    }
    const mp = readMP(actor); if (mp){
      if (card.mpNum){
        const o = Number(card.mpNum.textContent?.replace(/,/g,"")) || 0;
        glideNumber(card.mpNum, o, mp.v, 420);
      }
      card.mpFill.style.width = pct(mp.v, mp.m);
      card.mpFill.classList.remove("oni2-flash"); void card.mpFill.offsetWidth; card.mpFill.classList.add("oni2-flash");
    }
    const zp = readZP(actor); if (zp){
      card.zpFill.style.width = pct(zp.v, zp.m);
      card.zpFill.classList.remove("oni2-flash"); void card.zpFill.offsetWidth; card.zpFill.classList.add("oni2-flash");
      card.zpFill.classList.toggle("oni2-glow", zp.v >= zp.m);
    }
    const ip = readIP(actor);
    if (ip && card.ipRow){
      card.ipRow.innerHTML = dotRow(ip.m, ip.v);
    }
  }

  function purgeAllCards(){
    for (const { el } of window[HUD_NS].cards.values()){ try { el.remove(); } catch{} }
    window[HUD_NS].cards.clear();
  }

  // ——— Build/teardown (renamed) —————————————————————————————
  async function composeHudForCombat(combat){
    dismantle(); // safety reset
    injectStyles(); mountRoot();

    const slots = await fetchPartySlots();
    const picks = mapPartyToCombat(combat, slots);
    if (!picks.length) return;

    for (const entry of picks){
      const card = makeCard(entry.actor, entry.combatant.token ?? entry.actor?.prototypeToken);
      if (!card) continue;
      window[HUD_NS].cards.set(entry.actor.id, card);

      // live updates
      const h1 = Hooks.on("updateActor", (doc, diff) => {
        if (doc?.id !== entry.actor.id) return;
        const live = game.actors?.get(entry.actor.id);
        if (typeof diff?.name === "string") {
          const el = card.el.querySelector(".oni2-name");
          if (el) el.textContent = diff.name;
        }
        if (live) refreshCard(entry.slot, card, live);
      });
      const h2 = Hooks.on("updateToken", (tok, change) => {
        if (stripActorPrefix(tok?.actor?.id) !== stripActorPrefix(entry.actor.id)) return;
        if (typeof change?.name === "string") {
          const el = card.el.querySelector(".oni2-name");
          if (el) el.textContent = change.name || tok?.actor?.name;
        }
        const live = tok.actor;
        if (live) refreshCard(entry.slot, card, live);
      });
      window[HUD_NS].off.push(()=>Hooks.off("updateActor", h1), ()=>Hooks.off("updateToken", h2));
    }

    scaleRootForCards(window[HUD_NS].cards.size);
  }

  function dismantle(){
    for (const f of window[HUD_NS].off){ try{ f(); } catch{} }
    window[HUD_NS].off = [];
    purgeAllCards();
  }

  // ——— Hook wiring (renamed) ———————————————————————————————
  function primeHudHooks(){
    if (window[HUD_NS].active) return;

    const hStart  = Hooks.on("combatStart", (c)=> composeHudForCombat(c));
    const hEnd    = Hooks.on("combatEnd",   ()=> dismantle());
    const hDel    = Hooks.on("deleteCombat",()=> dismantle());
    const hUpd    = Hooks.on("updateCombat",(c,diff)=> { if (diff?.started === false) dismantle(); });
    const hDown   = Hooks.on("canvasTearDown", ()=> dismantle());
    const hReady  = Hooks.on("canvasReady", ()=> {
      const c = game.combat;
      if (c?.started || (c?.round ?? 0) > 0) composeHudForCombat(c);
    });

    window[HUD_NS].off.push(
      ()=>Hooks.off("combatStart", hStart),
      ()=>Hooks.off("combatEnd",   hEnd),
      ()=>Hooks.off("deleteCombat",hDel),
      ()=>Hooks.off("updateCombat",hUpd),
      ()=>Hooks.off("canvasTearDown", hDown),
      ()=>Hooks.off("canvasReady", hReady),
    );

    window[HUD_NS].active = true;
  }

  Hooks.once("ready", () => primeHudHooks());
})();
