/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* `SvalPanel` is declared by a classic script the chrome window loads, so
 * there is no module to import it from. */
/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/**
 * What `test/xpcshell/test_sval_panel_*.js` cannot prove: that the ARIA
 * attributes reach the DOM, that a real key event moves real focus, and that
 * a click on the panel reaches the engine.
 * The fixture they share is in `sval_panel_helpers.js`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

/**
 * A nameless tab row draws its address, or for a blank page the new tab
 * placeholder (`SvalPanel.tabPlaceholder` says why). Workspaces and groups
 * keep their placeholders.
 */
add_task(async function a_nameless_tab_row_draws_its_address() {
  const { engine, ids, settings } = await withFreshPanel();

  const nameless = {
    hosted: crypto.randomUUID(),
    subdomain: crypto.randomUUID(),
    local: crypto.randomUUID(),
    blank: crypto.randomUUID(),
    nowhere: crypto.randomUUID(),
    group: crypto.randomUUID(),
  };
  const now = Date.now();
  for (const [id, url] of [
    [nameless.hosted, "https://www.bbc.co.uk/news/world"],
    [nameless.subdomain, "https://docs.example.org/a/b?c=d"],
    [nameless.local, "file:///Users/someone/notes.html"],
    [nameless.blank, "about:blank"],
    [nameless.nowhere, ""],
  ]) {
    await engine.mutate({
      kind: "addTab",
      parent: ids.workspace,
      name: "",
      url,
      id,
      now,
    });
  }
  await engine.mutate({
    kind: "addGroup",
    parent: ids.workspace,
    name: "",
    id: nameless.group,
    now,
  });
  settings.setCollapsed(nameless.group, false);
  await SvalPanel.refresh();

  const label = id =>
    SvalPanel._rowElementFor(id).querySelector(".sval-row-name").textContent;

  Assert.equal(
    label(nameless.hosted),
    "bbc.co.uk",
    "a nameless tab draws its host, with www. left off"
  );
  Assert.equal(
    label(nameless.subdomain),
    "docs.example.org",
    "a subdomain that is not www. is part of the host and stays"
  );
  Assert.equal(
    label(nameless.local),
    "file:///Users/someone/notes.html",
    "an address with no host draws the whole address"
  );
  Assert.equal(
    label(nameless.blank),
    SvalPanel.tabPlaceholder(null),
    "and a genuinely blank page is a new tab"
  );
  Assert.equal(
    label(nameless.nowhere),
    SvalPanel.tabPlaceholder(null),
    "as is a tab filed with no address at all"
  );

  Assert.equal(
    label(nameless.group),
    SvalPanel._untitled(SvalTree.GROUP),
    "a nameless group still says so: it has no address to fall back on"
  );
});

/**
 * The nested structure is drawn, and every row carries the roles and numbers
 * spec §10.5 requires.
 */
add_task(async function the_panel_draws_the_tree_with_correct_aria() {
  const { tree, ids } = await withFreshPanel();

  Assert.equal(tree.getAttribute("role"), "tree", "the container is a tree");
  Assert.ok(
    tree.getAttribute("aria-label").includes("Work"),
    "and is named, so it does not announce as an unlabelled tree"
  );

  const rows = drawnRows();
  Assert.deepEqual(
    rows.map(row => row.dataset.nodeId),
    [ids.groupA, ids.tab1, ids.tab2, ids.tab3, ids.loose, ids.groupB, ids.tab4],
    "the current workspace's children are drawn depth-first, with the loose " +
      "tab between the two groups where its order key puts it"
  );
  Assert.ok(
    !SvalPanel._rowElementFor(ids.workspace),
    "and the workspace itself is not a row: the switcher names it (§10.7)"
  );

  for (const row of rows) {
    Assert.equal(
      row.getAttribute("role"),
      "treeitem",
      `${row.dataset.nodeId} is a treeitem`
    );
  }

  const attributes = row =>
    [
      row.getAttribute("aria-level"),
      row.getAttribute("aria-posinset"),
      row.getAttribute("aria-setsize"),
    ].join("/");

  Assert.equal(
    attributes(rows[0]),
    "1/1/3",
    "the workspace has three children — two groups and a tab — and the first " +
      "group is 1 of those 3 at level 1, not 1 of 2 groups"
  );
  Assert.equal(
    attributes(rows[1]),
    "2/1/3",
    "the first of three tabs at level 2"
  );
  Assert.equal(attributes(rows[3]), "2/3/3", "the third of three tabs");
  Assert.equal(
    attributes(rows[4]),
    "1/2/3",
    "the loose tab is the workspace's second child, counted with the groups"
  );
  Assert.equal(attributes(rows[5]), "1/3/3", "and the second group its third");
  Assert.equal(attributes(rows[6]), "2/1/1", "the lone tab under that group");

  Assert.equal(
    rows[0].getAttribute("aria-expanded"),
    "true",
    "an expanded group says so"
  );
  Assert.ok(
    !rows[1].hasAttribute("aria-expanded"),
    "a tab has no expansion state to report"
  );
  Assert.ok(
    !rows[4].hasAttribute("aria-expanded"),
    "and neither does a tab sitting at group level"
  );

  Assert.equal(
    rows.filter(row => row.getAttribute("tabindex") === "0").length,
    1,
    "exactly one row is in the tab order — the tree is one tab stop, not seven"
  );
});

/**
 * Spec §10.4 requires the full set size once rows virtualise. Collapsing a
 * branch takes its children off screen, and the branch's own numbers must not
 * move with them.
 */
add_task(async function aria_set_size_survives_a_collapse() {
  const { ids, settings } = await withFreshPanel();
  await viewTab(ids.loose);

  settings.setCollapsed(ids.groupA, true);
  SvalPanel.render();

  const rows = drawnRows();
  Assert.deepEqual(
    rows.map(row => row.dataset.nodeId),
    [ids.groupA, ids.loose, ids.groupB, ids.tab4],
    "the collapsed group's three tabs are no longer drawn"
  );
  Assert.equal(
    rows[0].getAttribute("aria-setsize"),
    "3",
    "and the collapsed group is still the first of the workspace's three"
  );
  Assert.equal(
    rows[0].getAttribute("aria-expanded"),
    "false",
    "reported as collapsed rather than as a leaf"
  );
  Assert.equal(
    rows[3].getAttribute("aria-setsize"),
    "1",
    "its sibling's own child is unaffected"
  );
});

/**
 * Spec §10.5: arrow keys navigate, Left and Right fold. Asserted with real key
 * events against real focus, because a test that called the handler directly
 * would pass with no key binding at all.
 */
add_task(async function the_keyboard_reaches_every_row_and_folds() {
  const { ids } = await withFreshPanel();

  const expected = [
    ids.groupA,
    ids.tab1,
    ids.tab2,
    ids.tab3,
    ids.loose,
    ids.groupB,
    ids.tab4,
  ];

  drawnRows()[0].focus();
  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.groupA,
    "focus starts on the first row"
  );

  const walked = [document.activeElement.dataset.nodeId];
  for (let i = 1; i < expected.length; i++) {
    EventUtils.synthesizeKey("KEY_ArrowDown");
    walked.push(document.activeElement.dataset.nodeId);
  }
  Assert.deepEqual(
    walked,
    expected,
    "ArrowDown reaches every row in the tree, at every depth"
  );

  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.tab4,
    "and stops at the last row rather than wrapping"
  );

  EventUtils.synthesizeKey("KEY_Home");
  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.groupA,
    "Home returns to the first row"
  );
  EventUtils.synthesizeKey("KEY_End");
  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.tab4,
    "End goes to the last"
  );

  EventUtils.synthesizeKey("KEY_ArrowUp");
  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.groupB,
    "ArrowUp walks back"
  );

  EventUtils.synthesizeKey("KEY_ArrowLeft");
  await TestUtils.waitForCondition(
    () => drawnRows().length === expected.length - 1,
    "the collapsed group's child stops being drawn"
  );
  Assert.equal(
    SvalPanel._rowElementFor(ids.groupB).getAttribute("aria-expanded"),
    "false",
    "Left collapsed the group"
  );
  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.groupB,
    "and focus stayed on it"
  );

  EventUtils.synthesizeKey("KEY_ArrowRight");
  await TestUtils.waitForCondition(
    () => drawnRows().length === expected.length,
    "the child is drawn again"
  );
  Assert.equal(
    SvalPanel._rowElementFor(ids.groupB).getAttribute("aria-expanded"),
    "true",
    "Right expanded it"
  );

  // Left on a collapsed group, or on a leaf, moves out to the parent.
  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.equal(document.activeElement.dataset.nodeId, ids.tab4);
  EventUtils.synthesizeKey("KEY_ArrowLeft");
  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.groupB,
    "Left on a leaf moves out to its parent"
  );

  // Right on a tab does nothing, which is the ARIA tree pattern for a leaf.
  SvalPanel._rowElementFor(ids.loose).focus();
  EventUtils.synthesizeKey("KEY_ArrowRight");
  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.loose,
    "Right on a tab at group level leaves focus where it was"
  );
});

add_task(async function an_arrow_key_moves_focus_to_the_next_row() {
  await withFreshPanel();
  drawnRows()[0].focus();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.equal(
    document.activeElement,
    drawnRows()[1],
    "the arrow key moved focus to the next row"
  );
});

/**
 * A mutation started in the panel reaches the tree in the engine.
 * Driven by a click, so the mouse path is what is proven, and asserted
 * against `engine.tree()`.
 */
add_task(async function a_click_in_the_panel_reaches_the_tree() {
  const { engine, ids } = await withFreshPanel();

  await viewTab(ids.tab4);
  const addGroup = SvalPanel._els.header.querySelector(
    '[data-command="addGroup"]'
  );
  addGroup.click();
  await answerContainerDialog("Errands");

  await TestUtils.waitForCondition(async () => {
    const nodes = (await engine.tree()).nodes;
    return Object.values(nodes).some(node => node.content.name === "Errands");
  }, "the new group reaches the document");

  const nodes = (await engine.tree()).nodes;
  const [id, added] = Object.entries(nodes).find(
    ([, node]) => node.content.name === "Errands"
  );
  Assert.equal(added.kind, "group", "it is a group");
  Assert.equal(
    added.placement.parent,
    ids.groupB,
    "filed inside the group the user was working in, not at the top"
  );
  await TestUtils.waitForCondition(
    () => SvalPanel._rowElementFor(id),
    "and the panel drew it without being told to re-read"
  );

  // Deleting deletes once the Undo message goes: no closed state, no
  // tombstone (spec §5.4). An empty group has nothing to ask about.
  const menu = await openContextMenu(SvalPanel._rowElementFor(id));
  await activateMenuItem(menu, "deleteGroup");
  await dismissUndoMessage();
  await TestUtils.waitForCondition(
    async () => !(id in (await engine.tree()).nodes),
    "deleting the group removed the record entirely"
  );
  Assert.ok(!gDialogBox.isOpen, "without asking");
});

/**
 * F2 renames a tab, through the engine's `setLabel` call, and touches nothing
 * else.
 *
 * The content, placement and lifecycle groups are compared as serialised
 * JSON before and after. A label written into content would lose to the
 * next navigation on another device, and every substitute for a single-group
 * write, re-adding under the same id or remove-then-add, writes placement
 * too, which reorders the node or turns the edit into a deletion a peer's
 * concurrent edit may beat (spec §5.1, §5.4).
 */
add_task(
  async function f2_renames_a_tab_and_writes_only_the_appearance_group() {
    const { engine, ids } = await withFreshPanel();

    const before = (await engine.tree()).nodes[ids.tab2];
    Assert.equal(before.content.name, "Two", "the fixture's name");

    SvalPanel._rowElementFor(ids.tab2).focus();
    EventUtils.synthesizeKey("KEY_F2");
    const { value: offered } = await answerDialog({
      value: "Quarterly review",
    });

    await TestUtils.waitForCondition(async () => {
      const node = (await engine.tree()).nodes[ids.tab2];
      return node.appearance?.label === "Quarterly review";
    }, "the rename reaches the document");

    Assert.equal(
      offered,
      "Two",
      "the prompt starts from the name the row shows, not a placeholder"
    );

    const after = (await engine.tree()).nodes[ids.tab2];
    Assert.greater(
      after.appearance_at,
      before.appearance_at,
      "appearance_at moved with the name"
    );
    Assert.equal(
      JSON.stringify(after.content),
      JSON.stringify(before.content),
      "the content group, which follows the page, is byte-identical"
    );
    Assert.equal(
      after.content_at,
      before.content_at,
      "content_at is not stamped by a rename"
    );

    Assert.equal(
      JSON.stringify(after.placement),
      JSON.stringify(before.placement),
      "the placement group is byte-identical, so nothing reordered"
    );
    Assert.equal(
      after.placement_at,
      before.placement_at,
      "placement_at is not stamped by a rename"
    );
    Assert.equal(
      after.placement_by,
      before.placement_by,
      "nor is placement's writer"
    );
    Assert.equal(
      JSON.stringify(after.lifecycle),
      JSON.stringify(before.lifecycle),
      "the lifecycle group is byte-identical too"
    );
    Assert.equal(
      after.lifecycle_at,
      before.lifecycle_at,
      "lifecycle_at is not stamped by a rename"
    );

    Assert.equal(
      SvalPanel._rowElementFor(ids.tab2).querySelector(".sval-row-name")
        .textContent,
      "Quarterly review",
      "and the panel redrew the row"
    );
    Assert.deepEqual(
      drawnRows().map(row => row.dataset.nodeId),
      [
        ids.groupA,
        ids.tab1,
        ids.tab2,
        ids.tab3,
        ids.loose,
        ids.groupB,
        ids.tab4,
      ],
      "the renamed row kept its place in the tree"
    );
  }
);

/**
 * Clicks a part of a row, as a pointer user does.
 *
 * @param {Element} target Inside the row.
 * @param {object} [options] `EventUtils.synthesizeMouseAtCenter`'s.
 */
function clickRow(target, options = {}) {
  // The rows are a tree with a roving tabindex: Tab reaches the focused row
  // and the arrow keys the rest.
  AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
  EventUtils.synthesizeMouseAtCenter(target, options, window);
  AccessibilityUtils.resetEnv();
}

/**
 * One click on a tab's row shows its page (spec §10.4: "the page loads on
 * click"). A group's row takes the focus and folds or unfolds, because a group
 * has no page and is never selected.
 */
add_task(async function clicking_a_tab_row_opens_it() {
  const { ids } = await withFreshPanel();
  await viewTab(ids.loose);

  clickRow(SvalPanel._rowElementFor(ids.tab1).querySelector(".sval-row-name"));
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab === SvalPanel.observer.tabFor(ids.tab1),
    "a single click on a tab's row shows its page"
  );
  await switchDone();

  const selectionBefore = SvalPanel._selectedId();
  const expandedBefore = SvalPanel._rowElementFor(ids.groupA).getAttribute(
    "aria-expanded"
  );
  clickRow(
    SvalPanel._rowElementFor(ids.groupA).querySelector(".sval-row-name")
  );
  await TestUtils.waitForCondition(
    () => SvalPanel._focusedId === ids.groupA,
    "a click on a group's row focuses it"
  );
  Assert.equal(
    gBrowser.selectedTab,
    SvalPanel.observer.tabFor(ids.tab1),
    "and shows no other page"
  );
  Assert.equal(
    SvalPanel._selectedId(),
    selectionBefore,
    "and does not take the selection from the tab"
  );
  Assert.notEqual(
    SvalPanel._rowElementFor(ids.groupA).getAttribute("aria-expanded"),
    expandedBefore,
    "but it folds or unfolds the group"
  );
});

/**
 * Going to a tab from its row records the selection and when the tab was
 * looked at, both device-local (spec §5.6), and puts them on disk in one
 * write rather than one per thing recorded.
 */
add_task(async function a_row_click_writes_the_settings_file_once() {
  expectWorkspaceTabs();
  const { settings, ids } = await withFreshPanel();
  await settings.flushPending();
  await IOUtils.remove(settings.path, { ignoreAbsent: true });

  clickRow(SvalPanel._rowElementFor(ids.tab1).querySelector(".sval-row-name"));
  await within(
    TestUtils.waitForCondition(
      () => IOUtils.exists(settings.path),
      "the settings file is written"
    ),
    10_000,
    "the click's settings write"
  );
  const saved = await IOUtils.readJSON(settings.path);
  Assert.equal(
    saved.selections[SvalPanel.workspaceId],
    ids.tab1,
    "the file holds the selection"
  );
  Assert.ok(
    Number.isFinite(saved.lastActive[ids.tab1]),
    "and when the tab was looked at"
  );

  await IOUtils.remove(settings.path);
  await settings.flushPending();
  Assert.ok(
    !(await IOUtils.exists(settings.path)),
    "and the click left nothing to write a second time"
  );
});

/**
 * A fresh panel with a group inside `ids.groupA` holding one tab, and every
 * group folded, so the tab sits two collapsed groups deep.
 *
 * @returns {Promise<object>} `withFreshPanel`'s fixture, with `inner` and
 *   `deep`, the new group and tab.
 */
async function aTabTwoFoldsDeep() {
  let inner, deep;
  const fixture = await withFreshPanel({
    async before({ engine, ids }) {
      inner = await engine.mutate({
        kind: "addGroup",
        parent: ids.groupA,
        name: "Inner",
        id: crypto.randomUUID(),
        now: Date.now(),
      });
      deep = await engine.mutate({
        kind: "addTab",
        parent: inner,
        name: "Deep",
        url: "https://example.com/Deep",
        id: crypto.randomUUID(),
        now: Date.now(),
      });
    },
  });
  const { settings, ids } = fixture;
  for (const id of [ids.groupA, inner, ids.groupB]) {
    settings.setCollapsed(id, true);
  }
  await SvalPanel.refresh();
  Assert.ok(!SvalPanel._rowElementFor(deep), "the tab starts out of sight");
  return { ...fixture, inner, deep };
}

/**
 * Selecting a tab in the window reveals its row: `SvalTabs` hears
 * `TabSelect`, the path Cmd+number, the switcher, a link and an agent all
 * take.
 */
add_task(async function selecting_a_tab_opens_every_group_above_it() {
  const { settings, ids, inner, deep } = await aTabTwoFoldsDeep();

  await viewTab(deep);

  Assert.ok(!settings.isCollapsed(ids.groupA), "the outer group is open");
  Assert.ok(!settings.isCollapsed(inner), "and so is the inner one");
  const row = SvalPanel._rowElementFor(deep);
  Assert.ok(row, "the selected tab's row is drawn");
  Assert.equal(row.getAttribute("aria-selected"), "true", "and selected");
  Assert.ok(
    settings.isCollapsed(ids.groupB),
    "a group the selection is not in stays as it was"
  );
});

/**
 * A peer moving the selected tab into a group this device has never opened
 * reveals it when the change is drawn; a group the user folds over the
 * selected tab stays folded until the selection changes.
 */
add_task(async function a_moved_selection_is_revealed_and_a_fold_is_kept() {
  const fixture = await withFreshPanel();
  const { engine, settings, ids } = fixture;
  await viewTab(ids.loose);

  const arrived = await engine.mutate({
    kind: "addGroup",
    parent: ids.groupB,
    name: "Arrived",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  settings.setCollapsed(ids.groupB, true);
  await engine.mutate({
    kind: "moveNode",
    id: ids.loose,
    newParent: arrived,
    before: null,
    after: null,
    now: Date.now(),
  });
  await SvalPanel.refresh();
  Assert.ok(!settings.isCollapsed(ids.groupB), "the group it went into opens");
  Assert.ok(!settings.isCollapsed(arrived), "and the new group inside it");
  Assert.ok(
    SvalPanel._rowElementFor(ids.loose),
    "so the selected row is drawn"
  );

  await SvalPanel._setCollapsed(ids.groupB, true);
  await SvalPanel.refresh();
  Assert.ok(
    settings.isCollapsed(ids.groupB),
    "a fold the user made over the selection survives a redraw"
  );

  await viewTab(ids.tab1);
  Assert.ok(settings.isCollapsed(ids.groupB), "selecting elsewhere opens none");
  await viewTab(ids.loose);
  Assert.ok(
    !settings.isCollapsed(ids.groupB),
    "and opens again when the tab is next selected"
  );
});

/**
 * Collapsing a group that holds the selected tab leaves that tab's row drawn
 * under it and hides the rest, and opens nothing. The row hides again once
 * the selection is elsewhere, and selecting it again opens the group.
 */
add_task(async function a_collapsed_group_keeps_the_selected_tab_drawn() {
  const { settings, ids } = await withFreshPanel();
  await viewTab(ids.tab2);

  await SvalPanel._setCollapsed(ids.groupA, true);
  Assert.ok(settings.isCollapsed(ids.groupA), "the collapse is kept");
  Assert.deepEqual(
    drawnIds(),
    [ids.groupA, ids.tab2, ids.loose, ids.groupB, ids.tab4],
    "the selected tab stays under its collapsed group, alone"
  );
  const header = SvalPanel._rowElementFor(ids.groupA);
  Assert.equal(header.getAttribute("aria-expanded"), "false", "collapsed");
  Assert.ok(header.hasAttribute("data-sval-shows-selection"));
  const row = SvalPanel._rowElementFor(ids.tab2);
  Assert.equal(row.getAttribute("aria-selected"), "true", "and selected");
  Assert.equal(row.getAttribute("aria-level"), "2", "at its own level");
  Assert.equal(row.getAttribute("aria-posinset"), "2", "and its own place");
  Assert.equal(row.getAttribute("aria-setsize"), "3", "among all three");

  await viewTab(ids.loose);
  Assert.deepEqual(
    drawnIds(),
    [ids.groupA, ids.loose, ids.groupB, ids.tab4],
    "selecting elsewhere hides it again"
  );
  Assert.ok(settings.isCollapsed(ids.groupA), "and leaves the group folded");
  Assert.ok(
    !SvalPanel._rowElementFor(ids.groupA).hasAttribute(
      "data-sval-shows-selection"
    )
  );

  await viewTab(ids.tab2);
  Assert.ok(!settings.isCollapsed(ids.groupA), "selecting it opens the group");
  Assert.deepEqual(
    drawnIds(),
    [ids.groupA, ids.tab1, ids.tab2, ids.tab3, ids.loose, ids.groupB, ids.tab4],
    "and draws all it holds"
  );
});

/**
 * Two groups deep, the selected tab is drawn whichever group above it is
 * collapsed, with only the groups on its path.
 */
add_task(
  async function a_nested_selection_stays_drawn_under_collapsed_groups() {
    const { settings, ids, inner, deep } = await aTabTwoFoldsDeep();
    await viewTab(deep);

    await SvalPanel._setCollapsed(inner, true);
    Assert.deepEqual(
      drawnIds(),
      [
        ids.groupA,
        ids.tab1,
        ids.tab2,
        ids.tab3,
        inner,
        deep,
        ids.loose,
        ids.groupB,
      ],
      "the inner group folded: the tab stays under it"
    );

    await SvalPanel._setCollapsed(ids.groupA, true);
    Assert.deepEqual(
      drawnIds(),
      [ids.groupA, inner, deep, ids.loose, ids.groupB],
      "both folded: the path to the tab and nothing else"
    );
    Assert.ok(settings.isCollapsed(ids.groupA) && settings.isCollapsed(inner));
    Assert.equal(
      SvalPanel._rowElementFor(deep).getAttribute("aria-level"),
      "3",
      "the tab keeps its depth"
    );

    await SvalPanel._setCollapsed(inner, false);
    Assert.deepEqual(
      drawnIds(),
      [ids.groupA, inner, deep, ids.loose, ids.groupB],
      "the outer group folded hides the inner group's other contents"
    );

    await viewTab(ids.loose);
    Assert.deepEqual(
      drawnIds(),
      [ids.groupA, ids.loose, ids.groupB],
      "and the selection leaving hides the path"
    );
  }
);

/**
 * The keyboard walks the drawn rows, so it reaches the selected tab under a
 * collapsed group and carries on past it.
 */
add_task(async function the_keyboard_walks_past_a_collapsed_group() {
  const { ids } = await withFreshPanel();
  await viewTab(ids.tab2);
  await SvalPanel._setCollapsed(ids.groupA, true);

  SvalPanel._rowElementFor(ids.groupA).focus();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.tab2,
    "Down from the collapsed group lands on the selected tab"
  );
  EventUtils.synthesizeKey("KEY_ArrowDown");
  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.loose,
    "and the next Down leaves the group"
  );
  EventUtils.synthesizeKey("KEY_ArrowUp");
  EventUtils.synthesizeKey("KEY_ArrowLeft");
  Assert.equal(
    document.activeElement.dataset.nodeId,
    ids.groupA,
    "Left from the tab moves out to its group"
  );
  EventUtils.synthesizeKey("KEY_ArrowRight");
  await TestUtils.waitForCondition(
    () => drawnIds().includes(ids.tab3),
    "Right on the collapsed group opens it"
  );
});

/**
 * A tab row carries a slot for the site's favicon before its name, filled from
 * the live tab and updated in place when the icon arrives.
 */
add_task(async function a_tab_row_draws_its_favicon() {
  const { ids } = await withFreshPanel();
  await viewTab(ids.tab1);
  const iconOf = id =>
    SvalPanel._rowElementFor(id).querySelector(".sval-row-icon");

  Assert.ok(iconOf(ids.tab2), "a tab row has the slot");
  Assert.ok(
    !iconOf(ids.tab2).hasAttribute("src"),
    "empty while its tab has no favicon"
  );
  Assert.ok(
    !SvalPanel._rowElementFor(ids.groupA).querySelector(".sval-row-icon"),
    "and only a tab row has one"
  );
  Assert.equal(
    iconOf(ids.tab1).nextElementSibling,
    SvalPanel._rowElementFor(ids.tab1).querySelector(".sval-row-name"),
    "the slot sits directly before the name"
  );

  const src = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>";
  const rowBefore = SvalPanel._rowElementFor(ids.tab1);
  gBrowser.setIcon(SvalPanel.observer.tabFor(ids.tab1), src);
  await TestUtils.waitForCondition(
    () => iconOf(ids.tab1).getAttribute("src") === src,
    "the icon shows"
  );
  Assert.equal(
    SvalPanel._rowElementFor(ids.tab1),
    rowBefore,
    "without rebuilding the row"
  );
});

/**
 * A tab that has not loaded here is marked so, and a tab that loads is
 * marked loaded without the row being rebuilt.
 */
add_task(async function an_unloaded_tab_row_is_marked() {
  const { ids } = await withFreshPanel();
  await viewTab(ids.loose);

  const row = SvalPanel._rowElementFor(ids.tab2);
  is(row.getAttribute("data-loaded"), "false", "an unloaded tab is marked");
  is(
    SvalPanel._rowElementFor(ids.groupA).getAttribute("data-loaded"),
    null,
    "a group is never marked"
  );

  await viewTab(ids.tab2);
  await TestUtils.waitForCondition(
    () => row.getAttribute("data-loaded") === "true",
    "a loaded tab is marked"
  );
  is(SvalPanel._rowElementFor(ids.tab2), row, "without rebuilding the row");
});

/**
 * A tab Sval will not open on this device (`SvalRestore.opensHere`) says so
 * on its row, so going to it doing nothing is not a mystery. This device's
 * own browser page is not one of them.
 */
add_task(async function a_tab_that_cannot_open_here_says_so() {
  const { engine, ids } = await withFreshPanel();
  const peers = crypto.randomUUID();
  const own = crypto.randomUUID();
  await engine.mutate({
    kind: "addTab",
    parent: ids.workspace,
    name: "Hosts",
    url: "file:///etc/hosts",
    local: false,
    id: peers,
    now: Date.now(),
  });
  await engine.mutate({
    kind: "addTab",
    parent: ids.workspace,
    name: "Source",
    url: "view-source:resource://gre/modules/Troubleshoot.sys.mjs",
    id: own,
    now: Date.now(),
  });

  await SvalPanel.refresh();
  const row = SvalPanel._rowElementFor(peers);
  ok(row.hasAttribute("data-unopenable"), "another device's file is marked");
  const said = row.getAttribute("aria-description");
  ok(said, "and says so to a screen reader");
  ok(
    row
      .querySelector(".sval-row-name")
      .getAttribute("title")
      .endsWith(`\n${said}`),
    "and in its tooltip"
  );
  ok(
    !SvalPanel._rowElementFor(own).hasAttribute("data-unopenable"),
    "this device's own page source is not"
  );
  ok(
    !SvalPanel._rowElementFor(ids.tab1).hasAttribute("data-unopenable"),
    "nor is a web page"
  );
});

/**
 * The switcher names the workspace, the header's buttons name themselves to
 * sight and to a screen reader, with New tab first, and every row says what
 * level it is on. "New workspace" is not in the header: the switcher is where
 * a workspace is made.
 */
add_task(async function the_panel_names_its_workspace_and_its_actions() {
  const { ids } = await withFreshPanel();

  Assert.equal(
    SvalPanel._els.switcher.querySelector(".sval-switcher-name").textContent,
    "Work",
    "the switcher names the workspace"
  );

  const header = SvalPanel._els.header;
  const [first] = header.children;
  Assert.equal(
    first.dataset.command,
    "addTab",
    "New tab is the header's first button"
  );
  Assert.ok(first.textContent.trim(), "labelled");
  const newGroup = header.querySelector('[data-command="addGroup"]');
  Assert.equal(first.nextElementSibling, newGroup, "New group is beside it");
  Assert.ok(newGroup.textContent.trim(), "labelled too");
  Assert.ok(
    !header.querySelector('[data-command="addWorkspace"]'),
    "and there is no New workspace button: the switcher makes workspaces"
  );

  Assert.equal(
    SvalPanel._rowElementFor(ids.groupA).getAttribute("aria-level"),
    "1",
    "a top-level row is level 1"
  );
  Assert.equal(
    SvalPanel._rowElementFor(ids.tab1).getAttribute("aria-level"),
    "2",
    "and a tab in a group is level 2"
  );
});

add_task(async function a_collapsed_group_shows_its_count() {
  const { ids, settings } = await withFreshPanel();
  await viewTab(ids.loose);

  const count = id =>
    SvalPanel._rowElementFor(id).querySelector(".sval-row-count");
  Assert.equal(count(ids.groupA).textContent, "3", "the group holds three");

  settings.setCollapsed(ids.groupA, true);
  await SvalPanel.refresh();
  Assert.ok(
    !SvalPanel._rowElementFor(ids.tab1) ||
      SvalPanel._rowElementFor(ids.tab1).hidden,
    "with its tabs out of sight"
  );
  settings.setCollapsed(ids.groupA, false);
  await SvalPanel.refresh();
});

/**
 * A coloured group's last visible row carries `data-sval-group-end`, and it is
 * recomputed when the group folds.
 */
add_task(async function a_coloured_block_marks_its_last_row() {
  const { ids, engine, settings } = await withFreshPanel();
  await viewTab(ids.loose);
  await engine.mutate({
    kind: "setAppearance",
    id: ids.groupA,
    color: "green",
    emoji: null,
    now: Date.now(),
  });
  await SvalPanel.refresh();

  const ended = () =>
    drawnRows().filter(el => el.hasAttribute("data-sval-group-end"));
  Assert.deepEqual(
    ended().map(el => el.dataset.nodeId),
    [ids.tab3],
    "the block ends at its last tab"
  );

  settings.setCollapsed(ids.groupA, true);
  await SvalPanel.refresh();
  Assert.deepEqual(
    ended().map(el => el.dataset.nodeId),
    [ids.groupA],
    "and at the header once the tabs fold away"
  );
  settings.setCollapsed(ids.groupA, false);
  await SvalPanel.refresh();
});

/**
 * Every row starts on a whole pixel of the tree, open and folded, so the gaps
 * between coloured blocks are all one height.
 */
add_task(async function every_row_starts_on_a_whole_pixel() {
  const { ids, engine, settings } = await withFreshPanel();
  await engine.mutate({
    kind: "setAppearance",
    id: ids.groupA,
    color: "green",
    emoji: null,
    now: Date.now(),
  });
  await SvalPanel.refresh();

  const offTheGrid = () => {
    const top = SvalPanel._els.tree.getBoundingClientRect().top;
    return drawnRows()
      .map(el => el.getBoundingClientRect().top - top)
      .filter(y => Math.abs(y - Math.round(y)) > 0.01);
  };
  Assert.deepEqual(offTheGrid(), [], "with the group open");
  settings.setCollapsed(ids.groupA, true);
  await SvalPanel.refresh();
  Assert.deepEqual(offTheGrid(), [], "and folded");
  settings.setCollapsed(ids.groupA, false);
  await SvalPanel.refresh();
});

/**
 * A group inside a group of another colour is a card drawn over the outer
 * colour, which keeps the whole width of every row, so the outer colour never
 * breaks where the inner one starts.
 */
add_task(async function a_nested_colour_is_a_card_over_the_outer_one() {
  const { ids, engine } = await withFreshPanel();
  const inner = crypto.randomUUID();
  const deep = crypto.randomUUID();
  const now = Date.now();
  await engine.mutate({
    kind: "addGroup",
    parent: ids.groupA,
    name: "Inner",
    id: inner,
    now,
  });
  await engine.mutate({
    kind: "addTab",
    parent: inner,
    name: "Deep",
    url: "https://example.com/deep",
    id: deep,
    now,
  });
  SvalPanel.settings.setCollapsed(inner, false);
  for (const [id, color] of [
    [ids.groupA, "green"],
    [inner, "red"],
  ]) {
    await engine.mutate({
      kind: "setAppearance",
      id,
      color,
      emoji: null,
      now,
    });
  }
  await SvalPanel.refresh();

  const header = SvalPanel._rowElementFor(inner);
  const tab = SvalPanel._rowElementFor(deep);
  Assert.ok(
    header.hasAttribute("data-sval-nested"),
    "the inner header is nested"
  );
  Assert.ok(
    header.hasAttribute("data-sval-nested-start"),
    "and starts its card"
  );
  Assert.ok(
    !SvalPanel._rowElementFor(ids.groupA).hasAttribute("data-sval-nested"),
    "the outer header is not"
  );
  Assert.equal(
    tab.querySelectorAll(".sval-row-surface").length,
    1,
    "a row in the card carries one surface"
  );
  Assert.ok(
    tab.querySelector(".sval-row-surface").hasAttribute("data-inner"),
    "which is the innermost"
  );
  Assert.ok(
    tab.querySelector(".sval-row-surface").hasAttribute("data-end"),
    "and ends the card at its last row"
  );
  Assert.strictEqual(
    SvalPanel._rowElementFor(ids.tab1).querySelector(".sval-row-surface"),
    null,
    "a row beside the card has none"
  );
});

/**
 * A tab with no live favicon of its own draws the one Firefox has cached for
 * its address. Sval restores tabs lazily, and a tab from another device is
 * never live here.
 */
add_task(async function a_tab_row_falls_back_to_the_cached_favicon() {
  const { ids } = await withFreshPanel();

  const pageURI = Services.io.newURI("https://example.com/One");
  const icon =
    "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'/>";
  await PlacesTestUtils.addVisits(pageURI);
  await PlacesUtils.favicons.setFaviconForPage(
    pageURI,
    Services.io.newURI("https://example.com/favicon.svg"),
    Services.io.newURI(icon)
  );
  registerCleanupFunction(() => PlacesUtils.history.clear());

  await SvalPanel.refresh();
  await TestUtils.waitForCondition(
    () =>
      SvalPanel._rowElementFor(ids.tab1)
        .querySelector(".sval-row-icon")
        .hasAttribute("src"),
    "the row takes the cached favicon"
  );
  Assert.ok(
    !SvalPanel._rowElementFor(ids.tab2)
      .querySelector(".sval-row-icon")
      .hasAttribute("src"),
    "and a tab with nothing cached stays empty"
  );
});

/**
 * Spec §10.5 requires everything reachable by mouse to be reachable by
 * keyboard, and says nothing about the reverse. F2 alone would leave a mouse
 * user unable to rename. The label is the target. A double-click anywhere
 * else on the row activates it.
 */
add_task(async function double_clicking_a_label_renames_it() {
  const { engine, ids } = await withFreshPanel();
  await viewTab(ids.loose);

  const row = SvalPanel._rowElementFor(ids.tab1);
  clickRow(row.querySelector(".sval-row-name"), { clickCount: 2 });
  await answerDialog({ value: "Renamed by pointer" });
  await TestUtils.waitForCondition(async () => {
    const node = (await engine.tree()).nodes[ids.tab1];
    return node.appearance?.label === "Renamed by pointer";
  }, "a double-click on the label renames the node");
  Assert.ok(
    [ids.loose, ids.tab1].includes(
      SvalPanel.observer.nodeIdFor(gBrowser.selectedTab)
    ),
    "and the only page it showed, through the first click, is that tab's"
  );

  // Anywhere else on the row still activates. The event is dispatched at the
  // row because the label covers most of the row's box, so no coordinate
  // reliably lands on the row itself, and what is under test is which
  // target the handler branches on.
  SvalPanel._rowElementFor(ids.tab3).dispatchEvent(
    new MouseEvent("dblclick", { bubbles: true })
  );
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab === SvalPanel.observer.tabFor(ids.tab3),
    "a double-click off the label still shows the tab"
  );
  await switchDone();
  Assert.ok(!gDialogBox.isOpen, "and renames nothing");
});

/**
 * A rename the engine refuses, asked for by a double-click, is handled as a
 * refused command is: the panel redraws from the engine's tree and tells the
 * user nothing (spec §10.7). The harness fails the task on a rejection left
 * unhandled, which is where an event handler's failure would otherwise go.
 */
add_task(async function a_refused_rename_from_a_double_click_redraws() {
  const { engine, ids } = await withFreshPanel();
  const empty = await engine.mutate({
    kind: "addGroup",
    parent: ids.workspace,
    name: "Empty",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await SvalPanel.refresh();

  SvalPanel._rowElementFor(empty)
    .querySelector(".sval-row-name")
    .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  // Another device deletes the group while the user names it, so the
  // engine refuses the rename (`require_node`).
  await answerDialog({
    value: "Refused by the engine",
    meanwhile: () =>
      engine.mutate({ kind: "remove", id: empty, now: Date.now() }),
  });
  await TestUtils.waitForCondition(
    () => !SvalPanel._rowElementFor(empty),
    "the panel redrew from the engine's tree once it refused the rename"
  );
  Assert.ok(
    !Object.values((await engine.tree()).nodes).some(
      node => node.content.name === "Refused by the engine"
    ),
    "and the document holds no node of that name"
  );
});

/**
 * Moving a node from the keyboard: it must not be mouse-only (spec §10.5).
 */
add_task(async function alt_arrow_moves_a_node() {
  const { engine, ids } = await withFreshPanel();

  SvalPanel._rowElementFor(ids.tab2).focus();
  EventUtils.synthesizeKey("KEY_ArrowUp", { altKey: true });

  await TestUtils.waitForCondition(
    () => drawnRows()[1]?.dataset.nodeId === ids.tab2,
    "the second tab is drawn first among its siblings"
  );

  const nodes = (await engine.tree()).nodes;
  const reordered =
    nodes[ids.tab2].placement.order < nodes[ids.tab1].placement.order;
  Assert.ok(
    reordered,
    "and the engine holds the new order key, not just the panel's row list"
  );

  // The moved tab is first among its siblings, so there is nothing above it
  // to indent into, and the move does nothing. A move posts to the engine in
  // the key's own dispatch, so the read below would see one.
  EventUtils.synthesizeKey("KEY_ArrowRight", { altKey: true });
  Assert.equal(
    (await engine.tree()).nodes[ids.tab2].placement.parent,
    ids.groupA,
    "Alt+Right with no sibling above it leaves the node where it was"
  );

  // Outdenting lifts it to the workspace, the fourth direction a drag can
  // express, which would otherwise need a drop target.
  SvalPanel._rowElementFor(ids.tab2).focus();
  EventUtils.synthesizeKey("KEY_ArrowLeft", { altKey: true });
  await TestUtils.waitForCondition(async () => {
    const parent = (await engine.tree()).nodes[ids.tab2].placement.parent;
    return parent === ids.workspace;
  }, "Alt+Left lifts the tab out of its group");
});

/**
 * A move the engine refuses did not happen, and the panel redraws what the
 * engine holds without saying anything.
 *
 * The panel never plans a move `tree::move_node` refuses, so a refusal means
 * the panel's picture was stale: here, another device closed the group the
 * user indents a tab into, and the window has not redrawn since. The redraw
 * is the answer: the group is gone and the tab is where it was. The user,
 * who cannot act on a race, is told nothing (spec §5.2, §10.7).
 */
add_task(async function a_refused_move_redraws_and_says_nothing() {
  const { engine, ids } = await withFreshPanel();

  // Collapsed, so that an optimistic open is visible: `_move` opens the parent
  // it is moving into, because a node moved somewhere invisible is
  // indistinguishable from a deleted one.
  SvalPanel.settings.setCollapsed(ids.groupA, true);
  await SvalPanel.refresh();

  await engine.mutate({
    kind: "batch",
    ops: [ids.tab1, ids.tab2, ids.tab3, ids.groupA].map(id => ({
      kind: "remove",
      id,
    })),
    now: Date.now(),
  });
  const before = JSON.stringify((await engine.tree()).nodes);
  Assert.ok(
    SvalPanel._rowElementFor(ids.groupA),
    "the window still draws the group the engine no longer holds"
  );

  // The loose tab sits after the group, so indenting it aims at the group.
  await SvalPanel._move(ids.loose, "moveIn");

  Assert.equal(
    JSON.stringify((await engine.tree()).nodes),
    before,
    "the document is exactly what it was"
  );
  Assert.ok(
    !SvalPanel._rowElementFor(ids.groupA),
    "the panel redrew from the engine's tree, so the closed group is gone"
  );
  Assert.equal(
    SvalPanel._rowElementFor(ids.loose)?.getAttribute("aria-level"),
    "1",
    "and the tab is drawn where it was, rather than inside a parent"
  );
});

/**
 * A tab's row fades in as the tab opens and out as it closes, and the fade
 * never stands in for the tab: a closed tab's row has no node id, takes no
 * focus and is hidden from assistive technology from the moment it closes,
 * and is gone once its fade is. Under `prefers-reduced-motion` it goes at
 * once.
 */
add_task(async function a_tab_row_fades_in_and_out() {
  const { engine, ids } = await withFreshPanel();

  const opened = await engine.mutate({
    kind: "addTab",
    parent: ids.workspace,
    name: "Opened",
    url: "https://example.com/Opened",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await SvalPanel.refresh();
  const row = SvalPanel._rowElementFor(opened);
  Assert.ok(
    row.classList.contains("sval-row-opening"),
    "the opened tab's row fades in"
  );
  Assert.ok(
    !SvalPanel._rowElementFor(ids.loose).classList.contains("sval-row-opening"),
    "and no row that was already there does"
  );

  await engine.mutate({ kind: "remove", id: opened });
  await SvalPanel.refresh();
  Assert.ok(!SvalPanel._rowElementFor(opened), "the closed tab has no row");
  Assert.ok(
    !drawnRows().some(drawn => drawn.dataset.nodeId === opened),
    "and is not among the drawn rows"
  );
  const leaving = SvalPanel._els.tree.querySelector(".sval-row-leaving");
  Assert.ok(leaving, "its row stays only to fade out");
  Assert.ok(
    leaving.inert && leaving.getAttribute("aria-hidden") === "true",
    "out of reach of focus and assistive technology"
  );
  Assert.ok(
    !leaving.hasAttribute("role") &&
      !leaving.hasAttribute("tabindex") &&
      !leaving.dataset.nodeId,
    "and naming no node"
  );
  // A row can still be fading once the first one found has gone, and one
  // left fading reads below as the reduced-motion close.
  await TestUtils.waitForCondition(
    () =>
      !leaving.isConnected &&
      !SvalPanel._els.tree.querySelector(".sval-row-leaving"),
    "the faded row is taken out of the tree"
  );

  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  try {
    // Gecko applies a look-and-feel pref on a later turn
    // (`nsPresContext::ThemeChanged`), so the panel reads it once it shows.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    await TestUtils.waitForCondition(
      () => reduced.matches,
      "the window prefers reduced motion"
    );
    const quiet = await engine.mutate({
      kind: "addTab",
      parent: ids.workspace,
      name: "Quiet",
      url: "https://example.com/Quiet",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    await SvalPanel.refresh();
    await engine.mutate({ kind: "remove", id: quiet });
    await SvalPanel.refresh();
    Assert.ok(
      !SvalPanel._els.tree.querySelector(".sval-row-leaving"),
      "with reduced motion a closed tab's row goes at once"
    );
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

/**
 * With Firefox's tab strip gone the panel is the only tab surface, so it has
 * to be able to make a tab. The button opens a tab in the window and
 * `TabOpen` files it.
 */
add_task(async function the_header_offers_a_new_tab() {
  const { ids } = await withFreshPanel();

  const button = SvalPanel._els.header.querySelector('[data-command="addTab"]');
  Assert.ok(button, "the header has a New tab button");
  Assert.equal(
    SvalPanel._els.header.firstChild,
    button,
    "and it comes first: it is the commonest act a tab surface has"
  );

  /**
   * The node of the tab `action` opens, once the observer has filed it.
   *
   * @param {Function} action
   * @returns {Promise<object>}
   */
  const filedTab = async action => {
    const opened = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "TabOpen"
    );
    await action();
    const tab = expectOpened(
      (await within(opened, 10_000, "the new tab opening")).target
    );
    await within(SvalPanel.observer.settled(), 10_000, "the tab being filed");
    return SvalPanel.nodes[SvalPanel.observer.nodeIdFor(tab)];
  };

  // A tab inside a group is the one being viewed, which is when a new tab
  // could be mistaken for one meant to go beside it.
  await viewTab(ids.tab1);
  const top = await filedTab(() => button.click());
  Assert.equal(
    top?.placement.parent,
    ids.workspace,
    "clicking it opened a tab at the top of the workspace"
  );

  // The same command from the context menu, so a menu entry is never a
  // second implementation of the button. Aimed at a row, its tab goes in
  // that row.
  const inGroup = await filedTab(async () => {
    const menu = await openContextMenu(SvalPanel._rowElementFor(ids.groupA));
    await activateMenuItem(menu, "addTab");
  });
  Assert.equal(
    inGroup?.placement.parent,
    ids.groupA,
    "and so did the context menu's entry, in the row it was opened on"
  );
});

/**
 * Favorites sit directly under the workspace switcher, list the favorites
 * document, and choosing one opens a new tab (import spec §6).
 */
add_task(async function favorites_open_a_new_tab() {
  await withFreshPanel();
  const url = "https://example.com/favorite";
  const { store } = await favoritesFixture();
  await store.insertTree([{ title: "A favorite", url }]);

  const switcher = SvalPanel._els.switcherMenu;
  const switcherShown = BrowserTestUtils.waitForPopupEvent(switcher, "shown");
  EventUtils.synthesizeMouseAtCenter(SvalPanel._els.switcher, {});
  await within(switcherShown, 10_000, "the switcher showing");
  Assert.ok(
    !switcher.querySelector("[data-sval-favorites], [placespopup]"),
    "the switcher holds workspaces and no Favorites"
  );
  const switcherHidden = BrowserTestUtils.waitForPopupEvent(switcher, "hidden");
  switcher.hidePopup();
  await within(switcherHidden, 10_000, "the switcher hiding");

  const button = SvalPanel._els.favorites;
  const bar = button.parentElement;
  Assert.equal(
    bar.previousElementSibling,
    SvalPanel._els.switcher.parentElement,
    "the Favorites row sits directly under the workspace switcher"
  );
  Assert.ok(!bar.hidden, "and shows");

  const popup = SvalPanel._els.favoritesMenu;
  const listed = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  EventUtils.synthesizeMouseAtCenter(button, {});
  await within(listed, 10_000, "the Favorites menu showing");
  Assert.equal(button.getAttribute("aria-expanded"), "true");
  Assert.ok(popup.hasAttribute("nonnative"), "the menu is drawn by sval");
  const labels = Array.from(popup.querySelectorAll(":scope > menu"), el =>
    el.getAttribute("label")
  );
  Assert.deepEqual(labels, [], "Favorites is the one tree it shows");
  const item = await TestUtils.waitForCondition(() =>
    Array.from(popup.querySelectorAll("menuitem")).find(
      el => el.dataset.url === url
    )
  );
  // An empty selected tab would take the favorite itself
  // (`PlacesUIUtils.openNodeWithEvent`), so the selected tab shows a page. A
  // tab stays empty (`isEmpty`) until its load has started, so the page is
  // loaded first.
  const page = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/page"),
    10_000,
    "the page's tab loading"
  );
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, url);
  await chooseMenuItem(item, popup, "the favorite");
  const tab = await within(opened, 10_000, "the favorite's tab opening");
  Assert.equal(gBrowser.selectedTab, tab, "the favorite opens in front");
  Assert.equal(button.getAttribute("aria-expanded"), "false");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(page);
});

/**
 * A new group lands after the groups already there and ahead of the tabs,
 * when nobody said where.
 */
add_task(async function a_new_group_lands_ahead_of_the_tabs() {
  const { engine, ids } = await withFreshPanel();

  await viewTab(ids.tab1);
  SvalPanel._els.header.querySelector('[data-command="addGroup"]').click();
  await answerContainerDialog("Fresh");
  let children;
  await TestUtils.waitForCondition(async () => {
    children = await childrenOf(engine, ids.groupA);
    return children.length === 4;
  }, "the new group reaches the document");
  const nodes = (await engine.tree()).nodes;
  Assert.equal(
    nodes[children[0]].content.name,
    "Fresh",
    "inside a group of tabs, the new group comes first"
  );
  Assert.deepEqual(
    children.slice(1),
    [ids.tab1, ids.tab2, ids.tab3],
    "and the tabs keep their order after it"
  );
});

/**
 * Typing a row's first letters moves focus to it (the ARIA tree pattern), and
 * the same letter again steps to the next row that starts with it.
 */
add_task(async function typing_moves_focus_to_a_row_by_its_name() {
  const pause = 100;
  await SpecialPowers.pushPrefEnv({
    set: [["ui.menu.incremental_search.timeout", pause]],
  });
  const { ids } = await withFreshPanel();
  SvalPanel._rowElementFor(ids.groupA).focus();
  const focused = () => document.activeElement.dataset.nodeId;
  let typedAt;
  const type = key => {
    EventUtils.synthesizeKey(key);
    typedAt = Date.now();
  };
  const afterAPause = () =>
    TestUtils.waitForCondition(
      () => Date.now() - typedAt > pause,
      "the type-ahead's pause passes"
    );

  type("t");
  Assert.equal(focused(), ids.tab2, "t lands on Two");
  type("t");
  Assert.equal(focused(), ids.tab3, "t again steps on to Three");

  await afterAPause();
  type("s");
  type("h");
  Assert.equal(focused(), ids.groupB, "sh, after a pause, spells Shipping");

  await afterAPause();
  type("x");
  Assert.equal(
    focused(),
    ids.groupB,
    "and a letter no row starts with stays put"
  );
});
