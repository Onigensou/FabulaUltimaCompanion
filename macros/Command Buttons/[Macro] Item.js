// ============================================================================
// Foundry VTT v12 – Item Button (JRPG-style list) → ActionDataFetch
// This macro lets the player pick a CONSUMABLE item, then (if needed) pick
// which Active Skill inside that item to use, then forwards that Skill to
// ActionDataFetch. It also handles item quantity / unique logic.
// ============================================================================

(async () => {
  const ACTION_DATA_FETCH_NAME = "ActionDataFetch";

  // --- Cursor-move sound (same as Skill dialog) -----------------------------
  const SOUND_URL          = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/CursorMove.mp3";
  const SOUND_COOLDOWN_MS  = 90;
  let   _lastSoundTimeItem = 0;

  function playMove() {
    const now = (typeof performance !== "undefined" && performance.now)
      ? performance.now()
      : Date.now();

    // Small cooldown so it doesn't spam if the key is held down
    if (now - _lastSoundTimeItem < SOUND_COOLDOWN_MS) return;
    _lastSoundTimeItem = now;

    try {
      AudioHelper.play(
        {
          src: SOUND_URL,
          volume: 0.5,
          autoplay: true,
          loop: false
        },
        false // local only, no broadcast
      );
    } catch (err) {
      console.warn("Item dialog cursor sound failed:", err);
    }
  }

  // --- Small helpers --------------------------------------------------------

  function resolveActorForUser(user) {
    // 1) If GM: prefer selected token
    if (user.isGM) {
      const controlled = canvas.tokens.controlled[0];
      if (controlled?.actor) return controlled.actor;


      // Fallback: first token with an actor owned by GM
      const ownedToken = canvas.tokens.placeables.find(t => t.actor);
      return ownedToken?.actor ?? null;
    }

    // 2) Player: prefer their linked character
    if (user.character) {
      return game.actors.get(user.character.id) ?? null;
    }

    // 3) Fallback: first token the user owns and controls
    const candidate = canvas.tokens.placeables.find(t => {
      return t.actor && t.actor.testUserPermission(user, "OWNER");
    });
    return candidate?.actor ?? null;
  }

  function htmlEscape(str = "") {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function stripTags(html = "") {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent ?? tmp.innerText ?? "";
  }

    // Ask user to pick *one* skill from an item's Active Skill container
  // Now uses the same JRPG pill-button style as the Item dialog
  // and shows the Skill's icon on the left.
  async function pickSkillFromItem(item, skillEntries) {
    if (!Array.isArray(skillEntries) || !skillEntries.length) return null;

    // Build display info (including Skill icon from the Item document)
    const skillInfos = [];
    for (const entry of skillEntries) {
      const uuid = entry?.uuid;
      if (!uuid) continue;

      let skillDoc = null;
      try {
        skillDoc = await fromUuid(uuid);
      } catch (e) {
        console.error("pickSkillFromItem | fromUuid failed:", e, entry);
      }

      const name = entry?.name ?? skillDoc?.name ?? "(No name)";
      const img  = skillDoc?.img || skillDoc?.system?.img || "icons/svg/explosion.svg";

      const descHtml  = entry?.skill_description ?? entry?.description ?? skillDoc?.system?.props?.description ?? "";
      const descPlain = stripTags(descHtml);

      skillInfos.push({
        uuid,
        name,
        img,
        desc: descPlain
      });
    }

    if (!skillInfos.length) return null;

        const rowsHtml = skillInfos.map(info => {
      const safeUuid = htmlEscape(info.uuid);
      const safeName = htmlEscape(info.name);
      const safeDesc = htmlEscape(info.desc);
      const safeImg  = htmlEscape(info.img);

      return `
        <div class="jrpg-row">
          <button type="button"
                  class="jrpg-skill-btn"
                  data-uuid="${safeUuid}"
                  data-desc="${safeDesc}"
                  title="${safeDesc}">
            <img class="jrpg-skill-icon" src="${safeImg}" alt="" />
            <span class="jrpg-skill-label">${safeName}</span>
          </button>
        </div>
      `;
    }).join("");

    const itemNameSafe = htmlEscape(item?.name ?? "Item");

        const skillDialogContent = `
      <style>
        .jrpg-wrap {
          max-height: 460px;
          overflow: auto;
          padding: 8px;
        }
        .jrpg-row {
          position: relative;
        }
        .jrpg-skill-btn {
          position: relative;
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          margin: 6px 0;
          padding: 8px 12px;
          border: 2px solid rgba(120,78,20,.9);
          outline: none;
          border-radius: 9999px;
          box-shadow:
            0 2px 0 rgba(0,0,0,.25),
            inset 0 0 0 1px rgba(255,255,255,.25);
          background: linear-gradient(#f2d9a2,#e1c385);
          font-weight: 600;
          font-size: 14px;
          text-align: left;
          cursor: pointer;
          transition: filter .05s, transform .05s, box-shadow .05s;
        }
        .jrpg-skill-btn:hover {
          filter: brightness(1.05);
          transform: translateY(-1px);
        }
        .jrpg-skill-btn:active {
          transform: translateY(0);
          box-shadow:
            0 1px 0 rgba(0,0,0,.3),
            inset 0 0 0 1px rgba(255,255,255,.25);
        }
        .jrpg-skill-btn:focus,
        .jrpg-skill-btn.is-active {
          box-shadow:
            0 0 0 3px rgba(255,255,255,.6),
            0 0 0 6px rgba(120,78,20,.55),
            0 2px 0 rgba(0,0,0,.25);
        }
        .jrpg-skill-icon {
          width: 24px;
          height: 24px;
          image-rendering: pixelated;
          flex: 0 0 24px;
          border-radius: 4px;
          box-shadow: 0 0 0 1px rgba(0,0,0,.15) inset;
          background: rgba(0,0,0,.05);
        }
        .jrpg-skill-label {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          flex: 1;
        }
        .jrpg-tip {
          position: fixed;
          z-index: 999999;
          max-width: 340px;
          padding: 8px 10px;
          border: 2px solid rgba(80,50,12,.95);
          border-radius: 10px;
          background: #f7f1e3;
          color: #2b2b2b;
          box-shadow: 0 6px 18px rgba(0,0,0,.35);
          font-size: 13px;
          line-height: 1.2;
          font-weight: 600;
          pointer-events: none;
        }
      </style>
      <div class="jrpg-wrap" tabindex="-1">
        ${rowsHtml}
      </div>
    `;

        const chosenSkillUuid = await new Promise(resolve => {
      const dlg = new Dialog(
        {
          title: "Skills in " + itemNameSafe,
          content: skillDialogContent,
          buttons: {}
        },
        { width: 420 }
      );

      // Small helper to spawn tooltip near a button
      function createTip(text, anchorEl) {
        const tip = document.createElement("div");
        tip.className = "jrpg-tip";
        tip.textContent = text;
        document.body.appendChild(tip);

        const r   = anchorEl.getBoundingClientRect();
        const pad = 8;

        const top  = Math.max(
          8,
          Math.min(window.innerHeight - tip.offsetHeight - 8,
                   r.top + (r.height - tip.offsetHeight) / 2)
        );
        const left = Math.min(
          window.innerWidth - tip.offsetWidth - 8,
          r.right + pad
        );

        tip.style.top  = `${top}px`;
        tip.style.left = `${left}px`;
        return tip;
      }

      const onRender = (app, html) => {
        if (app.id !== dlg.id) return;

        let liveTip  = null;
        let tipTimer = null;

        const $wrap = html.find(".jrpg-wrap");
        const wrapEl = $wrap.get(0);
        const $btns = html.find(".jrpg-skill-btn");

        // Initial focus
        const first = $btns.get(0);
        if (first) {
          first.classList.add("is-active");
          first.focus({ preventScroll: true });
        }

        // Hover → highlight + cursor sound + tooltip
        html.on("mouseenter", ".jrpg-skill-btn", ev => {
          const btnEl = ev.currentTarget;
          $btns.removeClass("is-active");
          btnEl.classList.add("is-active");
          btnEl.focus({ preventScroll: true });
          if (typeof playMove === "function") playMove();

          // clear old tooltip
          if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
          if (liveTip)  { liveTip.remove(); liveTip = null; }

          const text = btnEl?.dataset?.desc || "";
          if (!text) return;

          tipTimer = setTimeout(() => {
            liveTip = createTip(text, btnEl);
          }, 120);
        });

        html.on("mouseleave", ".jrpg-skill-btn", () => {
          if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
          if (liveTip)  { liveTip.remove(); liveTip = null; }
        });

        // Click → choose this skill
        html.on("click", ".jrpg-skill-btn", ev => {
          const btnEl = ev.currentTarget;
          const uuid  = btnEl?.dataset?.uuid || null;

          if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
          if (liveTip)  { liveTip.remove(); liveTip = null; }

          resolve(uuid);
          dlg.close();
        });

        // Keyboard navigation (Up/Down/Home/End/Enter/Esc)
        $wrap.on("keydown", ev => {
          const KEY = ev.key;
          const btnEls = $btns.toArray();
          if (!btnEls.length) return;

          const activeIx = btnEls.findIndex(b => b.classList.contains("is-active"));
          let nextIx     = activeIx >= 0 ? activeIx : 0;

          if (KEY === "ArrowDown") {
            nextIx = Math.min(btnEls.length - 1, activeIx + 1);
            ev.preventDefault();
          } else if (KEY === "ArrowUp") {
            nextIx = Math.max(0, activeIx - 1);
            ev.preventDefault();
          } else if (KEY === "Home") {
            nextIx = 0;
            ev.preventDefault();
          } else if (KEY === "End") {
            nextIx = btnEls.length - 1;
            ev.preventDefault();
          } else if (KEY === "Enter" || KEY === " ") {
            ev.preventDefault();
            const btnEl = btnEls[Math.max(0, activeIx)];
            const uuid  = btnEl?.dataset?.uuid || null;

            if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
            if (liveTip)  { liveTip.remove(); liveTip = null; }

            resolve(uuid);
            dlg.close();
            return;
          } else if (KEY === "Escape") {
            ev.preventDefault();

            if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
            if (liveTip)  { liveTip.remove(); liveTip = null; }

            resolve(null);
            dlg.close();
            return;
          } else {
            return;
          }

          if (nextIx !== activeIx) {
            const btnEl = btnEls[nextIx];
            $btns.removeClass("is-active");
            btnEl.classList.add("is-active");
            btnEl.focus({ preventScroll: true });

            // keep in view
            if (wrapEl && btnEl) {
              const c = wrapEl.getBoundingClientRect();
              const e = btnEl.getBoundingClientRect();
              const pad = 8;
              if (e.top < c.top + pad) wrapEl.scrollTop -= (c.top + pad - e.top);
              else if (e.bottom > c.bottom - pad) wrapEl.scrollTop += (e.bottom - (c.bottom - pad));
            }

            // clear tooltip when moving with keyboard
            if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
            if (liveTip)  { liveTip.remove(); liveTip = null; }

            if (typeof playMove === "function") playMove();
          }
        });

        // Safety: if dialog closes while tooltip is up, remove it
        Hooks.once("closeDialog", () => {
          if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
          if (liveTip)  { liveTip.remove(); liveTip = null; }
        });
      };

      Hooks.once("renderDialog", onRender);
      dlg.render(true);
    });

    return chosenSkillUuid || null;
  }

  // --- 1. Resolve actor for this user --------------------------------------

  const actor = resolveActorForUser(game.user);
  if (!actor) {
    ui.notifications.warn("Could not find an actor for this user to use items.");
    return;
  }

  const actorProps = actor.system?.props ?? {};
  const consumableMap = actorProps.consumable_list ?? {};

  const entries = Object.values(consumableMap);
  if (!entries.length) {
    ui.notifications.warn("You have no consumable items to use.");
    return;
  }

  // --- 2. Resolve actual Item documents & filter to real consumables -------

  const candidatePromises = entries.map(async entry => {
    const uuid = entry.uuid;
    if (!uuid) return null;

    const item = await fromUuid(uuid);
    if (!item) return null;

    const itemProps = item.system?.props ?? {};

    // Safety: only keep items that are actual "consumable"
    if (itemProps.item_type !== "consumable") return null;

    const isUnique = !!itemProps.isUnique;

    // Prefer live quantity on the Item; fallback to cached "quantity" on container
    let quantity = null;
    if (!isUnique) {
      const liveQty = Number(itemProps.item_quantity ?? NaN);
      const cachedQty = Number(entry.quantity ?? NaN);
      if (Number.isFinite(liveQty)) quantity = liveQty;
      else if (Number.isFinite(cachedQty)) quantity = cachedQty;
      else quantity = 0;
    }

    return {
      entry,
      item,
      itemProps,
      isUnique,
      quantity
    };
  });

  let candidates = (await Promise.all(candidatePromises)).filter(Boolean);

  // Remove non-unique items that have 0 quantity
  candidates = candidates.filter(c => c.isUnique || (c.quantity ?? 0) > 0);

  if (!candidates.length) {
    ui.notifications.warn("You have no usable consumable items (all quantities are 0).");
    return;
  }

  // Sort by name for a stable order
  candidates.sort((a, b) => a.entry.name.localeCompare(b.entry.name, game.i18n.lang));

  // For quick lookup by Item UUID
  const byItemUuid = new Map();
  for (const c of candidates) {
    byItemUuid.set(c.item.uuid, c);
  }

    // --- 3. Build Item selection dialog (JRPG round buttons) ------------------

  const itemRowsHtml = candidates.map(c => {
    const { entry, item, isUnique, quantity } = c;
    const name      = entry.name ?? item.name ?? "(No name)";
    const img       = item.img || item.system?.img || "icons/svg/potion.svg";
    const descHtml  = entry.consume_description ?? item.system?.props?.description ?? "";
    const descPlain = stripTags(descHtml);
    const tooltip   = htmlEscape(descPlain);
    const qtyLabel  = isUnique ? "∞" : String(quantity ?? 0);

    return `
      <div class="jrpg-row">
        <button type="button"
                class="jrpg-skill-btn"
                data-uuid="${htmlEscape(item.uuid)}"
                data-desc="${htmlEscape(descPlain)}"
                title="${tooltip}">
          <img class="jrpg-skill-icon" src="${htmlEscape(img)}" alt="" />
          <span class="jrpg-skill-label">${htmlEscape(name)}</span>
          <div class="jrpg-costs">
            <span class="jrpg-cost">x${htmlEscape(qtyLabel)}</span>
          </div>
        </button>
      </div>
    `;
  }).join("");

    const itemDialogContent = `
    <style>
      .jrpg-wrap {
        max-height: 460px;
        overflow: auto;
        padding: 8px;
      }
      .jrpg-row {
        position: relative;
      }
      .jrpg-skill-btn {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        margin: 6px 0;
        padding: 8px 12px;
        border: 2px solid rgba(120,78,20,.9);
        outline: none;
        border-radius: 9999px;
        box-shadow:
          0 2px 0 rgba(0,0,0,.25),
          inset 0 0 0 1px rgba(255,255,255,.25);
        background: linear-gradient(#f2d9a2,#e1c385);
        font-weight: 600;
        font-size: 14px;
        text-align: left;
        cursor: pointer;
        transition: filter .05s, transform .05s, box-shadow .05s;
      }
      .jrpg-skill-btn:hover {
        filter: brightness(1.05);
        transform: translateY(-1px);
      }
      .jrpg-skill-btn:active {
        transform: translateY(0);
        box-shadow:
          0 1px 0 rgba(0,0,0,.3),
          inset 0 0 0 1px rgba(255,255,255,.25);
      }
      .jrpg-skill-btn:focus,
      .jrpg-skill-btn.is-active {
        box-shadow:
          0 0 0 3px rgba(255,255,255,.6),
          0 0 0 6px rgba(120,78,20,.55),
          0 2px 0 rgba(0,0,0,.25);
      }
      .jrpg-skill-icon {
        width: 24px;
        height: 24px;
        image-rendering: pixelated;
        flex: 0 0 24px;
        border-radius: 4px;
        box-shadow: 0 0 0 1px rgba(0,0,0,.15) inset;
        background: rgba(0,0,0,.05);
      }
      .jrpg-skill-label {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
      }
      .jrpg-costs {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .jrpg-cost {
        font-weight: 550;
        font-style: italic;
        color: #3a2a14;
        text-shadow: none;
        letter-spacing: .4px;
        font-size: 13px;
      }
      /* Tooltip bubble (same style family as Skill picker) */
      .jrpg-tip {
        position: fixed;
        z-index: 999999;
        max-width: 340px;
        padding: 8px 10px;
        border: 2px solid rgba(80,50,12,.95);
        border-radius: 10px;
        background: #f7f1e3;
        color: #2b2b2b;
        box-shadow: 0 6px 18px rgba(0,0,0,.35);
        font-size: 13px;
        line-height: 1.2;
        font-weight: 600;
        pointer-events: none;
      }
    </style>
    <div class="jrpg-wrap" tabindex="-1">
      ${itemRowsHtml}
    </div>
  `;

    // Use the same interaction pattern as the Skill dialog:
  // click = choose item; ESC = cancel.
  const chosenItemUuid = await new Promise(resolve => {
    const dlg = new Dialog(
      {
        title: "Choose Item",
        content: itemDialogContent,
        buttons: {}
      },
      { width: 420 }
    );

    // Small helper to spawn the tooltip near the hovered button
    function createTip(text, anchorEl) {
      const tip = document.createElement("div");
      tip.className = "jrpg-tip";
      tip.textContent = text;
      document.body.appendChild(tip);

      const r   = anchorEl.getBoundingClientRect();
      const pad = 8;

      const top  = Math.max(
        8,
        Math.min(window.innerHeight - tip.offsetHeight - 8,
                 r.top + (r.height - tip.offsetHeight) / 2)
      );
      const left = Math.min(
        window.innerWidth - tip.offsetWidth - 8,
        r.right + pad
      );

      tip.style.top  = `${top}px`;
      tip.style.left = `${left}px`;
      return tip;
    }

    const onRender = (app, html) => {
      if (app.id !== dlg.id) return;

      let liveTip  = null;
      let tipTimer = null;

      const $wrap = html.find(".jrpg-wrap");
      const wrapEl = $wrap.get(0);
      const $btns = html.find(".jrpg-skill-btn");

      // Initial focus
      const first = $btns.get(0);
      if (first) {
        first.classList.add("is-active");
        first.focus({ preventScroll: true });
      }

      // Hover with mouse: move highlight + play cursor sound + tooltip
      html.on("mouseenter", ".jrpg-skill-btn", ev => {
        const btn = ev.currentTarget;

        $btns.removeClass("is-active");
        btn.classList.add("is-active");
        btn.focus({ preventScroll: true });
        playMove();

        // clear old tooltip
        if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
        if (liveTip)  { liveTip.remove(); liveTip = null; }

        const text = btn?.dataset?.desc || "";
        if (!text) return;

        // short delay to feel snappy but not jittery (matches Skill dialog feel)
        tipTimer = setTimeout(() => {
          liveTip = createTip(text, btn);
        }, 120);
      });

      html.on("mouseleave", ".jrpg-skill-btn", () => {
        if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
        if (liveTip)  { liveTip.remove(); liveTip = null; }
      });

      // Click to choose
      html.on("click", ".jrpg-skill-btn", ev => {
        const btn  = ev.currentTarget;
        const uuid = btn?.dataset?.uuid || null;

        if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
        if (liveTip)  { liveTip.remove(); liveTip = null; }

        resolve(uuid);
        dlg.close();
      });

      // Simple keyboard navigation: Up/Down + Enter + Esc
      $wrap.on("keydown", ev => {
        const KEY = ev.key;
        const btnEls = $btns.toArray();
        if (!btnEls.length) return;

        const activeIx = btnEls.findIndex(b => b.classList.contains("is-active"));
        let nextIx = activeIx >= 0 ? activeIx : 0;

        if (KEY === "ArrowDown") {
          nextIx = Math.min(btnEls.length - 1, activeIx + 1);
          ev.preventDefault();
        } else if (KEY === "ArrowUp") {
          nextIx = Math.max(0, activeIx - 1);
          ev.preventDefault();
        } else if (KEY === "Home") {
          nextIx = 0;
          ev.preventDefault();
        } else if (KEY === "End") {
          nextIx = btnEls.length - 1;
          ev.preventDefault();
        } else if (KEY === "Enter" || KEY === " ") {
          ev.preventDefault();
          const btn = btnEls[Math.max(0, activeIx)];
          const uuid = btn?.dataset?.uuid || null;

          if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
          if (liveTip)  { liveTip.remove(); liveTip = null; }

          resolve(uuid);
          dlg.close();
          return;
        } else if (KEY === "Escape") {
          ev.preventDefault();

          if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
          if (liveTip)  { liveTip.remove(); liveTip = null; }

          resolve(null);
          dlg.close();
          return;
        } else {
          return;
        }

        if (nextIx !== activeIx) {
          const btn = btnEls[nextIx];
          $btns.removeClass("is-active");
          btn.classList.add("is-active");
          btn.focus({ preventScroll: true });

          // keep in view
          if (wrapEl && btn) {
            const c = wrapEl.getBoundingClientRect();
            const e = btn.getBoundingClientRect();
            const pad = 8;
            if (e.top < c.top + pad) wrapEl.scrollTop -= (c.top + pad - e.top);
            else if (e.bottom > c.bottom - pad) wrapEl.scrollTop += (e.bottom - (c.bottom - pad));
          }

          // clear tooltip when moving with keyboard
          if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
          if (liveTip)  { liveTip.remove(); liveTip = null; }

          // Play cursor move sound when selection actually changed
          playMove();
        }
      });

      // Safety: if dialog closes while tooltip is up, remove it
      Hooks.once("closeDialog", () => {
        if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
        if (liveTip)  { liveTip.remove(); liveTip = null; }
      });
    };

    Hooks.once("renderDialog", onRender);
    dlg.render(true);
  });

  if (!chosenItemUuid) {
    // cancelled
    return;
  }

  const chosen = byItemUuid.get(chosenItemUuid);
  if (!chosen) {
    ui.notifications.error("Could not resolve the chosen item.");
    return;
  }

  const { item, itemProps, isUnique } = chosen;

  // --- 4. Resolve Active Skills inside the item -----------------------------

  const activeContainer = itemProps.item_skill_active ?? {};
  const skillEntries = Object.values(activeContainer);

  if (!skillEntries.length) {
    ui.notifications.warn("This item has no Active skills wired into it.");
    return;
  }

  let chosenSkillUuid = null;

  if (skillEntries.length === 1) {
    chosenSkillUuid = skillEntries[0].uuid;
  } else {
    // Ask player which skill to use from this item
    chosenSkillUuid = await pickSkillFromItem(item, skillEntries);
  }

  if (!chosenSkillUuid) {
    // Player cancelled the skill choice
    return;
  }

  const skillItem = await fromUuid(chosenSkillUuid);
  if (!skillItem) {
    ui.notifications.error("Could not resolve the selected Skill inside the item.");
    return;
  }

  // --- 6. Call ActionDataFetch with chosen skill (Item-origin) -------------

  const adfMacro = game.macros.getName(ACTION_DATA_FETCH_NAME);
  if (!adfMacro) {
    return ui.notifications.error(`Macro "${ACTION_DATA_FETCH_NAME}" not found or no permission.`);
  }

  // Optional: we can pass explicit targets, or let ADF read game.user.targets.
  const targets = Array.from(game.user?.targets ?? [])
    .map(t => t.document?.uuid)
    .filter(Boolean);

  const payload = {
    // Tell ActionDataFetch this came from an Item, not the normal Skill button.
    source: "Item",

    // Use the same field name ActionDataFetch already looks for:
    attacker_uuid: actor.uuid,

    // This is the actual Skill Item wired into the consumable.
    skillUuid: skillItem.uuid,

    // Extra info in case you want to use it later in the pipeline:
    itemUuid: item.uuid,
    itemName: item.name,

    // Targets (or leave empty and ADF will read game.user.targets)
    targets
  };

  await adfMacro.execute({
    __AUTO: true,
    __PAYLOAD: payload
  });
})();
