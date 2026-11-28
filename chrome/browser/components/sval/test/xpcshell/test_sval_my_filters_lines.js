/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// My filters kept a pref per line (settings-sync spec §4.4):
// the orders that place the lines, the writes an edit makes, and the move of
// rules held as one text.

const {
  MY_FILTER_BRANCH,
  lineKey,
  lines,
  moveText,
  orderBetween,
  ordersBetween,
  plan,
  store,
  textOf,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalMyFilters.sys.mjs"
);

const TEXT_PREF = "browser.sval.adblock.myFilters";

function clearAll() {
  for (const name of Services.prefs.getChildList(MY_FILTER_BRANCH)) {
    Services.prefs.clearUserPref(name);
  }
  Services.prefs.clearUserPref(TEXT_PREF);
}

/** @returns {Map<string, string>} each line pref's name and value. */
function snapshot() {
  return new Map(
    Services.prefs
      .getChildList(MY_FILTER_BRANCH)
      .map(name => [name, Services.prefs.getStringPref(name)])
  );
}

/**
 * @param {Map<string, string>} before
 * @returns {string[]} the line prefs written or cleared since `before`.
 */
function changedSince(before) {
  const after = snapshot();
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    name => before.get(name) !== after.get(name)
  );
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean} whether `a` sorts before `b`.
 */
function isBefore(a, b) {
  return a < b;
}

add_task(function an_order_falls_strictly_between_its_neighbours() {
  const cases = [
    ["", null],
    ["", "1"],
    ["", "01"],
    ["h", "h1"],
    ["h", "i"],
    ["z", null],
    ["zz", null],
    ["a1", "a2"],
    ["9", "a"],
  ];
  for (const [a, b] of cases) {
    const order = orderBetween(a, b);
    Assert.ok(isBefore(a, order), `${order} is after ${JSON.stringify(a)}`);
    if (b !== null) {
      Assert.ok(isBefore(order, b), `${order} is before ${b}`);
    }
    Assert.ok(/[1-9a-z]$/.test(order), `${order} does not end in 0`);
  }
});

add_task(function a_run_of_orders_rises_and_stays_short() {
  const run = ordersBetween("", null, 1000);
  Assert.equal(run.length, 1000);
  for (let i = 1; i < run.length; i++) {
    Assert.ok(isBefore(run[i - 1], run[i]), `order ${i} rises`);
  }
  Assert.lessOrEqual(
    Math.max(...run.map(order => order.length)),
    12,
    "a thousand lines pasted at once take short orders"
  );
});

add_task(function stored_text_reads_back_as_written() {
  clearAll();
  const text = "a##.x\n! note\n\nb##.y\na##.x";
  store(text);
  Assert.equal(textOf(lines()), text, "blank and repeated lines are kept");
  Assert.deepEqual(
    lines().map(entry => entry.key),
    [
      lineKey("a##.x", 0),
      lineKey("! note", 0),
      lineKey("", 0),
      lineKey("b##.y", 0),
      lineKey("a##.x", 1),
    ],
    "a repeated line takes the next key of its text"
  );
  store("a##.x\n\n");
  Assert.equal(textOf(lines()), "a##.x\n\n", "empty lines at the end too");
  clearAll();
});

add_task(function an_edit_writes_only_the_lines_it_changes() {
  clearAll();
  store("one\ntwo\nthree\nfour");
  const kept = lines();
  let before = snapshot();
  store("one\ntwo, edited\nthree\nfour\nfive");
  Assert.deepEqual(
    changedSince(before).sort(),
    [
      MY_FILTER_BRANCH + lineKey("two", 0),
      MY_FILTER_BRANCH + lineKey("two, edited", 0),
      MY_FILTER_BRANCH + lineKey("five", 0),
    ].sort(),
    "an edited line is a removal and an addition, and the rest stay"
  );
  Assert.equal(
    lines().find(entry => entry.line == "three").order,
    kept.find(entry => entry.line == "three").order,
    "an untouched line keeps its order"
  );

  before = snapshot();
  store("four\none\ntwo, edited\nthree\nfive");
  Assert.deepEqual(
    changedSince(before),
    [MY_FILTER_BRANCH + lineKey("four", 0)],
    "a moved line is the one line written"
  );
  Assert.equal(textOf(lines()), "four\none\ntwo, edited\nthree\nfive");

  Assert.deepEqual(plan(lines(), textOf(lines())), [], "no edit, no writes");
  store("");
  Assert.deepEqual(snapshot(), new Map(), "an empty text clears every line");
});

add_task(function edits_to_different_lines_merge() {
  // Two devices start from the same lines. Each edits its own copy, and the
  // settings merge keeps the newer write of each pref, so applying both
  // devices' writes to the shared lines holds both edits.
  clearAll();
  store("a\nb\nc");
  const shared = snapshot();
  store("a, here\nb\nc");
  const here = snapshot();
  for (const [name, value] of shared) {
    Services.prefs.setStringPref(name, value);
  }
  for (const name of Services.prefs.getChildList(MY_FILTER_BRANCH)) {
    if (!shared.has(name)) {
      Services.prefs.clearUserPref(name);
    }
  }
  store("a\nb\nc\nd");
  for (const [name, value] of here) {
    if (shared.get(name) !== value) {
      Services.prefs.setStringPref(name, value);
    }
  }
  for (const name of shared.keys()) {
    if (!here.has(name)) {
      Services.prefs.clearUserPref(name);
    }
  }
  Assert.equal(textOf(lines()), "a, here\nb\nc\nd");
  clearAll();
});

add_task(function a_value_that_is_not_a_line_is_left_out() {
  clearAll();
  store("kept");
  const bad = [
    ["1", "not json"],
    ["2", JSON.stringify({ line: "x\ny", order: "i" })],
    ["3", JSON.stringify({ line: "x\u0001", order: "i" })],
    ["4", JSON.stringify({ line: "x", order: "i0" })],
    ["5", JSON.stringify({ line: "x" })],
  ];
  for (const [key, value] of bad) {
    Services.prefs.setStringPref(MY_FILTER_BRANCH + key, value);
  }
  Services.prefs.setIntPref(MY_FILTER_BRANCH + "6", 42);
  Assert.equal(textOf(lines()), "kept");
  clearAll();
});

add_task(function rules_held_as_one_text_move_into_lines() {
  clearAll();
  Services.prefs.setStringPref(TEXT_PREF, "a\nb\nb\n");
  Assert.deepEqual(moveText(), { from: "a\nb\nb\n", to: "a\nb\nb\n" });
  Assert.ok(!Services.prefs.prefHasUserValue(TEXT_PREF), "the text is gone");
  Assert.equal(textOf(lines()), "a\nb\nb\n", "and reads as it did");
  const moved = snapshot();

  clearAll();
  store("b\nc");
  Services.prefs.setStringPref(TEXT_PREF, "a\nb\nb");
  moveText();
  Assert.equal(
    textOf(lines()),
    "b\nc\na\nb",
    "lines sync brought first stay, and only the rest are added"
  );

  clearAll();
  Services.prefs.setStringPref(TEXT_PREF, "a\nb\nb\n");
  moveText();
  Assert.deepEqual(
    snapshot(),
    moved,
    "two devices moving the same text write the same prefs"
  );
  Assert.equal(moveText(), null, "with nothing left to move, nothing moves");
  clearAll();
});
