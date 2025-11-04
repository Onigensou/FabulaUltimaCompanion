// fu-chatbtn.js — Foundry VTT v12
// Global delegated listener for chat-card buttons using [data-fu-apply].
// Executes AdvanceDamage (and Miss) on GM click, regardless of who posted.

const MODULE_ID = "fu-chatbtn";

Hooks.once("ready", async () => {
  
  // In scripts/applyDamage-button.js — replace the non-GM CSS block with:
if (!game.user?.isGM) {
  const style = document.createElement("style");
  style.id = "fu-chatbtn-hide-player-buttons";
  style.textContent = `
    /* Players should NOT see/press Apply or any dismiss button,
       but SHOULD see Invoke Trait/Bond */
    [data-fu-apply],
    [data-action="dismiss"] {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

  
  const root = document.querySelector("#chat-log") || document.body;
  if (!root) return;

  if (root.__fuChatBtnBound) return;
  root.__fuChatBtnBound = true;

  root.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.("[data-fu-apply]");
    if (!btn) return;

    // Only GMs can Apply
    if (!game.user?.isGM) {
      ui.notifications?.warn("Only the GM can press Apply.");
      return;
    }

    // Double-click guard
    if (btn.dataset.fuLock === "1") return;
    btn.dataset.fuLock = "1";

    // Try to read attached ChatMessage
    const msgEl = btn.closest?.(".message");
    const msgId = msgEl?.dataset?.messageId;
    const chatMsg = msgId ? game.messages.get(msgId) : null;

    // Parse embedded args from the card
    let args = {};
    try { args = btn.dataset.fuArgs ? JSON.parse(btn.dataset.fuArgs) : {}; }
    catch { args = {}; }

    // Fill missing fields (like attackerUuid) from the card’s stored payload
const flagged = chatMsg?.getFlag("fabula-ultima-companion", "actionCard")?.payload ?? null;
if (flagged) {
  // If the dataset JSON is missing these fields, borrow from the flag payload
  if (!args.attackerUuid && flagged.meta?.attackerUuid) args.attackerUuid = flagged.meta.attackerUuid;
  if ((!args.aeDirectives || !args.aeDirectives.length) && Array.isArray(flagged.meta?.activeEffects)) {
    args.aeDirectives = flagged.meta.activeEffects;
  }
}

    async function spendResourcesOnApply(flaggedPayload) {
  try {
    const meta = flaggedPayload?.meta ?? null;
    const costs = meta?.costsNormalized;
    const attackerUuid = meta?.attackerUuid;
    if (!attackerUuid || !Array.isArray(costs) || !costs.length) return true; // nothing to spend

    const doc = await fromUuid(attackerUuid).catch(()=>null);
    const actor = doc?.actor ?? (doc?.documentName === "Actor" ? doc : null);
    if (!actor) { ui.notifications?.error("Apply: cannot resolve attacker to spend resource."); return false; }

    const patch = {};
    for (const c of costs) {
      const curPath = `system.props.${c.curKey}`;
      const curVal = Number(getProperty(actor, curPath) ?? 0) || 0;
      const next = Math.max(0, curVal - Number(c.req || 0));
      patch[curPath] = next;
    }
    if (Object.keys(patch).length) await actor.update(patch);
    return true;
  } catch (e) {
    console.error("[fu-chatbtn] Spend failed:", e);
    ui.notifications?.error("Apply: resource spend failed (see console).");
    return false;
  }
}

const {
  advMacroName     = "AdvanceDamage",
  missMacroName    = "Miss",
  advPayload       = {},
  elementType      = "physical",
  isSpellish       = false,

  // NEW:
  hasAccuracy      = true,          // default true to preserve old cards’ behavior
  accuracyTotal    = null,          // null means “no check/auto-hit”

  weaponType       = "",
  attackRange      = "Melee",
  attackerName     = "Unknown",
  aeMacroName      = "ApplyActiveEffect",
  aeDirectives     = [],
  attackerUuid     = null,
  originalTargetUUIDs = [],
  chatMsgId        = msgId
} = args;

// Spend resources now (on confirm). If it fails, stop.
const okToProceed = await spendResourcesOnApply(flagged ? flagged : null);
if (!okToProceed) { btn.dataset.fuLock = "0"; return; }

    // ──────────────────────────────────────────────────────────
// NAMECARD TRIGGER — show only for Skill / Spell / Passive
// (BEGIN BLOCK)
try {
  const payload = flagged || null;
  const core  = payload?.core || {};
  const meta  = payload?.meta || {};

  // 1) Eligibility (skip normal weapon Attacks)
  const listType = String(meta.listType || "").trim();
  const skillTypeRaw = String(core.skillTypeRaw || "").trim().toLowerCase();
  const sourceTypeRaw = String(advPayload?.sourceType || "").trim().toLowerCase();

  const isAttackish = (listType === "Attack") || (sourceTypeRaw === "weapon");
  const isSpellish  = !!meta.isSpellish;
  const isActive    = (listType === "Active");
  const isPassive   = (skillTypeRaw === "passive");  // you asked to allow Passive, too

  const shouldShow = !isAttackish && (isSpellish || isActive || isPassive);

  if (shouldShow) {
    // 2) Title
    let title = String(core.skillName || "—");

    // 3) Action type → emoji preset from demo
    let actionType = "skill";
    if (isSpellish && (listType === "Offensive Spell")) actionType = "offensiveSpell";
    else if (isSpellish) actionType = "spell";
    else if (isPassive)  actionType = "passive";
    // (we never treat it as "attack" here, since we skip attacks)

    // 4) Palette by disposition (attacker)
    let disp = 0;
    try {
      const aUuid = args.attackerUuid || meta.attackerUuid || null;
      if (aUuid) {
        const doc = await fromUuid(aUuid);
        const tok = (doc?.documentName === "Token") ? doc : (doc?.token ?? null);
        disp = Number(tok?.disposition ?? 0);
      }
    } catch {}

    // simple themes: hostile=tomato-ish, friendly=blue-ish, neutral=gold-ish
    const THEMES = {
      hostile: { bg: "#000000", accent: "#d98c6f", text: ["#fff","#ffd1b3"], glowColor: "#ffffff" },
      friendly:{ bg: "#000000", accent: "#7fb5ff", text: ["#fff","#d7e9ff"], glowColor: "#ffffff" },
      neutral: { bg: "#000000", accent: "#d9b56f", text: ["#fff","#ffe7b0"], glowColor: "#ffffff" }
    };
    const theme = (disp === -1) ? THEMES.hostile : (disp === 1 ? THEMES.friendly : THEMES.neutral);

    // 5) Options (safe defaults matching your demo vibe)
    const options = {
      actionType,
      xAlign: "center",
      offsetX: 0,
      offsetY: 12,
      fixedWidth: 640,
      autoWidth: false,
      cardScale: 0.95,
      inMs: 320,
      holdMs: 1400,
      outMs: 360,
      enterFrom: "up",

      plateOpacity: 0.55,
      bg: theme.bg,
      accent: theme.accent,
      text: theme.text,
      glowColor: theme.glowColor,
      border: "rgba(255,255,255,.10)",
      dropShadow: "0 10px 22px rgba(0,0,0,.35)",
      maskEdges: true,
      edgeFade: 0.12,

      // text stylings
      maxFontPx: 30,
      minFontPx: 16,
      letterSpacing: 0.06,
      fontWeight: 900,
      fontFamily: "Pixel Operator, system-ui, sans-serif",
      textStrokePx: 0.1,
      textStrokeColor: "rgba(0,0,0,0.55)",
      showIcon: true,
      iconScale: 0.93,
      iconGapPx: 10
    };

    // 6) Fire broadcast (multi-client)
    await window.FUCompanion?.api?.namecardBroadcast?.({ title, options });
  }
} catch (e) {
  console.warn("[fu-chatbtn] NameCard skipped:", e);
}
// (END BLOCK)
// ──────────────────────────────────────────────────────────
    
    try {
      // UI feedback
      btn.disabled = true;
      btn.textContent = "Applied ✔";
      btn.style.filter = "grayscale(1)";

      const stamp = msgEl?.querySelector?.("[data-fu-stamp]");
      if (stamp) {
        stamp.textContent = `Applied by GM: ${game.user.name}`;
        stamp.style.opacity = ".9";
      }

      const adv  = game.macros.getName(advMacroName);
      const miss = game.macros.getName(missMacroName);
      const ae   = game.macros.getName(aeMacroName);
      if (!adv) {
        ui.notifications?.error(`Advanced Damage macro "${advMacroName}" not found or no permission.`);
        throw new Error("AdvanceDamage not found");
      }

      // Sanity check targets
      const savedUUIDs = Array.isArray(originalTargetUUIDs) ? originalTargetUUIDs : [];
      if (!savedUUIDs.length) {
        ui.notifications?.warn("No saved targets on this card.");
        return;
      }

      // Utility: defense reader (prefers new keys; avoids *_mod)
      const numberish = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
      function readDefenseLike(props, preferMagic=false) {
        const p = props ?? {};
        const hard = preferMagic
          ? ["magic_defense", "current_mdef", "mdef"]
          : ["defense",       "current_def",  "def"];
        for (const k of hard) {
          const n = numberish(p[k]); if (n !== null) return n;
        }
        const isBanned = (k) => /(^|_)mod($|_)/i.test(k);
        const keys = Object.keys(p);
        const rePhys = /(^|_)(current_)?(def|guard|armor)($|_)/i;
        const reMag  = /(^|_)(current_)?(m(def|agic.*def)|magic.*resist|spirit)($|_)/i;
        const rx = preferMagic ? reMag : rePhys;
        for (const k of keys) {
          if (isBanned(k)) continue;
          const n = numberish(p[k]); if (n === null) continue;
          if (rx.test(k)) return n;
        }
        return 0;
      }
      async function defenseForUuid(uuid, useMagic) {
        try {
          const d = await fromUuid(uuid);
          const a = d?.actor ?? (d?.type === "Actor" ? d : null);
          const props = a?.system?.props ?? a?.system ?? {};
          return readDefenseLike(props, useMagic);
        } catch { return 0; }
      }

      const elemKey   = String(elementType || "physical").toLowerCase();
const isHealing = /^(heal|healing|recovery|restore|restoration)$/i.test(elemKey);

// NEW: respect No-Check (auto-hit) by skipping accuracy compare entirely
const accTotal  = hasAccuracy ? Number(accuracyTotal) : NaN;

const missUUIDs = [];
const hitUUIDs  = [];

if (!isHealing && hasAccuracy) {
  // There WAS an accuracy check → compare vs defense per target
  for (const u of savedUUIDs) {
    const usedDefense = await defenseForUuid(u, !!isSpellish);
    const willMiss    = Number.isFinite(usedDefense) && Number.isFinite(accTotal) && accTotal < usedDefense;
    if (willMiss) missUUIDs.push(u); else hitUUIDs.push(u);
  }
} else {
  // Healing OR No-Check → auto-hit all saved targets
  hitUUIDs.push(...savedUUIDs);
}

      const prevTargets = Array.from(game.user?.targets ?? []).map(t => t.id);

      // Active Effects: On Attack (all saved targets, regardless of hit/miss)
      if (ae && aeDirectives.length && savedUUIDs.length) {
        await ae.execute({
          __AUTO: true,
          __PAYLOAD: {
            directives : aeDirectives,
            attackerUuid,
            targetUUIDs: savedUUIDs,
            trigger    : "on_attack",
            accTotal   : accTotal,
            isSpellish : !!isSpellish,
            weaponType
          }
        });
      }

      // Fire Miss for the “missUUIDs” subset
      if (missUUIDs.length && miss) {
        const missIds = (await Promise.all(missUUIDs.map(async u => {
          const d = await fromUuid(u).catch(()=>null);
          return d?.id ?? d?.document?.id ?? null;
        }))).filter(Boolean);

        if (missIds.length) {
          await game.user.updateTokenTargets(missIds, { releaseOthers: true });
          await miss.execute({
            __AUTO: true,
            __PAYLOAD: {
              attackerName,
              elementType: elemKey,
              isSpellish: !!isSpellish,
              weaponType,
              attackRange,
              accuracyTotal: accTotal
            }
          });
        }
      }

      // Fire AdvanceDamage for the “hitUUIDs” subset
      if (hitUUIDs.length) {
        const hitIds = (await Promise.all(hitUUIDs.map(async u => {
          const d = await fromUuid(u).catch(()=>null);
          return d?.id ?? d?.document?.id ?? null;
        }))).filter(Boolean);

        if (hitIds.length) {
          await game.user.updateTokenTargets(hitIds, { releaseOthers: true });
       // Active Effects: On Hit (only the targets that were actually hit)
          if (ae && aeDirectives.length && hitUUIDs.length) {
            await ae.execute({
              __AUTO: true,
              __PAYLOAD: {
                directives : aeDirectives,
                attackerUuid,
                targetUUIDs: hitUUIDs,
                trigger    : "on_hit",
                accTotal   : accTotal,
                isSpellish : !!isSpellish,
                weaponType
              }
            });
          }
          await adv.execute({ __AUTO: true, __PAYLOAD: advPayload });
        }
      }

      // Restore prior targets
      await game.user.updateTokenTargets(prevTargets, { releaseOthers: true });

      console.log(`[${MODULE_ID}] Apply executed by GM:`, { chatMsgId, savedUUIDs, missUUIDs, hitUUIDs });
      ui.notifications?.info(`Applied by GM: ${game.user.name}`);
    } catch (err) {
      console.error(err);
      ui.notifications?.error("Apply failed (see console).");
      // revert + unlock so GM can try again
      btn.disabled = false;
      btn.textContent = "Apply (GM)";
      btn.style.filter = "";
    } finally {
      btn.dataset.fuLock = "0";
    }
  }, { capture: false });

  console.log(`[${MODULE_ID}] ready — global chat-button listener installed on this client`);
});
