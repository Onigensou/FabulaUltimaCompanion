// ─────────────────────────────────────────────────────────────
//  FU Cut-In • Client Receiver + Optimized Renderer (Foundry VTT v12)
//  - Install once per client (GM + players)
//  - Queue back-to-back plays, suppress duplicates
//  - Persistent PIXI layer w/ preload to avoid first-use lag
//  - Public API: window.FUCompanion.cutin.preload(url), .play(opts)
// ─────────────────────────────────────────────────────────────
(() => {
  const MODULE_ID   = "fabula-ultima-companion";
  const ACTION_KEY  = "FU_CUTIN_PLAY";      // socket action
  const TAG_ID      = "fu-portrait-cutin-layer"; // unique layer id (safe)
  const INSTALL_KEY = "__FU_CUTIN_RX_INSTALLED_v1";

  // Idempotent
  window.FUCompanion = window.FUCompanion || {};
  if (window[INSTALL_KEY]) return; // already installed

  // Require socketlib
  const sockMod = game.modules.get("socketlib");
  if (!sockMod?.active || !window.socketlib) {
    ui.notifications.error("Cut-in: socketlib not active on this client.");
    return;
  }
  const socket = socketlib.registerModule(MODULE_ID);

  // Easing + helpers (scoped; avoids global name collisions)
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInCubic  = t => t * t * t;
  const easeOutQuad  = t => 1 - (1 - t) * (1 - t);
  const easeInQuad   = t => t * t;
  const sleep        = (ms)=> new Promise(r=>setTimeout(r, ms));
  const nextFrame    = ()=> new Promise(r=>requestAnimationFrame(r));

  function tween(obj, prop, from, to, ms, ease=easeOutQuad){
    return new Promise(resolve=>{
      const start = performance.now();
      obj[prop] = from;
      const step = now => {
        const t = Math.min(1, (now - start) / ms);
        obj[prop] = from + (to - from) * ease(t);
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }
  function tweenXY(obj, xFrom, xTo, yFrom, yTo, ms, ease=easeOutQuad){
    return new Promise(resolve=>{
      const start = performance.now();
      obj.x = xFrom; obj.y = yFrom;
      const step = now => {
        const t = Math.min(1, (now - start) / ms);
        const k = ease(t);
        obj.x = xFrom + (xTo - xFrom) * k;
        obj.y = yFrom + (yTo - yFrom) * k;
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }
  function tweenCombo(items){
    return new Promise(resolve=>{
      const start = performance.now();
      for (const it of items) it.obj[it.prop] = it.from;
      const step = now => {
        let done = true;
        for (const it of items){
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

  // Persistent (preloaded) layer manager to avoid first-run lag
  const cutinManager = {
    __installed: true,
    _layer: null, _dim: null, _flash: null, _portrait: null,
    _texture: null, _imgUrl: null, _warm: false,

    _ensureLayer() {
      if (!canvas?.ready) throw new Error("Canvas not ready.");
      if (this._layer && this._layer.parent) return;

      const stage = canvas.stage;
      stage.sortableChildren = true;

      const layer = new PIXI.Container();
      layer.name = TAG_ID;
      layer.zIndex = 999999;
      layer.sortableChildren = true;
      layer.visible = false;
      layer.interactiveChildren = false;

      // Dim
      const dim = new PIXI.Graphics();
      const { width: W, height: H } = canvas.app.renderer.screen;
      dim.beginFill(0x000000, 1).drawRect(0,0,W,H).endFill();
      dim.alpha = 0;
      dim.zIndex = 0;

      // Optional flash overlay (SCREEN blend)
      const flash = new PIXI.Graphics();
      flash.beginFill(0xFFFFFF, 1).drawRect(0,0,W,H).endFill();
      flash.alpha = 0;
      flash.zIndex = 1;
      flash.blendMode = PIXI.BLEND_MODES.SCREEN;

      // Portrait (texture attached at play time)
      const portrait = new PIXI.Sprite(PIXI.Texture.EMPTY);
      portrait.anchor.set(0.0, 1.0);
      portrait.zIndex = 2;
      portrait.alpha = 0.999;

      layer.addChild(dim, flash, portrait);
      stage.addChild(layer);

      // Keep sized to screen
      const resize = () => {
        const { width: w2, height: h2 } = canvas.app.renderer.screen;
        dim.clear().beginFill(0x000000,1).drawRect(0,0,w2,h2).endFill();
        flash.clear().beginFill(0xFFFFFF,1).drawRect(0,0,w2,h2).endFill();
      };
      Hooks.on("canvasPan", resize);
      Hooks.on("resize", resize);
      resize();

      this._layer = layer; this._dim = dim; this._flash = flash; this._portrait = portrait;
    },

    async preload(imgUrl) {
      this._ensureLayer();
      if (this._imgUrl === imgUrl && this._texture) return;
      this._texture = await loadTexture(imgUrl);
      this._imgUrl  = imgUrl;

      // warm GPU upload
      this._portrait.texture = this._texture;
      this._layer.visible = true;
      this._portrait.visible = false;
      await nextFrame(); await nextFrame();
      this._layer.visible = false;
      this._portrait.visible = true;
      this._warm = true;
    },

    /**
     * opts:
     *  img, sfxUrl, sfxVol
     *  dimAlpha, dimFadeMs
     *  flashColor, flashPeak, flashInMs, flashOutMs, flashDelayMs
     *  slideInMs, holdMs, slideOutMs
     *  portraitHeightRatio, portraitBottomMargin, portraitInsetX
     */
    async play(opts = {}) {
      if (!canvas?.ready) return;
      this._ensureLayer();

      const {
        img,
        sfxUrl = null, sfxVol = 0.9,
        dimAlpha = 0.6, dimFadeMs = 200,
        flashColor = 0xFFFFFF, flashPeak = 0.9, flashInMs = 70, flashOutMs = 180, flashDelayMs = 60,
        slideInMs = 650, holdMs = 900, slideOutMs = 650,
        portraitHeightRatio = 0.9, portraitBottomMargin = 40, portraitInsetX = 220,
        easeIn = easeOutCubic, easeOut = easeInCubic
      } = opts;

      if (!img) return;

      if (!this._warm || img !== this._imgUrl) await this.preload(img);

      const { width: W, height: H } = canvas.app.renderer.screen;
      const p = this._portrait;
      p.texture = this._texture;

      const scale = (H * portraitHeightRatio) / p.texture.height;
      p.scale.set(scale, scale);

      const finalX = portraitInsetX;
      const finalY = H - portraitBottomMargin;

      p.x = -p.width - 80; // off-left
      p.y = finalY;
      p.alpha = 1.0;

      // show layer
      this._layer.visible = true;

      // SFX (best-effort)
      if (sfxUrl) {
        try {
          await (foundry?.audio?.AudioHelper ?? AudioHelper).play({ src: sfxUrl, volume: sfxVol, loop: false }, true);
        } catch (e) { console.warn("Cut-in SFX failed:", e); }
      }

      // Dim in
      await tween(this._dim, "alpha", 0, dimAlpha, dimFadeMs, easeOutQuad);

      // Flash (optional)
      this._flash.tint = flashColor;
      await sleep(flashDelayMs);
      await tween(this._flash, "alpha", 0, flashPeak, flashInMs, easeOutQuad);

      // Slide in while flash fades
      const flashFade = tween(this._flash, "alpha", this._flash.alpha, 0, flashOutMs, easeInQuad);
      await tweenXY(p, p.x, finalX, p.y, finalY, slideInMs, easeIn);
      await flashFade;

      // Hold
      await sleep(holdMs);

      // Slide out to right + fade
      const exitX = W + 40;
      await tweenCombo([
        { obj: p, prop: "x",     from: p.x, to: exitX, ms: slideOutMs, ease: easeOut },
        { obj: p, prop: "alpha", from: 1,   to: 0,     ms: slideOutMs, ease: easeInQuad }
      ]);

      // Dim out quick & hide
      await tween(this._dim, "alpha", this._dim.alpha, 0, 180, easeInQuad);
      this._layer.visible = false;
    }
  };

  // Public local API
  window.FUCompanion.cutin = window.FUCompanion.cutin || {};
  Object.assign(window.FUCompanion.cutin, {
    __installed: true,
    preload: (url) => cutinManager.preload(url),
    play: (opts) => cutinManager.play(opts)
  });

  // Queue + duplicate suppression for socket events
  let BUSY = false;
  const QUEUE = [];
  const START_LAG_MS     = 300;  // when queueing, re-time for near-future sync
  const DUP_SUPPRESS_MS  = 350;  // ignore near-identical spam bursts
  let lastSig   = "";
  let lastSigAt = 0;

  async function runCutInAt(t0, opts) {
    // wait until t0
    const wait = Math.max(0, t0 - Date.now());
    await sleep(wait);
    await cutinManager.play(opts);
  }

  async function runQueued(payload) {
    BUSY = true;
    try {
      const { t0 = Date.now() + 200, ...opts } = payload;
      if (!opts?.img) return; // nothing to render
      await runCutInAt(t0, opts);
    } finally {
      BUSY = false;
      if (QUEUE.length) {
        const next = QUEUE.shift();
        next.t0 = Date.now() + START_LAG_MS;
        runQueued(next);
      }
    }
  }

  socket.register(ACTION_KEY, async (payload) => {
    // near-duplicate suppression (ignore t0 in signature)
    const { t0, ...sigObj } = payload || {};
    const sig = JSON.stringify(sigObj);
    const now = Date.now();
    if (sig === lastSig && (now - lastSigAt) < DUP_SUPPRESS_MS) {
      // coalesce by refreshing/queuing
      const idx = QUEUE.findIndex(q => JSON.stringify(({...q, t0: undefined})) === sig);
      if (idx >= 0) QUEUE[idx] = payload; else QUEUE.push(payload);
      return;
    }
    lastSig = sig; lastSigAt = now;

    if (BUSY) { QUEUE.push(payload); return; }
    runQueued(payload);
  });

  // Optional: warm up a neutral image on first canvas ready
  Hooks.once("canvasReady", async () => {
    try {
      // No hardcoded art—only a tiny clear texture to warm the pipeline
      const empty = PIXI.Texture.EMPTY;
      if (empty) await nextFrame();
    } catch (e) { /* ignore */ }
  });

  // Local fallback callable by broadcaster (kept for compatibility)
  window.__FU_CUTIN_PLAY = (payload={}) => {
    const { imgUrl, ...rest } = payload;
    const { t0 = Date.now() + 300 } = payload;
    if (!imgUrl) return;
    return runCutInAt(t0, { img: imgUrl, ...rest });
  };

  window[INSTALL_KEY] = true;
})();
