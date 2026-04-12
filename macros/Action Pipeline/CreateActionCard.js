// ──────────────────────────────────────────────────────────
//  Create Action Card (global, delegated UI bind) — Foundry V12
//  • One row: Confirm → Invoke Trait → Invoke Bond
//  • Tooltips (black, instant) via document-level delegation
//  • Collapsible Effect via delegation
//  • Content-link open via delegation
//  • Roll-up numbers auto-run for new cards (IO + MO)
//  • Invoke buttons are HTML only; your module handles click logic
//  • No Dismiss button
//  • NEW: Floating 👑 Critical! callout (no more crit badge in Accuracy row)
//  • UPDATED: canonical saved target UUIDs are now the source of truth
// ──────────────────────────────────────────────────────────
const ADV_MACRO_NAME  = "AdvanceDamage";
const MISS_MACRO_NAME = "Miss";
const MODULE_NS       = "fabula-ultima-companion";
const CAC_DEBUG       = true;
const CAC_TAG         = "[ONI][CreateActionCard]";

// --- icons for defense targeting (Strike/Magic) ---
const STRIKE_ICON_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/UI/fu-icon/physical_icon.png";
const MAGIC_ICON_URL  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Fabula%20Ultima/UI/fu-icon/magical_icon.png";

// ---------- one-time global UI binder (idempotent) ----------
(function fuBindGlobalOnce(){
  if (window.__fuCardUIBound) return;
  window.__fuCardUIBound = true;

  // Global tooltip node
  const TT_ID = "fu-global-tooltip";
  let tipEl = document.getElementById(TT_ID);
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.id = TT_ID;
    Object.assign(tipEl.style, {
      position: "fixed", zIndex: "2147483647", display: "none",
      background: "rgba(0,0,0,.90)", color: "#fff", padding: ".45rem .6rem",
      borderRadius: "6px", fontSize: "12px", maxWidth: "320px",
      pointerEvents: "none", boxShadow: "0 2px 8px rgba(0,0,0,.4)",
      border: "1px solid rgba(255,255,255,.15)", textAlign: "left",
      whiteSpace: "pre-wrap"
    });
    document.body.appendChild(tipEl);
  }
  const TIP_MARGIN = 10, CURSOR_GAP = 12;
  const placeTipAt = (x,y) => {
    const vw=innerWidth, vh=innerHeight, r=tipEl.getBoundingClientRect();
    let tx=x+CURSOR_GAP, ty=y+CURSOR_GAP;
    if (tx + r.width + TIP_MARGIN > vw) tx = x - r.width - CURSOR_GAP;
    if (tx < TIP_MARGIN) tx = TIP_MARGIN;
    if (ty + r.height + TIP_MARGIN > vh) ty = y - r.height - CURSOR_GAP;
    if (ty < TIP_MARGIN) ty = TIP_MARGIN;
    tipEl.style.left = `${tx}px`; tipEl.style.top = `${ty}px`;
  };
  const showTip = (html,x,y)=>{ tipEl.style.visibility="hidden"; tipEl.style.display="block"; tipEl.innerHTML=html; placeTipAt(x,y); tipEl.style.visibility="visible"; };
  const hideTip = ()=>{ tipEl.style.display="none"; };

  // --- Half-open Effect CSS (inject once) ---
  if (!document.getElementById("fu-effect-preview-css")) {
    const style = document.createElement("style");
    style.id = "fu-effect-preview-css";
    style.textContent = `
  /* Keep body text black, but don't touch your colored content-links */
.chat-message .message-content .fu-effect .fu-effect-inner {
  color: #000;              /* no !important */
  text-shadow: none;        /* no !important */
}
/* Allow your Custom CSS to recolor these links (Bolt, Fire, etc.) */
.chat-message .message-content .fu-effect .fu-effect-inner a.content-link,
.chat-message .message-content .fu-effect .fu-effect-inner a.content-link * {
  color: inherit;           /* your external rules with !important will win */
  text-shadow: none;
}

  /* Body container already exists in your card */
  .fu-effect-body {
    will-change: max-height;
    max-height: 0;
    overflow: hidden;
    transition: max-height .28s ease, padding .28s ease;
    position: relative;             /* anchor for the overlay */
    padding: 0 .25rem;
    margin-top: .05rem;
  }

  /* NEW: Real child overlay (theme-safe), only when in preview mode */
  .fu-effect-body.preview .fu-fade{
    position: absolute;
    left: 0; right: 0; bottom: 0;
    height: var(--fade-height, 2.2em);
    pointer-events: none;
    z-index: 1;
    background: var(--fade-overlay,
      linear-gradient(to bottom,
        rgba(217,215,203,0) 0%,
        rgba(217,215,203,0.85) 65%,
        rgba(217,215,203,1) 100%)
    );
  }

  /* Optional hint styling (unchanged) */
  .fu-effect-hint { opacity:.7; font-size:12px; margin-left:.35rem; }
  .fu-effect[data-collapsed="false"] .fu-effect-hint { opacity:.9; }
`;
    document.head.appendChild(style);
  }

  // Delegated tooltip
  document.addEventListener("mouseover", (ev) => {
    const host = ev.target.closest?.(".fu-tip-host");
    if (!host) return;
    const html = decodeURIComponent(host.getAttribute("data-tip") || "");
    showTip(html, ev.clientX, ev.clientY);
    document.addEventListener("mousemove", mouseMoveFollower);
    function mouseMoveFollower(e){ placeTipAt(e.clientX, e.clientY); }
    host.addEventListener("mouseout", function onOut() {
      hideTip();
      document.removeEventListener("mousemove", mouseMoveFollower);
      host.removeEventListener("mouseout", onOut);
    }, { once:true });
  }, { capture:false });

  // Delegated content-link opening
  document.addEventListener("click", async (ev) => {
    const a = ev.target.closest?.("a.content-link[data-doc-uuid],a.content-link[data-uuid]");
    if (!a) return;
    ev.preventDefault(); ev.stopPropagation();
    const uuid = a.dataset.docUuid || a.dataset.uuid;
    if (!uuid) return;
    try { await Hotbar.toggleDocumentSheet(uuid); }
    catch {
      try { const doc = await fromUuid(uuid); doc?.sheet?.render(true); }
      catch { ui.notifications?.error("Could not open linked document."); }
    }
  }, { capture:false });

  // Roll-up numbers
  const reduceMotion = matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const clamp=(n,a,b)=>Math.min(Math.max(n,a),b), fmt=(n)=>n.toLocaleString?.() ?? String(n), easeOutCubic=t=>1-Math.pow(1-t,3);
  function animateRollNumber(el) {
    if (!el || el.__rolled) return;
    el.__rolled = true;
    const final = Number(el.dataset.final || "0");
    const start = Math.min(1, final>0?1:0);
    if (!Number.isFinite(final) || final <= 0 || reduceMotion) { el.textContent = fmt(final); return; }
    const dur = clamp(800, 500, 900);
    const t0 = performance.now();
    function frame(now){
      const p = clamp((now - t0)/dur, 0, 1);
      const v = Math.max(start, Math.floor(start + (final - start) * easeOutCubic(p)));
      el.textContent = fmt(v);
      if (p < 1) requestAnimationFrame(frame);
      else el.textContent = fmt(final);
    }
    requestAnimationFrame(frame);
  }
  const io = "IntersectionObserver" in window ? new IntersectionObserver((ents, obs) => {
    for (const e of ents) if (e.isIntersecting) { animateRollNumber(e.target); obs.unobserve(e.target); }
  }, { threshold: 0.1 }) : null;

  document.querySelectorAll(".fu-rollnum").forEach(n => io ? io.observe(n) : animateRollNumber(n));

  const chatRoot = document.getElementById("chat-log") || document.body;
  const mo = new MutationObserver((muts)=>{
    for (const m of muts) {
      m.addedNodes?.forEach?.(node => {
        if (!(node instanceof HTMLElement)) return;
        node.querySelectorAll?.(".fu-rollnum").forEach(n => io ? io.observe(n) : animateRollNumber(n));
      });
    }
  });
  mo.observe(chatRoot, { childList:true, subtree:true });

  Hooks.on("closeChatMessage", () => { const t=document.getElementById(TT_ID); if (t) t.style.display="none"; });
})();

(async () => {
  // ============ read payload ============
  let AUTO, PAYLOAD;
  if (typeof __AUTO !== "undefined") { AUTO = __AUTO; PAYLOAD = __PAYLOAD ?? {}; }
  else { AUTO = false; PAYLOAD = {}; }

  if (!PAYLOAD || !Object.keys(PAYLOAD).length) {
    return ui.notifications.error("CreateActionCard: Missing __PAYLOAD (call ActionDataFetch first).");
  }

  PAYLOAD.meta = PAYLOAD.meta || {};
  PAYLOAD.core = PAYLOAD.core || {};

  const cacLog  = (...a) => { if (CAC_DEBUG) console.log(CAC_TAG, ...a); };
  const cacWarn = (...a) => { if (CAC_DEBUG) console.warn(CAC_TAG, ...a); };
  const cacErr  = (...a) => { if (CAC_DEBUG) console.error(CAC_TAG, ...a); };

  const passiveGuardExecutionMode = String(
    PAYLOAD?.executionMode ??
    PAYLOAD?.meta?.executionMode ??
    "manual"
  ).trim();

  const isAutoPassiveExecution =
    passiveGuardExecutionMode === "autoPassive" ||
    !!PAYLOAD?.autoPassive ||
    !!PAYLOAD?.meta?.isPassiveExecution ||
    String(PAYLOAD?.source || "") === "AutoPassive";

  if (isAutoPassiveExecution) {
    cacWarn("AUTO PASSIVE reached CreateActionCard unexpectedly. Rerouting to execution core.", {
      skillName: PAYLOAD?.core?.skillName ?? null,
      executionMode: passiveGuardExecutionMode,
      source: PAYLOAD?.source ?? null,
      targets: PAYLOAD?.originalTargetUUIDs ?? PAYLOAD?.meta?.originalTargetUUIDs ?? PAYLOAD?.targets ?? []
    });

    const execApi = globalThis.FUCompanion?.api?.actionExecution?.execute ?? null;
    if (!execApi) {
      ui.notifications?.error("CreateActionCard: Auto Passive reached card creation but Action Execution Core API was not found.");
      return cacErr("AUTO PASSIVE reroute failed: execution core missing.");
    }

    try {
      const rerouteResult = await execApi({
        actionContext: PAYLOAD,
        args: {},
        chatMsgId: null,
        executionMode: "autoPassive",
        confirmingUserId: null,
        skipVisualFeedback: false
      });

      cacLog("AUTO PASSIVE reroute result", rerouteResult);
      return rerouteResult;
    } catch (err) {
      console.error("CreateActionCard: Auto Passive reroute failed:", err);
      ui.notifications?.error("CreateActionCard: Failed to reroute Auto Passive into execution core.");
      return;
    }
  }

  const { core, meta, accuracy, advPayload } = PAYLOAD;
  const {
    attackerName, listType, isSpellish, weaponTypeLabel,
    elementType, declaresHealing, hasDamageSection,
    baseValueStrForCard, hrBonus, attackRange, ignoreHR
  } = meta;
  const { skillName, skillImg, rawEffectHTML, skillTypeRaw, weaponType } = core;

  // ============ canonical saved targets ============
  const cloneArray = (a) => Array.isArray(a) ? a.filter(Boolean).map(String) : [];

  function resolveCanonicalTargetData(payload) {
    const fromTopOriginal = cloneArray(payload?.originalTargetUUIDs);
    if (fromTopOriginal.length) {
      return { uuids: fromTopOriginal, source: "PAYLOAD.originalTargetUUIDs" };
    }

    const fromMetaOriginal = cloneArray(payload?.meta?.originalTargetUUIDs);
    if (fromMetaOriginal.length) {
      return { uuids: fromMetaOriginal, source: "PAYLOAD.meta.originalTargetUUIDs" };
    }

    const fromTopTargets = cloneArray(payload?.targets);
    if (fromTopTargets.length) {
      return { uuids: fromTopTargets, source: "PAYLOAD.targets" };
    }

    // Legacy-only fallback: preserve old passive/older pipeline behavior if no saved targets exist.
    const liveTargets = Array.from(game.user?.targets ?? [])
      .map(t => t?.document?.uuid)
      .filter(Boolean)
      .map(String);

    if (liveTargets.length) {
      return { uuids: liveTargets, source: "game.user.targets (legacy fallback)" };
    }

    return { uuids: [], source: "none" };
  }

  const canonicalTargetData = resolveCanonicalTargetData(PAYLOAD);
  const originalTargetUUIDs = canonicalTargetData.uuids;
  const originalTargetSource = canonicalTargetData.source;

  // Keep payload synchronized so downstream systems / re-renders always see the same targets.
  PAYLOAD.originalTargetUUIDs = [...originalTargetUUIDs];
  PAYLOAD.targets = [...originalTargetUUIDs];
  PAYLOAD.meta.originalTargetUUIDs = [...originalTargetUUIDs];

  const originalTargetActorUUIDs = cloneArray(
    PAYLOAD?.originalTargetActorUUIDs ??
    PAYLOAD?.meta?.originalTargetActorUUIDs ??
    []
  );
  if (originalTargetActorUUIDs.length) {
    PAYLOAD.originalTargetActorUUIDs = [...originalTargetActorUUIDs];
    PAYLOAD.meta.originalTargetActorUUIDs = [...originalTargetActorUUIDs];
  }

  // --- ONI Reaction Phase beacons: action declared / checks / targeting ---
  try {
    if (globalThis.ONI?.emit) {
      const targetsFromPayload = [...originalTargetUUIDs];

      const baseReactionPayload = {
        kind: "action_declaration",
        trigger: null, // filled per-event below
        timestamp: Date.now(),
        // Who is acting
        attackerUuid: meta?.attackerUuid ?? advPayload?.attackerUuid ?? null,
        attackerName: attackerName ?? null,
        // What is being used
        sourceType: meta?.sourceType ?? advPayload?.sourceType ?? null,
        listType: listType ?? null,
        elementType: elementType ?? null,
        skillName: skillName ?? null,
        skillTypeRaw: skillTypeRaw ?? null,
        // Check info
        isCheck: !!accuracy,
        hasAccuracy: !!accuracy,
        // Target info
        targets: targetsFromPayload,
        attackRange: attackRange ?? null
      };

      // 1) Trigger: "When a creature performs a check"
      if (accuracy) {
        ONI.emit(
          "oni:reactionPhase",
          {
            ...baseReactionPayload,
            trigger: "creature_performs_check"
          },
          {
            local: true,
            world: false
          }
        );
      }

      // 2) Trigger: "When a creature gets targeted by an action"
      for (const targetUuid of targetsFromPayload) {
        ONI.emit(
          "oni:reactionPhase",
          {
            ...baseReactionPayload,
            trigger: "creature_is_targeted",
            targetUuid
          },
          {
            local: true,
            world: false
          }
        );
      }
    }
  } catch (err) {
    console.warn("[CreateActionCard] ReactionPhase emit failed (safe to ignore for now):", err);
  }

  // --- Critical Cut-In (unchanged behavior timing) ---
  try {
    const isCritical = !!((accuracy?.isCrit || advPayload?.isCrit) && !(accuracy?.isFumble || advPayload?.isFumble));
    const attackerUuid =
      meta?.attackerUuid ||
      canvas.tokens?.controlled?.[0]?.document?.uuid ||
      game.user?.character?.getActiveTokens?.()?.[0]?.document?.uuid ||
      game.user?.character?.uuid ||
      null;

    let hasCritImage = false;
    if (attackerUuid && isCritical) {
      try {
        const doc = await fromUuid(attackerUuid);
        const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
        const img =
          actor?.system?.cut_in_critical ||
          actor?.flags?.["fabula-ultima-companion"]?.cut_in_critical ||
          actor?.getFlag?.("fabula-ultima-companion", "cut_in_critical");
        hasCritImage = !!(img && String(img).trim().length);
      } catch { /* ignore */ }
    }

    if (isCritical && attackerUuid && window.FUCompanion?.api?.cutinBroadcast) {
      const SUSPENSE_MS = 0;
      const SLIDE_IN_MS = 220;
      const HOLD_MS     = 700;
      const SLIDE_OUT_MS= 550;
      const DIM_ALPHA   = 0.55;
      if (SUSPENSE_MS > 0 && hasCritImage) await new Promise(r => setTimeout(r, SUSPENSE_MS));
      await window.FUCompanion.api.cutinBroadcast({
        tokenUuid: attackerUuid,
        type: "critical",
        delayMs: 0,
        slideInMs: SLIDE_IN_MS,
        holdMs: HOLD_MS,
        slideOutMs: SLIDE_OUT_MS,
        dimAlpha: DIM_ALPHA
      });
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.warn("CreateActionCard: critical cut-in skipped:", err);
  }

  // ============ helpers ============
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
  const cap = (s="") => s ? s[0].toUpperCase()+s.slice(1) : s;
  const WEAPON_ICON = { arcane:"fa-book", bow:"fa-bow-arrow", brawling:"fa-hand-fist", dagger:"fa-dagger", firearm:"fa-gun", flail:"fa-mace", heavy:"fa-hammer-war", spear:"fa-location-arrow", sword:"fa-sword", thrown:"fa-bomb", swords:"fa-swords" };
  const weaponIconHTML = (t) => `<i class="fa-solid ${WEAPON_ICON[(t||"").toLowerCase()] || "fa-sword"}" style="margin-right:.35rem;"></i>`;
  const attrIcon = (a) => {
    const cls = { DEX:"fa-person-running", INS:"fa-book", MIG:"fa-dumbbell", WLP:"fa-comment-dots" }[(a||"").toUpperCase()] || "fa-circle-question";
    return `<i class="fa-solid ${cls}"></i>`;
  };
  const UUID_MAP = {
    range: { "Melee":"JournalEntry.10LjF01NAYNKpRvn", "Ranged":"JournalEntry.Fcq1HgCEh3jxxELa" },
    element: { physical:"Item.XpKZuGo3VmT0TlTu", fire:"Item.0sFCVCoM6FRrQP2f", ice:"Item.Osq3NN3QCtiW7otU", air:"Item.imkMQLnCLaFbaS6Y", earth:"Item.ZyOMe6IkUTlBzfjw", bolt:"Item.5XAuMMbDPlLzhJLw", light:"Item.IQaK3IzvfFp4I1xB", dark:"Item.vKU8UYT6DBhgOjtE", poison:"Item.tDcCWc67Ary9nVxe" }
  };
  const uuidLink = (label, uuid) => uuid ? `<a class="content-link" draggable="true" data-uuid="${uuid}" data-doc-uuid="${uuid}">${esc(label)}</a>` : esc(label);
  const linkRangeLabel = (txt) => { const t=(txt||"").toLowerCase(); if (t.includes("melee")) return uuidLink("Melee", UUID_MAP.range.Melee); if (t.includes("ranged")||t.includes("range")) return uuidLink("Ranged", UUID_MAP.range.Ranged); return esc(txt||"—"); };
  const linkElement = (type) => uuidLink(cap((type||"physical").toLowerCase()), UUID_MAP.element[(type||"physical").toLowerCase()]);

  // === defense targeting resolver (Strike vs Magic) ===
  function fuResolveDefenseTarget(meta) {
    const raw = String(
      meta?.targetDefenseType ??
      meta?.accuracyAgainst ??
      meta?.defenseKind ??
      meta?.defenseType ??
      ""
    ).trim().toLowerCase();

    const isStrike = ["def","defense","strike","phys","physical","guard","armor"].some(x => raw === x);
    const isMagic  = ["mdef","magic_defense","magicdefense","magic","mdf","res","resistance","spirit"].some(x => raw === x);

    if (isStrike) return { kind: "Strike", tip: "Strike (targets DEF)" };
    if (isMagic)  return { kind: "Magic",  tip: "Magic (targets Magic DEF)" };

    if (meta?.isSpellish) return { kind: "Magic", tip: "Magic (targets Magic DEF)" };
    return { kind: "Strike", tip: "Strike (targets DEF)" };
  }

  // ============ title + subtitle ============
  const isNormalAttack = (listType === "Attack") || ((advPayload?.sourceType || "").toLowerCase() === "weapon");
  const displayTitle   = isNormalAttack ? esc(String(skillName||"").replace(/^Attack\s*—\s*/i, "").trim() || "Attack") : esc(skillName);
  const subtitleHTML = (() => {
    if (isNormalAttack) {
      const bullets=[]; const rangeText=linkRangeLabel(attackRange || "—");
      if (rangeText && !rangeText.includes("—")) bullets.push(rangeText);
      const wt=(weaponType || weaponTypeLabel || "").toString().trim();
      if (wt) bullets.push(`${weaponIconHTML(wt)}${esc(cap(wt))}`);
      bullets.push("Normal Attack");
      return `<div style="text-align:center; font-size:12px; color:#6b3e1e; margin:.18rem 0 .25rem;">${bullets.join(" • ")}</div><div style="border-top:1px solid #cfa057; opacity:.6; margin:.2rem auto .35rem; width:96%;"></div>`;
    } else {
      let main=isSpellish?"Spell":"Skill", sub="", subIcon="";
      if (isSpellish && (core.isOffSpell || listType==="Offensive Spell")) { sub="Offensive"; subIcon=`<i class="fa-solid fa-bolt" style="margin-right:.25rem;"></i>`; }
      if (!isSpellish) { const st=(skillTypeRaw||"").toLowerCase(); if (st==="active") sub="Active"; else if (st==="passive") sub="Passive"; else if (st==="other") { sub="Other"; subIcon=`<i class="fa-solid fa-circle-notch" style="margin-right:.25rem;"></i>`; } }
      let wKey="", wLbl="";
      if (isSpellish) { wKey="arcane"; wLbl="Arcane"; }
      else if (weaponType && weaponType.toLowerCase()!=="none") { wKey=weaponType; wLbl=cap(weaponType); }
      const bullets=[]; const rangeText=linkRangeLabel(attackRange || "—");
      if (rangeText && !rangeText.includes("—")) bullets.push(rangeText);
      if (wLbl) bullets.push(`${weaponIconHTML(wKey)}${esc(wLbl)}`);
      bullets.push(esc(main));
      if (sub) bullets.push(`${subIcon}${esc(sub)}`);
      return `<div style="text-align:center; font-size:12px; color:#6b3e1e; margin:.18rem 0 .25rem;">${bullets.join(" • ")}</div><div style="border-top:1px solid #cfa057; opacity:.6; margin:.2rem auto .35rem; width:96%;"></div>`;
    }
  })();

  // ============ targets display (saved target list, not live UI state) ============
  let targetsList = `<i>None (saved target list empty)</i>`;
  if (originalTargetUUIDs.length) {
    const parts = [];
    for (const uuid of originalTargetUUIDs) {
      try {
        const doc = await fromUuid(uuid);
        const tokenDoc = doc?.documentName === "Token" ? doc : doc?.documentName === "TokenDocument" ? doc : doc?.document ?? null;
        const name = tokenDoc?.name ?? doc?.name ?? "Unknown";
        const disp = tokenDoc?.disposition ?? tokenDoc?.document?.disposition ?? null;
        const c = disp === 1 ? "dodgerblue" : disp === -1 ? "tomato" : "khaki";
        parts.push(`<b style="color:${c}">${esc(name)}</b>`);
      } catch {
        parts.push(`<b style="color:khaki">${esc(String(uuid).slice(0, 16))}…</b>`);
      }
    }
    targetsList = parts.join(", ");
  }

  const attackerBox = `
    <fieldset style="border:1px solid #cfa057; border-radius:8px; padding:.5rem;">
      <legend style="padding:0 .5rem; color:#8a4b22;"><b>Attacker</b></legend>
      <div style="display:grid; grid-template-columns:1fr auto 1fr; align-items:center; gap:.4rem; font-size:14px;">
        <div style="justify-self:start;"><b>${attackerName}</b></div>
        <div style="justify-self:center;"><i class="fa-solid fa-swords" style="opacity:.9;"></i></div>
        <div style="justify-self:end; text-align:right;">${targetsList}</div>
      </div>
    </fieldset>`;

  // ============ accuracy (tooltip hosts) ============
  let accuracyHTML = "";
  let floatBannerHTML = "";
  if (accuracy) {
    const { dA,dB,rA,rB,total,hr,isCrit,isBunny,isFumble,A1,A2,checkBonus } = accuracy;

    const tgtInfo = fuResolveDefenseTarget(meta);

    const tipDieA  = `<b>${A1}</b><br>Die: d${dA}<br>Raw: ${rA.result}<br>Result: ${rA.total}`;
    const tipDieB  = `<b>${A2}</b><br>Die: d${dB}<br>Raw: ${rB.result}<br>Result: ${rB.total}`;

    const tipTotal =
      `Targeting: <b>${tgtInfo.tip}</b><br>` +
      `${ignoreHR ? "HR: —" : `HR: ${hr ?? "—"}`}<br>` +
      `A: ${rA.total} (d${dA})<br>` +
      `B: ${rB.total} (d${dB})<br>` +
      `Bonus: ${Number(checkBonus)}<br>` +
      `Total: ${total}` +
      `${isCrit ? `<br><b style="color:#b40000;">Critical!</b>` : ""}` +
      `${isFumble ? `<br><b>Fumble!</b>` : ""}`;

    const accGlow = isCrit ? "rgba(180, 0, 0, .35)" : (isFumble ? "rgba(0, 0, 0, .30)" : "rgba(0, 0, 0, .22)");

    const isMagicKind = (tgtInfo.kind === "Magic");
    const defIconURL  = isMagicKind ? MAGIC_ICON_URL : STRIKE_ICON_URL;
    const iconSizePx  = 25;
    const defIconHTML = `
      <img src="${defIconURL}" alt="${tgtInfo.kind}" title="${tgtInfo.kind}"
           style="width:${iconSizePx}px;height:${iconSizePx}px;object-fit:contain;vertical-align:-3px;border:0;outline:0;box-shadow:none;background:transparent;">`;

    if (isCrit || isFumble) {
      const isF = !!isFumble;
      const text  = isF ? "Fumble!" : "Critical!";
      const icon  = isF ? "fa-skull" : "fa-crown";
      const color = isF ? "#e6e6e6" : "#ffd34d";
      const stroke = isF ? "1.6px rgba(38,38,38,.72)" : "1.6px rgba(90,58,18,.72)";
      const shadow = isF
        ? `0 0 26px rgba(255,255,255,.55),
           0 0 12px rgba(240,240,240,.85),
           0 2px 0 #1f1f1f,
           0 4px 0 #1f1f1f`
        : `0 0 30px rgba(255,207,64,.75),
           0 0 14px rgba(255,207,64,.85),
           0 2px 0 #5a3a12,
           0 4px 0 #5a3a12`;

      floatBannerHTML = `
        <div class="fu-crit-float" aria-hidden="true"
             style="
               position:absolute; right:-10px; bottom:-16px; z-index:7; pointer-events:none;
               background: transparent; transform: translateZ(0);
               font-size: 22px; font-weight:900; font-style:italic; letter-spacing:.6px; text-transform:uppercase;
               color:${color}; text-shadow:${shadow};
               -webkit-text-stroke: ${stroke};
               padding:.25rem .7rem; border-radius:12px;
               animation: fuCritPop .32s ease-out both;
             ">
          <i class="fa-solid ${icon}" style="margin-right:.45rem;"></i> ${text}
        </div>
        <style>
          @keyframes fuCritPop {
            0%   { transform: scale(.80); opacity:0; }
            60%  { transform: scale(1.18); opacity:1; }
            100% { transform: scale(1.02); opacity:1; }
          }
        </style>`;
    }

    accuracyHTML = `
      <div class="fu-acc-wrap" style="position:relative;">
        <fieldset style="border:1px solid #cfa057; border-radius:8px; padding:.5rem;">
          <legend style="padding:0 .5rem; color:#8a4b22;"><b>Accuracy Check</b></legend>
          <div class="fu-acc-row" style="display:flex; align-items:center; gap:.7rem; margin:.15rem 0 .1rem;">
            <span class="fu-tip-host" data-tip="${encodeURIComponent(tipDieA)}" style="display:inline-flex; align-items:center; gap:.35rem;">
              ${attrIcon(A1)} <b>${A1}</b> <b>${rA.total}</b>
            </span>
            <b>+</b>
            <span class="fu-tip-host" data-tip="${encodeURIComponent(tipDieB)}" style="display:inline-flex; align-items:center; gap:.35rem;">
              ${attrIcon(A2)} <b>${A2}</b> <b>${rB.total}</b>
            </span>
            <span style="margin-left:auto; display:inline-flex; align-items:center; gap:.4rem;">
              <span class="fu-tip-host"
                    data-tip="${encodeURIComponent(tipTotal)}"
                    style="display:inline-flex; align-items:center; gap:.35rem; font-weight:900; font-size:22px; margin-right:6px; text-shadow:0 0 6px ${accGlow}; color:#111;">
                ${defIconHTML}
                <span>${total}</span>
              </span>
            </span>
          </div>
        </fieldset>
        ${floatBannerHTML}
      </div>`;
  }

  // ============ damage / healing (tooltip hosts) ============
  let damagePreviewHTML = "";
  if (hasDamageSection) {
    const COLOR = { physical:"#111", fire:"#e25822", ice:"#5ab3d4", air:"#48c774", earth:"#8b5e3c", bolt:"#9b59b6", light:"#a38b50", dark:"#4b0082", poison:"#2e8b57",
                    heal:"#2ecc71", healing:"#2ecc71", recovery:"#2ecc71", restore:"#2ecc71", restoration:"#2ecc71" };
    const GLOW  = { physical:"rgba(0,0,0,.28)", fire:"rgba(226,88,34,.45)", ice:"rgba(90,179,212,.45)", air:"rgba(72,199,116,.45)", earth:"rgba(139,94,60,.45)", bolt:"rgba(155,89,182,.45)",
                    light:"rgba(163,139,80,.45)", dark:"rgba(75,0,130,.45)", poison:"rgba(46,139,87,.45)",
                    heal:"rgba(46,204,113,.48)", healing:"rgba(46,204,113,.48)", recovery:"rgba(46,204,113,.48)", restore:"rgba(46,204,113,.48)", restoration:"rgba(46,204,113,.48)" };

    const elemKey   = String(elementType || "physical").toLowerCase();
    const isMP      = (elemKey === "mp");
    const mpColor   = declaresHealing ? "#1e6cff" : "#c62828";
    const mpGlow    = declaresHealing ? "rgba(30,108,255,.45)" : "rgba(198,40,40,.45)";

    const dmgColor  = isMP ? mpColor : (COLOR[elemKey] || COLOR.physical);
    const glowColor = isMP ? mpGlow  : (GLOW[elemKey]  || GLOW.physical);

    const elemLabelHTML = isMP
      ? `<span style="color:${mpColor}; font-weight:900; letter-spacing:.4px;">MP</span>`
      : `<span class="fu-noicon">${linkElement(elemKey)}</span>`;

    const showHRPill = (!declaresHealing && !ignoreHR && (Number(hrBonus)||0) > 0);
    const hrPill = showHRPill ? `<span style="margin-left:.45rem; font-size:11px; font-weight:800; padding:.05rem .4rem; border-radius:999px; border:1px solid #cfa057; color:#8a4b22; background:#f7ecd9;">+HR</span>` : "";

    const _bonus = Number(advPayload?.bonus ?? 0) || 0;
    const _reduction = Number(advPayload?.reduction ?? 0) || 0;
    const _mult = Number(advPayload?.multiplier ?? 100) || 100;

    const _baseDamage = Number(baseValueStrForCard) || 0;
    const _baseHeal = Number(String(advPayload?.baseValue ?? "0").replace("+", "")) || 0;
    const _base = declaresHealing ? _baseHeal : _baseDamage;

    const finalForCard = Math.max(
      0,
      Math.floor((_base + _bonus - _reduction) * (_mult / 100))
    );

    const tipHTML = `
      <div style='min-width:220px'>
        <b>${declaresHealing ? "Healing Preview" : "Damage Preview"}</b><br>
        Base Value: ${declaresHealing ? (advPayload.baseValue || "+0").toString().replace("+","") : (Number(baseValueStrForCard) - (ignoreHR ? 0 : (Number(hrBonus)||0)))}<br>
        ${declaresHealing ? "HR: —" : (ignoreHR ? "HR: —" : `HR: ${accuracy?.hr ?? "—"}`)}<br>
        Bonus: ${advPayload.bonus}<br>
        Reduction: ${advPayload.reduction}<br>
        Multiplier: ${advPayload.multiplier}%<br>
        Element: ${elementType}<br>
        Weapon: ${weaponType || "—"}<br>
        ${accuracy?.isCrit ? "<b style='color:#ffb3b3;'>Critical</b><br>" : ""}
        ${accuracy?.isFumble ? "<b>Fumble</b><br>" : ""}
        <i>Final result may vary per target defenses.</i>
      </div>`;

    damagePreviewHTML = `
      <fieldset style="border:1px solid #cfa057; border-radius:8px; padding:.6rem;">
        <legend style="padding:0 .5rem; color:#8a4b22;"><b>${declaresHealing ? "Healing" : "Damage"}</b></legend>
        <style>.fu-noicon .content-link::before{content:none !important; margin:0 !important;}</style>
        <div class="fu-dmg-row" style="display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:.5rem;">
          <div style="font-weight:800;">${declaresHealing ? "Heal" : "Damage"}</div>
          <div style="text-align:left;">
            <span class="fu-rollnum fu-tip-host" data-final="${finalForCard}" data-tip="${encodeURIComponent(tipHTML)}"
                  style="font-size:32px; font-weight:900; font-style:italic; color:${dmgColor}; text-shadow:0 0 15px ${glowColor}; margin-left:2.9rem; will-change: contents;">
              ${finalForCard}
            </span>${hrPill}
          </div>
          <div style="justify-self:end; font-size:18px; font-weight:800;">
            ${elemLabelHTML}
          </div>
        </div>
      </fieldset>`;
  }

  // ============ effect (collapsible) ============
  const hasEffect = !!String(rawEffectHTML ?? "").trim();
  const effectHTML = !hasEffect ? "" : `
    <fieldset class="fu-effect" data-collapsed="true"
      style="border:1px solid #cfa057; border-radius:8px; padding:.35rem .5rem; margin-top:.45rem; cursor:pointer; user-select:none;">
      <legend style="padding:0 .5rem; color:#8a4b22;">
        <b>Effect</b>
        <span class="fu-effect-hint" style="opacity:.7; font-size:12px; margin-left:.35rem;">(click to expand)</span>
      </legend>
      <div class="fu-effect-body"
           style="position:relative; overflow:hidden; max-height:0; transition:max-height .25s ease, padding .25s ease; padding:0 .25rem;">
        <div class="fu-effect-inner" style="font-size:13px; line-height:1.35; color:#000; text-shadow:none;">
          ${rawEffectHTML}
        </div>

        <div class="fu-fade" aria-hidden="true"
             style="
               position:absolute; left:0; right:0; bottom:0;
               z-index:1; pointer-events:none; display:none;
               height:32px;
               background:transparent;
             "></div>
      </div>
    </fieldset>`;

  // ============ buttons row ============
  const confirmBtnHTML = `
    <button type="button" class="fu-confirm btn" data-fu-confirm
            data-original-targets="${encodeURIComponent(JSON.stringify(originalTargetUUIDs))}"
            data-fu-args='${esc(JSON.stringify({
              advMacroName: ADV_MACRO_NAME,
              missMacroName: MISS_MACRO_NAME,
              advPayload,
              elementType: (meta?.elementType ?? "physical"),
              isSpellish: !!meta?.isSpellish,

              hasAccuracy: !!accuracy,
              accuracyTotal: (accuracy && Number.isFinite(Number(accuracy.total))) ? Number(accuracy.total) : null,

              autoHit: !!(accuracy?.isCrit || advPayload?.autoHit),

              weaponType: core?.weaponType || "",
              attackRange: meta?.attackRange ?? (meta?.listType?.match(/Range/i) ? "Range" : "Melee"),
              attackerName: meta?.attackerName ?? "Unknown",
              aeMacroName: "ApplyActiveEffect",
              aeDirectives: meta?.activeEffects ?? [],
              attackerUuid: meta?.attackerUuid ?? null,
              originalTargetUUIDs,

              hasDamageSection: !!hasDamageSection
            }))}'
            style="flex:0 0 auto; padding:.35rem .6rem; border-radius:8px; border:1px solid #9a6a2a; background:#e2b86b; color:#4a2a10; font-weight:800;">
       Confirm
    </button>`;

  const invokeTraitBtnHTML = `
    <button type="button" class="fu-btn" data-fu-trait
            title="Invoke Trait (reroll up to two accuracy dice)"
            style="flex:0 0 auto; padding:.35rem .6rem; border-radius:8px; border:1px solid #cfa057; background:#f7ecd9; color:#8a4b22; font-weight:700;">
      🎭 Invoke Trait
    </button>`;

  const invokeBondBtnHTML = `
    <button type="button" class="fu-btn" data-fu-bond
            title="Invoke Bond (add your Bond bonus)"
            style="flex:0 0 auto; padding:.35rem .6rem; border-radius:8px; border:1px solid #cfa057; background:#f7ecd9; color:#8a4b22; font-weight:700;">
      🤝 Invoke Bond
    </button>`;

  // ============ card HTML ============
  const titleIconHTML = skillImg ? `<img src="${skillImg}" alt="" style="width:28px;height:28px; object-fit:cover; border-radius:4px; box-shadow: 0 1px 0 rgba(0,0,0,.2), inset 0 0 0 1px rgba(0,0,0,.25); margin-right:.35rem; vertical-align:-3px;">` : "";
  const editBtnHTML = `
    <button type="button" data-fu-edit data-gm-only
            title="Edit Action Card"
            style="
              display:inline-flex; align-items:center; justify-content:center;
              width:28px; height:28px; padding:0; margin:0;
              border-radius:6px; border:1px solid rgba(207,160,87,.9);
              background:rgba(247,236,217,.85);
              box-shadow: 0 1px 0 rgba(0,0,0,.18);
              cursor:pointer; user-select:none;
              font-size:16px; line-height:1;
            ">✏️</button>`;

  const cardHTML = `
    <div class="fu-card" style="font-family: Signika, sans-serif; letter-spacing:.2px; position:relative; overflow:hidden; border-radius:10px;">
      <div class="fu-body">
        <h1 style="font-family: Signika, sans-serif; letter-spacing:.5px; color:#8a4b22; text-align:center; border-bottom:3px solid #cfa057; padding-bottom:.15rem; margin:.25rem 0 .1rem;">
          <span style="display:inline-flex; align-items:center; gap:.35rem;">
            ${editBtnHTML}
            ${titleIconHTML}
            <span>${displayTitle}</span>
          </span>
        </h1>
        <div style="text-align:center; font-size:12px; color:#6b3e1e; margin:.18rem 0 .25rem;">${subtitleHTML ? subtitleHTML : ""}</div>
        ${attackerBox}
        ${accuracyHTML}
        ${damagePreviewHTML}
        ${effectHTML}
        <div class="fu-btns" style="display:flex; align-items:center; gap:.5rem; margin-top:.5rem; flex-wrap:wrap;">
          ${confirmBtnHTML}
          ${invokeTraitBtnHTML}
          ${invokeBondBtnHTML}
        </div>
        <div style="margin-top:.35rem; opacity:.7; font-size:12px;">
          This card will apply to the <b>original targets saved on creation</b>.
        </div>
      </div>
    </div>`;

  // ============ post & after-post light wiring ============
  const speaker = ChatMessage.getSpeaker();
  const posted  = await ChatMessage.create({ user: game.userId, speaker, content: cardHTML });

  Hooks.on("renderChatMessage", async function fuCardInit(chatMsg, htmlEl) {
    if (chatMsg.id !== posted.id) return;

    const root = htmlEl?.[0];
    if (!root) return;

    if (root.dataset.fuPrepped === "1") return;
    root.dataset.fuPrepped = "1";

    if (!game.user?.isGM) {
      root.querySelectorAll("[data-gm-only]").forEach(el => { el.style.display = "none"; });
    }

    const confirmBtn = root.querySelector("[data-fu-confirm]");
    if (confirmBtn?.dataset?.fuArgs) {
      try {
        const cur = JSON.parse(confirmBtn.dataset.fuArgs);
        cur.chatMsgId = chatMsg.id;
        confirmBtn.dataset.fuArgs = JSON.stringify(cur);
      } catch {}
    }

    // --- INIT: Half-open preview for this card's Effect body ---
    try {
      const eff   = root.querySelector(".fu-effect");
      const body  = eff?.querySelector(".fu-effect-body");
      const inner = eff?.querySelector(".fu-effect-inner");
      const hint  = eff?.querySelector(".fu-effect-hint");
      const fade  = eff?.querySelector(".fu-fade");
      if (!eff || !body || !inner || !fade) throw new Error("Effect DOM missing");

      const PREVIEW_LINES = 8;
      const cs = getComputedStyle(inner);
      const lineH = parseFloat(cs.lineHeight) || 16;
      const padT  = parseFloat(cs.paddingTop) || 0;
      const padB  = parseFloat(cs.paddingBottom) || 0;
      const previewPx = Math.round(lineH * PREVIEW_LINES + padT + padB);

      const msgContent = root.querySelector(".message-content") || root;
      let bg = getComputedStyle(msgContent).backgroundColor || "rgb(217, 215, 203)";
      if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent") bg = "rgb(217, 215, 203)";

      const toRgba = (alpha) => {
        const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/i);
        if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
        const hex = bg.match(/^#([0-9a-f]{6})$/i);
        if (hex) {
          const r = parseInt(hex[1].slice(0,2),16),
                g = parseInt(hex[1].slice(2,4),16),
                b = parseInt(hex[1].slice(4,6),16);
          return `rgba(${r},${g},${b},${alpha})`;
        }
        return `rgba(217,215,203,${alpha})`;
      };

      const fadeOverlay = `linear-gradient(to bottom,
        ${toRgba(0)} 0%,
        ${toRgba(0.85)} 65%,
        ${toRgba(1)} 100%)`;
      const fadeHeight = Math.round(lineH * 2);

      eff.dataset.collapsed = "true";
      body.style.maxHeight = `${previewPx}px`;
      body.style.paddingTop = "0";
      body.style.paddingBottom = "0";
      body.classList.add("preview");
      body.dataset.previewPx = String(previewPx);

      fade.style.display = "block";
      fade.style.height = `${fadeHeight}px`;
      fade.style.background = fadeOverlay;

      if (hint) hint.textContent = "(click to expand)";
    } catch (e) {
      console.warn("Effect preview init failed:", e);
    }

    // --- Persist payload WITHOUT re-rendering the message ---
    try {
      await chatMsg.update(
        { [`flags.${MODULE_NS}.actionCard`]: { payload: PAYLOAD } },
        { render: false }
      );
    } catch (e1) {
      try { await chatMsg.setFlag(MODULE_NS, "actionCard", { payload: PAYLOAD }); } catch (e2) {}
    }
  });

  cacLog("Posted with canonical targets:", {
    count: originalTargetUUIDs.length,
    source: originalTargetSource,
    targets: originalTargetUUIDs
  });
})();
