// ============================================================================
//  PseudoAnimationNetListener – socket receiver for pseudo-animations
//  Foundry VTT v12
//  Channel: module.fabula-ultima-companion
//
//  What this does:
//  - Listens for { type: "ONI_PSEUDO_ANIM_PLAY" }
//  - Rebuilds the animation function from the embedded script string
//  - Resolves token UUIDs to Token placeables on THIS client
//  - Runs the script locally (visual-only; no document changes)
//
//  IMPORTANT:
//  - This file should be loaded by your module on EVERY client (GM + players)
//    so they can react when the GM triggers an ActionAnimationHandler run.
// ============================================================================

(() => {
  const TAG = "[ONI][PseudoAnimNet]";
  const MODULE_ID = "fabula-ultima-companion";
  const CHANNEL = `module.${MODULE_ID}`;

  // Install once per client session
  if (globalThis.ONI_PSEUDO_ANIM_NET_INSTALLED) {
    console.log(`${TAG} Already installed.`);
    return;
  }
  globalThis.ONI_PSEUDO_ANIM_NET_INSTALLED = true;

  // Per-client de-dupe (runId -> true)
  const SEEN = (globalThis.ONI_PSEUDO_ANIM_SEEN ||= new Set());

  async function resolveTokenPlaceable(tokenLike) {
    try {
      if (!tokenLike) return null;

      if (typeof tokenLike === "string") {
        const doc = await fromUuid(tokenLike);
        if (!doc) return null;
        if (doc?.object) return doc.object;
        if (doc?.document?.object) return doc.document.object;
        return null;
      }

      if (tokenLike?.document && tokenLike?.center && tokenLike?.id) return tokenLike;
      if (tokenLike?.object) return tokenLike.object;
      return null;
    } catch (e) {
      console.warn(`${TAG} resolveTokenPlaceable failed:`, e);
      return null;
    }
  }

  async function resolveTargets(targetUuids) {
    const arr = Array.isArray(targetUuids) ? targetUuids : [];
    const out = [];
    for (const u of arr) {
      const tok = await resolveTokenPlaceable(u);
      if (tok) out.push(tok);
    }
    return out;
  }

  async function waitUntil(ts) {
    const delay = Math.max(0, Number(ts ?? 0) - Date.now());
    if (delay <= 0) return;
    await new Promise(r => setTimeout(r, delay));
  }

  // The actual executor for net packets
  async function runPseudoFromPacket(p) {
    const runId = p?.runId;
    if (!runId) return;

    if (SEEN.has(runId)) {
      // Prevent double-run if the packet gets delivered twice.
      return;
    }
    SEEN.add(runId);

    // If this client is the sender GM, ignore (GM already ran it locally).
    if (game.user?.isGM && p?.senderUserId && p.senderUserId === game.user.id) {
      return;
    }

    // Scene guard: only run if we're on the same scene.
    const sceneId = p?.sceneId ?? null;
    if (sceneId && canvas?.scene?.id && canvas.scene.id !== sceneId) {
      console.log(`${TAG} Packet sceneId mismatch. Ignoring. packet=${sceneId} local=${canvas.scene.id}`);
      return;
    }

    // Start-time sync (best-effort)
    await waitUntil(p?.scheduledAt);

    // Resolve attacker/targets into Token placeables
    await resolveTokenPlaceable(p?.attackerUuid); // optional resolve (script can resolve too)
    const targets  = await resolveTargets(p?.targetUuids);

    // Prepare arguments for the embedded script
    const actionPayload = p?.actionPayload ?? {};

    // Compile + execute
    const script = String(p?.script ?? "").trim();
    if (!script) return;

    let fn;
    try {
      fn = new Function("payload", "targets", `"use strict";\n${script}`);
    } catch (e) {
      console.error(`${TAG} Failed compiling embedded pseudo script:`, e);
      return;
    }

    // Auto timing hooks (so offset/default gates work consistently)
    try { Hooks?.callAll?.("oni:animationStart", { payload: actionPayload, targets, runId }); } catch (_) {}

    try {
      await Promise.resolve(fn(actionPayload, targets));
    } catch (e) {
      console.error(`${TAG} Embedded pseudo script runtime error:`, e);
    } finally {
      try { Hooks?.callAll?.("oni:animationEnd", { payload: actionPayload, targets, runId }); } catch (_) {}
    }
  }

  // Socket binding
  Hooks.once("ready", () => {
    if (!game?.socket) {
      console.warn(`${TAG} game.socket not available; listener not installed.`);
      return;
    }

    console.log(`${TAG} Installing socket listener on ${CHANNEL}`);

    game.socket.on(CHANNEL, (data) => {
      try {
        if (!data) return;
        if (data.type === "ONI_PSEUDO_ANIM_PLAY") {
          runPseudoFromPacket(data.payload);
        }
      } catch (e) {
        console.error(`${TAG} Socket handler error:`, e);
      }
    });
  });
})();
