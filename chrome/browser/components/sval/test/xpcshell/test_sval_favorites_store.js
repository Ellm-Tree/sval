/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Favorites over the engine's document, the only copy (favorites-native
 * spec §5.1): each change is one write, Undo puts back what it replaced, and
 * what a pass brings is told by name, never by absence.
 */

const { makeTempDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalFavoritesStore, FAVORITES_DOCUMENT, FAVORITES_ROOT, PINS_ROOT } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
  );

const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);
const { SvalTestDeny } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestDeny.sys.mjs"
);

const TREE = "workspace-under-test";

/** Two devices on one folder, each with its own engine and Favorites. */
async function twoDevices() {
  const root = await makeTempDir("sval-favorites-store");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  // Opening a document passes at the real time, so a change stamped before
  // it would read to the peer as already deleted.
  let tick = Date.now();
  const now = () => (tick += 1000);
  const made = [];
  registerCleanupFunction(() =>
    made.forEach(d => {
      d.store.stop();
      d.engine.terminate();
    })
  );
  const make = async () => {
    const engine = new SvalEngine({
      root,
      sharedRoot: root,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    const store = new SvalFavoritesStore({
      engine,
      requestPass: () => {},
      now,
    });
    const heard = [];
    store.addChangeListener(change => heard.push(change));
    await store.start();
    const device = {
      engine,
      store,
      heard,
      pass: async () => {
        await engine.sync(TREE, now());
        await within(store.whenIdle(), 10_000, "store going idle");
      },
    };
    made.push(device);
    return device;
  };
  return { make };
}

/**
 * Favorites as names, each after its folder's, depth first in order, read
 * from the engine itself.
 *
 * @param {object} engine
 * @returns {Promise<string>}
 */
async function outline(engine) {
  const rows = await engine.favorites(FAVORITES_DOCUMENT);
  const root = await engine.favoriteId(FAVORITES_ROOT);
  const out = [];
  const walk = (id, folder) => {
    for (const row of rows.filter(r => r.parent === id)) {
      out.push(`${folder}>${row.name}`);
      walk(row.id, row.name);
    }
  };
  walk(root, "");
  return out.join(" ");
}

add_task(async function each_change_is_undone_in_the_document() {
  const { make } = await twoDevices();
  const { engine, store } = await make();
  const [folder, a] = await store.insertTree([
    { title: "F", children: [{ title: "A", url: "https://a.example/" }] },
  ]);
  const b = await store.add({ url: "https://b.example/", title: "B" });
  Assert.ok(store.canUndo(), "an add is on the stack");
  const start = await outline(engine);
  Assert.equal(start, ">F F>A >B");

  await store.rename(b, "Bee");
  Assert.equal(await outline(engine), ">F F>A >Bee");
  await store.undo();
  Assert.equal(await outline(engine), start, "the rename is undone");

  await store.move(b, folder);
  Assert.equal(await outline(engine), ">F F>A F>B");
  await store.undo();
  Assert.equal(await outline(engine), start, "the move is undone");

  await store.delete(folder);
  Assert.equal(await outline(engine), ">B", "the folder goes with A");
  Assert.ok(!store.get(a), "and A with it");
  await store.undo();
  Assert.equal(await outline(engine), start, "the delete is undone");

  const [pins, pin] = await store.insertTree([], {
    pins: [
      { title: "P", children: [{ title: "Q", url: "https://q.example/" }] },
    ],
  });
  await store.setPinScope(pins, ["ws-1"]);
  await store.delete(pins);
  Assert.equal(store.home().length, 0, "a pinned folder goes with its pins");
  await store.undo();
  Assert.deepEqual(
    store.home().map(t => [t.guid, t.children.map(c => c.guid)]),
    [[pins, [pin]]],
    "Undo brings it back with them"
  );
  Assert.deepEqual(store.pinScopeOf(pins), ["ws-1"], "and its scope");

  await store.undo();
  Assert.equal(store.pinScopeOf(pins), null, "the scope is undone");

  await store.undo();
  Assert.ok(!store.get(b), "the add is undone");
  Assert.ok(!store.canUndo(), "an import is not on the stack");
});

add_task(async function a_url_is_one_favorite_however_it_is_spelled() {
  const { make } = await twoDevices();
  const { store } = await make();
  await store.add({ url: "HTTPS://Example.com", title: "E" });
  Assert.ok(store.isFavorite("https://example.com/"));
  Assert.equal(
    await store.add({ url: "https://example.com/" }),
    null,
    "a second add of it is nothing"
  );
  await store.removeUrl("https://example.com");
  Assert.ok(!store.isFavorite("https://example.com/"), "removed in one");
});

add_task(async function a_deleted_and_undone_favorite_reaches_a_peer() {
  const { make } = await twoDevices();
  const alice = await make();
  const bob = await make();
  const guid = await alice.store.add({ url: "https://a.example/", title: "A" });
  await alice.pass();
  await bob.pass();
  Assert.ok(bob.store.get(guid), "Bob has it");

  await alice.store.delete(guid);
  await alice.pass();
  bob.heard.length = 0;
  await bob.pass();
  Assert.ok(!bob.store.get(guid), "Bob's is deleted");
  Assert.deepEqual(
    bob.heard.flatMap(c => c.removed),
    [guid],
    "the pass names what it removed"
  );

  await alice.store.undo();
  await alice.pass();
  await bob.pass();
  Assert.equal(bob.store.get(guid)?.name, "A", "the undone delete arrives");
});

add_task(async function a_pass_names_only_what_it_changed() {
  const { make } = await twoDevices();
  const alice = await make();
  const bob = await make();
  const guid = await alice.store.add({ url: "https://a.example/", title: "A" });
  await alice.pass();
  bob.heard.length = 0;
  await bob.pass();
  Assert.deepEqual(
    bob.heard.flatMap(c => c.changed).filter(g => g === guid),
    [guid],
    "the new favorite is named as changed"
  );
  Assert.deepEqual(
    bob.heard.flatMap(c => c.removed),
    [],
    "nothing is named removed for what Bob did not hold before"
  );
  Assert.equal(bob.store.get(guid).parentGuid, FAVORITES_ROOT);
});

/**
 * A store stopped while its document is still opening settles everyone who
 * waits on it. The process's instance exists, and has asked the engine to
 * open the document, a few microtasks after `startFor`; the engine answers
 * from its worker, a message no microtask can come before, so a stop made
 * in between is made while the document opens.
 */
add_task(async function a_store_stopped_while_opening_settles_its_waiters() {
  const engine = new SvalEngine({
    root: await makeTempDir("sval-favorites-stopped"),
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => engine.terminate());
  const starting = SvalFavoritesStore.startFor(engine);
  for (let i = 0; i < 100 && !SvalFavoritesStore.instance; i++) {
    await Promise.resolve();
  }
  const store = SvalFavoritesStore.instance;
  Assert.ok(store, "the process's store is made before its document opens");
  const stopping = SvalFavoritesStore.stopShared();
  await within(stopping, 5000, "stopShared to settle");
  Assert.equal(
    await within(starting, 5000, "startFor to settle"),
    store,
    "startFor answers the stopped store"
  );
  Assert.ok(!store.ready, "a stopped store is not ready");
  await Assert.rejects(
    within(store.whenReady(), 5000, "whenReady to settle"),
    e => e.name === "AbortError",
    "whenReady rejects once the store stops"
  );
  await Assert.rejects(
    within(
      store.add({ url: "https://a.example/", title: "A" }),
      5000,
      "an add to settle"
    ),
    e => e.name === "AbortError",
    "an add on a stopped store fails"
  );
});

/**
 * Every file under `dir`, recursively.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function filesUnder(dir) {
  const out = [];
  for (const child of await IOUtils.getChildren(dir)) {
    const { type } = await IOUtils.stat(child);
    out.push(...(type === "directory" ? await filesUnder(child) : [child]));
  }
  return out;
}

/**
 * A document that will not open, because this device's own copy of it
 * cannot be read, fails the store's start and everything waiting on it.
 */
add_task(async function a_failed_open_settles_its_waiters() {
  const root = await makeTempDir("sval-favorites-unreadable");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const deviceId = crypto.getRandomValues(new Uint8Array(16));
  const before = new SvalEngine({ root, keyBytes, deviceId });
  let ownCopy;
  try {
    await before.sync(TREE);
    const treeFiles = new Set(await filesUnder(root));
    const earlier = new SvalFavoritesStore({
      engine: before,
      requestPass: () => {},
    });
    await earlier.start();
    await earlier.add({ url: "https://a.example/", title: "A" });
    await within(earlier.whenIdle(), 10_000, "the first store going idle");
    await before.sync(TREE);
    earlier.stop();
    ownCopy = (await filesUnder(root)).filter(path => !treeFiles.has(path));
    Assert.equal(ownCopy.length, 1, "the device wrote its own Favorites copy");
  } finally {
    before.terminate();
  }

  await SvalTestDeny.read(ownCopy[0]);
  const engine = new SvalEngine({ root, keyBytes, deviceId });
  const store = new SvalFavoritesStore({ engine, requestPass: () => {} });
  try {
    const starting = store.start();
    const adding = store.add({ url: "https://b.example/", title: "B" });
    await Assert.rejects(
      within(starting, 10_000, "start to settle"),
      e => e.reason === "own_file_unreadable",
      "start rejects"
    );
    await Assert.rejects(
      within(store.whenReady(), 5000, "whenReady to settle"),
      e => e.reason === "own_file_unreadable",
      "whenReady rejects with the failure"
    );
    await Assert.rejects(
      within(adding, 5000, "the waiting add to settle"),
      e => e.reason === "own_file_unreadable",
      "an add waiting on the read fails"
    );
  } finally {
    store.stop();
    engine.terminate();
  }

  const failing = new SvalEngine({ root, keyBytes, deviceId });
  const working = new SvalEngine({
    root: await makeTempDir("sval-favorites-retry"),
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  try {
    await Assert.rejects(
      within(SvalFavoritesStore.startFor(failing), 10_000, "startFor to fail"),
      e => e.reason === "own_file_unreadable",
      "the process's store fails to start the same way"
    );
    Assert.ok(
      await within(
        SvalFavoritesStore.startFor(working),
        10_000,
        "the next startFor to settle"
      ),
      "and the next start is not stuck behind it"
    );
  } finally {
    await SvalFavoritesStore.stopShared();
    failing.terminate();
    working.terminate();
    await SvalTestDeny.allow(ownCopy[0]);
  }
});

add_task(async function undo_takes_back_a_change_still_being_written() {
  const { make } = await twoDevices();
  const { engine, store } = await make();
  await store.add({ url: "https://a.example/", title: "A" });
  const adding = store.add({ url: "https://b.example/", title: "B" });
  await store.undo();
  await adding;
  Assert.equal(await outline(engine), ">A", "the later add is undone");
});

/**
 * A pin is not a favorite (decision 0137): the favorite button's questions
 * and its removal read the Favorites root alone.
 */
add_task(async function a_pin_is_not_a_favorite() {
  const { make } = await twoDevices();
  const { store } = await make();
  const url = "https://mail.example/";
  const [pin] = await store.insertTree([], { pins: [{ title: "M", url }] });
  Assert.ok(!store.isFavorite(url), "a pin's address is no favorite");
  Assert.deepEqual(store.favoritesWithUrl(url), []);
  Assert.ok(store.isPinned(pin));

  const favorite = await store.add({ url, title: "M" });
  Assert.ok(favorite, "it can be made a favorite");
  Assert.deepEqual(
    store.favoritesWithUrl(url).map(row => row.guid),
    [favorite]
  );
  await store.removeUrl(url);
  Assert.ok(!store.isFavorite(url), "and taken out of Favorites");
  Assert.ok(store.get(pin), "leaving the pin");
  Assert.deepEqual(
    store.pinsWithUrl(url).map(row => row.guid),
    [pin]
  );
});

/**
 * Move to Favorites puts a pin at the end of Favorites with no scope, and its
 * Undo puts it back in the row at its place with its scope (pins-root spec
 * §6).
 */
add_task(async function move_to_favorites_and_back() {
  const { make } = await twoDevices();
  const { store } = await make();
  await store.insertTree([{ title: "F", url: "https://f.example/" }]);
  const [x, y, z] = await store.insertTree([], {
    pins: ["x", "y", "z"].map(n => ({
      title: n,
      url: `https://${n}.example/`,
    })),
  });
  await store.setPinScope(y, ["ws-1"]);

  const entry = await store.moveToFavorites(y);
  Assert.ok(entry, "the move answers its Undo entry");
  Assert.equal(
    store.children(FAVORITES_ROOT).at(-1).guid,
    y,
    "last of Favorites"
  );
  Assert.ok(!store.isPinned(y), "no pin");
  Assert.equal(store.pinScopeOf(y), null, "with no scope");
  Assert.ok(store.isFavorite("https://y.example/"), "a favorite");
  Assert.deepEqual(
    store.home().map(t => t.guid),
    [x, z]
  );

  Assert.ok(await store.undoChange(entry), "Undo takes it back");
  Assert.deepEqual(
    store.home().map(t => t.guid),
    [x, y, z],
    "at its place"
  );
  Assert.deepEqual(store.pinScopeOf(y), ["ws-1"], "with its scope");
});

/**
 * A folder made of two pins shows in every workspace either pin showed in,
 * and in every workspace when either showed in all (pins spec §7).
 */
add_task(async function a_folder_of_two_pins_shows_where_they_showed() {
  const { make } = await twoDevices();
  const { store } = await make();
  const [x, y, z, w] = await store.insertTree([], {
    pins: ["x", "y", "z", "w"].map(n => ({
      title: n,
      url: `https://${n}.example/`,
    })),
  });
  await store.setPinScope(x, ["ws-2"]);
  await store.setPinScope(w, ["ws-1"]);
  await store.setPinScope(y, ["ws-1", "ws-2"]);

  const both = await store.folderOf(x, y, "Both");
  Assert.deepEqual(
    store.pinScopeOf(both),
    ["ws-1", "ws-2"],
    "the folder shows where either pin did"
  );

  const all = await store.folderOf(z, w, "All");
  Assert.equal(store.pinScopeOf(all), null, "z showed in every workspace");
});

/**
 * A pin dropped on another makes a folder of the two where the other stood,
 * Move Contents to Row puts them back where the folder stood, and Undo takes
 * each back (pins-root spec §5).
 */
add_task(async function a_folder_of_two_pins_and_its_contents_out() {
  const { make } = await twoDevices();
  const { store } = await make();
  const [x, y, z] = await store.insertTree([], {
    pins: ["x", "y", "z"].map(n => ({
      title: n,
      url: `https://${n}.example/`,
    })),
  });
  const row = () => store.home().map(t => t.guid);

  const folder = await store.folderOf(x, z, "Untitled folder");
  Assert.deepEqual(row(), [folder, y], "the folder stands where x stood");
  Assert.equal(store.get(folder).name, "Untitled folder");
  Assert.deepEqual(
    store.children(folder).map(r => r.guid),
    [x, z],
    "holding the pin dropped on, then the pin dropped"
  );

  await store.moveContentsOut(folder);
  Assert.deepEqual(row(), [x, z, y], "its pins stand where it stood");
  Assert.ok(!store.get(folder), "and the folder goes");

  await store.undo();
  Assert.deepEqual(row(), [folder, y], "Undo brings the folder back");
  Assert.deepEqual(
    store.children(folder).map(r => r.guid),
    [x, z]
  );
  await store.undo();
  Assert.deepEqual(row(), [x, y, z], "and Undo of the folder undoes it");
  Assert.ok(!store.get(folder));

  await store.movePin(z, { parentGuid: PINS_ROOT, afterGuid: x });
  Assert.deepEqual(row(), [x, z, y], "a pin moves along the row");
});

/**
 * A pin folder with `names` in it, then the pins `rest`, in the row.
 *
 * @param {object} store
 * @param {string[]} names
 * @param {string[]} rest
 * @returns {Promise<string[]>} the pin folder's guid, its pins', then the
 *   rest's.
 */
function pinFolderAnd(store, names, rest) {
  const pin = n => ({ title: n, url: `https://${n}.example/` });
  return store.insertTree([], {
    pins: [{ title: "F", children: names.map(pin) }, ...rest.map(pin)],
  });
}

/**
 * A move that leaves a pin folder holding one pin removes the pin folder,
 * the pin left standing where it stood, in the same change; Undo puts the
 * pin folder back with its scope and both pins.
 */
add_task(async function a_pin_folder_left_with_one_pin_goes() {
  const { make } = await twoDevices();
  const { store } = await make();
  const [folder, x, y, z] = await pinFolderAnd(store, ["x", "y"], ["z"]);
  await store.setPinScope(folder, ["ws-1"]);
  const row = () => store.home().map(t => t.guid);

  await store.movePin(x, { parentGuid: PINS_ROOT, afterGuid: z });
  Assert.deepEqual(row(), [y, z, x], "y stands where the pin folder stood");
  Assert.ok(!store.get(folder), "and the pin folder goes");

  await store.undo();
  Assert.deepEqual(row(), [folder, z], "Undo brings the pin folder back");
  Assert.deepEqual(
    store.children(folder).map(r => r.guid),
    [x, y],
    "holding both pins in order"
  );
  Assert.deepEqual(store.pinScopeOf(folder), ["ws-1"], "with its scope");
});

/**
 * A move that takes a pin folder's last pin out removes the pin folder, and
 * Undo puts it back holding the pin. Move to Favorites does the same.
 */
add_task(async function a_pin_folder_left_empty_goes() {
  const { make } = await twoDevices();
  const { store } = await make();
  const [folder, x, z] = await pinFolderAnd(store, ["x"], ["z"]);
  const row = () => store.home().map(t => t.guid);

  await store.movePin(x, { parentGuid: PINS_ROOT });
  Assert.deepEqual(row(), [z, x]);
  Assert.ok(!store.get(folder), "the pin folder goes");
  await store.undo();
  Assert.deepEqual(row(), [folder, z], "Undo brings it back");
  Assert.deepEqual(
    store.children(folder).map(r => r.guid),
    [x]
  );

  const entry = await store.moveToFavorites(x);
  Assert.equal(store.get(x).parentGuid, FAVORITES_ROOT, "x is a favorite");
  Assert.ok(!store.get(folder), "and the pin folder goes");
  Assert.ok(await store.undoChange(entry), "Undo takes it back");
  Assert.deepEqual(row(), [folder, z]);
  Assert.deepEqual(
    store.children(folder).map(r => r.guid),
    [x]
  );
});

/**
 * A pin dragged out of a pin folder onto a pin makes a pin folder of the two,
 * and the pin folder left with one pin goes in the same change.
 */
add_task(async function a_pin_folder_left_by_a_new_pin_folder_goes() {
  const { make } = await twoDevices();
  const { store } = await make();
  const [folder, x, y, z] = await pinFolderAnd(store, ["x", "y"], ["z"]);
  const row = () => store.home().map(t => t.guid);

  const made = await store.folderOf(z, y, "Two");
  Assert.deepEqual(row(), [x, made], "x stands where the pin folder stood");
  Assert.ok(!store.get(folder), "and the pin folder goes");
  Assert.deepEqual(
    store.children(made).map(r => r.guid),
    [z, y]
  );

  await store.undo();
  Assert.deepEqual(row(), [folder, z], "Undo puts both back");
  Assert.deepEqual(
    store.children(folder).map(r => r.guid),
    [x, y]
  );
  Assert.ok(!store.get(made));
});

/**
 * A pin folder left holding two pins stays, as does one a move inside it
 * leaves as it was, and an empty pin folder no move touches.
 */
add_task(async function a_pin_folder_holding_more_stays() {
  const { make } = await twoDevices();
  const { store } = await make();
  const [folder, x, y, w] = await pinFolderAnd(store, ["x", "y", "w"], []);
  const empty = await store.newFolder(PINS_ROOT, "Empty");

  await store.movePin(w, { parentGuid: folder, beforeGuid: x });
  Assert.deepEqual(
    store.children(folder).map(r => r.guid),
    [w, x, y],
    "a move inside the pin folder keeps it"
  );
  await store.movePin(x, { parentGuid: PINS_ROOT });
  Assert.deepEqual(
    store.children(folder).map(r => r.guid),
    [w, y],
    "two pins left keep it"
  );
  Assert.ok(store.get(empty), "and the empty pin folder stays");
});

/**
 * An engine holding `rows` as the favorites document, recording each batch
 * the store writes. The pass's moves are the engine's own, which its tests
 * cover (`pins.rs`); here the batch clears the marks as the pass does.
 *
 * @param {object[]} rows As `SvalEngine.favorites` answers them.
 * @returns {object}
 */
function engineHolding(rows) {
  return {
    batches: [],
    async openDocument() {},
    requestPass() {},
    async favorites() {
      return rows.map(row => ({ ...row }));
    },
    async favoriteId(guid) {
      return `id-${guid}`;
    },
    async mutate({ ops }) {
      this.batches.push(ops);
      for (const op of ops) {
        if (op.kind === "addFavorite") {
          rows.push({
            id: `id-${op.guid}`,
            kind: op.favoriteKind,
            guid: op.guid,
            parent: op.parent ?? null,
            name: op.name,
          });
        } else if (op.kind === "movePinsToRoot") {
          rows.forEach(row => (row.pinned = false));
        }
      }
    },
  };
}

/**
 * A profile from before the pins root has its pins moved into it once, as
 * the store starts, in the same write as any root it lacks (pins-root spec
 * §8). Starting again with no pin marked writes nothing.
 */
add_task(async function a_profiles_pins_are_moved_as_the_store_starts() {
  const root = guid => ({ id: `id-${guid}`, kind: "folder", guid, name: "" });
  const rows = [
    root("toolbar_____"),
    root("menu________"),
    root("unfiled_____"),
    {
      id: "id-pinAAAAAAAAA",
      kind: "favorite",
      guid: "pinAAAAAAAAA",
      parent: "id-toolbar_____",
      name: "A",
      url: "https://a.example/",
      pinned: true,
    },
  ];
  const engine = engineHolding(rows);
  let store = new SvalFavoritesStore({ engine, requestPass: () => {} });
  await store.start();
  Assert.deepEqual(
    engine.batches.map(ops => ops.map(op => op.guid ?? op.kind)),
    [[PINS_ROOT, "movePinsToRoot"]],
    "the pins root and the pass are one write, the root first"
  );
  store.stop();

  store = new SvalFavoritesStore({ engine, requestPass: () => {} });
  await store.start();
  Assert.equal(engine.batches.length, 1, "starting again writes nothing");
  store.stop();
});
