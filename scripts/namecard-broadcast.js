// scripts/namecard-broadcast.js
// Broadcast a NameCard to all clients (and also show locally).
// Exposes: window.FUCompanion.api.namecardBroadcast({ title, options })

(() => {
  window.FUCompanion = window.FUCompanion || { api: {} };

  // --- Only run in active combat ---
  function isCombatActive() {
    // Conservative check that works across v10+:
    // - started = true once the first turn begins
    // - round > 0 also indicates an active encounter
    const c = game?.combat;
    return !!(c && (c.started || (c.round ?? 0) > 0));
  }

  async function namecardBroadcast({ title, options = {} }) {
    // do nothing if combat isn't active
    if (!isCombatActive()) return;

    // show locally first (feels snappy)
    try { await window.FUCompanion.api.showNameCardLocal?.(title, options); } catch (e) { console.warn(e); }

    // broadcast to everyone
    try {
      await game.socket?.emit?.("module.fabula-ultima-companion", {
        type: "namecard",
        title,
        options
      });
    } catch (e) {
      console.warn("[NameCard] broadcast failed:", e);
    }
  }

  window.FUCompanion.api.namecardBroadcast = namecardBroadcast;
})();
