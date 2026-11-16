/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from shared_folder_head.js */

/**
 * An address no other device may open stays in this device's copy (decision
 * 1372): tabs and favorites at one never reach the shared folder, come back
 * when their address goes back to a web page's, and one another device wrote
 * anyway is held and never offered.
 */

const { SvalFavoritesStore, FAVORITES_ROOT } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
);

/**
 * Two devices with profiles of their own and one shared folder.
 *
 * @param {string} name
 * @returns {Promise<object>} `{ shared, keyBytes, here, there }`, each device
 *   an engine.
 */
async function twoDevices(name) {
  const first = await device(name);
  const engineOf = async () =>
    first.make({
      root: await makeTempDir(`sval-${name}-profile`),
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
  return {
    shared: first.shared,
    keyBytes: first.keyBytes,
    here: await engineOf(),
    there: await engineOf(),
  };
}

/**
 * @param {object} engine
 * @param {string} id
 * @returns {Promise<object|undefined>} the node `id` in `engine`'s tree.
 */
async function nodeOf(engine, id) {
  return (await engine.tree()).nodes[id];
}

add_task(async function a_tab_at_a_file_leaves_the_peer_and_comes_back() {
  const { here, there } = await twoDevices("local-tab");
  const ws = await here.mutate({ kind: "addWorkspace", name: "W", now: 1000 });
  const tab = await here.mutate({
    kind: "addTab",
    parent: ws,
    name: "Report",
    url: "https://example.com/report",
    now: 1000,
  });
  await here.sync(WORKSPACE, 2000);
  await there.sync(WORKSPACE, 2100);
  const order = (await nodeOf(there, tab)).placement.order;

  await here.mutate({
    kind: "setContent",
    id: tab,
    name: "Report",
    url: "file:///Users/me/report.pdf",
    now: 3000,
  });
  await here.sync(WORKSPACE, 3100);
  await there.sync(WORKSPACE, 3200);
  Assert.equal(await nodeOf(there, tab), undefined, "gone from the peer");
  const kept = await nodeOf(here, tab);
  Assert.equal(kept.content.url, "file:///Users/me/report.pdf");
  Assert.ok(kept.content.local, "kept here, marked local");

  await here.mutate({
    kind: "setContent",
    id: tab,
    name: "Report",
    url: "https://example.com/report#2",
    now: 4000,
  });
  await here.sync(WORKSPACE, 4100);
  await there.sync(WORKSPACE, 4200);
  const back = await nodeOf(there, tab);
  Assert.equal(back?.content.url, "https://example.com/report#2");
  Assert.equal(back.placement.order, order, "back at its place");
  Assert.ok(!back.content.local);
});

// One clock for every write and pass, each reading later than the last, so
// what a pass publishes is never stamped after it.
let tick = Date.now();
const clock = () => (tick += 1000);

/**
 * A device's Favorites over `engine`.
 *
 * @param {object} engine
 * @returns {Promise<object>} the started store.
 */
async function favoritesOf(engine) {
  const store = new SvalFavoritesStore({
    engine,
    requestPass: () => {},
    now: clock,
  });
  registerCleanupFunction(() => store.stop());
  await store.start();
  return store;
}

/**
 * One pass of `engine` and its Favorites.
 *
 * @param {object} engine
 * @param {object} store
 */
async function pass(engine, store) {
  await engine.sync(WORKSPACE, clock());
  await within(store.whenIdle(), 10_000, "store going idle");
}

add_task(async function a_local_favorite_never_reaches_the_peer() {
  const { here, there } = await twoDevices("local-favorite");
  const mine = await favoritesOf(here);
  const theirs = await favoritesOf(there);
  const notes = await mine.add({
    url: "file:///Users/me/notes.html",
    title: "Notes",
  });
  const web = await mine.add({ url: "https://example.com/", title: "Web" });
  await pass(here, mine);
  await pass(there, theirs);

  Assert.ok(mine.get(notes).local, "marked local here");
  Assert.ok(!mine.get(notes).refused, "and opened here");
  Assert.equal(theirs.get(notes), null, "never on the peer");
  Assert.ok(theirs.get(web), "beside one that is");

  await mine.setAddress(web, "file:///Users/me/web.html");
  await pass(here, mine);
  await pass(there, theirs);
  Assert.equal(theirs.get(web), null, "an address edited to a file leaves");

  await mine.setAddress(web, "https://example.com/again");
  await pass(here, mine);
  await pass(there, theirs);
  Assert.equal(theirs.get(web)?.url, "https://example.com/again");
  Assert.equal(theirs.get(web).parentGuid, FAVORITES_ROOT, "in its folder");
});

add_task(async function a_peers_address_that_stays_on_a_device_is_held() {
  const { shared, keyBytes, here } = await twoDevices("refused-favorite");
  // A peer whose profile is the shared folder publishes its whole copy,
  // local marks included, as a damaged or hostile device would.
  const planter = new SvalEngine({
    root: shared,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => planter.terminate());
  const planted = await favoritesOf(planter);
  const mine = await favoritesOf(here);
  const folder = await planted.newFolder(FAVORITES_ROOT, "Planted");
  const bad = await planted.add({
    url: "chrome://browser/content/browser.xhtml",
    title: "Bad",
    parentGuid: folder,
  });
  const good = await planted.add({
    url: "https://example.com/",
    title: "Good",
    parentGuid: folder,
  });
  // A pin of the same address, as the planter could pin one.
  await planted.insertTree([], {
    pins: [{ title: "Bad", url: "chrome://browser/content/browser.xhtml" }],
  });
  await pass(planter, planted);
  await pass(here, mine);

  const row = mine.get(bad);
  Assert.ok(row, "held in the document");
  Assert.ok(row.refused && !row.local, "and refused");
  Assert.deepEqual(
    mine.children(folder).map(r => r.guid),
    [bad, good],
    "the menu's reader lists it"
  );
  Assert.deepEqual(
    mine.favoritesIn(folder).map(r => r.guid),
    [good],
    "Open All leaves it out"
  );
  Assert.ok(!mine.isFavorite("chrome://browser/content/browser.xhtml"));
  Assert.deepEqual(mine.home(), [], "no pin and no home tile");

  await mine.rename(bad, "Renamed");
  Assert.ok(mine.get(bad).refused, "a rename sends its address back unmarked");
  await mine.delete(bad);
  Assert.equal(mine.get(bad), null, "Delete removes it");
  await mine.undo();
  Assert.ok(mine.get(bad)?.refused, "and Undo puts it back still refused");
  Assert.deepEqual(mine.home(), [], "and no pin");
});

add_task(async function a_peers_tab_stays_refused_when_its_address_is_resent() {
  const { shared, keyBytes, here } = await twoDevices("refused-tab");
  const planter = new SvalEngine({
    root: shared,
    keyBytes,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => planter.terminate());
  const ws = await planter.mutate({
    kind: "addWorkspace",
    name: "W",
    now: 1000,
  });
  const url = "chrome://browser/content/browser.xhtml";
  const tab = await planter.mutate({
    kind: "addTab",
    parent: ws,
    name: "Planted",
    url,
    now: 1000,
  });
  await planter.sync(WORKSPACE, 2000);
  await here.sync(WORKSPACE, 3000);
  Assert.ok(!(await nodeOf(here, tab)).content.local, "read unmarked");

  // A title arriving for the page the node holds sends its address back.
  await here.mutate({
    kind: "setContent",
    id: tab,
    name: "Titled",
    url,
    now: 4000,
  });
  const held = (await nodeOf(here, tab)).content;
  Assert.equal(held.name, "Titled");
  Assert.ok(!held.local, "and stays unmarked, so it never opens");
});

/**
 * A join publishes this device's nodes under the new key and checks the
 * folder holds them before it stores the key. A tab whose address stays on
 * this device never reaches the folder, so the join asks only for the rest,
 * and the tab is still this device's afterwards.
 */
add_task(async function a_join_with_a_tab_that_stays_here_is_adopted() {
  const { SvalKeyJoin } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalKeyJoin.sys.mjs"
  );
  const { SvalIdentity } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
  );
  const { SvalSecretStore, MemoryKeyStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
  );
  const previous = {
    path: SvalIdentity.path,
    localKeyPath: SvalIdentity.localKeyPath,
    secrets: SvalSecretStore.path,
    keyStore: SvalSecretStore.keyStore,
  };
  const dir = await makeTempDir("sval-local-join-identity");
  SvalIdentity.path = PathUtils.join(dir, "sval-identity.json");
  SvalIdentity.localKeyPath = PathUtils.join(dir, "sval-local-key");
  SvalSecretStore.path = PathUtils.join(dir, "sval-secrets.json");
  SvalSecretStore.keyStore = new MemoryKeyStore();
  SvalIdentity.forgetCachedValues();
  registerCleanupFunction(() => {
    SvalIdentity.path = previous.path;
    SvalIdentity.localKeyPath = previous.localKeyPath;
    SvalSecretStore.path = previous.secrets;
    SvalSecretStore.keyStore = previous.keyStore;
    SvalIdentity.forgetCachedValues();
  });

  const { make } = await device("local-join");
  const engine = make({ root: await makeTempDir("sval-local-join-profile") });
  const ws = await engine.mutate({
    kind: "addWorkspace",
    name: "W",
    now: Date.now(),
  });
  const tab = await engine.mutate({
    kind: "addTab",
    parent: ws,
    name: "Report",
    url: "file:///Users/me/report.pdf",
    now: Date.now(),
  });
  Assert.ok((await nodeOf(engine, tab)).content.local, "the tab stays here");
  await engine.sync(WORKSPACE, Date.now(), { shared: "wait" });

  const joined = await SvalKeyJoin.join(
    engine,
    crypto.getRandomValues(new Uint8Array(32))
  );
  Assert.equal(joined.outcome, "adopted", `the join landed: ${joined.reason}`);
  Assert.ok(await nodeOf(engine, tab), "and the tab is still this device's");
});
