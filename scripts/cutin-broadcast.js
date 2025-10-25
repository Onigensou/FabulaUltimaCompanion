// ─────────────────────────────────────────────────────────────
//  FU Portrait Cut-In • Broadcaster (Foundry VTT v12)
//  Module: fabula-ultima-companion · Socketlib executeForEveryone
//  - Resolve image & sfx based on token + cut-in type
//  - Build deterministic payload with shared t0
//  - Debounce; local fallback to receiver if present
//  Public API: window.FUCompanion.api.cutinBroadcast(opts)
// ─────────────────────────────────────────────────────────────
(() => {
  const MODULE_ID    = "fabula-ultima-companion";
  const ACTION_KEY   = "FU_CUTIN_PLAY";
  const NS           = "FUCompanion";
  const DEBOUNCE_KEY = "__FU_CUTIN_LAST_EMIT";
  const DEBOUNCE_MS  = 600;

  // SFX map by type
  const SFX = {
    critical:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BurstMax.ogg",
    zero_power: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/ChargeAttack.ogg",
    fumble:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Down2.ogg"
  };

  // Default visuals
  const DEFAULTS = {
    delayMs: 900,
    dimAlpha: 0.6, dimFadeMs: 200,
    flashPeak: 0.9, flashInMs: 70, flashOutMs: 180, flashDelayMs: 60,
    slideInMs: 650, holdMs: 900, slideOutMs: 650,
    portraitHeightRatio: 0.9, portraitBottomMargin: 40, portraitInsetX: 220,
    sfxVol: 0.9
  };

  // Helpers
  async function tokenFromUuid(uuid) { try { return await fromUuid(uuid); } catch { return null; } }
  function imageFromActorByType(token, type) {
    const props = token?.actor?.system?.props ?? {};
    switch (type) {
      case "critical":   return props.cut_in_critical || null;
      case "zero_power": return props.cut_in_zero_power || null;
      case "fumble":     return props.cut_in_fumble || null;
      default:           return null;
    }
  }
  // Validate a number or fall back to default
  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

  async function cutinBroadcast({
    tokenUuid,        // string (required if imgUrl not provided)
    type,             // "critical" | "zero_power" | "fumble"
    imgUrl,           // optional override image
    // optional visual overrides:
    delayMs, dimAlpha, dimFadeMs,
    flashPeak, flashInMs, flashOutMs, flashDelayMs,
    slideInMs, holdMs, slideOutMs,
    portraitHeightRatio, portraitBottomMargin, portraitInsetX,
    sfxUrl, sfxVol
  } = {}) {
    // Debounce
    const now  = Date.now();
    const last = window[DEBOUNCE_KEY] ?? 0;
    if (now - last < DEBOUNCE_MS) {
      ui.notifications.warn("Cut-in already queued—please wait a moment.");
      return;
    }
    window[DEBOUNCE_KEY] = now;

    // socketlib ready?
    const sockMod = game.modules.get("socketlib");
    if (!sockMod?.active || !window.socketlib) {
      ui.notifications.error("FU Cut-In: socketlib not found/active.");
      return;
    }
    const socket = socketlib.registerModule(MODULE_ID);

    // Resolve image & sfx
    let url = imgUrl ?? null;
    if (!url && tokenUuid && type) {
      const tok = await tokenFromUuid(tokenUuid);
      url = imageFromActorByType(tok, type);
    }
    const finalSfx = sfxUrl ?? (type ? SFX[type] : null);

    // Validate all numbers and compute t0
    const v = {
      delayMs:              num(delayMs,              DEFAULTS.delayMs),
      dimAlpha:             num(dimAlpha,             DEFAULTS.dimAlpha),
      dimFadeMs:            num(dimFadeMs,            DEFAULTS.dimFadeMs),
      flashPeak:            num(flashPeak,            DEFAULTS.flashPeak),
      flashInMs:            num(flashInMs,            DEFAULTS.flashInMs),
      flashOutMs:           num(flashOutMs,           DEFAULTS.flashOutMs),
      flashDelayMs:         num(flashDelayMs,         DEFAULTS.flashDelayMs),
      slideInMs:            num(slideInMs,            DEFAULTS.slideInMs),
      holdMs:               num(holdMs,               DEFAULTS.holdMs),
      slideOutMs:           num(slideOutMs,           DEFAULTS.slideOutMs),
      portraitHeightRatio:  num(portraitHeightRatio,  DEFAULTS.portraitHeightRatio),
      portraitBottomMargin: num(portraitBottomMargin, DEFAULTS.portraitBottomMargin),
      portraitInsetX:       num(portraitInsetX,       DEFAULTS.portraitInsetX),
      sfxVol:               num(sfxVol,               DEFAULTS.sfxVol),
    };
    const t0 = Date.now() + v.delayMs;

    const payload = {
      imgUrl: url || null,
      t0,
      sfxUrl: finalSfx || null,
      sfxVol: v.sfxVol,
      dimAlpha: v.dimAlpha,
      dimFadeMs: v.dimFadeMs,
      flashPeak: v.flashPeak,
      flashInMs: v.flashInMs,
      flashOutMs: v.flashOutMs,
      flashDelayMs: v.flashDelayMs,
      slideInMs: v.slideInMs,
      holdMs: v.holdMs,
      slideOutMs: v.slideOutMs,
      portraitHeightRatio: v.portraitHeightRatio,
      portraitBottomMargin: v.portraitBottomMargin,
      portraitInsetX: v.portraitInsetX
    };

    // Broadcast to everyone
    await socket.executeForEveryone(ACTION_KEY, payload);

    // Local fallback (fire on this client, too)
    try { window.__FU_CUTIN_PLAY?.(payload); } catch {}

    // Release debounce once the show should have started
    setTimeout(() => {
      if (window[DEBOUNCE_KEY] === now) window[DEBOUNCE_KEY] = 0;
    }, v.delayMs + 200);

    console.log("[FU Cut-In • Broadcast] payload:", payload);
  }

  // Expose API
  window[NS] = window[NS] || {};
  window[NS].api = window[NS].api || {};
  window[NS].api.cutinBroadcast = cutinBroadcast;
})();
