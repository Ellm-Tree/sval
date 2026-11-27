/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Ctrl+Tab switcher: what Firefox's `ctrlTab` shows while Ctrl is held,
 * drawn by Sval (`ctrl-tab-switcher.patch`). `ctrlTab` keeps the window's
 * tabs in order of use, leaving out the hidden ones, which are other
 * workspaces' (`ctrlTab.attachTab`), and decides what each key does. This
 * draws that list as a carousel of overlapping previews over the page, the
 * selected one in the middle, and hands each key and click back to
 * `ctrlTab`.
 *
 * - **A Split is one card.** Its panes stand side by side in the card, in
 *   the order the window shows them, and the list holds one of its tabs for
 *   it: the pane used last, which picking the card selects.
 * - **The carousel pans.** A wheel or a two-finger swipe slides it either
 *   way, and latches the switcher open: letting Ctrl go then picks
 *   nothing, and Return or a click picks.
 * - **Previews stay in memory.** A loaded tab's is drawn from its page
 *   (`PageThumbs.captureTabPreviewThumbnail`, the capture Firefox's tab hover
 *   preview makes) once its page has loaded, as the user leaves the tab, and
 *   as its card comes near the middle here, so a window of hundreds of tabs
 *   opens at once. The last one drawn is kept, as a JPEG in memory, for as
 *   long as the tab shows the same document, so a tab unloaded since still
 *   shows its page. Nothing is written to disk (`CONTRIBUTING.md` rule 10):
 *   Sval turns thumbnail storage off
 *   (`browser.pagethumbnails.capturing_disabled`), which is where Firefox's
 *   panel finds an unloaded tab's picture. A tab Sval restored and nobody
 *   has opened since (`SvalRestore`) has never been drawn, and shows its
 *   favicon and site instead.
 * - **The carousel is a listbox** whose options are the cards, named by
 *   their titles, with focus on the list and the selection its active
 *   descendant.
 *
 * **No title or address is ever logged** (`CONTRIBUTING.md` rule 10).
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  switcherItemLabel:
    "moz-src:///browser/components/sval/SvalWorkspaceEntries.sys.mjs",
  SvalWindowWorkspace:
    "moz-src:///browser/components/sval/SvalWindowWorkspace.sys.mjs",
  PageThumbs: "resource://gre/modules/PageThumbs.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalTabs: "moz-src:///browser/components/sval/SvalTabs.sys.mjs",
  GROUP: "moz-src:///browser/components/sval/SvalTree.sys.mjs",
  SPLIT: "moz-src:///browser/components/sval/SvalTree.sys.mjs",
  iconURL: "moz-src:///browser/components/sval/SvalIcons.sys.mjs",
  shortcutText: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  switcherItemOf: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  ancestorIds: "moz-src:///browser/components/sval/SvalTree.sys.mjs",
  chipElement: "moz-src:///browser/components/sval/SvalLauncherRows.sys.mjs",
  colorOf: "moz-src:///browser/components/sval/SvalColor.sys.mjs",
  isPin: "moz-src:///browser/components/sval/SvalPinTab.sys.mjs",
  SvalPinPages: "moz-src:///browser/components/sval/SvalPinPages.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
});

const SHEET = "chrome://browser/content/sval/sval-tab-switcher.css";
const HTML_NS = "http://www.w3.org/1999/xhtml";

const ROOT_ID = "sval-tab-switcher";
const LIST_ID = "sval-tab-switcher-list";
/**
 * On the window's root while the switcher shows, for the scrim the page's
 * frames draw (`sval-tab-switcher.css`).
 */
const OPEN_ATTRIBUTE = "sval-tab-switcher-open";

/** How the kept previews are encoded, and at what quality. */
const KEPT_TYPE = "image/jpeg";
const KEPT_QUALITY = 0.85;
/** The longest a tab's drawing waits for the window to be idle. */
const IDLE_DRAW_MS = 2000;

/**
 * A whole card's preview in CSS pixels, 16:10: the size the largest card
 * shows. A Split's pane takes its share of the width.
 */
const PREVIEW_WIDTH = 448;
const PREVIEW_HEIGHT = 280;

/** The least room the card leaves around it over the page. */
const CARD_MARGIN = 24;
const CARD_PADDING = 16;
/** A card's width as a share of the carousel's, and its bounds in pixels. */
const TILE_SHARE = 0.4;
const TILE_MIN = 160;
const TILE_MAX = 560;
/** The carousel's height for a card's, room for the middle card's ring. */
const STAGE_HEIGHT = 1.12;

/** Where the cards beside the middle one stand: see {@link tilePlace}. */
const NEAR = 0.62;
const FAR = 0.17;
const TURN_DEG = 50;
const SHRINK = 0.18;
const SHADE = 0.35;
/** How many cards each side of the middle one are drawn. */
const REACH = 7;

/**
 * How fast the carousel catches up with where it is going: the time it
 * takes to close two-thirds of the distance.
 */
const EASE_MS = 70;
/** A wheel's travel per card, and a line's travel where it scrolls lines. */
const WHEEL_PX_PER_CARD = 90;
const WHEEL_LINE_PX = 30;
/** How long a still wheel waits before the carousel settles on a card. */
const SETTLE_MS = 140;
/** The footer's pictures of the two ways to pan the carousel (`#onWheel`). */
const PAN_ICONS = ["scroll-wheel", "two-finger-swipe"];
/**
 * Each tab's last preview, as an object URL of its window, and the document
 * it was drawn from (its inner window id). An address the page changes for
 * itself (`history.pushState`) keeps the document, and the picture; a new
 * document replaces it.
 *
 * @type {WeakMap<Element, {document: number, url: string}>}
 */
const kept = new WeakMap();

/**
 * The last document each tab was seen to show while loaded, which a tab
 * unloaded since still stands for.
 *
 * @type {WeakMap<Element, number>}
 */
const lastDocument = new WeakMap();

/**
 * The document a loaded tab shows, noted as the one it last showed, or what
 * it last showed while loaded.
 *
 * @param {Element} tab
 * @returns {number|null} an inner window id.
 */
function documentOf(tab) {
  if (isLoaded(tab)) {
    const id =
      tab.linkedBrowser.browsingContext.currentWindowGlobal.innerWindowId;
    lastDocument.set(tab, id);
    return id;
  }
  return lastDocument.get(tab) ?? null;
}

/**
 * Lets a tab's kept preview go.
 *
 * @param {Element} tab
 */
function forget(tab) {
  const entry = kept.get(tab);
  if (entry) {
    kept.delete(tab);
    tab.documentGlobal.URL.revokeObjectURL(entry.url);
  }
}

/**
 * The tabs a card shows: a Split's panes in the order the window shows them
 * (`MozTabSplitViewWrapper.tabs`), or the tab alone.
 *
 * @param {Element} tab
 * @returns {Element[]}
 */
function panesOf(tab) {
  const panes = tab.splitview?.tabs.filter(pane => !pane.closing);
  return panes?.length > 1 ? panes : [tab];
}

/**
 * Draws a loaded tab's page at its pane's size in a card, and keeps a copy
 * for when the tab has unloaded ({@link kept}).
 *
 * @param {Element} tab
 * @returns {Promise<Element|null>} the drawing, or null when the page moved
 *   on or closed meanwhile.
 */
export async function draw(tab) {
  const win = tab.documentGlobal;
  const browser = tab.linkedBrowser;
  const shown = documentOf(tab);
  const canvas = win.document.createElementNS(HTML_NS, "canvas");
  // The capture takes the page's full width at the canvas's shape, so a
  // pane's drawing is as narrow as the pane's share of the card.
  const share = panesOf(tab).length;
  canvas.width = Math.round((PREVIEW_WIDTH / share) * win.devicePixelRatio);
  canvas.height = Math.round(PREVIEW_HEIGHT * win.devicePixelRatio);
  try {
    await lazy.PageThumbs.captureTabPreviewThumbnail(browser, canvas);
  } catch (err) {
    lazy.SvalLog.debug(
      `a switcher preview was not drawn: ${lazy.describeError(err)}`
    );
    return null;
  }
  if (!tab.isConnected || documentOf(tab) !== shown) {
    return null;
  }
  canvas.toBlob(
    blob => {
      if (!blob || !tab.isConnected || documentOf(tab) !== shown) {
        return;
      }
      forget(tab);
      kept.set(tab, { document: shown, url: win.URL.createObjectURL(blob) });
    },
    KEPT_TYPE,
    KEPT_QUALITY
  );
  return canvas;
}

/**
 * Draws `tab` once the window is idle, if it still shows the document it
 * shows now: a load that started, a new document or a close meanwhile draws
 * nothing.
 *
 * @param {Window} win The tab's window.
 * @param {Element} tab
 */
function drawWhenIdle(win, tab) {
  if (!isLoaded(tab)) {
    return;
  }
  const shown = documentOf(tab);
  win.requestIdleCallback(
    () => {
      if (
        isLoaded(tab) &&
        !tab.closing &&
        !tab.hasAttribute("busy") &&
        documentOf(tab) === shown
      ) {
        draw(tab);
      }
    },
    { timeout: IDLE_DRAW_MS }
  );
}

/**
 * The preview kept for the document `tab` shows, or showed last while
 * loaded, or null.
 *
 * @param {Element} tab
 * @returns {string|null} an object URL.
 */
export function keptPreview(tab) {
  const entry = kept.get(tab);
  return entry && entry.document === documentOf(tab) ? entry.url : null;
}

/**
 * Whether `tab`'s page is loaded, so there is something to draw: it has a
 * browser in the window, is not waiting to restore, and holds a document.
 * A lazy tab has no `linkedPanel`, and is asked nothing more.
 *
 * @param {Element} tab
 * @returns {boolean}
 */
function isLoaded(tab) {
  return (
    !!tab.linkedPanel &&
    !tab.hasAttribute("pending") &&
    !!tab.linkedBrowser?.browsingContext?.currentWindowGlobal
  );
}

/**
 * Where a card stands in the carousel, `offset` cards from the middle,
 * fractions included while it pans. The first card each side stands
 * `NEAR` of a card's width from the middle, and each further one `FAR`
 * more, so the cards overlap more the further out they are. A card turns
 * toward the middle, shrinks and darkens as it leaves it, all of it by the
 * time it is one card out.
 *
 * @param {number} offset
 * @returns {{x: number, turn: number, scale: number, shade: number,
 *   depth: number, shown: boolean}} `x` in card widths, `turn` in degrees,
 *   `depth` the stacking order, the middle card's highest.
 */
export function tilePlace(offset) {
  const distance = Math.abs(offset);
  const sign = Math.sign(offset);
  const near = Math.min(distance, 1);
  return {
    x: sign * (near * NEAR + Math.max(0, distance - 1) * FAR),
    turn: sign * near * TURN_DEG,
    scale: 1 - near * SHRINK,
    shade: near * SHADE,
    depth: 1000 - Math.round(distance * 10),
    shown: distance <= REACH,
  };
}

/**
 * One window's switcher, made by its `ctrlTab` (`ctrl-tab-switcher.patch`).
 */
export class SvalTabSwitcher {
  #win;
  #ctrlTab;
  #root = null;
  #card = null;
  #heading = null;
  #list = null;
  #caption = null;
  #footer = null;
  /** One tab per card, which stands for the card in `ctrlTab`'s calls. */
  #tabs = [];
  /** Each card's panes, in step with `#tabs`. */
  #panes = [];
  #items = [];
  #index = 0;
  #shown = false;
  #prevFocus = null;
  #listeners = null;
  /** Where the carousel's middle is, in cards, and where it is going. */
  #pos = 0;
  #target = 0;
  #frame = 0;
  #frameAt = 0;
  /** The cards drawn at the last paint, by index. */
  #painted = new Set();
  #tileWidth = TILE_MIN;
  #latched = false;
  #settle = 0;

  /**
   * @param {Window} win A browser window.
   * @param {object} ctrlTab The window's `ctrlTab`, which keys and clicks go
   *   to.
   */
  constructor(win, ctrlTab) {
    this.#win = win;
    this.#ctrlTab = ctrlTab;
  }

  /**
   * `browser-window-before-initial-xul-layout`: the switcher's stylesheet,
   * after the header's, whose colours it takes.
   *
   * @param {Window} win
   */
  static mount(win) {
    win.windowUtils.loadSheetUsingURIString(
      SHEET,
      win.windowUtils.AUTHOR_SHEET
    );
    // A page is drawn once it has loaded, selected or not, and again as the
    // user leaves its tab, so a tab has a preview after it unloads.
    // Tabbrowser takes `busy` off a tab when its top-level load stops.
    win.addEventListener("TabAttrModified", event => {
      const tab = event.target;
      if (
        event.detail?.changed?.includes("busy") &&
        !tab.hasAttribute("busy")
      ) {
        drawWhenIdle(win, tab);
      }
    });
    win.addEventListener("TabSelect", event => {
      const left = event.detail?.previousTab;
      if (left) {
        drawWhenIdle(win, left);
      }
    });
    win.addEventListener("TabClose", event => forget(event.target));
  }

  /** Whether the switcher is on screen. */
  get isOpen() {
    return this.#shown;
  }

  /**
   * Whether a wheel or a swipe has latched the switcher open, so letting
   * Ctrl go picks nothing (`ctrlTab.handleEvent`'s keyup).
   */
  get latched() {
    return this.#latched;
  }

  /** The tab the switcher has selected, or null. */
  get selectedTab() {
    return this.#tabs[this.#index] ?? null;
  }

  /**
   * The tabs a card stands for, which closing it closes
   * (`ctrlTab.remove`): a Split's panes, or the tab alone.
   *
   * @param {Element} tab A tab of the list.
   * @returns {Element[]}
   */
  tabsOf(tab) {
    const index = this.#tabs.indexOf(tab);
    return index < 0 ? [tab] : [...this.#panes[index]];
  }

  /**
   * What Ctrl+Tab lists (`ctrlTab.tabList`): the tabs `ctrlTab` keeps, and
   * the pages of the shown workspace's pins, which are hidden tabs it leaves
   * out (`SvalPinPages`), most recently used first, with each Split's panes
   * as one, the pane used last. `ctrlTab` files a tab opening in the
   * background second, so tabs a launch restores would stand in the reverse
   * of their restore order; sorting by `lastAccessed`, which a restored tab
   * takes from when this device last looked at it (`SvalRestore`), puts
   * them in order of use.
   *
   * @param {Element[]} used `ctrlTab`'s own list.
   * @returns {Element[]}
   */
  recentTabs(used) {
    const tabs = new Set(used);
    const pins = lazy.SvalPinPages.of(this.#win)?.tabsOfShownWorkspace() ?? [];
    for (const tab of pins) {
      tabs.add(tab);
    }
    const splits = new Set();
    return [...tabs]
      .sort((a, b) => b.lastAccessed - a.lastAccessed)
      .filter(tab => {
        const split = tab.splitview;
        if (!split) {
          return true;
        }
        if (splits.has(split)) {
          return false;
        }
        splits.add(split);
        return true;
      });
  }

  /**
   * Takes the tabs to list and the one to select, before the switcher shows,
   * so a quick press picks without drawing anything.
   *
   * @param {Element[]} tabs In order of use, the selected tab first.
   * @param {number} index
   */
  prepare(tabs, index) {
    this.#tabs = [...tabs];
    this.#panes = this.#tabs.map(panesOf);
    this.#index = Math.min(index, this.#tabs.length - 1);
    this.#pos = this.#target = this.#index;
  }

  /**
   * Moves the selection by `delta`, around the ends as Ctrl+Tab does.
   *
   * @param {number} delta
   * @returns {Element|null} The tab now selected.
   */
  move(delta) {
    const count = this.#tabs.length;
    if (!count) {
      return null;
    }
    let index = this.#index + delta;
    if (index < 0 || index >= count) {
      index = ((index % count) + count) % count;
      // Past an end the carousel comes round from the other side, one
      // card out, rather than panning across every card between.
      this.#pos = index - Math.sign(delta);
    }
    this.#target = index;
    this.#select(index);
    this.#animate();
    return this.selectedTab;
  }

  /** Draws the prepared tabs over the page and takes focus. */
  show() {
    if (this.#shown || !this.#tabs.length) {
      return;
    }
    const win = this.#win;
    const doc = win.document;
    this.#build();
    this.#items = this.#tabs.map((tab, i) => this.#item(i));
    this.#list.replaceChildren(...this.#items);
    this.#shown = true;
    this.#latched = false;
    this.#painted.clear();
    this.#fillFooter();
    this.#heading.firstChild.textContent = this.#headingText();
    // Shown before it is placed: placing measures the card.
    this.#root.hidden = false;
    doc.documentElement.toggleAttribute(OPEN_ATTRIBUTE, true);
    this.#pos = this.#target = this.#index;
    this.#place();
    this.#prevFocus = doc.commandDispatcher.focusedElement;
    this.#list.focus();
    this.#select(this.#index);
    // Ctrl's release goes to whatever app is in front once the window loses
    // it, so leaving the window cancels, and a resize places it again.
    this.#listeners = new win.AbortController();
    const { signal } = this.#listeners;
    win.addEventListener("deactivate", () => this.#ctrlTab.close(), {
      signal,
    });
    win.addEventListener("resize", () => this.#place(), { signal });
    // Every wheel in the window pans the carousel while it shows, wherever
    // the pointer is, and none reaches the Workspace panel, whose sideways
    // swipe would switch Workspaces under the carousel.
    win.addEventListener("wheel", event => this.#onWheel(event), {
      signal,
      capture: true,
      passive: false,
    });
  }

  /** Takes the switcher away, and gives focus back to where it was. */
  hide() {
    if (!this.#shown) {
      return;
    }
    this.#shown = false;
    this.#latched = false;
    this.#listeners.abort();
    this.#listeners = null;
    this.#win.cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#win.clearTimeout(this.#settle);
    const hadFocus = this.#root.contains(this.#win.document.activeElement);
    this.#root.hidden = true;
    this.#win.document.documentElement.removeAttribute(OPEN_ATTRIBUTE);
    this.#list.replaceChildren();
    this.#list.removeAttribute("aria-activedescendant");
    this.#caption.replaceChildren();
    this.#items = [];
    this.#painted.clear();
    const prev = this.#prevFocus;
    this.#prevFocus = null;
    if (!hadFocus) {
      return;
    }
    if (prev?.isConnected) {
      Services.focus.setFocus(prev, Ci.nsIFocusManager.FLAG_NOSCROLL);
    } else {
      this.#win.gBrowser.selectedBrowser.focus();
    }
  }

  /**
   * Takes a closing tab out of the list, keeping the selection on the same
   * place in it. A Split's pane leaves its card, which keeps its other
   * panes.
   *
   * @param {Element} tab
   */
  removeTab(tab) {
    const index = this.#panes.findIndex(panes => panes.includes(tab));
    if (index < 0) {
      return;
    }
    const rest = this.#panes[index].filter(pane => pane !== tab);
    if (rest.length) {
      this.#panes[index] = rest;
      if (this.#tabs[index] === tab) {
        this.#tabs[index] = rest[0];
      }
      if (this.#shown) {
        this.#redraw(index);
      }
      return;
    }
    this.#tabs.splice(index, 1);
    this.#panes.splice(index, 1);
    if (this.#shown) {
      const [item] = this.#items.splice(index, 1);
      item.remove();
      this.#items.forEach((el, i) => (el.dataset.index = i));
      this.#painted.clear();
    }
    const next = Math.min(
      index < this.#index ? this.#index - 1 : this.#index,
      this.#tabs.length - 1
    );
    if (index < this.#index) {
      this.#pos -= 1;
    }
    this.#target = next;
    if (this.#shown) {
      this.#select(next);
      this.#paint();
      // `TabClose` comes before the tab that takes the closing one's place
      // is selected (`_endRemoveTab`), and selecting it may focus its page.
      if (tab.selected) {
        Services.tm.dispatchToMainThread(() => {
          if (this.#shown) {
            this.#list.focus();
          }
        });
      }
    } else {
      this.#index = next;
      this.#pos = next;
    }
  }

  /**
   * Redraws a tab's title and icon after they changed.
   *
   * @param {Element} tab
   */
  updateTab(tab) {
    const index = this.#panes.findIndex(panes => panes.includes(tab));
    const item = this.#items[index];
    if (!item) {
      return;
    }
    item.setAttribute("aria-label", this.#nameOf(index));
    if (item.hasAttribute("data-seen")) {
      this.#fillIcons(item, index);
    }
    if (index === this.#index) {
      this.#fillCaption();
    }
  }

  /** The switcher's elements, made once per window. */
  #build() {
    if (this.#root) {
      return;
    }
    const doc = this.#win.document;
    const root = doc.createElementNS(HTML_NS, "div");
    root.id = ROOT_ID;
    root.hidden = true;
    // A press outside the card cancels, as Escape does.
    root.addEventListener("mousedown", event => {
      if (event.target === root) {
        event.preventDefault();
        this.#ctrlTab.close();
      }
    });

    const card = doc.createElementNS(HTML_NS, "div");
    card.className = "sval-switcher-card";
    // The card's top edge, and the list's accessible name in full, which
    // the edge may cut short.
    const heading = doc.createElementNS(HTML_NS, "div");
    heading.className = "sval-switcher-heading";
    heading.id = `${LIST_ID}-heading`;
    heading.append(doc.createElementNS(HTML_NS, "span"));
    heading.firstChild.className = "sval-switcher-heading-text";
    const list = doc.createElementNS(HTML_NS, "div");
    list.id = LIST_ID;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-labelledby", heading.id);
    list.setAttribute("aria-orientation", "horizontal");
    list.tabIndex = 0;
    list.addEventListener("keydown", event => this.#onKeyDown(event));
    list.addEventListener("click", event => {
      const tab = this.#tabOf(event);
      if (tab && event.button === 0) {
        this.#ctrlTab.pick(tab);
      }
    });
    // A middle click closes the card, as on a tab. Control and a click is a
    // right click on macOS, and Control is held while the switcher shows.
    list.addEventListener("auxclick", event => {
      const tab = this.#tabOf(event);
      if (!tab) {
        return;
      }
      if (event.button === 1) {
        this.#ctrlTab.remove(tab);
      } else if (
        event.button === 2 &&
        Services.appinfo.OS === "Darwin" &&
        event.ctrlKey
      ) {
        this.#ctrlTab.pick(tab);
      }
    });
    list.addEventListener("contextmenu", event => event.preventDefault());

    // The middle card's title, under the carousel. The option's own name
    // says the same to a screen reader.
    const caption = doc.createElementNS(HTML_NS, "div");
    caption.className = "sval-switcher-caption";
    caption.setAttribute("aria-hidden", "true");
    const footer = doc.createElementNS(HTML_NS, "div");
    footer.className = "sval-switcher-footer";
    footer.setAttribute("aria-hidden", "true");

    card.append(heading, list, caption, footer);
    root.append(card);
    doc.getElementById("browser").append(root);
    this.#root = root;
    this.#card = card;
    this.#heading = heading;
    this.#list = list;
    this.#caption = caption;
    this.#footer = footer;
  }

  /**
   * The card's bottom edge: the keys the switcher answers and the wheel and
   * swipe that pan it, each with what it does, keys spelled as the platform
   * spells them (`shortcutText`). It repeats what the keys do for the eye
   * alone; a screen reader meets the list's
   * own keys. Once latched, Return picks where letting Ctrl go did, and the
   * close key's label names what the selected card is.
   */
  #fillFooter() {
    const doc = this.#win.document;
    const control = Services.strings
      .createBundle("chrome://global-platform/locale/platformKeys.properties")
      .GetStringFromName("VK_CONTROL");
    // Named as the panel's Split row menu names closing every pane.
    const panes = this.#panes[this.#index]?.length ?? 1;
    const close = { 1: "Close tab", 2: "Close Both" }[panes] ?? "Close All";
    const pairs = [
      [
        null,
        lazy.shortcutText({ modifiers: "control", keycode: "VK_TAB" }),
        "Next",
      ],
      [null, lazy.shortcutText({ modifiers: "control", key: "`" }), "Previous"],
      [null, PAN_ICONS, "Browse"],
      this.#latched
        ? [null, lazy.shortcutText({ keycode: "VK_RETURN" }), "Switch"]
        : ["Release", control, "Switch"],
      [null, lazy.shortcutText({ keycode: "VK_ESCAPE" }), "Cancel"],
      [null, lazy.shortcutText({ modifiers: "control", key: "W" }), close],
    ];
    const nodes = pairs.map(([before, key, does]) => {
      const pair = doc.createElementNS(HTML_NS, "span");
      pair.className = "sval-switcher-pair";
      if (before) {
        pair.append(before, " ");
      }
      if (Array.isArray(key)) {
        for (const name of key) {
          const icon = doc.createElementNS(HTML_NS, "img");
          icon.className = "sval-switcher-icon";
          icon.src = lazy.iconURL(name);
          icon.alt = "";
          pair.append(icon);
        }
      } else {
        const cap = doc.createElementNS(HTML_NS, "kbd");
        cap.className = "sval-keycap";
        cap.textContent = key;
        pair.append(cap);
      }
      const label = doc.createElementNS(HTML_NS, "span");
      label.className = "sval-switcher-does";
      label.textContent = does;
      pair.append(label);
      return pair;
    });
    this.#footer.replaceChildren(...nodes);
  }

  /**
   * Places the switcher over the content area and sizes its cards to it: a
   * share of its width, as tall as the height left over the page allows.
   */
  #place() {
    const area = this.#win.gBrowser.tabbox.getBoundingClientRect();
    Object.assign(this.#root.style, {
      left: `${area.left}px`,
      top: `${area.top}px`,
      width: `${area.width}px`,
      height: `${area.height}px`,
    });
    const stage = Math.max(0, area.width - 2 * (CARD_MARGIN + CARD_PADDING));
    // What the card holds besides the carousel (its padding, its heading,
    // its caption and its footer) comes off the height the carousel may
    // take.
    const framing = this.#card.offsetHeight - this.#list.offsetHeight;
    const room = Math.max(0, area.height - 2 * CARD_MARGIN - framing);
    const ratio = PREVIEW_WIDTH / PREVIEW_HEIGHT;
    const width = Math.max(
      TILE_MIN,
      Math.min(TILE_MAX, stage * TILE_SHARE, (room / STAGE_HEIGHT) * ratio)
    );
    this.#tileWidth = width;
    const style = this.#card.style;
    style.setProperty("--sval-switcher-width", `${stage}px`);
    style.setProperty("--sval-switcher-tile-width", `${width}px`);
    style.setProperty("--sval-switcher-tile-height", `${width / ratio}px`);
    style.setProperty(
      "--sval-switcher-stage-height",
      `${(width / ratio) * STAGE_HEIGHT}px`
    );
    this.#paint();
  }

  /**
   * "Recent tabs in" the window's Workspace, named as the Workspace panel's
   * switcher names it (`switcherItemLabel`), or "Recent tabs" in
   * a window that shows no Workspace, as a Peek.
   *
   * @returns {string}
   */
  #headingText() {
    const panel = this.#win.SvalPanel;
    const id = lazy.SvalWindowWorkspace.of(this.#win).id;
    const item = id ? lazy.switcherItemOf(panel.nodes, id, id) : null;
    return item
      ? `Recent tabs in ${lazy.switcherItemLabel(item)}`
      : "Recent tabs";
  }

  /**
   * One card's option: a preview for each of its panes. The previews and
   * icons are filled once the card comes near the middle ({@link #reveal}).
   *
   * @param {number} index
   * @returns {Element}
   */
  #item(index) {
    const doc = this.#win.document;
    const el = (tag, className) => {
      const node = doc.createElementNS(HTML_NS, tag);
      node.className = className;
      return node;
    };
    const tab = this.#tabs[index];
    const panes = this.#panes[index];
    const item = el("div", "sval-switcher-item");
    item.id = `${LIST_ID}-${index}`;
    item.dataset.index = index;
    item.hidden = true;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    item.setAttribute("aria-label", this.#nameOf(index));

    const tile = el("div", "sval-switcher-tile");
    tile.setAttribute("aria-hidden", "true");
    for (const pane of panes) {
      const preview = el("div", "sval-switcher-preview");
      const shown = keptPreview(pane);
      if (shown) {
        const img = el("img", "sval-switcher-picture");
        img.setAttribute("alt", "");
        img.src = shown;
        preview.append(img);
        preview.dataset.preview = "snapshot";
      } else {
        const placeholder = el("div", "sval-switcher-placeholder");
        const siteIcon = el("img", "sval-switcher-icon");
        siteIcon.setAttribute("alt", "");
        const site = el("span", "sval-switcher-site");
        site.textContent =
          this.#win.SvalPanel?.tabPlaceholder(this.#urlOf(pane)) ?? "";
        placeholder.append(siteIcon, site);
        preview.append(placeholder);
        preview.dataset.preview = "placeholder";
      }
      tile.append(preview);
    }
    if (panes.length > 1) {
      item.dataset.split = "";
    }
    // A pin's page and a tab in a group carry the marks the Launcher's rows
    // draw for them, in the caption; the option's description says the same
    // to a screen reader.
    if (lazy.isPin(tab)) {
      item.setAttribute("aria-description", "Pin");
      item.dataset.pin = "";
    } else {
      const group = this.#groupOf(tab);
      if (group) {
        item.setAttribute("aria-description", group.name);
        item.dataset.group = group.id;
      }
    }
    item.append(tile);
    return item;
  }

  /**
   * Draws a card again after its panes changed, in its place.
   *
   * @param {number} index
   */
  #redraw(index) {
    const old = this.#items[index];
    const item = this.#item(index);
    this.#items[index] = item;
    old.replaceWith(item);
    this.#painted.delete(index);
    if (index === this.#index) {
      this.#select(index);
    }
    this.#paint();
  }

  /**
   * What a card is called: a tab as its row in the panel calls it, a Split
   * by its name, or by its panes' titles when it has none, as the panel's
   * Split row is named.
   *
   * @param {number} index
   * @returns {string}
   */
  #nameOf(index) {
    const panes = this.#panes[index];
    if (panes.length === 1) {
      return this.#titleOf(panes[0]);
    }
    return (
      this.#splitName(panes[0]) ||
      `Split View: ${panes.map(pane => this.#titleOf(pane)).join(", ")}`
    );
  }

  /**
   * What a tab is called here, as its row in the panel calls it: the label a
   * user gave it over its page's title.
   *
   * @param {Element} tab
   * @returns {string}
   */
  #titleOf(tab) {
    const nodes = this.#win.SvalPanel?.nodes;
    const id = nodes && lazy.SvalTabs.nodeIdOf(tab);
    return (id && nodes[id]?.appearance?.label) || tab.label;
  }

  /**
   * The name the user gave the Split a pane is in, or "".
   *
   * @param {Element} pane
   * @returns {string}
   */
  #splitName(pane) {
    const nodes = this.#win.SvalPanel?.nodes;
    const id = nodes && lazy.SvalTabs.nodeIdOf(pane);
    const split =
      id &&
      lazy.ancestorIds(nodes, id).find(a => nodes[a]?.kind === lazy.SPLIT);
    return (split && nodes[split].content?.name) || "";
  }

  /**
   * The group a tab is in, the innermost where groups nest, as the Launcher's
   * chip takes it.
   *
   * @param {Element} tab
   * @returns {?{id: string, name: string, color: ?string, emoji: ?string,
   *   agent: boolean}}
   */
  #groupOf(tab) {
    const nodes = this.#win.SvalPanel?.nodes;
    const id = nodes && lazy.SvalTabs.nodeIdOf(tab);
    const groupId =
      id &&
      lazy.ancestorIds(nodes, id).find(a => nodes[a]?.kind === lazy.GROUP);
    if (!groupId) {
      return null;
    }
    const group = nodes[groupId];
    return {
      id: groupId,
      name: group.content?.name ?? "",
      color: lazy.colorOf(group.appearance?.color, "group"),
      emoji: group.appearance?.emoji ?? null,
      agent: false,
    };
  }

  /**
   * The caption under the carousel, for the selected card: each pane's icon
   * and title, a pin's glyph or a group's chip after a tab's, and a named
   * Split's name before its panes.
   */
  #fillCaption() {
    const doc = this.#win.document;
    const el = (tag, className) => {
      const node = doc.createElementNS(HTML_NS, tag);
      node.className = className;
      return node;
    };
    const panes = this.#panes[this.#index];
    if (!panes) {
      this.#caption.replaceChildren();
      return;
    }
    const parts = [];
    const name = panes.length > 1 && this.#splitName(panes[0]);
    if (name) {
      const named = el("span", "sval-switcher-split-name");
      named.textContent = name;
      parts.push(named);
    }
    for (const pane of panes) {
      const part = el("span", "sval-switcher-caption-pane");
      const icon = el("img", "sval-switcher-icon");
      icon.setAttribute("alt", "");
      this.#fillIcon(icon, pane);
      const title = el("span", "sval-switcher-title");
      title.textContent = this.#titleOf(pane);
      part.append(icon, title);
      parts.push(part);
    }
    const tab = this.#tabs[this.#index];
    if (panes.length === 1) {
      if (lazy.isPin(tab)) {
        const mark = el("span", "sval-mark");
        mark.dataset.mark = "pin";
        parts.push(mark);
      } else {
        const group = this.#groupOf(tab);
        if (group) {
          parts.push(lazy.chipElement(doc, group));
        }
      }
    }
    this.#caption.toggleAttribute("data-split", panes.length > 1);
    this.#caption.replaceChildren(...parts);
  }

  /**
   * A card come near the middle: its icons, and its loaded panes' previews.
   *
   * @param {Element} item
   */
  #reveal(item) {
    const index = Number(item.dataset.index);
    const panes = this.#panes[index];
    if (!panes) {
      return;
    }
    item.setAttribute("data-seen", "");
    this.#fillIcons(item, index);
    const previews = item.querySelectorAll(".sval-switcher-preview");
    panes.forEach((pane, i) => {
      if (isLoaded(pane)) {
        this.#capture(previews[i], pane);
      }
    });
  }

  /**
   * Fills a card's placeholder icons, one per pane.
   *
   * @param {Element} item
   * @param {number} index
   */
  #fillIcons(item, index) {
    const previews = item.querySelectorAll(".sval-switcher-preview");
    this.#panes[index].forEach((pane, i) => {
      const img = previews[i]?.querySelector(".sval-switcher-icon");
      if (img) {
        this.#fillIcon(img, pane);
      }
    });
  }

  /**
   * Fills an icon as the tab's row in the panel fills its own
   * (`SvalPanel.fillTabIcon`), which finds an icon for a tab that has not
   * loaded; a window with no panel has the tab's own.
   *
   * @param {Element} img
   * @param {Element} tab
   */
  #fillIcon(img, tab) {
    const panel = this.#win.SvalPanel;
    const id = lazy.SvalTabs.nodeIdOf(tab);
    if (panel && id) {
      panel.fillTabIcon(img, id, this.#urlOf(tab));
    } else if (tab.image) {
      img.setAttribute("src", tab.image);
    }
  }

  /**
   * Draws a loaded tab's page into its preview, in memory.
   *
   * @param {Element} preview
   * @param {Element} tab
   */
  async #capture(preview, tab) {
    const canvas = await draw(tab);
    if (!canvas || !preview.isConnected) {
      return;
    }
    preview.replaceChildren(canvas);
    preview.dataset.preview = "snapshot";
  }

  /**
   * The address a tab is for, whether loaded or not.
   *
   * @param {Element} tab
   * @returns {string}
   */
  #urlOf(tab) {
    return lazy.SvalTabs.openingUrl(tab);
  }

  /**
   * @param {Event} event A pointer event on the list.
   * @returns {Element|null} The tab of the card it is on.
   */
  #tabOf(event) {
    const item = event.target.closest?.(".sval-switcher-item");
    return item ? (this.#tabs[Number(item.dataset.index)] ?? null) : null;
  }

  /**
   * @param {number} index
   */
  #select(index) {
    const before = this.#index;
    this.#index = index;
    if (!this.#shown) {
      return;
    }
    this.#items[before]?.setAttribute("aria-selected", "false");
    const item = this.#items[index];
    if (!item) {
      return;
    }
    item.setAttribute("aria-selected", "true");
    this.#list.setAttribute("aria-activedescendant", item.id);
    this.#fillCaption();
    // The close key's label names what the card holds.
    if ((this.#panes[before]?.length ?? 1) !== this.#panes[index].length) {
      this.#fillFooter();
    }
  }

  /** Moves the carousel toward where it is going, a frame at a time. */
  #animate() {
    if (!this.#shown || this.#frame) {
      return;
    }
    this.#frameAt = 0;
    this.#frame = this.#win.requestAnimationFrame(now => this.#tick(now));
  }

  /**
   * One frame of the carousel's travel: it closes the same share of the
   * distance left in each slice of time, so it slows as it arrives, and
   * keeps up with a target that moves on while it travels.
   *
   * @param {number} now
   */
  #tick(now) {
    this.#frame = 0;
    const elapsed = this.#frameAt ? now - this.#frameAt : 16;
    this.#frameAt = now;
    const still = this.#win.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    const gap = this.#target - this.#pos;
    if (still || Math.abs(gap) < 0.002) {
      this.#pos = this.#target;
    } else {
      this.#pos += gap * (1 - Math.exp(-elapsed / EASE_MS));
    }
    this.#paint();
    if (this.#pos !== this.#target) {
      this.#frame = this.#win.requestAnimationFrame(t => this.#tick(t));
    }
  }

  /**
   * Stands each card near the middle where {@link tilePlace} puts it, and
   * hides the cards drawn last time that have gone out of reach.
   */
  #paint() {
    if (!this.#shown) {
      return;
    }
    const rtl = this.#win.getComputedStyle(this.#list).direction === "rtl";
    const side = rtl ? -1 : 1;
    const width = this.#tileWidth;
    const low = Math.max(0, Math.floor(this.#pos - REACH));
    const high = Math.min(this.#items.length - 1, Math.ceil(this.#pos + REACH));
    const painted = new Set();
    for (let i = low; i <= high; i++) {
      const item = this.#items[i];
      const place = tilePlace(i - this.#pos);
      if (!place.shown) {
        continue;
      }
      painted.add(i);
      item.hidden = false;
      item.style.transform =
        `translateX(${side * place.x * width}px) ` +
        `rotateY(${-side * place.turn}deg) scale(${place.scale})`;
      item.style.zIndex = place.depth;
      item.style.setProperty("--sval-switcher-shade", place.shade);
      if (!item.hasAttribute("data-seen")) {
        this.#reveal(item);
      }
    }
    for (const i of this.#painted) {
      if (!painted.has(i) && this.#items[i]) {
        this.#items[i].hidden = true;
      }
    }
    this.#painted = painted;
  }

  /**
   * Keeps the switcher open when Ctrl is let go (`latched`), once the user
   * has moved through it with a wheel or a swipe.
   */
  #latch() {
    if (!this.#latched) {
      this.#latched = true;
      this.#fillFooter();
    }
  }

  /**
   * A wheel or a two-finger swipe anywhere in the window slides the
   * carousel: across or down, whichever the gesture moves more, a positive
   * delta toward the older tabs, as a positive `deltaX` goes Forward in
   * Firefox's page swipe (`browser.gesture.swipe.right`). Momentum after
   * the fingers lift slides it on. The carousel stops at its ends, and
   * settles on the nearest card once the wheel is still. The first one
   * latches the switcher open.
   *
   * @param {WheelEvent} event
   */
  #onWheel(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.#tabs.length) {
      return;
    }
    this.#latch();
    const unit =
      {
        [event.DOM_DELTA_PIXEL]: 1,
        [event.DOM_DELTA_LINE]: WHEEL_LINE_PX,
      }[event.deltaMode] ?? WHEEL_PX_PER_CARD;
    const rtl = this.#win.getComputedStyle(this.#list).direction === "rtl";
    const dx = event.deltaX * unit * (rtl ? -1 : 1);
    const dy = event.deltaY * unit;
    const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    const last = this.#tabs.length - 1;
    this.#target = Math.max(
      0,
      Math.min(last, this.#target + delta / WHEEL_PX_PER_CARD)
    );
    const index = Math.round(this.#target);
    if (index !== this.#index) {
      this.#select(index);
    }
    this.#animate();
    this.#win.clearTimeout(this.#settle);
    this.#settle = this.#win.setTimeout(() => {
      this.#target = this.#index;
      this.#animate();
      if (this.selectedTab) {
        this.#win.gBrowser.warmupTab(this.selectedTab);
      }
    }, SETTLE_MS);
  }

  /**
   * The keys the list answers itself; Ctrl+Tab, Ctrl+W and Delete reach
   * `ctrlTab`'s own listeners.
   *
   * @param {KeyboardEvent} event
   */
  #onKeyDown(event) {
    const ctrlTab = this.#ctrlTab;
    switch (event.key) {
      case "Tab":
        // Ctrl+Tab is `ctrlTab.onKeyDown`'s. Tab alone keeps focus here.
        if (event.ctrlKey) {
          return;
        }
        ctrlTab.advanceFocus(!event.shiftKey);
        break;
      case "Enter":
        ctrlTab.pick();
        break;
      case "Escape":
        ctrlTab.close();
        break;
      // The Mac key labeled delete is Backspace; `ctrlTab.onKeyPress`
      // answers forward Delete.
      case "Backspace":
        ctrlTab.remove(ctrlTab.selected);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
}
