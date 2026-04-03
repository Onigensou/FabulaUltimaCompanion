/**
 * movementControl-api.js
 * Fabula Ultima Companion - Movement Control System API
 * Foundry VTT v12
 *
 * Purpose:
 * - Tie together resolver + store + socket
 * - Provide the main public API for the Movement Control system
 * - Own the controller handoff workflow
 * - Keep future UI/runtime scripts simple
 *
 * Notes:
 * - This script does not render UI
 * - This script does not directly install camera hooks
 * - It does register socket handlers for controller / refresh requests
 *
 * Globals:
 *   globalThis.__ONI_MOVEMENT_CONTROL_API__
 *
 * API:
 *   FUCompanion.api.MovementControl
 */

(() => {
  const GLOBAL_KEY = "__ONI_MOVEMENT_CONTROL_API__";
  if (globalThis[GLOBAL_KEY]?.installed) return;

  const MODULE_ID = "fabula-ultima-companion";
  const SYSTEM_ID = "movementControl";

  const state = {
    installed: true,
    ready: false,
    lastSnapshot: null,
    socketUnsubs: [],
    refreshInFlight: false
  };

  function getDebug() {
    const dbg = globalThis.__ONI_MOVEMENT_CONTROL_DEBUG__;
    if (dbg?.installed) return dbg;

    const noop = () => {};
    return {
      log: noop,
      info: noop,
      verbose: noop,
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      group: noop,
      groupCollapsed: noop,
      table: noop,
      divider: noop,
      startTimer: noop,
      endTimer: () => null
    };
  }

  function getResolver() {
    return globalThis.__ONI_MOVEMENT_CONTROL_RESOLVER__ ?? null;
  }

  function getStore() {
    return globalThis.__ONI_MOVEMENT_CONTROL_STORE__ ?? null;
  }

  function getSocket() {
    return globalThis.__ONI_MOVEMENT_CONTROL_SOCKET__ ?? null;
  }

  const DBG = getDebug();

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function hasText(value) {
    return cleanString(value).length > 0;
  }

  function deepClone(value) {
    try {
      return foundry.utils.deepClone(value);
    } catch {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return value;
      }
    }
  }

  function getSocketMessageTypes() {
    return getSocket()?.MESSAGE_TYPES ?? {};
  }

  function getLastSnapshot() {
    return state.lastSnapshot ?? null;
  }

  function setLastSnapshot(snapshot) {
    state.lastSnapshot = snapshot ?? null;
    return state.lastSnapshot;
  }

  async function getStoredState() {
    const store = getStore();
    if (!store?.getState) {
      DBG.warn("API", "Store not available while requesting stored state");
      return null;
    }
    return await store.getState();
  }

  async function resolveSnapshot({
    preferredControllerUserId = null,
    onlineOnly = true,
    includeGM = false
  } = {}) {
    const resolver = getResolver();
    if (!resolver?.resolveSnapshot) {
      DBG.warn("API", "Resolver not available while resolving snapshot");
      return null;
    }

    const snapshot = await resolver.resolveSnapshot({
      preferredControllerUserId,
      onlineOnly,
      includeGM
    });

    setLastSnapshot(snapshot);
    return snapshot;
  }

  async function resolveSnapshotUsingStoredPreference({
    onlineOnly = true,
    includeGM = false
  } = {}) {
    const stored = await getStoredState();
    const preferredControllerUserId =
      stored?.currentControllerUserId ||
      stored?.lastControllerUserId ||
      null;

    return await resolveSnapshot({
      preferredControllerUserId,
      onlineOnly,
      includeGM
    });
  }

  function buildControllerDescriptorFromRow(row) {
    if (!row) return null;

    return {
      userId: row.userId ?? null,
      userName: row.userName ?? null,
      isActive: !!row.isActive,
      isGM: !!row.isGM,

      linkedActorId: row.linkedActorId ?? null,
      linkedActorUuid: row.linkedActorUuid ?? null,
      linkedActorName: row.linkedActorName ?? null,

      partyMemberSlot: row.partyMemberSlot ?? null,
      partyMemberActorId: row.partyMemberActorId ?? null,
      partyMemberActorName: row.partyMemberActorName ?? null
    };
  }

  async function getEffectiveControllerInfo(snapshot = null, storedState = null) {
    const snap = snapshot ?? state.lastSnapshot ?? await resolveSnapshotUsingStoredPreference();
    const storeState = storedState ?? await getStoredState();

    if (!snap) return null;

    const currentUserId = storeState?.currentControllerUserId ?? null;
    const lastUserId = storeState?.lastControllerUserId ?? null;

    const resolver = getResolver();
    const eligible = snap.eligibleControllers ?? [];

    const current =
      (currentUserId && resolver?.findControllerByUserId
        ? resolver.findControllerByUserId(eligible, currentUserId)
        : null) ||
      null;

    const last =
      (lastUserId && resolver?.findControllerByUserId
        ? resolver.findControllerByUserId(eligible, lastUserId)
        : null) ||
      null;

    const fallback = snap.defaultController ?? snap.resolvedController ?? eligible[0] ?? null;
    const effective = current ?? last ?? fallback ?? null;

    return {
      snapshot: snap,
      storedState: storeState,
      current: current ? buildControllerDescriptorFromRow(current) : null,
      last: last ? buildControllerDescriptorFromRow(last) : null,
      fallback: fallback ? buildControllerDescriptorFromRow(fallback) : null,
      effective: effective ? buildControllerDescriptorFromRow(effective) : null,
      effectiveRow: effective ?? null
    };
  }

  async function getCurrentControllerUser() {
    const info = await getEffectiveControllerInfo();
    return info?.effective ?? null;
  }

  async function isCurrentUserMainController() {
    const controller = await getCurrentControllerUser();
    return !!controller && controller.userId === game.user?.id;
  }

  async function getEligibleControllers({ onlineOnly = true, includeGM = false } = {}) {
    const snapshot = await resolveSnapshotUsingStoredPreference({ onlineOnly, includeGM });
    return deepClone(snapshot?.eligibleControllers ?? []);
  }

  async function validateTargetControllerUserId(targetUserId, {
    snapshot = null,
    onlineOnly = true,
    includeGM = false
  } = {}) {
    const cleanUserId = cleanString(targetUserId);
    if (!cleanUserId) {
      return {
        ok: false,
        reason: "missingTargetUserId",
        row: null,
        snapshot: snapshot ?? null
      };
    }

    const snap = snapshot ?? await resolveSnapshotUsingStoredPreference({ onlineOnly, includeGM });
    const resolver = getResolver();

    if (!snap) {
      return {
        ok: false,
        reason: "noSnapshot",
        row: null,
        snapshot: null
      };
    }

    const row = resolver?.findControllerByUserId
      ? resolver.findControllerByUserId(snap.eligibleControllers ?? [], cleanUserId)
      : null;

    if (!row) {
      return {
        ok: false,
        reason: "targetUserNotEligible",
        row: null,
        snapshot: snap
      };
    }

    return {
      ok: true,
      reason: "validated",
      row,
      snapshot: snap
    };
  }

  async function canCurrentUserPassControl({ snapshot = null } = {}) {
    const socket = getSocket();
    if (game.user?.isGM) {
      return { ok: true, reason: "gmOverride", snapshot: snapshot ?? null };
    }

    const controllerInfo = await getEffectiveControllerInfo(snapshot ?? null);
    const currentController = controllerInfo?.effective ?? null;

    if (!currentController) {
      return { ok: false, reason: "noCurrentController", snapshot: controllerInfo?.snapshot ?? null };
    }

    if (currentController.userId !== game.user?.id) {
      return { ok: false, reason: "notCurrentController", snapshot: controllerInfo?.snapshot ?? null };
    }

    return {
      ok: true,
      reason: socket?.isCurrentUserPrimaryGM?.() ? "primaryGmController" : "currentController",
      snapshot: controllerInfo?.snapshot ?? null
    };
  }

  function getLinkedActorForControllerRow(row) {
    return row?.linkedActor ?? row?.user?.character ?? null;
  }

  async function applyControllerVisualToCentralPartyToken(controllerRow, snapshot = null) {
    const snap = snapshot ?? state.lastSnapshot ?? await resolveSnapshotUsingStoredPreference();
    const token = snap?.centralPartyToken ?? null;
    const linkedActor = getLinkedActorForControllerRow(controllerRow);

    if (!token?.document) {
      DBG.warn("API", "applyControllerVisualToCentralPartyToken aborted because central party token was not found", {
        controllerUserId: controllerRow?.userId ?? null,
        controllerUserName: controllerRow?.userName ?? null
      });
      return { ok: false, reason: "noCentralPartyToken", token: null };
    }

    if (!linkedActor?.prototypeToken) {
      DBG.warn("API", "applyControllerVisualToCentralPartyToken aborted because linked actor or prototype token was missing", {
        controllerUserId: controllerRow?.userId ?? null,
        controllerUserName: controllerRow?.userName ?? null,
        linkedActorId: linkedActor?.id ?? null,
        linkedActorName: linkedActor?.name ?? null
      });
      return { ok: false, reason: "noLinkedActorPrototypeToken", token };
    }

    if (!token.document.isOwner) {
      DBG.warn("API", "applyControllerVisualToCentralPartyToken blocked because current user is not token owner", {
        tokenId: token.id,
        tokenName: token.name,
        controllerUserId: controllerRow?.userId ?? null,
        controllerUserName: controllerRow?.userName ?? null
      });
      return { ok: false, reason: "notTokenOwner", token };
    }

    const src = cleanString(linkedActor.prototypeToken.texture?.src || linkedActor.img || "");
    const scaleX = linkedActor.prototypeToken.texture?.scaleX ?? 1;
    const scaleY = linkedActor.prototypeToken.texture?.scaleY ?? 1;
    const newName = cleanString(linkedActor.name || controllerRow?.userName || token.name);

    const updateData = {
      name: newName
    };

    if (hasText(src)) {
      updateData["texture.src"] = src;
    }

    updateData["texture.scaleX"] = scaleX;
    updateData["texture.scaleY"] = scaleY;

    try {
      await token.document.update(updateData);

      DBG.groupCollapsed("API", "Applied controller visual to central party token", {
        tokenId: token.id,
        previousTokenName: token.name,
        nextTokenName: newName,
        textureSrc: src || null,
        scaleX,
        scaleY,
        linkedActorId: linkedActor.id,
        linkedActorName: linkedActor.name,
        controllerUserId: controllerRow?.userId ?? null,
        controllerUserName: controllerRow?.userName ?? null
      });

      return {
        ok: true,
        reason: "updated",
        token,
        updateData
      };
    } catch (err) {
      DBG.error("API", "Failed to update central party token visual", {
        tokenId: token.id,
        tokenName: token.name,
        linkedActorId: linkedActor.id,
        linkedActorName: linkedActor.name,
        controllerUserId: controllerRow?.userId ?? null,
        controllerUserName: controllerRow?.userName ?? null,
        error: err?.message ?? err
      });

      return {
        ok: false,
        reason: "tokenUpdateFailed",
        token,
        error: err
      };
    }
  }

  async function commitControllerChange(targetRow, {
    source = "unknown",
    snapshot = null,
    requestContext = null
  } = {}) {
    const store = getStore();
    const socket = getSocket();

    if (!store?.setController) {
      DBG.warn("API", "commitControllerChange aborted because store.setController is unavailable");
      return { ok: false, reason: "storeUnavailable" };
    }

    const snap = snapshot ?? await resolveSnapshotUsingStoredPreference();
    if (!snap) {
      return { ok: false, reason: "noSnapshot" };
    }

    const tokenVisualResult = await applyControllerVisualToCentralPartyToken(targetRow, snap);

    const storeResult = await store.setController(targetRow, {
      reason: `controllerChange:${source}`
    });

    if (!storeResult?.ok) {
      return {
        ok: false,
        reason: "storeWriteFailed",
        storeResult,
        tokenVisualResult
      };
    }

    await store.touchSnapshot(snap, {
      reason: `snapshotTouch:${source}`
    });

    setLastSnapshot(snap);

    if (socket?.broadcastStateUpdated) {
      await socket.broadcastStateUpdated({
        source,
        requestContext: requestContext ?? null,
        currentControllerUserId: targetRow?.userId ?? null,
        currentControllerUserName: targetRow?.userName ?? null,
        controllerActorId: targetRow?.linkedActorId ?? targetRow?.partyMemberActorId ?? null,
        controllerActorName: targetRow?.linkedActorName ?? targetRow?.partyMemberActorName ?? null
      });
    }

    if (socket?.broadcastRefresh) {
      await socket.broadcastRefresh({
        source,
        requestContext: requestContext ?? null
      });
    }

    DBG.groupCollapsed("API", "Controller change committed", {
      source,
      requestContext,
      currentControllerUserId: targetRow?.userId ?? null,
      currentControllerUserName: targetRow?.userName ?? null,
      tokenVisualResult,
      storeState: storeResult.state ?? null
    });

    return {
      ok: true,
      reason: "controllerChanged",
      controller: buildControllerDescriptorFromRow(targetRow),
      tokenVisualResult,
      storeResult
    };
  }

  async function refresh({
    source = "manual",
    broadcast = false,
    onlineOnly = true,
    includeGM = false
  } = {}) {
    if (state.refreshInFlight) {
      DBG.verbose("API", "refresh skipped because one is already in flight", { source });
      return getLastSnapshot();
    }

    const socket = getSocket();
    const store = getStore();

    state.refreshInFlight = true;
    DBG.startTimer("movement-control-refresh", "API", "Refreshing Movement Control state");

    try {
      const stored = await getStoredState();
      const preferredControllerUserId =
        stored?.currentControllerUserId ||
        stored?.lastControllerUserId ||
        null;

      const snapshot = await resolveSnapshot({
        preferredControllerUserId,
        onlineOnly,
        includeGM
      });

      if (!snapshot) {
        DBG.warn("API", "refresh failed because snapshot resolution returned null", { source });
        return null;
      }

            const controllerInfo = await getEffectiveControllerInfo(snapshot, stored);
      const effectiveRow = controllerInfo?.effectiveRow ?? null;

      const currentGameActor = store?.resolveCurrentGameActor
        ? await store.resolveCurrentGameActor()
        : null;

      const canWriteState = !!(
        store?.canWriteToCurrentGameActor &&
        currentGameActor &&
        store.canWriteToCurrentGameActor(currentGameActor)
      );

      if (canWriteState) {
        if (store?.touchSnapshot) {
          await store.touchSnapshot(snapshot, {
            reason: `refresh:${source}`
          });
        }

        if (effectiveRow && store?.setController) {
          await store.setController(effectiveRow, {
            reason: `refreshResolvedController:${source}`
          });
        }
      } else {
        DBG.verbose("API", "Skipping refresh store writes because current user is not owner of Current Game actor", {
          source,
          currentUserId: game.user?.id ?? null,
          currentUserName: game.user?.name ?? null,
          currentGameActorId: currentGameActor?.id ?? null,
          currentGameActorName: currentGameActor?.name ?? null
        });
      }

      setLastSnapshot(snapshot);

      if (broadcast && socket?.broadcastRefresh) {
        await socket.broadcastRefresh({
          source,
          currentControllerUserId: effectiveRow?.userId ?? null,
          currentControllerUserName: effectiveRow?.userName ?? null
        });
      }

      DBG.groupCollapsed("API", "Movement Control refresh complete", {
        source,
        currentControllerUserId: effectiveRow?.userId ?? null,
        currentControllerUserName: effectiveRow?.userName ?? null,
        partyActorId: snapshot.centralPartyActorId ?? null,
        partyActorName: snapshot.centralPartyActorName ?? null,
        centralPartyTokenId: snapshot.centralPartyTokenData?.tokenId ?? null,
        centralPartyTokenName: snapshot.centralPartyTokenData?.tokenName ?? null
      });

      return snapshot;
    } finally {
      state.refreshInFlight = false;
      DBG.endTimer("movement-control-refresh", "API", "Movement Control refresh completed");
    }
  }

  async function requestPassController(targetUserId, extra = {}) {
    const socket = getSocket();
    if (!socket?.requestPassController) {
      DBG.warn("API", "requestPassController failed because socket request helper is unavailable", {
        targetUserId,
        extra
      });
      return { ok: false, reason: "socketUnavailable" };
    }

    const access = await canCurrentUserPassControl();
    if (!access.ok) {
      DBG.warn("API", "requestPassController denied before request was sent", {
        targetUserId,
        reason: access.reason
      });
      return { ok: false, reason: access.reason };
    }

    const sent = await socket.requestPassController(targetUserId, {
      requestedByUserId: game.user?.id ?? null,
      requestedByUserName: game.user?.name ?? null,
      ...extra
    });

    return {
      ok: !!sent,
      reason: sent ? "requestSent" : "requestFailed"
    };
  }

  async function forceSetController(targetUserId, {
    source = "gmForce",
    requestContext = null
  } = {}) {
    if (!game.user?.isGM) {
      DBG.warn("API", "forceSetController blocked because current user is not GM", {
        targetUserId,
        source
      });
      return { ok: false, reason: "notGM" };
    }

    const validation = await validateTargetControllerUserId(targetUserId);
    if (!validation.ok) {
      DBG.warn("API", "forceSetController validation failed", {
        targetUserId,
        source,
        reason: validation.reason
      });
      return { ok: false, reason: validation.reason };
    }

    return await commitControllerChange(validation.row, {
      source,
      snapshot: validation.snapshot,
      requestContext
    });
  }

  async function handleRequestPassController(envelope) {
    const socket = getSocket();
    const types = getSocketMessageTypes();

    if (!socket?.isCurrentUserPrimaryGM?.()) {
      DBG.verbose("API", "Ignoring REQUEST_PASS_CONTROLLER because current user is not primary GM", {
        requestId: envelope?.requestId ?? null,
        senderUserId: envelope?.senderUserId ?? null,
        senderUserName: envelope?.senderUserName ?? null
      });
      return;
    }

    const senderUserId = cleanString(envelope?.senderUserId);
    const targetUserId = cleanString(envelope?.payload?.targetUserId);

    const controllerInfo = await getEffectiveControllerInfo();
    const effectiveControllerUserId = controllerInfo?.effective?.userId ?? null;

    const senderIsGM = !!game.users?.get(senderUserId)?.isGM;
    const senderIsController = !!effectiveControllerUserId && senderUserId === effectiveControllerUserId;

    if (!senderIsGM && !senderIsController) {
      DBG.warn("API", "REQUEST_PASS_CONTROLLER denied because sender is not current controller or GM", {
        requestId: envelope?.requestId ?? null,
        senderUserId,
        senderUserName: envelope?.senderUserName ?? null,
        effectiveControllerUserId
      });

      if (socket?.replyTo) {
        await socket.replyTo(envelope, types.ERROR, {
          reason: "senderNotAuthorized"
        });
      }
      return;
    }

    const validation = await validateTargetControllerUserId(targetUserId);
    if (!validation.ok) {
      DBG.warn("API", "REQUEST_PASS_CONTROLLER denied because target validation failed", {
        requestId: envelope?.requestId ?? null,
        senderUserId,
        senderUserName: envelope?.senderUserName ?? null,
        targetUserId,
        reason: validation.reason
      });

      if (socket?.replyTo) {
        await socket.replyTo(envelope, types.ERROR, {
          reason: validation.reason,
          targetUserId
        });
      }
      return;
    }

    const result = await commitControllerChange(validation.row, {
      source: "socketRequestPassController",
      snapshot: validation.snapshot,
      requestContext: {
        requestId: envelope?.requestId ?? null,
        senderUserId,
        senderUserName: envelope?.senderUserName ?? null,
        targetUserId
      }
    });

    if (socket?.replyTo) {
      await socket.replyTo(envelope, result.ok ? types.ACK : types.ERROR, {
        reason: result.reason,
        targetUserId,
        currentControllerUserId: result.controller?.userId ?? validation.row?.userId ?? null,
        currentControllerUserName: result.controller?.userName ?? validation.row?.userName ?? null
      });
    }
  }

  async function handleRequestRefresh(envelope) {
    const socket = getSocket();
    const types = getSocketMessageTypes();

    if (!socket?.isCurrentUserPrimaryGM?.()) return;

    const snapshot = await refresh({
      source: "socketRequestRefresh",
      broadcast: true
    });

    if (socket?.replyTo) {
      await socket.replyTo(envelope, types.ACK, {
        reason: snapshot ? "refreshed" : "refreshFailed",
        currentControllerUserId: (await getCurrentControllerUser())?.userId ?? null,
        currentControllerUserName: (await getCurrentControllerUser())?.userName ?? null
      });
    }
  }

  async function handleRequestSyncState(envelope) {
    const socket = getSocket();
    const types = getSocketMessageTypes();

    if (!socket?.isCurrentUserPrimaryGM?.()) return;

    const controller = await getCurrentControllerUser();
    const stored = await getStoredState();

    if (socket?.replyTo) {
      await socket.replyTo(envelope, types.ACK, {
        reason: "syncProvided",
        currentControllerUserId: controller?.userId ?? null,
        currentControllerUserName: controller?.userName ?? null,
        storeState: stored ?? null
      });
    }
  }

  async function handleBroadcastRefresh(envelope) {
    DBG.verbose("API", "Handling BROADCAST_REFRESH", {
      requestId: envelope?.requestId ?? null,
      senderUserId: envelope?.senderUserId ?? null,
      senderUserName: envelope?.senderUserName ?? null,
      source: envelope?.payload?.source ?? null
    });

    await refresh({
      source: "broadcastRefresh",
      broadcast: false
    });
  }

  async function handleBroadcastStateUpdated(envelope) {
    DBG.verbose("API", "Handling BROADCAST_STATE_UPDATED", {
      requestId: envelope?.requestId ?? null,
      senderUserId: envelope?.senderUserId ?? null,
      senderUserName: envelope?.senderUserName ?? null,
      payload: envelope?.payload ?? {}
    });

    await refresh({
      source: "broadcastStateUpdated",
      broadcast: false
    });
  }

  async function handleAck(envelope) {
    DBG.verbose("API", "Received Movement Control ACK", {
      replyToRequestId: envelope?.replyToRequestId ?? null,
      payload: envelope?.payload ?? {}
    });
  }

  async function handleError(envelope) {
    DBG.warn("API", "Received Movement Control ERROR", {
      replyToRequestId: envelope?.replyToRequestId ?? null,
      payload: envelope?.payload ?? {}
    });
  }

  function unregisterSocketHandlers() {
    for (const unsub of state.socketUnsubs) {
      try {
        unsub?.();
      } catch (err) {
        DBG.warn("API", "Error while unregistering socket handler", {
          error: err?.message ?? err
        });
      }
    }
    state.socketUnsubs = [];
  }

  function registerSocketHandlers() {
    const socket = getSocket();
    const types = getSocketMessageTypes();

    if (!socket?.on) {
      DBG.warn("API", "registerSocketHandlers skipped because socket.on is unavailable");
      return;
    }

    unregisterSocketHandlers();

    state.socketUnsubs.push(
      socket.on(types.REQUEST_PASS_CONTROLLER, handleRequestPassController),
      socket.on(types.REQUEST_REFRESH, handleRequestRefresh),
      socket.on(types.REQUEST_SYNC_STATE, handleRequestSyncState),
      socket.on(types.BROADCAST_REFRESH, handleBroadcastRefresh),
      socket.on(types.BROADCAST_STATE_UPDATED, handleBroadcastStateUpdated),
      socket.on(types.ACK, handleAck),
      socket.on(types.ERROR, handleError)
    );

    DBG.verbose("API", "Registered Movement Control socket handlers", {
      handlerCount: state.socketUnsubs.length
    });
  }

  function getSnapshotSummary(snapshot = null) {
    const snap = snapshot ?? state.lastSnapshot;
    if (!snap) return null;

    return {
      currentGameActorId: snap.currentGameActorId ?? null,
      currentGameActorName: snap.currentGameActorName ?? null,
      centralPartyActorId: snap.centralPartyActorId ?? null,
      centralPartyActorName: snap.centralPartyActorName ?? null,
      centralPartyTokenId: snap.centralPartyTokenData?.tokenId ?? null,
      centralPartyTokenName: snap.centralPartyTokenData?.tokenName ?? null,
      eligibleControllerCount: (snap.eligibleControllers ?? []).length,
      resolvedAt: snap.resolvedAt ?? null
    };
  }

  const api = {
    installed: true,
    MODULE_ID,
    SYSTEM_ID,

    getLastSnapshot,
    getSnapshotSummary,
    getStoredState,

    resolveSnapshot,
    resolveSnapshotUsingStoredPreference,
    refresh,

    getEligibleControllers,
    getCurrentControllerUser,
    isCurrentUserMainController,
    canCurrentUserPassControl,

    validateTargetControllerUserId,
    requestPassController,
    forceSetController,

    applyControllerVisualToCentralPartyToken,
    commitControllerChange,

    registerSocketHandlers,
    unregisterSocketHandlers
  };

  globalThis[GLOBAL_KEY] = api;

  Hooks.once("ready", async () => {
    try {
      registerSocketHandlers();
      state.ready = true;
    } catch (err) {
      DBG.error("API", "Failed to register Movement Control socket handlers", {
        error: err?.message ?? err
      });
    }

    try {
      globalThis.FUCompanion ??= {};
      globalThis.FUCompanion.api ??= {};
      globalThis.FUCompanion.api.MovementControl = api;
    } catch (err) {
      console.warn("[MovementControl:API] Failed to attach API to FUCompanion.api", err);
    }

    try {
      await refresh({
        source: "readyBootstrap",
        broadcast: false
      });
    } catch (err) {
      DBG.warn("API", "Initial Movement Control refresh failed during ready", {
        error: err?.message ?? err
      });
    }

    DBG.verbose("API", "movementControl-api.js ready", {
      ready: state.ready,
      snapshotSummary: getSnapshotSummary()
    });
  });

  Hooks.once("shutdown", () => {
    try {
      unregisterSocketHandlers();
    } catch (err) {
      DBG.warn("API", "Error while unregistering Movement Control socket handlers on shutdown", {
        error: err?.message ?? err
      });
    }
  });
})();
