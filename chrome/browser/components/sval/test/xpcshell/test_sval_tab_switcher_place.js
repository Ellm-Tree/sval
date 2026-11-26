/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Where the Ctrl+Tab carousel stands each card (`tilePlace`): the middle card
 * square on and on top, the cards either side mirrored, overlapping more the
 * further out they are, and none drawn past the reach.
 */

const { tilePlace } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabSwitcher.sys.mjs"
);

add_task(function the_middle_card_is_square_on_and_on_top() {
  const middle = tilePlace(0);
  Assert.equal(middle.x, 0, "in the middle");
  Assert.equal(middle.turn, 0, "unturned");
  Assert.equal(middle.scale, 1, "full size");
  Assert.equal(middle.shade, 0, "undarkened");
  Assert.ok(middle.shown, "drawn");
  for (const offset of [-3, -1, -0.5, 0.5, 1, 3]) {
    Assert.greater(
      middle.depth,
      tilePlace(offset).depth,
      `above the card ${offset} out`
    );
  }
});

add_task(function the_sides_mirror_each_other() {
  for (const offset of [0.25, 1, 2.5, 5]) {
    const right = tilePlace(offset);
    const left = tilePlace(-offset);
    Assert.equal(left.x, -right.x, `${offset} out stands mirrored`);
    Assert.equal(left.turn, -right.turn, "and turns the other way");
    Assert.equal(left.scale, right.scale, "at one size");
    Assert.equal(left.depth, right.depth, "at one depth");
  }
});

add_task(function the_cards_overlap_more_the_further_out() {
  const step = n => tilePlace(n + 1).x - tilePlace(n).x;
  Assert.less(step(0), 1, "the first card overlaps the middle one");
  Assert.less(step(1), step(0), "the next overlaps it more");
  Assert.less(
    Math.abs(step(2) - step(1)),
    1e-9,
    "and each further one as much"
  );
  Assert.greater(tilePlace(1).x, tilePlace(0.5).x, "a card moves out smoothly");
  Assert.equal(
    tilePlace(1).turn,
    tilePlace(4).turn,
    "a card is fully turned one card out"
  );
});

add_task(function cards_past_the_reach_are_not_drawn() {
  let reach = 0;
  while (tilePlace(reach + 1).shown) {
    reach++;
  }
  Assert.greater(reach, 2, "several cards each side are drawn");
  Assert.ok(!tilePlace(reach + 1).shown, "the next is not");
  Assert.ok(!tilePlace(-(reach + 1)).shown, "on either side");
});
