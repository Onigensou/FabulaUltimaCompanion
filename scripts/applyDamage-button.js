// fu-chatbtn.js — Foundry VTT v12
// Global delegated listener for chat-card buttons using [data-fu-apply].
// Executes AdvanceDamage (and Miss) on GM click, regardless of who posted.

const MODULE_ID = "fu-chatbtn";

Hooks.once("ready", async () => {
  
  // In scripts/applyDamage-button.js — replace the non-GM CSS block with:
if (!game.user?.isGM) {
  const style = document.createElement("style");
  style.id = "fu-chatbtn-hide-player-buttons";
  style.textContent = `
    /* Players should NOT see/press Apply or any dismiss button,
       but SHOULD see Invoke Trait/Bond */
    [data-fu-apply],
    [data-action="dismiss"] {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

  
  const root = document.querySelector("#chat-log") || document.body;
  if (!root) return;

  if (root.__fuChatBtnBound) return;
  root.__fuChatBtnBound = true;

  root.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.("[data-fu-apply]");
    if (!btn) return;

    // Only GMs can Apply
    if (!game.user?.isGM) {
      ui.notifications?.warn("Only the GM can press Apply.");
      return;
    }

    // Double-click guard
    if (btn.dataset.fuLock === "1") return;
    btn.dataset.fuLock = "1";

    // Try to read attached ChatMessage
    const msgEl = btn.closest?.(".message");
    const msgId = msgEl?.dataset?.messageId;
    const chatMsg = msgId ? game.messages.get(msgId) : null;

    // Parse embedded args from the card
    let args = {};
    try { args = btn.dataset.fuArgs ? JSON.parse(btn.dataset.fuArgs) : {}; }
    catch { args = {}; }

    const {
      advMacroName     = "AdvanceDamage",
      missMacroName    = "Miss",
      advPayload       = {},
      elementType      = "physical",
      isSpellish       = false,
      accuracyTotal    = 0,
      weaponType       = "",
      attackRange      = "Melee",
      attackerName     = "Unknown",
      aeMacroName      = "ApplyActiveEffect",
      aeDirectives     = [],
      attackerUuid     = null,
      originalTargetUUIDs = [],
      chatMsgId        = msgId // fallback to DOM id if not injected
    } = args;

    try {
      // UI feedback
      btn.disabled = true;
      btn.textContent = "Applied ✔";
      btn.style.filter = "grayscale(1)";

      const stamp = msgEl?.querySelector?.("[data-fu-stamp]");
      if (stamp) {
        stamp.textContent = `Applied by GM: ${game.user.name}`;
        stamp.style.opacity = ".9";
      }

      const adv  = game.macros.getName(advMacroName);
      const miss = game.macros.getName(missMacroName);
      const ae   = game.macros.getName(aeMacroName);
      if (!adv) {
        ui.notifications?.error(`Advanced Damage macro "${advMacroName}" not found or no permission.`);
        throw new Error("AdvanceDamage not found");
      }

      // Sanity check targets
      const savedUUIDs = Array.isArray(originalTargetUUIDs) ? originalTargetUUIDs : [];
      if (!savedUUIDs.length) {
        ui.notifications?.warn("No saved targets on this card.");
        return;
      }

      // Utility: defense reader (prefers new keys; avoids *_mod)
      const numberish = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
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

      const elemKey   = String(elementType || "physical").toLowerCase();
      const isHealing = /^(heal|healing|recovery|restore|restoration)$/i.test(elemKey);
      const accTotal  = Number(accuracyTotal ?? 0);

      const missUUIDs = [];
      const hitUUIDs  = [];

      if (!isHealing && Number.isFinite(accTotal)) {
        for (const u of savedUUIDs) {
          const usedDefense = await defenseForUuid(u, !!isSpellish);
          const willMiss    = Number.isFinite(usedDefense) && accTotal < usedDefense;
          if (willMiss) missUUIDs.push(u); else hitUUIDs.push(u);
        }
      } else {
        hitUUIDs.push(...savedUUIDs);
      }

      const prevTargets = Array.from(game.user?.targets ?? []).map(t => t.id);

      // Active Effects: On Attack (all saved targets, regardless of hit/miss)
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

      // Fire Miss for the “missUUIDs” subset
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

      // Fire AdvanceDamage for the “hitUUIDs” subset
      if (hitUUIDs.length) {
        const hitIds = (await Promise.all(hitUUIDs.map(async u => {
          const d = await fromUuid(u).catch(()=>null);
          return d?.id ?? d?.document?.id ?? null;
        }))).filter(Boolean);

        if (hitIds.length) {
          await game.user.updateTokenTargets(hitIds, { releaseOthers: true });
       // Active Effects: On Hit (only the targets that were actually hit)
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
          await adv.execute({ __AUTO: true, __PAYLOAD: advPayload });
        }
      }

      // Restore prior targets
      await game.user.updateTokenTargets(prevTargets, { releaseOthers: true });

      console.log(`[${MODULE_ID}] Apply executed by GM:`, { chatMsgId, savedUUIDs, missUUIDs, hitUUIDs });
      ui.notifications?.info(`Applied by GM: ${game.user.name}`);
    } catch (err) {
      console.error(err);
      ui.notifications?.error("Apply failed (see console).");
      // revert + unlock so GM can try again
      btn.disabled = false;
      btn.textContent = "Apply (GM)";
      btn.style.filter = "";
    } finally {
      btn.dataset.fuLock = "0";
    }
  }, { capture: false });

  console.log(`[${MODULE_ID}] ready — global chat-button listener installed on this client`);
});
