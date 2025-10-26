// scripts/invokeButtons.js — Foundry VTT v12
// Invoke Trait + Invoke Bond (merged)
// - [data-fu-trait]: reroll up to two accuracy dice ONCE per action
// - [data-fu-bond] : add a flat +1..+3 to accuracy.total ONCE per action
// Requires your CreateActionCard macro to persist payload on the message flag:
//   await posted.setFlag("fabula-ultima-companion", "actionCard", { payload: PAYLOAD });

(() => {
  const MODULE_NS = "fabula-ultima-companion";
  const CARD_FLAG = "actionCard";

  console.log("[fu-invokeButtons] script file loaded");

  // ---------- helpers (shared) ----------
  const esc = (v) => {
    const s = String(v ?? "");
    if (window.TextEditor?.escapeHTML) return TextEditor.escapeHTML(s);
    return s.replace(/[&<>"']/g, (m) => (
      m === "&" ? "&amp;" :
      m === "<" ? "&lt;"  :
      m === ">" ? "&gt;"  :
      m === '"' ? "&quot;":
                  "&#39;"
    ));
  };

  async function getPayload(chatMsg) {
    try {
      // getFlag is sync in V12; awaiting is harmless and keeps a uniform signature
      const f = await chatMsg.getFlag(MODULE_NS, CARD_FLAG);
      return f?.payload ?? f ?? null; // support {payload:{...}} and legacy {...}
    } catch (e) {
      console.warn("[fu-invokeButtons] getPayload failed:", e);
      return null;
    }
  }

  async function rebuildCard(nextPayload, oldMsg) {
    const cardMacro = game.macros.getName("CreateActionCard");
    if (!cardMacro) return ui.notifications.error('Macro "CreateActionCard" not found.');

    // Your CreateActionCard reads globals (__AUTO/__PAYLOAD)
    try {
      window.__AUTO = true;
      window.__PAYLOAD = nextPayload;
      await cardMacro.execute(); // no args: it uses the globals
    } finally {
      try { delete window.__AUTO; } catch {}
      try { delete window.__PAYLOAD; } catch {}
    }

    try { await oldMsg.delete(); } catch {}
  }

  async function getActorFromUuid(uuid) {
    if (!uuid) return null;
    try {
      const doc = await fromUuid(uuid);
      if (!doc) return null;
      if (doc?.actor) return doc.actor;                 // TokenDocument or embedded context
      if (doc?.type === "Actor") return doc;            // Actor doc
      return doc?.document?.actor ?? null;              // Fallback from embedded docs
    } catch {
      return null;
    }
  }

  function ensureOwner(actor, payload, what = "this action") {
  const initUid = payload?.meta?.ownerUserId || null;     // user who built the card
  const allow =
    game.user?.isGM ||
    actor?.isOwner === true ||
    (initUid && game.user?.id === initUid);

  if (!allow) ui.notifications?.warn(`Only the attacker’s owner (or GM) can ${what}.`);
  return allow;
}

  function lock(btn) {
    if (!btn) return true;
    if (btn.dataset.fuLock === "1") return true;
    btn.dataset.fuLock = "1";
    return false;
  }
  function unlock(btn) {
    if (btn) btn.dataset.fuLock = "0";
  }

  // ---------- Fabula / Ultima helpers ----------
function isVillainOrBoss(actor) {
  const P = actor?.system?.props ?? {};
  return !!(P.isVillain || P.isBoss); // sheet checkboxes on villain/boss sheets
}

function resourceKeyAndLabel(actor) {
  const useUltima = isVillainOrBoss(actor);
  return {
    key: useUltima ? "ultima_point" : "fabula_point",
    label: useUltima ? "Ultima Point" : "Fabula Point"
  };
}

function currentPoints(actor, key) {
  const P = actor?.system?.props ?? {};
  const n = Number(P?.[key] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function canPayInvoke(actor) {
  const { key, label } = resourceKeyAndLabel(actor);
  const cur = currentPoints(actor, key);
  return { ok: cur >= 1, key, label, cur };
}

async function payInvoke(actor) {
  const { key, label } = resourceKeyAndLabel(actor);
  const cur = currentPoints(actor, key);
  if (cur < 1) return { ok: false, key, label, cur };
  try {
    await actor.update({ [`system.props.${key}`]: cur - 1 });
    return { ok: true, key, label, cur: cur - 1 };
  } catch (e) {
    console.warn("[fu-invokeButtons] payInvoke failed:", e);
    return { ok: false, key, label, cur };
  }
}

  // Actor → die size for attribute label (e.g., "DEX"→d?)
  function dieSizeFor(actor, attr) {
    const k = String(attr || "").toLowerCase();
    const P = actor?.system?.props ?? {};
    const cur  = Number(P[`${k}_current`]);
    const base = Number(P[`${k}_base`]);
    const n = Number.isFinite(cur) ? cur : (Number.isFinite(base) ? base : 6);
    return [4, 6, 8, 10, 12, 20].includes(n) ? n : 6;
  }

  // Extract bonds in expected shape: { index, name, bonus, filled }
  function collectBonds(actor) {
    const P = actor?.system?.props ?? {};
    const bonds = [];
    for (let i = 1; i <= 6; i++) {
      const name = String(P[`bond_${i}`] ?? "").trim();
      if (!name) continue;
      const e1 = !!P[`emotion_${i}_1`];
      const e2 = !!P[`emotion_${i}_2`];
      const e3 = !!P[`emotion_${i}_3`];
      const filled = (e1 ? 1 : 0) + (e2 ? 1 : 0) + (e3 ? 1 : 0);
      const bonus = Math.min(3, Math.max(0, filled));
      bonds.push({ index: i, name, bonus, filled });
    }
    return bonds;
  }

  async function chooseBondDialog(bonds) {
    const viable = bonds.filter(b => b.bonus > 0);
    if (!viable.length) return null;
    const opts = viable
      .map(b => `<option value="${b.index}">${esc(b.name)} — +${b.bonus}</option>`)
      .join("");
    const content = `<form>
      <div class="form-group">
        <label>Choose a Bond to Invoke</label>
        <select name="bondIndex" style="width:100%;">${opts}</select>
      </div>
      <p style="margin:.4rem 0 0; font-size:12px; opacity:.75;">
        Bond bonus is +1 per filled emotion (max +3).
      </p>
    </form>`;
    return await new Promise(resolve => new Dialog({
      title: "Invoke Bond — Choose Bond",
      content,
      buttons: {
        ok:     { label: "Invoke", callback: html => resolve(Number(html[0].querySelector('[name="bondIndex"]').value)) },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "ok",
      // ✅ Close with window “X” acts like Cancel
      close: () => resolve(null)
    }).render(true));
  }

  // ---------- actions ----------
  async function handleInvokeTrait(btn, chatMsg) {
    const payload = await getPayload(chatMsg);
    if (!payload) return ui.notifications?.error("Invoke Trait: Missing payload on the card.");

    const invoked = payload?.meta?.invoked ?? { trait:false, bond:false };
    if (invoked.trait) return ui.notifications?.warn("Trait already invoked for this action.");

    const atkUuid  = payload?.meta?.attackerUuid ?? payload?.meta?.attacker_uuid ?? null;
    const attacker = await getActorFromUuid(atkUuid);
    if (!ensureOwner(attacker, payload, "Invoke Trait")) return;

    // 1) Pre-check resources (block immediately if none)
{
  const chk = canPayInvoke(attacker);
  if (!chk.ok) {
    ui.notifications?.warn(`Not enough ${chk.label}s (need 1).`);
    return;
  }
}

    const A = payload.accuracy;
    if (!A) return ui.notifications?.warn("No Accuracy check to reroll.");

    // Dialog to choose which die(s) to reroll — JRPG UI + local SFX
const ATTR_ICONS = {
  DEX: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/boot.png",
  MIG: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/asan.png",
  INS: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/book.png",
  WLP: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/stat.png"
};
const FALLBACK_ICON = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Item%20Icon/dice.png";
const iconFor = (attr) => ATTR_ICONS[(attr || "").toUpperCase()] ?? FALLBACK_ICON;

// SFX (local-only)
const SFX_MOVE    = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/CursorMove.mp3";
const SFX_CONFIRM = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Dice.wav";
const SFX_CANCEL  = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Cursor_Cancel.mp3";
async function playLocal(url, volume = 0.65) {
  try {
    if (globalThis.AudioHelper?.play) {
      await AudioHelper.play({ src: url, volume, loop: false }, true); // local-only
    } else {
      const a = new Audio(url); a.volume = volume; a.play().catch(()=>{});
    }
  } catch {}
}

const choice = await new Promise((resolve) => new Dialog({
  title: "Invoke Trait — Reroll",
  content: `<form>
    <style>
      .fu-root{ --parch-1:#f6ebd3; --parch-2:#efdfc3; --parch-3:#e7d3b1; --ink:#3b2a19; --shadow:rgba(0,0,0,.22); --accent:#e35151; }
      .fu-title{font-weight:700;margin:.25rem 0 .35rem;color:var(--ink);}
      .fu-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.6rem;margin:.2rem 0 .6rem;}
      .fu-card{
        position:relative; display:flex; align-items:center; gap:.6rem;
        padding:.6rem .75rem; border-radius:12px; cursor:pointer; user-select:none;
        color:var(--ink); border:3px solid rgba(87,58,33,.95);
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.45) 0%, rgba(255,255,255,.15) 22%, transparent 40%),
          linear-gradient(180deg, var(--parch-1) 0%, var(--parch-2) 55%, var(--parch-3) 100%);
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,.55),
          inset 0 0 0 2px rgba(255,255,255,.06),
          0 6px 14px var(--shadow);
        transition: filter .12s ease, box-shadow .12s ease, border-color .12s ease, transform .06s ease;
      }
      .fu-card:hover{ filter:brightness(1.04) saturate(1.03); }
      .fu-card:active{ transform:translateY(1px); }
      .fu-card.on{
        border-color: var(--accent);
        outline: 2px solid rgba(227,81,81,.35); outline-offset: 0;
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,.7),
          inset 0 0 0 2px rgba(255,255,255,.12),
          0 6px 14px var(--shadow),
          0 0 14px rgba(227,81,81,.55),
          0 0 28px rgba(227,81,81,.35);
        background:
          radial-gradient(120% 80% at 50% 0%, rgba(255,255,255,.65) 0%, rgba(255,255,255,.28) 22%, transparent 40%),
          linear-gradient(180deg, #fff3dc 0%, #f3e2bd 55%, #e8cea0 100%);
      }
      .fu-icon{width:40px;height:40px;object-fit:contain;border:none;background:transparent;border-radius:8px;}
      .fu-left{display:flex;align-items:center;gap:.5rem;min-width:0;}
      .fu-die{font-weight:800;white-space:nowrap;}
      .fu-spacer{flex:1 1 auto;}
      .fu-result{font-weight:900;font-size:22px;letter-spacing:.3px;}
      .fu-hint{font-size:12px;opacity:.75;margin:.25rem 0 0;color:var(--ink);}
      .fu-card[data-tip]::after{
        content: attr(data-tip); position:absolute; left:50%; bottom:100%; transform:translate(-50%,-6px);
        background:rgba(20,20,20,.92); color:#fff; padding:.3rem .5rem; border-radius:6px;
        font-size:12px; white-space:nowrap; box-shadow:0 2px 6px rgba(0,0,0,.35);
        opacity:0; pointer-events:none; transition:opacity .12s ease; z-index:1000;
      }
      .fu-card[data-tip]::before{
        content:""; position:absolute; left:50%; bottom:100%; transform:translate(-50%,2px);
        border:6px solid transparent; border-top-color:rgba(20,20,20,.92); opacity:0; transition:opacity .12s ease;
      }
      .fu-card[data-tip]:hover::after, .fu-card[data-tip]:hover::before{ opacity:1; }
    </style>

    <div class="fu-root">
      <div class="fu-title">Choose which die to reroll</div>

      <div class="fu-grid">
        <button type="button" class="fu-card" data-which="A" data-sel="0" data-tip="${A.A1}" title="${A.A1}">
          <div class="fu-left">
            <img class="fu-icon" src="${iconFor(A.A1)}" alt="">
            <div class="fu-die">d${A.dA}</div>
          </div>
          <div class="fu-spacer"></div>
          <div class="fu-result">${A.rA.total}</div>
        </button>

        <button type="button" class="fu-card" data-which="B" data-sel="0" data-tip="${A.A2}" title="${A.A2}">
          <div class="fu-left">
            <img class="fu-icon" src="${iconFor(A.A2)}" alt="">
            <div class="fu-die">d${A.dB}</div>
          </div>
          <div class="fu-spacer"></div>
          <div class="fu-result">${A.rB.total}</div>
        </button>
      </div>

      <p class="fu-hint">Click one or both to select. Click again to unselect.</p>
    </div>
  </form>`,
  buttons: {
    ok: {
      label: "Reroll",
      callback: async (html) => {
        await playLocal(SFX_CONFIRM, 0.9); // confirm sound (local)
        const root = html[0];
        const aOn = root.querySelector('[data-which="A"]')?.dataset.sel === "1";
        const bOn = root.querySelector('[data-which="B"]')?.dataset.sel === "1";
        const val = aOn && bOn ? "AB" : aOn ? "A" : bOn ? "B" : null;
        resolve(val);
      }
    },
    cancel: {
      label: "Cancel",
      callback: async () => { await playLocal(SFX_CANCEL, 0.8); resolve(null); }
    }
  },
  default: "ok",
  close: () => resolve(null),
  render: (html) => {
    const root = html[0];
    const btnA = root.querySelector('[data-which="A"]');
    const btnB = root.querySelector('[data-which="B"]');
    const okBtn = root.closest('.app')?.querySelector('.dialog-buttons button[data-button="ok"]');

    // move SFX with throttle; new Audio each time so quick moves won't cut off
    let lastMove = 0;
    const MOVE_COOLDOWN = 80;
    const tryMove = () => {
      const now = Date.now();
      if (now - lastMove < MOVE_COOLDOWN) return;
      lastMove = now;
      playLocal(SFX_MOVE, 0.65);
    };

    const toggle = (btn) => {
      btn.dataset.sel = btn.dataset.sel === "1" ? "0" : "1";
      btn.classList.toggle("on", btn.dataset.sel === "1");
      if (okBtn) okBtn.disabled = (btnA.dataset.sel !== "1" && btnB.dataset.sel !== "1");
    };

    [btnA, btnB].forEach((b) => {
      b.setAttribute("tabindex", "0");
      b.addEventListener("mouseenter", tryMove);
      b.addEventListener("focus", tryMove);
      b.addEventListener("click", (ev) => { ev.preventDefault(); toggle(b); });
      b.addEventListener("keydown", (ev) => {
        if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") { (b === btnA ? btnB : btnA).focus(); tryMove(); }
        if (ev.key === " " || ev.key === "Enter") { ev.preventDefault(); toggle(b); }
      });
    });

    if (okBtn) okBtn.disabled = true;
  }
}).render(true));

    if (!choice) {
      ui.notifications.info("Trait invoke cancelled.");
      return "CANCELLED";
    }

    // Spend 1 point now that the player confirmed the reroll
{
  const spend = await payInvoke(attacker);
  if (!spend.ok) {
    ui.notifications?.error(`Could not spend 1 ${spend.label}.`);
    return;
  }
}

    // Reroll
    const dA = dieSizeFor(attacker, A.A1);
    const dB = dieSizeFor(attacker, A.A2);
    const rA = (choice === "A" || choice === "AB")
      ? (await (new Roll(`1d${dA}`)).evaluate()).total
      : Number(A.rA.total);
    const rB = (choice === "B" || choice === "AB")
      ? (await (new Roll(`1d${dB}`)).evaluate()).total
      : Number(A.rB.total);

    const bonus = Number(A.checkBonus || 0);
    const total = rA + rB + bonus;
    const hr    = Math.max(rA, rB);

    // Crit/Fumble (keep your props)
    const critRange = Number(attacker?.system?.props?.critical_dice_range ?? 0);
    const minCrit   = Number(attacker?.system?.props?.minimum_critical_dice ?? 999);
    const isCrit    = (Math.abs(rA - rB) <= critRange) && (rA >= minCrit || rB >= minCrit);
    const fumbleTH  = Number(attacker?.system?.props?.fumble_threshold ?? -1);
    const isFumble  = (fumbleTH >= 0) ? (rA <= fumbleTH && rB <= fumbleTH) : false;

    // Build next payload
    const next = foundry.utils.deepClone(payload);
    next.meta = next.meta || {};
    next.meta.invoked = next.meta.invoked || { trait:false, bond:false };
    next.meta.invoked.trait = true;

    next.accuracy = {
      dA, dB,
      rA: { total: rA, result: rA },
      rB: { total: rB, result: rB },
      total, hr,
      isCrit, isBunny: (isCrit && rA !== rB), isFumble,
      A1: A.A1, A2: A.A2,
      checkBonus: bonus,
      hrUsed: next.meta?.ignoreHR ? null : hr
    };

    // Recompute preview damage (base-without-HR + new HR)
    const elem   = String(next?.meta?.elementType || "physical").toLowerCase();
    const healRx = /^(heal|healing|recovery|restore|restoration)$/i;
    const declaresHealing = healRx.test(elem);
    const ignoreHR = !!next?.meta?.ignoreHR;

    const prevCombined = Number(next?.meta?.baseValueStrForCard ?? 0);
    const prevHr       = Number(next?.meta?.hrBonus ?? 0);
    const baseNoHR     = declaresHealing ? prevCombined : Math.max(0, prevCombined - (ignoreHR ? 0 : prevHr));

    const newHrBonus   = (!declaresHealing && !ignoreHR) ? hr : 0;
    const newCombined  = declaresHealing ? baseNoHR : (baseNoHR + newHrBonus);

    next.meta.declaresHealing     = declaresHealing;
    next.meta.hasDamageSection    = (newCombined > 0);
    next.meta.hrBonus             = newHrBonus;
    next.meta.baseValueStrForCard = String(newCombined);

    if (next.advPayload) {
      next.advPayload.hr        = ignoreHR ? null : hr;
      next.advPayload.isCrit    = !!isCrit;
      next.advPayload.isFumble  = !!isFumble;
      next.advPayload.baseValue = declaresHealing ? `+${baseNoHR}` : String(newCombined);
    }

    await rebuildCard(next, chatMsg);
  }

  async function handleInvokeBond(btn, chatMsg) {
    const payload = await getPayload(chatMsg);
    if (!payload) return ui.notifications?.error("Invoke Bond: Missing payload on the card.");

    const invoked = payload?.meta?.invoked ?? { trait:false, bond:false };
    if (invoked.bond) return ui.notifications?.warn("Bond already invoked for this action.");

    const atkUuid  = payload?.meta?.attackerUuid ?? payload?.meta?.attacker_uuid ?? null;

    // We still gate by ownership, but we no longer read bonds from the actor.
    const attacker = await getActorFromUuid(atkUuid);
    if (!ensureOwner(attacker, payload, "Invoke Bond")) return;

    // 1) Pre-check resources (block immediately if none)
{
  const chk = canPayInvoke(attacker);
  if (!chk.ok) {
    ui.notifications?.warn(`Not enough ${chk.label}s (need 1).`);
    return;
  }
}

    const A = payload.accuracy;
    if (!A) return ui.notifications?.warn("No Accuracy check to modify.");

    // Prefer bonds from payload.meta (snapshot made by ActionDataFetch)
    const bondSnap = payload?.meta?.bonds || { list:[], viable:[] };
    const viable = Array.isArray(bondSnap.viable) ? bondSnap.viable
                 : Array.isArray(bondSnap.list)   ? bondSnap.list.filter(b => (b?.bonus||0) > 0)
                 : [];

    if (!viable.length) return ui.notifications?.warn("No eligible Bonds on this action.");

    // If multiple, ask the user; otherwise auto-pick
    let chosen = viable[0];
    if (viable.length > 1) {
      const opts = viable.map(b => `<option value="${b.index}">${esc(b.name)} — +${b.bonus}</option>`).join("");
      const content = `<form>
        <div class="form-group">
          <label>Choose a Bond to Invoke</label>
          <select name="bondIndex" style="width:100%;">${opts}</select>
        </div></form>`;
      const pick = await new Promise(res => new Dialog({
        title: "Invoke Bond — Choose Bond",
        content,
        buttons: {
          ok:     { label: "Invoke", callback: html => res(Number(html[0].querySelector('[name="bondIndex"]').value)) },
          cancel: { label: "Cancel", callback: () => res(null) }
        },
        default: "ok",
        close: () => res(null)
      }).render(true));

      if (pick == null) { ui.notifications.info("Bond invoke cancelled."); return "CANCELLED"; }
      chosen = viable.find(b => Number(b.index) === Number(pick)) ?? chosen;
    }

    {
  const spend = await payInvoke(attacker);
  if (!spend.ok) {
    ui.notifications?.error(`Could not spend 1 ${spend.label}.`);
    return;
  }
}

    const addBonus = Number(chosen.bonus || 0);
    if (!(addBonus > 0)) return ui.notifications?.warn("Chosen Bond gives no bonus.");

    const next = foundry.utils.deepClone(payload);
    next.meta = next.meta || {};
    next.meta.invoked = next.meta.invoked || { trait:false, bond:false };
    next.meta.invoked.bond = true;
    next.meta.bondInfo = { index: chosen.index, name: chosen.name, bonus: addBonus };

    const oldBonus = Number(A.checkBonus || 0);
    const newBonus = oldBonus + addBonus;
    const rA = Number(A.rA?.total ?? 0);
    const rB = Number(A.rB?.total ?? 0);
    const newTotal = rA + rB + newBonus;

    next.accuracy = {
      ...A,
      rA: { total: rA, result: A.rA?.result ?? rA },
      rB: { total: rB, result: A.rB?.result ?? rB },
      checkBonus: newBonus,
      total: newTotal
    };

    await rebuildCard(next, chatMsg);
  }

  // ---------- binder (single listener handles both buttons) ----------
  function bindInvokeButtons() {
    const root = document.querySelector("#chat-log") || document.body;
    if (!root || root.__fuInvokeButtonsBound) return;
    root.__fuInvokeButtonsBound = true;

    root.addEventListener("click", async (ev) => {
      // NOTE: keep selectors EXACTLY as used in your chat card HTML
      const btnTrait = ev.target.closest?.("[data-fu-trait]");
      const btnBond  = btnTrait ? null : ev.target.closest?.("[data-fu-bond]"); // avoid double hits

      if (!btnTrait && !btnBond) return;

      const btn = btnTrait || btnBond;
      if (lock(btn)) return;

      try {
        // Locate message (both buttons share same lookup)
        const msgEl   = btn.closest?.(".message");
        const msgId   = msgEl?.dataset?.messageId;
        const chatMsg = msgId ? game.messages.get(msgId) : null;
        if (!chatMsg) return;

        if (btnTrait) await handleInvokeTrait(btnTrait, chatMsg);
        else          await handleInvokeBond(btnBond,  chatMsg);
      } catch (err) {
        console.error(err);
        ui.notifications?.error("Invoke failed (see console).");
      } finally {
        unlock(btn);
      }
    }, { capture: false });

    console.log("[fu-invokeButtons] ready — installed chat listener");
  }

  // Bind even if loaded after 'ready'
  if (window.game?.ready) bindInvokeButtons();
  else Hooks.once("ready", bindInvokeButtons);
})();
