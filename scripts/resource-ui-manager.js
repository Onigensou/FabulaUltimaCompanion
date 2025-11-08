// scripts/resource-ui-manager.js
// ────────────────────────────────────────────────────────────────────────────
// Player Resource HUD (Production)
// • Builds up to 4 party HUD cards on combat start; tears down on combat end.
// • Party membership pulled from Database Actor via db-resolver.js API.
// • Live-updates HP/MP/ZP/IP, name; consistent per-client scaling + slide/fade.
// • No test UI, no close/gear buttons. Z-index sits below normal Foundry UI.
// ────────────────────────────────────────────────────────────────────────────
(() => {
  const MOD  = "fabula-ultima-companion";
  const NS   = "FU_ResourceHUD";
  const WRAP = "fu-rhud-wrap";
  const STYLE= "fu-rhud-style";

  // Ensure namespace
  window[NS] = window[NS] || { mounted:false, cards:new Map(), unhooks:[] };

  // ====== SYSTEM PATHS (match your demo) ====================================
  const HP_VALUE_PATH = "system.props.current_hp";
  const HP_MAX_PATH   = "system.props.max_hp";
  const MP_VALUE_PATH = "system.props.current_mp";
  const MP_MAX_PATH   = "system.props.max_mp";
  const ZP_VALUE_PATH = "system.props.zero_power_value"; // max 6
  const ZP_MAX_CONST  = 6;
  const IP_VALUE_PATH = "system.props.current_ip";
  const IP_MAX_PATH   = "system.props.max_ip"; // optional
  // reference from your demo file so we stay consistent.  // :contentReference[oaicite:10]{index=10}

  // ====== UTILITIES ==========================================================
  const gp = (obj, path) => {
    try { return getProperty(obj, path); } catch { return undefined; }
  };
  const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
  const clamp01 = (x)=>clamp(x,0,1);
  const fmtInt = (x)=> new Intl.NumberFormat().format(Math.max(0, Math.floor(Number(x)||0)));

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
    if (!Number.isFinite(v)) return { value:0, max:ZP_MAX_CONST };
    return { value: Math.max(0,v), max: ZP_MAX_CONST };
  };
  function getIP(actor) {
    const v = Number(gp(actor, IP_VALUE_PATH));
    let m = Number(gp(actor, IP_MAX_PATH));
    if (!Number.isFinite(m) || m <= 0) m = 6; // sane default (matches demo’s auto/fallback behavior)
    if (!Number.isFinite(v)) return { value: 0, max: m };
    return { value: clamp(v,0,m), max: m };
  }

  // ====== PARTY RESOLUTION ===================================================
  // Pull up to 4 members from the Database actor. We support either:
  // - system.props.member_id_1 … member_name_1 (your stated keys)
  // - or fallback name-only fields like system.props.party_member_1 … (seen in sample)
  async function getActivePartyFromDatabase() {
    const API = window.FUCompanion?.api;
    if (!API?.getCurrentGameDb) return [];
    const { db, source } = await API.getCurrentGameDb(); // db + optional token override  // :contentReference[oaicite:11]{index=11}
    if (!db) return [];

    const src = source ?? db;

    const slots = [1,2,3,4].map(i=>{
      const id   = gp(src, `system.props.member_id_${i}`) || gp(src, `system.props.party_member_${i}_id`) || null;
      const name = gp(src, `system.props.member_name_${i}`) || gp(src, `system.props.party_member_${i}`) || null; // sample shows party_member_*  // :contentReference[oaicite:12]{index=12}
      return { idx:i, id: id ? String(id).trim() : null, name: name ? String(name).trim() : null };
    });

    // Remove empty slots
    return slots.filter(s => s.id || s.name);
  }

  // ====== COMBAT → WHO GETS A CARD? =========================================
  function choosePartyCombatants(combat, partyList) {
    const out = [];
    if (!combat) return out;
    const all = combat.combatants?.contents ?? [];

    for (const slot of partyList) {
      let match = null;

      // Prefer ID match
      if (slot.id) {
        match = all.find(c => (c.actor?.id === slot.id) || (c.actor?.uuid?.endsWith(slot.id)));
      }
      // Fallback by name (exact)
      if (!match && slot.name) {
        match = all.find(c => (c.actor?.name === slot.name) || (c.token?.name === slot.name) || (c.name === slot.name));
      }

      if (match?.actor) {
        out.push({ slot: slot.idx, combatant: match, actor: match.actor, token: match.token });
      }
    }

    // Sort by slot order to keep layout deterministic across clients
    out.sort((a,b)=>a.slot-b.slot);
    return out.slice(0,4);
  }

  // ====== LIFECYCLE (COMBAT HOOKS) ==========================================
  function installHooksOnce() {
    if (window[NS].mounted) return;

    // Build cards at combat start (fires on every client; deterministic layout)
    const hStart = Hooks.on("combatStart", async (combat) => {
      await buildHudForCombat(combat);
    });

    // Clean up when combat ends or combat is deleted
    const hEnd1 = Hooks.on("combatEnd", (combat) => { teardown(); });
    const hEnd2 = Hooks.on("deleteCombat", (combat) => { teardown(); });

    // Also rebuild on canvas re-draw (e.g., reload), if there's an active combat
    const hCanvas = Hooks.on("canvasReady", async () => {
      const c = game.combat;
      if (c?.started || (c?.round ?? 0) > 0) await buildHudForCombat(c);
    });

    window[NS].unhooks.push(
      ()=>Hooks.off("combatStart", hStart),
      ()=>Hooks.off("combatEnd", hEnd1),
      ()=>Hooks.off("deleteCombat", hEnd2),
      ()=>Hooks.off("canvasReady", hCanvas),
    );

    window[NS].mounted = true;
  }

  // ====== DOM + STYLES =======================================================
  function ensureStyle() {
    if (document.getElementById(STYLE)) return;

    const css = `
#${WRAP}{
  position: fixed;
  left: 18px;
  bottom: 18px;
  z-index: 50;                /* below dialogs/windows */
  pointer-events: none;       /* HUD never blocks clicks */
  display: grid;
  grid-auto-flow: column;
  gap: 16px;                  /* space between cards */
  /* Per-client scale that we compute in JS */
  transform-origin: bottom left;
}

.fu-card{
  pointer-events: auto;       /* so text can select (if ever needed) */
  opacity: 0;                 /* start hidden for fade-in */
  transform: translateX(-24px); /* slide from left */
  transition: opacity 420ms ease, transform 420ms ease;
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  background: linear-gradient(to bottom, rgba(35,35,38,.90), rgba(22,22,24,.90));
  border: 1px solid #000;
  border-radius: 12px;
  padding: 10px 12px;
  box-shadow: 0 4px 12px rgba(0,0,0,.35);
  min-width: 320px;
  max-width: 420px;
}

.fu-card.appear{
  opacity: 1;
  transform: translateX(0);
}

.fu-portrait{
  width: 96px; height: 96px;
  border-radius: 12px;
  overflow: hidden;
  margin-right: 10px;
  background: #0007;
  display:flex; align-items:center; justify-content:center;
}
.fu-portrait img{
  display:block; max-width:100%; max-height:100%;
}

.fu-right{ display:grid; gap:6px; }
.fu-name{
  font-family: var(--fu-name, "Merriweather", system-ui, sans-serif);
  font-weight: 700; letter-spacing: .5px;
  transform: skewX(-8deg);
  text-shadow: 0 2px 0 #000, 0 0 8px #0008;
  color: #fff; font-size: 16px;
}

.fu-hp-row{
  display:grid; align-items:center;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
}
.fu-hp-num{
  font-family: var(--fu-num, "Merriweather", ui-monospace, monospace);
  font-size: 28px; font-weight: 800; color:#fff;
  text-shadow: 0 2px 0 #000, 0 0 8px #0008;
}
.fu-bar{
  height: 10px; border-radius: 8px; overflow: hidden; background:#000a; border:1px solid #000;
}
.fu-bar > i{ display:block; height:100%; width:0%; background: linear-gradient(90deg, #73e07a, #3cc15b); }
.fu-mp{ height: 6px; }
.fu-mp > i{ background: linear-gradient(90deg, #79b7ff, #6b9cff); }
.fu-zp{ height: 6px; }
.fu-zp > i{ background: linear-gradient(90deg, #f9b169, #ffdd91); box-shadow: 0 0 10px #ffd46699 inset; }
.fu-ip-row{ display:flex; gap:6px; }
.fu-ip-dot{ width: 8px; height: 8px; border-radius: 999px; background:#ddd; box-shadow: 0 0 0 1px #000 inset, 0 0 6px #fff7; }

@media (max-width: 1400px){
  .fu-card{ min-width: 300px; }
}
    `;
    const st = document.createElement("style");
    st.id = STYLE;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function ensureWrap() {
    let wrap = document.getElementById(WRAP);
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = WRAP;
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  function setWrapScale(cardCount){
    const wrap = ensureWrap();
    // Base scale from viewport vmin (keep consistent across monitors)
    // tuned for ≈1080p → 1.00; clamp a little for extremes
    const vmin = Math.min(window.innerWidth, window.innerHeight);
    let base = clamp(vmin / 1080, 0.75, 1.15);
    // Slightly shrink when we show more cards so we never collide with chat
    const factor = (cardCount >= 4) ? 0.78 : (cardCount === 3 ? 0.85 : 1.00);
    const scale = base * factor;
    wrap.style.transform = `scale(${scale.toFixed(4)})`;
  }

  // ====== BUILD / UPDATE CARDS ==============================================
  function createCard(actor, token){
    const wrap = ensureWrap();
    const card = document.createElement("div");
    card.className = "fu-card";

    const portraitSrc = actor?.img || actor?.prototypeToken?.texture?.src || token?.texture?.src || ""; // like the demo fallback order  // :contentReference[oaicite:13]{index=13}

    const hp = getHP(actor);
    if (!hp) { console.warn("[ResourceHUD] Missing HP fields on actor:", actor?.name); return null; }
    const mp = getMP(actor);
    const zp = getZP(actor);
    const ip = getIP(actor);

    const ipDots = Array.from({length: ip.max}, (_,i)=>`<i class="fu-ip-dot" data-i="${i}"></i>`).join("");

    card.innerHTML = `
      <div class="fu-portrait"><img src="${portraitSrc}"></div>
      <div class="fu-right">
        <div class="fu-name">${token?.name || actor?.name || "—"}</div>
        <div class="fu-hp-row">
          <div class="fu-hp-num" data-hp>${fmtInt(hp.value)} / ${fmtInt(hp.max)}</div>
          <div class="fu-bar fu-hp"><i data-hpbar style="width:${100*hp.value/hp.max}%"></i></div>
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="font-size:10px; color:#fff9; text-shadow:0 1px 0 #000;">MP</span>
            <div class="fu-bar fu-mp" style="width:120px"><i data-mpbar style="width:${100*mp.value/mp.max}%"></i></div>
          </div>
        </div>
        <div class="fu-bar fu-zp"><i data-zpbar style="width:${100*zp.value/zp.max}%"></i></div>
        <div class="fu-ip-row" data-ip>${ipDots}</div>
      </div>
    `;
    wrap.appendChild(card);

    // Trigger appear animation
    requestAnimationFrame(()=>card.classList.add("appear"));

    // Store refs for live updates
    return {
      el: card,
      hpNum: card.querySelector("[data-hp]"),
      hpBar: card.querySelector("[data-hpbar]"),
      mpBar: card.querySelector("[data-mpbar]"),
      zpBar: card.querySelector("[data-zpbar]"),
      ipRow: card.querySelector("[data-ip]")
    };
  }

  function updateCard(card, actor){
    if (!card) return;
    const hp = getHP(actor); if (hp){
      card.hpNum.textContent = `${fmtInt(hp.value)} / ${fmtInt(hp.max)}`;
      card.hpBar.style.width = `${100*hp.value/hp.max}%`;
    }
    const mp = getMP(actor); if (mp) card.mpBar.style.width = `${100*mp.value/mp.max}%`;
    const zp = getZP(actor); if (zp) card.zpBar.style.width = `${100*zp.value/zp.max}%`;
    const ip = getIP(actor);
    if (ip && card.ipRow){
      // ensure the right count then light up "value" dots
      const count = card.ipRow.children.length;
      if (count !== ip.max){
        card.ipRow.innerHTML = Array.from({length: ip.max}, (_,i)=>`<i class="fu-ip-dot" data-i="${i}"></i>`).join("");
      }
      [...card.ipRow.children].forEach((dot,i)=>{
        dot.style.opacity = (i < ip.value) ? "1" : ".3";
      });
    }
  }

  function destroyCards(){
    for (const { el } of window[NS].cards.values()){
      try { el.remove(); } catch {}
    }
    window[NS].cards.clear();
  }

  // ====== PUBLIC BUILD =======================================================
  async function buildHudForCombat(combat){
    teardown(); // safety
    ensureStyle();
    ensureWrap();

    const party = await getActivePartyFromDatabase();
    const selected = choosePartyCombatants(combat, party);
    if (!selected.length) return; // nothing to show

    // Build in slot order so all clients end up with same left→right layout
    for (const entry of selected){
      const card = createCard(entry.actor, entry.combatant.token ?? entry.actor?.prototypeToken);
      if (!card) continue;

      window[NS].cards.set(entry.actor.id, card);

      // Live update hooks (actor + token)
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
        if (doc?.actor?.id !== entry.actor.id) return;
        if (typeof change?.name === "string") {
          const el = card.el.querySelector(".fu-name");
          if (el) el.textContent = change.name || doc?.actor?.name;
        }
        const live = doc.actor;
        if (live) updateCard(card, live);
      });
      window[NS].unhooks.push(()=>Hooks.off("updateActor", h1), ()=>Hooks.off("updateToken", h2));
    }

    // Finalize scale after all cards exist
    setWrapScale(window[NS].cards.size);
  }

  // ====== TEARDOWN ===========================================================
  function teardown(){
    for (const fn of window[NS].unhooks){ try{ fn(); } catch{} }
    window[NS].unhooks = [];
    destroyCards();
  }

  // ====== INIT ===============================================================
  Hooks.once("ready", () => {
    installHooksOnce();
  });

})();
