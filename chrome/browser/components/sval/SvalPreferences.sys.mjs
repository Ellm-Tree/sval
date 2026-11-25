/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Puts Sval's settings into `about:preferences` as categories of its own (spec
 * §10.8), from Sval's own files.
 *
 * `document-element-inserted` fires for every document as its root element is
 * inserted, before the parser reaches any `<script>` inside it. Loading
 * `settings-pane.js` into the page at that moment lets it queue its own
 * `DOMContentLoaded` listener ahead of `init_all` in `preferences.js`, which
 * is what lets Sval's categories exist by the time `gotoPref` reads the URL's
 * hash. It costs no patch against `preferences.xhtml`, whose `<head>` Mozilla
 * changes often.
 */

import { SvalChromePages } from "moz-src:///browser/components/sval/SvalChromePages.sys.mjs";

const PANE_SCRIPTS = [
  "chrome://browser/content/sval/settings-helpers.js",
  "chrome://browser/content/sval/settings.js",
  "chrome://browser/content/sval/settings-ui.js",
  "chrome://browser/content/sval/settings-storage.js",
  "chrome://browser/content/sval/settings-sync-status.js",
  "chrome://browser/content/sval/settings-pairing.js",
  "chrome://browser/content/sval/settings-blocking.js",
  "chrome://browser/content/sval/settings-sites.js",
  "chrome://browser/content/sval/settings-tracking.js",
  "chrome://browser/content/sval/settings-fingerprinting.js",
  "chrome://browser/content/sval/settings-agents.js",
  "chrome://browser/content/sval/settings-agent-policy.js",
  "chrome://browser/content/sval/settings-passwords.js",
  "chrome://browser/content/sval/settings-kagi.js",
  "chrome://browser/content/sval/settings-appearance.js",
  "chrome://browser/content/sval/settings-advanced.js",
  "chrome://browser/content/sval/settings-site-page.js",
  "chrome://browser/content/sval/settings-secure-dns.js",
  "chrome://browser/content/sval/settings-cookies.js",
  "chrome://browser/content/sval/settings-site-defaults.js",
  "chrome://browser/content/sval/settings-archive.js",
  "chrome://browser/content/sval/settings-warnings.js",
  "chrome://browser/content/sval/settings-battery-saver.js",
  "chrome://browser/content/sval/settings-favorites.js",
  "chrome://browser/content/sval/settings-keyboard.js",
  "chrome://browser/content/sval/settings-extensions.js",
  "chrome://browser/content/sval/settings-links.js",
  "chrome://browser/content/sval/settings-pane.js",
];

/**
 * The addresses `about:preferences` answers to. `about:settings` is the same
 * page under its other name (`AboutRedirector.cpp`'s `kRedirMap`).
 */
const PREFERENCES_URLS = ["about:preferences", "about:settings"];

/**
 * Whether `spec` is the preferences page, whatever its hash or query.
 *
 * @param {string} spec
 * @returns {boolean}
 */
function isPreferencesURL(spec) {
  return PREFERENCES_URLS.some(
    url =>
      spec === url || spec.startsWith(`${url}#`) || spec.startsWith(`${url}?`)
  );
}

let watching = false;

function addPanes(doc) {
  for (const url of PANE_SCRIPTS) {
    Services.scriptloader.loadSubScript(url, doc.defaultView);
  }
}

export const SvalPreferences = {
  isPreferencesURL,

  /**
   * The form data the session store may keep and put back for a tab, or null
   * for Settings'. The session store sets each saved field back once the page
   * loads and fires `input` on it (`SessionStoreUtils::RestoreFormData`), and
   * a switch or field in Settings writes its pref on `input`. Settings' saved
   * fields are the prefs as they were when the tab was last saved, so putting
   * them back would undo every change made since. The prefs are what Settings
   * shows, so nothing of Settings needs keeping.
   *
   * @param {?object} formdata A tab's `formdata`, whose `url` is its page's
   *   address without the fragment.
   * @returns {?object}
   */
  restorableFormData(formdata) {
    return formdata && isPreferencesURL(formdata.url ?? "") ? null : formdata;
  },

  watch() {
    if (watching) {
      return;
    }
    watching = true;
    SvalChromePages.on(isPreferencesURL, addPanes);
  },
};
