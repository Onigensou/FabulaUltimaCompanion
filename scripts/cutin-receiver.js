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

  // ======= BEGIN: FU Cache + Combat Preloader (shared) =======
const FU_CACHE_NS = "FU_ASSET_CACHE";
function fuCache() {
  globalThis[FU_CACHE_NS] ??= {
    __createdAt: Date.now(),
    __audioCtx: null,
    // Track what we cached per-combat so we can free it later
    __combatKeys: new Map(), // combatId -> Set(keys)
    get size() { return Object.keys(this).filter(k => !k.startsWith("__")).length; }
  };
  return globalThis[FU_CACHE_NS];
}
function fuAudioCtx() {
  const cache = fuCache();
  cache.__audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  return cache.__audioCtx;
}

// Core helpers
async function fuPreloadTexture(key, url) {
  const cache = fuCache();
  // Foundry 12: prefer foundry.utils.preloadTexture if present
  const loader = foundry?.utils?.preloadTexture ?? globalThis.loadTexture;
  if (typeof loader !== "function") throw new Error("No texture loader available.");
  const tex = await loader(url);
  cache[key] = { ...(cache[key]||{}), texture: tex, url, cachedAt: Date.now() };
  return tex;
}
async function fuPreloadAudio(key, url) {
  const cache = fuCache();
  const ctx = fuAudioCtx();
  if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
  const resp = await fetch(url, { cache: "force-cache" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const arr  = await resp.arrayBuffer();
  const buff = await ctx.decodeAudioData(arr.slice(0));
  cache[key] = { ...(cache[key]||{}), buffer: buff, url, cachedAt: Date.now() };
  return buff;
}
function fuGetTexture(key) { return fuCache()[key]?.texture ?? null; }
function fuGetBuffer(key)  { return fuCache()[key]?.buffer  ?? null; }
function fuForget(key) {
  const cache = fuCache();
  const entry = cache[key];
  if (!entry) return;
  if (entry.texture && !entry.texture.destroyed) entry.texture.destroy(false);
  delete cache[key];
}

// Stable keys for actors/types so all clients match
function cutinImgKey(actorId, type) { return `cutin:${actorId}:${type}`; }
function cutinSfxKey(type) { return `sfx:${type}`; }

// SFX registry (authoritative URLs live here; we only fetch once at preload)
const CUTIN_SFX = {
  critical:   { key: cutinSfxKey("critical"),   url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BurstMax.ogg" },
  zero_power: { key: cutinSfxKey("zero_power"), url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/ChargeAttack.ogg" },
  fumble:     { key: cutinSfxKey("fumble"),     url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Down2.ogg" }
};

// Extract cut-in URL from actor by type (same logic your broadcaster used)
function imageUrlFromActorByType(actor, type) {
  const props = actor?.system?.props ?? {};
  if (type === "critical")   return props.cut_in_critical || null;
  if (type === "zero_power") return props.cut_in_zero_power || null;
  if (type === "fumble")     return props.cut_in_fumble || null;
  return null;
}

// Preload everything for a combat (images for all combatants + SFX set)
async function fuPreloadCombatAssets(combat) {
  const cache = fuCache();
  const cId = combat?.id; if (!cId) return;
  if (!cache.__combatKeys.has(cId)) cache.__combatKeys.set(cId, new Set());
  const bucket = cache.__combatKeys.get(cId);

  const types = ["critical","zero_power","fumble"];
  const list  = combat?.combatants?.contents ?? [];

  // 1) Preload SFX (always)
  for (const t of types) {
    const { key, url } = CUTIN_SFX[t];
    if (!fuGetBuffer(key)) {
      try { await fuPreloadAudio(key, url); } catch(e){ console.warn("[FU Cut-In] SFX preload failed", t, e); }
    }
    bucket.add(key);
  }

  // 2) Preload every actor's cut-in textures if present
  for (const c of list) {
    const a = c?.actor; const actorId = a?.id; if (!actorId) continue;
    for (const t of types) {
      const url = imageUrlFromActorByType(a, t);
      if (!url) continue; // actor has no cut-in of this type
      const k = cutinImgKey(actorId, t);
      if (!fuGetTexture(k)) {
        try { await fuPreloadTexture(k, url); } catch(e){ console.warn("[FU Cut-In] Texture preload failed", t, url, e); }
      }
      bucket.add(k);
    }
  }

  console.log("[FU Cut-In] Preloaded combat assets. Keys:", Array.from(bucket));
}

// Free only the assets we loaded for that combat
function fuForgetCombatAssets(combat) {
  const cache = fuCache();
  const cId = combat?.id; if (!cId) return;
  const bucket = cache.__combatKeys.get(cId);
  if (!bucket) return;
  for (const key of bucket) { fuForget(key); }
  cache.__combatKeys.delete(cId);
  console.log("[FU Cut-In] Freed combat assets.");
}

// Install start/end hooks once (GM or everyone is fine; it’s per-tab cache)
(function installCombatPreloaderOnce(){
  const FLAG = "__FU_CUTIN_COMBAT_PRELOADER";
  if (window[FLAG]) return;
  window[FLAG] = true;

  Hooks.on("combatStart", (combat) => { fuPreloadCombatAssets(combat); });
  // Works when combat ends; if you prefer also clean on delete, add "deleteCombat"
  Hooks.on("combatEnd",   (combat) => { fuForgetCombatAssets(combat); });
  Hooks.on("deleteCombat",(combat) => { fuForgetCombatAssets(combat); });
})();
// ======= END: FU Cache + Combat Preloader =======


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
      // Guard: skip bogus/sentinel URL used for cache-first flow
      if (!url || url === "__USE_CACHED_TEXTURE__") return;
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
  // STRICT: we ignore any imgUrl; we require __resolvedTexture
  __resolvedTexture,
  imgKey,

  dimAlpha = 0.6, dimFadeMs = 200,
  flashPeak = 0.9, flashInMs = 70, flashOutMs = 180, flashDelayMs = 60,
  slideInMs = 650, holdMs = 900, slideOutMs = 650,
  portraitHeightRatio = 0.9, portraitBottomMargin = 40, portraitInsetX = 220
} = {}) {
  if (!canvas?.ready) return;

  this._ensureLayer();

  // STRICT mode: must be provided with a pre-resolved texture
  if (!__resolvedTexture) {
    ui.notifications?.error("Cut-In: No cached texture provided (strict mode).");
    console.error("[FU Cut-In] Strict mode: play() called without __resolvedTexture", { imgKey });
    return;
  }

  // attach
  this._tex = __resolvedTexture;
  this._portrait.texture = this._tex;
  this._imgUrl = "(cached)";
  this._warm = true;

  const { width: W, height: H } = canvas.app.renderer.screen;
  const p = this._portrait;

  // sizing & positioning
  const fullH = H * portraitHeightRatio;
  const aspect = (p.texture.baseTexture?.realWidth || p.texture.width) /
                 (p.texture.baseTexture?.realHeight || p.texture.height) || 0.75;
  const fullW = Math.round(fullH * aspect);

  p.width = fullW;
  p.height = fullH;
  p.position.set(W - fullW + portraitInsetX, H - fullH - portraitBottomMargin);

  // dim + flash layers
  this._layer.visible = true;
  this._dim.alpha = 0;
  this._flash.alpha = 0;
  this._layer.alpha = 1;

  // simple timeline (slide in → hold → slide out)
  p.x += fullW; // start off-screen
  await gsap.to(p, { duration: slideInMs/1000, x: W - fullW + portraitInsetX, ease: "power3.out" });
  // dim + flash
  await gsap.to(this._dim, { duration: dimFadeMs/1000, alpha: dimAlpha, ease: "linear" });
  await sleep(flashDelayMs);
  await gsap.to(this._flash, { duration: flashInMs/1000, alpha: flashPeak, ease: "linear" });
  await gsap.to(this._flash, { duration: flashOutMs/1000, alpha: 0, ease: "linear" });

  await sleep(holdMs);

  await gsap.to(p, { duration: slideOutMs/1000, x: W + 40, ease: "power3.in" });
  await gsap.to(this._dim, { duration: 0.2, alpha: 0, ease: "linear" });

  // hide layer after finish
  this._layer.visible = false;
}

      // Accept a pre-resolved texture (preferred path)
if (arguments[0]?.__resolvedTexture) {
  this._tex = arguments[0].__resolvedTexture;
  this._imgUrl = "(cached)";
  this._portrait.texture = this._tex;
  this._warm = true;
} else {
  // legacy: if not warm or url changed, preload by URL once (but this shouldn't be used in new flow)
  if (!this._warm || imgUrl !== this._imgUrl) {
    await this.preload(imgUrl);
  }
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
    // 1) align start time
    const wait = Math.max(0, (payload.t0 ?? Date.now()) - Date.now());
    await sleep(wait);

    // 2) STRICT cache resolve — image (required)
    const imgKey = payload?.imgKey ?? null;
    if (!imgKey) {
      ui.notifications?.error("Cut-In: missing imgKey in payload (strict mode).");
      console.error("[FU Cut-In] Strict mode: payload has no imgKey.", payload);
      return;
    }
    const tex = (typeof fuGetTexture === "function") ? fuGetTexture(imgKey) : null;
    if (!tex) {
      ui.notifications?.error("Cut-In: image not cached. (Strict mode: aborting)");
      console.error("[FU Cut-In] Strict mode: no cached texture for", imgKey);
      return;
    }

    // 3) STRICT cache resolve — sfx (optional)
    const sfxKey = payload?.sfxKey ?? null;
    let buff = null;
    if (sfxKey && typeof fuGetBuffer === "function") {
      buff = fuGetBuffer(sfxKey);
      if (!buff) {
        console.warn("[FU Cut-In] Strict mode: SFX buffer missing for", sfxKey, "(skipping SFX)");
      }
    }

    // 4) play SFX if present (no URL fallback)
    const now = Date.now();
    if (buff && (now - __FU_LAST_SFX_AT) >= __FU_SFX_GUARD_MS) {
      try {
        const ctx = fuAudioCtx();
        if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
        const src  = ctx.createBufferSource();
        const gain = ctx.createGain();
        gain.gain.value = (payload.sfxVol ?? 0.9);
        src.buffer = buff;
        src.connect(gain).connect(ctx.destination);
        src.start(0);
        __FU_LAST_SFX_AT = now;
      } catch (err) {
        console.warn("[FU Cut-In] SFX failed:", err);
      }
    }

    // 5) hand the texture directly to the manager; no URL; no preload
    await manager.play({
      // NOTE: we do not pass any imgUrl in strict mode
      __resolvedTexture: tex,
      imgKey,

      dimAlpha:              payload.dimAlpha,
      dimFadeMs:             payload.dimFadeMs,
      flashPeak:             payload.flashPeak,
      flashInMs:             payload.flashInMs,
      flashOutMs:            payload.flashOutMs,
      flashDelayMs:          payload.flashDelayMs,
      slideInMs:             payload.slideInMs,
      holdMs:                payload.holdMs,
      slideOutMs:            payload.slideOutMs,
      portraitHeightRatio:   payload.portraitHeightRatio,
      portraitBottomMargin:  payload.portraitBottomMargin,
      portraitInsetX:        payload.portraitInsetX
    });

  } finally {
    BUSY = false;
    if (QUEUE.length) {
      const next = QUEUE.shift();
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
