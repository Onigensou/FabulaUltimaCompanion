// ============================================
// JRPG Targeting System - Parser
// File: jrpg-targeting-parser.js
// Foundry VTT V12
// ============================================

import {
  ACTION_KEYS,
  MODES,
  NUMBER_WORDS,
  PARSER,
  TARGET_CATEGORIES,
  UI,
  WORDS
} from "./jrpg-targeting-constants.js";

import { createJRPGTargetingDebugger } from "./jrpg-targeting-debug.js";

const dbg = createJRPGTargetingDebugger("Parser");

/* -------------------------------------------- */
/* Internal helpers                             */
/* -------------------------------------------- */

function toCleanString(value) {
  return String(value ?? "").trim();
}

export function normalizeJRPGTargetingText(value) {
  return toCleanString(value)
    .replace(PARSER.NORMALIZE_REGEX.NON_ALNUM_KEEP_SPACE, " ")
    .replace(/-/g, " ")
    .replace(PARSER.NORMALIZE_REGEX.MULTISPACE, " ")
    .trim()
    .toLowerCase();
}

export function isJRPGTargetingNoneText(value) {
  const normalized = normalizeJRPGTargetingText(value);
  return WORDS.NONE.includes(normalized);
}

export function normalizeJRPGTargetCategory(value) {
  const normalized = normalizeJRPGTargetingText(value);

  if (WORDS.CREATURE.includes(normalized)) return TARGET_CATEGORIES.CREATURE;
  if (WORDS.ALLY.includes(normalized)) return TARGET_CATEGORIES.ALLY;
  if (WORDS.ENEMY.includes(normalized)) return TARGET_CATEGORIES.ENEMY;

  return null;
}

export function parseJRPGTargetNumber(value) {
  const normalized = normalizeJRPGTargetingText(value);
  if (!normalized) return null;

  if (/^\d+$/.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, normalized)) {
    const parsed = NUMBER_WORDS[normalized];
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getCategoryLabel(category, count = 1) {
  switch (category) {
    case TARGET_CATEGORIES.CREATURE:
      return count === 1 ? "creature" : "creatures";
    case TARGET_CATEGORIES.ALLY:
      return count === 1 ? "ally" : "allies";
    case TARGET_CATEGORIES.ENEMY:
      return count === 1 ? "enemy" : "enemies";
    default:
      return count === 1 ? "target" : "targets";
  }
}

function buildPromptText({ mode, count, category }) {
  switch (mode) {
    case MODES.EXACT:
      return `Please select ${count} ${getCategoryLabel(category, count)}`;

    case MODES.UP_TO:
      return `Please select up to ${count} ${getCategoryLabel(category, count)}`;

    case MODES.ALL:
      return `Please confirm all ${getCategoryLabel(category, 2)}`;

    case MODES.FREE:
    default:
      return UI.TEXT.DEFAULT_TITLE;
  }
}

function buildExactResult({ raw, normalized, count, category }) {
  return {
    raw,
    normalized,
    recognized: true,
    mode: MODES.EXACT,
    category,
    count,
    minTargets: count,
    maxTargets: count,
    autoSelectAll: false,
    acceptsZero: false,
    promptText: buildPromptText({ mode: MODES.EXACT, count, category })
  };
}

function buildUpToResult({ raw, normalized, count, category }) {
  return {
    raw,
    normalized,
    recognized: true,
    mode: MODES.UP_TO,
    category,
    count,
    minTargets: 0,
    maxTargets: count,
    autoSelectAll: false,
    acceptsZero: true,
    promptText: buildPromptText({ mode: MODES.UP_TO, count, category })
  };
}

function buildAllResult({ raw, normalized, category }) {
  return {
    raw,
    normalized,
    recognized: true,
    mode: MODES.ALL,
    category,
    count: null,
    minTargets: null,
    maxTargets: null,
    autoSelectAll: true,
    acceptsZero: true,
    promptText: buildPromptText({ mode: MODES.ALL, count: null, category })
  };
}

export function buildJRPGFreeTargetingResult(raw = "") {
  const normalized = normalizeJRPGTargetingText(raw);

  return {
    raw: toCleanString(raw),
    normalized,
    recognized: false,
    mode: MODES.FREE,
    category: TARGET_CATEGORIES.CREATURE,
    count: null,
    minTargets: 0,
    maxTargets: null,
    autoSelectAll: false,
    acceptsZero: true,
    promptText: UI.TEXT.DEFAULT_TITLE
  };
}

/* -------------------------------------------- */
/* Main parser                                  */
/* -------------------------------------------- */

export function parseJRPGTargetingText(skillTargetText) {
  const runId = dbg.makeRunId("PARSE");
  const raw = toCleanString(skillTargetText);
  const normalized = normalizeJRPGTargetingText(raw);

  dbg.logRun(runId, "START", { raw, normalized });

  if (!raw || isJRPGTargetingNoneText(raw)) {
    const result = buildJRPGFreeTargetingResult(raw);
    dbg.logRun(runId, "FREE MODE (empty/none)", result);
    return result;
  }

  // All mode
  {
    const match = normalized.match(PARSER.REGEX.ALL);
    if (match) {
      const [, rawCategory] = match;
      const category = normalizeJRPGTargetCategory(rawCategory);

      if (category) {
        const result = buildAllResult({ raw, normalized, category });
        dbg.logRun(runId, "PARSED ALL", result);
        return result;
      }
    }
  }

  // Up to mode
  {
    const match = normalized.match(PARSER.REGEX.UP_TO);
    if (match) {
      const [, rawCount, rawCategory] = match;
      const count = parseJRPGTargetNumber(rawCount);
      const category = normalizeJRPGTargetCategory(rawCategory);

      if (Number.isFinite(count) && count >= 0 && category) {
        const result = buildUpToResult({ raw, normalized, count, category });
        dbg.logRun(runId, "PARSED UP_TO", result);
        return result;
      }

      dbg.warnRun(runId, "UP_TO matched but count/category invalid", {
        rawCount,
        rawCategory,
        count,
        category
      });
    }
  }

  // Exact mode
  {
    const match = normalized.match(PARSER.REGEX.EXACT);
    if (match) {
      const [, rawCount, rawCategory] = match;
      const count = parseJRPGTargetNumber(rawCount);
      const category = normalizeJRPGTargetCategory(rawCategory);

      if (Number.isFinite(count) && count >= 0 && category) {
        const result = buildExactResult({ raw, normalized, count, category });
        dbg.logRun(runId, "PARSED EXACT", result);
        return result;
      }

      dbg.warnRun(runId, "EXACT matched but count/category invalid", {
        rawCount,
        rawCategory,
        count,
        category
      });
    }
  }

  const fallback = buildJRPGFreeTargetingResult(raw);
  dbg.warnRun(runId, "UNRECOGNIZED target text -> fallback FREE", fallback);
  return fallback;
}

/* -------------------------------------------- */
/* Action object helpers                        */
/* -------------------------------------------- */

export function getJRPGSkillTargetFromAction(action) {
  const direct = action?.[ACTION_KEYS.SKILL_TARGET];
  if (typeof direct === "string") return direct;

  const fromSystemProps = action?.system?.props?.[ACTION_KEYS.SKILL_TARGET];
  if (typeof fromSystemProps === "string") return fromSystemProps;

  return "";
}

export function parseJRPGTargetingFromAction(action) {
  const runId = dbg.makeRunId("PARSE-ACTION");
  const skillTarget = getJRPGSkillTargetFromAction(action);

  dbg.logRun(runId, "ACTION INPUT", {
    hasAction: Boolean(action),
    skillTarget
  });

  const result = parseJRPGTargetingText(skillTarget);

  dbg.logRun(runId, "ACTION RESULT", result);
  return result;
}

export default {
  normalizeJRPGTargetingText,
  isJRPGTargetingNoneText,
  normalizeJRPGTargetCategory,
  parseJRPGTargetNumber,
  buildJRPGFreeTargetingResult,
  parseJRPGTargetingText,
  getJRPGSkillTargetFromAction,
  parseJRPGTargetingFromAction
};
