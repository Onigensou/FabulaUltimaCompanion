// applyDamage-button.js — Foundry VTT v12
// Global delegated listener for chat-card buttons using [data-fu-apply].
//
// REFACTOR (Manager-based):
// • Clicking Apply loads the stored card payload from ChatMessage flags
//   (flags.fabula-ultima-companion.actionCard.payload)
// • Then calls the ActionManager in mode="apply".
//
// This file should be loaded by your module on ready (client-side).

const MODULE_ID = "fu-chatbtn";
const MODULE_NS = "fabula-ultima-companion";
const ACTION_MANAGER_MACRO = "ActionManager";

Hooks.once("ready", async () => {

  // Players should NOT see/press Apply (or any dismiss button),
  // but SHOULD see Invoke Trait/Bond.
  if (!game.user?.isGM) {
    const style = document.createElement("style");
    style.id = "fu-chatbtn-hide-player-buttons";
    style.textContent = `
      [data-fu-apply],
      [data-action="dismiss"] {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  const root = document.querySelector("#chat-log") || document.body;
  if (!root) return;

  // Idempotent bind
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

    // Try to resolve the ChatMessage
    const msgEl = btn.closest?.(".message");
    const msgId = msgEl?.dataset?.messageId;
    const chatMsg = msgId ? game.messages?.get(msgId) : null;

    // Parse embedded args from the card
    let btnArgs = {};
    try {
      btnArgs = btn.dataset.fuArgs ? JSON.parse(btn.dataset.fuArgs) : {};
    } catch {
      btnArgs = {};
    }

    // Pull the stored payload (CreateActionCard persists it here)
    const cardPayload = chatMsg?.getFlag?.(MODULE_NS, "actionCard")?.payload ?? null;

    if (!chatMsg || !msgId) {
      ui.notifications?.error("Apply: could not resolve the ChatMessage for this card.");
      btn.dataset.fuLock = "0";
      return;
    }

    if (!cardPayload) {
      ui.notifications?.error("Apply: this card has no stored payload. (Did CreateActionCard set the flag?)");
      btn.dataset.fuLock = "0";
      return;
    }

    // Visual feedback (optimistic). If manager fails, we revert.
    const prevText = btn.textContent;
    const prevDisabled = btn.disabled;
    const prevFilter = btn.style.filter;

    btn.disabled = true;
    btn.textContent = "Applying...";
    btn.style.filter = "grayscale(0.5)";

    const stamp = msgEl?.querySelector?.("[data-fu-stamp]");
    if (stamp) {
      stamp.textContent = `Applying (GM): ${game.user.name}`;
      stamp.style.opacity = ".9";
    }

    try {
      // Build the apply request for ActionManager
      globalThis.__PAYLOAD = {
        mode: "apply",
        request: {
          source: "chat-apply",
          chatMsgId: msgId,
          cardPayload,
          btnArgs
        }
      };

      const managerMacro = game.macros?.getName?.(ACTION_MANAGER_MACRO);
      if (!managerMacro) {
        throw new Error(`Apply: Macro "/${ACTION_MANAGER_MACRO}/" not found.`);
      }

      await managerMacro.execute();

      // Success UI
      btn.disabled = true;
      btn.textContent = "Applied ✔";
      btn.style.filter = "grayscale(1)";

      if (stamp) {
        stamp.textContent = `Applied by GM: ${game.user.name}`;
        stamp.style.opacity = ".9";
      }

      ui.notifications?.info?.(`Applied by GM: ${game.user.name}`);

      console.log(`[${MODULE_ID}] Apply → ActionManager executed by GM`, { chatMsgId: msgId });

    } catch (e) {
      console.error(`[${MODULE_ID}] Apply → ActionManager failed`, e);
      ui.notifications?.error?.("Apply failed (see console)." );

      // Revert UI so GM can try again
      btn.disabled = prevDisabled;
      btn.textContent = prevText;
      btn.style.filter = prevFilter;

      if (stamp) {
        stamp.textContent = "";
      }

    } finally {
      btn.dataset.fuLock = "0";
    }

  }, { capture: false });

  console.log(`[${MODULE_ID}] ready — delegated Apply listener installed (Manager-based)`);

});
