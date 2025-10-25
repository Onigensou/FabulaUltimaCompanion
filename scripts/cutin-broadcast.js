// scripts/cutin-broadcast.js
// ─────────────────────────────────────────────────────────────
//  Fabula Ultima Companion • Cut-in Broadcaster (Foundry VTT v12)
//  • Exposes: game.modules.get('fabula-ultima-companion')?.api.cutin.broadcast(opts)
//  • Looks up actor-specific art by type (critical / zeroPower / fumble)
//  • Debounced; skips gracefully if actor has no cut-in configured
//  • Plays type-specific SFX (Critical / Zero Power / Fumble)
//  Requires: socketlib
// ─────────────────────────────────────────────────────────────
(() => {
  const MODULE_ID  = "fabula-ultima-companion";
  const ACTION_KEY = "FU_CUTIN_PLAY_V1";
  const EMIT_FLAG  = "__FU_CUTIN_LAST_EMIT_AT";
  const DEBOUNCE_MS = 600;

  // SFX map (per your request)
  const SFX = {
    critical:  { url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BurstMax.ogg",   vol: 0.9 },
    zeroPower: { url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/ChargeAttack.ogg", vol: 0.9 },
    fumble:    { url: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Down2.ogg",       vol: 0.9 }
  };

  // Visual defaults (match your PoC feel)
  const DEFAULTS = {
    DELAY_MS: 900,                 // schedule slightly in the future for sync
    DIM_ALPHA: 0.6,                // background dim amount
    DIM_FADE_MS: 200,
    SLIDE_IN_MS: 650,
    HOLD_MS: 900,
    SLIDE_OUT_MS: 650,
    PORTRAIT_HEIGHT_RATIO: 0.90,   // 90% of screen height
    PORTRAIT_BOTTOM_MARGIN: 40,
    PORTRAIT_INSET_X: 220,
    FLASH_COLOR: 0xFFFFFF,
    FLASH_PEAK: 0.9,
    FLASH_IN_MS: 70,
    FLASH_OUT_MS: 180,
    FLASH_DELAY_MS: 60
  };

  // Safe lookup helper for token/actor
  async function resolveActorAndImage({ tokenUuid, type }) {
    let tokenDoc = null;
    try { tokenDoc = tokenUuid ? await fromUuid(tokenUuid) : canvas?.tokens?.controlled?.[0]?.document; } catch {}
    const actor = tokenDoc?.actor ?? game?.actors?.get(tokenUuid); // fallback

    if (!actor) return { imgUrl: null, actor: null };

    // Sheet keys you specified
    const props = actor?.system?.props ?? {};
    const map = {
      critical:  props?.cut_in_critical,
      zeroPower: props?.cut_in_zero_power,
      fumble:    props?.cut_in_fumble
    };

    const imgUrl = (map[type] || "").toString().trim() || null;
    return { imgUrl, actor };
  }

  // Broadcast core
  async function broadcastCutIn(opts = {}) {
    // Debounce accidental double-clicks
    const now = Date.now();
    const last = window[EMIT_FLAG] ?? 0;
    if (now - last < DEBOUNCE_MS) {
      ui.notifications.warn("Cut-in already queued—please wait a moment.");
      return false;
    }
    window[EMIT_FLAG] = now;

    // Require socketlib
    const sockMod = game.modules.get("socketlib");
    if (!sockMod?.active || !window.socketlib) {
      ui.notifications.error("Fabula Ultima Companion: socketlib is required for Cut-ins.");
      return false;
    }
    const socket = socketlib.registerModule(MODULE_ID);

    // Required option: type
    const type = String(opts.type || "").toLowerCase();
    if (!["critical", "zeropower", "fumble"].includes(type)) {
      ui.notifications.error("Cut-in broadcast: opts.type must be 'critical' | 'zeroPower' | 'fumble'.");
      return false;
    }
    const normalizedType = (type === "zeropower") ? "zeroPower" : type;

    // Resolve actor + art
    const { imgUrl } = await resolveActorAndImage({ tokenUuid: opts.tokenUuid, type: normalizedType });

    // If no art configured for this actor → skip gracefully (no errors)
    if (!imgUrl) {
      console.log("[FU Cut-in] No image set for", normalizedType, "—skipping.");
      // Clear debounce sooner so user can try another cut-in quickly
      setTimeout(() => { if (window[EMIT_FLAG] === now) window[EMIT_FLAG] = 0; }, 200);
      return false;
    }

    // Type SFX
    const sfx = SFX[normalizedType] || {};
    const t0  = Date.now() + (opts.delayMs ?? DEFAULTS.DELAY_MS);

    const payload = {
      imgUrl,
      t0,
      sfxUrl: opts.sfxUrl ?? sfx.url ?? null,
      sfxVol: opts.sfxVol ?? sfx.vol ?? 0.9,
      dimAlpha: opts.dimAlpha ?? DEFAULTS.DIM_ALPHA,
      dimFadeMs: opts.dimFadeMs ?? DEFAULTS.DIM_FADE_MS,
      slideInMs: opts.slideInMs ?? DEFAULTS.SLIDE_IN_MS,
      holdMs: opts.holdMs ?? DEFAULTS.HOLD_MS,
      slideOutMs: opts.slideOutMs ?? DEFAULTS.SLIDE_OUT_MS,
      portraitHeightRatio: opts.portraitHeightRatio ?? DEFAULTS.PORTRAIT_HEIGHT_RATIO,
      portraitBottomMargin: opts.portraitBottomMargin ?? DEFAULTS.PORTRAIT_BOTTOM_MARGIN,
      portraitInsetX: opts.portraitInsetX ?? DEFAULTS.PORTRAIT_INSET_X,
      flashColor: opts.flashColor ?? DEFAULTS.FLASH_COLOR,
      flashPeak: opts.flashPeak ?? DEFAULTS.FLASH_PEAK,
      flashInMs: opts.flashInMs ?? DEFAULTS.FLASH_IN_MS,
      flashOutMs: opts.flashOutMs ?? DEFAULTS.FLASH_OUT_MS,
      flashDelayMs: opts.flashDelayMs ?? DEFAULTS.FLASH_DELAY_MS
    };

    // Broadcast to all clients (sync via t0).
    await socket.executeForEveryone(ACTION_KEY, payload);

    // Local fallback (if receiver is already loaded on this client)
    try { window.FUCompanion?.cutin?.playLocal?.(payload); } catch (_) {}

    // Release debounce after scheduled start window so further clicks work
    setTimeout(() => { if (window[EMIT_FLAG] === now) window[EMIT_FLAG] = 0; }, (opts.delayMs ?? DEFAULTS.DELAY_MS) + 200);

    console.log("[FU Cut-in] Broadcast", normalizedType, payload);
    return true;
  }

  // Expose API on the module for easy macro calls
  const mod = game.modules.get(MODULE_ID);
  mod.api = mod.api || {};
  mod.api.cutin = mod.api.cutin || {};
  mod.api.cutin.broadcast = broadcastCutIn;

  console.log("[FU Cut-in] Broadcaster API ready at modules.get('%s').api.cutin.broadcast(opts)", MODULE_ID);
})();
