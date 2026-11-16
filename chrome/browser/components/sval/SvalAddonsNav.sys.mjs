/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Settings and the add-ons page as one place: Settings' links to add-ons
 * open it in Settings' own tab, and the add-ons page leads back to Settings
 * in that tab, so the tab's Back and Forward move between them.
 *
 * Firefox opens add-ons from Settings with `BrowserAddonUI.openAddonsMgr`,
 * which selects a tab already showing add-ons or opens one
 * (`switchToTabHavingURI`), and the add-ons page opens Settings the same way
 * (`openAboutSettingsInTab`). Sval takes the plain click first and loads the
 * other page in the tab instead. A click with a modifier, which asks for a
 * new tab, is left to Firefox. Routes from outside Settings (the Tools menu,
 * an extension's Manage, an install's prompt) keep Firefox's tab choice.
 */

import { SvalChromePages } from "moz-src:///browser/components/sval/SvalChromePages.sys.mjs";
import { SvalPreferences } from "moz-src:///browser/components/sval/SvalPreferences.sys.mjs";
import {
  HTML_NS,
  htmlElement,
} from "moz-src:///browser/components/sval/SvalDom.sys.mjs";

const ADDONS_URL = "about:addons";
const SETTINGS_URL = "about:preferences";

/**
 * The view each browser asked for on its way to add-ons, applied once the
 * page announces itself (`EM-loaded`, `gViewController.notifyEMLoaded`).
 *
 * @type {WeakMap<Element, string>}
 */
const pendingViews = new WeakMap();

let started = false;

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

/**
 * The view a click in Settings asks add-ons for, or null for a click on no
 * link to add-ons. Firefox's one is a setting's "manage" link
 * (`setting-control`'s `navigateToAddons`); the Extensions category opens
 * add-ons through `openInTab` itself.
 *
 * @param {MouseEvent} event
 * @returns {string|null}
 */
function settingsLinkView(event) {
  for (const node of event.composedPath()) {
    if (node.matches?.("a[data-l10n-name='addons-link']")) {
      return "addons://list/extension";
    }
  }
  return null;
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

/** @param {Document} doc The preferences page, as its root is inserted. */
function mountSettingsPage(doc) {
  const win = doc.defaultView;
  // Before Firefox's own handlers on the button and in `setting-control`,
  // which open add-ons through `openAddonsMgr`.
  doc.addEventListener(
    "click",
    event => {
      if (!isPlainClick(event)) {
        return;
      }
      const view = settingsLinkView(event);
      if (view === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      SvalAddonsNav.openInTab(win, view);
    },
    { capture: true }
  );
}

const loadedObserver = {
  observe(emWindow) {
    const browser = browserOf(emWindow);
    const view = browser && pendingViews.get(browser);
    if (!view) {
      return;
    }
    pendingViews.delete(browser);
    emWindow.loadView(view);
  },
};

export const SvalAddonsNav = {
  /**
   * Loads add-ons in the tab showing `win`, at `view` when one is given.
   *
   * @param {Window} win A page in a tab, Settings.
   * @param {string} [view] An add-ons view id, `addons://list/extension`.
   */
  openInTab(win, view = "") {
    if (view) {
      pendingViews.set(browserOf(win), view);
    }
    win.location.href = ADDONS_URL;
  },

  /** Watches Settings and the add-ons page. Idempotent. */
  start() {
    if (started) {
      return;
    }
    started = true;
    SvalChromePages.on(url => url.startsWith(ADDONS_URL), mountAddonsPage);
    SvalChromePages.on(SvalPreferences.isPreferencesURL, mountSettingsPage);
    Services.obs.addObserver(loadedObserver, "EM-loaded");
  },
};
