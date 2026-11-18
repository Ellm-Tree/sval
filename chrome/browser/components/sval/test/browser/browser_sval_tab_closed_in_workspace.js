/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * Closing the tab the user is viewing leaves them in the same workspace, in
 * the same window.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { SvalSharedFolder } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSharedFolder.sys.mjs"
);

/**
 * Two windows, each on a workspace of its own: closing tabs in the second
 * goes through that workspace's tabs, and leaves the user in its window
 * rather than sending them to the first window's.
 */
add_task(async function closing_tabs_in_a_second_window_stays_in_it() {
  const { ids, engine } = await withSwitcherTabs();
  const [first, second] = ids.workspaces;
  const now = Date.now();
  const more = [];
  for (const name of ["Second", "Third"]) {
    more.push(
      await engine.mutate({
        kind: "addTab",
        parent: second,
        name,
        url: TITLED_TAB_URL.replace("%s", name),
        id: crypto.randomUUID(),
        now,
      })
    );
  }
  await SvalPanel.refresh();
  const order = [ids.tabs[1], ...more];

  // ⌘N: the new window takes the workspace after this window's.
  const opening = BrowserTestUtils.waitForNewWindow();
  SvalWindowWorkspace.of(window).openWindowOnNext();
  const win = await within(opening, 20_000, "a new window's opening");
  registerCleanupFunction(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the test window closing"
      );
    }
  });
  await within(
    win.SvalPanel.started,
    20_000,
    "the new window's panel starting"
  );
  Assert.equal(SvalWindowWorkspace.of(win).id, second, "on the second");

  // The user goes to the middle row and reads the page.
  const middle = win.SvalPanel._rows.find(row => row.id === order[1]);
  await win.SvalPanel.activate(middle);
  const shown = win.gBrowser.selectedTab;
  Assert.equal(taggedId(shown), order[1], "showing the middle tab");

  const shownAfterClose = async () => {
    await untilRestored(win.gBrowser.selectedTab);
    // Cmd/Ctrl+W (`cmd_close`).
    win.BrowserCommands.closeTabOrWindow();
    await within(
      win.SvalPanel.observer.settled(),
      10_000,
      "win.SvalPanel.observer settling"
    );
    Assert.ok(!win.closed, "the window stays open");
    return taggedId(win.gBrowser.selectedTab);
  };
  Assert.equal(
    await shownAfterClose(),
    order[2],
    "closing it shows the next tab of the workspace"
  );
  Assert.equal(
    await shownAfterClose(),
    order[0],
    "and closing that shows the one before"
  );
  Assert.equal(
    SvalWindowWorkspace.of(win).id,
    second,
    "the window is still on the second workspace"
  );
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "and the first window on the first"
  );
  await untilRestored(win.gBrowser.selectedTab);

  // Closed only once the window's work is done: its observer has acted on
  // every close, and the shared folder's helper its passes started has
  // stopped writing.
  const observer = win.SvalPanel.observer;
  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the second window closing"
  );
  await stopFixture({ observer });
  await SvalSharedFolder._whenIdle();
});
