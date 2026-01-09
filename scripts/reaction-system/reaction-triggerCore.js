/**
 * [ONI] Reaction System — Module Version (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * This file is safe to load automatically from a module (runs once per client).
 * Generated: 2026-01-09T07:27:00
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  /**
   * Macro: ReactionTriggerCore
   * Id: PE1TObaoXwIY93uT
   * Folder: Reaction System
   * Type: script
   * Author: GM
   * Exported: 2026-01-09T07:11:59.483Z
   */
  // ============================================================================
  // ONI ReactionTriggerCore – v0.1 (Foundry VTT v12)
  // ---------------------------------------------------------------------------
  // PURPOSE
  // -------
  // Encapsulate all logic related to:
  //   - Mapping raw phase triggers → reaction trigger keys
  //   - Validating reaction trigger keys
  //   - Building subject token lists from payloads
  //   - Matching reaction_source + reaction_damage_type filters
  //   - Scanning the current combat for Actors who *could* react
  //
  // This file does NOT:
  //   - Decide which users should see the Reaction UI
  //   - Spawn any UI
  //   - Talk to sockets
  //
  // Those responsibilities stay inside ReactionManager.
  //
  // EXPOSED API (window["oni.ReactionTriggerCore"])
  // ----------------------------------------------
  // byIdOnCanvas(tokenId)                    -> Token | null
  // mapIncomingTrigger(rawTrigger)          -> normalized triggerKey | null
  // isValidTriggerKey(triggerKey)           -> boolean
  // collectReactionsForTrigger(triggerKey, phasePayload) -> Array<ReactionContext>
  //
  // ReactionContext structure:
  //   {
  //     combatant,   // Combatant document
  //     actor,       // Actor document
  //     token,       // Token on canvas
  //     reactions: [ // For this actor
  //       {
  //         item,    // Item document (Reaction Skill)
  //         triggers: [ "turn_start", ... ],
  //         rows:    [ rowObj, rowObj, ... ] // matching config rows
  //       },
  //       ...
  //     ],
  //     triggerKey,   // normalized trigger key
  //     phasePayload  // original payload from oni:reactionPhase
  //   }
  // ============================================================================

  (() => {
    const KEY = "oni.ReactionTriggerCore";
    if (window[KEY]) {
      console.log("[ReactionTriggerCore] Already installed.");
      return;
    }

    // ---------------------------------------------------------------------------
    // Small helper – resolve token by id on current canvas
    // ---------------------------------------------------------------------------
    function byIdOnCanvas(tokenId) {
      if (!tokenId) return null;
      return canvas?.tokens?.get(tokenId) ?? null;
    }

    // ---------------------------------------------------------------------------
    // Valid trigger keys + mapping from PhaseHandler triggers
    // ---------------------------------------------------------------------------
    const VALID_TRIGGER_KEYS = new Set([
      "conflict_start",
      "round_start",
      "round_end",
      "turn_start",
      "turn_end",
      "creature_performs_check",
      "creature_targeted_by_action",
      "creature_hit_by_action",
      "creature_deals_damage",
      "creature_takes_damage"
    ]);

    const PHASE_TRIGGER_MAP = {
      start_of_conflict: "conflict_start",
      start_of_round:    "round_start",
      end_of_round:      "round_end",
      start_of_turn:     "turn_start",
      end_of_turn:       "turn_end",

      // Alias: the internal phase event "creature_is_targeted" should match
      // the skill config trigger "creature_targeted_by_action".
      creature_is_targeted: "creature_targeted_by_action"
    };

    function mapIncomingTrigger(rawTrigger) {
      if (!rawTrigger) return null;
      return PHASE_TRIGGER_MAP[rawTrigger] ?? rawTrigger;
    }

    function isValidTriggerKey(triggerKey) {
      if (!triggerKey) return false;
      return VALID_TRIGGER_KEYS.has(triggerKey);
    }

    // ---------------------------------------------------------------------------
    // Helpers for reading dynamic-table rows
    // ---------------------------------------------------------------------------

    // Try to extract rows from a dynamicTable-like structure.
    function extractRows(tableValue) {
      if (!tableValue) return [];
      const rows = [];

      // If it's already an array of row objects
      if (Array.isArray(tableValue)) {
        for (const row of tableValue) {
          if (row && typeof row === "object") rows.push(row);
        }
        return rows;
      }

      // If it's an object map (e.g. { "id1": {...}, "id2": {...} })
      if (typeof tableValue === "object") {
        for (const k of Object.keys(tableValue)) {
          const row = tableValue[k];
          if (row && typeof row === "object") rows.push(row);
        }
      }

      return rows;
    }

    // Read only the list of trigger keys from an item (not used by manager yet,
    // but kept for completeness / debugging).
    function extractReactionTriggers(item) {
      const sys   = item.system ?? {};
      const props = sys.props ?? sys;
      const table = props.reaction_config_table;
      const rows  = extractRows(table);
      const out   = [];

      for (const row of rows) {
        const key = row.reaction_trigger;
        if (typeof key === "string" && key.length > 0) out.push(key);
      }
      return out;
    }

     // ---------------------------------------------------------------------------
    // reaction_source helpers
    // ---------------------------------------------------------------------------
    //
    // reaction_source in each row can be:
    //   "", "all", "self", "ally", "enemy", "neutral"
    // Empty / missing = behave as "all".
    //
    // These mostly matter for triggers that have a clear "subject creature":
    //   - "creature_*" triggers → subject list is built from the payload
    //   - "turn_start" / "turn_end" → subject = the token whose turn it is
    //
    // For global phase triggers like "conflict_start", "round_start", "round_end"
    // there is no single subject creature, so we keep the old behavior and
    // ignore reaction_source (all rows match regardless of source).

    function normalizeSourceKey(raw) {
      if (!raw || raw === "") return "all";
      const k = String(raw).toLowerCase();
      switch (k) {
        case "self":
        case "ally":
        case "enemy":
        case "neutral":
        case "all":
          return k;
        default:
          return "all";
      }
    }

    function normalizeDisposition(disposition) {
      // Foundry dispositions:
      //  1  = Friendly
      //  0  = Neutral
      // -1  = Hostile
      // -2  = Secret  (we treat as Neutral)
      if (disposition === -2) return 0;
      if (disposition === 1)  return 1;
      if (disposition === -1) return -1;
      return 0;
    }

    // ---------------------------------------------------------------------------
    // Token resolution helpers
    // ---------------------------------------------------------------------------

    // Given a combat + actorUuid, try to find the token for that actor.
    function findTokenByActorUuidInCombat(combat, actorUuid) {
      if (!combat || !actorUuid) return null;
      const combatants = combat.combatants?.contents ?? combat.combatants ?? [];
      for (const cmbt of combatants) {
        if (cmbt?.actor?.uuid === actorUuid) {
          const tokenId = cmbt.tokenId ?? cmbt.token?.id;
          const token   = byIdOnCanvas(tokenId);
          if (token) return token;
        }
      }
      return null;
    }

    // Resolve a "uuid-ish" string (Scene.Token UUID or plain tokenId)
    // into a token on the current canvas, if possible.
    function findTokenByUuidish(uuidish) {
      if (!uuidish || typeof uuidish !== "string") return null;

      // Case 1: Foundry Scene.Token UUID, e.g.
      //   "Scene.xxx.Token.yyy"
      const match = uuidish.match(/\.Token\.([A-Za-z0-9]+)$/);
      if (match) {
        const tokenId = match[1];
        const t = byIdOnCanvas(tokenId);
        if (t) return t;
      }

      // Case 2: maybe it's already just a tokenId
      const direct = byIdOnCanvas(uuidish);
      if (direct) return direct;

      // Optional fallback: if it's an Actor UUID, try to find via combatants
      try {
        const doc = (typeof fromUuidSync === "function")
          ? fromUuidSync(uuidish)
          : null;
        const tokenId2 = doc?.token?.id ?? doc?.id;
        if (tokenId2) {
          const t = byIdOnCanvas(tokenId2);
          if (t) return t;
        }
      } catch (_err) {
        // ignore
      }

      return null;
    }

    // ---------------------------------------------------------------------------
    // Subject tokens for "creature_*" triggers
    // ---------------------------------------------------------------------------
    //
    // Build a list of "subject" tokens for the current trigger.
    // These are the "creatures" that the reaction text refers to:
    //   - "When a creature performs a check"
    //   - "When a creature takes damage", etc.
    //
    function getSubjectTokensForTrigger(triggerKey, phasePayload, combat) {
      const subjects = [];
      if (!phasePayload || !combat) return subjects;

      const addToken = (token) => {
        if (!token) return;
        if (!subjects.includes(token)) subjects.push(token);
      };

      const addUuidish = (uuidish) => {
        if (!uuidish) return;
        const t = findTokenByUuidish(uuidish);
        if (t) addToken(t);
      };

      const addManyUuidish = (list) => {
        if (!Array.isArray(list)) return;
        for (const u of list) addUuidish(u);
      };

      switch (triggerKey) {
        case "creature_performs_check": {
          // Depending on your Action pipeline, these may be actor or token uuids.
          // We try both resolutions.
          addUuidish(phasePayload.tokenUuid);
          addUuidish(phasePayload.attackerUuid);
          addUuidish(phasePayload.checkTokenUuid);

          if (!subjects.length) {
            // Fallback: actor-based
            const t1 = findTokenByActorUuidInCombat(combat, phasePayload.actorUuid);
            const t2 = findTokenByActorUuidInCombat(combat, phasePayload.checkActorUuid);
            addToken(t1);
            addToken(t2);
          }
          break;
        }

        case "creature_targeted_by_action":
        case "creature_hit_by_action":
        case "creature_takes_damage": {
          // From your console log we know we have:
          //   - payload.targetUuid      (single token UUID)
          //   - payload.targets[]       (array of token UUIDs)
          addUuidish(phasePayload.targetUuid);
          addManyUuidish(phasePayload.targets);

          // Fallbacks if you ever use actor-level fields too
          if (!subjects.length) {
            const t1 = findTokenByActorUuidInCombat(combat, phasePayload.targetActorUuid);
            if (t1) addToken(t1);
            if (Array.isArray(phasePayload.targetActorUuids)) {
              for (const aUuid of phasePayload.targetActorUuids) {
                const t = findTokenByActorUuidInCombat(combat, aUuid);
                if (t) addToken(t);
              }
            }
          }
          break;
        }

        case "creature_deals_damage": {
          // For the "dealer", we expect token uuids like:
          //   - payload.attackerUuid
          //   - payload.sourceUuid
          addUuidish(phasePayload.attackerUuid);
          addUuidish(phasePayload.sourceUuid);

          // Fallbacks: actor-based
          if (!subjects.length) {
            const t1 = findTokenByActorUuidInCombat(combat, phasePayload.sourceActorUuid);
            const t2 = findTokenByActorUuidInCombat(combat, phasePayload.attackerActorUuid);
            const t3 = findTokenByActorUuidInCombat(combat, phasePayload.actorUuid);
            addToken(t1);
            addToken(t2);
            addToken(t3);
          }
          break;
        }

        default:
          // For non "creature_*" triggers we don't build subjects here.
          break;
      }

      return subjects;
    }

      // ---------------------------------------------------------------------------
    // reaction_source matching
    // ---------------------------------------------------------------------------

    // Does a single reaction row's reaction_source match this event?
    function reactionSourceMatchesRow(rowSourceRaw, reactionToken, triggerKey, phasePayload, combat) {
      const sourceKey = normalizeSourceKey(rowSourceRaw);

      // Small helper that applies the source filter once we
      // already have a list of "subject" tokens.
      const applyToSubjects = (subjects) => {
        // If we have no subject tokens:
        //   - "all" still matches (generic "a creature/turn" with unknown target).
        //   - more specific filters (self/ally/enemy/neutral) do *not*.
        if (!Array.isArray(subjects) || subjects.length === 0) {
          return sourceKey === "all";
        }

        const reactDoc  = reactionToken?.document;
        const reactDisp = normalizeDisposition(reactDoc?.disposition ?? 0);

        // Helper to test a single subject token
        const matchOne = (subjectToken) => {
          const subDoc  = subjectToken?.document;
          const subDisp = normalizeDisposition(subDoc?.disposition ?? 0);

          switch (sourceKey) {
            case "all":
              return true;

            case "self":
              // Same token OR same actor uuid is considered "self"
              if (!reactDoc || !subDoc) return false;
              if (subjectToken.id === reactionToken.id) return true;
              const reactActorUuid = reactionToken.actor?.uuid;
              const subjActorUuid  = subjectToken.actor?.uuid;
              return !!reactActorUuid && reactActorUuid === subjActorUuid;

            case "ally":
              // Ally = same side as the reactor.
              if (reactDisp === 1)  return subDisp === 1;   // PCs: other friendlies
              if (reactDisp === -1) return subDisp === -1;  // Monsters: other hostiles
              // Neutral reactors don't really have "allies" here
              return false;

            case "enemy":
              // Enemy = opposite side from the reactor.
              if (reactDisp === 1)  return subDisp === -1;  // PCs: enemies are Hostile
              if (reactDisp === -1) return subDisp === 1;   // Monsters: enemies are Friendly
              return false;

            case "neutral":
              return subDisp === 0;

            default:
              return true;
          }
        };

        return subjects.some(matchOne);
      };

      // -------------------------------------------------------------------------
      // 1) Creature-based triggers – use subject list from payload (unchanged)
      // -------------------------------------------------------------------------
      if (triggerKey.startsWith("creature_")) {
        const subjects = getSubjectTokensForTrigger(triggerKey, phasePayload, combat);
        return applyToSubjects(subjects);
      }

      // -------------------------------------------------------------------------
      // 2) Turn-based triggers – subject = token whose turn it is
      // -------------------------------------------------------------------------
      if (triggerKey === "turn_start" || triggerKey === "turn_end") {
        const subjects = [];
        if (phasePayload && combat) {
          // Prefer tokenUuid if present, then tokenId, then actorUuid.
          const turnToken =
            findTokenByUuidish(phasePayload.tokenUuid) ||
            byIdOnCanvas(phasePayload.tokenId) ||
            findTokenByActorUuidInCombat(combat, phasePayload.actorUuid);

          if (turnToken) {
            subjects.push(turnToken);
          }
        }

        return applyToSubjects(subjects);
      }

      // -------------------------------------------------------------------------
      // 3) Other phase triggers (conflict/round) – no per-creature subject.
      //    Keep old behavior: ignore reaction_source and always treat as match.
      // -------------------------------------------------------------------------
      return true;
    }

    // ---------------------------------------------------------------------------
    // reaction_damage_type helper
    // ---------------------------------------------------------------------------
    //
    // reaction_damage_type in each row is an element key from your select:
    //   "physical", "air", "bolt", "dark", "earth", "fire", "ice", "light", "poison"
    //
    // Empty / missing means "no filter" (matches any element).
    //
    // The event payload already carries things like:
    //   payload.elementType = "physical"
    //
    function reactionDamageTypeMatchesRow(rowDamageTypeRaw, triggerKey, phasePayload) {
      const desired = (rowDamageTypeRaw ?? "").toString().trim().toLowerCase();

      // No damage-type filter set on this row → always match
      if (!desired) return true;

      if (!phasePayload || typeof phasePayload !== "object") return false;

      // Try a few likely field names. You already use `elementType`, but we
      // support some aliases in case other triggers use different keys.
      const possibleKeys = [
        "elementType",
        "damageElementType",
        "damageType",
        "damage_type",
        "element"
      ];

      let eventRaw = null;
      for (const k of possibleKeys) {
        if (phasePayload[k] != null) {
          eventRaw = phasePayload[k];
          break;
        }
      }

      if (eventRaw == null) {
        console.log("[ReactionTriggerCore] reaction_damage_type filter set, but no elementType found in payload for trigger",
          triggerKey, phasePayload);
        return false;
      }

      const eventType = eventRaw.toString().trim().toLowerCase();
      return eventType === desired;
    }

    // ---------------------------------------------------------------------------
    // collectReactionsForTrigger
    // ---------------------------------------------------------------------------
    //
    // This is the main "detector" entry point:
    //  - Looks at the current combat
    //  - For each combatant's Actor:
    //      * Looks for isReaction items
    //      * Filters their reaction_config_table rows by:
    //           reaction_trigger == triggerKey
    //           reaction_source matches (if creature_* trigger)
    //           reaction_damage_type matches (if set)
    //
    //  - Returns a list of "reaction contexts" WITHOUT any user/ownership info.
    // ---------------------------------------------------------------------------

    function collectReactionsForTrigger(triggerKey, phasePayload) {
      const combat = game.combat;
      if (!combat) {
        console.log("[ReactionTriggerCore] collectReactionsForTrigger: no active combat.", {
          triggerKey,
          phasePayload
        });
        return [];
      }

      const results = [];
      const combatants = combat.combatants?.contents ?? combat.combatants ?? [];

      console.log("[ReactionTriggerCore] collectReactionsForTrigger: scanning combatants for trigger.", {
        triggerKey,
        numCombatants: combatants.length,
        phasePayload
      });

      for (const cmbt of combatants) {
        const actor = cmbt?.actor;
        if (!actor) {
          console.log("[ReactionTriggerCore] collectReactionsForTrigger: skipping combatant with no actor.", {
            combatantId: cmbt?.id,
            combatantName: cmbt?.name
          });
          continue;
        }

        // Only consider tokens that actually exist on the current canvas
        const tokenId = cmbt.tokenId ?? cmbt.token?.id;
        const token   = byIdOnCanvas(tokenId);
        if (!token) {
          console.log("[ReactionTriggerCore] collectReactionsForTrigger: skipping actor with no token on this canvas.", {
            combatantId: cmbt.id,
            combatantName: cmbt.name,
            actorName: actor.name,
            tokenId
          });
          continue;
        }

        const tokenDoc = token.document;
        const actorReactions = [];

        for (const item of actor.items ?? []) {
          const sys   = item.system ?? {};
          const props = sys.props ?? sys;
          if (!props?.isReaction) continue;

          const table = props.reaction_config_table;
          const rows  = extractRows(table);

          // For this item, collect only the rows that:
          //   1) Have reaction_trigger == triggerKey
          //   2) Pass the reaction_source filter for THIS event + actor
          //   3) Pass the reaction_damage_type filter (if any)
          const matchingRows = [];

          for (const row of rows) {
            const rowTrigger = row.reaction_trigger;
            if (rowTrigger !== triggerKey) continue;

            // 1) Source (Self / Ally / Enemy / Neutral / All)
            const rowSource = row.reaction_source;
            const okSource  = reactionSourceMatchesRow(rowSource, token, triggerKey, phasePayload, combat);
            if (!okSource) continue;

            // 2) Damage type (Physical / Fire / Ice / etc.)
            const rowDamageType = row.reaction_damage_type;
            const okDamageType  = reactionDamageTypeMatchesRow(rowDamageType, triggerKey, phasePayload);
            if (!okDamageType) continue;

            matchingRows.push(row);
          }

          if (matchingRows.length > 0) {
            console.log("[ReactionTriggerCore] collectReactionsForTrigger: item has matching rows for trigger.", {
              actorName: actor.name,
              tokenName: tokenDoc.name,
              itemName: item.name,
              triggerKey,
              matchingRowCount: matchingRows.length
            });

            actorReactions.push({
              item,
              triggers: matchingRows.map(r => r.reaction_trigger),
              rows: matchingRows
            });
          } else {
            console.log("[ReactionTriggerCore] collectReactionsForTrigger: item has NO matching rows for trigger.", {
              actorName: actor.name,
              tokenName: tokenDoc.name,
              itemName: item.name,
              triggerKey
            });
          }
        }

        if (actorReactions.length > 0) {
          results.push({
            combatant: cmbt,
            actor,
            token,
            reactions: actorReactions,
            triggerKey,
            phasePayload
          });

          console.log("[ReactionTriggerCore] collectReactionsForTrigger: actor has reaction candidates.", {
            combatantId: cmbt.id,
            combatantName: cmbt.name,
            actorName: actor.name,
            tokenName: tokenDoc.name,
            numReactionItems: actorReactions.length
          });
        } else {
          console.log("[ReactionTriggerCore] collectReactionsForTrigger: actor has NO matching reaction rows for this trigger.", {
            combatantId: cmbt.id,
            combatantName: cmbt.name,
            actorName: actor.name,
            tokenName: tokenDoc.name,
            triggerKey
          });
        }
      }

      console.log("[ReactionTriggerCore] collectReactionsForTrigger: final results.", {
        triggerKey,
        resultCount: results.length,
        resultSummary: results.map(r => ({
          actorName: r.actor?.name,
          tokenName: r.token?.name,
          numReactionItems: r.reactions?.length ?? 0
        }))
      });

      return results;
    }

    // ---------------------------------------------------------------------------
    // EXPORT
    // ---------------------------------------------------------------------------

    window[KEY] = {
      byIdOnCanvas,
      mapIncomingTrigger,
      isValidTriggerKey,
      collectReactionsForTrigger,
      extractRows,
      extractReactionTriggers,
      reactionSourceMatchesRow,
      reactionDamageTypeMatchesRow
    };

    console.log("[ReactionTriggerCore] Installed. Exposed on window['oni.ReactionTriggerCore'].");
  })();
});
