// scripts/battlelog/battlelog-clear.js
// Backend function: clears BOTH Battle Log fields on the DB actor.

export async function clearBattleLog() {
  console.debug("[BL-CLEAR] start. user:", game.user?.name, "isGM:", game.user?.isGM);

  // Resolve DB actor via DB_Resolver
  async function resolveDbActor() {
    const api = window.FUCompanion?.api;

    // Preferred: DB_Resolver
    if (api?.getCurrentGameDb) {
      const { db } = await api.getCurrentGameDb();
      return db ?? null;
    }

    // Fallback: Current Game -> game_id
    console.warn("[BL-CLEAR] DB_Resolver API not found at window.FUCompanion.api.getCurrentGameDb(). Falling back to Current Game -> game_id lookup.");
    try {
      const currentGameActor = await fromUuid("Actor.DMpK5Bi119jIrCFZ");
      const gameDbUuid = currentGameActor?.system?.props?.game_id;
      if (!gameDbUuid) return null;
      return await fromUuid(gameDbUuid);
    } catch {
      return null;
    }
  }

  try {
    const dbActor = await resolveDbActor();
    if (!dbActor) {
      console.warn("[BL-CLEAR] No DB actor resolved. Check Current Game -> system.props.game_id / DB_Resolver load order.");
      return false;
    }

    // Clear both logs
    await dbActor.update({
      "system.props.battle_log": "[]",
      "system.props.battle_log_table": []
    });

    console.log("Battle Log cleared!");
    console.debug("[BL-CLEAR] done.");
    return true;
  } catch (err) {
    console.warn("[BL-CLEAR] Failed to clear battle log:", err);
    return false;
  }
}
