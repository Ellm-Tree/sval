/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Launcher's float (launcher spec §3, §6, §7).
 *
 * ⌘L (Ctrl+L), Alt+D and the menu's Open Location run `Browser:OpenLocation`,
 * and that floats the address bar: the same `#urlbar`, its view and its
 * query, placed centred over the page under a scrim, with the field's text
 * selected. A click on the field and F6 reach it without that command, so
 * they open it in place. Firefox keeps `#urlbar` in the top layer as a
 * popover once it can break out of the toolbar (`UrlbarInput`'s
 * `#updateLayoutBreakoutDimensions`), so `sval-launcher.css` can place it
 * anywhere over the window; where it cannot, the address bar opens in place.
 *
 * While it floats, the toolbar's pill keeps showing the page's address
 * (`#sval-launcher-address`), and a screen reader still meets the address
 * bar's own combobox, with focus in it: the float is a place, not a dialog.
 * Escape (outside a command's choices, which step back first), a click on
 * the scrim and a pick return the field to the toolbar; Escape and the scrim
 * hand focus to the page, as a pick does by loading it. Focus leaving the
 * field and its search-mode switcher another way ends the float too.
 *
 * While the floating field holds the page's address as the float opened on
 * it, a pill set at its end copies that address, whole or clean
 * (`SvalTabActions`), and closes the float. `sval-launcher.css` hides it once
 * the field holds anything else.
 *
 * **No address or query is ever logged** (Sval `CONTRIBUTING.md` rule 10).
 */

import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUIUtils: "resource:///modules/BrowserUIUtils.sys.mjs",
  CLEAN_ADDRESS_NAME:
    "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs",
  COPY_ADDRESS_KEY: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  copyAddress: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
  copyCleanAddress: "moz-src:///browser/components/sval/SvalTabActions.sys.mjs",
  URLBAR_KEY_ID: "moz-src:///browser/components/sval/SvalHeader.sys.mjs",
  SvalLauncherCommands:
    "moz-src:///browser/components/sval/SvalLauncherCommands.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  UrlbarPrefs: "moz-src:///browser/components/urlbar/UrlbarPrefs.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  LAUNCHER_KEY: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  ariaShortcut: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  keyOf: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
  shortcutText: "moz-src:///browser/components/sval/SvalKeys.sys.mjs",
});

const LAUNCHER_CSS = "chrome://browser/content/sval/sval-launcher.css";

/** The attribute `#urlbar` carries while it floats. */
export const FLOATING = "sval-launcher-floating";

const SCRIM_ID = "sval-launcher-scrim";
const ADDRESS_ID = "sval-launcher-address";
const KEY_CAP_ID = "sval-launcher-key";
const COPIES_ID = "sval-launcher-copies";
export const COPY_ADDRESS_BUTTON_ID = "sval-launcher-copy-address";
export const COPY_CLEAN_ADDRESS_BUTTON_ID = "sval-launcher-copy-clean-address";

/** The float's card, by the Launcher's design: its width, at most. */
const CARD_WIDTH = 760;
/** How far below the toolbar the card's top sits. */
const CARD_DROP = 72;
/** The least room the card leaves either side of it in a narrow window. */
const CARD_MARGIN = 16;
/** How long the card takes to fade on close (the design's motion). */
const CLOSE_MS = 100;

/**
 * What each window's float keeps: the scrim, the toolbar's copy of the
 * address, and the fade a close is running, if any.
 *
 * @type {WeakMap<Window, {scrim: Element, address: Element,
 *   fading: Animation|null}>}
 */
const windows = new WeakMap();

/** The windows that have the Launcher's strings. */
const mounted = new WeakSet();

/**
 * The page's address as the toolbar's pill shows it while the field is not
 * focused: `SvalHeader`'s shortened address where it draws one, nothing on
 * a page the field leaves blank, and the address as the field shows it
 * otherwise.
 *
 * @param {Window} win
 * @returns {string}
 */
function addressShown(win) {
  if (win.gURLBar.hasAttribute("sval-domain-only")) {
    const label = win.document.getElementById("sval-urlbar-domain");
    return [".sval-urlbar-host", ".sval-urlbar-tail"]
      .map(part => label.querySelector(part).textContent)
      .join("");
  }
  let uri = win.gBrowser.currentURI;
  try {
    uri = Services.io.createExposableURI(uri);
  } catch {}
  if (win.isInitialPage(uri)) {
    return "";
  }
  const readable = win.gURLBar.makeURIReadable(uri).displaySpec;
  return lazy.UrlbarPrefs.get("trimURLs")
    ? lazy.BrowserUIUtils.trimURL(readable)
    : readable;
}

/**
 * Places the card and the scrim over the content area: the scrim covers the
 * tab box, never the toolbar or the panel, and the card is centred on it.
 *
 * @param {Window} win
 */
function place(win) {
  const state = windows.get(win);
  const urlbar = win.gURLBar;
  const area = win.gBrowser.tabbox.getBoundingClientRect();
  const width = Math.max(0, Math.min(CARD_WIDTH, area.width - 2 * CARD_MARGIN));
  urlbar.style.setProperty("--sval-launcher-width", `${width}px`);
  urlbar.style.setProperty(
    "--sval-launcher-left",
    `${area.left + (area.width - width) / 2}px`
  );
  urlbar.style.setProperty("--sval-launcher-top", `${area.top + CARD_DROP}px`);
  Object.assign(state.scrim.style, {
    left: `${area.left}px`,
    top: `${area.top}px`,
    width: `${area.width}px`,
    height: `${area.height}px`,
  });
}

/**
 * The pill set that copies the page's address, whole or clean, at the
 * field's end. A press keeps focus in the field, which would otherwise end
 * the float before the click; the click closes the float with focus on the
 * page, then copies, so the copy's confirmation outlives the close.
 *
 * @param {Window} win
 * @returns {Element}
 */
function buildCopies(win) {
  const doc = win.document;
  const button = (id, icon, copy) => {
    const el = htmlElement(doc, "button", {
      type: "button",
      id,
      className: "sval-launcher-copy",
      dataset: { icon },
    });
    el.addEventListener("mousedown", event => event.preventDefault());
    el.addEventListener("click", () => {
      SvalLauncher.close(win, { focusPage: true });
      copy(win);
    });
    return el;
  };
  const clean = button(
    COPY_CLEAN_ADDRESS_BUTTON_ID,
    "clean-address",
    lazy.copyCleanAddress
  );
  clean.title = lazy.CLEAN_ADDRESS_NAME;
  return htmlElement(
    doc,
    "div",
    { id: COPIES_ID, attrs: { role: "group", "aria-label": "Copy" } },
    button(COPY_ADDRESS_BUTTON_ID, "copy", lazy.copyAddress),
    clean
  );
}

/**
 * Names Copy Address's button with its key as it is now, which Settings ›
 * Keyboard may have changed or cleared.
 *
 * @param {Window} win
 */
function refreshCopyTitle(win) {
  const doc = win.document;
  const button = doc.getElementById(COPY_ADDRESS_BUTTON_ID);
  const key = doc.getElementById(lazy.COPY_ADDRESS_KEY);
  button.title = "Copy Address";
  button.removeAttribute("aria-keyshortcuts");
  if (key?.getAttribute("key") || key?.getAttribute("keycode")) {
    button.title += ` (${lazy.shortcutText(lazy.keyOf(key))})`;
    button.setAttribute(
      "aria-keyshortcuts",
      lazy.ariaShortcut(lazy.keyOf(key))
    );
  }
}

/**
 * Makes a window's scrim and toolbar address, and listens for what ends the
 * float, once per window.
 *
 * @param {Window} win
 * @returns {object} The window's state.
 */
function prepare(win) {
  let state = windows.get(win);
  if (state) {
    return state;
  }
  const doc = win.document;
  const urlbar = win.gURLBar;

  const scrim = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  scrim.id = SCRIM_ID;
  scrim.setAttribute("aria-hidden", "true");
  // Before the press can move focus out of the field, which would end the
  // float without handing focus to the page.
  scrim.addEventListener("mousedown", event => {
    event.preventDefault();
    SvalLauncher.close(win, { focusPage: true });
  });
  doc.getElementById("browser").append(scrim);

  // Drawn by `sval-launcher.css` in the toolbar's pill while the field
  // floats; the field itself keeps the address for screen readers.
  const address = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
  address.id = ADDRESS_ID;
  address.setAttribute("aria-hidden", "true");
  urlbar.parentNode.append(address);

  urlbar.inputField.closest(".urlbar-input-box").after(buildCopies(win));

  state = { scrim, address, fading: null };
  windows.set(win, state);

  // In the capture phase on the field, ahead of `UrlbarController`, which
  // would close only the view. A command's choices step back on Escape
  // (`SvalLauncherCommands`), so they keep it.
  urlbar.inputField.addEventListener(
    "keydown",
    event => {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        !urlbar.hasAttribute(FLOATING) ||
        lazy.SvalLauncherCommands.providersFor(urlbar)
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      SvalLauncher.close(win, { focusPage: true });
    },
    true
  );
  // The field's search-mode switcher and its list are the Launcher's too
  // (`SearchModeSwitcher`), so focus moving among them keeps the float. The
  // list's XUL panel takes focus with no `relatedTarget` and leaves the
  // document's `activeElement` outside `#urlbar` while it shows, so an open
  // list counts as inside, and where focus went is read once the move is
  // done: a pick focuses the field in the same task
  // (`SearchModeSwitcher#remoteSearch`).
  const list = () => urlbar.querySelector(".searchmode-switcher-panel-list");
  const stillInside = () =>
    doc.hasFocus() && (!!list()?.open || urlbar.contains(doc.activeElement));
  const closeUnlessInside = () =>
    Services.tm.dispatchToMainThread(() => {
      if (!stillInside()) {
        SvalLauncher.close(win);
      }
    });
  urlbar.addEventListener("focusout", event => {
    if (event.relatedTarget) {
      if (!urlbar.contains(event.relatedTarget)) {
        SvalLauncher.close(win);
      }
      return;
    }
    closeUnlessInside();
  });
  // A list opened by a click and closed without a pick hands focus to
  // nothing (`PanelList.hide` restores it only to a focused trigger), and
  // the field takes it back, as `SearchModeSwitcher` does for its button.
  urlbar.addEventListener("hidden", event => {
    if (
      event.target !== list() ||
      !urlbar.hasAttribute(FLOATING) ||
      !doc.hasFocus()
    ) {
      return;
    }
    Services.tm.dispatchToMainThread(() => {
      const active = doc.activeElement;
      if (!active || active === doc.documentElement || active === doc.body) {
        urlbar.focus();
      }
      closeUnlessInside();
    });
  });
  urlbar.controller.addListener({
    // `launcher-float.patch` says whether a row was picked; a view that
    // closes for want of rows leaves the float open to type into.
    onViewClose: ({ elementPicked = false } = {}) => {
      if (!elementPicked || !urlbar.hasAttribute(FLOATING)) {
        return;
      }
      // After `UrlbarInput.pickResult` has recorded the pick. Focus leaving
      // the field first records the session as abandoned
      // (`UrlbarController`'s `engagementEvent`), and the picked row's
      // provider is never told of it (`onEngagement`), which is all a
      // command's row does.
      Services.tm.dispatchToMainThread(() => {
        if (urlbar.hasAttribute(FLOATING)) {
          SvalLauncher.close(win, { focusPage: urlbar.focused });
        }
      });
    },
  });
  win.addEventListener("resize", () => {
    if (urlbar.hasAttribute(FLOATING) && !state.fading) {
      place(win);
    }
  });
  const update = () => {
    if (urlbar.hasAttribute(FLOATING)) {
      address.textContent = addressShown(win);
    }
  };
  const listener = {
    onLocationChange: update,
    QueryInterface: ChromeUtils.generateQI([
      "nsIWebProgressListener",
      "nsISupportsWeakReference",
    ]),
  };
  win.gBrowser.addProgressListener(listener);
  win.addEventListener(
    "unload",
    () => win.gBrowser.removeProgressListener(listener),
    { once: true }
  );
  return state;
}

/** The placeholders Firefox writes outside a search mode. */
const FIREFOX_PLACEHOLDERS = new Set([
  "urlbar-placeholder",
  "urlbar-placeholder-with-name",
]);

/**
 * Writes Sval's placeholder into the field when it shows Firefox's, leaving a
 * search mode's or a command's choices' placeholder alone.
 *
 * @param {Window} win
 */
function refreshPlaceholder(win) {
  const field = win.gURLBar?.inputField;
  if (field && FIREFOX_PLACEHOLDERS.has(field.getAttribute("data-l10n-id"))) {
    const { id, args } = SvalLauncher.placeholder(win);
    win.document.l10n.setAttributes(field, id, args);
  }
}

/**
 * The Launcher's key as the user sees it, or "" when it is cleared.
 *
 * @param {Document} doc A browser window's document.
 * @returns {string}
 */
export function launcherKeyText(doc) {
  const key = doc.getElementById(lazy.LAUNCHER_KEY);
  if (!(key?.getAttribute("key") || key?.getAttribute("keycode"))) {
    return "";
  }
  return lazy.shortcutText(lazy.keyOf(key));
}

/**
 * Names the Launcher's key as it is now in a key cap at the field's end, in
 * the cap `SvalHeader` draws beside a shortened address, and in the field's
 * `aria-keyshortcuts` (launcher spec §8). `sval-launcher.css` shows the
 * field's cap while the field is empty and waits. A cleared key hides both.
 *
 * @param {Window} win
 */
function refreshKeyCap(win) {
  const doc = win.document;
  const field = win.gURLBar?.inputField;
  const box = field?.closest(".urlbar-input-box");
  if (!box) {
    return;
  }
  let cap = doc.getElementById(KEY_CAP_ID);
  if (!cap) {
    cap = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    cap.id = KEY_CAP_ID;
    cap.className = "sval-keycap";
    cap.setAttribute("aria-hidden", "true");
    box.after(cap);
  }
  const text = launcherKeyText(doc);
  const addressCap = doc.getElementById(lazy.URLBAR_KEY_ID);
  if (addressCap) {
    addressCap.textContent = text;
  }
  cap.hidden = !text;
  cap.textContent = text;
  if (text) {
    field.setAttribute(
      "aria-keyshortcuts",
      lazy.ariaShortcut(lazy.keyOf(doc.getElementById(lazy.LAUNCHER_KEY)))
    );
  } else {
    field.removeAttribute("aria-keyshortcuts");
  }
}

export const SvalLauncher = {
  /**
   * `browser-window-before-initial-xul-layout`: the Launcher's stylesheet,
   * after the header's (`SvalHeader.mount`), whose address bar it draws
   * open, and the Open Location command, answered here on its element
   * before `mainCommandSet`'s listener runs Firefox's `openLocation`.
   *
   * @param {Window} win A browser window.
   */
  mount(win) {
    win.windowUtils.loadSheetUsingURIString(
      LAUNCHER_CSS,
      win.windowUtils.AUTHOR_SHEET
    );
    const doc = win.document;
    doc
      .getElementById("Browser:OpenLocation")
      ?.addEventListener("command", event => {
        event.stopImmediatePropagation();
        SvalLauncher.open(win, { floating: true, event });
      });
    mounted.add(win);
    // The field wrote Firefox's placeholder while the window parsed
    // (`launcher-float.patch`), and the key's letter comes from Fluent
    // (`location-open-shortcut`), so Sval's are written once both are in.
    doc.l10n.ready
      .then(() => {
        refreshPlaceholder(win);
        refreshKeyCap(win);
        // Settings › Keyboard rewrites the key's own attributes
        // (`CustomKeys.changeKey`), and tells no one.
        const key = doc.getElementById(lazy.LAUNCHER_KEY);
        if (key) {
          new win.MutationObserver(() => refreshKeyCap(win)).observe(key, {
            attributes: true,
            attributeFilter: ["key", "keycode", "modifiers"],
          });
        }
      })
      .catch(err =>
        lazy.SvalLog.error(
          `the Launcher's placeholder failed: ${lazy.describeError(err)}`
        )
      );
  },

  /**
   * Opens the Launcher as Firefox's `openLocation` opens the address bar,
   * with the field's text selected and the view open on what it holds:
   * floating over the page, or in the toolbar.
   *
   * @param {Window} win
   * @param {object} options
   * @param {boolean} options.floating
   * @param {Event} options.event The command that opens it, which the view
   *   opens for (`UrlbarView.autoOpen`).
   */
  open(win, { floating, event }) {
    const urlbar = win.gURLBar;
    if (floating && urlbar.hasAttribute("breakout")) {
      const state = prepare(win);
      state.fading?.cancel();
      state.fading = null;
      state.address.textContent = addressShown(win);
      refreshCopyTitle(win);
      place(win);
      urlbar.setAttribute(FLOATING, "");
      state.scrim.setAttribute("open", "");
    } else {
      this.close(win);
    }
    win.openLocation(event);
  },

  /**
   * Returns a floating field to the toolbar, the card fading out as it goes.
   *
   * @param {Window} win
   * @param {object} [options]
   * @param {boolean} [options.focusPage] Whether focus goes to the page, the
   *   field's view closing and its text going back to the page's address.
   */
  close(win, { focusPage = false } = {}) {
    const urlbar = win.gURLBar;
    const state = windows.get(win);
    if (!state || !urlbar.hasAttribute(FLOATING) || state.fading) {
      return;
    }
    state.scrim.removeAttribute("open");
    // The design's close fades the card. It stays where it floated until
    // the fade ends, then takes its place in the toolbar again.
    const fading = urlbar.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: CLOSE_MS,
    });
    state.fading = fading;
    fading.finished.then(
      () => {
        if (state.fading === fading) {
          state.fading = null;
          urlbar.removeAttribute(FLOATING);
        }
      },
      // Cancelled by a new open, which keeps the float.
      () => {}
    );
    if (focusPage) {
      urlbar.view.close();
      urlbar.handleRevert();
      win.gBrowser.selectedBrowser.focus();
    }
  },

  /**
   * The address bar's placeholder (`launcher-float.patch`). The Launcher's
   * key is in the key cap beside it ({@link refreshKeyCap}).
   *
   * @param {Window} win
   * @returns {{id: string, args?: object}|null} null before the window has
   *   the Launcher's strings ({@link SvalLauncher.mount}).
   */
  placeholder(win) {
    if (!mounted.has(win)) {
      return null;
    }
    return { id: "launcher-placeholder" };
  },

  /**
   * Whether `win`'s address bar floats, a close's fade aside.
   *
   * @param {Window} win
   * @returns {boolean}
   */
  isFloating(win) {
    return !!win.gURLBar?.hasAttribute(FLOATING) && !windows.get(win)?.fading;
  },
};
