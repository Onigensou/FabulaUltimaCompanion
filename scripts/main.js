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
