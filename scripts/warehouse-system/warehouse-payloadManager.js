// scripts/warehouse/PayloadManager.js
// ----------------------------------------------------------------------------
// ONI Warehouse — Payload Manager (Foundry V12)
// - Creates the universal payload ONCE
// - Payload NEVER shrinks (only grows)
// - Stores payload globally: globalThis.__WAREHOUSE_PAYLOAD
// ----------------------------------------------------------------------------

import { WarehouseDebug } from "./Debug.js";

export class WarehousePayloadManager {
  static GLOBAL_KEY = "__WAREHOUSE_PAYLOAD";

  /**
   * Create a short payload id for tracing logs.
   */
  static _makeId() {
    return Math.random().toString(16).slice(2, 10);
  }

  /**
   * Get (or create) the global payload.
   * If it already exists, we return it unchanged (Manager rule).
   */
  static getOrCreate(initial = {}) {
    const existing = globalThis[this.GLOBAL_KEY];
    if (existing) return existing;

    const payload = this.create(initial);
    globalThis[this.GLOBAL_KEY] = payload;
    return payload;
  }

  /**
   * Create a fresh payload object.
   * NOTE: This should be called ONLY at the start of the pipeline.
   */
  static create(initial = {}) {
    const payloadId = this._makeId();

    const payload = {
      meta: {
        payloadId,
        createdAt: Date.now(),
        system: "ONI_Warehouse",
        version: "0.1.0",
        debug: initial.debug ?? true
      },

      // ----------------------------------------------------------------------
      // ctx: resolved context (filled later by resolver script)
      // ----------------------------------------------------------------------
      ctx: {
        userId: initial.userId ?? game.user?.id ?? null,
        actorUuid: initial.actorUuid ?? null,
        storageDbUuid: initial.storageDbUuid ?? null,
        storageActorUuid: initial.storageActorUuid ?? null,

        // Optional extras (safe placeholders)
        actorName: null,
        storageName: null,
        sceneId: canvas?.scene?.id ?? null
      },

      // ----------------------------------------------------------------------
      // snapshot: read-only snapshot (filled later)
      // ----------------------------------------------------------------------
      snapshot: {
        actorZenit: null,
        storageZenit: null,
        actorItems: [],
        storageItems: [],
        normalizedAt: null,
        sourceCounts: { actor: 0, storage: 0 }
      },

      // ----------------------------------------------------------------------
      // plan: planning layer (changes over time, but never removed)
      // ----------------------------------------------------------------------
      plan: {
        itemMoves: [], // {from,to,itemUuid,qty,requestedByUserId,...}
        zenit: {
          depositToStorage: 0,
          withdrawFromStorage: 0,
          lastEditedAt: null,
          lastEditedBy: null
        }
      },

      // ----------------------------------------------------------------------
      // gates: validation output (rewritten each time evaluateAll runs)
      // ----------------------------------------------------------------------
      gates: {
        ok: true,
        errors: [],
        warnings: [],
        byRule: {}
      },

      // ----------------------------------------------------------------------
      // ui: references + render counters
      // ----------------------------------------------------------------------
      ui: {
        instanceId: null,
        appId: null,
        renderCount: 0,
        dragState: null,
        refs: {}
      },

      // ----------------------------------------------------------------------
      // commit: commit report (filled on Confirm)
      // ----------------------------------------------------------------------
      commit: {
        status: "idle", // idle|running|success|failed
        startedAt: null,
        finishedAt: null,
        results: [],
        deltaSummary: null,
        errorDetails: null
      },

      // ----------------------------------------------------------------------
      // audit: append-only log (Debug helper writes here)
      // ----------------------------------------------------------------------
      audit: []
    };

    // Allow adding extra initial fields (niche specs) without overwriting core shape
    payload.meta.initial = initial;

    WarehouseDebug.log(payload, "BOOT", "Payload created", {
      payloadId,
      userId: payload.ctx.userId,
      actorUuid: payload.ctx.actorUuid
    });

    return payload;
  }

  /**
   * Safe "add-only" merge:
   * - Adds new keys that don't exist
   * - Does NOT delete
   * - Does NOT overwrite existing non-null/defined values unless forced
   */
  static add(payload, patch = {}, { force = false } = {}) {
    const walk = (target, src, path = "") => {
      for (const [k, v] of Object.entries(src || {})) {
        const nextPath = path ? `${path}.${k}` : k;

        if (v && typeof v === "object" && !Array.isArray(v)) {
          target[k] = target[k] && typeof target[k] === "object" ? target[k] : {};
          walk(target[k], v, nextPath);
          continue;
        }

        // Arrays: only append, never replace
        if (Array.isArray(v)) {
          target[k] = target[k] ?? [];
          if (!Array.isArray(target[k])) target[k] = [];
          target[k].push(...v);
          continue;
        }

        // Primitive:
        if (target[k] === undefined || target[k] === null || force) {
          target[k] = v;
        }
      }
    };

    walk(payload, patch);

    WarehouseDebug.log(payload, "PAYLOAD", "Add-only patch applied", { patch });
    return payload;
  }

  /**
   * Mark payload closed without deleting (useful for debugging).
   */
  static markClosed(payload, reason = "closed") {
    payload.meta.closedAt = Date.now();
    payload.meta.closeReason = reason;
    WarehouseDebug.log(payload, "CLOSE", "Payload marked closed", { reason });
  }
}
