/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_helpers.js */

/**
 * The dialogs the panel asks with: "New Workspace…", "New group", Edit…,
 * Rename and the deletions. Every task opens its dialog from the panel as a
 * person does, answers it, and checks what reached the document.
 *
 * The dialog is a page in the window's modal dialog (`gDialogBox`), so the
 * tests reach its document through the dialog's frame.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_helpers.js",
  this
);

const { SvalColor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);
const COLOR_TOKENS = SvalColor.PRESETS;

/**
 * Each preset as `doc` draws it, in its appearance and contrast: `tint` the
 * window a Workspace of it gets, `body` the text solved on that window, and
 * `block` a group's block on the window under the dialog.
 *
 * @param {Document} doc A dialog's document.
 * @returns {object}
 */
function paletteOf(doc) {
  const view = doc.defaultView;
  const scheme = view.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
  const more = view.matchMedia("(prefers-contrast: more)").matches;
  return Object.fromEntries(
    COLOR_TOKENS.map(token => {
      const look = SvalColor.windowLook({ color: token }, { scheme, more });
      return [
        token,
        {
          tint: SvalColor.css(look.tint),
          body: SvalColor.css(look.body),
          block: SvalColor.swatchOf(token, "group", {
            scheme,
            more,
            on: SvalPanel.windowBlockSurface(),
          }),
        },
      ];
    })
  );
}
const { EMOJI_GROUPS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEmojiData.sys.mjs"
);
const { drawableEmojiGroups } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEmojiPicker.sys.mjs"
);
const { SvalWorkspaceJar } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalWorkspaceJar.sys.mjs"
);

add_setup(async function the_window_is_ready() {
  await within(SvalPanel.started, 10_000, "the panel starting");
});

const gAccService = Cc["@mozilla.org/accessibilityService;1"].getService(
  Ci.nsIAccessibilityService
);

/**
 * @returns {Promise<Set<string>>} the workspaces the document holds.
 */
async function workspacesHeld() {
  return new Set(SvalTree.workspaceIds((await SvalPanel.engine.tree()).nodes));
}

/**
 * Opens "New Workspace…" from the switcher.
 *
 * @returns {Promise<{doc: Document, made: Function, none: Function}>} the
 *   dialog's document; `made` waits for the workspace the dialog made, which
 *   the window then shows, and gives its node; `none` checks that the dialog
 *   made none. When the task ends, the window goes back to the workspace it
 *   showed and the one made is deleted.
 */
async function openDialog() {
  const before = await workspacesHeld();
  const home = SvalPanel.workspaceId;
  await chooseNewWorkspace();
  const doc = await dialogDocument(".sval-nw-name");
  const made = async () => {
    await dialogGone(doc);
    let id;
    await TestUtils.waitForCondition(async () => {
      id = [...(await workspacesHeld())].find(each => !before.has(each));
      return (
        id &&
        SvalPanel.workspaceId === id &&
        SvalPanel._els.switcher.querySelector(".sval-switcher-name")
          ?.textContent === SvalPanel.nodes[id]?.content.name
      );
    }, "the window shows the workspace made");
    // The window opens the empty workspace's tab after the switch and files
    // it in the workspace later, from its `TabOpen`. A switch away before
    // then passes over the tab, which carries no node yet, and leaves it on
    // screen in the workspace switched to (`_handOverWindowOnce`).
    await TestUtils.waitForCondition(async () => {
      const tabId = taggedId(gBrowser.selectedTab);
      const { nodes } = await SvalPanel.engine.tree();
      return tabId && nodes[tabId]?.placement.parent === id;
    }, "the workspace holds the tab the window shows");
    // The window leaves the workspace before it goes. Nothing tells a window
    // that the engine was changed under it, so a window still showing a
    // deleted workspace moves off it at its next redraw, whenever that is,
    // and opens that workspace's tabs in whatever task is running then.
    atTaskEnd(async () => {
      await within(SvalPanel.switchTo(home), 10_000, "the switch back");
      await removeWorkspace(id);
      await SvalPanel.refresh();
      await within(SvalPanel.observer.settled(), 10_000, "the window settling");
    });
    return { ...(await SvalPanel.engine.tree()).nodes[id], id };
  };
  const none = async what => {
    await dialogGone(doc);
    await within(SvalPanel.observer.settled(), 10_000, "the window settling");
    Assert.deepEqual(
      [...(await workspacesHeld())],
      [...before],
      `${what} makes no workspace`
    );
  };
  return { doc, made, none };
}

/**
 * @param {Document} doc The dialog's document.
 * @param {string} text What is typed into the name field.
 */
function typeName(doc, text) {
  const name = doc.querySelector(".sval-nw-name");
  name.value = text;
  name.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
}

/**
 * @param {Document} doc The dialog's document.
 * @returns {string} the emoji the dialog shows, or "" when it shows none.
 */
function shownEmoji(doc) {
  const value = doc.querySelector(".sval-nw-emoji-value");
  return value.hasAttribute("data-empty") ? "" : value.textContent;
}

/**
 * @param {Document} doc The dialog's document.
 * @param {string} token A palette token, or "" for no colour.
 * @returns {Element} its swatch.
 */
function swatch(doc, token) {
  return doc.querySelector(`.sval-nw-swatch[data-token="${token}"]`);
}

/**
 * Clicks a swatch, as a pointer user picks a colour.
 *
 * @param {Document} doc The dialog's document.
 * @param {string} token A palette token, or "" for no colour.
 */
function clickSwatch(doc, token) {
  // The swatches are a radio group with a roving tabindex: Tab reaches the
  // checked one and the arrow keys the rest.
  AccessibilityUtils.setEnv({ nonNegativeTabIndexRule: false });
  swatch(doc, token).click();
  AccessibilityUtils.resetEnv();
}

/**
 * The dialog starts with an emoji already chosen, which is what the user asked
 * for, and with nothing else required of them but a name.
 */
add_task(async function the_dialog_starts_with_an_emoji_and_asks_a_name() {
  const { doc, made } = await openDialog();

  const offered = shownEmoji(doc);
  Assert.ok(offered, "an emoji is already chosen");
  Assert.ok(
    drawableEmojiGroups(EMOJI_GROUPS, document).some(group =>
      group.emoji.some(([char]) => char === offered)
    ),
    "and it is one the picker offers, which this system draws"
  );
  Assert.equal(doc.querySelector(".sval-nw-name").value, "", "with no name");
  Assert.equal(
    doc.querySelectorAll(".sval-nw-swatch").length,
    2 * COLOR_TOKENS.length + 2,
    "every preset is offered dark and light, no colour and a custom colour"
  );
  Assert.equal(
    doc.querySelector('.sval-nw-swatch[aria-checked="true"]').dataset.token,
    "",
    "and no colour is chosen"
  );
  // A workspace's swatch is the window it would get.
  const palette = paletteOf(doc);
  const painted = colour => {
    const probe = doc.createElement("div");
    probe.style.color = colour;
    doc.body.append(probe);
    const value = doc.defaultView.getComputedStyle(probe).color;
    probe.remove();
    return value;
  };
  for (const token of COLOR_TOKENS) {
    Assert.equal(
      doc.defaultView.getComputedStyle(swatch(doc, token)).backgroundColor,
      painted(palette[token].tint),
      `${token}'s swatch is the window it tints`
    );
  }

  typeName(doc, "   ");
  const create = doc.querySelector(".sval-nw-create");
  Assert.ok(!create.disabled, "Create can be reached and pressed");
  create.click();
  const name = doc.querySelector(".sval-nw-name");
  Assert.ok(gDialogBox.isOpen, "but whitespace is not a name");
  Assert.equal(doc.activeElement, name, "focus goes back to the name");
  const acc = await accessibleOf(name);
  // Lower-cased: the label is drawn upper-case, and Gecko names the field
  // from the text as drawn.
  Assert.equal(
    acc.name.toLowerCase(),
    doc.querySelector('label[for="sval-nw-name"]').textContent.toLowerCase(),
    "whose name is its label alone"
  );
  const reason = doc.getElementById("sval-nw-name-error").textContent;
  Assert.ok(reason, "a reason shows");
  Assert.equal(
    acc.description,
    reason,
    "and which is described by why it was refused"
  );
  const state = {};
  acc.getState(state, {});
  Assert.ok(state.value & Ci.nsIAccessibleStates.STATE_INVALID, "as invalid");
  typeName(doc, "Errands");
  Assert.equal(
    (await accessibleOf(name)).description,
    "",
    "typing a name clears the reason"
  );

  create.click();
  const node = await made();
  Assert.equal(node.content.name, "Errands", "the workspace has the name");
  Assert.ok(!node.appearance?.color, "no colour");
  Assert.equal(
    node.appearance?.emoji,
    offered,
    "and the emoji the dialog started with"
  );
  Assert.ok(
    !SvalWorkspaceJar.isIsolated({ [node.id]: node }, node.id),
    "and shares the cookie jar"
  );
});

/**
 * A colour is one click, and the one chosen is the workspace's.
 */
add_task(async function a_chosen_colour_is_in_the_workspace() {
  const { doc, made } = await openDialog();
  const view = doc.defaultView;
  const card = () =>
    view.getComputedStyle(doc.querySelector(".sval-nw")).backgroundColor;
  const untinted = card();

  typeName(doc, "Reading");
  clickSwatch(doc, "green");
  Assert.equal(
    swatch(doc, "green").getAttribute("aria-checked"),
    "true",
    "the swatch is ticked"
  );
  clickSwatch(doc, "pink");
  Assert.equal(
    swatch(doc, "green").getAttribute("aria-checked"),
    "false",
    "and a second choice replaces it"
  );
  const palette = paletteOf(doc);
  const probe = doc.body.appendChild(doc.createElement("div"));
  const painted = colour => {
    probe.style.backgroundColor = colour;
    return view.getComputedStyle(probe).backgroundColor;
  };
  Assert.equal(
    card(),
    painted(palette.pink.tint),
    "the dialog's card is the window the chosen colour gives"
  );
  Assert.equal(
    view.getComputedStyle(swatch(doc, "pink")).backgroundColor,
    card(),
    "the same colour as its swatch"
  );
  Assert.equal(
    view.getComputedStyle(doc.querySelector(".sval-nw-color-name")).color,
    painted(palette.pink.body),
    "with the text the palette solves for it"
  );
  clickSwatch(doc, "yellow");
  Assert.equal(
    card(),
    painted(palette.yellow.tint),
    "yellow paints its own window"
  );
  probe.remove();
  clickSwatch(doc, "");
  Assert.equal(card(), untinted, "and no colour takes the tint away");
  clickSwatch(doc, "pink");
  doc.querySelector(".sval-nw-create").click();

  const node = await made();
  Assert.equal(node.content.name, "Reading", "the name");
  Assert.equal(node.appearance?.color, "pink", "the colour");
});

/**
 * A new workspace can be made isolated (isolated workspaces spec §5). The box
 * starts unticked, since shared is the default.
 */
add_task(async function a_new_workspace_can_be_isolated() {
  const { doc, made } = await openDialog();
  const box = doc.querySelector(".sval-nw-isolated");
  Assert.ok(!box.hidden, "a new workspace offers isolation");
  const input = box.querySelector("input");
  Assert.ok(!input.checked, "unticked to begin with");
  typeName(doc, "Banking");
  input.click();
  doc.querySelector(".sval-nw-create").click();
  const node = await made();
  Assert.ok(
    SvalWorkspaceJar.isIsolated({ [node.id]: node }, node.id),
    "the workspace is made isolated"
  );
});

/**
 * The emoji it started with can be removed: the random one is a suggestion.
 */
add_task(async function the_starting_emoji_can_be_removed() {
  const { doc, made } = await openDialog();
  typeName(doc, "Plain");

  doc.querySelector(".sval-nw-emoji").click();
  const picker = await dialogDocument(".sval-emoji-choice");
  picker.querySelector(".sval-emoji-none").click();

  const reopened = await dialogDocument(".sval-nw-name");
  Assert.equal(
    reopened.querySelector(".sval-nw-name").value,
    "Plain",
    "the name typed before choosing an emoji is still there"
  );
  Assert.equal(shownEmoji(reopened), "", "and the emoji is gone");
  reopened.querySelector(".sval-nw-create").click();

  const node = await made();
  Assert.equal(node.content.name, "Plain", "it is created");
  Assert.ok(!node.appearance?.emoji, "with no emoji");
});

/**
 * Choosing an emoji goes to the picker and comes back with everything the
 * user had entered.
 */
add_task(async function choosing_an_emoji_keeps_what_was_entered() {
  const { doc, made } = await openDialog();
  typeName(doc, "Fishing");
  clickSwatch(doc, "cyan");

  doc.querySelector(".sval-nw-emoji").click();
  const picker = await dialogDocument(".sval-emoji-choice");
  const search = picker.querySelector(".sval-emoji-search");
  search.value = "fish";
  search.dispatchEvent(
    new picker.defaultView.Event("input", { bubbles: true })
  );
  const choice = [...picker.querySelectorAll(".sval-emoji-choice")].find(
    button => !button.hidden && button.title === "fish"
  );
  Assert.ok(choice, "the picker finds a fish");
  choice.click();

  const reopened = await dialogDocument(".sval-nw-name");
  await TestUtils.waitForCondition(
    () => reopened.activeElement === reopened.querySelector(".sval-nw-emoji"),
    "focus comes back to the Emoji button, where the user left"
  );
  Assert.equal(
    reopened.querySelector(".sval-nw-name").value,
    "Fishing",
    "name"
  );
  Assert.equal(
    reopened.querySelector('.sval-nw-swatch[aria-checked="true"]').dataset
      .token,
    "cyan",
    "colour"
  );
  Assert.equal(shownEmoji(reopened), choice.textContent, "and the new emoji");
  reopened.querySelector(".sval-nw-create").click();

  const node = await made();
  Assert.equal(node.content.name, "Fishing", "the name");
  Assert.equal(node.appearance?.color, "cyan", "the colour");
  Assert.equal(node.appearance?.emoji, choice.textContent, "and the emoji");
});

add_task(async function a_dismissed_picker_changes_nothing() {
  const { doc, none } = await openDialog();
  const before = shownEmoji(doc);
  typeName(doc, "Kept");

  doc.querySelector(".sval-nw-emoji").click();
  const picker = await dialogDocument(".sval-emoji-choice");
  picker.defaultView.close();

  const reopened = await dialogDocument(".sval-nw-name");
  Assert.equal(shownEmoji(reopened), before, "the emoji is as it was");
  reopened.querySelector(".sval-nw-cancel").click();
  await none("Cancel after the picker");
});

/**
 * Cancel and a dismissal both create nothing, whatever was typed.
 */
add_task(async function cancelling_creates_nothing() {
  const first = await openDialog();
  typeName(first.doc, "Never made");
  first.doc.querySelector(".sval-nw-cancel").click();
  await first.none("Cancel");

  const second = await openDialog();
  typeName(second.doc, "Never made either");
  second.doc.defaultView.close();
  await second.none("closing the dialog");
});

/**
 * "New group" opens the same dialog, titled for a group: a name, the same
 * colour swatches and the same emoji picker. Its emoji starts empty, and its
 * colour does not tint the dialog, because a group does not tint its window.
 */
add_task(async function new_group_has_the_colour_and_emoji_pickers() {
  await withFreshPanel();
  chooseNewGroup();
  const doc = await dialogDocument(".sval-nw-name");

  Assert.equal(
    doc.querySelector(".sval-nw").dataset.purpose,
    "new-group",
    "the dialog is for a new group"
  );
  Assert.ok(
    doc.querySelector(".sval-nw-isolated").hidden,
    "a group has no jar of its own to choose"
  );
  Assert.equal(shownEmoji(doc), "", "with no emoji chosen to begin with");
  Assert.equal(
    doc.querySelectorAll(".sval-nw-swatch").length,
    COLOR_TOKENS.length + 2,
    "and every preset, no colour and a custom colour offered"
  );

  const card = () =>
    doc.defaultView.getComputedStyle(doc.querySelector(".sval-nw"))
      .backgroundColor;
  typeName(doc, "Recipes");
  clickSwatch(doc, "orange");
  // A group's swatch is its block on this window, as its row draws it.
  const palette = paletteOf(doc);
  const painted = colour => {
    const probe = doc.body.appendChild(doc.createElement("div"));
    probe.style.backgroundColor = colour;
    const value = doc.defaultView.getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  };
  Assert.equal(
    card(),
    painted(palette.orange.block),
    "the dialog wears the block the group will have"
  );
  for (const token of COLOR_TOKENS) {
    Assert.equal(
      doc.defaultView.getComputedStyle(swatch(doc, token)).backgroundColor,
      painted(palette[token].block),
      `${token}'s swatch is its group's block`
    );
  }

  doc.querySelector(".sval-nw-emoji").click();
  const picker = await dialogDocument(".sval-emoji-choice");
  const choice = [...picker.querySelectorAll(".sval-emoji-choice")].find(
    button => !button.hidden
  );
  choice.click();
  const reopened = await dialogDocument(".sval-nw-name");
  Assert.equal(
    reopened.querySelector(".sval-nw").dataset.purpose,
    "new-group",
    "the reopened dialog too"
  );
  Assert.equal(shownEmoji(reopened), choice.textContent, "with the emoji");
  reopened.querySelector(".sval-nw-create").click();
  await dialogGone(reopened);

  const group = await nodeNamed("Recipes");
  Assert.equal(group.kind, SvalTree.GROUP, "a group is made");
  await TestUtils.waitForCondition(
    () => SvalPanel._rowElementFor(group.id),
    "the panel draws its row"
  );
  Assert.equal(group.appearance?.color, "orange", "with the colour");
  Assert.equal(
    group.appearance?.emoji,
    choice.textContent,
    "and the emoji chosen"
  );
});

/**
 * "Edit…" opens the same dialog, for an edit, with every field starting from
 * what the group holds. An emoji chosen in the picker comes back to a dialog
 * still for the edit, and Save writes the changes.
 */
add_task(async function the_edit_dialog_starts_from_what_the_node_holds() {
  const { ids } = await withFreshPanel({
    before: ({ engine, ids: made }) =>
      engine.mutate({
        kind: "setAppearance",
        id: made.groupA,
        color: "green",
        emoji: "\u{1F41F}",
        now: Date.now(),
      }),
  });
  await chooseOnRow(ids.groupA, "edit");
  const doc = await dialogDocument(".sval-nw-name");

  Assert.equal(
    doc.querySelector(".sval-nw").dataset.purpose,
    "edit-group",
    "the dialog is for the edit"
  );
  Assert.equal(
    doc.querySelector(".sval-nw-name").value,
    "Reading",
    "the name starts as the group's"
  );
  Assert.equal(
    swatch(doc, "green").getAttribute("aria-checked"),
    "true",
    "and so does the colour"
  );
  Assert.equal(shownEmoji(doc), "\u{1F41F}", "and the emoji");
  Assert.ok(
    !doc.querySelector(".sval-nw-create").disabled,
    "Save can be pressed straight away"
  );

  typeName(doc, "Books");
  doc.querySelector(".sval-nw-emoji").click();
  const picker = await dialogDocument(".sval-emoji-choice");
  const choice = [...picker.querySelectorAll(".sval-emoji-choice")].find(
    button => !button.hidden && button.textContent !== "\u{1F41F}"
  );
  choice.click();
  const reopened = await dialogDocument(".sval-nw-name");
  Assert.equal(
    reopened.querySelector(".sval-nw").dataset.purpose,
    "edit-group",
    "the reopened dialog is still for the edit"
  );
  reopened.querySelector(".sval-nw-create").click();
  await dialogGone(reopened);

  await TestUtils.waitForCondition(
    async () =>
      (await SvalPanel.engine.tree()).nodes[ids.groupA].content.name ===
      "Books",
    "the group takes the new name"
  );
  const group = (await SvalPanel.engine.tree()).nodes[ids.groupA];
  Assert.equal(group.appearance?.color, "green", "keeps its colour");
  Assert.equal(
    group.appearance?.emoji,
    choice.textContent,
    "and wears the emoji chosen"
  );
});

/**
 * Every question the panel asks is Sval's dialog, drawn inside its own window
 * by `gDialogBox` like the dialog above, and never as a top-level window of
 * its own, which would stay above other applications while Sval is in the
 * background. Cancel answers each with no change.
 */
add_task(async function the_panels_questions_are_drawn_inside_the_window() {
  const { engine, ids } = await withFreshPanel();
  const opened = [];
  const observer = {
    observe(subject, topic) {
      if (topic === "domwindowopened") {
        opened.push(subject);
      }
    },
  };
  const before = Object.keys((await engine.tree()).nodes).sort();
  Services.ww.registerNotification(observer);
  try {
    for (const ask of [
      () => chooseOnRow(ids.tab1, "rename"),
      () => chooseOnWorkspace(ids.workspace, "deleteWorkspace"),
      () => chooseOnRow(ids.groupA, "deleteGroup"),
    ]) {
      await ask();
      const doc = await dialogDocument(".sval-dialog-actions button");
      Assert.equal(
        doc.documentURI,
        "chrome://browser/content/sval/sval-dialog.xhtml",
        "the question is Sval's dialog, in this window's dialog box"
      );
      doc.querySelector('[data-button="cancel"]').click();
      await dialogGone(doc);
      await within(SvalPanel.observer.settled(), 10_000, "the window settling");
    }
  } finally {
    Services.ww.unregisterNotification(observer);
  }
  const after = (await engine.tree()).nodes;
  Assert.deepEqual(Object.keys(after).sort(), before, "Cancel deleted nothing");
  Assert.deepEqual(opened, [], "and no question opened a window of its own");
});

/**
 * A group's rename starts from the name held, selected, and writes what was
 * typed when Enter is pressed. An empty field cannot be submitted.
 */
add_task(async function a_rename_writes_what_was_typed() {
  const { engine, ids } = await withFreshPanel();
  const held = (await engine.tree()).nodes[ids.groupA].content.name;
  // F2 on a group's row, whose menu offers Edit for the same name.
  const asked = SvalPanel.run("rename", SvalPanel._rowFor(ids.groupA));
  const doc = await dialogDocument(".sval-dialog-input");
  const input = doc.querySelector(".sval-dialog-input");
  const rename = doc.querySelector('[data-button="ok"]');
  Assert.equal(input.value, held, "the field starts from the name held");
  await TestUtils.waitForCondition(
    () => doc.activeElement === input,
    "the field has focus"
  );
  Assert.equal(
    input.selectionEnd - input.selectionStart,
    held.length,
    "with the name selected"
  );

  input.value = "  ";
  input.dispatchEvent(new doc.defaultView.Event("input"));
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  Assert.ok(gDialogBox.isOpen, "a blank name cannot be submitted");
  const acc = await accessibleOf(input);
  // Lower-cased, as Gecko names the field from its label as drawn.
  Assert.equal(
    acc.name.toLowerCase(),
    doc.querySelector(".sval-dialog-label").textContent.toLowerCase(),
    "the field is named by its label alone"
  );
  const reason = doc.getElementById("sval-dialog-error").textContent;
  Assert.ok(reason, "a reason shows");
  Assert.equal(acc.description, reason, "and the reason is its description");
  Assert.ok(!rename.disabled, "Rename stays enabled, so it can be reached");

  input.value = "New";
  input.dispatchEvent(new doc.defaultView.Event("input"));
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  await dialogGone(doc);
  await within(asked, 10_000, "the rename");
  Assert.equal(
    (await engine.tree()).nodes[ids.groupA].content.name,
    "New",
    "Enter writes what was typed"
  );
});

/**
 * A tab's rename starts from the page's title, and a blank answer is one: the
 * tab keeps no name of the user's and goes on showing the title.
 */
add_task(async function a_blank_tab_rename_leaves_the_page_title() {
  const { engine, ids } = await withFreshPanel();
  await viewTab(ids.tab1);
  const tab = SvalPanel.observer.tabFor(ids.tab1);
  await pageReady(tab.linkedBrowser, "https://example.com/One");
  await TestUtils.waitForCondition(
    async () =>
      (await engine.tree()).nodes[ids.tab1].content.name === tab.label,
    "the tab's node holds its page's title"
  );
  await engine.mutate({
    kind: "setLabel",
    id: ids.tab1,
    label: "Mine",
    now: Date.now(),
  });
  await SvalPanel.refresh();

  await chooseOnRow(ids.tab1, "rename");
  const doc = await dialogDocument(".sval-dialog-input");
  const input = doc.querySelector(".sval-dialog-input");
  Assert.equal(input.value, "Mine", "the field starts from the name shown");
  input.value = "  ";
  input.dispatchEvent(new doc.defaultView.Event("input"));
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  await dialogGone(doc);
  await TestUtils.waitForCondition(
    async () =>
      (await engine.tree()).nodes[ids.tab1].appearance?.label === undefined,
    "a blank answer takes the name away"
  );
  await TestUtils.waitForCondition(
    () =>
      SvalPanel._rowElementFor(ids.tab1)?.querySelector(".sval-row-name")
        ?.textContent === tab.label,
    "and the row shows the page's title"
  );
});

/**
 * A deletion is a danger dialog: Cancel has focus, so a stray Enter deletes
 * nothing. "Delete group" offers its third answer, which moves the group's
 * tabs out, apart from the primary, which deletes them with it.
 */
add_task(async function a_deletion_starts_on_cancel() {
  const { engine, ids } = await withFreshPanel();
  const before = Object.keys((await engine.tree()).nodes).sort();
  await chooseOnRow(ids.groupA, "deleteGroup");
  let doc = await dialogDocument(".sval-dialog-actions button");
  Assert.equal(
    doc.querySelector(".sval-dialog").dataset.tone,
    "danger",
    "the dialog is drawn as a danger"
  );
  await TestUtils.waitForCondition(
    () => doc.activeElement === doc.querySelector('[data-button="cancel"]'),
    "Cancel has focus"
  );
  EventUtils.synthesizeKey("KEY_Enter", {}, doc.defaultView);
  await dialogGone(doc);
  await within(SvalPanel.observer.settled(), 10_000, "the window settling");
  Assert.deepEqual(
    Object.keys((await engine.tree()).nodes).sort(),
    before,
    "so Enter deletes nothing"
  );

  await chooseOnRow(ids.groupA, "deleteGroup");
  doc = await dialogDocument(".sval-dialog-extra");
  doc.querySelector(".sval-dialog-extra").click();
  await dialogGone(doc);
  await dismissUndoMessage();
  let after = (await engine.tree()).nodes;
  Assert.ok(!(ids.groupA in after), "the third answer deletes the group");
  for (const tab of [ids.tab1, ids.tab2, ids.tab3]) {
    Assert.equal(
      after[tab]?.placement.parent,
      ids.workspace,
      "and moves its tabs out"
    );
  }

  await chooseOnRow(ids.groupB, "deleteGroup");
  doc = await dialogDocument(".sval-dialog-extra");
  doc.querySelector('[data-button="ok"]').click();
  await dialogGone(doc);
  await dismissUndoMessage();
  after = (await engine.tree()).nodes;
  Assert.ok(
    !(ids.groupB in after) && !(ids.tab4 in after),
    "and the primary deletes the group with its tabs"
  );
});

/**
 * The chosen colour is named in words beside its label, so telling it apart
 * does not rest on seeing the colour.
 */
add_task(async function the_chosen_colour_is_named_in_words() {
  const { doc, none } = await openDialog();
  const named = () => doc.querySelector(".sval-nw-color-name").textContent;
  Assert.ok(named(), "no colour is named");
  clickSwatch(doc, "green");
  Assert.equal(
    named(),
    swatch(doc, "green").getAttribute("aria-label"),
    "a chosen colour by its swatch's name"
  );
  doc.querySelector(".sval-nw-cancel").click();
  await none("Cancel");
});

/**
 * @param {Document} doc
 * @param {string} color Any CSS colour the document resolves.
 * @returns {number[]} its sRGB channels, 0 to 255, as drawn.
 */
function drawn(doc, color) {
  const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

/**
 * The WCAG 2 contrast ratio of two opaque colours.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function contrast(a, b) {
  const luminance = rgb => {
    const [r, g, bl] = rgb.map(c => {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every pair a dialog draws text or a control edge in, on its card, as the
 * page resolves its palette.
 */
const DIALOG_PAIRS = [
  ["--sval-dialog-text", "--sval-dialog-card", 4.5],
  ["--sval-dialog-body", "--sval-dialog-card", 4.5],
  ["--sval-dialog-muted", "--sval-dialog-card", 4.5],
  ["--sval-dialog-error", "--sval-dialog-card", 4.5],
  ["--sval-dialog-field-border", "--sval-dialog-card", 3],
  ["--sval-dialog-focus", "--sval-dialog-card", 3],
  ["#ffffff", "--sval-dialog-primary", 4.5],
  ["#ffffff", "--sval-dialog-primary-hover", 4.5],
  ["#ffffff", "--sval-dialog-danger", 4.5],
  ["#ffffff", "--sval-dialog-danger-hover", 4.5],
];

/**
 * @param {Document} doc A page wearing `sval-dialog.css`.
 * @param {string} what The palette, for the messages.
 */
function checkDialogContrast(doc, what) {
  const style = doc.defaultView.getComputedStyle(doc.documentElement);
  const resolve = value =>
    drawn(
      doc,
      value.startsWith("--") ? style.getPropertyValue(value).trim() : value
    );
  for (const [fg, bg, need] of DIALOG_PAIRS) {
    const ratio = contrast(resolve(fg), resolve(bg));
    Assert.greaterOrEqual(
      Math.round(ratio * 100) / 100,
      need,
      `${what}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`
    );
  }
}

/**
 * Every colour's dialog, and the untinted one, keeps text at 4.5:1 and
 * control edges and focus rings at 3:1 on its card, in both themes. The
 * dialog wears the chosen workspace colour as the window will, from the
 * window's own palette, so this is each tinted window's dialog.
 */
add_task(async function every_palette_keeps_its_contrast() {
  const before = window.browsingContext.prefersColorSchemeOverride;
  try {
    for (const scheme of ["light", "dark"]) {
      window.browsingContext.prefersColorSchemeOverride = scheme;
      const { doc, none } = await openDialog();
      Assert.ok(
        doc.defaultView.matchMedia(`(prefers-color-scheme: ${scheme})`).matches,
        `the dialog is in the ${scheme} theme`
      );
      for (const token of ["", ...COLOR_TOKENS]) {
        clickSwatch(doc, token);
        checkDialogContrast(doc, `${scheme}, ${token || "no colour"}`);
      }
      doc.querySelector(".sval-nw-cancel").click();
      await none("Cancel");
    }
  } finally {
    window.browsingContext.prefersColorSchemeOverride = before;
  }
});

/**
 * The yellow window of the dark scheme and the black window of the light one
 * take the other scheme, and a dialog over either still draws in the OS's:
 * its swatches are the windows each colour gives in that scheme.
 */
add_task(
  async function a_dialog_over_a_window_of_the_other_scheme_keeps_the_os_scheme() {
    const before = window.browsingContext.prefersColorSchemeOverride;
    try {
      for (const [scheme, token] of [
        ["dark", "yellow"],
        ["light", "black"],
      ]) {
        window.browsingContext.prefersColorSchemeOverride = scheme;
        await withFreshPanel({
          before: ({ engine, ids }) =>
            engine.mutate({
              kind: "setAppearance",
              id: ids.workspace,
              color: token,
              emoji: null,
              now: Date.now(),
            }),
        });
        Assert.equal(
          SvalPanel._els.switcher.getAttribute("data-sval-color"),
          token,
          `the window shows a ${token} workspace`
        );
        const { doc, none } = await openDialog();
        const view = doc.defaultView;
        Assert.ok(
          view.matchMedia(`(prefers-color-scheme: ${scheme})`).matches,
          `over the ${token} window the dialog is in the ${scheme} theme`
        );
        const palette = paletteOf(doc);
        const probe = doc.body.appendChild(doc.createElement("div"));
        const painted = colour => {
          probe.style.backgroundColor = colour;
          return view.getComputedStyle(probe).backgroundColor;
        };
        for (const each of COLOR_TOKENS) {
          Assert.equal(
            view.getComputedStyle(swatch(doc, each)).backgroundColor,
            painted(palette[each].tint),
            `${each}'s swatch is its ${scheme} window`
          );
        }
        probe.remove();
        doc.querySelector(".sval-nw-cancel").click();
        await none("Cancel");
      }
    } finally {
      window.browsingContext.prefersColorSchemeOverride = before;
    }
  }
);
