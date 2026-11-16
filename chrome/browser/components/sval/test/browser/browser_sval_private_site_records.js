/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * Settings opened in a private window keeps no record of a site (private
 * windows spec, site page spec §5): its choices last as long as the window,
 * and an extension's site switch, which is saved and synced, is shown
 * without a way to change it.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_page_helpers.js",
  this
);

const ID = "private-records@sval.invalid";
const SITE = `sval-private-${Math.random().toString(36).slice(2)}.com`;

async function loadExtension() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      name: "Private records test extension",
      browser_specific_settings: { gecko: { id: ID } },
      permissions: ["<all_urls>"],
    },
    useAddonManager: "temporary",
  });
  await extension.startup();
  atTaskEnd(() => extension.unload());
}

/**
 * Opens a settings tab at `url` in `win` and waits for Sval's panes.
 *
 * @param {Window} win
 * @param {string} url
 * @returns {Promise<Window>} The settings page.
 */
async function openSettingsIn(win, url) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, url),
    15_000,
    "the settings tab opening"
  );
  const page = tab.linkedBrowser.contentWindow;
  await until(
    () => page.document?.documentElement?.dataset.svalSettings === "ready",
    "Sval's panes loading"
  );
  return page;
}

/** @returns {string[]} Every pref set this session whose name or value names SITE. */
function prefsNamingSite() {
  return Services.prefs
    .getChildList("")
    .filter(name => Services.prefs.prefHasUserValue(name))
    .filter(
      name =>
        name.includes(SITE) ||
        (Services.prefs.getPrefType(name) === Services.prefs.PREF_STRING &&
          Services.prefs.getStringPref(name, "").includes(SITE))
    );
}

add_task(async function a_private_windows_site_page_leaves_no_record() {
  await loadExtension();
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "the private window opening"
  );
  let closed = false;
  atTaskEnd(() =>
    closed
      ? undefined
      : within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing")
  );

  const ui = await untilSitePage(
    await openSettingsIn(win, PAGE_URL(SITE)),
    SITE
  );
  ok(ui.byId("sval-site-note").checkVisibility(), "the private note shows");
  const row = () =>
    ui.doc.querySelector(
      `[data-site-card="extensions"] [data-extension-id="${ID}"]`
    );
  await until(row, "the extension listed on the site's page");
  ok(!row().querySelector("input"), "with no switch to change");
  is(
    row().querySelector(".sval-site-value").dataset.value,
    "on",
    "showing it on"
  );

  // What the page does offer changes the window's choices alone.
  change(ui.byKey("site-protections"), "off");
  change(ui.byKey("site-media"), "block");
  Assert.deepEqual(prefsNamingSite(), [], "no pref names the site");

  await within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing");
  closed = true;

  const { page } = await openAt("about:preferences#svalSites-sites");
  const sites = partsOf(page);
  await until(sites.sitesShown, "Settings › Sites showing");
  ok(
    !sites.doc.querySelector(`[data-site="${SITE}"]`),
    "the site is not in Settings › Sites"
  );
  Assert.deepEqual(prefsNamingSite(), [], "and no pref names it");
});

add_task(async function a_private_windows_extension_page_takes_no_site() {
  await loadExtension();
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "the private window opening"
  );
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing")
  );
  const page = await openSettingsIn(
    win,
    `about:preferences#svalExtensions-extension?id=${encodeURIComponent(ID)}`
  );
  const card = () =>
    page.document.querySelector('[data-extension-card="sites"]');
  await until(card, "the sites card showing");
  ok(!card().querySelector("input, button"), "no field or switch saves a site");
});
