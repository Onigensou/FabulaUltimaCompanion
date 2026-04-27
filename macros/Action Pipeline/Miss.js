// ──────────────────────────────────────────────────────────
//  Miss / Dodge  — Foundry V12
//  • Logs to Battle Log
//  • Plays FX/SFX
//  • For each target, calls Create Damage Card in "miss" mode
// ──────────────────────────────────────────────────────────
const LOGGER_MACRO_NAME = "BattleLog: Append";
const DMG_CARD_MACRO_NAME = "Create Damage Card";

// ---- Inputs from Create Action Card (headless) ----
let AUTO=false, PAYLOAD={};
if (typeof __AUTO !== "undefined") { AUTO = __AUTO; PAYLOAD = __PAYLOAD ?? {}; }

const attackerName  = String(PAYLOAD.attackerName ?? "Unknown");
const attackerUuid  = String(PAYLOAD.attackerUuid ?? ""); // optional
const elementType   = String(PAYLOAD.elementType  ?? "physical").toLowerCase();
const isSpellish    = !!PAYLOAD.isSpellish;
const weaponTypeRaw = String(PAYLOAD.weaponType   ?? "");
const attackRange   = String(PAYLOAD.attackRange  ?? "—");
const accTotal      = Number(PAYLOAD.accuracyTotal ?? NaN);
const defenseUsed   = Number(PAYLOAD.defenseUsed   ?? NaN);

// Preserve upstream action context so the Damage Card batcher can recognize
// that this Miss belongs to a larger multi-target action.
const ACTION_CONTEXT =
  PAYLOAD.actionContext ??
  PAYLOAD.meta?.actionContext ??
  null;

const ACTION_CARD_MSG =
  PAYLOAD.actionCardMsgId ??
  PAYLOAD.chatMsgId ??
  PAYLOAD.meta?.actionCardMessageId ??
  null;

const ACTION_SKILL_TYPE_RAW = String(
  PAYLOAD.skillTypeRaw ??
  PAYLOAD.skill_type ??
  ACTION_CONTEXT?.core?.skillTypeRaw ??
  ACTION_CONTEXT?.dataCore?.skillTypeRaw ??
  ACTION_CONTEXT?.meta?.skillTypeRaw ??
  ""
).trim();

// ---- Resolve targets (set by Create Action Card before calling this macro) ----
const foundryTargets = Array.from(game.user?.targets ?? []);
const selectedTokens = canvas.tokens?.controlled ?? [];
const tokens = (foundryTargets.length ? foundryTargets : selectedTokens);

if (!tokens.length) { ui.notifications.error("Select/target token(s) before applying Miss."); return; }

// ---- 1) Battle Log -------------------------------------------------------------
(async () => {
  const logger = game.macros.getName(LOGGER_MACRO_NAME);
  if (!logger) { console.warn(`[Miss] Logger macro "${LOGGER_MACRO_NAME}" not found.`); return; }

  const rows = [];
  const entries = [];

  for (const t of tokens) {
    const targetName = t.actor?.name ?? t.name ?? "Target";

    entries.push({
      ts: new Date().toISOString(),
      dealer: { name: attackerName, disposition: "?", range: attackRange, sourceType: isSpellish ? "Spell" : "Attack" },
      target: { name: targetName, disposition: "?" },
      inputs: { accuracy: Number.isFinite(accTotal)?accTotal:null, defense:Number.isFinite(defenseUsed)?defenseUsed:null,
                isSpell: isSpellish, elementType, weaponType: weaponTypeRaw },
      miss: true,
      summary: `${attackerName} misses ${targetName}`
    });

    rows.push({
      $deleted: false,
      attacker: attackerName,
      attack_target: targetName,
      value: "—",
      value_type: "HP",
      apply_mode: "Miss",
      damage_type: elementType.toUpperCase(),
      affinity: "—",
      efficiency: "—",
      weapon_type: (weaponTypeRaw && weaponTypeRaw !== "none_ef")
        ? String(weaponTypeRaw).split("_")[0].toUpperCase() : "—",
      range: attackRange
    });
  }

  await logger.execute({ __AUTO: true, __PAYLOAD: { entries, rows } });
})().catch(e => console.warn("[Miss] logger failed:", e));

// ---- 2) FX/SFX -----------------------------------------------------------------
for (const t of tokens) {
  if (typeof Sequencer !== "undefined") {
    new Sequence()
      .effect().file("jb2a.ui.miss").attachTo(t).scaleToObject(1.0).opacity(0.9).duration(1200)
      .sound().file("https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Miss.ogg").volume(0.4)
      .play();
  }
}

// ---- 3) Chat Card (delegated to Create Damage Card) ----------------------------
const createDmg = game.macros.getName(DMG_CARD_MACRO_NAME);
if (!createDmg) { console.warn(`[Miss] Macro "${DMG_CARD_MACRO_NAME}" not found.`); }

// One compact “miss” card per target (same as how damage cards are per-target)
for (const t of tokens) {
  const targetName = t.actor?.name ?? t.name ?? "Target";
  const targetUuid = t.document?.uuid ?? "";

  if (createDmg) {
    await createDmg.execute({
      __AUTO: true,
     __PAYLOAD: {
  // ---- core identity (used by the renderer) ----
  mode: "miss",                 // << tells Create Damage Card to render MISS variant
  attackerName,
  attackerUuid,
  targetName,
  targetUuid,

  sourceType: isSpellish ? "Spell" : "Attack",
  attackRange,
  elementType,
  weaponType: weaponTypeRaw,

  // ---- batching / downstream context ----
  // These are important so Miss cards can batch with the later damage cards
  // from the same original Action Card.
  actionContext: ACTION_CONTEXT,
  actionCardMsgId: ACTION_CARD_MSG,
  skillTypeRaw: ACTION_SKILL_TYPE_RAW || null,
  skill_type: ACTION_SKILL_TYPE_RAW || null,
  isSpellish,

        // ---- display channels expected by the damage card ----
        valueType: "hp",
        displayedAmount: 0,           // no number roll-up on miss
        affected: false,              // signals no effect
        noEffectReason: "Miss",

        // (optional) show context in details if you want later
        accuracyTotal: Number.isFinite(accTotal)?accTotal:null,
        defenseUsed: Number.isFinite(defenseUsed)?defenseUsed:null
      }
    });
  }
}
