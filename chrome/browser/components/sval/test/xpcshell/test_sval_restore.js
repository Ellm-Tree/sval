/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from tabs_head.js */

/**
 * Restoration against fake tabs and real engines: what the tree says is open
 * is what a launch opens, and a second launch of the same tree adds nothing.
 *
 * The engines and the folder are real, because the document has to survive
 * a restart, and an in-memory stand-in would make that unfalsifiable. The
 * window is faked, so `test/browser/browser_sval_restore.js` proves the real
 * `SessionStore.setTabState` path.
 */

const { SvalRestore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalRestore.sys.mjs"
);

const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

const DOCUMENT = "workspaces";

/** A blank tab: blank, no history, no node id. */
function blankTab() {
  const tab = new FakeTab("New Tab", "about:newtab");
  tab.blank = true;
  return tab;
}

/**
 * `tabs_head.js`'s window, with what a launch adds: the empty tab a window
 * opens with, which announces no `TabOpen`, and every tab restoration
 * selected, in order.
 */
class RestoreWindow extends FakeWindow {
  constructor() {
    super();
    this.shown = [];
    // The window a launch is restoring, for an adapter that acts on it.
    RestoreWindow.latest = this;
  }

  dispatch(type, tab, detail = {}) {
    if (type === "TabOpen") {
      tab.announced = true;
    }
    super.dispatch(type, tab, detail);
  }

  /** The empty tab a window opens with. */
  openBlankTab() {
    const tab = blankTab();
    this.tabs.push(tab);
    this.selected = tab;
    return tab;
  }

  /** A new tab somebody opened, blank as the window's own is. */
  openUserBlankTab() {
    const tab = blankTab();
    this.tabs.push(tab);
    this.dispatch("TabOpen", tab);
    return tab;
  }
}

const nodeIdOf = tab => fakeAdapter.nodeId(tab);

/**
 * The restore adapter over the same fakes. `openRestoredTab` records that the
 * tab was materialised from a node, which is how the tests tell a restored
 * tab from one the fixture opened by hand.
 */
const fakeRestoreAdapter = {
  tabsOf: window => Array.from(window.gBrowser.tabs),
  nodeId: nodeIdOf,
  openRestoredTab(window, node, id) {
    const tab = new FakeTab(node.content?.name ?? "", node.content?.url ?? "");
    tab.restored = true;
    tab.values.set(SvalTabs.NODE_ID_KEY, id);
    window.tabs.push(tab);
    return tab;
  },
  openRestoredTabs(window, entries) {
    return entries.map(({ node, id }) =>
      fakeRestoreAdapter.openRestoredTab(window, node, id)
    );
  },
  // Only the tab the window was created with, which announced no `TabOpen`.
  isDebris: tab => tab.blank && !tab.announced,
  selectTab(window, tab) {
    window.shown.push(tab);
    window.selected = tab;
  },
  // Closing the selected tab selects its neighbour, as tabbrowser does.
  removeTab(window, tab) {
    const index = window.tabs.indexOf(tab);
    window.tabs.splice(index, 1);
    if (window.selected === tab) {
      window.selected =
        window.tabs[Math.min(index, window.tabs.length - 1)] ?? null;
    }
  },
  sessionSettled: () => Promise.resolve(),
};

/**
 * One device: an engine over `root`, plus the window and observer a launch
 * brings up. Reusing `root`, `keyBytes` and `deviceId` across two calls makes
 * the second a restart of the first.
 *
 * @param {object} identity `{ root, keyBytes, deviceId }`.
 * @param {object} [options] Launch options.
 * @param {Function} [options.show] Passed to `restore`.
 * @param {object} [options.adapter] Passed to `restore`.
 * @returns {Promise<object>} `{ engine, window, observer, workspace, result }`.
 */
async function launch(identity, { show, adapter = fakeRestoreAdapter } = {}) {
  const engine = new SvalEngine(identity);
  await engine.sync(DOCUMENT, Date.now());

  const tree = (await engine.tree()).nodes ?? {};
  let workspace = Object.entries(tree).find(
    ([, node]) => node.kind === "workspace"
  )?.[0];
  if (!workspace) {
    workspace = await engine.mutate({
      kind: "addWorkspace",
      name: "",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
  }

  const window = new RestoreWindow();
  window.openBlankTab();

  const result = await SvalRestore.restore(window, {
    engine,
    workspaceId: workspace,
    adapter,
    show,
  });

  const observer = await SvalTabs.attach(window, {
    engine,
    workspaceId: workspace,
    adapter: fakeAdapter,
    onFlush: () => engine.sync(DOCUMENT, Date.now()),
  });
  await within(observer.settled(), 10_000, "observer settling");

  return { engine, window, observer, workspace, result };
}

/**
 * Ends a launch the way quitting does: the debounce is flushed so the document
 * reaches the folder, then the worker goes.
 *
 * The document is read before the worker is terminated. A terminated engine
 * answers `tree()` by starting a fresh worker with an empty document, so a
 * count taken afterwards would be zero.
 *
 * @param {object} session A value from {@link launch}.
 * @returns {Promise<object>} the tab nodes the document held at the end.
 */
async function quit(session) {
  await within(session.observer.settled(), 10_000, "session.observer settling");
  await session.engine.sync(DOCUMENT, Date.now());
  const tabs = await tabNodes(session.engine);
  await session.observer.detach();
  session.engine.terminate();
  return tabs;
}

/**
 * The tab nodes in the document, id to node.
 *
 * @param {object} engine The engine to read.
 */
async function tabNodes(engine) {
  const nodes = (await engine.tree()).nodes ?? {};
  return Object.fromEntries(
    Object.entries(nodes).filter(([, node]) => node.kind === "tab")
  );
}

/**
 * One device's identity over a folder of its own. Passing the same value to
 * two `launch` calls makes the second a restart of the first.
 *
 * @param {string} name Distinguishes this test's folder from the others'.
 * @returns {Promise<object>} `{ root, keyBytes, deviceId }`.
 */
async function device(name) {
  return {
    root: await makeTempDir(`sval-${name}`),
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  };
}

/**
 * Quit with tabs open, launch again, and the same tabs are there, from
 * Sval's document, with Firefox's session never consulted.
 */
add_task(async function the_tree_is_what_a_launch_opens() {
  const me = await device("restore-tree");

  const first = await launch(me);
  first.window.openTab("Kagi", "https://kagi.com/");
  first.window.openTab("Example", "https://example.com/");
  const wanted = await quit(first);
  Assert.equal(Object.keys(wanted).length, 2, "two tabs were filed");

  const second = await launch(me);
  Assert.deepEqual(
    second.result.opened.sort(),
    Object.keys(wanted).sort(),
    "the second launch opened a tab for every tab node and no others"
  );
  Assert.deepEqual(second.result.adopted, [], "none of them was already open");
  Assert.deepEqual(
    second.window.tabs.map(tab => tab.url),
    ["https://kagi.com/", "https://example.com/"],
    "with the URLs the tree held, in the order the tree held them"
  );
  Assert.ok(
    second.window.tabs.every(tab => tab.restored),
    "every tab in the window came from a node"
  );
  await quit(second);
});

/**
 * It takes two launches: one launch cannot tell a tree that is stable from a
 * tree that grows.
 */
add_task(async function two_launches_of_the_same_tree_file_nothing_new() {
  const me = await device("restore-count");

  const first = await launch(me);
  first.window.openTab("Kagi", "https://kagi.com/");
  first.window.openTab("Example", "https://example.com/");
  const after_first = Object.keys(await quit(first)).length;
  Assert.equal(
    after_first,
    2,
    "the first launch filed the two tabs opened in it"
  );

  const second = await launch(me);
  const after_second = Object.keys(await quit(second)).length;

  const third = await launch(me);
  const after_third = Object.keys(await quit(third)).length;

  Assert.equal(
    after_second,
    after_first,
    "relaunching filed no stray: the tabs it restored are the tabs it matched"
  );
  Assert.equal(
    after_third,
    after_first,
    "and the count does not creep, which one relaunch could not have shown"
  );
});

/**
 * A tab Sval restored carries the node id of the node it came from, so the
 * observer recognises it. Without that match every launch would file the
 * whole tree again under new ids.
 */
add_task(async function a_restored_tab_is_matched_by_its_node_id() {
  const me = await device("restore-match");

  const first = await launch(me);
  const tab = first.window.openTab("Kagi", "https://kagi.com/");
  await within(first.observer.settled(), 10_000, "first.observer settling");
  const id = nodeIdOf(tab);
  await quit(first);

  const second = await launch(me);
  Assert.deepEqual(second.result.opened, [id], "the node came back as a tab");
  Assert.equal(
    nodeIdOf(second.window.tabs[0]),
    id,
    "carrying the id it had before, not a new one"
  );
  Assert.deepEqual(
    Object.keys(await quit(second)),
    [id],
    "so the document still holds exactly one tab node"
  );
});

/**
 * The empty tab a window opens with is worth no node: filing one would put a
 * fresh "New Tab" in the tree on every launch. Once there is something of the
 * user's to show, it is closed.
 */
add_task(
  async function the_empty_tab_a_window_opens_with_is_not_worth_a_node() {
    const me = await device("restore-debris");

    const first = await launch(me);
    Assert.equal(
      first.window.tabs.length,
      1,
      "an empty tree keeps the blank tab: a window with no tabs is not a state"
    );
    Assert.equal(
      Object.keys(await tabNodes(first.engine)).length,
      0,
      "and files no node for it"
    );

    first.window.openTab("Kagi", "https://kagi.com/");
    await quit(first);

    const second = await launch(me);
    Assert.equal(
      second.result.closed,
      1,
      "the blank tab was closed, not left over"
    );
    Assert.deepEqual(
      second.window.tabs.map(tab => tab.url),
      ["https://kagi.com/"],
      "leaving only what the tree held"
    );
    Assert.equal(
      Object.keys(await quit(second)).length,
      1,
      "and still one tab node, not two"
    );
  }
);

/**
 * The empty tab is the one the window was created with. A blank tab opened
 * while restoring waits, as a new tab in a window just reopened can be, is
 * the user's and stays.
 */
add_task(async function a_blank_tab_opened_while_restoring_is_kept() {
  const me = await device("restore-debris-late");

  const first = await launch(me);
  first.window.openTab("Kagi", "https://kagi.com/");
  await quit(first);

  let late = null;
  const second = await launch(me, {
    adapter: {
      ...fakeRestoreAdapter,
      async sessionSettled() {
        late ??= RestoreWindow.latest.openUserBlankTab();
      },
    },
  });
  Assert.equal(second.result.closed, 1, "only the startup tab closed");
  Assert.ok(
    second.window.tabs.includes(late),
    "the tab opened while restoring is still there"
  );
  Assert.deepEqual(
    second.window.tabs.filter(tab => !tab.blank).map(tab => tab.url),
    ["https://kagi.com/"],
    "beside what the tree held"
  );
  await quit(second);
});

/**
 * A window closed while its restore waits, for the session or for the tree,
 * gets nothing opened, selected or closed in it: tabbrowser cannot make a
 * tab in a window that has gone.
 */
add_task(async function a_window_closed_while_restoring_opens_nothing() {
  const me = await device("restore-closed");
  const first = await launch(me);
  first.window.openTab("Kagi", "https://kagi.com/");
  const engine = first.engine;
  await within(first.observer.settled(), 10_000, "first.observer settling");
  await engine.sync(DOCUMENT, Date.now());
  const workspace = first.workspace;

  const closing = [
    {
      what: "for the session",
      adapter: window => ({
        ...fakeRestoreAdapter,
        async sessionSettled() {
          window.closed = true;
        },
      }),
      engine: () => engine,
    },
    {
      what: "for the tree",
      adapter: () => fakeRestoreAdapter,
      engine: window => ({
        async tree() {
          const tree = await engine.tree();
          window.closed = true;
          return tree;
        },
      }),
    },
  ];
  for (const { what, adapter, engine: engineFor } of closing) {
    const window = new RestoreWindow();
    window.closed = false;
    window.openBlankTab();
    const result = await SvalRestore.restore(window, {
      engine: engineFor(window),
      workspaceId: workspace,
      adapter: adapter(window),
      show: wanted => wanted[0],
    });
    Assert.deepEqual(
      window.tabs.filter(tab => tab.restored),
      [],
      `closed while waiting ${what}, nothing opened`
    );
    Assert.deepEqual(window.shown, [], "nothing selected");
    Assert.equal(result.closed, 0, "nothing closed");
    Assert.deepEqual(result.opened, [], "and the result says so");
  }
  await quit(first);
});

/**
 * A launch lands on the tab it is told to show, selected before the empty
 * startup tab closes, so no other tab is shown on the way and the empty tab is
 * not left over.
 */
add_task(async function a_launch_shows_the_tab_it_is_given_and_nothing_first() {
  const me = await device("restore-show");

  const first = await launch(me);
  first.window.openTab("Kagi", "https://kagi.com/");
  first.window.openTab("Example", "https://example.com/");
  await quit(first);

  const second = await launch(me, { show: ids => ids[1] });
  Assert.equal(
    second.window.selected?.url,
    "https://example.com/",
    "the tab it was given is the one selected"
  );
  Assert.deepEqual(
    second.window.shown.map(tab => tab.url),
    ["https://example.com/"],
    "and no other tab was selected on the way"
  );
  Assert.equal(second.result.closed, 1, "the empty startup tab closed");
  Assert.deepEqual(
    second.window.tabs.map(tab => tab.url),
    ["https://kagi.com/", "https://example.com/"],
    "leaving only the workspace's tabs"
  );
  await quit(second);
});

/**
 * A recorded tab that is not one of the workspace's (closed since, or in
 * another workspace) selects nothing, and the window shows the first tab, as
 * it does when nothing was recorded.
 */
add_task(async function a_tab_outside_the_workspace_is_never_shown() {
  const me = await device("restore-show-gone");

  const first = await launch(me);
  first.window.openTab("Kagi", "https://kagi.com/");
  first.window.openTab("Example", "https://example.com/");
  await quit(first);

  const second = await launch(me, { show: () => crypto.randomUUID() });
  Assert.equal(
    second.window.selected?.url,
    "https://kagi.com/",
    "the window shows the workspace's first tab"
  );
  Assert.equal(second.result.closed, 1, "and the empty startup tab closed");
  await quit(second);
});

/**
 * A blank tab the user opens while Sval is running is filed. The panel is the
 * only tab surface, so a new tab has to appear there. The debris filter is
 * about tabs that predate the observer.
 */
add_task(async function a_blank_tab_the_user_opens_is_still_filed() {
  const me = await device("restore-newtab");
  const session = await launch(me);

  const tab = blankTab();
  session.window.tabs.push(tab);
  session.window.dispatch("TabOpen", tab);
  await within(session.observer.settled(), 10_000, "session.observer settling");

  Assert.ok(
    nodeIdOf(tab),
    "a tab opened after attach is filed whatever it is showing"
  );
  await quit(session);
});

/**
 * Restoration does not disturb a tab already open under its node, as in a
 * second window or a tab Firefox handed back, and does not open a second
 * one beside it.
 */
add_task(async function a_node_already_open_is_adopted_not_reopened() {
  const me = await device("restore-adopt");

  const first = await launch(me);
  const tab = first.window.openTab("Kagi", "https://kagi.com/");
  await within(first.observer.settled(), 10_000, "first.observer settling");
  const id = nodeIdOf(tab);

  const again = await SvalRestore.restore(first.window, {
    engine: first.engine,
    workspaceId: first.workspace,
    adapter: fakeRestoreAdapter,
  });

  Assert.deepEqual(again.opened, [], "nothing was opened");
  Assert.deepEqual(again.adopted, [id], "the open tab was matched by its id");
  Assert.equal(first.window.tabs.length, 1, "and no duplicate appeared");
  await quit(first);
});

/**
 * Tabs inside groups are restored too, in the one ordered list the workspace's
 * children are. Nothing sorts by kind, so a tab after a group comes after
 * that group's tabs.
 */
add_task(async function tabs_inside_groups_are_restored_in_document_order() {
  const me = await device("restore-groups");
  const engine = new SvalEngine(me);

  const now = 1000;
  const workspace = await engine.mutate({
    kind: "addWorkspace",
    name: "",
    id: crypto.randomUUID(),
    now,
  });
  const group = await engine.mutate({
    kind: "addGroup",
    parent: workspace,
    name: "Reading",
    id: crypto.randomUUID(),
    now,
  });
  await engine.mutate({
    kind: "addTab",
    parent: group,
    name: "Inside",
    url: "https://inside.example/",
    id: crypto.randomUUID(),
    now,
  });
  await engine.mutate({
    kind: "addTab",
    parent: workspace,
    name: "After",
    url: "https://after.example/",
    id: crypto.randomUUID(),
    now,
  });

  const window = new RestoreWindow();
  window.openBlankTab();
  const result = await SvalRestore.restore(window, {
    engine,
    workspaceId: workspace,
    adapter: fakeRestoreAdapter,
  });

  Assert.equal(result.opened.length, 2, "both tabs were restored");
  Assert.deepEqual(
    window.tabs.map(tab => tab.url),
    ["https://inside.example/", "https://after.example/"],
    "in the order the tree draws them, the group walked through rather than skipped"
  );
  engine.terminate();
});

/**
 * `restoreOnce` is what the panel calls, and it stops the second window the
 * user opens from opening the whole tree again.
 */
add_task(async function only_the_first_window_of_a_session_restores() {
  const me = await device("restore-once");
  const engine = new SvalEngine(me);
  const workspace = await engine.mutate({
    kind: "addWorkspace",
    name: "",
    id: crypto.randomUUID(),
    now: 1000,
  });
  await engine.mutate({
    kind: "addTab",
    parent: workspace,
    name: "Kagi",
    url: "https://kagi.com/",
    id: crypto.randomUUID(),
    now: 1000,
  });

  const options = {
    engine,
    workspaceId: workspace,
    adapter: fakeRestoreAdapter,
  };

  const one = new RestoreWindow();
  one.openBlankTab();
  const first = await SvalRestore.restoreOnce(one, options);
  Assert.equal(first.opened.length, 1, "the first window restored the tree");

  const two = new RestoreWindow();
  two.openBlankTab();
  Assert.strictEqual(
    await SvalRestore.restoreOnce(two, options),
    null,
    "a window opened afterwards restores nothing"
  );
  Assert.equal(two.tabs.length, 1, "and holds only the tab it opened with");

  engine.terminate();
});

/**
 * A tab the user opens and then navigates comes back where it was, because
 * the node's url follows the tab instead of staying at `about:blank`, where
 * `TabOpen` found it.
 */
add_task(async function a_navigated_tab_comes_back_at_the_url_it_was_on() {
  const me = await device("restore-navigated");

  const first = await launch(me);
  const tab = first.window.openTab("", "about:blank");
  await within(first.observer.settled(), 10_000, "first.observer settling");
  first.window.navigate(tab, "https://example.com/article");
  first.window.retitle(tab, "The Article");
  const filed = await quit(first);

  Assert.deepEqual(
    Object.values(filed).map(node => node.content.url),
    ["https://example.com/article"],
    "the document holds where the tab ended up, not where it started"
  );
  Assert.deepEqual(
    Object.values(filed).map(node => node.content.name),
    ["The Article"],
    "and what the page is called"
  );

  const second = await launch(me);
  const restored = second.window.tabs.filter(each => each.restored);
  Assert.deepEqual(
    restored.map(each => each.url),
    ["https://example.com/article"],
    "the next launch opens the page the user was actually on"
  );
  Assert.deepEqual(
    restored.map(each => each.label),
    ["The Article"],
    "under its own title"
  );
  await quit(second);
});
