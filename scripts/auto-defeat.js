/**
 * Module Script: Auto Defeat.js (Foundry V12)
 * - Auto-detects enemy defeat when HP reaches 0
 * - Checks Database option: system.props.option_autoDefeat
 * - Only triggers for hostile tokens (disposition === -1)
 * - Only triggers for npc_rank Soldier/Elite (never Champion)
 * - Executes the same defeat flow as your Defeated.js:
 *    1) Play defeat animation + sound
 *    2) Remove token from Combat Tracker (if active combat on current scene)
 *    3) Delete token
 *    4) Post chat message
 */

(() => {
  const TAG = "[ONI][AutoDefeat]";

  // =========================================================
  // Debug Toggle (turn this OFF when finished debugging)
  // =========================================================
  const DEBUG = true;

  const log = (...args) => DEBUG && console.log(TAG, ...args);
  const warn = (...args) => DEBUG && console.warn(TAG, ...args);
  const err = (...args) => DEBUG && console.error(TAG, ...args);

  // =========================================================
  // Config: Data Paths (based on your data style)
  // =========================================================
  const PATH_DB_OPTION = "system.props.option_autoDefeat"; // Database actor boolean-like
  const PATH_HP = "system.props.current_hp";               // Actor HP (current)
  const PATH_RANK = "system.props.npc_rank";               // Actor rank (Soldier / Elite / Champion)

  // =========================================================
  // Safety: Prevent double-firing while deletion is in progress
  // =========================================================
  const processedTokenUuids = new Set();

  // Clear processed set when scene changes (nice hygiene)
  Hooks.on("canvasReady", () => {
    processedTokenUuids.clear();
    log("canvasReady -> cleared processed token cache");
  });

  // =========================================================
  // Helpers
  // =========================================================

  function getValue(obj, path) {
    try {
      return foundry.utils.getProperty(obj, path);
    } catch (e) {
      return undefined;
    }
  }

  function isHpZeroLike(value) {
    // Handles numbers, numeric strings, nullish, etc.
    const n = Number(value ?? NaN);
    return Number.isFinite(n) && n <= 0;
  }

  function isTruthyOption(value) {
    // Your note says boolean, but this also tolerates common “select-like” values.
    if (value === true) return true;
    if (value === false) return false;

    const s = String(value ?? "").trim().toLowerCase();
    return s === "true" || s === "1" || s === "on" || s === "yes" || s === "enabled";
  }

  function normalizeRank(rank) {
    return String(rank ?? "").trim().toLowerCase();
  }

  function isAllowedRank(rank) {
    const r = normalizeRank(rank);
    // Only Soldier or Elite allowed. Champion is explicitly excluded.
    if (r === "champion") return false;
    return r === "soldier" || r === "elite";
  }

  /**
   * Try to resolve the Database actor by finding an Actor that actually has the key.
   * (So you don’t have to hardcode the DB actor name.)
   */
  function resolveDatabaseActor() {
    const actors = game.actors?.contents ?? [];
    const matches = actors.filter(a => getValue(a, PATH_DB_OPTION) !== undefined);

    if (!matches.length) {
      warn("Could not find a Database actor containing:", PATH_DB_OPTION);
      return null;
    }

    if (matches.length > 1) {
      warn(
        `Found ${matches.length} possible Database actors (has ${PATH_DB_OPTION}). Using the first one:`,
        matches.map(a => `${a.name} (${a.id})`)
      );
    }

    return matches[0] ?? null;
  }

  /**
   * Mirrors your Defeated.js combat detection approach.
   * Finds an "active" combat on the CURRENT ACTIVE scene.
   */
  function getActiveCombatOnActiveScene() {
    const activeScene = canvas?.scene ?? null;
    const activeSceneId = activeScene?.id ?? null;

    const combats = game.combats?.contents ?? [];
    const matches = activeSceneId ? combats.filter(c => c.scene?.id === activeSceneId) : [];

    const picked =
      matches.find(c => (typeof c.started === "boolean" ? c.started : Number(c.round ?? 0) > 0)) ??
      matches.find(c => (typeof c.active === "boolean" ? c.active : false)) ??
      matches.find(c => (c.combatants?.size ?? 0) > 0) ??
      null;

    return picked;
  }

  async function removeTokenFromCombatIfNeeded(tokenDoc) {
    const activeCombat = getActiveCombatOnActiveScene();
    const isInCombatOnThisScene = !!activeCombat;

    if (!isInCombatOnThisScene || !activeCombat) return;

    const combatant =
      activeCombat.combatants?.find(c => c.tokenId === tokenDoc.id) ??
      null;

    if (!combatant) return;

    try {
      await activeCombat.deleteEmbeddedDocuments("Combatant", [combatant.id]);
      log(`Removed combatant for token "${tokenDoc.name}" from combat.`);
    } catch (e) {
      warn(`Failed to remove combatant for token "${tokenDoc.name}"`, e);
      // Keep it smooth: token deletion can still proceed.
    }
  }

  /**
   * The defeat operation (copied behavior from your Defeated.js),
   * but WITHOUT a confirmation dialog (because this is automatic).
   */
  async function performDefeat(token) {
    const tokenUuid = token?.document?.uuid ?? token?.uuid ?? null;
    if (!tokenUuid) {
      warn("performDefeat called with no tokenUuid. Aborting.", token);
      return;
    }

    if (processedTokenUuids.has(tokenUuid)) {
      log("Already processing this tokenUuid, skipping:", tokenUuid);
      return;
    }

    processedTokenUuids.add(tokenUuid);

    log("performDefeat START:", {
      tokenName: token.name,
      tokenId: token.document?.id,
      tokenUuid,
      actorName: token.actor?.name,
      actorId: token.actor?.id
    });

    try {
      await new Sequence()
        .sound("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Enemy_Death.ogg")
        .animation().on(token).tint("#ff0000").waitUntilFinished()
        .animation().on(token).fadeOut(1000).waitUntilFinished()
        .thenDo(async () => {
          // 1) Remove from combat tracker first (if relevant)
          await removeTokenFromCombatIfNeeded(token.document);

          // 2) Delete the token
          await token.document.delete();

          // 3) Post chat message
          ChatMessage.create({ content: `<b>${token.name}</b> was defeated!` });

          log("performDefeat DONE:", tokenUuid);
        })
        .play();
    } catch (e) {
      err("performDefeat FAILED:", e);
      ui.notifications?.error(`Auto Defeat failed for ${token.name}. Check permissions.`);
      // If it fails, allow retry later by removing from processed set
      processedTokenUuids.delete(tokenUuid);
    }
  }

  /**
   * Main decision pipeline for a token.
   */
  async function tryAutoDefeatForToken(token, reason = "unknown") {
    if (!token?.actor) return;

    const tokenUuid = token.document?.uuid ?? null;

    // HP gate (must be 0)
    const hp = getValue(token.actor, PATH_HP);
    if (!isHpZeroLike(hp)) {
      log("HP not zero -> skip", { reason, token: token.name, hp });
      return;
    }

    // Database option gate
    const dbActor = resolveDatabaseActor();
    if (!dbActor) {
      warn("No DB actor resolved -> skip auto defeat");
      return;
    }

    const option = getValue(dbActor, PATH_DB_OPTION);
    const enabled = isTruthyOption(option);

    log("DB option check:", {
      dbActor: `${dbActor.name} (${dbActor.id})`,
      optionValue: option,
      enabled
    });

    if (!enabled) {
      log("AutoDefeat option is OFF -> do nothing");
      return;
    }

    // Disposition gate (enemy only)
    const disp = token.document?.disposition;
    if (disp !== -1) {
      log("Disposition not enemy (-1) -> skip", { token: token.name, disposition: disp });
      return;
    }

    // Rank gate (Soldier/Elite only; never Champion)
    const rank = getValue(token.actor, PATH_RANK);
    const rankOk = isAllowedRank(rank);

    log("Rank check:", {
      token: token.name,
      actor: token.actor.name,
      rankValue: rank,
      rankOk
    });

    if (!rankOk) {
      log("Rank not allowed -> skip (only Soldier/Elite)", { token: token.name, rank });
      return;
    }

    // All checks passed -> defeat
    log("ALL CONDITIONS PASSED -> Auto Defeat will trigger", {
      reason,
      token: token.name,
      actor: token.actor.name,
      hp,
      disposition: disp,
      rank
    });

    await performDefeat(token);
  }

  // =========================================================
  // Hook Installation
  // =========================================================

  /**
   * Primary hook: updateActor
   * - Because your HP is stored on the Actor (system.props.current_hp)
   * - When it changes, we check active tokens for that actor.
   */
  function installAutoDefeatHooks() {
    log("Installing Auto Defeat hooks...");

    Hooks.on("updateActor", async (actor, changed, options, userId) => {
      try {
        // Only react if HP path changed (or if something under system.props changed)
        const hpChanged =
          getValue(changed, PATH_HP) !== undefined ||
          getValue(changed, "system.props") !== undefined;

        if (!hpChanged) return;

        const newHp = getValue(actor, PATH_HP);
        log("updateActor detected (HP related):", {
          actor: `${actor.name} (${actor.id})`,
          userId,
          newHp,
          changedKeys: Object.keys(changed ?? {})
        });

        // Only proceed if HP is 0
        if (!isHpZeroLike(newHp)) return;

        // Active tokens in current scene
        const tokens = actor.getActiveTokens(true, true) ?? [];
        if (!tokens.length) {
          log("Actor has no active tokens -> skip", actor.name);
          return;
        }

        // Try each token (but only enemy disposition will pass anyway)
        for (const t of tokens) {
          await tryAutoDefeatForToken(t, "updateActor:hpZero");
        }
      } catch (e) {
        err("updateActor hook error:", e);
      }
    });

    /**
     * Secondary hook: updateToken
     * - If you ever decide HP is stored per-token in some cases,
     *   this gives extra coverage.
     */
    Hooks.on("updateToken", async (tokenDoc, changed, options, userId) => {
      try {
        // If token doc changed but we can still check actor HP, do so.
        const actor = tokenDoc?.actor;
        if (!actor) return;

        const maybeHpChanged =
          getValue(changed, "actorData.system.props.current_hp") !== undefined ||
          getValue(changed, "actorData.system.props") !== undefined ||
          getValue(changed, "actorData.system") !== undefined;

        if (!maybeHpChanged) return;

        const token = tokenDoc.object;
        if (!token) return;

        log("updateToken detected (actorData hp-ish):", {
          token: `${tokenDoc.name} (${tokenDoc.id})`,
          userId,
          actor: `${actor.name} (${actor.id})`
        });

        await tryAutoDefeatForToken(token, "updateToken:actorData");
      } catch (e) {
        err("updateToken hook error:", e);
      }
    });

    log("Auto Defeat hooks installed.");
  }

  // Boot on ready (module behavior)
  Hooks.once("ready", () => {
    installAutoDefeatHooks();
  });
})();
