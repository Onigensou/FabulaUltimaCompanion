/*********************************************************
 * Create Damage Card (shim → module) · Foundry V12
 * Forwards __PAYLOAD to FabulaUltimaCompanion API.
 * Keeps your existing flow intact while using the module
 * so speakerless rendering works for ALL clients.
 *********************************************************/
(async () => {
  const RUN_TAG = "[FU CreateDamageCard Shim]";
  const DBG_TAG = "[FU CreateDamageCard Shim][DBG]";
  const TRACE_ID = `CDC-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  const dbg = (label, data) => {
    try {
      console.log(`${DBG_TAG} ${label}`, data);
    } catch (_) {}
  };

  const nonBlankString = (...values) => {
    for (const value of values) {
      const s = value == null ? "" : String(value).trim();
      if (s) return s;
    }
    return "";
  };

  const buildReactionActionContext = (ctx) => {
    if (!ctx || typeof ctx !== "object") return null;
    return {
      core: {
        skillTypeRaw: ctx?.core?.skillTypeRaw ?? null
      },
      dataCore: {
        skillTypeRaw: ctx?.dataCore?.skillTypeRaw ?? null,
        isSpell: !!ctx?.dataCore?.isSpell
      },
      meta: {
        skillTypeRaw: ctx?.meta?.skillTypeRaw ?? null,
        isSpellish: !!ctx?.meta?.isSpellish
      },
      sourceItem: {
        system: {
          props: {
            skill_type: ctx?.sourceItem?.system?.props?.skill_type ?? null
          }
        }
      }
    };
  };

  async function wait(ms) {
    return await new Promise(resolve => setTimeout(resolve, ms));
  }

  async function resolveUuidDoc(uuid) {
    try {
      if (!uuid || typeof uuid !== "string") return null;
      return await fromUuid(uuid);
    } catch (err) {
      dbg("resolveUuidDoc:failed", { TRACE_ID, uuid, error: err?.message ?? String(err) });
      return null;
    }
  }

  function isTokenUuid(v) {
    return typeof v === "string" && /\.Token\./.test(v);
  }

  function isActorUuid(v) {
    return typeof v === "string" && /^Actor\./.test(v);
  }

  async function resolveTokenDocFromAny(ref, actorRef = null) {
    const directDoc = await resolveUuidDoc(ref);

    if (directDoc?.documentName === "Token" || directDoc?.documentName === "TokenDocument") {
      return directDoc;
    }

    if (directDoc?.documentName === "Actor") {
      try {
        const activeToken =
          directDoc.getActiveTokens?.(true, true)?.[0] ??
          directDoc.getActiveTokens?.()?.[0] ??
          null;
        if (activeToken?.document) return activeToken.document;
      } catch (_) {}

      try {
        const protoDoc = directDoc.token?.document ?? directDoc.prototypeToken ?? null;
        if (protoDoc?.documentName === "Token" || protoDoc?.documentName === "TokenDocument") return protoDoc;
      } catch (_) {}

      return null;
    }

    if (directDoc?.token?.document) return directDoc.token.document;
    if (directDoc?.token?.documentName === "Token" || directDoc?.token?.documentName === "TokenDocument") return directDoc.token;
    if (directDoc?.document?.documentName === "Token" || directDoc?.documentName === "Token") return directDoc.document ?? directDoc;

    const actorDoc = actorRef ? await resolveUuidDoc(actorRef) : null;
    const actor =
      actorDoc?.documentName === "Actor"
        ? actorDoc
        : actorDoc?.actor ?? null;

    if (actor) {
      try {
        const activeToken =
          actor.getActiveTokens?.(true, true)?.[0] ??
          actor.getActiveTokens?.()?.[0] ??
          null;
        if (activeToken?.document) return activeToken.document;
      } catch (_) {}

      try {
        const protoDoc = actor.token?.document ?? actor.prototypeToken ?? null;
        if (protoDoc?.documentName === "Token" || protoDoc?.documentName === "TokenDocument") return protoDoc;
      } catch (_) {}
    }

    return null;
  }

 async function emitReactionPhaseLocalOnGM(payload, traceId = TRACE_ID) {
  dbg("emitReactionPhaseLocalOnGM:begin", {
    traceId,
    isGM: !!game.user?.isGM,
    userId: game.user?.id ?? null,
    userName: game.user?.name ?? null,
    oniPresent: !!globalThis.ONI,
    hasEmitFn: typeof globalThis.ONI?.emit === "function",
    trigger: payload?.trigger ?? null,
    kind: payload?.kind ?? null
  });

  try {
    if (!game.user?.isGM) {
      dbg("emitReactionPhaseLocalOnGM:abort:not-gm", { traceId, payload });
      return false;
    }

    const emit = globalThis.ONI?.emit;
    if (typeof emit !== "function") {
      console.warn(`${RUN_TAG} ONI.emit unavailable; reaction signal skipped`, {
        traceId,
        payload
      });
      return false;
    }

    // Add trace id directly to the emitted payload.
    // This keeps debug visibility without needing a temporary hook + 50ms wait.
    const tracedPayload = {
      ...payload,
      __debugTraceId: traceId
    };

    emit("oni:reactionPhase", tracedPayload, { local: true, world: false });

    console.log(`${RUN_TAG} oni:reactionPhase emitted`, tracedPayload);

    dbg("emitReactionPhaseLocalOnGM:done:no-wait", {
      traceId,
      trigger: tracedPayload?.trigger ?? null,
      kind: tracedPayload?.kind ?? null
    });

    return true;
  } catch (err) {
    console.error(`${RUN_TAG} Failed to emit oni:reactionPhase`, err, {
      traceId,
      payload
    });
    return false;
  }
}

  // 1) Require module + API
  const mod = game.modules.get("fabula-ultima-companion");
  const api = mod?.api;
  if (!mod || !mod.active || !api?.createDamageCard) {
    console.error(`${RUN_TAG} Module not ready.`, { mod, api, TRACE_ID });
    return ui.notifications.error(
      "FabulaUltimaCompanion is missing or outdated. Enable/update the module."
    );
  }

  // 2) Gather payload from your established convention
  const payload = (typeof __PAYLOAD === "object" && __PAYLOAD) ? __PAYLOAD : {};
  dbg("start", {
    TRACE_ID,
    isGM: !!game.user?.isGM,
    userId: game.user?.id ?? null,
    userName: game.user?.name ?? null,
    payloadKeys: Object.keys(payload ?? {}),
    payloadPreview: {
      mode: payload?.mode ?? null,
      attackerUuid: payload?.attackerUuid ?? null,
      targetUuid: payload?.targetUuid ?? null,
      affected: payload?.affected ?? null,
      noEffectReason: payload?.noEffectReason ?? null,
      attackerName: payload?.attackerName ?? null,
      targetName: payload?.targetName ?? null,
      skillName: payload?.skillName ?? null,
      skillTypeRaw: payload?.skillTypeRaw ?? payload?.skill_type ?? null,
      hasActionContext: !!payload?.actionContext,
      elementType: payload?.elementType ?? null,
      finalValue: payload?.finalValue ?? null,
      displayedAmount: payload?.displayedAmount ?? null
    }
  });

  // 2b) ONI Reaction Phase beacons: per-target damage resolution / miss resolution
  try {
    if (game.user?.isGM && globalThis.ONI?.emit) {
      const {
        mode,

        // include attackerUuid so ReactionTriggerCore can resolve "SELF"
        attackerUuid,

        // Optional fallbacks (harmless if undefined)
        attackerActorUuid,
        sourceUuid,
        sourceActorUuid,
        actorUuid,

        attackerName,
        attackRange,
        sourceType,
        targetName,
        targetUuid,
        valueType,
        changeKey,
        elementType,
        weaponType,
        weaponEfficiencyUsed,
        affinityCode,
        effectivenessLabel,
        baseValue,
        finalValue,
        displayedAmount,
        shieldBreak,
        affected,
        noEffectReason,
        gmChanges,
        accuracyTotal,
        defenseUsed,
        skillName,
        skillTypeRaw,
        skill_type,
        isSpellish,
        isSpell,
        actionContext
      } = payload;

      const reactionActionContext = buildReactionActionContext(actionContext);

      const resolvedSkillTypeRaw = nonBlankString(
        skillTypeRaw,
        skill_type,
        actionContext?.core?.skillTypeRaw,
        actionContext?.dataCore?.skillTypeRaw,
        actionContext?.meta?.skillTypeRaw,
        actionContext?.sourceItem?.system?.props?.skill_type
      );
      const resolvedSkillTypeNorm = resolvedSkillTypeRaw.toLowerCase();
      const resolvedIsSpellish = !!(
        isSpellish ||
        isSpell ||
        resolvedSkillTypeNorm === "spell" ||
        actionContext?.dataCore?.isSpell ||
        actionContext?.meta?.isSpellish
      );

      const normalizedMode = String(mode ?? "").trim().toLowerCase();
      const normalizedNoEffectReason = String(noEffectReason ?? "").trim().toLowerCase();
      const isMissCard =
        normalizedMode === "miss" ||
        normalizedNoEffectReason === "miss" ||
        (affected === false && normalizedNoEffectReason === "miss");

      dbg("reaction-branch:decision", {
        TRACE_ID,
        normalizedMode,
        normalizedNoEffectReason,
        affected,
        isMissCard,
        hasTargetUuid: !!targetUuid,
        hasAttackerUuid: !!(attackerUuid ?? sourceUuid),
        hasONIEmit: typeof globalThis.ONI?.emit === "function"
      });

      dbg("reaction-branch:skill-type-resolved", {
        TRACE_ID,
        topLevelSkillTypeRaw: skillTypeRaw ?? null,
        topLevelSkillTypeAlt: skill_type ?? null,
        resolvedSkillTypeRaw: resolvedSkillTypeRaw || null,
        resolvedIsSpellish,
        hasActionContext: !!actionContext,
        reactionActionContext
      });

      const attackerDoc = await resolveUuidDoc(attackerUuid ?? sourceUuid ?? null);
      const attackerActor =
        attackerDoc?.actor ??
        (attackerDoc?.documentName === "Actor" ? attackerDoc : null) ??
        null;

      const attackerTokenDoc = await resolveTokenDocFromAny(
        attackerUuid ?? sourceUuid ?? null,
        attackerActorUuid ?? sourceActorUuid ?? actorUuid ?? attackerActor?.uuid ?? null
      );

      const targetDoc = await resolveUuidDoc(targetUuid ?? null);
      const targetActor =
        targetDoc?.actor ??
        (targetDoc?.documentName === "Actor" ? targetDoc : null) ??
        null;

      const targetTokenDoc = await resolveTokenDocFromAny(
        targetUuid ?? null,
        targetActor?.uuid ?? null
      );

      const subjectTokenUuid =
        attackerTokenDoc?.uuid ??
        attackerTokenDoc?.document?.uuid ??
        (isTokenUuid(attackerUuid) ? attackerUuid : null) ??
        (isTokenUuid(sourceUuid) ? sourceUuid : null) ??
        null;

      const subjectActorUuid =
        attackerActorUuid ??
        sourceActorUuid ??
        actorUuid ??
        (isActorUuid(attackerUuid) ? attackerUuid : null) ??
        (isActorUuid(sourceUuid) ? sourceUuid : null) ??
        attackerActor?.uuid ??
        null;

      const sourceTokenUuid = subjectTokenUuid;

      const targetTokenUuid =
        targetTokenDoc?.uuid ??
        targetTokenDoc?.document?.uuid ??
        (isTokenUuid(targetUuid) ? targetUuid : null) ??
        null;

      const targetActorUuid =
        targetActor?.uuid ??
        (targetDoc?.documentName === "Actor" ? targetDoc.uuid : null) ??
        null;

      dbg("reaction-branch:resolved-context", {
        TRACE_ID,
        attackerDoc: attackerDoc ? {
          documentName: attackerDoc.documentName ?? null,
          uuid: attackerDoc.uuid ?? null,
          name: attackerDoc.name ?? null,
          actorName: attackerDoc.actor?.name ?? null
        } : null,
        attackerActor: attackerActor ? {
          uuid: attackerActor.uuid ?? null,
          name: attackerActor.name ?? null
        } : null,
        attackerTokenDoc: attackerTokenDoc ? {
          documentName: attackerTokenDoc.documentName ?? null,
          uuid: attackerTokenDoc.uuid ?? null,
          name: attackerTokenDoc.name ?? null
        } : null,
        targetDoc: targetDoc ? {
          documentName: targetDoc.documentName ?? null,
          uuid: targetDoc.uuid ?? null,
          name: targetDoc.name ?? null,
          actorName: targetDoc.actor?.name ?? null
        } : null,
        targetActor: targetActor ? {
          uuid: targetActor.uuid ?? null,
          name: targetActor.name ?? null
        } : null,
        targetTokenDoc: targetTokenDoc ? {
          documentName: targetTokenDoc.documentName ?? null,
          uuid: targetTokenDoc.uuid ?? null,
          name: targetTokenDoc.name ?? null
        } : null,
        subjectTokenUuid,
        subjectActorUuid,
        sourceTokenUuid,
        targetTokenUuid,
        targetActorUuid
      });

      const commonPayload = {
        timestamp: Date.now(),
        __debugTraceId: TRACE_ID,
        __debugSource: "CreateDamageCardShim",

        // Subject / source creature
        attackerUuid: subjectTokenUuid,
        attackerActorUuid: attackerActorUuid ?? attackerActor?.uuid ?? null,

        sourceUuid: sourceTokenUuid ?? subjectTokenUuid,
        sourceTokenUuid: sourceTokenUuid ?? subjectTokenUuid,
        sourceActorUuid: sourceActorUuid ?? attackerActor?.uuid ?? null,

        tokenUuid: subjectTokenUuid,
        actorUuid: subjectActorUuid,

        // Explicit subject aliases
        subjectTokenUuid: subjectTokenUuid ?? null,
        subjectActorUuid: subjectActorUuid ?? null,

        // Target context
        targetUuid: targetTokenUuid,
        targetTokenUuid: targetTokenUuid,
        targetActorUuid,
        targets: targetTokenUuid ? [targetTokenUuid] : [],
        targetTokenUuids: targetTokenUuid ? [targetTokenUuid] : [],
        targetActorUuids: targetActorUuid ? [targetActorUuid] : [],

        // Helpful labels / metadata
        attackerName: attackerName ?? attackerActor?.name ?? null,
        targetName: targetName ?? targetDoc?.name ?? targetActor?.name ?? null,
        sourceType: sourceType ?? null,
        attackRange: attackRange ?? null,
        elementType: elementType ?? null,
        weaponType: weaponType ?? null,
        weaponEfficiencyUsed: weaponEfficiencyUsed ?? null,
        affinityCode: affinityCode ?? null,
        effectivenessLabel: effectivenessLabel ?? null,
        valueType: valueType ?? null,
        changeKey: changeKey ?? null,
        skillName: skillName ?? null,
        skillTypeRaw: resolvedSkillTypeRaw || null,
        skill_type: resolvedSkillTypeRaw || null,
        isSpellish: resolvedIsSpellish,
        actionContext: reactionActionContext,

        // Numbers / flags
        baseValue: baseValue ?? null,
        finalValue: finalValue ?? null,
        displayedAmount: displayedAmount ?? null,
        shieldBreak: !!shieldBreak,
        affected: affected ?? null,
        noEffectReason: noEffectReason ?? null,
        gmChanges: gmChanges ?? null,
        accuracyTotal: Number.isFinite(Number(accuracyTotal)) ? Number(accuracyTotal) : null,
        defenseUsed: Number.isFinite(Number(defenseUsed)) ? Number(defenseUsed) : null
      };

      dbg("reaction-branch:common-payload", {
        TRACE_ID,
        commonPayload
      });

      if (isMissCard) {
        const missPayload = {
          ...commonPayload,
          kind: "miss_resolution",
          trigger: "creature_miss_action",
          result: "miss",

          // Extra explicit miss semantics
          missSourceTokenUuid: commonPayload.sourceTokenUuid ?? null,
          missSourceActorUuid: commonPayload.sourceActorUuid ?? null,
          missTargetTokenUuid: commonPayload.targetTokenUuid ?? null,
          missTargetActorUuid: commonPayload.targetActorUuid ?? null
        };

        dbg("reaction-branch:emit-miss:payload", {
          TRACE_ID,
          missPayload
        });

        const emitted = await emitReactionPhaseLocalOnGM(missPayload, `${TRACE_ID}-miss`);
        dbg("reaction-branch:emit-miss:result", {
          TRACE_ID,
          emitted
        });
            } else {
        // Successful hit branch:
        // this card only exists for a resolved non-miss target result,
        // so emit the generic "got hit by an action" trigger once here.
        if (targetTokenUuid) {
          const hitPayload = {
            ...commonPayload,
            kind: "hit_resolution",
            trigger: "creature_hit_by_action",
            result: "hit"
          };

          dbg("reaction-branch:emit-hit:payload", {
            TRACE_ID,
            hitPayload
          });

          const hitEmitted = await emitReactionPhaseLocalOnGM(
            hitPayload,
            `${TRACE_ID}-hit`
          );

          dbg("reaction-branch:emit-hit:result", {
            TRACE_ID,
            hitEmitted
          });
        } else {
          dbg("reaction-branch:emit-hit:skip:no-target", {
            TRACE_ID
          });
        }

        const normalizedChangeKey = String(changeKey ?? "").trim();
        const normalizedValueType = String(valueType ?? "").trim().toLowerCase();

        let resourceType = null;
        let changeKind = null;
        let primaryTrigger = null;
        let emitDealsDamage = false;

        switch (normalizedChangeKey) {
          case "hpReduction":
            resourceType = "hp";
            changeKind = "loss";
            primaryTrigger = "creature_takes_damage";
            emitDealsDamage = true;
            break;
          case "hpRecovery":
            resourceType = "hp";
            changeKind = "gain";
            primaryTrigger = "creature_recovers_hp";
            break;
          case "mpReduction":
            resourceType = "mp";
            changeKind = "loss";
            primaryTrigger = "creature_lose_mp";
            break;
          case "mpRecovery":
            resourceType = "mp";
            changeKind = "gain";
            primaryTrigger = "creature_recovers_mp";
            break;
          default:
            if (normalizedValueType === "hp") {
              resourceType = "hp";
              changeKind = Number(finalValue ?? displayedAmount ?? 0) >= 0 ? "loss" : "gain";
              primaryTrigger = changeKind === "loss" ? "creature_takes_damage" : "creature_recovers_hp";
              emitDealsDamage = changeKind === "loss";
            } else if (normalizedValueType === "mp") {
              resourceType = "mp";
              changeKind = Number(finalValue ?? displayedAmount ?? 0) >= 0 ? "loss" : "gain";
              primaryTrigger = changeKind === "loss" ? "creature_lose_mp" : "creature_recovers_mp";
            }
            break;
        }

        const baseReactionPayload = {
          ...commonPayload,
          kind: resourceType ? "resource_resolution" : "damage_resolution",
          trigger: null,
          resourceType,
          changeKind,
          changeKeyNormalized: normalizedChangeKey || null
        };

        dbg("reaction-branch:emit-resource:payload-base", {
          TRACE_ID,
          normalizedChangeKey,
          normalizedValueType,
          resourceType,
          changeKind,
          primaryTrigger,
          emitDealsDamage,
          baseReactionPayload
        });

        if (emitDealsDamage) {
          const dealsEmitted = await emitReactionPhaseLocalOnGM(
            {
              ...baseReactionPayload,
              trigger: "creature_deals_damage"
            },
            `${TRACE_ID}-deals`
          );

          dbg("reaction-branch:emit-resource:deals-result", {
            TRACE_ID,
            dealsEmitted
          });
        } else {
          dbg("reaction-branch:emit-resource:skip-deals", {
            TRACE_ID,
            normalizedChangeKey,
            normalizedValueType,
            resourceType,
            changeKind
          });
        }

        if (primaryTrigger && targetTokenUuid) {
          const targetEmitted = await emitReactionPhaseLocalOnGM(
            {
              ...baseReactionPayload,
              trigger: primaryTrigger
            },
            `${TRACE_ID}-${primaryTrigger}`
          );

          dbg("reaction-branch:emit-resource:target-result", {
            TRACE_ID,
            primaryTrigger,
            targetEmitted
          });
        } else if (!primaryTrigger) {
          dbg("reaction-branch:emit-resource:skip-target:no-trigger", {
            TRACE_ID,
            normalizedChangeKey,
            normalizedValueType,
            valueType,
            changeKey
          });
        } else {
          dbg("reaction-branch:emit-resource:skip-target:no-target", {
            TRACE_ID,
            primaryTrigger
          });
        }
      }
    } else {
      dbg("reaction-branch:skipped", {
        TRACE_ID,
        isGM: !!game.user?.isGM,
        oniPresent: !!globalThis.ONI,
        hasEmitFn: typeof globalThis.ONI?.emit === "function"
      });
    }
  } catch (err) {
    console.warn(`${RUN_TAG} ReactionPhase emit failed (safe to ignore for now):`, err, payload, { TRACE_ID });
  }

  // 3) Call the module’s implementation
  try {
    dbg("api.createDamageCard:begin", {
      TRACE_ID,
      payloadSummary: {
        mode: payload?.mode ?? null,
        targetUuid: payload?.targetUuid ?? null,
        noEffectReason: payload?.noEffectReason ?? null,
        affected: payload?.affected ?? null,
        finalValue: payload?.finalValue ?? null,
        displayedAmount: payload?.displayedAmount ?? null
      }
    });
    await api.createDamageCard(payload);
    dbg("api.createDamageCard:done", { TRACE_ID });
  } catch (err) {
    console.error(`${RUN_TAG} Failed to create card:`, err, payload, { TRACE_ID });
    ui.notifications.error("Failed to create Damage Card (see console).");
  }
})();
