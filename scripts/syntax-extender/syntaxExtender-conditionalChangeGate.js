/*:
 * @target Foundry VTT v12
 * @plugindesc [ONI] Adds conditional Active Effect change gates like aeWhen("Crisis", "RS").
 *
 * File:
 * modules/fabula-ultima-companion/scripts/syntaxExtender-conditionalChangeGate.js
 */

(() => {
  "use strict";

  const MODULE_ID = "fabula-ultima-companion";
  const TAG = "[ONI][AE-Gate]";

  const HELPERS = ["aeWhen", "aeUuidWhen", "aeStatusWhen"];

  const state = {
    settingsRegistered: false,

    debug: false,

    actorPatched: false,
    actorPatchTarget: null,
    actorPatchMode: null,

    effectPatched: false,
    effectPatchTarget: null,
    effectPatchMode: null,

    actorGuard: new WeakSet(),
    actorCache: new WeakMap()
  };

  // ------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------

  const settingDefs = {
    enabled: {
      name: "Enable AE Conditional Change Gate",
      hint: "Allows Active Effect changes like aeWhen(\"Crisis\", \"RS\") to skip the change completely when false.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    },

    debug: {
      name: "AE Conditional Gate Debug Logs",
      hint: "Prints detailed logs when aeWhen / aeUuidWhen / aeStatusWhen are evaluated.",
      scope: "client",
      config: true,
      type: Boolean,
      default: false
    },

    useLibWrapper: {
      name: "AE Conditional Gate Prefer libWrapper",
      hint: "Usually leave this OFF. AE Syntax owns the libWrapper patch; AE Gate should use the direct backup layer to avoid startup self-conflict warnings.",
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    }
  };

  function registerSettings() {
    if (state.settingsRegistered) return;

    for (const [key, data] of Object.entries(settingDefs)) {
      try {
        game.settings.register(MODULE_ID, `activeEffectConditionalGate.${key}`, data);
      } catch (_err) {
        // Already registered or settings unavailable.
      }
    }

    state.settingsRegistered = true;
  }

  function getSetting(key, fallback = undefined) {
    try {
      return game.settings.get(MODULE_ID, `activeEffectConditionalGate.${key}`);
    } catch (_err) {
      return fallback ?? settingDefs[key]?.default;
    }
  }

  async function setSetting(key, value) {
    try {
      await game.settings.set(MODULE_ID, `activeEffectConditionalGate.${key}`, value);
    } catch (_err) {}
  }

  const isEnabled = () => !!getSetting("enabled", true);
  const isDebug = () => !!state.debug || !!getSetting("debug", false);
  const preferLibWrapper = () => !!getSetting("useLibWrapper", true);

  const log = (...args) => {
    if (isDebug()) console.log(TAG, ...args);
  };

  const warn = (...args) => {
    console.warn(TAG, ...args);
  };

  // ------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------

  function normalize(value) {
    return String(value ?? "").trim().toLowerCase();
  }

  function isActorDocument(doc) {
    return doc?.documentName === "Actor" || doc?.constructor?.name === "Actor";
  }

  function safeArrayFrom(value) {
    if (!value) return [];

    try {
      if (globalThis.Collection && value instanceof Collection) {
        return Array.from(value.values());
      }

      if (typeof value.values === "function") {
        return Array.from(value.values());
      }

      if (Array.isArray(value)) {
        return value;
      }

      if (Symbol.iterator in Object(value) && typeof value !== "string") {
        return Array.from(value);
      }
    } catch (_err) {}

    return [];
  }

  function clone(value) {
    try {
      if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
    } catch (_err) {}

    try {
      return structuredClone(value);
    } catch (_err) {}

    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_err) {}

    if (Array.isArray(value)) return [...value];
    if (value && typeof value === "object") return { ...value };
    return value;
  }

  function isEffectUsable(effect) {
    if (!effect) return false;
    if (effect.disabled) return false;
    if (effect.isSuppressed) return false;
    return true;
  }

  function hasGateSyntax(value) {
    return typeof value === "string"
      && /\b(?:aeWhen|aeUuidWhen|aeStatusWhen)\s*\(/i.test(value);
  }

  function resolveActorFromEffect(effect, explicitActor = null) {
    if (isActorDocument(explicitActor)) return explicitActor;
    if (explicitActor?.actor && isActorDocument(explicitActor.actor)) return explicitActor.actor;

    let parent = effect?.parent ?? null;

    for (let i = 0; parent && i < 10; i++) {
      if (isActorDocument(parent)) return parent;
      if (parent.actor && isActorDocument(parent.actor)) return parent.actor;
      parent = parent.parent ?? null;
    }

    return null;
  }

  function collectActorEffects(actor) {
    const results = [];
    const seen = new Set();

    const add = (effect) => {
      if (!effect) return;

      const id = effect.uuid ?? effect.id ?? effect._id ?? `${effect.name}-${results.length}`;
      if (seen.has(id)) return;

      seen.add(id);
      results.push(effect);
    };

    for (const effect of safeArrayFrom(actor?.effects)) {
      add(effect);
    }

    try {
      for (const effect of safeArrayFrom(actor?.temporaryEffects)) {
        add(effect);
      }
    } catch (_err) {}

    return results.filter(isEffectUsable);
  }

  function buildActorCache(actor) {
    const effects = collectActorEffects(actor);

    const names = new Set();
    const uuids = new Set();
    const statuses = new Set();

    const addName = (raw) => {
      const key = normalize(raw);
      if (key) names.add(key);
    };

    for (const effect of effects) {
      addName(effect?.name);
      addName(effect?.id);
      addName(effect?._id);
      addName(effect?.uuid);
      addName(effect?._source?.name);

      const uuid = normalize(effect?.uuid);
      if (uuid) uuids.add(uuid);

      for (const status of safeArrayFrom(effect?.statuses)) {
        const key = normalize(status);
        if (key) statuses.add(key);
      }
    }

    return {
      actor,
      effects,
      names,
      uuids,
      statuses,
      createdAt: Date.now()
    };
  }

  function getActorCache(actor) {
    if (!actor) return null;

    let cache = state.actorCache.get(actor);
    if (!cache) {
      cache = buildActorCache(actor);
      state.actorCache.set(actor, cache);
    }

    return cache;
  }

  function withActorCache(actor, callback) {
    if (!actor) return callback();

    const alreadyHadCache = state.actorCache.has(actor);

    if (!alreadyHadCache) {
      state.actorCache.set(actor, buildActorCache(actor));
    }

    try {
      return callback();
    } finally {
      if (!alreadyHadCache) {
        state.actorCache.delete(actor);
      }
    }
  }

  // ------------------------------------------------------------
  // Effect checks
  // ------------------------------------------------------------

  function hasEffect(actor, effectName) {
    const cache = getActorCache(actor);
    if (!cache) return false;

    const wanted = normalize(effectName);
    if (!wanted) return false;

    return cache.names.has(wanted) || cache.statuses.has(wanted);
  }

  function hasEffectUuid(actor, uuid) {
    const cache = getActorCache(actor);
    if (!cache) return false;

    const wanted = normalize(uuid);
    if (!wanted) return false;

    return cache.uuids.has(wanted);
  }

  function hasEffectStatus(actor, statusId) {
    const cache = getActorCache(actor);
    if (!cache) return false;

    const wanted = normalize(statusId);
    if (!wanted) return false;

    return cache.statuses.has(wanted);
  }

  // ------------------------------------------------------------
  // Gate syntax parser
  // ------------------------------------------------------------

  /*
   * Supported:
   *
   * aeWhen("Crisis", "RS")
   * ${aeWhen("Crisis", "RS")}$
   *
   * aeUuidWhen("Actor.x.ActiveEffect.y", "RS")
   * aeStatusWhen("crisis", "RS")
   */
  function parseGateSyntax(rawValue) {
    const text = String(rawValue ?? "").trim();

    const match = text.match(
      /^\s*(?:\$\{\s*)?(aeWhen|aeUuidWhen|aeStatusWhen)\s*\(\s*(['"])(.*?)\2\s*,\s*(?:(['"])(.*?)\4|([^)]*?))\s*\)\s*(?:\}\$)?\s*$/i
    );

    if (!match) {
      return {
        ok: false,
        reason: "not_gate_syntax",
        rawValue
      };
    }

    const helper = String(match[1] ?? "").trim();
    const query = String(match[3] ?? "").trim();

    const quotedValue = match[5];
    const unquotedValue = match[6];

    const trueValue = String(
      quotedValue !== undefined
        ? quotedValue
        : unquotedValue ?? ""
    ).trim();

    if (!helper || !query) {
      return {
        ok: false,
        reason: "missing_helper_or_query",
        rawValue
      };
    }

    return {
      ok: true,
      helper,
      query,
      trueValue,
      rawValue
    };
  }

  function evaluateGate(rawValue, actor, effect = null, change = null) {
    const parsed = parseGateSyntax(rawValue);

    if (!parsed.ok) {
      return {
        recognized: false,
        active: false,
        skipped: false,
        value: rawValue,
        reason: parsed.reason
      };
    }

    let active = false;

    const helperNorm = normalize(parsed.helper);

    if (helperNorm === "aewhen") {
      active = hasEffect(actor, parsed.query);
    } else if (helperNorm === "aeuuidwhen") {
      active = hasEffectUuid(actor, parsed.query);
    } else if (helperNorm === "aestatuswhen") {
      active = hasEffectStatus(actor, parsed.query);
    }

    const result = {
      recognized: true,
      active,
      skipped: !active,
      helper: parsed.helper,
      query: parsed.query,
      value: active ? parsed.trueValue : rawValue,
      rawValue,
      actorName: actor?.name ?? null,
      effectName: effect?.name ?? effect?.id ?? null,
      key: change?.key ?? null
    };

    log("Gate evaluated.", result);

    return result;
  }

  // ------------------------------------------------------------
  // Patch 1: ActiveEffect.apply
  // This is the main skip behavior.
  // If gate is false, do not call the original apply at all.
  // ------------------------------------------------------------

  function transformApplyArgsOrSkip(effect, args) {
    const explicitActor = args.find((arg) => isActorDocument(arg)) ?? null;
    const actor = resolveActorFromEffect(effect, explicitActor);

    if (!actor) {
      return {
        skip: false,
        args,
        reason: "no_actor"
      };
    }

    return withActorCache(actor, () => {
      let changed = false;
      const nextArgs = [...args];

      for (let i = 0; i < nextArgs.length; i++) {
        const arg = nextArgs[i];

        if (!arg || typeof arg.value !== "string") continue;
        if (!hasGateSyntax(arg.value)) continue;

        const decision = evaluateGate(arg.value, actor, effect, arg);

        if (!decision.recognized) continue;

        if (!decision.active) {
          log("Skipping Active Effect change.", {
            actor: actor.name,
            effect: effect?.name ?? effect?.id,
            key: arg.key,
            value: arg.value
          });

          return {
            skip: true,
            args,
            reason: "gate_false",
            decision
          };
        }

        const cloned = clone(arg);
        cloned.value = decision.value;
        nextArgs[i] = cloned;
        changed = true;

        log("Gate active. Applying transformed value.", {
          actor: actor.name,
          effect: effect?.name ?? effect?.id,
          key: cloned.key,
          before: arg.value,
          after: cloned.value
        });
      }

      return {
        skip: false,
        args: changed ? nextArgs : args,
        reason: changed ? "gate_true_transformed" : "no_gate_change"
      };
    });
  }

  function getActiveEffectPatchTarget() {
    const candidates = [
      CONFIG?.ActiveEffect?.documentClass,
      globalThis.CustomActiveEffect,
      globalThis.ActiveEffect?.implementation,
      globalThis.ActiveEffect
    ].filter(Boolean);

    const uniqueCandidates = [...new Set(candidates)];

    for (const cls of uniqueCandidates) {
      const proto = cls?.prototype;
      if (proto && typeof proto.apply === "function") {
        return { cls, proto };
      }
    }

    return null;
  }

  function patchActiveEffectDirect() {
    const target = getActiveEffectPatchTarget();

    if (!target) {
      warn("Could not patch ActiveEffect.apply(). Patch target not found.");
      return false;
    }

    const { cls, proto } = target;

    if (proto.__oniAeConditionalGateApplyPatched) {
      state.effectPatched = true;
      state.effectPatchTarget = cls?.name ?? "ActiveEffect";
      state.effectPatchMode = "direct-existing";
      return true;
    }

    const original = proto.apply;

    proto.apply = function oniAeConditionalGateApply(...args) {
      if (!isEnabled()) {
        return original.apply(this, args);
      }

      const result = transformApplyArgsOrSkip(this, args);

      if (result.skip) {
        return null;
      }

      return original.apply(this, result.args);
    };

    proto.__oniAeConditionalGateApplyPatched = true;
    proto.__oniAeConditionalGateOriginalApply = original;

    state.effectPatched = true;
    state.effectPatchTarget = cls?.name ?? "ActiveEffect";
    state.effectPatchMode = "direct";

    console.log(TAG, `Patched ${state.effectPatchTarget}.prototype.apply() directly.`);
    return true;
  }

  function patchActiveEffectLibWrapper() {
    if (!globalThis.libWrapper || !preferLibWrapper()) return false;

    try {
      libWrapper.register(
        MODULE_ID,
        "CONFIG.ActiveEffect.documentClass.prototype.apply",
        function oniAeConditionalGateApplyWrapper(wrapped, ...args) {
          if (!isEnabled()) {
            return wrapped(...args);
          }

          const result = transformApplyArgsOrSkip(this, args);

          if (result.skip) {
            return null;
          }

          return wrapped(...result.args);
        },
        "WRAPPER"
      );

      state.effectPatched = true;
      state.effectPatchTarget = CONFIG?.ActiveEffect?.documentClass?.name ?? "CONFIG.ActiveEffect.documentClass";
      state.effectPatchMode = "libWrapper";

      console.log(TAG, `Patched ${state.effectPatchTarget}.prototype.apply() with libWrapper.`);
      return true;
    } catch (err) {
      warn("libWrapper ActiveEffect.apply patch failed. Falling back to direct patch.", err);
      return false;
    }
  }

  function patchActiveEffectApply() {
    if (state.effectPatched) return true;
    return patchActiveEffectLibWrapper() || patchActiveEffectDirect();
  }

  // ------------------------------------------------------------
  // Patch 2: Actor.applyActiveEffects
  // Backup layer:
  // Temporarily removes false gated changes before actor-level AE application.
  // ------------------------------------------------------------

  function withGatedActorChanges(actor, callback) {
    if (!isEnabled()) return callback();
    if (!actor || state.actorGuard.has(actor)) return callback();

    const restoredValues = [];
    const removedChanges = [];

    state.actorGuard.add(actor);

    try {
      return withActorCache(actor, () => {
        const effects = collectActorEffects(actor);

        for (const effect of effects) {
          const changes = effect?.changes;

          if (!Array.isArray(changes)) continue;

          for (let i = changes.length - 1; i >= 0; i--) {
            const change = changes[i];

            if (!change || typeof change.value !== "string") continue;
            if (!hasGateSyntax(change.value)) continue;

            const decision = evaluateGate(change.value, actor, effect, change);

            if (!decision.recognized) continue;

            if (!decision.active) {
              const [removed] = changes.splice(i, 1);

              removedChanges.push({
                changes,
                index: i,
                change: removed
              });

              log("Temporarily removed gated change.", {
                actor: actor.name,
                effect: effect?.name ?? effect?.id,
                key: change.key,
                value: change.value
              });

              continue;
            }

            restoredValues.push({
              change,
              value: change.value
            });

            change.value = decision.value;

            log("Temporarily transformed gated change.", {
              actor: actor.name,
              effect: effect?.name ?? effect?.id,
              key: change.key,
              before: decision.rawValue,
              after: decision.value
            });
          }
        }

        return callback();
      });
    } finally {
      for (const entry of restoredValues.reverse()) {
        try {
          entry.change.value = entry.value;
        } catch (_err) {}
      }

      for (const entry of removedChanges.reverse()) {
        try {
          entry.changes.splice(entry.index, 0, entry.change);
        } catch (_err) {}
      }

      state.actorGuard.delete(actor);
    }
  }

  function getActorPatchTarget() {
    const candidates = [
      CONFIG?.Actor?.documentClass,
      globalThis.Actor
    ].filter(Boolean);

    const uniqueCandidates = [...new Set(candidates)];

    for (const cls of uniqueCandidates) {
      const proto = cls?.prototype;
      if (proto && typeof proto.applyActiveEffects === "function") {
        return { cls, proto };
      }
    }

    return null;
  }

  function patchActorDirect() {
    const target = getActorPatchTarget();

    if (!target) {
      warn("Could not patch Actor.applyActiveEffects(). Patch target not found.");
      return false;
    }

    const { cls, proto } = target;

    if (proto.__oniAeConditionalGateActorPatched) {
      state.actorPatched = true;
      state.actorPatchTarget = cls?.name ?? "Actor";
      state.actorPatchMode = "direct-existing";
      return true;
    }

    const original = proto.applyActiveEffects;

    proto.applyActiveEffects = function oniAeConditionalGateActorApply(...args) {
      return withGatedActorChanges(this, () => {
        return original.apply(this, args);
      });
    };

    proto.__oniAeConditionalGateActorPatched = true;
    proto.__oniAeConditionalGateOriginalActorApply = original;

    state.actorPatched = true;
    state.actorPatchTarget = cls?.name ?? "Actor";
    state.actorPatchMode = "direct";

    console.log(TAG, `Patched ${state.actorPatchTarget}.prototype.applyActiveEffects() directly.`);
    return true;
  }

  function patchActorLibWrapper() {
    if (!globalThis.libWrapper || !preferLibWrapper()) return false;

    try {
      libWrapper.register(
        MODULE_ID,
        "CONFIG.Actor.documentClass.prototype.applyActiveEffects",
        function oniAeConditionalGateActorWrapper(wrapped, ...args) {
          return withGatedActorChanges(this, () => {
            return wrapped(...args);
          });
        },
        "WRAPPER"
      );

      state.actorPatched = true;
      state.actorPatchTarget = CONFIG?.Actor?.documentClass?.name ?? "CONFIG.Actor.documentClass";
      state.actorPatchMode = "libWrapper";

      console.log(TAG, `Patched ${state.actorPatchTarget}.prototype.applyActiveEffects() with libWrapper.`);
      return true;
    } catch (err) {
      warn("libWrapper Actor.applyActiveEffects patch failed. Falling back to direct patch.", err);
      return false;
    }
  }

  function patchActorApplyActiveEffects() {
    if (state.actorPatched) return true;
    return patchActorLibWrapper() || patchActorDirect();
  }

  // ------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------

  function getActorFromInput(actorOrName) {
    if (typeof actorOrName === "string") {
      return game.actors.getName(actorOrName) ?? game.actors.get(actorOrName);
    }

    return actorOrName;
  }

  function installApi() {
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};

    globalThis.FUCompanion.api.activeEffectConditionalGate = {
      status() {
        const enabled = isEnabled();
        const ok = enabled && !!state.actorPatched && !!state.effectPatched;

        return {
          ok,
          enabled,

          actorPatched: !!state.actorPatched,
          actorPatchTarget: state.actorPatchTarget,
          actorPatchMode: state.actorPatchMode,

          effectPatched: !!state.effectPatched,
          effectPatchTarget: state.effectPatchTarget,
          effectPatchMode: state.effectPatchMode,

          debug: isDebug(),
          libWrapperAvailable: !!globalThis.libWrapper,
          preferLibWrapper: preferLibWrapper(),

          helpers: HELPERS
        };
      },

      async setEnabled(value = true) {
        await setSetting("enabled", Boolean(value));
        return this.status();
      },

      async setDebug(value = true) {
        state.debug = Boolean(value);
        await setSetting("debug", Boolean(value));
        console.log(TAG, "Debug mode:", isDebug());
        return isDebug();
      },

      parse(value) {
        return parseGateSyntax(value);
      },

      test(actorOrName, value) {
        const actor = getActorFromInput(actorOrName);

        if (!actor) {
          return {
            ok: false,
            reason: "Actor not found.",
            actor: actorOrName,
            value
          };
        }

        return withActorCache(actor, () => {
          const result = evaluateGate(value, actor);

          return {
            ok: true,
            actor: actor.name,
            input: value,
            result,
            detectedEffects: collectActorEffects(actor).map(e => ({
              name: e.name,
              id: e.id,
              uuid: e.uuid,
              disabled: e.disabled,
              statuses: safeArrayFrom(e.statuses)
            })),
            status: this.status()
          };
        });
      },

      forcePatch() {
        const actorPatch = patchActorApplyActiveEffects();
        const effectPatch = patchActiveEffectApply();

        return {
          actorPatch,
          effectPatch,
          status: this.status()
        };
      }
    };
  }

  // ------------------------------------------------------------
  // Startup
  // ------------------------------------------------------------

  Hooks.once("init", () => {
    registerSettings();
    state.debug = !!getSetting("debug", false);

    installApi();
    patchActorApplyActiveEffects();
    patchActiveEffectApply();
  });

  Hooks.once("ready", () => {
    registerSettings();
    state.debug = !!getSetting("debug", false);

    installApi();

    if (!state.actorPatched) {
      patchActorApplyActiveEffects();
    }

    if (!state.effectPatched) {
      patchActiveEffectApply();
    }

    console.log(TAG, "Ready.", globalThis.FUCompanion.api.activeEffectConditionalGate.status());
  });
})();