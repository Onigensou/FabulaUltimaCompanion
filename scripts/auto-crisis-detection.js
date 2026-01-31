// fabula-ultima-companion/scripts/auto-crisis-detection.js
(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[FUC][AutoCrisis]";

  // Your provided Crisis Active Effect UUID
  const CRISIS_EFFECT_UUID = "Item.0gIBYzSpjdXS6f25.ActiveEffect.4ldx00srGNv5AJBr";

  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err  = (...a) => console.error(TAG, ...a);


  // Reaction System integration -----------------------------------------------
  // We emit "oni:reactionPhase" with trigger keys:
  //   - creature_enter_crisis
  //   - creature_exit_crisis
  //
  // This is designed to mirror your other trigger emit sites.
  function emitReactionPhase(payload) {
    try {
      if (globalThis?.ONI?.emit) {
        // Local-only is fine because the GM client will also receive the actor update
        // and therefore emit on its own client.
        globalThis.ONI.emit("oni:reactionPhase", payload, { local: true, world: false });
        return;
      }
    } catch (_e) {}

    // Fallback (in case ONI.emit isn't available yet)
    try {
      Hooks.callAll?.("oni:reactionPhase", payload);
    } catch (_e) {
      warn("Could not emit oni:reactionPhase (no ONI.emit or Hooks.callAll).", payload);
    }
  }

  function buildCrisisReactionPayload(actor, tokenUuids, extra) {
    return {
      trigger: extra?.trigger ?? null,
      // For creature_* trigger core resolution
      tokenUuid: tokenUuids?.[0] ?? null,
      targetUuid: tokenUuids?.[0] ?? null,
      targets: Array.isArray(tokenUuids) ? tokenUuids : [],
      actorUuid: actor?.uuid ?? null,
      targetActorUuid: actor?.uuid ?? null,
      // Debug / context (ignored by trigger core if not needed)
      hpCur: extra?.hpCur ?? null,
      hpMax: extra?.hpMax ?? null,
      threshold: extra?.threshold ?? null,
      source: "auto-crisis-detection"
    };
  }

  function getRelevantTokenUuids(actor) {
    // Prefer tokens in the active combat scene, otherwise fall back to current canvas scene.
    const combatSceneId = game.combat?.scene?.id ?? null;

    const tokens = actor?.getActiveTokens?.(true, true) ?? actor?.getActiveTokens?.(true) ?? [];
    const filtered = tokens.filter(t => {
      const sceneId = t?.document?.parent?.id ?? t?.scene?.id ?? null;
      if (combatSceneId) return sceneId === combatSceneId;
      return sceneId === canvas?.scene?.id;
    });

    // Use document.uuid because ReactionTriggerCore can parse ".Token.<id>"
    return filtered.map(t => t?.document?.uuid).filter(Boolean);
  }

  // Track "before" crisis state so we can detect ENTER/EXIT transitions cleanly
  const _preUpdateCrisisState = new WeakMap();


  function toNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // Crisis threshold rule:
  // "Below 50% HP (round up when calculating percentage)" -> current_hp <= ceil(max_hp / 2)
  function crisisThreshold(maxHp) {
    return Math.ceil(maxHp / 2);
  }

  // Your actor templates store HP under system.props.current_hp / system.props.max_hp
  // (We also try a couple fallback paths just in case)
  function getHp(actor) {
    const sys = actor?.system ?? {};
    const props = sys.props ?? {};

    const curRaw =
      props.current_hp ??
      sys.current_hp ??
      sys.attributes?.hp?.value ??
      sys.hp?.value;

    const maxRaw =
      props.max_hp ??
      sys.max_hp ??
      sys.attributes?.hp?.max ??
      sys.hp?.max;

    const cur = toNumber(curRaw);
    const max = toNumber(maxRaw);

    return { cur, max };
  }

  function findExistingCrisisEffect(actor) {
    // Prefer removing only the effect that matches your template UUID,
    // or the one we applied (flagged).
    return actor.effects.find(e =>
      e?.origin === CRISIS_EFFECT_UUID ||
      e?.flags?.[MODULE_ID]?.autoCrisis === true
    );
  }

  async function buildCrisisEffectData() {
    const template = await fromUuid(CRISIS_EFFECT_UUID);
    if (!template) return null;

    const data = template.toObject();

    // Remove _id so Foundry can create a new embedded effect
    delete data._id;

    // Mark it so we can safely identify/remove it later
    data.flags ??= {};
    data.flags[MODULE_ID] ??= {};
    data.flags[MODULE_ID].autoCrisis = true;

    // Set origin to the template UUID (useful for identification)
    data.origin = CRISIS_EFFECT_UUID;

    // "Indefinite until HP recovers" -> leave duration empty
    data.duration = {};

    return data;
  }

  async function applyCrisis(actor) {
    const existing = findExistingCrisisEffect(actor);
    if (existing) return;

    const data = await buildCrisisEffectData();
    if (!data) {
      warn("Could not resolve Crisis ActiveEffect UUID:", CRISIS_EFFECT_UUID);
      return;
    }

    await actor.createEmbeddedDocuments("ActiveEffect", [data], {
      oniAutoCrisis: true
    });

    log(`Applied Crisis to: ${actor.name}`);
  }

  async function removeCrisis(actor) {
    const existing = findExistingCrisisEffect(actor);
    if (!existing) return;

    await actor.deleteEmbeddedDocuments("ActiveEffect", [existing.id], {
      oniAutoCrisis: true
    });

    log(`Removed Crisis from: ${actor.name}`);
  }

  async function evaluateActorCrisis(actor) {
    if (!actor) return;

    const { cur, max } = getHp(actor);
    if (cur === null || max === null || max <= 0) return;

    const threshold = crisisThreshold(max);
    const inCrisis = cur <= threshold;

    if (inCrisis) await applyCrisis(actor);
    else await removeCrisis(actor);
  }

  function hpWasTouched(changed) {
    // Filter: only react when HP fields are part of the update payload
    const hpPaths = [
      "system.props.current_hp",
      "system.props.max_hp",
      "system.current_hp",
      "system.max_hp",
      "system.attributes.hp.value",
      "system.attributes.hp.max"
    ];
    return hpPaths.some(p => foundry.utils.hasProperty(changed, p));
  }

  Hooks.once("ready", () => {
    log("Loaded.");

    // Capture the crisis state *before* HP updates so we can detect enter/exit transitions
    Hooks.on("preUpdateActor", (actor, changed, options) => {
      if (options?.oniAutoCrisis) return;
      if (!hpWasTouched(changed)) return;

      // Compute "before" from current actor data
      const before = getHp(actor);
      if (before.cur === null || before.max === null || before.max <= 0) return;

      // Compute "after" by applying the changed values (when present)
      const afterCur =
        foundry.utils.getProperty(changed, "system.props.current_hp") ??
        foundry.utils.getProperty(changed, "system.current_hp") ??
        foundry.utils.getProperty(changed, "system.attributes.hp.value") ??
        before.cur;

      const afterMax =
        foundry.utils.getProperty(changed, "system.props.max_hp") ??
        foundry.utils.getProperty(changed, "system.max_hp") ??
        foundry.utils.getProperty(changed, "system.attributes.hp.max") ??
        before.max;

      const curAfter = toNumber(afterCur);
      const maxAfter = toNumber(afterMax);
      if (curAfter === null || maxAfter === null || maxAfter <= 0) return;

      const thresholdBefore = crisisThreshold(before.max);
      const thresholdAfter  = crisisThreshold(maxAfter);

      const wasInCrisis = before.cur <= thresholdBefore;
      const willBeInCrisis = curAfter <= thresholdAfter;

      _preUpdateCrisisState.set(actor, {
        wasInCrisis,
        willBeInCrisis,
        before,
        after: { cur: curAfter, max: maxAfter },
        thresholdAfter
      });
    });


    // Main hook: after an Actor updates, check if they should gain/lose Crisis
    
    Hooks.on("updateActor", (actor, changed, options) => {
      // Prevent recursion when we add/remove effects ourselves
      if (options?.oniAutoCrisis) return;

      // Only when HP changed
      if (!hpWasTouched(changed)) return;

      const pre = _preUpdateCrisisState.get(actor) ?? null;
      _preUpdateCrisisState.delete(actor);

      evaluateActorCrisis(actor)
        .then(() => {
          // After we sync the actual ActiveEffect, emit a Reaction trigger
          // only if we detected an ENTER/EXIT transition across the threshold.
          if (!pre) return;

          const { wasInCrisis, willBeInCrisis, after, thresholdAfter } = pre;
          if (wasInCrisis === willBeInCrisis) return;

          const tokenUuids = getRelevantTokenUuids(actor);
          if (tokenUuids.length === 0) {
            // We can still emit, but disposition filtering may not work without a token on canvas.
            warn("Crisis transition detected, but no active token found on canvas/combat scene:", actor.name);
          }

          const trigger = willBeInCrisis ? "creature_enter_crisis" : "creature_exit_crisis";
          const payload = buildCrisisReactionPayload(actor, tokenUuids, {
            trigger,
            hpCur: after.cur,
            hpMax: after.max,
            threshold: thresholdAfter
          });

          emitReactionPhase(payload);
          log(`Emitted Crisis Reaction trigger: ${trigger} for ${actor.name}`);
        })
        .catch(e => err("evaluateActorCrisis failed:", e));
    });

    // Optional: on ready, do a one-time sync across ALL actors in the world
    // so existing actors immediately get correct Crisis state after a reload.
    for (const actor of game.actors ?? []) {
      evaluateActorCrisis(actor).catch(e => err("Initial sync failed:", e));
    }
  });
})();
