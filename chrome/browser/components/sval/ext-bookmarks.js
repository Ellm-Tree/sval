/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* globals EventEmitter, EventManager, ExtensionAPIPersistent, ExtensionUtils */

/**
 * The WebExtension `bookmarks` API over Sval's Favorites, the engine's
 * `favorites` document (favorites-native spec §8). Sval's `jar.mn` overrides
 * Firefox's `ext-bookmarks.js` with this file; Firefox's schema, permission
 * and install prompt stay as they are.
 *
 * Every ext-*.js script shares one global (`ExtensionCommon`'s
 * `_createExtGlobal`), so everything but `bookmarks` lives in this block.
 */
{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    FAVORITES_CHANGED_TOPIC:
      "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
    FAVORITES_ROOT:
      "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
    importableUrl: "moz-src:///browser/components/sval/SvalImportModel.sys.mjs",
    PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
    PINS_ROOT: "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
    ROOT_GUIDS: "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
    SvalFavoritesStore:
      "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
    normalUrl: "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  });

  const { ExtensionError } = ExtensionUtils;

  /**
   * The parent of every root, which the document does not hold: the API
   * reports it as Places does, parentless and read-only.
   */
  const TREE_ROOT = "root________";

  /** Places' mobile root, which Sval keeps no favorites in. */
  const MOBILE_ROOT = "mobile______";

  /** The roots under `TREE_ROOT`, in Places' order among its children. */
  const TOP = ["menu________", "toolbar_____", "unfiled_____", MOBILE_ROOT];

  /** The URL Places reports for a separator. */
  const SEPARATOR_URL = "data:";

  const API_TYPES = new Map([
    ["favorite", "bookmark"],
    ["folder", "folder"],
    ["separator", "separator"],
  ]);

  /** How deep a tree is walked, as the store walks one. */
  const MAX_DEPTH = 64;

  const ROOT_ERROR = "The bookmark root cannot be modified";
  const NOT_FOUND = "No bookmarks found for the provided GUID";

  /**
   * The process's Favorites, once they are read. They start with the
   * profile's engine, which an extension's background page may beat.
   *
   * @returns {Promise<object>} The store.
   */
  async function favorites() {
    for (;;) {
      const store = lazy.SvalFavoritesStore.instance;
      if (store) {
        await store.whenReady();
        return store;
      }
      await new Promise(resolve => {
        const seen = () => {
          Services.obs.removeObserver(seen, lazy.FAVORITES_CHANGED_TOPIC);
          resolve();
        };
        Services.obs.addObserver(seen, lazy.FAVORITES_CHANGED_TOPIC);
      });
    }
  }

  /**
   * A row for each place the document does not hold, dated as Favorites.
   *
   * @param {object} store
   * @param {string} guid `TREE_ROOT` or `MOBILE_ROOT`.
   * @returns {object}
   */
  function syntheticRow(store, guid) {
    const at = store.get(lazy.FAVORITES_ROOT).added;
    return {
      guid,
      kind: "folder",
      parentGuid: guid === TREE_ROOT ? null : TREE_ROOT,
      index: guid === TREE_ROOT ? 0 : TOP.indexOf(guid),
      name: "",
      url: null,
      added: at,
      contentAt: at,
      placementAt: at,
    };
  }

  /**
   * Whether `guid` is the pins root or a pin, which the API never shows: a
   * pin is not a favorite (decision 0137).
   *
   * @param {Function} get Answers a row by guid.
   * @param {string} guid
   * @returns {boolean}
   */
  function isPinIn(get, guid) {
    for (let row = get(guid), d = 0; row && d < MAX_DEPTH; d++) {
      if (row.guid === lazy.PINS_ROOT) {
        return true;
      }
      row = row.parentGuid ? get(row.parentGuid) : null;
    }
    return false;
  }

  /**
   * @param {object} store
   * @param {string} guid
   * @returns {boolean} Whether the API hides `guid` ({@link isPinIn}).
   */
  function hidden(store, guid) {
    return isPinIn(g => store.get(g), guid);
  }

  /**
   * @param {object} store
   * @param {string} guid
   * @returns {object|null} The row for `guid`, a root's as the API places it.
   */
  function rowOf(store, guid) {
    if (guid === TREE_ROOT || guid === MOBILE_ROOT) {
      return syntheticRow(store, guid);
    }
    if (hidden(store, guid)) {
      return null;
    }
    const row = store.get(guid);
    if (row && TOP.includes(guid)) {
      return { ...row, parentGuid: TREE_ROOT, index: TOP.indexOf(guid) };
    }
    return row;
  }

  /**
   * @param {object} store
   * @param {string} guid A folder.
   * @returns {object[]} Its children, in order, the roots' as the API
   *   places them.
   */
  function childrenOf(store, guid) {
    if (guid === TREE_ROOT) {
      return TOP.map(root => rowOf(store, root));
    }
    return store.children(guid);
  }

  /**
   * The latest stamp among a folder's children's names and places, or the
   * folder's own date for an empty one (spec §8.3).
   *
   * @param {object} store
   * @param {object} row A folder.
   * @returns {number}
   */
  function groupModified(store, row) {
    let at = row.added;
    for (const child of childrenOf(store, row.guid)) {
      at = Math.max(at, child.contentAt, child.placementAt);
    }
    return at;
  }

  /**
   * @param {object} store
   * @param {object} row A root under `TREE_ROOT`.
   * @returns {string} Its name: Favorites as the store names it, the others
   *   as Places does.
   */
  function rootTitle(store, row) {
    return row.guid === lazy.FAVORITES_ROOT
      ? store.folders()[0].title
      : lazy.PlacesUtils.bookmarks.getLocalizedTitle({
          guid: row.guid,
          title: row.name,
        });
  }

  /**
   * A `BookmarkTreeNode` for `row`, without children.
   *
   * @param {object|null} store Null for a removed row, which has no folder
   *   date, as Places reports none.
   * @param {object} row
   * @returns {object}
   */
  function nodeOf(store, row) {
    const node = {
      id: row.guid,
      title: store && TOP.includes(row.guid) ? rootTitle(store, row) : row.name,
      index: row.index,
      dateAdded: row.added,
      type: API_TYPES.get(row.kind),
    };
    if (row.parentGuid) {
      node.parentId = row.parentGuid;
    }
    if (row.kind === "favorite") {
      node.url = row.url;
    } else if (row.kind === "separator") {
      node.url = SEPARATOR_URL;
    } else if (store) {
      node.dateGroupModified = groupModified(store, row);
    }
    return node;
  }

  /**
   * @param {object} store
   * @param {object} row
   * @param {number} depth
   * @returns {object} `row`'s node, a folder's with its children.
   */
  function treeOf(store, row, depth = 0) {
    const node = nodeOf(store, row);
    if (row.kind === "folder") {
      node.children =
        depth < MAX_DEPTH
          ? childrenOf(store, row.guid).map(child =>
              treeOf(store, child, depth + 1)
            )
          : [];
    }
    return node;
  }

  /**
   * Every favorite, folder and separator below the roots, depth first in
   * order.
   *
   * @param {object} store
   * @returns {object[]}
   */
  function everyRow(store) {
    const out = [];
    const walk = (guid, depth) => {
      for (const row of store.children(guid)) {
        out.push(row);
        if (depth < MAX_DEPTH) {
          walk(row.guid, depth + 1);
        }
      }
    };
    for (const root of lazy.ROOT_GUIDS) {
      if (root !== lazy.PINS_ROOT) {
        walk(root, 0);
      }
    }
    return out;
  }

  /**
   * @param {string} id
   * @returns {boolean} Whether `id` names a root, which no write may change.
   */
  function isRoot(id) {
    return id === TREE_ROOT || TOP.includes(id);
  }

  function throwIfRoot(id) {
    if (isRoot(id)) {
      throw new ExtensionError(ROOT_ERROR);
    }
  }

  /**
   * Throws for a parent no favorite can go in: the tree's root and the
   * mobile root, which the document does not hold.
   *
   * @param {string} guid
   */
  function throwIfNoParent(guid) {
    if (guid === TREE_ROOT || guid === MOBILE_ROOT) {
      throw new ExtensionError(ROOT_ERROR);
    }
  }

  /**
   * Whether an extension may save `url` in a favorite: one that parses, as
   * Places requires, of a kind every other way into Favorites accepts
   * (`SvalImportModel.importableUrl`), so no extension plants a bookmarklet
   * or a browser page as a favorite every device syncs.
   *
   * @param {string} url
   * @returns {boolean}
   */
  function savable(url) {
    const parsed = URL.parse(url);
    return !!parsed && lazy.importableUrl(parsed.href);
  }

  function invalid(info) {
    return new ExtensionError(`Invalid bookmark: ${JSON.stringify(info)}`);
  }

  /**
   * @param {object} store
   * @param {string} id
   * @returns {object} The row `id` names, which a write may change.
   */
  function writable(store, id) {
    throwIfRoot(id);
    const row = id === MOBILE_ROOT || hidden(store, id) ? null : store.get(id);
    if (!row) {
      throw new ExtensionError(NOT_FOUND);
    }
    return row;
  }

  /**
   * Whether `query`, as `bookmarks.search` takes it, matches `row`: each
   * word of `query` in the name or address, `url` and `title` exactly,
   * as `Bookmarks.search` matches (spec §8.3).
   *
   * @param {object} row
   * @param {object} query
   * @param {string[]} query.words Lower-cased.
   * @param {string|null} query.url
   * @param {string|null} query.title
   * @returns {boolean}
   */
  function matches(row, { words, url, title }) {
    if (url !== null && row.url !== url) {
      return false;
    }
    if (title !== null && row.name !== title) {
      return false;
    }
    const name = row.name.toLowerCase();
    const address = (row.url ?? "").toLowerCase();
    return words.every(word => name.includes(word) || address.includes(word));
  }

  /**
   * The index the store's `move` takes for landing at `index` of
   * `parentGuid`. Places counts a move's index as the place it lands at,
   * and the store as the item it lands before, `row` counted where it is.
   *
   * @param {object} row
   * @param {string} parentGuid
   * @param {number|null} index
   * @returns {number|null}
   */
  function moveIndex(row, parentGuid, index) {
    if (index === null || index < 0) {
      return null;
    }
    return parentGuid === row.parentGuid && index > row.index
      ? index + 1
      : index;
  }

  /**
   * Turns the store's changes into the API's events, for every change
   * whoever made it (spec §8.3): new is created, a new place is moved, a
   * new name or address is changed, and a removal is removed for the
   * outermost item removed, as Places leaves out `isDescendantRemoval`.
   */
  const changes = new (class extends EventEmitter {
    #listeners = 0;
    #followed = null;
    #unfollow = null;

    #follow = () => {
      const store = lazy.SvalFavoritesStore.instance;
      if (store === this.#followed) {
        return;
      }
      this.#unfollow?.();
      this.#followed = store;
      this.#unfollow = store
        ? store.addChangeListener(change => this.#emitFor(store, change))
        : null;
    };

    #emitFor(store, { changed, removed, before }) {
      const wasPin = guid => isPinIn(g => before.get(g), guid);
      const removedFor = (guid, old) =>
        this.emit("removed", {
          guid,
          info: {
            parentId: old.parentGuid,
            index: old.index,
            node: nodeOf(null, old),
          },
        });
      for (const guid of changed) {
        const row = store.get(guid);
        if (!row || isRoot(guid)) {
          continue;
        }
        // A pin is outside the API, so one moved to Favorites arrives in it
        // and a favorite moved into the pins root leaves it.
        const old = before.get(guid) && !wasPin(guid) ? before.get(guid) : null;
        if (hidden(store, guid)) {
          if (old) {
            removedFor(guid, old);
          }
          continue;
        }
        if (!old) {
          this.emit("created", nodeOf(store, row));
          continue;
        }
        if (old.parentGuid !== row.parentGuid || old.index !== row.index) {
          this.emit("moved", {
            guid,
            info: {
              parentId: row.parentGuid,
              index: row.index,
              oldParentId: old.parentGuid,
              oldIndex: old.index,
            },
          });
        }
        if (old.name !== row.name) {
          this.emit("changed", { guid, info: { title: row.name } });
        }
        if (old.url !== row.url) {
          this.emit("changed", { guid, info: { url: row.url } });
        }
      }
      const gone = new Set(removed);
      for (const guid of removed) {
        const old = before.get(guid);
        if (!old || gone.has(old.parentGuid) || wasPin(guid)) {
          continue;
        }
        removedFor(guid, old);
      }
    }

    listen() {
      if (!this.#listeners++) {
        Services.obs.addObserver(this.#follow, lazy.FAVORITES_CHANGED_TOPIC);
        this.#follow();
      }
    }

    unlisten() {
      if (!--this.#listeners) {
        Services.obs.removeObserver(this.#follow, lazy.FAVORITES_CHANGED_TOPIC);
        this.#unfollow?.();
        this.#followed = null;
        this.#unfollow = null;
      }
    }
  })();

  /**
   * A persistent event fed by `changes`' `name`.
   *
   * @param {string} name
   * @param {Function} args Given what `changes` emitted, the listener's
   *   arguments.
   * @returns {Function} As `PERSISTENT_EVENTS` takes.
   */
  const persistent =
    (name, args) =>
    ({ fire }) => {
      const listener = (event, data) => fire.sync(...args(data));
      changes.on(name, listener);
      changes.listen();
      return {
        unregister() {
          changes.off(name, listener);
          changes.unlisten();
        },
        convert(_fire) {
          fire = _fire;
        },
      };
    };

  this.bookmarks = class extends ExtensionAPIPersistent {
    PERSISTENT_EVENTS = {
      onCreated: persistent("created", node => [node.id, node]),
      onRemoved: persistent("removed", ({ guid, info }) => [guid, info]),
      onChanged: persistent("changed", ({ guid, info }) => [guid, info]),
      onMoved: persistent("moved", ({ guid, info }) => [guid, info]),
    };

    getAPI(context) {
      const event = name =>
        new EventManager({
          context,
          module: "bookmarks",
          event: name,
          extensionApi: this,
        }).api();

      return {
        bookmarks: {
          async get(idOrIdList) {
            const store = await favorites();
            const ids = Array.isArray(idOrIdList) ? idOrIdList : [idOrIdList];
            return ids.map(id => {
              if (!lazy.PlacesUtils.isValidGuid(id)) {
                throw new ExtensionError(
                  `Invalid value for property 'guid': ${JSON.stringify(id)}`
                );
              }
              const row = rowOf(store, id);
              if (!row) {
                throw new ExtensionError("Bookmark not found");
              }
              return nodeOf(store, row);
            });
          },

          async getChildren(id) {
            const store = await favorites();
            if (!rowOf(store, id)) {
              throw new ExtensionError("Bookmark not found");
            }
            return childrenOf(store, id).map(row => nodeOf(store, row));
          },

          async getTree() {
            const store = await favorites();
            return [treeOf(store, rowOf(store, TREE_ROOT))];
          },

          async getSubTree(id) {
            const store = await favorites();
            const row = rowOf(store, id);
            if (!row) {
              throw new ExtensionError("Bookmark not found");
            }
            return [treeOf(store, row)];
          },

          async search(query) {
            const store = await favorites();
            const asked = typeof query === "string" ? { query } : query;
            const wanted = {
              words: (asked.query ?? "")
                .toLowerCase()
                .split(/\s+/)
                .filter(Boolean),
              url: asked.url ? lazy.normalUrl(asked.url) : null,
              title: asked.title ?? null,
            };
            return everyRow(store)
              .filter(row => matches(row, wanted))
              .map(row => nodeOf(store, row));
          },

          async getRecent(numberOfItems) {
            const store = await favorites();
            return everyRow(store)
              .filter(row => row.kind === "favorite")
              .reverse()
              .sort((a, b) => b.added - a.added)
              .slice(0, numberOfItems)
              .map(row => nodeOf(store, row));
          },

          async create(bookmark) {
            const store = await favorites();
            const title = bookmark.title || "";
            let type = bookmark.type;
            if (!type) {
              type = bookmark.url === null ? "folder" : "bookmark";
            }
            const parentGuid = bookmark.parentId ?? lazy.FAVORITES_ROOT;
            throwIfNoParent(parentGuid);
            const index = bookmark.index ?? undefined;
            const info = { type, title, parentGuid, index };
            if (
              store.get(parentGuid)?.kind !== "folder" ||
              hidden(store, parentGuid)
            ) {
              throw invalid(info);
            }
            let guid;
            if (type === "bookmark") {
              info.url = bookmark.url || "";
              if (!savable(info.url)) {
                throw invalid(info);
              }
              guid = await store.add({
                url: info.url,
                title,
                parentGuid,
                index,
                duplicate: true,
                undoable: false,
              });
            } else if (type === "folder") {
              guid = await store.newFolder(parentGuid, title, index, {
                undoable: false,
              });
            } else {
              guid = await store.newSeparator(parentGuid, index, {
                undoable: false,
              });
            }
            const row = guid && store.get(guid);
            if (!row) {
              throw invalid(info);
            }
            return nodeOf(store, row);
          },

          async move(id, destination) {
            const store = await favorites();
            const row = writable(store, id);
            const parentGuid = destination.parentId ?? row.parentGuid;
            throwIfNoParent(parentGuid);
            const info = { guid: id, parentGuid, index: destination.index };
            if (
              store.get(parentGuid)?.kind !== "folder" ||
              hidden(store, parentGuid) ||
              store.isWithin(parentGuid, id)
            ) {
              throw invalid(info);
            }
            await store.move(
              id,
              parentGuid,
              moveIndex(row, parentGuid, destination.index),
              { undoable: false }
            );
            return nodeOf(store, rowOf(store, id));
          },

          async update(id, edits) {
            const store = await favorites();
            const row = writable(store, id);
            const info = { guid: id, title: edits.title, url: edits.url };
            if (
              edits.url !== null &&
              (row.kind !== "favorite" || !savable(edits.url))
            ) {
              throw invalid(info);
            }
            if (edits.title !== null && row.kind === "separator") {
              throw invalid(info);
            }
            await store.setContent(
              id,
              { name: edits.title, url: edits.url },
              { undoable: false }
            );
            return nodeOf(store, rowOf(store, id));
          },

          async remove(id) {
            const store = await favorites();
            const row = writable(store, id);
            if (store.children(row.guid).length) {
              throw new ExtensionError("Cannot remove a non-empty folder");
            }
            await store.delete(id, { undoable: false });
          },

          async removeTree(id) {
            const store = await favorites();
            writable(store, id);
            await store.delete(id, { undoable: false });
          },

          onCreated: event("onCreated"),
          onRemoved: event("onRemoved"),
          onChanged: event("onChanged"),
          onMoved: event("onMoved"),
        },
      };
    }
  };
}
