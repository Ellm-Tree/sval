/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Quick Peek (link routing spec §5): the click the user chose for it, Alt-click
 * (Option-click on macOS) unless they chose another in Settings › Keyboard
 * shortcuts, opens a link in a page in a live overlay over the tab, which the
 * user closes, or keeps as a tab or a split.
 *
 * The click reaches the parent as every click on a link with a modifier does,
 * through Firefox's `ClickHandlerParent`, which `quick-peek-click.patch` has
 * ask {@link SvalQuickPeek.openClick} first. The choices other than Alt-click are
 * clicks Firefox opens a tab or a window for (`BrowserUtils.whereToOpenLink`),
 * so the Quick Peek takes the click in Firefox's place, and Firefox opens the link
 * where it would whenever no Quick Peek can open.
 *
 * The page is a real tab of the window, opened in the background in the jar
 * of the tab it came from and hidden from everything that walks the window's
 * tabs (`gBrowser.hideTab`). Its own panel, which already holds its
 * `<browser>`, is drawn over the content area (`sval-quick-peek.css`) and made
 * active, as Firefox keeps a split's panels active together
 * (`showSplitViewPanels`). So keeping it moves no browser and swaps no
 * docshell: the same tab is shown and filed through the path every new tab
 * takes (`SvalTabs` `fileTab`), and split through the panel's own write
 * (`splitBeside`). Until then it is marked (`SvalQuickPeekTab`) and no node
 * describes it, since an open Quick Peek belongs to no workspace.
 *
 * A Quick Peek closes on Escape, Close Tab (`cmd_close`), a click outside it, or its
 * close button, and when the window shows another tab or the tab under it closes or goes to another
 * page. Its page goes to History as any visited page does, and to no
 * recently-closed list, because the user dismissed it. A Quick Peek stays open while
 * another window is in front: it belongs to its window, as a split does.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import {
  SPLIT_MAX_PANES,
  isPane,
  splitHasRoom,
} from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";
import {
  isQuickPeek,
  markQuickPeek,
  unmarkQuickPeek,
} from "moz-src:///browser/components/sval/SvalQuickPeekTab.sys.mjs";
import { isPin } from "moz-src:///browser/components/sval/SvalPinTab.sys.mjs";
import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";
import {
  ariaShortcut,
  keycap,
} from "moz-src:///browser/components/sval/SvalKeys.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  copyText: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
  linkLoad: "moz-src:///browser/components/sval/SvalLinkClick.sys.mjs",
  SvalFirefox: "moz-src:///browser/components/sval/SvalFirefox.sys.mjs",
  loadOf: "moz-src:///browser/components/sval/SvalLinkClick.sys.mjs",
  SvalLoadLine: "moz-src:///browser/components/sval/SvalLoadLine.sys.mjs",
});
// Named exports, read once a Quick Peek draws its shield.
ChromeUtils.defineLazyGetter(lazy, "protection", () =>
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs"
  )
);

/**
 * Whether a click opens a Quick Peek (link routing spec §7). Synced. Settings ›
 * Links' switch and the Keyboard shortcuts pane's Off both write it.
 */
export const QUICK_PEEK_PREF = "browser.sval.quickPeek.enabled";

/**
 * The modifiers of the click that opens a Quick Peek, one of {@link QUICK_PEEK_CLICKS}.
 * It stays on the device, as `CustomKeys` keeps the user's keys.
 */
export const QUICK_PEEK_CLICK_PREF = "browser.sval.quickPeek.click";

/**
 * The clicks a Quick Peek may take, as a `<key>`'s `modifiers`, the default first.
 * Each holds Alt: a click without it is one a page or Firefox already
 * answers. Accel and Shift alone, and together, stay Firefox's
 * (`BrowserUtils.whereToOpenLink`), and a click with Control is a right
 * click on macOS (`dom.event.treat_ctrl_click_as_right_click.disabled`).
 */
export const QUICK_PEEK_CLICKS = Object.freeze([
  "alt",
  "accel,alt",
  "alt,shift",
]);

/** The page context menu's item that Quick Peeks at a link. */
export const QUICK_PEEK_LINK_ITEM_ID = "sval-context-quick-peek-link";

const QUICK_PEEK_CSS = "chrome://browser/content/sval/sval-quick-peek.css";

const SPLIT_FULL_TIP = `Split View holds ${SPLIT_MAX_PANES} pages, and this Split is full`;
const SPLIT_JOIN_TIP = "Add it to this Split";
const SPLIT_NEW_TIP = "Show it next to this tab in a Split";
const SPLIT_PIN_TIP =
  "You cannot create a Split because the page you opened this from is a Pin";

/** window -> the Quick Peek open in it. */
const quickPeeks = new WeakMap();

/** The windows `sval-quick-peek.css` is loaded in, which a window takes once. */
const styled = new WeakSet();

/**
 * Whether `win` is a window a Quick Peek opens in: a normal browser window, whose
 * panel files its tabs. A popup (`toolbar.visible` false, as
 * `BrowserDOMWindow` tells them apart) shows the one page that opened it.
 *
 * @param {Window} win
 * @returns {boolean}
 */
function canQuickPeekIn(win) {
  return !win.closed && win.toolbar.visible && !!win.SvalPanel?.observer;
}

/**
 * The modifiers of the click that opens a Quick Peek: the user's choice when it is
 * one of {@link QUICK_PEEK_CLICKS}, else the default.
 *
 * @returns {string} as a `<key>`'s `modifiers`.
 */
export function quickPeekClick() {
  const chosen = Services.prefs.getStringPref(QUICK_PEEK_CLICK_PREF, "");
  return QUICK_PEEK_CLICKS.includes(chosen) ? chosen : QUICK_PEEK_CLICKS[0];
}

/**
 * The modifiers a click was made with, as a `<key>`'s `modifiers` in the
 * order {@link QUICK_PEEK_CLICKS} spells them, with the platform's accel key as
 * "accel".
 *
 * @param {{altKey: boolean, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean}} click
 * @returns {string}
 */
export function clickModifiers({ altKey, ctrlKey, metaKey, shiftKey }) {
  const mac = AppConstants.platform === "macosx";
  const accel = mac ? metaKey : ctrlKey;
  const other = mac ? ctrlKey : metaKey;
  return [
    accel && "accel",
    altKey && "alt",
    other && (mac ? "control" : "meta"),
    shiftKey && "shift",
  ]
    .filter(Boolean)
    .join(",");
}

/**
 * @param {object} click A click's modifiers, as {@link clickModifiers} takes them.
 * @returns {boolean} whether they are the Quick Peek's click.
 */
function isQuickPeekClick(click) {
  return clickModifiers(click) === quickPeekClick();
}

/**
 * The tab browser a document is in, when the document is a web page: a
 * privileged page of the browser's own opens no Quick Peek.
 *
 * @param {WindowGlobalParent} wgp
 * @returns {Element|null}
 */
function webBrowserOf(wgp) {
  const type = wgp.domProcess?.remoteType;
  return type && lazy.E10SUtils.isWebRemoteType(type)
    ? wgp.browsingContext.top.embedderElement
    : null;
}

/**
 * The page's address as the bar shows it: its host, then the rest, unescaped
 * for reading, as the address bar unescapes it.
 *
 * @param {nsIURI} uri
 * @returns {{host: string, rest: string}}
 */
function addressOf(uri) {
  const forReading = text => Services.textToSubURI.unEscapeURIForUI(text);
  if (uri.schemeIs("http") || uri.schemeIs("https")) {
    const path = uri.pathQueryRef === "/" ? "" : uri.pathQueryRef;
    return { host: uri.displayHostPort, rest: forReading(path) };
  }
  return { host: "", rest: forReading(uri.displaySpec) };
}

/**
 * One window's open Quick Peek.
 */
class QuickPeek {
  /**
   * @param {Window} win
   * @param {object} owner The tab the Quick Peek opens over.
   * @param {object|null} [from] The pin it opens from, `{ name, icon }`,
   *   which its bar names (pins spec §12.6).
   */
  constructor(win, owner, from = null) {
    this.win = win;
    this.owner = owner;
    this.from = from;
    this.tab = null;
    this.panel = null;
    this.bar = null;
    /** Whether keeping it has begun, after which nothing closes it. */
    this.kept = false;
    /** The address asked for, shown until the page has one. */
    this.href = "";
    /** Stops the bar's loading line following the page. */
    this.stopLine = null;
    this.progress = {
      onLocationChange: (browser, webProgress, request, location, flags) =>
        this.onLocationChange(browser, webProgress, flags),
      onSecurityChange: browser => this.onPageState(browser),
      onContentBlockingEvent: browser => this.onPageState(browser),
    };
  }

  /**
   * Opens `load.href` in a new background tab in the owner's jar, with what
   * Firefox's own link click passes a new tab (`ClickHandlerParent`
   * `contentAreaClick`), and shows its panel over the content area.
   *
   * @param {object} load
   */
  open(load) {
    const { win, owner } = this;
    const { gBrowser, document: doc } = win;
    this.href = load.href;
    const mark = event => markQuickPeek(event.target);
    win.addEventListener("TabOpen", mark, { capture: true });
    try {
      this.tab = gBrowser.addTab(load.href, {
        inBackground: true,
        skipAnimation: true,
        userContextId: owner.userContextId,
        charset: owner.linkedBrowser.characterSet,
        referrerInfo: load.referrerInfo,
        triggeringPrincipal: load.triggeringPrincipal,
        originPrincipal: load.originPrincipal,
        originStoragePrincipal: load.originStoragePrincipal,
        triggeringRemoteType: load.triggeringRemoteType,
        policyContainer: load.policyContainer,
        allowInheritPrincipal: true,
        hasValidUserGestureActivation: true,
        textDirectiveUserActivation: true,
      });
    } finally {
      win.removeEventListener("TabOpen", mark, { capture: true });
    }
    if (!this.tab || !isQuickPeek(this.tab)) {
      return false;
    }
    gBrowser.hideTab(this.tab);

    if (!styled.has(win)) {
      styled.add(win);
      win.windowUtils.loadSheetUsingURIString(
        QUICK_PEEK_CSS,
        win.windowUtils.AUTHOR_SHEET
      );
    }
    this.panel = doc.getElementById(this.tab.linkedPanel);
    this.bar = this.makeBar();
    this.panel.prepend(this.bar);
    this.panel.classList.add("sval-quick-peek-panel");
    gBrowser.tabpanels.setAttribute("sval-quick-peek", "true");
    this.activate();
    this.update();
    this.stopLine = lazy.SvalLoadLine.follow(
      win,
      this.bar.querySelector(".sval-load-line"),
      () => this.tab
    );
    // The page's prompts show while it is open (`PopupNotifications`
    // `_activeBrowser`), in place of the tab's under it.
    win.PopupNotifications.anchorVisibilityChange();

    win.addEventListener("keydown", this, { mozSystemGroup: true });
    win.addEventListener("mousedown", this, true);
    win.addEventListener("command", this, true);
    win.addEventListener("DOMWindowClose", this);
    doc.addEventListener("visibilitychange", this);
    for (const type of [
      "TabSelect",
      "TabClose",
      "TabRemotenessChange",
      "TabAttrModified",
    ]) {
      gBrowser.tabContainer.addEventListener(type, this);
    }
    gBrowser.addTabsProgressListener(this.progress);
    this.tab.linkedBrowser.focus();
    return true;
  }

  /** @returns {Element} the bar over the page (link routing design, F1). */
  makeBar() {
    const doc = this.win.document;
    const bar = htmlElement(doc, "div", { className: "sval-quick-peek-bar" });
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Quick Peek");

    const address = htmlElement(doc, "div", {
      className: "sval-quick-peek-address",
    });
    const shield = htmlElement(doc, "span", {
      className: "sval-prot-glyph sval-quick-peek-shield",
    });
    shield.setAttribute("aria-hidden", "true");
    const url = htmlElement(doc, "span", { className: "sval-quick-peek-url" });
    url.append(
      htmlElement(
        doc,
        "span",
        { className: "sval-quick-peek-host" },
        htmlElement(doc, "bdi", { dir: "ltr" })
      ),
      htmlElement(doc, "span", { className: "sval-quick-peek-rest" })
    );
    address.append(shield, url);

    const copy = htmlElement(doc, "button", {
      className: "sval-quick-peek-copy",
    });
    copy.setAttribute("aria-label", "Copy address");
    copy.title = "Copy address";
    copy.append(
      htmlElement(doc, "span", { className: "sval-quick-peek-copy-icon" })
    );
    copy.addEventListener("click", () => this.copyAddress());

    const split = htmlElement(doc, "button", {
      className: "sval-quick-peek-split",
    });
    split.append(
      htmlElement(doc, "span", { className: "sval-quick-peek-split-icon" }),
      "Open in Split"
    );
    split.addEventListener("click", () => this.keep({ split: true }));

    const asTab = htmlElement(doc, "button", {
      className: "sval-quick-peek-tab",
    });
    asTab.textContent = "Open as tab";
    asTab.addEventListener("click", () => this.keep({ split: false }));

    const close = htmlElement(doc, "button", {
      className: "sval-quick-peek-close",
    });
    close.setAttribute("aria-label", "Close Quick Peek");
    close.title = `Close (${keycap("VK_ESCAPE")})`;
    close.setAttribute(
      "aria-keyshortcuts",
      ariaShortcut({ keycode: "VK_ESCAPE" })
    );
    close.append(
      htmlElement(doc, "span", { className: "sval-quick-peek-close-icon" })
    );
    close.addEventListener("click", () => this.close());

    const loading = lazy.SvalLoadLine.create(doc);
    loading.classList.add("sval-quick-peek-loading");

    bar.append(address, copy, split, asTab, close, loading);
    if (this.from) {
      // A label, not a button: the pin stays selected under the dim.
      const chip = htmlElement(doc, "span", {
        className: "sval-quick-peek-from",
      });
      const icon = htmlElement(doc, "img", {
        className: "sval-quick-peek-from-icon",
      });
      icon.setAttribute("alt", "");
      if (this.from.icon) {
        icon.setAttribute("src", this.from.icon);
      }
      const word = htmlElement(doc, "span", {
        className: "sval-quick-peek-from-word",
      });
      word.textContent = "From";
      const name = htmlElement(doc, "span", {
        className: "sval-quick-peek-from-name",
      });
      name.textContent = this.from.name;
      chip.append(icon, word, " ", name);
      bar.prepend(chip);
    }
    return bar;
  }

  /**
   * Whether "Open in Split" can add the page: it joins the owner's split,
   * or makes one with it, under the split view's limit of pages
   * (`SvalPanelModel.splitHasRoom`), as the panel's own Alt-click does.
   *
   * @param {Element} button
   */
  updateSplit(button) {
    const panel = this.win.SvalPanel;
    const nodes = panel?.nodes ?? {};
    const id = panel?.observer?.nodeIdFor(this.owner);
    const inSplit = isPane(nodes, id);
    const full = inSplit && !splitHasRoom(nodes, nodes[id].placement.parent);
    // Disabled for assistive technology and still hovered, so the tooltip
    // says why. A tab with no node yet has no place in the tree to split at.
    if (full || !id) {
      button.setAttribute("aria-disabled", "true");
    } else {
      button.removeAttribute("aria-disabled");
    }
    let tip = inSplit ? SPLIT_JOIN_TIP : SPLIT_NEW_TIP;
    button.dataset.split = inSplit ? "join" : "new";
    if (full) {
      tip = SPLIT_FULL_TIP;
      button.dataset.split = "full";
    } else if (isPin(this.owner)) {
      tip = SPLIT_PIN_TIP;
      button.dataset.split = "pin";
    }
    button.title = tip;
  }

  /**
   * Copies the page's address without the credentials in it, as Copy
   * address copies a tab's (`SvalTabActions` `copyAddress`).
   */
  copyAddress() {
    const uri = this.uri();
    lazy.copyText(this.win, Services.io.createExposableURI(uri).spec);
  }

  /** @returns {nsIURI} the page's address, or the link's until it commits. */
  uri() {
    const browser = this.tab.linkedBrowser;
    return browser.currentURI?.spec === "about:blank" && this.href
      ? Services.io.newURI(this.href)
      : browser.currentURI;
  }

  /**
   * Keeps the page's browser rendering while it shows, as
   * `showSplitViewPanels` does for a split's panes. A process switch gives
   * the browser a new remote tab, which is made active again. A hidden
   * window's pages stop rendering (`on_visibilitychange` in tabbrowser), and
   * so does the Quick Peek's.
   */
  activate() {
    this.tab.linkedBrowser.docShellIsActive = !this.win.document.hidden;
  }

  /** Draws the address and the shield. */
  update() {
    const { win, tab, bar } = this;
    if (!bar) {
      return;
    }
    const browser = tab.linkedBrowser;
    const { host, rest } = addressOf(this.uri());
    bar.querySelector(".sval-quick-peek-host > bdi").textContent = host;
    bar.querySelector(".sval-quick-peek-rest").textContent = rest;
    bar.querySelector(".sval-quick-peek-address").title = host + rest;

    const shield = bar.querySelector(".sval-quick-peek-shield");
    const { stateOf, shieldOf } = lazy.protection;
    const state = stateOf(win, browser);
    shield.hidden = !state;
    if (state) {
      shield.dataset.icon = shieldOf(state);
      shield.dataset.look = state.look;
      shield.dataset.tone = state.connection.tone ?? "";
    }
    this.updateSplit(bar.querySelector(".sval-quick-peek-split"));
  }

  /** @param {Event} event */
  handleEvent(event) {
    switch (event.type) {
      case "keydown":
        this.onKeyDown(event);
        break;
      case "mousedown":
        this.onMouseDown(event);
        break;
      case "command":
        this.onCommand(event);
        break;
      // The page is not asked whether it may go when what it sat over is
      // gone: a page let stay would be left over another tab.
      case "TabSelect":
        this.close({ skipPermitUnload: true });
        break;
      case "visibilitychange":
        this.activate();
        break;
      // As the window starts to close (`nsGlobalWindowOuter::CloseOuter`),
      // while it is open still: a tab removed from a closed window has no
      // window for the tabs API to name (ext-browser.js `setId`). That is
      // before the session store records the window's tabs, so a reopened
      // window brings back no hidden tab nobody kept. The window's own close
      // has asked its pages whether they may go. A page's `window.close()`
      // reaches here too, from its `<browser>`.
      case "DOMWindowClose":
        if (event.target === this.win) {
          this.close({ skipPermitUnload: true });
        }
        break;
      case "TabClose":
        if (event.target === this.tab) {
          this.teardown();
        } else if (event.target === this.owner) {
          this.close({ skipPermitUnload: true });
        }
        break;
      case "TabRemotenessChange":
        if (event.target === this.tab) {
          this.activate();
        }
        break;
      case "TabAttrModified":
        if (event.target === this.tab) {
          this.update();
        }
        break;
    }
  }

  /**
   * Escape closes the Quick Peek, once the page has had it and left it alone
   * (`_maybeRequestReplyFromRemoteContent`, as the tab strip's keys wait).
   * An open popup has it first.
   *
   * @param {KeyboardEvent} event
   */
  onKeyDown(event) {
    if (
      event.key !== "Escape" ||
      !event.isTrusted ||
      event.defaultPrevented ||
      event.target?.closest?.("menupopup, panel")
    ) {
      return;
    }
    if (lazy.SvalFirefox.awaitsPageReply(this.win, event)) {
      return;
    }
    event.preventDefault();
    this.close();
  }

  /**
   * Close Tab closes the Quick Peek in place of the tab under it, which the user
   * sees as the page in front. The command reaches `mainCommandSet`'s
   * listener in browser-sets.js from its key and its menu item alike.
   *
   * @param {Event} event A `command` event.
   */
  onCommand(event) {
    if (event.target?.id !== "cmd_close") {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.close();
  }

  /**
   * A click anywhere outside the Quick Peek closes it: on the dim, the toolbar or
   * the panel. What the click was on still gets it. A popup, such as a
   * page's select menu or a prompt the Quick Peek's page raised, is no outside.
   * The target is the window's own element, retargeted out of any shadow
   * root: `closest` stops at a shadow root, and a prompt's buttons are
   * `moz-button`s that draw their inner button in one. A dialog the page
   * raised, such as an alert or the ask to open a link in another app, draws
   * in a frame of its own (`SubDialog`), whose press reaches this window
   * with its target in the frame's document. The frame stands in for it.
   *
   * @param {MouseEvent} event
   */
  onMouseDown(event) {
    let { target } = event;
    while (target && target.ownerDocument !== this.win.document) {
      target = target.documentGlobal?.browsingContext?.embedderElement;
    }
    if (
      this.panel?.contains(target) ||
      target?.closest?.("menupopup, panel, tooltip")
    ) {
      return;
    }
    this.close();
  }

  /**
   * The tab under the Quick Peek going to another page ends the Quick Peek, which was
   * about that page. A page that changes its address in place has not gone.
   *
   * @param {Element} browser
   * @param {nsIWebProgress} webProgress
   * @param {number} flags
   */
  onLocationChange(browser, webProgress, flags) {
    if (!webProgress?.isTopLevel) {
      return;
    }
    if (browser === this.tab?.linkedBrowser) {
      if (browser.currentURI?.spec !== "about:blank") {
        this.href = "";
      }
      this.update();
    } else if (
      browser === this.owner.linkedBrowser &&
      !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)
    ) {
      this.close();
    }
  }

  /** @param {Element} browser A page whose security or blocking changed. */
  onPageState(browser) {
    if (browser === this.tab?.linkedBrowser) {
      this.update();
    }
  }

  /**
   * Closes the page. A page that asks to stay (`beforeunload`) and is let
   * stay keeps the Quick Peek open; its `TabClose` is what ends the Quick Peek.
   *
   * @param {object} [options]
   * @param {boolean} [options.skipPermitUnload] Whether the page was asked
   *   already.
   */
  close({ skipPermitUnload = false } = {}) {
    if (this.kept || !this.tab || this.tab.closing) {
      return;
    }
    const { gBrowser } = this.win;
    const focused = this.panel?.contains(this.win.document.activeElement);
    gBrowser.removeTab(this.tab, {
      animate: false,
      skipSessionStore: true,
      skipPermitUnload,
      closeWindowWithLastTab: false,
    });
    if (focused && this.tab.closing) {
      gBrowser.selectedBrowser.focus();
      // A dialog the owner's page opened under the Quick Peek was kept from
      // taking the keyboard (quick-peek-dialog-waits-for-focus.patch).
      gBrowser.getTabDialogBox(gBrowser.selectedBrowser).focus();
    }
  }

  /**
   * Keeps the page: as a tab right after the owner, or in a split with it,
   * in the workspace the window shows, and in the jar it already has.
   *
   * @param {object} options
   * @param {boolean} options.split Whether to split it with the owner.
   */
  async keep({ split }) {
    if (this.kept || this.tab.closing) {
      return;
    }
    if (
      split &&
      this.bar
        .querySelector(".sval-quick-peek-split")
        .hasAttribute("aria-disabled")
    ) {
      return;
    }
    const { win, owner, tab } = this;
    const { gBrowser } = win;
    const panel = win.SvalPanel;
    const observer = panel?.observer;
    if (!observer) {
      return;
    }
    this.kept = true;
    this.teardown();
    gBrowser.showTab(tab);
    // A pin's page is in no place in the tree, so a page kept from it goes
    // where the user's own new tab goes, outside every group (pins spec §5).
    const fromPin = isPin(owner);
    if (!fromPin) {
      gBrowser.moveTabAfter(tab, owner);
    }
    unmarkQuickPeek(tab);
    if (!split) {
      gBrowser.selectedTab = tab;
    }
    const id = await observer.fileTab(
      tab,
      fromPin ? { atTop: true } : { beside: owner }
    );
    // The tab it came from may have closed, or gone to another window, in
    // the meantime; the page is then kept as a tab.
    const ownerId =
      !owner.closing && owner.documentGlobal === win
        ? observer.nodeIdFor(owner)
        : null;
    if (!split || !id || !ownerId) {
      return;
    }
    if (!(await panel.splitBeside(ownerId, id))) {
      SvalLog.warn("a kept Quick Peek stayed a tab: its split was not written");
    }
    // Into its split, unless the user has gone to another tab since.
    if (!tab.closing && gBrowser.selectedTab === owner) {
      gBrowser.selectedTab = tab;
    }
  }

  /** Takes the overlay away and stops listening, leaving the tab. */
  teardown() {
    const { win } = this;
    if (quickPeeks.get(win) !== this) {
      return;
    }
    quickPeeks.delete(win);
    const { gBrowser } = win;
    win.removeEventListener("keydown", this, { mozSystemGroup: true });
    win.removeEventListener("mousedown", this, true);
    win.removeEventListener("command", this, true);
    win.removeEventListener("DOMWindowClose", this);
    win.document.removeEventListener("visibilitychange", this);
    for (const type of [
      "TabSelect",
      "TabClose",
      "TabRemotenessChange",
      "TabAttrModified",
    ]) {
      gBrowser.tabContainer.removeEventListener(type, this);
    }
    gBrowser.removeTabsProgressListener(this.progress);
    gBrowser.tabpanels.removeAttribute("sval-quick-peek");
    this.stopLine?.();
    this.stopLine = null;
    this.bar?.remove();
    this.bar = null;
    this.panel?.classList.remove("sval-quick-peek-panel");
    win.PopupNotifications.anchorVisibilityChange();
  }
}

export const SvalQuickPeek = {
  /**
   * Whether {@link open} would open a Quick Peek over `browser`'s page.
   *
   * @param {Element} browser The page's top-level browser.
   * @param {object} [options]
   * @param {object|null} [options.from] As {@link open} takes it.
   * @returns {boolean}
   */
  canOpen(browser, { from = null } = {}) {
    const win = browser?.documentGlobal;
    const gBrowser = win?.gBrowser;
    const owner = gBrowser?.getTabForBrowser(browser);
    return !(
      (!from && !Services.prefs.getBoolPref(QUICK_PEEK_PREF, true)) ||
      !owner ||
      isQuickPeek(owner) ||
      quickPeeks.has(win) ||
      !canQuickPeekIn(win) ||
      (owner !== gBrowser.selectedTab &&
        !gBrowser.splitViewBrowsers.includes(browser))
    );
  },

  /**
   * "Open Link in Quick Peek" in the page's context menu, after Firefox's "Open
   * Link in Split View". It shows for a link the Quick Peek's click would Quick Peek at:
   * one Firefox can open (`nsContextMenu`'s `onSaveableLink`, which leaves
   * out `mailto:`, `tel:` and `javascript:`), in a web page, that the
   * document may load, where {@link canOpen} agrees. Choosing it opens what
   * the click opens.
   *
   * @param {Window} win A browser window.
   */
  mountLinkItem(win) {
    const doc = win.document;
    const anchor = doc.getElementById("context-openlinkinsplitview");
    if (!anchor) {
      return;
    }
    const item = doc.createXULElement("menuitem");
    item.id = QUICK_PEEK_LINK_ITEM_ID;
    item.className = "context-menu-open-link";
    item.setAttribute("label", "Open Link in Quick Peek");
    item.hidden = true;
    anchor.after(item);
    const quickPeekOf = menu => {
      if (!menu?.onSaveableLink) {
        return null;
      }
      const wgp = menu.actor.manager;
      const browser = webBrowserOf(wgp);
      const load =
        browser &&
        lazy.loadOf(wgp, {
          href: menu.linkURL,
          referrerInfo: menu.contentData.linkReferrerInfo,
          policyContainer: menu.policyContainer,
        });
      return load && this.canOpen(browser) ? { browser, load } : null;
    };
    item.addEventListener("command", () => {
      const quickPeek = quickPeekOf(win.gContextMenu);
      if (quickPeek) {
        this.open(quickPeek.browser, quickPeek.load);
      }
    });
    // On the window, so it runs after the menu's own `popupshowing`, which
    // makes `gContextMenu`.
    win.addEventListener("popupshowing", event => {
      if (event.target.id === "contentAreaContextMenu") {
        item.hidden = !quickPeekOf(win.gContextMenu);
        // Firefox placed the menu's separators for the items it showed
        // (`nsContextMenu.showHideSeparators`), before this ran.
        event.target.showHideSeparators?.();
      }
    });
  },

  /**
   * Opens a Quick Peek for a link clicked in a page with the Quick Peek's click, in
   * Firefox's place: `ClickHandlerParent.contentAreaClick` asks this first,
   * for every click on a link that reaches it (`quick-peek-click.patch`), and
   * opens the link itself when this answers false.
   *
   * @param {WindowGlobalParent} wgp The global of the document clicked in.
   * @param {object} data `ClickHandlerChild`'s `Content:Click`: the button,
   *   the modifiers, whether the click is the user's, and what `linkMessage`
   *   sends. A page's own scripted click opens no Quick Peek, though Firefox
   *   follows one made while the page has the user's activation.
   * @returns {boolean} whether a Quick Peek opened.
   */
  openClick(wgp, data) {
    if (
      !data?.href ||
      !data.isTrusted ||
      data.button !== 0 ||
      !isQuickPeekClick(data)
    ) {
      return false;
    }
    const browser = webBrowserOf(wgp);
    if (!browser || !this.canOpen(browser)) {
      return false;
    }
    const load = lazy.linkLoad(wgp, data);
    return !!load && this.open(browser, load);
  },

  /**
   * Opens a Quick Peek for a link clicked in `browser`'s page, when Quick Peek is on
   * and the page is a tab the window shows, or for a link to another site
   * clicked in a pin's page (`SvalPinParent`), whose own setting decided.
   *
   * @param {Element} browser The page's top-level browser.
   * @param {object} load What `SvalLinkClick` read of the click.
   * @param {object} [options]
   * @param {object|null} [options.from] The pin the link was clicked in,
   *   `{ name, icon }`.
   * @returns {boolean} whether a Quick Peek opened.
   */
  open(browser, load, { from = null } = {}) {
    if (!this.canOpen(browser, { from })) {
      return false;
    }
    const win = browser.documentGlobal;
    const { gBrowser } = win;
    const owner = gBrowser.getTabForBrowser(browser);
    // A click in a pane makes it the one the toolbar drives
    // (`MozTabpanels`), so the Quick Peek is over it.
    if (owner !== gBrowser.selectedTab) {
      gBrowser.selectedTab = owner;
    }
    const quickPeek = new QuickPeek(win, owner, from);
    quickPeeks.set(win, quickPeek);
    try {
      if (quickPeek.open(load)) {
        return true;
      }
    } catch (err) {
      SvalLog.warn(`a Quick Peek did not open: ${SvalLog.errorName(err)}`);
    }
    quickPeek.teardown();
    if (quickPeek.tab && !quickPeek.tab.closing) {
      gBrowser.removeTab(quickPeek.tab, {
        animate: false,
        skipSessionStore: true,
      });
    }
    return false;
  },

  /**
   * The tab of the Quick Peek open in `win`, or null.
   *
   * @param {Window} win
   * @returns {object|null}
   */
  tabOf(win) {
    return quickPeeks.get(win)?.tab ?? null;
  },

  /**
   * Closes the Quick Peek open in `win`, as its close button does.
   *
   * @param {Window} win
   */
  close(win) {
    quickPeeks.get(win)?.close();
  },
};
