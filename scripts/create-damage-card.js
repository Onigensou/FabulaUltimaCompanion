// scripts/create-damage-card.js
// ──────────────────────────────────────────────────────────
//  Create Damage Card (module version, speakerless) · V12
//  Exposes: game.modules.get('fabula-ultima-companion')?.api.createDamageCard(payload)
//  NEW: Short-window Damage Card batching / grouping.
//       Multiple damage cards created very close together are rendered into
//       ONE Foundry ChatMessage, reducing chat-message spam and performance dips.
// ──────────────────────────────────────────────────────────

(function initFUCreateDamageCard() {
  // Global namespace
  window.FUCompanion = window.FUCompanion || {};

  // ------------------------- config -------------------------
  const MODULE_NS = "fabula-ultima-companion";
  const BATCH_WINDOW_MS = 300; // Tuning knob: larger catches more consecutive cards, smaller feels snappier.
  const CARD_MARKER = "fu-damage-card"; // Unique marker detected by render hook.
  const GROUP_MARKER = "fu-damage-card-group";

  // ------------------------- helpers -------------------------
  const S = (v, d = "(None)") => {
    try {
      const s = (v ?? "").toString().trim();
      return s.length ? s : d;
    } catch {
      return d;
    }
  };
  const N = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const FALLBACK_IMG = "icons/svg/mystery-man.svg";

  function clone(value, fallback = null) {
    try {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    } catch (_e) {}
    try {
      return structuredClone(value);
    } catch (_e) {}
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_e) {}
    return fallback;
  }

  // Prefer the Actor's Profile/Portrait image for cards.
  // Falls back to token texture if the actor image isn't available.
  async function tokenImgFromUuid(uuid) {
    try {
      if (!uuid) return FALLBACK_IMG;

      const doc = await fromUuid(uuid);

      // Normalize to TokenDocument (tok) and Actor (actor)
      const tok =
        doc?.isToken ? doc :
        (doc?.token ?? null);

      const actor =
        doc?.actor ??
        tok?.actor ??
        (doc?.type === "Actor" ? doc : null) ??
        tok?.document?.actor ??
        null;

      // 1) Use Actor profile image (portrait) FIRST
      if (actor?.img) return actor.img;

      // 2) Then try the prototype token portrait (static)
      if (actor?.prototypeToken?.texture?.src) return actor.prototypeToken.texture.src;

      // 3) Finally fall back to whatever the token is using (may be animated)
      return tok?.texture?.src ||
             tok?.document?.texture?.src ||
             tok?.img ||
             FALLBACK_IMG;
    } catch {
      return FALLBACK_IMG;
    }
  }

  async function guessAttackerByName(name) {
    const t = canvas?.tokens?.placeables?.find(t => (t.actor?.name || t.name) === name);
    return t?.document?.uuid ?? "";
  }

  // ------------------ PERSISTENT RENDER HOOK ------------------
  // Runs for every message on every client; only acts on our cards.
  Hooks.on("renderChatMessage", (_msg, htmlJQ) => {
    const root = htmlJQ?.[0];
    if (!root) return;

    // Only proceed if this message contains at least one damage card marker.
    const markers = Array.from(root.querySelectorAll(`[data-fu-card="${CARD_MARKER}"]`));
    if (!markers.length) return;

    try {
// 1) Speakerless: hide the message header everywhere.
// IMPORTANT:
// Do NOT remove the header node completely.
// Some modules, such as Chat Portrait, expect .message-header to still exist.
const header = root.querySelector(".message-header");
if (header) {
  header.style.display = "none";
  header.style.height = "0";
  header.style.minHeight = "0";
  header.style.margin = "0";
  header.style.padding = "0";
  header.style.overflow = "hidden";
  header.setAttribute("aria-hidden", "true");
}

const content = root.querySelector(".message-content");
if (content) {
  content.style.marginTop = "0";
  content.style.paddingTop = "0";
}

      // 2) Interactivity: bind EACH shell independently.
      const shells = Array.from(root.querySelectorAll(".fu-shell"));
      for (const shell of shells) {
        if (shell.dataset.fuDamageBound === "1") continue;
        shell.dataset.fuDamageBound = "1";

        const details = shell.querySelector(".fu-details");
        if (!details) continue;

        const setOpen = (open) => {
          shell.dataset.open = open ? "true" : "false";
          if (open) {
            const full = details.scrollHeight;
            details.style.maxHeight = full + "px";
            details.style.paddingTop = ".35rem";
            details.style.paddingBottom = ".35rem";
          } else {
            details.style.maxHeight = "0px";
            details.style.paddingTop = "0";
            details.style.paddingBottom = "0";
          }
        };
        setOpen(false);

        shell.addEventListener("click", (ev) => {
          if (ev.target.closest("a, button")) return;
          setOpen(shell.dataset.open !== "true");
        });

        if ("ResizeObserver" in window) {
          const ro = new ResizeObserver(() => {
            if (shell.dataset.open === "true") {
              details.style.maxHeight = details.scrollHeight + "px";
            }
          });
          ro.observe(details);
        }
      }

      // 3) Number roll-up: animate EACH number in grouped messages.
      const rollEls = Array.from(root.querySelectorAll(".fu-rollnum"));
      for (const rollEl of rollEls) {
        if (rollEl.dataset.fuRollBound === "1") continue;
        rollEl.dataset.fuRollBound = "1";

        const final = Math.max(0, Number(rollEl.dataset.final || 0));
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        const fmt = (n) => n.toLocaleString?.() ?? String(n);

        if (reduce || !final) {
          rollEl.textContent = fmt(final);
          continue;
        }

        let started = false;
        const dur = 800;
        const startVal = 1;
        const run = () => {
          if (started) return;
          started = true;
          const t0 = performance.now();
          const frame = (now) => {
            const p = Math.min(1, (now - t0) / dur);
            const curr = Math.max(startVal, Math.floor(startVal + (final - startVal) * (1 - Math.pow(1 - p, 3))));
            rollEl.textContent = fmt(curr);
            if (p < 1) requestAnimationFrame(frame);
            else rollEl.textContent = fmt(final);
          };
          requestAnimationFrame(frame);
        };

        if ("IntersectionObserver" in window) {
          const io = new IntersectionObserver((entries, obs) => {
            for (const e of entries) {
              if (e.isIntersecting) {
                run();
                obs.unobserve(e.target);
              }
            }
          }, { root: document, rootMargin: "0px", threshold: 0.1 });
          io.observe(rollEl);
        } else {
          run();
        }
      }
    } catch (e) {
      console.warn("[FU CreateDamageCard] render hook error:", e);
    }
  });

  // --------------------- SINGLE CARD HTML RENDER ---------------------
  async function renderDamageCardHTML(P_in) {
    const P = P_in ?? {};

    // Parse payload
    const attackerName  = S(P.attackerName, "System");
    const attackerUuid  = S(P.attackerUuid, "");
    const attackRange   = S(P.attackRange, "(None)");
    const sourceType    = S(P.sourceType , "(None)");
    const targetName    = S(P.targetName , "Unknown Target");
    const targetUuid    = S(P.targetUuid , "");

    const valueType     = S(P.valueType, "hp");
    const changeKey     = S(P.changeKey, "hpReduction");
    const elementType   = S(P.elementType, "elementless");
    const weaponType    = S(P.weaponType, "none_ef");

    const affinityCode  = S(P.affinityCode, "NE");
    const effLabel      = S(P.effectivenessLabel, "Neutral");

    const baseValue     = N(P.baseValue, 0);
    const finalValue    = N(P.finalValue, baseValue);
    let   shownAmount   = N(P.displayedAmount, Math.abs(finalValue || baseValue));
    if (!Number.isFinite(shownAmount) || shownAmount < 0) shownAmount = 0;

    const shieldBreak   = !!P.shieldBreak;
    const affected      = (typeof P.affected === "boolean") ? P.affected : true;
    const noEffectReason= P.noEffectReason ?? null;

    const modeMiss = String(P.mode || "").toLowerCase() === "miss" || (!!P.miss);
    const isMiss   = modeMiss || (P.affected === false && String(P.noEffectReason || "").toLowerCase() === "miss");

    // Images
    const targetImg   = await tokenImgFromUuid(targetUuid);
    const attackerId  = attackerUuid || await guessAttackerByName(attackerName);
    const attackerImg = await tokenImgFromUuid(attackerId);

    // Colors
    const COLOR = {
      physical:"#111111", fire:"#e25822", ice:"#5ab3d4", air:"#48c774",
      earth:"#8b5e3c", bolt:"#9b59b6", light:"#a38b50", dark:"#4b0082",
      poison:"#2e8b57", mp:"#2e7bd6", shield:"#888888", heal:"#2ecc71"
    };
    const GLOW = {
      physical:"rgba(0,0,0,.28)", fire:"rgba(226,88,34,.45)", ice:"rgba(90,179,212,.45)",
      air:"rgba(72,199,116,.45)", earth:"rgba(139,94,60,.45)", bolt:"rgba(155,89,182,.45)",
      light:"rgba(163,139,80,.45)", dark:"rgba(75,0,130,.45)", poison:"rgba(46,139,87,.45)",
      mp:"rgba(46,124,214,.45)", shield:"rgba(136,136,136,.40)", heal:"rgba(46,204,113,.48)"
    };
    const COLOR_MISS = "#777777";
    const GLOW_MISS  = "rgba(0,0,0,.10)";

    const isRecovery  = changeKey.endsWith("Recovery");
    const elemKey     = (valueType === "hp" ? elementType : (valueType === "mp" ? "mp" : "shield")).toLowerCase();
    const elemNice    = (valueType === "hp" && elementType !== "elementless")
                          ? elementType.charAt(0).toUpperCase() + elementType.slice(1)
                          : (valueType === "mp" ? "Mind" : valueType === "shield" ? "Shield" : "Damage");
    const colorKey    = (valueType === "hp") ? (isRecovery ? "heal" : (COLOR[elemKey] ? elemKey : "physical"))
                                           : (valueType === "mp" ? "mp" : "shield");

    const dmgColor    = isMiss ? COLOR_MISS : COLOR[colorKey];
    const glowColor   = isMiss ? GLOW_MISS  : GLOW[colorKey];

    const wpnKey      = (weaponType || "").split("_")[0];
    const wpnNice     = wpnKey && wpnKey !== "none" ? (wpnKey[0].toUpperCase() + wpnKey.slice(1)) : "(None)";
    const effTag      = effLabel && effLabel !== "Neutral" ? `<span style="font-weight:800;">${effLabel}</span>` : "Neutral";

    const isImmune =
      /immune/i.test(effLabel) ||
      /^(im|imm|immune)$/i.test(affinityCode) ||
      (affected === false && /immune/i.test(String(noEffectReason || "")));

    const isSuper     = !isImmune && (/vuln|weak|super/i.test(effLabel) || /^(v|vu|wk|se)$/i.test(affinityCode));
    const isResisted  = !isImmune && (/resist|half/i.test(effLabel)     || /^(re|rs|rh)$/i.test(affinityCode));

    const numberHTML = isImmune
      ? `<span class="fu-immune" style="font-size:28px;font-weight:900;letter-spacing:.5px;color:#777;text-transform:uppercase;text-shadow:0 0 8px rgba(0,0,0,.06);">IMMUNE</span>`
      : (isMiss
        ? `<span class="fu-miss-text" style="font-size:38px;font-weight:900;letter-spacing:.5px;color:${COLOR_MISS};text-shadow:0 0 18px ${GLOW_MISS},0 0 8px ${GLOW_MISS};text-transform:uppercase;line-height:1;">MISS</span>`
        : `<span class="fu-rollnum" data-final="${Math.max(0, Math.abs(shownAmount))}" style="font-size:42px;font-weight:900;font-style:italic;line-height:1;color:${dmgColor};text-shadow:0 0 18px ${glowColor},0 0 8px ${glowColor};will-change:contents;">${Math.max(0, Math.abs(shownAmount))}</span>`
      );

    const typeHTML = isMiss ? "" : `
      <div style="font-size:12px;font-weight:800;text-transform:uppercase;opacity:.9;color:#333;text-align:right;">
        ${isRecovery ? "HEAL" : elemNice}
      </div>
    `;

    const compactRow = `
      <div class="fu-compact" style="position:relative;display:grid;grid-template-columns:1fr auto;align-items:center;gap:.6rem;min-height:56px;">
        <img src="${targetImg}" alt=""
             style="position:absolute;left:-14px;top:50%;transform:translateY(-55%);width:72px;height:72px;object-fit:contain;border:none;box-shadow:none;pointer-events:none;z-index:1;opacity:.98;">
        <div class="fu-right" style="margin-left:58px;display:flex;align-items:baseline;justify-content:flex-end;gap:.6rem;position:relative;z-index:2;">
          ${shieldBreak ? `<span style="color:#ff3838;font-weight:900;">BREAK!</span>` : ``}
          ${numberHTML}
        </div>
        ${typeHTML}
      </div>
    `;

    const baseLine = `${Math.abs(baseValue)}`;
    const detailRows = `
      <div class="fu-actors" style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:.4rem;margin-bottom:.35rem;">
        <div style="justify-self:end;"><img src="${attackerImg}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:6px;box-shadow:0 0 0 1px rgba(0,0,0,.25);"></div>
        <div style="justify-self:center;font-size:18px;opacity:.85;"><i class="fa-solid fa-swords"></i></div>
        <div style="justify-self:start;"><img src="${targetImg}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:6px;box-shadow:0 0 0 1px rgba(0,0,0,.25);"></div>
      </div>

      <div style="display:grid;grid-template-columns:160px 1fr;row-gap:.25rem;column-gap:.6rem;font-size:13px;">
        <div style="opacity:.8;">Attacker</div><div><b>${attackerName}</b></div>
        <div style="opacity:.8;">Target</div><div><b>${targetName}</b></div>
        <div style="opacity:.8;">Weapon Type</div><div>${wpnNice}</div>
        <div style="opacity:.8;">Base Damage</div><div>${baseLine}</div>
        <div style="opacity:.8;">Affinity</div><div>${effTag}</div>
        <div style="opacity:.8;">Range</div><div>${attackRange}</div>
        <div style="opacity:.8;">Source</div><div>${sourceType}</div>
      </div>
    `;

    let fxBadgeHTML = "";
    if (valueType === "hp" && !isRecovery && !isImmune && (isSuper || isResisted)) {
      const text = isSuper ? "Super Effective!" : "Resisted";
      const pill = isSuper
        ? { bg:"#f7ecd9", border:"#cfa057", color:"#8a4b22" }
        : { bg:"#eee",     border:"#999",    color:"#333" };
      fxBadgeHTML = `
        <div class="fu-fx-badge" aria-hidden="true" style="position:absolute;right:-6px;bottom:-10px;z-index:5;pointer-events:none;background:${pill.bg};color:${pill.color};border:1px solid ${pill.border};border-radius:999px;padding:.1rem .45rem;font-weight:800;font-size:11px;letter-spacing:.2px;box-shadow:0 2px 6px rgba(0,0,0,.14),0 1px 0 rgba(255,255,255,.6) inset;transform:translateZ(0);white-space:nowrap;">
          ${text}
        </div>
      `;
    }

    const srAlt = isImmune
      ? `${targetName}: Immune.`
      : (isMiss
          ? `${targetName} dodged the attack!`
          : (affected
              ? `${targetName}: ${Math.abs(shownAmount)} ${isRecovery ? "healing" : elemNice}.`
              : `No effect on ${targetName}${noEffectReason ? ` (${noEffectReason})` : ""}.`));

    // Add the data-fu-card marker so every client can detect this card.
    return `
      <div class="fu-card" data-fu-card="${CARD_MARKER}" style="font-family: Signika, sans-serif; letter-spacing:.2px;">
        <div class="fu-shell" data-open="false"
             style="border:1px solid #cfa057;background:#faf3e4;border-radius:10px;padding:.55rem .65rem;position:relative;overflow:visible;cursor:pointer;">
          <span class="sr-only" style="position:absolute;left:-9999px;top:auto;">${srAlt}</span>
          ${compactRow}
          ${fxBadgeHTML}
          <div class="fu-details" style="max-height:0;overflow:hidden;transition:max-height .22s ease, padding .22s ease;padding:0 .25rem;">
            <div style="border-top:1px dashed #cfa057;opacity:.6;margin:.45rem 0;"></div>
            ${detailRows}
            <div style="height:.25rem;"></div>
          </div>
        </div>
      </div>
    `;
  }

  // --------------------- DAMAGE CARD BATCHER ---------------------
  const DamageCardBatcher = (() => {
    let queue = [];
    let timer = null;
    let flushing = false;

    function schedule() {
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = null;
        flush().catch(err => console.error("[FU CreateDamageCard][Batcher] flush failed:", err));
      }, BATCH_WINDOW_MS);
    }

    async function postPayloads(payloads) {
      const safePayloads = payloads.map(p => clone(p, {}) || {});
      const htmlParts = [];

      for (const p of safePayloads) {
        try {
          htmlParts.push(await renderDamageCardHTML(p));
        } catch (err) {
          console.warn("[FU CreateDamageCard][Batcher] Failed to render one damage card:", err, p);
        }
      }

      if (!htmlParts.length) return { ok: false, reason: "no-rendered-cards" };

      const grouped = htmlParts.length > 1;
      const content = grouped
        ? `
          <div class="${GROUP_MARKER}" data-fu-card-group="${GROUP_MARKER}" style="display:flex;flex-direction:column;gap:.45rem;">
            ${htmlParts.join("\n")}
          </div>
        `
        : htmlParts[0];

      const speaker = { alias: "" };

     const chatData = {
  user: game.userId,
  speaker,
  content,
  flags: {
    [MODULE_NS]: {
      damageCard: {
        payload: safePayloads[0] ?? null,
        payloads: safePayloads,
        grouped,
        count: safePayloads.length,
        batchWindowMs: BATCH_WINDOW_MS,
        createdAt: new Date().toISOString()
      },
      damageCardGroup: grouped
        ? {
            payloads: safePayloads,
            count: safePayloads.length,
            batchWindowMs: BATCH_WINDOW_MS
          }
        : null
    }
  }
};

// Foundry V12 renamed ChatMessage "type" into "style".
// Use the new field to avoid the deprecation warning.
if (CONST.CHAT_MESSAGE_STYLES?.OTHER !== undefined) {
  chatData.style = CONST.CHAT_MESSAGE_STYLES.OTHER;
} else {
  // Fallback for older Foundry versions.
  chatData.type = CONST.CHAT_MESSAGE_TYPES.OTHER;
}

const msg = await ChatMessage.create(chatData);

      return { ok: true, grouped, count: safePayloads.length, messageId: msg?.id ?? null };
    }

    async function flush() {
      if (flushing) {
        schedule();
        return { ok: true, deferred: true };
      }

      if (!queue.length) return { ok: true, count: 0 };

      flushing = true;
      const batch = queue;
      queue = [];

      try {
        return await postPayloads(batch);
      } finally {
        flushing = false;
        if (queue.length) schedule();
      }
    }

    function enqueue(payload) {
      queue.push(clone(payload, {}) || {});
      schedule();
      return {
        ok: true,
        queued: true,
        pendingCount: queue.length,
        batchWindowMs: BATCH_WINDOW_MS
      };
    }

    async function createImmediate(payloadOrPayloads) {
      const payloads = Array.isArray(payloadOrPayloads) ? payloadOrPayloads : [payloadOrPayloads];
      return await postPayloads(payloads.filter(Boolean));
    }

    return {
      enqueue,
      flush,
      createImmediate,
      getPendingCount: () => queue.length
    };
  })();

  // --------------------- PUBLIC API ---------------------
  async function createDamageCard(P_in) {
    const P = P_in ?? {};

    // Escape hatch for debugging: pass { batch: false } or { disableBatch: true }
    // if you ever need to force old one-message-per-card behavior temporarily.
    const disableBatch = !!(
      P?.disableBatch === true ||
      P?.batch === false ||
      P?.meta?.disableDamageCardBatch === true
    );

    if (disableBatch) {
      return await DamageCardBatcher.createImmediate(P);
    }

    // Important: return immediately so callers that `await createDamageCard()` do
    // not serialize the batch window and accidentally prevent grouping.
    return DamageCardBatcher.enqueue(P);
  }

  async function createDamageCards(payloads = {}) {
    const list = Array.isArray(payloads) ? payloads : (Array.isArray(payloads?.payloads) ? payloads.payloads : []);
    for (const p of list) DamageCardBatcher.enqueue(p);
    return { ok: true, queued: true, count: list.length, batchWindowMs: BATCH_WINDOW_MS };
  }

  // Expose API
  FUCompanion.createDamageCard = createDamageCard;
  FUCompanion.createDamageCards = createDamageCards;
  FUCompanion.damageCardBatcher = DamageCardBatcher;

  Hooks.once("ready", () => {
    const mod = game.modules.get(MODULE_NS);
    if (mod) {
      mod.api = mod.api || {};
      mod.api.createDamageCard = createDamageCard;
      mod.api.createDamageCards = createDamageCards;
      mod.api.damageCardBatcher = DamageCardBatcher;
    }
  });
})();