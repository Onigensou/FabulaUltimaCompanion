/**
 * JournalSystem_Listener — Foundry VTT v12
 * Runs on EVERY client.
 * Listens for a socket broadcast to open a journal page, then:
 * - plays book SFX
 * - opens the journal page (or entry) for that client
 */

(() => {
  const TAG = "[ONI][JournalSystem_Listener]";
  const CHANNEL = "module.fabula-ultima-companion"; // change if your module id differs
  const ACTION_OPEN = "oni.journal.open";

  // Prevent double-install (important if hot reloading or rerunning)
  globalThis.ONI = globalThis.ONI ?? {};
  ONI.__journalListenerInstalled = ONI.__journalListenerInstalled ?? false;
  if (ONI.__journalListenerInstalled) return;
  ONI.__journalListenerInstalled = true;

  const BOOK_SFX = "https://assets.forge-vtt.com/610d918102e7ac281373ffcb/Sound/Soundboard/Book2.ogg";

  async function openJournalByUuid(uuid) {
    const doc = await fromUuid(uuid);
    if (!doc) {
      console.warn(`${TAG} Cannot resolve UUID:`, uuid);
      return;
    }

    // If it's a JournalEntryPage, open the page sheet
    if (doc.documentName === "JournalEntryPage") {
      doc.sheet?.render(true);
      return;
    }

    // If it's a JournalEntry, open the entry sheet
    if (doc.documentName === "JournalEntry") {
      doc.sheet?.render(true);
      return;
    }

    // Fallback: try rendering anything that has a sheet
    doc.sheet?.render?.(true);
  }

  function playBookSfx() {
    try {
      AudioHelper.play({ src: BOOK_SFX, volume: 0.8, loop: false }, true);
    } catch (err) {
      console.warn(`${TAG} Failed to play SFX:`, err);
    }
  }

  // Socket handler
  const handler = async (data) => {
    try {
      if (!data || data.action !== ACTION_OPEN) return;

      const { pageUuid, targetUserId } = data.payload ?? {};
      if (!pageUuid) return;

      // If a targetUserId is set, only that user should react.
      if (targetUserId && targetUserId !== game.user.id) return;

      playBookSfx();
      await openJournalByUuid(pageUuid);
    } catch (err) {
      console.error(`${TAG} handler error:`, err);
    }
  };

  // Register listener on your module channel if possible, otherwise fallback to "world"
  const canUseModuleChannel = !!game.socket && (CHANNEL.startsWith("module."));
  const finalChannel = canUseModuleChannel ? CHANNEL : "world";

  game.socket.on(finalChannel, handler);

  console.log(`${TAG} Installed on channel: ${finalChannel}`);
})();
