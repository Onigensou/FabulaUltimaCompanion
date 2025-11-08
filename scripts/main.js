// scripts/main.js
let socket;

// Wait for SocketLib, then register under your MODULE namespace.
// (Using your module id: "fabula-ultima-companion")
Hooks.once("socketlib.ready", () => {
  console.log("[FU Companion] SocketLib ready");
  socket = socketlib.registerModule("fabula-ultima-companion");

  // --- Demo handlers you already had ---
  socket.register("hello", showHelloMessage);
  socket.register("add", add);

  // --- NEW: privileged HP decrease handler (GM-side write) ---
  socket.register("decreaseHP", async ({ sceneId, tokenId, amount = 10, requestorId } = {}) => {
    if (!game.user.isGM) return { ok: false, error: "Not GM" };
    try {
      const scene = game.scenes.get(sceneId) ?? canvas?.scene;
      if (!scene) return { ok: false, error: "Scene not found." };

      const tokDoc = scene.tokens.get(tokenId);
      if (!tokDoc) return { ok: false, error: "Token not found." };

      const actor = tokDoc.actor;
      if (!actor) return { ok: false, error: "Actor not found on token." };

      // Your sheet path:
      const PATH = "system.props.current_hp";
      const cur = Number(foundry.utils.getProperty(actor, PATH) ?? 0);
      const delta = Math.abs(Number(amount));
      const next = Math.max(0, cur - delta);

      await actor.update({ [PATH]: next });

      // Optional GM-side echo
      const by = game.users.get(requestorId)?.name ?? "Unknown User";
      await ChatMessage.create({
        content: `🛠️ <b>${actor.name}</b> HP ${cur} → ${next} (−${delta}) <i>[requested by ${by}]</i>`
      });

      return { ok: true, actorName: actor.name, cur, next, delta };
    } catch (err) {
      console.error(err);
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  console.log("[FU Companion] Registered socket handlers: hello, add, decreaseHP");
});

// Your original ready hook demo is fine; keep it if you like.
Hooks.once("ready", async () => {
  console.log("[FU Companion] World ready");
  if (!socket) {
    console.warn("[FU Companion] Socket not ready yet.");
    return;
  }

  // Demo calls (optional)
  try {
    socket.executeForEveryone("hello", game.user.name);
    socket.executeForEveryone(showHelloMessage, game.user.name);
    const result = await socket.executeAsGM("add", 5, 3);
    console.log(`[FU Companion] GM calculated: ${result}`);
  } catch (e) {
    console.warn("[FU Companion] Demo calls failed:", e);
  }
});

function showHelloMessage(userName) {
  console.log(`User ${userName} says hello!`);
}

function add(a, b) {
  console.log("The addition is performed on a GM client.");
  return a + b;
}
