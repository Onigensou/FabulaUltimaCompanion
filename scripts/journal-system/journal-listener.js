/**
 * JournalSystem_Listener — Foundry VTT v12
 * Runs on EVERY client.
 * Listens for a socket broadcast to open a journal page, then:
 * - plays book SFX
 * - opens the journal entry/page
 */

(() => {
  const TAG = "[ONI][JournalSystem_Listener]";
  const CHANNEL = "module.fabula-ultima-companion";
  const ACTION_OPEN = "oni.journal.open";

  // ✅ Use a UNIQUE guard key to avoid collisions with other scripts/macros
  globalThis.ONI = globalThis.ONI ?? {};
  const GUARD = "__journalSystemListenerInstalled_v1";
  if (ONI[GUARD]) {
    console.log(`${TAG} already installed (guard=${GUARD})`);
    return;
  }
  ONI[GUARD] = true;

  const BOOK_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Book2.ogg";

  function playBookSfx() {
    try {
      AudioHelper.play({ src: BOOK_SFX, volume: 0.8, loop: false }, true);
    } catch (err) {
      console.warn(`${TAG} Failed to play SFX:`, err);
    }
  }

  async function openJournalByUuid(uuid) {
    const doc = await fromUuid(uuid);
    if (!doc) {
      console.warn(`${TAG} Cannot resolve UUID:`, uuid);
      return;
    }

    // Best practice: if it's a PAGE, open its PARENT entry and focus the page if possible
    if (doc.documentName === "JournalEntryPage") {
      const entry = doc.parent;
      if (!entry) {
        console.warn(`${TAG} Page has no parent entry:`, doc);
        doc.sheet?.render(true);
        return;
      }

      // Open the journal entry sheet
      entry.sheet?.render(true);

      // Try to switch to the page after the sheet renders (different sheets expose different APIs)
      setTimeout(() => {
        try {
          if (entry.sheet?.goToPage) entry.sheet.goToPage(doc.id);
          else if (entry.sheet?._showPage) entry.sheet._showPage(doc.id);
          else entry.sheet?.render(true, { pageId: doc.id });
        } catch (e) {
          // Not fatal — at least the entry opens
        }
      }, 50);

      return;
    }

    // JournalEntry opens normally
    if (doc.documentName === "JournalEntry") {
      doc.sheet?.render(true);
      return;
    }

    // Fallback
    doc.sheet?.render?.(true);
  }

  const handler = async (data) => {
    try {
      if (!data || data.action !== ACTION_OPEN) return;

      const { pageUuid, targetUserId } = data.payload ?? {};
      if (!pageUuid) return;

      // If a targetUserId is set, only that user should react.
      if (targetUserId && targetUserId !== game.user.id) return;

      console.log(`${TAG} RECEIVED`, data); // ✅ confirms the listener is actually firing
      playBookSfx();
      await openJournalByUuid(pageUuid);
    } catch (err) {
      console.error(`${TAG} handler error:`, err);
    }
  };

  game.socket.on(CHANNEL, handler);
  console.log(`${TAG} Installed on channel: ${CHANNEL} (guard=${GUARD})`);
})();
