/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

const { childrenByParent } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

const { failEngineCalls } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestFault.sys.mjs"
);

/**
 * The engine names the engine code it was built from, so a sync report can be
 * traced to it. `build-core-wasm.sh` always passes the tree id of `engine/`
 * in, so an engine built any other way fails here.
 */
add_task(async function the_engine_reports_the_code_it_was_built_from() {
  const engine = new SvalEngine({
    root: await makeTempDir("sval-version"),
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  try {
    const version = await engine.engineVersion();
    info(`engine version: ${version}`);
    Assert.stringMatches(
      version,
      /^[0-9a-f]{40}(-dirty)?$/,
      "a tree id, marked dirty when built from uncommitted changes"
    );
    Assert.equal(
      await engine.engineVersion(),
      version,
      "the version is fixed for the engine's lifetime"
    );
  } finally {
    engine.terminate();
  }
});

/**
 * A rename travels between devices without disturbing a move made elsewhere.
 *
 * This is the case the three-fact model exists for (spec §5.1): the name and
 * the tree position are independently timestamped, so a device that only
 * renamed and a device that only moved each keep what they wrote. It runs
 * through two real engines and one folder, the only place the whole chain
 * of `rename`, the file and the merge is exercised.
 */
add_task(async function a_rename_and_a_move_on_two_devices_both_survive() {
  const root = await makeTempDir("sval-rename");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));

  const alice = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const bob = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });

  try {
    // Explicit timestamps: the engine stamps whatever the host hands it, and
    // two mutations inside one millisecond would land on an equal timestamp
    // and be decided by the canonical-byte tie-break instead of by which act
    // came later (spec §5.3).
    const workspace = await alice.mutate({
      kind: "addWorkspace",
      name: "W",
      now: 1000,
    });
    const shelf = await alice.mutate({
      kind: "addGroup",
      parent: workspace,
      name: "Shelf",
      now: 1000,
    });
    const tab = await alice.mutate({
      kind: "addTab",
      parent: workspace,
      name: "Before",
      url: "https://example.com/before",
      now: 1000,
    });
    await alice.sync(WORKSPACE);
    await bob.sync(WORKSPACE);

    // Alice renames; Bob, independently, files the same tab into the group.
    await alice.mutate({ kind: "rename", id: tab, name: "After", now: 2000 });
    await bob.mutate({
      kind: "moveNode",
      id: tab,
      newParent: shelf,
      now: 2000,
    });

    await alice.sync(WORKSPACE);
    await bob.sync(WORKSPACE);
    await alice.sync(WORKSPACE);

    for (const [label, engine] of [
      ["alice", alice],
      ["bob", bob],
    ]) {
      const node = (await engine.tree()).nodes[tab];
      Assert.equal(node.content.name, "After", `${label} kept the rename`);
      Assert.equal(
        node.placement.parent,
        shelf,
        `${label} kept the move: a rename must not drag the tab back`
      );
    }

    // An id the document does not hold is an error: a host that got "ok"
    // here would show a rename that never happened.
    await Assert.rejects(
      alice.mutate({
        kind: "rename",
        id: "00000000-0000-4000-8000-000000000000",
        name: "Nobody",
        now: 3000,
      }),
      err => err.code === "no_such_node",
      "renaming an unknown id rejects as an unknown node"
    );
  } finally {
    alice.terminate();
    bob.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * A batch is one act to the user, so one refused part-way leaves the document
 * exactly as it was, every timestamp included, and nothing of it reaches a
 * peer. The engine goes on taking changes after it.
 */
add_task(async function a_refused_batch_changes_nothing() {
  const root = await makeTempDir("sval-batch");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const alice = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const bob = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  try {
    const workspace = await alice.mutate({
      kind: "addWorkspace",
      name: "W",
      now: 1000,
    });
    const tab = await alice.mutate({
      kind: "addTab",
      parent: workspace,
      name: "Tab",
      url: "https://example.com/",
      now: 1000,
    });
    await alice.sync(WORKSPACE);
    const before = await alice.treeJson();

    const group = crypto.randomUUID();
    await Assert.rejects(
      alice.mutate({
        kind: "batch",
        ops: [
          { kind: "addGroup", parent: workspace, name: "G", id: group },
          { kind: "rename", id: tab, name: "Renamed" },
          { kind: "moveNode", id: tab, newParent: group },
          { kind: "moveNode", id: crypto.randomUUID(), newParent: group },
        ],
        now: 2000,
      }),
      err => err.code === "no_such_node",
      "the batch is refused at the node it cannot find"
    );
    Assert.equal(
      await alice.treeJson(),
      before,
      "and the document is exactly as it was"
    );

    await alice.sync(WORKSPACE);
    await bob.sync(WORKSPACE);
    const peer = (await bob.tree()).nodes;
    Assert.ok(!(group in peer), "a peer is sent no part of it");
    Assert.equal(peer[tab].content.name, "Tab", "not even the rename");

    await alice.mutate({ kind: "rename", id: tab, name: "Later", now: 3000 });
    Assert.equal(
      (await alice.tree()).nodes[tab].content.name,
      "Later",
      "a change after it lands"
    );
  } finally {
    alice.terminate();
    bob.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * Two tabs merged into a new group, as the panel does it, are one change: a
 * peer's next pass receives the group with both tabs in it.
 */
add_task(async function a_merged_group_reaches_a_peer_whole() {
  const root = await makeTempDir("sval-merge");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const alice = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const bob = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  try {
    const workspace = await alice.mutate({
      kind: "addWorkspace",
      name: "W",
    });
    const tabs = [];
    for (const name of ["One", "Two"]) {
      tabs.push(
        await alice.mutate({
          kind: "addTab",
          parent: workspace,
          name,
          url: "https://example.com/",
        })
      );
    }
    await alice.sync(WORKSPACE);
    await bob.sync(WORKSPACE);

    const group = crypto.randomUUID();
    await alice.mutate({
      kind: "batch",
      ops: [
        { kind: "addGroup", parent: workspace, name: "G", id: group },
        { kind: "setAppearance", id: group, color: "blue", emoji: null },
        { kind: "moveNode", id: tabs[0], newParent: group },
        { kind: "moveNode", id: tabs[1], newParent: group, before: tabs[0] },
      ],
    });
    await alice.sync(WORKSPACE);
    await bob.sync(WORKSPACE);

    const peer = (await bob.tree()).nodes;
    Assert.equal(peer[group]?.appearance.color, "blue", "the group arrives");
    Assert.deepEqual(
      tabs.map(id => peer[id].placement.parent),
      [group, group],
      "with both tabs in it"
    );
  } finally {
    alice.terminate();
    bob.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * A tab filed into a group another device deleted lands where that group was:
 * in the group's parent, at the group's place (spec §5.2), on
 * both devices.
 */
add_task(async function a_tab_filed_into_a_deleted_group_lands_at_its_place() {
  const root = await makeTempDir("sval-deleted-group");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const alice = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const bob = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  try {
    await alice.mutate({ kind: "addWorkspace", name: "Other" });
    const workspace = await alice.mutate({
      kind: "addWorkspace",
      name: "W",
    });
    const parent = await alice.mutate({
      kind: "addGroup",
      parent: workspace,
      name: "P",
    });
    const tab = name => ({
      kind: "addTab",
      parent,
      name,
      url: `https://${name}.example/`,
    });
    const before = await alice.mutate(tab("before"));
    const group = await alice.mutate({
      kind: "addGroup",
      parent,
      name: "G",
    });
    const after = await alice.mutate(tab("after"));
    await alice.sync(WORKSPACE);
    await bob.sync(WORKSPACE);
    await alice.sync(WORKSPACE);

    // Alice deletes G and publishes; Bob, not having read that, files a tab
    // into G.
    await alice.mutate({ kind: "remove", id: group });
    await alice.sync(WORKSPACE);
    const filed = await bob.mutate({
      kind: "addTab",
      parent: group,
      name: "filed",
      url: "https://filed.example/",
    });
    await bob.sync(WORKSPACE);
    await alice.sync(WORKSPACE);

    for (const [label, engine] of [
      ["alice", alice],
      ["bob", bob],
    ]) {
      const { nodes } = await engine.tree();
      const inParent = childrenByParent(nodes).get(parent);
      Assert.ok(!nodes[group], `${label} no longer holds G`);
      Assert.deepEqual(
        inParent,
        [before, filed, after],
        `${label} holds the tab in G's parent, at G's place`
      );
    }
  } finally {
    alice.terminate();
    bob.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * Converging means holding the same `nodes`. Every file also carries its own
 * `written_at`, `written_by` and `seen` (the version vector of spec §5.4),
 * which describe that device's own write and differ by design.
 */
add_task(async function two_devices_converge_on_one_folder() {
  const root = await makeTempDir("sval-converge");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));

  const alice = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const bob = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });

  try {
    const aliceWorkspace = await alice.mutate({
      kind: "addWorkspace",
      name: "Alice's workspace",
    });
    const bobWorkspace = await bob.mutate({
      kind: "addWorkspace",
      name: "Bob's workspace",
    });
    Assert.notEqual(
      aliceWorkspace,
      bobWorkspace,
      "each device minted its own node id"
    );

    // Alice publishes first, then Bob merges her and publishes, then Alice
    // merges him: the minimum number of passes for both to have heard the
    // other.
    const alicePublished = await alice.sync(WORKSPACE);
    Assert.deepEqual(alicePublished.errors, [], "no corrupt files for Alice");
    Assert.deepEqual(alicePublished.unreadable, [], "Alice read every file");
    Assert.notEqual(
      alicePublished.wrote,
      null,
      "a device with a new workspace publishes a file"
    );

    const bobMerged = await bob.sync(WORKSPACE);
    Assert.deepEqual(bobMerged.errors, [], "no corrupt files for Bob");
    Assert.deepEqual(bobMerged.schemaTooNew, [], "no peer is on a newer build");
    Assert.equal(bobMerged.merged, 1, "Bob merged Alice's one file");
    Assert.notEqual(bobMerged.wrote, null, "Bob published his own file");

    const aliceMerged = await alice.sync(WORKSPACE);
    Assert.deepEqual(aliceMerged.errors, [], "no corrupt files for Alice");
    Assert.equal(
      aliceMerged.merged,
      2,
      "Alice merged her own file back plus Bob's"
    );

    const aliceTree = await alice.tree();
    const bobTree = await bob.tree();

    Assert.deepEqual(
      Object.keys(aliceTree.nodes).sort(),
      [aliceWorkspace, bobWorkspace].sort(),
      "Alice holds both workspaces"
    );
    Assert.deepEqual(
      aliceTree.nodes,
      bobTree.nodes,
      "both devices converged on the same shared tree"
    );

    // The convergence assertion above means nothing if both trees are empty.
    Assert.equal(
      Object.keys(aliceTree.nodes).length,
      2,
      "the converged tree actually holds the two workspaces"
    );

    Assert.notEqual(
      aliceTree.written_by,
      bobTree.written_by,
      "each file still records the device that wrote it"
    );

    // One file per device, per workspace: the guarantee that keeps a cloud
    // client from ever seeing two writers race on one path (spec §6.2).
    const prefix = PathUtils.parent(resolve(root, alicePublished.wrote));
    const children = await IOUtils.getChildren(prefix);
    Assert.equal(children.length, 2, "exactly two files, one per device");
  } finally {
    alice.terminate();
    bob.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * A host call that throws must surface as a readable rejection. A wasm trap
 * leaves the module instance and the in-memory document it holds
 * unrecoverable, so a sync into a folder Sval cannot write must leave the
 * engine still able to sync somewhere it can.
 */
add_task(
  async function an_unwritable_folder_rejects_and_leaves_the_engine_usable() {
    const root = await makeTempDir("sval-unwritable");
    await SvalTestDeny.write(root);

    const engine = new SvalEngine({
      root,
      keyBytes: crypto.getRandomValues(new Uint8Array(32)),
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });

    try {
      await engine.mutate({ kind: "addWorkspace", name: "Nowhere" });

      await Assert.rejects(
        engine.sync(WORKSPACE),
        err => err.name === "SvalError",
        "sync rejected rather than resolving"
      );

      // The engine survived: same worker, same document, and it can still
      // publish once given a folder it can write.
      await SvalTestDeny.allow(root);
      const recovered = await engine.sync(WORKSPACE);
      Assert.notEqual(
        recovered.wrote,
        null,
        "the same engine instance still publishes after the failure"
      );
      Assert.equal(
        Object.keys((await engine.tree()).nodes).length,
        1,
        "the in-memory document survived the failed write"
      );
    } finally {
      engine.terminate();
      await SvalTestDeny.allow(root);
      await IOUtils.remove(root, { recursive: true });
    }
  }
);

/**
 * A peer that cannot be decrypted is reported and skipped; every other peer
 * still merges. One bad file must never cost the user the rest of the folder.
 */
add_task(async function one_corrupt_peer_does_not_stop_the_others() {
  const root = await makeTempDir("sval-corrupt-peer");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));

  const publisher = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const reader = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });

  try {
    const workspace = await publisher.mutate({
      kind: "addWorkspace",
      name: "Readable",
    });
    const published = await publisher.sync(WORKSPACE);

    // A file in the right place, with a device-id-shaped name, holding bytes
    // that are not a sealed document.
    const dir = PathUtils.parent(resolve(root, published.wrote));
    await IOUtils.writeUTF8(
      PathUtils.join(dir, "00000000000000000000000000000099.json"),
      "this is not a sealed sval document"
    );

    const report = await reader.sync(WORKSPACE);

    Assert.equal(report.merged, 1, "the readable peer still merged");
    Assert.equal(
      report.errors.length,
      1,
      `exactly one file is reported as broken: ${JSON.stringify(report.errors)}`
    );
    Assert.deepEqual(
      report.unreadable,
      [],
      "the bad file was read fine — it is its contents that are wrong"
    );
    Assert.ok(
      Object.keys((await reader.tree()).nodes).includes(workspace),
      "the readable peer's workspace is in the tree"
    );
  } finally {
    publisher.terminate();
    reader.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * What a cloud client or the operating system leaves in the shared folder is
 * not a peer, and a pass reports none of it: a conflict copy of a peer's file,
 * one that would not even read, Finder's metadata.
 */
add_task(async function what_a_cloud_client_leaves_is_not_reported() {
  const root = await makeTempDir("sval-cloud-leftovers");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const publisher = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const reader = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });

  try {
    await publisher.mutate({ kind: "addWorkspace", name: "Readable" });
    const published = await publisher.sync(WORKSPACE);
    const own = resolve(root, published.wrote);
    const dir = PathUtils.parent(own);
    const name = PathUtils.filename(own).replace(/\.json$/, "");
    await IOUtils.copy(own, PathUtils.join(dir, `${name} (1).json`));
    // A conflict copy that will not read, as a directory will not.
    await IOUtils.makeDirectory(PathUtils.join(dir, `${name} (2).json`));
    await IOUtils.writeUTF8(PathUtils.join(dir, ".DS_Store"), "Bud1");

    const report = await reader.sync(WORKSPACE);

    Assert.equal(report.merged, 1, "the real peer merged");
    Assert.deepEqual(report.errors, [], "nothing would not open");
    Assert.deepEqual(report.unreadable, [], "nothing would not read");
  } finally {
    publisher.terminate();
    reader.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * An own file that exists but cannot be read must stop the pass.
 *
 * `sync` treats `NotFound` on this device's own file as "first run, nothing of
 * mine to merge" and goes on to merge the peers and overwrite that path
 * (`src/sync.rs`). An unreadable own file treated as missing would hand the
 * engine that case, and everything this device wrote that no peer has merged
 * would be overwritten. This asserts the bytes on disk survive.
 */
add_task(
  async function an_unreadable_own_file_stops_the_pass_and_keeps_its_bytes() {
    const root = await makeTempDir("sval-own-file");
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const deviceId = crypto.getRandomValues(new Uint8Array(16));

    const mine = new SvalEngine({ root, keyBytes, deviceId });
    const peer = new SvalEngine({
      root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });

    // A workspace only this device knows about, published and then left in a
    // file nothing else holds a copy of.
    const onlyMine = await mine.mutate({
      kind: "addWorkspace",
      name: "Written while offline",
    });
    const published = await mine.sync(WORKSPACE);
    const ownPath = resolve(root, published.wrote);
    const before = await IOUtils.read(ownPath);
    mine.terminate();

    // A peer with something to say, so a pass that mistook the own file for
    // absent would have a reason to write.
    await peer.mutate({ kind: "addWorkspace", name: "From the peer" });
    await peer.sync(WORKSPACE);
    peer.terminate();

    await SvalTestDeny.read(ownPath);

    // A fresh engine for the same device: an empty in-memory document, exactly
    // as after a restart.
    const restarted = new SvalEngine({ root, keyBytes, deviceId });
    try {
      await Assert.rejects(
        restarted.sync(WORKSPACE),
        err => err.reason === "own_file_unreadable",
        "the pass rejected over this device's own file"
      );

      await SvalTestDeny.allow(ownPath);
      const after = await IOUtils.read(ownPath);
      Assert.equal(
        after.join(","),
        before.join(","),
        "the own file on disk is byte-identical — nothing was overwritten"
      );

      // And the workspace it holds is still recoverable once the file can be
      // read again.
      const recovered = await restarted.sync(WORKSPACE);
      Assert.deepEqual(recovered.errors, [], "the file was readable again");
      Assert.ok(
        Object.keys((await restarted.tree()).nodes).includes(onlyMine),
        "the workspace only this device knew about came back"
      );
    } finally {
      restarted.terminate();
      await SvalTestDeny.allow(ownPath);
      await IOUtils.remove(root, { recursive: true });
    }
  }
);

/**
 * The write must go through a temp file and a rename, so a peer polling the
 * folder never reads a partial document.
 *
 * A partial read cannot be raced deterministically, so this asserts the
 * mechanism: it blocks the temp path with a directory. A write that renames
 * from `${target}.tmp` has nowhere to stage and fails with the target
 * untouched; a write straight to the target would succeed and change it.
 */
add_task(async function the_write_goes_through_the_temp_path() {
  const root = await makeTempDir("sval-atomic");
  const engine = new SvalEngine({
    root,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });

  try {
    await engine.mutate({ kind: "addWorkspace", name: "First" });
    const published = await engine.sync(WORKSPACE);
    const target = resolve(root, published.wrote);
    const before = await IOUtils.read(target);

    // Something new to publish, so the next pass has a reason to write.
    await engine.mutate({ kind: "addWorkspace", name: "Second" });

    const blocked = `${target}.tmp`;
    await IOUtils.makeDirectory(blocked);

    await Assert.rejects(
      engine.sync(WORKSPACE),
      err => err.name === "SvalError",
      "the write failed because it had to stage through the temp path"
    );

    const during = await IOUtils.read(target);
    Assert.equal(
      during.join(","),
      before.join(","),
      "the target was never touched by the failed write"
    );

    await IOUtils.remove(blocked, { recursive: true });
    const recovered = await engine.sync(WORKSPACE);
    Assert.notEqual(recovered.wrote, null, "the pass publishes once unblocked");
    const after = await IOUtils.read(target);
    Assert.notEqual(
      after.join(","),
      before.join(","),
      "and the file really did change, so the check above was not vacuous"
    );
  } finally {
    engine.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * A pass that cannot save this device's file rejects with the name of what
 * failed, because the panel words the cause from it.
 */
add_task(async function a_write_failure_keeps_its_name() {
  const root = await makeTempDir("sval-write-name");
  const engine = new SvalEngine({
    root,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  let dir = null;
  try {
    await engine.mutate({ kind: "addWorkspace", name: "First" });
    const published = await engine.sync(WORKSPACE);
    dir = PathUtils.parent(resolve(root, published.wrote));
    await engine.mutate({ kind: "addWorkspace", name: "Second" });
    await SvalTestDeny.write(dir);

    await Assert.rejects(
      engine.sync(WORKSPACE),
      err => err.code === "NotAllowedError",
      "the pass names the refusal"
    );
  } finally {
    if (dir) {
      await SvalTestDeny.allow(dir);
    }
    engine.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * A copy the shared-folder helper left that does not read rejects with the
 * name of what failed, as a failed write does: the copy is on this machine's
 * disk, and the panel words a local cause from that name.
 */
add_task(async function a_copy_that_does_not_read_keeps_its_name() {
  const root = await makeTempDir("sval-copy-name");
  const engine = new SvalEngine({
    root,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const copy = PathUtils.join(root, "copy.bin");
  await IOUtils.write(copy, new Uint8Array([1, 2, 3]));
  await SvalTestDeny.read(copy);
  try {
    await Assert.rejects(
      engine.post("treeOfSnapshot", [
        {
          paths: ["sval/ws/doc/peer.bin"],
          files: [copy],
          workspace: WORKSPACE,
          keyBytes: crypto.getRandomValues(new Uint8Array(32)),
          deviceId: crypto.getRandomValues(new Uint8Array(16)),
        },
      ]),
      err => err.code === "NotAllowedError",
      "the read names the refusal"
    );
  } finally {
    await SvalTestDeny.allow(copy);
    engine.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * A change posted before a pass is in the file that pass writes, even while
 * the engine is still loading.
 */
add_task(
  async function a_change_made_as_the_engine_loads_is_in_its_first_file() {
    const root = await makeTempDir("sval-loading-order");
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const engine = new SvalEngine({
      root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    const peer = new SvalEngine({
      root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    try {
      const added = engine.mutate({ kind: "addWorkspace", name: "Early" });
      const passed = engine.sync(WORKSPACE);
      const id = await added;
      await passed;

      await peer.sync(WORKSPACE);
      Assert.ok(
        (await peer.tree()).nodes[id],
        "another device reads the change from the first file"
      );
    } finally {
      engine.terminate();
      peer.terminate();
      await IOUtils.remove(root, { recursive: true });
    }
  }
);

/**
 * Two passes launched together must run one after the other. A pass is a
 * read-modify-write across many await points and both passes write the same
 * path through the same temp name, so interleaving them can publish a document
 * assembled from a state no single snapshot held.
 */
add_task(async function overlapping_passes_are_serialised() {
  const root = await makeTempDir("sval-serialised");
  const engine = new SvalEngine({
    root,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });

  try {
    await engine.mutate({ kind: "addWorkspace", name: "Contended" });

    const reports = await Promise.all([
      engine.sync(WORKSPACE),
      engine.sync(WORKSPACE),
      engine.sync(WORKSPACE),
    ]);

    for (const report of reports) {
      Assert.deepEqual(report.errors, [], "no pass saw a damaged file");
      Assert.deepEqual(report.unreadable, [], "no pass failed a read");
    }

    // The first pass publishes; the later two find the document unchanged
    // against the file they just read and write nothing, which is what keeps an
    // idle device from generating cloud writes (spec §6.5). An interleaved pass
    // would have read the folder before the first write landed and published
    // again.
    const wrote = reports.filter(report => report.wrote !== null);
    Assert.equal(
      wrote.length,
      1,
      "exactly one of three overlapping passes wrote"
    );

    const dir = PathUtils.parent(resolve(root, wrote[0].wrote));
    Assert.equal(
      (await IOUtils.getChildren(dir)).length,
      1,
      "no temp file was left behind"
    );
  } finally {
    engine.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * An idle poll is the one pass that can be skipped. Every window of a profile
 * shares one engine and one document, so a pass another window began within
 * the poll interval already brought in what this one would; a pass that is
 * not idle always runs. Every pass that runs is reported to every listener,
 * with whoever asked for it, which is how the other windows draw it.
 */
add_task(async function an_idle_poll_just_after_another_pass_is_skipped() {
  const root = await makeTempDir("sval-idle-poll");
  const engine = new SvalEngine({
    root,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const heard = [];
  const forget = engine.addPassListener((report, origin) => heard.push(origin));

  try {
    await engine.mutate({ kind: "addWorkspace", name: "Polled" });

    Assert.ok(await engine.sync(WORKSPACE, 1_000, { origin: "a" }), "a pass");
    Assert.equal(
      await engine.sync(WORKSPACE, 3_000, { idleWithinMs: 5_000, origin: "b" }),
      null,
      "an idle poll two seconds after a pass is skipped"
    );
    Assert.ok(
      await engine.sync(WORKSPACE, 3_500, { origin: "c" }),
      "a pass that is not idle runs, however recent the last"
    );
    Assert.equal(
      await engine.sync(WORKSPACE, 9_000, { idleWithinMs: 5_000, origin: "-" }),
      null,
      "an idle poll with nothing to publish and no folder to read is skipped"
    );
    await engine.mutate({ kind: "addWorkspace", name: "Later" });
    Assert.ok(
      await engine.sync(WORKSPACE, 9_000, { idleWithinMs: 5_000, origin: "d" }),
      "an idle poll a full interval later runs when a change waits"
    );
    await engine.mutate({ kind: "addWorkspace", name: "Later still" });
    Assert.ok(
      await engine.sync(WORKSPACE, 500, { idleWithinMs: 5_000, origin: "e" }),
      "a clock set back does not stop the polls"
    );
    Assert.deepEqual(
      heard,
      ["a", "c", "d", "e"],
      "every pass that ran was heard, with who asked for it"
    );
  } finally {
    forget();
    engine.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * A pass that throws still marks the document as just passed, so another
 * window's idle poll skips. Every failure listener hears the error with who
 * asked and when, and the caller still gets the rejection.
 */
add_task(async function a_failed_pass_is_heard_by_every_listener() {
  const root = await makeTempDir("sval-failed-pass");
  const engine = new SvalEngine({
    root,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const failed = [];
  const passed = [];
  const forgetFailure = engine.addFailureListener((err, origin, now) =>
    failed.push([err.code, origin, now])
  );
  const forgetPass = engine.addPassListener(() => passed.push(true));
  try {
    await engine.mutate({ kind: "addWorkspace", name: "Refused" });
    const fault = failEngineCalls(engine, "sync", {
      error: () =>
        Object.assign(new Error("refused"), { code: "NotAllowedError" }),
    });
    await Assert.rejects(
      engine.sync(WORKSPACE, 1_000, { origin: "a" }),
      err => err.code === "NotAllowedError",
      "the caller gets the rejection"
    );
    Assert.deepEqual(
      failed,
      [["NotAllowedError", "a", 1_000]],
      "and the listener hears it, with who asked and when"
    );
    Assert.deepEqual(passed, [], "and no pass listener hears a pass");
    Assert.ok(
      !engine.failedInSharedStep(
        await engine.sync(WORKSPACE, 1_500).catch(err => err)
      ),
      "a profile pass that fails is no shared step's failure"
    );
    failed.pop();
    Assert.equal(
      await engine.sync(WORKSPACE, 2_000, { idleWithinMs: 5_000, origin: "b" }),
      null,
      "another window's idle poll just after it skips"
    );

    fault.mend();
    forgetFailure();
    Assert.ok(await engine.sync(WORKSPACE, 3_000), "a later pass runs");
    Assert.equal(failed.length, 1, "and a removed listener hears nothing");
  } finally {
    forgetFailure();
    forgetPass();
    engine.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * Changes asked to be published together are one pass and one file, and the
 * file holds every one of them.
 */
add_task(async function a_burst_of_requested_passes_publishes_once() {
  const root = await makeTempDir("sval-requested");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const engine = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
    passRequestDelayMs: 50,
  });
  const peer = new SvalEngine({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  try {
    await engine.sync(WORKSPACE);
    const passes = [];
    const forget = engine.addPassListener(report => passes.push(report));
    const ids = [];
    for (const name of ["One", "Two", "Three"]) {
      ids.push(await engine.mutate({ kind: "addWorkspace", name }));
      engine.requestPass();
    }
    await within(
      new Promise(heard => {
        const wait = engine.addPassListener(() => {
          wait();
          heard();
        });
      }),
      10_000,
      "the requested pass"
    );
    forget();
    Assert.equal(passes.length, 1, "one pass ran for the burst");
    Assert.ok(passes[0].wrote, "and wrote one file");

    await peer.sync(WORKSPACE);
    const nodes = (await peer.tree()).nodes;
    Assert.ok(
      ids.every(id => nodes[id]),
      "another device reads every change from it"
    );
  } finally {
    engine.terminate();
    peer.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * The document modules that wait for first run to end begin at the pass
 * after it, so an idle device with nothing to publish still runs that pass.
 */
add_task(async function the_end_of_first_run_runs_a_pass_on_an_idle_device() {
  const root = await makeTempDir("sval-past-first-run");
  const engine = new SvalEngine({
    root,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
    passRequestDelayMs: 10,
  });
  SvalEngine.pastFirstRun = false;
  SvalEngine.setSharedInstance(engine);
  try {
    await engine.sync(WORKSPACE);
    const heard = Promise.withResolvers();
    const forget = engine.addPassListener(() => heard.resolve());
    SvalEngine.pastFirstRun = true;
    await within(heard.promise, 10_000, "the pass after first run");
    forget();
  } finally {
    SvalEngine.setSharedInstance(null);
    SvalEngine.pastFirstRun = false;
    engine.terminate();
    await IOUtils.remove(root, { recursive: true });
  }
});

/**
 * Choosing an empty shared folder, which makes `sval/` in it, publishes this
 * device's document there, and the profile keeps its copy.
 *
 * A fresh engine for the new folder would start with an empty document,
 * publish that, and leave the user's workspaces behind. `setSharedRoot` keeps
 * the document and changes only where the next shared step looks, and the
 * engine's unchanged-document shortcut cannot suppress the write because
 * there is no own file at the destination to compare against.
 */
add_task(async function relocating_to_an_empty_folder_carries_the_document() {
  const from = await makeTempDir("sval-relocate-from");
  const to = await makeTempDir("sval-relocate-to");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const engine = new SvalEngine({
    root: from,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  // A second device at the destination, so what is asserted is what another
  // device pointed at that folder can read.
  const reader = new SvalEngine({
    root: to,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });

  try {
    const workspace = await engine.mutate({
      kind: "addWorkspace",
      name: "Carried",
      now: 1000,
    });
    const tab = await engine.mutate({
      kind: "addTab",
      parent: workspace,
      name: "A page",
      url: "https://example.com/carried",
      now: 2000,
    });
    const published = await engine.sync(WORKSPACE, 3000);
    Assert.notEqual(published.wrote, null, "the old folder holds the document");
    const before = Object.keys((await engine.tree()).nodes);
    Assert.equal(before.length, 2, "one workspace and one tab to carry");

    engine.setSharedRoot(to);
    Assert.ok(
      (await engine.markSharedRoot()).reachable,
      "the folder is chosen"
    );
    const moved = await engine.sync(WORKSPACE, 4000);
    Assert.equal(moved.shared, "reached", "the chosen folder answered");
    Assert.notEqual(
      moved.sharedWrote,
      null,
      "an empty folder is published to, not skipped as unchanged"
    );
    Assert.ok(
      await IOUtils.exists(resolve(to, moved.sharedWrote)),
      "and the file is in the folder the user chose"
    );

    Assert.deepEqual(
      Object.keys((await engine.tree()).nodes).sort(),
      before.sort(),
      "changing the setting lost no node"
    );

    const arrived = await reader.sync(WORKSPACE, 5000);
    Assert.deepEqual(arrived.errors, [], "the destination's copy is readable");
    const onReader = (await reader.tree()).nodes;
    Assert.equal(
      Object.keys(onReader).length,
      2,
      "and holds both nodes, which is the whole point of moving it"
    );
    Assert.equal(onReader[workspace].content.name, "Carried");
    Assert.equal(onReader[tab].content.url, "https://example.com/carried");

    // The profile keeps this device's copy whatever folder is chosen
    // (local-copy spec §4.1).
    Assert.ok(
      await IOUtils.exists(resolve(from, published.wrote)),
      "the profile still holds its copy"
    );
  } finally {
    engine.terminate();
    reader.terminate();
    await IOUtils.remove(from, { recursive: true });
    await IOUtils.remove(to, { recursive: true });
  }
});

/**
 * Pointing a device at a folder another device already publishes to merges the
 * two, and neither side loses a workspace.
 *
 * The count is asserted on both devices after the move: a relocation that
 * published over the destination would leave the arriving device looking
 * correct and the device already there missing a workspace.
 */
add_task(async function relocating_into_an_occupied_folder_merges_both_ways() {
  const from = await makeTempDir("sval-merge-from");
  const shared = await makeTempDir("sval-merge-shared");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const mover = new SvalEngine({
    root: from,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const resident = new SvalEngine({
    root: shared,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });

  try {
    const theirs = await resident.mutate({
      kind: "addWorkspace",
      name: "Already there",
      now: 1000,
    });
    await resident.sync(WORKSPACE, 2000);

    const mine = await mover.mutate({
      kind: "addWorkspace",
      name: "Arriving",
      now: 3000,
    });
    await mover.sync(WORKSPACE, 4000);

    mover.setSharedRoot(shared);
    const merged = await mover.sync(WORKSPACE, 5000);
    Assert.deepEqual(merged.errors, [], "the resident's file was readable");
    Assert.equal(merged.shared, "reached", "the occupied folder answered");

    const onMover = (await mover.tree()).nodes;
    Assert.equal(
      Object.keys(onMover).length,
      2,
      "the mover holds both workspaces"
    );
    Assert.ok(mine in onMover, "its own survived the change of setting");
    Assert.ok(theirs in onMover, "and the folder's was adopted, not replaced");

    await resident.sync(WORKSPACE, 6000);
    const onResident = (await resident.tree()).nodes;
    Assert.equal(
      Object.keys(onResident).length,
      2,
      "and the device that was already there holds both too"
    );
    Assert.ok(theirs in onResident, "keeping its own");
    Assert.ok(mine in onResident, "and gaining the arriving one");
  } finally {
    mover.terminate();
    resident.terminate();
    await IOUtils.remove(from, { recursive: true });
    await IOUtils.remove(shared, { recursive: true });
  }
});

const { AsyncShutdown } = ChromeUtils.importESModule(
  "resource://gre/modules/AsyncShutdown.sys.mjs"
);

/**
 * The profile's engine, built through `forProfile` and with its shutdown
 * blocker moved onto a barrier the test can trigger.
 *
 * @param {object} [options] Passed to `SvalEngine.setShutdownClient`.
 * @returns {Promise<object>} `{ engine, barrier, root, keyBytes, cleanup }`.
 */
async function profileEngine(options) {
  const root = await makeTempDir("sval-shutdown");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const barrier = new AsyncShutdown.Barrier("sval test: profile shutdown");
  SvalEngine.setShutdownClient(barrier.client, options);
  const engine = SvalEngine.forProfile({
    root,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const cleanup = async () => {
    SvalEngine.setSharedInstance(null);
    SvalEngine.setShutdownClient(null);
    engine.terminate();
    await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
  };
  return { engine, barrier, root, keyBytes, cleanup };
}

/**
 * A change no pass has published yet is published by the profile's shutdown
 * blocker, so quitting inside the debounce window loses nothing.
 */
add_task(async function shutdown_publishes_what_no_pass_has() {
  const { engine, barrier, root, keyBytes, cleanup } = await profileEngine();
  try {
    await engine.sync(WORKSPACE);
    const id = crypto.randomUUID();
    await engine.mutate({
      kind: "addWorkspace",
      name: "Work",
      id,
      now: Date.now(),
    });
    Assert.ok(
      !(id in (await readBack(root, keyBytes))),
      "the change is in memory only before shutdown"
    );

    await barrier.wait();

    Assert.ok(
      id in (await readBack(root, keyBytes)),
      "the blocker published it before letting shutdown go on"
    );
  } finally {
    await cleanup();
  }
});

/**
 * One profile is one blocker, however many windows ask for the engine, and
 * the blocker goes when the profile's engine does.
 */
add_task(async function the_profile_registers_one_blocker() {
  const added = [];
  const removed = [];
  const client = {
    addBlocker(name, condition) {
      added.push(condition);
    },
    removeBlocker(condition) {
      removed.push(condition);
      return true;
    },
  };
  const root = await makeTempDir("sval-one-blocker");
  SvalEngine.setShutdownClient(client);
  try {
    const identity = {
      root,
      keyBytes: crypto.getRandomValues(new Uint8Array(32)),
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    };
    const first = SvalEngine.forProfile(identity);
    const second = SvalEngine.forProfile(identity);
    Assert.equal(first, second, "both windows share one engine");
    Assert.equal(added.length, 1, "and the profile registered one blocker");

    SvalEngine.setSharedInstance(null);
    Assert.deepEqual(
      removed,
      added,
      "forgetting the profile's engine removes that blocker"
    );
    first.terminate();
  } finally {
    SvalEngine.setSharedInstance(null);
    SvalEngine.setShutdownClient(null);
    await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
  }
});

/**
 * The engine `prestart` starts before the profile's keys are read is the one
 * the first `forProfile` hands out, and it works under that identity.
 */
add_task(async function the_prestarted_engine_becomes_the_profiles() {
  const root = await makeTempDir("sval-prestart");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  SvalEngine.setShutdownClient({
    addBlocker() {},
    removeBlocker() {
      return true;
    },
  });
  let engine = null;
  try {
    SvalEngine.prestart();
    engine = SvalEngine.forProfile({
      root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    Assert.ok(
      engine.launchTimeStamp,
      "the profile's engine is the one whose worker was already running"
    );
    await engine.sync(WORKSPACE);
    const id = crypto.randomUUID();
    await engine.mutate({
      kind: "addWorkspace",
      name: "Work",
      id,
      now: Date.now(),
    });
    await engine.sync(WORKSPACE);
    Assert.ok(
      id in (await readBack(root, keyBytes)),
      "it published under the profile's key, in the profile's folder"
    );
  } finally {
    SvalEngine.setSharedInstance(null);
    SvalEngine.setShutdownClient(null);
    engine?.terminate();
    await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
  }
});

/**
 * A torn-down engine is never synced at shutdown. Posting to it would start a
 * fresh worker holding an empty document, which is not this device's state.
 */
add_task(async function a_terminated_engine_is_not_synced_at_shutdown() {
  const { engine, barrier, root, keyBytes, cleanup } = await profileEngine();
  try {
    await engine.sync(WORKSPACE);
    const id = crypto.randomUUID();
    await engine.mutate({
      kind: "addWorkspace",
      name: "Work",
      id,
      now: Date.now(),
    });
    let passes = 0;
    const realSync = engine.sync.bind(engine);
    engine.sync = (...args) => {
      passes++;
      return realSync(...args);
    };
    engine.terminate();

    await barrier.wait();

    Assert.equal(passes, 0, "no pass was attempted");
    Assert.ok(
      !(id in (await readBack(root, keyBytes))),
      "and nothing reached the folder"
    );
  } finally {
    await cleanup();
  }
});

/**
 * A pass that never finishes cannot hold shutdown past the blocker's own
 * deadline, which sits well inside AsyncShutdown's crash timeout.
 */
add_task(async function a_hung_pass_does_not_hold_shutdown() {
  const { engine, barrier, cleanup } = await profileEngine({ timeoutMs: 50 });
  try {
    await engine.sync(WORKSPACE);
    await engine.mutate({
      kind: "addWorkspace",
      name: "Work",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    engine.sync = () => new Promise(() => {});

    const started = Date.now();
    await barrier.wait();
    Assert.less(
      Date.now() - started,
      5000,
      "the barrier finished on the blocker's deadline"
    );
  } finally {
    await cleanup();
  }
});

add_task(async function shutdown_with_nothing_unpublished_runs_no_pass() {
  const { engine, barrier, cleanup } = await profileEngine();
  try {
    await engine.mutate({
      kind: "addWorkspace",
      name: "Work",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    await engine.sync(WORKSPACE);
    let passes = 0;
    engine.sync = async () => {
      passes++;
      return {};
    };

    await barrier.wait();
    Assert.equal(passes, 0, "an idle device does not sync on its way out");
  } finally {
    await cleanup();
  }
});
