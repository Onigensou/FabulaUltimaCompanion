/**
 * [ONI][PseudoAnim] Listener (Foundry VTT v12)
 * - Boots on every client
 * - Listens for socket events on "module.fabula-ultima-companion"
 * - Executes registered pseudo animations by scriptId (safe registry)
 */

(() => {
  const TAG = "[ONI][PseudoAnim][Listener]";
  const SOCKET_NS = "module.fabula-ultima-companion";
  const DEBUG = true;

  function log(...args) { if (DEBUG) console.log(TAG, ...args); }
  function warn(...args) { console.warn(TAG, ...args); }
  function err(...args) { console.error(TAG, ...args); }

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // Registry: add more pseudo animations here over time
  // ---------------------------------------------------------------------------
  const REGISTRY = {};

  // Tween helper (same idea as your demo)
  function animateJump(obj, fromX, fromY, toX, toY, duration, heightPx) {
    return new Promise(resolve => {
      const startTime = performance.now();
      const ticker = canvas.app.ticker;

      const update = () => {
        const now = performance.now();
        const elapsed = now - startTime;
        const t = Math.min(elapsed / duration, 1);

        const x = fromX + (toX - fromX) * t;
        const y = fromY + (toY - fromY) * t;

        const arc = Math.sin(t * Math.PI) * heightPx;
        obj.x = x;
        obj.y = y - arc;

        if (t >= 1) {
          ticker.remove(update);
          resolve();
        }
      };

      ticker.add(update);
    });
  }

  // Clone token into PIXI.Sprite (texture-safe approach from your demos)
  async function createActorSpriteFromToken(token) {
    const texSrc = token.document.texture.src;
    const baseObj = token.mesh ?? token.icon;
    let texture;

    if (baseObj?.texture) texture = baseObj.texture;
    else texture = await loadTexture(texSrc);

    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.x = token.center.x;
    sprite.y = token.center.y;

    if (baseObj) {
      sprite.width  = baseObj.width;
      sprite.height = baseObj.height;
    }

    sprite.zIndex = 5000;
    canvas.stage.sortableChildren = true;
    canvas.stage.addChild(sprite);
    canvas.stage.sortChildren();

    return sprite;
  }

  // ---------------------------------------------------------------------------
  // TEST SCRIPT: jumpSelf
  // - Uses casterTokenUuid as performer
  // - Plays sound during jump
  // ---------------------------------------------------------------------------
  REGISTRY.jumpSelf = async function jumpSelf(ctx) {
    const { runId, casterToken, params } = ctx;

    if (!casterToken) throw new Error("jumpSelf requires casterTokenUuid to resolve a caster token.");

    const jumpHeight = Number(params?.jumpHeight ?? 80);
    const durationUp = Number(params?.durationUp ?? 180);
    const durationDown = Number(params?.durationDown ?? 220);
    const soundSrc = params?.soundSrc ?? "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Fall.ogg";
    const soundVolume = Number(params?.soundVolume ?? 1.0);

    // Per-client concurrency guard (prevents spam overlap on the same client)
    globalThis.__ONI_PSEUDO_ANIM_GUARD__ ??= new Set();
    if (globalThis.__ONI_PSEUDO_ANIM_GUARD__.has(runId)) {
      warn("Guard: already running runId:", runId);
      return;
    }
    globalThis.__ONI_PSEUDO_ANIM_GUARD__.add(runId);

    const baseMesh = casterToken.mesh ?? casterToken.icon;
    const originalTokenVisible = casterToken.visible;
    const originalMeshVisible = baseMesh?.visible ?? true;

    let sprite;

    try {
      if (!canvas?.ready) throw new Error("Canvas not ready on this client.");

      sprite = await createActorSpriteFromToken(casterToken);

      // Hide the real token on THIS client (same technique as your demo)
      if (baseMesh) baseMesh.visible = false;
      casterToken.visible = false;

      // play sound (broadcast=false here: we already synced by socket)
      AudioHelper.play({ src: soundSrc, volume: soundVolume, autoplay: true, loop: false }, false);

      const startX = sprite.x;
      const startY = sprite.y;

      // Jump up & down in-place
      await animateJump(sprite, startX, startY, startX, startY, durationUp, jumpHeight);
      await wait(40);
      await animateJump(sprite, startX, startY, startX, startY, durationDown, jumpHeight);

    } finally {
      if (sprite) {
        canvas.stage.removeChild(sprite);
        // IMPORTANT: do NOT destroy(true) (texture safety per your demos)
        sprite.destroy();
      }
      if (baseMesh) baseMesh.visible = originalMeshVisible;
      casterToken.visible = originalTokenVisible;

      globalThis.__ONI_PSEUDO_ANIM_GUARD__.delete(runId);
    }
  };

  // ---------------------------------------------------------------------------
  // Socket Receiver
  // ---------------------------------------------------------------------------
  async function onSocketMessage(msg) {
    try {
      if (!msg || msg.type !== "oni.pseudo.play") return;

      const runId = msg.runId ?? "NO_RUNID";
      log(`RECV runId=${runId} scriptId=${msg.scriptId}`, msg);

      const scriptFn = REGISTRY[msg.scriptId];
      if (!scriptFn) throw new Error(`Unknown scriptId="${msg.scriptId}" (not registered on this client).`);

      // Resolve caster token (if present)
      let casterToken = null;
      if (msg.casterTokenUuid) {
        const casterDoc = await fromUuid(msg.casterTokenUuid);
        // casterDoc may be TokenDocument
        casterToken = casterDoc?.object ?? canvas.tokens?.get(casterDoc?.id) ?? null;
      }

      // Resolve targets (optional)
      const targetTokens = [];
      for (const tuuid of (msg.targetTokenUuids ?? [])) {
        const tdoc = await fromUuid(tuuid);
        const tok = tdoc?.object ?? canvas.tokens?.get(tdoc?.id) ?? null;
        if (tok) targetTokens.push(tok);
      }

      const ctx = {
        runId,
        msg,
        casterToken,
        targetTokens,
        params: msg.params ?? {},
      };

      await scriptFn(ctx);
      log(`DONE runId=${runId} scriptId=${msg.scriptId}`);

    } catch (e) {
      err("Socket playback error:", e);
    }
  }

  Hooks.once("ready", () => {
    // install socket listener
    game.socket.on(SOCKET_NS, onSocketMessage);
    log("Listener ready. Registered scripts:", Object.keys(REGISTRY));
  });

})();
