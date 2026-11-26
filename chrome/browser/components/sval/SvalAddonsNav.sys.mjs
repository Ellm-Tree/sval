/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Settings is where extensions are managed. Every way Firefox opens the
 * add-ons page goes through `BrowserAddonUI.openAddonsMgr`, which Sval's
 * patch hands to `openInSettings`: the Tools menu, an extension's Manage
 * Extension, an install's prompt, an extension asking for its options or
 * its shortcuts. Each lands on the matching place in Settings' Extensions
 * or Keyboard shortcuts category. The kinds of add-on Settings doesn't list
 * (dictionaries, language packs, plugins) keep the add-ons page.
 *
 * The add-ons page, reached by its address, gets a row that leads back to
 * Settings in its tab, so the tab's Back and Forward move between them.
 */

import { SvalChromePages } from "moz-src:///browser/components/sval/SvalChromePages.sys.mjs";
import { SvalPreferences } from "moz-src:///browser/components/sval/SvalPreferences.sys.mjs";
import {
  HTML_NS,
  htmlElement,
} from "moz-src:///browser/components/sval/SvalDom.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
});

const ADDONS_URL = "about:addons";
const SETTINGS_URL = "about:preferences";

let started = false;

/**
 * The Settings place that shows what an add-ons view shows.
 *
 * @param {string} [view] An add-ons view id, `addons://detail/<id>`.
 * @returns {?string} The pane, with its section after a dash, as
 *   `openPreferences` takes it, or null for a view Settings doesn't hold.
 */
export function settingsPaneFor(view) {
  const [, kind = "", param = "", sub = ""] =
    /^addons:\/\/([^/]*)\/?([^/]*)\/?(.*)$/.exec(view ?? "") ?? [];
  const extension = (id, card) =>
    `paneSvalExtensions-extension?${new URLSearchParams(card ? { id, card } : { id })}`;
  switch (kind) {
    case "":
    case "discover":
    case "updates":
    case "search":
      return "paneSvalExtensions";
    case "list":
      return ["extension", "theme"].includes(param)
        ? "paneSvalExtensions"
        : null;
    case "detail":
      return extension(
        decodeURIComponent(param),
        { preferences: "settings", permissions: "permissions" }[sub]
      );
    case "shortcuts":
      return param === "shortcuts"
        ? "paneSvalKeyboard"
        : extension(decodeURIComponent(param), "shortcuts");
  }
  return null;
}

/**
 * @param {MouseEvent} event
 * @returns {boolean} whether `event` is a plain primary click.
 */
function isPlainClick(event) {
  return (
    event.button === 0 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** @param {Window} win A page in a tab. */
function browserOf(win) {
  return win.browsingContext.top.embedderElement;
}

/**
 * The index of the Settings entry the add-ons page in `win` was reached
 * from: the entry before the add-ons page's first, when it is Settings.
 *
 * @param {Window} win The add-ons page.
 * @returns {number} -1 when the tab came to add-ons some other way.
 */
function settingsEntryIndex(win) {
  const history = win.browsingContext.top.sessionHistory;
  if (!history) {
    return -1;
  }
  let index = history.index;
  while (
    index > 0 &&
    history.getEntryAtIndex(index).URI.spec.startsWith(ADDONS_URL)
  ) {
    index--;
  }
  const spec = history.getEntryAtIndex(index).URI.spec;
  return SvalPreferences.isPreferencesURL(spec) ? index : -1;
}

/**
 * Takes the add-ons page in `win` back to Settings in its tab: back through
 * its history to the Settings it came from, or a load of Settings.
 *
 * @param {Window} win The add-ons page.
 */
function backToSettings(win) {
  const index = settingsEntryIndex(win);
  const browser = browserOf(win);
  if (index >= 0) {
    browser.gotoIndex(index);
    return;
  }
  win.location.href = SETTINGS_URL;
}

/**
 * The row above the add-ons page's header that leads back to Settings, in
 * the form of Settings' own way back from a site's page: a round back
 * button, then the crumb.
 *
 * @param {Document} doc The add-ons page.
 * @returns {Element}
 */
function backRow(doc) {
  const nav = htmlElement(doc, "nav", {
    id: "sval-addons-nav",
    className: "sval-addons-nav",
  });
  nav.setAttribute("aria-label", "Breadcrumb");
  const back = htmlElement(doc, "button", {
    id: "sval-addons-back",
    className: "sval-addons-back",
    type: "button",
    title: "Back to Settings",
  });
  back.setAttribute("aria-label", "Back to Settings");
  back.append(
    htmlElement(doc, "span", { className: "sval-addons-back-glyph" })
  );
  back.firstChild.setAttribute("aria-hidden", "true");
  const crumb = htmlElement(doc, "a", {
    id: "sval-addons-crumb",
    href: SETTINGS_URL,
    textContent: "Settings",
  });
  const separator = htmlElement(doc, "span", { textContent: "›" });
  separator.setAttribute("aria-hidden", "true");
  nav.append(back, crumb, separator);
  return nav;
}

/**
 * The line under the crumb that says why finding or installing an add-on
 * opens Mozilla's site.
 *
 * @param {Document} doc The add-ons page.
 * @returns {Element}
 */
function sourceNote(doc) {
  return Object.assign(doc.createElementNS(HTML_NS, "p"), {
    id: "sval-addons-source",
    className: "sval-addons-source",
    textContent:
      "Sval uses Mozilla's add-on catalog, so finding or installing an add-on opens addons.mozilla.org.",
  });
}

/** @param {Document} doc The add-ons page, as its root is inserted. */
function mountAddonsPage(doc) {
  const win = doc.defaultView;
  // Before the sidebar's own handler (`categories-box`'s
  // `#handlePreferencesButton`), which would pick another tab.
  doc.addEventListener(
    "click",
    event => {
      if (!isPlainClick(event)) {
        return;
      }
      const path = event.composedPath();
      if (
        !path.some(
          node =>
            node.id === "preferencesButton" ||
            node.id === "sval-addons-back" ||
            node.id === "sval-addons-crumb"
        )
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      backToSettings(win);
    },
    { capture: true }
  );
  doc.addEventListener(
    "DOMContentLoaded",
    () => {
      const content = doc.getElementById("content");
      content?.prepend(backRow(doc), sourceNote(doc));
    },
    { once: true }
  );
}

export const SvalAddonsNav = {
  /**
   * Opens the Settings place that holds `view`, as `openAddonsMgr` would
   * open the add-ons page at it.
   *
   * @param {Window} win A browser window.
   * @param {string} [view] An add-ons view id.
   * @returns {?Promise<?Window>} Settings' page once it has loaded, which
   *   `openAddonsMgr`'s callers take as the add-ons page, or null for a
   *   view Settings doesn't hold.
   */
  openInSettings(win, view) {
    const pane = settingsPaneFor(view);
    if (!pane) {
      return null;
    }
    return win.openPreferences(pane).then(async () => {
      // A first window `openPreferences` opened is still starting.
      const browser = lazy.SvalPeek.settingsWindow()?.gBrowser?.selectedBrowser;
      if (!browser) {
        return null;
      }
      if (browser.contentDocument?.readyState !== "complete") {
        await new Promise(resolve =>
          browser.addEventListener("load", resolve, {
            capture: true,
            once: true,
          })
        );
      }
      return browser.contentWindow;
    });
  },

  /** Watches the add-ons page. Idempotent. */
  start() {
    if (started) {
      return;
    }
    started = true;
    SvalChromePages.on(url => url.startsWith(ADDONS_URL), mountAddonsPage);
  },
};
