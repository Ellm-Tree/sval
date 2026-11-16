/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_panel_startup_helpers.js */

/**
 * Which workspace a launch shows, and what it creates, against the folders a
 * device keeps its document in (spec §6, local-copy spec §4): a first launch
 * and a second device, with the shared folder answering, away, holding another
 * device's work, or not chosen at all. Startup also clears an abandoned
 * pairing offer.
 *
 * Each task opens windows on a fresh profile over temporary folders, which
 * start as a launch's windows do. `browser_sval_startup_when_sync_fails.js`
 * covers a launch whose sync fails; the fixture they share is in
 * `sval_panel_startup_helpers.js`.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_startup_helpers.js",
  this
);

const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

const { SvalPairing } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPairing.sys.mjs"
);

add_setup(failOnConsoleErrors);

/**
 * The ids of the workspaces in `nodes`.
 *
 * @param {object} nodes A document's `nodes` map.
 * @returns {string[]}
 */
function workspacesIn(nodes) {
  return Object.entries(nodes)
    .filter(([, node]) => node.kind === "workspace")
    .map(([id]) => id);
}

/**
 * A device asked nothing at startup is one whose launch opened no dialog: a
 * name prompt or first run's would be a window-modal dialog in it.
 *
 * @param {Window} win
 */
function assertNothingAsked(win) {
  Assert.ok(!win.gDialogBox.isOpen, "the user was never asked anything");
}

/**
 * This holds because `_start` syncs *before* asking whether a workspace
 * exists, and because the directory it syncs is named by a constant. A device
 * that minted its own id for the directory would look where no peer ever
 * writes.
 */
add_task(async function a_second_device_adopts_the_workspace_in_the_folder() {
  let published = null;

  const profile = await freshProfile({
    async publish({ root, keys }) {
      // Another device: the same key and folder (the key is what the
      // directory name is hashed under), and a device id of its own, because
      // two devices sharing one id would share one file (spec §6.2).
      const other = new SvalEngine({
        root,
        ...keys,
        deviceId: crypto.getRandomValues(new Uint8Array(16)),
      });
      try {
        const workspace = await other.mutate({
          kind: "addWorkspace",
          name: "Shared",
        });
        await other.mutate({
          kind: "addTab",
          parent: workspace,
          name: "Already here",
          url: "https://example.com/already",
        });
        await other.sync(SvalPanelModel.SYNC_DOCUMENT);
        published = { workspace, nodes: (await other.tree()).nodes };
      } finally {
        await stopEngine(other);
      }
    },
  });
  const win = await profile.open();
  const panel = win.SvalPanel;

  Assert.equal(
    Object.keys(published.nodes).length,
    2,
    "the other device published a workspace and a tab"
  );
  assertNothingAsked(win);

  const nodes = (await panel.engine.tree()).nodes;
  for (const id of Object.keys(published.nodes)) {
    Assert.ok(id in nodes, `the published node ${id} is in the document`);
  }
  Assert.deepEqual(
    workspacesIn(nodes),
    [published.workspace],
    "there is exactly one workspace, and it is the one already in the folder"
  );
  Assert.equal(
    panel.workspaceId,
    published.workspace,
    "and the panel adopted it rather than minting its own"
  );
  Assert.equal(
    nodes[published.workspace].content.name,
    "Shared",
    "under the name the other device's user typed"
  );
});

/**
 * Nothing is asked: a launch cannot wait on an answer, since until a workspace
 * exists there is nowhere for a tab to go. The placeholder the panel draws is
 * a label in this window; the document holds the empty string.
 */
add_task(async function an_empty_folder_gets_a_nameless_workspace() {
  const profile = await freshProfile();
  const win = await profile.open();
  const panel = win.SvalPanel;

  assertNothingAsked(win);

  const nodes = (await panel.engine.tree()).nodes;
  const workspaces = workspacesIn(nodes);
  Assert.equal(workspaces.length, 1, "one workspace exists");
  const [id] = workspaces;
  Assert.strictEqual(
    nodes[id].content.name,
    "",
    "with no name in the document"
  );
  Assert.equal(
    panel.workspaceId,
    id,
    "and it is the workspace this window files under"
  );
  Assert.equal(
    panel._els.switcher.textContent,
    panel._untitled(SvalPanelModel.WORKSPACE),
    "and the switcher labels the nameless workspace, which is a label in " +
      "this window and not a value anywhere"
  );

  // Naming it is a rename: the id, and everything already filed under it,
  // survive being named.
  const before = Object.keys(nodes).sort();
  await answerNameDialog(
    win,
    panel.run("rename", { id }),
    ".sval-dialog-input",
    "R\u00e9unions"
  );

  const renamed = (await panel.engine.tree()).nodes;
  Assert.deepEqual(Object.keys(renamed).sort(), before, "the same nodes");
  Assert.equal(
    renamed[id].content.name,
    "R\u00e9unions",
    "named as the user typed"
  );
});

/**
 * The plaintext export is what is searched: the file on disk is AES-GCM
 * ciphertext, so grepping it for a name would find nothing whatever the
 * document said. The export is the same `Document` the engine seals
 * (`sync::export_json` is `Document::to_json`), so it is the bytes Sval
 * writes, before the layer that makes them unreadable.
 */
add_task(async function no_name_sval_invented_reaches_the_document() {
  const profile = await freshProfile();
  const win = await profile.open();
  const panel = win.SvalPanel;

  await answerNameDialog(
    win,
    panel.run("rename", { id: panel.workspaceId }),
    ".sval-dialog-input",
    "Réunions"
  );
  await answerNameDialog(
    win,
    panel.run("addGroup", null),
    ".sval-nw-name",
    "Lecture"
  );

  const exported = await panel.engine.exportJson();
  Assert.ok(exported.includes("Réunions"), "the workspace name the user typed");
  Assert.ok(exported.includes("Lecture"), "and the group name they typed");

  for (const invented of [
    "My workspace",
    "New Workspace",
    "New group",
    "Untitled",
    "Unsorted",
  ]) {
    Assert.ok(
      !exported.includes(invented),
      `"${invented}" is a string sval chose and must not be in the document`
    );
  }
});

/**
 * With no shared folder nothing is synced, so the footer has no sync
 * indicator (messages spec §3).
 */
add_task(async function no_shared_folder_shows_no_indicator() {
  const profile = await freshProfile();
  const { SvalPanel: panel } = await profile.open();
  Assert.equal(panel.folderState, "none", "no shared folder is chosen");
  Assert.strictEqual(panel.lastSynced, null, "nothing has been synced");
  Assert.ok(
    BrowserTestUtils.isHidden(panel._els.syncRow),
    "the footer shows no sync indicator"
  );
  Assert.ok(
    BrowserTestUtils.isVisible(panel._els.footer),
    "while the footer itself stays"
  );
});

/** Spec §6 test 9. */
add_task(async function no_local_copy_and_no_folder_creates_nothing() {
  const missing = tempPath("sval-missing");
  const profile = await freshProfile({ shared: missing });
  const { SvalPanel: panel } = await profile.open();
  Assert.strictEqual(
    panel.workspaceId,
    null,
    "a device with no copy of its own creates no workspace while the folder is away"
  );
  Assert.equal(
    Object.keys(panel.nodes).length,
    0,
    "and the document holds nothing it invented"
  );

  // The startup retry's first try fails too, and doubles the wait for the
  // next.
  await TestUtils.waitForCondition(
    () => panel._startRetryWaitMs === panel._startRetryMs * 4,
    "the window's own retry tried the folder again",
    100,
    150
  );
  Assert.strictEqual(
    panel.workspaceId,
    null,
    "and a retry while the folder is still away creates none either"
  );

  // The folder comes back as the chosen one, holding `sval/`.
  await IOUtils.makeDirectory(PathUtils.join(missing, "sval"));
  await TestUtils.waitForCondition(
    () => panel.workspaceId,
    "the window's own retry finds the folder",
    100,
    300
  );
  Assert.ok(
    panel.workspaceId,
    "once the folder answers, the device has a workspace"
  );
});

/**
 * A user who picked the profile folder explicitly has chosen no other folder:
 * startup has nothing to wait for and no helper has anything to do.
 */
add_task(
  async function choosing_the_local_folder_explicitly_waits_for_nothing() {
    const local = tempPath("sval-explicit");
    // Chosen with a trailing separator, a different spelling of the same
    // path.
    const profile = await freshProfile({
      shared: `${local}/`,
      localRoot: local,
    });
    const { SvalPanel: panel } = await profile.open();
    Assert.strictEqual(
      panel.sharedRootSetting(),
      null,
      "the profile folder, chosen explicitly, is no shared folder"
    );
    Assert.ok(
      panel.workspaceId,
      "an empty profile gets its unnamed workspace without waiting"
    );
    Assert.equal(panel.folderState, "none", "and no folder is tracked");
    Assert.strictEqual(
      panel.engine.sharedRoot,
      null,
      "and the engine shares nowhere, so no helper has a folder to reach"
    );
  }
);

/**
 * The first pass writes this device's file even for an empty document, so a
 * profile that holds a file says nothing about whether the folder holds a
 * workspace (local-copy spec §4.4).
 */
add_task(async function an_empty_own_file_does_not_license_a_workspace() {
  const missing = tempPath("sval-missing");
  const profile = await freshProfile({ shared: missing });
  const first = await profile.open();
  const report = await first.SvalPanel.engine.sync(
    SvalPanelModel.SYNC_DOCUMENT,
    Date.now(),
    { shared: "skip" }
  );
  Assert.ok(report.hadLocalCopy, "the profile now holds this device's file");

  const { SvalPanel: second } = await profile.open();
  Assert.strictEqual(
    second.workspaceId,
    null,
    "a second window with the folder still away creates no workspace"
  );
  Assert.equal(
    Object.keys(second.nodes).length,
    0,
    "and the document holds nothing it invented"
  );
});

add_task(async function a_relaunch_before_the_folder_answers_creates_nothing() {
  const missing = tempPath("sval-missing");
  const profile = await freshProfile({ shared: missing });
  const first = await profile.open();
  const engine = first.SvalPanel.engine;

  const { SvalPanel: panel } = await profile.relaunch();
  Assert.ok(
    panel.engine && panel.engine !== engine,
    "a new engine reads the same profile folder"
  );
  Assert.strictEqual(
    panel.workspaceId,
    null,
    "and the relaunch creates no workspace while the folder is away"
  );
  Assert.equal(
    Object.keys(panel.nodes).length,
    0,
    "the document holds nothing it invented"
  );
});

add_task(async function the_workspace_a_peer_published_is_the_only_one() {
  const missing = tempPath("sval-missing");
  const profile = await freshProfile({ shared: missing });
  const { SvalPanel: panel } = await profile.open();
  Assert.strictEqual(
    panel.workspaceId,
    null,
    "nothing is created while the folder is away"
  );

  const peer = new SvalEngine({
    root: missing,
    keyBytes: profile.keys.syncKey,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  let theirs;
  try {
    theirs = await peer.mutate({
      kind: "addWorkspace",
      name: "From the other device",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    await peer.sync(SvalPanelModel.SYNC_DOCUMENT, Date.now());
  } finally {
    await stopEngine(peer);
  }

  await TestUtils.waitForCondition(
    () => panel.workspaceId,
    "the window's own retry finds the folder",
    100,
    300
  );
  Assert.equal(
    panel.workspaceId,
    theirs,
    "once the folder answers, the peer's workspace is the one shown"
  );
  Assert.deepEqual(
    workspacesIn(panel.nodes),
    [theirs],
    "and no unnamed one exists beside it"
  );
});

/**
 * Spec §6.7 bounds an offer at an hour and says any device that sees a stale
 * one may remove it, because the device that made it may have been closed
 * before it could withdraw its own.
 *
 * A live offer is written beside the stale one: a sweep that removed both
 * would break pairing.
 */
add_task(async function startup_clears_an_abandoned_pairing_offer() {
  let stale;
  let live;
  const shared = tempPath("sval-offers");
  // A chosen folder, which holds `sval/`: the helper never creates a missing
  // shared folder, and an offer goes only into one that holds it.
  await IOUtils.makeDirectory(PathUtils.join(shared, "sval"));
  const profile = await freshProfile({
    shared,
    publish: async ({ keys: { syncKey } }) => {
      // Two hours back, past the one-hour TTL `offer` seals in. Only the
      // moment it was made is this test's.
      stale = (await SvalPairing.offer(shared, syncKey, Date.now() - 7200000))
        .path;
      live = (await SvalPairing.offer(shared, syncKey)).path;
    },
  });
  await profile.open();

  await TestUtils.waitForCondition(
    async () => !(await IOUtils.exists(stale)),
    "startup took the expired offer out of the shared folder"
  );
  Assert.ok(
    await IOUtils.exists(live),
    "and left the live one, which is what someone is about to type a code for"
  );
});
