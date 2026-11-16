/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_private_helpers.js */

/**
 * What a private window holds its tabs in (private-windows spec): a tree
 * and settings in memory that answer what the panel and `SvalTabs` ask and
 * nothing that could sync or write, a tree that orders as the profile's
 * engine does, `SvalTabs` refusing to mix a private window with the profile's
 * document, and a session that starts empty after the last window closes.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_private_helpers.js",
  this
);

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { BasePromiseWorker } = ChromeUtils.importESModule(
  "resource://gre/modules/PromiseWorker.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

add_setup(privateSetup);

/**
 * @param {Window} win
 */
async function closeIt(win) {
  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "a private window closing"
  );
}

/**
 * The private tree answers only the part of `SvalEngine`'s surface that keeps
 * a window's tabs in memory; every other engine method, sync, storage and key
 * included, is absent, so a caller reaching for one fails at once. A change
 * to any document but the window's tabs is refused.
 */
add_task(async function the_private_tree_cannot_sync() {
  const win = await openPrivate();
  try {
    const tree = win.SvalPanel.engine;
    Assert.equal(tree.isPrivate, true, "the window runs on the private tree");
    const shared = new Set([
      "constructor",
      "tree",
      "mutate",
      "publishPending",
      "finishBeforeShutdown",
      // The worker plumbing both inherit, which reaches only their own worker.
      ...Object.getOwnPropertyNames(BasePromiseWorker.prototype),
    ]);
    for (const name of Object.getOwnPropertyNames(SvalEngine.prototype)) {
      if (!shared.has(name)) {
        Assert.ok(!(name in tree), `the private tree has no ${name}`);
      }
    }
    for (const kind of ["addAgentWorkspace", "setSetting"]) {
      await Assert.rejects(
        tree.mutate({ kind, key: "k", name: "n", agentLabel: "a" }),
        err => err.code === "not_in_private",
        `${kind} is refused`
      );
    }
    await Assert.rejects(
      tree.mutate({ kind: "addGroup", document: "settings", name: "x" }),
      err => err.code === "not_in_private",
      "and so is any other document"
    );
    await Assert.rejects(
      tree.mutate({
        kind: "batch",
        ops: [{ kind: "setSetting", key: "k", valueJson: "1" }],
      }),
      err => err.code === "not_in_private",
      "and so is a batch holding one"
    );
  } finally {
    await closeIt(win);
  }
});

/**
 * A batch refused part-way leaves the private tree as it was, as it does the
 * profile's: a group made in a private window is made whole or not at all.
 */
add_task(async function a_refused_private_batch_changes_nothing() {
  const win = await openPrivate();
  try {
    const tree = win.SvalPanel.engine;
    const group = crypto.randomUUID();
    await Assert.rejects(
      tree.mutate({
        kind: "batch",
        ops: [
          {
            kind: "addGroup",
            parent: win.SvalPanel.workspaceId,
            name: "g",
            id: group,
          },
          { kind: "remove", id: crypto.randomUUID() },
        ],
      }),
      err => err.code === "no_such_node",
      "the batch is refused at the node it cannot find"
    );
    Assert.ok(
      !(group in (await privateTree(win))),
      "and the group it began with is not in the private tree"
    );
  } finally {
    await closeIt(win);
  }
});

/**
 * Applies `ops` to a document through `mutate`.
 *
 * @param {object} target A `SvalEngine` or a private tree.
 * @param {object[]} ops
 */
async function applyAll(target, ops) {
  for (const op of ops) {
    await target.mutate(op);
  }
}

/**
 * The same changes give the same tree in a profile's engine and in a private
 * window's: one implementation, `SvalDocumentOps`, behind both. The changes
 * go into a workspace no window shows, so no window's tabs take part.
 */
add_task(async function the_private_tree_orders_as_the_engine_does() {
  const win = await openPrivate();
  const engine = new SvalEngine({
    root: await makeTempDir("sval-private-parity"),
    keyBytes: randomBytes(32),
    deviceId: randomBytes(16),
  });
  try {
    const tree = win.SvalPanel.engine;
    const workspaceId = await tree.mutate({
      kind: "addWorkspace",
      name: "Parity",
    });
    await engine.mutate({
      kind: "addWorkspace",
      name: "Parity",
      id: workspaceId,
      now: 1,
    });
    const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const ops = [
      { kind: "addTab", parent: workspaceId, name: "a", url: "u:a", id: id(1) },
      { kind: "addTab", parent: workspaceId, name: "b", url: "u:b", id: id(2) },
      { kind: "addGroup", parent: workspaceId, name: "g", id: id(3) },
      { kind: "addTab", parent: id(3), name: "c", url: "u:c", id: id(4) },
      { kind: "addGroup", parent: id(3), name: "h", id: id(5) },
      { kind: "addTab", parent: id(5), name: "d", url: "u:d", id: id(6) },
      {
        kind: "moveNode",
        id: id(2),
        newParent: id(3),
        before: null,
        after: id(4),
      },
      {
        kind: "moveNode",
        id: id(1),
        newParent: workspaceId,
        before: id(3),
        after: null,
      },
      {
        kind: "moveNode",
        id: id(5),
        newParent: workspaceId,
        before: null,
        after: null,
      },
      { kind: "rename", id: id(3), name: "renamed" },
      { kind: "setContent", id: id(4), name: "c2", url: "u:c2", icon: null },
      { kind: "setAppearance", id: id(3), color: "blue", emoji: "\u{1F984}" },
      { kind: "remove", id: id(6) },
    ].map((op, i) => ({ ...op, now: 10 + i }));
    await applyAll(engine, ops);
    await applyAll(tree, ops);

    const drawn = async target =>
      SvalPanelModel.rows((await target.tree()).nodes, {
        isCollapsed: () => false,
        root: workspaceId,
      }).map(({ id: rowId, kind, name, url, depth, color, emoji }) => ({
        rowId,
        kind,
        name,
        url,
        depth,
        color,
        emoji,
      }));
    const rows = await drawn(tree);
    Assert.equal(rows.length, 5, "the private tree draws every node left");
    Assert.deepEqual(rows, await drawn(engine), "exactly as the engine's");
  } finally {
    await stopEngine(engine);
    await closeIt(win);
  }
});

/**
 * A private window's settings answer every method `SvalLocalSettings` has,
 * so a panel path that reaches for one gets an answer from memory, and a
 * method added to one and not the other fails here. They have no file and
 * no storage, and first run is never owed from them.
 */
add_task(async function the_private_settings_have_every_settings_method() {
  const win = await openPrivate();
  try {
    const settings = win.SvalPanel.settings;
    const names = Object.getOwnPropertyNames(
      Object.getPrototypeOf(SvalPanel.settings)
    );
    const privateNames = new Set(
      Object.getOwnPropertyNames(Object.getPrototypeOf(settings))
    );
    for (const name of names) {
      Assert.ok(privateNames.has(name), `private settings have ${name}`);
    }

    Assert.equal(settings.path, null, "a private store has no file");
    Assert.equal(settings.sharedFolder, null, "and no storage");
    Assert.throws(() => (settings.sharedFolder = "/tmp"), /no storage/);
    Assert.strictEqual(settings.firstRunDone, true, "first run is never owed");
    Assert.strictEqual(
      settings.firstRunStarted,
      true,
      "nor read as one interrupted"
    );
    settings.markFirstRunStarted();
    settings.markFirstRunDone();
    Assert.strictEqual(
      settings.firstRunDone,
      true,
      "and marking changes nothing"
    );
    const id = crypto.randomUUID();
    settings.setCollapsed(id, false);
    Assert.equal(settings.isCollapsed(id), false, "collapse is kept");
    settings.setLastActive(id, 5);
    Assert.equal(settings.lastActive(id), 5, "and the last-active time");
    settings.setSelection(id, id);
    await settings.flush();
    Assert.equal(
      settings.selectionIn(id),
      id,
      "and flush keeps what is in memory"
    );
  } finally {
    await closeIt(win);
  }
});

/**
 * `SvalTabs` refuses a private window on the profile's engine, on a private
 * tree with nowhere of its own to keep ids or asked to sync, and a normal
 * window on a private tree.
 */
add_task(async function svalTabs_will_not_mix_private_and_saved() {
  const win = await openPrivate();
  try {
    const tree = win.SvalPanel.engine;
    const { nodeIds } = await SvalPrivateSession.forWindow(win);
    await Assert.rejects(
      SvalTabs.attach(win, {
        engine: SvalPanel.engine,
        workspaceId: SvalPanel.workspaceId,
        nodeIds,
        onFlush: () => {},
        pollMs: 0,
      }),
      err => err.code === "private_window_outside_private_session",
      "a private window on the profile's engine is refused"
    );
    await Assert.rejects(
      SvalTabs.attach(win, {
        engine: tree,
        workspaceId: win.SvalPanel.workspaceId,
        onFlush: () => {},
        pollMs: 0,
      }),
      err => err.code === "private_window_outside_private_session",
      "and so is one with nowhere of its own to keep ids"
    );
    await Assert.rejects(
      SvalTabs.attach(win, {
        engine: tree,
        workspaceId: win.SvalPanel.workspaceId,
        nodeIds,
        syncDocument: "workspaces",
        pollMs: 0,
      }),
      err => err.code === "private_window_outside_private_session",
      "and one asked to sync"
    );
    await Assert.rejects(
      SvalTabs.attach(window, {
        engine: tree,
        workspaceId: win.SvalPanel.workspaceId,
        nodeIds,
        onFlush: () => {},
        pollMs: 0,
      }),
      err => err.code === "normal_window_in_private_session",
      "a normal window on a private tree is refused"
    );
  } finally {
    await closeIt(win);
  }
});

/**
 * The last private window closing ends the session, and the next private
 * window starts on an empty tree: nothing of the closed window's workspace
 * or tabs is in it.
 */
add_task(async function the_next_session_starts_empty() {
  const first = await openPrivate();
  let second = null;
  try {
    const { id } = await openMarked(first, marker());
    const firstWorkspace = first.SvalPanel.workspaceId;
    await closeIt(first);
    await TestUtils.waitForCondition(
      () => !SvalPrivateSession.isLive,
      "closing the last private window ended the session"
    );

    second = await openPrivate();
    const nodes = await privateTree(second);
    Assert.ok(!(id in nodes), "the closed window's tab is not in the tree");
    Assert.ok(!(firstWorkspace in nodes), "nor its workspace");
    Assert.deepEqual(
      Object.keys(nodes).filter(
        node => nodes[node].kind === SvalPanelModel.WORKSPACE
      ),
      [second.SvalPanel.workspaceId],
      "the new window's workspace is the only one"
    );
  } finally {
    if (!first.closed) {
      await closeIt(first);
    }
    if (second) {
      await closeIt(second);
    }
  }
});

/**
 * A private window opening while the last other one closes joins a live
 * session, or starts a new one, and either way shows its own workspace.
 */
add_task(async function a_window_opening_as_the_last_one_closes() {
  const closing = await openPrivate();
  let joining = null;
  try {
    const opened = within(
      BrowserTestUtils.openNewBrowserWindow({ private: true }),
      20_000,
      "a private window's opening"
    );
    const closed = closeIt(closing);
    joining = await opened;
    await within(joining.SvalPanel.started, 10_000, "its panel's startup");
    await closed;
    Assert.ok(SvalPrivateSession.isLive, "a session is live");
    Assert.ok(SvalPrivateSession.has(joining), "and the new window runs on it");
    const { id } = await openMarked(joining, marker());
    const nodes = await privateTree(joining);
    Assert.ok(
      nodes[joining.SvalPanel.workspaceId],
      "its workspace is in the tree"
    );
    Assert.ok(nodes[id], "and so is the tab it files");
  } finally {
    if (!closing.closed) {
      await closeIt(closing);
    }
    if (joining) {
      await closeIt(joining);
    }
  }
});
