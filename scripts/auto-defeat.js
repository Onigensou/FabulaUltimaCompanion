/* ============================================
 *  ONI - Auto Defeat System (Foundry V12)
 *  File: auto-defeat.js
 * ============================================
 *  What it does:
 *  - Watches HP changes on Actors
 *  - If HP hits 0, checks:
 *    1) Database option: system.props.option_autoDefeat enabled
 *    2) Token disposition is enemy (-1)  [token.document.disposition]
 *    3) Actor has system.props.npc_rank (if missing => skip)
 *    4) Rank must be Soldier/Elite (never Champion)
 *    5) Actor system.props.token_option_persist must NOT be true
 *  - If all pass => runs Defeat operation (auto)
 *
 *  Debug:
 *  - Toggle globalThis.ONI_AUTO_DEFEAT_DEBUG = true/false
 * ============================================ */

(() => {
  // =========================
  // Debug Toggle
  // =========================
  const DEBUG =
    typeof globalThis.ONI_AUTO_DEFEAT_DEBUG === "boolean"
      ? globalThis.ONI_AUTO_DEFEAT_DEBUG
      : true; // default ON for now

  const TAG = "[ONI][AutoDefeat]";

  function log(...args) {
    if (!DEBUG) return;
    console.log(TAG, ...args);
  }
  function warn(...args) {
    if (!DEBUG) return;
    console.warn(TAG, ...args);
  }
  function error(...args) {
    if (!DEBUG) return;
    console.error(TAG, ...args);
  }

  // =========================
  // Config (edit if needed)
  // =========================
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_NS = `module.${MODULE_ID}`;

  // Your system data paths (confirmed from your sample NPC actor JSON)
  const PATH_NPC_RANK = "system.props.npc_rank";
  const PATH_TOKEN_PERSIST = "system.props.token_option_persist";

  // Database option path (your campaign DB actor)
  const PATH_DB_OPTION = "system.props.option_autoDefeat";

  // =========================
  // Helpers
  // =========================
  function get(obj, path, fallback = undefined) {
    try {
      return foundry.utils.getProperty(obj, path) ?? fallback;
    } catch (e) {
      return fallback;
    }
  }

  function normalizeRank(v) {
    if (v == null) return "";
    return String(v).trim().toLowerCase();
  }

  function isAutoDefeatRank(rank) {
    // Only soldier/elite are eligible. Champion is never eligible.
    const r = normalizeRank(rank);
    return r === "soldier" || r === "elite";
  }

  function parseDbOption(value) {
    // Support boolean true, string "ON", "true", "1", etc.
    if (typeof value === "boolean") return value;
    if (value == null) return false;
    const s = String(value).trim().toLowerCase();
    return s === "on" || s === "true" || s === "1" || s === "yes" || s === "enabled";
  }

  function isHpChange(updateData) {
    // We’re watching “current_hp” changes (Custom System Builder style)
    // Your log shows updateActor detects HP related updates correctly already.
    // We’ll keep it broad but safe:
    const flat = foundry.utils.flattenObject(updateData ?? {});
    const keys = Object.keys(flat);
    const hit = keys.some((k) => k.includes("current_hp") || k.includes("attributeBar") || k.includes("hp"));
    return { hit, keys };
  }

  // =========================
  // DB Resolver (your requested fix)
  // =========================
  async function resolveDatabaseActor() {
    // 1) Preferred: FUCompanion DB_Resolver API
    const resolver =
      globalThis.FUCompanion?.api?.DB_Resolver ||
      globalThis.fucompanion?.api?.DB_Resolver ||
      globalThis.ONI?.DB_Resolver;

    if (resolver) {
      log("DB_Resolver detected:", resolver);

      // Try common function names (so this script survives small refactors)
      const candidates = [
        resolver.getDatabaseActor,
        resolver.resolveDatabaseActor,
        resolver.getDatabase,
        resolver.resolveDatabase,
        resolver.getGlobalDatabaseActor,
      ].filter((fn) => typeof fn === "function");

      for (const fn of candidates) {
        try {
          const db = await fn.call(resolver);
          if (db?.id) {
            log("DB_Resolver resolved database actor:", { name: db.name, id: db.id });
            return db;
          }
        } catch (e) {
          warn("DB_Resolver method failed, trying next:", e);
        }
      }

      warn("DB_Resolver exists but no working resolver method was found.");
    } else {
      warn("DB_Resolver not found on globalThis.FUCompanion.api.DB_Resolver (or aliases).");
    }

    // 2) Fallback (only if DB_Resolver is missing)
    // This is intentionally strict: if more than 1 candidate, we refuse to guess.
    const all = game.actors?.contents ?? [];
    const matches = all.filter((a) => get(a, PATH_DB_OPTION) !== undefined);

    if (matches.length === 1) {
      warn("Fallback DB resolve used (single match):", { name: matches[0].name, id: matches[0].id });
      return matches[0];
    }

    warn("Fallback DB resolve refused (ambiguous). Found:", matches.map((a) => `${a.name} (${a.id})`));
    return null;
  }

  // =========================
  // Defeat Operation (auto)
  // =========================
  async function performDefeat(token) {
    // token is a Token (placeable object) OR TokenDocument — we’ll normalize.
    const tokenDoc = token?.document ?? token;
    const scene = tokenDoc?.parent;
    if (!tokenDoc?.id || !scene?.id) {
      warn("performDefeat aborted (bad token):", { token, tokenDoc, scene });
      return;
    }

    // If not GM, ask GM to do it (token deletion/combat edits are GM operations)
    if (!game.user.isGM) {
      log("Not GM -> requesting GM defeat via socket:", { sceneId: scene.id, tokenId: tokenDoc.id });
      game.socket.emit(SOCKET_NS, {
        type: "AUTO_DEFEAT_REQUEST",
        sceneId: scene.id,
        tokenId: tokenDoc.id,
      });
      return;
    }

    log("GM performing defeat now:", {
      token: tokenDoc.name,
      tokenId: tokenDoc.id,
      scene: scene.name,
      sceneId: scene.id,
    });

    // 1) Remove combatant if in combat
    try {
      const combats = game.combats?.contents ?? [];
      for (const c of combats) {
        const combatant = c?.combatants?.find((cb) => cb.tokenId === tokenDoc.id);
        if (combatant) {
          log("Removing combatant:", { combat: c.name, combatId: c.id, combatantId: combatant.id });
          await c.deleteEmbeddedDocuments("Combatant", [combatant.id]);
        }
      }
    } catch (e) {
      warn("Combatant removal failed (continuing):", e);
    }

    // 2) Optional: set a “defeated” visual marker before delete (very short)
    // If you have a specific effect from your Defeat.js, swap it in here.
    try {
      await tokenDoc.update({ alpha: 0.35 });
    } catch (e) {
      // ignore
    }

    // 3) Delete the token (this is the “auto defeat” end result)
    try {
      log("Deleting token document...");
      await tokenDoc.delete();
      log("Token deleted.");
    } catch (e) {
      error("Token delete failed:", e);
    }
  }

  // =========================
  // Gate + Execute
  // =========================
  async function tryAutoDefeatForActor(actor, updateData, options, userId) {
    try {
      if (!actor) return;

      // A) HP update gate
      const hpCheck = isHpChange(updateData);
      if (!hpCheck.hit) return;

      // We read current HP from your NPC data shape (custom system builder style)
      const currentHp = Number(get(actor, "system.props.current_hp", NaN));
      if (!Number.isFinite(currentHp)) {
        // Some actors may store HP differently; if so we skip rather than guessing.
        log("HP path not found -> skip actor:", {
          actor: `${actor.name} (${actor.id})`,
          triedPath: "system.props.current_hp",
        });
        return;
      }

      log("updateActor detected (HP related):", {
        actor: `${actor.name} (${actor.id})`,
        userId,
        newHp: currentHp,
        changedKeys: hpCheck.keys,
      });

      // Only when HP is exactly 0
      if (currentHp !== 0) return;

      // B) Resolve DB + option check
      const dbActor = await resolveDatabaseActor();
      if (!dbActor) {
        warn("No database actor resolved -> skip.");
        return;
      }

      const dbValue = get(dbActor, PATH_DB_OPTION);
      const enabled = parseDbOption(dbValue);

      log("DB option check:", {
        dbActor: `${dbActor.name} (${dbActor.id})`,
        optionPath: PATH_DB_OPTION,
        rawValue: dbValue,
        enabled,
      });

      if (!enabled) return;

      // C) New gate: token_option_persist
      const persist = Boolean(get(actor, PATH_TOKEN_PERSIST, false));
      if (persist) {
        log("token_option_persist is TRUE -> skip auto defeat:", {
          actor: `${actor.name} (${actor.id})`,
          path: PATH_TOKEN_PERSIST,
          value: persist,
        });
        return;
      }

      // D) New gate: npc_rank must exist (if missing -> skip)
      const npcRank = get(actor, PATH_NPC_RANK, undefined);
      if (npcRank === undefined || npcRank === null || String(npcRank).trim() === "") {
        log("npc_rank missing -> exclude from auto defeat (likely Player Actor):", {
          actor: `${actor.name} (${actor.id})`,
          path: PATH_NPC_RANK,
          value: npcRank,
        });
        return;
      }

      // E) Rank must be Soldier/Elite only
      if (!isAutoDefeatRank(npcRank)) {
        log("Rank not eligible -> skip:", { actor: actor.name, npcRank });
        return;
      }

      // F) Get the active token(s) for this actor, then disposition gate on TokenDocument
      const tokens = actor.getActiveTokens(true, true) ?? [];
      if (!tokens.length) {
        warn("Actor HP hit 0 but no active tokens found -> skip:", actor.name);
        return;
      }

      log("Active tokens found for actor:", tokens.map((t) => `${t.name} (${t.id})`));

      for (const token of tokens) {
        const dispo = token?.document?.disposition; // <-- FIX (your confirmed correct path)
        if (dispo !== -1) {
          log("Disposition not enemy (-1) -> skip token:", {
            token: token.name,
            disposition: dispo,
          });
          continue;
        }

        // Final pass: execute defeat
        log("AUTO DEFEAT PASSED ALL GATES -> executing:", {
          token: token.name,
          actor: actor.name,
          npcRank,
          disposition: dispo,
        });

        await performDefeat(token);
      }
    } catch (e) {
      error("tryAutoDefeatForActor crashed:", e);
    }
  }

  // =========================
  // Socket (GM executes requests)
  // =========================
  function installSocketListener() {
    game.socket.off(SOCKET_NS, onSocketMessage);
    game.socket.on(SOCKET_NS, onSocketMessage);
    log("Socket listener installed:", SOCKET_NS);
  }

  async function onSocketMessage(payload) {
    try {
      if (!payload || payload.type !== "AUTO_DEFEAT_REQUEST") return;
      if (!game.user.isGM) return;

      const { sceneId, tokenId } = payload;
      const scene = game.scenes.get(sceneId);
      const tokenDoc = scene?.tokens?.get(tokenId);

      log("GM received AUTO_DEFEAT_REQUEST:", { sceneId, tokenId, hasScene: !!scene, hasToken: !!tokenDoc });

      if (!scene || !tokenDoc) return;
      await performDefeat(tokenDoc);
    } catch (e) {
      error("Socket handler crashed:", e);
    }
  }

  // =========================
  // Hook Install
  // =========================
  function installHooks() {
    // IMPORTANT: updateActor is what your HP bar change is firing (from your log),
    // so we hook there and then find active tokens for that actor.
    Hooks.off("updateActor", onUpdateActor);
    Hooks.on("updateActor", onUpdateActor);
    log("Hook installed: updateActor");
  }

  async function onUpdateActor(actor, updateData, options, userId) {
    // Don’t run on compendium/synthetic weirdness; try anyway but safely.
    await tryAutoDefeatForActor(actor, updateData, options, userId);
  }

  // =========================
  // Boot
  // =========================
  Hooks.once("ready", () => {
    log("Booting Auto Defeat system...", { DEBUG });
    installSocketListener();
    installHooks();
    log("Auto Defeat system READY.");
  });
})();
