// scripts/create-damage-card.js
// ──────────────────────────────────────────────────────────
//  Create Damage Card (module version, speakerless) · V12
//  Exposes: game.modules.get('fabula-ultima-companion')?.api.createDamageCard(payload)
//  Change: Speakerless now works for ALL clients via a persistent render hook
// ──────────────────────────────────────────────────────────

(function initFUCreateDamageCard() {
  // Global namespace
  window.FUCompanion = window.FUCompanion || {};

  // ------------------------- helpers -------------------------
  const S = (v, d="(None)") => { try { const s=(v??"").toString().trim(); return s.length?s:d; } catch { return d; } };
  const N = (v, d=0) => { const n=Number(v); return Number.isFinite(n)?n:d; };
  const FALLBACK_IMG = "icons/svg/mystery-man.svg";
  const CARD_MARKER  = "fu-damage-card";    // <— unique marker we’ll detect in render hook

  async function tokenImgFromUuid(uuid) {
    try {
      if (!uuid) return FALLBACK_IMG;
      const doc = await fromUuid(uuid);
      const tok = doc?.isToken ? doc : (doc?.token ?? doc);
      return tok?.texture?.src || tok?.document?.texture?.src || tok?.img || tok?.actor?.img || FALLBACK_IMG;
    } catch { return FALLBACK_IMG; }
  }
  async function guessAttackerByName(name) {
    const t = canvas?.tokens?.placeables?.find(t => (t.actor?.name || t.name) === name);
    return t?.document?.uuid ?? "";
  }

  // ------------------ PERSISTENT RENDER HOOK ------------------
  // Runs for every message on every client; only acts on our cards.
  Hooks.on("renderChatMessage", (_msg, htmlJQ) => {
    const root = htmlJQ?.[0];
    if (!root) return;

    // Only proceed if this message contains our card marker
    const marker = root.querySelector(`[data-fu-card="${CARD_MARKER}"]`);
    if (!marker) return;

    try {
      // 1) Speakerless: remove the message header everywhere
      const header = root.querySelector(".message-header");
      if (header) header.remove();
      const content = root.querySelector(".message-content");
      if (content) { content.style.marginTop = "0"; content.style.paddingTop = "0"; }

      // 2) Interactivity (toggle details + resize keep-open)
      const shell   = root.querySelector(".fu-shell");
      const details = root.querySelector(".fu-details");
      const rollEl  = root.querySelector(".fu-rollnum"); // absent on immune/miss

      if (!shell || !details) return;

      const setOpen = (open) => {
        shell.dataset.open = open ? "true" : "false";
        if (open) {
          const full = details.scrollHeight;
          details.style.maxHeight = full + "px";
          details.style.paddingTop = ".35rem";
          details.style.paddingBottom = ".35rem";
        } else {
          details.style.maxHeight = "0px";
          details.style.paddingTop = "0";
          details.style.paddingBottom = "0";
        }
      };
      setOpen(false);

      root.addEventListener("click", (ev) => {
        const inShell = ev.target.closest(".fu-shell");
        if (!inShell) return;
        if (ev.target.closest("a, button")) return;
        setOpen(shell.dataset.open !== "true");
      });

      if ("ResizeObserver" in window) {
        const ro = new ResizeObserver(() => {
          if (shell.dataset.open === "true") {
            details.style.maxHeight = details.scrollHeight + "px";
          }
        });
        ro.observe(details);
      }

      // 3) Number roll-up (skips on immune/miss and prefers-reduced-motion)
      if (rollEl) {
        const final = Math.max(0, Number(rollEl.dataset.final || 0));
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        const fmt = (n)=> n.toLocaleString?.() ?? String(n);
        if (reduce || !final) { rollEl.textContent = fmt(final); }
        else {
          let started = false;
          const dur = 800;
          const startVal = 1;
          const run = () => {
            if (started) return; started = true;
            const t0 = performance.now();
            const frame = (now) => {
              const p = Math.min(1, (now - t0) / dur);
              const curr = Math.max(startVal, Math.floor(startVal + (final - startVal) * (1 - Math.pow(1 - p, 3)) ));
              rollEl.textContent = fmt(curr);
              if (p < 1) requestAnimationFrame(frame);
              else rollEl.textContent = fmt(final);
            };
            requestAnimationFrame(frame);
          };
          if ("IntersectionObserver" in window) {
            const io = new IntersectionObserver((entries, obs) => {
              for (const e of entries) if (e.isIntersecting) { run(); obs.unobserve(e.target); }
            }, { root: document, rootMargin: "0px", threshold: 0.1 });
            io.observe(rollEl);
          } else {
            run();
          }
        }
      }
    } catch (e) {
      console.warn("[FU CreateDamageCard] render hook error:", e);
    }
  });

  // --------------------- CARD CREATION ---------------------
  async function createDamageCard(P_in) {
    const P = P_in ?? {};

    // Parse payload (unchanged)
    const attackerName  = S(P.attackerName, "System");
    const attackerUuid  = S(P.attackerUuid, "");
    const attackRange   = S(P.attackRange, "(None)");
    const sourceType    = S(P.sourceType , "(None)");
    const targetName    = S(P.targetName , "Unknown Target");
    const targetUuid    = S(P.targetUuid , "");

    const valueType     = S(P.valueType, "hp");
    const changeKey     = S(P.changeKey, "hpReduction");
    const elementType   = S(P.elementType, "elementless");
    const weaponType    = S(P.weaponType, "none_ef");

    const affinityCode  = S(P.affinityCode, "NE");
    const effLabel      = S(P.effectivenessLabel, "Neutral");

    const baseValue     = N(P.baseValue, 0);
    const finalValue    = N(P.finalValue, baseValue);
    let   shownAmount   = N(P.displayedAmount, Math.abs(finalValue || baseValue));
    if (!Number.isFinite(shownAmount) || shownAmount < 0) shownAmount = 0;

    const shieldBreak   = !!P.shieldBreak;
    const affected      = (typeof P.affected === "boolean") ? P.affected : true;
    const noEffectReason= P.noEffectReason ?? null;

    const modeMiss = String(P.mode || "").toLowerCase() === "miss" || (!!P.miss);
    const isMiss   = modeMiss || (P.affected === false && String(P.noEffectReason||"").toLowerCase() === "miss");

    // Images
    const targetImg   = await tokenImgFromUuid(targetUuid);
    const attackerId  = attackerUuid || await guessAttackerByName(attackerName);
    const attackerImg = await tokenImgFromUuid(attackerId);

    // Colors
    const COLOR = {
      physical:"#111111", fire:"#e25822", ice:"#5ab3d4", air:"#48c774",
      earth:"#8b5e3c", bolt:"#9b59b6", light:"#a38b50", dark:"#4b0082",
      poison:"#2e8b57", mp:"#2e7bd6", shield:"#888888", heal:"#2ecc71"
    };
    const GLOW = {
      physical:"rgba(0,0,0,.28)", fire:"rgba(226,88,34,.45)", ice:"rgba(90,179,212,.45)",
      air:"rgba(72,199,116,.45)", earth:"rgba(139,94,60,.45)", bolt:"rgba(155,89,182,.45)",
      light:"rgba(163,139,80,.45)", dark:"rgba(75,0,130,.45)", poison:"rgba(46,139,87,.45)",
      mp:"rgba(46,124,214,.45)", shield:"rgba(136,136,136,.40)", heal:"rgba(46,204,113,.48)"
    };
    const COLOR_MISS = "#777777";
    const GLOW_MISS  = "rgba(0,0,0,.10)";

    const isRecovery  = changeKey.endsWith("Recovery");
    const elemKey     = (valueType === "hp" ? elementType : (valueType === "mp" ? "mp" : "shield")).toLowerCase();
    const elemNice    = (valueType === "hp" && elementType !== "elementless")
                          ? elementType.charAt(0).toUpperCase() + elementType.slice(1)
                          : (valueType === "mp" ? "Mind" : valueType === "shield" ? "Shield" : "Damage");
    const colorKey    = (valueType === "hp") ? (isRecovery ? "heal" : (COLOR[elemKey] ? elemKey : "physical"))
                                           : (valueType === "mp" ? "mp" : "shield");

    const dmgColor    = isMiss ? COLOR_MISS : COLOR[colorKey];
    const glowColor   = isMiss ? GLOW_MISS  : GLOW[colorKey];

    const wpnKey      = (weaponType || "").split("_")[0];
    const wpnNice     = wpnKey && wpnKey !== "none" ? (wpnKey[0].toUpperCase()+wpnKey.slice(1)) : "(None)";
    const effTag      = effLabel && effLabel !== "Neutral" ? `<span style="font-weight:800;">${effLabel}</span>` : "Neutral";

    const isImmune =
      /immune/i.test(effLabel) ||
      /^(im|imm|immune)$/i.test(affinityCode) ||
      (affected === false && /immune/i.test(String(noEffectReason || "")));

    const isSuper     = !isImmune && ( /vuln|weak|super/i.test(effLabel) || /^(v|vu|wk|se)$/i.test(affinityCode) );
    const isResisted  = !isImmune && ( /resist|half/i.test(effLabel)     || /^(re|rs|rh)$/i.test(affinityCode)   );

    const numberHTML = isImmune
      ? `<span class="fu-immune" style="font-size:28px;font-weight:900;letter-spacing:.5px;color:#777;text-transform:uppercase;text-shadow:0 0 8px rgba(0,0,0,.06);">IMMUNE</span>`
      : (isMiss
        ? `<span class="fu-miss-text" style="font-size:38px;font-weight:900;letter-spacing:.5px;color:${COLOR_MISS};text-shadow:0 0 18px ${GLOW_MISS},0 0 8px ${GLOW_MISS};text-transform:uppercase;line-height:1;">MISS</span>`
        : `<span class="fu-rollnum" data-final="${Math.max(0, Math.abs(shownAmount))}" style="font-size:42px;font-weight:900;font-style:italic;line-height:1;color:${dmgColor};text-shadow:0 0 18px ${glowColor},0 0 8px ${glowColor};will-change:contents;">${Math.max(0, Math.abs(shownAmount))}</span>`
      );

    const typeHTML = isMiss ? "" : `
      <div style="font-size:12px;font-weight:800;text-transform:uppercase;opacity:.9;color:#333;text-align:right;">
        ${isRecovery ? "HEAL" : elemNice}
      </div>
    `;

    const compactRow = `
      <div class="fu-compact" style="position:relative;display:grid;grid-template-columns:1fr auto;align-items:center;gap:.6rem;min-height:56px;">
        <img src="${targetImg}" alt=""
             style="position:absolute;left:-14px;top:50%;transform:translateY(-55%);width:72px;height:72px;object-fit:contain;border:none;box-shadow:none;pointer-events:none;z-index:1;opacity:.98;">
        <div class="fu-right" style="margin-left:58px;display:flex;align-items:baseline;justify-content:flex-end;gap:.6rem;position:relative;z-index:2;">
          ${shieldBreak ? `<span style="color:#ff3838;font-weight:900;">BREAK!</span>` : ``}
          ${numberHTML}
        </div>
        ${typeHTML}
      </div>
    `;

    const baseLine = `${Math.abs(baseValue)}`;
    const detailRows = `
      <div class="fu-actors" style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:.4rem;margin-bottom:.35rem;">
        <div style="justify-self:end;"><img src="${attackerImg}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:6px;box-shadow:0 0 0 1px rgba(0,0,0,.25);"></div>
        <div style="justify-self:center;font-size:18px;opacity:.85;"><i class="fa-solid fa-swords"></i></div>
        <div style="justify-self:start;"><img src="${targetImg}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:6px;box-shadow:0 0 0 1px rgba(0,0,0,.25);"></div>
      </div>

      <div style="display:grid;grid-template-columns:160px 1fr;row-gap:.25rem;column-gap:.6rem;font-size:13px;">
        <div style="opacity:.8;">Attacker</div><div><b>${attackerName}</b></div>
        <div style="opacity:.8;">Target</div><div><b>${targetName}</b></div>
        <div style="opacity:.8;">Weapon Type</div><div>${wpnNice}</div>
        <div style="opacity:.8;">Base Damage</div><div>${baseLine}</div>
        <div style="opacity:.8;">Affinity</div><div>${effTag}</div>
        <div style="opacity:.8;">Range</div><div>${attackRange}</div>
        <div style="opacity:.8;">Source</div><div>${sourceType}</div>
      </div>
    `;

    let fxBadgeHTML = "";
    if (valueType === "hp" && !isRecovery && !isImmune && (isSuper || isResisted)) {
      const text = isSuper ? "Super Effective!" : "Resisted";
      const pill = isSuper
        ? { bg:"#f7ecd9", border:"#cfa057", color:"#8a4b22" }
        : { bg:"#eee",     border:"#999",    color:"#333" };
      fxBadgeHTML = `
        <div class="fu-fx-badge" aria-hidden="true" style="position:absolute;right:-6px;bottom:-10px;z-index:5;pointer-events:none;background:${pill.bg};color:${pill.color};border:1px solid ${pill.border};border-radius:999px;padding:.1rem .45rem;font-weight:800;font-size:11px;letter-spacing:.2px;box-shadow:0 2px 6px rgba(0,0,0,.14),0 1px 0 rgba(255,255,255,.6) inset;transform:translateZ(0);white-space:nowrap;">
          ${text}
        </div>
      `;
    }

    const srAlt = isImmune
      ? `${targetName}: Immune.`
      : (isMiss
          ? `${targetName} dodged the attack!`
          : (affected
              ? `${targetName}: ${Math.abs(shownAmount)} ${isRecovery ? "healing" : elemNice}.`
              : `No effect on ${targetName}${noEffectReason ? ` (${noEffectReason})` : ""}.`));

    // Add the data-fu-card marker so every client can detect this card
    const cardHTML = `
      <div class="fu-card" data-fu-card="${CARD_MARKER}" style="font-family: Signika, sans-serif; letter-spacing:.2px;">
        <div class="fu-shell" data-open="false"
             style="border:1px solid #cfa057;background:#faf3e4;border-radius:10px;padding:.55rem .65rem;position:relative;overflow:visible;cursor:pointer;">
          <span class="sr-only" style="position:absolute;left:-9999px;top:auto;">${srAlt}</span>
          ${compactRow}
          ${fxBadgeHTML}
          <div class="fu-details" style="max-height:0;overflow:hidden;transition:max-height .22s ease, padding .22s ease;padding:0 .25rem;">
            <div style="border-top:1px dashed #cfa057;opacity:.6;margin:.45rem 0;"></div>
            ${detailRows}
            <div style="height:.25rem;"></div>
          </div>
        </div>
      </div>
    `;

    // Post message (empty alias so there’s never a name even if header stays for some reason)
    const speaker = { alias: "" };
    await ChatMessage.create({
      user: game.userId,
      speaker,
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      content: cardHTML
    });
  }

  // Expose API
  FUCompanion.createDamageCard = createDamageCard;
  Hooks.once("ready", () => {
    const mod = game.modules.get("fabula-ultima-companion");
    if (mod) {
      mod.api = mod.api || {};
      mod.api.createDamageCard = createDamageCard;
    }
  });
})();
