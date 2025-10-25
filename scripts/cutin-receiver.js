// ─────────────────────────────────────────────────────────────
//  FU Cut-In • Install Receiver (Foundry VTT v12 + socketlib)
//  Queueing, duplicate suppression, and full cleanup
//  Run once on EVERY client (GM + players)
// ─────────────────────────────────────────────────────────────
(() => {
  const MODULE_ID  = "fabula-ultima-companion";
  const ACTION_KEY = "FU_CUTIN_PLAY";
  const FLAG       = "__FU_CUTIN_READY_v2";
  const TAG_ID     = "fu-portrait-cutin";

  if (window[FLAG]) { console.log("[CutIn-Recv] Already active."); return; }

  // socketlib required
  const sockMod = game.modules.get("socketlib");
  if (!sockMod?.active || !window.socketlib) {
    ui.notifications.error("Cut-in receiver: socketlib not found or inactive.");
    return;
  }
  const socket = socketlib.registerModule(MODULE_ID);

  // State: busy/queue & duplicate suppression
  let BUSY = false;
  const QUEUE = [];
  const START_LAG_MS     = 300; // when queueing, next cut-in starts this many ms from "now"
  const DUP_SUPPRESS_MS  = 350; // ignore near-duplicates within this window
  let lastSig = "";
  let lastSigAt = 0;

  // Easing + helpers
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInCubic  = t => t * t * t;
  const easeOutQuad  = t => 1 - (1 - t) * (1 - t);
  const easeInQuad   = t => t * t;
  const sleep        = (ms)=>new Promise(r=>setTimeout(r,ms));

  const loadTexture = async (url) => PIXI.Assets.load(url);

  function tween(obj, prop, from, to, ms, ease=easeOutQuad){
    return new Promise(res=>{
      const start=performance.now(); obj[prop]=from;
      const step=(now)=>{ const t=Math.min(1,(now-start)/ms); obj[prop]=from+(to-from)*ease(t); if(t<1)requestAnimationFrame(step); else res(); };
      requestAnimationFrame(step);
    });
  }
  function tweenXY(obj, xFrom, xTo, yFrom, yTo, ms, ease=easeOutQuad){
    return new Promise(res=>{
      const start=performance.now(); obj.x=xFrom; obj.y=yFrom;
      const step=(now)=>{ const t=Math.min(1,(now-start)/ms); const k=ease(t); obj.x=xFrom+(xTo-xFrom)*k; obj.y=yFrom+(yTo-yFrom)*k; if(t<1)requestAnimationFrame(step); else res(); };
      requestAnimationFrame(step);
    });
  }
  function tweenCombo(items){
    return new Promise(res=>{
      const start=performance.now(); for(const it of items) it.obj[it.prop]=it.from;
      const step=(now)=>{ let done=true;
        for(const it of items){ const t=Math.min(1,(now-start)/it.ms); const k=(it.ease||easeOutQuad)(t); it.obj[it.prop]=it.from+(it.to-it.from)*k; if(t<1) done=false; }
        if(!done) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
  }

  async function runCutIn(payload) {
    BUSY = true;
    try { await __FU_CUTIN_PLAY(payload); }
    finally {
      BUSY = false;
      if (QUEUE.length) {
        const next = QUEUE.shift();
        // reschedule so all clients stay aligned for queued one
        next.t0 = Date.now() + START_LAG_MS;
        runCutIn(next);
      }
    }
  }

  // Main renderer (scheduled at t0), with full cleanup and optional flash
  async function __FU_CUTIN_PLAY(payload = {}) {
    if (!canvas?.ready) return;

    const {
      imgUrl,
      t0 = Date.now() + 1000,
      sfxUrl = null,
      sfxVol = 0.9,
      // visuals
      dimAlpha = 0.6, dimFadeMs = 200,
      flashColor = 0xFFFFFF, flashPeak = 0.9, flashInMs = 70, flashOutMs = 180, flashDelayMs = 60,
      slideInMs = 300, holdMs = 900, slideOutMs = 650,
      portraitHeightRatio = 0.9, portraitBottomMargin = 40, portraitInsetX = 220
    } = payload;
    if (!imgUrl) return;

    // scene switch watchdog
    let sceneChanged = false;
    const onReady = () => { sceneChanged = true; };
    Hooks.once("canvasReady", onReady);

    // remove any previous
    const prev = canvas.stage.children.find(c => c?.name === TAG_ID);
    if (prev) { try { canvas.stage.removeChild(prev); prev.destroy({children:true}); } catch {} }

    const { width: W, height: H } = canvas.app.renderer.screen;
    canvas.stage.sortableChildren = true;

    const layer = new PIXI.Container();
    layer.name = TAG_ID; layer.zIndex = 999999; layer.sortableChildren = true;

    // full-screen layers
    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000,1).drawRect(0,0,W,H).endFill();
    dim.alpha = 0; dim.zIndex = 0; dim.interactive = false; layer.addChild(dim);

    const flash = new PIXI.Graphics();
    flash.beginFill(flashColor,1).drawRect(0,0,W,H).endFill();
    flash.alpha = 0; flash.zIndex = 1; flash.blendMode = PIXI.BLEND_MODES.SCREEN; layer.addChild(flash);

    const onResize = ()=> {
      const { width: w2, height: h2 } = canvas.app.renderer.screen;
      dim.clear().beginFill(0x000000,1).drawRect(0,0,w2,h2).endFill();
      flash.clear().beginFill(flashColor,1).drawRect(0,0,w2,h2).endFill();
    };
    Hooks.on("canvasPan", onResize);
    Hooks.on("resize", onResize);

    const cleanup = () => {
      Hooks.off("canvasPan", onResize);
      Hooks.off("resize", onResize);
      Hooks.off("canvasReady", onReady);
      try { canvas.stage.removeChild(layer); layer.destroy({children:true}); } catch {}
    };

    // Preload during wait: prefer manager if present (warmer), else texture load
    let texPromise;
    if (window.FUCompanion?.cutin) {
      texPromise = (async () => { await window.FUCompanion.cutin.preload(imgUrl); return window.FUCompanion.cutin._texture; })();
    } else {
      texPromise = loadTexture(imgUrl);
    }

    // wait to shared t0
    const wait = Math.max(0, t0 - Date.now());
    await sleep(wait);
    if (sceneChanged) return cleanup();

    const tex = await texPromise;
    const portrait = new PIXI.Sprite(tex);
    portrait.anchor.set(0.0, 1.0); portrait.zIndex = 2;

    const scale = (H * portraitHeightRatio) / portrait.texture.height;
    portrait.scale.set(scale, scale);
    const finalX = portraitInsetX, finalY = H - portraitBottomMargin;
    portrait.x = -portrait.width - 80; portrait.y = finalY; portrait.alpha = 1;

    layer.addChild(portrait);
    canvas.stage.addChild(layer);

    // play sfx
    if (sfxUrl) {
      try { await (foundry?.audio?.AudioHelper ?? AudioHelper).play({src:sfxUrl, volume:sfxVol, loop:false}, true); }
      catch (e) { console.warn("Cut-in SFX failed:", e); }
    }

    // animate: dim → (optional flash) → slide in → hold → slide out → undim
    await tween(dim, "alpha", 0, dimAlpha, dimFadeMs, easeOutQuad);
    await sleep(flashDelayMs);
    await tween(flash, "alpha", 0, flashPeak, flashInMs, easeOutQuad);
    const flashFade = tween(flash, "alpha", flash.alpha, 0, flashOutMs, easeInQuad);

    await tweenXY(portrait, portrait.x, finalX, portrait.y, finalY, slideInMs, easeOutCubic);
    await flashFade;
    await sleep(holdMs);

    const exitX = W + 40;
    await tweenCombo([
     
