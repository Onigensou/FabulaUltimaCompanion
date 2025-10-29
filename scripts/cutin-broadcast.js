// ─────────────────────────────────────────────────────────────
//  FU Portrait Cut-In • Broadcaster (Foundry VTT v12)
// ─────────────────────────────────────────────────────────────
(() => {
  const MODULE_ID    = "fabula-ultima-companion";
  const ACTION_KEY   = "FU_CUTIN_PLAY";
  const NS           = "FUCompanion";
  const DEBOUNCE_KEY = "__FU_CUTIN_LAST_EMIT";
  const DEBOUNCE_MS  = 600;

  function cutinImgKey(actorId, type) { return `cutin:${actorId}:${type}`; }
  function cutinSfxKey(type) { return `sfx:${type}`; }

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
    sfxVol: 0.9,
    ttlMs: 3000 // ⟵ NEW: expires window to avoid late-join floods
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
  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

  async function cutinBroadcast({
    tokenUuid,
    type, imgUrl,
    // optional visual overrides:
    delayMs, dimAlpha, dimFadeMs,
    flashPeak, flashInMs, flashOutMs, flashDelayMs,
    slideInMs, holdMs, slideOutMs,
    portraitHeightRatio, portraitBottomMargin, portraitInsetX,
    sfxUrl, sfxVol,
    ttlMs
  } = {}) {
    // Debounce
    const now  = Date.now();
    const last = window[DEBOUNCE_KEY] ?? 0;
    if (now - last < DEBOUNCE_MS) {
      ui.notifications.warn("Cut-in already queued—please wait a moment.");
      return;
    }
    window[DEBOUNCE_KEY] = now;

    // socketlib
    const sockMod = game.modules.get("socketlib");
    if (!sockMod?.active || !window.socketlib) {
      ui.notifications.error("FU Cut-In: socketlib not found/active.");
      return;
    }
    const socket = socketlib.registerModule(MODULE_ID);

    // Resolve image & sfx as KEYS (not URLs)
let imgKey = null;
let urlForLegacy = imgUrl ?? null; // optional compatibility

if (!urlForLegacy && tokenUuid && type) {
  const tok = await tokenFromUuid(tokenUuid);
  urlForLegacy = imageFromActorByType(tok, type) || null;
  if (tok?.actor?.id && type) {
    imgKey = cutinImgKey(tok.actor.id, type);
  }
}

const sfxKey = type ? cutinSfxKey(type) : null;

    // Validate all numbers
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
      ttlMs:                num(ttlMs,                DEFAULTS.ttlMs)
    };

    // Shared start time & expiry
    const t0       = Date.now() + v.delayMs;
    const expireAt = t0 + v.ttlMs;

    // Only target users who are currently active
    const activeUsers = (game.users?.filter(u => u.active) ?? []).map(u => u.id);

   const payload = {
  // sync timing
  t0, 
  expireAt,

  // keys ONLY (strict cache mode)
  imgKey: imgKey ?? null,
  sfxKey: sfxKey ?? null,
  sfxVol: v.sfxVol,

  // visuals
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
  portraitInsetX: v.portraitInsetX,

  // delivery
  allowedUserIds: activeUsers
};

    // Prefer executeForUsers if available
    if (typeof socket.executeForUsers === "function" && activeUsers.length) {
      await socket.executeForUsers(ACTION_KEY, activeUsers, payload);
    } else {
      await socket.executeForEveryone(ACTION_KEY, payload);
    }

    // Local fallback
    try { window.__FU_CUTIN_PLAY?.(payload); } catch {}

    // Release debounce
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
