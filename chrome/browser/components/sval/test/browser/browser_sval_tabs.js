/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * What only a real window can prove: that `SessionStore`'s custom tab values
 * carry a node id on a real tab, and that Firefox's own `TabOpen`/`TabClose`
 * events reach the window's tab observer and land in its document. The tree
 * logic is covered without a window in `test/xpcshell/test_sval_tabs.js`.
 *
 * Each task writes a workspace into the window's own document and switches
 * the window to it, so what it asserts went through the window's own panel,
 * engine and observer.
 */

const { SvalTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const SvalTree = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);
const { tabsIn } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentSession.sys.mjs"
);

/* import-globals-from ../../sval-panel.js */

const SETTINGS_PAGE_URL = "about:preferences";

/**
 * A workspace of this task's in the window's own document, shown in the
 * window by its own switch, whose tabs are the task's
 * (`expectWorkspaceTabs`).
 *
 * @param {object} [options]
 * @param {Function} [options.fill] Called with `(engine, workspace)` before
 *   the switch, to write nodes the switch opens as tabs.
 * @param {boolean} [options.second] Whether to write a second workspace with
 *   a tab of its own. A window shows one workspace (spec §10.7), so anything
 *   asserting that the window and the tree agree has to be able to tell "the
 *   tabs this document holds" from "the tabs this window shows".
 * @returns {Promise<object>} `{ engine, workspace, elsewhere, filled }`,
 *   where `filled` is what `fill` answered.
 */
async function ourWorkspace({ fill, second = false } = {}) {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const { engine } = SvalPanel;
  const workspace = await engine.mutate({
    kind: "addWorkspace",
    name: "Work",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const filled = fill ? await fill(engine, workspace) : null;

  let elsewhere = null;
  if (second) {
    const other = await engine.mutate({
      kind: "addWorkspace",
      name: "Home",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    elsewhere = await engine.mutate({
      kind: "addTab",
      parent: other,
      name: "Filed in the other workspace",
      url: "https://example.com/elsewhere",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
  }

  expectWorkspaceTabs();
  Assert.ok(
    await within(
      SvalPanel.switchTo(workspace),
      10_000,
      "the switch to the task's workspace"
    ),
    "the window shows the task's workspace"
  );
  // A workspace holding no tab is shown in a home tab, which is filed when
  // its page commits (`SvalTabObserver.openUnfiledTab`), after the switch.
  await TestUtils.waitForCondition(
    () => taggedId(gBrowser.selectedTab),
    "the window's tab is filed"
  );
  await settled();
  return { engine, workspace, elsewhere, filled };
}

/**
 * Waits for the window's observer to have filed every tab event it has seen.
 *
 * @param {Window} [win]
 */
async function settled(win = window) {
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "the window's observer settling"
  );
}

/**
 * The document's nodes once the window's observer has written what its tabs
 * show.
 */
async function settledNodes() {
  await settled();
  return nodes(SvalPanel.engine);
}

/**
 * Counts the passes the window's engine runs for the rest of the task, with
 * the passes Sval runs on its own turned on, so the observer's debounce runs
 * one. The count starts once a flush has re-armed the observer's poll, which
 * is then an interval away.
 *
 * @returns {Promise<object>} `{ count }`.
 */
async function countingPasses() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.sval.sync.background.enabled", true]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const passes = { count: 0, stacks: [] };
  // Every document's pass is heard here; the window's panel runs the tab
  // document's, and names itself as the pass's origin.
  const forget = SvalPanel.engine.addPassListener((report, origin) => {
    if (origin === SvalPanel) {
      passes.count++;
      passes.stacks.push(`${Date.now()} ${new Error().stack}`);
    }
  });
  atTaskEnd(forget);
  const warm = BrowserTestUtils.addTab(gBrowser, "https://example.com/warm");
  await within(
    BrowserTestUtils.browserLoaded(
      warm.linkedBrowser,
      false,
      "https://example.com/warm"
    ),
    10_000,
    "the warm-up tab's load"
  );
  await settled();
  return passes;
}

/**
 * The row the window's panel draws for node `id`, or undefined.
 *
 * @param {string} id
 * @returns {Element|undefined}
 */
function rowOf(id) {
  return drawnRows().find(row => row.dataset.nodeId === id);
}

/**
 * Resolves on the first turn of the event loop at which `condition` holds,
 * checking once a turn. A turn is the least a reply from the engine's worker
 * takes, so a step the observer starts on one turn and finishes on a later
 * one, such as a tab's tag and the add of its node, is seen between the two.
 *
 * @param {Function} condition
 * @param {string} what
 */
async function onTheTurn(condition, what) {
  await within(
    (async () => {
      while (!condition()) {
        await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
      }
    })(),
    10_000,
    what
  );
}

/**
 * Forgets every closed window, before the task and after it, so the window
 * the task closes is the one `undoCloseWindow(0)` reopens.
 */
function forgetClosedWindows() {
  const forget = () => {
    for (const { closedId } of SessionStore.getClosedWindowData()) {
      SessionStore.forgetClosedWindowById(closedId);
    }
  };
  forget();
  atTaskEnd(forget);
}

add_task(async function a_real_tab_is_tagged_through_the_session_store() {
  const { engine, workspace } = await ourWorkspace();

  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"),
    15_000,
    "the new tab opening and loading"
  );
  await settled();

  const id = taggedId(tab);
  ok(id, "the real tab carries a node id in the session store");
  is(typeof id, "string", "and it is stored as a string, as that API requires");

  const tree = await nodes(engine);
  ok(id in tree, "the document holds a node for the real tab");
  is(tree[id].kind, "tab", "the node is a tab");
  is(
    tree[id].placement.parent,
    workspace,
    "a tab opened in the window is filed under the workspace it shows"
  );

  BrowserTestUtils.removeTab(tab);
  await settled();

  ok(!(id in (await nodes(engine))), "closing the real tab deleted its node");
});

/**
 * A tab opened in the foreground is selected before the observer has filed
 * it, so its `TabSelect` carries no node. The panel still shows it as the
 * selected tab once it is filed.
 */
add_task(async function a_new_foreground_tab_is_shown_selected() {
  await ourWorkspace();

  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"),
    15_000,
    "the new tab opening and loading"
  );
  await settled();

  const id = taggedId(tab);
  ok(id, "the new tab is filed");
  await TestUtils.waitForCondition(
    () => rowOf(id)?.getAttribute("aria-selected") === "true",
    "and its row is drawn selected"
  );
});

/**
 * A stray belongs to the workspace itself: a workspace holds tabs and groups
 * as siblings in one ordered list, so a tab in no group needs no group
 * invented for it.
 *
 * A tab is a stray when it is open before the window's observer attaches,
 * which is a window opened on a page: its first tab loads the page while the
 * panel is still starting.
 */
add_task(async function tabs_open_before_attach_land_in_the_workspace() {
  const url = "https://example.org/";
  const args = Cc["@mozilla.org/supports-string;1"].createInstance(
    Ci.nsISupportsString
  );
  args.data = url;
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ args, waitForTabURL: url }),
    15_000,
    "a window opening on a page"
  );
  expectWorkspaceTabs(win);
  await within(win.SvalPanel.started, 20_000, "the window's startup");
  await settled(win);

  const [stray] = win.gBrowser.tabs;
  const id = taggedId(stray);
  ok(id, "attaching tagged the page the window opened on");

  const tree = await nodes(win.SvalPanel.engine);
  const workspace = win.SvalPanel.workspaceId;
  is(
    SvalTree.descendantIds(tree, workspace).filter(
      node => tree[node].kind === "group"
    ).length,
    0,
    "no group was invented to hold it"
  );
  is(
    tree[id].placement.parent,
    workspace,
    "the stray is a child of the workspace itself"
  );

  // Every other tab the window has is a stray too, except a blank page with
  // no history, which is worth no node.
  //
  // Reading `canGoBack` here is safe only because `linkedPanel` says the tab
  // is not lazy. `a_lazy_blank_tab_is_left_untagged_and_left_lazy` proves the
  // filter itself never makes that read on an unbound tab.
  for (const tab of win.gBrowser.tabs) {
    if (taggedId(tab) || !tab.linkedPanel) {
      continue;
    }
    ok(
      win.isBlankPageURL(tab.linkedBrowser.currentURI.spec) &&
        !tab.linkedBrowser.canGoBack,
      `the untagged tab is blank: ${tab.label}`
    );
  }
});

/**
 * The filter exists for a lazy tab: reading `canGoBack` on one instantiates
 * its browser (`_createLazyBrowser` in tabbrowser.js), which filing a tab
 * must never do as a side effect. This builds a tab the way
 * `SvalRestore.sys.mjs` restores one: `addTrustedTab` with
 * `createLazyBrowser` leaves the browser unbound, and `setTabState` gives it
 * a URL and a single history entry without touching it. So the tab is
 * guaranteed lazy.
 *
 * The filter runs over the tabs a window holds when its observer attaches.
 * A window `undoCloseWindow` reopens loads before its panel's startup
 * attaches one, so the tab is built there as the window loads.
 */
add_task(async function a_lazy_blank_tab_is_left_untagged_and_left_lazy() {
  forgetClosedWindows();
  const first = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    15_000,
    "a new window opening"
  );
  expectWorkspaceTabs(first);
  await within(first.SvalPanel.started, 20_000, "the window's startup");
  await within(
    BrowserTestUtils.openNewForegroundTab(
      first.gBrowser,
      "https://example.com/selected"
    ),
    10_000,
    "a page's load"
  );
  await settled(first);
  await within(
    BrowserTestUtils.closeWindow(first),
    10_000,
    "the window's closing"
  );
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedWindowCount() == 1,
    "the session keeps the closed window"
  );

  const { E10SUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/E10SUtils.sys.mjs"
  );
  let lazyTab = null;
  let beforeAttach = null;
  const opening = BrowserTestUtils.domWindowOpenedAndLoaded().then(win => {
    beforeAttach = !win.SvalPanel.observer;
    lazyTab = win.gBrowser.addTrustedTab(null, {
      createLazyBrowser: true,
      skipAnimation: true,
      skipLoad: true,
      skipBackgroundNotify: true,
      bulkOrderedOpen: true,
    });
    SessionStore.setTabState(lazyTab, {
      entries: [
        {
          url: "about:blank",
          title: "about:blank",
          triggeringPrincipal_base64: E10SUtils.SERIALIZED_SYSTEMPRINCIPAL,
        },
      ],
      index: 1,
    });
    return win;
  });
  SessionStore.undoCloseWindow(0);
  const win = await within(opening, 20_000, "the reopened window's opening");
  atTaskEnd(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the reopened window closing"
      );
    }
  });
  await within(win.SvalPanel.started, 20_000, "the reopened window's startup");
  await settled(win);
  ok(beforeAttach, "the tab was built before any observer watched the window");

  is(
    taggedId(lazyTab),
    null,
    "a lazy blank tab with no history is left untagged"
  );
  ok(
    !lazyTab.linkedPanel,
    "and the filter reached that answer without instantiating it"
  );
});

add_task(async function a_burst_of_real_opens_produces_one_pass() {
  await ourWorkspace();
  const passes = await countingPasses();
  const before = passes.count;

  const tabs = [];
  for (let i = 0; i < 10; i++) {
    tabs.push(
      BrowserTestUtils.addTab(gBrowser, `https://example.com/burst/${i}`)
    );
  }
  await settled();

  info(passes.stacks.join("\n----\n"));
  is(
    passes.count - before,
    1,
    "ten tabs opening at once cost one pass, and one file in the user's folder"
  );
  is(
    new Set(tabs.map(taggedId)).size,
    10,
    "and each of them got its own node id"
  );
});

/**
 * A tab opened in the middle of the strip, as a link opened in a new tab
 * is, is filed where it sits.
 */
add_task(async function a_tab_opened_mid_strip_is_filed_where_it_sits() {
  const { engine, workspace } = await ourWorkspace();

  const last = BrowserTestUtils.addTab(gBrowser, "https://example.com/last");
  await settled();

  const middle = BrowserTestUtils.addTab(
    gBrowser,
    "https://example.com/middle",
    { tabIndex: gBrowser.tabs.indexOf(last) }
  );
  await settled();

  const ours = [taggedId(middle), taggedId(last)];
  const siblings = SvalTree.childrenByParent(await nodes(engine))
    .get(workspace)
    .filter(id => ours.includes(id));
  Assert.deepEqual(
    siblings,
    ours,
    "the tab is filed before the one it was opened before"
  );
});

/**
 * Deleting a group takes its tabs with it as the panel does it: one engine
 * delete for the group and everything in it, and each of the window's tabs
 * for it closed as a person closes a tab, so Firefox's recently-closed list
 * can hand it back as the same node.
 */
add_task(async function a_deleted_groups_tabs_close_and_can_come_back() {
  const { engine, workspace } = await ourWorkspace();
  const group = await engine.mutate({
    kind: "addGroup",
    parent: workspace,
    name: "Reading",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const tabs = [];
  for (const name of ["first", "second"]) {
    const url = `https://example.com/${name}`;
    const tab = BrowserTestUtils.addTab(gBrowser, url);
    await within(
      BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url),
      10_000,
      `the ${name} tab's load`
    );
    tabs.push(tab);
  }
  await settled();
  const ids = tabs.map(taggedId);
  for (const id of ids) {
    await engine.mutate({
      kind: "moveNode",
      id,
      newParent: group,
      now: Date.now(),
    });
  }
  await settled();

  const closedBefore = SessionStore.getClosedTabCountForWindow(window);
  const before = await nodes(engine);
  await SvalTabs.removeNodes(engine, null, before, [group]);
  Assert.deepEqual(
    SvalPanel.observer.closeNodes(ids, before).sort(),
    [...ids].sort(),
    "each of the group's tabs had a tab to close"
  );
  await settled();

  for (const tab of tabs) {
    Assert.ok(!gBrowser.tabs.includes(tab), "the group's tab left the window");
  }
  const after = await nodes(engine);
  for (const id of [group, ...ids]) {
    Assert.ok(!(id in after), "and the document holds neither group nor tab");
  }
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedTabCountForWindow(window) === closedBefore + 2,
    "Firefox keeps both closed tabs"
  );

  const reopened = SessionStore.undoCloseTab(window, 0);
  await within(
    BrowserTestUtils.waitForEvent(reopened, "SSTabRestored"),
    10_000,
    "the reopened tab's restore"
  );
  await settled();
  Assert.ok(ids.includes(taggedId(reopened)), "it comes back as its own node");
  Assert.ok(taggedId(reopened) in (await nodes(engine)), "in the document");
});

/**
 * A tab the user closes from a group, handed back by Firefox's
 * recently-closed list, goes back into that group: the closed tab Firefox
 * keeps carries where its node sat.
 */
add_task(async function a_closed_tab_comes_back_into_its_group() {
  const { engine, workspace } = await ourWorkspace();
  const group = await engine.mutate({
    kind: "addGroup",
    parent: workspace,
    name: "Reading",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const url = "https://example.com/grouped";
  const tab = BrowserTestUtils.addTab(gBrowser, url);
  await within(
    BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url),
    10_000,
    "the tab's load"
  );
  await settled();
  const id = taggedId(tab);
  await engine.mutate({
    kind: "moveNode",
    id,
    newParent: group,
    now: Date.now(),
  });
  await settled();
  // Read back, as every writer of the tree does once its write has landed.
  Assert.equal(
    (await nodes(engine))[id].placement.parent,
    group,
    "the tab's node is in the group"
  );

  const closedBefore = SessionStore.getClosedTabCountForWindow(window);
  BrowserTestUtils.removeTab(tab);
  await settled();
  Assert.ok(!(id in (await nodes(engine))), "closing it deleted its node");
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedTabCountForWindow(window) > closedBefore,
    "Firefox keeps the closed tab"
  );

  const reopened = SessionStore.undoCloseTab(window, 0);
  await within(
    BrowserTestUtils.waitForEvent(reopened, "SSTabRestored"),
    10_000,
    "the reopened tab's restore"
  );
  await settled();
  const after = await nodes(engine);
  Assert.equal(taggedId(reopened), id, "it comes back as its own node");
  Assert.equal(after[id]?.placement?.parent, group, "in the group it left");
});

/**
 * A tab dragged into another workspace's window moves to that window's
 * workspace. A reorder runs on the observer's queue, after whatever is ahead
 * of it, so the reorder a move queued just before the tab left runs once it
 * has gone, and the tabs left behind keep their order.
 *
 * The move and the tab's leaving happen in one turn.
 */
add_task(async function a_tab_dragged_to_another_window_joins_its_workspace() {
  const { engine, workspace } = await ourWorkspace();
  const opened = [];
  for (const name of ["first", "second", "third"]) {
    opened.push(
      BrowserTestUtils.addTab(gBrowser, `https://example.com/${name}`)
    );
    await settled();
  }
  const ids = opened.map(taggedId);
  const order = async () =>
    tabsIn(await nodes(engine), workspace)
      .map(t => t.tab)
      .filter(id => ids.includes(id));
  Assert.deepEqual(await order(), ids, "filed in strip order");

  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    15_000,
    "a new window opening"
  );
  expectWorkspaceTabs(other);
  await within(other.SvalPanel.started, 20_000, "the other window's startup");
  await settled(other);
  const [first, second] = opened;
  gBrowser.moveTabTo(second, { tabIndex: gBrowser.tabs.indexOf(first) });
  const moved = other.gBrowser.adoptTab(second);
  ok(moved, "the tab left the window");
  await settled();
  await settled(other);

  Assert.deepEqual(
    await order(),
    [ids[0], ids[2]],
    "the tabs left behind keep their order"
  );
  Assert.ok(
    tabsIn(await nodes(engine), other.SvalPanel.workspaceId)
      .map(t => t.tab)
      .includes(ids[1]),
    "and the tab that left is filed in the other window's workspace"
  );
  await within(
    BrowserTestUtils.closeWindow(other),
    10_000,
    "the other window's closing"
  );
});

/**
 * A real tab reports its favicon as `TabAttrModified` naming `"image"`, and
 * the tab's row shows it.
 */
add_task(async function a_real_favicon_reaches_the_row() {
  await ourWorkspace();

  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"),
    15_000,
    "the new tab opening and loading"
  );
  await settled();
  const id = taggedId(tab);
  await TestUtils.waitForCondition(() => rowOf(id), "the tab's row is drawn");
  const icon = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>";
  gBrowser.setIcon(tab, icon);

  is(
    SvalPanel.observer.iconFor(id),
    icon,
    "the favicon reads back from the tab"
  );
  await TestUtils.waitForCondition(
    () =>
      rowOf(id)?.querySelector(".sval-row-icon")?.getAttribute("src") === icon,
    "and the tab's row shows it"
  );
});

/**
 * A page whose title keeps changing, a mail or chat tab's unread count, has
 * each title in its row as the page sets it, while the document takes its
 * titles once per hold (`SvalTitleHold`).
 */
add_task(async function a_ticking_title_shows_at_once_and_writes_once() {
  const { engine } = await ourWorkspace();
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"),
    15_000,
    "the new tab opening and loading"
  );
  await settled();
  const id = taggedId(tab);
  await TestUtils.waitForCondition(() => rowOf(id), "the tab's row is drawn");

  const writes = { count: 0 };
  const mutate = engine.mutate;
  engine.mutate = op => {
    if (op.kind === "setContent" && op.id === id) {
      writes.count++;
    }
    return mutate.call(engine, op);
  };
  atTaskEnd(() => {
    delete engine.mutate;
  });

  const ticks = 6;
  for (let i = 1; i <= ticks; i++) {
    const title = `Inbox (${i})`;
    await SpecialPowers.spawn(tab.linkedBrowser, [title], t => {
      content.document.title = t;
    });
    await TestUtils.waitForCondition(
      () => rowOf(id)?.querySelector(".sval-row-name")?.textContent === title,
      `the row shows ${title}`
    );
  }
  // The title the page loaded with started the hold, so every tick after it
  // waits for the hold's end.
  is(writes.count, 0, "the document took none of the ticks");

  await settled();
  is(
    (await nodes(engine))[id].content.name,
    `Inbox (${ticks})`,
    "and the latest once something waited on the observer"
  );
  is(writes.count, 1, "in one write");
});

/**
 * What only a real window can prove about following a tab: that Firefox's
 * progress listener and `TabAttrModified` report a navigation and a title,
 * and that what lands in the document is where the tab ended up.
 */
add_task(async function a_real_navigation_reaches_the_node() {
  const { engine } = await ourWorkspace();
  const passes = await countingPasses();

  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"),
    15_000,
    "the new tab opening and loading"
  );
  await settled();
  const id = taggedId(tab);
  is(
    (await nodes(engine))[id].content.url,
    "https://example.com/",
    "the node starts where the tab opened"
  );
  const passesBefore = passes.count;

  BrowserTestUtils.startLoadingURIString(
    tab.linkedBrowser,
    "https://example.org/"
  );
  await within(
    BrowserTestUtils.browserLoaded(
      tab.linkedBrowser,
      false,
      "https://example.org/"
    ),
    10_000,
    "the tab's load of example.org"
  );
  await settled();

  const node = (await nodes(engine))[id];
  is(
    node.content.url,
    "https://example.org/",
    "the node followed the tab, which is what the next launch restores"
  );
  ok(
    node.content.name && node.content.name !== "https://example.org/",
    `the title came with it: ${node.content.name}`
  );
  is(
    passes.count - passesBefore,
    1,
    "and the whole load cost one pass, and one file in the user's folder"
  );
});

/**
 * One path: closing a row closes the browser, and it is the `TabClose` that
 * follows which deletes the node. Two paths could disagree about whether the
 * thing is still open.
 */
add_task(async function closing_a_node_closes_the_real_browser() {
  const { engine } = await ourWorkspace();

  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "https://example.com/closing"
    ),
    15_000,
    "the new tab opening and loading"
  );
  await settled();
  const id = taggedId(tab);

  gBrowser.removeTab(tab);
  await settled();

  ok(!gBrowser.tabs.includes(tab), "the browser is gone from the window");
  ok(!(id in (await nodes(engine))), "and the node is gone from the tree");
});

/**
 * A redraw reads the tree, and the strip can gain a tagged tab before that
 * read comes back: the observer tags a tab, then adds its node. A tab whose
 * node is still on its way is not an orphan, so a redraw holding the tree
 * from before it must not close it.
 *
 * The sweep runs on the turn the tag lands (`onTheTurn`), before the add's
 * answer from the engine's worker can arrive.
 */
add_task(async function a_tab_whose_node_is_being_added_is_not_an_orphan() {
  const { engine } = await ourWorkspace();
  const { observer } = SvalPanel;
  const before = await nodes(engine);
  const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/adding");
  await onTheTurn(() => taggedId(tab), "the tab's tag");

  Assert.deepEqual(
    observer.closeOrphanTabs(before),
    [],
    "a tree read before the tab was tagged closes nothing"
  );
  ok(gBrowser.tabs.includes(tab), "the tab is still in the window");

  await settled();
  ok(taggedId(tab) in (await nodes(engine)), "and its node arrived");
});

/**
 * Nor is a tab carried into another window while the window it left is still
 * adding its node: a redraw in the window it reached, holding the tree from
 * before the add, must not close it.
 *
 * The tab is carried on the turn its tag lands, as the task above sweeps.
 */
add_task(async function a_tab_carried_in_while_its_node_is_added_stays() {
  const { engine } = await ourWorkspace();
  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    15_000,
    "a new window opening"
  );
  expectWorkspaceTabs(other);
  await within(other.SvalPanel.started, 20_000, "the other window's startup");
  await settled(other);
  const otherObserver = other.SvalPanel.observer;
  const before = await nodes(engine);

  const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/carried");
  await onTheTurn(() => taggedId(tab), "the tab's tag");
  const id = taggedId(tab);
  const moved = other.gBrowser.adoptTab(tab);
  Assert.equal(taggedId(moved), id, "the tab carried its id across");

  Assert.deepEqual(
    otherObserver.closeOrphanTabs(before),
    [],
    "the window it reached closes nothing"
  );
  ok(other.gBrowser.tabs.includes(moved), "the tab is still in that window");

  await settled();
  await settled(other);
  ok(id in (await nodes(engine)), "and its node arrived");
  await within(
    BrowserTestUtils.closeWindow(other),
    10_000,
    "the other window's closing"
  );
});

/**
 * A burst of opens and closes in the browser, and the panel agrees with
 * `gBrowser` at the end of it without anything redrawing it by hand.
 */
add_task(async function the_panel_redraws_when_the_window_changes() {
  // Two workspaces, because a window shows one of them (spec §10.7): the
  // document holds every workspace's tabs and the window holds the shown
  // workspace's, so the comparison is against the latter.
  const { engine, workspace, elsewhere } = await ourWorkspace({
    second: true,
  });

  const tabs = [];
  for (let i = 0; i < 5; i++) {
    tabs.push(
      BrowserTestUtils.addTab(gBrowser, `https://example.com/redraw/${i}`)
    );
  }
  for (const tab of tabs.slice(0, 2)) {
    BrowserTestUtils.removeTab(tab);
  }
  await settled();

  const tree = await nodes(engine);
  const inWorkspace = SvalTree.descendantIds(tree, workspace)
    .filter(id => tree[id].kind === "tab")
    .sort();
  // A switch keeps some tabs of the workspace it left loaded, hidden.
  const inWindow = gBrowser.visibleTabs
    .map(taggedId)
    .filter(id => id && id in tree)
    .sort();
  Assert.deepEqual(
    inWorkspace,
    inWindow,
    "the workspace this window shows holds exactly the tabs the window has"
  );
  await TestUtils.waitForCondition(
    () =>
      JSON.stringify(
        drawnIds()
          .filter(id => tree[id]?.kind === "tab")
          .sort()
      ) === JSON.stringify(inWindow),
    "and the panel draws those tabs, without anything redrawing it by hand"
  );
  Assert.ok(
    elsewhere in tree && !inWindow.includes(elsewhere),
    "while the other workspace's tab stays in the document and out of the " +
      "window, which is what makes the comparison above the right one"
  );
});

/**
 * Tabs closed together, as Close Other Tabs closes them, are drawn once the
 * last has closed, so the panel ends drawing the tabs left and the document
 * ends holding none of the closed ones.
 */
add_task(async function tabs_closed_together_leave_the_panel_right() {
  const { engine } = await ourWorkspace();
  const tabs = [];
  for (let i = 0; i < 6; i++) {
    tabs.push(
      BrowserTestUtils.addTab(gBrowser, `https://example.com/together/${i}`)
    );
  }
  await settled();
  const closing = tabs.slice(1, 5);
  const closedIds = closing.map(taggedId);
  gBrowser.removeTabs(closing, { animate: false });
  await settled();

  const tree = await nodes(engine);
  Assert.deepEqual(
    closedIds.filter(id => id in tree),
    [],
    "the document holds none of the closed tabs"
  );
  const left = gBrowser.visibleTabs
    .map(taggedId)
    .filter(id => id && id in tree)
    .sort();
  Assert.ok(
    [tabs[0], tabs[5]].every(tab => left.includes(taggedId(tab))),
    "the tabs left open are still filed"
  );
  Assert.deepEqual(
    drawnIds()
      .filter(id => tree[id]?.kind === "tab")
      .sort(),
    left,
    "and the panel draws exactly the tabs left, once the closes settle"
  );
});

/**
 * A new window's startup tab is blank, so its observer files no node for it.
 * The user's first act in a new window is to type a URL into that tab, and
 * the panel is the only tab surface, so a tab that browses somewhere has to
 * appear there. The window is handed an empty workspace, as the switcher
 * hands one: on a workspace with tabs the startup tab closes once the
 * workspace's tab is on screen (decision 1997).
 */
add_task(async function typing_a_url_into_the_startup_tab_files_it() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const workspace = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const { handWorkspaceTo } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
  );
  const opening = BrowserTestUtils.waitForNewWindow();
  handWorkspaceTo(OpenBrowserWindow(), workspace);
  const win = await within(opening, 15_000, "a new window opening");
  expectWorkspaceTabs(win);
  await within(win.SvalPanel.started, 20_000, "the window's startup");
  await settled(win);

  const startup = win.gBrowser.tabs.find(
    tab =>
      !taggedId(tab) && win.isBlankPageURL(tab.linkedBrowser.currentURI.spec)
  );
  ok(startup, "the window's blank startup tab is filed nowhere");

  BrowserTestUtils.startLoadingURIString(
    startup.linkedBrowser,
    "https://example.com/typed"
  );
  await within(
    BrowserTestUtils.browserLoaded(
      startup.linkedBrowser,
      false,
      "https://example.com/typed"
    ),
    10_000,
    "the typed address's load"
  );
  await settled(win);

  const id = taggedId(startup);
  ok(id, "navigating the blank startup tab filed it");

  const tree = await nodes(win.SvalPanel.engine);
  ok(id in tree, "the document holds a node for it");
  is(
    tree[id].content.url,
    "https://example.com/typed",
    "and the node carries where it went"
  );
  is(
    tree[id].placement.parent,
    win.SvalPanel.workspaceId,
    "filed in the workspace the window shows, where a new tab goes"
  );
});

/**
 * The panel's New tab button, from the observer's side: the tab is opened in
 * the window and filed by the `TabOpen` that follows, which is the same path a
 * link opened in a new tab takes.
 */
add_task(async function the_panel_can_open_a_tab() {
  const { engine, workspace } = await ourWorkspace();

  const before = new Set(gBrowser.tabs);
  SvalPanel.observer.openNewTab();
  await TestUtils.waitForCondition(
    () => gBrowser.tabs.some(tab => !before.has(tab)),
    "the window gained a tab"
  );
  const opened = gBrowser.tabs.find(tab => !before.has(tab));
  expectOpened(opened);
  await settled();

  const id = taggedId(opened);
  ok(id, "the opened tab was filed");
  const tree = await nodes(engine);
  is(tree[id]?.kind, "tab", "as a tab node");
  is(
    tree[id].placement.parent,
    workspace,
    "in the workspace, where new tabs go"
  );
});

/**
 * A workspace holding a group with a tab in it, shown in the window with
 * that tab selected, as the user viewing a grouped tab has it: the panel
 * then files a tab opened from the page in the group.
 *
 * @param {object} [options]
 * @param {boolean} [options.loose] Whether a tab outside the group follows
 *   the grouped one.
 * @returns {Promise<object>} `{ engine, workspace, group, grouped, loose }`,
 *   the last two being tabs.
 */
async function viewingInAGroup({ loose = false } = {}) {
  const { engine, workspace, filled } = await ourWorkspace({
    async fill(eng, parent) {
      const group = await eng.mutate({
        kind: "addGroup",
        parent,
        name: "Reading",
        id: crypto.randomUUID(),
        now: Date.now(),
      });
      const grouped = await eng.mutate({
        kind: "addTab",
        parent: group,
        name: "Grouped",
        url: "https://example.com/grouped",
        id: crypto.randomUUID(),
        now: Date.now(),
      });
      const looseId = loose
        ? await eng.mutate({
            kind: "addTab",
            parent,
            name: "Loose",
            url: "https://example.com/loose",
            id: crypto.randomUUID(),
            now: Date.now(),
          })
        : null;
      SvalPanel.settings.setCollapsed(group, false);
      return { group, grouped, loose: looseId };
    },
  });
  const tabOf = id => gBrowser.tabs.find(tab => taggedId(tab) === id);
  const grouped = tabOf(filled.grouped);
  ok(grouped, "the switch opened the grouped tab");
  await selectTab(grouped);
  await pageReady(grouped.linkedBrowser, "https://example.com/grouped");
  await settled();
  return {
    engine,
    workspace,
    group: filled.group,
    grouped,
    loose: filled.loose ? tabOf(filled.loose) : null,
  };
}

/**
 * The user's own new tab (⌘T, or the panel's New tab button)
 * opens at the top of the workspace, never inside a group, whatever group the
 * tab beside it is in. A link opened in a new tab is filed where the panel
 * says, beside the page it came from, and so is a row's own New tab.
 *
 * The user is viewing a grouped tab, so the panel files a tab opened from a
 * page in that group.
 */
add_task(async function a_new_tab_opens_outside_every_group() {
  const { engine, workspace, group, grouped } = await viewingInAGroup();

  const parentOf = async tab => {
    await settled();
    const id = taggedId(tab);
    ok(id, "the tab was filed");
    return (await nodes(engine))[id]?.placement.parent;
  };
  const newTabFrom = async open => {
    const before = new Set(gBrowser.tabs);
    open();
    await TestUtils.waitForCondition(
      () => gBrowser.tabs.some(tab => !before.has(tab)),
      "the window gained a tab"
    );
    return expectOpened(gBrowser.tabs.find(tab => !before.has(tab)));
  };

  const linked = BrowserTestUtils.addTab(gBrowser, "about:blank");
  is(
    await parentOf(linked),
    group,
    "a tab opened from a link goes in the group"
  );
  await selectTab(linked);
  gBrowser.moveTabTo(linked, { tabIndex: gBrowser.tabs.length - 1 });
  is(gBrowser.tabs.at(-1), linked, "and the grouped tab ends the strip");

  const keyed = await newTabFrom(() =>
    EventUtils.synthesizeKey("t", { accelKey: true })
  );
  is(
    gBrowser.tabs.indexOf(keyed),
    gBrowser.tabs.indexOf(linked) + 1,
    "the keyboard's new tab opens beside the grouped tab"
  );
  is(await parentOf(keyed), workspace, "and is filed at the top, not in it");

  await selectTab(linked);
  const button = await newTabFrom(() => SvalPanel.observer.openNewTab());
  is(await parentOf(button), workspace, "so is the button's");

  await selectTab(linked);
  const fromRow = await newTabFrom(() =>
    SvalPanel.observer.openNewTab({ inSelection: true })
  );
  is(await parentOf(fromRow), group, "a row's own New tab goes in the group");

  await selectTab(grouped);
  const after = await newTabFrom(() =>
    BrowserTestUtils.addTab(gBrowser, "about:blank")
  );
  is(
    await parentOf(after),
    group,
    "and no verdict outlives the tab it was made for"
  );
});

/**
 * Settings opened while the user is in a group opens as the last tab of the
 * workspace, outside every group, and is selected, and closing it goes back
 * to the tab it was opened from. That holds for Firefox's `openPreferences`,
 * which the menu, the keyboard and the app menu call, and for Sval's own
 * `openSettingsPage`. Settings is about the browser, so it does not go with
 * the page the user was on.
 *
 * The user is viewing a grouped tab, and a loose tab follows it in the
 * strip, so a tab opened beside the selected one would be filed before it.
 */
add_task(async function settings_opens_last_outside_every_group() {
  const { engine, workspace, group, grouped, loose } = await viewingInAGroup({
    loose: true,
  });
  ok(loose, "the switch opened the loose tab");
  is(
    (await nodes(engine))[taggedId(grouped)]?.placement.parent,
    group,
    "the viewed tab is in the group"
  );

  for (const [how, open] of [
    ["openPreferences", () => openPreferences()],
    ["openSettingsPage", () => SvalPanel.openSettingsPage()],
  ]) {
    // Closing settings hands the selection back to the tab it was opened
    // from, so only the first pass switches to it.
    if (gBrowser.selectedTab !== grouped) {
      await selectTab(grouped);
    }
    const opening = BrowserTestUtils.waitForNewTab(
      gBrowser,
      url => url.startsWith(SETTINGS_PAGE_URL),
      true
    );
    open();
    const settings = await within(opening, 10_000, `settings from ${how}`);
    await TestUtils.waitForCondition(
      () => taggedId(settings),
      "settings was filed"
    );
    await settled();
    const id = taggedId(settings);
    const tree = await nodes(engine);
    is(
      tree[id]?.placement.parent,
      workspace,
      `${how}: settings is filed at the top of the workspace`
    );
    is(
      SvalTree.childrenByParent(tree).get(workspace).at(-1),
      id,
      `${how}: as its last row`
    );
    is(gBrowser.selectedTab, settings, `${how}: and is selected`);
    BrowserTestUtils.removeTab(settings);
    is(
      gBrowser.selectedTab,
      grouped,
      `${how}: closing it goes back to the tab it was opened from`
    );
    await settled();
  }
});

/**
 * Settings is a tab like any other (spec §10.4): opening it files it in the
 * workspace, and opening it again brings the same tab forward instead of
 * filing another.
 *
 * A workspace switch then releases it like any other tab, though
 * `about:preferences` loads in the parent process and Firefox's discard
 * refuses such a browser: left behind, it would sit in a window showing
 * another workspace with no row to reach it by.
 */
add_task(async function settings_is_filed_and_opening_it_again_reuses_it() {
  const { engine, workspace, elsewhere } = await ourWorkspace({
    second: true,
  });

  const tab = expectOpened(SvalPanel.openSettingsPage());
  await committed(
    tab.linkedBrowser,
    b => b.currentURI?.spec.startsWith(SETTINGS_PAGE_URL),
    "settings opened"
  );
  await TestUtils.waitForCondition(() => taggedId(tab), "settings was filed");
  await settled();

  const id = taggedId(tab);
  let tree = await nodes(engine);
  ok(
    tree[id]?.content?.url?.startsWith(SETTINGS_PAGE_URL),
    "the document holds settings as a tab"
  );
  is(tree[id]?.placement?.parent, workspace, "in the window's workspace");

  const tabCount = gBrowser.tabs.length;
  const again = SvalPanel.openSettingsPage("storage");
  is(again, tab, "opening it again brings the same tab forward");
  is(gBrowser.selectedTab, tab, "and selects it");
  is(gBrowser.tabs.length, tabCount, "and opens no other tab");
  await settled();
  tree = await nodes(engine);
  is(
    SvalTree.descendantIds(tree, workspace).filter(node =>
      (tree[node].content?.url ?? "").startsWith(SETTINGS_PAGE_URL)
    ).length,
    1,
    "so the workspace holds one settings tab"
  );
  ok(
    !tab.linkedBrowser.isRemoteBrowser,
    "settings loads in the parent process, which Firefox will not discard"
  );

  const other = tree[elsewhere].placement.parent;
  Assert.ok(
    await within(SvalPanel.switchTo(other), 10_000, "the switch away"),
    "the window shows the other workspace"
  );
  await settled();
  const { HIDDEN_WORKSPACE_UNLOAD_MS } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
  );
  const { SvalClock } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalClock.sys.mjs"
  );
  await SvalPanel.observer.releaseIdle(
    SvalClock.now() + HIDDEN_WORKSPACE_UNLOAD_MS
  );
  ok(!gBrowser.tabs.includes(tab), "the idle unload released the settings tab");
  ok(id in (await nodes(engine)), "while its node stays in its workspace");
});

/**
 * A tab the user takes to settings keeps its node, which follows it there,
 * and a tab that leaves settings keeps it too.
 */
add_task(async function a_tab_navigated_to_settings_keeps_its_node() {
  await ourWorkspace();

  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"),
    15_000,
    "the new tab opening and loading"
  );
  await settled();
  const id = taggedId(tab);
  ok(id, "the tab was filed when it opened");

  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, SETTINGS_PAGE_URL);
  await within(
    BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url =>
      url.startsWith(SETTINGS_PAGE_URL)
    ),
    10_000,
    "settings loading in the tab"
  );
  await TestUtils.waitForCondition(
    async () =>
      (await settledNodes())[id]?.content?.url?.startsWith(SETTINGS_PAGE_URL),
    "the node follows the tab to settings"
  );
  is(taggedId(tab), id, "under the same id");

  BrowserTestUtils.startLoadingURIString(
    tab.linkedBrowser,
    "https://example.org/"
  );
  await within(
    BrowserTestUtils.browserLoaded(
      tab.linkedBrowser,
      false,
      "https://example.org/"
    ),
    10_000,
    "the tab's load of example.org"
  );
  await TestUtils.waitForCondition(
    async () =>
      (await settledNodes())[id]?.content?.url === "https://example.org/",
    "and back out again"
  );
  is(taggedId(tab), id, "still under the same id");
});

/**
 * Every screen the user opens is a tab in the workspace, and the panel closes
 * it like any other: Firefox's own pages, and an `about:blank` the user asked
 * for.
 */
add_task(async function about_pages_the_user_opens_are_filed_and_close() {
  const { engine, workspace } = await ourWorkspace();

  for (const url of [
    "about:addons",
    "about:downloads",
    "about:config",
    "about:blank",
  ]) {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(gBrowser, url),
      15_000,
      "the new tab opening and loading"
    );
    await TestUtils.waitForCondition(() => taggedId(tab), `${url} was filed`);
    const id = taggedId(tab);
    await TestUtils.waitForCondition(
      async () => (await settledNodes())[id]?.content?.url === url,
      `the document holds ${url} as a tab`
    );
    is(
      (await nodes(engine))[id]?.placement?.parent,
      workspace,
      `${url} is in the workspace`
    );

    gBrowser.removeTab(tab);
    await TestUtils.waitForCondition(
      () => !gBrowser.tabs.includes(tab),
      `${url} left the window`
    );
    await settled();
    ok(!(id in (await nodes(engine))), `and ${url}'s node went with it`);
  }
});

/**
 * An error page is the address the user asked for, and is filed and closed
 * as that address.
 */
add_task(async function an_error_page_is_filed_and_closes() {
  const { engine, workspace } = await ourWorkspace();

  const url = "https://expired.example.com/";
  const tab = BrowserTestUtils.addTab(gBrowser, url);
  const shown = BrowserTestUtils.waitForErrorPage(tab.linkedBrowser);
  await selectTab(tab);
  await within(shown, 15_000, "the error page loading in the tab");
  await TestUtils.waitForCondition(() => taggedId(tab), "the tab was filed");
  const id = taggedId(tab);
  await TestUtils.waitForCondition(
    async () => (await settledNodes())[id]?.content?.url === url,
    "under the address that failed"
  );
  is(
    (await nodes(engine))[id]?.placement?.parent,
    workspace,
    "in the workspace"
  );

  gBrowser.removeTab(tab);
  await TestUtils.waitForCondition(
    () => !gBrowser.tabs.includes(tab),
    "the error page left the window"
  );
  await settled();
  ok(!(id in (await nodes(engine))), "and its node went with it");
});
