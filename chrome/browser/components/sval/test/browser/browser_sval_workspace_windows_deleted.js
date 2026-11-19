/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_on_helpers.js */

/**
 * What a person is left looking at when another device deletes the
 * workspaces two windows show, in one change (spec §10.7). Another device is
 * an engine of its own on the profile's folder, and its change arrives on a
 * pass, as it does in use.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_on_helpers.js",
  this
);

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);

add_setup(failOnConsoleErrors);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  expectWorkspaceTabs();
});

/**
 * @param {string} title
 * @returns {{url: string, title: string}} a page for `workspaceWith`.
 */
function page(title) {
  return { url: titledRed(title), title };
}

/**
 * Another device that has read what this one holds, stopped when the task
 * ends.
 *
 * @returns {Promise<object>} its engine.
 */
async function anotherDevice() {
  const { engine } = SvalPanel;
  // Published, so the other device reads the task's workspaces.
  await engine.sync(SvalTree.SYNC_DOCUMENT, Date.now());
  const peer = new SvalEngine({
    root: engine.root,
    ...(await svalKeys()),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  atTaskEnd(() => stopFixture({ engine: peer }));
  // Read before it writes, so this device's watermark is in the peer's file
  // and the absence it publishes is a deletion (spec §5.4).
  await peer.sync(SvalTree.SYNC_DOCUMENT, Date.now());
  return peer;
}

/**
 * Deletes `workspaces` on `peer`, each with its tabs, and publishes the
 * deletions as one change.
 *
 * @param {object} peer
 * @param {Array<{id: string, tabs: string[]}>} workspaces
 */
async function deleteElsewhere(peer, workspaces) {
  for (const { id, tabs } of workspaces) {
    for (const tab of tabs) {
      await peer.mutate({ kind: "remove", id: tab });
    }
    await peer.mutate({ kind: "remove", id });
  }
  await peer.sync(SvalTree.SYNC_DOCUMENT, Date.now());
}

/**
 * A workspace has one window (spec §10.7). Two windows that lose their
 * workspaces in one change both look for another, and one workspace is free:
 * one window takes it, and the other, left with nothing to show, closes.
 */
add_task(async function two_windows_losing_their_workspaces_share_one_free() {
  const first = await workspaceWith("First", { pages: [page("One")] });
  const second = await workspaceWith("Second", { pages: [page("Two")] });
  const free = await workspaceWith("Free", { pages: [page("Spare")] });
  const home = SvalWindowWorkspace.of(window).id;
  const homeRows = rowIdsIn(window);

  // Opened as a Shift-release on a switcher entry opens them. Opening the
  // switcher waits for its window to have the focus, which a window manager
  // may refuse a script once another window has taken it.
  const windows = [
    await windowShowing(first.id, () =>
      SvalPanel.switcher.pick(first.id, true)
    ),
    await windowShowing(second.id, () =>
      SvalPanel.switcher.pick(second.id, true)
    ),
  ];
  const peer = await anotherDevice();
  await deleteElsewhere(peer, [first, second]);

  const closing = windows.map(win => BrowserTestUtils.domWindowClosed(win));
  const observers = windows.map(win => win.SvalPanel.observer);
  Assert.ok(
    await within(SvalPanel.syncNow(), 20_000, "the pass"),
    "the pass read the other device's deletions"
  );
  await within(Promise.race(closing), 10_000, "one of the two closing");
  const stayed = windows.filter(win => !win.closed);
  Assert.equal(stayed.length, 1, "one window closed and one stayed");
  const [win] = stayed;
  await TestUtils.waitForCondition(
    () => switcherNameIn(win) === "Free",
    "the window that stayed names the free workspace"
  );
  await switchDone(win);
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "its observer settling"
  );
  Assert.ok(!win.closed, "and it is still open once it has settled");
  Assert.deepEqual(rowIdsIn(win), free.tabs, "that workspace's rows are drawn");
  Assert.deepEqual(shownTabIdsIn(win), free.tabs, "and is the one on show");
  Assert.equal(taggedId(win.gBrowser.selectedTab), free.tabs[0], "on screen");

  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    home,
    "this window stayed where it was"
  );
  Assert.deepEqual(rowIdsIn(window), homeRows, "drawing what it drew");
  // The entries the switcher draws when opened, read without the focus
  // opening it needs.
  const entries = SvalPanel.switcher.list();
  const listed = entries.map(item => item.id);
  Assert.ok(
    entries.find(item => item.id === free.id)?.elsewhere,
    "and its switcher lists the free workspace as one a window shows"
  );
  Assert.ok(
    !listed.includes(first.id) && !listed.includes(second.id),
    "with neither deleted workspace"
  );
  // The closed window's last flush is over before the task's teardown reads
  // the document.
  for (const observer of observers) {
    if (observer !== win.SvalPanel.observer) {
      await stopFixture({ observer });
    }
  }
});
