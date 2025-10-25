// ─────────────────────────────────────────────────────────────
//  FU Portrait Cut-In • Receiver & Renderer (Foundry VTT v12)
//  Module: fabula-ultima-companion  ·  Socketlib required
//  - Installs executeForEveryone receiver: ACTION_KEY = "FU_CUTIN_PLAY"
//  - Optimized PIXI renderer with preload/warm-up
//  - Queue, duplicate suppression, and safe cleanup
//  - Public API exposed at: window.FUCompanion.cutin.{preload,play}
//  - Local fallback renderer: window.__FU_CUTIN_PLAY(payload)
// ─────────────────────────────────────────────────────────────
(() => {
  const MODULE_ID  = "fabula-ultima-companion";
  const ACTION_KEY = "FU_CUTIN_PLAY";
  const FLAG       = "__FU_CUTIN_READY_v3";
  const TAG_ID     = "fu-portrait-cutin-layer";
  const NS         = "FUCompanion";
  let __FU_LAST_SFX_AT = 0;
  const __FU_SFX_GUARD_MS = 900; // play SFX at most once per 0.9s per client


  if (window[FLAG]) return; // idempotent guard

  // Defer full install until Foundry 'ready'
  Hooks.once("ready", () => {
    try {
      // ——— socketlib check
      const sockMod = game.modules.get("socketlib");
      if (!sockMod?.active || !window.socketlib) {
        ui.notifications.error("FU Cut-In: socketlib not found/active.");
        return;
      }
      const socket = socketlib.registerModule(MODULE_ID);

  // ————————————————— Small easing/tween helpers (scoped, unique names)
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInCubic  = t => t * t * t;
  const easeOutQuad  = t => 1 - (1 - t) * (1 - t);
  const easeInQuad   = t => t * t;

  const sleep     = (ms) => new Promise(r => setTimeout(r, ms));
  const nextFrame = ()  => new Promise(r => requestAnimationFrame(r));

  function tween(obj, prop, from, to, ms, ease=easeOutQuad){
    return new Promise(resolve => {
      const start = performance.now(); obj[prop] = from;
      const step  = (now) => {
        const t = Math.min(1, (now - start) / ms);
        obj[prop] = from + (to - from) * ease(t);
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }
  function tweenXY(obj, xFrom, xTo, yFrom, yTo, ms, ease=easeOutQuad){
    return new Promise(resolve => {
      const start = performance.now(); obj.x = xFrom; obj.y = yFrom;
      const step  = (now) => {
        const t = Math.min(1, (now - start) / ms); const k = ease(t);
        obj.x = xFrom + (xTo - xFrom) * k; obj.y = yFrom + (yTo - yFrom) * k;
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }
  function tweenCombo(items){
    return new Promise(resolve => {
      const start = performance.now();
      for (const it of items) it.obj[it.prop] = it.from;
      const step  = (now) => {
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

  // ————————————————— Optimized PIXI manager (preload/warm-up + reuse)  (inspired by your PoC) :contentReference[oaicite:4]{index=4}
  const manager = {
    __installed: true,
    _layer: null,
    _dim: null,
    _flash: null,
    _portrait: null,
    _imgUrl: null,
    _tex: null,
    _warm: false,

    _ensureLayer() {
      if (!canvas?.ready) throw new Error("Canvas not ready.");
      if (this._layer && this._layer.parent) return;

      const layer = new PIXI.Container();
      layer.name = TAG_ID;
      layer.zIndex = 999999;
      layer.sortableChildren = true;
      layer.visible = false;
      layer.interactiveChildren = false;

      // Dim layer
      const dim = new PIXI.Graphics();
      // Flash layer (optional white flash on entry)
      const flash = new PIXI.Graphics();

      // Portrait
      const portrait = new PIXI.Sprite(PIXI.Texture.EMPTY);
      portrait.anchor.set(0.0, 1.0);
      portrait.zIndex = 2;
      portrait.alpha = 0.999;

      layer.addChild(dim, flash, portrait);
      canvas.stage.sortableChildren = true;
      canvas.stage.addChild(layer);

      const resize = () => {
        const { width: W, height: H } = canvas.app.renderer.screen;
        dim.clear().beginFill(0x000000, 1).drawRect(0,0,W,H).endFill();
        flash.clear().beginFill(0xFFFFFF,1).drawRect(0,0,W,H).endFill();
        flash.alpha = 0;
      };
      Hooks.on("canvasPan", resize);
      Hooks.on("resize", resize);
      resize();

      this._layer = layer;
      this._dim = dim;
      this._flash = flash;
      this._portrait = portrait;
    },

    async preload(url) {
      this._ensureLayer();
      if (this._imgUrl === url && this._tex) return;
      this._tex = await loadTexture(url);
      this._imgUrl = url;

      // Warm-up: attach, hide, yield frames (GPU upload), then hide whole layer again
      this._portrait.texture = this._tex;
      this._layer.visible = true;
      this._portrait.visible = false;
      await nextFrame(); await nextFrame();
      this._portrait.visible = true;
      this._layer.visible = false;
      this._warm = true;
    },

    async play({
      imgUrl,
      dimAlpha = 0.6, dimFadeMs = 200,
      flashPeak = 0.9, flashInMs = 70, flashOutMs = 180, flashDelayMs = 60,
      slideInMs = 650, holdMs = 900, slideOutMs = 650,
      portraitHeightRatio = 0.9, portraitBottomMargin = 40, portraitInsetX = 220
    } = {}) {
      if (!canvas?.ready) return;

      this._ensureLayer();
      if (!this._warm || imgUrl !== this._imgUrl) {
        await this.preload(imgUrl);
      }

      const { width: W, height: H } = canvas.app.renderer.screen;
      const p = this._portrait;
      p.texture = this._tex;

      // size/placement
      const scale = (H * portraitHeightRatio) / p.texture.height;
      p.scale.set(scale, scale);
      const finalX = portraitInsetX;
      const finalY = H - portraitBottomMargin;
      p.x = -p.width - 80; p.y = finalY; p.alpha = 1;

      // show
      this._layer.visible = true;

      // dim in
      await tween(this._dim, "alpha", 0, dimAlpha, dimFadeMs, easeOutQuad);

      // white flash (optional)
      await sleep(flashDelayMs);
      await tween(this._flash, "alpha", 0, flashPeak, flashInMs, easeOutQuad);
      const flashFade = tween(this._flash, "alpha", this._flash.alpha, 0, flashOutMs, easeInQuad);

      // slide in
      await tweenXY(p, p.x, finalX, p.y, finalY, slideInMs, easeOutCubic);
      await flashFade;

      // hold
      await sleep(holdMs);

      // slide out + fade + undim
      const exitX = W + 40;
      await tweenCombo([
        { obj: p,        prop: "x",     from: p.x, to: exitX, ms: slideOutMs, ease: easeInCubic },
        { obj: p,        prop: "alpha", from: 1,   to: 0,     ms: slideOutMs, ease: easeInQuad }
      ]);
      await tween(this._dim, "alpha", this._dim.alpha, 0, 180, easeInQuad);

      this._layer.visible = false;
    }
  };

  // ————————————————— Queue & duplicate suppression (coalesce)
  let BUSY = false;
  const QUEUE = [];
  const DUP_SUPPRESS_MS = 350;
  let lastSig = "", lastSigAt = 0;

  async function runCutIn(payload) {
    BUSY = true;
    try {
      // wait until shared t0 (synchronized start)  (pattern per your manifesto) :contentReference[oaicite:5]{index=5}
      const wait = Math.max(0, (payload.t0 ?? Date.now()) - Date.now());
      await sleep(wait);

      // If payload has no imgUrl (fail-safe), just return quietly.
      if (!payload?.imgUrl) return;

      // SFX (per-client at t0) with cool-down to avoid bursts
const now = Date.now();
if (payload.sfxUrl && (now - __FU_LAST_SFX_AT) >= __FU_SFX_GUARD_MS) {
  try {
    await (foundry?.audio?.AudioHelper ?? AudioHelper).play(
      { src: payload.sfxUrl, volume: payload.sfxVol ?? 0.9, loop: false },
      true
    );
    __FU_LAST_SFX_AT = now;
  } catch (err) {
    console.warn("[FU Cut-In] SFX failed:", err);
  }
} // else: skip SFX but still render the visual

      await manager.play(payload);
    } finally {
      BUSY = false;
      if (QUEUE.length) {
        const next = QUEUE.shift();
        // reschedule queued one shortly in the future to keep clients aligned
        next.t0 = Date.now() + 300;
        runCutIn(next);
      }
    }
  }

  socket.register(ACTION_KEY, async (payload) => {
  // 1) Optional whitelist check (from broadcaster fallback)
  const myUserId = game.user?.id;
  if (Array.isArray(payload?.allowedUserIds) && myUserId) {
    if (!payload.allowedUserIds.includes(myUserId)) return; // not for me
  }

  // 2) Expiry guard: if this client received it too late, ignore
  const now = Date.now();
  const expireAt = Number(payload?.expireAt) || (Number(payload?.t0) + 3000);
  if (Number.isFinite(expireAt) && now > expireAt) {
    // Too late—drop silently to avoid flooding late joiners
    return;
  }

  // (existing duplicate suppression and queue follow)
  const sigObj = { ...payload }; delete sigObj.t0; delete sigObj.expireAt; delete sigObj.allowedUserIds;
  const sig = JSON.stringify(sigObj);
  const now2 = Date.now();

  if (sig === lastSig && (now2 - lastSigAt) < DUP_SUPPRESS_MS) {
    if (BUSY) {
      const idx = QUEUE.findIndex(q => {
        const a = { ...q }; delete a.t0; delete a.expireAt; delete a.allowedUserIds;
        return JSON.stringify(a) === sig;
      });
      if (idx >= 0) QUEUE[idx] = payload; else QUEUE.push(payload);
    }
    return;
  }
  lastSig = sig; lastSigAt = now2;

  if (BUSY) { QUEUE.push(payload); return; }
  runCutIn(payload);
});

  // Expose public API & local fallback
  window[NS] = window[NS] || {};
  window[NS].cutin = manager;
  window.__FU_CUTIN_PLAY = (payload) => runCutIn(payload); // optional local fallback

  // Warm-up once the canvas is ready
  Hooks.once("canvasReady", async () => {
    try {
      // Optional: warm a tiny transparent 1px image to initialize GPU path
      const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAj0Bz3k0aHAAAAAASUVORK5CYII=";
      await manager.preload(BLANK);
    } catch (e) { console.warn("[FU Cut-In] Warm-up failed:", e); }
  });

   window[FLAG] = true;
      console.log("[FU Cut-In] Receiver installed.");
    } catch (err) {
      console.error("[FU Cut-In] Receiver failed to install:", err);
    }
  });
})();
