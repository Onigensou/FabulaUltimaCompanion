// ============================================================================
// ActiveEffectManager-fx.js
// Foundry VTT V12 — Fabula Ultima Companion
//
// Purpose:
// - Play multi-client Active Effect feedback through ONI Pseudo Animation.
// - No Sequencer VFX.
// - Does not apply/remove effects itself.
// - Called automatically by ActiveEffectManager-api.js through:
//     FUCompanion.api.activeEffectManager.fx.play(report, options)
//
// Public API:
//   FUCompanion.api.activeEffectManager.fx.play(report, options)
//   FUCompanion.api.activeEffectManager.fx.playForTokens(payload)
//
// Notes:
// - Actor-first system means some affected actors may not have tokens on scene.
// - FX only plays for affected actors that currently have visible tokens.
// ============================================================================

(() => {
  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][ActiveEffectManager:FX]";
  const DEBUG = true;

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  const DEFAULT_SFX = {
    Buff: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Recovery.ogg",
    Debuff: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Dispel%20Magic.ogg",
    Other: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Recovery.ogg",
    Remove: "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Dispel%20Magic.ogg"
  };

  const DEFAULT_COLORS = {
    Buff: 0x63f29b,
    Debuff: 0xbe64ff,
    Other: 0xffd36a,
    Remove: 0x9bc7ff
  };

  const DEFAULT_CONFIG = {
    enabled: true,
    sfxVolume: 0.75,

    pulseMs: 760,
    iconMs: 820,
    ringDelayMs: 130,

    ringAlpha: 0.9,
    glowAlpha: 0.22,

    zIndex: 7000,

    playSfx: true,
    playIcon: true,
    playRing: true,
    playGlow: true
  };

  // --------------------------------------------------------------------------
  // API root
  // --------------------------------------------------------------------------

  function ensureApiRoot() {
    globalThis.FUCompanion = globalThis.FUCompanion || {};
    globalThis.FUCompanion.api = globalThis.FUCompanion.api || {};
    globalThis.FUCompanion.api.activeEffectManager = globalThis.FUCompanion.api.activeEffectManager || {};
    return globalThis.FUCompanion.api.activeEffectManager;
  }

  function exposeApi(api) {
    const root = ensureApiRoot();
    root.fx = api;

    try {
      const mod = game.modules?.get?.(MODULE_ID);
      if (mod) {
        mod.api = mod.api || {};
        mod.api.activeEffectManager = mod.api.activeEffectManager || {};
        mod.api.activeEffectManager.fx = api;
      }
    } catch (e) {
      warn("Could not expose FX API on module object.", e);
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  function clone(value, fallback = null) {
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

  function safeString(value, fallback = "") {
    const s = String(value ?? "").trim();
    return s.length ? s : fallback;
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    if (value instanceof Set) return Array.from(value);
    return [value];
  }

  function uniq(values) {
    return Array.from(
      new Set(
        asArray(values)
          .filter(v => v != null && String(v).trim() !== "")
          .map(String)
      )
    );
  }

  function randomId(prefix = "aem-fx") {
    const id =
      foundry?.utils?.randomID?.(8) ??
      Math.random().toString(36).slice(2, 10);

    return `${prefix}-${Date.now().toString(36)}-${id}`;
  }

  function getPseudoApi() {
    return game?.ONI?.pseudo ?? null;
  }

  function actorUuidFromRow(row = {}) {
    return safeString(row?.actor?.uuid ?? row?.actorUuid);
  }

  function effectNameFromRow(row = {}) {
    return safeString(
      row?.effect?.name ??
      row?.created?.name ??
      row?.removed?.[0]?.name ??
      row?.before?.name ??
      row?.after?.name ??
      "Active Effect"
    );
  }

  function effectImgFromRow(row = {}) {
    return safeString(
      row?.effect?.img ??
      row?.created?.img ??
      row?.removed?.[0]?.img ??
      row?.before?.img ??
      row?.after?.img ??
      "icons/svg/aura.svg"
    );
  }

  function categoryFromRow(row = {}) {
    return safeString(
      row?.effect?.identity?.category ??
      row?.effect?.category ??
      row?.category ??
      ""
    );
  }

  function isFxResultRow(row = {}) {
    if (!row?.ok) return false;

    return [
      "applied",
      "replaced",
      "stacked",
      "removed"
    ].includes(row.status);
  }

  function classifyReport(report = {}) {
    const action = safeString(report.action).toLowerCase();
    const rows = asArray(report.results).filter(isFxResultRow);

    if (action === "remove") return "Remove";

    if (!rows.length) return "Other";

    const categories = rows
      .map(categoryFromRow)
      .filter(Boolean);

    if (!categories.length) return "Other";

    const allDebuff = categories.every(c => c === "Debuff");
    if (allDebuff) return "Debuff";

    const allOther = categories.every(c => c === "Other");
    if (allOther) return "Other";

    // Mixed/conflicted effects default to Buff.
    return "Buff";
  }

  function collectFxRows(report = {}) {
    return asArray(report.results).filter(isFxResultRow);
  }

  function findTokensForActorUuid(actorUuid) {
    if (!actorUuid || !canvas?.tokens?.placeables) return [];

    return canvas.tokens.placeables.filter(token => {
      if (!token?.actor?.uuid) return false;
      if (token.actor.uuid !== actorUuid) return false;
      if (token.document?.hidden) return false;
      return true;
    });
  }

  function collectTargetTokenUuids(report = {}) {
    const rows = collectFxRows(report);
    const tokenUuids = [];

    for (const row of rows) {
      const actorUuid = actorUuidFromRow(row);
      const tokens = findTokensForActorUuid(actorUuid);

      for (const token of tokens) {
        if (token?.document?.uuid) tokenUuids.push(token.document.uuid);
      }
    }

    return uniq(tokenUuids);
  }

  function pickIcon(report = {}) {
    const rows = collectFxRows(report);

    for (const row of rows) {
      const img = effectImgFromRow(row);
      if (img) return img;
    }

    return "icons/svg/aura.svg";
  }

  function buildTokenInfo(report = {}) {
    const rows = collectFxRows(report);
    const out = [];

    for (const row of rows) {
      const actorUuid = actorUuidFromRow(row);
      const tokens = findTokensForActorUuid(actorUuid);

      for (const token of tokens) {
        out.push({
          tokenUuid: token.document.uuid,
          actorUuid,
          actorName: row?.actor?.name ?? token.actor?.name ?? "",
          effectName: effectNameFromRow(row),
          effectImg: effectImgFromRow(row),
          status: row.status,
          category: categoryFromRow(row)
        });
      }
    }

    const byToken = new Map();

    for (const info of out) {
      if (!byToken.has(info.tokenUuid)) {
        byToken.set(info.tokenUuid, info);
      }
    }

    return Array.from(byToken.values());
  }

  // --------------------------------------------------------------------------
  // Pseudo script
  // --------------------------------------------------------------------------

  const PSEUDO_SCRIPT_SOURCE = String.raw`
const { targetTokens, params, meta } = ctx;

const tokens = Array.isArray(targetTokens) ? targetTokens.filter(Boolean) : [];
if (!tokens.length) return;

const cfg = params || {};
const category = String(cfg.category || "Other");
const color = Number(cfg.color ?? 0xffd36a);
const zIndex = Number(cfg.zIndex ?? 7000);

const pulseMs = Number(cfg.pulseMs ?? 760);
const iconMs = Number(cfg.iconMs ?? 820);
const ringDelayMs = Number(cfg.ringDelayMs ?? 130);

const ringAlpha = Number(cfg.ringAlpha ?? 0.9);
const glowAlpha = Number(cfg.glowAlpha ?? 0.22);

const playRing = cfg.playRing !== false;
const playGlow = cfg.playGlow !== false;
const playIcon = cfg.playIcon !== false;
const playSfx = cfg.playSfx !== false;

const iconSrc = String(cfg.iconSrc || "icons/svg/aura.svg");
const sfxSrc = String(cfg.sfxSrc || "");
const sfxVolume = Number(cfg.sfxVolume ?? 0.75);

function emitLocal(eventName, payload) {
  try {
    globalThis.ONI?.emit?.(eventName, payload, { local: true, world: false });
  } catch (_e) {
    try { Hooks.callAll(eventName, payload); } catch (__e) {}
  }
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerp(a, b, t) {
  return a + ((b - a) * t);
}

function waitMs(ms) {
  if (typeof wait === "function") return wait(ms);
  return new Promise(resolve => setTimeout(resolve, ms));
}

function animateMs(durationMs, onFrame, easing = easeOutCubic) {
  return new Promise(resolve => {
    const dur = Math.max(1, Number(durationMs) || 1);
    const start = performance.now();
    const ticker = canvas.app.ticker;

    const update = () => {
      const raw = (performance.now() - start) / dur;
      const t = Math.min(Math.max(raw, 0), 1);
      const e = easing(t);

      try {
        onFrame(e, t);
      } catch (e) {
        console.error("[ONI][AEM-FX][Pseudo] frame error", e);
      }

      if (t >= 1) {
        ticker.remove(update);
        resolve();
      }
    };

    ticker.add(update);
  });
}

async function playLocalAudio(src, volume) {
  if (!src || !playSfx) return;

  try {
    const helper =
      (typeof FAudioHelper !== "undefined" && FAudioHelper) ||
      foundry?.audio?.AudioHelper ||
      null;

    if (helper?.play) {
      await helper.play({
        src,
        volume: Number(volume ?? 0.75),
        autoplay: true,
        loop: false
      }, false);
      return;
    }
  } catch (e) {
    console.warn("[ONI][AEM-FX][Pseudo] AudioHelper failed", e);
  }

  try {
    const audio = new Audio(src);
    audio.volume = Number(volume ?? 0.75);
    audio.loop = false;
    void audio.play();
  } catch (e) {
    console.warn("[ONI][AEM-FX][Pseudo] Audio fallback failed", e);
  }
}

function makeRing(radius, thickness, alpha) {
  const g = new PIXI.Graphics();
  g.lineStyle(Math.max(1, thickness), color, alpha);
  g.drawCircle(0, 0, Math.max(1, radius));
  return g;
}

function makeGlow(radius, alpha) {
  const g = new PIXI.Graphics();
  g.beginFill(color, alpha);
  g.drawCircle(0, 0, Math.max(1, radius));
  g.endFill();
  return g;
}

async function makeIconSprite(src) {
  try {
    const tex = await loadTexture(src);
    if (!tex) return null;

    const sprite = new PIXI.Sprite(tex);
    sprite.anchor.set(0.5);
    return sprite;
  } catch (e) {
    console.warn("[ONI][AEM-FX][Pseudo] Could not load icon", src, e);
    return null;
  }
}

function tokenBaseRadius(token) {
  const grid = canvas?.grid?.size ?? 100;
  const w = Number(token?.w ?? grid);
  const h = Number(token?.h ?? grid);
  return Math.max(grid * 0.34, Math.max(w, h) * 0.46);
}

async function animateTokenEffect(token, index) {
  const center = token.center ?? {
    x: token.x + ((token.w ?? 1) / 2),
    y: token.y + ((token.h ?? 1) / 2)
  };

  const baseRadius = tokenBaseRadius(token);
  const layer = new PIXI.Container();
  layer.zIndex = zIndex + index;
  layer.x = center.x;
  layer.y = center.y;

  canvas.stage.sortableChildren = true;
  canvas.stage.addChild(layer);
  canvas.stage.sortChildren();

  const children = [];

  try {
    const tasks = [];

    if (playGlow) {
      const glow = makeGlow(baseRadius * 0.82, glowAlpha);
      glow.alpha = 0;
      layer.addChild(glow);
      children.push(glow);

      tasks.push(
        animateMs(pulseMs, (e, t) => {
          glow.alpha = Math.sin(t * Math.PI) * glowAlpha;
          const scale = lerp(0.7, 1.22, e);
          glow.scale.set(scale);
        }, easeInOutCubic)
      );
    }

    if (playRing) {
      const ring1 = makeRing(baseRadius * 0.65, Math.max(2, baseRadius * 0.035), ringAlpha);
      ring1.alpha = 0;
      layer.addChild(ring1);
      children.push(ring1);

      tasks.push(
        animateMs(pulseMs, (e, t) => {
          ring1.alpha = (1 - e) * ringAlpha;
          const scale = lerp(0.55, 1.55, e);
          ring1.scale.set(scale);
        }, easeOutCubic)
      );

      const ring2 = makeRing(baseRadius * 0.48, Math.max(2, baseRadius * 0.026), ringAlpha * 0.8);
      ring2.alpha = 0;
      layer.addChild(ring2);
      children.push(ring2);

      tasks.push((async () => {
        await waitMs(ringDelayMs);
        await animateMs(Math.max(1, pulseMs - ringDelayMs), (e, t) => {
          ring2.alpha = (1 - e) * ringAlpha * 0.8;
          const scale = lerp(0.55, 1.85, e);
          ring2.scale.set(scale);
        }, easeOutCubic);
      })());
    }

    if (playIcon) {
      const icon = await makeIconSprite(iconSrc);

      if (icon) {
        const size = Math.max(24, Math.min(52, baseRadius * 0.55));
        icon.width = size;
        icon.height = size;
        icon.y = -baseRadius * 0.85;
        icon.alpha = 0;
        icon.zIndex = zIndex + 100 + index;

        layer.addChild(icon);
        children.push(icon);

        const startY = icon.y;
        const endY = startY - Math.max(18, baseRadius * 0.25);

        tasks.push(
          animateMs(iconMs, (e, t) => {
            icon.y = lerp(startY, endY, e);
            icon.alpha = Math.sin(t * Math.PI);
            const scale = lerp(0.75, 1.05, easeOutCubic(Math.min(t * 1.8, 1)));
            icon.scale.set(Math.sign(icon.scale.x || 1) * Math.abs(icon.scale.x) * 0 + scale);
          }, easeOutCubic)
        );
      }
    }

    await Promise.all(tasks);
    await waitMs(40);

  } finally {
    try {
      if (layer.parent) layer.parent.removeChild(layer);
      layer.destroy({ children: true, texture: false, baseTexture: false });
    } catch (e) {
      console.warn("[ONI][AEM-FX][Pseudo] cleanup failed", e);
    }
  }
}

const eventPayload = {
  type: "activeEffectManagerFx",
  category,
  targetTokenIds: tokens.map(t => t.id),
  targetTokenUuids: tokens.map(t => t.document?.uuid).filter(Boolean),
  sceneId: canvas.scene?.id ?? null,
  runId: ctx.runId,
  timestamp: Date.now(),
  meta
};

emitLocal("oni:animationStart", eventPayload);

try {
  if (sfxSrc) void playLocalAudio(sfxSrc, sfxVolume);

  await Promise.all(
    tokens.map((token, index) => animateTokenEffect(token, index))
  );
} finally {
  emitLocal("oni:animationEnd", {
    ...eventPayload,
    timestamp: Date.now()
  });
}
`;

  // --------------------------------------------------------------------------
  // Main FX API
  // --------------------------------------------------------------------------

  async function play(report = {}, options = {}) {
    const cfg = {
      ...DEFAULT_CONFIG,
      ...(options.fx ?? {}),
      ...(options.activeEffectFx ?? {})
    };

    if (cfg.enabled === false || options.playFx === false || options.silent === true) {
      return {
        ok: true,
        skipped: true,
        reason: "fx_disabled_or_silent"
      };
    }

    const pseudo = getPseudoApi();

    if (!pseudo?.play) {
      warn("game.ONI.pseudo.play is not available. Skipping Active Effect FX.");
      return {
        ok: false,
        skipped: true,
        reason: "pseudo_api_not_found"
      };
    }

    const targetTokenUuids = collectTargetTokenUuids(report);

    if (!targetTokenUuids.length) {
      log("No on-scene tokens found for Active Effect FX.", {
        runId: report.runId,
        action: report.action
      });

      return {
        ok: true,
        skipped: true,
        reason: "no_on_scene_tokens"
      };
    }

    const category = options.category ?? classifyReport(report);
    const iconSrc = options.iconSrc ?? pickIcon(report);
    const sfxSrc =
      options.sfxSrc ??
      cfg.sfxSrc ??
      DEFAULT_SFX[category] ??
      DEFAULT_SFX.Other;

    const color =
      Number(options.color ?? cfg.color ?? DEFAULT_COLORS[category] ?? DEFAULT_COLORS.Other);

    const runId = report.runId ?? randomId("aem-fx");

    const payload = {
      scriptId: "activeEffectManager.feedback",
      scriptSource: PSEUDO_SCRIPT_SOURCE,

      // Use the first affected token as casterTokenUuid for core compatibility.
      // The pseudo script itself uses ctx.targetTokens.
      casterTokenUuid: targetTokenUuids[0],
      targetTokenUuids,

      params: {
        category,
        color,
        iconSrc,
        sfxSrc,
        sfxVolume: Number(options.sfxVolume ?? cfg.sfxVolume ?? DEFAULT_CONFIG.sfxVolume),

        pulseMs: Number(options.pulseMs ?? cfg.pulseMs ?? DEFAULT_CONFIG.pulseMs),
        iconMs: Number(options.iconMs ?? cfg.iconMs ?? DEFAULT_CONFIG.iconMs),
        ringDelayMs: Number(options.ringDelayMs ?? cfg.ringDelayMs ?? DEFAULT_CONFIG.ringDelayMs),

        ringAlpha: Number(options.ringAlpha ?? cfg.ringAlpha ?? DEFAULT_CONFIG.ringAlpha),
        glowAlpha: Number(options.glowAlpha ?? cfg.glowAlpha ?? DEFAULT_CONFIG.glowAlpha),

        zIndex: Number(options.zIndex ?? cfg.zIndex ?? DEFAULT_CONFIG.zIndex),

        playSfx: options.playSfx ?? cfg.playSfx,
        playIcon: options.playIcon ?? cfg.playIcon,
        playRing: options.playRing ?? cfg.playRing,
        playGlow: options.playGlow ?? cfg.playGlow,

        tokenInfo: buildTokenInfo(report)
      },

      meta: {
        source: "ActiveEffectManager-fx",
        runId,
        action: report.action ?? null,
        category,
        senderUserId: game.userId ?? null,
        senderUserName: game.user?.name ?? null
      }
    };

    try {
      const result = await pseudo.play(payload);

      log("Pseudo FX played.", {
        runId,
        category,
        tokenCount: targetTokenUuids.length
      });

      return {
        ok: true,
        runId,
        category,
        targetTokenUuids,
        pseudoResult: result ?? null
      };

    } catch (e) {
      warn("Pseudo FX failed.", e);

      return {
        ok: false,
        runId,
        category,
        targetTokenUuids,
        error: String(e?.message ?? e)
      };
    }
  }

  async function playForTokens(payload = {}) {
    const pseudo = getPseudoApi();

    if (!pseudo?.play) {
      return {
        ok: false,
        reason: "pseudo_api_not_found"
      };
    }

    const targetTokenUuids = uniq(payload.targetTokenUuids ?? payload.tokenUuids ?? []);

    if (!targetTokenUuids.length) {
      return {
        ok: false,
        reason: "no_target_token_uuids"
      };
    }

    const category = safeString(payload.category, "Other");
    const runId = payload.runId ?? randomId("aem-fx-manual");

    const fxPayload = {
      scriptId: "activeEffectManager.feedback.manual",
      scriptSource: PSEUDO_SCRIPT_SOURCE,
      casterTokenUuid: payload.casterTokenUuid ?? targetTokenUuids[0],
      targetTokenUuids,
      params: {
        ...clone(DEFAULT_CONFIG, {}),
        ...(payload.params ?? {}),

        category,
        color: Number(payload.color ?? DEFAULT_COLORS[category] ?? DEFAULT_COLORS.Other),
        iconSrc: payload.iconSrc ?? "icons/svg/aura.svg",
        sfxSrc: payload.sfxSrc ?? DEFAULT_SFX[category] ?? DEFAULT_SFX.Other,
        sfxVolume: Number(payload.sfxVolume ?? DEFAULT_CONFIG.sfxVolume)
      },
      meta: {
        source: "ActiveEffectManager-fx-manual",
        runId,
        category,
        senderUserId: game.userId ?? null,
        senderUserName: game.user?.name ?? null
      }
    };

    const result = await pseudo.play(fxPayload);

    return {
      ok: true,
      runId,
      category,
      targetTokenUuids,
      pseudoResult: result ?? null
    };
  }

  function configure(newDefaults = {}) {
    Object.assign(DEFAULT_CONFIG, newDefaults ?? {});
    return clone(DEFAULT_CONFIG, {});
  }

  function getConfig() {
    return clone(DEFAULT_CONFIG, {});
  }

  // --------------------------------------------------------------------------
  // API
  // --------------------------------------------------------------------------

  const api = {
    version: "0.1.0",

    play,
    playForTokens,

    configure,
    getConfig,

    classifyReport,
    collectTargetTokenUuids,

    _internal: {
      DEFAULT_SFX,
      DEFAULT_COLORS,
      DEFAULT_CONFIG,
      PSEUDO_SCRIPT_SOURCE,
      collectFxRows,
      buildTokenInfo,
      pickIcon,
      findTokensForActorUuid
    }
  };

  exposeApi(api);

  Hooks.once("ready", () => {
    exposeApi(api);

    log("Ready. Active Effect Manager FX API installed.", {
      api: "FUCompanion.api.activeEffectManager.fx.play(report)"
    });
  });
})();