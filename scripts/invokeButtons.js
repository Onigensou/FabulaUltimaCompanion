// scripts/invokeButtons.js — Foundry VTT v12
// Invoke Trait + Invoke Bond (merged)
// - [data-fu-trait]: reroll up to two accuracy dice ONCE per action
// - [data-fu-bond] : add a flat +1..+3 to accuracy.total ONCE per action
// Requires your CreateActionCard macro to persist payload on the message flag:
//   await posted.setFlag("fabula-ultima-companion", "actionCard", { payload: PAYLOAD });

(() => {
  const MODULE_NS = "fabula-ultima-companion";
  const CARD_FLAG = "actionCard";

  console.log("[fu-invokeButtons] script file loaded");

// ---------- helpers (shared) ----------
async function getPayload(chatMsg) {
  try {
    // getFlag is synchronous in practice; awaiting is harmless
    const f = await chatMsg.getFlag(MODULE_NS, CARD_FLAG);
    // support both shapes: {payload:{...}} and legacy {...}
    return f?.payload ?? f ?? null;
  } catch (e) {
    console.warn("[fu-invokeButtons] getPayload failed:", e);
    return null;
  }
}

async function rebuildCard(nextPayload, oldMsg) {
  const cardMacro = game.macros.getName("CreateActionCard");
  if (!cardMacro) return ui.notifications.error('Macro "CreateActionCard" not found.');

  // Your CreateActionCard reads globals (__AUTO/__PAYLOAD); set them, run, then clean up.
  try {
    window.__AUTO = true;
    window.__PAYLOAD = nextPayload;
    await cardMacro.execute();      // no args: it uses the globals
  } finally {
    try { delete window.__AUTO; } catch {}
    try { delete window.__PAYLOAD; } catch {}
  }

  try { await oldMsg.delete(); } catch {}
}

  // Actor → die size for attribute label (e.g., "DEX"→d?); safe defaults
  function dieSizeFor(actor, attr) {
    const k = String(attr || "").toLowerCase();
    const P = actor?.system?.props ?? {};
    const cur  = Number(P[`${k}_current`]);
    const base = Number(P[`${k}_base`]);
    const n = Number.isFinite(cur) ? cur : (Number.isFinite(base) ? base : 6);
    return [4,6,8,10,12,20].includes(n) ? n : 6;
  }

  // Extract bonds in expected shape: { index, name, bonus, filled }
  function collectBonds(actor) {
    const P = actor?.system?.props ?? {};
    const bonds = [];
    for (let i = 1; i <= 6; i++) {
      const name = String(P[`bond_${i}`] ?? "").trim();
      if (!name) continue;
      const e1 = !!P[`emotion_${i}_1`];
      const e2 = !!P[`emotion_${i}_2`];
      const e3 = !!P[`emotion_${i}_3`];
      const filled = [e1, e2, e3].filter(Boolean).length;
      const bonus = Math.min(3, Math.max(0, filled));
      bonds.push({ index: i, name, bonus, filled });
    }
    return bonds;
  }

  async function chooseBondDialog(bonds) {
    const viable = bonds.filter(b => b.bonus > 0);
    if (!viable.length) return null;
    const opts = viable
      .map(b => `<option value="${b.index}">${foundry.utils.escapeHTML(b.name)} — +${b.bonus}</option>`)
      .join("");
    const content = `<form>
      <div class="form-group">
        <label>Choose a Bond to Invoke</label>
        <select name="bondIndex" style="width:100%;">${opts}</select>
      </div>
      <p style="margin:.4rem 0 0; font-size:12px; opacity:.75;">
        Bond bonus is +1 per filled emotion (max +3).
      </p>
    </form>`;
    return await new Promise(resolve => new Dialog({
      title: "Invoke Bond — Choose Bond",
      content,
      buttons: {
        ok:     { label: "Invoke", callback: html => resolve(Number(html[0].querySelector('[name="bondIndex"]').value)) },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "ok"
    }).render(true));
  }

  // ---------- actions ----------
  async function handleInvokeTrait(btn, chatMsg) {
    const payload = await getPayload(chatMsg);
    if (!payload) return ui.notifications?.error("Invoke Trait: Missing payload on the card.");

    const invoked = payload?.meta?.invoked ?? { trait:false, bond:false };
    if (invoked.trait) return ui.notifications?.warn("Trait already invoked for this action.");

    const atkUuid = payload?.meta?.attackerUuid ?? payload?.meta?.attacker_uuid ?? null;
    const attacker = await getActorFromUuid(atkUuid);
    if (!ensureOwner(attacker, "Invoke Trait")) return;

    const A = payload.accuracy;
    if (!A) return ui.notifications?.warn("No Accuracy check to reroll.");

    // Dialog to choose which die(s) to reroll
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

    // Reroll
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

    // Crit/Fumble (keep your props)
    const critRange = Number(attacker?.system?.props?.critical_dice_range ?? 0);
    const minCrit   = Number(attacker?.system?.props?.minimum_critical_dice ?? 999);
    const isCrit    = (Math.abs(rA - rB) <= critRange) && (rA >= minCrit || rB >= minCrit);
    const fumbleTH  = Number(attacker?.system?.props?.fumble_threshold ?? -1);
    const isFumble  = (fumbleTH >= 0) ? (rA <= fumbleTH && rB <= fumbleTH) : false;

    // Build next payload
    const next = foundry.utils.deepClone(payload);
    next.meta = next.meta || {};
    next.meta.invoked = next.meta.invoked || { trait:false, bond:false };
    next.meta.invoked.trait = true;

    next.accuracy = {
      dA, dB,
      rA: { total: rA, result: rA },
      rB: { total: rB, result: rB },
      total, hr,
      isCrit, isBunny: (isCrit && rA !== rB), isFumble,
      A1: A.A1, A2: A.A2,
      checkBonus: bonus,
      hrUsed: next.meta?.ignoreHR ? null : hr
    };

    // Recompute preview damage (base-without-HR + new HR)
    const elem   = String(next?.meta?.elementType || "physical").toLowerCase();
    const healRx = /^(heal|healing|recovery|restore|restoration)$/i;
    const declaresHealing = healRx.test(elem);
    const ignoreHR = !!next?.meta?.ignoreHR;

    const prevCombined = Number(next?.meta?.baseValueStrForCard ?? 0);
    const prevHr       = Number(next?.meta?.hrBonus ?? 0);
    const baseNoHR     = declaresHealing ? prevCombined : Math.max(0, prevCombined - (ignoreHR ? 0 : prevHr));

    const newHrBonus   = (!declaresHealing && !ignoreHR) ? hr : 0;
    const newCombined  = declaresHealing ? baseNoHR : (baseNoHR + newHrBonus);

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

    await rebuildCard(next, chatMsg);
  }

  async function handleInvokeBond(btn, chatMsg) {
    const payload = await getPayload(chatMsg);
    if (!payload) return ui.notifications?.error("Invoke Bond: Missing payload on the card.");

    const invoked = payload?.meta?.invoked ?? { trait:false, bond:false };
    if (invoked.bond) return ui.notifications?.warn("Bond already invoked for this action.");

    const atkUuid  = payload?.meta?.attackerUuid ?? payload?.meta?.attacker_uuid ?? null;
    const attacker = await getActorFromUuid(atkUuid);
    if (!ensureOwner(attacker, "Invoke Bond")) return;

    const A = payload.accuracy;
    if (!A) return ui.notifications?.warn("No Accuracy check to modify.");

    const bonds = collectBonds(attacker);
    if (!bonds.length) return ui.notifications?.warn("No Bonds found on this actor.");
    const viable = bonds.filter(b => b.bonus > 0);
    if (!viable.length) return ui.notifications?.warn("No eligible Bonds (no filled emotions).");

    let chosen = viable[0];
    if (viable.length > 1) {
      const pick = await chooseBondDialog(bonds);
      if (!pick) return;
      chosen = bonds.find(b => b.index === pick) ?? viable[0];
    }

    const addBonus = Number(chosen.bonus || 0);
    if (!(addBonus > 0)) return ui.notifications?.warn("Chosen Bond gives no bonus.");

    const next = foundry.utils.deepClone(payload);
    next.meta = next.meta || {};
    next.meta.invoked = next.meta.invoked || { trait:false, bond:false };
    next.meta.invoked.bond = true;
    next.meta.bondInfo = { index: chosen.index, name: chosen.name, bonus: addBonus };

    const oldBonus = Number(A.checkBonus || 0);
    const newBonus = oldBonus + addBonus;
    const rA = Number(A.rA?.total ?? 0);
    const rB = Number(A.rB?.total ?? 0);
    const newTotal = rA + rB + newBonus;

    next.accuracy = {
      ...A,
      rA: { total: rA, result: A.rA?.result ?? rA },
      rB: { total: rB, result: A.rB?.result ?? rB },
      checkBonus: newBonus,
      total: newTotal
    };

    await rebuildCard(next, chatMsg);
  }

  // ---------- binder (single listener handles both buttons) ----------
  function bindInvokeButtons() {
    const root = document.querySelector("#chat-log") || document.body;
    if (!root || root.__fuInvokeButtonsBound) return;
    root.__fuInvokeButtonsBound = true;

    root.addEventListener("click", async (ev) => {
      const btnTrait = ev.target.closest?.("[data-fu-trait]");
      const btnBond  = btnTrait ? null : ev.target.closest?.("[data-fu-bond]"); // avoid double hits

      if (!btnTrait && !btnBond) return;

      const btn = btnTrait || btnBond;
      if (lock(btn)) return;

      try {
        // Locate message (both buttons share same lookup)
        const msgEl   = btn.closest?.(".message");
        const msgId   = msgEl?.dataset?.messageId;
        const chatMsg = msgId ? game.messages.get(msgId) : null;
        if (!chatMsg) return;

        if (btnTrait) await handleInvokeTrait(btnTrait, chatMsg);
        else          await handleInvokeBond(btnBond,  chatMsg);
      } catch (err) {
        console.error(err);
        ui.notifications?.error("Invoke failed (see console).");
      } finally {
        unlock(btn);
      }
    }, { capture: false });

    console.log("[fu-invokeButtons] ready — installed chat listener");
  }

  // Bind even if loaded after 'ready'
  if (window.game?.ready) bindInvokeButtons();
  else Hooks.once("ready", bindInvokeButtons);
})();
