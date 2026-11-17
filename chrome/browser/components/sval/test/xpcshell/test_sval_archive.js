/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// Archiving idle tabs (idle-tab archive spec): two devices on one folder,
// each with its own archive over its own engine, swept as a pass ends. The
// global choice is the pref Settings writes. No window is open, so no tab is
// on screen.

const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { AUTO_ARCHIVE_PREF, SvalArchive } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalArchive.sys.mjs"
);
const { SvalLocalSettings } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
);
const { childrenByParent } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

do_get_profile();

const TREE = "workspace-under-test";
const DAY_MS = 24 * 60 * 60 * 1000;
const LONG_AGO = Date.now() - 8 * DAY_MS;

/** Devices on one folder, each with its archive. */
function devices() {
  const root = makeTempDir("sval-archive");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const made = [];
  registerCleanupFunction(async () => {
    for (const device of made) {
      device.archive.stop();
      await device.engine.terminate();
    }
    SvalLocalSettings.forgetCachedValues();
  });
  return async ({ exempt = async () => [] } = {}) => {
    const engine = new SvalEngine({
      root: await root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    await engine.sync(TREE, Date.now());
    const archive = new SvalArchive({
      engine,
      settings: await SvalLocalSettings.open(
        tempPath("sval-archive-settings", ".json")
      ),
      exempt,
      requestPass: () => {},
    });
    await archive.start();
    const device = {
      engine,
      archive,
      // A pass, and the sweep it may start.
      pass: async () => {
        await engine.sync(TREE, Date.now());
        await within(archive.whenIdle(), 10_000, "archive going idle");
      },
      nodes: async () => (await engine.tree()).nodes ?? {},
      add: (op, now = Date.now()) =>
        engine.mutate({ ...op, id: op.id ?? crypto.randomUUID(), now }),
    };
    made.push(device);
    return device;
  };
}

/** Turns archiving on as Settings' checkbox does, for this task. */
function archiveAfterSevenDays() {
  Services.prefs.setStringPref(AUTO_ARCHIVE_PREF, "7d");
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref(AUTO_ARCHIVE_PREF)
  );
}

/**
 * The children of `parent`, in sibling order.
 *
 * @param {object} nodes The tree's nodes, by id.
 * @param {string} parent A node id.
 * @returns {string[]}
 */
function childrenOf(nodes, parent) {
  return childrenByParent(nodes).get(parent) ?? [];
}

add_task(async function an_idle_tab_is_archived_and_listed_on_every_device() {
  archiveAfterSevenDays();
  const device = devices();
  const laptop = await device();
  const home = await laptop.add({ kind: "addWorkspace", name: "Home" });
  const idle = await laptop.add(
    {
      kind: "addTab",
      parent: home,
      name: "Idle page",
      url: "https://idle.example/",
    },
    LONG_AGO
  );
  const fresh = await laptop.add({
    kind: "addTab",
    parent: home,
    name: "Fresh page",
    url: "https://fresh.example/",
  });
  // The first sweep runs after this session's first pass.
  await laptop.pass();

  const nodes = await laptop.nodes();
  Assert.ok(!(idle in nodes), "the tab nobody used for 8 days left the tree");
  Assert.ok(fresh in nodes, "a tab opened today stays");
  const [entry, ...others] = await laptop.archive.entries();
  Assert.equal(others.length, 0, "one tab archived");
  Assert.equal(entry.url, "https://idle.example/");
  Assert.equal(entry.title, "Idle page");
  Assert.equal(entry.workspaceName, "Home", "named by its workspace");
  Assert.ok(!entry.restored);

  // The pass the sweep asks for publishes the tree's removal.
  await laptop.pass();
  // The desktop keeps the tab itself, so what it learns comes from the
  // laptop.
  const desktop = await device({ exempt: async () => [idle] });
  await desktop.pass();
  Assert.ok(
    !(idle in (await desktop.nodes())),
    "the other device's tree lost it too"
  );
  Assert.deepEqual(
    (await desktop.archive.entries()).map(each => [
      each.id,
      each.workspaceName,
    ]),
    [[entry.id, "Home"]],
    "and its Archive lists it"
  );
});

add_task(async function a_groups_tab_and_an_agents_tab_are_never_archived() {
  archiveAfterSevenDays();
  const laptop = await devices()();
  const home = await laptop.add({ kind: "addWorkspace", name: "Home" });
  const group = await laptop.add(
    { kind: "addGroup", parent: home, name: "Kept" },
    LONG_AGO
  );
  const grouped = await laptop.add(
    {
      kind: "addTab",
      parent: group,
      name: "In a group",
      url: "https://g.example/",
    },
    LONG_AGO
  );
  const agents = await laptop.add(
    { kind: "addAgentWorkspace", name: "Agent", agentLabel: "Helper" },
    LONG_AGO
  );
  const agentTab = await laptop.add(
    {
      kind: "addTab",
      parent: agents,
      name: "Agent's",
      url: "https://a.example/",
    },
    LONG_AGO
  );
  await laptop.pass();

  const nodes = await laptop.nodes();
  Assert.ok(grouped in nodes, "a tab in a group stays");
  Assert.ok(agentTab in nodes, "an agent's tab stays");
  Assert.deepEqual(await laptop.archive.entries(), [], "nothing was archived");
});

add_task(async function a_restored_tab_goes_back_between_its_neighbours() {
  archiveAfterSevenDays();
  const laptop = await devices()();
  const home = await laptop.add({ kind: "addWorkspace", name: "Home" });
  const tab = (name, now) =>
    laptop.add(
      {
        kind: "addTab",
        parent: home,
        name,
        url: `https://${name.toLowerCase()}.example/`,
      },
      now
    );
  const first = await tab("First");
  await tab("Middle", LONG_AGO);
  const last = await tab("Last");
  // Ordered as made: the idle one sits between the other two.
  await laptop.pass();
  Assert.deepEqual(childrenOf(await laptop.nodes(), home), [first, last]);

  const [entry] = await laptop.archive.entries();
  const restored = await laptop.archive.restore(entry.id, home);
  const nodes = await laptop.nodes();
  Assert.deepEqual(
    childrenOf(nodes, home),
    [first, restored.tabs[0], last],
    "the restored tab is back between its neighbours"
  );
  Assert.equal(nodes[restored.tabs[0]].content.url, "https://middle.example/");
  Assert.ok(
    (await laptop.archive.entries())[0].restored,
    "and its entry says it was restored"
  );
});

add_task(async function a_split_is_archived_whole_and_restored_as_a_split() {
  archiveAfterSevenDays();
  const laptop = await devices()();
  const home = await laptop.add({ kind: "addWorkspace", name: "Home" });
  const kept = await laptop.add({
    kind: "addTab",
    parent: home,
    name: "Kept",
    url: "https://kept.example/",
  });
  const split = crypto.randomUUID();
  const panes = [crypto.randomUUID(), crypto.randomUUID()];
  await laptop.engine.mutate({
    kind: "batch",
    now: LONG_AGO,
    ops: [
      // With no neighbour named, each goes last.
      { kind: "addSplit", parent: home, id: split },
      ...panes.map((id, i) => ({
        kind: "addTab",
        parent: split,
        id,
        name: `Pane ${i}`,
        url: `https://pane${i}.example/`,
      })),
    ],
  });
  await laptop.pass();

  let nodes = await laptop.nodes();
  Assert.deepEqual(
    [split, ...panes].filter(id => id in nodes),
    [],
    "the split and both its panes left the tree together"
  );
  Assert.deepEqual(childrenOf(nodes, home), [kept], "the tab beside it stays");
  const entries = await laptop.archive.entries();
  Assert.deepEqual(
    entries.map(entry => entry.pane).sort(),
    [0, 1],
    "each pane has its entry"
  );

  const restored = await laptop.archive.restore(entries[0].id, home);
  nodes = await laptop.nodes();
  Assert.equal(nodes[restored.split]?.kind, "split", "a split came back");
  Assert.deepEqual(
    childrenOf(nodes, restored.split).map(id => nodes[id].content.url),
    ["https://pane0.example/", "https://pane1.example/"],
    "with both panes, in their order"
  );
  Assert.deepEqual(
    (await laptop.archive.entries()).map(entry => entry.restored),
    [true, true],
    "and both entries are marked restored"
  );
});

add_task(async function archive_now_takes_a_tab_in_use_and_lists_it() {
  // Archiving idle tabs is off, as it is by default, and the tab is in use.
  const device = devices();
  const laptop = await device({ exempt: async () => [tab] });
  const home = await laptop.add({ kind: "addWorkspace", name: "Home" });
  const tab = await laptop.add({
    kind: "addTab",
    parent: home,
    name: "Reading",
    url: "https://reading.example/",
  });
  const swept = await laptop.archive.archiveNow(tab);

  Assert.deepEqual(swept.tabs, [tab]);
  Assert.ok(!(tab in (await laptop.nodes())), "the tab left the tree");
  const [entry, ...others] = await laptop.archive.entries();
  Assert.equal(others.length, 0);
  Assert.equal(entry.url, "https://reading.example/");
  Assert.equal(entry.workspaceName, "Home");
});

add_task(async function archive_now_refuses_a_tab_in_a_group() {
  const device = devices();
  const laptop = await device();
  const home = await laptop.add({ kind: "addWorkspace", name: "Home" });
  const group = await laptop.add({
    kind: "addGroup",
    parent: home,
    name: "Trip",
  });
  const tab = await laptop.add({
    kind: "addTab",
    parent: group,
    name: "Flights",
    url: "https://flights.example/",
  });
  await Assert.rejects(laptop.archive.archiveNow(tab), /never archived/);
  Assert.ok(tab in (await laptop.nodes()), "the tab stays");
  Assert.deepEqual(await laptop.archive.entries(), []);
});

add_task(async function imported_tabs_are_listed_restored_and_synced() {
  const device = devices();
  const laptop = await device();
  const home = await laptop.add({ kind: "addWorkspace", name: "Home" });
  const closedAt = Date.now() - 2 * DAY_MS;
  const ids = await laptop.archive.importEntries([
    {
      title: "Kept",
      url: "https://kept.example/",
      workspace: home,
      workspaceName: "Home",
      closedAt,
    },
    {
      title: "Orphan",
      url: "https://orphan.example/",
      workspace: crypto.randomUUID(),
      workspaceName: "",
      closedAt,
    },
  ]);
  Assert.equal(ids.length, 2);
  const entries = await laptop.archive.entries();
  Assert.deepEqual(
    entries.map(e => [e.url, e.workspaceName, e.closedAt, e.restored]).sort(),
    [
      ["https://kept.example/", "Home", closedAt, false],
      ["https://orphan.example/", "", closedAt, false],
    ]
  );

  // The other device lists them once a pass has carried them over.
  const desktop = await device();
  await laptop.pass();
  await desktop.pass();
  Assert.deepEqual((await desktop.archive.entries()).map(e => e.url).sort(), [
    "https://kept.example/",
    "https://orphan.example/",
  ]);

  // An entry whose workspace no tree holds restores into the current one.
  const work = await laptop.add({ kind: "addWorkspace", name: "Work" });
  const orphan = entries.find(e => e.url === "https://orphan.example/");
  const restored = await laptop.archive.restore(orphan.id, work);
  Assert.equal(restored.workspace, work);
  const kept = entries.find(e => e.url === "https://kept.example/");
  Assert.equal((await laptop.archive.restore(kept.id, work)).workspace, home);
});

add_task(async function an_import_waits_for_the_archive_to_open() {
  const root = await makeTempDir("sval-archive-waits");
  const engine = new SvalEngine({
    root,
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  await engine.sync(TREE, Date.now());
  let mayBegin = false;
  const archive = new SvalArchive({
    engine,
    canBegin: () => mayBegin,
    settings: await SvalLocalSettings.open(
      tempPath("sval-archive-settings", ".json")
    ),
    requestPass: () => {},
  });
  registerCleanupFunction(async () => {
    archive.stop();
    await engine.terminate();
  });
  await archive.start();
  Assert.ok(!archive.ready, "first run holds the archive back");
  const adding = archive.importEntries([
    {
      title: "Later",
      url: "https://later.example/",
      workspace: crypto.randomUUID(),
      workspaceName: "",
      closedAt: Date.now() - DAY_MS,
    },
  ]);
  mayBegin = true;
  await engine.sync(TREE, Date.now());
  const ids = await within(
    adding,
    10000,
    "the import after the archive opened"
  );
  Assert.equal(ids.length, 1);
  Assert.deepEqual(
    (await archive.entries()).map(e => e.url),
    ["https://later.example/"]
  );
});
