/**
 * ONI – Module Script: Scene "Camera Follow Token" (DB Token) + Right-Click Walk
 * Foundry VTT v12 (Client-side)
 *
 * Player-only:
 * - GM client is NEVER affected.
 *
 * Uses Scene Flag (from your Scene Config custom tab):
 * - flags.fabula-ultima-companion.oniFabula.general.cameraFollowToken
 *
 * When the flag is true on the active scene:
 * - Locks camera zoom/pan
 * - Follows the Database token (resolved via DB Resolver)
 * - Right-click moves the Database token (collision-aware, gridless safe)
 *
 * If the Database token is not present yet:
 * - Camera stays locked/frozen
 * - When the Database token appears later, follow starts automatically
 *
 * Unlock condition:
 * - The scene flag is turned off (false)
 */
(() => {
  const GLOBAL_KEY = "__ONI_CAMERA_FOLLOW_DB_MODULE__";

  // Guard: avoid double-install if the file is loaded twice
  if (globalThis[GLOBAL_KEY]?.state?.installed) return;

  // GM is never affected
  if (game.user?.isGM) {
    globalThis[GLOBAL_KEY] = { state: { installed: true, disabledBecauseGM: true } };
    return;
  }

  // ---------------------------------------------------------------------------
  // CONFIG (match your module / scene flag structure)
  // ---------------------------------------------------------------------------
  const MODULE_ID = "fabula-ultima-companion";
  const FABULA_ROOT_KEY = "oniFabula";
  const GENERAL_KEY = "general";
  const CAMERA_FOLLOW_KEY = "cameraFollowToken";

  // Smooth follow tuning
  const SMOOTHING = 0.18; // 0.05–0.35 (higher = snappier)

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function safeGet(obj, path, fallback) {
    try {
      const parts = String(path).split(".");
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return fallback;
        cur = cur[p];
      }
      return (cur === undefined) ? fallback : cur;
    } catch {
      return fallback;
    }
  }

  function normalizeBoolean(v, fallback = false) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(s)) return true;
      if (["false", "0", "no", "n", "off"].includes(s)) return false;
    }
    return fallback;
  }

  function getSceneCameraFollowEnabled(scene) {
    const fab = scene?.flags?.[MODULE_ID]?.[FABULA_ROOT_KEY];
    const raw = safeGet(fab, `${GENERAL_KEY}.${CAMERA_FOLLOW_KEY}`, false);
    return normalizeBoolean(raw, false);
  }

  function smoothingAlpha(deltaFrames) {
    return 1 - Math.pow(1 - SMOOTHING, deltaFrames);
  }

  function addDomListener(state, el, type, fn, options) {
    el.addEventListener(type, fn, options);
    state.listeners.push(() => el.removeEventListener(type, fn, options));
  }

  async function resolveDbActor() {
    const API = window.FUCompanion?.api;
    if (!API?.getCurrentGameDb) return null;

    try {
      const res = await API.getCurrentGameDb();
      return res?.db ?? null;
    } catch {
      return null;
    }
  }

  function findDbTokenOnCanvas(dbActor) {
    if (!canvas?.ready || !canvas.tokens) return null;

    // Strong match: actorId
    const byActorId = canvas.tokens.placeables.find(t => t?.actor?.id === dbActor.id);
    if (byActorId) return byActorId;

    // Fallback: name match
    const byName = canvas.tokens.placeables.find(t => (t?.name === dbActor.name));
    if (byName) return byName;

    return null;
  }

  function isDbTokenDocument(tokenDoc, dbActor) {
    if (!tokenDoc || !dbActor) return false;
    if (tokenDoc.actorId && tokenDoc.actorId === dbActor.id) return true;
    if (tokenDoc.name && tokenDoc.name === dbActor.name) return true;
    return false;
  }

  // Movement helpers (right-click walk)
  function clampToSceneTopLeft(x, y, token) {
    const rect = canvas.dimensions?.sceneRect;
    if (!rect) return { x, y };

    const minX = rect.x;
    const minY = rect.y;
    const maxX = rect.x + rect.width - token.w;
    const maxY = rect.y + rect.height - token.h;

    return {
      x: Math.min(Math.max(x, minX), maxX),
      y: Math.min(Math.max(y, minY), maxY)
    };
  }

  function snapTopLeftIfGrid(x, y) {
    if (!canvas.grid || canvas.grid.type === CONST.GRID_TYPES.GRIDLESS) return { x, y };
    return canvas.grid.getSnappedPosition(x, y, 1);
  }

  function pointToTopLeftFromCenter(center, token) {
    return {
      x: center.x - (token.w / 2),
      y: center.y - (token.h / 2)
    };
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    installed: true,
    enabled: true,

    followEnabledForScene: false,
    activeSceneId: null,

    dbActorId: null,
    dbActorName: null,

    followTokenId: null,

    lockedScale: null,
    lockX: null,
    lockY: null,

    curX: null,
    curY: null,

    // "inactive" | "waiting" | "follow"
    mode: "inactive",

    // Right-click move queue
    isMoving: false,
    pendingDestination: null,

    tickerFn: null,
    hookIds: [],
    listeners: [],
    inputInstalled: false,
    isApplying: false
  };

  function getFollowToken() {
    if (!state.followTokenId) return null;
    return canvas.tokens?.get(state.followTokenId) ?? null;
  }

  async function attemptMoveTokenToCanvasPoint(destCanvasPoint) {
    const token = getFollowToken();
    if (!token) return;

    // Must own token to move it
    if (!token.document?.isOwner) return;

    // Treat click as desired center
    const origin = token.center;
    const destination = { x: destCanvasPoint.x, y: destCanvasPoint.y };

    // Find collision point (closest)
    let collision = null;
    try {
      collision = token.checkCollision(destination, {
        origin,
        mode: "closest",
        type: "move"
      });
    } catch {
      collision = null;
    }

    let finalCenter = destination;

    // If collision returned a vertex, stop there
    if (collision && typeof collision === "object" && typeof collision.x === "number" && typeof collision.y === "number") {
      finalCenter = { x: collision.x, y: collision.y };
    }

    // center -> top-left
    let { x, y } = pointToTopLeftFromCenter(finalCenter, token);

    // Snap attempt (skip if gridless), but avoid snapping into collision
    const snapped = snapTopLeftIfGrid(x, y);
    const snappedCenter = { x: snapped.x + token.w / 2, y: snapped.y + token.h / 2 };

    let snappedWouldCollide = false;
    try {
      const test = token.checkCollision(snappedCenter, { origin: token.center, mode: "any", type: "move" });
      snappedWouldCollide = (test === true);
    } catch {
      snappedWouldCollide = false;
    }

    if (!snappedWouldCollide) {
      x = snapped.x;
      y = snapped.y;
    }

    // Clamp inside scene
    ({ x, y } = clampToSceneTopLeft(x, y, token));

    await token.document.update({ x, y }, { animate: true });
  }

  async function consumeMoveQueue() {
    if (state.isMoving) return;
    state.isMoving = true;

    try {
      while (state.enabled && state.pendingDestination) {
        const dest = state.pendingDestination;
        state.pendingDestination = null;
        await attemptMoveTokenToCanvasPoint(dest);
      }
    } finally {
      state.isMoving = false;
    }
  }

  function removeInputBlockers() {
    for (const remove of state.listeners) remove();
    state.listeners = [];
    state.inputInstalled = false;
  }

  function ensureInputBlockersInstalled() {
    const view = canvas?.app?.view;
    if (!view) return;
    if (state.inputInstalled) return;

    state.inputInstalled = true;

    // Block zoom wheel while locked
    const onWheel = (ev) => {
      if (state.mode === "inactive") return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    addDomListener(state, view, "wheel", onWheel, { capture: true, passive: false });

    // Block default context menu while locked (so right-click is repurposed)
    const onContextMenu = (ev) => {
      if (state.mode === "inactive") return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    addDomListener(state, view, "contextmenu", onContextMenu, { capture: true });

    // Right-click to move + block middle-click pan
    const onPointerDown = (ev) => {
      if (state.mode === "inactive") return;

      // Right-click move
      if (ev.button === 2) {
        ev.preventDefault();
        ev.stopPropagation();

        const p = canvas.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY });
        state.pendingDestination = p;
        consumeMoveQueue();
        return;
      }

      // Middle-click pan
      if (ev.button === 1) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    addDomListener(state, view, "pointerdown", onPointerDown, { capture: true });

    // Block right-drag panning
    const onPointerMove = (ev) => {
      if (state.mode === "inactive") return;
      if ((ev.buttons & 2) === 2) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    addDomListener(state, view, "pointermove", onPointerMove, { capture: true });
  }

  function detachTicker() {
    if (state.tickerFn && canvas?.app?.ticker) {
      canvas.app.ticker.remove(state.tickerFn);
    }
    state.tickerFn = null;
  }

  function attachTicker() {
    if (!canvas?.ready || !canvas?.app?.ticker) return;
    if (state.tickerFn) return;

    state.tickerFn = (delta) => {
      if (!state.enabled) return;
      if (!canvas?.ready) return;

      if (state.mode === "inactive") return;

      const scale = state.lockedScale ?? canvas.stage.scale.x;

      // WAITING: freeze forever
      if (state.mode === "waiting") {
        const x = state.lockX ?? canvas.stage.pivot.x;
        const y = state.lockY ?? canvas.stage.pivot.y;
        canvas.pan({ x, y, scale });
        return;
      }

      // FOLLOW: follow DB token
      if (state.mode === "follow") {
        const token = getFollowToken();

        // If token vanished, revert to waiting freeze
        if (!token) {
          state.mode = "waiting";
          state.lockX = canvas.stage.pivot.x;
          state.lockY = canvas.stage.pivot.y;
          canvas.pan({ x: state.lockX, y: state.lockY, scale });
          return;
        }

        const targetCenter = token.center;
        const alpha = smoothingAlpha(delta);

        state.curX = (state.curX ?? canvas.stage.pivot.x);
        state.curY = (state.curY ?? canvas.stage.pivot.y);

        state.curX = state.curX + (targetCenter.x - state.curX) * alpha;
        state.curY = state.curY + (targetCenter.y - state.curY) * alpha;

        canvas.pan({ x: state.curX, y: state.curY, scale });
      }
    };

    canvas.app.ticker.add(state.tickerFn);
  }

  async function applyForActiveScene(reason) {
    if (state.isApplying) return;
    state.isApplying = true;

    try {
      if (!canvas?.ready || !canvas.scene) return;

      const scene = canvas.scene;
      state.activeSceneId = scene.id;

      const enabled = getSceneCameraFollowEnabled(scene);
      state.followEnabledForScene = enabled;

      // OFF: unlock behavior
      if (!enabled) {
        state.mode = "inactive";
        state.dbActorId = null;
        state.dbActorName = null;
        state.followTokenId = null;
        state.pendingDestination = null;
        state.isMoving = false;
        return;
      }

      // ON: lock scale and freeze at current view while resolving DB token
      state.lockedScale = canvas.stage.scale.x;
      state.lockX = canvas.stage.pivot.x;
      state.lockY = canvas.stage.pivot.y;

      state.mode = "waiting";
      state.followTokenId = null;

      const dbActor = await resolveDbActor();
      if (!dbActor) return;

      state.dbActorId = dbActor.id;
      state.dbActorName = dbActor.name;

      const dbToken = findDbTokenOnCanvas(dbActor);
      if (dbToken) {
        state.followTokenId = dbToken.id;
        state.mode = "follow";
        state.curX = canvas.stage.pivot.x;
        state.curY = canvas.stage.pivot.y;
        return;
      }
    } finally {
      state.isApplying = false;
    }
  }

  function installHooks() {
    const idCanvasReady = Hooks.on("canvasReady", async () => {
      if (!state.enabled) return;
      ensureInputBlockersInstalled();
      attachTicker();
      await applyForActiveScene("canvasReady");
    });
    state.hookIds.push(["canvasReady", idCanvasReady]);

    const idCanvasTearDown = Hooks.on("canvasTearDown", () => {
      if (!state.enabled) return;
      detachTicker();
      removeInputBlockers();
    });
    state.hookIds.push(["canvasTearDown", idCanvasTearDown]);

    const idUpdateScene = Hooks.on("updateScene", async (scene) => {
      if (!state.enabled) return;
      if (!canvas?.scene) return;
      if (scene.id !== canvas.scene.id) return;
      await applyForActiveScene("updateScene");
    });
    state.hookIds.push(["updateScene", idUpdateScene]);

    const idCreateToken = Hooks.on("createToken", async (tokenDoc) => {
      if (!state.enabled) return;
      if (!canvas?.ready || !canvas.scene) return;

      if (!state.followEnabledForScene) return;
      if (state.mode !== "waiting") return;

      // Ensure we have DB actor info; if not, try again
      let dbActorId = state.dbActorId;
      let dbActorName = state.dbActorName;

      if (!dbActorId || !dbActorName) {
        const dbActor = await resolveDbActor();
        if (!dbActor) return;
        state.dbActorId = dbActor.id;
        state.dbActorName = dbActor.name;
        dbActorId = dbActor.id;
        dbActorName = dbActor.name;
      }

      const dbStub = { id: dbActorId, name: dbActorName };

      if (isDbTokenDocument(tokenDoc, dbStub)) {
        state.followTokenId = tokenDoc.id;
        state.mode = "follow";
        state.curX = canvas.stage.pivot.x;
        state.curY = canvas.stage.pivot.y;
      }
    });
    state.hookIds.push(["createToken", idCreateToken]);
  }

  async function enable() {
    state.enabled = true;
    installHooks();

    // If already in a ready canvas, apply immediately
    if (canvas?.ready) {
      ensureInputBlockersInstalled();
      attachTicker();
      await applyForActiveScene("enable");
    }
  }

  async function disable() {
    state.enabled = false;

    detachTicker();
    removeInputBlockers();

    for (const [hookName, id] of state.hookIds) Hooks.off(hookName, id);
    state.hookIds = [];

    state.mode = "inactive";
    state.followEnabledForScene = false;
    state.activeSceneId = null;
    state.dbActorId = null;
    state.dbActorName = null;
    state.followTokenId = null;
    state.pendingDestination = null;
    state.isMoving = false;
  }

  // Expose a small handle for debugging from console if needed
  globalThis[GLOBAL_KEY] = { state, enable, disable };

  // Auto-enable when Foundry is ready
  Hooks.once("ready", () => {
    enable();
  });
})();
