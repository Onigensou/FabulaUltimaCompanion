// ============================================================================
// expAwarder-ui.js (Foundry V12 Module Script)
// - Listens for: Hooks.on("oni:expAwarded", payload)
// - Shows EXP award UI (decoupled snapshot)
// - Multiple targets => queue => ONLY 1 UI at a time
//
// NOTE: This is based on Sample_EXPAwarder_UI.js "EXACTLY" in structure/styling,
//       but wired to real event payload + queue system.
// ============================================================================

(() => {
  const TAG = "[ONI][EXPAwarder][UI]";
  const DBG = true;

  function log(...args) { if (DBG) console.log(TAG, ...args); }
  function warn(...args) { console.warn(TAG, ...args); }
  function err(...args) { console.error(TAG, ...args); }

  // ----------------------------------------------------------------------------
  // Queue system (hard rule: only 1 UI at a time)
  // ----------------------------------------------------------------------------
  const UI_STATE = {
    lock: false,
    queue: [],
  };

  Hooks.on("oni:expAwarded", (payload) => {
    try {
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      if (!entries.length) return;

      // Push all entries into queue (sequential display)
      for (const e of entries) UI_STATE.queue.push({ meta: payload, entry: e });

      log("Event received; queued entries=", entries.length, "queueSize=", UI_STATE.queue.length);

      if (!UI_STATE.lock) drainQueue();
    } catch (e) {
      err("oni:expAwarded handler crashed", e);
    }
  });

  async function drainQueue() {
    UI_STATE.lock = true;
    try {
      while (UI_STATE.queue.length) {
        const { meta, entry } = UI_STATE.queue.shift();
        log("UI start", { actorName: entry?.actorName, actorUuid: entry?.actorUuid, runId: meta?.runId });
        await runOnce(entry, meta);
        log("UI end", { actorName: entry?.actorName, remaining: UI_STATE.queue.length });
        await sleep(GAP_MS);
      }
    } catch (e) {
      err("Queue drain crashed", e);
    } finally {
      UI_STATE.lock = false;
      removeRoot();
      log("Queue drain complete");
    }
  }

  // ----------------------------------------------------------------------------
  // TUNING KNOBS (kept from sample)
  // ----------------------------------------------------------------------------
  const DIM_ENABLED = true;       // keep
  const LOOP_ENABLED = false;     // loop disabled in real UI
  const INTRO_MS = 280;
  const OUTRO_MS = 260;
  const HOLD_MS = 650;
  const BAR_ANIM_MS = 900;
  const GAP_MS = 250;            // gap between queued actors

  // ----------------------------------------------------------------------------
  // Utilities (kept from sample)
  // ----------------------------------------------------------------------------
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function clamp(n, a, b) { return Math.min(Math.max(n, a), b); }

  function removeRoot() {
    const old = document.querySelector(".oni-exp-root");
    if (old) old.remove();
  }

  function ensureStyles() {
    const id = "oni-exp-tuner-style";
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

      .oni-exp-dim{
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,0.25);
        opacity: 0;
        transition: opacity ${INTRO_MS}ms ease;
      }
      .oni-exp-dim.is-in{ opacity: 1; }

      .oni-exp-ui{
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
      }

      .oni-exp-card{
        width: 520px;
        max-width: calc(100vw - 80px);
        padding: 18px 18px 16px;
        border-radius: 16px;
        background: var(--oni-exp-bg);
        border: 1px solid var(--oni-exp-border);
        box-shadow: var(--oni-exp-shadow);
        backdrop-filter: blur(10px);
        transform: translateY(10px) scale(0.98);
        opacity: 0;
        transition: transform ${INTRO_MS}ms ease, opacity ${INTRO_MS}ms ease;
      }
      .oni-exp-card.is-in{
        transform: translateY(0) scale(1);
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
        translate: 0 -110px;
        padding: 10px 18px;
        border-radius: 999px;
        background: rgba(0,0,0,0.35);
        border: 1px solid rgba(255,255,255,0.16);
        color: var(--oni-exp-accent);
        font-weight: 900;
        letter-spacing: 1px;
        text-transform: uppercase;
        opacity: 0;
        transform: translateY(10px) scale(0.98);
        transition: opacity 220ms ease, transform 220ms ease;
        text-shadow: 0 2px 10px rgba(0,0,0,0.35);
      }
      .oni-exp-levelup-float.is-show{
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    `;

    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ----------------------------------------------------------------------------
  // Decoupled data shaping (fallbacks for early testing)
  // ----------------------------------------------------------------------------
  function shapeData(entry) {
    // Preferred: API later can send expPctFrom/To + levelAfter
    const expBefore = Number(entry?.expBefore ?? 0);
    const expAfter = Number(entry?.expAfter ?? expBefore);

    let levelBefore = entry?.levelBefore;
    let levelAfter = entry?.levelAfter;

    // Fallback visual model (ONLY for UI testing): 100 EXP per level
    // (This does NOT affect real actor data; UI is decoupled.)
    const FALLBACK_STEP = 100;

    if (levelBefore == null) levelBefore = Math.floor(expBefore / FALLBACK_STEP) + 1;
    if (levelAfter == null) levelAfter = Math.floor(expAfter / FALLBACK_STEP) + 1;

    let expPctFrom = entry?.expPctFrom;
    let expPctTo = entry?.expPctTo;

    if (expPctFrom == null) expPctFrom = (expBefore % FALLBACK_STEP) / FALLBACK_STEP * 100;
    if (expPctTo == null) expPctTo = (expAfter % FALLBACK_STEP) / FALLBACK_STEP * 100;

    return {
      actorName: entry?.actorName ?? "Unknown",
      levelBefore,
      levelAfter,
      expPctFrom,
      expPctTo,
    };
  }

  // ----------------------------------------------------------------------------
  // UI build + animation (same flow as sample, but data-driven)
  // ----------------------------------------------------------------------------
  function buildUI(data) {
    removeRoot();

    const root = document.createElement("div");
    root.className = "oni-exp-root";

    const dim = document.createElement("div");
    dim.className = "oni-exp-dim";
    if (DIM_ENABLED) root.appendChild(dim);

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
    pct.textContent = `${Math.round(Number(data.expPctFrom || 0))}%`;
    row.appendChild(pct);

    const bar = document.createElement("div");
    bar.className = "oni-exp-bar";
    card.appendChild(bar);

    const fill = document.createElement("div");
    fill.className = "oni-exp-fill";
    bar.appendChild(fill);

    document.body.appendChild(root);

    return {
      root,
      dim,
      ui,
      card,
      name,
      lv,
      lvNum: lv.querySelector(".oni-exp-lv-num"),
      pct,
      bar,
      fill,
      levelUp,
    };
  }

  function setBar(ui, pct) {
    const p = clamp(Number(pct), 0, 100);
    ui.fill.style.width = `${p.toFixed(2)}%`;
    ui.pct.textContent = `${Math.round(p)}%`;
  }

  function flashLevelUp(ui) {
    ui.levelUp.classList.remove("is-show");
    void ui.levelUp.offsetWidth;
    ui.levelUp.classList.add("is-show");
  }

  async function animateBar(ui, fromPct, toPct, durationMs) {
    const a = clamp(Number(fromPct), 0, 100);
    const b = clamp(Number(toPct), 0, 100);

    if (durationMs <= 0) {
      setBar(ui, b);
      return;
    }

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
    if (ui.dim) ui.dim.classList.remove("is-in");
    await sleep(OUTRO_MS + 10);
    removeRoot();
  }

  async function runOnce(entry, meta) {
    ensureStyles();

    const data = shapeData(entry);
    const ui = buildUI(data);

    // Intro
    await sleep(0);
    if (ui.dim) ui.dim.classList.add("is-in");
    ui.card.classList.add("is-in");

    // Start
    ui.lvNum.textContent = String(Math.floor(Number(data.levelBefore || 1)));
    setBar(ui, data.expPctFrom);

    // Animate bar
    await animateBar(ui, data.expPctFrom, data.expPctTo, BAR_ANIM_MS);

    // Level up flash
    const lvBefore = Math.floor(Number(data.levelBefore || 1));
    const lvAfter = Math.floor(Number(data.levelAfter || lvBefore));
    if (lvAfter > lvBefore) {
      ui.lvNum.textContent = String(lvAfter);
      flashLevelUp(ui);
    }

    // Hold + outro
    await sleep(HOLD_MS);
    await teardown(ui);
  }

  Hooks.once("ready", () => {
    log("UI script ready. Listening for oni:expAwarded");
  });
})();
