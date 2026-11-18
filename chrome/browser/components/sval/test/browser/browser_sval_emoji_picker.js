/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/**
 * The emoji picker the Emoji button of the new workspace, new group and
 * Edit dialogs opens: that the choices are on screen the moment it opens, and
 * that each way of choosing, searching and dismissing reaches the document.
 * Each picker here is opened from a group's Edit dialog, which Save then
 * writes.
 *
 * The picker is a page in the window's modal dialog (`gDialogBox`), so the
 * tests reach its document through the dialog's frame.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

const { EMOJI_GROUPS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEmojiData.sys.mjs"
);
const { drawableEmojiGroups } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEmojiPicker.sys.mjs"
);
const { searchEmoji, emojiAtTone } = SvalPanelModel;

add_setup(async function the_window_is_ready() {
  await within(SvalPanel.started, 10_000, "the panel starting");
});

/**
 * Makes a group wearing `initial` in the workspace the window shows, removed
 * when the task ends, and opens the picker from its Edit dialog.
 *
 * @param {string} initial The group's emoji.
 * @returns {Promise<{answer: Function, doc: Document}>} the picker's
 *   document, and `answer`, which saves the Edit dialog the picker goes back
 *   to and gives the emoji the group then wears, or "" for none.
 */
async function openPicker(initial = "") {
  const { engine } = SvalPanel;
  const group = crypto.randomUUID();
  await engine.mutate({
    kind: "batch",
    ops: [
      {
        kind: "addGroup",
        parent: SvalWindowWorkspace.of(window).id,
        name: "Picked",
        id: group,
      },
      ...(initial
        ? [{ kind: "setAppearance", id: group, color: null, emoji: initial }]
        : []),
    ],
    now: Date.now(),
  });
  atTaskEnd(async () => {
    if (group in (await nodes(engine))) {
      await engine.mutate({ kind: "remove", id: group });
      await SvalPanel.refresh();
    }
  });
  await SvalPanel.refresh();
  await chooseOnRow(group, "edit");
  const edit = await dialogDocument(".sval-nw-emoji");
  edit.querySelector(".sval-nw-emoji").click();
  await dialogGone(edit);
  const doc = await dialogDocument(".sval-emoji-choice");
  const answer = async () => {
    await dialogGone(doc);
    const reopened = await dialogDocument(".sval-nw-name");
    reopened.querySelector(".sval-nw-create").click();
    await dialogGone(reopened);
    await within(SvalPanel.observer.settled(), 10_000, "the window settling");
    return SvalTree.appearanceOf(await nodes(engine), group).emoji ?? "";
  };
  return { answer, doc };
}

/**
 * An emoji newer than the system's emoji font would be drawn as a box holding
 * its code point. The picker leaves such a character out and keeps the rest.
 * U+10FFFD is a private-use character no system font draws.
 */
add_task(async function an_emoji_no_font_draws_is_left_out() {
  const opened = await openPicker();
  const groups = [
    {
      name: "Test",
      emoji: [
        ["\u{10FFFD}", "nothing draws this"],
        ["😀", "grinning face"],
      ],
    },
    { name: "Empty", emoji: [["\u{10FFFD}", "nothing draws this either"]] },
  ];
  Assert.deepEqual(
    drawableEmojiGroups(groups, opened.doc),
    [{ name: "Test", emoji: [["😀", "grinning face"]] }],
    "the drawable emoji is kept, and a group left with none is gone"
  );
  await dismiss(opened);
});

/**
 * Closes the picker as dismissing it does, and gives what the group then
 * wears.
 *
 * @param {{answer: Function, doc: Document}} opened What {@link openPicker}
 *   returned.
 * @returns {Promise<string>} the group's emoji.
 */
function dismiss({ answer, doc }) {
  doc.defaultView.close();
  return answer();
}

/**
 * @param {Document} doc The picker's document.
 * @returns {Element[]} the emoji buttons on show.
 */
function visibleChoices(doc) {
  return [...doc.querySelectorAll(".sval-emoji-choice")].filter(b => !b.hidden);
}

/**
 * @param {Document} doc The picker's document.
 * @param {string} key A `KeyboardEvent.key`.
 * @param {Element} [target] Where it is sent; the search field by default.
 */
function press(doc, key, target = doc.querySelector(".sval-emoji-search")) {
  target.dispatchEvent(
    new doc.defaultView.KeyboardEvent("keydown", { key, bubbles: true })
  );
}

/**
 * @param {Document} doc The picker's document.
 * @param {string} text What is typed into the search field.
 */
function typeSearch(doc, text) {
  const search = doc.querySelector(".sval-emoji-search");
  search.value = text;
  search.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
}

/**
 * The point of the picker: opening it shows emoji, with nothing to find or
 * press first, and the search field has the keyboard.
 */
add_task(async function the_choices_are_on_screen_when_it_opens() {
  const opened = await openPicker();
  const { doc } = opened;

  const total = drawableEmojiGroups(EMOJI_GROUPS, doc).reduce(
    (n, g) => n + g.emoji.length,
    0
  );
  Assert.greater(total, 1000, "this system draws most of Unicode's emoji");
  Assert.equal(
    visibleChoices(doc).length,
    total,
    "every emoji it draws is on show, with no query typed"
  );
  const first = visibleChoices(doc)[0];
  Assert.greater(
    first.getBoundingClientRect().height,
    0,
    "and the first is actually laid out, not merely present"
  );
  Assert.equal(
    doc.activeElement,
    doc.querySelector(".sval-emoji-search"),
    "the search field has the keyboard, so typing narrows at once"
  );
  Assert.ok(
    doc.querySelector(".sval-emoji-none").hidden,
    "a node with no emoji has none to remove, so there is no such button"
  );
  Assert.ok(
    !document.getElementById("sval-emoji-picker"),
    "and it is the window's own dialog, not a separate popup that can be left " +
      "floating over another application"
  );

  await dismiss(opened);
});

/**
 * Clicks a skin tone, as a pointer user does.
 *
 * @param {Element} tone
 */
function clickTone(tone) {
  // The tones are a radio group with a roving tabindex: Tab reaches the
  // chosen one and the arrow keys the rest.
  AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
  tone.click();
  AccessibilityUtils.resetEnv();
}

/**
 * Clicking an emoji answers with it, whole.
 */
add_task(async function clicking_an_emoji_answers_with_it() {
  const { answer, doc } = await openPicker();
  const flag = [...doc.querySelectorAll(".sval-emoji-choice")].find(
    b => b.textContent === "🇯🇵"
  );
  Assert.ok(flag, "a flag is on offer");
  // The grid has one Tab stop, and the arrow keys, Home and End reach the
  // rest. The checker looks for that stop only in the clicked cell's own row
  // group, and the flag's group is not the one holding it.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  flag.click();
  AccessibilityUtils.resetEnv();
  Assert.strictEqual(
    await answer(),
    "🇯🇵",
    "the group wears it, both regional indicators"
  );
});

add_task(async function searching_narrows_and_enter_chooses_the_first() {
  const { answer, doc } = await openPicker();
  typeSearch(doc, "fish");

  const expected = searchEmoji(drawableEmojiGroups(EMOJI_GROUPS, doc), "fish");
  Assert.deepEqual(
    visibleChoices(doc).map(b => b.getAttribute("aria-label")),
    expected.map(e => e[1]),
    "exactly the matches are on show"
  );
  Assert.less(
    visibleChoices(doc).length,
    20,
    "which is far fewer than all of them"
  );
  const groups = [...doc.querySelectorAll(".sval-emoji-group")].filter(
    g => !g.hidden
  );
  Assert.less(
    groups.length,
    EMOJI_GROUPS.length,
    "and a group with no match is gone rather than left as a bare heading"
  );

  press(doc, "Enter");
  Assert.strictEqual(await answer(), expected[0][0], "Enter picks the first");
});

/**
 * A search with no match says so and offers nothing to press Enter on.
 */
add_task(async function a_search_with_no_match_says_so() {
  const opened = await openPicker();
  const { doc } = opened;
  typeSearch(doc, "qqqqqqqq");
  Assert.equal(visibleChoices(doc).length, 0, "nothing is on show");
  Assert.ok(!doc.querySelector(".sval-emoji-empty").hidden, "and it says so");

  press(doc, "Enter");
  Assert.ok(gDialogBox.isOpen, "Enter with nothing to pick does nothing");

  await dismiss(opened);
});

/**
 * The skin tone redraws the emoji that have one, and an emoji picked after it
 * answers at that tone. The tone is kept for the next time the picker opens.
 */
add_task(async function a_skin_tone_applies_to_what_is_picked_after_it() {
  const { answer, doc } = await openPicker();
  const dark = doc.querySelector('.sval-emoji-tone[data-tone="4"]');
  clickTone(dark);
  Assert.equal(dark.getAttribute("aria-checked"), "true", "the tone is chosen");

  typeSearch(doc, "thumbs up");
  const thumbs = visibleChoices(doc)[0];
  const entry = searchEmoji(EMOJI_GROUPS, "thumbs up")[0];
  Assert.equal(thumbs.textContent, emojiAtTone(entry, 4), "it is drawn dark");
  thumbs.click();
  Assert.strictEqual(await answer(), "👍🏿", "and the group wears it dark");

  const second = await openPicker();
  Assert.equal(
    second.doc
      .querySelector('.sval-emoji-tone[data-tone="4"]')
      .getAttribute("aria-checked"),
    "true",
    "the next picker opens with it still set"
  );
  clickTone(second.doc.querySelector('.sval-emoji-tone[data-tone=""]'));
  visibleChoices(second.doc)[0].click();
  await second.answer();

  const third = await openPicker();
  Assert.equal(
    third.doc
      .querySelector('.sval-emoji-tone[data-tone=""]')
      .getAttribute("aria-checked"),
    "true",
    "and the default is what it keeps once that is chosen and something picked"
  );
  await dismiss(third);
});

/**
 * The arrow keys move through the grid and back to the search field.
 */
add_task(async function the_arrow_keys_move_through_the_grid() {
  const opened = await openPicker();
  const { doc } = opened;
  const choices = visibleChoices(doc);

  press(doc, "ArrowDown");
  Assert.equal(doc.activeElement, choices[0], "down from search enters it");
  press(doc, "ArrowRight", choices[0]);
  Assert.equal(doc.activeElement, choices[1], "right moves along");
  press(doc, "ArrowLeft", choices[1]);
  Assert.equal(doc.activeElement, choices[0], "left moves back");
  press(doc, "ArrowDown", choices[0]);
  Assert.greater(
    visibleChoices(doc).indexOf(doc.activeElement),
    1,
    "down moves to a later row"
  );
  press(doc, "End", doc.activeElement);
  Assert.equal(
    doc.activeElement,
    choices[choices.length - 1],
    "End goes to the last"
  );
  press(doc, "Home", doc.activeElement);
  press(doc, "ArrowUp", doc.activeElement);
  Assert.equal(
    doc.activeElement,
    doc.querySelector(".sval-emoji-search"),
    "up from the first row returns to the search field"
  );

  await dismiss(opened);
});

/**
 * Dismissing is a cancel, which writes nothing, and "No emoji" is the one way
 * to clear.
 */
add_task(async function dismissing_cancels_and_no_emoji_clears() {
  let opened = await openPicker("🐟");
  Assert.strictEqual(await dismiss(opened), "🐟", "closing changes nothing");

  opened = await openPicker("🐟");
  opened.doc.querySelector(".sval-emoji-cancel").click();
  Assert.strictEqual(await opened.answer(), "🐟", "and nor does Cancel");

  opened = await openPicker("🐟");
  const none = opened.doc.querySelector(".sval-emoji-none");
  Assert.ok(!none.hidden, "a node that has an emoji can have it removed");
  none.click();
  Assert.strictEqual(await opened.answer(), "", "and that clears it");
});

/**
 * Opening again starts clean: the last search does not carry over.
 */
add_task(async function it_opens_clean_each_time() {
  let opened = await openPicker();
  typeSearch(opened.doc, "fish");
  await dismiss(opened);

  opened = await openPicker();
  Assert.equal(
    opened.doc.querySelector(".sval-emoji-search").value,
    "",
    "the field is empty"
  );
  Assert.greater(
    visibleChoices(opened.doc).length,
    1000,
    "and everything is back"
  );
  await dismiss(opened);
});

const gAccService = Cc["@mozilla.org/accessibilityService;1"].getService(
  Ci.nsIAccessibilityService
);

/**
 * The skin tones are one radio group: Tab reaches the chosen tone only, and
 * the arrow keys move the choice, as a screen reader says they will.
 */
add_task(async function the_skin_tones_are_a_radio_group() {
  const opened = await openPicker();
  const { doc } = opened;
  const tones = [...doc.querySelectorAll(".sval-emoji-tone")];
  const reachable = () => tones.filter(t => t.tabIndex === 0);
  Assert.deepEqual(
    reachable(),
    tones.filter(t => t.getAttribute("aria-checked") === "true"),
    "Tab reaches the chosen tone alone"
  );

  const at = tones.indexOf(reachable()[0]);
  tones[at].focus();
  EventUtils.synthesizeKey("KEY_ArrowRight", {}, doc.defaultView);
  const next = tones[(at + 1) % tones.length];
  Assert.equal(doc.activeElement, next, "ArrowRight moves to the next tone");
  Assert.equal(next.getAttribute("aria-checked"), "true", "and chooses it");
  Assert.deepEqual(reachable(), [next], "which is then the one Tab reaches");
  EventUtils.synthesizeKey("KEY_ArrowLeft", {}, doc.defaultView);
  Assert.equal(
    tones[at].getAttribute("aria-checked"),
    "true",
    "ArrowLeft moves back"
  );

  await dismiss(opened);
});

/**
 * @param {Document} doc
 * @param {string} color Any CSS colour the document resolves.
 * @returns {number} its WCAG relative luminance, as drawn.
 */
function luminance(doc, color) {
  const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(
    c => {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The chosen skin tone is ringed at 3:1 or more against the page, in both
 * themes.
 */
add_task(async function the_chosen_tone_is_ringed_at_3_to_1() {
  const before = window.browsingContext.prefersColorSchemeOverride;
  try {
    for (const scheme of ["light", "dark"]) {
      window.browsingContext.prefersColorSchemeOverride = scheme;
      const opened = await openPicker();
      const { doc } = opened;
      const chosen = doc.querySelector('.sval-emoji-tone[aria-checked="true"]');
      const ring = luminance(
        doc,
        doc.defaultView.getComputedStyle(chosen).borderTopColor
      );
      const page = luminance(
        doc,
        doc.defaultView.getComputedStyle(doc.documentElement).backgroundColor
      );
      const ratio =
        (Math.max(ring, page) + 0.05) / (Math.min(ring, page) + 0.05);
      Assert.greaterOrEqual(ratio, 3, `${scheme}: ${ratio.toFixed(2)}:1`);
      await dismiss(opened);
    }
  } finally {
    window.browsingContext.prefersColorSchemeOverride = before;
  }
});

/**
 * The emoji are one grid with one Tab stop: from the tones, Tab goes to the
 * current emoji, not to the box that scrolls them, and a screen reader is
 * told the row and column of each.
 */
add_task(async function the_emoji_are_one_grid() {
  const opened = await openPicker();
  const { doc } = opened;
  const grid = doc.querySelector(".sval-emoji-grid");
  const gridAcc = await accessibleOf(grid);
  Assert.equal(gridAcc.role, Ci.nsIAccessibleRole.ROLE_GRID, "a grid");
  Assert.equal(gridAcc.name, "Emoji", "named for what it holds");

  const choices = visibleChoices(doc);
  const first = await accessibleOf(choices[0]);
  Assert.equal(first.role, Ci.nsIAccessibleRole.ROLE_GRID_CELL, "of cells");
  Assert.equal(first.name, choices[0].getAttribute("aria-label"), "named");
  const columns = choices.findIndex(
    b => b.parentElement !== choices[0].parentElement
  );
  Assert.greater(columns, 1, "laid out in rows");
  const below = (await accessibleOf(choices[columns])).QueryInterface(
    Ci.nsIAccessibleTableCell
  );
  Assert.equal(below.rowIndex, 1, "the second row is the second row");
  Assert.equal(below.columnIndex, 0, "and starts at the first column");

  doc.querySelector('.sval-emoji-tone[aria-checked="true"]').focus();
  EventUtils.synthesizeKey("KEY_Tab", {}, doc.defaultView);
  Assert.equal(doc.activeElement, choices[0], "Tab goes into the grid");
  EventUtils.synthesizeKey("KEY_Tab", {}, doc.defaultView);
  Assert.ok(
    !grid.contains(doc.activeElement) && doc.activeElement !== grid,
    "and the next Tab leaves it"
  );
  await dismiss(opened);
});
