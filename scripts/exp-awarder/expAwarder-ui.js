// ============================================================================
// expAwarder-ui.js (Foundry V12 Module Script) — MULTI-CLIENT + HEAVY DEBUG
//
// Goal:
// - EXP award UI appears on ALL connected clients.
// - Uses socket channel: "fabula-ultima-companion"  ✅ (per your system)
// - Also listens to "module.fabula-ultima-companion" as DEBUG fallback.
// - Socket message format expected:
//    { type: "oni:expAwarded", payload: { runId, entries:[...] } }
//
// IMPORTANT:
// - This script does NOT require socketlib.
// - It uses Foundry core game.socket
// ============================================================================

(() => {
  const TAG = "[ONI][EXPAwarder][UI]";

  // --------------------------------------------------------------------------
  // DEBUG SWITCH (TURN OFF later)
  // --------------------------------------------------------------------------
  const DEBUG = {
    enabled: true,
    socket: true,
    hook: true,
    queue: true,
    ui: true,
  };

  const dlog = (section, ...a) => {
    if (!DEBUG.enabled) return;
    if (section && DEBUG[section] === false) return;
    console.log(TAG, ...a);
  };
  const dwarn = (...a) => console.warn(TAG, ...a);
  const derr  = (...a) => console.error(TAG, ...a);

  // --------------------------------------------------------------------------
  // SOCKET CHANNELS
  // --------------------------------------------------------------------------
  const SOCKET_PRIMARY = "fabula-ultima-companion";        // ✅ your required one
  const SOCKET_FALLBACK = "module.fabula-ultima-companion"; // debug fallback

  // De-dupe so sender doesn’t double-play (local + echo)
  const SEEN_RUNIDS = new Set();
  const SEEN_MAX = 500;

  function rememberRunId(runId, source) {
    if (!runId) return false;
    if (SEEN_RUNIDS.has(runId)) {
      dlog("socket", `[DEDUPE] skip runId=${runId} (source=${source})`);
      return true;
    }
    SEEN_RUNIDS.add(runId);
    dlog("socket", `[DEDUPE] remember runId=${runId} (source=${source}) size=${SEEN_RUNIDS.size}`);

    // cap memory
    if (SEEN_RUNIDS.size > SEEN_MAX) {
      const keep = Array.from(SEEN_RUNIDS).slice(-Math.floor(SEEN_MAX * 0.8));
      SEEN_RUNIDS.clear();
      for (const k of keep) SEEN_RUNIDS.add(k);
      dlog("socket", `[DEDUPE] trimmed -> size=${SEEN_RUNIDS.size}`);
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // QUEUE (1 UI at a time)
  // --------------------------------------------------------------------------
  const UI_STATE = {
    lock: false,
    queue: [],
  };

  // --------------------------------------------------------------------------
  // TUNING KNOBS
  // --------------------------------------------------------------------------
  const INTRO_MS = 260;
  const OUTRO_MS = 220;
  const HOLD_MS = 650;
  const BAR_ANIM_MS = 900;

  const GAP_MS = 250;
  const SLIDE_PX = 18;

  const PAD_X = 18;
  const PAD_Y = 18;

  // Floating LEVEL UP! position tuning
  const LEVELUP_OFFSET_X = 0;
  const LEVELUP_OFFSET_Y = 22;

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const clamp = (n, a, b) => Math.min(Math.max(n, a), b);

  function removeRoot() {
    const old = document.querySelector(".oni-exp-root");
    if (old) old.remove();
  }

  function ensureStyles() {
    const id = "oni-exp-ui-style";
    const old = document.getElementById(id);
    if (old) old.remove();

    const css = `
      :root{
        --oni-exp-bg: rgba(8, 10, 14, 0.62);
        --oni-exp-border: rgba(255,255,255,0.18);
        --oni-exp-text: rgba(255,255,255,0.92);
        --oni-exp-sub: rgba(255,255,255,0.72);
        --oni-exp-accent: rgba(255, 210, 120, 0.95);
        --oni-exp-bar-bg: rgba(255,255,255,0.14);
        --oni-exp-shadow: 0 10px 30px rgba(0,0,0,0.35);
      }

      .oni-exp-root{
        position: fixed;
        inset: 0;
        z-index: 100000;
        pointer-events: none;
        font-family: "Signika","Segoe UI",sans-serif;
      }

      .oni-exp-ui{
        position: absolute;
        top: ${PAD_Y}px;
        left: ${PAD_X}px;
        right: auto;
        bottom: auto;
      }

      .oni-exp-card{
        width: 520px;
        max-width: calc(100vw - ${PAD_X * 2}px);
        padding: 18px 18px 16px;
        border-radius: 16px;
        background: var(--oni-exp-bg);
        border: 1px solid var(--oni-exp-border);
        box-shadow: var(--oni-exp-shadow);
        backdrop-filter: blur(10px);

        transform: translateX(-${SLIDE_PX}px);
        opacity: 0;

        transition:
          transform ${INTRO_MS}ms ease,
          opacity ${INTRO_MS}ms ease;

        overflow: visible;
      }

      .oni-exp-card.is-in{
        transform: translateX(0);
        opacity: 1;
      }

      .oni-exp-header{
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .oni-exp-name{
        color: var(--oni-exp-text);
        font-size: 20px;
        font-weight: 700;
        letter-spacing: 0.2px;
      }
      .oni-exp-lv{
        color: var(--oni-exp-sub);
        font-size: 14px;
      }
      .oni-exp-lv strong{
        color: var(--oni-exp-text);
        font-size: 16px;
      }

      .oni-exp-row{
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      .oni-exp-label{
        color: var(--oni-exp-sub);
        font-size: 13px;
        letter-spacing: 0.5px;
      }
      .oni-exp-pct{
        color: var(--oni-exp-text);
        font-size: 14px;
        font-weight: 700;
      }

      .oni-exp-bar{
        position: relative;
        height: 12px;
        border-radius: 999px;
        background: var(--oni-exp-bar-bg);
        overflow: hidden;
      }
      .oni-exp-fill{
        position: absolute;
        inset: 0 auto 0 0;
        width: 0%;
        background: linear-gradient(90deg, rgba(255,214,130,0.95), rgba(255,170,80,0.95));
      }

      .oni-exp-levelup-float{
        position: absolute;
        left: ${12 + LEVELUP_OFFSET_X}px;
        top: ${-32 + LEVELUP_OFFSET_Y}px;
        font-weight: 1000;
        font-size: 18px;
        letter-spacing: 1px;
        color: rgba(255,255,255,0.96);
        text-shadow:
          -1px  0px 0 rgba(0,0,0,0.85),
           1px  0px 0 rgba(0,0,0,0.85),
           0px -1px 0 rgba(0,0,0,0.85),
           0px  1px 0 rgba(0,0,0,0.85),
           0 2px 0 rgba(0,0,0,0.35);
        opacity: 0;
        transform: translateY(-8px) scale(1.2);
        pointer-events:none;
        z-index: 3;
      }
      .oni-exp-levelup-float.is-show{
        animation: oniExpLevelUp 1400ms ease-in-out forwards;
      }
      @keyframes oniExpLevelUp{
        0%{ opacity: 0; transform: translateY(-10px) scale(1.18); }
        18%{ opacity: 1; transform: translateY(0px) scale(1.22); }
        80%{ opacity: 1; transform: translateY(0px) scale(1.22); }
        100%{ opacity: 0; transform: translateY(-8px) scale(1.18); }
      }
    `;

    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // --------------------------------------------------------------------------
  // Data shaping (uses API-provided expPctFrom/expPctTo)
  // --------------------------------------------------------------------------
  function shapeData(entry) {
    let levelBefore = entry?.levelBefore ?? 1;
    let levelAfter  = entry?.levelAfter ?? levelBefore;

    let expPctFrom = entry?.expPctFrom;
    let expPctTo   = entry?.expPctTo;

    // If API didn't provide (shouldn't happen now), fallback
    if (expPctFrom == null || expPctTo == null) {
      const expBeforeRaw = Number(entry?.expBefore ?? 0);
      const expAfterRaw  = Number(entry?.expAfter ?? expBeforeRaw);
      const FALLBACK_STEP = 100;
      expPctFrom = (expBeforeRaw % FALLBACK_STEP) / FALLBACK_STEP * 100;
      expPctTo   = (expAfterRaw  % FALLBACK_STEP) / FALLBACK_STEP * 100;
    }

    return {
      actorName: entry?.actorName ?? "Unknown",
      levelBefore: Number(levelBefore),
      levelAfter: Number(levelAfter),
      expPctFrom: Number(expPctFrom ?? 0),
      expPctTo: Number(expPctTo ?? 0),
    };
  }

  // --------------------------------------------------------------------------
  // UI build
  // --------------------------------------------------------------------------
  function buildUI(data) {
    removeRoot();

    const root = document.createElement("div");
    root.className = "oni-exp-root";

    const ui = document.createElement("div");
    ui.className = "oni-exp-ui";
    root.appendChild(ui);

    const card = document.createElement("div");
    card.className = "oni-exp-card";
    ui.appendChild(card);

    const levelUp = document.createElement("div");
    levelUp.className = "oni-exp-levelup-float";
    levelUp.textContent = "LEVEL UP!";
    ui.appendChild(levelUp);

    const header = document.createElement("div");
    header.className = "oni-exp-header";
    card.appendChild(header);

    const name = document.createElement("div");
    name.className = "oni-exp-name";
    name.textContent = String(data.actorName || "Unknown");
    header.appendChild(name);

    const lv = document.createElement("div");
    lv.className = "oni-exp-lv";
    lv.innerHTML = `Lv <strong class="oni-exp-lv-num">${Number(data.levelBefore || 1)}</strong>`;
    header.appendChild(lv);

    const row = document.createElement("div");
    row.className = "oni-exp-row";
    card.appendChild(row);

    const label = document.createElement("div");
    label.className = "oni-exp-label";
    label.textContent = "EXP";
    row.appendChild(label);

    const pct = document.createElement("div");
    pct.className = "oni-exp-pct";
    pct.textContent = `${Number(data.expPctFrom || 0).toFixed(1)}%`;
    row.appendChild(pct);

    const bar = document.createElement("div");
    bar.className = "oni-exp-bar";
    card.appendChild(bar);

    const fill = document.createElement("div");
    fill.className = "oni-exp-fill";
    bar.appendChild(fill);

    document.body.appendChild(root);

    // Heavy debug: confirm it exists + where it is
    if (DEBUG.enabled && DEBUG.ui) {
      const rect = card.getBoundingClientRect();
      dlog("ui", "[UI] appended root/card", {
        inDOM: document.body.contains(root),
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        zIndex: getComputedStyle(root).zIndex,
        opacity: getComputedStyle(card).opacity,
      });
    }

    return {
      root, ui, card,
      lvNum: lv.querySelector(".oni-exp-lv-num"),
      pct, fill, levelUp
    };
  }

  function setBar(ui, pct) {
    const p = clamp(Number(pct), 0, 100);
    ui.fill.style.width = `${p.toFixed(2)}%`;
    ui.pct.textContent = `${p.toFixed(1)}%`;
  }

  function flashLevelUp(ui) {
    ui.levelUp.classList.remove("is-show");
    void ui.levelUp.offsetWidth;
    ui.levelUp.classList.add("is-show");
  }

  async function animateBar(ui, fromPct, toPct, durationMs) {
    const a = clamp(Number(fromPct), 0, 100);
    const b = clamp(Number(toPct), 0, 100);

    if (durationMs <= 0) { setBar(ui, b); return; }

    const start = performance.now();
    return new Promise((resolve) => {
      function frame(now) {
        const t = clamp((now - start) / durationMs, 0, 1);
        const v = a + (b - a) * t;
        setBar(ui, v);
        if (t >= 1) resolve();
        else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  }

  async function teardown(ui) {
    ui.card.classList.remove("is-in");
    ui.card.style.transition = `transform ${OUTRO_MS}ms ease, opacity ${OUTRO_MS}ms ease`;
    ui.card.style.transform = `translateX(-${SLIDE_PX}px)`;
    ui.card.style.opacity = "0";
    await sleep(OUTRO_MS + 10);
    removeRoot();
  }

  // --------------------------------------------------------------------------
  // Main runOnce (supports overflow level-ups)
  // --------------------------------------------------------------------------
  async function runOnce(entry, meta) {
    ensureStyles();

    const data = shapeData(entry);
    const ui = buildUI(data);

    const lvBefore = Math.floor(Number(data.levelBefore || 1));
    const lvAfter  = Math.floor(Number(data.levelAfter || lvBefore));
    const gainedRaw = Number(entry?.levelsGained);
    const levelsGained =
      Number.isFinite(gainedRaw)
        ? Math.max(0, Math.floor(gainedRaw))
        : Math.max(0, lvAfter - lvBefore);

    // Set initial
    ui.lvNum.textContent = String(lvBefore);
    setBar(ui, data.expPctFrom);

    await sleep(0);
    ui.card.classList.add("is-in");

    const durScaled = (from, to, base) => {
      const dist = Math.abs(clamp(Number(to), 0, 100) - clamp(Number(from), 0, 100));
      const ms = base * (dist / 100);
      return Math.max(120, Math.floor(ms));
    };

    if (levelsGained <= 0) {
      await animateBar(ui, data.expPctFrom, data.expPctTo, BAR_ANIM_MS);
    } else {
      // Fill -> 100 on old level
      await animateBar(ui, data.expPctFrom, 100, durScaled(data.expPctFrom, 100, BAR_ANIM_MS));
      await sleep(90);

      let shownLv = lvBefore;

      for (let i = 0; i < levelsGained; i++) {
        shownLv += 1;
        ui.lvNum.textContent = String(shownLv);
        flashLevelUp(ui);

        setBar(ui, 0);
        await sleep(80);

        if (i < levelsGained - 1) {
          await animateBar(ui, 0, 100, BAR_ANIM_MS);
          await sleep(90);
        }
      }

      // Final overflow fill
      await animateBar(ui, 0, data.expPctTo, durScaled(0, data.expPctTo, BAR_ANIM_MS));
    }

    await sleep(HOLD_MS);
    await teardown(ui);
  }

  async function drainQueue() {
    UI_STATE.lock = true;
    try {
      while (UI_STATE.queue.length) {
        const { meta, entry } = UI_STATE.queue.shift();
        dlog("queue", "[QUEUE] UI start", {
          actorName: entry?.actorName,
          actorUuid: entry?.actorUuid,
          runId: meta?.runId,
          fromSocket: meta?.__fromSocket ?? false,
          queueRemain: UI_STATE.queue.length
        });
        await runOnce(entry, meta);
        dlog("queue", "[QUEUE] UI end", { actorName: entry?.actorName, queueRemain: UI_STATE.queue.length });
        await sleep(GAP_MS);
      }
    } catch (e) {
      derr("[QUEUE] drain crashed", e);
    } finally {
      UI_STATE.lock = false;
      removeRoot();
      dlog("queue", "[QUEUE] drain complete");
    }
  }

  // --------------------------------------------------------------------------
  // Local hook receive
  // --------------------------------------------------------------------------
  Hooks.on("oni:expAwarded", (payload) => {
    try {
      const runId = payload?.runId;

      dlog("hook", "[HOOK] oni:expAwarded received", {
        runId,
        entriesLen: Array.isArray(payload?.entries) ? payload.entries.length : 0,
        hasSocketMarker: payload?.__fromSocket ?? false,
      });

      // De-dupe at hook layer too (protect against echo)
      if (runId && rememberRunId(runId, "hook")) return;

      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      if (!entries.length) return;

      for (const e of entries) UI_STATE.queue.push({ meta: payload, entry: e });

      dlog("queue", "[QUEUE] enqueued", { runId, added: entries.length, queueSize: UI_STATE.queue.length });

      if (!UI_STATE.lock) drainQueue();
    } catch (e) {
      derr("[HOOK] handler crashed", e);
    }
  });

  // --------------------------------------------------------------------------
  // Socket receive (THIS is what makes all clients show UI)
  // --------------------------------------------------------------------------
  function onSocketMessage(channelName, msg) {
    try {
      dlog("socket", `[SOCKET] recv on "${channelName}"`, msg);

      if (!msg) return;
      if (msg.type !== "oni:expAwarded") {
        dlog("socket", `[SOCKET] ignore type="${msg.type}"`);
        return;
      }

      const payload = msg.payload;
      const runId = payload?.runId;

      dlog("socket", "[SOCKET] oni:expAwarded payload", {
        runId,
        entriesLen: Array.isArray(payload?.entries) ? payload.entries.length : 0,
        fromUser: payload?.awardedBy?.name ?? payload?.awardedBy?.id ?? null,
      });

      if (runId && rememberRunId(runId, `socket:${channelName}`)) return;

      // Mark it came from socket (helps debugging)
      const marked = { ...payload, __fromSocket: true };

      // Re-fire locally so the rest of the UI system is unchanged
      Hooks.callAll("oni:expAwarded", marked);

      dlog("socket", "[SOCKET] re-fired Hooks.callAll(oni:expAwarded)", { runId });
    } catch (e) {
      derr("[SOCKET] handler crashed", e);
    }
  }

  Hooks.once("ready", () => {
    try {
      dlog("socket", "READY", {
        user: { id: game.user?.id, name: game.user?.name, isGM: game.user?.isGM },
        socketHasOn: !!game.socket?.on,
        primary: SOCKET_PRIMARY,
        fallback: SOCKET_FALLBACK
      });

      if (!game.socket?.on) {
        dwarn("game.socket.on not available — cannot receive multi-client UI.");
        return;
      }

      // ✅ correct channel
      game.socket.on(SOCKET_PRIMARY, (msg) => onSocketMessage(SOCKET_PRIMARY, msg));
      dlog("socket", `[SOCKET] listening on "${SOCKET_PRIMARY}"`);

      // debug fallback (helps catch API emitting to module.* by mistake)
      game.socket.on(SOCKET_FALLBACK, (msg) => onSocketMessage(SOCKET_FALLBACK, msg));
      dlog("socket", `[SOCKET] also listening on fallback "${SOCKET_FALLBACK}" (debug)`);

      dlog("ui", "UI script ready: listening to hook + socket");
    } catch (e) {
      derr("Failed to register socket listeners", e);
    }
  });
})();
