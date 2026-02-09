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

const MODULE_ID = "fu-chatbtn";
const MODULE_NS = "fabula-ultima-companion";
const SOCKET_NS = "module.fabula-ultima-companion";


// ------------------------------------------------------------
// Debug toggle (set to false to silence logs)
// ------------------------------------------------------------
const DEBUG_FU_CONFIRM = true;
const FU_TAG = "[fu-chatbtn][DEBUG]";
const dlog  = (...a)=>{ if (DEBUG_FU_CONFIRM) console.log(FU_TAG, ...a); };
const dwarn = (...a)=>{ if (DEBUG_FU_CONFIRM) console.warn(FU_TAG, ...a); };
const derr  = (...a)=>{ if (DEBUG_FU_CONFIRM) console.error(FU_TAG, ...a); };


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
    const msgEl =
      document.querySelector(`#chat-log .message[data-message-id="${chatMsg.id}"]`) ||
      document.querySelector(`.chat-popout .message[data-message-id="${chatMsg.id}"]`) ||
      null;

    const btn = msgEl?.querySelector?.("[data-fu-confirm]") ?? null;

    // double-click guard
    if (btn?.dataset?.fuLock === "1") return;
    if (btn) lockButton(btn, "Confirming…");

    try {
      const flagged = chatMsg.getFlag(MODULE_NS, "actionCard")?.payload ?? null;

      // Prevent double-confirm (server-side-ish)
      const already = await chatMsg.getFlag(MODULE_NS, "actionApplied");
      if (already) return;

      // Backfill args from flag payload when needed
      if (flagged) {
        if (!args.attackerUuid && flagged.meta?.attackerUuid) args.attackerUuid = flagged.meta.attackerUuid;
        if ((!args.aeDirectives || !args.aeDirectives.length) && Array.isArray(flagged.meta?.activeEffects)) {
          args.aeDirectives = flagged.meta.activeEffects;
        }
        if (typeof args.hasDamageSection !== "boolean" && flagged.meta?.hasDamageSection !== undefined) {
          args.hasDamageSection = !!flagged.meta.hasDamageSection;
        }
        if (typeof args.hasAnimationScript !== "boolean" && flagged.meta?.hasAnimationScript !== undefined) {
          args.hasAnimationScript = !!flagged.meta.hasAnimationScript;
        }
      }

      const {
        advMacroName     = "AdvanceDamage",
        animMacroName    = "ActionAnimationHandler",
        missMacroName    = "Miss",
        advPayload       = {},
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
        chatMsgId        = chatMsg.id
      } = args;

      const itemUsage = flagged?.itemUsage ?? flagged?.meta?.itemUsage ?? null;

      const hasDamageSection =
        (typeof args.hasDamageSection === "boolean") ? args.hasDamageSection :
        (flagged?.meta?.hasDamageSection !== undefined) ? !!flagged.meta.hasDamageSection :
        true;

      const hasAnimationScript =
        (typeof args.hasAnimationScript === "boolean") ? args.hasAnimationScript :
        (flagged?.meta?.hasAnimationScript !== undefined) ? !!flagged.meta.hasAnimationScript :
        (() => {
          const raw = String(flagged?.animationScriptRaw ?? flagged?.meta?.animationScriptRaw ?? "").trim();
          if (!raw) return false;
          if (/insert your sequencer animation here/i.test(raw)) return false;
          return true;
        })();

      // Spend resources now (commit point). If fail, stop.
      const okToProceed = await spendResourcesOnConfirm(flagged ? flagged : null);
      if (!okToProceed) return;

      // Consume item only after resource spend succeeds
      if (itemUsage && attackerUuid) await consumeItemOnConfirm(attackerUuid, itemUsage);

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

      if (hasDamageSection && !adv) {
        ui.notifications?.error(`AdvanceDamage macro "${advMacroName}" not found or no permission.`);
        throw new Error("AdvanceDamage not found");
      }

      if (!hasDamageSection && hasAnimationScript && !anim) {
        ui.notifications?.error(`ActionAnimationHandler macro "${animMacroName}" not found or no permission.`);
        throw new Error("ActionAnimationHandler not found");
      }

      const savedUUIDs = Array.isArray(originalTargetUUIDs) ? originalTargetUUIDs : [];
      if (!savedUUIDs.length) {
        // For animation-only actions (e.g., passive/buff utilities), allow zero targets.
        // We'll let ActionAnimationHandler fall back to the attacker token.
        if (!( !hasDamageSection && hasAnimationScript )) {
          ui.notifications?.warn("No saved targets on this card.");
          return;
        }
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

      if (!isHealing && !treatAutoHit) {
        for (const u of savedUUIDs) {
          const usedDefense = await defenseForUuid(u, !!isSpellish);
          const isHit = Number.isFinite(usedDefense) && Number.isFinite(accTotal) ? (accTotal >= usedDefense) : true;
          if (isHit) hitUUIDs.push(u); else missUUIDs.push(u);
        }
      } else {
        hitUUIDs.push(...savedUUIDs);
      }

      const prevTargets = Array.from(game.user?.targets ?? []).map(t => t.id);

      // Active Effects: On Attack (all targets)
      if (ae && aeDirectives.length && savedUUIDs.length) {
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
      }

      // Miss cards
      if (missUUIDs.length && miss) {
        const missIds = (await Promise.all(missUUIDs.map(async u => {
          const d = await fromUuid(u).catch(()=>null);
          return d?.id ?? d?.document?.id ?? null;
        }))).filter(Boolean);

        if (missIds.length) {
          await game.user.updateTokenTargets(missIds, { releaseOthers: true });
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
        }
      }

      // Hit → AE on_hit + AdvanceDamage
      if (hitUUIDs.length) {
        const hitIds = (await Promise.all(hitUUIDs.map(async u => {
          const d = await fromUuid(u).catch(()=>null);
          return d?.id ?? d?.document?.id ?? null;
        }))).filter(Boolean);

        if (hitIds.length) {
          await game.user.updateTokenTargets(hitIds, { releaseOthers: true });

          // Active Effects: On Hit (hit-only)
          if (ae && aeDirectives.length && hitUUIDs.length) {
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
          }

          if (hasDamageSection) {
            const advUniversalPayload = {
              ...advPayload,
              targetIds: hitIds,
              actionContext: flagged ?? null,
              actionCardMsgId: chatMsgId ?? null,
            };
            await adv.execute({ __AUTO: true, __PAYLOAD: advUniversalPayload });
          }
        }
      }
      // Animation-only (no damage/heal): still play the Action animation script.
      if (!hasDamageSection && hasAnimationScript && anim) {
        // Prefer hit targets; otherwise fall back to saved targets; otherwise let handler fall back to attacker.
        const targetUUIDsForAnim =
          (hitUUIDs?.length ? hitUUIDs : (savedUUIDs?.length ? savedUUIDs : []));


        // --- Ensure animationScriptRaw is present (non-damage actions sometimes lose it) ---
        let animScriptRaw = String((flagged ?? {})?.animationScriptRaw ?? (flagged ?? {})?.meta?.animationScriptRaw ?? "").trim();

        if (!animScriptRaw) {
          const skillUuid = (flagged?.skillUuid ?? flagged?.meta?.skillUuid ?? flagged?.meta?.actionUuid ?? null);
          dlog("Animation-only: animationScriptRaw missing on card payload; attempting to fetch from item", { skillUuid });

          if (skillUuid) {
            try {
              const doc = await fromUuid(skillUuid);
              const rawFromItem = String(doc?.system?.props?.animation_script ?? "").trim();
              if (rawFromItem) {
                animScriptRaw = rawFromItem;
                dlog("Animation-only: fetched animation_script from item.system.props.animation_script", { chars: animScriptRaw.length, itemName: doc?.name });
              } else {
                dwarn("Animation-only: item resolved but has no system.props.animation_script", { itemName: doc?.name });
              }
            } catch (e) {
              derr("Animation-only: fromUuid(skillUuid) failed", e);
            }
          } else {
            dwarn("Animation-only: no skillUuid/actionUuid found on payload; cannot fetch animation_script");
          }
        } else {
          dlog("Animation-only: animationScriptRaw present on payload", { chars: animScriptRaw.length });
        }


        await anim.execute({
          __AUTO: true,
          __PAYLOAD: {
            ...(flagged ?? {}),
            // provide common fields expected by animation scripts/handler
            meta: {
              ...((flagged ?? {})?.meta ?? {}),
              attackerUuid: attackerUuid ?? (flagged?.meta?.attackerUuid ?? null),
              targetUUIDs: targetUUIDsForAnim,
              originalTargetUUIDs: targetUUIDsForAnim
            },
            targetUUIDs: targetUUIDsForAnim,
            originalTargetUUIDs: targetUUIDsForAnim
            },
            animationScriptRaw: animScriptRaw || ((flagged ?? {})?.animationScriptRaw ?? ((flagged ?? {})?.meta?.animationScriptRaw ?? ""))
          }
        });
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

      ui.notifications?.info("Action confirmed.");
      console.log(`[${MODULE_ID}] Confirm resolved`, { chatMsgId: chatMsg.id, hitUUIDs, missUUIDs });

    } catch (err) {
      console.error(err);
      ui.notifications?.error("Confirm failed (see console).");
      if (btn) unlockButton(btn);
    } finally {
      if (btn) btn.dataset.fuLock = "0";
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
