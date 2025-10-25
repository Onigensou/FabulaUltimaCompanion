// ─────────────────────────────────────────────────────────────
//  FU Cut-In • Broadcaster API (Foundry VTT v12 + socketlib)
//  - Call this from ANY macro or script to play a cut-in
//  - Chooses image from actor sheet (Zero Power / Critical / Fumble)
//  - Debounced sender + socket executeForEveryone + local fallback
// ─────────────────────────────────────────────────────────────
(() => {
  const MODULE_ID  = "fabula-ultima-companion";
  const ACTION_KEY = "FU_CUTIN_PLAY";

  // SFX by type (provided)
  const SFX = {
    critical: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/BurstMax.ogg",
    zero:     "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/ChargeAttack.ogg",
    fumble:   "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Down2.ogg"
  };

  // UI-friendly defaults per type
  const PRESET = {
    critical: { dimAlpha: 0.65, flashPeak: 1.0, flashInMs: 60,  flashOutMs: 180, flashDelayMs: 40, slideInMs: 380, holdMs: 950,  slideOutMs: 600 },
    zero:     { dimAlpha: 0.7,  flashPeak: 0.9, flashInMs: 100, flashOutMs: 220, flashDelayMs: 80, slideInMs: 520, holdMs: 1200, slideOutMs: 700 },
    fumble:   { dimAlpha: 0.5,  flashPeak: 0.6, flashInMs: 60,  flashOutMs: 180, flashDelayMs: 0,  slideInMs: 420, holdMs: 850,  slideOutMs: 600 }
  };

  // Debounce to block accidental double taps
  const DEBOUNCE_MS = 600;
  const LAST_KEY    = "__FU_CUTIN_LAST_EMIT";
  function debounced() {
    const now  = Date.now();
    const last = window[LAST_KEY] ?? 0;
    if (now - last < DEBOUNCE_MS) return false;
    window[LAST_KEY] = now;
    // auto-clear shortly after scheduled start
    setTimeout(() => { if (window[LAST_KEY] === now) window[LAST_KEY] = 0; }, 1200);
    return true;
  }

  // Resolve actor from uuid or current selection
  async function resolveActor(actorUuid) {
    if (actorUuid) {
      try { return await fromUuid(actorUuid); } catch (e) {}
    }
    // fallback: selected token's actor
    const sel = canvas?.tokens?.controlled?.[0];
    return sel?.actor ?? game.user?.character ?? null;
  }

  // Pull cut-in URL from your PC sheet fields
  function pickCutInUrl(actor, type, overrideUrl) {
    if (overrideUrl && String(overrideUrl).trim()) return String(overrideUrl).trim();

    const sys = actor?.system ?? {};
    const map = {
      zero:     sys.cut_in_zero_power,
      critical: sys.cut_in_critical,
      fumble:   sys.cut_in_fumble
    };
    const url = map[type] ?? "";
    return (typeof url === "string" && url.trim().length) ? url.trim() : "";
  }

  // Public API: Broadcast
  async function broadcastCutIn({ actorUuid=null, type="critical", imgUrl=null, opts={} } = {}) {
    const actor = await resolveActor(actorUuid);
    // If no actor (or NPCs without those fields) skip gracefully
    const img = pickCutInUrl(actor, type, imgUrl);
    if (!img) {
      // quietly skip (failsafe requirement)
      console.log("[FU Cut-In] No cut-in image defined for this character; skipping.");
      return false;
    }

    // Socketlib
    const sockMod = game.modules.get("socketlib");
    const socketOk = !!(sockMod?.active && window.socketlib);
    const socket   = socketOk ? socketlib.registerModule(MODULE_ID) : null;

    // Compose payload
    const t0 = Date.now() + 800; // small future start to sync everyone
    const preset  = PRESET[type] ?? PRESET.critical;
    const payload = {
      imgUrl: img,
      t0,
      sfxUrl: SFX[type] ?? null,
      sfxVol: 0.9,
      dimAlpha: preset.dimAlpha, dimFadeMs: 200,
      flashColor: 0xFFFFFF, flashPeak: preset.flashPeak, flashInMs: preset.flashInMs, flashOutMs: preset.flashOutMs, flashDelayMs: preset.flashDelayMs,
      slideInMs: preset.slideInMs, holdMs: preset.holdMs, slideOutMs: preset.slideOutMs,
      portraitHeightRatio: 0.9, portraitBottomMargin: 40, portraitInsetX: 220,
      ...opts // allow caller overrides
    };

    // Debounce accidental re-press
    if (!debounced()) {
      ui.notifications.warn("Cut-in already queued—please wait a moment.");
      return false;
    }

    // Broadcast to all (and local fallback)
    if (socketOk) await socket.executeForEveryone(ACTION_KEY, payload);
    try { window.__FU_CUTIN_PLAY?.(payload); } catch (e) { /* ignore */ }

    console.log("[FU Cut-In • Broadcast] emitted", { type, actor: actor?.name, payload });
    return true;
  }

  // Export into FUCompanion namespace without clobbering the renderer object
  window.FUCompanion = window.FUCompanion || {};
  window.FUCompanion.cutin = window.FUCompanion.cutin || {};
  // Attach a .broadcast method alongside .play/.preload from the client script
  window.FUCompanion.cutin.broadcast = broadcastCutIn;

  // Convenience short alias for macros
  window.FU_CUTIN_BROADCAST = broadcastCutIn;
})();
