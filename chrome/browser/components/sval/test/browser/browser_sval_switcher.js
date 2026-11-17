/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * Spec §10.7: a window shows one workspace, and a switcher at the top of the
 * panel names it and lists the others. Every task here is a way a person
 * could lose sight of their tabs, asserted against the window's own panel,
 * engine and tab observer, and against the DOM the panel drew. The fixture the
 * switcher files share is in `sval_switcher_helpers.js`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

/**
 * The panel draws one workspace's children, and the switcher names that one
 * and offers the rest.
 */
add_task(async function the_panel_draws_one_workspace_and_names_it() {
  const { ids } = await withSwitcherPanel();
  const [first, second] = ids.workspaces;

  Assert.equal(
    SvalPanel.workspaceId,
    first,
    "the window shows the workspace it switched to"
  );
  Assert.deepEqual(
    drawnIds(),
    [ids.tabs[0]],
    "the rows are that workspace's children and nothing else — the second " +
      "workspace's tab is data this window holds and does not draw"
  );
  Assert.ok(
    !SvalPanel._rowElementFor(first) && !SvalPanel._rowElementFor(second),
    "and no workspace is a row: the switcher is where a workspace is named"
  );
  Assert.equal(
    SvalPanel._els.switcher.textContent,
    "Workspace 1",
    "the switcher names the one being shown"
  );
  Assert.ok(
    SvalPanel._els.switcher.getAttribute("aria-label").includes("Workspace 1"),
    "and its accessible name contains the visible one, so the two agree"
  );

  Assert.equal(
    SvalPanel._els.switcher.getAttribute("aria-expanded"),
    "false",
    "the closed switcher says so, so a screen reader is told there is a menu"
  );

  const menu = await openSwitcher();
  Assert.equal(
    SvalPanel._els.switcher.getAttribute("aria-expanded"),
    "true",
    "and says so while it is open"
  );
  const entries = switcherEntries(menu, ids.workspaces);
  Assert.deepEqual(
    entries.map(item => item.getAttribute("label")),
    ["Workspace 1", "Workspace 2"],
    "the switcher lists every workspace in sibling order, the shown one in " +
      "its place"
  );
  Assert.deepEqual(
    entries.map(item => item.getAttribute("aria-current")),
    ["true", null],
    "and marks the one its button names as current"
  );
  Assert.deepEqual(
    Array.from(menu.querySelectorAll("[data-open-workspace-id]"))
      .map(item => item.dataset.openWorkspaceId)
      .filter(id => ids.workspaces.includes(id)),
    ids.workspaces.slice(1),
    "and every workspace but the one this window shows can be opened in a " +
      "window of its own: a workspace has one window (spec §10.7)"
  );

  await closeSwitcher(menu);
  Assert.equal(
    SvalPanel._els.switcher.getAttribute("aria-expanded"),
    "false",
    "and goes back to saying it is closed once it is"
  );
});

/**
 * Choosing a workspace redraws the panel from it, and the window remembers:
 * per window, in the session store, never in the synced document (spec §5.6).
 */
add_task(async function switching_redraws_and_the_window_remembers() {
  const { ids, engine } = await withSwitcherPanel();
  const [first, second] = ids.workspaces;

  const menu = await openSwitcher();
  await activateWorkspace(menu, second);

  Assert.equal(
    SvalPanel.workspaceId,
    second,
    "the window shows the workspace that was chosen"
  );
  Assert.deepEqual(
    drawnIds(),
    [ids.tabs[1]],
    "and draws its children instead of the first workspace's"
  );
  Assert.equal(
    SvalPanel._els.switcher.textContent,
    "Workspace 2",
    "the switcher names where the user now is"
  );
  Assert.equal(
    SessionStore.getCustomWindowValue(window, CURRENT_WORKSPACE_KEY),
    second,
    "the choice is remembered per window, which is what survives a restart"
  );

  // Never in the document: syncing a window's attention would drag one
  // device's onto another's (spec §5.6, §10.7).
  const exported = await engine.exportJson();
  Assert.ok(
    !exported.includes(CURRENT_WORKSPACE_KEY),
    "and nothing about it reaches the document sval publishes"
  );

  Assert.equal(
    SvalPanel._rememberedWorkspaceId(),
    second,
    "a window reopened reads back what it was showing, not the first"
  );

  Assert.strictEqual(
    await SvalPanel.switchTo(second),
    false,
    "switching to the workspace already shown is not a switch"
  );
  Assert.strictEqual(
    await SvalPanel.switchTo(ids.tabs[0]),
    false,
    "and a node that is not a workspace is refused rather than shown, which " +
      "would leave the window remembering an id that draws nothing"
  );
  Assert.equal(
    SvalPanel.workspaceId,
    second,
    "neither refusal moved the window"
  );
  Assert.ok(first, "the first workspace is still there to go back to");
});

/**
 * A window left pointing at a workspace the document does not hold draws
 * nothing, and a panel with no rows and no switcher entry for where it thinks
 * it is has no way out of that state. So it falls back.
 */
add_task(async function a_workspace_closed_elsewhere_falls_back_to_the_first() {
  const { ids, engine } = await withSwitcherPanel();
  const [, second] = ids.workspaces;
  const first = await nameTheProfilesWorkspace("Home");

  const menu = await openSwitcher();
  await activateWorkspace(menu, second);
  Assert.equal(SvalPanel.workspaceId, second, "showing the second");

  // A peer's close arrives as the node gone (spec §5.4: no tombstone, no
  // closed state).
  await engine.mutate({ kind: "remove", id: ids.tabs[1] });
  await engine.mutate({ kind: "remove", id: second });
  await SvalPanel.refresh();

  Assert.equal(
    SvalPanel.workspaceId,
    first,
    "the window falls back to the first workspace in sibling order"
  );
  Assert.ok(drawnIds().length, "so the panel has rows rather than being empty");
  Assert.equal(
    SvalPanel._els.switcher.textContent,
    "Home",
    "and says where the user has been put"
  );
  Assert.equal(
    SessionStore.getCustomWindowValue(window, CURRENT_WORKSPACE_KEY),
    first,
    "the fallback is remembered, so the next redraw is not another fallback"
  );

  const reopened = await openSwitcher();
  Assert.deepEqual(
    switcherEntries(reopened, [second]),
    [],
    "the closed workspace is gone from the switcher too"
  );
  await closeSwitcher(reopened);
});

/**
 * One workspace is the state every new user is in, and the switcher has to
 * work there (`one_workspace_still_makes_a_switcher_entry` in
 * test_sval_panel_workspaces.js says why).
 */
add_task(async function one_workspace_still_has_a_working_switcher() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await nameTheProfilesWorkspace("Home");

  Assert.equal(
    SvalPanelModel.workspaceIds(SvalPanel.nodes).length,
    1,
    "the profile's document holds exactly one workspace, which is the state " +
      "under test"
  );
  const shown = window.getComputedStyle(SvalPanel._els.switcher).display;
  Assert.notEqual(shown, "none", "the switcher is on screen");
  Assert.ok(!SvalPanel._els.switcher.disabled, "and is operable");
  Assert.equal(
    SvalPanel._els.switcher.textContent,
    "Home",
    "naming the only workspace there is"
  );

  const menu = await openSwitcher();
  const entries = switcherEntries(menu);
  Assert.deepEqual(
    entries.map(item => item.getAttribute("aria-current")),
    ["true"],
    "it opens on the one workspace there is, marked as current"
  );
  Assert.ok(
    !entries[0].querySelector("[data-open-workspace-id]"),
    "which no other window can open, since this one shows it"
  );
  Assert.ok(
    menu.querySelector("[data-sval-new-workspace]"),
    "and offers to make another"
  );
  await closeSwitcher(menu);
});

/**
 * A workspace arriving from a peer while the panel is open does not move the
 * window: it is offered in the switcher and changes nothing about what this
 * window is showing.
 *
 * The window is put in the *second* workspace first, so a panel that re-picked
 * the first workspace on every redraw fails here.
 */
/**
 * New Workspace has no key until the user gives it one in Settings, and the
 * switcher's entry shows the key once it has one.
 */
add_task(async function new_workspace_shows_the_key_the_user_gave_it() {
  await withSwitcherPanel({ workspaces: 1 });
  const { NEW_WORKSPACE_KEY, shortcutText } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
  );
  const key = document.getElementById(NEW_WORKSPACE_KEY);

  let menu = await openSwitcher();
  let entry = menu.querySelector("[data-sval-new-workspace]");
  Assert.equal(
    entry.getAttribute("key"),
    NEW_WORKSPACE_KEY,
    "it names its key"
  );
  Assert.ok(!entry.getAttribute("acceltext"), "which shows nothing unbound");
  await closeSwitcher(menu);

  // As `CustomKeys` binds a key the user sets.
  key.setAttribute("key", "N");
  key.setAttribute("modifiers", "accel,alt");
  registerCleanupFunction(() => {
    key.removeAttribute("key");
    key.removeAttribute("modifiers");
  });
  menu = await openSwitcher();
  entry = menu.querySelector("[data-sval-new-workspace]");
  Assert.equal(
    entry.getAttribute("acceltext"),
    shortcutText({ key: "N", modifiers: "accel,alt" }),
    "and shows the key once the user gives it one"
  );
  await closeSwitcher(menu);
  key.removeAttribute("key");
  key.removeAttribute("modifiers");
});

add_task(async function a_peers_workspace_does_not_move_this_window() {
  const { ids, engine, root, keys } = await withSwitcherPanel();
  const [first, second] = ids.workspaces;

  const chosen = await openSwitcher();
  await activateWorkspace(chosen, second);
  Assert.equal(SvalPanel.workspaceId, second, "showing the second");
  const before = drawnIds();

  const peer = new SvalEngine({
    root,
    ...keys,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => stopEngine(peer));
  await peer.sync(SYNC_DOCUMENT, Date.now());
  const theirs = await peer.mutate({
    kind: "addWorkspace",
    name: "Made on the other device",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await peer.sync(SYNC_DOCUMENT, Date.now());

  // The pass a poll runs, which is how a peer's change reaches an idle
  // window.
  Assert.ok(await SvalPanel._syncInBackground(), "the poll read the folder");
  Assert.ok(theirs in SvalPanel.nodes, "and brought the workspace in");
  const order = SvalPanelModel.workspaceIds(SvalPanel.nodes);
  Assert.less(
    order.indexOf(first),
    order.indexOf(theirs),
    "the workspace this window is not in still comes before the arrival"
  );

  Assert.equal(
    SvalPanel.workspaceId,
    second,
    "and the window is still in the workspace its user was working in"
  );
  Assert.deepEqual(before, drawnIds(), "with the same rows as before");
  Assert.equal(
    SvalPanel._els.switcher.textContent,
    "Workspace 2",
    "and the switcher still names that one"
  );

  const menu = await openSwitcher();
  Assert.ok(
    Array.from(menu.children).some(item => item.dataset.workspaceId === theirs),
    "the arrival is offered — reachable, not imposed"
  );
  await closeSwitcher(menu);

  await engine.sync(SYNC_DOCUMENT, Date.now());
});

/**
 * A window's acts stay inside the workspace it shows.
 *
 * The selection is kept per workspace, so the workspace left keeps its own.
 * Filing a new tab against it would open a tab in this window with no row
 * anywhere in it.
 */
add_task(async function a_switch_keeps_new_tabs_in_the_workspace_shown() {
  const { ids } = await withSwitcherPanel();
  const [first, second] = ids.workspaces;

  await SvalPanel._select(ids.tabs[0]);
  Assert.equal(
    await SvalPanel._newTabParent(),
    first,
    "a tab selected in the first workspace files beside itself"
  );

  Assert.ok(await SvalPanel.switchTo(second), "the window switched");
  await assertNoHandOverFailure();
  // One of the browser's own pages is filed in the workspace the tab observer
  // was told the window shows, whatever is selected (`SvalTabs`' `fileTab`).
  const page = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:license"),
    10_000,
    "a browser page opening"
  );
  Assert.equal(
    (await filedAt(page)).parent,
    second,
    "the tab observer was told, so a stray is filed where the user can see it"
  );
  Assert.equal(
    SvalPanel.settings.selectionIn(first),
    ids.tabs[0],
    "the workspace that was left keeps its selection"
  );
  Assert.notEqual(
    SvalPanel._selectedId(),
    ids.tabs[0],
    "which is not the window's selection"
  );
  Assert.equal(
    await SvalPanel._newTabParent(),
    second,
    "and a new tab is filed in the workspace the window shows, not there"
  );
});

/**
 * Making a workspace goes to it. A new workspace is empty, so the window that
 * asked for it is the one that means to start filling it.
 */
add_task(async function a_new_workspace_is_the_one_the_window_shows() {
  const { ids } = await withSwitcherPanel();

  await chooseNewWorkspace();
  await answerNewContainer({ name: "Made here", color: null, emoji: null });
  {
    let made;
    await TestUtils.waitForCondition(() => {
      made = SvalPanelModel.workspaceIds(SvalPanel.nodes).find(
        id => SvalPanel.nodes[id].content.name === "Made here"
      );
      return (
        made &&
        SvalPanel.workspaceId === made &&
        SvalPanel._els.switcher.querySelector(".sval-switcher-name")
          ?.textContent === "Made here"
      );
    }, "the workspace reaches the document and the window shows it");
    atTaskEnd(() => removeWorkspace(made));
    Assert.equal(
      SvalPanel.workspaceId,
      made,
      "and the window shows it rather than leaving the user where they were"
    );
    Assert.equal(
      SessionStore.getCustomWindowValue(window, CURRENT_WORKSPACE_KEY),
      made,
      "remembered, like any other switch"
    );
    Assert.ok(
      drawnIds().every(id => SvalPanel.nodes[id]?.placement.parent === made),
      "every row drawn is the new workspace's own"
    );
    Assert.equal(
      SvalPanel._els.switcher.textContent,
      "Made here",
      "under the name its owner typed"
    );
    Assert.ok(
      !drawnIds().includes(ids.tabs[0]),
      "and nothing from the workspace it left"
    );
  }
});

/**
 * The colour and emoji chosen while creating a workspace are in the document
 * with it, and a workspace made with only a name has neither.
 */
add_task(async function a_new_workspace_is_made_with_the_look_it_was_given() {
  await withSwitcherPanel();

  for (const answer of [
    { name: "Painted", color: "orange", emoji: "🐟" },
    { name: "Bare", color: null, emoji: null },
  ]) {
    await chooseNewWorkspace();
    await answerNewContainer(answer);
    await TestUtils.waitForCondition(
      () =>
        SvalPanel.nodes[SvalPanel.workspaceId]?.content.name === answer.name &&
        SvalPanel._els.switcher.querySelector(".sval-switcher-name")
          ?.textContent === answer.name,
      "the workspace is made and the window shows it"
    );
  }

  const nodes = (await SvalPanel.engine.tree()).nodes;
  const find = name =>
    Object.entries(nodes).find(([, node]) => node.content.name === name);
  for (const name of ["Painted", "Bare"]) {
    atTaskEnd(() => removeWorkspace(find(name)[0]));
  }
  const painted = find("Painted")[1];
  const bare = find("Bare")[1];
  Assert.equal(painted.appearance?.color, "orange", "the colour");
  Assert.equal(painted.appearance?.emoji, "🐟", "and the emoji");
  Assert.ok(
    !bare.appearance?.color && !bare.appearance?.emoji,
    "a workspace made with a name alone has neither"
  );
});

/**
 * A group made through the new-group dialog wears the colour and emoji chosen
 * there.
 */
add_task(async function a_new_group_is_made_with_the_look_it_was_given() {
  await withSwitcherPanel();

  chooseNewGroup();
  await answerNewContainer({
    name: "Painted group",
    color: "purple",
    emoji: "🌿",
  });

  const group = await nodeNamed("Painted group");
  Assert.equal(group?.kind, "group", "the group is made");
  Assert.equal(group.appearance?.color, "purple", "with the colour");
  Assert.equal(group.appearance?.emoji, "🌿", "and the emoji");
});

/**
 * A group just made is not selected. The selection belongs to the active tab
 * and stays there, so the new row never wears the selected row's bar; the row
 * pulses instead, so the eye still finds it.
 */
add_task(async function a_new_group_does_not_take_the_selection() {
  const { ids } = await withSwitcherPanel();
  await SvalPanel._select(ids.tabs[0]);

  // The pulse is a class its animation's end takes off again, so it is
  // recorded as it goes on.
  const flashed = [];
  const watch = new MutationObserver(records => {
    for (const { target } of records) {
      if (target.classList.contains("sval-row-new")) {
        flashed.push(target.dataset.nodeId);
      }
    }
  });
  watch.observe(SvalPanel._els.tree, {
    subtree: true,
    attributeFilter: ["class"],
  });
  let group;
  try {
    chooseNewGroup();
    await answerNewContainer({ name: "Fresh group", color: null, emoji: null });
    ({ id: group } = await nodeNamed("Fresh group"));
    await TestUtils.waitForCondition(
      () => flashed.includes(group),
      "the group's row is drawn"
    );
  } finally {
    watch.disconnect();
  }
  Assert.equal(
    SvalPanel._selectedId(),
    ids.tabs[0],
    "the selection stays with the tab"
  );
  Assert.equal(
    SvalPanel._rowElementFor(ids.tabs[0]).getAttribute("aria-selected"),
    "true",
    "whose row is still the selected one"
  );
  Assert.notEqual(
    SvalPanel._rowElementFor(group).getAttribute("aria-selected"),
    "true",
    "and the new group's row is not"
  );
  Assert.deepEqual(
    [...new Set(flashed)],
    [group],
    "the new group's row pulses instead"
  );
});
