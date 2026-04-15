/**
 * [ONI] Reaction System — Module Version (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * This file is safe to load automatically from a module (runs once per client).
 * Generated: 2026-01-09T07:27:00
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  // ============================================================================
  // ONI ReactionManager – Demo v0.2 (Foundry VTT v12)
  // ---------------------------------------------------------------------------
  // PURPOSE
  // -------
  // Listens to Oni's reaction phase events (oni:reactionPhase) and, whenever a
  // matching Reaction is available for an Actor in the current combat, shows a
  // floating "Reaction" button next to that Actor's token.
  //
  // UPDATED BEHAVIOUR
  // -----------------
  // • Reactions still clear when the larger PHASE BUCKET changes.
  // • Within the SAME phase bucket, multiple low-level triggers can now coexist
  //   for the SAME token.
  // • The manager merges those same-bucket triggers into one live "reaction
  //   window" per token, then refreshes that token's button with the merged
  //   context instead of treating every trigger as a totally separate window.
  //
  // This is what allows combinations like:
  //   creature_deals_damage + creature_enter_crisis + creature_defeated
  // to all remain available in the same resolution timing window.
  // ============================================================================

  (() => {
    const KEY = "oni.ReactionManager";
    if (window[KEY]) {
      console.log("[ReactionManager] Already installed.");
      return;
    }

    // Module socket channel we’ll use for GM→Player messages
    const MODULE_ID = "fabula-ultima-companion";
    const CHANNEL = `module.${MODULE_ID}`;

    // Track the currently active broad timing bucket.
    let _currentPhaseBucket = null;

    // GM-authoritative same-bucket windows, keyed by `${phaseBucket}::${tokenId}`.
    const _gmReactionWindows = new Map();

    // Optional local mirror for socket-built contexts on non-GM clients.
    const _localReactionWindows = new Map();

    // -------------------------------------------------------------------------
    // HARD NUKE – clear all Reaction buttons on THIS client
    // -------------------------------------------------------------------------
    /**
     * Try to remove ALL floating Reaction buttons on THIS client.
     *
     * 1) Calls ReactionButtonUI.clearAll() if available.
     * 2) Also directly removes any DOM nodes that look like Reaction blades:
     *      - .oni-reaction-item under #oni-reaction-root
     *      - any stray .oni-reaction-item in the document
     *
     * @param {string} source  Just for logging (e.g. "socket", "GM-phase-change", "combatEnd").
     */
    function hardNukeReactionButtons(source) {
      const localUserId = game.user.id;
      const localUserName = game.user.name;

      console.log("[ReactionManager] hardNukeReactionButtons invoked.", {
        source,
        localUserId,
        localUserName,
        isGM: game.user.isGM
      });

      // 1) Try via official ReactionButtonUI API
      const uiApi = window["oni.ReactionButtonUI"];
      if (uiApi && typeof uiApi.clearAll === "function") {
        try {
          uiApi.clearAll();
          console.log("[ReactionManager] Called ReactionButtonUI.clearAll() from hardNukeReactionButtons.");
        } catch (err) {
          console.error("[ReactionManager] Error calling ReactionButtonUI.clearAll().", err);
        }
      } else {
        console.warn("[ReactionManager] ReactionButtonUI API not available on this client (hardNukeReactionButtons).");
      }

      // 2) Direct DOM cleanup as safety net, but with a small ease-out animation.
      try {
        const elementsToAnimate = new Set();

        // 2A) Any .oni-reaction-item under the root container
        const root = document.getElementById("oni-reaction-root");
        if (root) {
          for (const el of root.querySelectorAll(".oni-reaction-item")) {
            elementsToAnimate.add(el);
          }
        }

        // 2B) Any stray .oni-reaction-item in the document
        for (const el of document.querySelectorAll(".oni-reaction-item")) {
          elementsToAnimate.add(el);
        }

        let totalScheduled = 0;

        for (const el of elementsToAnimate) {
          try {
            const element = el; // capture

            // Add / extend transition so we don't override existing ones completely
            const existingTransition = element.style.transition || "";
            const extraTransition = "opacity 0.25s ease-out, transform 0.25s ease-out";

            element.style.transition = existingTransition
              ? `${existingTransition}, ${extraTransition}`
              : extraTransition;

            // Ensure starting values
            if (!element.style.opacity) element.style.opacity = "1";
            if (!element.style.transform) element.style.transform = "translateY(0px)";

            // Force reflow so the browser applies the starting values
            // eslint-disable-next-line no-unused-expressions
            element.offsetWidth;

            // End values for the ease-out
            element.style.opacity = "0";
            element.style.transform = "translateY(-8px)";

            // Remove the node after the animation window
            setTimeout(() => {
              if (element.isConnected) element.remove();
            }, 260);

            totalScheduled++;
          } catch (_err) {}
        }

        console.log("[ReactionManager] DOM animated cleanup scheduled from hardNukeReactionButtons.", {
          totalScheduled
        });
      } catch (err) {
        console.error("[ReactionManager] Error during DOM cleanup in hardNukeReactionButtons.", err);
      }
    }

    function clearAllReactionWindows() {
      _gmReactionWindows.clear();
      _localReactionWindows.clear();
    }

    // -------------------------------------------------------------------------
    // 0) Small helpers copied from Turn UI Manager (ownership logic)
    // -------------------------------------------------------------------------

    function isFriendly(tokenDoc) {
      const d = tokenDoc?.disposition ?? 0;
      return d === 1;
    }

    function isLinkedToLocalUser(actor) {
      const myCharId = game.user?.character?.id ?? null;
      if (myCharId && actor?.id === myCharId) return true;
      try {
        return actor?.testUserPermission?.(game.user, "OWNER") || false;
      } catch {
        return false;
      }
    }

    // NOTE: We no longer use this inside the GM logic, but we keep it around
    // in case you want to reuse the "local visibility" pattern elsewhere.
    function shouldLocalSeeForToken(token) {
      const tokenDoc = token?.document;
      const actor = token?.actor;
      if (!tokenDoc || !actor) return false;

      const friendly = isFriendly(tokenDoc);
      const ownerIsLocal = friendly
        ? isLinkedToLocalUser(actor) // PCs -> only that player
        : game.user?.isGM; // Monsters/Neutral -> GM only

      return !!ownerIsLocal;
    }

    function byIdOnCanvas(tokenId) {
      if (!tokenId) return null;
      return canvas?.tokens?.get(tokenId) ?? null;
    }

    /**
     * Decide which user(s) should see Reaction buttons for a given token.
     *
     * Rules:
     *   - Friendly PCs  -> all non-GM owners (players) + all GMs.
     *   - Monsters/NPCs -> all GMs.
     *
     * So GM will ALWAYS see every Reaction, and players will see only their own.
     */
    function getOwningUserIdsForToken(tokenDoc, actor) {
      if (!tokenDoc || !actor) return [];

      const friendly = isFriendly(tokenDoc);
      const allUsers = game.users?.contents ?? game.users ?? [];
      const ownerUsers = [];

      for (const u of allUsers) {
        try {
          if (actor.testUserPermission?.(u, "OWNER")) {
            ownerUsers.push(u);
          }
        } catch (_err) {
          // ignore testUserPermission errors
        }
      }

      const result = new Set();

      if (friendly) {
        // Friendly PCs: all non-GM owners (players)
        for (const u of ownerUsers) {
          if (!u.isGM) {
            result.add(u.id);
          }
        }

        // Also ALWAYS include all GMs so they see every Reaction as an overseer.
        for (const u of allUsers) {
          if (u.isGM) {
            result.add(u.id);
          }
        }
      } else {
        // Monsters / Neutral: GM only
        for (const u of allUsers) {
          if (u.isGM) {
            result.add(u.id);
          }
        }
      }

      const resolvedIds = Array.from(result);

      console.log("[ReactionManager] getOwningUserIdsForToken:", {
        tokenName: tokenDoc?.name,
        actorName: actor?.name,
        friendly,
        ownerUsers: ownerUsers.map(u => ({
          id: u.id,
          name: u.name,
          isGM: u.isGM
        })),
        resolvedUserIds: resolvedIds
      });

      return resolvedIds;
    }

    // -------------------------------------------------------------------------
    // 1) Reaction data helpers
    // -------------------------------------------------------------------------
    //
    // NOTE:
    //   All low-level detection logic (valid triggers, mapping PhaseHandler
    //   keys, source/damage-type filters, scanning combat for candidates, etc.)
    //   has been moved into a separate helper script:
    //
    //       ReactionTriggerCore.js
    //       -> window["oni.ReactionTriggerCore"]
    //
    //   This manager keeps the "phase bucket" concept locally and now also
    //   maintains one merged same-bucket reaction window per token.

    // -------------------------------------------------------------------------
    // Phase buckets – group low-level triggers into bigger "windows"
    // -------------------------------------------------------------------------
    //
    // The idea:
    // - Many events can fire close together (e.g. creature_deals_damage +
    //   creature_enter_crisis + creature_defeated).
    // - We only want to CLEAR the Reaction UI when the *phase window* changes,
    //   not when every little event fires.
    // - So we map each trigger to a "phase bucket":
    //
    //   • "turn_start", "conflict_start", "round_start"  → each their own bucket
    //   • "creature_performs_check", "creature_targeted_by_action",
    //     "creature_hit_by_action", "creature_miss_action"  → "action_phase"
    //   • "creature_deals_damage", "creature_takes_damage",
    //     "creature_enter_crisis", "creature_exit_crisis",
    //     "creature_defeated"                                → "resolution_phase"
    //   • "turn_end", "round_end"                          → each their own bucket
    //
    // This way:
    //   - Damage + crisis + defeat stay in the same resolution window.
    //   - Action declaration + miss stay in the same action window.
    //   - Moving from Start-of-turn → Action → Resolution → End-of-turn WILL
    //     clear old reactions when the phase actually changes.

        function phaseBucketForTrigger(triggerKey) {
      switch (triggerKey) {
        // All the action declaration / hit result triggers live in the Action Phase
        case "creature_performs_action":
        case "creature_performs_check":
        case "creature_targeted_by_action":
        case "creature_hit_by_action":
        case "creature_miss_action":
          return "action_phase";

        // All the HP/damage result triggers live in the Resolution Phase
        case "creature_deals_damage":
        case "creature_takes_damage":
        case "creature_enter_crisis":
        case "creature_exit_crisis":
        case "creature_defeated":
          return "resolution_phase";

        // Everything else (start_of_turn, end_of_turn, conflict/round start/end)
        // gets its own bucket. That means switching between them WILL clear the UI.
        default:
          return triggerKey;
      }
    }

    function pickPassiveEventStamp(payload = {}) {
      return String(
        payload?.meta?.passiveOrigin?.rootTimestamp ??
        payload?.passiveOrigin?.rootTimestamp ??
        payload?.timestamp ??
        payload?.eventTimestamp ??
        payload?.meta?.timestamp ??
        payload?.meta?.eventTimestamp ??
        payload?.meta?.runId ??
        `${Date.now()}`
      );
    }

    function buildPassiveSourceEvent({ rawTrigger, triggerKey, phaseBucket, payload }) {
      return {
        rawTrigger: rawTrigger ?? null,
        triggerKey: triggerKey ?? null,
        phaseBucket: phaseBucket ?? null,
        timestamp: Date.now(),
        eventStamp: pickPassiveEventStamp(payload),
        payloadTimestamp: payload?.timestamp ?? payload?.eventTimestamp ?? payload?.meta?.timestamp ?? null,
        attackerUuid: payload?.attacker_uuid ?? payload?.attackerUuid ?? payload?.meta?.attackerUuid ?? null,
        targetUuid: payload?.target_uuid ?? payload?.targetUuid ?? payload?.meta?.targetUuid ?? null,
        targetUuids: Array.isArray(payload?.targets) ? [...payload.targets] : [],
        actionName: payload?.skill_name ?? payload?.skillName ?? payload?.itemName ?? payload?.meta?.passiveItemName ?? null,
        passiveOrigin: foundry.utils.deepClone(
          payload?.meta?.passiveOrigin ?? payload?.passiveOrigin ?? {}
        )
      };
    }

    function makeWindowKey(phaseBucket, tokenId) {
      return `${phaseBucket}::${tokenId ?? "(no-token)"}`;
    }

    function uniqueStrings(values) {
      const out = [];
      const seen = new Set();
      for (const v of values ?? []) {
        const s = String(v ?? "").trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
      }
      return out;
    }

    function cloneReactionGroup(group) {
      return {
        item: group?.item ?? null,
        triggers: uniqueStrings(group?.triggers ?? []),
        rows: Array.isArray(group?.rows) ? [...group.rows] : []
      };
    }

    function emptyWindowState(phaseBucket, tokenId) {
      return {
        windowKey: makeWindowKey(phaseBucket, tokenId),
        phaseBucket,
        tokenId,
        combatant: null,
        actor: null,
        token: null,
        actorUuid: null,
        ownerUserIds: [],
        latestTriggerKey: null,
        latestPhasePayload: {},
        triggerKeys: [],
        phasePayloadByTrigger: {},
        triggerHistory: [],
        reactionGroupsByItemUuid: new Map()
      };
    }

    function mergeReactionGroupIntoWindow(windowState, group) {
      const item = group?.item ?? null;
      if (!item) return;

      const mapKey = item.uuid ?? item.id ?? item.name ?? randomID?.() ?? `${Date.now()}`;
      const existing = windowState.reactionGroupsByItemUuid.get(mapKey);

      if (!existing) {
        windowState.reactionGroupsByItemUuid.set(mapKey, cloneReactionGroup(group));
        return;
      }

      existing.triggers = uniqueStrings([
        ...(existing.triggers ?? []),
        ...(group?.triggers ?? [])
      ]);

      const existingRows = Array.isArray(existing.rows) ? existing.rows : [];
      const incomingRows = Array.isArray(group?.rows) ? group.rows : [];
      existing.rows = [...existingRows, ...incomingRows];
    }

    function mergeMatchIntoWindow(windowState, ctx, triggerKey, phasePayload) {
      windowState.combatant = ctx?.combatant ?? windowState.combatant;
      windowState.actor = ctx?.actor ?? windowState.actor;
      windowState.token = ctx?.token ?? windowState.token;
      windowState.actorUuid = ctx?.actor?.uuid ?? windowState.actorUuid;

      windowState.ownerUserIds = uniqueStrings([
        ...(windowState.ownerUserIds ?? []),
        ...(ctx?.ownerUserIds ?? [])
      ]);

      windowState.latestTriggerKey = triggerKey;
      windowState.latestPhasePayload = phasePayload && typeof phasePayload === "object"
        ? foundry.utils.deepClone(phasePayload)
        : {};

      windowState.triggerKeys = uniqueStrings([
        ...(windowState.triggerKeys ?? []),
        triggerKey
      ]);

      windowState.phasePayloadByTrigger[triggerKey] = phasePayload && typeof phasePayload === "object"
        ? foundry.utils.deepClone(phasePayload)
        : {};

      windowState.triggerHistory.push({
        triggerKey,
        at: Date.now()
      });

      for (const group of ctx?.reactions ?? []) {
        mergeReactionGroupIntoWindow(windowState, group);
      }
    }

    function buildTriggerEntriesForWindow(windowState) {
      const triggerKeys = Array.isArray(windowState?.triggerKeys) ? windowState.triggerKeys : [];
      const allGroups = Array.from(windowState?.reactionGroupsByItemUuid?.values?.() ?? []);

      return triggerKeys.map(triggerKey => ({
        triggerKey,
        phasePayload: foundry.utils.deepClone(windowState?.phasePayloadByTrigger?.[triggerKey] ?? {}),
        reactions: allGroups
          .filter(group => Array.isArray(group?.triggers) && group.triggers.includes(triggerKey))
          .map(group => ({
            item: group?.item ?? null,
            triggers: uniqueStrings(group?.triggers ?? []),
            rows: Array.isArray(group?.rows) ? [...group.rows] : []
          }))
      }));
    }

    function buildCtxFromWindow(windowState) {
      const reactionGroups = Array.from(windowState?.reactionGroupsByItemUuid?.values?.() ?? []).map(group => ({
        item: group?.item ?? null,
        triggers: uniqueStrings(group?.triggers ?? []),
        rows: Array.isArray(group?.rows) ? [...group.rows] : []
      }));

      return {
        combatant: windowState?.combatant ?? null,
        actor: windowState?.actor ?? null,
        token: windowState?.token ?? null,
        reactions: reactionGroups,
        triggerKey: windowState?.latestTriggerKey ?? "(unknown_trigger)",
        latestTriggerKey: windowState?.latestTriggerKey ?? "(unknown_trigger)",
        triggerKeys: uniqueStrings(windowState?.triggerKeys ?? []),
        phasePayload: foundry.utils.deepClone(windowState?.latestPhasePayload ?? {}),
        latestPhasePayload: foundry.utils.deepClone(windowState?.latestPhasePayload ?? {}),
        phasePayloadByTrigger: foundry.utils.deepClone(windowState?.phasePayloadByTrigger ?? {}),
        triggerEntries: buildTriggerEntriesForWindow(windowState),
        phaseBucket: windowState?.phaseBucket ?? null,
        ownerUserIds: uniqueStrings(windowState?.ownerUserIds ?? [])
      };
    }

    function buildSocketOfferFromWindow(windowState, targetUserId) {
      const reactionGroups = Array.from(windowState?.reactionGroupsByItemUuid?.values?.() ?? []);
      const itemGroups = reactionGroups
        .map(group => ({
          itemUuid: group?.item?.uuid ?? null,
          triggers: uniqueStrings(group?.triggers ?? [])
        }))
        .filter(g => !!g.itemUuid);

      return {
        targetUserId,
        triggerKey: windowState?.latestTriggerKey ?? null,
        latestTriggerKey: windowState?.latestTriggerKey ?? null,
        triggerKeys: uniqueStrings(windowState?.triggerKeys ?? []),
        phaseBucket: windowState?.phaseBucket ?? null,
        actorUuid: windowState?.actorUuid ?? null,
        tokenId: windowState?.tokenId ?? null,
        itemUuids: itemGroups.map(g => g.itemUuid),
        itemGroups,
        phasePayload: foundry.utils.deepClone(windowState?.latestPhasePayload ?? {}),
        latestPhasePayload: foundry.utils.deepClone(windowState?.latestPhasePayload ?? {}),
        phasePayloadByTrigger: foundry.utils.deepClone(windowState?.phasePayloadByTrigger ?? {}),
        triggerHistory: Array.isArray(windowState?.triggerHistory) ? [...windowState.triggerHistory] : []
      };
    }

    function clearForNewPhaseBucket(phaseBucket, triggerKey) {
      console.log("[ReactionManager] (GM) Phase bucket changed; clearing all Reaction buttons on all clients.", {
        from: _currentPhaseBucket,
        to: phaseBucket,
        triggerKey
      });

      _currentPhaseBucket = phaseBucket;
      clearAllReactionWindows();

      if (game.socket) {
        game.socket.emit(CHANNEL, {
          type: "OniReactionClear",
          payload: {
            phaseBucket,
            triggerKey,
            fromUserId: game.user.id
          }
        });
      } else {
        console.warn("[ReactionManager] (GM) game.socket is not available when trying to emit OniReactionClear.");
      }

      // Also clear locally for GM using the same nuke helper.
      hardNukeReactionButtons("GM-phase-change");
    }

    // -------------------------------------------------------------------------
    // 3) Main event listener – reacts to oni:reactionPhase
    // -------------------------------------------------------------------------

    Hooks.on("oni:reactionPhase", async (payload) => {
      // Grab our trigger helper API
      const triggerApi = window["oni.ReactionTriggerCore"];
      if (!triggerApi) {
        console.error("[ReactionManager] oni:reactionPhase fired, but oni.ReactionTriggerCore is not installed.");
        ui.notifications?.error?.("[Reaction] Internal error: ReactionTriggerCore not loaded.");
        return;
      }

      const rawTrigger = payload?.trigger;
      const triggerKey = triggerApi.mapIncomingTrigger(rawTrigger);

      if (!triggerApi.isValidTriggerKey(triggerKey)) {
        console.log("[ReactionManager] Ignoring oni:reactionPhase; invalid or unsupported triggerKey.", {
          rawTrigger,
          triggerKey,
          payload
        });
        return;
      }

      // -----------------------------------------------------------------------
      // Non-GM clients: ignore the phase event itself and wait for GM socket.
      // -----------------------------------------------------------------------
      if (!game.user.isGM) {
        console.log("[ReactionManager] Non-GM client ignoring oni:reactionPhase; waiting for GM offers via socket.", {
          rawTrigger,
          triggerKey,
          payload
        });
        return;
      }

      const phaseBucket = phaseBucketForTrigger(triggerKey);

      console.log("[ReactionManager] (GM) Received reaction trigger:", {
        rawTrigger,
        triggerKey,
        phaseBucket,
        payload
      });

      // Grab UI + dialog APIs for GM’s own local buttons
      const uiApi = window["oni.ReactionButtonUI"];
      const dialogApi = window["oni.ReactionChooseSkill"];

      if (!uiApi || typeof uiApi.spawnButton !== "function") {
        ui.notifications?.error?.("[Reaction] ReactionButtonUI script not installed (GM).");
        console.error("[ReactionManager] (GM) Missing oni.ReactionButtonUI API. Make sure ReactionButtonUI.js has been loaded.");
      }

      if (!dialogApi || typeof dialogApi.openReactionDialog !== "function") {
        ui.notifications?.error?.("[Reaction] ReactionChooseSkill script not installed (GM).");
        console.error("[ReactionManager] (GM) Missing oni.ReactionChooseSkill.openReactionDialog. Make sure ReactionChooseSkill.js has been loaded.");
      }

      // -----------------------------------------------------------------------
      // 1) Phase bucket change -> tell everyone to clear.
      // -----------------------------------------------------------------------
      if (phaseBucket !== _currentPhaseBucket) {
        clearForNewPhaseBucket(phaseBucket, triggerKey);
      }

      // -----------------------------------------------------------------------
      // 2) Compute which combatants have matching Reactions for this trigger.
      //    (Pure detection is handled by ReactionTriggerCore.)
      // -----------------------------------------------------------------------
      const matches = triggerApi.collectReactionsForTrigger(triggerKey, payload);
      if (!Array.isArray(matches) || matches.length === 0) {
        console.log("[ReactionManager] (GM) No matching reactions for trigger", triggerKey, "in this combat.");
        return;
      }

      // Now enrich each context with ownership info (who should see the button)
      for (const ctx of matches) {
        const token = ctx.token;
        const actor = ctx.actor;
        const tokenDoc = token?.document;

        if (!tokenDoc || !actor) {
          ctx.ownerUserIds = [];
          continue;
        }

        const ownerUserIds = getOwningUserIdsForToken(tokenDoc, actor);
        ctx.ownerUserIds = Array.isArray(ownerUserIds) ? ownerUserIds : [];
      }

      const filteredMatches = matches.filter(m =>
        Array.isArray(m.ownerUserIds) && m.ownerUserIds.length > 0
      );

      if (filteredMatches.length === 0) {
        console.log("[ReactionManager] (GM) No reaction candidates with resolved owners for trigger.", {
          triggerKey
        });
        return;
      }

      console.log("[ReactionManager] (GM) Found reaction candidates for trigger.", {
        triggerKey,
        matchCount: filteredMatches.length,
        matchSummary: filteredMatches.map(m => ({
          actorName: m.actor?.name,
          tokenName: m.token?.name,
          ownerUserIds: m.ownerUserIds,
          numReactionItems: m.reactions?.length ?? 0
        }))
      });

      // -----------------------------------------------------------------------
      // 2.5) Split passive rows away from manual Reaction rows BEFORE any UI.
      //      Passive rows auto-execute and should never spawn Reaction buttons.
      // -----------------------------------------------------------------------
      let manualMatches = filteredMatches;
      const autoPassiveApi = window["oni.AutoPassiveManager"] ?? globalThis.FUCompanion?.api?.autoPassiveManager ?? null;

      if (autoPassiveApi?.processMatches) {
        try {
          const passiveSourceEvent = buildPassiveSourceEvent({
            rawTrigger,
            triggerKey,
            phaseBucket,
            payload
          });

          const passiveProcessing = await autoPassiveApi.processMatches({
            matches: filteredMatches,
            triggerKey,
            phaseBucket,
            rawTrigger,
            phasePayload: payload,
            phasePayloadByTrigger: {
              [triggerKey]: foundry.utils.deepClone(payload ?? {})
            },
            sourceEvent: passiveSourceEvent
          });

          manualMatches = Array.isArray(passiveProcessing?.manualMatches)
            ? passiveProcessing.manualMatches
            : [];

          console.log("[ReactionManager] (GM) Passive split complete.", {
            triggerKey,
            originalMatches: filteredMatches.length,
            manualMatches: manualMatches.length,
            passiveExecutions: Array.isArray(passiveProcessing?.passiveResults)
              ? passiveProcessing.passiveResults.length
              : 0,
            passiveSummary: Array.isArray(passiveProcessing?.passiveResults)
              ? passiveProcessing.passiveResults.map(r => ({
                  ok: !!r?.ok,
                  skipped: !!r?.skipped,
                  actorName: r?.actor?.name ?? null,
                  itemName: r?.item?.name ?? null,
                  triggerKey: r?.triggerKey ?? null,
                  reason: r?.reason ?? null,
                  rootKey: r?.rootKey ?? null
                }))
              : [],
            passiveSourceEvent
          });
        } catch (err) {
          console.error("[ReactionManager] (GM) AutoPassiveManager.processMatches failed; falling back to old manual reaction flow.", {
            triggerKey,
            err
          });
          manualMatches = filteredMatches;
        }
      } else {
        console.warn("[ReactionManager] (GM) AutoPassiveManager API not found; passive rows will behave like normal reactions until the script is loaded.", {
          triggerKey
        });
      }

      if (!Array.isArray(manualMatches) || manualMatches.length === 0) {
        console.log("[ReactionManager] (GM) No manual Reaction rows remain after passive auto-processing.", {
          triggerKey
        });
        return;
      }

      console.log("[ReactionManager] (GM) Manual reaction candidates remaining after passive split.", {
        triggerKey,
        matchCount: manualMatches.length,
        matchSummary: manualMatches.map(m => ({
          actorName: m.actor?.name,
          tokenName: m.token?.name,
          ownerUserIds: m.ownerUserIds,
          numReactionItems: m.reactions?.length ?? 0
        }))
      });

      // -----------------------------------------------------------------------
      // 3) Merge each MANUAL match into that token's active same-bucket reaction
      //    window, then refresh the owners' UI using the MERGED context.
      // -----------------------------------------------------------------------
      for (const ctx of manualMatches) {
        const token = ctx.token;
        const tokenId = token?.id ?? ctx.combatant?.tokenId ?? null;
        const actorUuid = ctx.actor?.uuid ?? null;
        const ownerUserIds = Array.isArray(ctx.ownerUserIds) ? ctx.ownerUserIds : [];

        if (!tokenId || !ownerUserIds.length) continue;

        const windowKey = makeWindowKey(phaseBucket, tokenId);
        const windowState = _gmReactionWindows.get(windowKey)
          ?? emptyWindowState(phaseBucket, tokenId);

        mergeMatchIntoWindow(windowState, ctx, triggerKey, payload);
        windowState.actorUuid = actorUuid ?? windowState.actorUuid;
        _gmReactionWindows.set(windowKey, windowState);

        const mergedCtx = buildCtxFromWindow(windowState);

        console.log("[ReactionManager] (GM) Updated merged reaction window.", {
          windowKey,
          tokenName: mergedCtx.token?.name,
          actorName: mergedCtx.actor?.name,
          triggerKey,
          triggerKeys: mergedCtx.triggerKeys,
          reactionCount: mergedCtx.reactions?.length ?? 0,
          ownerUserIds: mergedCtx.ownerUserIds
        });

        // 3A) GM local UI: if GM is among ownerUserIds, spawn the button directly.
        const gmId = game.user.id;
        if (ownerUserIds.includes(gmId) && uiApi && dialogApi) {
          console.log("[ReactionManager] (GM) Spawning local Reaction button for GM.", {
            actorName: mergedCtx.actor?.name,
            tokenName: mergedCtx.token?.name,
            gmId,
            triggerKey,
            triggerKeys: mergedCtx.triggerKeys
          });

          uiApi.spawnButton(token, mergedCtx, (clickedCtx) => {
            dialogApi.openReactionDialog(clickedCtx);
          });
        }

        // 3B) Player offers: send merged OniReactionOffer to every non-GM owner.
        for (const targetUserId of ownerUserIds) {
          // Skip GM here; GM already got a local button.
          if (targetUserId === gmId) continue;

          const payloadOut = buildSocketOfferFromWindow(windowState, targetUserId);

          console.log("[ReactionManager] (GM) Sending merged OniReactionOffer to user", targetUserId, payloadOut);

          if (game.socket) {
            game.socket.emit(CHANNEL, {
              type: "OniReactionOffer",
              payload: payloadOut
            });
          } else {
            console.warn("[ReactionManager] (GM) game.socket is not available when trying to emit OniReactionOffer.");
          }
        }
      }
    });

    // -------------------------------------------------------------------------
    // 3) Module socket listener – GM→Player clear + offers
    // -------------------------------------------------------------------------

    function handleModuleMessage(data) {
      if (!data || typeof data !== "object") return;

      // 1) CLEAR: GM changed phase bucket; everyone clears buttons.
      if (data.type === "OniReactionClear") {
        const payload = data.payload || {};
        const { phaseBucket, triggerKey, fromUserId } = payload;

        console.log("[ReactionManager] Socket OniReactionClear on user", game.user.id, {
          phaseBucket,
          triggerKey,
          fromUserId
        });

        clearAllReactionWindows();

        // Use the same hard nuke we proved with the manual V3 macro.
        hardNukeReactionButtons("socket");

        // Keep the local bucket in sync (mostly for debugging)
        _currentPhaseBucket = phaseBucket ?? null;
        return;
      }

      // 2) OFFER: GM is telling a specific user to show Reaction buttons.
      if (data.type === "OniReactionOffer") {
        const payload = data.payload || {};
        const {
          targetUserId,
          triggerKey,
          latestTriggerKey,
          triggerKeys,
          phaseBucket,
          actorUuid,
          tokenId,
          itemUuids,
          itemGroups,
          phasePayload,
          latestPhasePayload,
          phasePayloadByTrigger
        } = payload;

        console.log("[ReactionManager] Socket OniReactionOffer on user", game.user.id, payload);

        // Only the targeted user should respond.
        if (!targetUserId || targetUserId !== game.user.id) {
          console.log("[ReactionManager] OniReactionOffer: message not for this user; ignoring.", {
            localUserId: game.user.id,
            targetUserId
          });
          return;
        }

        const uiApi = window["oni.ReactionButtonUI"];
        if (!uiApi || typeof uiApi.spawnButton !== "function") {
          ui.notifications?.error?.("[Reaction] ReactionButtonUI script not installed (socket offer).");
          console.error("[ReactionManager] Missing oni.ReactionButtonUI API for OniReactionOffer.");
          return;
        }

        // If GM says phase bucket is now X, keep our local view in sync
        if (phaseBucket && phaseBucket !== _currentPhaseBucket) {
          clearAllReactionWindows();
          hardNukeReactionButtons("socket-phase-change");
          _currentPhaseBucket = phaseBucket;
        }

        // Resolve the token on this canvas
        const token = byIdOnCanvas(tokenId);
        if (!token) {
          console.warn("[ReactionManager] OniReactionOffer: token not found on this canvas.", { tokenId });
          return;
        }

        // Resolve the actor (prefer actorUuid, fall back to token.actor)
        let actor = null;
        try {
          actor = actorUuid ? fromUuidSync(actorUuid) : token.actor;
        } catch (err) {
          console.warn("[ReactionManager] OniReactionOffer: error resolving actor from uuid.", actorUuid, err);
          actor = token.actor;
        }

        if (!actor) {
          console.warn("[ReactionManager] OniReactionOffer: no actor found for token / actorUuid.", {
            tokenId,
            actorUuid
          });
          return;
        }

        // Rebuild a simple "reactions" array: [{ item, triggers }, ...]
        const reactions = [];
        const uniqueIds = new Set();
        const itemGroupMap = new Map();

        if (Array.isArray(itemGroups)) {
          for (const g of itemGroups) {
            if (!g?.itemUuid) continue;
            itemGroupMap.set(g.itemUuid, {
              itemUuid: g.itemUuid,
              triggers: uniqueStrings(g.triggers ?? [])
            });
          }
        }

        const uuidsToResolve = Array.isArray(itemUuids)
          ? itemUuids
          : Array.from(itemGroupMap.keys());

        for (const u of uuidsToResolve) {
          if (!u) continue;

          let item = null;

          // Try resolving via fromUuidSync first
          try {
            item = fromUuidSync(u);
          } catch (_err) {}

          // Fallback: try to pull from the actor's own items
          if (!item && actor.items) {
            const match = u.match(/Item\.([A-Za-z0-9]+)$/);
            const idGuess = match ? match[1] : null;
            if (idGuess) {
              item = actor.items.get(idGuess);
            }
          }

          if (!item || uniqueIds.has(item.id)) continue;
          uniqueIds.add(item.id);

          const triggerInfo = itemGroupMap.get(u);
          reactions.push({
            item,
            triggers: uniqueStrings(triggerInfo?.triggers ?? []),
            rows: []
          });
        }

        if (!reactions.length) {
          console.warn("[ReactionManager] OniReactionOffer: no valid Item documents resolved for this offer.", itemUuids);
          return;
        }

        const resolvedTriggerKey = latestTriggerKey ?? triggerKey ?? "(unknown_trigger)";
        const resolvedTriggerKeys = uniqueStrings(triggerKeys ?? reactions.flatMap(r => r?.triggers ?? []));

        const ctx = {
          combatant: null, // not used by ReactionChooseSkill
          actor,
          token,
          reactions,
          triggerKey: resolvedTriggerKey,
          latestTriggerKey: resolvedTriggerKey,
          triggerKeys: resolvedTriggerKeys,
          phasePayload: foundry.utils.deepClone(latestPhasePayload ?? phasePayload ?? {}),
          latestPhasePayload: foundry.utils.deepClone(latestPhasePayload ?? phasePayload ?? {}),
          phasePayloadByTrigger: foundry.utils.deepClone(phasePayloadByTrigger ?? {}),
          triggerEntries: resolvedTriggerKeys.map(k => ({
            triggerKey: k,
            phasePayload: foundry.utils.deepClone((phasePayloadByTrigger ?? {})[k] ?? {}),
            reactions: reactions.filter(r => Array.isArray(r?.triggers) && r.triggers.includes(k))
          })),
          phaseBucket: phaseBucket ?? null,
          ownerUserIds: [targetUserId]
        };

        _localReactionWindows.set(makeWindowKey(phaseBucket, tokenId), foundry.utils.deepClone({
          phaseBucket,
          tokenId,
          triggerKey: resolvedTriggerKey,
          triggerKeys: resolvedTriggerKeys
        }));

        // Spawn the floating button and wire it to open the dialog on click
        uiApi.spawnButton(token, ctx, (clickedCtx) => {
          const dialogApi = window["oni.ReactionChooseSkill"];
          if (!dialogApi || typeof dialogApi.openReactionDialog !== "function") {
            ui.notifications?.error?.("[Reaction] ReactionChooseSkill script not installed (socket offer).");
            console.error("[ReactionManager] Missing oni.ReactionChooseSkill.openReactionDialog for OniReactionOffer.");
            return;
          }

          dialogApi.openReactionDialog(clickedCtx);
        });

        return;
      }

      // Other message types on this channel are ignored by ReactionManager.
    }

    // Attach our handler to the module channel on every client (GM + players)
    if (game.socket) {
      game.socket.on(CHANNEL, handleModuleMessage);
      console.log("[ReactionManager] Module socket listener attached on", CHANNEL, "for user", game.user.id);
    } else {
      console.warn("[ReactionManager] game.socket is not available; GM→Player Reaction offers will not work.");
    }

    // -------------------------------------------------------------------------
    // 4) Hard cleanup when combat ends
    // -------------------------------------------------------------------------
    //
    // No matter what phase we THINK we're in, if the combat is deleted or ends,
    // any leftover Reaction buttons should disappear.

    Hooks.on("combatEnd", (combat, data) => {
      console.log("[ReactionManager] combatEnd detected – hard nuking all Reaction buttons on this client.", {
        combatId: combat?.id,
        localUserId: game.user.id,
        isGM: game.user.isGM
      });

      clearAllReactionWindows();
      hardNukeReactionButtons("combatEnd");
      _currentPhaseBucket = null;
    });

    Hooks.on("deleteCombat", (combat, options, userId) => {
      console.log("[ReactionManager] deleteCombat detected – hard nuking all Reaction buttons on this client.", {
        combatId: combat?.id,
        localUserId: game.user.id,
        isGM: game.user.isGM
      });

      clearAllReactionWindows();
      hardNukeReactionButtons("deleteCombat");
      _currentPhaseBucket = null;
    });

    console.log("[ReactionManager] Demo installed. Listening for oni:reactionPhase and combat end.");

    // Expose a small debug API that proxies to ReactionTriggerCore.
    window[KEY] = {
      /**
       * Debug helper: call the underlying ReactionTriggerCore.collectReactionsForTrigger
       * from the console, e.g.:
       *   window["oni.ReactionManager"]
       *     .collectReactionsForTrigger("turn_start", { ...payload... });
       */
      collectReactionsForTrigger(triggerKey, phasePayload) {
        const triggerApi = window["oni.ReactionTriggerCore"];
        if (!triggerApi || typeof triggerApi.collectReactionsForTrigger !== "function") {
          console.error("[ReactionManager] Debug collectReactionsForTrigger: ReactionTriggerCore not available.");
          return [];
        }
        return triggerApi.collectReactionsForTrigger(triggerKey, phasePayload);
      },

      getCurrentPhaseBucket() {
        return _currentPhaseBucket;
      },

      debugListGMReactionWindows() {
        return Array.from(_gmReactionWindows.entries()).map(([key, ws]) => ({
          key,
          phaseBucket: ws.phaseBucket,
          tokenId: ws.tokenId,
          actorName: ws.actor?.name,
          tokenName: ws.token?.name,
          latestTriggerKey: ws.latestTriggerKey,
          triggerKeys: [...(ws.triggerKeys ?? [])],
          ownerUserIds: [...(ws.ownerUserIds ?? [])],
          numReactionItems: ws.reactionGroupsByItemUuid?.size ?? 0
        }));
      },

      async processPassiveDebug(matches, triggerKey, phasePayload, options = {}) {
        const autoPassiveApi = window["oni.AutoPassiveManager"] ?? globalThis.FUCompanion?.api?.autoPassiveManager ?? null;
        if (!autoPassiveApi?.processMatches) {
          console.warn("[ReactionManager] Debug processPassiveDebug: AutoPassiveManager not available.");
          return {
            ok: false,
            reason: "auto_passive_manager_missing"
          };
        }

        const phaseBucket = options?.phaseBucket ?? phaseBucketForTrigger(triggerKey);
        const rawTrigger = options?.rawTrigger ?? triggerKey;
        const normalizedPayload = phasePayload ?? {};
        const sourceEvent = options?.sourceEvent ?? buildPassiveSourceEvent({
          rawTrigger,
          triggerKey,
          phaseBucket,
          payload: normalizedPayload
        });

        return autoPassiveApi.processMatches({
          matches: Array.isArray(matches) ? matches : [],
          triggerKey,
          phaseBucket,
          rawTrigger,
          phasePayload: normalizedPayload,
          phasePayloadByTrigger: {
            [triggerKey]: foundry.utils.deepClone(normalizedPayload)
          },
          sourceEvent
        });
      }
    };
  })();
});
