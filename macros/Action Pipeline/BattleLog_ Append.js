// ──────────────────────────────────────────────────────────
// BattleLog: Append  (Foundry V12) — instrumented
// ──────────────────────────────────────────────────────────
(async () => {
  const MAX = 30;

  // 0) Inputs
  const entries   = Array.isArray(__PAYLOAD.entries) ? __PAYLOAD.entries : [];
  const rows      = Array.isArray(__PAYLOAD.rows)    ? __PAYLOAD.rows    : [];

  console.debug("[BL-APPEND] start. entries:", entries.length, "rows:", rows.length, "user:", game.user?.name, "isGM:", game.user?.isGM);

  // 1) Resolve DB actor
  async function getDbActor() {
    try {
      const currentGameActor = await fromUuid("Actor.DMpK5Bi119jIrCFZ");
      if (!currentGameActor) {
        console.warn("[BL-APPEND] Current Game actor not found by UUID Actor.DMpK5Bi119jIrCFZ");
        return null;
      }
      const gameDbUuid = currentGameActor?.system?.props?.game_id;
      if (!gameDbUuid) {
        console.warn("[BL-APPEND] system.props.game_id is empty on Current Game actor.");
        return null;
      }
      const dbActor = await fromUuid(gameDbUuid);
      if (!dbActor) {
        console.warn("[BL-APPEND] DB actor not found by UUID from system.props.game_id:", gameDbUuid);
      } else {
        // Helpful: show ownership for permission debugging
        const perm = dbActor.testUserPermission(game.user, "OWNER");
        console.debug("[BL-APPEND] DB actor resolved:", dbActor.name, "owner?", perm);
      }
      return dbActor;
    } catch (err) {
      console.warn("[BL-APPEND] getDbActor failed:", err);
      return null;
    }
  }


  // 2) JSON append
  async function appendBattleLogJSON(dbActor, newEntries) {
    if (!newEntries?.length) return;
    try {
      let existingRaw = String(dbActor.system?.props?.battle_log ?? "").trim();
      let arr = [];
      if (existingRaw.startsWith("[") || existingRaw.startsWith("{")) {
        try {
          const parsed = JSON.parse(existingRaw);
          arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        } catch {
          console.warn("[BL-APPEND] battle_log contains non-JSON; resetting.");
          arr = [];
        }
      }
      arr.push(...newEntries);
      if (arr.length > MAX) arr = arr.slice(-MAX);
      await dbActor.update({ "system.props.battle_log": JSON.stringify(arr, null, 2) });
      console.debug("[BL-APPEND] JSON append OK. New length:", arr.length);
    } catch (err) {
      console.warn("[BL-APPEND] JSON append failed (likely permissions):", err);
      ui.notifications.warn("BattleLog JSON append failed. Check DB actor ownership & console.");
    }
  }

  // 3) Table append
  async function appendBattleTableRows(dbActor, newRows) {
    if (!newRows?.length) return;
    try {
      const table = dbActor.system?.props?.battle_log_table;
      const existing = Array.isArray(table)
        ? foundry.utils.duplicate(table)
        : (table && typeof table === "object" && !Array.isArray(table))
          ? foundry.utils.duplicate(Object.values(table))
          : [];

      existing.push(...newRows);
      const trimmed = existing.length > MAX ? existing.slice(-MAX) : existing;
      await dbActor.update({ "system.props.battle_log_table": trimmed });
      console.debug("[BL-APPEND] TABLE append OK. New length:", trimmed.length);
    } catch (err) {
      console.warn("[BL-APPEND] TABLE append failed (likely permissions):", err);
      ui.notifications.warn("BattleLog TABLE append failed. Check DB actor ownership & console.");
    }
  }

  // 4) Execute
  try {
    const dbActor = await getDbActor();
    if (!dbActor) {
      ui.notifications.warn("BattleLog: no DB actor. Is Current Game → game_id set?");
      return;
    }
    if (entries.length) await appendBattleLogJSON(dbActor, entries);
    if (rows.length)    await appendBattleTableRows(dbActor, rows);
    console.debug("[BL-APPEND] done.");
  } catch (err) {
    console.warn("[BL-APPEND] Unexpected failure:", err);
  }
})();
