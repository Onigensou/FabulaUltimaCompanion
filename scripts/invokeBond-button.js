// invokeBond-button.js — Foundry VTT v12
// Global delegated listener for [data-fu-bond] on Action Cards.
// Lets an attacker add a Bond bonus ONCE per action (default: +1 per filled emotion, max +3).
// Reads Bonds from attackerActor.system.props: bond_1..6 + emotion_X_1..3.
//
// Flags: payload.meta.invoked = { trait: boolean, bond: boolean }

const MODULE_NS = "fabula-ultima-companion";
const CARD_FLAG = "actionCard";

console.log("[fu-invokeBond] script file loaded"); // add near top

Hooks.once("ready", () => {
  const root = document.querySelector("#chat-log") || document.body;
  if (!root || root.__fuInvokeBondBound) return;
  root.__fuInvokeBondBound = true;

  root.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.("[data-fu-bond]");
    if (!btn) return;

    if (btn.dataset.fuLock === "1") return;
    btn.dataset.fuLock = "1";

    try {
      const msgEl = btn.closest?.(".message");
      const msgId = msgEl?.dataset?.messageId;
      const chatMsg = msgId ? game.messages.get(msgId) : null;
      if (!chatMsg) return;

      const stored = await chatMsg.getFlag(MODULE_NS, CARD_FLAG);
      const payload = stored?.payload ?? null;
      if (!payload) return ui.notifications?.error("Invoke Bond: Missing payload on the card.");

      // Already used?
      const invoked = payload?.meta?.invoked ?? { trait:false, bond:false };
      if (invoked.bond) return ui.notifications?.warn("Bond already invoked for this action.");

      // Owner gating
      const atkUuid = payload?.meta?.attackerUuid ?? null;
      let attackerActor = null;
      if (atkUuid) attackerActor = await fromUuid(atkUuid).catch(()=>null);
      attackerActor = attackerActor?.actor ?? (attackerActor?.type === "Actor" ? attackerActor : null);
      const isOwner = attackerActor?.isOwner || false;
      if (!isOwner && !game.user?.isGM) {
        return ui.notifications?.warn("Only the attacker’s owner (or GM) can Invoke Bond.");
      }

      // Build a small list of bonds from props (bond_1..bond_6 with emotion_X_1..3)
      const P = attackerActor?.system?.props ?? {};
      const rows = Array.from({length:6}, (_,i) => i+1).map(i => {
        const label = String(P[`bond_${i}`] || "").trim();
        const e1 = String(P[`emotion_${i}_1`] || "").trim();
        const e2 = String(P[`emotion_${i}_2`] || "").trim();
        const e3 = String(P[`emotion_${i}_3`] || "").trim();
        const lvl = Math.min([e1,e2,e3].filter(Boolean).length, 3);
        return { idx:i, label, lvl, emotions:[e1,e2,e3].filter(Boolean) };
      }).filter(r => r.label || r.emotions.length);

      if (!rows.length) return ui.notifications?.warn("No bonds filled on the attacker’s sheet.");

      const options = rows.map(r => `<option value="${r.idx}">${r.idx}. ${r.label} [Level ${r.lvl}]</option>`).join("");
      const selection = await new Promise((resolve) => new Dialog({
        title: "Invoke Bond — Choose a Bond",
        content: `<form>
          <p>Select one bond to empower your check (Level = filled emotions, max 3).</p>
          <div class="form-group">
            <label>Bond</label>
            <select name="bondRow" style="width:100%">${options}</select>
          </div>
        </form>`,
        buttons: {
          ok: { label: "Use Bond", callback: (html)=>resolve(Number(html[0].querySelector('[name="bondRow"]').value)) },
          cancel: { label: "Cancel", callback: ()=>resolve(null) }
        },
        default: "ok"
      }).render(true));

      if (selection == null) { btn.dataset.fuLock = "0"; return; }

      const chosen = rows.find(r => r.idx === selection);
      const level  = chosen?.lvl ?? 0;

      // Default rule: +1 per level (cap 3). Adjust here if your table uses a different mapping.
      const bondBonus = Math.max(0, Math.min(level, 3)); // ← tweak if needed

      // Need an Accuracy block
      const A = payload.accuracy;
      if (!A) return ui.notifications?.warn("No Accuracy check to empower.");

      // Clone payload and add the bond bonus to accuracy.total
      const next = foundry.utils.deepClone(payload);

      next.meta = next.meta || {};
      next.meta.invoked = next.meta.invoked || { trait:false, bond:false };
      next.meta.invoked.bond = true;

      const total = Number(A.rA.total) + Number(A.rB.total) + Number(A.checkBonus||0) + bondBonus;

      next.accuracy = {
        ...A,
        total
      };

      // Damage preview does not change here EXCEPT for miss/hit thresholds later — apply remains GM-only.
      // We keep the hr, crit/fumble as-is; this is strictly a check boost.

      // Also add a small crumb so the card can show “Bond +X” in the Accuracy tooltip/row if you like
      next.accuracy._bondBonus = bondBonus;

      // Spawn new card, delete old
      const cardMacro = game.macros.getName("CreateActionCard");
      if (!cardMacro) return ui.notifications.error(`Macro "CreateActionCard" not found.`);
      await cardMacro.execute({ __AUTO: true, __PAYLOAD: next });
      await chatMsg.delete();
    } catch (err) {
      console.error(err);
      ui.notifications?.error("Invoke Bond failed (see console).");
    } finally {
      btn.dataset.fuLock = "0";
    }
  }, { capture:false });

  console.log("[fu-invokeBond] ready — installed chat listener");
});
