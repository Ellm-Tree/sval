/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from panel_model_head.js */

/**
 * The whole keyboard map, asserted as a map. Spec §10.5 requires arrow
 * navigation, Left/Right collapse and expand, and Enter to activate, and
 * forbids a mouse-only action, so every mutation has a key here too.
 */
add_task(function the_keyboard_map_covers_every_action() {
  const { keyCommand } = SvalPanelModel;
  const leaf = { id: "t", hasChildren: false, expanded: false, depth: 2 };
  const closed = { id: "g", hasChildren: true, expanded: false, depth: 1 };
  const open = { id: "g", hasChildren: true, expanded: true, depth: 1 };
  const root = { id: "ws", hasChildren: false, expanded: false, depth: 0 };
  const key = (k, extra = {}) => ({ key: k, ...extra });

  Assert.equal(keyCommand(key("ArrowDown"), leaf), "focusNext");
  Assert.equal(keyCommand(key("ArrowUp"), leaf), "focusPrevious");
  Assert.equal(keyCommand(key("Home"), leaf), "focusFirst");
  Assert.equal(keyCommand(key("End"), leaf), "focusLast");

  Assert.equal(
    keyCommand(key("ArrowRight"), closed),
    "expand",
    "Right on a collapsed parent expands it"
  );
  Assert.equal(
    keyCommand(key("ArrowRight"), open),
    "focusNext",
    "Right on an expanded parent moves to its first child, which is the next row"
  );
  Assert.equal(
    keyCommand(key("ArrowRight"), leaf),
    null,
    "Right on a leaf does nothing, per the ARIA tree pattern"
  );

  Assert.equal(
    keyCommand(key("ArrowLeft"), open),
    "collapse",
    "Left on an expanded parent collapses it"
  );
  Assert.equal(
    keyCommand(key("ArrowLeft"), closed),
    "focusParent",
    "Left on a collapsed parent moves out to its own parent"
  );
  Assert.equal(
    keyCommand(key("ArrowLeft"), leaf),
    "focusParent",
    "Left on a leaf moves out to its parent"
  );
  Assert.equal(
    keyCommand(key("ArrowLeft"), root),
    null,
    "Left at the top level has nowhere to go"
  );

  Assert.equal(keyCommand(key("Enter"), leaf), "activate");
  Assert.equal(
    keyCommand(key(" "), leaf),
    "activate",
    "Space shows the tab, as Enter does, so the selection is what is viewed"
  );
  Assert.equal(keyCommand(key("ContextMenu"), leaf), "contextMenu");
  Assert.equal(
    keyCommand(key("F10", { shiftKey: true }), closed),
    "contextMenu",
    "Shift+F10 opens a row's menu, the one keyboard way to it on macOS"
  );
  Assert.equal(
    keyCommand(key("F10"), leaf),
    null,
    "F10 alone is the browser's"
  );
  Assert.equal(
    keyCommand(key("ContextMenu"), null),
    null,
    "with no focused row there is no menu to open"
  );
  Assert.equal(keyCommand(key("F2"), leaf), "rename");
  Assert.equal(keyCommand(key("Delete"), leaf), "close");
  Assert.equal(
    keyCommand(key("Backspace"), leaf),
    "close",
    "Backspace closes too, which is what a Mac keyboard's Delete key sends"
  );
  const group = { ...closed, kind: SvalPanelModel.GROUP };
  Assert.equal(
    keyCommand(key("Delete"), group),
    "deleteGroup",
    "Delete on a group deletes it, which asks about its contents: a group " +
      "never closes (spec §5.4)"
  );
  Assert.equal(keyCommand(key("Backspace"), group), "deleteGroup");

  // The keyboard equivalent of a drag, in all four directions a drag can
  // express. Without these, moving a node would be mouse-only.
  Assert.equal(
    keyCommand(key("ArrowUp", { altKey: true }), leaf),
    "moveBefore"
  );
  Assert.equal(
    keyCommand(key("ArrowDown", { altKey: true }), leaf),
    "moveAfter"
  );
  Assert.equal(keyCommand(key("ArrowLeft", { altKey: true }), leaf), "moveOut");
  Assert.equal(keyCommand(key("ArrowRight", { altKey: true }), leaf), "moveIn");

  Assert.equal(
    keyCommand(key("ArrowDown", { ctrlKey: true }), leaf),
    null,
    "a modified key the panel does not own is left to the browser"
  );
  Assert.equal(
    keyCommand(key("a"), leaf),
    null,
    "and so is an ordinary character"
  );
  Assert.equal(
    keyCommand(key("Enter"), null),
    null,
    "with no focused row there is nothing to activate"
  );
  Assert.equal(
    keyCommand(key("ArrowDown"), null),
    "focusNext",
    "but navigation still works, which is how focus first lands on a row"
  );
});

add_task(function type_ahead_finds_the_next_row_starting_with_what_was_typed() {
  const { typeAheadIndex } = SvalPanelModel;
  const labels = ["Reading", "One", "Two", "Three", "Loose", "Shipping"];

  Assert.equal(typeAheadIndex(labels, 0, "t"), 2, "the next row with a t");
  Assert.equal(typeAheadIndex(labels, 2, "t"), 3, "and the one after it");
  Assert.equal(typeAheadIndex(labels, 3, "t"), 2, "wrapping round");
  Assert.equal(
    typeAheadIndex(labels, 3, "tt"),
    2,
    "one character typed again steps through the rows starting with it"
  );
  Assert.equal(
    typeAheadIndex(labels, 2, "tw"),
    2,
    "a longer prefix may stay on the row already focused"
  );
  Assert.equal(typeAheadIndex(labels, 0, "SH"), 5, "without regard to case");
  Assert.equal(typeAheadIndex(labels, -1, "r"), 0, "from no focused row");
  Assert.equal(typeAheadIndex(labels, 0, "x"), -1, "and no row for none");
  Assert.equal(typeAheadIndex([], -1, "a"), -1, "nor in an empty tree");
});
