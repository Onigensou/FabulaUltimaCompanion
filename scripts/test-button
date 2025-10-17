// fu-chatbtn.js — Foundry VTT v12
// Global delegated listener for chat-card buttons using [data-fu-apply].
// Same method you approved, but auto-installed for every client via module.

const MODULE_ID = "fu-chatbtn";

Hooks.once("ready", () => {
  // Prefer #chat-log; fallback to body (some UIs change containers)
  const root = document.querySelector("#chat-log") || document.body;
  if (!root) return;

  // Idempotent (per client)
  if (root.__fuChatBtnBound) return;
  root.__fuChatBtnBound = true;

  root.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.("[data-fu-apply]");
    if (!btn) return;

    // Double-click / lag guard
    if (btn.dataset.fuLock === "1") return;
    btn.dataset.fuLock = "1";

    // Grab the chat message context
    const msgEl = btn.closest?.(".message");
    const msgId = msgEl?.dataset?.messageId;
    const chatMsg = msgId ? game.messages.get(msgId) : null;

    // Optional payload from button attribute
    let args = {};
    try { args = btn.dataset.fuArgs ? JSON.parse(btn.dataset.fuArgs) : {}; }
    catch { args = {}; }

    // GM-only guard
    if (!game.user?.isGM) {
      ui.notifications?.warn("Only the GM can press Apply.");
      btn.dataset.fuLock = "0"; // allow GM to press later
      return;
    }

    try {
      // --- POC UI feedback (you can keep/replace this) ---
      btn.disabled = true;
      btn.textContent = "Applied ✔";
      btn.style.filter = "grayscale(1)";

      const stamp = msgEl?.querySelector?.("[data-fu-stamp]");
      if (stamp) {
        stamp.textContent = `Applied by GM: ${game.user.name}`;
        stamp.style.opacity = ".9";
      }

      // --- Your real logic goes here ---
      // Example:
      // const adv = game.macros.getName("AdvanceDamage");
      // await adv?.execute({ __AUTO: true, __PAYLOAD: { ...args } });

      console.log(`[${MODULE_ID}] Apply clicked by GM:`, game.user.name, { msgId, chatMsg, args });
      ui.notifications?.info(`Applied by GM: ${game.user.name}`);
    } catch (err) {
      console.error(err);
      ui.notifications?.error("Apply failed (see console).");
      // revert + unlock so GM can try again
      btn.disabled = false;
      btn.textContent = "Apply (GM)";
      btn.style.filter = "";
      btn.dataset.fuLock = "0";
    }
  }, { capture: false });

  console.log(`[${MODULE_ID}] ready — global chat-button listener installed on this client`);
});
