/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_private_helpers.js */

/**
 * What a private window's pages reach outside the window: no page title in
 * the window's own title, no website notification unless the user turns
 * them on, an address copied as sensitive data, and nothing about a closed
 * tab's place in the session store.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_private_helpers.js",
  this
);

const { MockRegistrar } = ChromeUtils.importESModule(
  "resource://testing-common/MockRegistrar.sys.mjs"
);
const { copyAddress, copyCleanAddress, copyMarkdownLink } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalTabActions.sys.mjs"
  );

const NOTIFICATIONS_PREF = "dom.webnotifications.privateBrowsing.enabled";
const SITE = "https://example.com/";
const FORMER_KEYS = ["sval-former-parent", "sval-former-workspace"];

add_setup(privateSetup);

add_task(async function a_private_windows_title_names_no_page() {
  const mark = marker();
  const win = await openPrivate();
  try {
    const { tab } = await openMarked(win, mark);
    await TestUtils.waitForCondition(
      () => tab.label === mark,
      "the private tab shows its page's title"
    );
    Assert.ok(
      !win.document.title.includes(mark),
      "the private window's title holds no page title"
    );
  } finally {
    await closePrivate(win);
  }

  const shown = marker();
  const tab = await openPage(pageFor(shown));
  await TestUtils.waitForCondition(
    () => document.title.includes(shown),
    "a normal window's title holds its page's title"
  );
  BrowserTestUtils.removeTab(tab);
});

/**
 * @param {Window} win A private window.
 * @returns {Promise<string>} `Notification.permission`, as a page of `SITE`
 *   opened in `win` reads it.
 */
async function notificationPermissionIn(win) {
  const tab = await openPage(SITE, win);
  const permission = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [],
    () => content.Notification.permission
  );
  BrowserTestUtils.removeTab(tab);
  return permission;
}

/**
 * @param {Window} win A browser window.
 * @returns {Promise<string>} What a page of `SITE` opened in `win` is
 *   answered when it asks to show notifications, after a click.
 */
async function askToNotifyIn(win) {
  const tab = await openPage(SITE, win);
  return SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.notifyUserGestureActivation();
    return content.Notification.requestPermission();
  });
}

add_task(async function a_private_page_shows_no_notification_by_default() {
  Assert.equal(
    Services.prefs.getDefaultBranch("").getBoolPref(NOTIFICATIONS_PREF),
    false,
    "Sval ships notifications in private windows off"
  );
  const win = await openPrivate();
  try {
    Assert.equal(
      await within(askToNotifyIn(win), 10_000, "the page's request answered"),
      "denied",
      "a private page that asks to show notifications is refused, unprompted"
    );
    Assert.equal(
      await notificationPermissionIn(win),
      await notificationPermissionIn(window),
      "the page reads the permission a normal window's page reads"
    );
    await SpecialPowers.pushPrefEnv({ set: [[NOTIFICATIONS_PREF, true]] });
    Assert.equal(
      await notificationPermissionIn(win),
      "default",
      "with the setting on, a private page may ask, as Gecko lets it"
    );
    await SpecialPowers.popPrefEnv();
  } finally {
    await closePrivate(win);
  }
});

add_task(async function a_private_window_copies_as_sensitive_data() {
  const copies = [];
  const mock = MockRegistrar.register("@mozilla.org/widget/clipboardhelper;1", {
    QueryInterface: ChromeUtils.generateQI(["nsIClipboardHelper"]),
    copyString(text, context, sensitive) {
      copies.push(sensitive);
    },
  });
  atTaskEnd(() => MockRegistrar.unregister(mock));
  const { Sensitive, NotSensitive } = Ci.nsIClipboardHelper;

  const win = await openPrivate();
  try {
    const { tab } = await openMarked(win, marker());
    copyAddress(win);
    copyCleanAddress(win);
    copyMarkdownLink(tab);
    Assert.deepEqual(
      copies.splice(0),
      [Sensitive, Sensitive, Sensitive],
      "each of a private window's copies is marked sensitive"
    );
  } finally {
    await closePrivate(win);
  }

  const tab = await openPage(pageFor(marker()));
  copyAddress(window);
  copyMarkdownLink(tab);
  Assert.deepEqual(
    copies,
    [NotSensitive, NotSensitive],
    "a normal window's copies are not"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(
  async function a_closed_private_tab_files_nothing_in_the_session_store() {
    const win = await openPrivate();
    try {
      const { tab, id } = await openMarked(win, marker());
      BrowserTestUtils.removeTab(tab);
      await TestUtils.waitForCondition(
        async () => !(await privateTree(win))[id],
        "the closed private tab's node is gone"
      );
      const [closed] = SessionStore.getClosedTabDataForWindow(win);
      Assert.ok(closed, "the private window keeps its closed tab for undo");
      for (const key of FORMER_KEYS) {
        Assert.ok(
          !(key in (closed.state.extData ?? {})),
          `the session store holds no ${key} for it`
        );
      }
      Assert.ok(
        win.SvalPanel.observer.reopenClosedTab(),
        "and undo close tab reopens it all the same"
      );
    } finally {
      await closePrivate(win);
    }

    const tab = await openPage(pageFor(marker()));
    await within(SvalPanel.observer.settled(), 10_000, "the tab being filed");
    BrowserTestUtils.removeTab(tab);
    const [closed] = SessionStore.getClosedTabDataForWindow(window);
    atTaskEnd(() => SessionStore.forgetClosedTab(window, 0));
    Assert.ok(
      closed.state.extData?.["sval-former-workspace"],
      "a normal window's closed tab carries the workspace it was in"
    );
  }
);
