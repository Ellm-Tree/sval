/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Ctrl+Tab switcher: what Firefox's `ctrlTab` shows while Ctrl is held,
 * drawn by Sval (`ctrl-tab-switcher.patch`). `ctrlTab` keeps the window's
 * tabs in order of use, leaving out the hidden ones, which are other
 * workspaces' (`ctrlTab.attachTab`), and decides what each key does. This
 * draws that list as a grid of previews centred over the page, every tab of
 * it, and hands each key and click back to `ctrlTab`.
 *
 * - **Previews stay in memory.** A loaded tab's is drawn from its page
 *   (`PageThumbs.captureTabPreviewThumbnail`, the capture Firefox's tab hover
 *   preview makes) once its page has loaded, as the user leaves the tab, and
 *   as it scrolls into view here, so a window of hundreds of tabs opens at
 *   once. The last one drawn is kept, as a JPEG in memory, for as long as the
 *   tab shows the same document, so a tab unloaded since still shows its
 *   page. Nothing is written to disk (`CONTRIBUTING.md` rule 10): Sval turns
 *   thumbnail storage off (`browser.pagethumbnails.capturing_disabled`),
 *   which is where Firefox's panel finds an unloaded tab's picture. A tab
 *   Sval restored and nobody has opened since (`SvalRestore`) has never been
 *   drawn, and shows its favicon and site instead.
 * - **The grid is a listbox** whose options are the tabs, named by their
 *   titles, with focus on the list and the selection its active descendant.
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
  shadeScrollEdges: "moz-src:///browser/components/sval/SvalDom.sys.mjs",
  shortcutText: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  switcherItemOf: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  ancestorIds: "moz-src:///browser/components/sval/SvalTree.sys.mjs",
  chipElement: "moz-src:///browser/components/sval/SvalLauncherRows.sys.mjs",
  colorOf: "moz-src:///browser/components/sval/SvalColor.sys.mjs",
  isPin: "moz-src:///browser/components/sval/SvalPinTab.sys.mjs",
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

/** A preview's size in CSS pixels, 16:10. */
const PREVIEW_WIDTH = 224;
const PREVIEW_HEIGHT = 140;
/** The space between items, and around them inside the card. */
const GAP = 12;
const CARD_PADDING = 16;
/** The least room the card leaves around it over the page. */
const CARD_MARGIN = 24;
/** The list's padding, room for the selected item's ring at its edges. */
const LIST_PADDING = 4;

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
 * Draws a loaded tab's page at a preview's size, and keeps a copy for
 * when the tab has unloaded ({@link kept}).
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
  canvas.width = Math.round(PREVIEW_WIDTH * win.devicePixelRatio);
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
 * One window's switcher, made by its `ctrlTab` (`ctrl-tab-switcher.patch`).
 */
export class SvalTabSwitcher {
  #win;
  #ctrlTab;
  #root = null;
  #card = null;
  #heading = null;
  #scroller = null;
  #list = null;
  #tabs = [];
  #items = [];
  #index = 0;
  #columns = 1;
  #shown = false;
  #prevFocus = null;
  #observer = null;
  #pointer = null;
  #listeners = null;

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

  /** The tab the switcher has selected, or null. */
  get selectedTab() {
    return this.#tabs[this.#index] ?? null;
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
    this.#index = Math.min(index, this.#tabs.length - 1);
  }

  /**
   * Moves the selection by `delta`. A step of one wraps around the ends, as
   * Ctrl+Tab does; a row's step stops at them.
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
    if (Math.abs(delta) === 1) {
      index = (index + count) % count;
    } else if (index < 0 || index >= count) {
      return this.selectedTab;
    }
    this.#select(index);
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
    this.#items = this.#tabs.map((tab, i) => this.#item(tab, i));
    this.#list.replaceChildren(...this.#items);
    this.#shown = true;
    this.#pointer = null;
    this.#heading.firstChild.textContent = this.#headingText();
    // Shown before it is placed: placing measures the grid.
    this.#root.hidden = false;
    doc.documentElement.toggleAttribute(OPEN_ATTRIBUTE, true);
    this.#place();
    this.#prevFocus = doc.commandDispatcher.focusedElement;
    this.#list.focus();
    this.#select(this.#index);
    for (const item of this.#items) {
      this.#observer.observe(item);
    }
    // Ctrl's release goes to whatever app is in front once the window loses
    // it, so leaving the window cancels, and a resize places it again.
    this.#listeners = new win.AbortController();
    const { signal } = this.#listeners;
    win.addEventListener("deactivate", () => this.#ctrlTab.close(), {
      signal,
    });
    win.addEventListener("resize", () => this.#place(), { signal });
  }

  /** Takes the switcher away, and gives focus back to where it was. */
  hide() {
    if (!this.#shown) {
      return;
    }
    this.#shown = false;
    this.#listeners.abort();
    this.#listeners = null;
    this.#observer.disconnect();
    const hadFocus = this.#root.contains(this.#win.document.activeElement);
    this.#root.hidden = true;
    this.#win.document.documentElement.removeAttribute(OPEN_ATTRIBUTE);
    this.#list.replaceChildren();
    this.#list.removeAttribute("aria-activedescendant");
    this.#items = [];
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
   * place in it.
   *
   * @param {Element} tab
   */
  removeTab(tab) {
    const index = this.#tabs.indexOf(tab);
    if (index < 0) {
      return;
    }
    this.#tabs.splice(index, 1);
    if (this.#shown) {
      const [item] = this.#items.splice(index, 1);
      this.#observer.unobserve(item);
      item.remove();
      this.#items.forEach((el, i) => (el.dataset.index = i));
    }
    const next = Math.min(
      index < this.#index ? this.#index - 1 : this.#index,
      this.#tabs.length - 1
    );
    if (this.#shown) {
      this.#select(next);
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
    }
  }

  /**
   * Redraws a tab's title and icon after they changed.
   *
   * @param {Element} tab
   */
  updateTab(tab) {
    const item = this.#items[this.#tabs.indexOf(tab)];
    if (!item) {
      return;
    }
    item.querySelector(".sval-switcher-title").textContent = this.#titleOf(tab);
    if (item.hasAttribute("data-seen")) {
      this.#fillIcons(item, tab);
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
    // The card's fixed top edge, and the list's accessible name in full,
    // which the edge may cut short.
    const heading = doc.createElementNS(HTML_NS, "div");
    heading.className = "sval-switcher-heading sval-edge-above";
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
    // The switcher can open under a still pointer, which must not take the
    // selection from the keys, so the pointer selects only once it has moved
    // from where the first event found it.
    list.addEventListener("mousemove", event => {
      const at = `${event.screenX},${event.screenY}`;
      const moved = this.#pointer !== null && this.#pointer !== at;
      this.#pointer = at;
      const item = moved && event.target.closest?.(".sval-switcher-item");
      if (item) {
        this.#select(Number(item.dataset.index), { scroll: false });
      }
    });
    list.addEventListener("click", event => {
      const tab = this.#tabOf(event);
      if (tab && event.button === 0) {
        this.#ctrlTab.pick(tab);
      }
    });
    // A middle click closes the tab, as on a tab. Control and a click is a
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

    // The grid scrolls between the heading and the footer, which cast a
    // shadow over the tiles past them as the Workspace panel's header and
    // footer do over its rows.
    const scroller = doc.createElementNS(HTML_NS, "div");
    scroller.className = "sval-switcher-scroller";
    const marker = () => {
      const node = doc.createElementNS(HTML_NS, "div");
      node.className = "sval-switcher-edge";
      node.setAttribute("aria-hidden", "true");
      return node;
    };
    const topMarker = marker();
    const bottomMarker = marker();
    scroller.append(topMarker, list, bottomMarker);
    const footer = this.#footer(doc);

    card.append(heading, scroller, footer);
    root.append(card);
    doc.getElementById("browser").append(root);
    this.#root = root;
    this.#card = card;
    this.#heading = heading;
    this.#scroller = scroller;
    this.#list = list;
    lazy.shadeScrollEdges(scroller, {
      topMarker,
      bottomMarker,
      top: heading,
      bottom: footer,
    });
    this.#observer = new this.#win.IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.#observer.unobserve(entry.target);
            this.#reveal(entry.target);
          }
        }
      },
      { root: scroller }
    );
  }

  /**
   * The card's fixed bottom edge: the keys the switcher answers, each with
   * what it does, spelled as the platform spells keys (`shortcutText`). It
   * repeats what the keys do for the eye alone; a screen reader meets the
   * list's own keys.
   *
   * @param {Document} doc
   * @returns {Element}
   */
  #footer(doc) {
    const footer = doc.createElementNS(HTML_NS, "div");
    footer.className = "sval-switcher-footer sval-edge-below";
    footer.setAttribute("aria-hidden", "true");
    const control = Services.strings
      .createBundle("chrome://global-platform/locale/platformKeys.properties")
      .GetStringFromName("VK_CONTROL");
    const pairs = [
      [
        null,
        lazy.shortcutText({ modifiers: "control", keycode: "VK_TAB" }),
        "Next",
      ],
      [null, lazy.shortcutText({ modifiers: "control", key: "`" }), "Previous"],
      ["Release", control, "Switch"],
      [null, lazy.shortcutText({ keycode: "VK_ESCAPE" }), "Cancel"],
      [
        null,
        lazy.shortcutText({ modifiers: "control", key: "W" }),
        "Close tab",
      ],
    ];
    for (const [before, key, does] of pairs) {
      const pair = doc.createElementNS(HTML_NS, "span");
      pair.className = "sval-switcher-pair";
      if (before) {
        pair.append(before, " ");
      }
      const cap = doc.createElementNS(HTML_NS, "kbd");
      cap.className = "sval-keycap";
      cap.textContent = key;
      const label = doc.createElementNS(HTML_NS, "span");
      label.className = "sval-switcher-does";
      label.textContent = does;
      pair.append(cap, label);
      footer.append(pair);
    }
    return footer;
  }

  /**
   * Places the switcher over the content area and sizes its grid to it: as
   * many columns as there are tabs, up to as many as fit the window's width.
   * The list scrolls down when its rows are taller than the window, and is
   * as wide as its columns and its scrollbar, so it never scrolls sideways.
   */
  #place() {
    const area = this.#win.gBrowser.tabbox.getBoundingClientRect();
    Object.assign(this.#root.style, {
      left: `${area.left}px`,
      top: `${area.top}px`,
      width: `${area.width}px`,
      height: `${area.height}px`,
    });
    const scroller = this.#scroller;
    // The scroller keeps its scrollbar's room whether it scrolls or not
    // (`scrollbar-gutter`), and an overlay scrollbar takes none.
    const gutter = scroller.offsetWidth - scroller.clientWidth;
    const inset = 2 * (CARD_MARGIN + CARD_PADDING + LIST_PADDING);
    const room = Math.max(0, area.width - inset - gutter);
    const item = Math.min(PREVIEW_WIDTH, room);
    const fit = Math.floor((room + GAP) / (item + GAP));
    const columns = Math.max(1, Math.min(fit, this.#tabs.length));
    this.#columns = columns;
    const style = this.#card.style;
    style.setProperty("--sval-switcher-columns", columns);
    style.setProperty("--sval-switcher-item-width", `${item}px`);
    style.setProperty(
      "--sval-switcher-width",
      `${columns * item + (columns - 1) * GAP + 2 * LIST_PADDING + gutter}px`
    );
    // What the card holds besides the scroller (its padding, its heading
    // and its footer) comes off the height the scroller may take.
    const framing = this.#card.offsetHeight - scroller.offsetHeight;
    style.setProperty(
      "--sval-switcher-room",
      `${Math.max(0, area.height - 2 * CARD_MARGIN - framing)}px`
    );
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
   * One tab's option: its preview, then its favicon and title. The preview
   * and icons are filled once the option scrolls into view ({@link #reveal}).
   *
   * @param {Element} tab
   * @param {number} index
   * @returns {Element}
   */
  #item(tab, index) {
    const doc = this.#win.document;
    const el = (tag, className) => {
      const node = doc.createElementNS(HTML_NS, tag);
      node.className = className;
      return node;
    };
    const item = el("div", "sval-switcher-item");
    item.id = `${LIST_ID}-${index}`;
    item.dataset.index = index;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");

    // The title names the option; the preview repeats what it shows.
    const preview = el("div", "sval-switcher-preview");
    preview.setAttribute("aria-hidden", "true");
    const shown = keptPreview(tab);
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
        this.#win.SvalPanel?.tabPlaceholder(this.#urlOf(tab)) ?? "";
      placeholder.append(siteIcon, site);
      preview.append(placeholder);
      preview.dataset.preview = "placeholder";
    }

    const caption = el("div", "sval-switcher-caption");
    const icon = el("img", "sval-switcher-icon");
    icon.setAttribute("alt", "");
    const title = el("span", "sval-switcher-title");
    title.textContent = this.#titleOf(tab);
    caption.append(icon, title);
    // A pin's page and a tab in a group carry the marks the Launcher's rows
    // draw for them: the pin glyph, and the group's chip in its colour. The
    // option's description says the same to a screen reader.
    if (lazy.isPin(tab)) {
      const mark = el("span", "sval-mark");
      mark.dataset.mark = "pin";
      mark.setAttribute("aria-hidden", "true");
      caption.append(mark);
      item.setAttribute("aria-description", "Pin");
      item.dataset.pin = "";
    } else {
      const group = this.#groupOf(tab);
      if (group) {
        const chip = lazy.chipElement(doc, group);
        chip.setAttribute("aria-hidden", "true");
        caption.append(chip);
        item.setAttribute("aria-description", group.name);
        item.dataset.group = group.id;
      }
    }
    item.append(preview, caption);
    return item;
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
   * An option scrolled into view: its icons, and a loaded tab's preview.
   *
   * @param {Element} item
   */
  #reveal(item) {
    const tab = this.#tabs[Number(item.dataset.index)];
    if (!tab) {
      return;
    }
    item.setAttribute("data-seen", "");
    this.#fillIcons(item, tab);
    if (isLoaded(tab)) {
      this.#capture(item, tab);
    }
  }

  /**
   * Fills an option's icons as the tab's row in the panel fills its own
   * (`SvalPanel.fillTabIcon`), which finds an icon for a tab that has not
   * loaded; a window with no panel has the tab's own.
   *
   * @param {Element} item
   * @param {Element} tab
   */
  #fillIcons(item, tab) {
    const panel = this.#win.SvalPanel;
    const id = lazy.SvalTabs.nodeIdOf(tab);
    for (const img of item.querySelectorAll(".sval-switcher-icon")) {
      if (panel && id) {
        panel.fillTabIcon(img, id, this.#urlOf(tab));
      } else if (tab.image) {
        img.setAttribute("src", tab.image);
      }
    }
  }

  /**
   * Draws a loaded tab's page into its option, in memory.
   *
   * @param {Element} item
   * @param {Element} tab
   */
  async #capture(item, tab) {
    const canvas = await draw(tab);
    if (!canvas || !item.isConnected) {
      return;
    }
    const preview = item.querySelector(".sval-switcher-preview");
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
   * @returns {Element|null} The tab of the option it is on.
   */
  #tabOf(event) {
    const item = event.target.closest?.(".sval-switcher-item");
    return item ? (this.#tabs[Number(item.dataset.index)] ?? null) : null;
  }

  /**
   * @param {number} index
   * @param {object} [options]
   * @param {boolean} [options.scroll] Whether to scroll the option into
   *   view, which the pointer's own moves do not need.
   */
  #select(index, { scroll = true } = {}) {
    this.#index = index;
    if (!this.#shown) {
      return;
    }
    for (const item of this.#list.querySelectorAll("[aria-selected=true]")) {
      item.setAttribute("aria-selected", "false");
    }
    const item = this.#items[index];
    if (!item) {
      return;
    }
    item.setAttribute("aria-selected", "true");
    this.#list.setAttribute("aria-activedescendant", item.id);
    if (scroll) {
      item.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /**
   * The keys the list answers itself; Ctrl+Tab, Ctrl+W and Delete reach
   * `ctrlTab`'s own listeners.
   *
   * @param {KeyboardEvent} event
   */
  #onKeyDown(event) {
    const rtl = this.#win.getComputedStyle(this.#list).direction === "rtl";
    const ctrlTab = this.#ctrlTab;
    switch (event.key) {
      case "ArrowRight":
        ctrlTab.advanceFocus(!rtl);
        break;
      case "ArrowLeft":
        ctrlTab.advanceFocus(rtl);
        break;
      case "ArrowDown":
        ctrlTab.advanceFocus(true, this.#columns);
        break;
      case "ArrowUp":
        ctrlTab.advanceFocus(false, this.#columns);
        break;
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
