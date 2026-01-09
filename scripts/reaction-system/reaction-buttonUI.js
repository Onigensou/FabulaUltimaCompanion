/**
 * [ONI] Reaction System — Module Version (Foundry VTT v12)
 * ---------------------------------------------------------------------------
 * This file is safe to load automatically from a module (runs once per client).
 * Generated: 2026-01-09T07:27:00
 * ---------------------------------------------------------------------------
 */

Hooks.once("ready", () => {
  /**
   * Macro: ReactionButtonUI
   * Id: 4VRo1IJaYORWfhmR
   * Folder: Reaction System
   * Type: script
   * Author: GM
   * Exported: 2026-01-09T07:11:48.545Z
   */
  // ============================================================================
  // ONI ReactionButtonUI – Floating "Reaction" blade next to tokens (Foundry v12)
  // ---------------------------------------------------------------------------
  // PURPOSE
  // -------
  // This script ONLY handles the small floating "Reaction" button UI:
  //
  //   • Creates the #oni-reaction-root container and CSS
  //   • Spawns / positions a "Reaction" blade next to a token
  //   • Cleans up buttons when asked
  //
  // It exposes a small API on window["oni.ReactionButtonUI"]:
  //
  //   const ui = window["oni.ReactionButtonUI"];
  //   ui.spawnButton(token, context, (ctxClicked) => { ... });
  //   ui.removeButton(tokenId);
  //   ui.clearAll();
  //
  // NOTES
  // -----
  // - It DOES NOT know anything about triggers, phases, or skill selection.
  // - ReactionManager decides *when* to show a button and what happens when
  //   it's clicked. This file just does the pretty floating UI.
  // ============================================================================

  (() => {
    const KEY = "oni.ReactionButtonUI";
    if (window[KEY]) {
      console.log("[ReactionButtonUI] Already installed.");
      return;
    }

    // ---------------------------------------------------------------------------
    // 0) Helpers
    // ---------------------------------------------------------------------------

    function byIdOnCanvas(tokenId) {
      if (!tokenId) return null;
      return canvas?.tokens?.get(tokenId) ?? null;
    }

    const STYLE_ID = "oni-reaction-manager-style";

    function ensureReactionStyles() {
      if (document.getElementById(STYLE_ID)) return;
      const css = document.createElement("style");
      css.id = STYLE_ID;
      css.textContent = `
        #oni-reaction-root {
          position:fixed;
          left:0;
          top:0;
          z-index:var(--z-index-canvas, 0);
          pointer-events:none;
        }

        /* Wrapper that we animate in/out */
        #oni-reaction-root .oni-reaction-item {
          position:absolute;
          pointer-events:auto;
          opacity:0;
          transform:translateX(-16px);
          transition:
            opacity 180ms ease-out,
            transform 180ms ease-out;
        }

        /* Entered / visible state */
        #oni-reaction-root .oni-reaction-item.is-visible {
          opacity:1;
          transform:translateX(0);
        }

        /* Leaving state (fade + slide back to the left) */
        #oni-reaction-root .oni-reaction-item.is-leaving {
          opacity:0;
          transform:translateX(-16px);
        }

        #oni-reaction-root .oni-reaction-blade {
          position:relative;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          padding:8px 14px;
          color:var(--bd-ink, #3a3228);
          font-family:"Inter","Segoe UI",system-ui,-apple-system,sans-serif;
          font-weight:800;
          letter-spacing:.32px;
          text-transform:uppercase;
          white-space:nowrap;
          user-select:none;
          cursor:pointer;
          font-size:12px;
          background:linear-gradient(180deg,
            var(--bd-parchment-top, #f6f1e6),
            var(--bd-parchment-bot, #ebe3d0)
          );
          border:2px solid var(--bd-stroke, #7a6a55);
          border-radius:12px;
          box-shadow:0 3px 0 var(--bd-shadow, rgba(41,33,24,.55)),
                     0 0 0 1px var(--bd-highlight, rgba(255,255,255,.7)) inset;
          text-shadow:0 1px 0 rgba(255,255,255,0.75);
        }

        #oni-reaction-root .oni-reaction-blade .label {
          padding-top:1px;
        }

        #oni-reaction-root .oni-reaction-blade:hover {
          filter:brightness(1.04);
          box-shadow:0 4px 0 rgba(41,33,24,.65),
                     0 0 0 1px rgba(255,255,255,.8) inset;
          transform:translateY(-1px);
        }

        #oni-reaction-root .oni-reaction-blade:active {
          transform:translateY(0) scale(.97);
        }
      `;
      document.head.appendChild(css);
    }

    // ---------------------------------------------------------------------------
    // 1) Internal store
    // ---------------------------------------------------------------------------

    const ReactionUI = {
      root: null,
      buttons: {} // tokenId -> { wrap, tokenId, hooks: [ {event, handler}, ... ], context, leaving }
    };

    function ensureRoot() {
      if (ReactionUI.root && document.body.contains(ReactionUI.root)) return ReactionUI.root;
      const root = document.createElement("div");
      root.id = "oni-reaction-root";
      document.body.appendChild(root);
      ReactionUI.root = root;
      return root;
    }

    // Find an anchor point around the token, in WORLD coords
    function tokenAnchorWorld(token) {
      const c = token.center ?? token.getCenter?.() ?? {
        x: token.x + token.w / 2,
        y: token.y + token.h / 2
      };

      // Place Reaction button on the LEFT side of the token, slightly above center.
      // Turn UI lives on the right, so we mirror the horizontal offset.
      const offsetX = -token.w * 0.37;  // left of center
      const offsetY = -token.h * 1;  // slightly above center
      return { x: c.x + offsetX, y: c.y + offsetY };
    }

    // Convert WORLD coords to CLIENT-screen coords
    function worldToClient(x, y) {
      const wt = canvas.stage.worldTransform;
      const out = new PIXI.Point();
      wt.apply({ x, y }, out);
      const rect = canvas.app.view.getBoundingClientRect();
      return { x: rect.left + out.x, y: rect.top + out.y };
    }

    function updateButtonPosition(rec) {
      const token = byIdOnCanvas(rec.tokenId);
      if (!token || !ReactionUI.root) return;
      const world  = tokenAnchorWorld(token);
      const client = worldToClient(world.x, world.y);

      const el = rec.wrap;
      if (!el) return;

      el.style.left = `${client.x}px`;
      el.style.top  = `${client.y}px`;
    }

    // ---------------------------------------------------------------------------
    // 2) Public-ish operations – spawn / remove / clear
    // ---------------------------------------------------------------------------

    /**
     * Spawn a floating Reaction button for a given token.
     *
     * @param {Token} token          The token to attach to.
     * @param {object} context       The reaction context (actor, trigger, etc.)
     * @param {function} onClick     Called when the blade is clicked.
     *                               Signature: onClick(context)
     */
    function spawnButton(token, context, onClick) {
      if (!token) return;

      ensureReactionStyles();
      const root    = ensureRoot();
      const tokenId = token.id;

      // Clean up any existing button for this token
      removeButton(tokenId);

      const wrap = document.createElement("div");
      // Start in the "hidden" state; CSS will animate to is-visible next frame.
      wrap.className = "oni-reaction-item";

      const blade = document.createElement("div");
      blade.className = "oni-reaction-blade";
      blade.innerHTML = `<span class="label">Reaction</span>`;

      wrap.appendChild(blade);
      root.appendChild(wrap);

      const rec = {
        wrap,
        tokenId,
        hooks: [],
        context,
        leaving: false
      };

      // Position now and keep it synced with token/canvas movement
      updateButtonPosition(rec);

      const h1 = Hooks.on("updateToken", (doc) => {
        if (doc.id !== tokenId) return;
        updateButtonPosition(rec);
      });
      const h2 = Hooks.on("canvasPan", () => {
        updateButtonPosition(rec);
      });

      rec.hooks.push(
        { event: "updateToken", handler: h1 },
        { event: "canvasPan",  handler: h2 }
      );

      // Click handler – delegate to whoever called us
      blade.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (typeof onClick === "function") {
          try {
            onClick(rec.context);
          } catch (err) {
            console.error("[ReactionButtonUI] Error in onClick handler:", err);
          }
        }
      });

      // Trigger the enter animation on the next frame
      requestAnimationFrame(() => {
        if (!wrap.isConnected) return;
        wrap.classList.add("is-visible");
      });

      ReactionUI.buttons[tokenId] = rec;
    }

    function removeButton(tokenId) {
      const rec = ReactionUI.buttons[tokenId];
      if (!rec) return;

      // Prevent double-removal animations
      if (rec.leaving) return;
      rec.leaving = true;

      // Stop following the token / canvas immediately
      for (const h of rec.hooks ?? []) {
        try { Hooks.off(h.event, h.handler); } catch {}
      }

      const el = rec.wrap;
      if (!el) {
        delete ReactionUI.buttons[tokenId];
        return;
      }

      // Switch to "leaving" state: CSS will fade+slide it out.
      el.classList.remove("is-visible");
      el.classList.add("is-leaving");

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { el.removeEventListener("transitionend", finish); } catch {}
        try { el.remove(); } catch {}
        delete ReactionUI.buttons[tokenId];
      };

      // When the transition finishes, clean up
      el.addEventListener("transitionend", finish);

      // Safety fallback: if transition doesn't fire for some reason,
      // hard-remove after ~250ms.
      setTimeout(finish, 250);
    }

    function clearAll() {
      for (const tokenId of Object.keys(ReactionUI.buttons)) {
        removeButton(tokenId);
      }
    }

    // ---------------------------------------------------------------------------
    // 3) Expose API
    // ---------------------------------------------------------------------------

    window[KEY] = {
      spawnButton,
      removeButton,
      clearAll
    };

    console.log("[ReactionButtonUI] Installed. Provides oni.ReactionButtonUI API.");
  })();
});
