// scripts/invokeBond-button.js — Foundry VTT v12
// Invoke Bond: add a fixed +1..+3 bonus to the Accuracy check ONCE per action.
// Reads bonds from attackerActor.system.props:
//   bond_1..bond_6  (string label; empty = unused slot)
//   emotion_X_1..emotion_X_3 (truthy if filled); bonus = count of filled (cap 3)
//
// Requires CreateActionCard to save { payload } on the ChatMessage flag:
//   await posted.setFlag("fabula-ultima-companion", "actionCard", { payload: PAYLOAD });
//
// Flags used:
//   payload.meta.invoked = { trait:boolean, bond:boolean }
//   payload.meta.bondInfo = { index:number, name:string, bonus:number }   // (added by this script)

const MODULE_NS = "fabula-ultima-companion";
const CARD_FLAG = "actionCard";

console.log("[fu-invokeBond] script file loaded");

// ---------- helpers ----------
async function getPayload(chatMsg) {
  const f = await chatMsg.getFlag(MODULE_NS, CARD_FLAG).catch(() => null);
  return f?.payload ?? null;
}
async function getActorFromUuid(uuid) {
  if (!uuid) return null;
  try {
    let doc = await fromUuid(uuid);
    if (!doc) return null;
    if (doc?.actor) return doc.actor;
    if (doc?.type === "Actor") return doc;
    return doc?.document?.actor ?? null;
  } catch { return null; }
}
function ensureOwner(actor) {
  const ok = actor?.isOwner || game.user?.isGM;
  if (!ok) ui.notifications?.warn("Only the attacker’s owner (or GM) can Invoke Bond.");
  return ok;
}
function lock(btn) { if (!btn) return true; if (btn.dataset.fuLock === "1") return true; btn.dataset.fuLock = "1"; return false; }
function unlock(btn) { if (btn) btn.dataset.fuLock = "0"; }

async function rebuildCard(nextPayload, oldMsg) {
  const cardMacro = game.macros.getName("CreateActionCard");
  if (!cardMacro) return ui.notifications.error('Macro "CreateActionCard" not found.');
  await cardMacro.execute({ __AUTO: true, __PAYLOAD: nextPayload });
  try { await oldMsg.delete(); } catch {}
}

// Extract bonds from actor.system.props in the expected shape
function collectBonds(actor) {
  const P = actor?.system?.props ?? {};
  const bonds = [];
  for (let i = 1; i <= 6; i++) {
    const name = String(P[`bond_${i}`] ?? "").trim();
    if (!name) continue; // empty slot
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
  // Only show options that yield a positive bonus
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

// ---------- binder ----------
function bindInvokeBond() {
  const root = document.querySelector("#chat-log") || document.body;
  if (!root || root.__fuInvokeBondBound) return;
  root.__fuInvokeBondBound = true;

  root.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.("[data-fu-bond]");
    if (!btn) return;
    if (lock(btn)) return;

    try {
      // Locate the message and payload
      const msgEl   = btn.closest?.(".message");
      const msgId   = msgEl?.dataset?.messageId;
      const chatMsg = msgId ? game.messages.get(msgId) : null;
      if (!chatMsg) return;

      const payload = await getPayload(chatMsg);
      if (!payload) return ui.notifications?.error("Invoke Bond: Missing payload on the card.");

      // Already used?
      const invoked = payload?.meta?.invoked ?? { trait:false, bond:false };
      if (invoked.bond) return ui.notifications?.warn("Bond already invoked for this action.");

      // Ownership gate (attacker only)
      const atkUuid  = payload?.meta?.attackerUuid ?? payload?.meta?.attacker_uuid ?? null;
      const attacker = await getActorFromUuid(atkUuid);
      if (!ensureOwner(attacker)) return;

      // Must have an Accuracy block (we’re adding to the check)
      const A = payload.accuracy;
      if (!A) return ui.notifications?.warn("No Accuracy check to modify.");

      // Pull bonds from actor
      const bonds = collectBonds(attacker);
      if (!bonds.length) return ui.notifications?.warn("No Bonds found on this actor.");
      const viable = bonds.filter(b => b.bonus > 0);
      if (!viable.length) return ui.notifications?.warn("No eligible Bonds (no filled emotions).");

      // Ask which bond to invoke when multiple are viable
      let chosen = viable[0];
      if (viable.length > 1) {
        const pick = await chooseBondDialog(bonds);
        if (!pick) return; // cancelled
        chosen = bonds.find(b => b.index === pick) ?? viable[0];
      }

      const addBonus = Number(chosen.bonus || 0);
      if (!(addBonus > 0)) return ui.notifications?.warn("Chosen Bond gives no bonus.");

      // Build the next payload
      const next = foundry.utils.deepClone(payload);
      next.meta = next.meta || {};
      next.meta.invoked = next.meta.invoked || { trait:false, bond:false };
      next.meta.invoked.bond = true;
      next.meta.bondInfo = { index: chosen.index, name: chosen.name, bonus: addBonus };

      // Update Accuracy totals (increase the checkBonus too so tooltips stay correct)
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

      // No change to HR/damage base — Invoke Bond doesn’t affect HR
      // Keep advPayload as-is; CreateActionCard reads accuracy.total for Apply logic

      // Rebuild card and remove the old one
      await rebuildCard(next, chatMsg);
    } catch (err) {
      console.error(err);
      ui.notifications?.error("Invoke Bond failed (see console).");
    } finally {
      unlock(btn);
    }
  }, { capture: false });

  console.log("[fu-invokeBond] ready — installed chat listener");
}

// Bind even if this script loads after the 'ready' hook
if (window.game?.ready) bindInvokeBond();
else Hooks.once("ready", bindInvokeBond);
