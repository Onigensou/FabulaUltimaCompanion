// ============================================================================
//  ActionAnimationHandler – Custom Skill Animation + Timing Gate (v3 - CLEAN)
//  - Supports BOTH damage actions and "no-damage" utility actions.
//  - Fixes caster/target resolution by enriching payload and publishing
//    globalThis.__PAYLOAD / globalThis.__TARGETS during script execution.
//  - This CLEAN build removes the heavy debug logs (keeps only minimal errors).
//
//  Usage:
//    - Called headless by Action System via macro.execute({ __AUTO:true, __PAYLOAD:{...} })
//    - For no-damage actions: pass __PAYLOAD.animationPurpose = "vfx_only"
//
//  Returns:
//    true  = a non-placeholder animation script ran AND the chosen gate resolved
//    false = no script / placeholder / error
// ============================================================================

return (async () => {
  let AUTO, PAYLOAD;
  if (typeof __AUTO !== "undefined") {
    AUTO = __AUTO;
    PAYLOAD = __PAYLOAD ?? {};
  } else {
    AUTO = false;
    PAYLOAD = globalThis.__PAYLOAD ?? {};
  }

  const isHeadless = !!AUTO;
  const hasPayload = PAYLOAD && typeof PAYLOAD === "object";
  if (!isHeadless && !hasPayload) return false;

  /* ======================= HTML → Plain Text helper ======================== */
  function htmlToPlain(html = "") {
    const container = document.createElement("div");
    container.innerHTML = html;

    const paragraphs = container.querySelectorAll("p");
    if (paragraphs.length > 0) {
      const lines = Array.from(paragraphs).map(p => (p.textContent || "").trimEnd());
      return lines.join("\n\n");
    }

    const text = container.textContent || container.innerText || "";
    return text;
  }

  /* ============================ Target normalization ======================== */
  async function normalizeTargets(rawTargets) {
    const list = Array.isArray(rawTargets) ? rawTargets : [];
    const resolved = [];

    for (let i = 0; i < list.length; i++) {
      const t = list[i];

      try {
        // UUID string
        if (typeof t === "string" && t.trim()) {
          const uuid = t.trim();
          const doc = (typeof fromUuid === "function") ? await fromUuid(uuid) : null;
          if (!doc) { resolved.push(t); continue; }

          // TokenDocument
          if (doc.documentName === "Token") {
            resolved.push(doc.object ?? doc);
            continue;
          }

          // ActorDocument -> active token
          if (doc.documentName === "Actor") {
            const tok = doc.getActiveTokens?.(true, true)?.[0] ?? null;
            resolved.push(tok ?? doc);
            continue;
          }

          resolved.push(doc);
          continue;
        }

        // Token placeable
        if (t?.document?.documentName === "Token") {
          resolved.push(t);
          continue;
        }

        // TokenDocument
        if (t?.documentName === "Token") {
          resolved.push(t.object ?? t);
          continue;
        }

        // Actor / ActorDocument
        if (t?.documentName === "Actor" || t?.actor) {
          const actor = t?.documentName === "Actor" ? t : t?.actor;
          const tok = actor?.getActiveTokens?.(true, true)?.[0] ?? null;
          resolved.push(tok ?? actor ?? t);
          continue;
        }

        resolved.push(t);
      } catch {
        resolved.push(t);
      }
    }

    return resolved;
  }

  const rawTargets = Array.isArray(PAYLOAD.targets) ? PAYLOAD.targets : [];
  const targets = await normalizeTargets(rawTargets);

  /* ================== Source / Target enrichment (BUGFIX) =================== */
  function toTokenPlaceable(x) {
    if (x?.document?.documentName === "Token") return x;      // Token placeable
    if (x?.documentName === "Token") return x.object ?? null; // TokenDocument
    return null;
  }

  function asUuid(x) {
    return (typeof x === "string" && x.includes(".")) ? x : null;
  }

  async function resolveCasterTokenFromPayload(p) {
    // 1) direct token refs
    const direct =
      p?.sourceTokenUuid || p?.casterTokenUuid || p?.tokenUuid || p?.tokenUUID || null;

    if (asUuid(direct) && typeof fromUuid === "function") {
      try {
        const doc = await fromUuid(direct);
        if (doc?.documentName === "Token") return doc.object ?? null;
      } catch {}
    }

    // 2) attackerUuid (pipeline)
    const attackerRef =
      p?.attackerUuid || p?.attackerUUID ||
      p?.meta?.attackerUuid || p?.meta?.attackerUUID ||
      null;

    if (asUuid(attackerRef) && typeof fromUuid === "function") {
      try {
        const doc = await fromUuid(attackerRef);
        if (doc?.documentName === "Token") return doc.object ?? null;
        if (doc?.documentName === "Actor") return doc.getActiveTokens?.(true, true)?.[0] ?? null;

        const actor = doc?.actor ?? null;
        if (actor?.getActiveTokens) return actor.getActiveTokens(true, true)?.[0] ?? null;
      } catch {}
    }

    // 3) safety fallbacks (shouldn't be needed in correct pipeline)
    return (
      game.user?.character?.getActiveTokens?.(true, true)?.[0] ??
      canvas.tokens?.controlled?.[0] ??
      null
    );
  }

  const casterToken = await resolveCasterTokenFromPayload(PAYLOAD);

  const targetTokens = (targets || []).map(toTokenPlaceable).filter(Boolean);
  const targetTokenIds = targetTokens.map(t => t.id).filter(Boolean);
  const targetTokenUuids = targetTokens.map(t => t.document?.uuid).filter(Boolean);

  // Enrich payload for downstream scripts
  PAYLOAD.sourceTokenId = PAYLOAD.sourceTokenId ?? (casterToken?.id ?? null);
  PAYLOAD.sourceTokenUuid = PAYLOAD.sourceTokenUuid ?? (casterToken?.document?.uuid ?? null);
  PAYLOAD.casterTokenId = PAYLOAD.casterTokenId ?? (casterToken?.id ?? null);
  PAYLOAD.casterTokenUuid = PAYLOAD.casterTokenUuid ?? (casterToken?.document?.uuid ?? null);

  if (!Array.isArray(PAYLOAD.targetTokenIds) || PAYLOAD.targetTokenIds.length === 0) {
    PAYLOAD.targetTokenIds = targetTokenIds;
  }
  if (!Array.isArray(PAYLOAD.targetTokenUuids) || PAYLOAD.targetTokenUuids.length === 0) {
    PAYLOAD.targetTokenUuids = targetTokenUuids;
  }

  /* ========================== Timing Gate constants ========================= */
  const MAX_TIMEOUT_DEFAULT = 30000;

  async function waitForAnimationEnd({ timeoutMs = MAX_TIMEOUT_DEFAULT } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const cleanup = () => {
        Hooks.off("oni:animationEnd", onEnd);
        if (timer) clearTimeout(timer);
      };

      const onEnd = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };

      Hooks.on("oni:animationEnd", onEnd);

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      }, timeoutMs);
    });
  }

  async function waitForDamageMoment(timingMode, offsetMs, { timeoutMs = MAX_TIMEOUT_DEFAULT } = {}) {
    const mode = String(timingMode ?? "default").trim().toLowerCase();

    if (mode === "timing_offset") {
      await new Promise((resolve) => {
        let started = false;
        let offsetTimer = null;
        let failSafe = null;

        const cleanup = () => {
          Hooks.off("oni:animationStart", onStart);
          Hooks.off("oni:animationEnd", onEnd);
          if (offsetTimer) clearTimeout(offsetTimer);
          if (failSafe) clearTimeout(failSafe);
        };

        const onStart = () => {
          if (started) return;
          started = true;

          if (offsetMs <= 0) {
            cleanup();
            resolve();
            return;
          }

          offsetTimer = setTimeout(() => {
            cleanup();
            resolve();
          }, offsetMs);
        };

        const onEnd = () => { /* ignore */ };

        Hooks.on("oni:animationStart", onStart);
        Hooks.on("oni:animationEnd", onEnd);

        failSafe = setTimeout(() => {
          cleanup();
          resolve();
        }, timeoutMs);
      });

      return;
    }

    await waitForAnimationEnd({ timeoutMs });
  }

  function fuGetAnimationConfig(payload) {
    const rawMode = String(payload?.animation_damage_timing_options ?? "default").trim().toLowerCase();
    const rawOffset = payload?.animation_damage_timing_offset;

    let mode = "default";
    if (rawMode === "offset" || rawMode === "timing_offset") mode = "timing_offset";

    let offsetMs = 0;
    if (mode === "timing_offset" && rawOffset !== undefined && rawOffset !== null) {
      const parsed = Number(rawOffset);
      if (!Number.isNaN(parsed) && parsed >= 0) offsetMs = parsed;
    }

    return { mode, offsetMs };
  }

  /* =================== Run per-Skill custom animation ====================== */
  function extractRawScript(payload) {
    return String(payload?.animationScriptRaw ?? payload?.animationScript ?? "").trim();
  }

  function isPlaceholderScript(raw) {
    return /insert your sequencer animation here/i.test(raw);
  }

  async function fuRunSkillAnimationIfAny(payload, targets, timingMode, offsetMs) {
    const purpose = String(payload?.animationPurpose ?? "damage").trim().toLowerCase();
    const purposeMode = (purpose === "vfx_only") ? "vfx_only" : "damage";

    try {
      const raw = extractRawScript(payload);
      if (!raw) return false;
      if (isPlaceholderScript(raw)) return false;

      let js = htmlToPlain(raw).replace(/\r\n/g, "\n").trim();
      if (!js) return false;

      const fn = new Function("payload", "targets", `"use strict";\n${js}`);

      const worker = async () => {
        const gatePromise =
          (purposeMode === "vfx_only")
            ? waitForAnimationEnd({ timeoutMs: MAX_TIMEOUT_DEFAULT })
            : waitForDamageMoment(timingMode, offsetMs, { timeoutMs: MAX_TIMEOUT_DEFAULT });

        try {
          // Publish payload for scripts that read globalThis.__PAYLOAD/__TARGETS
          const __prevPAYLOAD = globalThis.__PAYLOAD;
          const __prevTARGETS = globalThis.__TARGETS;

          globalThis.__PAYLOAD = payload;
          globalThis.__TARGETS = targets;

          try {
            const result = fn(payload, targets);
            if (result && typeof result.then === "function") await result;
          } finally {
            globalThis.__PAYLOAD = __prevPAYLOAD;
            globalThis.__TARGETS = __prevTARGETS;
          }
        } catch (e) {
          console.error("[ActionAnimationHandler] Animation script error:", e);
          await gatePromise.catch(() => {});
          return false;
        }

        await gatePromise;
        return true;
      };

      // Optional TurnUI hide/show
      const hasTurnUI =
        !!(globalThis.TurnUI &&
           typeof TurnUI.hideUIForAnimation === "function" &&
           typeof TurnUI.showUIAfterAnimation === "function");

      if (hasTurnUI && game?.socket) {
        const uiPayload = { sceneId: canvas.scene?.id ?? null };
        const MODULE_ID = "fabula-ultima-companion";
        const SOCKET_CHANNEL = `module.${MODULE_ID}`;

        const sendHide = () => {
          try { game.socket.emit(SOCKET_CHANNEL, { type: "ONI_TURNUI_HIDE_FOR_ANIMATION", payload: uiPayload }); } catch {}
          try { game.socket.emit("world", { _oniTurnUI: "HIDE_FOR_ANIMATION", payload: uiPayload }); } catch {}
          try { TurnUI.hideUIForAnimation(uiPayload); } catch {}
        };

        const sendShow = () => {
          try { game.socket.emit(SOCKET_CHANNEL, { type: "ONI_TURNUI_SHOW_AFTER_ANIMATION", payload: uiPayload }); } catch {}
          try { game.socket.emit("world", { _oniTurnUI: "SHOW_AFTER_ANIMATION", payload: uiPayload }); } catch {}
          try { TurnUI.showUIAfterAnimation(uiPayload); } catch {}
        };

        sendHide();
        try {
          return await worker();
        } finally {
          sendShow();
        }
      }

      return await worker();
    } catch (err) {
      console.error("[ActionAnimationHandler] Handler error:", err);
      return false;
    }
  }

  /* =============================== Main flow =============================== */
  const { mode: animTimingMode, offsetMs: animTimingOffset } = fuGetAnimationConfig(PAYLOAD);
  const used = await fuRunSkillAnimationIfAny(PAYLOAD, targets, animTimingMode, animTimingOffset);
  return !!used;
})();
