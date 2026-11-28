/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_on_helpers.js */

/**
 * Groups as a user works with them in the panel, with agent access on:
 * made, filled, a tab moved between them and reordered, folded and
 * unfolded, and renamed. Every tab's page still loads and paints from its
 * row, and a group's name shows in a window opened afterwards.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_on_helpers.js",
  this
);

add_setup(failOnConsoleErrors);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  await agentAccessOn(registerCleanupFunction);
  expectWorkspaceTabs();
});

/**
 * Makes a group named `name` with the panel's New group button, answering
 * its dialog.
 *
 * @param {string} name
 * @returns {Promise<string>} its id.
 */
async function newGroup(name) {
  const made = SvalPanel.run("addGroup", null);
  const doc = await dialogIn(window, ".sval-nw-name");
  typeIn(doc.querySelector(".sval-nw-name"), name);
  doc.querySelector(".sval-nw-create").click();
  await within(made, 10_000, "the new group");
  const id = Object.keys(SvalPanel.nodes).find(
    each =>
      SvalPanel.nodes[each].kind === SvalTree.GROUP &&
      SvalPanel.nodes[each].content?.name === name
  );
  Assert.ok(id, `${name}: the group is made`);
  await TestUtils.waitForCondition(
    () => rowNameIn(window, id) === name,
    `${name}: its row shows its name`
  );
  return id;
}

/**
 * Moves `id` into `group` with the row menu's "Move to group".
 *
 * @param {string} id
 * @param {string} group
 */
async function moveToGroup(id, group) {
  const menu = await contextMenuIn(window, id);
  await menuCommand(menu, `moveParent:${group}`);
  await TestUtils.waitForCondition(
    () =>
      SvalPanel.nodes[id]?.placement.parent === group &&
      Number(rowIn(window, id)?.getAttribute("aria-level")) ===
        Number(rowIn(window, group)?.getAttribute("aria-level")) + 1,
    "the tab is drawn inside the group"
  );
}

/**
 * @param {string} parent
 * @returns {string[]} its children, in the order the panel draws them.
 */
function drawnChildren(parent) {
  const children = SvalTree.childrenByParent(SvalPanel.nodes).get(parent);
  return Array.from(SvalPanel._els.tree.querySelectorAll(".sval-row"))
    .map(row => row.dataset.nodeId)
    .filter(id => children?.includes(id));
}

add_task(async function groups_keep_their_tabs_through_every_move() {
  await newWorkspace("Sorting");
  const urls = ["One", "Two", "Three"].map(titledRed);
  const ids = [];
  for (const url of urls) {
    ids.push(await nodeOfTab(await openPage(url)));
  }
  const alpha = await newGroup("Alpha");
  const beta = await newGroup("Beta");

  await moveToGroup(ids[0], alpha);
  await moveToGroup(ids[1], alpha);
  await moveToGroup(ids[2], beta);
  Assert.deepEqual(drawnChildren(alpha), ids.slice(0, 2), "Alpha holds two");
  Assert.deepEqual(drawnChildren(beta), [ids[2]], "and Beta one");

  await moveToGroup(ids[1], beta);
  Assert.deepEqual(drawnChildren(alpha), [ids[0]], "a tab moved out of Alpha");
  Assert.equal(drawnChildren(beta).length, 2, "into Beta");

  const before = drawnChildren(beta);
  const menu = await contextMenuIn(window, before[1]);
  await menuCommand(menu, "moveBefore");
  await TestUtils.waitForCondition(
    () =>
      JSON.stringify(drawnChildren(beta)) ===
      JSON.stringify([before[1], before[0]]),
    "Move up puts the tab above its neighbour"
  );

  // A folded group still draws the tab the window shows, so that is one
  // outside it.
  await clickRowShows(window, ids[0], urls[0], "a tab outside the group");
  clickRow(window, beta);
  await TestUtils.waitForCondition(
    () =>
      rowIn(window, beta).getAttribute("aria-expanded") === "false" &&
      before.every(id => !rowIn(window, id)),
    "a click folds the group, hiding its tabs"
  );
  clickRow(window, beta);
  await TestUtils.waitForCondition(
    () =>
      rowIn(window, beta).getAttribute("aria-expanded") === "true" &&
      before.every(id => rowIn(window, id)),
    "and another unfolds it"
  );

  for (const [i, id] of ids.entries()) {
    await clickRowShows(window, id, urls[i], `tab ${i + 1} after its moves`);
  }
});

add_task(async function a_renamed_group_keeps_its_name_in_a_new_window() {
  const start = SvalWindowWorkspace.of(window).id;
  const named = await newWorkspace("Naming");
  const url = titledRed("Grouped");
  const id = await nodeOfTab(await openPage(url));
  const group = await newGroup("Before");
  await moveToGroup(id, group);

  const menu = await contextMenuIn(window, group);
  await menuCommand(menu, "edit");
  const doc = await dialogIn(window, ".sval-nw-name");
  Assert.equal(doc.querySelector(".sval-nw-name").value, "Before");
  typeIn(doc.querySelector(".sval-nw-name"), "After");
  doc.querySelector(".sval-nw-create").click();
  await TestUtils.waitForCondition(
    () => rowNameIn(window, group) === "After",
    "the row shows the new name"
  );
  await TestUtils.waitForCondition(() => !gDialogBox.isOpen, "it closes");

  await switchVia(window, start);
  const win = await tearOffVia(window, named);
  await TestUtils.waitForCondition(
    () => rowNameIn(win, group) === "After",
    "a new window shows the group's new name"
  );
  if (!rowIn(win, id)) {
    clickRow(win, group);
  }
  await TestUtils.waitForCondition(() => rowIn(win, id), "its tab's row");
  await clickRowShows(win, id, url, "the group's tab in the new window");
});
