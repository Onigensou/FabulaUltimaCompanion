// ============================================================================
// WarehouseAPI - Snapshot item gather (FILTERED BY SYSTEM CONTAINERS)
// Replace your current actor.items scanning with this block.
// ============================================================================

static _ALLOWED_ITEM_CONTAINERS = [
  "inventory_tab",
  "weapon_list",
  "itemContainer2",
  "itemContainer3",
  "itemContainer4",
  "consumable_list",
  "key_list",
];

static _getContainerObject(actor, key) {
  // Most FU sheets store these on actor.system (commonly), but we’ll safely check both.
  const sys = actor?.system ?? {};
  const root = actor ?? {};
  const a = sys?.[key];
  const b = root?.[key];
  const val = (a && typeof a === "object") ? a : (b && typeof b === "object" ? b : null);
  return val && typeof val === "object" ? val : null;
}

static _inferQtyFromEntry(entry) {
  // Your containers commonly use "quantity" for consumables; weapons may be "" (treat as 1).
  const q = entry?.quantity;
  const n = Number(q);
  if (Number.isFinite(n) && n >= 0) return n;
  return 1;
}

static _inferDescFromEntry(entry) {
  // Your data uses different description keys per container type.
  // Examples in your sample: weapon_description, consume_description, armor_description, key_description:contentReference[oaicite:3]{index=3}.
  return (
    entry?.weapon_description ??
    entry?.armor_description ??
    entry?.shield_description ??
    entry?.accessory_description ??
    entry?.consume_description ??
    entry?.key_description ??
    entry?.description ??
    ""
  );
}

static async _collectItemsFromContainers(actor, debug) {
  const out = [];
  const seen = new Set(); // de-dupe by uuid

  for (const key of WarehouseAPI._ALLOWED_ITEM_CONTAINERS) {
    const container = WarehouseAPI._getContainerObject(actor, key);
    if (!container) continue;

    // Container shape: { "<itemId>": { name, uuid, quantity, ... }, ... }
    for (const [itemId, entry] of Object.entries(container)) {
      const uuid = entry?.uuid;
      if (!uuid || typeof uuid !== "string") continue;
      if (seen.has(uuid)) continue;
      seen.add(uuid);

      const doc = await fromUuid(uuid);
      // Some bad/old entries can exist; skip if unresolved
      if (!doc) {
        debug?.warn?.("[SNAPSHOT] fromUuid null (container entry)", { key, itemId, uuid });
        continue;
      }

      const qty = WarehouseAPI._inferQtyFromEntry(entry);
      const desc = WarehouseAPI._inferDescFromEntry(entry);

      out.push({
        uuid,
        id: doc.id,
        name: entry?.name ?? doc.name ?? "Unnamed",
        img: doc.img,
        qty,
        // keep BOTH: raw container desc (fast) + doc/system desc (if you want later)
        desc,
        _containerKey: key,
      });
    }
  }

  return out;
}
