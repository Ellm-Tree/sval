/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_private_helpers.js */

/**
 * A private session writes nothing anywhere (private-windows spec), alone,
 * beside a window that syncs to a shared folder, and through the shutdown
 * publish.
 *
 * Each task proves it by reading what is on disk. The session is driven
 * with marker strings in its URLs, titles, group names and emoji. Afterwards
 * every file in the profile and in the shared folder is searched for every
 * marker, session files decompressed, and Sval's own files must be
 * byte-identical to before. `browser_sval_private_window.js` covers what a
 * private window shows and who can reach it; `sval_private_helpers.js` holds
 * what both use.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_private_helpers.js",
  this
);

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);

add_setup(privateSetup);

/**
 * Every document the profile's engine holds, as its plaintext export. The
 * engine's files are sealed under hashed names, so these say which document
 * a changed file holds.
 *
 * @returns {Promise<Map<string, object>>}
 */
async function engineExports() {
  const engine = SvalEngine.sharedInstance;
  const out = new Map([["tree", JSON.parse(await engine.exportJson())]]);
  for (const name of engine.extraDocumentNames()) {
    out.set(name, JSON.parse(await engine.exportJson(name)));
  }
  return out;
}

/**
 * What differs between two {@link engineExports}, as names and counts: per
 * document, each changed top-level field, and for `nodes` how many were
 * added, removed and changed and which node fields changed. A value, and a
 * node's id, can carry what the session browsed, so none is reported.
 *
 * @param {Map<string, object>} before
 * @param {Map<string, object>} after
 * @returns {object}
 */
function exportChanges(before, after) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const changes = {};
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(name) ?? {};
    const is = after.get(name) ?? {};
    const fields = {};
    for (const key of new Set([...Object.keys(was), ...Object.keys(is)])) {
      if (same(was[key], is[key])) {
        continue;
      }
      if (key != "nodes") {
        fields[key] = "changed";
        continue;
      }
      const nodes = { added: 0, removed: 0, changed: 0, fields: new Set() };
      const a = was.nodes ?? {};
      const b = is.nodes ?? {};
      for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!(id in a)) {
          nodes.added++;
        } else if (!(id in b)) {
          nodes.removed++;
        } else if (!same(a[id], b[id])) {
          nodes.changed++;
          for (const field of new Set([
            ...Object.keys(a[id]),
            ...Object.keys(b[id]),
          ])) {
            if (!same(a[id][field], b[id][field])) {
              nodes.fields.add(field);
            }
          }
        }
      }
      fields.nodes = { ...nodes, fields: [...nodes.fields].sort() };
    }
    if (Object.keys(fields).length) {
      changes[name] = fields;
    }
  }
  return changes;
}

/**
 * A whole private session leaves Sval's files and the shared folder exactly as
 * they were, and no marker anywhere in the profile or the folder.
 */
add_task(async function a_private_session_writes_nothing() {
  await flushEverything();
  const before = await snapshot(svalPaths());
  const exportsBefore = await engineExports();
  const win = await openPrivate();
  let marks;
  try {
    marks = await drivePrivateSession(win);
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
  await TestUtils.waitForCondition(
    () => !SvalPrivateSession.isLive,
    "closing the last private window ended the session"
  );
  await flushEverything();

  const after = await snapshot(svalPaths());
  const exportsAfter = await engineExports();
  Assert.deepEqual(
    [...after.entries()].sort(),
    [...before.entries()].sort(),
    "sval's own files are byte-identical"
  );
  Assert.deepEqual(
    exportChanges(exportsBefore, exportsAfter),
    {},
    "and so are the engine's documents"
  );
  Assert.deepEqual(
    await findMarkers([PathUtils.profileDir], marks),
    [],
    "and no file in the profile holds anything from the private session"
  );
  await assertProfileTreeClean(marks);
});

/**
 * Two private windows: each has its own workspace in the one private tree,
 * closing one drops only its workspace, and closing both ends the session.
 */
add_task(async function two_private_windows() {
  const first = await openPrivate();
  const second = await openPrivate();
  const mark = marker();
  try {
    const firstWs = SvalWindowWorkspace.of(first).id;
    const secondWs = SvalWindowWorkspace.of(second).id;
    Assert.notEqual(firstWs, secondWs, "each window has its own workspace");
    Assert.equal(
      first.SvalPanel.engine,
      second.SvalPanel.engine,
      "in one private tree"
    );

    const closedTab = await openMarked(first, mark);
    const { id } = await openMarked(second, mark);
    await within(
      BrowserTestUtils.closeWindow(first),
      10_000,
      "the first window closing"
    );
    // The closing window gives its workspace back from its `unload`, a
    // round trip to the private worker after the window has gone.
    let nodes = null;
    await TestUtils.waitForCondition(async () => {
      nodes = await privateTree(second);
      return !nodes[firstWs];
    }, "the closed window's workspace is gone");
    Assert.ok(!nodes[closedTab.id], "and so is its tab");
    Assert.ok(nodes[secondWs] && nodes[id], "the other window keeps its own");
    Assert.ok(SvalPrivateSession.isLive, "and the session goes on");
  } finally {
    if (!first.closed) {
      await within(
        BrowserTestUtils.closeWindow(first),
        10_000,
        "the first window closing"
      );
    }
    await within(
      BrowserTestUtils.closeWindow(second),
      10_000,
      "the second window closing"
    );
  }
  await TestUtils.waitForCondition(
    () => !SvalPrivateSession.isLive,
    "closing both ended the session"
  );
  await flushEverything();
  Assert.deepEqual(await findMarkers([PathUtils.profileDir], [mark]), []);
});

/**
 * A private window's session makes no container: `containers.json` never
 * learns that one existed.
 */
add_task(async function a_private_session_makes_no_container() {
  const { ContextualIdentityService } = ChromeUtils.importESModule(
    "resource://gre/modules/ContextualIdentityService.sys.mjs"
  );
  const path = PathUtils.join(PathUtils.profileDir, "containers.json");
  const read = async () =>
    (await IOUtils.exists(path)) ? sha256(await IOUtils.read(path)) : null;
  const before = await read();
  const win = await openPrivate();
  const jar = win.gBrowser.defaultUserContextId;
  try {
    await openMarked(win, marker());
    Assert.ok(
      !ContextualIdentityService.getPrivateIdentityFromId(jar),
      "the window's jar has no identity"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the private window closing"
    );
  }
  Assert.equal(await read(), before, "containers.json is as it was");
});

/**
 * No private tab carries Sval's node id in the session store, and no private
 * window records which workspace it shows there.
 */
add_task(async function nothing_private_is_tagged_in_the_session_store() {
  const win = await openPrivate();
  try {
    await drivePrivateSession(win);
    for (const tab of win.gBrowser.tabs) {
      Assert.equal(
        SessionStore.getCustomTabValue(tab, SvalTabs.NODE_ID_KEY),
        "",
        "a private tab carries no node id"
      );
    }
    const { CURRENT_WORKSPACE_KEY } = ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
    );
    Assert.equal(
      SessionStore.getCustomWindowValue(win, CURRENT_WORKSPACE_KEY),
      "",
      "and the window records no workspace"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

/**
 * A private session writes nothing with a normal window open, syncing to a
 * shared folder, and busy with its own tabs throughout. The profile's tree
 * is checked after every private step.
 */
add_task(async function a_private_session_beside_a_syncing_window() {
  // Only a device holding a sync key publishes to a shared folder.
  await svalKeys();
  const engine = SvalPanel.engine;
  const shared = await makeTempDir("sval-private-shared");
  const previous = engine.sharedRoot;
  engine.setSharedRoot(shared);
  Assert.ok((await engine.markSharedRoot()).reachable, "the folder is chosen");
  const normal = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"),
    15_000,
    "the normal tab opening and loading"
  );
  const win = await openPrivate();
  let marks;
  const seen = new Set();
  try {
    await SvalPanel.syncNow();
    marks = await drivePrivateSession(win, async (sofar, ids) => {
      ids.forEach(id => seen.add(id));
      // Activity in the normal window between private steps, then a pass
      // that publishes it.
      BrowserTestUtils.startLoadingURIString(
        normal.linkedBrowser,
        `about:blank#${seen.size}`
      );
      await SvalPanel.syncNow();
      await assertProfileTreeClean(sofar, ids);
    });
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
    BrowserTestUtils.removeTab(normal);
  }
  await TestUtils.waitForCondition(() => !SvalPrivateSession.isLive);
  try {
    // The passes above start the shared step in the background and do not
    // wait for it, and a step's helper can take seconds on a loaded machine.
    // This waits out any step still running and runs one of its own. One
    // helper runs at a time, and what the panel does after a step uses it
    // too, so a step that met it busy is asked again until the folder
    // answers.
    await TestUtils.waitForCondition(
      async () => (await SvalPanel.syncWithFolder()) === "reached",
      "a pass after the private session reaches the shared folder"
    );
    await flushEverything();
    Assert.greater(
      (await filesUnder(shared)).length,
      0,
      "the normal window did publish into the shared folder"
    );
    Assert.deepEqual(
      await findMarkers([PathUtils.profileDir, shared], [...marks, ...seen]),
      [],
      "and nothing from the private window reached the profile or the folder"
    );
    await assertProfileTreeClean(marks, [...seen]);
  } finally {
    engine.setSharedRoot(previous);
    await IOUtils.remove(shared, { recursive: true, ignoreAbsent: true });
  }
});

/**
 * What quitting runs: the session save and the profile engine's shutdown
 * publish, with a private window still open. Neither carries anything of it.
 */
add_task(async function the_shutdown_publish_carries_nothing_private() {
  const win = await openPrivate();
  let marks;
  try {
    marks = await drivePrivateSession(win);
    await SvalPanel.engine.publishBeforeShutdown();
    await SessionSaver.run();
    Assert.deepEqual(
      await findMarkers([PathUtils.profileDir], marks),
      [],
      "nothing private reached the disk with the private window still open"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});
