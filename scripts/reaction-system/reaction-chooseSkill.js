/**
 * [ONI] Reaction System — Module Version (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * This file is safe to load automatically from a module (runs once per client).
 * Generated: 2026-01-09T07:27:00
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  /**
   * Macro: ReactionChooseSkill
   * Id: 8KUWT6QwAv2wU9S5
   * Folder: Reaction System
   * Type: script
   * Author: GM
   * Exported: 2026-01-09T07:11:54.590Z
   */
  // ============================================================================
  // ONI ReactionChooseSkill – Dialog + ActionDataFetch handoff (Foundry VTT v12)
  // ---------------------------------------------------------------------------
  // PURPOSE
  // -------
  // This script ONLY handles the UI/dialog part of choosing a Reaction skill,
  // then feeds the chosen Item into your Action system (ActionDataFetch).
  //
  // It exposes a small API on window["oni.ReactionChooseSkill"]:
  //
  //   window["oni.ReactionChooseSkill"].openReactionDialog(ctx)
  //
  // where `ctx` is the same object ReactionManager builds:
  //
  //   {
  //     combatant, actor, token,
  //     reactions,   // array from collectReactionsForTrigger(...)
  //     triggerKey,  // normalized trigger ("round_start", "creature_deals_damage", ...)
  //     phasePayload // payload that came from oni:reactionPhase
  //   }
  //
  // ReactionManager remains responsible for:
  //   - Listening to oni:reactionPhase
  //   - Finding which actors have Reactions
  //   - Spawning the floating "Reaction" button
  //
  // This file is responsible for:
  //   - UI of the "Choose Reaction" dialog
  //   - Determining targets (from phasePayload or user targets)
  //   - Calling the ActionDataFetch macro with the chosen skill UUID
  // ============================================================================

  (() => {
    const KEY = "oni.ReactionChooseSkill";
    if (window[KEY]) {
      console.log("[ReactionChooseSkill] Already installed.");
      return;
    }

    // -------------------------------------------------------------------------
    // 1) Dialog CSS
    // -------------------------------------------------------------------------

    const REACT_SKILL_STYLE_ID = "oni-reaction-choose-skill-style";

    function ensureReactionDialogStyles() {
      if (document.getElementById(REACT_SKILL_STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = REACT_SKILL_STYLE_ID;
      style.textContent = `
        .oni-react-skill-wrap {
          padding: 6px 8px 10px 8px;
        }
        .oni-react-skill-list {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 380px;
          overflow-y: auto;
        }
        .oni-react-skill-row {
          position: relative;
          display: grid;
          grid-template-columns: 32px 1fr;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border-radius: 999px;
          background: linear-gradient(180deg,#f6f1e6,#ebdfc7);
          border: 2px solid #7a6a55;
          box-shadow:
            0 3px 0 rgba(41,33,24,0.55),
            0 0 0 1px rgba(255,255,255,0.65) inset;
          cursor: pointer;
          transition: transform 120ms ease-out, box-shadow 120ms ease-out, filter 120ms ease-out;
        }
        .oni-react-skill-row:hover {
          transform: translateY(-1px);
          filter: brightness(1.03);
          box-shadow:
            0 4px 0 rgba(41,33,24,0.65),
            0 0 0 1px rgba(255,255,255,0.8) inset;
        }
        .oni-react-skill-icon {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          overflow: hidden;
          box-shadow:
            0 0 0 1px rgba(0,0,0,0.2),
            0 2px 3px rgba(0,0,0,0.35);
        }
        .oni-react-skill-icon img {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .oni-react-skill-main {
          display: flex;
          flex-direction: column;
          justify-content: center;
        }
        .oni-react-skill-name {
          font-weight: 700;
          font-size: 13px;
          letter-spacing: 0.03em;
          margin-bottom: 1px;
        }
        .oni-react-skill-sub {
          font-size: 11px;
          opacity: 0.8;
        }
        .oni-react-skill-tip {
          margin-top: 6px;
          padding: 6px 8px;
          border-radius: 6px;
          background: rgba(0,0,0,0.18);
          font-size: 11px;
          line-height: 1.35;
        }
        .oni-react-skill-tip b {
          color: #ffe38a;
        }
      `;
      document.head.appendChild(style);
    }

    // -------------------------------------------------------------------------
    // 2) Main API: openReactionDialog(ctx)
    // -------------------------------------------------------------------------

    async function openReactionDialog(ctx) {
      ensureReactionDialogStyles();

      const actor        = ctx?.actor ?? null;
      const token        = ctx?.token ?? null;
      const reactionsArr = Array.isArray(ctx?.reactions) ? ctx.reactions : [];
      const triggerKey   = ctx?.triggerKey ?? "(unknown_trigger)";
      const phasePayload = ctx?.phasePayload ?? {};

      if (!actor) {
        ui.notifications.warn("[Reaction] No actor found in context.");
        console.warn("[ReactionChooseSkill] openReactionDialog: missing actor in ctx:", ctx);
        return;
      }

      if (!reactionsArr.length) {
        ui.notifications.warn("[Reaction] No reaction skills available for this trigger.");
        console.warn("[ReactionChooseSkill] openReactionDialog: ctx.reactions is empty:", ctx);
        return;
      }

      // Build unique list of Items from ctx.reactions
      const seenIds = new Set();
      const items   = [];
      for (const entry of reactionsArr) {
        const it = entry?.item;
        if (!it) continue;
        if (seenIds.has(it.id)) continue;
        seenIds.add(it.id);
        items.push(it);
      }

      if (!items.length) {
        ui.notifications.warn("[Reaction] No valid Item documents found in reaction list.");
        console.warn("[ReactionChooseSkill] openReactionDialog: items list empty. ctx.reactions =", reactionsArr);
        return;
      }

      // Sort by name
      items.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

      // Small helpers
      const esc = (s) => {
        if (s == null) return "";
        return String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      };

      const stripHtml = (s) => String(s ?? "").replace(/<[^>]*>/g, "");

      const triggerLabel = String(triggerKey).replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

      const rowsHtml = items.map(it => {
        const name = esc(it.name ?? "(Unnamed)");
        const uuid = esc(it.uuid ?? "");
        const img  = esc(it.img || "icons/svg/explosion.svg");

        const descRaw = it.system?.description ?? it.system?.system?.description ?? "";
        const desc = esc(stripHtml(descRaw)).substring(0, 240);

        return `
          <div class="oni-react-skill-row" data-uuid="${uuid}" data-desc="${desc}">
            <div class="oni-react-skill-icon">
              <img src="${img}" alt="">
            </div>
            <div class="oni-react-skill-main">
              <div class="oni-react-skill-name">${name}</div>
              <div class="oni-react-skill-sub">Reaction Skill</div>
            </div>
          </div>
        `;
      }).join("");

      const content = `
        <div class="oni-react-skill-wrap">
          <div style="margin-bottom:6px;font-size:11px;opacity:0.9;">
            Trigger: <b>${esc(triggerLabel)}</b><br>
            <span style="opacity:0.85;">Choose a Reaction to perform.</span>
          </div>
          <div class="oni-react-skill-list">
            ${rowsHtml}
          </div>
          <div class="oni-react-skill-tip" data-tip>
            <b>Tip:</b> Hover a Reaction to see its description here.
          </div>
        </div>
      `;

      // --- Show dialog and wait for choice ---
      const chosenItem = await new Promise((resolve) => {
        let dlg = null;

        dlg = new Dialog({
          title: "Choose Reaction",
          content,
          buttons: {},
          close: () => resolve(null),
          render: (html) => {
            const $html = $(html);
            const tipEl = html[0].querySelector(".oni-react-skill-tip[data-tip]");
            const $rows = $html.find(".oni-react-skill-row");

            // Hover = update description
            $rows.on("mouseenter", function () {
              if (!tipEl) return;
              const desc = this.dataset.desc || "";
              tipEl.innerHTML = desc
                ? `<b>Description:</b> ${desc}`
                : `<b>Description:</b> (No description)`;
            });

            // Click = choose this reaction
            $rows.on("click", function () {
              const uuid = this.dataset.uuid;
              const item = items.find(i => i.uuid === uuid);
              resolve(item ?? null);
              dlg.close();
            });
          }
        }, { width: 420 });

        dlg.render(true);
      });

      if (!chosenItem) {
        console.log("[ReactionChooseSkill] Reaction dialog closed without choice.");
        return;
      }

      // --- Build ActionDataFetch payload ---
      const attacker_uuid =
        actor?.uuid ??
        token?.actor?.uuid ??
        null;

      if (!attacker_uuid) {
        ui.notifications.error("[Reaction] Could not determine attacker_uuid for Reaction.");
        console.error("[ReactionChooseSkill] openReactionDialog: no attacker_uuid. ctx =", ctx);
        return;
      }

      // Resolve targets:
      let targets = [];

      // 1) Prefer targets from the phase payload
      if (Array.isArray(phasePayload.targets) && phasePayload.targets.length > 0) {
        targets = [...phasePayload.targets];
      } else if (phasePayload.targetUuid) {
        targets = [phasePayload.targetUuid];
      }

      // 2) Fallback: current user targets
      if (!targets.length && game.user?.targets?.size) {
        targets = Array.from(game.user.targets)
          .map(t => t.document?.uuid)
          .filter(Boolean);
      }

      if (!targets.length) {
        ui.notifications.warn("[Reaction] No targets found for this Reaction. Please target something first.");
        console.warn("[ReactionChooseSkill] openReactionDialog: no targets resolved. phasePayload =", phasePayload);
        return;
      }

        // Build payload EXACTLY like the Skill.js macro does, so
      // ActionDataFetch treats this as "skill already chosen"
      // and does NOT open a second "Choose Skill" dialog.
      const payload = {
        attacker_uuid,
        targets,
        // Main key ActionDataFetch expects:
        skill_uuid: chosenItem.uuid,
        // Extra key for safety/backwards-compat (harmless if unused):
        skillUuid: chosenItem.uuid
      };

      const ADF = game.macros.getName("ActionDataFetch");
      if (!ADF) {
        ui.notifications.error(`Macro "ActionDataFetch" not found or no permission.`);
        console.error("[ReactionChooseSkill] openReactionDialog: missing ActionDataFetch macro.");
        return;
      }

      console.log("[ReactionChooseSkill] Calling ActionDataFetch for Reaction:", {
        attacker_uuid,
        targets,
        skill_uuid: chosenItem.uuid,
        triggerKey
      });

      // NEW: also put payload on the global, for macros that
      // read from window.__PAYLOAD instead of args[0].__PAYLOAD
      window.__PAYLOAD = payload;

      // Same call pattern as in Skill.js:
      await ADF.execute({ __AUTO: true, __PAYLOAD: payload });
    }

    // -------------------------------------------------------------------------
    // 3) Expose API on window
    // -------------------------------------------------------------------------

    window[KEY] = {
      openReactionDialog
    };

    console.log("[ReactionChooseSkill] Installed. Use window['oni.ReactionChooseSkill'].openReactionDialog(ctx)");
  })();
});
