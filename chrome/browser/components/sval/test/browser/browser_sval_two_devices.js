/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The claim Sval exists to make: two devices pointed at one folder converge.
 *
 * `docs/acceptance-two-devices.md` walks the same ground with two real
 * browsers, the only way to see that the other window updates and looks
 * right. This file is the part that can run unattended: device A is this
 * window's own panel, sharing a temporary folder it chose, and device B an
 * engine with a device id of its own that keeps that folder as its own
 * location, so A's tabs arrive through Firefox's own `TabOpen`/`TabClose`
 * events and the window's own observer, and the chain under test starts at a
 * real tab strip and ends at a peer's rows.
 *
 * Two devices in one profile share one key and one login store, which the
 * manual procedure has to arrange by hand (spec §6.6).
 */

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const SvalTree = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

const { SYNC_DOCUMENT } = SvalTree;

/* import-globals-from ../../sval-panel.js */

/**
 * Device A, this window's panel, sharing a folder of the task's, and device
 * B, which keeps that folder as its own location under the sync key, so what
 * it holds is what the folder holds.
 *
 * The shared key is what makes them peers: `syncPrefix` hashes it into the
 * directory name, so two devices holding different keys enumerate different
 * directories and never see each other's files even in one folder.
 *
 * @param {string} label Distinguishes this task's temporary paths.
 * @returns {Promise<object>} `{ root, a, b, workspace, publishA }`: the
 *   shared folder, A's engine, B's, the workspace A's window shows, and a
 *   function that runs A's pass through the folder.
 */
async function twoDevices(label) {
  const device = await panelOnAFolder(label, { shared: true });
  const root = SvalPanel.sharedRootSetting();
  const keys = await svalKeys();
  const b = new SvalEngine({
    root,
    keyBytes: keys.syncKey,
    deviceId: randomBytes(16),
  });
  atTaskEnd(() => stopEngine(b));
  const publishA = async () => {
    await within(SvalPanel.observer.settled(), 10_000, "A's observer");
    await TestUtils.waitForCondition(
      async () => (await SvalPanel.syncWithFolder()) === "reached",
      "A's pass reached the folder"
    );
  };
  return { root, a: device.engine, b, workspace: device.workspace, publishA };
}

/**
 * The directory an engine-relative path names, under the storage folder.
 *
 * Every path in a sync report is engine-relative and `/`-separated: it names
 * a position in `sval-core`'s own layout.
 *
 * @param {string} rootPath The storage folder.
 * @param {string} relative An engine-relative path.
 * @returns {string} the absolute directory holding that file.
 */
function directoryOf(rootPath, relative) {
  return PathUtils.parent(PathUtils.join(rootPath, ...relative.split("/")));
}

/**
 * The rows a panel would draw for `engine`'s workspace `root`, with nothing
 * collapsed.
 *
 * Asserted wherever the question is what the user would see: `rows` is what
 * the panel renders from, so an ordering only the raw `nodes` map agrees on
 * is not convergence.
 *
 * @param {object} engine A `SvalEngine`.
 * @param {string} root The workspace being shown.
 * @returns {Promise<object[]>} rows in draw order.
 */
async function rowsOf(engine, root) {
  return SvalPanelModel.rows(await nodes(engine), {
    isCollapsed: () => false,
    root,
  });
}

/**
 * A workspace with two real tabs made on A appears on B, and B invents
 * nothing of its own to hold them.
 *
 * The two tabs are opened in this window and reach the document only through
 * Firefox's own `TabOpen` event and the window's observer, so what is
 * asserted on B travelled the whole chain: tab strip, session-store tag,
 * engine, encrypted file, merge.
 */
add_task(
  async function a_workspace_with_two_tabs_arrives_on_the_other_device() {
    const { root, a, b, workspace, publishA } = await twoDevices("two-tabs");

    const opened = [];
    for (const url of ["https://example.com/one", "https://example.org/two"]) {
      opened.push(
        await within(
          BrowserTestUtils.openNewForegroundTab(gBrowser, url),
          10_000,
          `the load of ${url}`
        )
      );
    }
    await TestUtils.waitForCondition(async () => {
      const tree = await nodes(a);
      return opened.every(tab => taggedId(tab) && taggedId(tab) in tree);
    }, "both real tabs reached device A's document");
    await publishA();

    const report = await b.sync(SYNC_DOCUMENT, Date.now());
    Assert.deepEqual(report.errors, [], "B decrypted and parsed A's file");
    Assert.deepEqual(report.unreadable, [], "B could read every file");
    Assert.equal(report.merged, 1, "B merged A's one file");

    const ids = opened.map(taggedId);
    const onA = await nodes(a);
    const onB = await nodes(b);
    Assert.ok(workspace in onB, "the workspace A's window shows is on B");
    Assert.equal(
      onB[workspace].content.name,
      onA[workspace].content.name,
      "under the name A gave it"
    );
    for (const [index, id] of ids.entries()) {
      Assert.ok(id in onB, `tab ${index + 1} is on B`);
      Assert.equal(onB[id].kind, "tab", `and arrived as a tab`);
      Assert.equal(
        onB[id].placement.parent,
        workspace,
        `filed under the same workspace`
      );
    }
    Assert.deepEqual(
      Object.keys(onB).sort(),
      Object.keys(onA).sort(),
      "B holds exactly A's nodes and minted none of its own"
    );

    // One key means one hashed directory for the document; two keys would
    // leave two directories holding one file each. The pass above is the one
    // that wrote: it had A's nodes to incorporate, and a changed document is
    // what makes a device publish (spec §6.5).
    Assert.notEqual(report.wrote, null, "B published its own file");
    const children = await IOUtils.getChildren(directoryOf(root, report.wrote));
    Assert.equal(
      children.length,
      2,
      `one file per device in one directory: ${children.join(", ")}`
    );
  }
);

/**
 * Closing deletes the node, with no closed state and no tombstone
 * (spec §5.4), so the document holds no undo for it.
 */
add_task(async function a_real_tab_closed_on_a_lands_as_a_deletion_on_b() {
  const { a, b, workspace, publishA } = await twoDevices("closing");

  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "https://example.com/closing"
    ),
    10_000,
    "the tab's load"
  );
  const id = taggedId(tab);
  Assert.ok(id, "the real tab was tagged");
  await TestUtils.waitForCondition(
    async () => id in (await nodes(a)),
    "the tab reached A's document"
  );
  await publishA();
  await b.sync(SYNC_DOCUMENT, Date.now());
  Assert.ok(id in (await nodes(b)), "and reached B");

  BrowserTestUtils.removeTab(tab);
  await TestUtils.waitForCondition(
    async () => !(id in (await nodes(a))),
    "closing the real tab deleted the node on A"
  );
  await publishA();
  await b.sync(SYNC_DOCUMENT, Date.now());

  Assert.ok(
    !(id in (await nodes(b))),
    "the close reached B, which had the node a moment before"
  );
  Assert.ok(
    !(await rowsOf(b, workspace)).some(row => row.id === id),
    "so B's panel would no longer draw a row for it"
  );
});

/**
 * A workspace's children are one list ordered by fractional index and nothing
 * sorts by kind, so the order key alone decides this, and it has to survive
 * the trip through the folder. `browser_sval_panel.js` covers the
 * single-device DOM; this adds that the peer draws the same list in the same
 * order.
 */
add_task(async function a_loose_tab_and_a_group_arrive_in_one_ordered_list() {
  const { a, b, publishA } = await twoDevices("ordered");
  const workspace = await a.mutate({
    kind: "addWorkspace",
    name: "Mixed",
    id: crypto.randomUUID(),
    now: Date.now(),
  });

  // Group, loose tab, group: a list that any sort by kind would reorder, and
  // one a fixture with tabs only under groups could not tell apart.
  const first = await a.mutate({
    kind: "addGroup",
    parent: workspace,
    name: "Reading",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const loose = await a.mutate({
    kind: "addTab",
    parent: workspace,
    name: "Loose",
    url: "https://example.com/loose",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const second = await a.mutate({
    kind: "addGroup",
    parent: workspace,
    name: "Shipping",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const nested = await a.mutate({
    kind: "addTab",
    parent: first,
    name: "Nested",
    url: "https://example.com/nested",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await publishA();
  await b.sync(SYNC_DOCUMENT, Date.now());

  const expected = [
    { id: first, depth: 0 },
    { id: nested, depth: 1 },
    { id: loose, depth: 0 },
    { id: second, depth: 0 },
  ];
  for (const [label, engine] of [
    ["A", a],
    ["B", b],
  ]) {
    const drawn = (await rowsOf(engine, workspace)).map(row => ({
      id: row.id,
      depth: row.depth,
    }));
    Assert.deepEqual(
      drawn,
      expected,
      `${label} draws the loose tab between the two groups, at group level`
    );
  }

  const onB = await nodes(b);
  Assert.equal(onB[loose].kind, "tab", "the loose row really is a tab");
  Assert.equal(
    onB[second].kind,
    "group",
    "and the row after it really is a group"
  );
  Assert.equal(
    onB[loose].placement.parent,
    onB[second].placement.parent,
    "both are children of the workspace itself, with no group invented"
  );
});

/** Spec §6 test 10. */
add_task(async function choosing_where_to_sync_loses_no_workspace() {
  const device = await panelOnAFolder("choose");
  const { engine, settings } = device;
  const empty = await device.folder("choose-empty");
  const occupied = await device.folder("choose-occupied");
  const keys = await svalKeys();
  const idsBefore = Object.keys(await nodes(engine)).sort();

  Assert.ok(
    (await SvalPanel.chooseSharedFolder(empty)).reached,
    "an empty folder is published to"
  );
  Assert.equal(engine.sharedRoot, empty);
  Assert.deepEqual(Object.keys(await nodes(engine)).sort(), idsBefore);
  Assert.ok(
    (await IOUtils.getChildren(PathUtils.join(empty, "sval"))).length,
    "and received this device's document"
  );

  // A device that keeps the folder as its own location, so what it holds is
  // what the folder holds under the sync key.
  const peer = new SvalEngine({
    root: occupied,
    keyBytes: keys.syncKey,
    deviceId: randomBytes(16),
  });
  atTaskEnd(() => stopEngine(peer));
  const theirs = await peer.mutate({
    kind: "addWorkspace",
    name: "Waiting in the folder",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await peer.sync(SYNC_DOCUMENT, Date.now());

  const filesIn = async dir => {
    const found = [];
    for (const child of await IOUtils.getChildren(dir)) {
      const { type } = await IOUtils.stat(child);
      found.push(...(type === "directory" ? await filesIn(child) : [child]));
    }
    return found;
  };
  const leftBehind = await filesIn(PathUtils.join(empty, "sval"));

  Assert.ok((await SvalPanel.chooseSharedFolder(occupied)).reached);
  Assert.deepEqual(
    await filesIn(PathUtils.join(empty, "sval")),
    leftBehind,
    "this device's file is still in the folder it left"
  );
  Assert.ok(leftBehind.length, "and there was one to leave");
  const merged = Object.keys(await nodes(engine));
  for (const id of idsBefore) {
    Assert.ok(
      merged.includes(id),
      `${id} survived choosing an occupied folder`
    );
  }
  Assert.ok(merged.includes(theirs), "and the folder's own workspace arrived");
  await peer.sync(SYNC_DOCUMENT, Date.now());
  Assert.deepEqual(
    Object.keys(await nodes(peer)).sort(),
    merged.sort(),
    "and the folder's device holds every one of them"
  );

  const publishedInOccupied = await filesIn(PathUtils.join(occupied, "sval"));
  Assert.ok((await SvalPanel.chooseSharedFolder(null)).reached, "stop syncing");
  Assert.deepEqual(
    await filesIn(PathUtils.join(occupied, "sval")),
    publishedInOccupied,
    "this device's file stays in the folder it stopped using"
  );
  Assert.equal(engine.sharedRoot, null, "the engine shares nowhere");
  Assert.equal(settings.sharedFolder, null, "the setting is back to none");
  Assert.deepEqual(
    Object.keys(await nodes(engine)).sort(),
    merged.sort(),
    "and every workspace is kept"
  );
});
