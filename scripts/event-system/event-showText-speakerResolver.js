/**
 * [ONI] Event System — Show Text — Speaker Resolver
 * Foundry VTT v12
 *
 * File:
 * scripts/event-system/event-showText-speakerResolver.js
 *
 * What this does:
 * - Resolves the "Speaker" field for the Show Text event
 * - Supports:
 *   1) empty input          -> Self
 *   2) "Self"               -> current party speaker
 *   3) Actor UUID           -> actor name
 *   4) Token UUID           -> token name
 *   5) plain text name      -> use as-is, with optional scene lookup
 *
 * Exposes API to:
 *   window.oni.EventSystem.ShowText.SpeakerResolver
 *
 * Requires:
 * - event-constants.js
 * - event-debug.js
 */

(() => {
  const INSTALL_TAG = "[ONI][EventSystem][ShowText][SpeakerResolver]";

  // ------------------------------------------------------------
  // Global namespace + guard
  // ------------------------------------------------------------
  window.oni = window.oni || {};
  window.oni.EventSystem = window.oni.EventSystem || {};
  window.oni.EventSystem.ShowText = window.oni.EventSystem.ShowText || {};

  if (window.oni.EventSystem.ShowText.SpeakerResolver?.installed) {
    console.log(INSTALL_TAG, "Already installed; skipping.");
    return;
  }

  const C = window.oni.EventSystem.Constants;
  const D = window.oni.EventSystem.Debug;

  if (!C) {
    console.error(INSTALL_TAG, "Missing Constants. Load event-constants.js first.");
    return;
  }

  const DEBUG_SCOPE = "ShowTextSpeakerResolver";

  const FALLBACK_DEBUG = {
    log: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    verboseLog: (...args) => console.log(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    warn: (...args) => console.warn(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args),
    error: (...args) => console.error(`[ONI][EventSystem][${DEBUG_SCOPE}]`, ...args)
  };

  const DBG = D || FALLBACK_DEBUG;

  // ------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------
  function stringOrEmpty(value) {
    return String(value ?? "").trim();
  }

  function isUuidLike(value) {
    const s = stringOrEmpty(value);
    return s.includes(".");
  }

  function normalizeSpeakerInput(raw) {
    const s = stringOrEmpty(raw);
    if (!s) return C.SPECIAL_SPEAKER_SELF;
    return s;
  }

  function isSelfSyntax(raw) {
    const s = normalizeSpeakerInput(raw).toLowerCase();
    return s === String(C.SPECIAL_SPEAKER_SELF).toLowerCase();
  }

  function getSceneFromContext(context = {}) {
    const sceneId = stringOrEmpty(context.sceneId);
    if (sceneId && game?.scenes?.has(sceneId)) return game.scenes.get(sceneId);
    return canvas?.scene ?? null;
  }

  function getSceneTokens(scene) {
    if (!scene) return [];
    if (scene.id === canvas?.scene?.id) return canvas?.tokens?.placeables ?? [];
    return scene.tokens?.contents ?? [];
  }

  function getTokenDocumentUuid(tokenLike) {
    if (!tokenLike) return null;
    return tokenLike.document?.uuid || tokenLike.uuid || null;
  }

  function getTokenActor(tokenLike) {
    return tokenLike?.actor || tokenLike?.document?.actor || null;
  }

  function getTokenName(tokenLike) {
    return stringOrEmpty(
      tokenLike?.name ||
      tokenLike?.document?.name ||
      tokenLike?.actor?.name ||
      tokenLike?.document?.actor?.name
    );
  }

  // ------------------------------------------------------------
  // Party / Self resolution
  // Mirrors the spirit of your other tile systems:
  // controlled token first, then FUCompanion DB actor fallback
  // ------------------------------------------------------------
  async function resolveCurrentDbContext() {
    try {
      const api = window.FUCompanion?.api;
      if (!api?.getCurrentGameDb) {
        DBG.verboseLog(DEBUG_SCOPE, "FUCompanion DB resolver not available.");
        return { db: null, source: null };
      }

      const cache = await api.getCurrentGameDb();
      return {
        db: cache?.db ?? null,
        source: cache?.source ?? null
      };
    } catch (e) {
      DBG.warn(DEBUG_SCOPE, "Failed resolving current DB context:", e);
      return { db: null, source: null };
    }
  }

  async function resolvePartyToken(context = {}) {
    try {
      const scene = getSceneFromContext(context);
      const sceneTokens = getSceneTokens(scene);

      // 1) explicit token from context
      const explicitTokenId = stringOrEmpty(context.partyTokenId || context.tokenId);
      if (explicitTokenId) {
        const explicit =
          sceneTokens.find(t => String(t.id) === explicitTokenId) ||
          canvas?.tokens?.get?.(explicitTokenId) ||
          null;

        if (explicit) {
          DBG.verboseLog(DEBUG_SCOPE, "Resolved party token from explicit tokenId.", {
            tokenId: explicit.id,
            tokenName: getTokenName(explicit)
          });
          return explicit;
        }
      }

      // 2) explicit token object from context
      if (context.partyToken) {
        DBG.verboseLog(DEBUG_SCOPE, "Resolved party token from context.partyToken.", {
          tokenId: context.partyToken.id,
          tokenName: getTokenName(context.partyToken)
        });
        return context.partyToken;
      }

      // 3) controlled token on current canvas
      const controlled = canvas?.tokens?.controlled?.[0] ?? null;
      if (controlled) {
        DBG.verboseLog(DEBUG_SCOPE, "Resolved party token from controlled token.", {
          tokenId: controlled.id,
          tokenName: getTokenName(controlled)
        });
        return controlled;
      }

      // 4) FUCompanion DB lookup fallback
      const { db, source } = await resolveCurrentDbContext();
      if (!db) {
        DBG.verboseLog(DEBUG_SCOPE, "No DB actor found for Self speaker resolution.");
        return null;
      }

      const dbToken =
        sceneTokens.find(t => t?.actor?.id === db.id) ||
        (source ? sceneTokens.find(t => t?.actor?.id === source.id) : null) ||
        sceneTokens.find(t => getTokenName(t) === db.name) ||
        sceneTokens.find(t => stringOrEmpty(t?.actor?.name) === db.name) ||
        null;

      if (dbToken) {
        DBG.verboseLog(DEBUG_SCOPE, "Resolved party token from FUCompanion DB fallback.", {
          tokenId: dbToken.id,
          tokenName: getTokenName(dbToken)
        });
      }

      return dbToken;
    } catch (e) {
      DBG.warn(DEBUG_SCOPE, "resolvePartyToken failed:", e);
      return null;
    }
  }

  async function resolveSelfSpeaker(context = {}) {
    const token = await resolvePartyToken(context);
    const actor = getTokenActor(token);

    const tokenName = getTokenName(token);
    const actorName = stringOrEmpty(actor?.name);
    const displayName = tokenName || actorName || C.SPECIAL_SPEAKER_SELF;

    const result = {
      ok: true,
      mode: "self",
      input: C.SPECIAL_SPEAKER_SELF,
      matchedBy: token ? "partyToken" : "fallback",
      speakerName: displayName,
      token,
      actor,
      tokenUuid: getTokenDocumentUuid(token),
      actorUuid: actor?.uuid ?? null,
      document: token?.document ?? actor ?? null
    };

    DBG.verboseLog(DEBUG_SCOPE, "Resolved Self speaker:", result);
    return result;
  }

  // ------------------------------------------------------------
  // UUID resolution
  // Supports Actor, TokenDocument, Token, and fallback to name if possible
  // ------------------------------------------------------------
  async function resolveUuidSpeaker(raw, context = {}) {
    const input = normalizeSpeakerInput(raw);

    try {
      const doc = await fromUuid(input);
      if (!doc) {
        DBG.warn(DEBUG_SCOPE, "fromUuid returned null for speaker input:", input);
        return null;
      }

      // Actor
      if (doc.documentName === "Actor") {
        const scene = getSceneFromContext(context);
        const sceneTokens = getSceneTokens(scene);

        const sceneToken =
          sceneTokens.find(t => t?.actor?.id === doc.id) ||
          null;

        const result = {
          ok: true,
          mode: "uuid",
          input,
          matchedBy: "actorUuid",
          speakerName: stringOrEmpty(doc.name) || "Unknown Speaker",
          token: sceneToken,
          actor: doc,
          tokenUuid: getTokenDocumentUuid(sceneToken),
          actorUuid: doc.uuid,
          document: doc
        };

        DBG.verboseLog(DEBUG_SCOPE, "Resolved speaker from Actor UUID:", result);
        return result;
      }

      // TokenDocument
      if (doc.documentName === "Token") {
        const liveToken =
          canvas?.tokens?.get?.(doc.id) ||
          null;

        const result = {
          ok: true,
          mode: "uuid",
          input,
          matchedBy: "tokenUuid",
          speakerName: stringOrEmpty(doc.name) || stringOrEmpty(doc.actor?.name) || "Unknown Speaker",
          token: liveToken || doc.object || doc,
          actor: doc.actor ?? null,
          tokenUuid: doc.uuid,
          actorUuid: doc.actor?.uuid ?? null,
          document: doc
        };

        DBG.verboseLog(DEBUG_SCOPE, "Resolved speaker from Token UUID:", result);
        return result;
      }

      // If someone drops in some other UUID by mistake, try to salvage a display name
      const fallbackName = stringOrEmpty(doc.name);
      if (fallbackName) {
        const result = {
          ok: true,
          mode: "uuid",
          input,
          matchedBy: "otherDocumentUuid",
          speakerName: fallbackName,
          token: null,
          actor: null,
          tokenUuid: null,
          actorUuid: null,
          document: doc
        };

        DBG.warn(DEBUG_SCOPE, "Speaker UUID was not Actor/Token, using document name as fallback:", {
          input,
          documentName: doc.documentName,
          speakerName: fallbackName
        });

        return result;
      }

      return null;
    } catch (e) {
      DBG.warn(DEBUG_SCOPE, "Failed to resolve UUID speaker:", { input, error: e });
      return null;
    }
  }

  // ------------------------------------------------------------
  // Name resolution
  // First try scene tokens by token name / actor name
  // Then world actors
  // Finally use plain text as-is
  // ------------------------------------------------------------
  async function resolveNameSpeaker(raw, context = {}) {
    const input = normalizeSpeakerInput(raw);
    const scene = getSceneFromContext(context);
    const sceneTokens = getSceneTokens(scene);
    const lowered = input.toLowerCase();

    // Scene token exact token-name match
    let token =
      sceneTokens.find(t => stringOrEmpty(t?.name).toLowerCase() === lowered) ||
      null;

    if (token) {
      const result = {
        ok: true,
        mode: "name",
        input,
        matchedBy: "sceneTokenName",
        speakerName: getTokenName(token) || input,
        token,
        actor: getTokenActor(token),
        tokenUuid: getTokenDocumentUuid(token),
        actorUuid: getTokenActor(token)?.uuid ?? null,
        document: token?.document ?? token
      };

      DBG.verboseLog(DEBUG_SCOPE, "Resolved speaker from scene token name:", result);
      return result;
    }

    // Scene token actor-name match
    token =
      sceneTokens.find(t => stringOrEmpty(t?.actor?.name).toLowerCase() === lowered) ||
      null;

    if (token) {
      const result = {
        ok: true,
        mode: "name",
        input,
        matchedBy: "sceneActorName",
        speakerName: stringOrEmpty(token.actor?.name) || getTokenName(token) || input,
        token,
        actor: getTokenActor(token),
        tokenUuid: getTokenDocumentUuid(token),
        actorUuid: getTokenActor(token)?.uuid ?? null,
        document: token?.document ?? token
      };

      DBG.verboseLog(DEBUG_SCOPE, "Resolved speaker from scene actor name:", result);
      return result;
    }

    // World actor exact match
    const actor =
      game?.actors?.find?.(a => stringOrEmpty(a?.name).toLowerCase() === lowered) ||
      null;

    if (actor) {
      const result = {
        ok: true,
        mode: "name",
        input,
        matchedBy: "worldActorName",
        speakerName: stringOrEmpty(actor.name) || input,
        token: null,
        actor,
        tokenUuid: null,
        actorUuid: actor.uuid,
        document: actor
      };

      DBG.verboseLog(DEBUG_SCOPE, "Resolved speaker from world actor name:", result);
      return result;
    }

    // Plain text fallback
    const result = {
      ok: true,
      mode: "text",
      input,
      matchedBy: "plainTextFallback",
      speakerName: input,
      token: null,
      actor: null,
      tokenUuid: null,
      actorUuid: null,
      document: null
    };

    DBG.verboseLog(DEBUG_SCOPE, "Resolved speaker as plain text fallback:", result);
    return result;
  }

  // ------------------------------------------------------------
  // Main API
  // ------------------------------------------------------------
  const SpeakerResolver = {
    installed: true,

    normalizeSpeakerInput,
    isSelfSyntax,

    async resolve(rawSpeaker, context = {}) {
      const normalized = normalizeSpeakerInput(rawSpeaker);

      DBG.log(DEBUG_SCOPE, "Resolving speaker...", {
        rawSpeaker,
        normalized,
        context
      });

      // Self / empty
      if (isSelfSyntax(normalized)) {
        return resolveSelfSpeaker(context);
      }

      // UUID path
      if (isUuidLike(normalized)) {
        const fromUuidResult = await resolveUuidSpeaker(normalized, context);
        if (fromUuidResult) return fromUuidResult;

        DBG.warn(DEBUG_SCOPE, "UUID speaker did not resolve cleanly, falling back to plain text/name resolution.", {
          input: normalized
        });
      }

      // Name / plain text path
      return resolveNameSpeaker(normalized, context);
    }
  };

  // ------------------------------------------------------------
  // Publish API
  // ------------------------------------------------------------
  window.oni.EventSystem.ShowText.SpeakerResolver = SpeakerResolver;

  console.log(INSTALL_TAG, "Installed.");
})();
