/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The pins row's arithmetic (pins spec §4, §6, §7), as pure functions of the
 * pins `SvalFavoritesStore.home()` reads and the window's state, so the whole
 * of it is asserted in xpcshell. The row (`SvalPinsRow`) draws what these
 * answer and decides nothing of its own.
 */

import { siteOf } from "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs";

/** How many lines the row shows before its last slot becomes "+N". Synced. */
export const PINS_LINES_PREF = "browser.sval.pins.lines";

/** Whether a link to another site opens in a Quick Peek over its pin. Synced. */
export const PINS_QUICK_PEEK_PREF = "browser.sval.pins.quickPeekLinks";

/** A tile's width and the gap after it, and the row's inline padding. */
const TILE_PX = 40;
const GAP_PX = 4;
const PADDING_PX = 16;

/** The 48px panel's row: one column of small tiles, six slots (§4). */
export const NARROW_PANEL_PX = 72;
const NARROW_SLOTS = 6;

/**
 * Pins per line at a panel `width` wide: 4 at 280px, 8 at 480px (§4). The
 * two left over are what the selected pin widens into.
 *
 * @param {number} width The panel's width in CSS pixels.
 * @returns {number}
 */
export function perLine(width) {
  if (width <= NARROW_PANEL_PX) {
    return 1;
  }
  return Math.max(
    2,
    Math.floor((width - PADDING_PX + GAP_PX) / (TILE_PX + GAP_PX)) - 2
  );
}

/**
 * Whether a pin shows in `workspaceId` (§7). A pin with no scope shows in
 * every workspace. A scope's workspaces that are gone count for nothing, and
 * a scope left with none is every workspace.
 *
 * @param {string[]|null} scope The pin's workspace ids, or null.
 * @param {string|null} workspaceId The workspace the window shows.
 * @param {Set<string>} workspaces Every workspace the document holds.
 * @returns {boolean}
 */
export function showsIn(scope, workspaceId, workspaces) {
  const live = (scope ?? []).filter(id => workspaces.has(id));
  return !live.length || live.includes(workspaceId);
}

/**
 * The scope a pin is stored with for the workspaces ticked in its "Show in"
 * menu (§7): every workspace ticked is "all workspaces", so it shows in ones
 * made later. Nothing ticked is no change.
 *
 * @param {string[]} ticked
 * @param {string[]} workspaces Every workspace "Show in" lists.
 * @returns {string[]|null|undefined} the scope, null for every workspace, or
 *   undefined for no change.
 */
export function scopeFor(ticked, workspaces) {
  if (!ticked.length) {
    return undefined;
  }
  if (workspaces.every(id => ticked.includes(id))) {
    return null;
  }
  return [...ticked].sort();
}

/**
 * Every pin inside a pinned folder, depth first in folder order (§6). Each is
 * a pin as a pin in the row is.
 *
 * @param {object} folder A folder tile from `SvalFavoritesStore.home()`.
 * @returns {object[]}
 */
export function pinsInFolder(folder) {
  const out = [];
  const walk = node => {
    for (const child of node.children ?? []) {
      if (child.kind === "folder") {
        walk(child);
      } else if (child.url) {
        out.push(child);
      }
    }
  };
  walk(folder);
  return out;
}

/**
 * The slots the row shows in `workspaceId`, in the row's order: each a pin
 * or a pinned folder (§4, §7).
 *
 * @param {object[]} tiles As `SvalFavoritesStore.home()` answers them.
 * @param {string|null} workspaceId
 * @param {Set<string>} workspaces
 * @returns {object[]}
 */
export function slotsIn(tiles, workspaceId, workspaces) {
  return tiles.filter(
    tile =>
      (tile.kind === "folder" || !!tile.url) &&
      showsIn(tile.scope, workspaceId, workspaces)
  );
}

/**
 * Lays `slots` out in lines of `columns`, at most `lines` of them (§4). Past
 * that the last slot is "+N", holding the rest. Lines fill by order alone.
 *
 * @param {object[]} slots
 * @param {object} options
 * @param {number} options.columns Pins per line ({@link perLine}).
 * @param {number} options.lines The line limit, at least one.
 * @param {boolean} [options.narrow] The 48px panel's one column of six.
 * @returns {{lines: object[][], hidden: object[]}} each line's slots, and
 *   what "+N" holds; "+N" itself is the last line's last slot, `null`.
 */
export function layout(slots, { columns, lines, narrow = false }) {
  const room = narrow
    ? NARROW_SLOTS
    : Math.max(1, columns) * Math.max(1, Math.floor(lines));
  const step = narrow ? 1 : Math.max(1, columns);
  let shown = slots;
  let hidden = [];
  if (slots.length > room) {
    shown = [...slots.slice(0, room - 1), null];
    hidden = slots.slice(room - 1);
  }
  const out = [];
  for (let i = 0; i < shown.length; i += step) {
    out.push(shown.slice(i, i + step));
  }
  return { lines: out, hidden };
}

/**
 * The guid of each pin a slot stands for: itself, or every pin in a folder.
 *
 * @param {object} slot
 * @returns {string[]}
 */
export function guidsOf(slot) {
  return slot.kind === "folder"
    ? pinsInFolder(slot).map(pin => pin.guid)
    : [slot.guid];
}

/**
 * The slot holding the pin `guid`, as the row draws it: the pin, or the
 * pinned folder it is in. A pin both pinned on its own and inside a pinned
 * folder is the pin itself (§6).
 *
 * @param {object[]} slots
 * @param {string|null} guid
 * @returns {object|null}
 */
export function slotOf(slots, guid) {
  if (!guid) {
    return null;
  }
  return (
    slots.find(slot => slot.kind !== "folder" && slot.guid === guid) ??
    slots.find(slot => guidsOf(slot).includes(guid)) ??
    null
  );
}

/**
 * The pin with `guid` among `slots`, looked for in folders too.
 *
 * @param {object[]} slots
 * @param {string} guid
 * @returns {object|null}
 */
export function pinOf(slots, guid) {
  for (const slot of slots) {
    if (slot.kind !== "folder" && slot.guid === guid) {
      return slot;
    }
    if (slot.kind === "folder") {
      const found = pinsInFolder(slot).find(pin => pin.guid === guid);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/**
 * The slot ⌘1–9 selects (§3): the `n`th slot that shows in this workspace,
 * counting from 1, a folder as one slot.
 *
 * @param {object[]} slots
 * @param {number} n 1 to 9.
 * @returns {object|null}
 */
export function numberedSlot(slots, n) {
  return Number.isInteger(n) && n >= 1 ? (slots[n - 1] ?? null) : null;
}

/**
 * A pin's site: its saved address's site, as `siteOf` answers it (§5). An
 * address `siteOf` refuses, such as a `file:` page, has no site, so every web
 * page leaves it.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function siteOfPin(url) {
  try {
    return siteOf(url);
  } catch {
    return null;
  }
}

/**
 * Whether a link to `href` leaves the pin whose site is `site` (§5): an http
 * or https page whose site, as `siteOf` answers it, differs. A link within
 * the site, or to something that is no web page, stays the page's.
 *
 * @param {string} href
 * @param {string|null} site The pin's site.
 * @returns {boolean}
 */
export function leavesPin(href, site) {
  let linkSite;
  try {
    linkSite = siteOf(href);
  } catch {
    return false;
  }
  return linkSite !== null && linkSite !== site;
}

/**
 * The line in the row a slot index falls on, and its column there.
 *
 * @param {object[][]} lines As {@link layout} answers them.
 * @param {object} slot
 * @returns {{line: number, column: number}|null}
 */
export function placeOf(lines, slot) {
  for (let line = 0; line < lines.length; line++) {
    const column = lines[line].indexOf(slot);
    if (column >= 0) {
      return { line, column };
    }
  }
  return null;
}
