/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The workspace panel's side of the window and its width, which are this
 * device's (spec §5.6) and shared by every window on its settings.
 *
 * `SvalWindow` loads this as a classic script after `sval-panel.js`; it adds
 * its methods to `SvalPanel`, whose state and helpers it shares.
 */

/* import-globals-from sval-panel.js */

{
  /** Whether Firefox's sidebar sits at the window's start (`SidebarController`). */
  const SIDEBAR_START_PREF = "sidebar.position_start";
  const { IN_PANEL_PREF } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalHeader.sys.mjs"
  );
  const { SvalPanelToolbar } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelToolbar.sys.mjs"
  );

  Object.assign(SvalPanel, {
    /**
     * Puts the panel on the side spec §5.6 records for this device:
     * `sval-panel.css` places the box by `sval-placement`, over the order
     * Firefox's sidebar writes on each of `#browser`'s children.
     */
    _applyPlacement() {
      const container = this._els.container;
      const placement = this._settings.placement;
      // Firefox's sidebar opens on the panel's other side, so the two never
      // stack. The pref is every window's, so only the profile's side writes
      // it: a window on a tree in memory keeps the side it opened with.
      if (!this._inMemory) {
        Services.prefs.setBoolPref(SIDEBAR_START_PREF, placement === "right");
      }
      container.setAttribute("sval-placement", placement);
      // Kept for the next window's first paint (`SvalWindow`), before this
      // device's settings have loaded.
      if (!this._inMemory) {
        Services.xulStore.setValue(
          document.documentURI,
          container.id,
          "sval-placement",
          placement
        );
      }
    },

    /**
     * The panel's edge, which a drag or the arrow keys move to resize it, and
     * a double-click or Enter puts back to its default width. It is the ARIA
     * window splitter (WAI-ARIA APG, "Window Splitter"), with Home and End
     * taking the panel to its narrowest and widest. The panel has no collapsed
     * state, so Enter restores its default instead of collapsing it. The width
     * is this device's (spec §5.6), so every window on these settings takes
     * it. The stylesheet's `min-width` and `max-width` bound it, and the width
     * kept is the one the panel ends up drawn at.
     *
     * @param {Element} container `#sval-panel-container`.
     * @returns {Element} the edge.
     */
    _buildResizer(container) {
      const edge = this._html("div");
      edge.className = "sval-panel-resizer";
      edge.setAttribute("role", "separator");
      edge.setAttribute("aria-orientation", "vertical");
      edge.setAttribute("aria-label", "Resize panel");
      edge.tabIndex = 0;

      // Which way along x widens the panel: towards the page, wherever the
      // panel sits and whichever way the window's text runs.
      const widening = () => {
        const panel = container.getBoundingClientRect();
        const own = edge.getBoundingClientRect();
        return own.left + own.width / 2 > panel.left + panel.width / 2 ? 1 : -1;
      };
      // Measured when it is read, so the panel's layout is never forced
      // only to keep this current.
      const sayWidth = () =>
        edge.setAttribute(
          "aria-valuenow",
          String(Math.round(container.getBoundingClientRect().width))
        );
      // The range the value is read against: the stylesheet's bounds, which
      // Home and End go to. The maximum is a share of the window, so it
      // follows the window's size.
      const sayBounds = () => {
        const style = window.getComputedStyle(container);
        edge.setAttribute("aria-valuemin", String(parseFloat(style.minWidth)));
        edge.setAttribute(
          "aria-valuemax",
          String(Math.round(parseFloat(style.maxWidth)))
        );
      };
      const onResize = () => {
        if (edge.isConnected) {
          sayBounds();
        } else {
          window.removeEventListener("resize", onResize);
        }
      };
      sayBounds();
      window.addEventListener("resize", onResize);
      edge.addEventListener("focus", sayBounds);
      const keep = () => {
        this._setPanelWidth(
          Math.round(container.getBoundingClientRect().width)
        );
        sayWidth();
      };
      edge.addEventListener("focus", sayWidth);

      let drag = null;
      edge.addEventListener("pointerdown", event => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        edge.setPointerCapture(event.pointerId);
        drag = {
          x: event.clientX,
          width: container.getBoundingClientRect().width,
          sign: widening(),
          moved: false,
        };
        container.toggleAttribute("sval-resizing", true);
      });
      edge.addEventListener("pointermove", event => {
        if (drag && event.clientX !== drag.x) {
          drag.moved = true;
          const width = drag.width + drag.sign * (event.clientX - drag.x);
          container.style.width = `${this._snapWidth(Math.max(0, width), null)}px`;
        }
      });
      // A press that never moved keeps no width: the panel stays on the
      // default, or on the width it was given for a wider window.
      const end = () => {
        if (drag) {
          const { moved } = drag;
          drag = null;
          container.removeAttribute("sval-resizing");
          if (moved) {
            keep();
          }
        }
      };
      edge.addEventListener("pointerup", end);
      edge.addEventListener("lostpointercapture", end);
      edge.addEventListener("dblclick", () => {
        this._setPanelWidth(null);
        sayWidth();
      });
      edge.addEventListener("keydown", event => {
        if (event.altKey || event.ctrlKey || event.metaKey) {
          return;
        }
        const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
        if (step) {
          const by = (event.shiftKey ? 64 : 16) * step * widening();
          const now = container.getBoundingClientRect().width;
          container.style.width = `${this._snapWidth(now + by, by > 0)}px`;
          keep();
        } else if (event.key === "Home" || event.key === "End") {
          // The stylesheet's bounds clamp a width past them to the bound.
          container.style.width =
            event.key === "Home" ? "0px" : `${window.innerWidth}px`;
          keep();
        } else if (event.key === "Enter") {
          this._setPanelWidth(null);
          sayWidth();
        } else {
          return;
        }
        event.preventDefault();
      });
      return edge;
    },

    /**
     * The width the panel takes for `width`. With the toolbar in the panel,
     * no width stands between the panel's narrowest, where it is one column,
     * and the narrowest its toolbar's rows hold, as the toolbar measured it:
     * the whole panel turns to the column at once. A width between snaps to the
     * column as the panel narrows and to the rows as it widens, or, with no
     * way given, to the nearer of the two.
     *
     * @param {number} width CSS pixels.
     * @param {boolean|null} growing
     * @returns {number}
     */
    _snapWidth(width, growing) {
      const column = parseFloat(
        window.getComputedStyle(this._els.container).minWidth
      );
      const rows = SvalPanelToolbar.rowsMinWidth(window);
      if (
        width <= column ||
        width >= rows ||
        !Services.prefs.getBoolPref(IN_PANEL_PREF, false)
      ) {
        return width;
      }
      const wider = growing ?? width - column > rows - width;
      return wider ? rows : column;
    },

    /**
     * Records the panel's width, or null for the default, and draws it in
     * every window on these settings.
     *
     * @param {number|null} width CSS pixels.
     */
    _setPanelWidth(width) {
      this._settings.panelWidth = width;
      for (const win of this._modules.BrowserWindowTracker.orderedWindows) {
        const panel = win.SvalPanel;
        if (panel?._els && panel._settings === this._settings) {
          panel._applyPanelWidth();
        }
      }
      this._applyPanelWidth();
      this._settings.saveSoon();
    },

    /** Draws the panel at this device's width, or the stylesheet's default. */
    _applyPanelWidth() {
      const container = this._els?.container;
      if (!container) {
        return;
      }
      const width = this._settings.panelWidth;
      if (width) {
        container.style.width = `${this._snapWidth(width, null)}px`;
      } else {
        container.style.removeProperty("width");
      }
    },

    /**
     * Puts the panel on `side` in every normal window, which share this
     * profile's settings, and records it. A private window keeps the side it
     * opened with.
     *
     * @param {string} side `left` or `right`.
     */
    async placePanel(side) {
      this._settings.placement = side;
      for (const win of this._modules.BrowserWindowTracker.orderedWindows) {
        const panel = win.SvalPanel;
        if (panel?._els && panel._settings === this._settings) {
          panel._applyPlacement();
        }
      }
      this._applyPlacement();
      this._settings.saveSoon();
    },
  });
}
