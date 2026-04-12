// PassiveModifierApply
// New behavior:
// - Treat passive logic as item-based script stored in .system.props.custom_logic_passive
// - Call passive engine and let passive scripts mutate __PAYLOAD directly
// - No flat/percent legacy merge step
//
// IMPORTANT:
// - RETURN the top-level Promise so ActionDataComputation can truly await pm.execute(...)

return (async () => {
  const TAG = "[ONI][PassiveModifierApply]";
  const DEBUG = true; // <- toggle backend logs here

  let AUTO = false;
  let PAYLOAD = {};
  if (typeof __AUTO !== "undefined") {
    AUTO = __AUTO;
    PAYLOAD = __PAYLOAD ?? {};
  }

  const log = (...a) => { if (DEBUG) console.log(TAG, ...a); };
  const warn = (...a) => { if (DEBUG) console.warn(TAG, ...a); };
  const err = (...a) => { if (DEBUG) console.error(TAG, ...a); };

  function clone(obj, fallback = {}) {
    try {
      if (obj == null) {
        return foundry?.utils?.deepClone
          ? foundry.utils.deepClone(fallback)
          : JSON.parse(JSON.stringify(fallback));
      }
      return foundry?.utils?.deepClone
        ? foundry.utils.deepClone(obj)
        : JSON.parse(JSON.stringify(obj));
    } catch {
      if (Array.isArray(obj)) return [...obj];
      if (obj && typeof obj === "object") return { ...obj };
      return foundry?.utils?.deepClone
        ? foundry.utils.deepClone(fallback)
        : fallback;
    }
  }

  function uniq(arr) {
    return Array.from(new Set((Array.isArray(arr) ? arr : []).filter(Boolean).map(String)));
  }

  function snapshotPayload(p = {}) {
    return {
      skillName: p?.core?.skillName ?? p?.dataCore?.skillName ?? null,
      attackerUuid:
        p?.meta?.attackerUuid ??
        p?.attackerUuid ??
        p?.attackerActorUuid ??
        null,
      elementType:
        p?.meta?.elementType ??
        p?.advPayload?.elementType ??
        null,
      baseValue: String(p?.advPayload?.baseValue ?? "0"),
      bonus: Number(p?.advPayload?.bonus ?? 0) || 0,
      reduction: Number(p?.advPayload?.reduction ?? 0) || 0,
      multiplier: Number(p?.advPayload?.multiplier ?? 100) || 100,
      accuracyBonus: Number(p?.accuracy?.bonus ?? 0) || 0,
      targets: uniq(p?.targets ?? []),
      abort: !!p?.meta?.__abortPipeline,
      abortReason: String(p?.meta?.__abortReason ?? "")
    };
  }

  function diffSnapshots(before, after) {
    return {
      baseValue: `${before.baseValue} -> ${after.baseValue}`,
      bonus: `${before.bonus} -> ${after.bonus}`,
      reduction: `${before.reduction} -> ${after.reduction}`,
      multiplier: `${before.multiplier} -> ${after.multiplier}`,
      accuracyBonus: `${before.accuracyBonus} -> ${after.accuracyBonus}`,
      targetsCount: `${before.targets.length} -> ${after.targets.length}`,
      abort: `${before.abort} -> ${after.abort}`,
      abortReason: `${before.abortReason} -> ${after.abortReason}`
    };
  }

  async function resolveActor(uuidOrDoc) {
    if (!uuidOrDoc) return null;

    let doc = uuidOrDoc;
    if (typeof uuidOrDoc === "string") {
      try {
        doc = await fromUuid(uuidOrDoc);
      } catch (e) {
        warn("fromUuid failed while resolving attacker.", {
          uuidOrDoc,
          error: String(e?.message ?? e)
        });
        return null;
      }
    }

    if (!doc) return null;
    if (doc?.documentName === "Actor" || doc?.constructor?.name === "Actor") return doc;
    if (doc?.actor) return doc.actor;
    if (doc?.object?.actor) return doc.object.actor;
    if (doc?.token?.actor) return doc.token.actor;
    if (doc?.parent?.actor) return doc.parent.actor;
    if (doc?.document?.actor) return doc.document.actor;

    return null;
  }

  try {
    PAYLOAD.meta = PAYLOAD.meta || {};
    PAYLOAD.advPayload = PAYLOAD.advPayload || {};

    const pmApi = globalThis.FUCompanion?.api?.passiveModifier;
    if (typeof pmApi?.evaluatePassiveModifiers !== "function") {
      warn("Passive engine API missing; skipping.");
      return { ok: false, reason: "engine_missing" };
    }

    const attackerUuid =
      PAYLOAD?.meta?.attackerUuid ??
      PAYLOAD?.attackerUuid ??
      PAYLOAD?.attackerActorUuid ??
      null;

    if (!attackerUuid) {
      warn("No attacker UUID found on payload.");
      return { ok: false, reason: "no_attacker_uuid" };
    }

    const actor = await resolveActor(attackerUuid);
    if (!actor) {
      warn("Could not resolve attacker actor.", { attackerUuid });
      return { ok: false, reason: "no_actor" };
    }

    const before = snapshotPayload(PAYLOAD);

    log("START", {
      actor: actor?.name ?? null,
      actorUuid: actor?.uuid ?? null,
      skillName: before.skillName,
      attackerUuid: before.attackerUuid,
      elementType: before.elementType,
      targets: before.targets,
      autoPassive:
        PAYLOAD?.meta?.executionMode === "autoPassive" ||
        PAYLOAD?.meta?.isPassiveExecution === true ||
        PAYLOAD?.source === "AutoPassive"
    });

    const result = await pmApi.evaluatePassiveModifiers({
      actor,
      actionCtx: PAYLOAD,
      finalElement: String(
        PAYLOAD?.meta?.elementType ??
        PAYLOAD?.advPayload?.elementType ??
        ""
      ).trim().toLowerCase() || null
    });

    PAYLOAD.meta.passiveModifier = {
      ...(PAYLOAD.meta.passiveModifier ?? {}),
      lastRun: {
        ranAt: new Date().toISOString(),
        actorName: actor?.name ?? null,
        actorUuid: actor?.uuid ?? null,
        ok: !!result?.ok,
        ranScripts: Array.isArray(result?.ranScripts) ? clone(result.ranScripts, []) : [],
        skippedScripts: Array.isArray(result?.skippedScripts) ? clone(result.skippedScripts, []) : [],
        errors: Array.isArray(result?.errors) ? clone(result.errors, []) : [],
        breakdown: Array.isArray(result?.breakdown) ? clone(result.breakdown, []) : []
      }
    };

    PAYLOAD.advPayload.passiveApplied = true;
    PAYLOAD.advPayload.passiveMods = result ?? null;

    const after = snapshotPayload(PAYLOAD);
    const diff = diffSnapshots(before, after);

    log("DONE", {
      actor: actor?.name ?? null,
      ok: !!result?.ok,
      ranScripts: Array.isArray(result?.ranScripts) ? result.ranScripts.length : 0,
      skippedScripts: Array.isArray(result?.skippedScripts) ? result.skippedScripts.length : 0,
      errors: Array.isArray(result?.errors) ? result.errors.length : 0,
      diff
    });

    return {
      ok: !!result?.ok,
      actorName: actor?.name ?? null,
      actorUuid: actor?.uuid ?? null,
      ranScripts: Array.isArray(result?.ranScripts) ? result.ranScripts.length : 0,
      skippedScripts: Array.isArray(result?.skippedScripts) ? result.skippedScripts.length : 0,
      errors: Array.isArray(result?.errors) ? result.errors.length : 0,
      abort: !!PAYLOAD?.meta?.__abortPipeline,
      abortReason: PAYLOAD?.meta?.__abortReason ?? null,
      diff,
      engineResult: result ?? null
    };
  } catch (e) {
    err("Failed:", e);
    return {
      ok: false,
      error: String(e?.message ?? e)
    };
  }
})();
