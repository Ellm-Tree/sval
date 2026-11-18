/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_private_helpers.js */

/**
 * "Always use private browsing mode" (private-windows spec): every window is
 * private and has Sval's panel, and Sval saves, syncs and creates nothing.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_private_helpers.js",
  this
);

/** Anything Sval ever kept in the login manager, which should be nothing. */
async function svalLogins() {
  return (await Services.logins.searchLoginsAsync({ origin: "chrome://sval" }))
    .length;
}

add_task(async function every_window_is_private_and_has_the_panel() {
  Assert.ok(
    PrivateBrowsingUtils.permanentPrivateBrowsing,
    "the browser is in permanent private browsing"
  );
  await within(SvalPanel.started, 10_000, "the panel starting");
  Assert.ok(
    PrivateBrowsingUtils.isWindowPrivate(window),
    "this window is private"
  );
  Assert.equal(SvalPanel.engine.isPrivate, true, "and on a private tree");
  Assert.equal(
    SvalPanel._els.indicator.dataset.icon,
    "moon-off",
    "with sync shown as off"
  );
  Assert.ok(
    BrowserTestUtils.isHidden(document.getElementById("TabsToolbar")),
    "and no tab strip"
  );

  const second = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    15_000,
    "a new window opening"
  );
  try {
    await within(second.SvalPanel.started, 10_000, "the panel starting");
    Assert.ok(PrivateBrowsingUtils.isWindowPrivate(second));
    Assert.equal(second.SvalPanel.engine.isPrivate, true);
  } finally {
    await within(
      BrowserTestUtils.closeWindow(second),
      10_000,
      "the second window closing"
    );
  }
});

/**
 * A session of tabs, groups and names leaves Sval's files as they were, stores
 * no key, and leaves no marker anywhere in the profile.
 */
add_task(async function a_private_only_session_saves_nothing() {
  await within(SvalPanel.started, 10_000, "the panel starting");
  await flushEverything();
  const before = await snapshot(svalPaths());
  const loginsBefore = await svalLogins();

  const marks = [marker(), marker(), marker()];
  const panel = SvalPanel;
  const tabs = [];
  for (const mark of marks.slice(0, 2)) {
    tabs.push(
      await within(
        BrowserTestUtils.openNewForegroundTab(
          gBrowser,
          `data:text/html,<title>${mark}</title>`
        ),
        15_000,
        "a new tab opening and loading"
      )
    );
  }
  const adding = panel.run("addGroup", null);
  await answerContainerDialogIn(window, { name: marks[2] });
  await within(adding, 10_000, "the group's making");
  await TestUtils.waitForCondition(
    async () =>
      Object.values((await panel.engine.tree()).nodes).some(
        node => node.content?.name === marks[2]
      ),
    "the group is in the private tree"
  );
  for (const tab of tabs) {
    BrowserTestUtils.removeTab(tab);
  }
  await flushEverything();

  Assert.deepEqual(
    await snapshot(svalPaths()),
    before,
    "sval's files did not change"
  );
  Assert.equal(await svalLogins(), loginsBefore, "no key was stored");
  Assert.deepEqual(
    await findMarkers([PathUtils.profileDir], marks),
    [],
    "and nothing from the session is in the profile"
  );
  Assert.ok(SvalPrivateSession.isLive, "the session lives while windows do");
});

/** Settings says why storage, syncing and pairing are unavailable. */
add_task(async function settings_says_nothing_is_saved() {
  await within(SvalPanel.started, 10_000, "the panel starting");
  const tab = SvalPanel.openSettingsPage();
  try {
    await within(
      TestUtils.waitForCondition(
        () =>
          tab.linkedBrowser.contentWindow?.document.documentElement?.dataset
            .svalSettings === "ready",
        "the settings page started"
      ),
      10_000,
      "the settings page started"
    );
    const page = tab.linkedBrowser.contentWindow;
    const notes = page.document.querySelectorAll(".sval-private-only");
    Assert.equal(notes.length, 1, "the Sync and devices pane says why");
    for (const id of [
      "sval-pairing-open",
      "sval-offer-start",
      "sval-claim-submit",
      "sval-sync-now",
    ]) {
      Assert.ok(page.document.getElementById(id).disabled, `${id} is off`);
    }
    Assert.equal(page.SvalSettings.panel, null, "and there is no saved panel");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});

/**
 * The Sites card edits the choices of the window it is open in, which never
 * reach the synced pref.
 */
add_task(async function a_sites_card_choice_stays_private() {
  const { SvalSiteProtections, SITE_BRANCH } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
  );
  const session = gBrowser.defaultUserContextId;
  SvalSiteProtections.setMedia("example.org", "allow", session);
  const tab = SvalPanel.openSettingsPage();
  try {
    await within(
      TestUtils.waitForCondition(
        () =>
          tab.linkedBrowser.contentWindow?.document.documentElement?.dataset
            .svalSettings === "ready",
        "the settings page started"
      ),
      10_000,
      "the settings page started"
    );
    const page = tab.linkedBrowser.contentWindow;
    await showPane(page, "svalSites");
    const row = () =>
      page.document.querySelector('#sval-sites-body [data-site="example.org"]');
    await TestUtils.waitForCondition(
      () => row()?.checkVisibility(),
      "the card lists the private choice"
    );
    SvalSiteProtections.setMedia("example.net", "block", session);
    Assert.ok(
      page.document.querySelector('#sval-sites-body [data-site="example.net"]'),
      "a private choice made elsewhere shows at once"
    );
    SvalSiteProtections.setRule("example.net", null, session);
    Assert.ok(
      !page.document.querySelector(
        '#sval-sites-body [data-site="example.net"]'
      ),
      "and goes at once"
    );
    // The choices are made on the site's page.
    row().querySelector(".sval-sites-link").click();
    await TestUtils.waitForCondition(
      () =>
        page.document.getElementById("sval-site-title")?.textContent ===
        "example.org",
      "the site's page"
    );
    const exceptions = page.document.querySelector(
      '[data-sval-key="site-exceptions"]'
    );
    Assert.ok(exceptions.disabled, "exceptions are off in private windows");
    Assert.equal(exceptions.dataset.why, "private", "and say why");
    Assert.ok(exceptions.title, "in a tooltip");
    const protections = page.document.querySelector(
      '[data-sval-key="site-protections"]'
    );
    Assert.ok(
      protections.choices.find(([value]) => value === "fingerprinting")[2],
      "fingerprinting protection can't go off on its own"
    );

    protections.value = "off";
    protections.dispatchEvent(new page.Event("change"));
    Assert.equal(
      SvalSiteProtections.protectionsFor("example.org", session),
      "off",
      "the choice is a private one"
    );
    Assert.equal(
      Services.perms.testExactPermissionFromPrincipal(
        Services.scriptSecurityManager.createContentPrincipal(
          Services.io.newURI("https://example.org/"),
          { privateBrowsingId: 1, userContextId: session }
        ),
        "trackingprotection-pb"
      ),
      Services.perms.ALLOW_ACTION,
      "in Firefox's private allow list"
    );
    page.document.getElementById("sval-site-back").click();
    await TestUtils.waitForCondition(
      () => row()?.checkVisibility(),
      "back on the list"
    );
    row().querySelector(".sval-sites-reset").click();
    Assert.deepEqual(
      SvalSiteProtections.ruleFor("example.org", session),
      {},
      "reset"
    );
    Assert.deepEqual(
      Services.prefs.getChildList(SITE_BRANCH),
      [],
      "the synced prefs are untouched"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    SvalSiteProtections.setRule("example.org", null, session);
  }
});

/**
 * My filters is stored, so a private-only Sites card names a site's lines
 * and its page lists them with no Show again, and Reset forgets the
 * window's choices without asking.
 */
add_task(async function the_sites_card_lists_hidden_elements_read_only() {
  const { SvalSiteProtections } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
  );
  const { SvalBlocking } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
  );
  const session = gBrowser.defaultUserContextId;
  const lines = "example.net##.sval-test-ad\nexample.org##.sval-test-ad";
  SvalBlocking.setMyFilters(lines);
  SvalSiteProtections.setMedia("example.org", "allow", session);
  const tab = SvalPanel.openSettingsPage();
  try {
    await within(
      TestUtils.waitForCondition(
        () =>
          tab.linkedBrowser.contentWindow?.document.documentElement?.dataset
            .svalSettings === "ready",
        "the settings page started"
      ),
      10_000,
      "the settings page started"
    );
    const page = tab.linkedBrowser.contentWindow;
    await showPane(page, "svalSites");
    const row = site =>
      page.document.querySelector(`#sval-sites-body [data-site="${site}"]`);
    await within(
      TestUtils.waitForCondition(
        () => row("example.net")?.checkVisibility(),
        "a site with only a line has its row"
      ),
      10_000,
      "a site with only a line has its row"
    );
    Assert.ok(
      !row("example.net").querySelector(".sval-sites-reset"),
      "with nothing to reset"
    );
    Assert.equal(
      row("example.org").querySelector(".sval-sites-summary").dataset.differs,
      "media:allow removed:1",
      "a row names the site's lines"
    );
    row("example.org").querySelector(".sval-sites-link").click();
    await within(
      TestUtils.waitForCondition(
        () =>
          page.document.querySelector(
            '[data-site-card="hidden"] .sval-sites-hidden-row'
          ),
        "the site's page with its line"
      ),
      10_000,
      "the site's page with its line"
    );
    Assert.ok(
      !page.document.querySelector(".sval-sites-hidden-show"),
      "lines are listed with no Show again"
    );
    page.document.getElementById("sval-site-back").click();
    await within(
      TestUtils.waitForCondition(
        () => row("example.org")?.checkVisibility(),
        "back on the list"
      ),
      10_000,
      "back on the list"
    );
    row("example.org").querySelector(".sval-sites-reset").click();
    Assert.ok(
      !page.document.getElementById("sval-blocking-dialog").open,
      "Reset asks nothing"
    );
    Assert.deepEqual(
      SvalSiteProtections.ruleFor("example.org", session),
      {},
      "and forgets the window's choice"
    );
    Assert.equal(SvalBlocking.myFilters, lines, "and leaves My filters");
  } finally {
    BrowserTestUtils.removeTab(tab);
    SvalSiteProtections.setRule("example.org", null, session);
    SvalBlocking.setMyFilters("");
  }
});

/**
 * Colorshift is off in a private window, so a site whose only choice is a
 * style has no row there, as it has no card on a site's page.
 */
add_task(async function a_colorshift_style_lists_no_site_there() {
  const { SvalSiteProtections } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
  );
  const { removeStyles, setStyle } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs"
  );
  const session = gBrowser.defaultUserContextId;
  setStyle("example.net", { theme: "dark" });
  setStyle("example.org", { theme: "dark" });
  SvalSiteProtections.setMedia("example.org", "allow", session);
  const tab = SvalPanel.openSettingsPage();
  try {
    await within(
      TestUtils.waitForCondition(
        () =>
          tab.linkedBrowser.contentWindow?.document.documentElement?.dataset
            .svalSettings === "ready",
        "the settings page started"
      ),
      10_000,
      "the settings page started"
    );
    const page = tab.linkedBrowser.contentWindow;
    await showPane(page, "svalSites");
    const row = site =>
      page.document.querySelector(`#sval-sites-body [data-site="${site}"]`);
    await within(
      TestUtils.waitForCondition(
        () => row("example.org")?.checkVisibility(),
        "the site with a choice of the window's has its row"
      ),
      10_000,
      "the site with a choice of the window's has its row"
    );
    Assert.equal(
      row("example.org").querySelector(".sval-sites-summary").dataset.differs,
      "media:allow",
      "which leaves its style out"
    );
    Assert.ok(!row("example.net"), "and a site with only a style has none");
  } finally {
    BrowserTestUtils.removeTab(tab);
    SvalSiteProtections.setRule("example.org", null, session);
    removeStyles(["example.net", "example.org"]);
  }
});

/**
 * A site's page in a private window says its changes are the window's own,
 * edits the window's choices, and shows JavaScript as plain text.
 */
add_task(async function the_site_page_edits_the_windows_own_choices() {
  const { SvalSiteProtections } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
  );
  const session = gBrowser.defaultUserContextId;
  const tab = SvalPanel.openSettingsPage();
  try {
    await within(
      TestUtils.waitForCondition(
        () =>
          tab.linkedBrowser.contentWindow?.document.documentElement?.dataset
            .svalSettings === "ready",
        "the settings page started"
      ),
      10_000,
      "the settings page started"
    );
    const page = tab.linkedBrowser.contentWindow;
    const byId = id => page.document.getElementById(id);
    const byKey = key =>
      page.document.querySelector(`[data-sval-key="${key}"]`);
    page.SvalSettings.showSite("example.org");
    await within(
      TestUtils.waitForCondition(
        () => byId("sval-site-page")?.checkVisibility(),
        "the site's page showing"
      ),
      10_000,
      "the site's page showing"
    );
    Assert.ok(byId("sval-site-note").checkVisibility(), "with the note");
    Assert.equal(
      byKey("site-javascript").localName,
      "span",
      "JavaScript is plain text"
    );
    Assert.equal(byKey("site-javascript").dataset.value, "", "at the default");
    const permissions = page.document.querySelector(
      '[data-site-card="permissions"]'
    );
    Assert.ok(
      permissions.querySelector(".sval-site-value") &&
        !permissions.querySelector("select, button"),
      "Permissions are plain text with no ×"
    );
    const select = byKey("site-protections");
    select.value = "off";
    select.dispatchEvent(new Event("change"));
    Assert.equal(
      SvalSiteProtections.ruleFor("example.org", session).protections,
      "off",
      "the window's choice changes"
    );
    Assert.ok(
      !SvalSiteProtections.rules().has("example.org"),
      "and no stored one"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    SvalSiteProtections.setRule("example.org", null, session);
  }
});

/**
 * Every window is a session of its own, and a popup shares the session of
 * the page that opened it.
 */
add_task(async function every_window_is_a_session_of_its_own() {
  await within(SvalPanel.started, 10_000, "the panel starting");
  const first = jarOf(window);
  Assert.ok(SvalPrivateJars.isPrivateJar(first), "the first window has a jar");
  const second = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    15_000,
    "a new window opening"
  );
  const secondJar = jarOf(second);
  try {
    await within(second.SvalPanel.started, 10_000, "the panel starting");
    Assert.ok(SvalPrivateJars.isPrivateJar(secondJar), "so has the next");
    Assert.notEqual(secondJar, first, "of its own");
    const here = await openIsolationPage(window);
    const there = await openIsolationPage(second);
    await writeSiteData(here.linkedBrowser, "first");
    await writeSiteData(there.linkedBrowser, "second");
    Assert.deepEqual(
      await readSiteData(here.linkedBrowser),
      { cookie: "first", storage: "first" },
      "each window keeps its own site data"
    );
    const popup = await openPopupFrom(here.linkedBrowser);
    const browser = popup.gBrowser.selectedBrowser;
    Assert.equal(
      browser.browsingContext.originAttributes.userContextId,
      first,
      "a popup is in its opener's jar"
    );
    Assert.deepEqual(
      await readSiteData(browser),
      { cookie: "first", storage: "first" },
      "and signed in as its opener is"
    );
    await closePrivate(popup);
    BrowserTestUtils.removeTab(here);
  } finally {
    await closePrivate(second);
  }
  Assert.deepEqual(cookiesIn(secondJar), [], "a closed window's data is gone");
  Assert.ok(
    cookiesIn(first).some(c => c.name === "sval" && c.value === "first"),
    "and the open one keeps its own"
  );
});
