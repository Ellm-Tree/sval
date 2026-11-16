/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Holds Firefox's default theme as the only theme.
 *
 * Sval draws its chrome's colours itself (`sval-header.css`), and a workspace's
 * colour tints the window; a theme add-on would paint over both and recolour
 * only part of a header whose shape is drawn in CSS. So a theme is never
 * installed (`SvalExtensionCompat`), the default theme is put back if another
 * is ever enabled, and the add-ons page offers no Themes category.
 *
 * This is done through the add-on manager's listeners rather than an
 * `ExtensionSettings` policy, whose `allowed_types` would do the same but
 * makes every settings page say the browser is managed by an organisation.
 */

import { SvalChromePages } from "moz-src:///browser/components/sval/SvalChromePages.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
});

export const DEFAULT_THEME_ID = "default-theme@mozilla.org";

const ADDONS_URL = "about:addons";
const EXTENSIONS_VIEW = "addons://list/extension";

/**
 * The browser window's menu items Firefox labels "Add-ons and themes". They
 * take a plain label, with Fluent's message dropped, because macOS draws the
 * menu bar natively from the `label` attribute.
 */
const EXTENSIONS_MENU_ITEMS = ["menu_openAddons"];

function relabel(item) {
  item.removeAttribute("data-l10n-id");
  item.setAttribute("label", "Extensions");
}

let started = false;

async function enableDefaultTheme() {
  try {
    const theme = await lazy.AddonManager.getAddonByID(DEFAULT_THEME_ID);
    if (theme && !theme.isActive) {
      await theme.enable();
    }
  } catch (err) {
    SvalLog.warn(`holding the default theme failed: ${SvalLog.errorName(err)}`);
  }
}

const addonListener = {
  onEnabled(addon) {
    if (addon.type === "theme" && addon.id !== DEFAULT_THEME_ID) {
      enableDefaultTheme();
    }
  },
};

/** @param {Document} doc The add-ons page. */
function fitAddonsPage(doc) {
  const win = doc.defaultView;
  // The page reopens the view it last showed, and an address can name the
  // theme list; either way it shows the extensions instead.
  doc.addEventListener("view-selected", event => {
    if (event.detail?.type === "list" && event.detail.param === "theme") {
      win.setTimeout(() => win.loadView(EXTENSIONS_VIEW));
    }
  });
}

export const SvalThemes = {
  /**
   * Labels a browser window's add-ons menu items for extensions alone.
   *
   * @param {Window} win A browser window.
   */
  mount(win) {
    const doc = win.document;
    for (const id of EXTENSIONS_MENU_ITEMS) {
      const item = doc.getElementById(id);
      if (item) {
        relabel(item);
      }
    }
  },

  /** Starts holding the default theme. Idempotent. */
  start() {
    if (started) {
      return;
    }
    started = true;
    lazy.AddonManager.addAddonListener(addonListener);
    SvalChromePages.on(url => url.startsWith(ADDONS_URL), fitAddonsPage);
    enableDefaultTheme();
  },
};
