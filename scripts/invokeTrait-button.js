// scripts/invokeTrait-button.js — Foundry VTT v12
// Invoke Trait: reroll up to two accuracy dice ONCE per action.
// Requires CreateActionCard to save { payload } on the ChatMessage flag:
//   await posted.setFlag("fabula-ultima-companion", "actionCard", { payload: PAYLOAD });

const MODULE_NS = "fabula-ultima-companion";
const CARD_FLAG = "actionCard";

console.log("[fu-invokeTrait] script file loaded");

// ---------- helpers ----------
async function getPayload(chatMsg) {
  const f = await chatMsg.getFlag(MODULE_NS, CARD_FLAG);
  return f?.payload ?? null;
}
async function getActorFromUuid(uuid) {
  if (!uuid) return null;
  let a = await fromUuid(uuid).catch(() => null);
  a = a?.actor ?? (a?.type === "Actor" ? a : null);
  return a;
}
function ensureOwner(actor) {
  const ok = actor?.isOwner || game.user?.isGM;
  if (!ok) ui.notifications?.warn("Only the attacker’s owner (or GM) can Invoke Trait.");
  return ok;
}
function dieSizeFor(actor, attr) {
  const k = String(attr || "").toLowerCase();
  const P = actor?.system?.props ?? {};
  const cur  = Number(P[`${k}_current`]);
  const base = Number(P[`${k}_base`]);
  const n = Number.isFinite(cur) ? cur : (Number.isFinite(base) ? base : 6);
  return [4,6,8,10,12,20].includes(n) ? n : 6;
}
function lock(btn) { if (!btn) return true; if (btn.dataset.fuLock === "1") return true; btn.dataset.fuLock = "1"; return false; }
function unlock(btn) { if (btn) btn.dataset.fuLock = "0"; }
async function rebuildCard(nextPayload, oldMsg) {
  const cardMacro = game.macros.getName("CreateActionCard");
  if (!cardMacro) return ui.notifications.error('Macro "CreateActionCard" not found.');
  await cardMacro.execute({ __AUTO: true, __PAYLOAD: nextPayload });
  await oldMsg.delete();
}

// ---------- binder ----------
function bindInvokeTrait() {
  const root = document.querySelector("#chat-log") || document.body;
  if (!root || root.__fuInvokeTraitBound) return;
  root.__fuInvokeTraitBound = true;

  root.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.("[data-fu-trait]");
    if (!btn) return;
    if (lock(btn)) return;

    try {
      // Locate the message & payload
      const msgEl   = btn.closest?.(".message");
      const msgId   = msgEl?.dataset?.messageId;
      const chatMsg = msgId ? game.messages.get(msgId) : null;
      if (!chatMsg) return;

      const payload = await getPayload(chatMsg);
      if (!payload) return ui.notifications?.error("Invoke Trait: Missing payload on the card.");

      // Already used?
      const invoked = payload?.meta?.invoked ?? { trait:false, bond:false };
      if (invoked.trait) return ui.notifications?.warn("Trait already invoked for this action.");

      // Ownership gate
      const atkUuid = payload?.meta?.attackerUuid ?? null;
      const attacker = await getActorFromUuid(atkUuid);
      if (!ensureOwner(attacker)) return;

      // Must have an Accuracy block
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
          ok:     { label: "Reroll", callback: (html) => resolve(html[0].querySelector('[name="which"]').value) },
          cancel: { label: "Cancel", callback: () => resolve(null) }
        },
        default: "ok"
      }).render(true));
      if (!choice) return;

      // Reroll the chosen dice (sizes inferred from actor)
      const dA = dieSizeFor(attacker, A.A1);
      const dB = dieSizeFor(attacker, A.A2);
      const rA = (choice === "A" || choice === "AB")
        ? (await (new Roll(`1d${dA}`)).evaluate()).total
        : Number(A.rA.total);
      const rB = (choice === "B" || choice === "AB")
        ? (await (new Roll(`1d${dB}`)).evaluate()).total
        : Number(A.rB.total);

      const bonus = Number(A.checkBonus || 0);
      const total = rA + rB + bonus;
      const hr    = Math.max(rA, rB);

      // Crit/Fumble (keeps your props)
      const critRange = Number(attacker?.system?.props?.critical_dice_range ?? 0);
      const minCrit   = Number(attacker?.system?.props?.minimum_critical_dice ?? 999);
      const isCrit    = (Math.abs(rA - rB) <= critRange) && (rA >= minCrit || rB >= minCrit);
      const fumbleTH  = Number(attacker?.system?.props?.fumble_threshold ?? -1);
      const isFumble  = (fumbleTH >= 0) ? (rA <= fumbleTH && rB <= fumbleTH) : false;

      // Build the next payload
      const next = foundry.utils.deepClone(payload);
      next.meta = next.meta || {};
      next.meta.invoked = next.meta.invoked || { trait:false, bond:false };
      next.meta.invoked.trait = true;

      // Update accuracy
      next.accuracy = {
        dA, dB,
        rA: { total: rA, result: rA },
        rB: { total: rB, result: rB },
        total, hr, isCrit, isBunny: (isCrit && rA !== rB), isFumble,
        A1: A.A1, A2: A.A2,
        checkBonus: bonus,
        hrUsed: next.meta?.ignoreHR ? null : hr
      };

      // --- Recompute the preview damage correctly (base-without-HR + new HR) ---
      const elem   = String(next?.meta?.elementType || "physical").toLowerCase();
      const healRx = /^(heal|healing|recovery|restore|restoration)$/i;
      const declaresHealing = healRx.test(elem);
      const ignoreHR = !!next?.meta?.ignoreHR;

      // Recover base-without-HR from previous card
      const prevCombined = Number(next?.meta?.baseValueStrForCard ?? 0);
      const prevHr       = Number(next?.meta?.hrBonus ?? 0);
      const baseNoHR     = declaresHealing ? prevCombined : Math.max(0, prevCombined - (ignoreHR ? 0 : prevHr));

      const newHrBonus   = (!declaresHealing && !ignoreHR) ? hr : 0;
      const newCombined  = declaresHealing ? baseNoHR : (baseNoHR + newHrBonus);

      // Update meta + advPayload in the shape CreateActionCard expects
      next.meta.declaresHealing     = declaresHealing;
      next.meta.hasDamageSection    = (newCombined > 0);
      next.meta.hrBonus             = newHrBonus;
      next.meta.baseValueStrForCard = String(newCombined);

      if (next.advPayload) {
        next.advPayload.hr        = ignoreHR ? null : hr;
        next.advPayload.isCrit    = !!isCrit;
        next.advPayload.isFumble  = !!isFumble;
        next.advPayload.baseValue = declaresHealing ? `+${baseNoHR}` : String(newCombined);
      }

      // Rebuild card and remove the old one
      await rebuildCard(next, chatMsg);
    } catch (err) {
      console.error(err);
      ui.notifications?.error("Invoke Trait failed (see console).");
    } finally {
      unlock(btn);
    }
  }, { capture: false });

  console.log("[fu-invokeTrait] ready — installed chat listener");
}

// Bind even if this script loads after the 'ready' hook
if (window.game?.ready) bindInvokeTrait();
else Hooks.once("ready", bindInvokeTrait);
