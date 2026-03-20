/* ========================================================================== *
 * ActionReader Announce Result
 * -------------------------------------------------------------------------- *
 * Module-compatible result announcer for the ActionReader pipeline.
 *
 * Suggested file path:
 *   scripts/action-reader/actionReader-announceResult.js
 *
 * Purpose:
 *   1. Build the final user-facing result text.
 *   2. Show a UI notification to the user who triggered the flow.
 *   3. Optionally create a chat message.
 *
 * Default notification format:
 *   <Actor Name> use <Icon><Action Name> on <Target Name>!
 *
 * Usage:
 *   import {
 *     announceActionReaderResult,
 *     registerActionReaderAnnounceResult
 *   } from "./actionReader-announceResult.js";
 * ========================================================================== */

import { ActionReaderCore as AR } from "./actionReader-core.js";
import { ActionReaderDebug as ARD } from "./actionReader-debug.js";

export const ACTION_READER_ANNOUNCE_RESULT_VERSION = "1.0.0";
export const ACTION_READER_ANNOUNCE_RESULT_STAGE = "AnnounceResult";

function getModuleApiContainer(moduleId) {
  const module = game.modules.get(moduleId);
  if (!module) return null;

  module.api ??= {};
  module.api.ActionReader ??= {};
  return module.api.ActionReader;
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

function getPerformerName(context) {
  return (
    context?.performer?.actorName ??
    context?.actorData?.identity?.actorName ??
    context?.performer?.actor?.name ??
    "Unknown Actor"
  );
}

function getChosenAction(context) {
  return context?.chosenAction ?? null;
}

function getChosenTargets(context) {
  return Array.isArray(context?.chosenTargets) ? context.chosenTargets : [];
}

function getActionName(context) {
  const chosenAction = getChosenAction(context);
  return (
    chosenAction?.name ??
    chosenAction?.itemSnapshot?.displayName ??
    chosenAction?.item?.name ??
    "Unknown Action"
  );
}

function getActionIcon(context) {
  const chosenAction = getChosenAction(context);
  return (
    chosenAction?.icon ??
    (chosenAction?.item ? AR.getActionTypeIcon(chosenAction.item) : "💥")
  );
}

function getTargetDisplayName(target) {
  return (
    target?.tokenName ??
    target?.actorName ??
    target?.token?.name ??
    target?.actor?.name ??
    "Unknown Target"
  );
}

function formatNameList(names = []) {
  const clean = names
    .map(name => AR.toString(name, "").trim())
    .filter(Boolean);

  if (!clean.length) return "";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;

  return `${clean.slice(0, -1).join(", ")}, and ${clean.at(-1)}`;
}

function getTargetNames(context) {
  return getChosenTargets(context).map(getTargetDisplayName);
}

function buildPlainText(context, options = {}) {
  const performerName = getPerformerName(context);
  const actionName = getActionName(context);
  const actionIcon = getActionIcon(context);
  const targetNames = getTargetNames(context);
  const targetText = formatNameList(targetNames);
  const noTargetText = AR.toString(options?.noTargetText, "no target");

  if (!targetText) {
    return `${performerName} use ${actionIcon}${actionName}!`;
  }

  return `${performerName} use ${actionIcon}${actionName} on ${targetText}!`;
}

function buildHtmlText(context, options = {}) {
  const performerName = foundry.utils.escapeHTML(getPerformerName(context));
  const actionName = foundry.utils.escapeHTML(getActionName(context));
  const actionIcon = foundry.utils.escapeHTML(getActionIcon(context));
  const targetNames = getTargetNames(context).map(name => foundry.utils.escapeHTML(name));
  const targetText = formatNameList(targetNames);

  if (!targetText) {
    return `<strong>${performerName}</strong> use ${actionIcon}<strong>${actionName}</strong>!`;
  }

  return `<strong>${performerName}</strong> use ${actionIcon}<strong>${actionName}</strong> on <strong>${targetText}</strong>!`;
}

function getChatSpeaker(context) {
  const token = context?.performer?.token ?? null;
  const actor = context?.performer?.actor ?? null;

  if (ChatMessage?.getSpeaker) {
    return ChatMessage.getSpeaker({ actor, token });
  }

  return {};
}

function getGmWhisperIds() {
  const recipients = ChatMessage?.getWhisperRecipients?.("GM") ?? [];
  return recipients.map(user => user.id).filter(Boolean);
}

async function createResultChatMessage(context, html, options = {}) {
  const speaker = getChatSpeaker(context);
  const whisperToGm = options?.whisperToGm !== false;
  const explicitWhisper = Array.isArray(options?.whisper) ? options.whisper.filter(Boolean) : null;

  const chatData = {
    speaker,
    content: html
  };

  if (explicitWhisper?.length) {
    chatData.whisper = explicitWhisper;
  } else if (whisperToGm) {
    chatData.whisper = getGmWhisperIds();
  }

  return ChatMessage.create(chatData);
}

function summarizeAnnouncement(context, plainText, htmlText, options = {}) {
  return {
    performerName: getPerformerName(context),
    actionName: getActionName(context),
    targetNames: getTargetNames(context),
    plainText,
    showNotification: options?.showNotification !== false,
    showChatMessage: Boolean(options?.showChatMessage)
  };
}

/* -------------------------------------------------------------------------- */
/* Exported stage function                                                    */
/* -------------------------------------------------------------------------- */

export async function announceActionReaderResult(context, options = {}) {
  const stage = ACTION_READER_ANNOUNCE_RESULT_STAGE;
  ARD.beginStage(context, stage, {
    optionsSummary: {
      showNotification: options?.showNotification !== false,
      showChatMessage: Boolean(options?.showChatMessage),
      whisperToGm: options?.whisperToGm !== false
    }
  });

  try {
    if (!context) {
      context = AR.createBaseContext();
    }

    const chosenAction = getChosenAction(context);
    if (!chosenAction) {
      ARD.addError(context, stage, "AnnounceResult requires a chosen action first.", {
        hasChosenAction: false
      });
      ARD.endStage(context, stage, { ok: false });
      return context;
    }

    const plainText = buildPlainText(context, options);
    const htmlText = buildHtmlText(context, options);

    context.finalText = plainText;
    context.finalHtml = htmlText;
    context.announceMeta = summarizeAnnouncement(context, plainText, htmlText, options);

    if (options?.showNotification !== false) {
      ui.notifications.info(plainText);
    }

    if (options?.showChatMessage) {
      await createResultChatMessage(context, htmlText, options);
    }

    ARD.recordStage(context, stage, context.announceMeta);

    if (ARD.isVerbose(context)) {
      ARD.table(
        stage,
        "Announcement summary",
        [{
          performerName: context.announceMeta.performerName,
          actionName: context.announceMeta.actionName,
          targetNames: formatNameList(context.announceMeta.targetNames),
          plainText: context.announceMeta.plainText,
          showNotification: context.announceMeta.showNotification,
          showChatMessage: context.announceMeta.showChatMessage
        }],
        context
      );
    }

    ARD.endStage(context, stage, {
      ok: true,
      finalText: context.finalText
    });

    return context;
  } catch (error) {
    ARD.addError(context, stage, "Unexpected error while announcing result.", {
      error: error?.message ?? String(error)
    });
    console.error("[ActionReader][AnnounceResult] Unexpected error:", error);
    ARD.endStage(context, stage, { ok: false, crashed: true });
    return context;
  }
}

/* -------------------------------------------------------------------------- */
/* Optional module API registration                                           */
/* -------------------------------------------------------------------------- */

export function registerActionReaderAnnounceResult(moduleId) {
  if (!moduleId || typeof moduleId !== "string") {
    console.warn("[ActionReader] registerActionReaderAnnounceResult called without a valid moduleId.");
    return;
  }

  const api = getModuleApiContainer(moduleId);
  if (!api) {
    console.warn(`[ActionReader] Could not find module "${moduleId}" while registering Announce Result.`);
    return;
  }

  api.AnnounceResult = {
    announceActionReaderResult
  };

  console.log(`[ActionReader] Announce Result registered to module API for "${moduleId}".`);
}
