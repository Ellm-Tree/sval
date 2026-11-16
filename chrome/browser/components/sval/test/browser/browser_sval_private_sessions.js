/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_private_helpers.js */

/**
 * Each private window is a session of its own (private-windows spec):
 * no private window sees another's cookies or storage; a sign-in popup
 * shares its opener's session; a window's data goes when it closes; and a
 * link or a tab never joins another window's session.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_private_helpers.js",
  this
);

/** Every private session's data this file made goes when the file ends. */
add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  registerCleanupFunction(async () => {
    Services.perms.removeAll();
    await within(
      SvalPrivateJars._clearedForTests(),
      10_000,
      "the private sessions' clears"
    );
  });
});

add_task(async function each_private_window_is_a_session_of_its_own() {
  const a = await openPrivate();
  const b = await openPrivate();
  try {
    for (const win of [a, b]) {
      Assert.ok(
        SvalPrivateJars.isPrivateJar(win.gBrowser.selectedTab.userContextId),
        "the window's first tab is in a private jar"
      );
    }
    Assert.notEqual(jarOf(a), jarOf(b), "of its own");
    const opened = await within(
      new Promise(resolve => {
        a.gBrowser.tabContainer.addEventListener(
          "TabOpen",
          event => resolve(event.target),
          { once: true }
        );
        a.BrowserCommands.openTab();
      }),
      10_000,
      "a new tab opening"
    );
    Assert.equal(opened.userContextId, jarOf(a), "a new tab joins its window");
    BrowserTestUtils.removeTab(opened);

    const inA = await openIsolationPage(a);
    const inB = await openIsolationPage(b);
    await writeSiteData(inA.linkedBrowser, "a");
    Assert.deepEqual(
      await readSiteData(inB.linkedBrowser),
      { cookie: null, storage: null },
      "the other private window sees none of it"
    );
    await writeSiteData(inB.linkedBrowser, "b");
    Assert.deepEqual(
      await readSiteData(inA.linkedBrowser),
      { cookie: "a", storage: "a" },
      "and keeps its own"
    );
    const normal = await openIsolationPage(window);
    try {
      Assert.deepEqual(
        await readSiteData(normal.linkedBrowser),
        { cookie: null, storage: null },
        "a normal window sees none of it either"
      );
    } finally {
      BrowserTestUtils.removeTab(normal);
    }
  } finally {
    await closePrivate(a);
    await closePrivate(b);
  }
});

/**
 * A link opened in a new private window, from a normal window or a private
 * one, opens there alone, in a session of its own.
 */
add_task(async function a_link_opens_in_a_new_session() {
  const a = await openPrivate();
  try {
    for (const from of [window, a]) {
      const opened = BrowserTestUtils.waitForNewWindow({ url: ISOLATION_PAGE });
      from.openLinkIn(ISOLATION_PAGE, "window", {
        private: true,
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
      const win = await within(opened, 15_000, "the new private window");
      try {
        Assert.equal(win.gBrowser.tabs.length, 1, "with the link's tab alone");
        const jar = win.gBrowser.selectedTab.userContextId;
        Assert.ok(SvalPrivateJars.isPrivateJar(jar), "in a private jar");
        Assert.equal(jar, jarOf(win), "the window's own");
        Assert.notEqual(jar, jarOf(a), "not its opener's");
      } finally {
        await closePrivate(win);
      }
    }
  } finally {
    await closePrivate(a);
  }
});

/**
 * Closing a private window clears its session and leaves the other's, and
 * its jar is never given to a window opened after it.
 */
add_task(async function closing_a_window_clears_its_session_alone() {
  const a = await openPrivate();
  const b = await openPrivate();
  const jarA = jarOf(a);
  let c = null;
  try {
    await writeSiteData((await openIsolationPage(a)).linkedBrowser, "a");
    const inB = await openIsolationPage(b);
    await writeSiteData(inB.linkedBrowser, "b");
    Assert.equal(cookiesIn(jarA).length, 1, "the first window has a cookie");

    await closePrivate(a);
    Assert.deepEqual(cookiesIn(jarA), [], "its cookies went with it");
    Assert.deepEqual(
      await readSiteData(inB.linkedBrowser),
      { cookie: "b", storage: "b" },
      "the other window keeps its own"
    );

    c = await openPrivate();
    Assert.ok(SvalPrivateJars.isPrivateJar(jarOf(c)), "a new window's jar");
    Assert.ok(
      ![jarA, jarOf(b)].includes(jarOf(c)),
      "is one no window had before"
    );
  } finally {
    await closePrivate(a);
    await closePrivate(b);
    if (c) {
      await closePrivate(c);
    }
  }
});

add_task(async function a_popup_shares_its_openers_session() {
  const a = await openPrivate();
  const jarA = jarOf(a);
  let popup = null;
  try {
    const inA = await openIsolationPage(a);
    await writeSiteData(inA.linkedBrowser, "a");
    popup = await openPopupFrom(inA.linkedBrowser);
    const browser = popup.gBrowser.selectedBrowser;
    Assert.equal(
      browser.browsingContext.originAttributes.userContextId,
      jarA,
      "the popup is in its opener's jar"
    );
    Assert.deepEqual(
      await readSiteData(browser),
      { cookie: "a", storage: "a" },
      "and signed in as its opener is"
    );
    await closePrivate(a);
    Assert.equal(cookiesIn(jarA).length, 1, "the popup keeps the session");
    await closePrivate(popup);
    Assert.deepEqual(cookiesIn(jarA), [], "until it closes too");
  } finally {
    await closePrivate(a);
    if (popup) {
      await closePrivate(popup);
    }
  }
});

/**
 * A tab asked to open in one private window in another's jar is given the
 * window's own, so it reads nothing of the other's session.
 */
add_task(async function a_tab_never_joins_another_windows_session() {
  const a = await openPrivate();
  const b = await openPrivate();
  try {
    await writeSiteData((await openIsolationPage(a)).linkedBrowser, "a");
    const tab = BrowserTestUtils.addTab(b.gBrowser, ISOLATION_PAGE, {
      userContextId: jarOf(a),
    });
    await within(
      BrowserTestUtils.browserLoaded(tab.linkedBrowser),
      15_000,
      "the page loading"
    );
    Assert.equal(tab.userContextId, jarOf(b), "the tab is in its window's jar");
    Assert.deepEqual(
      await readSiteData(tab.linkedBrowser),
      { cookie: null, storage: null },
      "and reads nothing of the other window's session"
    );
  } finally {
    await closePrivate(a);
    await closePrivate(b);
  }
});

/**
 * A link a popup opens in a new tab opens in the window whose session the
 * popup shares, never in the private window in front.
 */
add_task(async function a_popups_link_opens_in_its_openers_window() {
  const a = await openPrivate();
  let popup = null;
  let b = null;
  try {
    const inA = await openIsolationPage(a);
    await writeSiteData(inA.linkedBrowser, "a");
    popup = await openPopupFrom(inA.linkedBrowser);
    b = await openPrivate();
    const opened = within(
      BrowserTestUtils.waitForNewTab(
        a.gBrowser,
        `${ISOLATION_PAGE}?from-popup`
      ),
      15_000,
      "the link opening in the opener's window"
    );
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#link",
      {},
      popup.gBrowser.selectedBrowser
    );
    const tab = await opened;
    Assert.equal(tab.userContextId, jarOf(a), "in the opener's session");
    Assert.deepEqual(
      await readSiteData(tab.linkedBrowser),
      { cookie: "a", storage: "a" },
      "signed in as the opener is"
    );
    Assert.equal(b.gBrowser.tabs.length, 1, "the window in front got nothing");
  } finally {
    if (popup) {
      await closePrivate(popup);
    }
    await closePrivate(a);
    if (b) {
      await closePrivate(b);
    }
  }
});
