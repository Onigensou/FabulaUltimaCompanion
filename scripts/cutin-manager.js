// ─────────────────────────────────────────────────────────────
//  FU Portrait Cut-In Manager (Foundry VTT v12) · Perf-Optimized
//  • Preloads texture; reuses a persistent PIXI layer/sprite
//  • Public API: window.FUCompanion.cutin.preload(url), .play(opts)
//  • Idempotent install; very small global footprint
// ─────────────────────────────────────────────────────────────
(() => {
  const NS = "FUCompanion";
  const TAG_ID = "fu-portrait-cutin-layer";

  // Namespace
  window[NS] = window[NS] || {};
  if (window[NS].cutin?.__installed) return; // idempotent

  // Easing
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInCubic  = t => t * t * t;
  const easeOutQuad  = t => 1 - (1 - t) * (1 - t);
  const easeInQuad   = t => t * t;

  // Helpers
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function tween(obj, prop, from, to, ms, ease=easeOutQuad){
    return new Promise(resolve => {
      const start = performance.now();
      obj[prop] = from;
      const step = (now) => {
        const t = Math.min(1, (now - start) / ms);
        obj[prop] = from + (to - from) * ease(t);
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }
  function tweenXY(obj, xFrom, xTo, yFrom, yTo, ms, ease=easeOutQuad){
    return new Promise(resolve => {
      const start = performance.now();
      obj.x = xFrom; obj.y = yFrom;
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
  function tweenCombo(items){
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

  // Manager object
  const manager = {
    __installed: true,
    _layer: null,
    _dim: null,
    _portrait: null,
    _texture: null,
    _imgUrl: null,
    _warm: false,

    _ensureLayer() {
      if (!canvas?.ready) return;
      if (this._layer) return;

      const stage = canvas.stage;
      stage.sortableChildren = true;

      const layer = new PIXI.Container();
      layer.name = TAG_ID;
      layer.zIndex = 999998; // just below other temp effects
      layer.visible = false;
      layer.sortableChildren = true;

      const { width: W, height: H } = canvas.app.renderer.screen;
      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000,1).drawRect(0,0,W,H).endFill();
      dim.alpha = 0; dim.zIndex = 0; dim.interactive = false;
      layer.addChild(dim);

      const portrait = new PIXI.Sprite(PIXI.Texture.WHITE);
      portrait.anchor.set(0.0, 1.0);
      portrait.zIndex = 2;
      layer.addChild(portrait);

      const onResize = ()=> {
        const { width: w2, height: h2 } = canvas.app.renderer.screen;
        dim.clear().beginFill(0x000000,1).drawRect(0,0,w2,h2).endFill();
      };
      Hooks.on("canvasPan", onResize);
      Hooks.on("resize", onResize);

      stage.addChild(layer);

      this._layer = layer;
      this._dim = dim;
      this._portrait = portrait;
    },

    async preload(imgUrl) {
      if (!imgUrl) return;
      if (!canvas?.ready) return;
      this._ensureLayer();
      try {
        this._texture = await PIXI.Assets.load(imgUrl);
        this._imgUrl  = imgUrl;
        this._warm = true;
      } catch (e) {
        console.warn("[CutIn] preload failed:", e);
      }
    },

    /**
     * Plays a basic left-slide cut-in with dim & fade.
     * If you want FLASH and extra timing, the receiver script adds those.
     */
    async play({
      img,
      dimAlpha = 0.6, dimFadeMs = 200,
      slideInMs = 300, holdMs = 900, slideOutMs = 650,
      portraitHeightRatio = 0.9, portraitBottomMargin = 40, portraitInsetX = 220,
      easeIn = easeOutCubic, easeOut = easeInCubic
    } = {}) {
      if (!canvas?.ready) return;
      this._ensureLayer();

      // Make sure we have the right texture
      if (!this._warm || img !== this._imgUrl) {
        await this.preload(img);
      }
      if (!this._texture) return;

      const { width: W, height: H } = canvas.app.renderer.screen;

      const p = this._portrait;
      p.texture = this._texture;
      const scale = (H * portraitHeightRatio) / p.texture.height;
      p.scale.set(scale, scale);
      p.x = -p.width - 80; // off-screen left
      p.y = H - portraitBottomMargin;
      p.alpha = 1.0;

      this._layer.visible = true;

      // Dim in → slide in → hold → slide out → dim out
      await tween(this._dim, "alpha", 0, dimAlpha, dimFadeMs, easeOutQuad);
      await tweenXY(p, p.x, portraitInsetX, p.y, p.y, slideInMs, easeIn);
      await sleep(holdMs);
      const exitX = W + 40;
      await tweenCombo([
        { obj: p, prop: "x",     from: p.x, to: exitX, ms: slideOutMs, ease: easeOut },
        { obj: p, prop: "alpha", from: 1,   to: 0,     ms: slideOutMs, ease: easeInQuad }
      ]);
      await tween(this._dim, "alpha", this._dim.alpha, 0, 180, easeInQuad);
      this._layer.visible = false;
    }
  };

  window[NS].cutin = manager;
})();
