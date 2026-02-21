// ============================================================================
// expAwarder-api.js (Foundry V12 Module Script)
// - Public API: window.FUCompanion.api.expAwarder.awardExp(payload)
// - Updates Actor EXP at: actor.system.experience (decimal supported)
// - Emits UI signal (decoupled snapshot): Hooks.callAll("oni:expAwarded", {...})
// ============================================================================

(() => {
  const TAG = "[ONI][EXPAwarder][API]";
  const DBG = true;

  function log(...args) { if (DBG) console.log(TAG, ...args); }
  function warn(...args) { console.warn(TAG, ...args); }
  function err(...args) { console.error(TAG, ...args); }

  function makeRunId() {
    return `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  }

  function ensureNamespace() {
    globalThis.FUCompanion = globalThis.FUCompanion ?? {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api ?? {};
    globalThis.FUCompanion.api.expAwarder = globalThis.FUCompanion.api.expAwarder ?? {};
    return globalThis.FUCompanion.api.expAwarder;
  }

  function asNumber(v, fallback = 0) {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function normString(v) {
    const s = (v ?? "").toString();
    const t = s.trim();
    return t.length ? t : "";
  }

  function normalizeTargets(targets) {
    // Accept:
    // - ["Actor.xxx", "Actor.yyy"]
    // - [{ actorUuid: "Actor.xxx", label, group }, ...]
    const out = [];
    const arr = Array.isArray(targets) ? targets : [];
    for (const t of arr) {
      if (!t) continue;

      if (typeof t === "string") {
        const uuid = normString(t);
        if (uuid) out.push({ actorUuid: uuid });
        continue;
      }

      if (typeof t === "object") {
        const uuid = normString(t.actorUuid ?? t.uuid);
        if (!uuid) continue;
        out.push({
          actorUuid: uuid,
          label: normString(t.label),
          group: normString(t.group),
        });
      }
    }
    return out;
  }

  function emitExpAwardedSignal(payload) {
    // Local signal only (decoupled UI listens to this)
    // UI should queue and show 1 at a time.
    try {
      Hooks.callAll("oni:expAwarded", payload);
    } catch (e) {
      err("Failed to emit oni:expAwarded", e);
    }
  }

  async function awardExp(userPayload = {}) {
    const runId = makeRunId();
    log(`START runId=${runId}`, { keys: Object.keys(userPayload ?? {}) });

    try {
      const targets = normalizeTargets(userPayload.targets);
      const amount = asNumber(userPayload.amount, NaN);
      const playUi = (userPayload.playUi ?? true) === true;
      const source = normString(userPayload.source);

      const awardingUser = {
        id: userPayload.user?.id ?? game.user?.id ?? null,
        name: userPayload.user?.name ?? game.user?.name ?? "Unknown",
      };

      if (!Number.isFinite(amount)) {
        ui.notifications?.warn?.("EXP Awarder: Invalid EXP amount.");
        warn(`runId=${runId} Invalid amount`, userPayload.amount);
        return { ok: false, runId, error: "INVALID_AMOUNT" };
      }

      if (!targets.length) {
        ui.notifications?.warn?.("EXP Awarder: No targets selected.");
        warn(`runId=${runId} No targets`);
        return { ok: false, runId, error: "NO_TARGETS" };
      }

      const entries = [];
      for (const t of targets) {
        const actorUuid = t.actorUuid;

        let actor;
        try {
          actor = await fromUuid(actorUuid);
        } catch (e) {
          warn(`runId=${runId} fromUuid failed`, actorUuid, e);
          continue;
        }

        if (!actor) {
          warn(`runId=${runId} Actor not found`, actorUuid);
          continue;
        }

        const expBefore = asNumber(actor.system?.experience, 0);
        const expAfter = expBefore + amount;

        // Optional level snapshot (safe fallback)
        const levelBefore =
          actor.system?.props?.level ??
          actor.system?.level ??
          null;

        // Update EXP
        try {
          await actor.update({ "system.experience": expAfter });
        } catch (e) {
          err(`runId=${runId} Failed to update actor EXP`, actorUuid, e);
          ui.notifications?.error?.(`EXP Awarder: Failed to update ${actor.name}.`);
          continue;
        }

        const entry = {
          actorUuid,
          actorName: actor.name,
          group: t.group ?? "",
          label: t.label ?? "",
          amount,
          source,
          awardedBy: awardingUser,
          // Decoupled snapshot for UI:
          expBefore,
          expAfter,
          levelBefore,
          // Future-proof fields (UI can ignore):
          levelAfter: null,
          expPctFrom: null,
          expPctTo: null,
        };

        entries.push(entry);
        log(`runId=${runId} Updated`, {
          actor: actor.name,
          expBefore,
          expAfter,
          amount,
        });
      }

      if (!entries.length) {
        warn(`runId=${runId} No entries updated (all targets failed?)`);
        return { ok: false, runId, error: "NO_UPDATES" };
      }

      // Emit UI signal (single event containing all entries)
      if (playUi) {
        emitExpAwardedSignal({
          runId,
          ts: Date.now(),
          source,
          awardedBy: awardingUser,
          entries,
        });
        log(`runId=${runId} Emitted oni:expAwarded`, { count: entries.length });
      } else {
        log(`runId=${runId} playUi=false (no UI signal emitted)`);
      }

      log(`END runId=${runId} ok`);
      return { ok: true, runId, entries };
    } catch (e) {
      err(`runId=${runId} CRASH`, e);
      ui.notifications?.error?.("EXP Awarder: API crashed. Check console.");
      return { ok: false, runId, error: "CRASH", detail: String(e?.message ?? e) };
    }
  }

  function registerApi() {
    const api = ensureNamespace();
    api.awardExp = awardExp;

    // Optional tiny helpers for debugging / inspection
    api._debug = api._debug ?? {};
    api._debug.TAG = TAG;
    api._debug.version = "v1";
    log("API registered: window.FUCompanion.api.expAwarder.awardExp");
  }

  Hooks.once("init", () => {
    registerApi();
  });
})();
