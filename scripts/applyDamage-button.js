// scripts/applyDamage-button.js — Foundry VTT v12
// Confirm (owner or GM) → commits the action: spend resources, resolve hit/miss,
// apply Active Effects, run AdvanceDamage / Miss, consume items, etc.
//
// • Button: [data-fu-confirm] (shown only to action owner or GM; fu-card-hydrate enforces per-client visibility)
// • Players: click Confirm → request GM to resolve via module socket (module.fabula-ultima-companion)
// • GM: click Confirm OR receives socket request → resolves immediately on GM client
//
// Notes:
// - This REPLACES the old Apply(GM) logic entirely.
// - UPDATE (2026-02-09): Supports animation for NO-DAMAGE actions by calling ActionAnimationHandler
//   with animationPurpose="vfx_only" when hasDamageSection === false.

const MODULE_ID = "fu-chatbtn";
const MODULE_NS = "fabula-ultima-companion";
const SOCKET_NS = "module.fabula-ultima-companion";

Hooks.once("ready", async () => {
  const root = document.querySelector("#chat-log") || document.body;
  if (!root) return;

  // Prevent double-binding on this client
  if (root.__fuChatBtnBound) return;
  root.__fuChatBtnBound = true;

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------
  const numberish = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

  function readDefenseLike(props, preferMagic=false) {
    const p = props ?? {};
    const hard = preferMagic
      ? ["magic_defense", "current_mdef", "mdef"]
      : ["defense",       "current_def",  "def"];

    for (const k of hard) {
      const n = numberish(p[k]); if (n !== null) return n;
    }

    const isBanned = (k) => /(^|_)mod($|_)/i.test(k);
    const keys = Object.keys(p);

    const rePhys = /(^|_)(current_)?(def|guard|armor)($|_)/i;
    const reMag  = /(^|_)(current_)?(m(def|agic.*def)|magic.*resist|spirit)($|_)/i;
    const rx = preferMagic ? reMag : rePhys;

    for (const k of keys) {
      if (isBanned(k)) continue;
      const n = numberish(p[k]); if (n === null) continue;
      if (rx.test(k)) return n;
    }
    return 0;
  }

  async function defenseForUuid(uuid, useMagic) {
    try {
      const d = await fromUuid(uuid);
      const a = d?.actor ?? (d?.type === "Actor" ? d : null);
      const props = a?.system?.props ?? a?.system ?? {};
      return readDefenseLike(props, useMagic);
    } catch { return 0; }
  }

  async function resolveAttackerActor(attackerUuid) {
    const doc = await fromUuid(attackerUuid).catch(()=>null);
    return (
      doc?.actor ??
      (doc?.documentName === "Actor" ? doc : null) ??
      (doc?.documentName === "Token" ? doc.actor : null) ??
      (doc?.documentName === "TokenDocument" ? doc.actor : null)
    );
  }

  async function spendResourcesOnConfirm(flaggedPayload) {
    try {
      const meta = flaggedPayload?.meta ?? null;
      const costs = meta?.costsNormalized;
      const attackerUuid = meta?.attackerUuid;
      if (!attackerUuid || !Array.isArray(costs) || !costs.length) return true;

      const actor = await resolveAttackerActor(attackerUuid);
      if (!actor) {
        ui.notifications?.error("Confirm: cannot resolve attacker to spend resource.");
        return false;
      }

      const patch = {};
      for (const c of costs) {
        const curPath = `system.props.${c.curKey}`;
        const curVal  = Number(getProperty(actor, curPath) ?? 0) || 0;
        const next    = Math.max(0, curVal - Number(c.req || 0));
        patch[curPath] = next;
      }
      if (Object.keys(patch).length) await actor.update(patch);
      return true;
    } catch (e) {
      console.error("[fu-chatbtn] Spend failed:", e);
      ui.notifications?.error("Confirm: resource spend failed (see console).");
      return false;
    }
  }

  async function consumeItemOnConfirm(attackerUuid, itemUsage) {
    if (!attackerUuid || !itemUsage?.itemUuid) return;

    try {
      const actor = await resolveAttackerActor(attackerUuid);
      if (!actor) return;

      let item = null;
      if (itemUsage.itemId && actor.items.has(itemUsage.itemId)) item = actor.items.get(itemUsage.itemId);
      if (!item && itemUsage.itemUuid) item = actor.items.find(i => i.uuid === itemUsage.itemUuid);
      if (!item) return;

      const props    = item.system?.props ?? {};
      const isUnique = !!props.isUnique;
      if (isUnique) return;

      let currentQty = Number(props.item_quantity ?? 0);
      if (!Number.isFinite(currentQty)) currentQty = 0;
      if (currentQty <= 0) return;

      const newQty = currentQty - 1;
      if (newQty > 0) {
        await item.update({ "system.props.item_quantity": newQty });
      } else {
        await actor.deleteEmbeddedDocuments("Item", [item.id]);
      }
    } catch (err) {
      console.error("[fu-chatbtn] consumeItemOnConfirm error", err);
      ui.notifications?.warn("Item consumption failed — see console for details.");
    }
  }

  const CONFIRM_DEBUG_NS = "[fu-chatbtn][Confirm][DBG]";
  const REACTION_EMIT_DEBUG_WAIT_MS = 50;

  function dbg(step, data = undefined) {
    try {
      if (data === undefined) console.log(`${CONFIRM_DEBUG_NS} ${step}`);
      else console.log(`${CONFIRM_DEBUG_NS} ${step}`, data);
    } catch {}
  }

  async function describeUuid(uuid) {
    if (!uuid || typeof uuid !== "string") {
      return { uuid: uuid ?? null, ok: false, reason: "empty" };
    }

    try {
      const doc = await fromUuid(uuid).catch(() => null);
      if (!doc) {
        return { uuid, ok: false, reason: "fromUuid-null" };
      }

      const actor =
        doc?.actor ??
        (doc?.documentName === "Actor" ? doc : null) ??
        null;

      return {
        uuid,
        ok: true,
        documentName: doc?.documentName ?? null,
        id: doc?.id ?? null,
        name: doc?.name ?? doc?.actor?.name ?? null,
        actorUuid: actor?.uuid ?? null,
        actorName: actor?.name ?? null,
        tokenId: doc?.id ?? doc?.document?.id ?? null,
        sceneId: doc?.parent?.id ?? doc?.scene?.id ?? null
      };
    } catch (err) {
      return {
        uuid,
        ok: false,
        reason: "exception",
        error: err?.message ?? String(err)
      };
    }
  }

  function emitReactionPhaseLocalOnGM(payload) {
    const traceId = payload?.__debugTraceId ?? `MISS-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    if (payload && !payload.__debugTraceId) payload.__debugTraceId = traceId;

    dbg("emitReactionPhaseLocalOnGM:begin", {
      traceId,
      isGM: !!game.user?.isGM,
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null,
      oniPresent: !!window.ONI,
      oniEmitType: typeof window.ONI?.emit,
      trigger: payload?.trigger ?? null,
      payload
    });

    try {
      if (!game.user?.isGM) {
        dbg("emitReactionPhaseLocalOnGM:abort:not-gm", { traceId });
        return false;
      }

      const emit = window.ONI?.emit;
      if (typeof emit !== "function") {
        console.warn("[fu-chatbtn][Confirm] ONI.emit unavailable; reaction signal skipped", payload);
        dbg("emitReactionPhaseLocalOnGM:abort:no-emit-function", {
          traceId,
          oniKeys: Object.keys(window.ONI ?? {})
        });
        return false;
      }

      let observedSync = false;
      let observedAsync = false;
      const hookId = Hooks.on("oni:reactionPhase", (observedPayload) => {
        const matchesTrace =
          observedPayload?.__debugTraceId &&
          observedPayload.__debugTraceId === traceId;

        if (!matchesTrace) return;

        observedAsync = true;
        dbg("emitReactionPhaseLocalOnGM:hook-observed", {
          traceId,
          observedPayload
        });
        try { Hooks.off("oni:reactionPhase", hookId); } catch {}
      });

      emit("oni:reactionPhase", payload, { local: true, world: false });
      observedSync = observedAsync;

      console.log("[fu-chatbtn][Confirm] oni:reactionPhase emitted", payload);
      dbg("emitReactionPhaseLocalOnGM:after-emit", {
        traceId,
        observedSync,
        observedAsync
      });

      setTimeout(() => {
        dbg("emitReactionPhaseLocalOnGM:post-wait", {
          traceId,
          waitMs: REACTION_EMIT_DEBUG_WAIT_MS,
          observedSync,
          observedAsync
        });
        if (!observedAsync) {
          console.warn(`${CONFIRM_DEBUG_NS} emit did not loop back through Hooks.on('oni:reactionPhase') within wait window`, {
            traceId,
            waitMs: REACTION_EMIT_DEBUG_WAIT_MS,
            payload
          });
        }
        try { Hooks.off("oni:reactionPhase", hookId); } catch {}
      }, REACTION_EMIT_DEBUG_WAIT_MS);

      return true;
    } catch (err) {
      console.error("[fu-chatbtn][Confirm] Failed to emit oni:reactionPhase", err, payload);
      dbg("emitReactionPhaseLocalOnGM:error", {
        traceId,
        error: err?.message ?? String(err),
        stack: err?.stack ?? null
      });
      return false;
    }
  }

  async function emitMissReactionSignal({
    flagged,
    attackerUuid,
    attackerName,
    missUUIDs,
    elementType,
    isSpellish,
    weaponType,
    attackRange,
    accuracyTotal
  } = {}) {
    const traceId = `MISS-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    dbg("emitMissReactionSignal:begin", {
      traceId,
      isGM: !!game.user?.isGM,
      attackerUuid,
      attackerName,
      missUUIDs,
      elementType,
      isSpellish: !!isSpellish,
      weaponType,
      attackRange,
      accuracyTotal,
      hasFlagged: !!flagged
    });

    if (!game.user?.isGM) {
      dbg("emitMissReactionSignal:abort:not-gm", { traceId });
      return false;
    }

    const missTargets = Array.isArray(missUUIDs) ? missUUIDs.filter(Boolean) : [];
    if (!missTargets.length) {
      dbg("emitMissReactionSignal:abort:no-miss-targets", { traceId, missUUIDs });
      return false;
    }

    const core = flagged?.core ?? {};
    const meta = flagged?.meta ?? {};
    const adv  = flagged?.advPayload ?? {};

    const attackerActor = attackerUuid
      ? await resolveAttackerActor(attackerUuid).catch((err) => {
          dbg("emitMissReactionSignal:resolveAttackerActor:error", {
            traceId,
            attackerUuid,
            error: err?.message ?? String(err)
          });
          return null;
        })
      : null;

    const firstMissUuid = missTargets[0] ?? null;
    const firstMissDoc = firstMissUuid
      ? await fromUuid(firstMissUuid).catch((err) => {
          dbg("emitMissReactionSignal:firstMissDoc:error", {
            traceId,
            firstMissUuid,
            error: err?.message ?? String(err)
          });
          return null;
        })
      : null;

    const firstMissActor =
      firstMissDoc?.actor ??
      (firstMissDoc?.documentName === "Actor" ? firstMissDoc : null) ??
      null;

    const missTargetDetails = await Promise.all(missTargets.map(describeUuid));
    const attackerDetails = await describeUuid(attackerUuid ?? meta.attackerUuid ?? null);

    const payload = {
      kind: "action_resolution",
      source: "applyDamage-button",
      trigger: "creature_miss_action",
      timestamp: Date.now(),
      __debugTraceId: traceId,

      attackerUuid: attackerUuid ?? meta.attackerUuid ?? null,
      attackerActorUuid: attackerActor?.uuid ?? null,
      attackerName: attackerName ?? meta.attackerName ?? null,

      tokenUuid: attackerUuid ?? meta.attackerUuid ?? null,
      actorUuid: attackerActor?.uuid ?? null,

      targetUuid: firstMissUuid,
      targetActorUuid: firstMissActor?.uuid ?? null,
      targets: missTargets,

      skillName: String(core.skillName ?? meta.skillName ?? "").trim() || null,
      skillTypeRaw: String(core.skillTypeRaw ?? "").trim().toLowerCase() || null,
      sourceType: String(adv.sourceType ?? "").trim().toLowerCase() || null,

      elementType: String(elementType ?? "physical").toLowerCase(),
      isSpellish: !!isSpellish,
      weaponType: String(weaponType ?? ""),
      attackRange: String(attackRange ?? ""),
      accuracyTotal: Number.isFinite(Number(accuracyTotal)) ? Number(accuracyTotal) : null,
    };

    dbg("emitMissReactionSignal:resolved-context", {
      traceId,
      attackerDetails,
      attackerActorUuid: attackerActor?.uuid ?? null,
      attackerActorName: attackerActor?.name ?? null,
      firstMissUuid,
      firstMissDocName: firstMissDoc?.name ?? null,
      firstMissDocType: firstMissDoc?.documentName ?? null,
      firstMissActorUuid: firstMissActor?.uuid ?? null,
      firstMissActorName: firstMissActor?.name ?? null,
      missTargetDetails
    });

    dbg("emitMissReactionSignal:payload", { traceId, payload });

    const emitted = emitReactionPhaseLocalOnGM(payload);

    dbg("emitMissReactionSignal:result", {
      traceId,
      emitted
    });

    return emitted;
  }

  function lockButton(btn, text="Confirming…") {
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = text;
    btn.style.filter = "grayscale(.25)";
    btn.dataset.fuLock = "1";
  }
  function unlockButton(btn, text="✅ Confirm") {
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = text;
    btn.style.filter = "";
    btn.dataset.fuLock = "0";
  }

  // ------------------------------------------------------------
  // Core resolver (GM only)
  // ------------------------------------------------------------
  async function runConfirm(chatMsg, args = {}, confirmingUserId = null) {
    const RUN_TAG = "[fu-chatbtn][Confirm]";
    const runId = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    const msgEl =
      document.querySelector(`#chat-log .message[data-message-id="${chatMsg.id}"]`) ||
      document.querySelector(`.chat-popout .message[data-message-id="${chatMsg.id}"]`) ||
      null;

    const btn = msgEl?.querySelector?.("[data-fu-confirm]") ?? null;

    // double-click guard
    if (btn?.dataset?.fuLock === "1") return;
    if (btn) lockButton(btn, "Confirming…");

    console.groupCollapsed(`${RUN_TAG} START runId=${runId} msgId=${chatMsg.id}`);
    console.log(`${RUN_TAG} meta`, {
      runId,
      msgId: chatMsg.id,
      confirmingUserId,
      gm: !!game.user?.isGM,
      argsKeys: Object.keys(args || {})
    });

    try {
      const flagged = chatMsg.getFlag(MODULE_NS, "actionCard")?.payload ?? null;

      console.log(`${RUN_TAG} flagged payload`, {
        hasFlagged: !!flagged,
        hasMeta: !!flagged?.meta,
        hasCore: !!flagged?.core
      });

      // Prevent double-confirm (server-side-ish)
      const already = await chatMsg.getFlag(MODULE_NS, "actionApplied");
      if (already) {
        console.warn(`${RUN_TAG} already applied, abort`, already);
        return;
      }

      // Backfill args from flag payload when needed
      if (flagged) {
        if (!args.attackerUuid && flagged.meta?.attackerUuid) args.attackerUuid = flagged.meta.attackerUuid;
        if ((!args.aeDirectives || !args.aeDirectives.length) && Array.isArray(flagged.meta?.activeEffects)) {
          args.aeDirectives = flagged.meta.activeEffects;
        }
        if (typeof args.hasDamageSection !== "boolean" && flagged.meta?.hasDamageSection !== undefined) {
          args.hasDamageSection = !!flagged.meta.hasDamageSection;
        }
      }

// ------------------------------------------------------------
// Custom Logic — Resolution Phase (GM-side confirm)
// ------------------------------------------------------------
const clResMacroName = "CustomLogic-Resolution";

// We treat blank as "no custom logic"
const clResRaw = String(flagged?.customLogicResolutionRaw ?? flagged?.meta?.customLogicResolutionRaw ?? "").trim();
const hasCLRes = !!clResRaw;

console.log(`${RUN_TAG} custom logic (resolution)`, {
  runId,
  hasCLRes,
  clResLen: clResRaw.length,
  clResPreview: clResRaw.slice(0, 140)
});

if (hasCLRes) {
  const cl = game.macros.getName(clResMacroName);
  if (!cl) {
    console.warn(`${RUN_TAG} CustomLogic-Resolution macro missing`, { runId, clResMacroName });
  } else {
    // IMPORTANT:
    // - Pass the SAME payload object so the snippet can mutate it (advPayload, targets, meta, etc.)
    // - Also pass the "args" in case you want snippet to read them later (optional convenience)
    flagged.__confirmArgs = args;

    console.log(`${RUN_TAG} Calling CustomLogic-Resolution`, { runId, clResMacroName });
    await cl.execute({ __AUTO: true, __PAYLOAD: flagged });
    console.log(`${RUN_TAG} Returned from CustomLogic-Resolution`, {
      runId,
      metaMarks: flagged?.meta?.__customLogicResolution?.lastRun ?? null,
      err: flagged?.meta?.__customLogicResolution?.error ?? null
    });
  }
}

      const {
        advMacroName     = "AdvanceDamage",
        missMacroName    = "Miss",
        advPayload       = (flagged?.advPayload ?? {}),
        elementType      = "physical",
        isSpellish       = false,

        hasAccuracy      = true,
        accuracyTotal    = null,

        weaponType       = "",
        attackRange      = "Melee",
        attackerName     = "Unknown",
        aeMacroName      = "ApplyActiveEffect",
        aeDirectives     = [],
        attackerUuid     = null,
        originalTargetUUIDs = [],
        chatMsgId        = chatMsg.id,

        // NEW (optional): animation macro name
        animMacroName    = "ActionAnimationHandler",
      } = args;

      const itemUsage = flagged?.itemUsage ?? flagged?.meta?.itemUsage ?? null;

      const hasDamageSection =
        (typeof args.hasDamageSection === "boolean") ? args.hasDamageSection :
        (flagged?.meta?.hasDamageSection !== undefined) ? !!flagged.meta.hasDamageSection :
        true;

      console.log(`${RUN_TAG} core args`, {
        runId,
        attackerUuid,
        attackerName,
        elementType,
        isSpellish: !!isSpellish,
        hasAccuracy: !!hasAccuracy,
        accuracyTotal,
        weaponType,
        attackRange,
        hasDamageSection,
        advMacroName,
        missMacroName,
        aeMacroName,
        animMacroName,
        originalTargetUUIDsCount: Array.isArray(originalTargetUUIDs) ? originalTargetUUIDs.length : 0
      });

      // Spend resources now (commit point). If fail, stop.
      const okToProceed = await spendResourcesOnConfirm(flagged ? flagged : null);
      console.log(`${RUN_TAG} spendResourcesOnConfirm`, { runId, okToProceed });
      if (!okToProceed) return;

      // Consume item only after resource spend succeeds
      if (itemUsage && attackerUuid) {
        console.log(`${RUN_TAG} consumeItemOnConfirm begin`, { runId, itemUsage });
        await consumeItemOnConfirm(attackerUuid, itemUsage);
      }

      // NAMECARD TRIGGER — show only for Skill / Spell / Passive
      try {
        const payload = flagged || null;
        const core  = payload?.core || {};
        const meta  = payload?.meta || {};

        const listType      = String(meta.listType || "").trim();
        const skillTypeRaw  = String(core.skillTypeRaw || "").trim().toLowerCase();
        const sourceTypeRaw = String(advPayload?.sourceType || "").trim().toLowerCase();

        const isAttackish = (listType === "Attack") || (sourceTypeRaw === "weapon");
        const isSpellish2 = !!meta.isSpellish;
        const isActive    = (listType === "Active");
        const isPassive   = (skillTypeRaw === "passive");

        const shouldShow = !isAttackish && (isSpellish2 || isActive || isPassive);
        if (shouldShow) {
          const title = String(core.skillName || "—");

          let actionType = "skill";
          if (isSpellish2 && (listType === "Offensive Spell")) actionType = "offensiveSpell";
          else if (isSpellish2) actionType = "spell";
          else if (isPassive)   actionType = "passive";

          let disp = 0;
          try {
            const aUuid = attackerUuid || meta.attackerUuid || null;
            if (aUuid) {
              const doc = await fromUuid(aUuid);
              const tok = (doc?.documentName === "Token") ? doc : (doc?.token ?? null);
              disp = Number(tok?.disposition ?? 0);
            }
          } catch {}

          const THEMES = {
            hostile: { bg: "#000000", accent: "#ff5a5a", text: ["#ffffff","#ffd6d6"], glowColor: "#ffffff" },
            friendly:{ bg: "#000000", accent: "#7fb5ff", text: ["#ffffff","#d7e9ff"], glowColor: "#ffffff" },
            neutral: { bg: "#000000", accent: "#ffd866", text: ["#ffffff","#fff1b3"], glowColor: "#ffffff" },
            secret:  { bg: "#000000", accent: "#a0a4a8", text: ["#ffffff","#e5e7ea"], glowColor: "#ffffff" }
          };

          const d = Number.isFinite(disp) ? Math.trunc(Number(disp)) : 0;
          const theme =
            (d === -2) ? THEMES.secret  :
            (d === -1) ? THEMES.hostile :
            (d ===  1) ? THEMES.friendly:
            THEMES.neutral;

          const options = {
            actionType,
            bg: theme.bg,
            accent: theme.accent,
            text: theme.text,
            glowColor: theme.glowColor,
            border: "rgba(255,255,255,.10)",
            dropShadow: "0 10px 22px rgba(0,0,0,.35)",
            maskEdges: true,
            edgeFade: 0.12,

            xAlign: "center",
            offsetX: 0,
            offsetY: 100,
            fixedWidth: 640,
            autoWidth: false,
            cardScale: 0.20,

            inMs: 350,
            holdMs: 1500,
            outMs: 400,
            enterFrom: "left",

            maxFontPx: 28,
            minFontPx: 16,
            letterSpacing: 0.06,
            fontWeight: 0,
            upperCase: false,
            fontFamily: "Pixel Operator, system-ui, sans-serif",
            textShadowStrength: 0.0,
            textStrokePx: 0.1,
            textStrokeColor: "rgba(0,0,0,0.55)",
            showIcon: true,
            iconScale: 0.93,
            iconGapPx: 10,

            baselineVh: 900,
            scaleMin: 0.80,
            scaleMax: 1.50,
            scaleMode: "vh"
          };

          await window.FUCompanion?.api?.namecardBroadcast?.({ title, options });
        }
      } catch (e) {
        // silently skip
      }

      const adv  = game.macros.getName(advMacroName);
      const miss = game.macros.getName(missMacroName);
      const ae   = game.macros.getName(aeMacroName);
      const anim = game.macros.getName(animMacroName);

      console.log(`${RUN_TAG} macros`, {
        runId,
        advFound: !!adv,
        missFound: !!miss,
        aeFound: !!ae,
        animFound: !!anim
      });

      if (hasDamageSection && !adv) {
        ui.notifications?.error(`AdvanceDamage macro "${advMacroName}" not found or no permission.`);
        throw new Error("AdvanceDamage not found");
      }

      const savedUUIDs = Array.isArray(originalTargetUUIDs) ? originalTargetUUIDs : [];
      if (!savedUUIDs.length) {
        ui.notifications?.warn("No saved targets on this card.");
        console.warn(`${RUN_TAG} abort: no savedUUIDs`, { runId });
        return;
      }

      const elemKey   = String(elementType || "physical").toLowerCase();
      const isHealing = /^(heal|healing|recovery|restore|restoration)$/i.test(elemKey);

      const accTotal  = hasAccuracy ? Number(accuracyTotal) : NaN;

      const explicitAutoHit =
        (args.autoHit === true) ||
        (args.advPayload?.autoHit === true) ||
        (args.advPayload?.isCrit === true) ||
        (flagged?.accuracy?.isCrit === true);

      const treatAutoHit = (!hasAccuracy) || explicitAutoHit;

      const missUUIDs = [];
      const hitUUIDs  = [];
      const perTargetTrace = [];

      if (!isHealing && !treatAutoHit) {
        for (const u of savedUUIDs) {
          const usedDefense = await defenseForUuid(u, !!isSpellish);
          const isHit = Number.isFinite(usedDefense) && Number.isFinite(accTotal) ? (accTotal >= usedDefense) : true;
          perTargetTrace.push({
            targetUuid: u,
            usedDefense,
            accuracyTotal: accTotal,
            comparedWithMagicDefense: !!isSpellish,
            isHit
          });
          if (isHit) hitUUIDs.push(u); else missUUIDs.push(u);
        }
      } else {
        for (const u of savedUUIDs) {
          perTargetTrace.push({
            targetUuid: u,
            usedDefense: null,
            accuracyTotal: accTotal,
            comparedWithMagicDefense: !!isSpellish,
            isHit: true,
            autoReason: isHealing ? "healing" : (treatAutoHit ? "auto-hit" : "unknown")
          });
        }
        hitUUIDs.push(...savedUUIDs);
      }

      console.log(`${RUN_TAG} hit/miss split`, {
        runId,
        savedCount: savedUUIDs.length,
        hitCount: hitUUIDs.length,
        missCount: missUUIDs.length,
        isHealing,
        treatAutoHit,
        accTotal,
        savedUUIDs,
        hitUUIDs,
        missUUIDs,
        perTargetTrace
      });

      dbg("runConfirm:hit-miss-evaluation", {
        runId,
        attackerUuid,
        attackerName,
        elemKey,
        isSpellish: !!isSpellish,
        isHealing,
        treatAutoHit,
        accTotal,
        savedUUIDs,
        hitUUIDs,
        missUUIDs,
        perTargetTrace
      });

      const prevTargets = Array.from(game.user?.targets ?? []).map(t => t.id);
      dbg("runConfirm:previous-user-targets", { runId, prevTargets });

      // Active Effects: On Attack (all targets)
      if (ae && aeDirectives.length && savedUUIDs.length) {
        console.log(`${RUN_TAG} AE on_attack begin`, { runId, directives: aeDirectives.length, targets: savedUUIDs.length });
        await ae.execute({
          __AUTO: true,
          __PAYLOAD: {
            directives : aeDirectives,
            attackerUuid,
            targetUUIDs: savedUUIDs,
            trigger    : "on_attack",
            accTotal   : accTotal,
            isSpellish : !!isSpellish,
            weaponType
          }
        });
        console.log(`${RUN_TAG} AE on_attack done`, { runId });
      }

      // Miss reaction signal + Miss cards
      if (missUUIDs.length) {
        dbg("runConfirm:miss-branch:enter", {
          runId,
          missUUIDs,
          missMacroFound: !!miss,
          missMacroName,
          attackerUuid,
          attackerName
        });

        const missResolvedBeforeEmit = await Promise.all(missUUIDs.map(describeUuid));
        dbg("runConfirm:miss-branch:resolved-before-emit", {
          runId,
          missResolvedBeforeEmit
        });

        const missReactionEmitted = await emitMissReactionSignal({
          flagged,
          attackerUuid,
          attackerName,
          missUUIDs,
          elementType: elemKey,
          isSpellish: !!isSpellish,
          weaponType,
          attackRange,
          accuracyTotal: accTotal
        });

        console.log(`${RUN_TAG} MISS reaction emit`, {
          runId,
          missReactionEmitted,
          missCount: missUUIDs.length,
          missUUIDs
        });

        dbg("runConfirm:miss-branch:after-emit", {
          runId,
          missReactionEmitted,
          missUUIDs
        });

        if (miss) {
          const missIds = (await Promise.all(missUUIDs.map(async u => {
            const d = await fromUuid(u).catch((err) => {
              dbg("runConfirm:miss-branch:resolve-miss-id:error", {
                runId,
                targetUuid: u,
                error: err?.message ?? String(err)
              });
              return null;
            });
            return d?.id ?? d?.document?.id ?? null;
          }))).filter(Boolean);

          console.log(`${RUN_TAG} MISS targeting`, {
            runId,
            missIds,
            missIdsCount: missIds.length
          });

          dbg("runConfirm:miss-branch:resolved-miss-ids", {
            runId,
            missIds,
            missIdsCount: missIds.length
          });

          if (missIds.length) {
            dbg("runConfirm:miss-branch:update-targets:begin", {
              runId,
              missIds
            });
            await game.user.updateTokenTargets(missIds, { releaseOthers: true });
            dbg("runConfirm:miss-branch:update-targets:done", {
              runId,
              currentTargets: Array.from(game.user?.targets ?? []).map(t => ({ id: t.id, name: t.name }))
            });

            dbg("runConfirm:miss-branch:miss-macro:begin", {
              runId,
              missMacroName,
              payload: {
                attackerName,
                elementType: elemKey,
                isSpellish: !!isSpellish,
                weaponType,
                attackRange,
                accuracyTotal: accTotal
              }
            });

            await miss.execute({
              __AUTO: true,
              __PAYLOAD: {
                attackerName,
                elementType: elemKey,
                isSpellish: !!isSpellish,
                weaponType,
                attackRange,
                accuracyTotal: accTotal
              }
            });

            console.log(`${RUN_TAG} MISS macro done`, { runId });
            dbg("runConfirm:miss-branch:miss-macro:done", { runId });
          } else {
            console.warn(`${RUN_TAG} MISS had UUIDs but no resolvable token ids`, {
              runId,
              missUUIDs
            });
            dbg("runConfirm:miss-branch:no-miss-ids", {
              runId,
              missUUIDs
            });
          }
        } else {
          console.warn(`${RUN_TAG} MISS macro not found; reaction signal still emitted`, {
            runId,
            missMacroName
          });
          dbg("runConfirm:miss-branch:no-miss-macro", {
            runId,
            missMacroName
          });
        }
      } else {
        dbg("runConfirm:miss-branch:skipped", {
          runId,
          reason: "no missUUIDs"
        });
      }

      // Hit → AE on_hit + AdvanceDamage OR (NEW) VFX-only animation
      if (hitUUIDs.length) {
        const hitIds = (await Promise.all(hitUUIDs.map(async u => {
          const d = await fromUuid(u).catch(()=>null);
          return d?.id ?? d?.document?.id ?? null;
        }))).filter(Boolean);

        if (hitIds.length) {
          console.log(`${RUN_TAG} HIT targeting`, { runId, hitIdsCount: hitIds.length });
          await game.user.updateTokenTargets(hitIds, { releaseOthers: true });

          // Active Effects: On Hit (hit-only)
          if (ae && aeDirectives.length && hitUUIDs.length) {
            console.log(`${RUN_TAG} AE on_hit begin`, { runId, directives: aeDirectives.length, targets: hitUUIDs.length });
            await ae.execute({
              __AUTO: true,
              __PAYLOAD: {
                directives : aeDirectives,
                attackerUuid,
                targetUUIDs: hitUUIDs,
                trigger    : "on_hit",
                accTotal   : accTotal,
                isSpellish : !!isSpellish,
                weaponType
              }
            });
            console.log(`${RUN_TAG} AE on_hit done`, { runId });
          }

          if (hasDamageSection) {
            console.log(`${RUN_TAG} AdvanceDamage begin`, { runId, advMacroName });
            const advUniversalPayload = {
              ...advPayload,
              targetIds: hitIds,
              actionContext: flagged ?? null,
              actionCardMsgId: chatMsgId ?? null,
            };
            await adv.execute({ __AUTO: true, __PAYLOAD: advUniversalPayload });
            console.log(`${RUN_TAG} AdvanceDamage done`, { runId });
          } else {
            // ========================= NEW: VFX-only animation path =========================
            // If the action has NO damage numbers at all, we still allow animation to run here.
            // The updated ActionAnimationHandler expects:
            //   - targets: UUIDs or token-ish objects (UUID strings are fine)
            //   - animationPurpose: "vfx_only"
            //   - animationScriptRaw / animation_damage_timing_* fields (handler will validate placeholder/empty)
            //
            // Priority: take explicit animation fields from advPayload first (if you store them there),
            // then fall back to flagged.meta.* (your action context).
            const animScriptRaw =
              String(advPayload?.animationScriptRaw ?? flagged?.meta?.animationScriptRaw ?? advPayload?.animationScript ?? flagged?.meta?.animationScript ?? "").trim();

            const animTimingOpt =
              (advPayload?.animation_damage_timing_options ?? flagged?.meta?.animation_damage_timing_options ?? "default");

            const animTimingOffset =
              (advPayload?.animation_damage_timing_offset ?? flagged?.meta?.animation_damage_timing_offset ?? 0);

            console.log(`${RUN_TAG} VFX-only branch`, {
              runId,
              hasDamageSection,
              animFound: !!anim,
              animMacroName,
              hasAnimScriptRaw: !!animScriptRaw,
              timingOpt: animTimingOpt,
              timingOffset: animTimingOffset,
              targetsUuidCount: hitUUIDs.length
            });

            if (anim) {
              // Even if script is empty/placeholder, handler returns false safely.
              const vfxPayload = {
                // Keep any extra fields animation scripts might rely on
                ...advPayload,
                attackerUuid,
                targets: hitUUIDs,                 // UUID strings; handler will normalize
                animationPurpose: "vfx_only",
                animationScriptRaw: animScriptRaw,
                animation_damage_timing_options: animTimingOpt,
                animation_damage_timing_offset: animTimingOffset,

                // Optional context for custom scripts
                actionContext: flagged ?? null,
                actionCardMsgId: chatMsgId ?? null,
              };

              console.log(`${RUN_TAG} ActionAnimationHandler execute begin`, { runId, animMacroName, vfxPayloadPreview: {
                attackerUuid: vfxPayload.attackerUuid,
                targetsCount: vfxPayload.targets?.length ?? 0,
                animationPurpose: vfxPayload.animationPurpose,
                timingOpt: vfxPayload.animation_damage_timing_options,
                timingOffset: vfxPayload.animation_damage_timing_offset,
                scriptPreview: String(vfxPayload.animationScriptRaw || "").slice(0, 120)
              }});

              const used = await anim.execute({ __AUTO: true, __PAYLOAD: vfxPayload });
              console.log(`${RUN_TAG} ActionAnimationHandler execute done`, { runId, used });

            } else {
              console.warn(`${RUN_TAG} VFX-only animation macro not found; skipping animation`, { runId, animMacroName });
            }
            // ======================= END NEW: VFX-only animation path =======================
          }
        }
      }

      // Restore prior targets
      await game.user.updateTokenTargets(prevTargets, { releaseOthers: true });

      // Stamp + disable button (GM client)
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Confirmed ✔";
        btn.style.filter = "grayscale(1)";
      }
      const stamp = msgEl?.querySelector?.("[data-fu-stamp]");
      if (stamp) {
        const by = confirmingUserId ? (game.users.get(confirmingUserId)?.name ?? "Player") : game.user.name;
        stamp.textContent = `Confirmed by: ${by}`;
        stamp.style.opacity = ".9";
      }

      await chatMsg.setFlag(MODULE_NS, "actionApplied", { by: confirmingUserId ?? game.userId, at: Date.now() });

      // NEW: broadcast to all clients so their Confirm button greys out too
      game.socket.emit(SOCKET_NS, {
        type: "fu.actionConfirmed",
        messageId: chatMsg.id,
        by: confirmingUserId ?? game.userId
      });

      console.log(`[${MODULE_ID}] Confirm resolved`, { chatMsgId: chatMsg.id, hitUUIDs, missUUIDs });

    } catch (err) {
      console.error(err);
      ui.notifications?.error("Confirm failed (see console).");
      if (btn) unlockButton(btn);
    } finally {
      if (btn) btn.dataset.fuLock = "0";
      console.groupEnd();
    }
  }

  // ------------------------------------------------------------
  // Socket receiver
  // ------------------------------------------------------------
  game.socket.on(SOCKET_NS, async (data) => {
    try {
      // GM-only: player requests confirm
      if (data?.type === "fu.actionConfirm") {
        if (!game.user?.isGM) return;

        const chatMsg = data.messageId ? game.messages.get(data.messageId) : null;
        if (!chatMsg) return;

        const already = await chatMsg.getFlag(MODULE_NS, "actionApplied");
        if (already) return;

        // Validate: confirming user must own the attacker OR match ownerUserId
        const flagged = chatMsg.getFlag(MODULE_NS, "actionCard")?.payload ?? null;
        const ownerUserId = flagged?.meta?.ownerUserId ?? null;

        let ok = false;
        if (ownerUserId && ownerUserId === data.userId) ok = true;
        else {
          const attackerUuid = flagged?.meta?.attackerUuid ?? null;
          if (attackerUuid) {
            const actor = await resolveAttackerActor(attackerUuid);
            const user = game.users.get(data.userId);
            if (actor && user) ok = actor.testUserPermission(user, "OWNER");
          }
        }
        if (!ok) return;

        await runConfirm(chatMsg, data.args ?? {}, data.userId);
        return;
      }

      // ALL clients: GM broadcasts that this action is confirmed
      if (data?.type === "fu.actionConfirmed") {
        const msgId = data.messageId;
        if (!msgId) return;

        const msgEl =
          document.querySelector(`#chat-log .message[data-message-id="${msgId}"]`) ||
          document.querySelector(`.chat-popout .message[data-message-id="${msgId}"]`) ||
          null;

        const btn = msgEl?.querySelector?.("[data-fu-confirm]") ?? null;
        if (btn) {
          btn.disabled = true;
          btn.textContent = "Confirmed ✔";
          btn.style.filter = "grayscale(1)";
          btn.dataset.fuLock = "1";
        }

        return;
      }
    } catch (err) {
      console.error("[fu-chatbtn] socket handler failed:", err);
    }
  });

  // ------------------------------------------------------------
  // Click handler (all clients)
  // ------------------------------------------------------------
  root.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.("[data-fu-confirm]");
    if (!btn) return;

    // Double-click guard
    if (btn.dataset.fuLock === "1") return;

    const msgEl = btn.closest?.(".message");
    const msgId = msgEl?.dataset?.messageId;
    const chatMsg = msgId ? game.messages.get(msgId) : null;
    if (!chatMsg) return;

    // Parse dataset args
    let args = {};
    try { args = btn.dataset.fuArgs ? JSON.parse(btn.dataset.fuArgs) : {}; }
    catch { args = {}; }

    // Permission: GM always; otherwise must own attacker (or match ownerUserId)
    const flagged = chatMsg.getFlag(MODULE_NS, "actionCard")?.payload ?? null;
    const ownerUserId = flagged?.meta?.ownerUserId ?? null;

    let ownsAttacker = false;
    try {
      const attackerUuid = flagged?.meta?.attackerUuid ?? null;
      if (attackerUuid) {
        const actor = await resolveAttackerActor(attackerUuid);
        ownsAttacker = !!actor?.isOwner;
      }
    } catch {}

    const canConfirm = !!game.user?.isGM || (ownerUserId && ownerUserId === game.userId) || ownsAttacker;
    if (!canConfirm) {
      ui.notifications?.warn("You can only confirm actions for a character you own.");
      return;
    }

    // If player: request GM to resolve via socket
    if (!game.user?.isGM) {
      btn.dataset.fuLock = "1";
      lockButton(btn, "Confirming…");
      game.socket.emit(SOCKET_NS, {
        type: "fu.actionConfirm",
        messageId: msgId,
        userId: game.userId,
        args
      });
      return;
    }

    // GM click: resolve locally
    await runConfirm(chatMsg, args, game.userId);
  }, { capture: false });

  console.log(`[${MODULE_ID}] ready — global Confirm listener installed on this client`);
});
