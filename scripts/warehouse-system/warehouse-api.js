// scripts/warehouse-system/warehouse-api.js
// ----------------------------------------------------------------------------
// ONI Warehouse — API (Context + Snapshot)
// - resolveContext(payload): fills payload.ctx (actor + storage via DB Resolver)
// - buildSnapshot(payload): fills payload.snapshot (items + zenit)
// ----------------------------------------------------------------------------

import { WarehouseDebug } from "./warehouse-debug.js";
import { WarehousePayloadManager } from "./warehouse-payloadManager.js";

export class WarehouseAPI {
  // -----------------------------
  // Helpers
  // -----------------------------

  static _asInt(n, fallback = 0) {
    const v = Number.parseInt(n ?? "", 10);
    return Number.isFinite(v) ? v : fallback;
  }

  static getZenit(doc) {
    // Your data key is ".zenit" on both Actor + DB Actor.
    // In samples, it's commonly at doc.system.zenit (string/number).
    // We'll also support doc.system.props.zenit as fallback.
    const z =
      doc?.system?.zenit ??
      doc?.system?.props?.zenit ??
      doc?.system?.data?.zenit; // extra fallback just in case

    return this._asInt(z, 0);
  }

  static normalizeItem(item) {
    // Foundry Item document normalization (UI-friendly)
    const itemType = item?.system?.props?.item_type ?? item?.system?.item_type ?? item?.type ?? "";
    const rawQty = item?.system?.props?.item_quantity ?? item?.system?.item_quantity ?? null;

    // Stack rule assumption (based on your ecosystem):
    // - "consumable" stacks via item_quantity
    // - everything else is treated as qty = 1 in the UI planning layer
    const isConsumable = String(itemType).toLowerCase() === "consumable";
    const qty = isConsumable ? Math.max(1, this._asInt(rawQty, 1)) : 1;

    return {
      itemUuid: item?.uuid ?? null,
      itemId: item?.id ?? null,
      name: item?.name ?? "(Unnamed Item)",
      img: item?.img ?? "icons/svg/item-bag.svg",
      itemType,
      qty,
      // keep extra data for future niche rules (never harmful)
      flags: item?.flags ?? {},
      system: item?.system ?? {}
    };
  }

  static getActorFromUuidOrUser(payload) {
    // 1) payload.ctx.actorUuid
    // 2) game.user.character
    const actorUuid = payload?.ctx?.actorUuid ?? null;

    if (actorUuid && actorUuid !== "TEST") {
      // fromUuid can resolve Actor/Token/Item; we want Actor
      return fromUuid(actorUuid);
    }

    // fallback: linked character
    if (game.user?.character) return game.user.character;

    return null;
  }

  // -----------------------------
  // 1) Context Resolve
  // -----------------------------
  static async resolveContext(payload) {
    WarehouseDebug.log(payload, "CTX", "Resolving context...");

    // Always ensure payload exists (manager rule)
    payload = WarehousePayloadManager.getOrCreate(payload?.meta?.initial ?? {});

    // user
    payload.ctx.userId = payload.ctx.userId ?? game.user?.id ?? null;

    // actor
    let actorDoc = await this.getActorFromUuidOrUser(payload);
    // If getActorFromUuidOrUser returned a document directly (game.user.character),
    // fromUuid isn't needed.
    if (actorDoc?.document) actorDoc = actorDoc.document;

    if (!actorDoc) {
      payload.gates.ok = false;
      payload.gates.errors.push("No actor found (payload.ctx.actorUuid is missing and user has no linked character).");
      WarehouseDebug.error(payload, "CTX", "Failed: No actor resolved", { actorUuid: payload.ctx.actorUuid });
      ui.notifications?.error?.("Warehouse: No actor found. Link a character or pass actorUuid.");
      return payload;
    }

    payload.ctx.actorUuid = actorDoc.uuid;
    payload.ctx.actorName = actorDoc.name;

    // storage / db via DB Resolver
    // Your DB Resolver is part of FUCompanion: window.FUCompanion.api.getCurrentGameDb()
    const hasResolver = !!(window.FUCompanion?.api?.getCurrentGameDb);
    if (!hasResolver) {
      payload.gates.ok = false;
      payload.gates.errors.push("DB Resolver not found: window.FUCompanion.api.getCurrentGameDb is missing.");
      WarehouseDebug.error(payload, "CTX", "Failed: DB Resolver missing", {});
      ui.notifications?.error?.("Warehouse: DB Resolver missing (FUCompanion).");
      return payload;
    }

    let dbActor = null;
    try {
      dbActor = await window.FUCompanion.api.getCurrentGameDb();
    } catch (err) {
      payload.gates.ok = false;
      payload.gates.errors.push(`DB Resolver error: ${err?.message ?? String(err)}`);
      WarehouseDebug.error(payload, "CTX", "Failed: DB Resolver threw error", { err });
      ui.notifications?.error?.("Warehouse: DB Resolver error. See console.");
      return payload;
    }

    if (!dbActor) {
      payload.gates.ok = false;
      payload.gates.errors.push("DB Resolver returned null/undefined Database Actor.");
      WarehouseDebug.error(payload, "CTX", "Failed: DB Actor is null", {});
      ui.notifications?.error?.("Warehouse: Database Actor not found.");
      return payload;
    }

    // Store DB actor as our storage actor for now (matches your stated “Database Object is storage”)
    payload.ctx.storageDbUuid = dbActor.uuid;
    payload.ctx.storageActorUuid = dbActor.uuid;
    payload.ctx.storageName = dbActor.name;

    WarehouseDebug.log(payload, "CTX", "Context resolved", {
      userId: payload.ctx.userId,
      actorUuid: payload.ctx.actorUuid,
      storageActorUuid: payload.ctx.storageActorUuid
    });

    return payload;
  }

  // -----------------------------
  // 2) Snapshot Builder
  // -----------------------------
  static async buildSnapshot(payload) {
    WarehouseDebug.log(payload, "SNAPSHOT", "Building snapshot...");

    // Resolve context first if not ready
    const needsCtx = !payload?.ctx?.actorUuid || !payload?.ctx?.storageActorUuid;
    if (needsCtx) {
      await this.resolveContext(payload);
    }

    // If gates already failed, stop snapshot
    if (payload?.gates?.ok === false) {
      WarehouseDebug.warn(payload, "SNAPSHOT", "Skipped because gates.ok=false", {
        errors: payload.gates?.errors ?? []
      });
      return payload;
    }

    const actorDoc = await fromUuid(payload.ctx.actorUuid);
    const storageDoc = await fromUuid(payload.ctx.storageActorUuid);

    if (!actorDoc || !storageDoc) {
      payload.gates.ok = false;
      payload.gates.errors.push("Snapshot failed: could not resolve actor/storage documents from UUID.");
      WarehouseDebug.error(payload, "SNAPSHOT", "Failed: fromUuid returned null", {
        actorUuid: payload.ctx.actorUuid,
        storageActorUuid: payload.ctx.storageActorUuid
      });
      return payload;
    }

    // Zenit
    payload.snapshot.actorZenit = this.getZenit(actorDoc);
    payload.snapshot.storageZenit = this.getZenit(storageDoc);

    // Items (use embedded Item collection)
    const actorItems = Array.from(actorDoc.items ?? []).map((it) => this.normalizeItem(it));
    const storageItems = Array.from(storageDoc.items ?? []).map((it) => this.normalizeItem(it));

    payload.snapshot.actorItems = actorItems;
    payload.snapshot.storageItems = storageItems;
    payload.snapshot.sourceCounts = { actor: actorItems.length, storage: storageItems.length };
    payload.snapshot.normalizedAt = Date.now();

    WarehouseDebug.log(payload, "SNAPSHOT", "Snapshot built", {
      actorItems: actorItems.length,
      storageItems: storageItems.length,
      actorZenit: payload.snapshot.actorZenit,
      storageZenit: payload.snapshot.storageZenit
    });

    return payload;
  }
}
