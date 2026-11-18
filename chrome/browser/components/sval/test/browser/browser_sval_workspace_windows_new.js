/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_on_helpers.js */
/* import-globals-from sval_private_helpers.js */

/**
 * Which workspace the New Window command's window shows (launcher spec §3,
 * spec §10.7): the next one down from the window it was pressed in that no
 * window shows, wrapping at the bottom, and one of its own once every
 * workspace has a window. A private window shows none of them. Each task
 * presses the command's key and reads the windows as a person does.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_on_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_private_helpers.js",
  this
);

add_setup(failOnConsoleErrors);

add_setup(privateSetup);

add_setup(async function () {
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
 * @param {Window} win
 * @returns {Promise<string|undefined>} the workspace `win`'s switcher marks
 *   as the one the window is on.
 */
async function currentIn(win) {
  const menu = await openSwitcherIn(win);
  const current = menu.querySelector(
    '[data-workspace-id][aria-current="true"]'
  );
  const id = current?.dataset.workspaceId;
  await closeSwitcherIn(menu);
  return id;
}

/**
 * The profile's own workspace is the first in the switcher, and the task's
 * are below it. From the last one the command wraps to the first, then goes
 * on down.
 */
add_task(async function new_window_wraps_from_the_last_workspace() {
  const home = SvalPanel.workspaceId;
  const homeRows = rowIdsIn(window);
  const middle = await workspaceWith("Middle", { pages: [page("Between")] });
  const last = await workspaceWith("Last", { pages: [page("Bottom")] });
  Assert.deepEqual(
    (await switcherIdsIn(window)).listed,
    [home, middle.id, last.id],
    "the switcher lists the profile's workspace, then the task's two"
  );
  await switchVia(window, last.id);

  const wrapped = await newWindowCommand(window);
  Assert.equal(
    await currentIn(wrapped),
    home,
    "from the last workspace, the new window is on the first"
  );
  Assert.deepEqual(rowIdsIn(wrapped), homeRows, "drawing its rows");

  const next = await newWindowCommand(window);
  Assert.equal(
    switcherNameIn(next),
    "Middle",
    "the next window passes the first, which has a window, for the second"
  );
  Assert.equal(await currentIn(next), middle.id, "which its switcher marks");
  Assert.deepEqual(rowIdsIn(next), middle.tabs, "drawing its rows");
  Assert.deepEqual(shownTabIdsIn(next), middle.tabs, "with its tab on show");

  Assert.equal(switcherNameIn(window), "Last", "this window stayed");
  Assert.deepEqual(rowIdsIn(window), last.tabs, "on its own rows");
});

/**
 * A new window is for working somewhere else, so with a window on every
 * workspace it gets one of its own, which every other window then lists.
 */
add_task(async function new_window_with_every_workspace_shown_makes_one() {
  const home = SvalPanel.workspaceId;
  const only = await workspaceWith("Only", { pages: [page("Alone")] });

  const taken = await newWindowCommand(window);
  Assert.equal(switcherNameIn(taken), "Only", "the one free workspace");
  Assert.deepEqual(
    (await switcherIdsIn(window)).free,
    [],
    "which leaves no workspace without a window"
  );

  const made = await newWindowCommand(window);
  const own = await currentIn(made);
  Assert.ok(
    own && own !== home && own !== only.id,
    "the next window is on a workspace neither window shows"
  );
  Assert.notEqual(switcherNameIn(made), "Only", "which is not the other's");
  Assert.ok(
    !rowIdsIn(made).some(id => only.tabs.includes(id)),
    "and draws none of its tabs"
  );
  Assert.equal(switcherNameIn(taken), "Only", "that window stayed on its own");

  await TestUtils.waitForCondition(
    () => own in SvalPanel.nodes,
    "the new workspace reaches the window the command was pressed in"
  );
  const { listed, free } = await switcherIdsIn(window);
  Assert.deepEqual(
    listed,
    [home, only.id, own],
    "whose switcher lists it after the others"
  );
  Assert.deepEqual(free, [], "as one a window shows");
});

/**
 * A private window shows a temporary workspace of its own tabs
 * (private-windows spec), which is none of the profile's. It holds no
 * workspace away from the other windows, and its own is not theirs to go to.
 */
add_task(async function a_private_window_holds_no_workspace() {
  const home = SvalPanel.workspaceId;
  const spare = await workspaceWith("Spare", { pages: [page("Unshown")] });
  const priv = await openPrivate();
  atTaskEnd(() => closePrivate(priv));

  const { listed, free } = await switcherIdsIn(window);
  Assert.deepEqual(
    listed,
    [home, spare.id],
    "the switcher lists the profile's workspaces and nothing of the " +
      "private window's"
  );
  Assert.deepEqual(free, [spare.id], "and offers the spare one a window");

  const win = await newWindowCommand(window);
  Assert.ok(
    !PrivateBrowsingUtils.isWindowPrivate(win),
    "the command pressed in an ordinary window opens an ordinary window"
  );
  Assert.equal(switcherNameIn(win), "Spare", "on the next free workspace");
  Assert.deepEqual(rowIdsIn(win), spare.tabs, "drawing its rows");
  Assert.deepEqual(
    (await switcherIdsIn(window)).free,
    [],
    "which that window now holds"
  );
  Assert.ok(!priv.closed, "and the private window is still open");
  Assert.ok(
    !rowIdsIn(priv).some(id => spare.tabs.includes(id)),
    "drawing none of the workspace's rows"
  );
});
