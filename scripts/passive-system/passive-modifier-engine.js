// Passive Modifier Engine (Foundry V12)
// Updated: .system.props.custom_logic_passive is now treated as a SCRIPT field
// Exposes: FUCompanion.api.passiveModifier.evaluatePassiveModifiers({ actor, actionCtx, finalElement? })
(function () {
  const ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  ROOT.api = ROOT.api || {};

  const TAG = "[ONI][PassiveModifierEngine]";
  const MODULE_ID = "fabula-ultima-companion";
  const DEBUG = true; // <- toggle backend logs here

  function log(...a) {
    if (DEBUG) console.log(TAG, ...a);
  }
  function warn(...a) {
    if (DEBUG) console.warn(TAG, ...a);
  }
  function err(...a) {
    if (DEBUG) console.error(TAG, ...a);
  }

  function toNumber(v, d = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }

  function str(v, d = "") {
    const s = String(v ?? "").trim();
    return s.length ? s : d;
  }

  function lower(v, d = "") {
    return str(v, d).toLowerCase();
  }

  function uniq(arr) {
    return Array.from(new Set((Array.isArray(arr) ? arr : []).filter(Boolean).map(String)));
  }

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

  function getRichTextApi() {
    try {
      return game.modules?.get(MODULE_ID)?.api?.richText ?? null;
    } catch {
      return null;
    }
  }

  function toScript(raw) {
    const s = String(raw ?? "");
    if (!s.trim()) return "";
    const api = getRichTextApi();
    if (!api?.toScript) return s;
    try {
      return String(api.toScript(s) ?? "");
    } catch (e) {
      err("richText.toScript failed; falling back to raw text.", e);
      return s;
    }
  }

  function getItemProps(item) {
    return item?.system?.props ?? item?.system ?? {};
  }

  function resolveDocumentName(doc) {
    return doc?.documentName ?? doc?.constructor?.name ?? null;
  }

  async function resolveDocument(uuidOrDoc) {
    if (!uuidOrDoc) return null;
    if (typeof uuidOrDoc !== "string") return uuidOrDoc;
    try {
      return await fromUuid(uuidOrDoc);
    } catch (e) {
      warn("resolveDocument failed", { uuidOrDoc, error: String(e?.message ?? e) });
      return null;
    }
  }

  function coerceActorFromDoc(doc) {
    if (!doc) return null;
    if (resolveDocumentName(doc) === "Actor") return doc;
    if (doc?.actor) return doc.actor;
    if (doc?.object?.actor) return doc.object.actor;
    if (doc?.token?.actor) return doc.token.actor;
    if (doc?.parent?.actor) return doc.parent.actor;
    if (doc?.document?.actor) return doc.document.actor;
    return null;
  }

  async function resolveActor(uuidOrDoc) {
    const doc = await resolveDocument(uuidOrDoc);
    return coerceActorFromDoc(doc);
  }

  function normalizeWeaponCategory(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    const v = raw.toLowerCase();
    const aliases = {
      arcana: "arcane",
      arcane: "arcane",
      wand: "arcane",
      staff: "arcane",
      tome: "arcane",
      dagger: "dagger",
      knife: "dagger",
      flail: "flail",
      mace: "flail"
    };
    return aliases[v] ?? v;
  }

  function isItemEquipped(item) {
    const props = getItemProps(item);
    const candidates = [
      props?.isEquipped,
      props?.equipped,
      item?.system?.equipped,
      item?.equipped,
      item?.isEquipped
    ];
    return candidates.some(v => v === true || v === "true" || v === 1 || v === "1");
  }

  function getItemTypeNormalized(item) {
    const props = getItemProps(item);
    return lower(
      props?.item_type ??
      item?.system?.item_type ??
      item?.type ??
      ""
    );
  }

  function getItemCategoryNormalized(item) {
    const props = getItemProps(item);
    return normalizeWeaponCategory(
      props?.category ??
      item?.system?.category ??
      item?.category ??
      ""
    );
  }

  function getDispositionFromResolved(doc, actor) {
    const tokenDoc =
      resolveDocumentName(doc) === "Token" || resolveDocumentName(doc) === "TokenDocument"
        ? doc
        : doc?.document ?? doc?.object?.document ?? null;

    const direct =
      tokenDoc?.disposition ??
      tokenDoc?.document?.disposition;

    if (Number.isFinite(Number(direct))) return Number(direct);

    const proto = actor?.prototypeToken?.disposition;
    if (Number.isFinite(Number(proto))) return Number(proto);

    return 0;
  }

  function buildActionTypeDebug(actionCtx = {}) {
    const phase =
      actionCtx?.meta?.reaction_phase_payload ??
      actionCtx?.reaction_phase_payload ??
      {};

    const sourceItem = phase?.actionContext?.sourceItem ?? null;

    const raw = {
      payload_core_skillTypeRaw: actionCtx?.core?.skillTypeRaw ?? null,
      payload_dataCore_skillTypeRaw: actionCtx?.dataCore?.skillTypeRaw ?? null,
      payload_meta_skillTypeRaw: actionCtx?.meta?.skillTypeRaw ?? null,
      payload_meta_sourceType: actionCtx?.meta?.sourceType ?? null,
      payload_source: actionCtx?.source ?? null,
      payload_typeDamage: actionCtx?.core?.typeDamageTxt ?? actionCtx?.dataCore?.typeDamageTxt ?? null,

      phase_skillTypeRaw: phase?.skillTypeRaw ?? null,
      phase_skill_type: phase?.skill_type ?? null,
      phase_sourceType: phase?.sourceType ?? null,
      phase_actionContext_core_skillTypeRaw: phase?.actionContext?.core?.skillTypeRaw ?? null,
      phase_actionContext_sourceType: phase?.actionContext?.sourceType ?? null,
      phase_sourceItem_skill_type: sourceItem?.system?.props?.skill_type ?? null,
      phase_sourceItem_isOffensiveSpell: sourceItem?.system?.props?.isOffensiveSpell ?? null,
      phase_sourceItem_name: sourceItem?.name ?? null
    };

    const normalized = {
      payloadCoreSkillType: lower(raw.payload_core_skillTypeRaw),
      payloadDataCoreSkillType: lower(raw.payload_dataCore_skillTypeRaw),
      payloadMetaSkillType: lower(raw.payload_meta_skillTypeRaw),
      payloadMetaSourceType: lower(raw.payload_meta_sourceType),
      payloadSource: lower(raw.payload_source),

      phaseSkillTypeRaw: lower(raw.phase_skillTypeRaw),
      phaseSkillType: lower(raw.phase_skill_type),
      phaseSourceType: lower(raw.phase_sourceType),
      phaseActionCoreSkillType: lower(raw.phase_actionContext_core_skillTypeRaw),
      phaseActionSourceType: lower(raw.phase_actionContext_sourceType),
      phaseSourceItemSkillType: lower(raw.phase_sourceItem_skill_type),

      payloadTypeDamage: lower(raw.payload_typeDamage)
    };

    const candidates = [
      normalized.payloadCoreSkillType,
      normalized.payloadDataCoreSkillType,
      normalized.payloadMetaSkillType,
      normalized.phaseSkillTypeRaw,
      normalized.phaseSkillType,
      normalized.phaseActionCoreSkillType,
      normalized.phaseSourceItemSkillType,
      normalized.payloadMetaSourceType,
      normalized.phaseSourceType,
      normalized.phaseActionSourceType,
      normalized.payloadSource
    ].filter(Boolean);

    const detectedActionType =
      candidates.find(v => ["attack", "weapon", "skill", "spell", "passive", "item"].includes(v)) ??
      candidates[0] ??
      "";

    const isSpell =
      detectedActionType === "spell" ||
      raw.phase_sourceItem_isOffensiveSpell === true;

    return {
      detectedActionType,
      isSpell,
      candidates,
      raw,
      normalized
    };
  }

  function snapshotPayload(p = {}) {
    return {
      baseValue: String(p?.advPayload?.baseValue ?? "0"),
      bonus: Number(p?.advPayload?.bonus ?? 0) || 0,
      reduction: Number(p?.advPayload?.reduction ?? 0) || 0,
      multiplier: Number(p?.advPayload?.multiplier ?? 100) || 100,
      accuracyBonus: Number(p?.accuracy?.bonus ?? 0) || 0,
      targetsCount: Array.isArray(p?.targets) ? p.targets.length : 0,
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
      targetsCount: `${before.targetsCount} -> ${after.targetsCount}`,
      abort: `${before.abort} -> ${after.abort}`,
      abortReason: `${before.abortReason} -> ${after.abortReason}`
    };
  }

  async function evaluatePassiveModifiers({ actor, actionCtx, finalElement = null } = {}) {
    const runId = `PM-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    const out = {
      ok: true,
      runId,

      // kept for compatibility with current PassiveModifierApply
      flatByElement: {},
      pctByElement: {},
      critFlat: 0,
      critMult: 1,
      options: { recalcOnConfirm: "never" },

      // new script-oriented debug/result surface
      ranScripts: [],
      skippedScripts: [],
      errors: [],
      breakdown: []
    };

    if (!actor) {
      warn(runId, "No actor provided.");
      out.ok = false;
      out.errors.push({ scope: "engine", reason: "no_actor" });
      return out;
    }

    if (!actionCtx || typeof actionCtx !== "object") {
      warn(runId, "No actionCtx provided.");
      out.ok = false;
      out.errors.push({ scope: "engine", reason: "no_actionCtx" });
      return out;
    }

    actionCtx.meta = actionCtx.meta || {};
    actionCtx.advPayload = actionCtx.advPayload || {};

    const targetUuids = uniq(actionCtx?.targets ?? []);
    const actionTypeDebug = buildActionTypeDebug(actionCtx);

    log(runId, "START", {
      actor: actor?.name ?? null,
      actorUuid: actor?.uuid ?? null,
      skillName: actionCtx?.core?.skillName ?? actionCtx?.dataCore?.skillName ?? null,
      targetsCount: targetUuids.length,
      finalElement,
      detectedActionType: actionTypeDebug.detectedActionType,
      isSpell: actionTypeDebug.isSpell
    });

    const items = Array.from(actor.items ?? []);
    for (const item of items) {
      const rawPassive = getItemProps(item)?.custom_logic_passive ?? "";
      const scriptText = toScript(rawPassive).trim();

      if (!scriptText) continue;

      const itemRunId = `${runId}:${item.id ?? item.name ?? "item"}`;
      const before = snapshotPayload(actionCtx);

      let itemSkipped = false;
      let itemSkipReason = "";
      let itemCancelled = false;

      const context = {
        runId: itemRunId,
        phase: "passive",
        finalElement,

        actorUuid: actor?.uuid ?? null,
        actorName: actor?.name ?? null,
        passiveOwner: actor,
        passiveItem: item,

        skillName: actionCtx?.core?.skillName ?? actionCtx?.dataCore?.skillName ?? null,
        listType: actionCtx?.meta?.listType ?? null,
        executionMode: actionCtx?.meta?.executionMode ?? null,
        isPassiveExecution: (
          actionCtx?.meta?.executionMode === "autoPassive" ||
          actionCtx?.meta?.isPassiveExecution === true ||
          actionCtx?.source === "AutoPassive"
        ),

        actionTypeDebug,

        log: (...a) => log(itemRunId, "[SNIPPET]", ...a),
        warn: (...a) => warn(itemRunId, "[SNIPPET]", ...a),
        error: (...a) => err(itemRunId, "[SNIPPET]", ...a),

        skipPassive: (reason = "", { notify = false } = {}) => {
          itemSkipped = true;
          itemSkipReason = String(reason ?? "");
          if (notify && itemSkipReason) ui.notifications?.warn?.(itemSkipReason);
          log(itemRunId, "SKIP PASSIVE", { item: item.name, reason: itemSkipReason, notify });
          return { skipped: true, reason: itemSkipReason };
        },

        cancelPipeline: (reason = "Passive cancelled the action.", { notify = true } = {}) => {
          itemCancelled = true;
          actionCtx.meta.__abortPipeline = true;
          actionCtx.meta.__abortReason = String(reason ?? "Passive cancelled the action.");
          actionCtx.meta.__abortNotify = !!notify;
          if (notify) ui.notifications?.warn?.(actionCtx.meta.__abortReason);
          warn(itemRunId, "PIPELINE CANCELLED", {
            item: item.name,
            reason: actionCtx.meta.__abortReason,
            notify
          });
          return { cancelled: true, reason: actionCtx.meta.__abortReason };
        },

        helpers: {
          normalizeWeaponCategory,
          isItemEquipped,
          getItemTypeNormalized,
          getItemCategoryNormalized,

          getActionTypeDebug: () => clone(actionTypeDebug, {}),
          getDetectedActionType: () => actionTypeDebug.detectedActionType,

          getPassiveOwnerActor: async () => actor,
          getPassiveItem: () => item,

          getAttackerActor: async () => {
            const attackerUuid =
              actionCtx?.meta?.attackerUuid ??
              actionCtx?.attackerActorUuid ??
              actionCtx?.attackerUuid ??
              null;
            return await resolveActor(attackerUuid);
          },

          getEquippedItems: async ({ actor: actorOverride = null, itemTypes = null } = {}) => {
            const useActor = actorOverride ? await resolveActor(actorOverride) : actor;
            const allItems = Array.from(useActor?.items ?? []);
            let equipped = allItems.filter(isItemEquipped);

            if (Array.isArray(itemTypes) && itemTypes.length) {
              const wanted = itemTypes.map(lower);
              equipped = equipped.filter(it => wanted.includes(getItemTypeNormalized(it)));
            }

            return equipped;
          },

          getEquippedWeapons: async ({ actor: actorOverride = null } = {}) => {
            return await context.helpers.getEquippedItems({
              actor: actorOverride,
              itemTypes: ["weapon"]
            });
          },

          getEquippedWeaponCategories: async ({ actor: actorOverride = null } = {}) => {
            const weapons = await context.helpers.getEquippedWeapons({ actor: actorOverride });
            return uniq(weapons.map(getItemCategoryNormalized));
          },

          hasEquippedWeaponCategory: async (wantedCategories = [], { actor: actorOverride = null } = {}) => {
            const wanted = uniq(wantedCategories.map(normalizeWeaponCategory));
            if (!wanted.length) return false;
            const equippedCats = await context.helpers.getEquippedWeaponCategories({ actor: actorOverride });
            return equippedCats.some(cat => wanted.includes(cat));
          },

          debugEquipmentSnapshot: async ({ actor: actorOverride = null } = {}) => {
            const useActor = actorOverride ? await resolveActor(actorOverride) : actor;
            const equipped = await context.helpers.getEquippedItems({ actor: useActor });
            return {
              actorName: useActor?.name ?? null,
              actorUuid: useActor?.uuid ?? null,
              equipped: equipped.map(it => ({
                name: it?.name ?? null,
                itemType: getItemTypeNormalized(it),
                category: getItemCategoryNormalized(it)
              }))
            };
          },

          getTargetUuids: () => uniq(actionCtx?.targets ?? []),

          getTargetDocs: async () => {
            const docs = [];
            for (const uuid of uniq(actionCtx?.targets ?? [])) {
              const doc = await resolveDocument(uuid);
              if (doc) docs.push(doc);
            }
            return docs;
          },

          getTargetActors: async () => {
            const docs = await context.helpers.getTargetDocs();
            const actors = [];
            for (const doc of docs) {
              const a = coerceActorFromDoc(doc);
              if (a) actors.push(a);
            }
            return actors;
          },

          getFirstTargetDoc: async () => {
            const uuid = uniq(actionCtx?.targets ?? [])[0] ?? null;
            return uuid ? await resolveDocument(uuid) : null;
          },

          getFirstTargetActor: async () => {
            const doc = await context.helpers.getFirstTargetDoc();
            return coerceActorFromDoc(doc);
          },

          getDisposition: async (uuidOrDoc) => {
            const doc = await resolveDocument(uuidOrDoc);
            const a = coerceActorFromDoc(doc);
            return getDispositionFromResolved(doc, a);
          },

          targetHasEffect: async (uuidOrDoc, effectName) => {
            const targetActor = await resolveActor(uuidOrDoc);
            if (!targetActor) return false;
            return !!targetActor.effects.find(e => String(e?.name ?? "") === String(effectName ?? ""));
          },

          findTargetEffect: async (uuidOrDoc, effectName) => {
            const targetActor = await resolveActor(uuidOrDoc);
            if (!targetActor) return null;
            return targetActor.effects.find(e => String(e?.name ?? "") === String(effectName ?? "")) ?? null;
          },

          getSkillLevelOnOwner: (skillName) => {
            const wanted = String(skillName ?? "").trim();
            if (!wanted) return 0;
            const owned = actor.items.find(i => String(i?.name ?? "") === wanted);
            return Math.max(0, parseInt(owned?.system?.props?.level ?? "0", 10) || 0);
          },

          addFlatBonus: (amount) => {
            const n = toNumber(amount, 0);
            actionCtx.advPayload.bonus = Number(actionCtx.advPayload.bonus ?? 0) + n;
            return actionCtx.advPayload.bonus;
          },

          addPercentMultiplierDec: (amount) => {
            const n = toNumber(amount, 0);
            const curDec = Number(actionCtx.advPayload.multiplier ?? 100) / 100;
            const nextDec = Math.max(0, curDec + n);
            actionCtx.advPayload.multiplier = Math.round(nextDec * 100);
            return nextDec;
          },

          addAccuracyBonus: (amount) => {
            const n = toNumber(amount, 0);
            actionCtx.accuracy = actionCtx.accuracy || {};
            actionCtx.accuracy.bonus = Number(actionCtx.accuracy.bonus ?? 0) + n;
            return actionCtx.accuracy.bonus;
          }
        }
      };

      const prevPAYLOAD = globalThis.__PAYLOAD;
      const prevTARGETS = globalThis.__TARGETS;
      const prevPASSIVEITEM = globalThis.__PASSIVE_ITEM;
      const prevPASSIVEACTOR = globalThis.__PASSIVE_ACTOR;

      globalThis.__PAYLOAD = actionCtx;
      globalThis.__TARGETS = [...targetUuids];
      globalThis.__PASSIVE_ITEM = item;
      globalThis.__PASSIVE_ACTOR = actor;

      try {
        log(itemRunId, "RUN SCRIPT", {
          item: item.name,
          itemId: item.id ?? null,
          scriptLen: scriptText.length,
          skillName: context.skillName,
          targetsCount: targetUuids.length,
          preview: scriptText.slice(0, 160)
        });

        const wrapped = `return (async () => {\n${scriptText}\n})();`;
        const fn = new Function("payload", "targets", "context", "item", "actor", "actionCtx", wrapped);

        const result = fn(actionCtx, [...targetUuids], context, item, actor, actionCtx);
        if (result && typeof result.then === "function") {
          await result;
        }

        const after = snapshotPayload(actionCtx);
        const diff = diffSnapshots(before, after);

        if (itemSkipped) {
          out.skippedScripts.push({
            itemId: item.id ?? null,
            itemName: item.name ?? "",
            reason: itemSkipReason,
            diff
          });

          log(itemRunId, "SCRIPT SKIPPED", {
            item: item.name,
            reason: itemSkipReason,
            diff
          });
        } else {
          out.ranScripts.push({
            itemId: item.id ?? null,
            itemName: item.name ?? "",
            cancelled: itemCancelled,
            diff
          });

          out.breakdown.push({
            source: item.name ?? item.id ?? "Passive Script",
            type: "script",
            diff
          });

          log(itemRunId, "SCRIPT DONE", {
            item: item.name,
            cancelled: itemCancelled,
            diff
          });
        }

        if (actionCtx?.meta?.__abortPipeline) {
          warn(itemRunId, "ABORT FLAG DETECTED. Stopping further passive scripts.", {
            abortReason: actionCtx?.meta?.__abortReason ?? null
          });
          break;
        }
      } catch (e) {
        const errorInfo = {
          itemId: item.id ?? null,
          itemName: item.name ?? "",
          message: String(e?.message ?? e),
          stack: String(e?.stack ?? "")
        };

        out.ok = false;
        out.errors.push(errorInfo);
        err(itemRunId, "SCRIPT ERROR", errorInfo);
      } finally {
        globalThis.__PAYLOAD = prevPAYLOAD;
        globalThis.__TARGETS = prevTARGETS;
        globalThis.__PASSIVE_ITEM = prevPASSIVEITEM;
        globalThis.__PASSIVE_ACTOR = prevPASSIVEACTOR;
      }
    }

    log(runId, "END", {
      actor: actor?.name ?? null,
      ranScripts: out.ranScripts.length,
      skippedScripts: out.skippedScripts.length,
      errors: out.errors.length,
      abort: !!actionCtx?.meta?.__abortPipeline,
      abortReason: actionCtx?.meta?.__abortReason ?? null
    });

    return out;
  }

  ROOT.api.passiveModifier = {
    evaluatePassiveModifiers
  };

  log("Installed/Updated");
})();
