// scripts/damage-card-cache.js
// ============================================================================
// FU Damage Card Cache
// Foundry VTT V12
//
// Purpose:
// - Pre-cache Actor/Token images, names, UUIDs, and document references.
// - Used by create-damage-card.js and Create Damage Card.js to avoid repeated
//   fromUuid() lookups during combat.
// ============================================================================

(function initFUDamageCardCache() {
  const MODULE_NS = "fabula-ultima-companion";
  const TAG = "[FU][DamageCardCache]";
  const DEBUG = false;

  const API_ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  API_ROOT.api = API_ROOT.api || {};

  const FALLBACK_IMG = "icons/svg/mystery-man.svg";

  const byUuid = new Map();      // uuid -> info
  const byName = new Map();      // lower name -> info
  const docsByUuid = new Map();  // uuid -> document reference

  const log = (...a) => DEBUG && console.log(TAG, ...a);
  const warn = (...a) => DEBUG && console.warn(TAG, ...a);

  function clean(v) {
    return String(v ?? "").trim();
  }

  function lower(v) {
    return clean(v).toLowerCase();
  }

  function isTokenDoc(doc) {
    return !!doc && (
      doc.documentName === "Token" ||
      doc.documentName === "TokenDocument"
    );
  }

  function isActorDoc(doc) {
    return !!doc && doc.documentName === "Actor";
  }

  function getActorImg(actor, tokenDoc = null) {
    return (
      actor?.img ||
      actor?.prototypeToken?.texture?.src ||
      tokenDoc?.texture?.src ||
      tokenDoc?.document?.texture?.src ||
      tokenDoc?.img ||
      FALLBACK_IMG
    );
  }

  function rememberInfo(info) {
    if (!info) return null;

    const tokenUuid = clean(info.tokenUuid);
    const actorUuid = clean(info.actorUuid);
    const tokenName = clean(info.tokenName);
    const actorName = clean(info.actorName);

    const finalInfo = {
      tokenUuid: tokenUuid || null,
      actorUuid: actorUuid || null,
      tokenName: tokenName || null,
      actorName: actorName || null,
      img: clean(info.img) || FALLBACK_IMG,
      disposition: Number(info.disposition ?? 0) || 0,
      lastTouched: Date.now()
    };

    if (tokenUuid) byUuid.set(tokenUuid, finalInfo);
    if (actorUuid) byUuid.set(actorUuid, finalInfo);

    if (actorName) byName.set(lower(actorName), finalInfo);
    if (tokenName) byName.set(lower(tokenName), finalInfo);

    return finalInfo;
  }

  function rememberDoc(doc) {
    if (!doc) return null;

    try {
      if (doc.uuid) docsByUuid.set(doc.uuid, doc);

      if (isTokenDoc(doc)) {
        const actor = doc.actor ?? null;
        if (actor?.uuid) docsByUuid.set(actor.uuid, actor);

        return rememberInfo({
          tokenUuid: doc.uuid,
          actorUuid: actor?.uuid ?? null,
          tokenName: doc.name ?? null,
          actorName: actor?.name ?? null,
          img: getActorImg(actor, doc),
          disposition: Number(doc.disposition ?? 0) || 0
        });
      }

      if (isActorDoc(doc)) {
        docsByUuid.set(doc.uuid, doc);

        let activeTokenDoc = null;
        try {
          const active = doc.getActiveTokens?.(true, true) ?? doc.getActiveTokens?.() ?? [];
          activeTokenDoc = active?.[0]?.document ?? active?.[0] ?? null;
        } catch (_) {}

        return rememberInfo({
          tokenUuid: activeTokenDoc?.uuid ?? null,
          actorUuid: doc.uuid,
          tokenName: activeTokenDoc?.name ?? null,
          actorName: doc.name ?? null,
          img: getActorImg(doc, activeTokenDoc),
          disposition: Number(activeTokenDoc?.disposition ?? 0) || 0
        });
      }
    } catch (err) {
      warn("rememberDoc failed", err, doc);
    }

    return null;
  }

  function rememberTokenObject(tokenObject) {
    try {
      const doc = tokenObject?.document ?? tokenObject;
      if (!doc) return null;
      return rememberDoc(doc);
    } catch (err) {
      warn("rememberTokenObject failed", err, tokenObject);
      return null;
    }
  }

  function warmActors() {
    let count = 0;
    try {
      for (const actor of game.actors?.contents ?? []) {
        rememberDoc(actor);
        count++;
      }
    } catch (err) {
      warn("warmActors failed", err);
    }
    return count;
  }

  function warmSceneTokens() {
    let count = 0;
    try {
      for (const token of canvas?.tokens?.placeables ?? []) {
        rememberTokenObject(token);
        count++;
      }
    } catch (err) {
      warn("warmSceneTokens failed", err);
    }
    return count;
  }

  function warmAll(reason = "manual") {
    const actors = warmActors();
    const tokens = warmSceneTokens();

    log("warmAll", {
      reason,
      actors,
      tokens,
      byUuid: byUuid.size,
      byName: byName.size,
      docsByUuid: docsByUuid.size
    });

    return {
      ok: true,
      reason,
      actors,
      tokens,
      byUuid: byUuid.size,
      byName: byName.size,
      docsByUuid: docsByUuid.size
    };
  }

  function getInfo(ref) {
    const key = clean(ref);
    if (!key) return null;

    return (
      byUuid.get(key) ||
      byName.get(lower(key)) ||
      null
    );
  }

  function getImage(ref) {
    return getInfo(ref)?.img ?? null;
  }

  function getDoc(ref) {
    const key = clean(ref);
    if (!key) return null;
    return docsByUuid.get(key) ?? null;
  }

  async function resolveDoc(ref) {
    const key = clean(ref);
    if (!key) return null;

    const cached = getDoc(key);
    if (cached) return cached;

    try {
      const doc = await fromUuid(key);
      if (doc) rememberDoc(doc);
      return doc ?? null;
    } catch {
      return null;
    }
  }

  function forget(ref) {
    const key = clean(ref);
    if (!key) return;

    byUuid.delete(key);
    byName.delete(lower(key));
    docsByUuid.delete(key);
  }

  function stats() {
    return {
      byUuid: byUuid.size,
      byName: byName.size,
      docsByUuid: docsByUuid.size
    };
  }

  const api = {
    warmAll,
    warmActors,
    warmSceneTokens,
    rememberDoc,
    rememberTokenObject,
    rememberInfo,
    getInfo,
    getImage,
    getDoc,
    resolveDoc,
    forget,
    stats
  };

  API_ROOT.api.damageCardCache = api;
  API_ROOT.damageCardCache = api;

  Hooks.once("ready", () => {
    const mod = game.modules.get(MODULE_NS);
    if (mod) {
      mod.api = mod.api || {};
      mod.api.damageCardCache = api;
    }

    // Warm once shortly after ready.
    setTimeout(() => warmAll("ready"), 500);
  });

  Hooks.on("canvasReady", () => {
    warmAll("canvasReady");
  });

  Hooks.on("createToken", (doc) => {
    rememberDoc(doc);
  });

  Hooks.on("updateToken", (doc) => {
    rememberDoc(doc);
  });

  Hooks.on("deleteToken", (doc) => {
    try {
      if (doc?.uuid) forget(doc.uuid);
      if (doc?.actor?.uuid) forget(doc.actor.uuid);
    } catch (_) {}
  });

  Hooks.on("updateActor", (actor) => {
    rememberDoc(actor);
  });

  Hooks.on("createActor", (actor) => {
    rememberDoc(actor);
  });

  Hooks.on("deleteActor", (actor) => {
    try {
      if (actor?.uuid) forget(actor.uuid);
    } catch (_) {}
  });

  log("registered");
})();