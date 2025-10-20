// scripts/fu-card-hydrate.js — Foundry VTT v12
// Runs on every client. Hydrates fu-cards so tooltips, collapses, and per-user
// button visibility work locally for everyone.

(() => {
  const MODULE_NS = "fabula-ultima-companion";
  const TT_ID = "fu-global-tooltip";

  // ---------- 1) One-time global delegated UI (idempotent) ----------
  function installGlobalUIOnce() {
    if (window.__fuCardUIBound) return;
    window.__fuCardUIBound = true;

    // Tooltip node
    let tipEl = document.getElementById(TT_ID);
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = TT_ID;
      Object.assign(tipEl.style, {
        position: "fixed", zIndex: "2147483647", display: "none",
        background: "rgba(0,0,0,.90)", color: "#fff", padding: ".45rem .6rem",
        borderRadius: "6px", fontSize: "12px", maxWidth: "320px",
        pointerEvents: "none", boxShadow: "0 2px 8px rgba(0,0,0,.4)",
        border: "1px solid rgba(255,255,255,.15)", textAlign: "left",
        whiteSpace: "pre-wrap"
      });
      document.body.appendChild(tipEl);
    }
    const TIP_MARGIN = 10, CURSOR_GAP = 12;
    const placeTipAt = (x,y) => {
      const vw=innerWidth, vh=innerHeight, r=tipEl.getBoundingClientRect();
      let tx=x+CURSOR_GAP, ty=y+CURSOR_GAP;
      if (tx + r.width + TIP_MARGIN > vw) tx = x - r.width - CURSOR_GAP;
      if (tx < TIP_MARGIN) tx = TIP_MARGIN;
      if (ty + r.height + TIP_MARGIN > vh) ty = y - r.height - CURSOR_GAP;
      if (ty < TIP_MARGIN) ty = TIP_MARGIN;
      tipEl.style.left = `${tx}px`; tipEl.style.top = `${ty}px`;
    };
    const showTip = (html,x,y)=>{ tipEl.style.visibility="hidden"; tipEl.style.display="block"; tipEl.innerHTML=html; placeTipAt(x,y); tipEl.style.visibility="visible"; };
    const hideTip = ()=>{ tipEl.style.display="none"; };

    // Delegated tooltip (mouseover/mouseout so it bubbles)
    document.addEventListener("mouseover", (ev) => {
      const host = ev.target.closest?.(".fu-tip-host");
      if (!host) return;
      const html = decodeURIComponent(host.getAttribute("data-tip") || "");
      showTip(html, ev.clientX, ev.clientY);
      function mouseMoveFollower(e){ placeTipAt(e.clientX, e.clientY); }
      document.addEventListener("mousemove", mouseMoveFollower);
      host.addEventListener("mouseout", function onOut() {
        hideTip();
        document.removeEventListener("mousemove", mouseMoveFollower);
        host.removeEventListener("mouseout", onOut);
      }, { once:true });
    });

    // Delegated content-link opening (so your element/weapon links open for everyone)
    document.addEventListener("click", async (ev) => {
      const a = ev.target.closest?.("a.content-link[data-doc-uuid],a.content-link[data-uuid]");
      if (!a) return;
      ev.preventDefault(); ev.stopPropagation();
      const uuid = a.dataset.docUuid || a.dataset.uuid;
      if (!uuid) return;
      try { await Hotbar.toggleDocumentSheet(uuid); }
      catch {
        try { const doc = await fromUuid(uuid); doc?.sheet?.render(true); }
        catch { ui.notifications?.error("Could not open linked document."); }
      }
    });

    // Delegated collapsible Effect section
    document.addEventListener("click", (ev) => {
      const eff = ev.target.closest?.(".fu-effect");
      if (!eff) return;
      if (ev.target.closest("a")) return; // allow clicking links inside
      const body = eff.querySelector(".fu-effect-body");
      const hint = eff.querySelector(".fu-effect-hint");
      const collapsed = eff.dataset.collapsed !== "false";
      if (collapsed) {
        eff.dataset.collapsed = "false";
        const h = body.scrollHeight;
        body.style.maxHeight = h + "px";
        body.style.paddingTop = ".25rem"; body.style.paddingBottom = ".25rem";
        if (hint) hint.textContent = "(click to collapse)";
      } else {
        eff.dataset.collapsed = "true";
        body.style.maxHeight = "0px";
        body.style.paddingTop = "0"; body.style.paddingBottom = "0";
        if (hint) hint.textContent = "(click to expand)";
      }
    });

    // Roll-up numbers animation for any .fu-rollnum that appears
    const reduceMotion = matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const clamp=(n,a,b)=>Math.min(Math.max(n,a),b), fmt=(n)=>n.toLocaleString?.() ?? String(n), easeOutCubic=t=>1-Math.pow(1-t,3);
    function animateRollNumber(el) {
      if (!el || el.__rolled) return;
      el.__rolled = true;
      const final = Number(el.dataset.final || "0");
      const start = Math.min(1, final>0?1:0);
      if (!Number.isFinite(final) || final <= 0 || reduceMotion) { el.textContent = fmt(final); return; }
      const dur = clamp(800, 500, 900);
      const t0 = performance.now();
      function frame(now){
        const p = clamp((now - t0)/dur, 0, 1);
        const v = Math.max(start, Math.floor(start + (final - start) * easeOutCubic(p)));
        el.textContent = fmt(v);
        if (p < 1) requestAnimationFrame(frame);
        else el.textContent = fmt(final);
      }
      requestAnimationFrame(frame);
    }

    // Observe chat for new .fu-rollnum
    const chatRoot = document.getElementById("chat-log") || document.body;
    const io = "IntersectionObserver" in window ? new IntersectionObserver((ents, obs) => {
      for (const e of ents) if (e.isIntersecting) { animateRollNumber(e.target); obs.unobserve(e.target); }
    }, { threshold: 0.1 }) : null;

    // Kick existing nodes now
    document.querySelectorAll(".fu-rollnum").forEach(n => io ? io.observe(n) : animateRollNumber(n));

    const mo = new MutationObserver((muts)=>{
      for (const m of muts) {
        m.addedNodes?.forEach?.(node => {
          if (!(node instanceof HTMLElement)) return;
          node.querySelectorAll?.(".fu-rollnum").forEach(n => io ? io.observe(n) : animateRollNumber(n));
        });
      }
    });
    mo.observe(chatRoot, { childList:true, subtree:true });

    // Clean tooltip when a message closes
    Hooks.on("closeChatMessage", () => { const t=document.getElementById(TT_ID); if (t) t.style.display="none"; });
  }

  // ---------- 2) Per-message hydration & per-client visibility ----------
  async function hydratePerClient(chatMsg, htmlJQ) {
    // Only bother if this message has our card
    const root = htmlJQ?.[0];
    if (!root) return;
    const card = root.querySelector?.(".fu-card");
    if (!card) return;

    // Hide GM-only Apply button for non-GMs (local, per-client)
    if (!game.user?.isGM) {
      root.querySelectorAll("[data-gm-only]").forEach(el => el.style.display = "none");
    }

    // Gate owner-only buttons using the saved payload on the message
    let canInvoke = false;
    try {
      const saved = await chatMsg.getFlag(MODULE_NS, "actionCard");
      const attackerUuid = saved?.payload?.meta?.attackerUuid || saved?.payload?.core?.attackerUuid;
      if (game.user?.isGM) canInvoke = true;
      else if (attackerUuid) {
        const actor = await fromUuid(attackerUuid);
        if (actor) canInvoke = actor.isOwner;  // current user owns the attacker?
      }
    } catch (err) {
      console.warn("[fu-card-hydrate] Could not resolve attacker ownership:", err);
    }

    if (!canInvoke) {
      root.querySelectorAll("[data-fu-trait],[data-fu-bond]").forEach(el => el.style.display = "none");
    }
  }

  // ---------- Hooks ----------
  Hooks.once("ready", () => {
    installGlobalUIOnce();
  });

  Hooks.on("renderChatMessage", async (chatMsg, html, data) => {
    // Ensure global UI is present (covers late loads or popouts)
    installGlobalUIOnce();
    hydratePerClient(chatMsg, html);
  });
})();
