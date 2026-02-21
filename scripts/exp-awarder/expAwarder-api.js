// ============================================================================
// expAwarder-api.js (Foundry V12 Module Script)
// - Public API: window.FUCompanion.api.expAwarder.awardExp(payload)
// - Updates Actor EXP at: actor.system.props.experience (decimal supported)
// - Emits UI signal (decoupled snapshot): Hooks.callAll("oni:expAwarded", {...})
// - UI percent conversion matches BattleEnd Summary behavior (0..10 => 0..100%)
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

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  // Same idea as BattleEnd SummaryUI expToPct(): (exp - start) / (cap - start) * 100
  function expToPct(exp, expStart, levelUpAt) {
    const start = Number(expStart);
    const cap = Number(levelUpAt);
    const denom = Math.max(1e-6, (cap - start));
    const t = (Number(exp) - start) / denom;
    return clamp(t * 100, 0, 100);
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

      // Your sheet behavior: exp is a 0..10 meter, displayed as % (x10)
      const EXP_START = 0;
      const LEVELUP_AT = 10;

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

        // --- Read EXP from Custom System Builder fields ---
        const expBefore = asNumber(actor.system?.props?.experience, 0);
        const expAfter = expBefore + amount;

        // Optional level snapshot (your actors store level under system.props.level)
        const levelBefore =
          actor.system?.props?.level ??
          actor.system?.level ??
          null;

        // --- Update EXP (Custom System Builder path) ---
        try {
          await actor.update({ "system.props.experience": expAfter });
        } catch (e) {
          err(`runId=${runId} Failed to update actor EXP`, actorUuid, e);
          ui.notifications?.error?.(`EXP Awarder: Failed to update ${actor.name}.`);
          continue;
        }

        // --- UI percent conversion (matches BattleEnd SummaryUI logic style) ---
        const expPctFrom = expToPct(expBefore, EXP_START, LEVELUP_AT);
        const expPctTo = expToPct(expAfter, EXP_START, LEVELUP_AT);

        const entry = {
          actorUuid,
          actorName: actor.name,
          group: t.group ?? "",
          label: t.label ?? "",
          amount,
          source,
          awardedBy: awardingUser,

          // Decoupled snapshot
          expBefore,
          expAfter,
          levelBefore,

          // UI snapshot values
          levelAfter: null,
          expPctFrom,
          expPctTo,
        };

        entries.push(entry);

        log(`runId=${runId} Updated`, {
          actor: actor.name,
          expBefore,
          expAfter,
          amount,
          expPctFrom,
          expPctTo,
        });
      }

      if (!entries.length) {
        warn(`runId=${runId} No entries updated (all targets failed?)`);
        return { ok: false, runId, error: "NO_UPDATES" };
      }

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

    api._debug = api._debug ?? {};
    api._debug.TAG = TAG;
    api._debug.version = "v2-expPctFix";
    log("API registered: window.FUCompanion.api.expAwarder.awardExp");
  }

  Hooks.once("init", () => {
    registerApi();
  });
})();
