/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* `SvalPanel` is a global of the chrome window, declared by a classic script
 * the window loads, so this file cannot import it. */
/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/* exported pinsSetup, pinFavorite, pinsFolder, tileOf, pinTabs, clickTile,
   selectedPinGuid, untilPinShows, rowGuids, closePinPages, tabNodes,
   LINKS_PAGE, TOOLBAR, PINS, SvalPinPages, pinsFixture, showWorkspace,
   forgetFavorites */

/**
 * The pins row (pins spec) in a real window: the window's own panel, engine,
 * settings and tab observer, as its startup made them, with the profile's
 * Favorites, which the row and the Favorites menu read. Each file loads this
 * with `loadSubScript`.
 */

const { SvalPinPages } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPinPages.sys.mjs"
);
const { isPin } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPinTab.sys.mjs"
);

const {
  FAVORITES_ROOT: TOOLBAR,
  PINS_ROOT: PINS,
  SvalFavoritesStore: Favorites,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
);

/** A page of links, among them one within its site and one to another. */
const LINKS_PAGE = ROOT + "sval_quick_peek_links.html";

/** What the setup made: `{ engine, settings, store, home, work }`. */
const pinsFixture = {};

/**
 * Shows the workspace `id` in this window, through the switcher's own
 * switch, once the observer has filed what the switch opened.
 *
 * @param {string} id
 */
async function showWorkspace(id) {
  await within(
    SvalWindowWorkspace.of(window).switchTo(id),
    10_000,
    "the workspace switch"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
}

/**
 * Adds two workspaces, "Home" and "Work", to the window's own document and
 * shows Home. The profile's startup workspace stays beside them, and the
 * window goes back to it when the file ends, before Known Good puts the
 * document back.
 */
async function pinsSetup() {
  const engine = SvalPanel.engine;
  const store = await within(
    Favorites.startFor(engine),
    10_000,
    "the profile's Favorites"
  );
  const started = SvalWindowWorkspace.of(window).id;
  const add = name =>
    engine.mutate({
      kind: "addWorkspace",
      name,
      id: crypto.randomUUID(),
      now: Date.now(),
    });
  const home = await add("Home");
  const work = await add("Work");
  expectWorkspaceTabs();
  await showWorkspace(home);
  Object.assign(pinsFixture, {
    engine,
    settings: SvalPanel.settings,
    store,
    home,
    work,
  });

  registerCleanupFunction(async () => {
    closePinPages();
    if (started) {
      await showWorkspace(started);
      await releaseHiddenWorkspaces();
    }
  });
}

/** Closes every pin's page in the window, as a task's end must. */
function closePinPages() {
  for (const tab of Array.from(gBrowser.tabs)) {
    if (isPin(tab)) {
      gBrowser.removeTab(tab, {
        animate: false,
        skipSessionStore: true,
        closeWindowWithLastTab: false,
      });
    }
  }
}

/**
 * Deletes every favorite and pin the running task files at the top of
 * Favorites or of the row when it ends, with their pages, and leaves the
 * profile's own.
 */
function forgetFavorites() {
  const { store } = pinsFixture;
  const tops = () => [...store.children(TOOLBAR), ...store.children(PINS)];
  const before = new Set(tops().map(row => row.guid));
  atTaskEnd(async () => {
    closePinPages();
    for (const row of tops()) {
      if (!before.has(row.guid)) {
        await store.delete(row.guid);
      }
    }
  });
}

/**
 * A pin of `url` at the end of the row, or at the end of the pinned folder
 * `parentGuid`, or with `pin` false a favorite at the end of Favorites,
 * deleted when the task ends, with its page.
 *
 * @param {string} url
 * @param {string} title
 * @param {object} [options]
 * @param {string} [options.parentGuid]
 * @param {boolean} [options.pin]
 * @returns {Promise<string>} its guid.
 */
async function pinFavorite(url, title, { parentGuid = null, pin = true } = {}) {
  const { store } = pinsFixture;
  const entry = { url, title };
  const [guid] =
    pin && !parentGuid
      ? await store.insertTree([], { pins: [entry] })
      : await store.insertTree([entry], { parentGuid: parentGuid ?? TOOLBAR });
  atTaskEnd(async () => {
    closePinPages();
    await store.delete(guid);
  });
  return guid;
}

/**
 * An empty folder at the end of the row, deleted when the task ends with
 * whatever is in it.
 *
 * @param {string} title
 * @returns {Promise<string>} its guid.
 */
async function pinsFolder(title) {
  const { store } = pinsFixture;
  const [guid] = await store.insertTree([], {
    pins: [{ title, children: [] }],
  });
  atTaskEnd(async () => {
    closePinPages();
    await store.delete(guid);
  });
  return guid;
}

/**
 * @param {string} guid
 * @returns {Element|null} the pin's tile in the row.
 */
function tileOf(guid) {
  return SvalPanel._els.pins.querySelector(
    `button.sval-pin[data-key="pin:${guid}"]`
  );
}

/** @returns {string[]} the guids of the row's tiles, in order. */
function rowGuids() {
  return Array.from(
    SvalPanel._els.pins.querySelectorAll("button.sval-pin[data-key^='pin:']")
  ).map(tile => tile.dataset.key.slice(4));
}

/**
 * Waits until the pin's tile is in the row.
 *
 * @param {string} guid
 * @returns {Promise<Element>}
 */
async function untilPinShows(guid) {
  await TestUtils.waitForCondition(() => tileOf(guid), "the pin's tile shows");
  return tileOf(guid);
}

/** @returns {object[]} the window's pin pages. */
function pinTabs() {
  return Array.from(gBrowser.tabs).filter(tab => isPin(tab));
}

/** @returns {string|null} the pin whose page the window shows. */
function selectedPinGuid() {
  return SvalPinPages.of(window)?.selectedGuid ?? null;
}

/**
 * Clicks a pin's tile and waits for its page to show `url`.
 *
 * @param {string} guid
 * @param {string} url
 * @returns {Promise<object>} the page's tab.
 */
async function clickTile(guid, url) {
  const tile = await untilPinShows(guid);
  EventUtils.synthesizeMouseAtCenter(tile, {});
  await TestUtils.waitForCondition(
    () =>
      selectedPinGuid() === guid &&
      gBrowser.selectedBrowser.currentURI.spec === url &&
      !gBrowser.selectedTab.hasAttribute("busy"),
    "the pin's page shows"
  );
  return gBrowser.selectedTab;
}

/** @returns {Promise<object[]>} the tree's tab nodes, once settled. */
async function tabNodes() {
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const nodes = (await SvalPanel.engine.tree()).nodes ?? {};
  return Object.values(nodes).filter(node => node.kind === "tab");
}
