/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The hidden Workspace panel sliding in over the page while the pointer rests
 * at the window's edge on the panel's side, and back out once the pointer
 * has left it.
 *
 * The panel hidden with its toggle stays lifted out of the layout and slid
 * out (`slide`, `SvalHeader`). Sliding in over the page is that same box
 * with its slide undone, marked `sval-reveal` (`sval-header.css`, panel
 * reveal): the page keeps its width and place, and the panel's toggle still
 * reads as off, so the toggle and its key show the panel for good from a
 * reveal as from hidden.
 *
 * The page fills its own process, so chrome hears the pointer at the edge
 * through a strip of its own along that edge, as `FullScreen` hears it at the
 * top through `#fullscr-toggler`. The strip covers the gap the page's frame
 * leaves (`sval-header.css`, page frame), and a full-screen window's first
 * column of the page. Once the panel is in, `MousePosTracker` follows the
 * pointer over chrome and page alike, as it does for `FullScreen`'s toolbar.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NODE_DRAG_TYPE: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
});

/** Whether the hidden panel slides in at the window's edge. */
export const REVEAL_PREF = "browser.sval.panel.revealAtEdge";

/**
 * How long the pointer rests at the edge before the panel slides in: long
 * enough that a pointer on its way out of the window crosses the strip
 * without showing it.
 */
export const REVEAL_DELAY_MS = 200;

/**
 * How far the pointer may stray past the panel, and for how long it stays
 * out, before the panel slides away: room for an overshoot past the panel's
 * edge, and for one that comes straight back.
 */
export const HIDE_MARGIN_PX = 24;
export const HIDE_DELAY_MS = 300;

/** The strip along the window's edge. */
export const EDGE_ID = "sval-panel-edge";

const HTML_NS = "http://www.w3.org/1999/xhtml";

/** @type {WeakMap<Window, Reveal>} */
const reveals = new WeakMap();

export const SvalPanelReveal = {
  /**
   * Gives a window with the Workspace panel its strip.
   *
   * @param {Window} win A browser window whose `#sval-panel-container` exists.
   */
  mount(win) {
    const container = win.document.getElementById("sval-panel-container");
    if (container && !reveals.has(win)) {
      reveals.set(win, new Reveal(win, container));
    }
  },

  /**
   * Slides the panel away at once if it is in over the page: a tab picked
   * there is what the person came for.
   *
   * @param {Window} win
   */
  dismiss(win) {
    reveals.get(win)?.hide();
  },

  /**
   * Slides the hidden panel in as the edge does, whether or not the edge is
   * turned on: the toolbar in the panel (`SvalPanelToolbar`) has a prompt or
   * a device in use to show there. It slides away as from the edge.
   *
   * @param {Window} win
   * @param {object} options
   * @param {boolean} options.instant Whether it is in at once, for a popup
   *   about to open from a button in it.
   */
  show(win, { instant }) {
    reveals.get(win)?.reveal({ force: true, instant });
  },
};

/** One window's strip, and its panel while slid in. */
class Reveal {
  /**
   * @param {Window} win
   * @param {Element} container `#sval-panel-container`.
   */
  constructor(win, container) {
    this.win = win;
    this.doc = win.document;
    this.container = container;
    this.revealTimer = null;
    this.hideTimer = null;
    /** Whether the pointer is over the panel, or within the margin. */
    this.inside = false;
    /** Popups opened while the panel was in, which hold it there. */
    this.popups = new Set();
    /**
     * Whether the pointer at the edge slides the panel in. A panel that has
     * just gone leaves the strip under a pointer that never moved, so the
     * pointer first moves somewhere else.
     */
    this.armed = true;

    const edge = this.doc.createElementNS(HTML_NS, "div");
    edge.id = EDGE_ID;
    // A target for the pointer alone: the panel's toggle and its key are
    // how a keyboard or a screen reader shows the panel.
    edge.setAttribute("aria-hidden", "true");
    this.edge = edge;
    this.doc.getElementById("browser").append(edge);

    for (const type of ["mouseenter", "dragenter"]) {
      edge.addEventListener(type, this);
    }
    for (const type of ["mouseleave", "dragleave"]) {
      edge.addEventListener(type, this);
    }

    this.tracker = {
      getMouseTargetRect: () => this.area(),
      onMouseEnter: () => {
        this.inside = true;
        this.win.clearTimeout(this.hideTimer);
        this.hideTimer = null;
      },
      onMouseLeave: () => {
        this.inside = false;
        this.hideSoon();
      },
    };

    this.followPref = () => {
      edge.hidden = !Services.prefs.getBoolPref(REVEAL_PREF, true);
      if (edge.hidden) {
        this.hide();
      }
    };
    this.followPref();
    Services.prefs.addObserver(REVEAL_PREF, this.followPref);

    const observer = new win.MutationObserver(() => this.onToggled());
    observer.observe(container, { attributeFilter: ["sval-collapsed"] });
    this.collapsed = container.hasAttribute("sval-collapsed");

    win.addEventListener(
      "unload",
      () => {
        observer.disconnect();
        Services.prefs.removeObserver(REVEAL_PREF, this.followPref);
        this.stopFollowing();
      },
      { once: true }
    );
  }

  get revealed() {
    return this.container.getAttribute("sval-reveal") === "shown";
  }

  handleEvent(event) {
    switch (event.type) {
      case "mouseenter":
        this.revealSoon();
        break;
      case "dragenter":
        // Only a drag the panel's tree takes, a row from a panel, shows it
        // as a place to drop.
        if (event.dataTransfer?.types.includes(lazy.NODE_DRAG_TYPE)) {
          this.revealSoon();
        }
        break;
      case "mouseleave":
        // macOS keeps a window's outermost pixels for resizing it, so a
        // pointer pushed on into the screen's edge leaves the window's
        // content from the strip, to nothing. It is still at the edge, and a
        // move back into the window ends the wait.
        if (event.relatedTarget === null && this.againstScreenEdge()) {
          break;
        }
      // Falls through: anywhere else, the pointer has left the edge.
      case "dragleave":
        this.win.clearTimeout(this.revealTimer);
        this.revealTimer = null;
        this.armed = true;
        break;
      case "mousemove":
        // The pointer has moved somewhere other than the strip: back into
        // the window after leaving it at the screen's edge, or anywhere
        // after the panel has gone.
        if (event.target !== this.edge) {
          this.armed = true;
          this.win.clearTimeout(this.revealTimer);
          this.revealTimer = null;
          this.win.removeEventListener("mousemove", this, true);
        }
        break;
      case "popupshown":
        if (this.holdsPanel(event.originalTarget)) {
          this.popups.add(event.originalTarget);
        }
        break;
      case "popuphidden":
        if (this.popups.delete(event.originalTarget)) {
          this.hideSoon();
        }
        break;
      case "dragend":
        this.hideSoon();
        break;
    }
  }

  revealSoon() {
    if (!this.armed || this.revealed || this.revealTimer !== null) {
      return;
    }
    this.revealTimer = this.win.setTimeout(() => {
      this.revealTimer = null;
      this.win.removeEventListener("mousemove", this, true);
      this.reveal();
    }, REVEAL_DELAY_MS);
    this.win.addEventListener("mousemove", this, true);
  }

  /**
   * Whether the window's edge on the panel's side is the screen's, so a
   * pointer that leaves the window there can go no further. The window's
   * frame counts: Windows puts a window's resize border outside its
   * content, where the content hears the pointer leave as macOS's own
   * margin makes it.
   *
   * @returns {boolean}
   */
  againstScreenEdge() {
    const { innerWidth, mozInnerScreenX, outerWidth, screen, screenX } =
      this.win;
    const strip = this.edge.getBoundingClientRect();
    return strip.left < innerWidth / 2
      ? Math.min(screenX, mozInnerScreenX) <= screen.left + 1
      : Math.max(screenX + outerWidth, mozInnerScreenX + innerWidth) >=
          screen.left + screen.width - 1;
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.force] Whether it slides in with the edge
   *   turned off.
   * @param {boolean} [options.instant] Whether it skips the slide.
   */
  reveal({ force = false, instant = false } = {}) {
    // The strip shows only while the panel is hidden and the pref is on
    // (`sval-header.css`, panel reveal), which a pointer resting on it
    // outlasts.
    if (
      !this.collapsed ||
      (this.edge.hidden && !force) ||
      this.container.hidden ||
      this.revealed
    ) {
      return;
    }
    this.measureCut();
    if (instant) {
      // A popup opening from a button in the panel is placed once, where
      // the button is drawn as it opens.
      const panels = this.doc.getElementById("tabbrowser-tabpanels");
      for (const el of [this.container, panels]) {
        el.style.transition = "none";
      }
      this.container.setAttribute("sval-reveal", "shown");
      this.container.getBoundingClientRect();
      for (const el of [this.container, panels]) {
        el.style.removeProperty("transition");
      }
    } else {
      this.container.setAttribute("sval-reveal", "shown");
    }
    this.doc.addEventListener("popupshown", this);
    this.doc.addEventListener("popuphidden", this);
    this.doc.addEventListener("dragend", this);
    // Called at once with the pointer's last place, which is on the strip.
    this.win.MousePosTracker.addListener(this.tracker);
  }

  /**
   * Writes the cut a see-through window makes in the page under the slid-in
   * panel (`sval-header.css`, panel reveal): the panel's width inside its
   * gutter, and how far the tab panels start from the window's edge on the
   * panel's side. The slid-out box is measured by its width alone, which
   * its slide leaves alone.
   */
  measureCut() {
    const browser = this.doc.getElementById("browser");
    const panels = this.doc.getElementById("tabbrowser-tabpanels");
    const outer = browser.getBoundingClientRect();
    const inner = panels.getBoundingClientRect();
    const atStart =
      (this.container.getAttribute("sval-placement") === "right") ===
      (this.win.getComputedStyle(browser).direction === "rtl");
    const inset = atStart ? inner.left - outer.left : outer.right - inner.right;
    browser.style.setProperty(
      "--sval-reveal-reach",
      `${this.container.clientWidth}px`
    );
    browser.style.setProperty("--sval-reveal-inset", `${Math.max(0, inset)}px`);
  }

  /** Slides the panel back out, if it is in. */
  hide() {
    if (!this.revealed) {
      return;
    }
    this.stopFollowing();
    // Focus left in a panel that slides out would be out of sight.
    if (this.container.contains(this.doc.activeElement)) {
      this.win.gBrowser.selectedBrowser.focus();
    }
    this.container.setAttribute("sval-reveal", "hidden");
    this.disarm();
  }

  /** Waits for the pointer to move off the strip before it reveals again. */
  disarm() {
    this.armed = false;
    this.win.addEventListener("mousemove", this, true);
  }

  stopFollowing() {
    this.win.clearTimeout(this.revealTimer);
    this.win.clearTimeout(this.hideTimer);
    this.revealTimer = this.hideTimer = null;
    this.win.MousePosTracker?.removeListener(this.tracker);
    this.inside = false;
    this.popups.clear();
    this.doc.removeEventListener("popupshown", this);
    this.doc.removeEventListener("popuphidden", this);
    this.doc.removeEventListener("dragend", this);
    this.win.removeEventListener("mousemove", this, true);
  }

  /**
   * The toggle or its key showed or hid the panel. Shown from a reveal, it
   * stays where it is and the page moves aside (`slide`).
   */
  onToggled() {
    const collapsed = this.container.hasAttribute("sval-collapsed");
    if (collapsed === this.collapsed) {
      return;
    }
    this.collapsed = collapsed;
    if (collapsed) {
      this.disarm();
    } else {
      this.stopFollowing();
      this.container.removeAttribute("sval-reveal");
    }
  }

  /**
   * Starts the wait before the panel slides away, once the pointer is out
   * of it. Whatever holds the panel is asked when the wait ends, and asked
   * again a wait later for as long as it holds: a drag's `dragend` goes to
   * the row it began on, which a redraw can take out of the document.
   */
  hideSoon() {
    if (!this.revealed || this.inside || this.hideTimer !== null) {
      return;
    }
    this.hideTimer = this.win.setTimeout(() => {
      this.hideTimer = null;
      if (this.inside) {
        return;
      }
      if (this.held()) {
        this.hideSoon();
      } else {
        this.hide();
      }
    }, HIDE_DELAY_MS);
  }

  /**
   * Whether the panel's own work keeps it in: a menu or popup opened from
   * it, a dialog such as a rename's (`openSvalDialog`, which opens in
   * `gDialogBox`), or a row being dragged.
   *
   * @returns {boolean}
   */
  held() {
    if (this.popups.size || this.win.gDialogBox?.isOpen) {
      return true;
    }
    const drag = Cc["@mozilla.org/widget/dragservice;1"]
      .getService(Ci.nsIDragService)
      .getCurrentSession(this.win);
    return !!drag?.sourceNode && this.container.contains(drag.sourceNode);
  }

  /**
   * Whether a popup shown while the panel is in holds it there. Tooltips come
   * and go under a passing pointer, as `FullScreen._setPopupOpen` finds.
   *
   * @param {Element} popup
   * @returns {boolean}
   */
  holdsPanel(popup) {
    return popup.localName !== "tooltip";
  }

  /**
   * Where the pointer keeps the panel in: the panel where it stands slid in,
   * with the margin around it. Measured each time, because a slide moves the
   * box's drawn place and the window can change size.
   *
   * @returns {{left: number, right: number, top: number, bottom: number}}
   */
  area() {
    const browser = this.doc.getElementById("browser").getBoundingClientRect();
    const own = this.container.getBoundingClientRect();
    const atStart = own.left + own.width / 2 < browser.left + browser.width / 2;
    const left = atStart ? browser.left : browser.right - own.width;
    return {
      left: left - HIDE_MARGIN_PX,
      right: left + own.width + HIDE_MARGIN_PX,
      top: browser.top - HIDE_MARGIN_PX,
      bottom: browser.bottom + HIDE_MARGIN_PX,
    };
  }
}
