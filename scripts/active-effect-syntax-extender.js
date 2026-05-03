/*:
 * @target Foundry VTT v12
 * @plugindesc [ONI] Extends Active Effect value syntax with actor-aware helpers like ae("Wet").
 *
 * File:
 * modules/fabula-ultima-companion/scripts/active-effect-syntax-extender.js
 */

(() => {
  "use strict";

  const TAG = "[ONI][AE-Syntax]";

  const state = {
    debug: false,

    actorPatched: false,
    actorPatchTarget: null,
    originalApplyActiveEffects: null,

    customEffectPatched: false,
    customEffectPatchTarget: null,
    originalCustomEffectApply: null
  };

  // ------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------

  const normalize = (value) => {
    return String(value ?? "").trim().toLowerCase();
  };

  const isActorDocument = (doc) => {
    return doc?.documentName === "Actor";
  };

  const safeArrayFrom = (value) => {
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
  };

  const isEffectUsable = (effect) => {
    if (!effect) return false;
    if (effect.disabled) return false;
    if (effect.isSuppressed) return false;
    return true;
  };

  const hasCustomSyntax = (value) => {
    return typeof value === "string"
      && /\b(?:ae|aeUuid|aeStatus|countAe)\s*\(/.test(value);
  };

  const getDocumentName = (doc) => {
    return doc?.name ?? doc?.id ?? doc?._id ?? "(unknown)";
  };

  // ------------------------------------------------------------
  // Actor / Effect resolution
  // ------------------------------------------------------------

  const resolveActorFromEffect = (effect, explicitActor = null) => {
    if (isActorDocument(explicitActor)) return explicitActor;
    if (explicitActor?.actor && isActorDocument(explicitActor.actor)) return explicitActor.actor;

    let parent = effect?.parent ?? null;

    for (let i = 0; parent && i < 10; i++) {
      if (isActorDocument(parent)) return parent;
      if (parent.actor && isActorDocument(parent.actor)) return parent.actor;
      parent = parent.parent ?? null;
    }

    return null;
  };

  const collectActorEffects = (actor) => {
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

    // Some systems/modules expose temporary effects separately.
    // Keep this simple to avoid recursive preparation issues.
    try {
      for (const effect of safeArrayFrom(actor?.temporaryEffects)) {
        add(effect);
      }
    } catch (_err) {}

    return results.filter(isEffectUsable);
  };

  const effectMatchesName = (effect, wantedName) => {
    const wanted = normalize(wantedName);
    if (!wanted) return false;

    // Do NOT read effect.label in Foundry V12.
    // label was migrated to name and creates compatibility warnings.
    const names = [
      effect?.name,
      effect?.id,
      effect?._id,
      effect?.uuid,
      effect?._source?.name
    ].map(normalize);

    if (names.includes(wanted)) return true;

    const statuses = safeArrayFrom(effect?.statuses).map(normalize);
    if (statuses.includes(wanted)) return true;

    return false;
  };

  const hasEffect = (actor, effectName) => {
    if (!actor) return false;
    return collectActorEffects(actor).some((effect) => effectMatchesName(effect, effectName));
  };

  const hasEffectUuid = (actor, uuid) => {
    const wanted = normalize(uuid);
    if (!actor || !wanted) return false;

    return collectActorEffects(actor).some((effect) => {
      return normalize(effect?.uuid) === wanted;
    });
  };

  const hasEffectStatus = (actor, statusId) => {
    const wanted = normalize(statusId);
    if (!actor || !wanted) return false;

    return collectActorEffects(actor).some((effect) => {
      const statuses = safeArrayFrom(effect?.statuses).map(normalize);
      return statuses.includes(wanted);
    });
  };

  const countEffect = (actor, effectName) => {
    if (!actor) return 0;
    return collectActorEffects(actor)
      .filter((effect) => effectMatchesName(effect, effectName))
      .length;
  };

  // ------------------------------------------------------------
  // Syntax transform
  // ------------------------------------------------------------

  const transformValue = (value, context = {}) => {
    if (typeof value !== "string") {
      return {
        changed: false,
        value
      };
    }

    if (!hasCustomSyntax(value)) {
      return {
        changed: false,
        value
      };
    }

    const actor = context.actor ?? null;
    let output = value;

    // ae("Wet")
    output = output.replace(/\bae\s*\(\s*(['"])(.*?)\1\s*\)/g, (_match, _quote, name) => {
      const result = hasEffect(actor, name);

      if (state.debug) {
        console.log(TAG, `ae("${name}") =>`, result, actor?.name ?? null);
      }

      return result ? "true" : "false";
    });

    // aeUuid("Actor.x.ActiveEffect.y")
    output = output.replace(/\baeUuid\s*\(\s*(['"])(.*?)\1\s*\)/g, (_match, _quote, uuid) => {
      const result = hasEffectUuid(actor, uuid);

      if (state.debug) {
        console.log(TAG, `aeUuid("${uuid}") =>`, result, actor?.name ?? null);
      }

      return result ? "true" : "false";
    });

    // aeStatus("wet")
    output = output.replace(/\baeStatus\s*\(\s*(['"])(.*?)\1\s*\)/g, (_match, _quote, statusId) => {
      const result = hasEffectStatus(actor, statusId);

      if (state.debug) {
        console.log(TAG, `aeStatus("${statusId}") =>`, result, actor?.name ?? null);
      }

      return result ? "true" : "false";
    });

    // countAe("Wet")
    output = output.replace(/\bcountAe\s*\(\s*(['"])(.*?)\1\s*\)/g, (_match, _quote, name) => {
      const result = countEffect(actor, name);

      if (state.debug) {
        console.log(TAG, `countAe("${name}") =>`, result, actor?.name ?? null);
      }

      return String(result);
    });

    return {
      changed: output !== value,
      value: output
    };
  };

  // ------------------------------------------------------------
  // Debug logging helper
  // ------------------------------------------------------------

  const logTransform = ({ title, actor, effect, key, path, before, after }) => {
    if (!state.debug) return;

    console.groupCollapsed(`${TAG} ${title}`);
    console.log("Actor:", actor?.name ?? null);
    console.log("Effect:", effect?.name ?? effect?.id ?? effect?._id ?? null);
    if (key) console.log("Key:", key);
    if (path) console.log("Path:", path);
    console.log("Before:", before);
    console.log("After:", after);
    console.groupEnd();
  };

  // ------------------------------------------------------------
  // Patch 1: Actor.applyActiveEffects
  // ------------------------------------------------------------
  // This catches the normal Foundry actor active effect preparation path.
  // It only changes in-memory values temporarily while data is prepared.
  // It does NOT update actor/item/effect documents.

  const withTransformedEffectChanges = (actor, callback) => {
    const restore = [];
    let transformedCount = 0;

    try {
      const effects = collectActorEffects(actor);

      for (const effect of effects) {
        const changes = safeArrayFrom(effect?.changes);

        for (const change of changes) {
          if (!change || typeof change.value !== "string") continue;
          if (!hasCustomSyntax(change.value)) continue;

          const before = change.value;
          const result = transformValue(before, {
            actor,
            effect,
            change
          });

          if (!result.changed) continue;

          try {
            change.value = result.value;
            restore.push({ change, value: before });
            transformedCount++;

            logTransform({
              title: "transformed Active Effect change",
              actor,
              effect,
              key: change.key,
              before,
              after: result.value
            });
          } catch (err) {
            console.error(TAG, "Failed to temporarily transform change.value.", err, {
              actor,
              effect,
              change
            });
          }
        }
      }

      return callback();
    } finally {
      for (const entry of restore.reverse()) {
        try {
          entry.change.value = entry.value;
        } catch (_err) {}
      }

      if (state.debug && transformedCount > 0) {
        console.log(TAG, `Restored ${transformedCount} temporary transformed Active Effect change(s).`);
      }
    }
  };

  const getActorPatchTarget = () => {
    const candidates = [
      CONFIG?.Actor?.documentClass,
      globalThis.Actor
    ].filter(Boolean);

    const unique = [...new Set(candidates)];

    for (const cls of unique) {
      const proto = cls?.prototype;
      if (proto && typeof proto.applyActiveEffects === "function") {
        return { cls, proto };
      }
    }

    return null;
  };

  const patchActorApplyActiveEffects = () => {
    if (state.actorPatched) return true;

    const target = getActorPatchTarget();

    if (!target) {
      console.warn(TAG, "Could not patch Actor.applyActiveEffects(). Patch target not found.");
      return false;
    }

    const { cls, proto } = target;

    if (proto.__oniAeSyntaxActorApplyPatched) {
      state.actorPatched = true;
      state.actorPatchTarget = cls?.name ?? "Actor";
      return true;
    }

    const original = proto.applyActiveEffects;

    proto.applyActiveEffects = function oniAeSyntaxApplyActiveEffects(...args) {
      return withTransformedEffectChanges(this, () => {
        return original.apply(this, args);
      });
    };

    proto.__oniAeSyntaxActorApplyPatched = true;
    proto.__oniAeSyntaxOriginalApplyActiveEffects = original;

    state.originalApplyActiveEffects = original;
    state.actorPatched = true;
    state.actorPatchTarget = cls?.name ?? "Actor";

    console.log(TAG, `Patched ${state.actorPatchTarget}.prototype.applyActiveEffects().`);
    return true;
  };

  // ------------------------------------------------------------
  // Patch 2: CustomActiveEffect.apply
  // ------------------------------------------------------------
  // CSB can call CustomActiveEffect.apply directly and read the effect's
  // own value field, not only Foundry's change.value.
  //
  // This patch transforms:
  // - passed change.value
  // - effect.value
  // - effect.system.value
  // - effect._source.value
  // - effect._source.system.value
  //
  // Everything is temporary and restored immediately after apply() finishes.

  const transformApplyArgs = (args, actor, effect) => {
    let changed = false;
    const nextArgs = [...args];

    for (let i = 0; i < nextArgs.length; i++) {
      const arg = nextArgs[i];

      if (!arg || typeof arg.value !== "string") continue;
      if (!hasCustomSyntax(arg.value)) continue;

      const before = arg.value;
      const result = transformValue(before, {
        actor,
        effect,
        change: arg
      });

      if (!result.changed) continue;

      const cloned = foundry.utils.deepClone(arg);
      cloned.value = result.value;
      nextArgs[i] = cloned;
      changed = true;

      logTransform({
        title: "transformed CustomActiveEffect apply argument",
        actor,
        effect,
        key: cloned.key,
        before,
        after: result.value
      });
    }

    return changed ? nextArgs : args;
  };

  const withTransformedCustomActiveEffectValue = (effect, actor, callback) => {
    const restore = [];

    const paths = [
      "value",
      "system.value",
      "_source.value",
      "_source.system.value"
    ];

    try {
      for (const path of paths) {
        const before = foundry.utils.getProperty(effect, path);

        if (!hasCustomSyntax(before)) continue;

        const result = transformValue(before, {
          actor,
          effect
        });

        if (!result.changed) continue;

        try {
          foundry.utils.setProperty(effect, path, result.value);
          restore.push({ path, value: before });

          logTransform({
            title: "transformed CustomActiveEffect value",
            actor,
            effect,
            path,
            before,
            after: result.value
          });
        } catch (err) {
          console.error(TAG, `Failed to temporarily set ${path}.`, err, {
            effect,
            actor
          });
        }
      }

      return callback();
    } finally {
      for (const entry of restore.reverse()) {
        try {
          foundry.utils.setProperty(effect, entry.path, entry.value);
        } catch (_err) {}
      }

      if (state.debug && restore.length > 0) {
        console.log(TAG, `Restored ${restore.length} temporary CustomActiveEffect value path(s).`);
      }
    }
  };

  const getCustomActiveEffectPatchTarget = () => {
    const candidates = [
      CONFIG?.ActiveEffect?.documentClass,
      globalThis.CustomActiveEffect,
      globalThis.ActiveEffect?.implementation,
      globalThis.ActiveEffect
    ].filter(Boolean);

    const unique = [...new Set(candidates)];

    for (const cls of unique) {
      const proto = cls?.prototype;
      if (proto && typeof proto.apply === "function") {
        return { cls, proto };
      }
    }

    return null;
  };

  const patchCustomActiveEffectApply = () => {
    if (state.customEffectPatched) return true;

    const target = getCustomActiveEffectPatchTarget();

    if (!target) {
      console.warn(TAG, "Could not patch CustomActiveEffect.apply(). Patch target not found.");
      return false;
    }

    const { cls, proto } = target;

    if (proto.__oniAeSyntaxCustomApplyPatched) {
      state.customEffectPatched = true;
      state.customEffectPatchTarget = cls?.name ?? "CustomActiveEffect";
      return true;
    }

    const original = proto.apply;

    proto.apply = function oniAeSyntaxCustomActiveEffectApply(...args) {
      const explicitActor = args.find((arg) => isActorDocument(arg)) ?? null;
      const actor = resolveActorFromEffect(this, explicitActor);

      if (!actor) {
        return original.apply(this, args);
      }

      const nextArgs = transformApplyArgs(args, actor, this);

      return withTransformedCustomActiveEffectValue(this, actor, () => {
        return original.apply(this, nextArgs);
      });
    };

    proto.__oniAeSyntaxCustomApplyPatched = true;
    proto.__oniAeSyntaxOriginalCustomApply = original;

    state.originalCustomEffectApply = original;
    state.customEffectPatched = true;
    state.customEffectPatchTarget = cls?.name ?? "CustomActiveEffect";

    console.log(TAG, `Patched ${state.customEffectPatchTarget}.prototype.apply().`);
    return true;
  };

  // ------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------

  const installApi = () => {
    globalThis.FUCompanion ??= {};
    globalThis.FUCompanion.api ??= {};

    globalThis.FUCompanion.api.activeEffectSyntax = {
      status() {
        const ok = !!state.actorPatched && !!state.customEffectPatched;

        return {
          ok,
          patched: !!state.actorPatched,
          patchTarget: state.actorPatchTarget,

          customEffectPatched: !!state.customEffectPatched,
          customEffectPatchTarget: state.customEffectPatchTarget,

          debug: state.debug,
          helpers: ["ae", "aeUuid", "aeStatus", "countAe"]
        };
      },

      setDebug(value = true) {
        state.debug = Boolean(value);
        console.log(TAG, "Debug mode:", state.debug);
        return state.debug;
      },

      hasEffect(actorOrName, effectName) {
        const actor = typeof actorOrName === "string"
          ? game.actors.getName(actorOrName)
          : actorOrName;

        return hasEffect(actor, effectName);
      },

      listEffects(actorOrName) {
        const actor = typeof actorOrName === "string"
          ? game.actors.getName(actorOrName)
          : actorOrName;

        return collectActorEffects(actor).map((effect) => ({
          name: effect.name,
          id: effect.id,
          uuid: effect.uuid,
          disabled: effect.disabled,
          suppressed: effect.isSuppressed,
          statuses: safeArrayFrom(effect.statuses)
        }));
      },

      transformValue(value, actorOrName) {
        const actor = typeof actorOrName === "string"
          ? game.actors.getName(actorOrName)
          : actorOrName;

        return transformValue(value, { actor });
      },

      forcePatch() {
        const actorPatch = patchActorApplyActiveEffects();
        const customPatch = patchCustomActiveEffectApply();

        return {
          actorPatch,
          customPatch,
          status: this.status()
        };
      },

      debugActor(actorOrName) {
        const actor = typeof actorOrName === "string"
          ? game.actors.getName(actorOrName)
          : actorOrName;

        if (!actor) {
          return {
            ok: false,
            reason: "Actor not found."
          };
        }

        return {
          ok: true,
          actor: actor.name,
          effects: this.listEffects(actor),
          status: this.status()
        };
      }
    };
  };

  // ------------------------------------------------------------
  // Startup
  // ------------------------------------------------------------

  Hooks.once("init", () => {
    installApi();
    patchActorApplyActiveEffects();
    patchCustomActiveEffectApply();
  });

  Hooks.once("ready", () => {
    installApi();

    if (!state.actorPatched) {
      patchActorApplyActiveEffects();
    }

    if (!state.customEffectPatched) {
      patchCustomActiveEffectApply();
    }

    console.log(TAG, "Ready.", globalThis.FUCompanion.api.activeEffectSyntax.status());
  });
})();