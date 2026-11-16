/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* exported importedTree, emptyFavorites, importedFavorites */

/**
 * A harvest imported into a real engine, read back as the user's tree. Shared
 * by the import tests that assert what lands in the document.
 */

const { makeTempDir: makeImportDir } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;
const { SvalEngine: ImportEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { runImport: runImportInto } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalImport.sys.mjs"
);
const { SPLIT, TAB, childrenByParent } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const { SvalFavoritesStore: ImportFavorites } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
);

/**
 * Favorites over an engine of their own, empty.
 *
 * @returns {Promise<object>} The `SvalFavoritesStore`.
 */
async function emptyFavorites() {
  const engine = new ImportEngine({
    root: await makeImportDir("sval-import-favorites"),
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => engine.terminate());
  const store = new ImportFavorites({ engine });
  await store.start();
  registerCleanupFunction(() => store.stop());
  return store;
}

/**
 * Imports the bookmarks of `harvest`, and no window, into empty Favorites.
 *
 * @param {object} harvest A reader's `Harvest`.
 * @param {string} source The reader's `source` key.
 * @returns {Promise<{store: object, report: object}>}
 */
async function importedFavorites(harvest, source) {
  const store = await emptyFavorites();
  const report = await runImportInto(
    [
      {
        browser: {
          source,
          profiles: [{ source, id: "Default", name: null, dir: "/nowhere" }],
        },
        harvest,
        windows: [],
        bookmarks: "favorites",
        bookmarksName: source,
        history: false,
      },
    ],
    { engine: { mutate: async () => null }, favorites: store }
  );
  Assert.deepEqual(report.failed, [], "the favorites took the import");
  return { store, report };
}

/**
 * Imports every window of `harvest`, and no bookmarks, into a fresh engine.
 *
 * @param {object} harvest A reader's `Harvest`.
 * @param {string} source The reader's `source` key.
 * @returns {Promise<Array<Array<string|object>>>} Each imported workspace's
 *   children in order: a tab as its URL, a group as `{ group, children }`, a
 *   split as `{ split, shares, panes }`, `split` being its name and `panes`
 *   its tabs' URLs.
 */
async function importedTree(harvest, source) {
  const engine = new ImportEngine({
    root: await makeImportDir("sval-import-engine"),
    keyBytes: crypto.getRandomValues(new Uint8Array(32)),
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  const report = await runImportInto(
    [
      {
        browser: {
          source,
          profiles: [{ source, id: "Default", name: null, dir: "/nowhere" }],
        },
        harvest,
        windows: harvest.windows.map(win => ({
          import: true,
          name: win.name ?? "",
        })),
        bookmarks: "none",
        history: false,
      },
    ],
    { engine }
  );
  Assert.deepEqual(report.failed, [], "the engine took the import's batch");
  const { nodes } = await engine.tree();
  const byParent = childrenByParent(nodes);
  const describe = id => {
    const { kind, content } = nodes[id];
    if (kind === TAB) {
      return content.url;
    }
    const children = byParent.get(id) ?? [];
    return kind === SPLIT
      ? {
          split: content.name ?? "",
          shares: content.shares ?? null,
          panes: children.map(describe),
        }
      : { group: content.name ?? "", children: children.map(describe) };
  };
  return report.workspaces.map(id => (byParent.get(id) ?? []).map(describe));
}
