/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Favorites, as the engine's `favorites` document holds them: the only copy
 * (favorites-native spec §3.1, §5.1). Places holds no bookmarks of Sval's.
 *
 * The store reads the document after each pass that changed it and after
 * each of its own writes, and keeps that read whole, as the panel keeps the
 * tree's (decision 0055). It never edits the read: every answer comes from
 * the last one, and every change is one engine batch, after which the
 * document is read again.
 *
 * A favorite is keyed by a twelve-character guid Sval mints, and its node id
 * is `favoriteId(guid)` (spec §3). **Names and addresses are never logged**
 * (Sval `CONTRIBUTING.md` rule 10).
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalSerialQueue } from "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs";
import { SvalClock } from "moz-src:///browser/components/sval/SvalClock.sys.mjs";
import { SvalProcessInstance } from "moz-src:///browser/components/sval/SvalEngine.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  refusedAddress:
    "moz-src:///browser/components/sval/SvalSyncableAddress.sys.mjs",
});

/**
 * Notified after every change to Favorites or their pins, local or from a
 * pass, for whatever draws them.
 */
export const FAVORITES_CHANGED_TOPIC = "sval-favorites-changed";

/** The engine document Favorites live in. */
export const FAVORITES_DOCUMENT = "favorites";

/**
 * The document's roots: Favorites, the one Sval shows (decision 0123), two
 * kept empty, and the pins root, whose nodes are the pins (decision 0137).
 * The first three are Places' guids for the same roots, which a bookmarks
 * HTML file and the extensions' API still speak of.
 */
export const FAVORITES_ROOT = "toolbar_____";
export const PINS_ROOT = "pins________";
export const ROOT_GUIDS = Object.freeze([
  FAVORITES_ROOT,
  "menu________",
  "unfiled_____",
  PINS_ROOT,
]);

/** How many changes Undo can take back. */
const UNDO_DEPTH = 100;

/**
 * The address a favorite holds for `url`: parsed and written back, as Places
 * stored a bookmark's (`PlacesUtils.BOOKMARK_VALIDATORS.url`), so two
 * spellings of one address are one favorite.
 *
 * @param {string|URL} url
 * @returns {string}
 */
export function normalUrl(url) {
  const text = String(url);
  return URL.parse(text)?.href ?? text;
}

/**
 * Whether `url` is a bookmarklet's: whether Gecko's URL parser reads its
 * scheme as `javascript`. A Places node's address is already parsed, so for
 * one this is the test `PlacesUIUtils` applies when it opens a bookmarklet;
 * a synced favorite's address is as another device wrote it, and the parser
 * folds the scheme's case and the blanks before it as a load would.
 *
 * @param {string|null} url
 * @returns {boolean}
 */
export function isBookmarklet(url) {
  return !!url && URL.parse(url)?.protocol === "javascript:";
}

/** The process's one instance, over the profile's engine. */
const shared = new SvalProcessInstance(
  (engine, options) => new SvalFavoritesStore({ engine, ...options })
);

/** Favorites over one engine (spec §5.1). */
export class SvalFavoritesStore {
  #engine;
  #requestPass;
  #now;

  #started = false;
  #stopped = false;
  #loaded = false;

  /** Every read and write, in order. */
  #queue = new SvalSerialQueue("favorites");

  /** The last read: rows by guid, and each folder's children in order. */
  #byGuid = new Map();
  #children = new Map();

  /** guid -> node id, as the engine derives it, which never changes. */
  #ids = new Map();

  /**
   * Whether the last read holds a node marked `pinned`, which the pass
   * that moves pins into the pins root has yet to move (pins-root spec §8).
   */
  #marked = false;

  /**
   * node id -> the row it last read as, kept past the read that no longer
   * holds it until a pass names it removed: a write or another pass may read
   * the document between a pass and its report, and the report's
   * `removedIds` still need their guids and addresses.
   */
  #lastRead = new Map();

  /** What Undo puts back, latest last: `{ ops, beforeUndo }`. */
  #undo = [];

  #listeners = new Set();

  /**
   * Resolves once the document is registered and this device's copy read.
   * Rejects when the store stops first or the read fails, so a caller about
   * to read or change Favorites fails rather than act on an empty read.
   */
  #ready;
  #resolveReady;
  #rejectReady;

  /**
   * @param {object} options
   * @param {object} options.engine The profile's engine.
   * @param {Function} [options.requestPass] Asks for a pass soon; the
   *   engine's `requestPass` by default.
   * @param {() => number} [options.now] Milliseconds since the epoch.
   */
  constructor({
    engine,
    requestPass = () => engine.requestPass(),
    now = () => SvalClock.now(),
  }) {
    this.#engine = engine;
    this.#requestPass = requestPass;
    this.#now = now;
    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // A store stopped or failed before anything waited on it rejects with
    // nobody to hear it, which automation would fail as uncaught.
    this.#ready.catch(() => {});
  }

  /**
   * Registers the document holding this device's own copy, as the profile's
   * engine starts, and reads it. The roots are written the first time a
   * profile has none, and a profile's pins are moved into the pins root
   * (pins-root spec §8), in one write. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this.#started) {
      return this.#ready;
    }
    this.#started = true;
    try {
      await this.#engine.openDocument(FAVORITES_DOCUMENT, report =>
        this.#queue.post(() => this.#afterPass(report))
      );
      if (this.#stopped) {
        return undefined;
      }
      await this.#queue.run(async () => {
        await this.#read();
        const missing = ROOT_GUIDS.filter(guid => !this.#byGuid.has(guid));
        if (missing.length || this.#marked) {
          await this.#mutate([
            ...missing.map(guid => ({
              kind: "addFavorite",
              favoriteKind: "folder",
              guid,
              name: "",
            })),
            ...(this.#marked ? [{ kind: "movePinsToRoot" }] : []),
          ]);
          await this.#read();
          this.#requestPass();
        }
      });
    } catch (err) {
      this.#rejectReady(err);
      throw err;
    }
    if (this.#stopped) {
      return undefined;
    }
    this.#loaded = true;
    this.#resolveReady();
    this.#notify({ changed: [], removed: [], before: this.#byGuid });
    return this.#ready;
  }

  stop() {
    this.#stopped = true;
    this.#listeners.clear();
    this.#rejectReady(
      new DOMException("sval: Favorites stopped", "AbortError")
    );
  }

  /** Whether the document has been read, so there are Favorites to show. */
  get ready() {
    return this.#loaded;
  }

  /** @returns {Promise<void>} once {@link ready}. */
  whenReady() {
    return this.#ready;
  }

  /** @returns {Promise<void>} once every read and write asked for is done. */
  whenIdle() {
    return this.#queue.idle();
  }

  /**
   * Calls `fn({ changed, removed, before })` after each change, with the
   * guids it changed and removed: the store's own writes, and each pass that
   * changed the document. Only an id a write or a pass names is in either
   * list, so a listener never acts on a favorite for being absent (spec
   * §5.5). `before` is the read the change replaced, by guid, so a listener
   * knows what a removed or re-addressed favorite held.
   *
   * @param {Function} fn
   * @returns {Function} removes `fn`.
   */
  addChangeListener(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  // ----------------------------------------------------------------- reads

  /**
   * @param {string} guid
   * @returns {object|null} The row: `{ guid, id, kind, parentGuid, index,
   *   name, url, pinScope, added, contentAt, placementAt, local, refused }`, the stamps in milliseconds since the
   *   epoch. `local` is an address that stays on this device, and `refused`
   *   one another device wrote that no device opens (decision 1372), which
   *   only the Favorites menu shows, so it can be deleted.
   */
  get(guid) {
    return this.#byGuid.get(guid) ?? null;
  }

  /**
   * @param {string} guid A folder.
   * @returns {object[]} Its children, in order.
   */
  children(guid) {
    return this.#children.get(guid) ?? [];
  }

  /** @returns {object[]} Every favorite, folder and separator. */
  all() {
    return [...this.#byGuid.values()];
  }

  /**
   * @param {string|URL} url
   * @returns {object[]} The favorites in Favorites whose address is `url`,
   *   refused ones left out. A pin is not a favorite (decision 0137).
   */
  favoritesWithUrl(url) {
    return this.#withUrl(url, FAVORITES_ROOT);
  }

  /**
   * @param {string|URL} url
   * @returns {object[]} The pins whose address is `url`, refused ones left
   *   out.
   */
  pinsWithUrl(url) {
    return this.#withUrl(url, PINS_ROOT);
  }

  #withUrl(url, root) {
    const wanted = normalUrl(url);
    return this.all().filter(
      row =>
        row.kind === "favorite" &&
        row.url === wanted &&
        !row.refused &&
        this.isWithin(row.guid, root)
    );
  }

  /**
   * @param {string|URL} url
   * @returns {boolean} Whether `url` is a favorite.
   */
  isFavorite(url) {
    return !!this.favoritesWithUrl(url).length;
  }

  /**
   * @param {string|URL} url
   * @returns {boolean} Whether a favorite or a pin has `url`.
   */
  isKept(url) {
    return this.isFavorite(url) || !!this.pinsWithUrl(url).length;
  }

  /**
   * Whether `guid` is `ancestor` or inside it.
   *
   * @param {string} guid
   * @param {string} ancestor
   * @returns {boolean}
   */
  isWithin(guid, ancestor) {
    for (let row = this.get(guid), d = 0; row && d < 64; d++) {
      if (row.guid === ancestor) {
        return true;
      }
      row = row.parentGuid ? this.get(row.parentGuid) : null;
    }
    return false;
  }

  /**
   * Every folder a favorite can be moved into, in menu order: Favorites and
   * every folder under it, each with its depth below Favorites.
   *
   * @returns {Array<{guid: string, title: string, depth: number}>}
   */
  folders() {
    const out = [{ guid: FAVORITES_ROOT, title: "Favorites", depth: 0 }];
    const walk = (guid, depth) => {
      for (const child of this.children(guid)) {
        if (child.kind === "folder" && depth < 64) {
          out.push({ guid: child.guid, title: child.name, depth });
          walk(child.guid, depth + 1);
        }
      }
    };
    walk(FAVORITES_ROOT, 1);
    return out;
  }

  /**
   * The favorites directly in a folder, as Open All opens them: no folders,
   * separators, bookmarklets or refused addresses.
   *
   * @param {string} guid
   * @returns {object[]}
   */
  favoritesIn(guid) {
    return this.children(guid).filter(
      row =>
        row.kind === "favorite" &&
        row.url &&
        !isBookmarklet(row.url) &&
        !row.refused
    );
  }

  /**
   * How many favorites a folder holds at any depth.
   *
   * @param {string} guid
   * @returns {number}
   */
  countIn(guid) {
    let n = 0;
    for (const row of this.#subtree(guid)) {
      if (row.guid !== guid && row.kind === "favorite") {
        n++;
      }
    }
    return n;
  }

  /**
   * @param {string} guid
   * @returns {boolean} Whether it is a pin: a node under the pins root, at
   *   any depth (pins-root spec §4).
   */
  isPinned(guid) {
    return guid !== PINS_ROOT && this.isWithin(guid, PINS_ROOT);
  }

  /**
   * The workspaces the pin `guid` shows in: workspace node ids, or null for
   * every workspace (pins spec §7).
   *
   * @param {string} guid
   * @returns {string[]|null}
   */
  pinScopeOf(guid) {
    return this.get(guid)?.pinScope ?? null;
  }

  /**
   * The scope the pin `row` shows with: its own in the row, or that of the
   * pinned folder in the row that holds it (pins spec §7).
   *
   * @param {object} row
   * @returns {string[]|null}
   */
  #shownScope(row) {
    for (let at = row, d = 0; at && d < 64; d++) {
      if (at.parentGuid === PINS_ROOT) {
        return at.pinScope ?? null;
      }
      at = this.get(at.parentGuid);
    }
    return null;
  }

  /**
   * The pins (pins spec §4) and the home page's row (home-favorites spec
   * §3), which are one list: the pins root's children in its order, a
   * folder with its contents, as `{ guid, kind, name, url, local, scope,
   * children }`. Separators, bookmarklets and refused addresses are left
   * out: a bookmarklet would run on the home page itself, even pinned from
   * another device.
   *
   * @returns {object[]}
   */
  home() {
    const shown = row =>
      row.kind !== "separator" &&
      !(row.url && isBookmarklet(row.url)) &&
      !row.refused;
    const tile = (row, depth = 0) => ({
      guid: row.guid,
      kind: row.kind,
      name: row.name,
      url: row.url ?? null,
      local: row.local,
      scope: depth ? null : (row.pinScope ?? null),
      children:
        row.kind === "folder" && depth < 32
          ? this.children(row.guid)
              .filter(shown)
              .map(child => tile(child, depth + 1))
          : null,
    });
    return this.children(PINS_ROOT)
      .filter(shown)
      .map(row => tile(row));
  }

  // ---------------------------------------------------------------- writes

  /**
   * Saves `url` as a favorite at the end of `parentGuid`, or of Favorites. A
   * URL that is already a favorite is left as it is, unless `duplicate` asks
   * for a second. In the pins root it is a pin (pins-root spec §6).
   *
   * @param {object} what
   * @param {string|URL} what.url
   * @param {string} [what.title]
   * @param {string} [what.parentGuid]
   * @param {number} [what.index] Where in the folder, as {@link move} takes it.
   * @param {string[]|null} [what.scope] For a pin in the row, the workspace
   *   ids it is limited to (pins spec §7).
   * @param {boolean} [what.duplicate]
   * @param {Function} [what.beforeUndo] Runs before Undo takes it back.
   * @param {boolean} [what.undoable] Whether Undo takes it back.
   * @param {boolean} [what.local] The `local` mark of the node `url` was
   *   copied from, for an address this device did not just produce
   *   (`SvalEngine`'s `markLocal`).
   * @returns {Promise<string|null>} The favorite's guid, or null when it was
   *   one already.
   */
  add({
    url,
    title,
    parentGuid = FAVORITES_ROOT,
    index,
    scope = null,
    duplicate = false,
    beforeUndo = null,
    undoable = true,
    local,
  }) {
    const address = normalUrl(url);
    return this.#write(async () => {
      if (
        (!duplicate && this.isFavorite(address)) ||
        this.get(parentGuid)?.kind !== "folder"
      ) {
        return { ops: [], result: null };
      }
      const guid = mintGuid();
      const id = await this.#idOf(guid);
      const ops = [
        {
          kind: "addFavorite",
          favoriteKind: "favorite",
          guid,
          parent: await this.#idOf(parentGuid),
          ...(await this.#neighbours(parentGuid, index, null)),
          name: title || address,
          url: address,
          ...(typeof local === "boolean" ? { local } : {}),
        },
      ];
      if (scope?.length && parentGuid === PINS_ROOT) {
        ops.push({ kind: "setPinScope", id, scope: [...scope] });
      }
      return {
        ops,
        undo: [{ kind: "remove", id }],
        beforeUndo,
        changed: [guid],
        result: guid,
      };
    }, undoable);
  }

  /**
   * Saves `links` as favorites, in order, before the item now at `index` of
   * `parentGuid` or at its end, as one change: a drop of several links is
   * one act, and Undo takes it back whole. Duplicates are kept, as a drop
   * into Places kept them.
   *
   * @param {Array<{url: string, title?: string}>} links
   * @param {object} [where]
   * @param {string} [where.parentGuid]
   * @param {number} [where.index] As {@link move} takes it.
   * @returns {Promise<string[]>} The new favorites' guids.
   */
  addAll(links, { parentGuid = FAVORITES_ROOT, index } = {}) {
    return this.#write(async () => {
      if (!links.length || this.get(parentGuid)?.kind !== "folder") {
        return { ops: [], result: [] };
      }
      const parent = await this.#idOf(parentGuid);
      let { before, after } = await this.#neighbours(parentGuid, index, null);
      const ops = [];
      const undo = [];
      const guids = [];
      for (const link of links) {
        const address = normalUrl(link.url);
        const guid = mintGuid();
        const id = await this.#idOf(guid);
        ops.push({
          kind: "addFavorite",
          favoriteKind: "favorite",
          guid,
          parent,
          before,
          after,
          name: link.title || address,
          url: address,
        });
        undo.push({ kind: "remove", id });
        guids.push(guid);
        before = id;
      }
      return { ops, undo, changed: guids, result: guids };
    });
  }

  /**
   * Takes every favorite of `url` out of Favorites, as one change.
   *
   * @param {string|URL} url
   * @returns {Promise<void>}
   */
  removeUrl(url) {
    return this.#write(async () => {
      const guids = this.favoritesWithUrl(url).map(row => row.guid);
      return this.#deleteOps(guids);
    });
  }

  /**
   * Deletes a favorite, or a folder with everything in it, and its pins.
   *
   * @param {string} guid
   * @param {object} [options]
   * @param {boolean} [options.undoable] Whether Undo takes it back.
   * @returns {Promise<void>}
   */
  delete(guid, { undoable = true } = {}) {
    return this.#write(
      async () =>
        ROOT_GUIDS.includes(guid) ? { ops: [] } : this.#deleteOps([guid]),
      undoable
    );
  }

  /**
   * @param {string} guid A favorite or folder.
   * @param {string} name
   * @returns {Promise<void>}
   */
  rename(guid, name) {
    return this.setContent(guid, { name });
  }

  /**
   * @param {string} guid A favorite.
   * @param {string} url An address `SvalFavorites.addressOf` accepted.
   * @returns {Promise<void>}
   */
  setAddress(guid, url) {
    return this.setContent(guid, { url });
  }

  /**
   * Renames a favorite or folder and sets a favorite's address, as one
   * change. A field left out keeps what it holds.
   *
   * @param {string} guid
   * @param {object} content
   * @param {string} [content.name]
   * @param {string} [content.url] An address `SvalFavorites.addressOf`
   *   accepted.
   * @param {object} [options]
   * @param {boolean} [options.undoable] Whether Undo takes it back.
   * @returns {Promise<void>}
   */
  setContent(guid, { name, url }, { undoable = true } = {}) {
    return this.#write(async () => {
      const row = this.get(guid);
      if (!row || ROOT_GUIDS.includes(guid) || row.kind === "separator") {
        return { ops: [] };
      }
      const next = {
        name: name ?? row.name,
        url: url === undefined || url === null ? row.url : normalUrl(url),
      };
      if (next.name === row.name && next.url === row.url) {
        return { ops: [] };
      }
      return {
        ops: [{ kind: "setContent", id: row.id, ...next }],
        undo: [
          {
            kind: "setContent",
            id: row.id,
            name: row.name,
            url: row.url,
            local: row.local,
          },
        ],
        changed: [guid],
      };
    }, undoable);
  }

  /**
   * Moves `guid` into `parentGuid` before the item now at `index` there, or
   * to its end. The index counts the item itself where it is, as Places'
   * `moveToFolder` does, so within one folder one place down is two on.
   *
   * @param {string} guid
   * @param {string} parentGuid
   * @param {number} [index]
   * @param {object} [options]
   * @param {boolean} [options.undoable] Whether Undo takes it back.
   * @returns {Promise<void>}
   */
  move(guid, parentGuid, index, { undoable = true } = {}) {
    return this.#write(async () => {
      const row = this.get(guid);
      if (
        !row ||
        ROOT_GUIDS.includes(guid) ||
        this.get(parentGuid)?.kind !== "folder" ||
        this.isWithin(parentGuid, guid)
      ) {
        return { ops: [] };
      }
      return {
        ops: [
          {
            kind: "moveNode",
            id: row.id,
            newParent: await this.#idOf(parentGuid),
            ...(await this.#neighbours(parentGuid, index, guid)),
          },
        ],
        undo: [await this.#placeOp(row)],
        changed: [guid],
      };
    }, undoable);
  }

  /**
   * Makes a folder in `parentGuid` at `index`, or at its end.
   *
   * @param {string} parentGuid
   * @param {string} name
   * @param {number} [index]
   * @param {object} [options]
   * @param {boolean} [options.undoable] Whether Undo takes it back.
   * @returns {Promise<string>} Its guid.
   */
  newFolder(parentGuid, name, index, { undoable = true } = {}) {
    return this.#addKind("folder", parentGuid, name, index, undoable);
  }

  /**
   * Puts a separator in `parentGuid` at `index`, or at its end.
   *
   * @param {string} parentGuid
   * @param {number} [index]
   * @param {object} [options]
   * @param {boolean} [options.undoable] Whether Undo takes it back.
   * @returns {Promise<string>} Its guid.
   */
  newSeparator(parentGuid, index, { undoable = true } = {}) {
    return this.#addKind("separator", parentGuid, "", index, undoable);
  }

  /**
   * Pins the favorite or folder `guid`: a copy of it, with new guids, at the
   * end of the row, the favorite left where it is (pins-root spec §6). A
   * bookmarklet is never pinned (home-favorites spec §12): it acts on the
   * selected tab's page, which on the home page is the home page itself.
   *
   * @param {string} guid
   * @param {object} [options]
   * @param {string[]|null} [options.scope] The workspace ids the pin is
   *   limited to.
   * @returns {Promise<string|null>} The pin's guid, or null when nothing was
   *   pinned.
   */
  pin(guid, { scope = null } = {}) {
    return this.#write(async () => {
      const row = this.get(guid);
      if (
        !row ||
        ROOT_GUIDS.includes(guid) ||
        row.kind === "separator" ||
        isBookmarklet(row.url)
      ) {
        return { ops: [] };
      }
      const parent = await this.#idOf(PINS_ROOT);
      const ops = [];
      const copyOf = async (from, parentId, top) => {
        const copy = mintGuid();
        ops.push({
          kind: "addFavorite",
          favoriteKind: from.kind,
          guid: copy,
          parent: parentId,
          name: from.name,
          ...(from.url ? { url: from.url, local: from.local } : {}),
        });
        if (top && scope?.length) {
          ops.push({
            kind: "setPinScope",
            id: await this.#idOf(copy),
            scope: [...scope],
          });
        }
        for (const child of this.children(from.guid)) {
          await copyOf(child, await this.#idOf(copy), false);
        }
        return copy;
      };
      const copy = await copyOf(row, parent, true);
      return {
        ops,
        undo: [{ kind: "remove", id: await this.#idOf(copy) }],
        changed: [copy],
        result: copy,
      };
    });
  }

  /**
   * Moves the pin or pin folder `guid` to the end of Favorites and
   * clears its scope (pins-root spec §6), as one change.
   *
   * @param {string} guid
   * @returns {Promise<object|null>} the change's Undo entry, for
   *   {@link undoChange}, or null when nothing changed.
   */
  moveToFavorites(guid) {
    return this.#write(async () => {
      const row = this.get(guid);
      if (!row || !this.isPinned(guid)) {
        return { ops: [] };
      }
      const scoped = !!row.pinScope;
      const left = await this.#pinFolderLeftOps(row, FAVORITES_ROOT);
      return {
        ops: [
          // The scope is a pin's, and only a pin takes one.
          ...(scoped ? [{ kind: "setPinScope", id: row.id, scope: null }] : []),
          {
            kind: "moveNode",
            id: row.id,
            newParent: await this.#idOf(FAVORITES_ROOT),
            ...(await this.#neighbours(FAVORITES_ROOT, null, guid)),
          },
          ...left.ops,
        ],
        undo: [
          ...left.undo,
          await this.#placeOp(row),
          ...(scoped
            ? [{ kind: "setPinScope", id: row.id, scope: row.pinScope }]
            : []),
        ],
        changed: [guid, ...left.changed],
        removed: left.removed,
        answerEntry: true,
      };
    });
  }

  /**
   * Moves the pin `guid` into `parentGuid`, the row or one of its pin
   * folders, between the pins `afterGuid` and `beforeGuid`, or to its end,
   * removing a pin folder the move leaves holding one pin or none.
   *
   * @param {string} guid
   * @param {object} where
   * @param {string} [where.parentGuid] The pins root by default.
   * @param {string|null} [where.afterGuid]
   * @param {string|null} [where.beforeGuid]
   * @param {object} [options]
   * @param {boolean} [options.undoable] Whether Undo takes it back: a pin
   *   moved along the row by dragging it is not.
   * @returns {Promise<void>}
   */
  movePin(
    guid,
    { parentGuid = PINS_ROOT, afterGuid = null, beforeGuid = null },
    { undoable = true } = {}
  ) {
    return this.#write(async () => {
      const row = this.get(guid);
      const inside = other =>
        other && this.get(other)?.parentGuid === parentGuid;
      if (
        !row ||
        !this.isPinned(guid) ||
        (parentGuid !== PINS_ROOT && !this.isPinned(parentGuid)) ||
        this.get(parentGuid)?.kind !== "folder" ||
        this.isWithin(parentGuid, guid)
      ) {
        return { ops: [] };
      }
      // The place is found among the pins there now, the one moved left
      // out, so a pin named on one side only still lands beside it.
      const others = this.children(parentGuid).filter(r => r.guid !== guid);
      const at = other => others.findIndex(r => r.guid === other);
      let place = others.length;
      if (inside(beforeGuid) && beforeGuid !== guid) {
        place = at(beforeGuid);
      } else if (inside(afterGuid) && afterGuid !== guid) {
        place = at(afterGuid) + 1;
      }
      const left = await this.#pinFolderLeftOps(row, parentGuid);
      return {
        ops: [
          {
            kind: "moveNode",
            id: row.id,
            newParent: await this.#idOf(parentGuid),
            before: place > 0 ? others[place - 1].id : null,
            after: others[place]?.id ?? null,
          },
          ...left.ops,
        ],
        undo: [...left.undo, await this.#placeOp(row)],
        changed: [guid, ...left.changed],
        removed: left.removed,
      };
    }, undoable);
  }

  /**
   * Makes a pin folder named `name` of the pins `targetGuid` and
   * `draggedGuid`, where `targetGuid` stands, holding them in that order
   * (pins-root spec §5), as one change. A pin folder `draggedGuid` leaves
   * holding one pin or none goes, as {@link movePin} has it. A folder made
   * in the row shows in every workspace either pin showed in, so neither
   * pin reaches a workspace it was kept out of.
   *
   * @param {string} targetGuid
   * @param {string} draggedGuid
   * @param {string} name
   * @returns {Promise<string|null>} The folder's guid.
   */
  folderOf(targetGuid, draggedGuid, name) {
    return this.#write(async () => {
      const target = this.get(targetGuid);
      const dragged = this.get(draggedGuid);
      if (
        !target ||
        !dragged ||
        targetGuid === draggedGuid ||
        !this.isPinned(targetGuid) ||
        !this.isPinned(draggedGuid) ||
        this.isWithin(targetGuid, draggedGuid)
      ) {
        return { ops: [] };
      }
      const guid = mintGuid();
      const folder = await this.#idOf(guid);
      const siblings = this.children(target.parentGuid);
      const at = siblings.findIndex(row => row.guid === targetGuid);
      // Read before the moves: a pin in a folder shows where its folder does.
      const scope =
        target.parentGuid === PINS_ROOT
          ? unionScope(this.#shownScope(target), this.#shownScope(dragged))
          : null;
      const left = await this.#pinFolderLeftOps(dragged, target.parentGuid);
      return {
        ops: [
          {
            kind: "addFavorite",
            favoriteKind: "folder",
            guid,
            parent: await this.#idOf(target.parentGuid),
            before: at > 0 ? siblings[at - 1].id : null,
            after: target.id,
            name,
          },
          ...(scope ? [{ kind: "setPinScope", id: folder, scope }] : []),
          { kind: "moveNode", id: target.id, newParent: folder },
          {
            kind: "moveNode",
            id: dragged.id,
            newParent: folder,
            before: target.id,
          },
          ...left.ops,
        ],
        undo: [
          ...left.undo,
          ...(await this.#restoreOps([target, dragged])),
          { kind: "remove", id: folder },
        ],
        changed: [guid, targetGuid, draggedGuid, ...left.changed],
        removed: left.removed,
        result: guid,
      };
    });
  }

  /**
   * Moves what the folder `guid` holds to where it stands, in order, and
   * deletes it (pins-root spec §5), as one change.
   *
   * @param {string} guid
   * @returns {Promise<void>}
   */
  moveContentsOut(guid) {
    return this.#write(async () => {
      const row = this.get(guid);
      if (!row || row.kind !== "folder" || ROOT_GUIDS.includes(guid)) {
        return { ops: [] };
      }
      const undo = [await this.#readdOp(row, true)];
      if (row.pinScope) {
        undo.push({ kind: "setPinScope", id: row.id, scope: row.pinScope });
      }
      let before = null;
      for (const child of this.children(guid)) {
        undo.push({
          kind: "moveNode",
          id: child.id,
          newParent: row.id,
          before,
        });
        before = child.id;
      }
      return {
        ops: [{ kind: "removeKeepingChildren", id: row.id }],
        undo,
        changed: this.children(guid).map(child => child.guid),
        removed: [guid],
      };
    });
  }

  /**
   * When moving `row` into `parentGuid` takes it out of a pin folder and
   * leaves that pin folder holding one item or none, the ops that remove
   * the pin folder, what it holds standing where it stood, and the ops that
   * put it back, to run ahead of the undo of `row`'s own move: the pin
   * folder re-added under its guid at its place with its scope, and what it
   * held moved back in.
   *
   * @param {object} row
   * @param {string} parentGuid Where `row` goes.
   * @returns {Promise<{ops: object[], undo: object[], changed: string[],
   *   removed: string[]}>}
   */
  async #pinFolderLeftOps(row, parentGuid) {
    const folder = this.get(row.parentGuid);
    const left = this.children(row.parentGuid).filter(
      child => child.guid !== row.guid
    );
    if (
      !folder ||
      folder.guid === parentGuid ||
      !this.isPinned(folder.guid) ||
      left.length > 1
    ) {
      return { ops: [], undo: [], changed: [], removed: [] };
    }
    const undo = [await this.#readdOp(folder, true)];
    if (folder.pinScope) {
      undo.push({ kind: "setPinScope", id: folder.id, scope: folder.pinScope });
    }
    for (const child of left) {
      undo.push({
        kind: "moveNode",
        id: child.id,
        newParent: folder.id,
        before: null,
      });
    }
    return {
      ops: [{ kind: "removeKeepingChildren", id: folder.id }],
      undo,
      changed: left.map(child => child.guid),
      removed: [folder.guid],
    };
  }

  /**
   * Limits the pin `guid` to the workspaces in `scope`, or shows it in every
   * workspace for null (pins spec §7).
   *
   * @param {string} guid
   * @param {string[]|null} scope
   * @returns {Promise<void>}
   */
  setPinScope(guid, scope) {
    return this.#write(async () => {
      const row = this.get(guid);
      if (!row || !this.isPinned(guid)) {
        return { ops: [] };
      }
      return {
        ops: [
          {
            kind: "setPinScope",
            id: row.id,
            scope: scope?.length ? [...scope] : null,
          },
        ],
        undo: [{ kind: "setPinScope", id: row.id, scope: row.pinScope }],
        changed: [guid],
      };
    });
  }

  /**
   * Adds a tree of favorites and folders at the end of `parentGuid`, and a
   * tree of pins at the end of the row, in one batch (pins-root spec §7).
   * Undo does not take it back, as it never took back an import.
   *
   * @param {object[]} tree As `SvalImportModel.planFavorites` plans it:
   *   `{ title, url }` for a favorite, `{ title, children }` for a folder.
   * @param {object} [options]
   * @param {object[]} [options.pins] The pins, in the same shape.
   * @param {string} [options.parentGuid] Where `tree` goes: Favorites by
   *   default.
   * @returns {Promise<string[]>} Each entry's guid, parents before their
   *   children, in order, the favorites' first.
   */
  insertTree(tree, { pins = [], parentGuid = FAVORITES_ROOT } = {}) {
    return this.#write(async () => {
      const ops = [];
      const guids = [];
      const walk = async (entries, parent) => {
        const parentId = await this.#idOf(parent);
        for (const entry of entries) {
          const guid = mintGuid();
          const folder = !!entry.children;
          ops.push({
            kind: "addFavorite",
            favoriteKind: folder ? "folder" : "favorite",
            guid,
            parent: parentId,
            name: entry.title ?? "",
            ...(folder ? {} : { url: normalUrl(entry.url) }),
          });
          guids.push(guid);
          if (folder) {
            await walk(entry.children, guid);
          }
        }
      };
      if (this.get(parentGuid)?.kind !== "folder") {
        return { ops: [], result: [] };
      }
      await walk(tree, parentGuid);
      await walk(pins, PINS_ROOT);
      return { ops, changed: guids, result: guids };
    });
  }

  /** @returns {boolean} Whether there is a change to undo. */
  canUndo() {
    return !!this.#undo.length;
  }

  /**
   * Takes back the latest change made here: one batch that restores what it
   * replaced. A change another device made since may leave nothing to
   * restore it into, and then the entry goes.
   *
   * @returns {Promise<void>}
   */
  async undo() {
    // A write pushes its entry from inside the queue once its batch is read
    // back, so the queue drains first or the pop takes the change before it.
    await this.#queue.run(() => {});
    const entry = this.#undo.pop();
    if (entry) {
      await this.#takeBack(entry);
    }
  }

  /**
   * Takes back one change, wherever it is among those Undo can take back,
   * and leaves the others to Undo. The panel's Undo message takes back the
   * change it offered this way (`SvalPinsRow.unpin`), since changes made
   * after it may sit above it.
   *
   * @param {object} entry As {@link setPinned} answers it.
   * @returns {Promise<boolean>} whether it was still there to take back.
   */
  async undoChange(entry) {
    await this.#queue.run(() => {});
    const at = this.#undo.indexOf(entry);
    if (at < 0) {
      return false;
    }
    this.#undo.splice(at, 1);
    await this.#takeBack(entry);
    return true;
  }

  /**
   * Restores what `entry` replaced, as one batch.
   *
   * @param {object} entry
   */
  async #takeBack(entry) {
    await entry.beforeUndo?.();
    await this.#queue.run(async () => {
      try {
        await this.#mutate(entry.ops);
      } catch (err) {
        SvalLog.warn(
          `favorites: nothing to undo into: ${SvalLog.errorName(err)}`
        );
        return;
      }
      const before = this.#byGuid;
      await this.#read();
      this.#requestPass();
      this.#notifyDiff(before);
    });
  }

  // -------------------------------------------------------------- internal

  /**
   * One change: `build()` answers the batch and how to undo it, from the
   * read as it stands, inside the queue so nothing changes the read first.
   *
   * @param {Function} build Answers `{ ops, undo, beforeUndo, changed,
   *   removed, result, answerEntry }`; with `answerEntry` the write answers
   *   its Undo entry in place of `result`.
   * @param {boolean} [undoable] Whether Undo takes it back.
   * @returns {Promise<*>} `result`.
   */
  async #write(build, undoable = true) {
    // Once loaded, the write queues before its caller's next step, so an
    // `undo()` asked for after it drains the queue past it.
    if (!this.#loaded) {
      await this.#ready;
    }
    return this.#queue.run(async () => {
      if (this.#stopped) {
        return undefined;
      }
      const {
        ops,
        undo = null,
        beforeUndo = null,
        changed = [],
        removed = [],
        result,
        answerEntry = false,
      } = await build();
      if (!ops.length) {
        return answerEntry ? null : result;
      }
      const before = this.#byGuid;
      await this.#mutate(ops);
      await this.#read();
      let entry = null;
      if (undoable && undo?.length) {
        entry = { ops: undo, beforeUndo };
        this.#undo.push(entry);
        this.#undo.splice(0, this.#undo.length - UNDO_DEPTH);
      }
      this.#requestPass();
      this.#notify({ changed, removed, before });
      return answerEntry ? entry : result;
    });
  }

  #mutate(ops) {
    return this.#engine.mutate({
      kind: "batch",
      document: FAVORITES_DOCUMENT,
      ops,
      now: this.#now(),
    });
  }

  async #addKind(kind, parentGuid, name, index, undoable) {
    return this.#write(async () => {
      if (this.get(parentGuid)?.kind !== "folder") {
        return { ops: [] };
      }
      const guid = mintGuid();
      return {
        ops: [
          {
            kind: "addFavorite",
            favoriteKind: kind,
            guid,
            parent: await this.#idOf(parentGuid),
            ...(await this.#neighbours(parentGuid, index, null)),
            name,
          },
        ],
        undo: [{ kind: "remove", id: await this.#idOf(guid) }],
        changed: [guid],
        result: guid,
      };
    }, undoable);
  }

  /**
   * Deletes `guids` with everything inside them, and the batch that puts
   * them back: each node re-added under its guid, parents first and each
   * after its previous sibling, then each pin's scope.
   * Re-adding a removed id at a new stamp is news to every peer (decisions
   * 0014, 0016).
   *
   * @param {string[]} guids
   * @returns {Promise<object>} What {@link #write} takes.
   */
  async #deleteOps(guids) {
    const top = guids
      .map(guid => this.get(guid))
      .filter(row => row && !ROOT_GUIDS.includes(row.guid))
      .filter(
        (row, _, rows) =>
          !rows.some(
            other => other !== row && this.isWithin(row.guid, other.guid)
          )
      );
    if (!top.length) {
      return { ops: [] };
    }
    const gone = top.flatMap(row => this.#subtree(row.guid));
    const undo = [];
    for (const row of top) {
      undo.push(await this.#readdOp(row, true));
      for (const child of this.#subtree(row.guid).slice(1)) {
        undo.push(await this.#readdOp(child, false));
      }
    }
    // A node added again takes no scope, so a pin's comes back after it.
    for (const row of gone) {
      if (row.pinScope && this.isPinned(row.guid)) {
        undo.push({ kind: "setPinScope", id: row.id, scope: row.pinScope });
      }
    }
    return {
      ops: top.map(row => ({ kind: "remove", id: row.id })),
      undo,
      removed: gone.map(row => row.guid),
    };
  }

  /**
   * @param {string} guid
   * @returns {object[]} `guid` and everything inside it, parents before
   *   children, in order.
   */
  #subtree(guid) {
    const out = [];
    const walk = (row, depth) => {
      out.push(row);
      if (depth < 64) {
        for (const child of this.children(row.guid)) {
          walk(child, depth + 1);
        }
      }
    };
    const row = this.get(guid);
    if (row) {
      walk(row, 0);
    }
    return out;
  }

  async #readdOp(row, atPlace) {
    return {
      kind: "addFavorite",
      favoriteKind: row.kind,
      guid: row.guid,
      parent: await this.#idOf(row.parentGuid),
      ...(atPlace ? await this.#siblingsOf(row) : {}),
      name: row.name,
      ...(row.url ? { url: row.url, local: row.local } : {}),
    };
  }

  /**
   * @param {object} row
   * @returns {Promise<object>} The move that puts `row` back where it is.
   */
  async #placeOp(row) {
    return {
      kind: "moveNode",
      id: row.id,
      newParent: await this.#idOf(row.parentGuid),
      ...(await this.#siblingsOf(row)),
    };
  }

  /**
   * @param {object} row
   * @returns {Promise<object>} Its neighbours now, as `{ before, after }`
   *   node ids.
   */
  async #siblingsOf(row) {
    const siblings = this.children(row.parentGuid);
    const at = siblings.findIndex(s => s.guid === row.guid);
    return {
      before: at > 0 ? siblings[at - 1].id : null,
      after: siblings[at + 1]?.id ?? null,
    };
  }

  /**
   * The neighbours a node goes between to land before the item at `index`
   * of `parentGuid`, `self` counted where it is, or at the end: the engine
   * puts a node moved with no neighbour named first.
   *
   * @param {string} parentGuid
   * @param {number|null|undefined} index
   * @param {string|null} self The node being placed, or null for a new one.
   * @returns {Promise<object>} `{ before, after }` node ids.
   */
  async #neighbours(parentGuid, index, self) {
    const siblings = this.children(parentGuid);
    const others = siblings.filter(s => s.guid !== self);
    const at =
      index === undefined || index === null || index < 0
        ? others.length
        : siblings.slice(0, index).filter(s => s.guid !== self).length;
    return {
      before: at > 0 ? others[at - 1].id : null,
      after: others[at]?.id ?? null,
    };
  }

  /**
   * The moves that put `rows`, moved by one change, back where they are
   * now, in order. Each goes between the neighbours it has now, less those
   * of `rows` still to be put back, which stand elsewhere until their own
   * move.
   *
   * @param {object[]} rows
   * @returns {Promise<object[]>}
   */
  async #restoreOps(rows) {
    const ops = [];
    rows.forEach((row, i) => {
      const later = new Set(rows.slice(i + 1).map(r => r.guid));
      const siblings = this.children(row.parentGuid).filter(
        s => s.guid === row.guid || !later.has(s.guid)
      );
      const at = siblings.findIndex(s => s.guid === row.guid);
      ops.push({
        kind: "moveNode",
        id: row.id,
        newParent: row.parentGuid,
        before: at > 0 ? siblings[at - 1].id : null,
        after: siblings[at + 1]?.id ?? null,
      });
    });
    for (const op of ops) {
      op.newParent = await this.#idOf(op.newParent);
    }
    return ops;
  }

  async #idOf(guid) {
    if (!this.#ids.has(guid)) {
      this.#ids.set(guid, await this.#engine.favoriteId(guid));
    }
    return this.#ids.get(guid);
  }

  /** Reads the document whole, replacing the last read. */
  async #read() {
    const rows = await this.#engine.favorites(FAVORITES_DOCUMENT);
    const guidOfId = new Map(rows.map(row => [row.id, row.guid]));
    const byGuid = new Map();
    const children = new Map();
    this.#marked = rows.some(row => row.pinned);
    // The engine lists rows by parent, then by order among siblings.
    for (const row of rows) {
      if (!row.guid) {
        continue;
      }
      this.#ids.set(row.guid, row.id);
      const parentGuid = row.parent ? (guidOfId.get(row.parent) ?? null) : null;
      const siblings = parentGuid ? (children.get(parentGuid) ?? []) : [];
      const read = Object.freeze({
        guid: row.guid,
        id: row.id,
        kind: row.kind,
        parentGuid,
        index: siblings.length,
        name: row.name ?? "",
        url: row.url ?? null,
        pinScope: row.pinScope ?? null,
        added: row.added,
        contentAt: row.contentAt,
        placementAt: row.placementAt,
        local: !!row.local,
        refused: lazy.refusedAddress(row),
      });
      byGuid.set(row.guid, read);
      this.#lastRead.set(row.id, read);
      if (parentGuid) {
        siblings.push(read);
        children.set(parentGuid, siblings);
      }
    }
    this.#byGuid = byGuid;
    this.#children = children;
  }

  /**
   * After a pass that changed the document: read it again, and tell
   * listeners which favorites it changed and which it removed, by the read
   * before it for the removed ones.
   *
   * @param {object} report The pass's report for the document.
   */
  async #afterPass(report) {
    if (!this.#loaded || this.#stopped) {
      return;
    }
    const changedIds = report?.changedIds ?? [];
    const removedIds = new Set(report?.removedIds ?? []);
    if (!changedIds.length && !removedIds.size) {
      return;
    }
    const before = new Map(this.#byGuid);
    await this.#read();
    const removed = [];
    for (const id of removedIds) {
      const row = this.#lastRead.get(id);
      this.#lastRead.delete(id);
      if (row && !this.#byGuid.has(row.guid)) {
        removed.push(row.guid);
        before.set(row.guid, row);
      }
    }
    const ids = new Set(changedIds);
    const changed = this.all()
      .filter(row => ids.has(row.id))
      .map(row => row.guid);
    this.#notify({ changed, removed, before });
  }

  /**
   * Tells listeners what Undo changed, from the read before it.
   *
   * @param {Map<string, object>} before
   */
  #notifyDiff(before) {
    const changed = [];
    const same = (a, b) => !!a && JSON.stringify(a) === JSON.stringify(b);
    for (const row of this.#byGuid.values()) {
      if (!same(before.get(row.guid), row)) {
        changed.push(row.guid);
      }
    }
    const removed = [...before.keys()].filter(g => !this.#byGuid.has(g));
    this.#notify({ changed, removed, before });
  }

  #notify(change) {
    for (const fn of this.#listeners) {
      try {
        fn(change);
      } catch (err) {
        SvalLog.warn(`favorites: a listener failed: ${SvalLog.errorName(err)}`);
      }
    }
    Services.obs.notifyObservers(null, FAVORITES_CHANGED_TOPIC);
  }

  /** @returns {?object} `{ engine, sync }` for the process's instance. */
  static get shared() {
    return shared.shared;
  }

  /** Stops the process's instance and forgets it, for tests and shutdown. */
  static stopShared() {
    return shared.stop();
  }

  /** @returns {SvalFavoritesStore|null} The process's instance, once made. */
  static get instance() {
    return shared.instance;
  }

  /** @returns {SvalFavoritesStore|null} The process's instance, once read. */
  static get readyInstance() {
    const store = shared.instance;
    return store?.ready ? store : null;
  }

  /**
   * Starts the store for `engine`, once for the process
   * (`SvalProcessInstance`), and settles once it is ready.
   *
   * @param {object} engine The profile's engine.
   * @param {object} [options] As the constructor takes, beside `engine`.
   * @returns {Promise<SvalFavoritesStore>}
   */
  static startFor(engine, options = {}) {
    return shared.startFor(engine, options);
  }
}

/**
 * The scope that shows everywhere `a` or `b` does: null, every workspace,
 * when either is.
 *
 * @param {string[]|null} a
 * @param {string[]|null} b
 * @returns {string[]|null}
 */
function unionScope(a, b) {
  if (!a?.length || !b?.length) {
    return null;
  }
  return [...new Set([...a, ...b])].sort();
}

/** A new favorite's key: Places' random guid, used only as a generator. */
function mintGuid() {
  return lazy.PlacesUtils.history.makeGuid();
}
