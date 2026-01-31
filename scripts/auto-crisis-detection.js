// fabula-ultima-companion/scripts/auto-crisis-detection.js
(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[FUC][AutoCrisis]";

  // Your provided Crisis Active Effect UUID
  const CRISIS_EFFECT_UUID = "Item.0gIBYzSpjdXS6f25.ActiveEffect.4ldx00srGNv5AJBr";

  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const err  = (...a) => console.error(TAG, ...a);

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

    // Main hook: after an Actor updates, check if they should gain/lose Crisis
    Hooks.on("updateActor", (actor, changed, options) => {
      // Prevent recursion when we add/remove effects ourselves
      if (options?.oniAutoCrisis) return;

      // Only when HP changed
      if (!hpWasTouched(changed)) return;

      evaluateActorCrisis(actor).catch(e => err("evaluateActorCrisis failed:", e));
    });

    // Optional: on ready, do a one-time sync across ALL actors in the world
    // so existing actors immediately get correct Crisis state after a reload.
    for (const actor of game.actors ?? []) {
      evaluateActorCrisis(actor).catch(e => err("Initial sync failed:", e));
    }
  });
})();
