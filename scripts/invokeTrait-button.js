// invokeTrait-button.js — Foundry VTT v12
// Global delegated listener for [data-fu-trait] on Action Cards.
// Lets an attacker reroll either accuracy die (A and/or B) ONCE per action.
// Requires the Action Card to have a ChatMessage flag with the original payload.
//
// Flags used (stored inside the payload.meta.invoked):
//   meta.invoked = { trait: boolean, bond: boolean }
//
// Assumptions (kept consistent with your ADF/CreateActionCard):
//  - payload.accuracy = { dA, dB, rA:{total,result}, rB:{total,result}, total, hr, isCrit, isFumble, A1, A2, checkBonus }
//  - payload.core/meta/advPayload are in the ChatMessage flag to rebuild the new card.
//  - payload.meta.attackerUuid exists (owner gating + stat reads)
//  - CreateActionCard re-saves the new payload back onto the newly created ChatMessage

const MODULE_NS = "fabula-ultima-companion";
const CARD_FLAG = "actionCard";

Hooks.once("ready", () => {
  const root = document.querySelector("#chat-log") || document.body;
  if (!root || root.__fuInvokeTraitBound) return;
  root.__fuInvokeTraitBound = true;

  root.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.("[data-fu-trait]");
    if (!btn) return;

    // Lock against accidental double-click
    if (btn.dataset.fuLock === "1") return;
    btn.dataset.fuLock = "1";

    try {
      const msgEl = btn.closest?.(".message");
      const msgId = msgEl?.dataset?.messageId;
      const chatMsg = msgId ? game.messages.get(msgId) : null;
      if (!chatMsg) return;

      // Pull original action payload from message flag (authoritative)
      const stored = await chatMsg.getFlag(MODULE_NS, CARD_FLAG);
      const payload = stored?.payload ?? null;
      if (!payload) return ui.notifications?.error("Invoke Trait: Missing payload on the card.");

      // Already used?
      const invoked = payload?.meta?.invoked ?? { trait: false, bond: false };
      if (invoked.trait) return ui.notifications?.warn("Trait already invoked for this action.");

      // Gating: only attacker’s owner or GM can press
      const atkUuid = payload?.meta?.attackerUuid ?? null;
      let attackerActor = null;
      if (atkUuid) attackerActor = await fromUuid(atkUuid).catch(()=>null);
      attackerActor = attackerActor?.actor ?? (attackerActor?.type === "Actor" ? attackerActor : null);
      const isOwner = attackerActor?.isOwner || false;
      if (!isOwner && !game.user?.isGM) {
        return ui.notifications?.warn("Only the attacker’s owner (or GM) can Invoke Trait.");
      }

      // Must have an Accuracy block to reroll
      const A = payload.accuracy;
      if (!A) return ui.notifications?.warn("No Accuracy check to reroll.");

      // Ask which die(s) to reroll
      const dieInfo = `
        <p><b>Current:</b><br>
        ${A.A1} → d${A.dA} = ${A.rA.total}<br>
        ${A.A2} → d${A.dB} = ${A.rB.total}</p>
        <p>Choose which die to reroll (once per action):</p>
      `;
      const choice = await new Promise((resolve) => new Dialog({
        title: "Invoke Trait — Reroll",
        content: `<form>${dieInfo}
          <div class="form-group">
            <label>Reroll</label>
            <select name="which" style="width:100%">
              <option value="A">${A.A1} (die A)</option>
              <option value="B">${A.A2} (die B)</option>
              <option value="AB">${A.A1} and ${A.A2} (both dice)</option>
            </select>
          </div></form>`,
        buttons: {
          ok: { label: "Reroll", callback: (html) => resolve(html[0].querySelector('[name="which"]').value) },
          cancel: { label: "Cancel", callback: () => resolve(null) }
        },
        default: "ok"
      }).render(true));

      if (!choice) { btn.dataset.fuLock = "0"; return; }

      // Rebuild dice sizes from actor props (kept aligned with ADF.getDieSize)
      function dieSizeFor(attr) {
        const k = String(attr||"").toLowerCase();
        const props = attackerActor?.system?.props ?? {};
        const cur = Number(props[`${k}_current`]); const base = Number(props[`${k}_base`]);
        const n = Number.isFinite(cur) ? cur : (Number.isFinite(base) ? base : 6);
        return [4,6,8,10,12,20].includes(n) ? n : 6;
      }

      const dA = dieSizeFor(A.A1);
      const dB = dieSizeFor(A.A2);

      // Re-roll chosen dice; keep the other as-is
      const rA = (choice === "A" || choice === "AB")
        ? (await (new Roll(`1d${dA}`)).evaluate()).total
        : Number(A.rA.total);
      const rB = (choice === "B" || choice === "AB")
        ? (await (new Roll(`1d${dB}`)).evaluate()).total
        : Number(A.rB.total);

      // Recompute core accuracy math (mirrors your ADF logic)
      const bonus = Number(A.checkBonus||0);
      const total = rA + rB + bonus;
      const hr    = Math.max(rA, rB);

      const critRange = Number(attackerActor?.system?.props?.critical_dice_range ?? 0);
      const minCrit   = Number(attackerActor?.system?.props?.minimum_critical_dice ?? 999);
      const isCrit    = (Math.abs(rA - rB) <= critRange) && (rA >= minCrit || rB >= minCrit);
      const fumbleTH  = Number(attackerActor?.system?.props?.fumble_threshold ?? -1);
      const isFumble  = (fumbleTH >= 0) ? (rA <= fumbleTH && rB <= fumbleTH) : false;

      // Clone and update payload
      const next = foundry.utils.deepClone(payload);

      // Mark "Trait used"
      next.meta = next.meta || {};
      next.meta.invoked = next.meta.invoked || { trait:false, bond:false };
      next.meta.invoked.trait = true;

      // Update accuracy block
      next.accuracy = {
        dA, dB,
        rA: { total: rA, result: rA },
        rB: { total: rB, result: rB },
        total, hr, isCrit, isBunny: (isCrit && rA !== rB),
        isFumble,
        A1: A.A1, A2: A.A2,
        checkBonus: bonus,
        hrUsed: next.meta?.ignoreHR ? null : hr
      };

      // Recompute damage preview bits dependent on HR (weapon attacks, non-heal)
      const elem   = String(next?.meta?.elementType || "physical").toLowerCase();
      const healRx = /^(heal|healing|recovery|restore|restoration)$/i;
      const declaresHealing = healRx.test(elem);
      const ignoreHR = !!next?.meta?.ignoreHR;

      const flatBonus = Number(next?.core?.damageBonus ?? next?.advPayload?.bonus ?? 0);
      const baseVal   = Math.max(0, Number(next?.core?.damageBonus ?? 0)); // original base (no HR)
      const hrBonus   = (!declaresHealing && !ignoreHR) ? hr : 0;
      const combined  = declaresHealing ? baseVal : (baseVal + hrBonus);

      next.meta.declaresHealing = declaresHealing;
      next.meta.hasDamageSection = (combined > 0);
      next.meta.hrBonus = hrBonus;
      next.meta.baseValueStrForCard = String(combined);
      if (next.advPayload) {
        next.advPayload.hr = ignoreHR ? null : hr;
        next.advPayload.isCrit = !!isCrit;
        next.advPayload.isFumble = !!isFumble;
        // baseValue for AdvanceDamage: keep your existing pattern
        next.advPayload.baseValue = declaresHealing ? `+${baseVal}` : String(combined);
      }

      // Spawn a fresh Action Card; then delete the old one
      const cardMacro = game.macros.getName("CreateActionCard");
      if (!cardMacro) return ui.notifications.error(`Macro "CreateActionCard" not found.`);
      await cardMacro.execute({ __AUTO: true, __PAYLOAD: next });

      // Clean up the old message (dismiss)
      await chatMsg.delete();
    } catch (err) {
      console.error(err);
      ui.notifications?.error("Invoke Trait failed (see console).");
    } finally {
      btn.dataset.fuLock = "0";
    }
  }, { capture:false });

  console.log("[fu-invokeTrait] ready — installed chat listener");
});
