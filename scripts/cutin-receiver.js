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

  // ── FU Cache (per-tab) ─────────────────────────────────────────────────
const FU_CACHE_NS = "FU_ASSET_CACHE";
function fuCache() {
  globalThis[FU_CACHE_NS] ??= { __createdAt: Date.now(), __audioCtx: null };
  return globalThis[FU_CACHE_NS];
}
function fuAudioCtx() {
  const cache = fuCache();
  cache.__audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  return cache.__audioCtx;
}
async function fuPreloadTexture(key, url) {
  const loader = foundry?.utils?.preloadTexture ?? globalThis.loadTexture;
  if (typeof loader !== "function") throw new Error("No texture loader available.");
  const tex = await loader(url);
  fuCache()[key] = { ...(fuCache()[key]||{}), texture: tex, url, cachedAt: Date.now() };
  return tex;
}
async function fuPreloadAudio(key, url) {
  const ctx = fuAudioCtx();
  if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
  const resp = await fetch(url, { cache: "force-cache" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const arr  = await resp.arrayBuffer();
  const buff = await ctx.decodeAudioData(arr.slice(0));
  fuCache()[key] = { ...(fuCache()[key]||{}), buffer: buff, url, cachedAt: Date.now() };
  return buff;
}
function fuGetTexture(key) { return fuCache()?.[key]?.texture ?? null; }
function fuGetBuffer(key)  { return fuCache()?.[key]?.buffer  ?? null; }
function fuForget(key) {
  const entry = fuCache()?.[key];
  if (entry?.texture && !entry.texture.destroyed) entry.texture.destroy(false);
  delete fuCache()[key];
}
  
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

    // Replace manager.preload(url) with attachTexture(tex)
async attachTexture(tex) {
  this._ensureLayer();
  this._tex = tex;
  this._portrait.texture = tex;
  this._layer.visible = true;
  this._portrait.visible = false;
  await nextFrame(); await nextFrame();     // warm GPU path
  this._portrait.visible = true;
  this._layer.visible = false;
  this._warm = true;
},

    async play({
  imgKey,   // NEW: cache key for texture
  dimAlpha = 0.6, dimFadeMs = 200,
  flashPeak = 0.9, flashInMs = 70, flashOutMs = 180, flashDelayMs = 60,
  slideInMs = 650, holdMs = 900, slideOutMs = 650,
  portraitHeightRatio = 0.9, portraitBottomMargin = 40, portraitInsetX = 220
} = {}) {
  if (!canvas?.ready) return;
  this._ensureLayer();

  const tex = fuGetTexture(imgKey);
  if (!tex) {
    console.warn("[FU Cut-In] Cached texture missing for key:", imgKey);
    return; // hard rule: never fetch at playtime
  }
  await this.attachTexture(tex);
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

// Visual: require a cached texture key
if (!payload?.imgKey) return;

// SFX: from cached buffer with per-client cooldown
const now = Date.now();
if (payload.sfxKey && (now - __FU_LAST_SFX_AT) >= __FU_SFX_GUARD_MS) {
  try {
    const ctx   = fuAudioCtx();
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }
    const buff  = fuGetBuffer(payload.sfxKey);
    if (buff) {
      const src  = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = payload.sfxVol ?? 0.9;
      src.buffer = buff; src.connect(gain).connect(ctx.destination); src.start(0);
    }
    __FU_LAST_SFX_AT = now;
  } catch (err) {
    console.warn("[FU Cut-In] SFX (buffer) failed:", err);
  }
}
await manager.play(payload); // payload now carries imgKey, not URLs
      
      // else: skip SFX but still render the visual

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

  // Warm-up + combat lifecycle (drop-in replacement)
Hooks.once("canvasReady", async () => {
  try {
    // Warm the GPU path without live URL usage
    const BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAj0Bz3k0aHAAAAAASUVORK5CYII=";

    // 1) Put a tiny texture into our cache
    await fuPreloadTexture("tmp:blank", BLANK);

    // 2) Attach it once to the manager to warm layout/render pipeline
    const tex = fuGetTexture("tmp:blank");
    if (tex && manager?.attachTexture) {
      await manager.attachTexture(tex);
    }

    // 3) Toss the throwaway texture
    fuForget("tmp:blank");
  } catch (e) {
    console.warn("[FU Cut-In] Warm-up failed:", e);
  }
});

// ── Combat lifecycle: preload on start, forget on end ─────────────────
const CACHED_KEYS_BY_COMBAT = new Map(); // combatId -> Set(keys)

// map type -> sfx URL (for preload only, never used at play time)
const SFX_URLS = {
  critical:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BurstMax.ogg",
  zero_power: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/ChargeAttack.ogg",
  fumble:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Down2.ogg"
};

function imgKeyFor(actorId, type) { return `cutin:${actorId}:${type}`; }
function sfxKeyFor(type)          { return `sfx:${type}`; }

async function preloadCutinsForCombat(combat) {
  const bag = new Set();
  const list = (combat?.combatants?.contents ?? []);
  for (const c of list) {
    const actor = c?.actor;
    const props = actor?.system?.props ?? {};
    const aid   = actor?.id;
    if (!aid) continue;

    // three cut-in slots (optional)
    const entries = [
      ["critical",   props.cut_in_critical],
      ["zero_power", props.cut_in_zero_power],
      ["fumble",     props.cut_in_fumble]
    ];
    for (const [type, url] of entries) {
      if (!url) continue;                      // actor has no image for this type
      const key = imgKeyFor(aid, type);        // cache key per actor+type
      try {
        await fuPreloadTexture(key, url);
        bag.add(key);
      } catch (e) {
        console.warn("cut-in tex preload failed", key, e);
      }

      // Preload SFX counterpart
      const sfxUrl = SFX_URLS[type];
      if (sfxUrl) {
        const sk = sfxKeyFor(type);
        try {
          await fuPreloadAudio(sk, sfxUrl);
          bag.add(sk);
        } catch (e) {
          console.warn("cut-in sfx preload failed", sk, e);
        }
      }
    }
  }
  if (combat?.id) CACHED_KEYS_BY_COMBAT.set(combat.id, bag);
}

// When combat starts, each client preloads locally (no URLs at playtime)
Hooks.on("combatStart", async (combat) => {
  try {
    await preloadCutinsForCombat(combat);
  } catch (e) {
    console.warn("combatStart preload error:", e);
  }
});

// When combat ends or is deleted, forget that combat's cached entries
function forgetCombatKeys(combat) {
  const bag = combat ? CACHED_KEYS_BY_COMBAT.get(combat.id) : null;
  if (bag) {
    for (const k of bag) fuForget(k);
    CACHED_KEYS_BY_COMBAT.delete(combat.id);
  }
}
Hooks.on("combatEnd",    forgetCombatKeys);
Hooks.on("deleteCombat", (_, combat) => { try { forgetCombatKeys(combat); } catch {} });

window[FLAG] = true;
console.log("[FU Cut-In] Receiver installed.");
} catch (err) {
  console.error("[FU Cut-In] Receiver failed to install:", err);
}
  });
})();
