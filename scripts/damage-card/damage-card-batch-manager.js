// scripts/damage-card-batch-manager.js
// ──────────────────────────────────────────────────────────
//  Damage Card Batch Manager · Foundry VTT V12
//
//  PURPOSE
//  -------
//  Collect multiple Damage Card payloads during one action/passive/reaction
//  resolution chain, then flush them into ONE grouped Damage Card message.
//
//  Important:
//  - This does NOT merge by timing.
//  - This does NOT use setTimeout to guess grouping.
//  - It groups by explicit damageBatchId / active execution depth.
//  - All state is in-memory only and clears on reload.
//
//  Public API:
//    FUCompanion.api.damageCardBatch.begin({...})
//    FUCompanion.api.damageCardBatch.end(batchId)
//    FUCompanion.api.damageCardBatch.capture(batchId, payload)
//    FUCompanion.api.damageCardBatch.captureIfOpen(payload)
//    FUCompanion.api.damageCardBatch.flush(batchId)
//    FUCompanion.api.damageCardBatch.isOpen(batchIdOrPayload)
//    FUCompanion.api.damageCardBatch.getActiveBatchId()
//    FUCompanion.api.damageCardBatch.makeBatchId(prefix)
// ──────────────────────────────────────────────────────────

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][DamageCardBatch]";
  const DEBUG = true;

  const ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  ROOT.api = ROOT.api || {};

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => DEBUG && console.warn(TAG, ...a);
  const err = (...a) => DEBUG && console.error(TAG, ...a);

  // Keep state outside the API object so re-registering the API does not
  // instantly lose an in-progress batch during development.
  const STATE_KEY = "__FU_DAMAGE_CARD_BATCH_STATE__";

  const STATE = globalThis[STATE_KEY] ??= {
    batches: new Map(),
    stack: []
  };

  const DEFAULT_TTL_MS = 120000;

  function nowMs() {
    return Date.now();
  }

  function str(v, d = "") {
    const s = String(v ?? "").trim();
    return s.length ? s : d;
  }

  function safeClone(value, fallback = null) {
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

  function makeBatchId(prefix = "DMG-BATCH") {
    const rnd =
      foundry?.utils?.randomID?.(8) ??
      Math.random().toString(36).slice(2, 10);

    return `${prefix}-${Date.now().toString(36)}-${rnd}`;
  }

  function getModuleApi() {
    try {
      return game.modules?.get?.(MODULE_ID)?.api ?? null;
    } catch (_e) {
      return null;
    }
  }

  function getGroupedRendererApi() {
    return (
      globalThis.FUCompanion?.api?.createGroupedDamageCard ??
      getModuleApi()?.createGroupedDamageCard ??
      globalThis.FUCompanion?.createGroupedDamageCard ??
      null
    );
  }

  function getSingleRendererApi() {
    return (
      globalThis.FUCompanion?.api?.createDamageCard ??
      getModuleApi()?.createDamageCard ??
      globalThis.FUCompanion?.createDamageCard ??
      null
    );
  }

  function getActiveBatchId() {
    cleanupStack();
    const top = STATE.stack[STATE.stack.length - 1];
    return top ? String(top) : null;
  }

  function cleanupStack() {
    STATE.stack = STATE.stack.filter(batchId => {
      const b = STATE.batches.get(String(batchId));
      return !!b && !b.flushed;
    });
  }

  function removeFromStack(batchId) {
    const id = str(batchId);
    if (!id) return;
    STATE.stack = STATE.stack.filter(v => String(v) !== id);
  }

  function resolveBatchIdFromPayload(payload = {}) {
    return str(
      payload?.damageBatchId ??
      payload?.meta?.damageBatchId ??
      payload?.actionContext?.damageBatchId ??
      payload?.actionContext?.meta?.damageBatchId ??
      payload?.rootActionContext?.damageBatchId ??
      payload?.rootActionContext?.meta?.damageBatchId ??
      getActiveBatchId() ??
      ""
    );
  }

  function resolveBatchId(input = null) {
    if (typeof input === "string") return str(input);
    if (input && typeof input === "object") return resolveBatchIdFromPayload(input);
    return getActiveBatchId();
  }

  function cleanupExpired({ ttlMs = DEFAULT_TTL_MS } = {}) {
    const now = nowMs();

    for (const [batchId, batch] of STATE.batches.entries()) {
      if (!batch) {
        STATE.batches.delete(batchId);
        continue;
      }

      const touchedAt = Number(batch.touchedAt || batch.createdAt || 0);
      const age = now - touchedAt;

      // Safety cleanup only. This is not grouping logic.
      // Do not auto-flush expired batches, because that could post stale results
      // at surprising times. Just remove abandoned empty batches.
      if (batch.depth <= 0 && batch.entries.length === 0 && age > ttlMs) {
        STATE.batches.delete(batchId);
        removeFromStack(batchId);
        log("Removed expired empty batch.", { batchId, age });
      }
    }

    cleanupStack();
  }

  function normalizeBeginOptions(options = {}) {
    const batchId = str(options?.batchId) || makeBatchId();

    return {
      batchId,
      rootActionId: str(options?.rootActionId),
      rootActionCardId: str(options?.rootActionCardId),
      rootActionCardMessageId: str(options?.rootActionCardMessageId),
      executionMode: str(options?.executionMode, "manualCard"),
      title: str(options?.title, "Damage Results"),
      subtitle: str(options?.subtitle),
      rootActionContext: options?.rootActionContext ?? options?.actionContext ?? null,
      reset: !!options?.reset,
      enter: options?.enter !== false
    };
  }

  function ensureBatch(options = {}) {
    cleanupExpired();

    const opts = normalizeBeginOptions(options);
    let batch = STATE.batches.get(opts.batchId);

    if (!batch || opts.reset) {
      batch = {
        batchId: opts.batchId,
        createdAt: nowMs(),
        touchedAt: nowMs(),
        depth: 0,
        entries: [],
        flushed: false,

        rootActionId: opts.rootActionId || null,
        rootActionCardId: opts.rootActionCardId || null,
        rootActionCardMessageId: opts.rootActionCardMessageId || null,
        executionMode: opts.executionMode || "manualCard",

        title: opts.title || "Damage Results",
        subtitle: opts.subtitle || "",
        rootActionContext: safeClone(opts.rootActionContext, opts.rootActionContext),

        meta: {
          createdByUserId: game.userId ?? null,
          createdByUserName: game.user?.name ?? null,
          createdByIsGM: !!game.user?.isGM
        }
      };

      STATE.batches.set(opts.batchId, batch);

      log("BEGIN new batch", {
        batchId: batch.batchId,
        executionMode: batch.executionMode,
        rootActionId: batch.rootActionId,
        rootActionCardId: batch.rootActionCardId
      });
    } else {
      batch.touchedAt = nowMs();

      if (opts.rootActionContext && !batch.rootActionContext) {
        batch.rootActionContext = safeClone(opts.rootActionContext, opts.rootActionContext);
      }

      if (opts.rootActionId && !batch.rootActionId) batch.rootActionId = opts.rootActionId;
      if (opts.rootActionCardId && !batch.rootActionCardId) batch.rootActionCardId = opts.rootActionCardId;
      if (opts.rootActionCardMessageId && !batch.rootActionCardMessageId) {
        batch.rootActionCardMessageId = opts.rootActionCardMessageId;
      }

      if (opts.title && batch.title === "Damage Results") batch.title = opts.title;
      if (opts.subtitle && !batch.subtitle) batch.subtitle = opts.subtitle;
    }

    return batch;
  }

  function begin(options = {}) {
    const opts = normalizeBeginOptions(options);
    const batch = ensureBatch(opts);

    if (opts.enter) {
      batch.depth += 1;
      batch.touchedAt = nowMs();
      STATE.stack.push(batch.batchId);

      log("ENTER batch", {
        batchId: batch.batchId,
        depth: batch.depth,
        stackDepth: STATE.stack.length
      });
    }

    return {
      ok: true,
      batchId: batch.batchId,
      depth: batch.depth,
      entries: batch.entries.length,
      batch
    };
  }

  function enter(batchIdOrOptions = {}) {
    const options =
      typeof batchIdOrOptions === "string"
        ? { batchId: batchIdOrOptions }
        : batchIdOrOptions;

    return begin({
      ...options,
      enter: true
    });
  }

  async function end(batchIdOrPayload = null, options = {}) {
    const batchId = resolveBatchId(batchIdOrPayload);
    const flushWhenReady = options?.flushWhenReady !== false;

    if (!batchId) {
      warn("END skipped: missing batchId.");
      return { ok: false, reason: "missing_batch_id" };
    }

    const batch = STATE.batches.get(batchId);

    if (!batch) {
      warn("END skipped: batch not found.", { batchId });
      removeFromStack(batchId);
      return { ok: false, reason: "batch_not_found", batchId };
    }

    batch.depth = Math.max(0, Number(batch.depth || 0) - 1);
    batch.touchedAt = nowMs();

    // Remove only one matching stack entry from the top side.
    for (let i = STATE.stack.length - 1; i >= 0; i--) {
      if (String(STATE.stack[i]) === batchId) {
        STATE.stack.splice(i, 1);
        break;
      }
    }

    log("LEAVE batch", {
      batchId,
      depth: batch.depth,
      entries: batch.entries.length,
      flushWhenReady
    });

    if (flushWhenReady && batch.depth <= 0) {
      return await flush(batchId, {
        force: false,
        reason: options?.reason ?? "depth_zero",
        title: options?.title,
        subtitle: options?.subtitle
      });
    }

    return {
      ok: true,
      batchId,
      depth: batch.depth,
      entries: batch.entries.length,
      pending: true
    };
  }

  function isOpen(batchIdOrPayload = null) {
    const batchId = resolveBatchId(batchIdOrPayload);
    if (!batchId) return false;

    const batch = STATE.batches.get(batchId);
    return !!batch && !batch.flushed;
  }

  function setRootContext(batchIdOrPayload, rootActionContext = null, extra = {}) {
    const batchId = resolveBatchId(batchIdOrPayload);
    if (!batchId) return { ok: false, reason: "missing_batch_id" };

    const batch = STATE.batches.get(batchId);
    if (!batch) return { ok: false, reason: "batch_not_found", batchId };

    batch.rootActionContext = safeClone(rootActionContext, rootActionContext);
    batch.touchedAt = nowMs();

    if (extra?.title) batch.title = str(extra.title, batch.title);
    if (extra?.subtitle) batch.subtitle = str(extra.subtitle, batch.subtitle);
    if (extra?.rootActionId) batch.rootActionId = str(extra.rootActionId);
    if (extra?.rootActionCardId) batch.rootActionCardId = str(extra.rootActionCardId);
    if (extra?.rootActionCardMessageId) {
      batch.rootActionCardMessageId = str(extra.rootActionCardMessageId);
    }

    return { ok: true, batchId, batch };
  }

  function normalizeCaptureArgs(arg1, arg2, arg3 = {}) {
    // capture(batchId, payload, options)
    if (typeof arg1 === "string") {
      return {
        batchId: str(arg1),
        payload: arg2 ?? {},
        options: arg3 ?? {}
      };
    }

    // capture(payload, options)
    return {
      batchId: resolveBatchIdFromPayload(arg1 ?? {}),
      payload: arg1 ?? {},
      options: arg2 ?? {}
    };
  }

  function capture(arg1, arg2, arg3 = {}) {
    const { batchId, payload, options } = normalizeCaptureArgs(arg1, arg2, arg3);

    if (!batchId) {
      return {
        ok: false,
        captured: false,
        reason: "missing_batch_id"
      };
    }

    const batch = STATE.batches.get(batchId);

    if (!batch || batch.flushed) {
      return {
        ok: false,
        captured: false,
        reason: batch?.flushed ? "batch_already_flushed" : "batch_not_open",
        batchId
      };
    }

    const entry = safeClone(payload, payload) ?? {};
    entry.meta = entry.meta || {};

    entry.damageBatchId = batchId;
    entry.meta.damageBatchId = batchId;
    entry.meta.damageBatchCapturedAtMs = nowMs();
    entry.meta.damageBatchCapturedAtIso = new Date().toISOString();
    entry.meta.damageBatchEntryIndex = batch.entries.length;

    if (options?.source) {
      entry.meta.damageBatchCaptureSource = str(options.source);
    }

    batch.entries.push(entry);
    batch.touchedAt = nowMs();

    log("CAPTURE", {
      batchId,
      entryIndex: batch.entries.length - 1,
      entries: batch.entries.length,
      mode: entry?.mode ?? null,
      attackerName: entry?.attackerName ?? null,
      targetName: entry?.targetName ?? null,
      displayedAmount: entry?.displayedAmount ?? null,
      noEffectReason: entry?.noEffectReason ?? null
    });

    return {
      ok: true,
      captured: true,
      batchId,
      entryIndex: batch.entries.length - 1,
      entries: batch.entries.length
    };
  }

  function captureIfOpen(payload = {}, options = {}) {
    const batchId = resolveBatchIdFromPayload(payload);

    if (!batchId) {
      return {
        ok: false,
        captured: false,
        reason: "missing_batch_id"
      };
    }

    if (!isOpen(batchId)) {
      return {
        ok: false,
        captured: false,
        reason: "batch_not_open",
        batchId
      };
    }

    return capture(batchId, payload, options);
  }

  function getBatch(batchIdOrPayload = null) {
    const batchId = resolveBatchId(batchIdOrPayload);
    if (!batchId) return null;
    return STATE.batches.get(batchId) ?? null;
  }

  function listBatches() {
    cleanupExpired();

    return Array.from(STATE.batches.values()).map(batch => ({
      batchId: batch.batchId,
      depth: batch.depth,
      entries: batch.entries.length,
      flushed: !!batch.flushed,
      executionMode: batch.executionMode,
      rootActionId: batch.rootActionId,
      rootActionCardId: batch.rootActionCardId,
      rootActionCardMessageId: batch.rootActionCardMessageId,
      title: batch.title,
      subtitle: batch.subtitle,
      createdAt: batch.createdAt,
      touchedAt: batch.touchedAt
    }));
  }

  async function flush(batchIdOrPayload = null, options = {}) {
    const batchId = resolveBatchId(batchIdOrPayload);

    if (!batchId) {
      warn("FLUSH skipped: missing batchId.");
      return { ok: false, reason: "missing_batch_id" };
    }

    const batch = STATE.batches.get(batchId);

    if (!batch) {
      warn("FLUSH skipped: batch not found.", { batchId });
      removeFromStack(batchId);
      return { ok: false, reason: "batch_not_found", batchId };
    }

    const force = !!options?.force;

    if (!force && Number(batch.depth || 0) > 0) {
      log("FLUSH delayed: batch still open.", {
        batchId,
        depth: batch.depth,
        entries: batch.entries.length
      });

      return {
        ok: true,
        pending: true,
        reason: "batch_still_open",
        batchId,
        depth: batch.depth,
        entries: batch.entries.length
      };
    }

    if (batch.flushed) {
      return {
        ok: true,
        alreadyFlushed: true,
        batchId
      };
    }

    const entries = batch.entries.filter(Boolean);

    batch.flushed = true;
    batch.touchedAt = nowMs();

    removeFromStack(batchId);

    if (!entries.length) {
      STATE.batches.delete(batchId);

      log("FLUSH empty batch.", {
        batchId,
        reason: options?.reason ?? null
      });

      return {
        ok: true,
        batchId,
        empty: true,
        entries: 0
      };
    }

    const title = str(options?.title, batch.title || "Damage Results");
    const subtitle = str(options?.subtitle, batch.subtitle || "");

    const groupedApi = getGroupedRendererApi();
    const singleApi = getSingleRendererApi();

    try {
      let message = null;
      let fallbackMode = false;

      if (typeof groupedApi === "function") {
        message = await groupedApi({
          batchId,
          title,
          subtitle,
          rootActionContext: batch.rootActionContext,
          entries
        });
      } else if (typeof singleApi === "function") {
        // Safety fallback: never lose results if grouped renderer is missing.
        fallbackMode = true;
        warn("Grouped renderer missing; falling back to individual Damage Cards.", {
          batchId,
          entries: entries.length
        });

        for (const entry of entries) {
          await singleApi(entry);
        }
      } else {
        throw new Error("No createGroupedDamageCard or createDamageCard API available.");
      }

      STATE.batches.delete(batchId);

      log("FLUSH complete.", {
        batchId,
        entries: entries.length,
        grouped: !fallbackMode,
        messageId: message?.id ?? null
      });

      return {
        ok: true,
        batchId,
        entries: entries.length,
        grouped: !fallbackMode,
        fallbackMode,
        messageId: message?.id ?? null,
        message
      };
    } catch (e) {
      err("FLUSH failed.", {
        batchId,
        entries: entries.length,
        error: String(e?.message ?? e)
      });

      // Mark not flushed so a manual debug flush can retry.
      batch.flushed = false;
      batch.touchedAt = nowMs();

      return {
        ok: false,
        reason: "flush_failed",
        batchId,
        entries: entries.length,
        error: String(e?.message ?? e)
      };
    }
  }

  async function cancel(batchIdOrPayload = null, options = {}) {
    const batchId = resolveBatchId(batchIdOrPayload);

    if (!batchId) {
      return { ok: false, reason: "missing_batch_id" };
    }

    const batch = STATE.batches.get(batchId);
    const entries = batch?.entries?.length ?? 0;

    STATE.batches.delete(batchId);
    removeFromStack(batchId);

    log("CANCEL batch", {
      batchId,
      entries,
      reason: options?.reason ?? null
    });

    return {
      ok: true,
      cancelled: true,
      batchId,
      entries
    };
  }

  async function withBatch(options = {}, worker) {
    const start = begin(options);
    const batchId = start.batchId;

    try {
      if (typeof worker !== "function") {
        throw new Error("withBatch requires a worker function.");
      }

      const result = await worker({
        batchId,
        api,
        batch: getBatch(batchId)
      });

      const endResult = await end(batchId, {
        flushWhenReady: options?.flushWhenReady !== false,
        reason: "withBatch_complete",
        title: options?.title,
        subtitle: options?.subtitle
      });

      return {
        ok: true,
        batchId,
        result,
        endResult
      };
    } catch (e) {
      if (options?.flushOnError) {
        await end(batchId, {
          flushWhenReady: true,
          reason: "withBatch_error_flush"
        });
      } else {
        await cancel(batchId, {
          reason: `withBatch_error: ${String(e?.message ?? e)}`
        });
      }

      throw e;
    }
  }

  function attachBatchIdToPayload(payload = {}, batchIdOrPayload = null) {
    const batchId =
      resolveBatchId(batchIdOrPayload) ||
      resolveBatchIdFromPayload(payload) ||
      getActiveBatchId();

    if (!batchId) return payload;

    payload.meta = payload.meta || {};
    payload.damageBatchId = batchId;
    payload.meta.damageBatchId = batchId;

    return payload;
  }

  const api = {
    version: "0.1.0",

    makeBatchId,
    begin,
    enter,
    end,
    leave: end,
    flush,
    cancel,

    capture,
    captureIfOpen,
    isOpen,
    getBatch,
    listBatches,
    getActiveBatchId,
    resolveBatchId,
    resolveBatchIdFromPayload,
    setRootContext,
    attachBatchIdToPayload,
    withBatch,

    // Debug helper.
    _state: STATE
  };

  function exposeApi() {
    ROOT.api.damageCardBatch = api;
    ROOT.damageCardBatch = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.damageCardBatch = api;
      }
    } catch (e) {
      warn("Could not expose API on module.", e);
    }

    log("API registered.", {
      version: api.version,
      functions: [
        "begin",
        "end",
        "capture",
        "captureIfOpen",
        "flush",
        "isOpen"
      ]
    });

    return api;
  }

  exposeApi();

  Hooks.once("ready", () => {
    exposeApi();
  });
})();