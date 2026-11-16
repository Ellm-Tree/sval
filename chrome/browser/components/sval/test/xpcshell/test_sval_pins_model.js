/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// The pins row's arithmetic (pins spec §4, §6, §7): what shows where, how it
// lays out, and what ⌘1–9 and a link mean.

const {
  layout,
  leavesPin,
  numberedSlot,
  perLine,
  pinOf,
  pinsInFolder,
  scopeFor,
  showsIn,
  siteOfPin,
  slotOf,
  slotsIn,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPinsModel.sys.mjs"
);

const pin = (guid, scope = null) => ({
  guid,
  kind: "favorite",
  name: guid,
  url: `https://${guid}.example/`,
  scope,
  children: null,
});

const folder = (guid, children, scope = null) => ({
  guid,
  kind: "folder",
  name: guid,
  url: null,
  scope,
  children,
});

add_task(function pins_per_line_follow_the_panel_width() {
  Assert.equal(perLine(280), 4, "4 at the default width");
  Assert.equal(perLine(480), 8, "8 at 480px");
  Assert.equal(perLine(120), 2, "never fewer than 2");
  Assert.equal(perLine(48), 1, "one column in the 48px panel");
});

add_task(function a_pin_shows_where_its_scope_says() {
  const workspaces = new Set(["home", "work"]);
  Assert.ok(showsIn(null, "work", workspaces), "no scope is everywhere");
  Assert.ok(showsIn(["work"], "work", workspaces));
  Assert.ok(!showsIn(["home"], "work", workspaces), "limited to another");
  Assert.ok(
    showsIn(["gone"], "work", workspaces),
    "a scope of deleted workspaces only is every workspace"
  );
  Assert.ok(
    !showsIn(["gone", "home"], "work", workspaces),
    "a deleted workspace counts for nothing"
  );

  const tiles = [pin("a"), pin("b", ["home"]), folder("f", [pin("c")])];
  Assert.deepEqual(
    slotsIn(tiles, "work", workspaces).map(t => t.guid),
    ["a", "f"],
    "the row filters by workspace, a folder as one slot"
  );
});

add_task(function show_in_stores_every_workspace_as_all() {
  Assert.equal(scopeFor(["b", "a"], ["a", "b"]), null, "every box is all");
  Assert.deepEqual(scopeFor(["b"], ["a", "b"]), ["b"]);
  Assert.equal(scopeFor([], ["a", "b"]), undefined, "none ticked: no change");
});

add_task(function the_row_folds_past_its_line_limit_into_plus_n() {
  const slots = Array.from({ length: 18 }, (_, i) => pin(`p${i}`));
  const { lines, hidden } = layout(slots, { columns: 4, lines: 4 });
  Assert.equal(lines.length, 4, "four lines");
  Assert.deepEqual(
    lines.map(line => line.length),
    [4, 4, 4, 4]
  );
  Assert.equal(lines[3][3], null, "the last slot is +N");
  Assert.equal(hidden.length, 3, "holding the three that do not fit");
  Assert.equal(hidden[0].guid, "p15");

  const short = layout(slots.slice(0, 6), { columns: 4, lines: 4 });
  Assert.deepEqual(
    short.lines.map(line => line.length),
    [4, 2],
    "lines fill by order alone, the last one short"
  );
  Assert.equal(short.hidden.length, 0);

  const narrow = layout(slots, { columns: 1, lines: 4, narrow: true });
  Assert.equal(narrow.lines.length, 6, "the 48px panel shows six slots");
  Assert.equal(narrow.lines[5][0], null, "the sixth is +N");
});

add_task(function a_folder_is_one_slot_holding_every_pin_in_it() {
  const inner = folder("sub", [pin("c")]);
  const f = folder("f", [pin("a"), inner, pin("b")]);
  Assert.deepEqual(
    pinsInFolder(f).map(p => p.guid),
    ["a", "c", "b"],
    "every favorite in a pinned folder is a pin, subfolders too"
  );
  const slots = [pin("x"), f, pin("a")];
  Assert.equal(slotOf(slots, "c"), f, "a pin in a folder is the folder's slot");
  Assert.equal(
    slotOf(slots, "a"),
    slots[2],
    "a pin also pinned on its own is its own slot"
  );
  Assert.equal(pinOf(slots, "c").guid, "c");
  Assert.equal(numberedSlot(slots, 2), f, "⌘2 is the folder");
  Assert.equal(numberedSlot(slots, 4), null, "past the end is nothing");
});

add_task(function a_link_leaves_a_pin_for_another_site() {
  const fastmail = siteOfPin("https://app.fastmail.com/mail/Inbox");
  Assert.equal(fastmail, "fastmail.com", "a pin's site is its address's site");
  Assert.ok(!leavesPin("https://app.fastmail.com/mail/Sent", fastmail));
  Assert.ok(
    !leavesPin("https://www.fastmail.com/pricing", fastmail),
    "another host on the same site stays in the pin"
  );
  Assert.ok(leavesPin("https://news.example.com/story", fastmail));
  Assert.ok(
    leavesPin("https://fastmail.example.com/", fastmail),
    "a site is its registrable domain, not a label in it"
  );
  Assert.ok(!leavesPin("mailto:a@fastmail.com", fastmail), "no web page");
  Assert.ok(!leavesPin("not a url", fastmail));
  Assert.ok(
    leavesPin("https://example.com/", siteOfPin("file:///tmp/page.html")),
    "a pin with no site leaves for any web page"
  );
});
