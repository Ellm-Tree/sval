/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * The tabs themselves. Switching materialises the incoming workspace's tabs
 * and hides the outgoing one's, which the idle unload later releases (§10.7,
 * §10.4), which means tabs leave a window, and the observer that watches tabs leave is the one that deletes
 * nodes when tabs close (§5.4). A switch mistaken for a close would empty the
 * workspace the user just looked away from, on every device, with nothing to
 * recover it from. `withSwitcherTabs` is where these tasks start, and they run
 * against a real window, a real tab observer and a real engine, because no
 * stub can make that mistake visible.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

/**
 * The document comes back byte-for-byte what it was. A close deletes the node
 * outright, with no tombstone (spec §5.4, `engine/CLAUDE.md` rule 5), so
 * this is where a switch read as a close would show.
 */
add_task(async function switching_away_and_back_loses_no_node() {
  const { ids, engine, observer, baseline } = await withSwitcherTabs();
  const [first, second] = ids.workspaces;

  // Before anything else: the warm-up lost nothing either. Without this the
  // baseline could be a picture of the loss, and every comparison against it
  // would pass on a browser that empties a workspace on every switch.
  const warmed = JSON.parse(baseline);
  for (const id of [...ids.workspaces, ...ids.tabs]) {
    Assert.ok(id in warmed, `${id} survived being switched away from`);
  }

  const outgoing = observer.tabFor(ids.tabs[0]);
  Assert.ok(outgoing, "the window materialised the shown workspace's tab");
  Assert.ok(
    !observer.tabFor(ids.tabs[1]),
    "and holds no tab for the workspace it is not showing — an inactive " +
      "workspace is data, not Firefox tabs (§10.4)"
  );

  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(second),
    "the window switched away"
  );
  await releaseHiddenNow(observer);
  const away = await quiet(engine, observer);

  Assert.ok(
    !gBrowser.tabs.includes(outgoing),
    "the outgoing workspace's tab left the window"
  );
  Assert.ok(
    observer.tabFor(ids.tabs[1]),
    "and the incoming workspace's tab is in it"
  );
  Assert.ok(
    ids.tabs[0] in JSON.parse(away),
    "the node of the tab that left is still in the document — leaving a " +
      "window is not closing a tab"
  );

  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(first),
    "and switched back"
  );
  await releaseHiddenNow(observer);
  Assert.equal(
    await quiet(engine, observer),
    baseline,
    "the document is byte-for-byte what it was before the round trip: a " +
      "switch reads the tree and never writes it"
  );

  const returned = observer.tabFor(ids.tabs[0]);
  Assert.ok(returned, "the tab is back in the window");
  Assert.notEqual(
    returned,
    outgoing,
    "as a new <tab>, which is what having unloaded it means"
  );
  Assert.equal(
    taggedId(returned),
    ids.tabs[0],
    "carrying the same node id, so the row the user clicks is still the same " +
      "node and not a second one filed beside it"
  );
  Assert.deepEqual(
    shownIds(),
    [ids.tabs[0]],
    "and the window holds that workspace's tabs and nothing else"
  );
});

/**
 * `discardBrowser` refusing is ordinary, and must not leave a switch
 * half-done: the switch completes, the tab stays loaded, and no node is lost.
 *
 * A dialog open over the page is one of the refusals
 * (`gBrowser._mayDiscardBrowser`), so the one exercised is `SvalTabs`'s own
 * reading of Firefox's answer.
 */
add_task(async function a_refused_discard_leaves_the_tab_where_it_is() {
  const { ids, engine, observer, baseline } = await withSwitcherTabs();
  const [, second] = ids.workspaces;

  const staying = observer.tabFor(ids.tabs[0]);
  Assert.ok(staying.linkedPanel, "the tab is loaded, so it is discardable");

  const { closedPromise, dialog } = gBrowser
    .getTabDialogBox(staying.linkedBrowser)
    .open(getRootDirectory(gTestPath) + "sval_agent_page.html");
  await dialogShown(dialog, "the dialog's load");
  Assert.equal(dialogsOver(staying), 1, "a dialog is open over the page");
  atTaskEnd(async () => {
    dialog.close();
    await within(closedPromise, 10_000, "the dialog closing");
  });
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(second),
    "the switch still completed"
  );

  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    second,
    "the window is in the workspace the user chose"
  );
  Assert.ok(
    observer.tabFor(ids.tabs[1]),
    "whose tabs were materialised, so the switch is not half-done"
  );
  Assert.ok(
    gBrowser.tabs.includes(staying),
    "the tab that would not unload is still in the window"
  );
  Assert.ok(
    staying.linkedPanel,
    "and still loaded, rather than left in some state between the two"
  );
  Assert.equal(
    await quiet(engine, observer),
    baseline,
    "and nothing was lost: a refusal costs memory, never data"
  );
});

/**
 * A switch while a sync pass is in flight. A pass is the only thing that
 * writes a file and a switch reads the tree, so the two overlap whenever a
 * poll lands as the user presses the switcher.
 */
add_task(async function a_switch_while_a_sync_is_in_flight_loses_nothing() {
  const { ids, engine, observer, baseline } = await withSwitcherTabs();
  const [first, second] = ids.workspaces;

  // A real pass against the real folder, not awaited.
  const pass = engine.sync(SYNC_DOCUMENT, Date.now());
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(second),
    "the switch went through"
  );
  await pass;

  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    second,
    "the window is where the user put it"
  );
  Assert.deepEqual(
    shownIds(),
    [ids.tabs[1]],
    "holding exactly the incoming workspace's tabs"
  );
  Assert.equal(
    await quiet(engine, observer),
    baseline,
    "and the pass and the switch between them changed nothing"
  );

  Assert.ok(await SvalWindowWorkspace.of(window).switchTo(first), "back again");
  Assert.equal(
    await quiet(engine, observer),
    baseline,
    "still nothing, and the tabs are back"
  );
  Assert.deepEqual(shownIds(), [ids.tabs[0]], "in the window that asked");
});

/**
 * `two_switches_in_a_row_do_not_interleave` checks the serialisation with the
 * work stubbed out. Here the work is real, which is where an interleave would
 * cost something: each half would materialise one workspace and release the
 * other's tabs in the other's order, and the window would end up holding
 * either both workspaces' tabs or neither's.
 */
add_task(async function two_real_switches_in_succession_end_in_one_place() {
  const { ids, engine, observer, baseline } = await withSwitcherTabs({
    workspaces: 3,
  });
  const [first, second, third] = ids.workspaces;

  // Not awaited between them, which is what a person pressing twice does.
  const both = await Promise.all([
    SvalWindowWorkspace.of(window).switchTo(second),
    SvalWindowWorkspace.of(window).switchTo(third),
  ]);
  Assert.deepEqual(both, [true, true], "both switches ran");

  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    third,
    "the window ends on the one pressed last"
  );
  Assert.deepEqual(
    shownIds(),
    [ids.tabs[2]],
    "holding that workspace's tabs and nothing of the one it passed through"
  );
  Assert.equal(
    await quiet(engine, observer),
    baseline,
    "and two switches racing deleted nothing between them"
  );

  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(first),
    "and the way back still works"
  );
  Assert.equal(await quiet(engine, observer), baseline, "with the tree intact");
  Assert.deepEqual(
    shownIds(),
    [ids.tabs[0]],
    "every node's tab comes back to the window that asks for it"
  );
});

/**
 * Two switches pressed in succession through workspaces whose tabs earlier
 * switches kept loaded and hidden. A switch lands on a kept tab by selecting
 * it, and that shows the tab as anything outside Sval going to a kept tab
 * shows it (`SvalWindowWorkspace.keptTabShown`). The window ends where the user pressed last
 * and goes nowhere after it.
 */
add_task(async function two_switches_through_kept_tabs_end_in_one_place() {
  const { ids, observer } = await withSwitcherTabs({ workspaces: 3 });
  const [first, second, third] = ids.workspaces;
  for (const id of [second, third, first]) {
    Assert.ok(
      await SvalWindowWorkspace.of(window).switchTo(id),
      "a switch that keeps tabs"
    );
  }
  Assert.ok(
    [1, 2].every(i => observer.tabFor(ids.tabs[i])?.hidden),
    "the other workspaces' tabs are kept, hidden"
  );

  const both = await Promise.all([
    SvalWindowWorkspace.of(window).switchTo(second),
    SvalWindowWorkspace.of(window).switchTo(third),
  ]);
  Assert.deepEqual(both, [true, true], "both switches ran");
  const selected = [];
  const onSelect = event => selected.push(taggedId(event.target));
  gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
  atTaskEnd(() =>
    gBrowser.tabContainer.removeEventListener("TabSelect", onSelect)
  );
  await within(
    SvalWindowWorkspace.of(window).switchesSettled(),
    10_000,
    "the switches settling"
  );

  Assert.deepEqual(selected, [], "the window selected nothing after them");
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    third,
    "the window ends on the one pressed last"
  );
  Assert.deepEqual(shownIds(), [ids.tabs[2]], "showing that workspace's tab");
});

/**
 * A window cannot hold zero tabs, so one is opened, and it shows the home
 * page, which is always a real tab: it is filed into the workspace the window
 * is showing and drawn as its row. Going somewhere in it is then an ordinary
 * navigation of that tab.
 */
add_task(async function an_empty_workspace_gets_its_home_tab() {
  const { ids, engine, observer, baseline } = await withSwitcherTabs();

  const empty = await engine.mutate({
    kind: "addWorkspace",
    name: "Nothing in here",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  SvalPanel.settings.setCollapsed(empty, false);
  await SvalPanel.refresh();

  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(empty),
    "the window switched"
  );
  const blank = gBrowser.selectedTab;
  await TestUtils.waitForCondition(
    () => taggedId(blank),
    "the window's tab was filed"
  );
  await quiet(engine, observer);
  const home = taggedId(blank);
  Assert.deepEqual(shownIds(), [home], "the window holds just that tab");
  const before = (await engine.tree()).nodes;
  Assert.equal(before[home]?.placement?.parent, empty, "in the workspace");
  Assert.equal(
    before[home]?.content?.url,
    "about:newtab",
    "showing the home page"
  );
  Assert.deepEqual(drawnIds(), [home], "and the panel draws it as a row");

  // The user goes somewhere in it.
  const loaded = BrowserTestUtils.browserLoaded(
    blank.linkedBrowser,
    false,
    "https://example.com/typed"
  );
  BrowserTestUtils.startLoadingURIString(
    blank.linkedBrowser,
    "https://example.com/typed"
  );
  await within(loaded, 10_000, "the typed address's load");
  await quiet(engine, observer);

  const filed = taggedId(blank);
  Assert.equal(filed, home, "going somewhere in it kept the tab's node");
  const nodes = (await engine.tree()).nodes;
  Assert.equal(
    nodes[filed]?.placement?.parent,
    empty,
    "in the workspace the window is showing, not the one it came from"
  );
  Assert.equal(
    nodes[filed]?.content?.url,
    "https://example.com/typed",
    "holding what the user actually did, rather than a blank page"
  );
  for (const id of [...ids.workspaces, ...ids.tabs]) {
    Assert.ok(id in nodes, `${id} is still in the document`);
  }
  Assert.ok(
    JSON.parse(baseline) && Object.keys(JSON.parse(baseline)).length,
    "and the baseline this was measured against was not empty"
  );
});

/**
 * The home tab the first visit opens stays with its workspace on leaving like
 * any other tab, and coming back shows it again. Switching in once cannot see
 * a tab stacking up per visit, which is why this task counts.
 */
add_task(
  async function repeated_visits_to_an_empty_workspace_keep_one_home_tab() {
    const { ids, engine, observer, baseline } = await withSwitcherTabs();
    const [first] = ids.workspaces;

    const empty = await engine.mutate({
      kind: "addWorkspace",
      name: "Nothing in here",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    SvalPanel.settings.setCollapsed(empty, false);
    await SvalPanel.refresh();
    const before = JSON.parse(await quiet(engine, observer));

    // The first visit adds the home tab, which every later one shows again.
    let tabsHeld = null;
    let home = null;

    for (let visit = 1; visit <= 5; visit++) {
      Assert.ok(
        await SvalWindowWorkspace.of(window).switchTo(empty),
        `visit ${visit} switched in`
      );
      await TestUtils.waitForCondition(
        () => shownIds().length === 1,
        `visit ${visit} holds the workspace's one tab`
      );
      await quiet(engine, observer);
      tabsHeld ??= gBrowser.tabs.length;
      Assert.equal(
        gBrowser.tabs.length,
        tabsHeld,
        `visit ${visit} left the window holding the same number of tabs`
      );
      const [held] = shownIds();
      home ??= held;
      Assert.equal(held, home, `visit ${visit} shows the same home tab`);

      Assert.ok(
        await SvalWindowWorkspace.of(window).switchTo(first),
        `visit ${visit} switched out`
      );
      await quiet(engine, observer);
      Assert.equal(
        gBrowser.tabs.length,
        tabsHeld,
        `and leaving on visit ${visit} opened no other`
      );
      Assert.deepEqual(
        shownIds(),
        [ids.tabs[0]],
        `holding exactly the workspace it returned to on visit ${visit}`
      );
    }

    const after = JSON.parse(await quiet(engine, observer));
    const added = Object.keys(after).filter(id => !(id in before));
    Assert.deepEqual(added, [home], "ten switches added exactly the home tab");
    Assert.equal(after[home].kind, "tab", "as a tab");
    Assert.equal(after[home].placement.parent, empty, "in the empty workspace");
    Assert.equal(
      after[home].content.url,
      "about:newtab",
      "showing the home page"
    );
    Assert.ok(
      Object.keys(before).every(id => id in after),
      "and nothing the document held was lost"
    );
    Assert.ok(
      Object.keys(JSON.parse(baseline)).every(id => id in before),
      "measured against a document that still held everything the fixture made"
    );
  }
);

/**
 * `switchTo` is serialised, but `show` is also reached from
 * `resolve`, which the panel's `refresh` calls, and `refresh` is the
 * tab observer's `onTreeChanged` as well as the poll's path. So a peer taking
 * away the workspace this window was showing can start a hand-over with no
 * switch involved. Two hand-overs with different ideas of what to keep leave
 * the window holding the wrong workspace's tabs; no node is at risk, because
 * every release is marked, but what the window shows is.
 *
 * The two are started in the same turn, so the second begins while the
 * first is still in flight, and what is asserted is where the window ends.
 */
add_task(async function a_hand_over_in_flight_serialises_the_next_one() {
  const { ids, engine, observer, baseline } = await withSwitcherTabs({
    workspaces: 3,
  });
  const [, second, third] = ids.workspaces;

  await within(
    Promise.all([
      SvalWindowWorkspace.of(window).show(second),
      SvalWindowWorkspace.of(window).show(third),
    ]),
    10_000,
    "both hand-overs"
  );

  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    third,
    "the window is in the workspace it was last told to show"
  );
  Assert.equal(
    await quiet(engine, observer),
    baseline,
    "nothing was written by either hand-over"
  );
  Assert.deepEqual(
    shownIds(),
    [ids.tabs[2]],
    "and it holds that workspace's tabs and nothing of the one it passed " +
      "through — which is what interleaving would have got wrong"
  );
});

/**
 * A tab dragged to another window keeps its node, and the window it left
 * writes nothing for it. The window it joins files it under its own
 * workspace (spec §10.7), and that move is the one write.
 */
add_task(async function a_dragged_tab_is_not_described_by_the_window_it_left() {
  const { ids, engine, observer } = await withSwitcherTabs();
  const id = ids.tabs[0];

  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "the other window's opening"
  );
  // The window attaches its tab observer once its panel's first sync pass is
  // done (`SvalPanel.started`). A tab adopted before then arrives unwatched.
  await within(other.SvalPanel.started, 10_000, "the other window's panel");
  const joined = SvalWindowWorkspace.of(other).id;
  Assert.notEqual(
    joined,
    SvalWindowWorkspace.of(window).id,
    "it shows another workspace"
  );

  const tab = observer.tabFor(id);
  Assert.ok(tab, "the window holds the shown workspace's tab");
  // The window's last tab adopted away would close the window
  // (`gBrowser.adoptTab`), so it keeps a second one. The user opened it, so
  // it is filed, and the document is read once its page and title are in.
  const keeperUrl = TITLED_TAB_URL.replace("%s", "keeper");
  const keeper = BrowserTestUtils.addTab(gBrowser, keeperUrl);
  await pageReady(keeper.linkedBrowser, keeperUrl);
  await quiet(engine, observer);

  // Content the tab does not have, so a flush that read this tab would find it
  // changed and write.
  await engine.mutate({
    kind: "setContent",
    id,
    name: "Written by hand",
    url: "https://example.com/by-hand",
    icon: null,
    now: Date.now(),
  });
  const before = JSON.parse(await treeJson(engine));

  try {
    other.gBrowser.adoptTab(tab, { tabIndex: 0, selectTab: true });
    await within(observer.settled(), 10_000, "observer settling");
    await within(
      other.SvalPanel.observer.settled(),
      10_000,
      "the other window's observer settling"
    );

    const after = JSON.parse(await treeJson(engine));
    Assert.ok(
      id in after,
      "the dragged tab keeps its node: being adopted is not being closed"
    );
    Assert.equal(
      after[id].placement.parent,
      joined,
      "filed under the workspace of the window it joined"
    );
    for (const nodes of [before, after]) {
      delete nodes[id].placement;
      delete nodes[id].placement_at;
      delete nodes[id].placement_by;
    }
    Assert.deepEqual(
      after,
      before,
      "and nothing else was written for a tab that is no longer in this window"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(other),
      10_000,
      "the other window closing"
    );
  }
  await within(observer.settled(), 10_000, "observer settling");
});
