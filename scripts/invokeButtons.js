// scripts/invokeButtons.js — Foundry VTT v12
// Invoke Trait + Invoke Bond (merged) + Fabula/Ultima point spend (1 per invoke)
// - [data-fu-trait]: reroll up to two accuracy dice ONCE per action (cost 1 point)
// - [data-fu-bond] : add a flat +1..+3 to accuracy.total ONCE per action (cost 1 point)
// If actor has <1 point in the correct pool, click silently does nothing.
// Buttons are also greyed at card render-time by CreateActionCard.js.

(() => {
  const MODULE_NS = "fabula-ultima-companion";
  const CARD_FLAG = "actionCard";

  console.log("[fu-invokeButtons] script file loaded");

  // ---------- helpers (shared) ----------
  const esc = (v) => {
    const s = String(v ?? "");
    if (window.TextEditor?.escapeHTML) return TextEditor.escapeHTML(s);
    return s.replace(/[&<>"']/g, (m) => (
      m === "&" ? "&amp;" :
      m === "<" ? "&lt;"  :
      m === ">" ? "&gt;"  :
      m === '"' ? "&quot;":
                  "&#39;"
    ));
  };

  async function getPayload(chatMsg) {
    try {
      const f = await chatMsg.getFlag(MODULE_NS, CARD_FLAG);
      return f?.payload ?? f ?? null;
    } catch (e) {
      console.warn("[fu-invokeButtons] getPayload failed:", e);
      return null;
    }
  }

  async function rebuildCard(nextPayload, oldMsg) {
    const cardMacro = game.macros.getName("CreateActionCard");
    if (!cardMacro) return ui.notifications.error('Macro "CreateActionCard" not found.');
    try {
      window.__AUTO = true;
      window.__PAYLOAD = nextPayload;
      await cardMacro.execute();
    } finally {
      try { delete window.__AUTO; } catch {}
      try { delete window.__PAYLOAD; } catch {}
    }
    try { await oldMsg.delete(); } catch {}
  }

  async function getActorFromUuid(uuid) {
    if (!uuid) return null;
    try {
      const doc = await fromUuid(uuid);
      if (!doc) return null;
      if (doc?.actor) return doc.actor;
      if (doc?.type === "Actor") return doc;
      return doc?.document?.actor ?? null;
    } catch {
      return null;
    }
  }

  function ensureOwner(actor, payload, what = "this action") {
    const initUid = payload?.meta?.ownerUserId || null;
    const allow =
      game.user?.isGM ||
      actor?.isOwner === true ||
      (initUid && game.user?.id === initUid);
    if (!allow) ui.notifications?.warn(`Only the attacker’s owner (or GM) can ${what}.`);
    return allow;
  }

  function lock(btn) {
    if (!btn) return true;
    if (btn.dataset.fuLock === "1") return true;
    btn.dataset.fuLock = "1";
    return false;
  }
  function unlock(btn) { if (btn) btn.dataset.fuLock = "0"; }

  // ---------- NEW: point helpers ----------
  function getPointKeyAndValue(actor) {
    const P = actor?.system?.props ?? {};
    const isVillain = !!P.isVillain || !!P.isBoss;
    const key = isVillain ? "ultima_point" : "fabula_point";
    const cur = Number(P[key] ?? 0) || 0;
    return { key, cur, isVillain };
  }

  async function trySpendOnePoint(actor) {
    const { key, cur } = getPointKeyAndValue(actor);
    if (cur < 1) return false;                             // not enough → silent block
    const path = `system.props.${key}`;
    try { await actor.update({ [path]: cur - 1 }); }
    catch (e) {
      console.warn("[fu-invokeButtons] point spend failed:", e);
      return false; // if update fails, don't proceed
    }
    return true;
  }

  // Actor → die size for attribute label (e.g., "DEX"→d?)
  function dieSizeFor(actor, attr) {
    const k = String(attr || "").toLowerCase();
    const P = actor?.system?.props ?? {};
    const cur  = Number(P[`${k}_current`]);
    const base = Number(P[`${k}_base`]);
    const n = Number.isFinite(cur) ? cur : (Number.isFinite(base) ? base : 6);
    return [4, 6, 8, 10, 12, 20].includes(n) ? n : 6;
  }

  // (kept for legacy, we now use payload.meta.bonds, but leaving this helper here doesn’t hurt)
  function collectBonds(actor) {
    const P = actor?.system?.props ?? {};
    const bonds = [];
    for (let i = 1; i <= 6; i++) {
      const name = String(P[`bond_${i}`] ?? "").trim();
      if (!name) continue;
      const e1 = !!P[`emotion_${i}_1`];
      const e2 = !!P[`emotion_${i}_2`];
      const e3 = !!P[`emotion_${i}_3`];
      const filled = (e1 ? 1 : 0) + (e2 ? 1 : 0) + (e3 ? 1 : 0);
      const bonus = Math.min(3, Math.max(0, filled));
      bonds.push({ index: i, name, bonus, filled });
    }
    return bonds;
  }

  async function handleInvokeTrait(btn, chatMsg) {
    const payload = await getPayload(chatMsg);
    if (!payload) return ui.notifications?.error("Invoke Trait: Missing payload on the card.");
    const invoked = payload?.meta?.invoked ?? { trait:false, bond:false };
    if (invoked.trait) return; // already used on this action → silently ignore

    const atkUuid  = payload?.meta?.attackerUuid ?? payload?.meta?.attacker_uuid ?? null;
    const attacker = await getActorFromUuid(atkUuid);
    if (!ensureOwner(attacker, payload, "Invoke Trait")) return;

    // NEW: must pay 1 point first; if cannot pay, silent block
    const paid = await trySpendOnePoint(attacker);
    if (!paid) return;

    const A = payload.accuracy;
    if (!A) return; // no accuracy section → nothing to reroll

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
      default: "ok",
      close: () => resolve(null)
    }).render(true));

    if (!choice) return; // cancelled → we already spent a point; if you want refunds on cancel, move spend after this block.

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

    const critRange = Number(attacker?.system?.props?.critical_dice_range ?? 0);
    const minCrit   = Number(attacker?.system?.props?.minimum_critical_dice ?? 999);
    const isCrit    = (Math.abs(rA - rB) <= critRange) && (rA >= minCrit || rB >= minCrit);
    const fumbleTH  = Number(attacker?.system?.props?.fumble_threshold ?? -1);
    const isFumble  = (fumbleTH >= 0) ? (rA <= fumbleTH && rB <= fumbleTH) : false;

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

    // Recompute preview damage
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
    if (invoked.bond) return; // already used on this action → silently ignore

    const atkUuid  = payload?.meta?.attackerUuid ?? payload?.meta?.attacker_uuid ?? null;
    const attacker = await getActorFromUuid(atkUuid);
    if (!ensureOwner(attacker, payload, "Invoke Bond")) return;

    // NEW: must pay 1 point first; if cannot pay, silent block
    const paid = await trySpendOnePoint(attacker);
    if (!paid) return;

    const A = payload.accuracy;
    if (!A) return;

    const bondSnap = payload?.meta?.bonds || { list:[], viable:[] };
    const viable = Array.isArray(bondSnap.viable) ? bondSnap.viable
                 : Array.isArray(bondSnap.list)   ? bondSnap.list.filter(b => (b?.bonus||0) > 0)
                 : [];
    if (!viable.length) return;

    // If multiple, ask the user; otherwise auto-pick first viable
    let chosen = viable[0];
    if (viable.length > 1) {
      const opts = viable.map(b => `<option value="${b.index}">${esc(b.name)} — +${b.bonus}</option>`).join("");
      const content = `<form>
        <div class="form-group">
          <label>Choose a Bond to Invoke</label>
          <select name="bondIndex" style="width:100%;">${opts}</select>
        </div></form>`;
      const pick = await new Promise(res => new Dialog({
        title: "Invoke Bond — Choose Bond",
        content,
        buttons: {
          ok:     { label: "Invoke", callback: html => res(Number(html[0].querySelector('[name="bondIndex"]').value)) },
          cancel: { label: "Cancel", callback: () => res(null) }
        },
        default: "ok",
        close: () => res(null)
      }).render(true));
      if (pick == null) return; // cancelled (point has already been spent by design)
      chosen = viable.find(b => Number(b.index) === Number(pick)) ?? chosen;
    }

    const addBonus = Number(chosen.bonus || 0);
    if (!(addBonus > 0)) return;

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

  // ---------- binder ----------
  function bindInvokeButtons() {
    const root = document.querySelector("#chat-log") || document.body;
    if (!root || root.__fuInvokeButtonsBound) return;
    root.__fuInvokeButtonsBound = true;

    root.addEventListener("click", async (ev) => {
      const btnTrait = ev.target.closest?.("[data-fu-trait]");
      const btnBond  = btnTrait ? null : ev.target.closest?.("[data-fu-bond]");
      if (!btnTrait && !btnBond) return;

      const btn = btnTrait || btnBond;
      if (lock(btn)) return;

      try {
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

  if (window.game?.ready) bindInvokeButtons();
  else Hooks.once("ready", bindInvokeButtons);
})();
