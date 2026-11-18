/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The user's own filter rules, My filters, kept a pref per line under
 * `MY_FILTER_BRANCH` so that each line syncs as a setting of its own
 * (settings-sync spec §4.5, decision 0117). Two devices that change different
 * lines both keep their change, and a removed line is a reset that stands.
 *
 * A line's pref is named by `lineKey`, the SHA-256 of its text and how many
 * lines of the same text come before it, so devices that add the same line
 * write the same setting. Its value is JSON, `{line, order}`. `order` places
 * the line among the others: a string over `ORDER_DIGITS` that sorts as a
 * fraction, and never ends in `0`, so another fits between any two
 * (`orderBetween`). The iPhone reads lines by the same rules
 * (`MyFilters.swift`).
 */

import { isPlainText } from "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs";
import { sha256HexSync } from "moz-src:///browser/components/sval/SvalBytes.sys.mjs";

export const MY_FILTER_BRANCH = "browser.sval.adblock.myFilter.";

/**
 * My filters as one text, which a profile may hold and `moveText` moves into
 * `MY_FILTER_BRANCH`.
 */
const TEXT_PREF = "browser.sval.adblock.myFilters";

const ORDER_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const ORDER = /^[0-9a-z]*[1-9a-z]$/;

/**
 * An order strictly between `a` and `b`, read as base-36 fractions.
 *
 * @param {string} a The order before, or "" for the start.
 * @param {?string} b The order after, or null for the end. Greater than `a`.
 * @returns {string}
 */
export function orderBetween(a, b) {
  let order = "";
  for (let i = 0; ; i++) {
    const lo = i < a.length ? ORDER_DIGITS.indexOf(a[i]) : 0;
    const hi =
      b !== null && i < b.length
        ? ORDER_DIGITS.indexOf(b[i])
        : ORDER_DIGITS.length;
    if (hi - lo > 1) {
      return order + ORDER_DIGITS[(lo + hi) >> 1];
    }
    order += ORDER_DIGITS[lo];
    if (hi - lo == 1) {
      // `order` is below `b` from this digit on, so only `a` bounds the rest.
      b = null;
    }
  }
}

/**
 * `count` orders between `a` and `b`, ascending. Each halves the gap it
 * splits, so a run of lines pasted at one place lengthens the orders by the
 * logarithm of the run.
 *
 * @param {string} a As `orderBetween` takes.
 * @param {?string} b As `orderBetween` takes.
 * @param {number} count
 * @returns {string[]}
 */
export function ordersBetween(a, b, count) {
  if (count <= 0) {
    return [];
  }
  const half = count >> 1;
  const middle = orderBetween(a, b);
  return [
    ...ordersBetween(a, middle, half),
    middle,
    ...ordersBetween(middle, b, count - half - 1),
  ];
}

/**
 * @param {string} line
 * @param {number} n How many lines of the same text come before it.
 * @returns {string} The name of the line's pref under `MY_FILTER_BRANCH`.
 */
export function lineKey(line, n) {
  return sha256HexSync(`${line}\n${n}`).slice(0, 32);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} `a` against `b` by UTF-16 code unit, which for the ASCII
 *   of orders and keys is byte order, as Swift compares them.
 */
function compare(a, b) {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * Every line, in order. A pref whose value is not a line, as a newer build
 * or another device could write, is left out.
 *
 * @param {object} [prefs]
 * @returns {{key: string, line: string, order: string}[]}
 */
export function lines(prefs = Services.prefs) {
  const found = [];
  for (const name of prefs.getChildList(MY_FILTER_BRANCH)) {
    let value;
    try {
      value = JSON.parse(prefs.getStringPref(name));
    } catch {
      // A value of another type, or text that is not JSON.
      continue;
    }
    const { line, order } = value ?? {};
    if (
      typeof line == "string" &&
      !line.includes("\n") &&
      !line.includes("\r") &&
      isPlainText(line) &&
      typeof order == "string" &&
      ORDER.test(order)
    ) {
      found.push({ key: name.slice(MY_FILTER_BRANCH.length), line, order });
    }
  }
  return found.sort(
    (x, y) => compare(x.order, y.order) || compare(x.key, y.key)
  );
}

/**
 * @param {{line: string}[]} stored As `lines` returns them.
 * @returns {string} The rules as one text, a line each.
 */
export function textOf(stored) {
  return stored.map(entry => entry.line).join("\n");
}

let cachedText = null;
let watching = false;

/**
 * My filters as one text, read once for every change to the branch, since
 * page rules ask for it at each page load.
 *
 * @returns {string}
 */
export function storedText() {
  if (cachedText === null) {
    if (!watching) {
      watching = true;
      Services.prefs.addObserver(MY_FILTER_BRANCH, () => {
        cachedText = null;
      });
    }
    cachedText = textOf(lines());
  }
  return cachedText;
}

/**
 * @param {string} text
 * @returns {string[]} The lines of `text`, none for "".
 */
function splitLines(text) {
  return text ? text.split(/\r\n|\r|\n/) : [];
}

/**
 * The longest run of `values` that rises, by index.
 *
 * @param {number[]} values
 * @returns {Set<number>} The indexes in `values` of that run.
 */
function longestRise(values) {
  const tails = [];
  const before = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    before[i] = lo ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const run = new Set();
  for (let i = tails.at(-1) ?? -1; i != -1; i = before[i]) {
    run.add(i);
  }
  return run;
}

/**
 * The pref writes that turn `stored` into `text`, touching only the lines
 * that changed: a line kept where it was is not written, so another
 * device's change to any other line survives the merge.
 *
 * A line of `text` takes a stored line of the same text, the first one not
 * yet taken. The taken lines that stay in their order keep it; every other
 * line gets an order between its neighbours.
 *
 * @param {{key: string, line: string, order: string}[]} stored As `lines`
 *   returns them.
 * @param {string} text
 * @returns {{key: string, value: ?string}[]} each pref under
 *   `MY_FILTER_BRANCH` to set to `value`, or to clear where it is null.
 */
export function plan(stored, text) {
  const wanted = splitLines(text);
  const unused = new Map();
  stored.forEach((entry, index) => {
    if (!unused.has(entry.line)) {
      unused.set(entry.line, []);
    }
    unused.get(entry.line).push(index);
  });
  const taken = wanted.map(line => unused.get(line)?.shift() ?? -1);
  const takenAt = [];
  taken.forEach((index, at) => index != -1 && takenAt.push(at));
  const stays = new Set(
    [...longestRise(takenAt.map(at => taken[at]))].map(i => takenAt[i])
  );

  const inUse = new Set(stored.map(entry => entry.key));
  const freeKey = line => {
    for (let n = 0; ; n++) {
      const key = lineKey(line, n);
      if (!inUse.has(key)) {
        inUse.add(key);
        return key;
      }
    }
  };

  const writes = [];
  let at = 0;
  let previous = "";
  while (at < wanted.length) {
    if (stays.has(at)) {
      previous = stored[taken[at]].order;
      at++;
      continue;
    }
    let end = at;
    while (end < wanted.length && !stays.has(end)) {
      end++;
    }
    const next = end < wanted.length ? stored[taken[end]].order : null;
    const orders = ordersBetween(previous, next, end - at);
    for (let i = at; i < end; i++) {
      const line = wanted[i];
      const key = taken[i] == -1 ? freeKey(line) : stored[taken[i]].key;
      writes.push({
        key,
        value: JSON.stringify({ line, order: orders[i - at] }),
      });
    }
    at = end;
  }
  const kept = new Set(taken.filter(index => index != -1));
  stored.forEach((entry, index) => {
    if (!kept.has(index)) {
      writes.push({ key: entry.key, value: null });
    }
  });
  return writes;
}

/**
 * Makes My filters `text`, writing only the lines that changed.
 *
 * @param {string} text
 * @param {object} [prefs]
 * @throws {Error} what the pref store throws for a line it refuses, past
 *   `MAX_PREF_LENGTH` (`nsPrefBranch::CheckSanityOfStringLength`).
 */
export function store(text, prefs = Services.prefs) {
  for (const { key, value } of plan(lines(prefs), text)) {
    if (value === null) {
      prefs.clearUserPref(MY_FILTER_BRANCH + key);
    } else {
      prefs.setStringPref(MY_FILTER_BRANCH + key, value);
    }
  }
}

/**
 * Moves the rules a profile holds in `TEXT_PREF` into `MY_FILTER_BRANCH`,
 * after any lines already there that sync brought, and clears `TEXT_PREF`
 * once the branch reads them back. Lines already there are not added twice,
 * so devices that held the same rules end with one copy.
 *
 * @param {object} [prefs]
 * @returns {?{from: string, to: string}} the text moved and the text the
 *   rules read as after, or null when there was nothing to move.
 */
export function moveText(prefs = Services.prefs) {
  if (!prefs.prefHasUserValue(TEXT_PREF)) {
    return null;
  }
  const from = prefs.getStringPref(TEXT_PREF, "");
  if (!isPlainText(from)) {
    return null;
  }
  const stored = lines(prefs);
  const have = new Map();
  for (const entry of stored) {
    have.set(entry.line, (have.get(entry.line) ?? 0) + 1);
  }
  const added = [];
  for (const line of splitLines(from)) {
    if (have.get(line)) {
      have.set(line, have.get(line) - 1);
    } else {
      added.push(line);
    }
  }
  const to = [...stored.map(entry => entry.line), ...added];
  store(to.join("\n"), prefs);
  const read = textOf(lines(prefs));
  if (read != to.join("\n")) {
    return null;
  }
  prefs.clearUserPref(TEXT_PREF);
  return { from, to: read };
}
