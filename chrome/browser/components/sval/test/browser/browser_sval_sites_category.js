/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */

/**
 * Settings › Sites (decision 1484): a category of its own after Privacy and
 * protection, with the defaults every site gets above one list of every site
 * with a choice. The defaults are the prefs Firefox's own dialogs and Sval's
 * buttons write, a site with only a JavaScript rule has a row, and a row's
 * reset takes its JavaScript rule and permissions with Undo.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SvalJavascript, SITE_BRANCH: JS_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalJavascript.sys.mjs"
);
const { SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);

const SITE = "example.com";

/** The prefs the defaults write, as this file found them. */
const DEFAULT_PREFS = [
  "javascript.enabled",
  "permissions.default.camera",
  "permissions.default.geo",
  "permissions.default.desktop-notification",
  "dom.disable_open_during_load",
  "dom.security.framebusting_intervention.enabled",
];
keepPrefs(...DEFAULT_PREFS);

function reset() {
  clearPrefBranches(SITE_BRANCH, JS_BRANCH);
  Services.perms.removeAll();
  for (const name of DEFAULT_PREFS) {
    Services.prefs.clearUserPref(name);
  }
}

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel starting");
  registerCleanupFunction(reset);
});

/**
 * Opens settings on Sites, with its defaults drawn.
 *
 * @returns {Promise<object>} `openSettings`' result, with `group`, the
 *   defaults, and `row(site)`.
 */
async function openSites() {
  await panelWithFolder(null);
  const ui = await openPane(
    "svalSites",
    ({ page }) =>
      page.document.querySelector(
        'setting-group[groupid="svalSiteDefaults"] sval-permission-default'
      ) && page.document.getElementById("sval-sites")?.checkVisibility(),
    "Sites is showing with its defaults"
  );
  return {
    ...ui,
    group: ui.page.document.querySelector(
      'setting-group[groupid="svalSiteDefaults"]'
    ),
    row: site =>
      ui.page.document.querySelector(`#sval-sites-body [data-site="${site}"]`),
  };
}

/**
 * @param {Element} select A `select`.
 * @param {string} value
 */
function choose(select, value) {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Picks a state from a permission default's menu, as a click on its pill
 * and then on the item would.
 *
 * @param {Element} row A `sval-permission-default`.
 * @param {string} value
 */
async function pick(row, value) {
  const doc = row.ownerDocument;
  const shown = BrowserTestUtils.waitForEvent(doc, "popupshown");
  row.querySelector("button").click();
  const { target: menu } = await within(shown, 5_000, "the pill's menu");
  const index = row.choices.findIndex(([choice]) => choice === value);
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.activateItem(menu.children[index]);
  await within(hidden, 5_000, "the menu closing");
}

add_task(async function sites_holds_the_defaults_then_the_list() {
  reset();
  const ui = await openSites();
  const nav = [...ui.byId("categories").children].map(el => el.id);
  Assert.equal(
    nav.indexOf("category-svalSites"),
    nav.indexOf("category-privacy") + 1,
    "Sites follows Privacy and protection in the nav"
  );
  const named = ui.byId("category-svalSites").textContent.trim();
  Assert.ok(named, "the nav names the category");
  Assert.equal(
    paneOf(ui.page, "svalSites").querySelector(".sval-pane-title").textContent,
    named,
    "and the pane's title is the nav's name"
  );
  Assert.ok(
    ui.group.compareDocumentPosition(ui.byId("sval-sites")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    "the defaults are above the list"
  );
  const controls = [
    ...ui.group.querySelectorAll(
      "moz-checkbox, moz-toggle, sval-segments-default, sval-permission-default"
    ),
  ]
    .filter(el => el.checkVisibility())
    .map(el => el.id);
  for (const id of [
    "svalSiteJavascript",
    "svalSiteMedia",
    "svalSiteDefault-geo",
    "svalSiteDefault-camera",
    "svalSiteDefault-microphone",
    "svalSiteDefault-desktop-notification",
    "svalSiteDefault-xr",
    "svalSiteDefault-popup",
  ]) {
    Assert.ok(controls.includes(id), `the defaults offer ${id}`);
  }
  Assert.ok(
    !ui.byId("sval-js") && !ui.byId("sval-js-sites"),
    "JavaScript has no card of its own"
  );
});

add_task(async function a_permission_default_is_firefoxs_pref() {
  reset();
  const ui = await openSites();
  const camera = ui.group.querySelector(
    "sval-permission-default#svalSiteDefault-camera"
  );
  Assert.deepEqual(
    camera.choices.map(([value]) => value),
    [
      String(Services.perms.UNKNOWN_ACTION),
      String(Services.perms.ALLOW_ACTION),
      String(Services.perms.DENY_ACTION),
    ],
    "Ask, Allow and Block, as the site menu offers"
  );
  Assert.equal(camera.value, "0", "sites ask by default");
  const principal =
    Services.scriptSecurityManager.createContentPrincipalFromOrigin(
      `https://${SITE}`
    );
  const cameraFor = () =>
    SitePermissions.getForPrincipal(principal, "camera").state;
  await pick(camera, "1");
  Assert.equal(
    cameraFor(),
    SitePermissions.ALLOW,
    "Allow lets a site with no choice use the camera"
  );
  await pick(camera, "2");
  Assert.equal(
    cameraFor(),
    SitePermissions.BLOCK,
    "Block refuses a site with no choice"
  );
  await pick(camera, "0");
  Assert.equal(cameraFor(), SitePermissions.UNKNOWN, "and Ask asks it again");

  Services.prefs.setIntPref("permissions.default.geo", 2);
  const geo = ui.group.querySelector(
    "sval-permission-default#svalSiteDefault-geo"
  );
  await TestUtils.waitForCondition(
    () => geo.value === "2",
    "a default changed elsewhere moves the pill"
  );
});

add_task(async function the_popup_default_is_firefoxs_policy() {
  reset();
  const ui = await openSites();
  const popup = ui.group.querySelector(
    "sval-permission-default#svalSiteDefault-popup"
  );
  Assert.deepEqual(
    popup.choices.map(([value]) => value),
    [String(SitePermissions.ALLOW), String(SitePermissions.BLOCK)],
    "Allow and Block, as the site menu offers"
  );
  Assert.equal(
    popup.value,
    String(SitePermissions.BLOCK),
    "blocked by default"
  );
  await pick(popup, String(SitePermissions.ALLOW));
  Assert.ok(
    !Services.prefs.getBoolPref("dom.disable_open_during_load"),
    "Allow lets pop-ups open"
  );
  await pick(popup, String(SitePermissions.BLOCK));
  Assert.ok(Services.prefs.getBoolPref("dom.disable_open_during_load"));
});

add_task(async function the_javascript_default_and_a_sites_rule() {
  reset();
  const ui = await openSites();
  const js = ui.group.querySelector("moz-toggle#svalSiteJavascript");
  Assert.ok(js.pressed, "JavaScript runs on every site by default");
  js.buttonEl.click();
  await TestUtils.waitForCondition(
    () => !Services.prefs.getBoolPref("javascript.enabled"),
    "the switch writes the default"
  );
  js.buttonEl.click();
  await TestUtils.waitForCondition(
    () => Services.prefs.getBoolPref("javascript.enabled"),
    "and back"
  );

  // As the JavaScript button or sync would.
  SvalJavascript.setEnabled(SITE, false);
  await TestUtils.waitForCondition(() => ui.row(SITE), "the site's row");
  Assert.equal(
    ui.row(SITE).querySelector(".sval-sites-summary").dataset.differs,
    "javascript:block",
    "its rule is what differs"
  );
});

add_task(async function reset_takes_javascript_and_permissions_with_undo() {
  reset();
  const principal =
    Services.scriptSecurityManager.createContentPrincipalFromOrigin(
      `https://${SITE}`
    );
  Services.perms.addFromPrincipal(
    principal,
    "camera",
    Services.perms.ALLOW_ACTION
  );
  SvalJavascript.setEnabled(SITE, false);
  const ui = await openSites();
  await TestUtils.waitForCondition(() => ui.row(SITE), "the site's row");
  Assert.equal(
    ui.row(SITE).querySelector(".sval-sites-summary").dataset.differs,
    `javascript:block camera:${Services.perms.ALLOW_ACTION}`,
    "the row says what the site may do"
  );
  ui.row(SITE).querySelector(".sval-sites-reset").click();
  await TestUtils.waitForCondition(() => !ui.row(SITE), "the row going");
  Assert.ok(!SvalJavascript.rules().has(SITE), "the rule is reset");
  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(principal, "camera"),
    Services.perms.UNKNOWN_ACTION,
    "and the permission"
  );
  ui.byId("sval-sites-status").querySelector("button").click();
  await TestUtils.waitForCondition(() => ui.row(SITE), "Undo brings it back");
  Assert.equal(SvalJavascript.rules().get(SITE), "block");
  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(principal, "camera"),
    Services.perms.ALLOW_ACTION
  );
});

/**
 * The defaults file grants addons.mozilla.org the install permission. Its
 * site's row names the host that holds it and says the grant is Sval's
 * default, which Reset leaves; the site's page offers it as Default.
 */
add_task(async function the_default_install_grant_reads_as_a_default() {
  reset();
  const amo = Services.scriptSecurityManager.createContentPrincipalFromOrigin(
    "https://addons.mozilla.org"
  );
  const grant = Services.perms.getPermissionObject(amo, "install", true);
  Assert.equal(
    grant?.capability,
    Services.perms.ALLOW_ACTION,
    "Sval grants it"
  );
  Assert.ok(grant.isDefault, "from the defaults file");
  const ui = await openSites();
  const row = await TestUtils.waitForCondition(
    () => ui.row("mozilla.org"),
    "its site's row"
  );
  Assert.equal(
    row.querySelector(".sval-sites-summary").dataset.differs,
    `install:${Services.perms.ALLOW_ACTION}@addons.mozilla.org:default`,
    "the row names the host and says the grant is a default"
  );
  Assert.ok(
    !row.querySelector(".sval-sites-reset"),
    "a default is nothing to reset"
  );

  row.querySelector(".sval-sites-link").click();
  await TestUtils.waitForCondition(
    () => ui.byId("sval-site-title")?.textContent === "mozilla.org",
    "the site's page"
  );
  const select = ui.page.document.querySelector(
    '[data-sval-key="site-perm:https://addons.mozilla.org:install"]'
  );
  Assert.equal(select.value, "", "the grant is the row's Default");
  Assert.equal(
    select.closest(".sval-site-row").dataset.byDefault,
    String(Services.perms.ALLOW_ACTION),
    "which allows"
  );
  const name = (await accessibleOf(select.querySelector("button"))).name;
  Assert.ok(
    name.includes("addons.mozilla.org") && name != "addons.mozilla.org",
    "named for the permission and its host"
  );
  choose(select, String(Services.perms.DENY_ACTION));
  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(amo, "install"),
    Services.perms.DENY_ACTION,
    "a choice replaces the grant"
  );
  Assert.ok(
    !Services.perms.getPermissionObject(amo, "install", true).isDefault
  );
  choose(select, "");
  Assert.equal(
    Services.perms.testExactPermissionFromPrincipal(amo, "install"),
    Services.perms.ALLOW_ACTION,
    "and Default brings the grant back"
  );
  Assert.ok(Services.perms.getPermissionObject(amo, "install", true).isDefault);
});

/**
 * Every control on a site's page shows a label and has an accessible name
 * that holds it, and every permission Page Info offers has a row, install
 * among them.
 */
add_task(async function every_control_on_a_sites_page_is_labelled() {
  reset();
  SvalJavascript.setEnabled(SITE, false);
  const ui = await openSites();
  await TestUtils.waitForCondition(() => ui.row(SITE), "the site's row");
  ui.row(SITE).querySelector(".sval-sites-link").click();
  await TestUtils.waitForCondition(
    () => ui.byId("sval-site-title")?.textContent === SITE,
    "the site's page"
  );
  // The Forget card is drawn again once the site's holdings are counted.
  await TestUtils.waitForCondition(
    () => ui.page.SvalSettings._sitePage.held !== null,
    "the site's holdings counted"
  );
  const cards = ui.byId("sval-site-cards");
  const home = `https://${SITE}`;
  for (const id of ["camera", "geo", "install", "popup", "cookie"]) {
    Assert.ok(
      cards.querySelector(`[data-sval-key="site-perm:${home}:${id}"]`),
      `a row for ${id}`
    );
  }
  const controls = [
    ...cards.querySelectorAll("select, button, input, a[href]"),
  ].filter(el => el.checkVisibility());
  Assert.greater(controls.length, 10, "the page's controls");
  for (const control of controls) {
    const acc = await accessibleOf(control);
    Assert.ok(
      acc.name?.trim(),
      `${control.dataset.svalKey ?? control.localName} has a name`
    );
    const row = control.closest(".sval-site-row");
    const label = row?.querySelector(".sval-site-row-label");
    if (label && control.closest("sval-choice-pill")) {
      Assert.ok(label.checkVisibility(), "its label shows");
      Assert.ok(
        acc.name.includes(label.textContent.trim()),
        `${acc.name} holds its shown label`
      );
    }
  }
});
