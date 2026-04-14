// PassiveModifierApply
// New behavior:
// - Treat passive logic as item-based script stored in .system.props.custom_logic_passive
// - Call passive engine and let passive scripts mutate __PAYLOAD directly
// - No flat/percent legacy merge step
//
// IMPORTANT:
// - RETURN the top-level Promise so ActionDataComputation can truly await pm.execute(...)
//
// NEW (GM bridge):
// - If current client is not GM and GMExecutor.executeSnippet(...) is available,
//   passive evaluation is executed through the generic GM executor
// - Returned payload is merged back into the live PAYLOAD object

return (async () => {
  const MODULE_ID = "fabula-ultima-companion";
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

  function mergeRemotePayloadInPlace(target, source) {
    if (!source || typeof source !== "object") return target;

    try {
      foundry.utils.mergeObject(target, source, {
        insertKeys: true,
        insertValues: true,
        overwrite: true,
        recursive: true,
        inplace: true
      });
    } catch (e) {
      warn("mergeObject failed; falling back to shallow assign", e);
      Object.assign(target, source);
    }

    if (Array.isArray(source.targets)) {
      target.targets = clone(source.targets, []);
    }

    if (Array.isArray(source.originalTargetUUIDs)) {
      target.originalTargetUUIDs = clone(source.originalTargetUUIDs, []);
    }

    return target;
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

    const attackerUuid =
      PAYLOAD?.meta?.attackerUuid ??
      PAYLOAD?.attackerUuid ??
      PAYLOAD?.attackerActorUuid ??
      null;

    const gmExecutor =
      game.modules?.get(MODULE_ID)?.api?.GMExecutor ??
      globalThis.FUCompanion?.api?.GMExecutor ??
      null;

    const canUseGMExecutor = !!(
      !game.user?.isGM &&
      gmExecutor &&
      typeof gmExecutor.executeSnippet === "function"
    );

    const before = snapshotPayload(PAYLOAD);

    log("START", {
      skillName: before.skillName,
      attackerUuid: before.attackerUuid,
      elementType: before.elementType,
      targets: before.targets,
      autoPassive:
        PAYLOAD?.meta?.executionMode === "autoPassive" ||
        PAYLOAD?.meta?.isPassiveExecution === true ||
        PAYLOAD?.source === "AutoPassive",
      executionPath: canUseGMExecutor ? "gm-executor-generic" : "local",
      autoFlag: !!AUTO
    });

    const runLocalPassiveEngine = async () => {
      const pmApi =
        globalThis.FUCompanion?.api?.passiveModifier ??
        game.modules?.get(MODULE_ID)?.api?.passiveModifier ??
        null;

      if (typeof pmApi?.evaluatePassiveModifiers !== "function") {
        warn("Passive engine API missing; skipping.");
        return { ok: false, reason: "engine_missing", via: "local" };
      }

      if (!attackerUuid) {
        warn("No attacker UUID found on payload.");
        return { ok: false, reason: "no_attacker_uuid", via: "local" };
      }

      const actor = await resolveActor(attackerUuid);
      if (!actor) {
        warn("Could not resolve attacker actor.", { attackerUuid });
        return { ok: false, reason: "no_actor", via: "local" };
      }

      const result = await pmApi.evaluatePassiveModifiers({
        actor,
        actionCtx: PAYLOAD,
        finalElement: String(
          PAYLOAD?.meta?.elementType ??
          PAYLOAD?.advPayload?.elementType ??
          ""
        ).trim().toLowerCase() || null
      });

      return {
        ok: !!result?.ok,
        via: "local",
        actorName: actor?.name ?? null,
        actorUuid: actor?.uuid ?? null,
        engineResult: result ?? null
      };
    };

    const runPassiveViaGM = async () => {
      if (!gmExecutor?.executeSnippet) {
        throw new Error("GMExecutor.executeSnippet is not available");
      }

      log("EXECUTE passive evaluation via generic GMExecutor...", {
        callerUserId: game.user?.id ?? null,
        attackerUuid
      });

      const wrappedScript = `
const pmApi =
  globalThis.FUCompanion?.api?.passiveModifier ??
  game.modules?.get("${MODULE_ID}")?.api?.passiveModifier ??
  null;

if (typeof pmApi?.evaluatePassiveModifiers !== "function") {
  throw new Error("Passive engine API missing");
}

const actor = await env.resolveActor(env.actorUuid);
if (!actor) {
  throw new Error(\`Could not resolve attacker actor: \${env.actorUuid ?? "null"}\`);
}

const result = await pmApi.evaluatePassiveModifiers({
  actor,
  actionCtx: payload,
  finalElement: String(
    payload?.meta?.elementType ??
    payload?.advPayload?.elementType ??
    ""
  ).trim().toLowerCase() || null
});

return {
  engineResult: result ?? null,
  actorName: actor?.name ?? null,
  actorUuid: actor?.uuid ?? null
};
      `.trim();

      const remote = await gmExecutor.executeSnippet({
        mode: "generic",
        scriptText: wrappedScript,
        payload: PAYLOAD,
        actorUuid: attackerUuid ?? null,
        auto: !!AUTO,
        metadata: {
          origin: "PassiveModifierApply"
        }
      });

      log("GMExecutor RETURN", {
        ok: !!remote?.ok,
        hasPayload: !!remote?.payload,
        hasResultValue: !!remote?.resultValue,
        error: remote?.error ?? null
      });

      if (remote?.payload) {
        mergeRemotePayloadInPlace(PAYLOAD, remote.payload);
      }

      const resultValue = remote?.resultValue ?? null;
      const finalOk = !!(resultValue?.engineResult?.ok ?? remote?.ok);

      return {
        ok: finalOk,
        via: "gm-executor-generic",
        actorName: resultValue?.actorName ?? null,
        actorUuid: resultValue?.actorUuid ?? null,
        engineResult: resultValue?.engineResult ?? null,
        error: remote?.error ?? null
      };
    };

    let execResult;
    if (canUseGMExecutor) {
      execResult = await runPassiveViaGM();
    } else {
      if (!game.user?.isGM && !gmExecutor?.executeSnippet) {
        warn("GMExecutor generic API is unavailable on a non-GM client. Falling back to local execution; permission-gated logic may fail.");
      }
      execResult = await runLocalPassiveEngine();
    }

    PAYLOAD.meta.passiveModifier = {
      ...(PAYLOAD.meta.passiveModifier ?? {}),
      lastRun: {
        ranAt: new Date().toISOString(),
        actorName: execResult?.actorName ?? null,
        actorUuid: execResult?.actorUuid ?? null,
        ok: !!execResult?.ok,
        executionPath: execResult?.via ?? (canUseGMExecutor ? "gm-executor-generic" : "local"),
        ranScripts: Array.isArray(execResult?.engineResult?.ranScripts) ? clone(execResult.engineResult.ranScripts, []) : [],
        skippedScripts: Array.isArray(execResult?.engineResult?.skippedScripts) ? clone(execResult.engineResult.skippedScripts, []) : [],
        errors: Array.isArray(execResult?.engineResult?.errors) ? clone(execResult.engineResult.errors, []) : [],
        breakdown: Array.isArray(execResult?.engineResult?.breakdown) ? clone(execResult.engineResult.breakdown, []) : []
      }
    };

    PAYLOAD.advPayload.passiveApplied = true;
    PAYLOAD.advPayload.passiveMods = execResult?.engineResult ?? null;

    const after = snapshotPayload(PAYLOAD);
    const diff = diffSnapshots(before, after);

    log("DONE", {
      actor: execResult?.actorName ?? null,
      ok: !!execResult?.ok,
      executionPath: execResult?.via ?? (canUseGMExecutor ? "gm-executor-generic" : "local"),
      ranScripts: Array.isArray(execResult?.engineResult?.ranScripts) ? execResult.engineResult.ranScripts.length : 0,
      skippedScripts: Array.isArray(execResult?.engineResult?.skippedScripts) ? execResult.engineResult.skippedScripts.length : 0,
      errors: Array.isArray(execResult?.engineResult?.errors) ? execResult.engineResult.errors.length : 0,
      diff
    });

    return {
      ok: !!execResult?.ok,
      actorName: execResult?.actorName ?? null,
      actorUuid: execResult?.actorUuid ?? null,
      executionPath: execResult?.via ?? (canUseGMExecutor ? "gm-executor-generic" : "local"),
      ranScripts: Array.isArray(execResult?.engineResult?.ranScripts) ? execResult.engineResult.ranScripts.length : 0,
      skippedScripts: Array.isArray(execResult?.engineResult?.skippedScripts) ? execResult.engineResult.skippedScripts.length : 0,
      errors: Array.isArray(execResult?.engineResult?.errors) ? execResult.engineResult.errors.length : 0,
      abort: !!PAYLOAD?.meta?.__abortPipeline,
      abortReason: PAYLOAD?.meta?.__abortReason ?? null,
      diff,
      engineResult: execResult?.engineResult ?? null,
      error: execResult?.error ?? null
    };
  } catch (e) {
    err("Failed:", e);
    return {
      ok: false,
      error: String(e?.message ?? e)
    };
  }
})();
