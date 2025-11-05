// scripts/namecard-broadcast.js
// Broadcast a NameCard to all clients with a shared t0 (socketlib).
// Exposes: window.FUCompanion.api.namecardBroadcast({ title, options, delayMs? })

(() => {
  const MODULE_ID  = "fabula-ultima-companion";
  const ACTION_KEY = "FU_NAMECARD_SHOW";

  window.FUCompanion = window.FUCompanion || { api: {} };

  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

  async function namecardBroadcast({ title, options = {}, delayMs = 120 } = {}) {
    // Use socketlib (like cut-ins) so every client runs off the same payload
    const sockMod = game.modules.get("socketlib");
    if (!sockMod?.active || !window.socketlib) {
      ui.notifications.error("NameCard: socketlib not found/active.");
      return;
    }
    const socket = socketlib.registerModule(MODULE_ID);

    // Active users only (helps big tables)
    const activeUsers = (game.users?.filter(u => u.active) ?? []).map(u => u.id);

    // Shared start time (slight delay so everyone can schedule)
    const t0 = Date.now() + num(delayMs, 120);

    const payload = {
      t0,
      title: String(title ?? "—"),
      options: options || {},
      allowedUserIds: activeUsers
    };

    // Dispatch to all active users (including ourselves) deterministically
    if (typeof socket.executeForUsers === "function" && activeUsers.length) {
      await socket.executeForUsers(ACTION_KEY, activeUsers, payload);
    } else {
      await socket.executeForEveryone(ACTION_KEY, payload);
    }

    // NOTE: Do NOT show locally first — we want perfect sync at t0 on all clients
  }

  window.FUCompanion.api.namecardBroadcast = namecardBroadcast;
})();
