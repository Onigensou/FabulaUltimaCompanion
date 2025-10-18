// invokeEnhancers-buttons.js — Foundry VTT v12
// One listener file that handles BOTH [data-fu-trait] and [data-fu-bond].
// - Trait: reroll up to two accuracy dice; recompute HR and damage preview.
// - Bond : add +Level (0–3) to Accuracy total; once per action.
// Requires CreateActionCard to save { payload } on the chat message flag:
//   await posted.setFlag("fabula-ultima-companion", "actionCard", { payload: PAYLOAD });

const MODULE_NS  = "fabula-ultima-companion";
const CARD_FLAG  = "actionCard";

console.log("[fu-invokeEnhancers] script file loaded");

// ---------- helpers ----------
async function getPayloadFromMsg(chatMsg) {
  const stored = await chatMsg.getFlag(MODULE_NS, CARD_FLAG);
  return stored?.payload ?? null;
}
function ensureOwner(attackerActor) {
  const isOwner = attackerActor?.isOwner || false;
  if (!isOwner && !game.user?.isGM) {
    ui.notifications?.warn("Only the attacker’s owner (or GM) can use this.");
    return false;
  }
  return true;
}
function getActorFromUuidMaybe(uuid) {
  return (async () => {
    if (!uuid) return null;
    let a = await fromUuid(uuid).catch(()=>null);
    a = a?.actor ?? (a?.type === "Actor" ? a : null);
    return a;
  })();
}
function dieSizeFor(attackerActor, attr) {
  const k = String(attr||"").toLowerCase();
  const P = attackerActor?.system?.props ?? {};
  const cur  = Number(P[`${k}_current`]);
  const base = Number(P[`${k}_base`]);
  const n = Number.isFinite(cur) ? cur : (Number.isFinite(base) ? base : 6);
  return [4,6,8,10,12,20].includes(n) ? n : 6;
}
function disableOnce(btn) {
  if (!btn) return false;
  if (btn.dataset.fuLock === "1") return true;
  btn.dataset.fuLock = "1";
  return false;
}
function cleanUnlock(btn) { if (btn) btn.dataset.fuLock = "0"; }

// Use CreateActionCard macro to rebuild a new card, then delete the old message
async function rebuildCard(nextPayload, chatMsgToReplace) {
  const cardMacro = game.macros.getName("CreateActionCard");
  if (!cardMacro) { ui.notifications.error(`Macro "CreateActionCard" not found.`); return; }
  await cardMacro.execute({ __AUTO: true, __PAYLOAD: nextPayload });
  await chatMsgToReplace.delete();
}

// ---------- main binding ----------
Hooks.once("ready", () => {
  const root = document.querySelector("#chat-log") || document.body;
  if (!root || root.__fuInvokeEnhancersBound) return;
  root.__fuInvokeEnhancersBound = true;

  root.addEventListener("click", async (ev) => {
    const traitBtn = ev.target.closest?.("[data-fu-trait]");
    const bondBtn  = ev.target.closest?.("[data-fu-bond]");
    if (!traitBtn && !bondBtn) return;

    const btn = traitBtn || bondBtn;
    if (disableOnce(btn)) return;

    try {
      const msgEl  = btn.closest?.(".message");
      const msgId  = msgEl?.dataset?.messageId;
      const chatMsg = msgId ? game.messages.get(msgId) : null;
      if (!chatMsg) return;

      const payload = await getPayloadFromMsg(chatMsg);
      if (!payload) return ui.notifications?.error("Missing payload on the card.");

      // Ownership gate
      const atkUuid = payload?.meta?.attackerUuid ?? null;
      const attackerActor = await getActorFromUuidMaybe(atkUuid);
      if (!ensureOwner(attackerActor)) return;

      // Common guard: need an Accuracy block
      const A = payload.accuracy;
      if (!A) return ui.notifications?.warn("No Accuracy check available.");

      // Fresh copy to mutate
      const next = foundry.utils.deepClone(payload);
      next.meta = next.meta || {};
      next.meta.invoked = next.meta.invoked || { trait:false, bond:false };

      // ====== INVOKE TRAIT ======
      if (traitBtn) {
        if (next.meta.invoked.trait) return ui.notifications?.warn("Trait already invoked for this action.");

        // Dialog: choose which die(s) to reroll
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
                <option v
