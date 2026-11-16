/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Each device's icons for the workspace tree's tabs, kept beside the
 * favorites' (`SvalFavoriteIcons`): an icon is kept for an address a tab
 * holds, through a restart, and goes when a read of the tree holds no tab
 * there. A read with no tab in it prunes nothing.
 */

const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalFavoriteIconStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoriteIcons.sys.mjs"
);

do_get_profile();

const NEWS = "https://news.example/";
const MAIL = "https://mail.example/inbox";
const ICON = "data:image/png;base64,iVBORw0KGgo=";
const OTHER_ICON = "data:image/png;base64,R0lGODlh";

/**
 * A tree in the shape `SvalEngine.tree` reads, with a tab at each address.
 *
 * @param {...string} urls
 * @returns {object} Its `nodes` map.
 */
function treeWith(...urls) {
  const nodes = { w: { kind: "workspace", content: { name: "W" } } };
  urls.forEach((url, i) => {
    nodes[`t${i}`] = { kind: "tab", content: { name: "T", url } };
  });
  return nodes;
}

async function loadedStore(path = tempPath("sval-tab-icons", ".json")) {
  const icons = new SvalFavoriteIconStore({ path });
  await icons.load();
  return icons;
}

add_task(async function a_tab_icon_lasts_a_restart() {
  const path = tempPath("sval-tab-icons", ".json");
  const first = await loadedStore(path);
  first.onTree(treeWith(NEWS));
  first.rememberTab(NEWS, ICON);
  Assert.equal(first.iconFor(NEWS), ICON, "kept for the tab's address");
  await first.flush();
  const second = await loadedStore(path);
  Assert.equal(second.iconFor(NEWS), ICON, "and read back");
});

add_task(async function nothing_is_kept_for_an_address_no_tab_holds() {
  const icons = await loadedStore();
  icons.rememberTab(NEWS, ICON);
  Assert.equal(icons.iconFor(NEWS), null, "nothing before a read of the tree");
  icons.onTree(treeWith(MAIL));
  icons.rememberTab(NEWS, ICON);
  Assert.equal(icons.iconFor(NEWS), null, "nothing for a page no tab holds");
});

add_task(async function an_icon_set_before_its_tab_is_read_is_kept_after() {
  const icons = await loadedStore();
  icons.onTree(treeWith(MAIL));
  icons.rememberTab(NEWS, ICON);
  icons.onTree(treeWith(MAIL, "https://other.example/"));
  Assert.equal(icons.iconFor(NEWS), null, "not while no read holds it");
  icons.onTree(treeWith(NEWS));
  Assert.equal(icons.iconFor(NEWS), ICON, "kept once a read holds it");
});

add_task(async function closing_the_last_tab_at_an_address_drops_its_icon() {
  const icons = await loadedStore();
  icons.onTree(treeWith(NEWS, NEWS, MAIL));
  icons.rememberTab(NEWS, ICON);
  icons.rememberTab(MAIL, OTHER_ICON);
  icons.onTree(treeWith(NEWS, MAIL));
  Assert.equal(icons.iconFor(NEWS), ICON, "another tab still holds it");
  icons.onTree(treeWith(MAIL));
  Assert.equal(icons.iconFor(NEWS), null, "the last one took its icon");
  Assert.equal(icons.iconFor(MAIL), OTHER_ICON, "the open tab's stays");
});

add_task(async function a_read_with_no_tab_prunes_nothing() {
  const icons = await loadedStore();
  icons.onTree(treeWith(NEWS));
  icons.rememberTab(NEWS, ICON);
  icons.onTree(treeWith());
  Assert.equal(icons.iconFor(NEWS), ICON, "an empty tree keeps every icon");
});

add_task(async function a_file_read_after_the_tree_is_pruned_by_it() {
  const path = tempPath("sval-tab-icons", ".json");
  const first = await loadedStore(path);
  first.onTree(treeWith(NEWS, MAIL));
  first.rememberTab(NEWS, ICON);
  first.rememberTab(MAIL, OTHER_ICON);
  await first.flush();
  const second = new SvalFavoriteIconStore({ path });
  second.onTree(treeWith(MAIL));
  await second.load();
  Assert.equal(second.iconFor(NEWS), null, "a closed tab's icon is not read");
  Assert.equal(second.iconFor(MAIL), OTHER_ICON, "an open tab's is");
});

add_task(async function a_favorite_icon_outlasts_its_tab() {
  const icons = await loadedStore();
  icons.onTree(treeWith(NEWS));
  icons.remember(NEWS, ICON);
  icons.onTree(treeWith(MAIL));
  Assert.equal(icons.iconFor(NEWS), ICON, "a favorite's icon is not a tab's");
});

add_task(async function the_engine_tree_names_its_tabs_addresses() {
  const engine = new SvalEngine({
    root: await makeTempDir("sval-tab-icons"),
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => engine.terminate());
  const workspace = crypto.randomUUID();
  await engine.mutate({
    kind: "addWorkspace",
    name: "W",
    id: workspace,
    now: Date.now(),
  });
  await engine.mutate({
    kind: "addTab",
    parent: workspace,
    name: "News",
    url: NEWS,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  const icons = await loadedStore();
  icons.onTree((await engine.tree()).nodes);
  icons.rememberTab(NEWS, ICON);
  Assert.equal(icons.iconFor(NEWS), ICON, "the tree's tab holds the address");
});
