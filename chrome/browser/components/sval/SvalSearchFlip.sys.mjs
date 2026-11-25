/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The address bar's switch between a search results page's search and its
 * address. Firefox shows the search on its results page in the field
 * (`UrlbarSearchTermsPersistence`) with a button that goes to the address
 * one way only (`UrlbarInput.handleRevert`). This button goes both ways, on
 * the page that searched, and turns the field over as it switches, so the
 * two read as sides of one thing.
 *
 * **No search or address is ever logged** (Sval `CONTRIBUTING.md` rule 10).
 */

import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";
import { SvalScope } from "moz-src:///browser/components/sval/SvalScope.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FLOATING: "moz-src:///browser/components/sval/SvalLauncher.sys.mjs",
});

export const FLIP_ID = "sval-urlbar-flip";

/** Each side's name, and the glyph of the side it switches to. */
const SIDES = {
  search: { label: "Show address", icon: "link" },
  address: { label: "Show search", icon: "search" },
};

/** Half the turn, each way: out to edge-on, then back in. */
const HALF_TURN_MS = 110;

/**
 * Per window, the pages whose address was asked for, with the search they
 * show again on the way back.
 *
 * @type {WeakMap<Window, WeakMap<Element, string>>}
 */
const shownAddress = new WeakMap();

export const SvalSearchFlip = {
  /**
   * After the window's delayed startup: the button, before Firefox's own,
   * which `sval-header.css` hides.
   *
   * @param {Window} win A browser window.
   */
  startWindow(win) {
    const { gURLBar, gBrowser } = win;
    const doc = win.document;
    const container = gURLBar?.querySelector(".urlbar-input-container");
    if (!container || doc.getElementById(FLIP_ID)) {
      return;
    }
    shownAddress.set(win, new WeakMap());
    const glyph = doc.createXULElement("image");
    glyph.className = "sval-header-glyph";
    glyph.setAttribute("aria-hidden", "true");
    const button = htmlElement(
      doc,
      "button",
      { id: FLIP_ID, type: "button", hidden: true },
      glyph
    );
    // Before the field hears the press, which would focus it.
    button.addEventListener("mousedown", event => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", () => flip(win));
    const revert = container.querySelector("#urlbar-revert-button-container");
    if (revert) {
      revert.before(button);
    } else {
      container.append(button);
    }

    // The engine's button asks for its icon as the window starts and when
    // the engine changes (`SearchModeSwitcher.updateSearchIcon`). An icon
    // not readable that early shows the glass until it asks again, so it
    // asks each time the field shows a search or opens the Launcher.
    const draw = () => {
      drawButton(win);
      gURLBar.searchModeSwitcher?.updateSearchIcon();
    };
    const lifetime = SvalScope.forWindow(win);
    const observer = new win.MutationObserver(draw);
    observer.observe(gURLBar, {
      attributeFilter: [
        "persistsearchterms",
        "pageproxystate",
        "focused",
        lazy.FLOATING,
      ],
    });
    lifetime.add(() => observer.disconnect());
    const listener = {
      onLocationChange: draw,
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
    };
    gBrowser.addProgressListener(listener);
    lifetime.add(() => gBrowser.removeProgressListener(listener));
    draw();
  },

  /**
   * Puts the field back to the side the page shows, discarding what was
   * typed: the search on a results page, the address once it was asked
   * for, as `UrlbarInput.handleRevert` does for any other page.
   *
   * @param {Window} win
   */
  revert(win) {
    const { gURLBar, gBrowser } = win;
    const search = searchOf(win);
    if (!search || shownAddress.get(win)?.has(gBrowser.selectedBrowser)) {
      gURLBar.handleRevert();
      return;
    }
    gURLBar.searchMode = null;
    showSearch(win, search);
  },
};

/**
 * Shows the page's search in the field: what Firefox does on the results
 * page's first view, the search as though typed, which
 * `UrlbarSearchTermsPersistence.shouldPersist` shows again for the page that
 * searched.
 *
 * @param {Window} win
 * @param {string} search
 */
function showSearch(win, search) {
  const { gURLBar } = win;
  gURLBar.userTypedValue = search;
  gURLBar.setURI({ dueToTabSwitch: true });
  if (gURLBar.focused) {
    gURLBar.select();
  }
}

/**
 * The search the selected page searched for, while it is the page that
 * searched for it.
 *
 * @param {Window} win
 * @returns {string}
 */
function searchOf(win) {
  const state = win.gURLBar.getBrowserState(win.gBrowser.selectedBrowser);
  return state?.persist?.searchTerms ?? "";
}

/** @param {Window} win */
function drawButton(win) {
  const button = win.document.getElementById(FLIP_ID);
  const { gURLBar, gBrowser } = win;
  const browser = gBrowser.selectedBrowser;
  const asked = shownAddress.get(win);
  const search = searchOf(win);
  // A page that is no longer the results page forgets the address was asked
  // for.
  if (asked.has(browser) && asked.get(browser) !== search) {
    asked.delete(browser);
  }
  // Each side as the page shows it: typing in the field drops
  // `persistsearchterms` and leaves the address's proxy state.
  let side = null;
  if (gURLBar.hasAttribute("persistsearchterms")) {
    side = "search";
  } else if (
    asked.has(browser) &&
    gURLBar.getAttribute("pageproxystate") === "valid"
  ) {
    side = "address";
  }
  // The field focused in its row shows Firefox's own view; floating, it is
  // the Launcher, which switches too.
  button.hidden =
    !side || (gURLBar.focused && !gURLBar.hasAttribute(lazy.FLOATING));
  if (!side) {
    return;
  }
  const { label, icon } = SIDES[side];
  button.dataset.side = side;
  button.firstElementChild.dataset.icon = icon;
  button.title = label;
  button.setAttribute("aria-label", label);
}

/**
 * Turns the field over to the other side: the field turns edge-on, the
 * value changes, and it turns back. Where motion is reduced it changes in
 * place.
 *
 * @param {Window} win
 */
async function flip(win) {
  const { gURLBar, gBrowser } = win;
  const browser = gBrowser.selectedBrowser;
  const asked = shownAddress.get(win);
  const box = gURLBar.querySelector(".urlbar-input-box");
  const still = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const turn = async keyframes => {
    if (!still && box) {
      await box.animate(keyframes, {
        duration: HALF_TURN_MS,
        easing: "ease-in-out",
      }).finished;
    }
  };
  await turn([{ transform: "rotateX(0)" }, { transform: "rotateX(90deg)" }]);
  if (gURLBar.hasAttribute("persistsearchterms")) {
    asked.set(browser, searchOf(win));
    gURLBar.handleRevert();
  } else if (asked.has(browser)) {
    const search = asked.get(browser);
    asked.delete(browser);
    showSearch(win, search);
  }
  drawButton(win);
  await turn([{ transform: "rotateX(-90deg)" }, { transform: "rotateX(0)" }]);
}
