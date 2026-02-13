/* ============================================
 *  ONI - Auto Defeat System (Foundry V12)
 *  File: auto-defeat.js
 * ============================================
 *  Uses your DB Resolver public API:
 *    await window.FUCompanion.api.getCurrentGameDb()
 *  (NOT FUCompanion.api.DB_Resolver)
 *
 *  Gates:
 *   - DB option: system.props.option_autoDefeat must be enabled
 *   - Token must be ENEMY: token.document.disposition === -1
 *   - Actor must have npc_rank; if missing => skip
 *   - npc_rank must be Soldier or Elite (never Champion)
 *   - token_option_persist true => skip (never auto defeat)
 *
 *  Debug toggle:
 *   globalThis.ONI_AUTO_DEFEAT_DEBUG = true/false
 * ============================================ */

(() => {
  // -------------------------
  // Debug Toggle
  // -------------------------
  const DEBUG =
    typeof globalThis.ONI_AUTO_DEFEAT_DEBUG === "boolean"
      ? globalThis.ONI_AUTO_DEFEAT_DEBUG
      : true;

  const TAG = "[ONI][AutoDefeat]";
  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => DEBUG && console.warn(TAG, ...a);
  const err = (...a) => DEBUG && console.error(TAG, ...a);

  // -------------------------
  // Config
  // -------------------------
  const MODULE_ID = "fabula-ultima-companion";
  const SOCKET_NS = `module.${MODULE_ID}`;

  const PATH_DB_OPTION = "system.props.option_autoDefeat";
  const PATH_HP = "system.props.current_hp";

  const PATH_NPC_RANK = "system.props.npc_rank";
  const PATH_TOKEN_PERSIST = "system.props.token_option_persist";

  // -------------------------
  // Helpers
  // -------------------------
  function get(obj, path, fallback = undefined) {
    try {
      const v = foundry.utils.getProperty(obj, path);
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }

  function parseDbOption(value) {
    if (typeof value === "boolean") return value;
    if (value == null) return false;
    const s = String(value).trim().toLowerCase();
    return s === "on" || s === "true" || s === "1" || s === "yes" || s === "enabled";
  }

  function normalizeRank(v) {
    return String(v ?? "").trim().toLowerCase();
  }

  function isAllowedRank(rank) {
    const r = normalizeRank(rank);
    if (!r) return false;
    if (r === "champion") return false;
    return r === "soldier" || r === "elite";
  }

  function hpUpdateDetected(updateData) {
    const flat = foundry.utils.flattenObject(updateData ?? {});
    const keys = Object.keys(flat);
    const hit = keys.some((k) => k.includes("current_hp"));
    return { hit, keys };
  }

  // -------------------------
  // DB Resolver (FIXED)
  // -------------------------
  async function resolveDatabaseActor() {
    // Per your guide, the resolver API lives here:
    // window.FUCompanion.api.getCurrentGameDb()
    const api = globalThis?.FUCompanion?.api || window?.FUCompanion?.api;

    if (!api) {
      warn("FUCompanion.api not found. AutoDefeat cannot resolve DB.");
      warn("CHECK LOAD ORDER: scripts/db-resolver.js must be FIRST in module.json scripts array.");
      return null;
    }

    if (typeof api.getCurrentGameDb !== "function") {
      warn("FUCompanion.api.getCurrentGameDb() not found.");
      warn("CHECK: your scripts/db-resolver.js is loaded and exposes getCurrentGameDb.");
      warn("CHECK LOAD ORDER: db-resolver.js must be FIRST in module.json scripts array.");
      return null;
    }

    try {
      const resolved = await api.getCurrentGameDb();
      const db = resolved?.db ?? null;
      const source = resolved?.source ?? null;

      log("DB resolved via getCurrentGameDb():", {
        gameName: resolved?.gameName ?? null,
        db: db ? `${db.name} (${db.id})` : null,
        source: source ? `${source.name} (${source.id})` : null,
        rawGameId: resolved?.rawGameId ?? null,
      });

      // Use db for global options (your option_autoDefeat lives on DB actor)
      return db;
    } catch (e) {
      err("getCurrentGameDb() failed:", e);
      return null;
    }
  }

  // -------------------------
  // Defeat Operation
  // (GM executes; players request via socket)
  // -------------------------
  async function performDefeat(tokenLike) {
    const tokenDoc = tokenLike?.document ?? tokenLike; // Token or TokenDocument
    const scene = tokenDoc?.parent;

    if (!tokenDoc?.id || !scene?.id) {
      warn("performDefeat aborted: invalid tokenDoc or scene.", { tokenDoc, scene });
      return;
    }

    // Non-GM: ask GM to perform deletion/combat cleanup
    if (!game.user.isGM) {
      log("Not GM -> sending AUTO_DEFEAT_REQUEST to GM via socket.", {
        sceneId: scene.id,
        tokenId: tokenDoc.id,
        tokenName: tokenDoc.name,
      });

      game.socket.emit(SOCKET_NS, {
        type: "AUTO_DEFEAT_REQUEST",
        sceneId: scene.id,
        tokenId: tokenDoc.id,
      });
      return;
    }

    log("GM performing defeat:", {
      scene: scene.name,
      token: tokenDoc.name,
      tokenId: tokenDoc.id,
    });

    // Remove from any combats that reference this token
    try {
      for (const c of (game.combats?.contents ?? [])) {
        const combatant = c?.combatants?.find((cb) => cb.tokenId === tokenDoc.id);
        if (combatant) {
          log("Removing combatant:", { combat: c.name, combatId: c.id, combatantId: combatant.id });
          await c.deleteEmbeddedDocuments("Combatant", [combatant.id]);
        }
      }
    } catch (e) {
      warn("Combatant removal failed (continuing):", e);
    }

    // Visual hint (optional)
    try {
      await tokenDoc.update({ alpha: 0.35 });
    } catch {}

    // Delete token
    try {
      await tokenDoc.delete();
      ChatMessage.create({ content: `<b>${tokenDoc.name}</b> was defeated!` });
      log("Defeat completed -> token deleted.");
    } catch (e) {
      err("Token delete failed:", e);
      ui.notifications?.error(`Auto Defeat failed for ${tokenDoc.name}. (GM permission?)`);
    }
  }

  // -------------------------
  // Main Gate Pipeline
  // -------------------------
  async function tryAutoDefeatForActor(actor, updateData, options, userId) {
    if (!actor) return;

    const hpGate = hpUpdateDetected(updateData);
    if (!hpGate.hit) return;

    const hp = Number(get(actor, PATH_HP, NaN));
    log("updateActor detected (HP related):", {
      actor: `${actor.name} (${actor.id})`,
      userId,
      newHp: hp,
      changedKeys: hpGate.keys,
    });

    if (!Number.isFinite(hp) || hp !== 0) return;

    // DB option gate
    const db = await resolveDatabaseActor();
    if (!db) {
      warn("No database actor resolved -> skip.");
      return;
    }

    const opt = get(db, PATH_DB_OPTION);
    const enabled = parseDbOption(opt);
    log("DB option check:", {
      dbActor: `${db.name} (${db.id})`,
      optionPath: PATH_DB_OPTION,
      rawValue: opt,
      enabled,
    });

    if (!enabled) return;

    // Persist gate
    const persist = Boolean(get(actor, PATH_TOKEN_PERSIST, false));
    if (persist) {
      log("token_option_persist is TRUE -> skip auto defeat:", {
        actor: `${actor.name} (${actor.id})`,
        path: PATH_TOKEN_PERSIST,
        value: persist,
      });
      return;
    }

    // npc_rank must exist gate
    const npcRank = get(actor, PATH_NPC_RANK, undefined);
    if (npcRank === undefined || npcRank === null || String(npcRank).trim() === "") {
      log("npc_rank missing -> exclude from auto defeat:", {
        actor: `${actor.name} (${actor.id})`,
        path: PATH_NPC_RANK,
        value: npcRank,
      });
      return;
    }

    // rank allowed gate
    if (!isAllowedRank(npcRank)) {
      log("Rank not eligible -> skip:", { actor: actor.name, npcRank });
      return;
    }

    // Token gates: active tokens + disposition
    const tokens = actor.getActiveTokens(true, true) ?? [];
    if (!tokens.length) {
      warn("Actor HP hit 0 but no active tokens found -> skip.", actor.name);
      return;
    }

    log("Active tokens found for actor:", tokens.map((t) => `${t.name} (${t.id})`));

    for (const token of tokens) {
      const disposition = token?.document?.disposition; // <-- FIXED
      if (disposition !== -1) {
        log("Disposition not enemy (-1) -> skip token:", {
          token: token.name,
          disposition,
        });
        continue;
      }

      log("AUTO DEFEAT PASSED ALL GATES -> executing:", {
        token: token.name,
        actor: actor.name,
        npcRank,
        disposition,
      });

      await performDefeat(token);
    }
  }

  // -------------------------
  // Socket Listener (GM executes requests)
  // -------------------------
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

      log("GM received AUTO_DEFEAT_REQUEST:", {
        sceneId,
        tokenId,
        hasScene: !!scene,
        hasToken: !!tokenDoc,
      });

      if (!scene || !tokenDoc) return;
      await performDefeat(tokenDoc);
    } catch (e) {
      err("Socket handler crashed:", e);
    }
  }

  // -------------------------
  // Hooks
  // -------------------------
  async function onUpdateActor(actor, updateData, options, userId) {
    await tryAutoDefeatForActor(actor, updateData, options, userId);
  }

  function installHooks() {
    Hooks.off("updateActor", onUpdateActor);
    Hooks.on("updateActor", onUpdateActor);
    log("Hook installed: updateActor");
  }

  // -------------------------
  // Boot
  // -------------------------
  Hooks.once("ready", () => {
    log("Booting Auto Defeat system...", { DEBUG });
    installSocketListener();
    installHooks();
    log("Auto Defeat system READY.");
  });
})();
