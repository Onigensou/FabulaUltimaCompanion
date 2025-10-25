// ─────────────────────────────────────────────────────────────
//  FU Portrait Cut-In • Broadcaster (Foundry VTT v12)
//  Module: fabula-ultima-companion · Socketlib executeForEveryone
//  - Resolve image & sfx based on token + cut-in type
//  - Build deterministic payload with shared t0
//  - Debounce; local fallback to receiver if present
//  Public API: window.FUCompanion.api.cutinBroadcast(opts)
// ─────────────────────────────────────────────────────────────
(() => {
  const MODULE_ID  = "fabula-ultima-companion";
  const ACTION_KEY = "FU_CUTIN_PLAY";
  const NS         = "FUCompanion";
  const DEBOUNCE_KEY = "__FU_CUTIN_LAST_EMIT";
  const DEBOUNCE_MS  = 600;

  // SFX map by type
  const SFX = {
    critical:    "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BurstMax.ogg",
    zero_power:  "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/ChargeAttack.ogg",
    fumble:      "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Down2.ogg"
  };

  // Default visuals (you can override per call)
  const DEFAULTS = {
    delayMs: 900,                     // buffer before t0 (sync safety per manifesto)  :contentReference[oaicite:6]{index=6}
    dimAlpha: 0.6, dimFadeMs: 200,
    flashPeak: 0.9, flashInMs: 70, flashOutMs: 180, flashDelayMs: 60,
    slideInMs: 650, holdMs: 900, slideOutMs: 650,
    portraitHeightRatio: 0.9, portraitBottomMargin: 40, portraitInsetX: 220,
    sfxVol: 0.9
  };

  // Helper: resolve token from UUID (works from any client)
  async function tokenFromUuid(uuid) {
    try { return await fromUuid(uuid); } catch { return null; }
  }

  // Helper: read cut-in image from actor props by type; return null if missing
  function imageFromActorByType(token, type) {
    const props = token?.actor?.system?.props ?? {};
    switch (type) {
      case "critical":   return props.cut_in_critical || null;
      case "zero_power": return props.cut_in_zero_power || null;
      case "fumble":     return props.cut_in_fumble || null;
      default:           return null;
    }
  }

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
    // Basic validation
    const now = Date.now();
    const last = window[DEBOUNCE_KEY] ?? 0;
    if (now - last < DEBOUNCE_MS) {
      ui.notifications.warn("Cut-in already queued—please wait a moment.");
      return;
    }
    window[DEBOUNCE_KEY] = now;

    const sockMod = game.modules.get("socketlib");
    if (!sockMod?.active || !window.socketlib) {
      ui.notifications.error("FU Cut-In: socketlib not found/active.");
      return;
    }
    const socket = socketlib.registerModule(MODULE_ID);

    // Resolve art + sfx
    let url = imgUrl ?? null;
    if (!url && tokenUuid && type) {
      const tok = await tokenFromUuid(tokenUuid);
      url = imageFromActorByType(tok, type);
    }

    // If still no URL, we still broadcast a payload with imgUrl=null — clients will quietly skip.
    const finalSfx = sfxUrl ?? (type ? SFX[type] : null);

    // Build deterministic payload (everyone renders locally at the same t0)
    const conf = { ...DEFAULTS, delayMs, dimAlpha, dimFadeMs, flashPeak, flashInMs, flashOutMs, flashDelayMs,
                   slideInMs, holdMs, slideOutMs, portraitHeightRatio, portraitBottomMargin, portraitInsetX, sfxVol };
    const t0 = Date.now() + (Number(conf.delayMs) || DEFAULTS.delayMs);

    const payload = {
      imgUrl: url || null,
      t0,
      sfxUrl: finalSfx || null,
      sfxVol: Number(conf.sfxVol) || DEFAULTS.sfxVol,
      dimAlpha: Number(conf.dimAlpha),
      dimFadeMs: Number(conf.dimFadeMs),
      flashPeak: Number(conf.flashPeak),
      flashInMs: Number(conf.flashInMs),
      flashOutMs: Number(conf.flashOutMs),
      flashDelayMs: Number(conf.flashDelayMs),
      slideInMs: Number(conf.slideInMs),
      holdMs: Number(conf.holdMs),
      slideOutMs: Number(conf.slideOutMs),
      portraitHeightRatio: Number(conf.portraitHeightRatio),
      portraitBottomMargin: Number(conf.portraitBottomMargin),
      portraitInsetX: Number(conf.portraitInsetX)
    };

    // Broadcast to everyone (receiver must already be installed)
    await socket.executeForEveryone(ACTION_KEY, payload);

    // Local fallback (least surprise)  (pattern per your PoC broadcaster) :contentReference[oaicite:7]{index=7}
    try { window.__FU_CUTIN_PLAY?.(payload); } catch {}

    // Release debounce after scheduled start (so user can trigger again after it fires)
    setTimeout(() => { if (window[DEBOUNCE_KEY] === now) window[DEBOUNCE_KEY] = 0; }, (Number(conf.delayMs)||900) + 200);

    console.log("[FU Cut-In • Broadcast] payload:", payload);
  }

  // Expose API under your module namespace
  window[NS] = window[NS] || {};
  window[NS].api = window[NS].api || {};
  window[NS].api.cutinBroadcast = cutinBroadcast;
})();
