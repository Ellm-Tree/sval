/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The loading line: a thin line inside the foot of an address, as long as
 * its page's load has got, which runs to the end and fades once the page has
 * loaded. A window's address field and a Quick Peek's bar each draw one.
 *
 * The length is tabbrowser's own measure of a load, the total progress its
 * `TabProgressListener.onProgressChange` passes to tabs progress listeners,
 * and a load is the tab's `busy` attribute. The length never shrinks during a
 * load: a page that starts more requests lowers the total, and the line
 * would jump back.
 *
 * `sval-header.css` draws the line from two attributes: `loading`, and
 * `instant`, which jumps to the next state with no transition.
 */

import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";

/** @type {WeakMap<Window, Map<Element, () => (Element|null)>>} */
const linesOf = new WeakMap();

/** The furthest each browser's current load has got, from 0 to 1. */
const reached = new WeakMap();

/**
 * Makes `change` with no transition.
 *
 * @param {Element} line
 * @param {() => void} change
 */
function jump(line, change) {
  line.setAttribute("instant", "");
  change();
  // The change takes effect at this style flush, before transitions return.
  line.documentGlobal.getComputedStyle(line).width;
  line.removeAttribute("instant");
}

/**
 * Draws a line for its tab's load.
 *
 * @param {Element} line
 * @param {Element|null} tab
 * @param {boolean} instant Whether to jump with no transition, as on a
 *   switch to another tab, whose load has nothing to do with the last.
 */
function draw(line, tab, instant) {
  const busy = !!tab?.hasAttribute("busy");
  if (busy && !line.hasAttribute("loading")) {
    // A load starts from nothing, wherever the last one's line ended.
    jump(line, () => {
      line.style.setProperty("--sval-load", "0");
      line.setAttribute("loading", "");
    });
  }
  const set = () => {
    line.toggleAttribute("loading", busy);
    const value = busy ? (reached.get(tab.linkedBrowser) ?? 0) : 1;
    line.style.setProperty("--sval-load", String(value));
  };
  if (instant) {
    jump(line, set);
  } else {
    set();
  }
}

/**
 * @param {Window} win
 * @param {Element} browser
 */
function drawFor(win, browser) {
  for (const [line, tabOf] of linesOf.get(win)) {
    const tab = tabOf();
    if (tab?.linkedBrowser === browser) {
      draw(line, tab, false);
    }
  }
}

/**
 * @param {Window} win
 * @returns {Map<Element, () => (Element|null)>} the window's lines.
 */
function watch(win) {
  let lines = linesOf.get(win);
  if (lines) {
    return lines;
  }
  lines = new Map();
  linesOf.set(win, lines);
  const { gBrowser } = win;
  gBrowser.addTabsProgressListener({
    onProgressChange(browser, _wp, _req, _cs, _ms, current, max) {
      const tab = gBrowser.getTabForBrowser(browser);
      if (!max || !tab?.hasAttribute("busy")) {
        return;
      }
      reached.set(
        browser,
        Math.max(reached.get(browser) ?? 0, Math.min(current / max, 1))
      );
      drawFor(win, browser);
    },
  });
  gBrowser.tabContainer.addEventListener("TabAttrModified", event => {
    if (!event.detail.changed.includes("busy")) {
      return;
    }
    const browser = event.target.linkedBrowser;
    if (event.target.hasAttribute("busy")) {
      reached.delete(browser);
    }
    drawFor(win, browser);
  });
  gBrowser.tabContainer.addEventListener("TabSelect", () => {
    for (const [line, tabOf] of lines) {
      draw(line, tabOf(), true);
    }
  });
  return lines;
}

export const SvalLoadLine = {
  /**
   * @param {Document} doc
   * @returns {Element} a line, for its caller to place.
   */
  create(doc) {
    const line = htmlElement(doc, "div", { className: "sval-load-line" });
    line.setAttribute("aria-hidden", "true");
    return line;
  },

  /**
   * Draws `line` for the load of whichever tab `tabOf` names, from now until
   * the returned function is called.
   *
   * @param {Window} win
   * @param {Element} line
   * @param {() => (Element|null)} tabOf
   * @returns {() => void} stops drawing it.
   */
  follow(win, line, tabOf) {
    const lines = watch(win);
    lines.set(line, tabOf);
    draw(line, tabOf(), true);
    return () => lines.delete(line);
  },

  /**
   * The address field's line, for the selected tab. A Peek's field is the
   * same element, so it gets one too.
   *
   * @param {Window} win A browser window, after its delayed startup.
   */
  startWindow(win) {
    const container = win.document.getElementById("urlbar-container");
    if (!container) {
      return;
    }
    const line = this.create(win.document);
    line.id = "sval-load-line";
    container.append(line);
    this.follow(win, line, () => win.gBrowser.selectedTab);
  },
};
