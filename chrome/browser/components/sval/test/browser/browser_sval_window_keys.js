/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * The keys that open a window (launcher spec §3): Accel+Shift+N opens a
 * private window and Accel+Shift+P still does, Accel+Shift+T still reopens a
 * closed window, and Accel+N and File > New Window open a window on the next
 * workspace down from the one the window shows.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { CustomKeys } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs"
);

registerCleanupFunction(() => CustomKeys.resetAll());

/**
 * Presses a key in this window and waits for the window it opens.
 *
 * @param {string} key The key typed.
 * @param {object} modifiers `EventUtils.synthesizeKey` modifiers.
 * @returns {Promise<DOMWindow>} the new window, loaded.
 */
async function windowOpenedBy(key, modifiers) {
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
  EventUtils.synthesizeKey(key, modifiers);
  return within(opening, 20_000, `the window ${key} opens`);
}

async function close(win) {
  if (!win.closed) {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
}

add_task(async function accel_shift_n_opens_a_private_window() {
  const win = await windowOpenedBy("N", { accelKey: true, shiftKey: true });
  try {
    Assert.ok(PrivateBrowsingUtils.isWindowPrivate(win), "it is private");
  } finally {
    await close(win);
  }
});

add_task(async function accel_shift_p_still_opens_a_private_window() {
  const win = await windowOpenedBy("P", { accelKey: true, shiftKey: true });
  try {
    Assert.ok(PrivateBrowsingUtils.isWindowPrivate(win), "it is private");
  } finally {
    await close(win);
  }
});

add_task(function reopen_closed_window_gives_up_the_key() {
  const reopen = document.getElementById("key_undoCloseWindow");
  Assert.ok(!reopen.getAttribute("key"), "Reopen Closed Window has no N");
  const privateKey = document.getElementById("key_privatebrowsing");
  Assert.equal(privateKey.getAttribute("key"), "N", "the private key is N");
  Assert.equal(
    privateKey.getAttribute("modifiers"),
    "accel,shift",
    "with Accel and Shift"
  );
});

/**
 * Settings > Keyboard shows the default and resets to it, because the
 * element carries N when `CustomKeys` saves its original.
 */
add_task(function the_private_windows_default_is_accel_shift_n() {
  registerCleanupFunction(() => CustomKeys.resetKey("key_privatebrowsing"));
  CustomKeys.changeKey("key_privatebrowsing", {
    modifiers: "accel,shift",
    key: "X",
  });
  Assert.deepEqual(
    CustomKeys.getDefaultKey("key_privatebrowsing"),
    { modifiers: "accel,shift", key: "N" },
    "the default is Accel+Shift+N"
  );
  CustomKeys.resetKey("key_privatebrowsing");
  Assert.equal(
    document.getElementById("key_privatebrowsing").getAttribute("key"),
    "N",
    "and resetting brings it back"
  );
});

/**
 * Firefox reopens whichever closed last, a tab or a window, with its own key.
 */
add_task(async function accel_shift_t_reopens_a_closed_window() {
  for (const { closedId } of SessionStore.getClosedWindowData()) {
    SessionStore.forgetClosedWindowById(closedId);
  }
  const second = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a second window"
  );
  const page = ROOT + "sval_agent_page.html";
  const loaded = BrowserTestUtils.browserLoaded(
    second.gBrowser.selectedBrowser,
    false,
    page
  );
  BrowserTestUtils.startLoadingURIString(second.gBrowser.selectedBrowser, page);
  await within(loaded, 10_000, "a page in the second window");
  await close(second);
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedWindowCount() == 1,
    "the closed window is kept"
  );

  const win = await windowOpenedBy("T", { accelKey: true, shiftKey: true });
  try {
    await TestUtils.waitForCondition(
      () => SessionStore.getClosedWindowCount() == 0,
      "the closed window is reopened, so it is no longer in the list"
    );
  } finally {
    await close(win);
    for (const { closedId } of SessionStore.getClosedWindowData()) {
      SessionStore.forgetClosedWindowById(closedId);
    }
  }
});

/**
 * A new window opened by the keyboard or the File menu shows the workspace
 * below the one this window shows, where any other new window takes the
 * first no window shows.
 */
add_task(async function accel_n_opens_the_next_workspace_down() {
  const { ids } = await withSwitcherPanel({
    workspaces: 4,
    tabUrl: TITLED_TAB_URL,
  });
  const [, second, third, fourth] = ids.workspaces;
  // The profile's own workspace, first in sibling order.
  const [first] = SvalTree.workspaceIds(SvalPanel.nodes);

  const menu = await openSwitcher();
  await activateWorkspace(menu, second);
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    second,
    "this window shows 2"
  );

  for (const open of [
    () => windowOpenedBy("n", { accelKey: true }),
    async () => {
      const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
      document.getElementById("menu_newNavigator").doCommand();
      return within(opening, 20_000, "File > New Window opening a window");
    },
  ]) {
    const win = await open();
    try {
      await within(
        win.SvalPanel.started,
        20_000,
        "the new window's panel starting"
      );
      Assert.equal(
        SvalWindowWorkspace.of(win).id,
        third,
        "the new window shows workspace 3"
      );
      Assert.equal(SvalWindowWorkspace.of(window).id, second, "this one stays");
    } finally {
      await close(win);
    }
  }

  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a window opened another way"
  );
  try {
    await within(
      other.SvalPanel.started,
      20_000,
      "that window's panel starting"
    );
    Assert.equal(
      SvalWindowWorkspace.of(other).id,
      first,
      "which takes the first no window shows"
    );
  } finally {
    await close(other);
  }

  const bottom = await openSwitcher();
  await activateWorkspace(bottom, fourth);
  const win = await windowOpenedBy("n", { accelKey: true });
  try {
    await within(
      win.SvalPanel.started,
      20_000,
      "the new window's panel starting"
    );
    Assert.equal(
      SvalWindowWorkspace.of(win).id,
      first,
      "from the last workspace the next is the first"
    );
  } finally {
    await close(win);
  }
});
