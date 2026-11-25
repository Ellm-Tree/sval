/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The toolbar in the Workspace panel: a second layout for the window, where
 * every control in the header moves into the panel's top and the page runs
 * from the window's top to its bottom
 * (`docs/superpowers/specs/2026-11-22-panel-toolbar-widths-design.md`).
 *
 * The header's widgets move by placement between `#nav-bar` and the
 * toolbar's sets, toolbar areas of Sval's own that each draw one pill
 * (`SvalHeader.arrange`, {@link SET_AREAS}), as Firefox's tab strip moves to
 * `#vertical-tabs`. The records' set joins Favorites in the panel's footer.
 * This module hosts every set in every window, before `CustomizableUI`
 * builds the window's toolbars, so the placements always have somewhere to
 * stand: at the panel's top and in its footer in a window with the panel,
 * and in the header row in a Peek or a page's popup, which have none. Each
 * widget keeps its node, its commands and the popup it opens, which drops
 * from it with the stem as in the header (`SvalStem`).
 *
 * The sets stand in one box in a fixed order, with a break between each two.
 * `SvalToolbarLayout` decides from the panel's width which breaks end a row
 * and how each set is drawn; the sets themselves never move, so no widget
 * is taken out of the document as the panel is dragged.
 *
 * A click on the address floats the Launcher over the page (`SvalLauncher`),
 * because the address bar's own results can't open usefully out of a
 * panel this narrow.
 *
 * While the panel is hidden, three things reach the page: a chip in its top
 * corner while a camera, microphone or screen is in use, a loading
 * line along its top edge, and a site's prompt, which slides the panel in
 * and holds it there until it is answered (`SvalPanelReveal.show`).
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { CustomizableUI } from "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs";
import { BUTTON_ID as PROTECTION_BUTTON_ID } from "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs";
import {
  IN_PANEL_PREF,
  PANEL_BUTTON_ID,
  PANEL_TOOLBAR_ID,
  RECORDS_AREA,
  SET_AREAS,
  SET_OVERFLOW,
} from "moz-src:///browser/components/sval/SvalHeader.sys.mjs";
import {
  COLUMN_MAX_W,
  ROWS_MIN_W,
  SETS,
  layout,
  rowsMinWidth,
} from "moz-src:///browser/components/sval/SvalToolbarLayout.sys.mjs";
import { SvalScope } from "moz-src:///browser/components/sval/SvalScope.sys.mjs";
import { FLIP_ID } from "moz-src:///browser/components/sval/SvalSearchFlip.sys.mjs";

export { IN_PANEL_PREF };

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FLOATING: "moz-src:///browser/components/sval/SvalLauncher.sys.mjs",
  KIND_NAMES: "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs",
  LIVE_ID: "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs",
  SITE_MENU_BUTTON_ID:
    "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs",
  SvalLauncher: "moz-src:///browser/components/sval/SvalLauncher.sys.mjs",
  SvalLoadLine: "moz-src:///browser/components/sval/SvalLoadLine.sys.mjs",
  SvalPanelReveal: "moz-src:///browser/components/sval/SvalPanelReveal.sys.mjs",
});

/** On the root while the toolbar is in the panel. */
export const IN_PANEL_ATTR = "sval-toolbar-in-panel";

const TOOLBAR_CSS = "chrome://browser/content/sval/sval-panel-toolbar.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const CHIP_ID = "sval-live-chip";
const CORNER_ID = "sval-panel-corner";
const CORNER_BUTTON_ID = "sval-panel-corner-button";
const PAGE_LINE_ID = "sval-page-load-line";
/** The row holding the sets in a window with no panel. */
const HEADER_HOST_ID = "sval-toolbar-host";

/** The sets at the panel's top, in the order they stand. */
const TOP_SETS = [
  SETS.WINDOW,
  SETS.NAV,
  SETS.BADGE,
  SETS.SHIELD,
  SETS.ADDRESS,
  SETS.SITE,
  SETS.PAGE,
  SETS.OVERFLOW,
  SETS.TOOLS,
];

/**
 * A set's pill in a row: a 1px border and 3px padding at each end around
 * its 28px circles (`sval-panel-toolbar.css`).
 */
const PILL_FRAME = 8;
const CIRCLE = 28;
/**
 * The window's set in a row: 8px before its buttons and 12px after them,
 * then the toggle's pill; wrapped, the toggle stands under the buttons, both
 * 8px in (`sval-panel-toolbar.css`).
 */
const WINDOW_START = 8;
const BUTTONS_GAP = 12;

/** The toolbar's », and the list in its panel the sets fold items into. */
export const OVERFLOW_BUTTON_ID = "sval-panel-overflow-button";
export const OVERFLOW_LIST_ID = "sval-panel-overflow-list";
/** The panel » opens: Firefox's own overflow panel. */
const OVERFLOW_PANEL_ID = "widget-overflow";

/** Each set's name for assistive technology. */
const SET_LABELS = {
  [SETS.WINDOW]: "Window",
  [SETS.NAV]: "Navigation",
  [SETS.BADGE]: "Private window",
  [SETS.SHIELD]: "Privacy and Security",
  [SETS.ADDRESS]: "Address",
  [SETS.SITE]: "Site controls",
  [SETS.PAGE]: "Page",
  [SETS.OVERFLOW]: "More tools",
  [SETS.TOOLS]: "Extensions",
  records: "Downloads and history",
};

/**
 * The longest the Launcher waits for the field to break out of its row: a
 * breakout takes a frame after layout (`UrlbarInput`).
 */
const BREAKOUT_WAIT_MS = 250;

/** A Peek's own parts of its header, beside the address's row (`SvalPeek`). */
const PEEK_PARTS = { before: "sval-peek-tag", after: "sval-peek-open" };

/** @type {WeakMap<Window, Placement>} */
const placements = new WeakMap();

export const SvalPanelToolbar = {
  /**
   * `browser-window-before-initial-xul-layout`: the layout's stylesheet, and
   * the sets, hosted before `CustomizableUI.handleNewBrowserWindow`
   * registers the window's toolbars, so a window opened with the setting on
   * builds its widgets in them from the start.
   *
   * @param {Window} win A browser window, a Peek or a popup included.
   */
  mount(win) {
    const doc = win.document;
    const navBar = doc.getElementById("nav-bar");
    if (!navBar || placements.has(win)) {
      return;
    }
    win.windowUtils.loadSheetUsingURIString(
      TOOLBAR_CSS,
      win.windowUtils.AUTHOR_SHEET
    );
    const placement = new Placement(win, navBar);
    placements.set(win, placement);
    placement.follow();
  },

  /**
   * Once the panel has drawn its footer: the parts that reach the page while
   * the panel is hidden start.
   *
   * @param {Window} win
   */
  startWindow(win) {
    placements.get(win)?.start();
  },

  /**
   * The layout `win`'s toolbar last drew, or null while it draws none.
   *
   * @param {Window} win
   * @returns {object|null} `SvalToolbarLayout.layout`'s result.
   */
  drawnLayout(win) {
    return placements.get(win)?.drawn ?? null;
  },

  /**
   * `SvalPanel._snapWidth`: the narrowest panel `win`'s toolbar rows hold, as
   * last measured.
   *
   * @param {Window} win
   * @returns {number}
   */
  rowsMinWidth(win) {
    return placements.get(win)?.rowsMin ?? ROWS_MIN_W;
  },

  /**
   * `SvalPanel._build`: the records' area, for the footer's Favorites row.
   *
   * @param {Document} doc
   * @returns {Element|null}
   */
  recordsArea(doc) {
    return doc.getElementById(RECORDS_AREA);
  },

  /**
   * `SvalSiteControls.promptAnchor`: a site's prompt is about to open from
   * a site control. With the toolbar in a hidden panel, the panel slides in
   * at once, so the prompt has its button to drop from, and stays until the
   * prompt closes.
   *
   * @param {Window} win
   */
  beforePrompt(win) {
    const placement = placements.get(win);
    if (placement?.inPanel && placement.container) {
      lazy.SvalPanelReveal.show(win, { instant: true });
    }
  },

  /**
   * `SvalLauncher`: the address field is about to float. The field floats
   * only once it has broken out of its row, which it does not while the
   * panel holding it moves or is hidden ({@link Placement#holdField}).
   *
   * @param {Window} win
   * @returns {Promise<void>|null} Settles once the field can float, or
   *   null when it already can.
   */
  whenFloatable(win) {
    return placements.get(win)?.whenFloatable() ?? null;
  },
};

/** One window's hosts for the toolbar's areas, and what follows them. */
class Placement {
  /**
   * @param {Window} win
   * @param {Element} navBar `#nav-bar`, whose window buttons the panel's
   *   area takes a copy of, as Firefox gives each of its titlebars one
   *   (`titlebar-items.inc.xhtml`).
   */
  constructor(win, navBar) {
    this.win = win;
    this.doc = win.document;
    this.navBar = navBar;
    // A Peek and a page's popup have no panel to hold the toolbar. A
    // popup's flags are read from the window itself: `chromehidden` is
    // written from them after this runs (`AppWindow::ApplyChromeFlags`).
    const container = this.doc.getElementById("sval-panel-container");
    this.container = container && win.toolbar.visible ? container : null;
    this.inPanel = false;
    this.started = false;
    this.lifetime = SvalScope.forWindow(win);
    this.layout = new win.ResizeObserver(() => this.fit());
    /** Whether a fit is due in a task of its own. */
    this.fitting = false;
    /**
     * Each widget's width as last drawn in its set, which stands for it
     * while it is overflowed out of the set.
     *
     * @type {Map<string, number>}
     */
    this.itemWidths = new Map();
    /**
     * Each of the panel's labelled buttons' widths with its label whole,
     * by its class, which outlives the button as the panel draws anew
     * (`labelledRowsWidth`).
     *
     * @type {Map<string, number>}
     */
    this.labelWidths = new Map();
    /** The last layout drawn, for tests to compare with what shows. */
    this.drawn = null;
    // An item folding into » or out of it shows or hides », which takes a
    // place in the rows.
    const refit = node => {
      if (node.ownerDocument === this.doc && this.inPanel && this.container) {
        this.fit();
      }
    };
    const listener = { onWidgetOverflow: refit, onWidgetUnderflow: refit };
    CustomizableUI.addListener(listener);
    this.lifetime.add(() => CustomizableUI.removeListener(listener));
    /** Whether the address field is held in its row. */
    this.fieldHeld = false;
    /** Whether the Launcher is floating the field, or about to. */
    this.floating = false;
    this.buildAreas();
  }

  /**
   * Makes one toolbar area for each set and hosts them: in the panel's top
   * box in their order, with a break between each two, and the records'
   * set beside it until the panel's build takes it to the footer; or side
   * by side in the header row, after `#nav-bar`.
   */
  buildAreas() {
    const doc = this.doc;
    const toolbar = doc.createXULElement("vbox");
    toolbar.id = PANEL_TOOLBAR_ID;
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", "Toolbar");
    /** @type {{[set: string]: Element}} */
    this.sets = {};
    /** The break after each top set but the last, by the set's name. */
    this.breaks = {};
    // Firefox's list belongs to `#nav-bar` (`overflowfortoolbar`), so the
    // sets fold into one of their own in the same panel, which every set's
    // toolbar finds as it is built.
    const list = doc.createXULElement("vbox");
    list.id = OVERFLOW_LIST_ID;
    list.className = "widget-overflow-list";
    doc.getElementById("widget-overflow-list")?.after(list);
    for (const set of TOP_SETS) {
      let area;
      if (set === SETS.OVERFLOW) {
        area = this.makeOverflow();
      } else if (set === SETS.SHIELD) {
        area = this.makeSlot(set);
      } else {
        area = this.makeSet(set);
      }
      if (set === SETS.WINDOW) {
        // As Firefox gives each of its titlebars a copy
        // (`titlebar-items.inc.xhtml`).
        const buttons = this.navBar.querySelector(
          ":scope > .titlebar-buttonbox-container"
        );
        if (buttons) {
          area.prepend(buttons.cloneNode(true));
        }
      }
      toolbar.append(area);
      if (set !== TOP_SETS.at(-1)) {
        const el = doc.createElementNS(HTML_NS, "div");
        el.className = "sval-set-break";
        el.setAttribute("aria-hidden", "true");
        toolbar.append(el);
        this.breaks[set] = el;
      }
    }
    this.toolbar = toolbar;
    this.records = this.makeSet("records");

    if (this.container) {
      this.container.prepend(toolbar, this.records);
    } else {
      const host = doc.createXULElement("hbox");
      host.id = HEADER_HOST_ID;
      host.append(toolbar, this.records);
      this.navBar.after(host);
    }
  }

  /**
   * One set's toolbar area, which draws its pill and holds its widgets in
   * its own customization target.
   *
   * @param {string} set A name from {@link SETS}, or "records".
   * @returns {Element}
   */
  makeSet(set) {
    const doc = this.doc;
    const area = doc.createXULElement("toolbar");
    area.id = SET_AREAS[set];
    area.className = "browser-toolbar sval-set";
    area.dataset.set = set;
    area.setAttribute("customizable", "true");
    area.setAttribute("customizationtarget", `${area.id}-target`);
    area.setAttribute("mode", "icons");
    area.setAttribute("context", "toolbar-context-menu");
    area.setAttribute("aria-label", SET_LABELS[set]);
    // Firefox answers many of the widgets' clicks and keys from the
    // toolbox, which the sets stand outside (`panel-toolbar-events.patch`).
    area.setAttribute("sval-toolbox-events", "");
    area.append(doc.createXULElement("toolbartabstop"));
    const target = doc.createXULElement("hbox");
    target.id = `${area.id}-target`;
    target.className = "sval-set-target";
    area.append(target);
    const overflow = SET_OVERFLOW[set];
    if (overflow) {
      // `OverflowableToolbar` reads these as `CustomizableUI` builds the set.
      area.setAttribute("overfloworder", overflow.leave.join(" "));
      if (overflow.hides) {
        const hidden = doc.createXULElement("vbox");
        hidden.id = `${area.id}-hidden`;
        hidden.hidden = true;
        area.append(hidden);
        area.setAttribute("overflowhides", "true");
        area.setAttribute("default-overflowtarget", hidden.id);
        area.setAttribute("default-overflowbutton", lazy.SITE_MENU_BUTTON_ID);
      } else {
        area.setAttribute("default-overflowtarget", OVERFLOW_LIST_ID);
        area.setAttribute("default-overflowbutton", OVERFLOW_BUTTON_ID);
        area.setAttribute("default-overflowpanel", OVERFLOW_PANEL_ID);
      }
      // Every overflowable toolbar names the extensions' list
      // (`OverflowableToolbar.#webExtList`), whether or not it holds one.
      area.setAttribute(
        "addon-webext-overflowbutton",
        "unified-extensions-button"
      );
      area.setAttribute(
        "addon-webext-overflowtarget",
        "overflowed-extensions-list"
      );
    }
    this.sets[set] = area;
    // Out of the toolbox, which Firefox's keyboard navigation of its own
    // toolbars covers (`ToolbarKeyboardNavigator`).
    this.win.ToolbarKeyboardNavigator.addToolbar(area);
    return area;
  }

  /**
   * The toolbar's », in a pill of its own that shows while the sets have
   * folded anything into its list. It is no area of `CustomizableUI`'s: the
   * first set's `OverflowableToolbar` to start answers it.
   *
   * @returns {Element}
   */
  makeOverflow() {
    const doc = this.doc;
    const slot = this.makeSlot(SETS.OVERFLOW);
    const button = doc.createXULElement("toolbarbutton");
    button.id = OVERFLOW_BUTTON_ID;
    button.className = "toolbarbutton-1 chromeclass-toolbar-additional";
    button.setAttribute("label", "More tools");
    button.setAttribute("tooltiptext", "More tools");
    slot.append(button);
    return slot;
  }

  /**
   * A pill the toolbar draws for something outside `CustomizableUI`'s areas:
   * » or, in the column, Privacy and Security on its own (spec §4).
   *
   * @param {string} set
   * @returns {Element}
   */
  makeSlot(set) {
    const slot = this.doc.createXULElement("toolbar");
    slot.className = "browser-toolbar sval-set";
    slot.dataset.set = set;
    slot.setAttribute("mode", "icons");
    slot.setAttribute("aria-label", SET_LABELS[set]);
    slot.append(this.doc.createXULElement("toolbartabstop"));
    this.sets[set] = slot;
    this.win.ToolbarKeyboardNavigator.addToolbar(slot);
    return slot;
  }

  /**
   * Stands Privacy and Security in a circle of its own above the address
   * while the panel is the column, and back at the address's start in rows.
   * Its button keeps its listeners and its prompts' anchor as it moves.
   *
   * @param {boolean} apart
   */
  placeShield(apart) {
    const slot = this.sets[SETS.SHIELD];
    const button = this.doc.getElementById(PROTECTION_BUTTON_ID);
    if (!button || (button.parentNode === slot) === apart) {
      return;
    }
    if (apart) {
      this.shieldHome = { parent: button.parentNode, next: button.nextSibling };
      slot.append(button);
    } else if (this.shieldHome) {
      this.shieldHome.parent.insertBefore(button, this.shieldHome.next);
    }
  }

  /** Whether the sets have folded anything into »'s list. */
  get folded() {
    return !!this.doc.getElementById(OVERFLOW_LIST_ID)?.firstElementChild;
  }

  follow() {
    const apply = () =>
      this.place(Services.prefs.getBoolPref(IN_PANEL_PREF, false));
    this.lifetime.pref(IN_PANEL_PREF, apply);
    apply();
  }

  start() {
    this.started = true;
    if (this.container) {
      this.startHidden();
    }
    this.showRecordsRow();
  }

  /**
   * Follows the setting: the root's mark, which `sval-panel-toolbar.css`
   * lays out by, and in a window with the panel, what the rows and the
   * address need there. `SvalHeader.arrange` moves the widgets.
   *
   * @param {boolean} inPanel
   */
  place(inPanel) {
    if (inPanel === this.inPanel) {
      return;
    }
    this.inPanel = inPanel;
    this.doc.documentElement.toggleAttribute(IN_PANEL_ATTR, inPanel);
    this.placePeekParts();
    if (!this.container) {
      return;
    }
    // The panel's width snaps clear of the widths between its column and
    // its rows while the toolbar is in it (`SvalPanel._snapWidth`).
    if (this.win.SvalPanel?._els) {
      this.win.SvalPanel._applyPanelWidth();
    }
    if (inPanel) {
      this.layout.observe(this.container);
      for (const set of TOP_SETS) {
        this.layout.observe(this.sets[set]);
      }
      this.listenToAddress();
      this.followPanel();
    } else {
      this.layout.disconnect();
      this.addressListener?.abort();
      this.addressListener = null;
      this.panelListener?.abort();
      this.panelListener = null;
      this.holdField(false);
      this.draw(null);
    }
    if (this.started) {
      this.showRecordsRow();
      this.drawHidden();
    }
  }

  /**
   * A Peek's own parts stand either side of the row holding its address,
   * which is `#nav-bar`'s or the address set's.
   */
  placePeekParts() {
    const target = this.inPanel
      ? this.sets[SETS.ADDRESS].querySelector(":scope > .sval-set-target")
      : this.doc.getElementById("nav-bar-customization-target");
    const before = this.doc.getElementById(PEEK_PARTS.before);
    const after = this.doc.getElementById(PEEK_PARTS.after);
    if (target && before) {
      target.before(before);
    }
    if (target && after) {
      target.after(after);
    }
  }

  /**
   * The footer's Favorites row holds the records while the toolbar is in
   * the panel, so it shows in a private window too, which keeps no
   * Favorites.
   */
  showRecordsRow() {
    const panel = this.win.SvalPanel;
    const bar = this.records.parentNode;
    const favorites = bar?.querySelector(":scope > .sval-favorites");
    if (!panel || !favorites) {
      return;
    }
    bar.hidden = panel._inMemory && !this.inPanel;
    favorites.hidden = panel._inMemory;
  }

  /**
   * Follows the panel as it slides, hides and comes back, and the Launcher
   * as it floats the field and lets it go.
   */
  followPanel() {
    this.panelListener = new this.win.AbortController();
    const { signal } = this.panelListener;
    const settle = () => {
      this.settleField();
      this.placeCorner();
    };
    const observer = new this.win.MutationObserver(settle);
    observer.observe(this.container, {
      attributeFilter: ["sval-collapsed", "sval-reveal", "sval-overlay"],
    });
    observer.observe(this.win.gURLBar, { attributeFilter: [lazy.FLOATING] });
    signal.addEventListener("abort", () => observer.disconnect());
    // A panel on the window's right moves with its edge.
    this.win.addEventListener("resize", () => this.placeCorner(), { signal });
    for (const type of ["transitionrun", "transitionend", "transitioncancel"]) {
      this.container.addEventListener(
        type,
        event => {
          if (event.target === this.container) {
            settle();
          }
        },
        { signal }
      );
    }
    settle();
  }

  /**
   * Holds the field in its row or lets it break out, for where the panel
   * is. A field that has broken out of its row is drawn in the top layer
   * (`UrlbarInput.#updateLayoutBreakoutDimensions`), where the panel's slide
   * does not move it, so it is held while the panel moves or is hidden,
   * unless the Launcher floats it over the page.
   */
  settleField() {
    const urlbar = this.win.gURLBar;
    if (urlbar.hasAttribute(lazy.FLOATING)) {
      this.floating = false;
    }
    const hidden =
      this.container.hasAttribute("sval-collapsed") &&
      this.container.getAttribute("sval-reveal") !== "shown";
    const moving = this.container
      .getAnimations()
      .some(animation => animation.transitionProperty === "transform");
    const floats = this.floating || urlbar.hasAttribute(lazy.FLOATING);
    this.holdField(!floats && (hidden || moving));
  }

  /** @param {boolean} held */
  holdField(held) {
    if (held === this.fieldHeld) {
      return;
    }
    this.fieldHeld = held;
    if (held) {
      this.win.gURLBar.incrementBreakoutBlockerCount();
    } else {
      this.win.gURLBar.decrementBreakoutBlockerCount();
    }
  }

  /**
   * Lets the field break out of its row for the Launcher, and settles once
   * it has. Firefox also takes the breakout down for a moment as the window
   * resizes (`UrlbarInput.#updateLayoutBreakoutDimensions`), and holds it
   * down while a modal dialog shows, so the wait is bounded: past it, the
   * Launcher opens as it does wherever the field can't float.
   *
   * @returns {Promise<void>|null}
   */
  whenFloatable() {
    const urlbar = this.win.gURLBar;
    if (!this.inPanel || urlbar.hasAttribute("breakout")) {
      return null;
    }
    this.floating = true;
    this.holdField(false);
    return new Promise(resolve => {
      // The Launcher floats the field, or opens it in place, as soon as
      // this settles, so the field is the panel's to hold again.
      const done = () => {
        observer.disconnect();
        this.win.clearTimeout(timer);
        this.floating = false;
        if (this.container) {
          this.settleField();
        }
        resolve();
      };
      const observer = new this.win.MutationObserver(() => {
        if (urlbar.hasAttribute("breakout")) {
          done();
        }
      });
      observer.observe(urlbar, { attributeFilter: ["breakout"] });
      const timer = this.win.setTimeout(done, BREAKOUT_WAIT_MS);
    });
  }

  /**
   * Lays the sets out for the panel's width. Drawing a layout changes the
   * sets' and the panel's sizes, which the resize observer is delivering, so
   * it waits for a task of its own.
   */
  fit() {
    if (this.fitting) {
      return;
    }
    this.fitting = true;
    Services.tm.dispatchToMainThread(() => {
      this.fitting = false;
      if (!this.win.closed && this.inPanel) {
        const drawn = this.measureLayout();
        this.draw(drawn);
        // A panel the rows no longer fit, past the column's width, snaps
        // to the column or to the rows' new narrowest.
        if (drawn.width > COLUMN_MAX_W && drawn.width < this.rowsMin) {
          this.win.SvalPanel?._applyPanelWidth();
        }
      }
    });
  }

  /**
   * @returns {object} The layout for the panel's width, and that width.
   */
  measureLayout() {
    const natural = {};
    const min = {};
    for (const set of TOP_SETS) {
      const widths = this.measure(set);
      if (widths) {
        natural[set] = widths.natural;
        min[set] = widths.min;
      }
    }
    const width = this.container.getBoundingClientRect().width;
    const records = this.measure("records");
    if (records) {
      natural.records = records.natural;
    }
    this.rowsMin = rowsMinWidth(natural, min);
    // The panel's own labelled rows show their icons alone while the panel
    // is too narrow for their labels (`sval-panel-toolbar.css`).
    this.container.toggleAttribute(
      "sval-short-labels",
      width < this.labelledRowsWidth(width, records?.min ?? 0)
    );
    return {
      ...layout({
        width,
        macos: AppConstants.platform === "macosx",
        natural,
        min,
      }),
      width,
      natural,
    };
  }

  /**
   * The narrowest panel whose own labelled rows show their labels whole:
   * New tab and New group, which share their row equally, and Favorites
   * beside the records at their narrowest. Measured as rows lay them out,
   * which the column does not, and kept for the column.
   *
   * @param {number} width The panel's width.
   * @param {number} recordsMin The records' set at its narrowest.
   * @returns {number}
   */
  labelledRowsWidth(width, recordsMin) {
    // The panel's own 48px layout (`sval-panel.css`) follows its width
    // before the toolbar draws its column.
    if (width <= COLUMN_MAX_W) {
      return this.labelledWidth ?? 0;
    }
    // A button's width with its label's text whole, read while the text
    // fits: a button whose label is cut short can be squeezed past its
    // own padding and icon too.
    const range = this.doc.createRange();
    const whole = button => {
      const label = button.querySelector(":scope > .sval-label");
      range.selectNodeContents(label);
      const text = range.getBoundingClientRect().width;
      if (text <= label.clientWidth + 1) {
        this.labelWidths.set(
          button.className,
          button.getBoundingClientRect().width - label.clientWidth + text
        );
      }
      return this.labelWidths.get(button.className) ?? 0;
    };
    const inner = el => {
      const style = this.win.getComputedStyle(el);
      return (
        el.clientWidth -
        parseFloat(style.paddingInlineStart) -
        parseFloat(style.paddingInlineEnd)
      );
    };
    let need = 0;
    const header = this.container.querySelector(".sval-panel-header");
    const buttons = header?.querySelectorAll(":scope > .sval-newtab") ?? [];
    if (buttons.length) {
      const gap = parseFloat(this.win.getComputedStyle(header).columnGap);
      need =
        width -
        inner(header) +
        buttons.length * Math.max(...Array.from(buttons, whole)) +
        (buttons.length - 1) * gap;
    }
    const bar = this.records.parentElement;
    const favorites = bar?.querySelector(":scope > .sval-favorites");
    if (favorites && !favorites.hidden) {
      need = Math.max(need, width - inner(bar) + whole(favorites) + recordsMin);
    }
    this.labelledWidth = Math.ceil(need);
    return this.labelledWidth;
  }

  /**
   * A set's width with every item it holds, and with only the items that
   * never leave it; null for a set with nothing to show, as the private
   * badge outside a private window.
   *
   * @param {string} set
   * @returns {{natural: number, min: number}|null}
   */
  measure(set) {
    const area = this.sets[set];
    if (set === SETS.SHIELD) {
      // Apart from the address in the column alone, which has no rows.
      return null;
    }
    if (set === SETS.OVERFLOW) {
      return this.folded
        ? { natural: PILL_FRAME + CIRCLE, min: PILL_FRAME + CIRCLE }
        : null;
    }
    if (set === SETS.ADDRESS) {
      // The address takes its row's whole width and gives up nothing; it
      // needs its own narrowest width (`sval-panel-toolbar.css`).
      const least =
        parseFloat(
          this.win
            .getComputedStyle(area)
            .getPropertyValue("--sval-address-min-w")
        ) || 0;
      return { natural: least, min: least };
    }
    const leave = SET_OVERFLOW[set]?.leave ?? [];
    let items = 0;
    let kept = 0;
    let shown = 0;
    for (const id of CustomizableUI.getWidgetIdsInArea(area.id)) {
      const node = this.doc.getElementById(id);
      if (!node || node.hidden || node.getAttribute("collapsed") === "true") {
        continue;
      }
      if (area.contains(node)) {
        const w = this.outerWidth(node);
        if (w) {
          this.itemWidths.set(id, w);
        }
      }
      // An item not yet drawn, in a set the layout has not shown, is one
      // circle until it is.
      const w = this.itemWidths.get(id) ?? CIRCLE;
      items += w;
      shown++;
      if (!leave.includes(id) && !CustomizableUI.isWebExtensionWidget(id)) {
        kept += w;
      }
    }
    // The frames are the stylesheet's for a set in a row, whatever the
    // layout draws now: what the layout reads must not hang on what it
    // drew, or a width at a boundary would flip between two layouts.
    let frame = set === SETS.BADGE ? 0 : PILL_FRAME;
    if (set === SETS.WINDOW) {
      const buttons = area.querySelector(
        ":scope > .titlebar-buttonbox-container"
      );
      // The box with its margins, as a row lays it out, which the column
      // does not. The container is no measure: a wrapped window row
      // stretches it across the row.
      const box = buttons?.querySelector(":scope > .titlebar-buttonbox");
      if (box && !this.toolbar.hasAttribute("sval-column")) {
        this.buttonsWidth = this.outerWidth(box);
      }
      const buttonsWidth = this.buttonsWidth ?? 0;
      const toggle = PILL_FRAME + items;
      return {
        natural: WINDOW_START + buttonsWidth + BUTTONS_GAP + toggle,
        min: WINDOW_START + Math.max(buttonsWidth, toggle),
      };
    } else if (!shown) {
      return null;
    }
    // A set none of whose items stay can give up all of them, and its pill.
    return { natural: items + frame, min: kept ? kept + frame : 0 };
  }

  /**
   * @param {Element} el
   * @returns {number} Its width with its inline margins.
   */
  outerWidth(el) {
    const { marginInlineStart, marginInlineEnd } =
      this.win.getComputedStyle(el);
    return (
      el.getBoundingClientRect().width +
      parseFloat(marginInlineStart) +
      parseFloat(marginInlineEnd)
    );
  }

  /**
   * Draws a layout as attributes `sval-panel-toolbar.css` lays out by, or
   * takes them away for null: the column, the joined pill, the Launcher
   * key, and the breaks that end a row.
   *
   * @param {import("SvalToolbarLayout.sys.mjs").Layout|null} drawn
   */
  draw(drawn) {
    this.drawn = drawn;
    const toolbar = this.toolbar;
    toolbar.toggleAttribute("sval-column", !!drawn?.column);
    // On the panel too, for the footer's records, which stand outside the
    // toolbar's box.
    this.container?.toggleAttribute("sval-column", !!drawn?.column);
    // In the column, a popover from the panel's buttons opens beside them,
    // toward the page (`SvalStem`): below one it would cover the next.
    this.container?.toggleAttribute("sval-stem-beside", !!drawn?.column);
    this.placeShield(!!drawn?.column);
    toolbar.toggleAttribute("sval-joined", !!drawn?.joined);
    toolbar.toggleAttribute("sval-window-wrapped", !!drawn?.windowWrapped);
    toolbar.toggleAttribute("sval-no-key", !!drawn && !drawn.key);
    toolbar.toggleAttribute("sval-folded", !!drawn && this.folded);
    const ends = new Set((drawn?.rows ?? []).map(row => row.at(-1)));
    for (const [set, el] of Object.entries(this.breaks)) {
      el.toggleAttribute("sval-row-end", ends.has(set));
    }
    // A row's sets stand in its order, each followed by its break, wherever
    // they stand in the toolbar's own: Page joins Navigation's row.
    const placed = (drawn?.rows ?? []).flat();
    for (const set of TOP_SETS) {
      const at = placed.indexOf(set);
      for (const el of [this.sets[set], this.breaks[set]]) {
        if (!el) {
          continue;
        }
        if (!drawn || drawn.column) {
          el.style.removeProperty("order");
        } else if (at < 0) {
          // Not in a row: after them all, where it takes no room.
          el.style.order = 2 * TOP_SETS.length;
        } else {
          el.style.order = 2 * at + (el === this.sets[set] ? 0 : 1);
        }
      }
    }
    // The column keeps only what never leaves a set (spec §4). In rows, each
    // set is given the width the layout gives it: `OverflowableToolbar`
    // counts that room, so a set sends items out as its width shrinks and
    // takes them back as it grows.
    // A set with nothing to show takes no room: in rows, one not in this
    // window, as the private badge outside a private window, or one the
    // layout gives no width, which shows again once it gives it some; in the
    // column, one showing nothing, since nothing comes back there.
    for (const set of [...TOP_SETS, "records"]) {
      const area = this.sets[set];
      const target = area.querySelector(":scope > .sval-set-target");
      const showing =
        set === SETS.SHIELD
          ? !!area.querySelector(`#${PROTECTION_BUTTON_ID}`)
          : !target ||
            [...target.children].some(
              node => !node.hidden && node.getAttribute("collapsed") !== "true"
            );
      // A set showing one button is one circle, its pill, which a popover's
      // stem grows from (`SvalStem`).
      const pill = target ?? area;
      const buttons = [...pill.children].filter(
        node =>
          !node.hidden &&
          node.getAttribute("collapsed") !== "true" &&
          node.localName !== "toolbartabstop"
      );
      // The address's pill holds the field, which grows no stem.
      pill.toggleAttribute(
        "sval-stem-face",
        set !== SETS.ADDRESS && buttons.length === 1
      );
      area.toggleAttribute(
        "sval-empty",
        !!drawn &&
          (drawn.column
            ? !showing
            : !(set in drawn.natural) || drawn.widths[set] === 0)
      );
    }
    for (const [set, overflow] of Object.entries(SET_OVERFLOW)) {
      const area = this.sets[set];
      // The overflow code checks the set again on every write.
      const order = ((drawn?.column && overflow.column) || overflow.leave).join(
        " "
      );
      if (area.getAttribute("overfloworder") !== order) {
        area.setAttribute("overfloworder", order);
      }
      // A set the layout gives no width sends all it may to », as the
      // column does.
      area.toggleAttribute(
        "overflowall",
        !!drawn && (drawn.column || drawn.widths[set] === 0)
      );
      // The footer's records have their row to themselves.
      let w = 0;
      if (drawn && !drawn.column) {
        w = set === "records" ? drawn.natural.records : drawn.widths[set];
      }
      if (w) {
        area.style.flexBasis = `${w}px`;
      } else {
        area.style.removeProperty("flex-basis");
      }
      area.toggleAttribute("sval-sized", !!w);
    }
    this.placeCorner();
  }

  /** A click on the address floats the Launcher over the page. */
  listenToAddress() {
    const urlbar = this.win.gURLBar;
    if (!urlbar) {
      return;
    }
    this.addressListener = new this.win.AbortController();
    urlbar.addEventListener(
      "mousedown",
      event => {
        // The shield, the engine's button and the search's switch do their
        // own thing. Anywhere else the field floats, focused or not: its own
        // view never opens in place here.
        if (
          event.button !== 0 ||
          urlbar.hasAttribute(lazy.FLOATING) ||
          event.target.closest?.(
            `#${PROTECTION_BUTTON_ID}, #${FLIP_ID}, .searchmode-switcher`
          )
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const open = () =>
          lazy.SvalLauncher.open(this.win, { floating: true, event });
        const wait = this.whenFloatable();
        if (wait) {
          wait.then(open);
        } else {
          open();
        }
      },
      { capture: true, signal: this.addressListener.signal }
    );
  }

  /**
   * What stands in for the hidden panel: in the page's corner on its side,
   * the window's buttons and the panel's toggle, with the chip after them
   * while a device is in use; and the page's loading line.
   */
  startHidden() {
    const doc = this.doc;
    const browser = doc.getElementById("browser");
    // A toolbar, which gives the toggle Firefox's toolbar button look.
    const corner = doc.createXULElement("toolbar");
    corner.id = CORNER_ID;
    corner.setAttribute("mode", "icons");
    corner.setAttribute("aria-label", "Window");
    const pill = doc.createXULElement("hbox");
    pill.className = "sval-corner-pill";
    // In the pill, whose gap leaves it no room.
    pill.append(doc.createXULElement("toolbartabstop"));
    // The window's buttons stand where their box is shown, as in each of
    // Firefox's titlebars (`titlebar-items.inc.xhtml`).
    const buttons = this.navBar.querySelector(
      ":scope > .titlebar-buttonbox-container"
    );
    if (buttons) {
      pill.append(buttons.cloneNode(true));
    }
    // The panel's toggle while the panel is hidden, so it is named and
    // pressed as that toggle is (`SvalHeader`).
    const toggle = doc.createXULElement("toolbarbutton");
    toggle.id = CORNER_BUTTON_ID;
    toggle.className = "toolbarbutton-1";
    toggle.setAttribute("label", "Workspaces");
    toggle.setAttribute("tooltiptext", "Show Workspace Panel");
    toggle.setAttribute("aria-pressed", "false");
    toggle.addEventListener("command", () =>
      this.win.SvalPanel?.toggleVisible()
    );
    pill.append(toggle);
    const chip = doc.createElementNS(HTML_NS, "button");
    chip.id = CHIP_ID;
    chip.hidden = true;
    chip.addEventListener("click", () => {
      lazy.SvalPanelReveal.show(this.win, { instant: false });
      this.doc
        .querySelector(`#${lazy.LIVE_ID} .sval-live-cell`)
        ?.focus({ focusVisible: true });
    });
    this.chip = chip;
    corner.append(pill, chip);
    const line = lazy.SvalLoadLine.create(doc);
    line.id = PAGE_LINE_ID;
    browser.append(corner, line);
    this.win.ToolbarKeyboardNavigator.addToolbar(corner);
    this.followToggleFocus(toggle);
    this.lifetime.add(
      lazy.SvalLoadLine.follow(
        this.win,
        line,
        () => this.win.gBrowser.selectedTab
      )
    );
    const cells = this.doc.querySelector(`#${lazy.LIVE_ID} .sval-live-cells`);
    if (cells) {
      const observer = new this.win.MutationObserver(() => this.drawHidden());
      observer.observe(cells, {
        attributes: true,
        attributeFilter: ["sval-live"],
        childList: true,
      });
      this.lifetime.add(() => observer.disconnect());
    }
    this.drawHidden();
  }

  /**
   * Keeps the keyboard on the panel's toggle as the panel hides and shows:
   * the toggle that goes away hands focus to the one that takes its place,
   * which stands where it stood.
   *
   * @param {Element} cornerToggle
   */
  followToggleFocus(cornerToggle) {
    const container = this.container;
    let hidden = container.hasAttribute("sval-collapsed");
    const observer = new this.win.MutationObserver(() => {
      const now = container.hasAttribute("sval-collapsed");
      if (now === hidden) {
        return;
      }
      hidden = now;
      const panelToggle = this.doc.getElementById(PANEL_BUTTON_ID);
      const [from, to] = now
        ? [panelToggle, cornerToggle]
        : [cornerToggle, panelToggle];
      if (from && to && this.doc.activeElement === from && this.inPanel) {
        this.win.ToolbarKeyboardNavigator._focusButton(to);
      }
    });
    observer.observe(container, { attributeFilter: ["sval-collapsed"] });
    this.lifetime.add(() => observer.disconnect());
  }

  /**
   * Puts the hidden panel's corner on the panel's own window row, so the
   * toggle, and the window's buttons where they lead the row, keep their
   * place as the panel hides and shows. The hidden panel stays laid out,
   * slid off the window whole (`sval-header.css`, panel slide), so the
   * row's place with the slide taken out is where it stands when shown.
   * Where the window's buttons end the row, the corner keeps them beside
   * the toggle.
   */
  placeCorner() {
    const corner = this.doc.getElementById(CORNER_ID);
    const shownToggle = this.doc.getElementById(PANEL_BUTTON_ID);
    if (!this.container || !shownToggle || !corner?.checkVisibility()) {
      return;
    }
    const iconOf = el =>
      el.querySelector(".toolbarbutton-icon").getBoundingClientRect();
    const buttonsIn = el =>
      el?.querySelector(":scope > .titlebar-buttonbox-container");
    const rtl = this.win.getComputedStyle(this.container).direction === "rtl";
    // How far the window's buttons stand before the toggle on its line, or
    // null where they stand elsewhere or show nothing.
    const lead = (buttons, icon) => {
      const box = buttons?.getBoundingClientRect();
      if (
        !box?.width ||
        Math.abs(box.bottom + box.top - icon.bottom - icon.top) > 1
      ) {
        return null;
      }
      const space = rtl ? box.left - icon.right : icon.left - box.right;
      return space >= 0 ? space : null;
    };
    const shownIcon = iconOf(shownToggle);
    const shownLead = lead(buttonsIn(this.sets[SETS.WINDOW]), shownIcon);
    const cornerToggle = this.doc.getElementById(CORNER_BUTTON_ID);
    const cornerButtons = buttonsIn(corner.querySelector(".sval-corner-pill"));
    const cornerLead = lead(cornerButtons, iconOf(cornerToggle));
    if (shownLead !== null && cornerLead !== null) {
      const gap = parseFloat(
        this.win.getComputedStyle(cornerButtons).marginInlineEnd
      );
      cornerButtons.style.marginInlineEnd = `${gap + shownLead - cornerLead}px`;
    }
    // The slide, part way or whole, set aside.
    const transform = this.win.getComputedStyle(this.container).transform;
    const slide =
      transform === "none" ? 0 : new this.win.DOMMatrix(transform).m41;
    const icon = iconOf(cornerToggle);
    const style = this.win.getComputedStyle(corner);
    corner.style.top = `${parseFloat(style.top) + shownIcon.top - icon.top}px`;
    corner.style.left = `${parseFloat(style.left) + shownIcon.left - slide - icon.left}px`;
  }

  /**
   * Draws the chip for the devices in use, one glyph each, with the same
   * name the cells carry.
   */
  drawHidden() {
    const chip = this.chip;
    if (!chip) {
      return;
    }
    const cells = this.doc.querySelector(`#${lazy.LIVE_ID} .sval-live-cells`);
    const live = this.inPanel && !!cells?.hasAttribute("sval-live");
    chip.hidden = !live;
    if (!live) {
      chip.replaceChildren();
      this.placeCorner();
      return;
    }
    const kinds = [];
    const glyphs = [];
    for (const cell of cells.querySelectorAll(".sval-live-cell")) {
      kinds.push(cell.dataset.kind);
      for (const glyph of cell.children) {
        glyphs.push(glyph.cloneNode(true));
      }
    }
    chip.replaceChildren(...glyphs);
    const names = kinds.map((kind, i) => {
      const name = lazy.KIND_NAMES[kind] ?? kind;
      return i ? name.toLowerCase() : name;
    });
    const list = new Intl.ListFormat("en-US", { type: "conjunction" });
    const label = `${list.format(names)} in use. Click to show the Workspace panel.`;
    chip.setAttribute("aria-label", label);
    chip.title = label;
    // A chip before the toggle, as in a right-to-left window, moves it.
    this.placeCorner();
  }
}
