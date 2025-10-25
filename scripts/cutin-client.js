// scripts/cutin-client.js
// ─────────────────────────────────────────────────────────────
//  Fabula Ultima Companion • Cut-in Client (Foundry VTT v12)
//  • Installs the socketlib receiver (idempotent)
//  • Lightweight warm-up (preload) to avoid first-run stutter
//  • Public API exposed at window.FUCompanion.cutin.playLocal(payload)
//    and window.FUCompanion.cutin.preload(url)
//  • Queueing + duplicate suppression so rapid triggers don’t explode
//  Requires: socketlib
// ─────────────────────────────────────────────────────────────
(() => {
  const MODULE_ID   = "fabula-ultima-companion";
  const ACTION_KEY  = "FU_CUTIN_PLAY_V1";
  const READY_FLAG  = "__FU_CUTIN_CLIENT_READY_v1";
  const LAYER_TAG   = "fu-portrait-cutin-layer";
  const DEFAULT_IMG = "icons/svg/mystery-man.svg";

  if (window[READY_FLAG]) return; // idempotent startup

  // Ensure namespace
  window.FUCompanion = window.FUCompanion || {};
  window.FUCompanion.cutin = window.FUCompanion.cutin || {};

  // Socketlib required
  const sockMod = game.modules.get("socketlib");
  if (!sockMod?.active || !window.socketlib) {
    ui.notifications.error("Fabula Ultima Companion: socketlib is required for Cut-ins.");
    return;
  }
  const socket = socketlib.registerModule(MODULE_ID); // idempotent inside socketlib

  // ------------------------ helpers ------------------------
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInCubic  = t => t * t * t;
  const easeOutQuad  = t => 1 - (1 - t) * (1 - t);
  const easeInQuad   = t => t * t;
  const sleep        = (ms) => new Promise(r => setTimeout(r, ms));

  function tween(obj, prop, from, to, ms, ease = easeOutQuad) {
    return new Promise(resolve => {
      const start = performance.now(); obj[prop] = from;
      const step = (now) => {
        const t = Math.min(1, (now - start) / ms);
        obj[prop] = from + (to - from) * ease(t);
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  function tweenXY(obj, xFrom, xTo, yFrom, yTo, ms, ease = easeOutQuad) {
    return new Promise(resolve => {
      const start = performance.now(); obj.x = xFrom; obj.y = yFrom;
      const step = (now) => {
        const t = Math.min(1, (now - start) / ms);
        const k = ease(t);
        obj.x = xFrom + (xTo - xFrom) * k;
        obj.y = yFrom + (yTo - yFrom) * k;
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  function tweenCombo(items) {
    return new Promise(resolve => {
      const start = performance.now();
      for (const it of items) it.obj[it.prop] = it.from;
      const step = (now) => {
        let done = true;
        for (const it of items) {
          const t = Math.min(1, (now - start) / it.ms);
          const k = (it.ease || easeOutQuad)(t);
          it.obj[it.prop] = it.from + (it.to - it.from) * k;
          if (t < 1) done = false;
        }
        if (!done) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  // ------------------- persistent PIXI layer -------------------
  const State = {
    layer: null,
    dim: null,
    portrait: null,
    texture: null,
    imgUrl: null,
    warmed: false
  };

  function ensureLayer() {
    if (!canvas?.ready) throw new Error("Canvas not ready.");
    if (State.layer && State.layer.parent) return;

    const stage = canvas.stage;
    stage.sortableChildren = true;

    const layer = new PIXI.Container();
    layer.name = LAYER_TAG;
    layer.zIndex = 999999;
    layer.sortableChildren = true;
    layer.visible = false;
    layer.interactiveChildren = false;

    const dim = new PIXI.Graphics();
    const { width: W, height: H } = canvas.app.renderer.screen;
    dim.beginFill(0x000000, 1).drawRect(0, 0, W, H).endFill();
    dim.alpha = 0;
    dim.zIndex = 0;

    const portrait = new PIXI.Sprite(PIXI.Texture.EMPTY);
    portrait.anchor.set(0.0, 1.0);
    portrait.zIndex = 1;
    portrait.alpha = 0.999;

    layer.addChild(dim, portrait);
    stage.addChild(layer);

    const resize = () => {
      const { width, height } = canvas.app.renderer.screen;
      dim.clear().beginFill(0x000000, 1).drawRect(0, 0, width, height).endFill();
    };
    Hooks.on("canvasPan", resize);
    Hooks.on("resize", resize);
    resize();

    State.layer = layer;
    State.dim = dim;
    State.portrait = portrait;
  }

  async function preload(url = DEFAULT_IMG) {
    try {
      ensureLayer();
      if (State.imgUrl === url && State.texture) return;
      State.texture = await loadTexture(url);
      State.imgUrl = url;
      // GPU warm-up: briefly attach while hidden so upload happens now
      State.portrait.texture = State.texture;
      State.layer.visible = true;
      State.portrait.visible = false;
      await new Promise(r => requestAnimationFrame(r));
      await new Promise(r => requestAnimationFrame(r));
      State.layer.visible = false;
      State.portrait.visible = true;
      State.warmed = true;
    } catch (e) {
      console.warn("[FU Cut-in] preload failed:", e);
    }
  }

  // ---------------------- main renderer -----------------------
  // Scheduled at payload.t0 and runs entirely client-side (deterministic).
  async function __FU_CUTIN_PLAY(payload = {}) {
    if (!canvas?.ready) return;

    const {
      imgUrl,
      t0 = Date.now() + 800,
      sfxUrl = null,
      sfxVol = 0.9,
      dimAlpha = 0.6, dimFadeMs = 200,
      slideInMs = 650, holdMs = 900, slideOutMs = 650,
      portraitHeightRatio = 0.9,
      portraitBottomMargin = 40,
      portraitInsetX = 220,
      flashColor = 0xFFFFFF, flashPeak = 0.9, flashInMs = 70, flashOutMs = 180, flashDelayMs = 60
    } = payload;

    if (!imgUrl) return; // “no cut-in for this actor” → quietly skip

    ensureLayer();

    // Preload during the wait window
    const texPromise = loadTexture(imgUrl);
    const wait = Math.max(0, t0 - Date.now());
    await sleep(wait);
    const tex = await texPromise;

    // Size & place
    const { width: W, height: H } = canvas.app.renderer.screen;
    const p = State.portrait;
    p.texture = tex;
    const scale = (H * portraitHeightRatio) / p.texture.height;
    p.scale.set(scale, scale);
    const finalX = portraitInsetX;
    const finalY = H - portraitBottomMargin;
    p.x = -p.width - 80; // from off-screen left
    p.y = finalY;
    p.alpha = 1;

    // Add a quick “flash” layer via Graphics (SCREEN)
    const flash = new PIXI.Graphics();
    flash.beginFill(flashColor, 1).drawRect(0, 0, W, H).endFill();
    flash.alpha = 0;
    flash.blendMode = PIXI.BLEND_MODES.SCREEN;
    flash.zIndex = 2;

    State.layer.addChild(flash);
    State.layer.visible = true;

    // Play SFX if present
    if (sfxUrl) {
      try { await (foundry?.audio?.AudioHelper ?? AudioHelper).play({ src: sfxUrl, volume: sfxVol, loop: false }, true); }
      catch (e) { console.warn("Cut-in SFX failed:", e); }
    }

    // dim in
    await tween(State.dim, "alpha", 0, dimAlpha, dimFadeMs, easeOutQuad);
    // flash + slide
    await sleep(flashDelayMs);
    await tween(flash, "alpha", 0, flashPeak, flashInMs, easeOutQuad);
    const fadeFlash = tween(flash, "alpha", flash.alpha, 0, flashOutMs, easeInQuad);
    await tweenXY(p, p.x, finalX, p.y, finalY, slideInMs, easeOutCubic);
    await fadeFlash;

    // hold
    await sleep(holdMs);

    // exit to right + fade
    const exitX = W + 40;
    await tweenCombo([
      { obj: p, prop: "x",     from: p.x, to: exitX, ms: slideOutMs, ease: easeInCubic },
      { obj: p, prop: "alpha", from: 1,   to: 0,     ms: slideOutMs, ease: easeInQuad }
    ]);

    // dim out + cleanup flash
    await tween(State.dim, "alpha", State.dim.alpha, 0, 180, easeInQuad);
    flash.destroy({ children: true });
    State.layer.visible = false;
  }

  // ---------------- queue + dup suppression on receive ----------------
  let BUSY = false;
  const QUEUE = [];
  const DUP_SUPPRESS_MS = 350;
  let lastSig = ""; let lastSigAt = 0;

  async function runCutIn(payload) {
    BUSY = true;
    try { await __FU_CUTIN_PLAY(payload); }
    finally {
      BUSY = false;
      if (QUEUE.length) {
        const next = QUEUE.shift();
        // keep sync for queued ones by re-scheduling a tiny future t0
        next.t0 = Date.now() + 300;
        runCutIn(next);
      }
    }
  }

  socket.register(ACTION_KEY, async (payload) => {
    const sigObj = { ...payload }; delete sigObj.t0; // ignore t0 in signature
    const sig = JSON.stringify(sigObj);
    const now = Date.now();
    if (sig === lastSig && (now - lastSigAt) < DUP_SUPPRESS_MS) {
      // coalesce near duplicates
      const idx = QUEUE.findIndex(q => JSON.stringify(({ ...q, t0: undefined })) === sig);
      if (idx >= 0) QUEUE[idx] = payload; else QUEUE.push(payload);
      return;
    }
    lastSig = sig; lastSigAt = now;
    if (BUSY) { QUEUE.push(payload); return; }
    runCutIn(payload);
  });

  // Expose local API for safety and manual triggering
  window.FUCompanion.cutin.playLocal = __FU_CUTIN_PLAY;
  window.FUCompanion.cutin.preload   = preload;

  // Auto warm-up at first canvas ready
  Hooks.once("canvasReady", async () => {
    try { await preload(DEFAULT_IMG); } catch (_) {}
  });

  window[READY_FLAG] = true;
  console.log("[FU Cut-in] Receiver installed & warmed.");
  ui.notifications.notify("FU Cut-in receiver installed.", { permanent: false });
})();
