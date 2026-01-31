// scripts/main.js
let socket;

/* ================================
 *  GM-side helpers (reusable)
 * ================================ */

/** Decrease HP helper (runs only on GM) */
async function gmDecreaseHP({ sceneId, tokenId, amount = 10, requestorId } = {}) {
  if (!game.user.isGM) return { ok: false, error: "Not GM" };
  try {
    const scene = game.scenes.get(sceneId) ?? canvas?.scene;
    if (!scene) return { ok: false, error: "Scene not found." };

    const tokDoc = scene.tokens.get(tokenId);
    if (!tokDoc) return { ok: false, error: "Token not found." };

    const actor = tokDoc.actor;
    if (!actor) return { ok: false, error: "Actor not found on token." };

    const PATH = "system.props.current_hp";
    const cur = Number(foundry.utils.getProperty(actor, PATH) ?? 0);
    const delta = Math.abs(Number(amount));
    const next = Math.max(0, cur - delta);

    await actor.update({ [PATH]: next });

    const by = game.users.get(requestorId)?.name ?? "Unknown User";
    await ChatMessage.create({
      content: `🛠️ <b>${actor.name}</b> HP ${cur} → ${next} (−${delta}) <i>[requested by ${by}]</i>`
    });

    return { ok: true, actorName: actor.name, cur, next, delta };
  } catch (err) {
    console.error(err);
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Run a world macro as GM (by name or id), return its result */
async function gmInvokeWorldMacro({ name, id, args = [] } = {}) {
  if (!game.user.isGM) return { ok: false, error: "Not GM" };
  const macro = id ? game.macros.get(id) : game.macros.getName(name);
  if (!macro) return { ok: false, error: "Macro not found" };
  const result = await macro.execute(...args);
  return { ok: true, result };
}

/** Run a macro as GM, but first select the player's token so unchanged macros work */
async function gmRunMacroWithPlayerContext({
  macroName,
  macroId,
  requestorId,
  tokenId,
  args = []
} = {}) {
  if (!game.user.isGM) return { ok: false, error: "Not GM" };

  // Resolve macro
  const macro = macroId ? game.macros.get(macroId) : game.macros.getName(macroName);
  if (!macro) return { ok: false, error: "Macro not found" };

  // Resolve acting token
  let actingTokenDoc = null;

  if (tokenId) {
    actingTokenDoc = canvas.scene?.tokens?.get(tokenId) ?? null;
  }
  if (!actingTokenDoc && requestorId) {
    const reqUser = game.users.get(requestorId);
    const charId = reqUser?.character?.id;
    if (charId) {
      actingTokenDoc = canvas.tokens?.placeables?.find(t => t.actor?.id === charId)?.document ?? null;
    }
  }
  if (!actingTokenDoc) return { ok: false, error: "No suitable token for player on this scene" };

  // Save & replace GM selection
  const prevSelection = canvas.tokens.controlled.map(t => t.id);
  try {
    canvas.tokens.releaseAll();
    const placeable = actingTokenDoc.object ?? actingTokenDoc._object;
    await placeable?.control({ releaseOthers: true });

    // Execute macro as GM with the player's token selected
    const result = await macro.execute(...args);
    return { ok: true, result };
  } catch (e) {
    console.error(e);
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    // Restore selection
    canvas.tokens.releaseAll();
    for (const id of prevSelection) {
      const tok = canvas.tokens.get(id);
      tok?.control({ releaseOthers: false });
    }
  }
}

/* ================================
 *  SocketLib registration
 * ================================ */

Hooks.once("socketlib.ready", () => {
  console.log("[FU Companion] SocketLib ready");
  socket = socketlib.registerModule("fabula-ultima-companion");

  // --- Existing demo handlers ---
  socket.register("hello", showHelloMessage);
  socket.register("add", add);

  // --- Core GM ops ---
  socket.register("decreaseHP", gmDecreaseHP);

  // Handler→Handler chaining demo
  socket.register("relayDecreaseHP", async (payload) => gmDecreaseHP(payload));

  // Run a world macro as GM
  socket.register("invokeWorldMacro", async (payload) => gmInvokeWorldMacro(payload));

  // Run a macro as GM while selecting the player's token (no per-macro edits)
  socket.register("runMacroAsGMWithPlayerContext", async (payload) => gmRunMacroWithPlayerContext(payload));

  console.log("[FU Companion] Registered handlers: hello, add, decreaseHP, relayDecreaseHP, invokeWorldMacro, runMacroAsGMWithPlayerContext");
});

/* ================================
 *  Ready hook (optional demo calls)
 * ================================ */

Hooks.once("ready", async () => {
  console.log("[FU Companion] World ready");
  if (!socket) {
    console.warn("[FU Companion] Socket not ready yet.");
    return;
  }

  // Demo (optional; safe to remove)
  try {
    socket.executeForEveryone("hello", game.user.name);
    socket.executeForEveryone(showHelloMessage, game.user.name);
    const result = await socket.executeAsGM("add", 5, 3);
    console.log(`[FU Companion] GM calculated: ${result}`);
  } catch (e) {
    console.warn("[FU Companion] Demo calls failed:", e);
  }
});

/* ================================
 *  Local helpers used by demos
 * ================================ */

function showHelloMessage(userName) {
  console.log(`User ${userName} says hello!`);
}

function add(a, b) {
  console.log("The addition is performed on a GM client.");
  return a + b;
}

// scripts/main.js
import { runJRPGSpeechBubble } from "./features/speech-bubble.js";

const MODULE_ID = "fabula-ultima-companion";
const CURSOR_URL = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Cursor1.ogg";

Hooks.once("init", () => {
  // Prepare api bag
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api ??= {};
    mod.api.sfx ??= {};
    mod.api.speechBubble = () => runJRPGSpeechBubble();
  }
});

Hooks.once("ready", () => {
  // ---- Preload & cache the tiny cursor sound -------------------------------
  try {
    // Foundry ships Howler. Create a single Howl instance and reuse it.
    const howl = new Howl({
      src: [CURSOR_URL],
      preload: true,
      html5: false,     // use WebAudio buffer (snappier for short SFX)
      volume: 0.55
    });
    const mod = game.modules.get(MODULE_ID);
    if (mod) mod.api.sfx.cursor = howl;
  } catch (err) {
    console.warn(`[${MODULE_ID}] Failed to cache cursor SFX`, err);
  }
});

/* ================================
 *  ONI: Obtain Chat Styling (Global)
 *  - Hides the chat header row (GM name/portrait/delete/time)
 *  - Compact JRPG obtain panel (icon + "Obtain NAME!")
 *  - Theme match: parchment + warm borders, strong readability
 *  Applies ONLY when message.flags.oni.obtain === true
 * ================================ */

Hooks.once("ready", () => {
  // 1) Inject CSS once per client
  if (!document.getElementById("oni-obtain-style")) {
    const style = document.createElement("style");
    style.id = "oni-obtain-style";
    style.textContent = `
      /* Scope EVERYTHING to only obtain messages */
      .chat-message.oni-obtain-msg {
        padding: 0 !important;
        background: transparent !important;
        border: none !important;
      }

      /* Remove the entire Foundry header row (GM line / portrait / trash / time) */
      .chat-message.oni-obtain-msg header.message-header {
        display: none !important;
      }

      /* Remove Foundry's default content padding so our panel is compact */
      .chat-message.oni-obtain-msg .message-content {
        padding: 0 !important;
      }

      /* --- Card theme: warm parchment, readable text --- */
      .oni-obtain-card{
        padding: 10px 12px;
        border-radius: 12px;

        /* Slightly warm parchment that still pops on darker chat backgrounds */
        background: rgba(248, 242, 233, 0.97);

        /* Warm bronze border to match "JRPG UI" vibe */
        border: 1px solid rgba(140, 105, 70, 0.35);

        /* Subtle inner highlight + soft shadow */
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.55),
          0 10px 24px rgba(0,0,0,0.22);
      }

      .oni-obtain-row{
        display: flex;
        align-items: center;
        gap: 10px;
        justify-content: flex-start;
        padding: 2px 2px;
      }

      .oni-obtain-icon{
        width: 38px;
        height: 38px;
        border-radius: 8px;

        /* Icon frame */
        border: 1px solid rgba(110, 80, 55, 0.30);
        background: rgba(255,255,255,0.30);

        box-shadow: 0 6px 14px rgba(0,0,0,0.18);
        object-fit: cover;
        flex: 0 0 auto;
      }

      .oni-obtain-text{
        font-weight: 900;
        font-size: 16px;

        /* Strong readable dark text */
        color: rgba(35, 22, 16, 0.95);

        letter-spacing: 0.2px;
        line-height: 1.2;
      }

      .oni-obtain-name{
        text-decoration: underline;
        text-underline-offset: 2px;
      }
    `;
    document.head.appendChild(style);
  }

  // 2) Tag ONLY our obtain messages so CSS stays safe
  Hooks.on("renderChatMessage", (message, html) => {
    const isObtain = message?.flags?.oni?.obtain === true;
    if (!isObtain) return;
    html.addClass("oni-obtain-msg");
  });
});

// ---- Chat button ------------------------------------------------------------
// Put a small "megaphone" button in the Chat sidebar controls.
// It triggers the module feature without needing a macro.
// ---- Chat button (robust injector) -----------------------------------------
Hooks.on("renderChatLog", (app, html) => {
  const MODULE_ID = "fabula-ultima-companion";

  // Avoid duplicates if ChatLog re-renders
  if (html[0].querySelector?.(".fu-speak-btn")) return;

  // 1) Find the controls block or create a safe container row
  let controls =
    html[0].querySelector("#chat-controls") ||
    html[0].querySelector(".chat-controls") ||
    html[0].querySelector(".control-buttons") ||
    html[0];

  // Ensure a dedicated row we control (works across themes/systems)
  let row = controls.querySelector(".fu-speak-row");
  if (!row) {
    row = document.createElement("div");
    row.className = "fu-speak-row";
    // place it right under existing controls (roll-mode select & icon row)
    // If #chat-controls exists, append there; else append to ChatLog root.
    controls.appendChild(row);
  }

  // 2) Minimal CSS (once)
  if (!document.getElementById("fu-speak-style")) {
    const style = document.createElement("style");
    style.id = "fu-speak-style";
    style.textContent = `
      /* Container row matches chat spacing */
      .fu-speak-row { display:flex; gap:6px; align-items:center; margin:6px 0 2px; }
      .fu-speak-btn {
        display:inline-flex; align-items:center; gap:6px;
        padding: 4px 8px; height: 26px; border-radius: 6px;
        background: var(--color-bg-option, rgba(0,0,0,.15));
        color: var(--color-text, #ddd); border: 1px solid var(--color-border-light-tertiary, rgba(255,255,255,.15));
        cursor: pointer; font-size: 12px; text-decoration: none;
      }
      .fu-speak-btn i { width:14px; text-align:center; }
      .fu-speak-btn:hover { filter: brightness(1.08); }
      .fu-speak-btn.disabled { opacity:.45; cursor:not-allowed; }
    `;
    document.head.appendChild(style);
  }

  // 3) Build the button
  const btn = document.createElement("a");
  btn.className = "fu-speak-btn";
  btn.title = "Speak (JRPG Bubble)";
  btn.innerHTML = `<i class="fas fa-bullhorn"></i><span>Speak</span>`;
  row.appendChild(btn);

  // 4) Enable/disable logic for Players (needs a linked Actor token on scene)
  const updateEnabledState = () => {
    if (game.user.isGM) return btn.classList.remove("disabled");
    const linked = game.user?.character ?? null;
    if (!linked) return btn.classList.add("disabled");
    const onScene = canvas?.tokens?.placeables?.some(t => t?.document?.actorId === linked.id);
    if (onScene) btn.classList.remove("disabled"); else btn.classList.add("disabled");
  };
  updateEnabledState();

  Hooks.on("controlToken", updateEnabledState);
  Hooks.on("updateToken", updateEnabledState);
  Hooks.on("canvasReady",  updateEnabledState);
  Hooks.on("updateScene",  updateEnabledState);

  // 5) Click → run feature
  btn.addEventListener("click", async () => {
    if (btn.classList.contains("disabled")) return;
    await game.modules.get(MODULE_ID)?.api?.speechBubble?.();
  });
});
