/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from panel_model_head.js */

/**
 * One grapheme cluster, and the cluster is whatever Unicode says it is.
 *
 * A flag is two regional-indicator code points; a skin-toned figure is several
 * joined by zero-width joiners. `value[0]` would hand back half a surrogate
 * pair and `[...value][0]` one code point out of a sequence, so this asserts
 * the exact strings survive: the engine preserves them, and the UI layer must
 * not truncate them.
 */
add_task(function an_emoji_is_one_grapheme_cluster_however_long() {
  const { chosenEmoji } = SvalPanelModel;

  Assert.strictEqual(chosenEmoji(true, "🐟"), "🐟", "a plain emoji");
  Assert.strictEqual(
    chosenEmoji(true, "🇯🇵"),
    "🇯🇵",
    "a flag is two regional indicators and stays both"
  );
  Assert.strictEqual(
    chosenEmoji(true, "👩🏽‍🚀"),
    "👩🏽‍🚀",
    "a skin-toned figure is a ZWJ sequence and stays whole"
  );
  Assert.strictEqual(
    chosenEmoji(true, "👨‍👩‍👧‍👦"),
    "👨‍👩‍👧‍👦",
    "and so is a family, four figures and three joiners"
  );
  Assert.strictEqual(
    chosenEmoji(true, "🇯🇵🇫🇷"),
    "🇯🇵",
    "two flags give the first flag, not one indicator of each"
  );
  Assert.strictEqual(
    chosenEmoji(true, "  🐟  "),
    "🐟",
    "surrounding whitespace is not part of it"
  );

  Assert.strictEqual(
    chosenEmoji(true, ""),
    null,
    "an empty field clears the emoji: setting one must be undoable"
  );
  Assert.strictEqual(chosenEmoji(true, "   "), null, "and whitespace is empty");
  Assert.strictEqual(
    chosenEmoji(false, "🐟"),
    undefined,
    "cancelling writes nothing at all, which is not the same as clearing"
  );
});

const { EMOJI_GROUPS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEmojiData.sys.mjs"
);

add_task(function a_random_workspace_emoji_comes_from_things_and_places() {
  const { randomWorkspaceEmoji } = SvalPanelModel;
  const groups = [
    { name: "Smileys & Emotion", emoji: [["😀", "grinning face"]] },
    {
      name: "Animals & Nature",
      emoji: [
        ["🐶", "dog face"],
        ["👍", "thumbs up", ["👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿"]],
      ],
    },
    { name: "Flags", emoji: [["🇯🇵", "flag: Japan"]] },
  ];

  Assert.equal(
    randomWorkspaceEmoji(groups, () => 0),
    "🐶",
    "the first one"
  );
  Assert.equal(
    randomWorkspaceEmoji(groups, () => 0.99),
    "👍",
    "the last one, as the plain character and never a skin-toned variant"
  );
  Assert.equal(
    randomWorkspaceEmoji(groups, () => 1),
    "👍",
    "a source that returns 1 still lands inside the pool"
  );
  Assert.strictEqual(
    randomWorkspaceEmoji([groups[0], groups[2]]),
    null,
    "with no group to draw from there is nothing to offer"
  );

  const real = randomWorkspaceEmoji(EMOJI_GROUPS);
  Assert.ok(
    EMOJI_GROUPS.some(group => group.emoji.some(([char]) => char === real)),
    "from the real data it is an emoji the picker offers"
  );
});

/**
 * The picker's data is what it offers, so a malformed entry is a button that
 * writes a broken value into the user's document.
 */
add_task(function the_emoji_data_is_well_formed() {
  Assert.ok(EMOJI_GROUPS.length, "there are groups");
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const group of EMOJI_GROUPS) {
    Assert.ok(group.name && group.emoji.length, `${group.name} is not empty`);
    for (const [char, name, tones] of group.emoji) {
      Assert.ok(name, `${char} is named`);
      Assert.equal(
        Array.from(graphemes.segment(char)).length,
        1,
        `${name} is one grapheme cluster, so storing it stores one emoji`
      );
      if (tones) {
        Assert.equal(tones.length, 5, `${name} has all five tones`);
      }
    }
  }
});

/**
 * Search matches words of the name in any order, and an empty query is the
 * whole list.
 */
add_task(function searching_matches_every_word_of_the_name() {
  const { searchEmoji } = SvalPanelModel;
  const all = searchEmoji(EMOJI_GROUPS, "");
  Assert.equal(
    all.length,
    EMOJI_GROUPS.reduce((n, g) => n + g.emoji.length, 0),
    "an empty query matches every emoji"
  );
  Assert.equal(
    searchEmoji(EMOJI_GROUPS, "   ").length,
    all.length,
    "and so does a blank one"
  );

  const names = query => searchEmoji(EMOJI_GROUPS, query).map(e => e[1]);
  Assert.ok(
    names("smiling face").includes("grinning face with smiling eyes"),
    "words may come in any order and match inside longer words' names"
  );
  Assert.ok(names("FISH").includes("fish"), "case is ignored");
  Assert.ok(
    !names("fish zebra").length,
    "every word has to match, so two unrelated words match nothing"
  );
  Assert.deepEqual(
    names("qqqqqq"),
    [],
    "no match is an empty list, not an error"
  );
});

/**
 * A tone picks a variant where there is one and never yields a non-string.
 */
add_task(function a_tone_selects_a_variant_only_where_one_exists() {
  const { emojiAtTone, searchEmoji } = SvalPanelModel;
  const thumbs = searchEmoji(EMOJI_GROUPS, "thumbs up")[0];
  Assert.equal(thumbs[0], "👍", "the entry is the plain thumbs up");
  Assert.equal(emojiAtTone(thumbs, null), "👍", "no tone is the default");
  Assert.equal(emojiAtTone(thumbs, 0), "👍🏻", "light");
  Assert.equal(emojiAtTone(thumbs, 4), "👍🏿", "dark");
  Assert.equal(emojiAtTone(thumbs, 9), "👍", "out of range is the default");

  const fish = ["🐟", "fish"];
  Assert.equal(
    emojiAtTone(fish, 2),
    "🐟",
    "an emoji with no tones ignores one"
  );
});

/**
 * The robot is the agent's mark, so no workspace of the user's can wear it.
 */
add_task(function the_robot_is_not_offered_for_a_workspace() {
  const { AGENT_EMOJI, searchEmoji } = SvalPanelModel;
  Assert.ok(
    !EMOJI_GROUPS.some(group => group.emoji.some(([c]) => c === AGENT_EMOJI)),
    "the picker's data does not hold the robot"
  );
  Assert.deepEqual(
    searchEmoji(EMOJI_GROUPS, "robot"),
    [],
    "and searching for it finds nothing"
  );
});

/**
 * The robot is reserved for agents however it reaches the document: an emoji
 * synced from an older build is no emoji at all, and a workspace name that
 * starts with one does not start the window's title with it. A user's window
 * is always prefaced, so a page's own title can never begin one.
 */
add_task(function the_robot_is_reserved_wherever_a_user_could_put_it() {
  const { appearanceOf, rows, switcherItems, windowTitlePreface } =
    SvalPanelModel;
  for (const robot of ["🤖", "🤖\uFE0F"]) {
    const nodes = {
      w: {
        ...node({ kind: "workspace", name: "Mine", order: "80" }),
        appearance: { emoji: robot, color: null },
        appearance_at: 1,
      },
      g: {
        ...node({ kind: "group", name: "G", parent: "w", order: "40" }),
        appearance: { emoji: robot, color: null },
        appearance_at: 1,
      },
    };
    Assert.strictEqual(appearanceOf(nodes, "w").emoji, null, "no emoji");
    Assert.strictEqual(switcherItems(nodes, "w")[0].emoji, null, "listed");
    Assert.strictEqual(
      rows(nodes, { isCollapsed: () => false, root: "w" })[0].emoji,
      null,
      "nor on a row"
    );
    Assert.equal(
      windowTitlePreface(null, `${robot} Work`),
      "Work — ",
      "a leading robot and its space leave the title"
    );
  }
  Assert.equal(
    windowTitlePreface(null, "🤖", "Untitled Workspace"),
    "Untitled Workspace — ",
    "a name that was only the robot falls back to the placeholder"
  );
  Assert.equal(
    windowTitlePreface(null, "Work 🤖"),
    "Work 🤖 — ",
    "a robot later in the name is left alone"
  );
});
