/**
 * Fabula Ultima Companion
 * Lancer Initiative - End of Round announcer (module version)
 *
 * Behavior:
 * - Detects lancer-initiative deactivation via combat.turn -> null
 * - Checks if any combatants still have activations left (flags.lancer-initiative.activations.value)
 * - If none left:
 *    - posts a headerless chat card showing:
 *        Row 1: "End of Round X" (big)
 *        Row 2: "Next Round" button (GM only)
 *    - Players see only the End of Round row (button row hidden)
 * - GM button advances to next round
 *
 * Notes:
 * - Uses MODULE_ID as flag scope (valid because module is active)
 * - Does NOT use ChatMessage flags
 */

const MODULE_ID = "fabula-ultima-companion";
const NS = "oni-li-eor";          // DOM/class namespace only
const LI = "lancer-initiative";
const FLAG_KEY_ANNOUNCED = "liEndOfRound.announcedRound";
const DEBUG = false; // flip true if you ever need logs again

function dlog(op, ...args) {
  if (!DEBUG) return;
  console.log(`%c[ONI][LI-EOR][${op}]`, "color:#7fd7ff;font-weight:700;", ...args);
}

function injectStylesOnce() {
  const id = `${NS}-style`;
  if (document.getElementById(id)) return;

  const styleEl = document.createElement("style");
  styleEl.id = id;
  styleEl.textContent = `
    /* Marked End-of-Round chat messages: hide header (speaker/portrait/meta/bin) */
    .chat-message.${NS}__msg .message-header { display: none !important; }
    .chat-message.${NS}__msg .message-metadata { display: none !important; }
    .chat-message.${NS}__msg .message-delete { display: none !important; }
    .chat-message.${NS}__msg .message-edit { display: none !important; }
    .chat-message.${NS}__msg .message-sender { display: none !important; }

    /* Tighten spacing so it's "just content" */
    .chat-message.${NS}__msg { padding-top: 6px !important; }
    .chat-message.${NS}__msg .message-content { margin: 0 !important; }

    /* Optional: make our block look clean */
    .chat-message.${NS}__msg .${NS} { padding: 2px 0 !important; }
    .chat-message.${NS}__msg .${NS}__title { margin: 0 !important; font-weight: 800 !important; }
    .chat-message.${NS}__msg .${NS}__next-round { width: 100% !important; }
  `;
  document.head.appendChild(styleEl);
}

function getPendingActivationsTotal(combat) {
  return combat.combatants.reduce((sum, c) => {
    const v = c.getFlag(LI, "activations.value") ?? 0;
    return sum + Math.max(0, v);
  }, 0);
}

function getSilentSpeaker() {
  // Speaker must exist internally, but we hide header anyway
  return { scene: null, actor: null, token: null, alias: "" };
}

async function maybeAnnounceEndOfRound(combat, reason) {
  if (!combat) return;
  if ((combat.round ?? 0) <= 0) return;    // LI activations meaningful after round starts
  if (combat.turn !== null) return;        // only when deactivated state

  const pendingTotal = getPendingActivationsTotal(combat);
  dlog("CHK", "maybeAnnounceEndOfRound", { reason, round: combat.round, pendingTotal });

  if (pendingTotal > 0) return;
  if (!game.user?.isGM) return;

  // Deduplicate per round (module flag scope)
  const announced = combat.getFlag(MODULE_ID, FLAG_KEY_ANNOUNCED);
  if (announced === combat.round) return;

  try {
    await combat.setFlag(MODULE_ID, FLAG_KEY_ANNOUNCED, combat.round);
  } catch (e) {
    // If flag write fails, don't block the announcement
    console.warn("[ONI][LI-EOR] setFlag failed", e);
  }

  const roundNum = combat.round ?? 0;

  const content = `
    <div class="${NS}" data-oni-li-eor="1" style="text-align:right;">
      <div class="${NS}__title" style="font-size: 1.6em; line-height: 1.1;">
        End of Round ${roundNum}
      </div>

      <div class="${NS}__controls" style="margin-top:10px;">
        <button
          type="button"
          class="${NS}__next-round"
          data-combat-id="${combat.id}"
        >
          Next Round
        </button>
      </div>
    </div>
  `;

  await ChatMessage.create({
    speaker: getSilentSpeaker(),
    content,
    type: CONST.CHAT_MESSAGE_TYPES.OTHER,
  });
}

function installLiEndOfRoundHooks() {
  // Avoid double-install if your module reloads during dev
  if (globalThis.__ONI_LI_EOR_MODULE_INSTALLED__) return;
  globalThis.__ONI_LI_EOR_MODULE_INSTALLED__ = true;

  injectStylesOnce();

  const prevTurnByCombatId = new Map();

  // Style + GM button wiring
  Hooks.on("renderChatMessage", (message, html) => {
    injectStylesOnce();

    const root = html?.[0]?.querySelector?.(`div.${NS}[data-oni-li-eor="1"]`);
    if (!root) return;

    const msgEl = html?.[0];
    if (msgEl?.classList) msgEl.classList.add(`${NS}__msg`);

    const btn = root.querySelector(`button.${NS}__next-round`);
    const controlsRow = root.querySelector(`.${NS}__controls`);

    // Players: hide the entire button row
    if (!game.user?.isGM) {
      if (controlsRow) controlsRow.style.display = "none";
      if (btn) btn.style.display = "none";
      return;
    }

    // GM: wire click
    if (!btn) return;

    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      const combatId = btn.dataset.combatId;
      const combat = game.combats?.get(combatId);
      if (!combat) return ui.notifications?.warn("[LI EoR] Combat not found.");

      btn.disabled = true;
      try {
        await combat.nextRound();
      } catch (e) {
        console.error("[ONI][LI-EOR] nextRound error", e);
        btn.disabled = false;
      }
    });
  });

  // Detect turn deactivation: turn -> null
  Hooks.on("preUpdateCombat", (combat, change) => {
    if (!Object.prototype.hasOwnProperty.call(change ?? {}, "turn")) return;
    prevTurnByCombatId.set(combat.id, combat.turn);
  });

  Hooks.on("updateCombat", async (combat, change) => {
    if (!Object.prototype.hasOwnProperty.call(change ?? {}, "turn")) return;

    const prevTurn = prevTurnByCombatId.get(combat.id);
    const looksLikeTurnNull = (change.turn === null && combat.turn === null);
    const deactivatedByPrev = (prevTurn !== null && prevTurn !== undefined && combat.turn === null);

    if (deactivatedByPrev || looksLikeTurnNull) {
      await Promise.resolve();
      await maybeAnnounceEndOfRound(combat, deactivatedByPrev ? "prevTurn->null" : "failsafe turn-null");
    }
  });

  // Reset dedupe when round changes
  Hooks.on("combatRound", async (combat) => {
    if (!game.user?.isGM) return;
    try {
      await combat.unsetFlag(MODULE_ID, FLAG_KEY_ANNOUNCED);
    } catch (e) {
      console.warn("[ONI][LI-EOR] unsetFlag failed", e);
    }
  });

  dlog("INIT", "Installed LI End of Round hooks (module).");
}

// Auto-install when Foundry is ready
Hooks.once("ready", () => {
  installLiEndOfRoundHooks();
});
