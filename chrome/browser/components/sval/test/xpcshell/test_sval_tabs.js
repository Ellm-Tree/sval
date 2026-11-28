/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from tabs_head.js */

const { waitForCondition, within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);
const { rows } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const { latestNodes, onTree } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTreeSnapshot.sys.mjs"
);

/**
 * These tests drive the observer's logic against fake tabs, so they can run
 * without a chrome window. They cannot prove that the real `SessionStore` and
 * the real `TabOpen`/`TabClose` events behave as the adapter assumes;
 * `test/browser/browser_sval_tabs.js` covers that.
 */

/**
 * An engine with one workspace, a fake window, and a flush that counts the
 * sync passes the observer asked for instead of running them.
 *
 * Polling is off unless a test asks for it: these tests count flushes, and a
 * clock that fires on its own would make every count depend on how long the
 * task before it took. The tests that are *about* the poller pass `pollMs`.
 *
 * @param {object} [options] Passed through to `SvalTabs.attach`.
 * @returns {Promise<object>} `{ engine, window, observer, workspace, flushes }`.
 */
async function harness(options = {}) {
  const root = await makeTempDir("sval-tabs");
  const engine = new SvalEngine({
    root,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const workspace = crypto.randomUUID();
  await engine.mutate({
    kind: "addWorkspace",
    name: "Work",
    id: workspace,
    now: Date.now(),
  });

  const window = new FakeWindow();
  const flushes = { count: 0 };
  const observer = await SvalTabs.attach(window, {
    engine,
    workspaceId: workspace,
    adapter: fakeAdapter,
    pollMs: 0,
    onFlush: given => {
      Assert.equal(
        typeof given?.idleWithinMs,
        "number",
        "onFlush is given { idleWithinMs }"
      );
      flushes.count++;
    },
    ...options,
  });
  registerCleanupFunction(async () => {
    await observer.detach();
    engine.terminate();
  });

  return { engine, window, observer, workspace, flushes, root };
}

/**
 * A file's contents as a hex digest.
 *
 * @param {string} path An absolute path.
 * @returns {Promise<string>} the SHA-256 of the file's bytes.
 */
async function digestOf(path) {
  const hash = await crypto.subtle.digest("SHA-256", await IOUtils.read(path));
  return Array.from(new Uint8Array(hash))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Whether `a` sorts before `b`. Placement order is a fractional index, a
 * string compared lexicographically, so the numeric assertions cannot judge it.
 *
 * @param {string} a A placement order.
 * @param {string} b Another placement order.
 * @returns {boolean} whether `a` comes first.
 */
function sortsBefore(a, b) {
  return a < b;
}

/**
 * The document's nodes, keyed by id.
 *
 * @param {object} engine The engine to read.
 */
async function nodes(engine) {
  return (await engine.tree()).nodes;
}

add_task(async function an_opened_tab_is_tagged_and_gains_a_node() {
  const { engine, window, observer, workspace } = await harness();

  const tab = window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");

  const id = fakeAdapter.nodeId(tab);
  Assert.ok(id, "the tab carries a node id");
  Assert.equal(typeof id, "string", "the node id is a string");

  const tree = await nodes(engine);
  Assert.ok(id in tree, "the document holds a node for the tab");
  Assert.equal(tree[id].kind, "tab", "the node is a tab");
  Assert.equal(
    tree[id].content.name,
    "Example",
    "the label is the node's name"
  );
  Assert.equal(
    tree[id].content.url,
    "https://example.com/",
    "the URL is the node's url"
  );
  Assert.equal(
    tree[id].placement.parent,
    workspace,
    "a newly opened tab is filed under the workspace, not the catch-all"
  );
});

add_task(async function a_tab_favicon_is_read_from_the_tab_and_never_stored() {
  const changed = [];
  const { engine, window, observer, flushes } = await harness({
    onTabIconChanged: id => changed.push(id),
  });

  const tab = window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);
  Assert.equal(observer.iconFor(id), null, "a tab with no favicon has none");

  const flushesBefore = flushes.count;
  const contentBefore = (await nodes(engine))[id].content;
  window.setIcon(tab, "https://example.com/favicon.ico");
  await within(observer.settled(), 10_000, "observer settling");

  Assert.deepEqual(changed, [id], "the change is reported for that node");
  Assert.equal(
    observer.iconFor(id),
    "https://example.com/favicon.ico",
    "and the favicon is read from the live tab"
  );
  Assert.equal(
    observer.iconFor("no-such-node"),
    null,
    "a node with no live tab here has none"
  );
  Assert.equal(flushes.count, flushesBefore, "a favicon asks for no sync pass");
  Assert.deepEqual(
    (await nodes(engine))[id].content,
    contentBefore,
    "and the node's content is untouched"
  );
});

add_task(async function a_tab_reports_loading_and_being_loaded() {
  const changed = [];
  const { window, observer } = await harness({
    onTabLoadChanged: id => changed.push(id),
  });

  const tab = window.openTab("Example", "https://example.com/");
  tab.pending = true;
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);
  Assert.ok(!observer.isLoaded(id), "a pending tab has not loaded");
  Assert.ok(
    !observer.isLoaded("no-such-node"),
    "and a node with no live tab here has not loaded"
  );

  window.startRestoring(tab);
  Assert.deepEqual(changed, [id], "starting to restore is reported");
  Assert.ok(observer.isLoaded(id), "and the tab reads as loaded");

  tab.pending = true;
  window.dispatch("TabAttrModified", tab, { changed: ["pending"] });
  Assert.deepEqual(changed, [id, id], "a tab pending again is reported");
  Assert.ok(!observer.isLoaded(id), "and reads as not loaded");

  tab.busy = true;
  window.dispatch("TabAttrModified", tab, { changed: ["busy"] });
  Assert.deepEqual(changed, [id, id, id], "a tab starting a load is reported");
  Assert.ok(observer.isBusy(id), "and reads as loading");
  Assert.ok(
    !observer.isBusy("no-such-node"),
    "and a node with no live tab here is not loading"
  );

  window.dispatch("TabAttrModified", tab, { changed: ["soundplaying"] });
  Assert.equal(changed.length, 3, "an unrelated attribute is not");
});

add_task(async function closing_a_tab_deletes_its_node() {
  const { engine, window, observer } = await harness();

  const tab = window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);

  window.closeTab(tab);
  await within(observer.settled(), 10_000, "observer settling");

  const tree = await nodes(engine);
  Assert.ok(!(id in tree), "the node is gone, not marked closed");
  Assert.equal(
    fakeAdapter.nodeId(tab),
    id,
    "the tab keeps its id, which is what lets a restore come back as this node"
  );
});

add_task(async function a_restored_tab_comes_back_as_the_same_node() {
  const { engine, window, observer, workspace } = await harness();

  const tab = window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);

  window.closeTab(tab);
  await within(observer.settled(), 10_000, "observer settling");

  // Firefox's recently-closed list hands the tab back with its id still on it.
  window.tabs.push(tab);
  window.dispatch("TabOpen", tab);
  await within(observer.settled(), 10_000, "observer settling");

  const tree = await nodes(engine);
  Assert.ok(id in tree, "the node is live again under its original id");
  Assert.equal(
    tree[id].placement.parent,
    workspace,
    "an undone close puts the tab back where it was, not in the catch-all"
  );
});

add_task(async function a_tab_adopted_by_another_window_is_not_deleted() {
  const { engine, window, observer } = await harness();

  const tab = window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);

  // Dragging a tab to another window closes it here and opens it there. The
  // node has to survive that, or every drag would lose the tab.
  const destination = new FakeTab("Example", tab.url);
  window.closeTab(tab, { adoptedBy: destination });
  await within(observer.settled(), 10_000, "observer settling");

  Assert.ok(id in (await nodes(engine)), "the node survived the adoption");
  Assert.ok(
    fakeAdapter.takeAdopted(destination),
    "and the destination tab was marked on the way out — the close side is " +
      "the half of the pair both of Firefox's move routes raise, and the same " +
      "place the node id crosses"
  );
});

/**
 * The one thing that may reuse a deleted id is Firefox handing a closed tab
 * back from its recently-closed list, because there the user asked for that
 * tab back. For a tab dragged out of a sibling window, re-adding the id would
 * write it under this device with a fresh timestamp, so it would be news to
 * every peer and the deletion would be undone everywhere (spec §5.4). The tab
 * is live and on screen, so it is filed as a new tab in this window.
 */
add_task(async function an_adopted_tab_whose_node_is_gone_is_filed_afresh() {
  const { engine, window, observer, workspace } = await harness();

  // A node this window never held: a sibling window filed it and closed it
  // again, which is why it is created and removed through the engine rather
  // than by opening and closing a tab here.
  const id = await engine.mutate({
    kind: "addTab",
    parent: workspace,
    name: "Elsewhere",
    url: "https://example.com/elsewhere",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await engine.mutate({ kind: "remove", id });
  Assert.ok(!(id in (await nodes(engine))), "the node is gone");

  // The tab that window held, arriving here still carrying the id.
  // `SessionStore` moves it across on the close side whatever route the drag
  // took.
  const tab = new FakeTab("Elsewhere", "https://example.com/elsewhere");
  fakeAdapter.setNodeId(tab, id);
  fakeAdapter.markAdopted(tab);
  window.tabs.push(tab);
  window.dispatch("TabOpen", tab);
  await within(observer.settled(), 10_000, "observer settling");

  const tree = await nodes(engine);
  Assert.ok(!(id in tree), "the deleted node did not come back");
  const filed = fakeAdapter.nodeId(tab);
  Assert.notEqual(filed, id, "the tab carries a new id");
  Assert.ok(filed in tree, "and the document holds that node");
  Assert.equal(
    tree[filed].placement.parent,
    workspace,
    "filed where a new tab in this window goes"
  );
});

/**
 * A workspace holds tabs and groups as siblings in one ordered list, the way
 * loose files sit beside folders, so a tab that belongs to no group is a child
 * of the workspace. No catch-all group is made for strays: a constant node id
 * shared by every device could converge on one placement after two devices
 * created it under different workspaces, its name would be an unlocalised
 * string in the synced document, and the user would find a group in their
 * panel that they never made.
 */
add_task(async function tabs_already_open_at_attach_land_in_the_workspace() {
  const root = await makeTempDir("sval-strays");
  const engine = new SvalEngine({
    root,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const workspace = crypto.randomUUID();
  await engine.mutate({
    kind: "addWorkspace",
    name: "Work",
    id: workspace,
    now: Date.now(),
  });

  // Tabs that exist before the first attach, none of them tagged.
  const window = new FakeWindow();
  window.tabs.push(
    new FakeTab("One", "https://one.example/"),
    new FakeTab("Two", "https://two.example/")
  );

  const observer = await SvalTabs.attach(window, {
    engine,
    workspaceId: workspace,
    adapter: fakeAdapter,
    onFlush: () => {},
  });
  await within(observer.settled(), 10_000, "observer settling");

  const tree = await nodes(engine);
  Assert.deepEqual(
    Object.values(tree)
      .filter(node => node.kind === "group")
      .map(node => node.content.name),
    [],
    "no group was invented to hold them"
  );

  for (const tab of window.tabs) {
    const id = fakeAdapter.nodeId(tab);
    Assert.ok(id, `the stray ${tab.label} was tagged`);
    Assert.equal(
      tree[id].placement.parent,
      workspace,
      `the stray ${tab.label} is a child of the workspace itself`
    );
  }

  // A tab opened after attach is not a stray, so the two paths stay distinct.
  const fresh = window.openTab("Three", "https://three.example/");
  await within(observer.settled(), 10_000, "observer settling");
  Assert.equal(
    (await nodes(engine))[fakeAdapter.nodeId(fresh)].placement.parent,
    workspace,
    "a tab opened after attach is filed under the workspace"
  );
});

add_task(
  async function a_tab_closed_on_another_device_closes_when_its_window_attaches() {
    // Two devices on one folder. This device's window holds two tabs, then
    // stops watching, as a session that ends does. The other device closes one
    // of them. When the window attaches to a document carrying that close, the
    // last action wins: the tab closes here, and stays closed everywhere.
    const root = await makeTempDir("sval-tabs-closed-elsewhere");
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const DOC = "workspace-under-test";
    // Sync readings follow the tabs, which are stamped with the real clock: a
    // reader takes on no peer watermark later than its own reading.
    const t0 = Date.now();
    const here = new SvalEngine({
      root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    const there = new SvalEngine({
      root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    registerCleanupFunction(() => {
      here.terminate();
      there.terminate();
    });
    const workspace = crypto.randomUUID();
    await here.mutate({
      kind: "addWorkspace",
      name: "Work",
      id: workspace,
      now: t0,
    });
    const window = new FakeWindow();
    const attach = () =>
      SvalTabs.attach(window, {
        engine: here,
        workspaceId: workspace,
        adapter: fakeAdapter,
        pollMs: 0,
        onFlush: () => {},
      });
    const observer = await attach();
    const closing = window.openTab("Closed elsewhere", "https://one.example/");
    const staying = window.openTab("Staying", "https://two.example/");
    await within(observer.settled(), 10_000, "observer settling");
    const closedId = fakeAdapter.nodeId(closing);
    const stayingId = fakeAdapter.nodeId(staying);
    await observer.detach();
    await here.sync(DOC, t0 + 1000);

    await there.sync(DOC, t0 + 2000);
    Assert.ok(closedId in (await nodes(there)), "test setup: the peer has it");
    await there.mutate({ kind: "remove", id: closedId });
    await there.sync(DOC, t0 + 3000);
    await here.sync(DOC, t0 + 4000);

    const restarted = await attach();
    await within(restarted.settled(), 10_000, "restarted settling");
    await restarted.detach();

    Assert.deepEqual(window.tabs, [staying], "the closed tab is gone here");
    Assert.ok(!(closedId in (await nodes(here))), "its node stays deleted");
    Assert.ok(stayingId in (await nodes(here)), "the other tab is untouched");
    await here.sync(DOC, t0 + 5000);
    await there.sync(DOC, t0 + 6000);
    Assert.ok(
      !(closedId in (await nodes(there))),
      "the close holds on the device that made it"
    );
  }
);

add_task(
  async function a_peers_delete_merged_mid_write_leaves_the_rest_written() {
    // Two devices on one folder. The window's flush reads the tree holding
    // all three tabs, and in the turn of that read this device starts a pass
    // that merges the peer's delete of the middle one. The pass reaches the
    // worker before the flush's second write, which is posted only once the
    // first has answered, so that write names a node already gone.
    const root = await makeTempDir("sval-tabs-deleted-mid-write");
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const DOC = "workspace-under-test";
    const t0 = Date.now();
    const here = new SvalEngine({
      root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    const there = new SvalEngine({
      root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    registerCleanupFunction(() => {
      here.terminate();
      there.terminate();
    });
    const workspace = crypto.randomUUID();
    await here.mutate({
      kind: "addWorkspace",
      name: "Work",
      id: workspace,
      now: t0,
    });
    const window = new FakeWindow();
    const flushes = { count: 0 };
    const observer = await SvalTabs.attach(window, {
      engine: here,
      workspaceId: workspace,
      adapter: fakeAdapter,
      pollMs: 0,
      onFlush: () => {
        flushes.count++;
      },
    });
    registerCleanupFunction(() => observer.detach());
    const tabs = ["one", "two", "three"].map(name =>
      window.openTab(name, `https://${name}.example/`)
    );
    await within(observer.settled(), 10_000, "observer settling");
    const [first, gone, last] = tabs.map(tab => fakeAdapter.nodeId(tab));
    await here.sync(DOC, t0 + 1000);
    await there.sync(DOC, t0 + 2000);
    Assert.ok(gone in (await nodes(there)), "test setup: the peer has it");
    await there.mutate({ kind: "remove", id: gone, now: t0 + 2500 });
    await there.sync(DOC, t0 + 3000);
    // Changed without a read, so the flush's read is a tree `onTree` has not
    // been told of.
    await here.mutate({
      kind: "rename",
      id: workspace,
      name: "Work, renamed",
      now: t0 + 3500,
    });

    let merging = null;
    onTree(engine => {
      if (engine === here && !merging && latestNodes(here)[gone]) {
        merging = here.sync(DOC, t0 + 4000);
      }
    });
    const before = flushes.count;
    for (const tab of tabs) {
      window.navigate(tab, `${tab.url}next`, `${tab.label} next`);
    }
    await within(observer.settled(), 10_000, "observer settling");
    Assert.ok(merging, "test setup: the flush read the tree holding the tab");
    await within(merging, 10_000, "the pass merging the peer's delete");

    const held = await nodes(here);
    Assert.ok(!(gone in held), "the peer's delete holds");
    Assert.equal(
      held[first].content.url,
      "https://one.example/next",
      "the tab before it took its page"
    );
    Assert.equal(
      held[last].content.url,
      "https://three.example/next",
      "and the tab after it did too"
    );
    Assert.equal(flushes.count, before + 1, "and the pass after it ran");
  }
);

add_task(async function a_burst_of_opens_produces_one_write() {
  const { window, observer, flushes } = await harness();

  for (let i = 0; i < 10; i++) {
    window.openTab(`Tab ${i}`, `https://example.com/${i}`);
  }
  await within(observer.settled(), 10_000, "observer settling");

  Assert.equal(
    flushes.count,
    1,
    "ten tabs opening cost one sync pass, not ten files in the user's folder"
  );
});

add_task(async function moving_a_tab_reorders_its_node() {
  const { engine, window, observer } = await harness();

  const first = window.openTab("First", "https://one.example/");
  const second = window.openTab("Second", "https://two.example/");
  await within(observer.settled(), 10_000, "observer settling");

  const firstId = fakeAdapter.nodeId(first);
  const secondId = fakeAdapter.nodeId(second);

  let tree = await nodes(engine);
  Assert.ok(
    sortsBefore(tree[firstId].placement.order, tree[secondId].placement.order),
    "the strip order is the tree order to begin with"
  );

  // Drag the second tab in front of the first.
  window.tabs.splice(window.tabs.indexOf(second), 1);
  window.tabs.unshift(second);
  window.dispatch("TabMove", second);
  await within(observer.settled(), 10_000, "observer settling");

  tree = await nodes(engine);
  Assert.ok(
    sortsBefore(tree[secondId].placement.order, tree[firstId].placement.order),
    "the move reordered the nodes to match the strip"
  );
});

add_task(async function a_tab_opened_mid_strip_is_placed_not_appended() {
  const { engine, window, observer } = await harness();

  const first = window.openTab("First", "https://one.example/");
  const last = window.openTab("Last", "https://three.example/");
  await within(observer.settled(), 10_000, "observer settling");

  // A tab opened from a link lands next to its opener.
  const middle = window.openTab("Middle", "https://two.example/", 1);
  await within(observer.settled(), 10_000, "observer settling");

  const tree = await nodes(engine);
  const order = id => tree[id].placement.order;
  Assert.ok(
    sortsBefore(
      order(fakeAdapter.nodeId(first)),
      order(fakeAdapter.nodeId(middle))
    ),
    "the new node sorts after the tab it was opened beside"
  );
  Assert.ok(
    sortsBefore(
      order(fakeAdapter.nodeId(middle)),
      order(fakeAdapter.nodeId(last))
    ),
    "and before the one it was opened in front of"
  );
});

add_task(async function selecting_a_tab_writes_device_local_state_only() {
  const settingsPath = PathUtils.join(
    await makeTempDir("sval-settings"),
    "sval-local-settings.json"
  );
  SvalLocalSettings.forgetCachedValues();
  const settings = await SvalLocalSettings.open(settingsPath);

  const { engine, window, observer, flushes } = await harness({
    settings,
  });

  const tab = window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);
  const writesBefore = flushes.count;

  window.dispatch("TabSelect", tab);
  await within(observer.settled(), 10_000, "observer settling");

  Assert.greater(
    settings.lastActive(id),
    0,
    "the selection was recorded in device-local state"
  );
  Assert.equal(
    flushes.count,
    writesBefore,
    "spec §5.6: last-active never syncs, so selecting a tab writes no file"
  );

  const tree = await nodes(engine);
  Assert.ok(
    !JSON.stringify(tree[id]).includes("lastActive"),
    "and nothing about last-active reached the synced node"
  );

  // It survives a restart of the settings store, and goes when the node does.
  SvalLocalSettings.forgetCachedValues();
  const reread = await SvalLocalSettings.open(settingsPath);
  Assert.equal(
    reread.lastActive(id),
    settings.lastActive(id),
    "last-active persists across a reload"
  );

  window.closeTab(tab);
  await within(observer.settled(), 10_000, "observer settling");
  Assert.equal(
    settings.lastActive(id),
    null,
    "closing the tab drops its last-active entry rather than leaking forever"
  );
});

/**
 * A node's url and title follow its tab after `TabOpen`, because a restart
 * restores the tab at the url its node holds.
 */
add_task(async function a_navigated_tab_updates_its_nodes_url_and_title() {
  const { engine, window, observer } = await harness();

  const tab = window.openTab("example.com/", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);
  Assert.equal(
    (await nodes(engine))[id].content.url,
    "https://example.com/",
    "the node starts at the url the tab opened on"
  );

  window.navigate(tab, "https://example.com/welcome");
  window.retitle(tab, "Welcome");
  await within(observer.settled(), 10_000, "observer settling");

  const node = (await nodes(engine))[id];
  Assert.equal(
    node.content.url,
    "https://example.com/welcome",
    "the node followed the tab, which is what a restart reads"
  );
  Assert.equal(node.content.name, "Welcome", "and it followed the title");
  Assert.equal(
    node.placement.parent,
    (await nodes(engine))[id].placement.parent,
    "without moving the node"
  );
});

/**
 * A tab the user renamed keeps that name however it navigates, and shows its
 * page's title again once the name is taken away.
 */
add_task(async function a_labelled_tab_keeps_its_label_as_it_navigates() {
  const { engine, window, observer, workspace } = await harness();
  const tab = window.openTab("Start", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);
  await engine.mutate({ kind: "setLabel", id, label: "Mine", now: Date.now() });

  window.navigate(tab, "https://example.com/next");
  window.retitle(tab, "Next page");
  await within(observer.settled(), 10_000, "observer settling");

  // As the panel draws it, a title the observer still holds included.
  const shown = async () =>
    rows(await nodes(engine), {
      isCollapsed: () => false,
      root: workspace,
      pendingName: tabId => observer.pendingName(tabId),
    }).find(row => row.id === id).name;
  Assert.equal(await shown(), "Mine", "the row keeps the user's name");
  Assert.equal(
    (await nodes(engine))[id].content.url,
    "https://example.com/next",
    "while the tab follows its page"
  );

  await engine.mutate({ kind: "setLabel", id, label: null, now: Date.now() });
  Assert.equal(await shown(), "Next page", "and without it shows the title");
});

add_task(async function a_title_arriving_after_open_replaces_the_bare_host() {
  const { engine, window, observer } = await harness();

  // The label at `TabOpen` is the address; the real title arrives later.
  const tab = window.openTab("example.com/", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);

  window.retitle(tab, "Example Domain");
  await within(observer.settled(), 10_000, "observer settling");

  Assert.equal(
    (await nodes(engine))[id].content.name,
    "Example Domain",
    "the row reads the page's title, not its address"
  );
});

add_task(async function a_redirect_chain_costs_one_write() {
  const { engine, window, observer, flushes } = await harness({});

  const tab = window.openTab("start", "https://example.com/a");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);
  const before = flushes.count;

  // A redirect chain and a title that resolves in stages: many events, one
  // state that matters. Each commit replaces the last before the flush, so
  // the intermediate addresses never reach the document at all.
  window.navigate(tab, "https://example.com/b");
  window.retitle(tab, "B");
  window.navigate(tab, "https://example.com/c");
  window.navigate(tab, "https://example.com/final");
  window.retitle(tab, "Final");
  await within(observer.settled(), 10_000, "observer settling");

  Assert.equal(
    flushes.count - before,
    1,
    "a whole page load costs one file in the user's folder"
  );
  const node = (await nodes(engine))[id];
  Assert.equal(node.content.url, "https://example.com/final");
  Assert.equal(node.content.name, "Final");
});

/**
 * Counts the content writes `engine` takes from here on.
 *
 * @param {object} engine
 * @returns {{count: number}}
 */
function countContentWrites(engine) {
  const writes = { count: 0 };
  const mutate = engine.mutate.bind(engine);
  engine.mutate = op => {
    if (op.kind === "setContent") {
      writes.count++;
    }
    return mutate(op);
  };
  return writes;
}

/**
 * A page whose title keeps changing, a timer or an unread count, costs one
 * write per hold: its first title is written at once, the polls between pass
 * the later ones by, and the latest is in the document by the time anything
 * waits on the observer. Its row shows each title as it is set.
 */
add_task(async function a_ticking_title_is_written_once_per_hold() {
  const held = [];
  const { engine, window, observer, flushes, workspace } = await harness({
    pollMs: 10,
    titleHoldMs: 60_000,
    onTitleHeld: id => held.push(id),
  });
  try {
    const tab = window.openTab("Inbox", "https://mail.example/");
    await within(observer.settled(), 10_000, "observer settling");
    const id = fakeAdapter.nodeId(tab);
    const writes = countContentWrites(engine);

    const rowName = async () =>
      rows(await nodes(engine), {
        isCollapsed: () => false,
        root: workspace,
        pendingName: tabId => observer.pendingName(tabId),
      }).find(row => row.id === id).name;

    const ticks = 20;
    for (let i = 1; i <= ticks; i++) {
      window.retitle(tab, `Inbox (${i})`);
      Assert.equal(await rowName(), `Inbox (${i})`, "the row shows the title");
      const before = flushes.count;
      await waitForCondition(
        () => flushes.count > before,
        "a flush after the title changed"
      );
    }
    Assert.equal(writes.count, 1, "only the first title was written");
    Assert.deepEqual(
      held,
      Array(ticks - 1).fill(id),
      "the panel heard of each title held back, to paint its row"
    );
    Assert.equal((await nodes(engine))[id].content.name, "Inbox (1)");

    await within(observer.settled(), 10_000, "observer settling");
    Assert.equal(
      (await nodes(engine))[id].content.name,
      `Inbox (${ticks})`,
      "the latest title reached the document"
    );
    Assert.equal(writes.count, 2, "in one more write");
  } finally {
    await observer.detach();
  }
});

add_task(async function a_held_title_is_written_when_its_hold_ends() {
  const { engine, window, observer } = await harness({ titleHoldMs: 50 });

  const tab = window.openTab("Inbox", "https://mail.example/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);
  window.retitle(tab, "Inbox (1)");
  await within(observer.settled(), 10_000, "observer settling");

  window.retitle(tab, "Inbox (2)");
  await waitForCondition(
    async () => (await nodes(engine))[id].content.name === "Inbox (2)",
    "the held title is written once its hold ends"
  );
});

add_task(async function an_unchanged_tab_leaves_its_node_untouched() {
  const { engine, window, observer } = await harness();

  const tab = window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);
  // The whole node as bytes, so a re-stamped `content_at` fails this even
  // though the name and url would still compare equal. The poller relies on
  // an idle device writing nothing.
  const before = JSON.stringify((await nodes(engine))[id]);

  window.navigate(tab, "https://example.com/");
  window.retitle(tab, "Example");
  await within(observer.settled(), 10_000, "observer settling");

  Assert.equal(
    JSON.stringify((await nodes(engine))[id]),
    before,
    "a page load that ends where the node already was writes nothing at all"
  );
});

/**
 * A tab that loads its page again commits it before its title arrives, and
 * shows the address as its label meanwhile. Neither is news about the page,
 * so the node keeps its name and its content group is not written: a write
 * would re-stamp it and could win over a rename another device made
 * meanwhile.
 */
add_task(async function a_reload_without_its_title_yet_writes_nothing() {
  const { engine, window, observer } = await harness();

  const tab = window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);
  const before = JSON.stringify((await nodes(engine))[id]);

  window.navigate(tab, "https://example.com/");
  window.relabel(tab, "example.com/");
  // A page with no title reports an empty one as it finishes parsing.
  window.retitle(tab, "");
  await within(observer.settled(), 10_000, "observer settling");
  Assert.equal(
    JSON.stringify((await nodes(engine))[id]),
    before,
    "the address standing in for a title is not written"
  );

  window.retitle(tab, "Example");
  await within(observer.settled(), 10_000, "observer settling");
  Assert.equal(
    JSON.stringify((await nodes(engine))[id]),
    before,
    "and the title it already had arriving writes nothing either"
  );
});

/**
 * A tab whose load is refused, cancelled or still restoring commits nothing,
 * and its browser shows the blank page it started on while its label carries
 * the title a restore remembers. None of that is the user's page, so the node
 * keeps its address and name, and the next restore brings the page back.
 */
add_task(async function a_tab_that_commits_nothing_keeps_its_node() {
  const { engine, window, observer } = await harness();

  const tab = window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);
  const before = JSON.stringify((await nodes(engine))[id]);

  tab.url = "about:blank";
  window.relabel(tab, "Example");
  window.relabel(tab, "New Tab");
  await within(observer.settled(), 10_000, "observer settling");

  Assert.equal(
    JSON.stringify((await nodes(engine))[id]),
    before,
    "the blank page the tab was left on is not written"
  );
});

add_task(async function a_content_change_redraws_the_panel() {
  const redraws = { count: 0 };
  const { window, observer } = await harness({
    onTreeChanged: () => {
      redraws.count++;
    },
  });

  const tab = window.openTab("example.com/", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const afterOpen = redraws.count;
  Assert.greater(afterOpen, 0, "opening a tab redrew the panel");

  window.retitle(tab, "Example Domain");
  await within(observer.settled(), 10_000, "observer settling");
  Assert.greater(
    redraws.count,
    afterOpen,
    "and so did the title arriving, or the row would read the address forever"
  );

  window.closeTab(tab);
  await within(observer.settled(), 10_000, "observer settling");
  Assert.greater(
    redraws.count,
    afterOpen + 1,
    "and closing it, or the panel would show a tab the window does not have"
  );
});

add_task(async function the_panel_and_the_window_agree_after_a_burst() {
  const redraws = { count: 0 };
  const { engine, window, observer, workspace } = await harness({
    onTreeChanged: () => {
      redraws.count++;
    },
  });

  const tabs = [];
  for (let i = 0; i < 8; i++) {
    tabs.push(window.openTab(`Tab ${i}`, `https://example.com/${i}`));
  }
  for (const tab of tabs.slice(0, 3)) {
    window.closeTab(tab);
  }
  await within(observer.settled(), 10_000, "observer settling");

  const tree = await nodes(engine);
  const inTree = Object.keys(tree).filter(id => tree[id].kind === "tab");
  const inWindow = window.tabs.map(tab => fakeAdapter.nodeId(tab));
  Assert.deepEqual(
    inTree.sort(),
    [...inWindow].sort(),
    "after a burst of opens and closes the tree holds exactly the window's tabs"
  );
  Assert.equal(
    tree[inWindow[0]].placement.parent,
    workspace,
    "and they are still where they belong"
  );
});

add_task(async function selecting_a_node_shows_the_tab_it_already_has() {
  const { window, observer } = await harness();

  const first = window.openTab("First", "https://one.example/");
  const second = window.openTab("Second", "https://two.example/");
  await within(observer.settled(), 10_000, "observer settling");
  const before = window.tabs.length;

  Assert.ok(
    observer.selectNode(fakeAdapter.nodeId(first)),
    "the node has a live tab, so it was selected"
  );
  Assert.equal(window.selected, first, "that tab is the one the window shows");
  Assert.equal(
    window.tabs.length,
    before,
    "and no second tab was opened for a row that already had one"
  );

  Assert.equal(
    observer.selectNode(crypto.randomUUID()),
    false,
    "a node this window has no tab for is left to be materialised"
  );
  Assert.equal(window.selected, first, "and nothing else was selected");
  Assert.ok(second, "both tabs are still open");
});

add_task(async function deleting_nodes_closes_their_tabs_as_a_person_does() {
  const { engine, window, observer } = await harness();

  const tab = window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);

  const before = await nodes(engine);
  await SvalTabs.removeNodes(engine, null, before, [id]);
  Assert.deepEqual(
    observer.closeNodes([id, crypto.randomUUID()], before),
    [id],
    "only a node with a live tab has a tab to close"
  );
  await within(observer.settled(), 10_000, "observer settling");

  Assert.deepEqual(
    window.closedByPanel,
    [tab],
    "the browser was closed as a person closes one, so Firefox can hand it back"
  );
  Assert.ok(!(id in (await nodes(engine))), "and the node is gone");
});

/**
 * A poll that had nothing to write says it is idle, for one poll interval, so
 * the engine can skip it when another window has just run a pass. A poll that
 * writes a changed tab, and a flush after tab activity, never do.
 */
add_task(async function a_poll_says_whether_it_has_anything_to_publish() {
  const idle = [];
  const { window, observer } = await harness({
    pollMs: 20,
    onFlush: ({ idleWithinMs }) => idle.push(idleWithinMs),
  });

  try {
    await waitForCondition(() => idle.length, "a poll ran");
    Assert.equal(idle[0], 20, "a poll with nothing to write is idle");

    const tab = window.openTab("Loading", "https://example.com/");
    await within(observer.settled(), 10_000, "observer settling");
    const before = idle.length;
    window.retitle(tab, "Example");
    await waitForCondition(
      () => idle.slice(before).includes(0),
      "a poll wrote the retitled tab and said it was not idle"
    );
  } finally {
    await observer.detach();
  }
});

add_task(async function a_flush_after_tab_activity_is_never_idle() {
  const idle = [];
  const { window, observer } = await harness({
    onFlush: ({ idleWithinMs }) => idle.push(idleWithinMs),
  });

  try {
    window.openTab("Example", "https://example.com/");
    await waitForCondition(() => idle.length, "the debounced flush");
    Assert.deepEqual(idle, [0], "it asks for a pass that always runs");
  } finally {
    await observer.detach();
  }
});

add_task(async function a_flush_as_the_window_closes_is_never_idle() {
  const idle = [];
  const filed = Promise.withResolvers();
  const { window, observer } = await harness({
    onFlush: ({ idleWithinMs }) => idle.push(idleWithinMs),
    onTreeChanged: filed.resolve,
  });

  window.openTab("Example", "https://example.com/");
  await filed.promise;
  await observer.detach();
  Assert.deepEqual(idle, [0], "the detach flush asks for a pass that runs");
});

/**
 * A device where nothing is happening still syncs, which is the only way a
 * peer's change arrives.
 *
 * Nothing happens on the device, so every flush counted here came from the
 * poll.
 */
add_task(async function an_idle_device_syncs_on_its_own() {
  const { observer, flushes } = await harness({
    pollMs: 20,
  });

  try {
    await waitForCondition(
      () => flushes.count >= 3,
      "an idle device ran three passes with nobody asking"
    );
  } finally {
    await observer.detach();
  }
});

/**
 * Polling does not defeat quiescence: an idle device runs passes and writes
 * nothing.
 *
 * This counts files. The engine skips a write when the merged document matches
 * what its own file already holds, and the poller's risk is stamping
 * something, such as a timestamp or a re-read title, that makes every pass
 * differ from the last. So this counts what landed in the folder: the files,
 * and each one's modification time.
 *
 * The first pass is excluded: a device with nothing in the folder yet has no
 * own file to compare against, so it must write once. Every pass after that is
 * the one under test.
 */
add_task(async function an_idle_device_writes_no_files_over_several_polls() {
  const { engine, window, observer, root } = await harness({
    pollMs: 30,
  });

  try {
    const wrote = [];
    observer.onFlush = async () => {
      const report = await engine.sync("sval-idle-device", Date.now());
      wrote.push(report.wrote);
    };

    // Something real to publish first, so the folder holds this device's file
    // and the comparison the engine makes on every later pass has something to
    // compare against.
    window.openTab("Example", "https://example.com/");
    await within(observer.settled(), 10_000, "observer settling");
    await waitForCondition(
      () => wrote.some(path => path !== null),
      "the tab reached the folder"
    );

    const dir = PathUtils.parent(
      PathUtils.join(root, ...wrote.find(path => path !== null).split("/"))
    );
    const files = await IOUtils.getChildren(dir);
    const stamps = await Promise.all(
      files.map(async file => (await IOUtils.stat(file)).lastModified)
    );
    // The sealed bytes too, because `crypto::seal` draws a fresh nonce every
    // call: a rewrite of byte-identical content still changes the file.
    // Digested, so a failure prints two hashes instead of kilobytes of
    // ciphertext.
    const sealed = await Promise.all(files.map(digestOf));

    const passesBefore = wrote.length;
    await waitForCondition(
      () => wrote.length >= passesBefore + 5,
      "five more polls ran with nothing happening"
    );

    Assert.deepEqual(
      wrote.slice(passesBefore),
      new Array(wrote.length - passesBefore).fill(null),
      "not one idle pass published a file"
    );
    Assert.deepEqual(
      await IOUtils.getChildren(dir),
      files,
      "the folder holds the same files it did before the polls"
    );
    Assert.deepEqual(
      await Promise.all(
        files.map(async file => (await IOUtils.stat(file)).lastModified)
      ),
      stamps,
      "and none of them was rewritten"
    );
    Assert.deepEqual(
      await Promise.all(files.map(digestOf)),
      sealed,
      "byte for byte, including the nonce a resealed file would change"
    );
  } finally {
    await observer.detach();
  }
});

/**
 * An observer with no document to sync has nothing to publish, and its flush
 * does nothing instead of failing a pass on every poll.
 *
 * An absent document sent across the wasm boundary makes the generated glue
 * read `arg.length` and throw a TypeError naming neither the argument nor the
 * caller.
 */
add_task(async function an_observer_with_no_document_does_not_attempt_a_sync() {
  const root = await makeTempDir("sval-no-document");
  const engine = new SvalEngine({
    root,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const workspace = crypto.randomUUID();
  await engine.mutate({
    kind: "addWorkspace",
    name: "Work",
    id: workspace,
    now: Date.now(),
  });

  // Neither onFlush nor syncDocument: the shape browser-chrome tasks that
  // exercise filing attach with.
  const window = new FakeWindow();
  const observer = await SvalTabs.attach(window, {
    engine,
    workspaceId: workspace,
    adapter: fakeAdapter,
    pollMs: 0,
  });

  let threw = null;
  try {
    await observer.onFlush();
  } catch (err) {
    threw = err;
  }
  Assert.equal(threw, null, "a flush with no document to sync does not throw");

  await observer.detach();
  await engine.terminate();
  await IOUtils.remove(root, { recursive: true });
});

/**
 * A caller that means to sync without a document name is told what is
 * missing, instead of a TypeError from the wasm glue about a property on an
 * undefined argument.
 */
add_task(async function syncing_without_a_document_name_says_so() {
  const root = await makeTempDir("sval-sync-no-name");
  const engine = new SvalEngine({
    root,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });

  for (const bad of [undefined, null, ""]) {
    await Assert.rejects(
      engine.sync(bad),
      err =>
        err.message.includes("document") && !err.message.includes("length"),
      `sync(${JSON.stringify(bad)}) rejects, naming the document rather ` +
        "than failing in the wasm glue"
    );
  }

  await engine.terminate();
  await IOUtils.remove(root, { recursive: true });
});

/**
 * What the folder holds for `document`, read through a scratch document so the
 * engine's own in-memory copy cannot answer for it.
 *
 * @param {object} engine The engine whose folder and key to read with.
 * @param {string} document The document name.
 * @returns {Promise<object>} the published `nodes` map.
 */
async function publishedNodes(engine, document) {
  return JSON.parse(await engine.publishedTree(document)).nodes;
}

/**
 * A tab closed inside the debounce window before its window goes away is still
 * closed on the next launch.
 *
 * The close is dispatched in the same turn as the detach, before the
 * debounce can fire, so the only thing that can publish it is `detach`
 * itself, with its removal still queued when the window goes: the order a
 * window closing with its last edits in flight produces.
 */
add_task(async function a_close_just_before_detach_is_published() {
  const document = "sval-detach-close";
  const { engine, window, observer } = await harness({
    syncDocument: document,
    onFlush: undefined,
  });

  const tab = window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);
  Assert.ok(
    id in (await publishedNodes(engine, document)),
    "the open tab was published first"
  );

  window.closeTab(tab);
  await observer.detach();
  await within(observer.settled(), 10_000, "observer settling");

  Assert.ok(
    !(id in (await publishedNodes(engine, document))),
    "the close reached the folder before the debounce fired"
  );
  await engine.terminate();
});

/**
 * The same for a navigation: the page a tab is on when its window closes is the
 * page the next launch restores.
 */
add_task(async function a_navigation_just_before_detach_is_published() {
  const document = "sval-detach-navigate";
  const { engine, window, observer } = await harness({
    syncDocument: document,
    onFlush: undefined,
  });

  const tab = window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  const id = fakeAdapter.nodeId(tab);

  window.navigate(tab, "https://example.org/next");
  await observer.detach();
  await within(observer.settled(), 10_000, "observer settling");

  Assert.equal(
    (await publishedNodes(engine, document))[id]?.content?.url,
    "https://example.org/next",
    "the new address reached the folder"
  );
  await engine.terminate();
});

/**
 * Device-local state waiting on the debounce is written on detach as well.
 */
add_task(async function last_active_state_waiting_at_detach_is_written() {
  const settingsPath = PathUtils.join(
    await makeTempDir("sval-detach-settings"),
    "local.json"
  );
  SvalLocalSettings.forgetCachedValues();
  const settings = await SvalLocalSettings.open(settingsPath);
  const { engine, window, observer } = await harness({
    settings,
  });

  const tab = window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");
  window.dispatch("TabSelect", tab);
  await observer.detach();
  await within(observer.settled(), 10_000, "observer settling");

  const written = await IOUtils.readJSON(settingsPath);
  Assert.ok(
    fakeAdapter.nodeId(tab) in written.lastActive,
    "the selection reached the settings file"
  );
  SvalLocalSettings.forgetCachedValues();
  await engine.terminate();
});

/**
 * A window that closes as the application quits hands its last flush to the
 * profile's shutdown blocker, which waits for it.
 *
 * The detach is not awaited here: during a real quit nothing awaits it, and
 * the barrier is the only thing standing between the flush and process exit.
 */
add_task(async function the_shutdown_blocker_waits_for_a_detach_in_flight() {
  const { AsyncShutdown } = ChromeUtils.importESModule(
    "resource://gre/modules/AsyncShutdown.sys.mjs"
  );
  const document = "sval-detach-shutdown";
  const barrier = new AsyncShutdown.Barrier("sval test: detach at shutdown");
  SvalEngine.setShutdownClient(barrier.client);
  const { engine, window, observer } = await harness({
    syncDocument: document,
    onFlush: undefined,
  });
  SvalEngine.setSharedInstance(engine);

  try {
    const tab = window.openTab("Example", "https://example.com/");
    await within(observer.settled(), 10_000, "observer settling");
    const id = fakeAdapter.nodeId(tab);

    window.closeTab(tab);
    const lastFlush = observer.detach();
    await barrier.wait();
    await lastFlush;

    Assert.ok(
      !(id in (await publishedNodes(engine, document))),
      "the close was published before the barrier let shutdown go on"
    );
  } finally {
    SvalEngine.setSharedInstance(null);
    SvalEngine.setShutdownClient(null);
    await engine.terminate();
  }
});

/**
 * A workspace another device took up and worked in while offline survives the
 * first device closing its window on it untouched.
 *
 * Device A opens a window on a new, untouched workspace W, and both devices
 * sync. Device B, offline, shows W in a window of its own and browses in it.
 * A then closes its W window, which deletes W, because nothing A can see has
 * touched it. B's browsing is an edit to W that A never saw, so when the two
 * sync, W comes back with B's tab still in it.
 */
add_task(
  async function a_workspace_another_device_worked_in_survives_the_close() {
    const root = await makeTempDir("sval-adopted-offline");
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const document = "sval-adopted-offline";
    const a = new SvalEngine({
      root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    const b = new SvalEngine({
      root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    const windowA = new FakeWindow();
    const windowB = new FakeWindow();
    let observerA = null;
    let observerB = null;

    try {
      // A named workspace beside W, so W is not the document's last one.
      await a.mutate({ kind: "addWorkspace", name: "Work", now: Date.now() });
      const untouched = await a.mutate({
        kind: "addWorkspace",
        name: "",
        now: Date.now(),
      });
      const home = windowA.openTab("New Tab", "about:home");
      observerA = await SvalTabs.attach(windowA, {
        engine: a,
        workspaceId: untouched,
        adapter: fakeAdapter,
        pollMs: 0,
        syncDocument: document,
      });
      await within(observerA.settled(), 10_000, "observerA settling");
      const homeId = fakeAdapter.nodeId(home);
      Assert.equal(
        (await nodes(a))[homeId]?.placement.parent,
        untouched,
        "A's window filed its home tab under W"
      );
      await a.sync(document);
      await b.sync(document);
      Assert.ok(untouched in (await nodes(b)), "B has W");

      // B shows W, restoring its home tab, and browses there. It never syncs:
      // its flush has no pass behind it.
      const restored = new FakeTab("New Tab", "about:home");
      restored.values.set(SvalTabs.NODE_ID_KEY, homeId);
      windowB.tabs.push(restored);
      observerB = await SvalTabs.attach(windowB, {
        engine: b,
        workspaceId: untouched,
        adapter: fakeAdapter,
        pollMs: 0,
        syncDocument: document,
        onFlush: () => {},
      });
      await within(observerB.settled(), 10_000, "observerB settling");
      windowB.navigate(restored, "https://example.com/");
      const opened = windowB.openTab("Example", "https://example.org/");
      await within(observerB.settled(), 10_000, "observerB settling");
      const openedId = fakeAdapter.nodeId(opened);
      Assert.equal(
        (await nodes(b))[openedId]?.placement.parent,
        untouched,
        "B's new tab is in W"
      );

      // A closes its W window. W looks untouched from A, so the close deletes it.
      await observerA.detach({ dropUntouched: true });
      observerA = null;
      Assert.ok(
        !(untouched in (await nodes(a))),
        "A's close deleted the workspace it saw as untouched"
      );

      // B comes back online.
      await b.sync(document);
      await a.sync(document);

      for (const [device, engine] of [
        ["B", b],
        ["A", a],
      ]) {
        const tree = await nodes(engine);
        Assert.equal(
          tree[untouched]?.kind,
          "workspace",
          `W is still a workspace on ${device}`
        );
        Assert.equal(
          tree[openedId]?.placement.parent,
          untouched,
          `the tab B opened is still in W on ${device}`
        );
        Assert.equal(
          tree[homeId]?.placement.parent,
          untouched,
          `the tab B browsed in is still in W on ${device}`
        );
        Assert.equal(
          tree[homeId]?.content.url,
          "https://example.com/",
          `and still shows where B took it on ${device}`
        );
      }
    } finally {
      await observerA?.detach();
      await observerB?.detach();
      await a.terminate();
      await b.terminate();
    }
  }
);

/**
 * A window closed straight after a page loads in its new workspace keeps
 * that workspace when another window's flush took the page's address and
 * is still writing it as the close judges the workspace.
 */
add_task(
  async function a_close_waits_for_its_commit_written_by_another_window() {
    const { engine, window, observer } = await harness({});
    const untouched = await engine.mutate({
      kind: "addWorkspace",
      name: "",
      now: Date.now(),
    });
    const closing = new FakeWindow();
    const home = closing.openTab("New Tab", "about:home");
    const closingObserver = await SvalTabs.attach(closing, {
      engine,
      workspaceId: untouched,
      adapter: fakeAdapter,
      pollMs: 0,
    });
    await within(closingObserver.settled(), 10_000, "closingObserver settling");
    const homeId = fakeAdapter.nodeId(home);

    // Both windows have a commit waiting on their debounce.
    const tab = window.openTab("Example", "https://example.com/");
    await within(observer.settled(), 10_000, "observer settling");
    window.navigate(tab, "https://example.org/");
    closing.navigate(home, "https://example.com/browsed");

    // The other window's flush takes every commit waiting and starts
    // writing, and the window closes before that write lands.
    const read = Promise.withResolvers();
    const tree = engine.tree.bind(engine);
    engine.tree = (...args) => {
      read.resolve();
      return tree(...args);
    };
    const otherFlush = within(
      observer.settled(),
      10_000,
      "the other observer settling"
    );
    await read.promise;
    delete engine.tree;
    await closingObserver.detach({ dropUntouched: true });
    await otherFlush;

    const after = await nodes(engine);
    Assert.equal(
      after[untouched]?.kind,
      "workspace",
      "the browsed workspace was kept"
    );
    Assert.equal(
      after[homeId]?.content?.url,
      "https://example.com/browsed",
      "with its tab where it was browsed"
    );
  }
);

/**
 * A rename that touches a workspace leaves its look alone: a recolour made
 * elsewhere still wins on merit.
 */
add_task(async function a_rename_that_touches_a_workspace_leaves_its_look() {
  const { engine, window, observer, workspace } = await harness({
    syncDocument: "sval-rename-touches",
    onFlush: undefined,
  });
  await engine.mutate({
    kind: "rename",
    id: workspace,
    name: "",
    now: Date.now(),
  });
  window.openTab("New Tab", "about:home");
  await within(observer.settled(), 10_000, "observer settling");
  const before = (await nodes(engine))[workspace];

  await engine.mutate({
    kind: "rename",
    id: workspace,
    name: "Named",
    now: before.content_at + 1,
  });
  window.retitle(window.tabs[0], "Home");
  await within(observer.settled(), 10_000, "observer settling");

  Assert.equal(
    (await nodes(engine))[workspace].appearance_at,
    before.appearance_at,
    "the workspace's look is not rewritten"
  );
});

/**
 * A tab opened into an untouched workspace is an edit to the workspace too,
 * stamped by the pass that publishes the tab.
 */
add_task(async function a_tab_that_touches_a_workspace_stamps_it() {
  const { engine, window, observer, workspace } = await harness({
    syncDocument: "sval-tab-touches",
    onFlush: undefined,
  });
  await engine.mutate({
    kind: "rename",
    id: workspace,
    name: "",
    now: Date.now(),
  });
  window.openTab("New Tab", "about:home");
  await within(observer.settled(), 10_000, "observer settling");
  const before = (await nodes(engine))[workspace];

  window.openTab("Example", "https://example.com/");
  await within(observer.settled(), 10_000, "observer settling");

  const after = (await nodes(engine))[workspace];
  Assert.equal(before.touched_at, undefined, "it was never touched before");
  Assert.greater(after.touched_at, 0, "the workspace is touched");
  Assert.ok(after.touched_by, "by this device");
  const groups = { ...after };
  delete groups.touched_at;
  delete groups.touched_by;
  Assert.deepEqual(groups, before, "and no fact group moved");
});

/**
 * The touch costs no edit made elsewhere. Device A colours W
 * and gives it an emoji while device B, offline, browses in it. When the two
 * sync, W keeps A's colour and emoji, and carries B's touch.
 */
add_task(async function a_touch_keeps_a_look_set_on_another_device() {
  const root = await makeTempDir("sval-touch-keeps-look");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const document = "sval-touch-keeps-look";
  const a = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const b = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const windowB = new FakeWindow();
  let observerB = null;

  try {
    await a.mutate({ kind: "addWorkspace", name: "Work", now: Date.now() });
    const w = await a.mutate({
      kind: "addWorkspace",
      name: "",
      now: Date.now(),
    });
    await a.sync(document);
    await b.sync(document);

    observerB = await SvalTabs.attach(windowB, {
      engine: b,
      workspaceId: w,
      adapter: fakeAdapter,
      pollMs: 0,
      syncDocument: document,
      onFlush: () => {},
    });
    windowB.openTab("Example", "https://example.org/");
    await within(observerB.settled(), 10_000, "observerB settling");

    await a.mutate({
      kind: "setAppearance",
      id: w,
      color: "blue",
      emoji: "🌊",
      now: Date.now(),
    });
    await a.sync(document);
    await b.sync(document);
    await a.sync(document);

    for (const [device, engine] of [
      ["B", b],
      ["A", a],
    ]) {
      const node = (await nodes(engine))[w];
      Assert.deepEqual(
        node.appearance,
        { color: "blue", emoji: "🌊" },
        `A's colour and emoji survive on ${device}`
      );
      Assert.greater(node.touched_at, 0, `and W is touched on ${device}`);
    }
  } finally {
    await observerB?.detach();
    await a.terminate();
    await b.terminate();
  }
});

/**
 * A jar pass handed the tree a window drew prunes with the latest tree read
 * as it runs: a workspace isolated since the window drew has a jar the prune
 * must keep, with its data (isolated workspaces spec §4). Whoever writes
 * reads the write back (`SvalTreeSnapshot`), and so does this test.
 */
add_task(async function a_jar_pass_prunes_with_the_latest_tree_read() {
  const pruned = [];
  const { engine, observer } = await harness({
    adapter: { ...fakeAdapter, pruneJars: tree => pruned.push(tree) },
  });
  const drawn = (await engine.tree()).nodes;
  const isolated = await engine.mutate({
    kind: "addWorkspace",
    name: "Isolated later",
    isolated: true,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await engine.tree();
  await within(
    observer.keepTabsInJar({ nodes: drawn }),
    10_000,
    "the jar pass"
  );
  Assert.ok(!drawn[isolated], "the drawn tree predates the workspace");
  Assert.ok(
    pruned.at(-1)?.[isolated],
    "the pass handed the drawn tree pruned with the workspace in it"
  );
});
