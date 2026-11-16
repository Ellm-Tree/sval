/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * Spec §5.1's appearance group, as a person meets it: a workspace or a group
 * carries a colour token and an emoji, and §10.7 shows both wherever that place
 * is named: in the switcher, on the row, and in the window's title.
 *
 * Everything here runs against the window's own engine, because what can go
 * wrong is what reaches the document. An emoji is not one
 * code point: a flag is two regional indicators, and a skin-toned figure is
 * several joined by zero-width joiners. The engine's own tests prove it keeps
 * them, so this file proves this layer does not truncate them. The appearance
 * group is replaced whole, so changing one field has to carry the other: a
 * write that dropped it would delete a colour on every device the user owns.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { SvalColor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);

/**
 * Each emoji under test is a different number of code points: a one-code-point
 * emoji passes with any implementation, including a wrong one.
 */
const PLAIN = "🐟";
const FLAG = "🇯🇵";
const JOINED = "👩🏽‍🚀";

/**
 * Adds a workspace holding a group with a tab in it to the window's own
 * document, and switches the window to it. A group is a place and carries a
 * look; a tab is a leaf and does not.
 *
 * @returns {Promise<object>} `{ engine, settings, ids, root, keys,
 *   deviceId }`, where `root`, `keys` and `deviceId` are what a second engine
 *   reading this device's files takes.
 */
async function withAppearancePanel() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const { engine, settings } = SvalPanel;
  const [deviceId, keys] = await Promise.all([
    SvalIdentity.deviceId(),
    svalKeys(),
  ]);

  const now = Date.now();
  const ids = {};
  ids.workspace = await engine.mutate({
    kind: "addWorkspace",
    name: "Work",
    id: crypto.randomUUID(),
    now,
  });
  leftWhenTheTaskEnds([ids.workspace]);
  ids.group = await engine.mutate({
    kind: "addGroup",
    parent: ids.workspace,
    name: "Reading",
    id: crypto.randomUUID(),
    now,
  });
  ids.tab = await engine.mutate({
    kind: "addTab",
    parent: ids.group,
    name: "One",
    url: "https://example.com/one",
    id: crypto.randomUUID(),
    now,
  });
  for (const id of [ids.workspace, ids.group]) {
    settings.setCollapsed(id, false);
  }
  await engine.sync(SYNC_DOCUMENT, now);
  await SvalPanel.refresh();
  Assert.ok(
    await within(SvalPanel.switchTo(ids.workspace), 10_000, "the switch"),
    "the window shows the workspace made"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "the window's observer settling"
  );

  return { engine, settings, ids, root: engine.root, keys, deviceId };
}

/**
 * @param {object} engine A `SvalEngine`.
 * @param {string} id A node id.
 * @returns {Promise<object>} that node's `appearance` group, read back from
 *   the engine's tree.
 */
async function storedAppearance(engine, id) {
  const tree = await engine.tree();
  return tree.nodes[id]?.appearance ?? {};
}

/**
 * @param {Element} row A `.sval-row`.
 * @returns {Promise<Element>} the row's open context menu.
 */
function openContextMenu(row) {
  return rightClickOpens(row, SvalPanel._els.contextMenu);
}

/** @returns {Promise<Element>} the switcher's open workspace menu. */
function openWorkspaceMenu() {
  return rightClickOpens(SvalPanel._els.switcher, SvalPanel._els.workspaceMenu);
}

/**
 * Chooses one entry in an open popup and waits for the popup to close.
 *
 * @param {Element} menu An open `menupopup`.
 * @param {string} selector Which entry.
 * @returns {Promise<void>}
 */
function activate(menu, selector) {
  return chooseMenuItem(menu.querySelector(selector), menu, selector);
}

/**
 * Answers the Edit dialog the panel opens next, as a person changing only
 * `changes` and pressing Save would, or pressing Cancel when `changes` is
 * null. `browser_sval_new_workspace.js` tests the dialog's controls; this
 * file tests what the panel writes from an answer.
 *
 * @param {object|null} changes The fields the person changed, as
 *   `fillContainerDialog` takes them.
 * @returns {Promise<object[]>} the state the dialog was opened with.
 */
async function answerEditDialog(changes) {
  const opening = await dialogDocument(".sval-nw-name");
  const { purpose, tintsWindow, name, color, emoji } =
    opening.defaultView.arguments[0];
  const opened = [{ purpose, tintsWindow, name, color, emoji }];
  if (!changes) {
    opening.querySelector(".sval-nw-cancel").click();
    return opened;
  }
  const doc = await fillContainerDialog(changes);
  doc.querySelector(".sval-nw-create").click();
  return opened;
}

/**
 * Edits a node as its menu's "Edit…" entry does.
 *
 * @param {string} id A workspace or group.
 * @param {object|null} changes See {@link answerEditDialog}.
 * @returns {Promise<object[]>} the state the dialog was opened with.
 */
async function edit(id, changes) {
  const done = SvalPanel.run("edit", { id });
  const opened = await answerEditDialog(changes);
  await within(done, 10_000, "the edit finishing");
  return opened;
}

/**
 * A colour chosen in the Edit dialog a group's row menu opens reaches the
 * document and is drawn, and the other fact groups are left alone. A colour
 * write that moved `content_at` could lose a rename made on another device at
 * the same moment (spec §5.1).
 */
add_task(
  async function a_colour_from_the_row_menu_reaches_the_tree_and_draws() {
    const { engine, ids } = await withAppearancePanel();

    const before = (await engine.tree()).nodes[ids.group];

    const answering = answerEditDialog({ color: "green" });
    const menu = await openContextMenu(SvalPanel._rowElementFor(ids.group));
    for (const command of ["rename", "setColor", "setEmoji"]) {
      Assert.ok(
        !menu.querySelector(`[data-command="${command}"]:not([hidden])`),
        `a group's menu folds ${command} into Edit`
      );
    }
    await activate(menu, '[data-command="edit"]');
    const opened = await within(answering, 10_000, "the Edit dialog");
    await TestUtils.waitForCondition(
      async () => (await storedAppearance(engine, ids.group)).color,
      "the edit is written"
    );
    // The panel draws after its own read of the tree, a round trip past the
    // write, so the row is waited for itself.
    await TestUtils.waitForCondition(
      () =>
        SvalPanel._rowElementFor(ids.group)?.hasAttribute("data-sval-color"),
      "the row is drawn with the colour"
    );

    Assert.deepEqual(
      opened.map(start => {
        const { purpose, tintsWindow, name, color, emoji } = start;
        return { purpose, tintsWindow, name, color, emoji };
      }),
      [
        {
          purpose: "edit-group",
          tintsWindow: false,
          name: "Reading",
          color: null,
          emoji: "",
        },
      ],
      "the dialog is the create dialog, set to edit and starting from " +
        "what the group holds"
    );
    Assert.deepEqual(
      await storedAppearance(engine, ids.group),
      { color: "green" },
      "the token is in the document, and nothing else is in the group with it"
    );

    const after = (await engine.tree()).nodes[ids.group];
    Assert.equal(
      after.content_at,
      before.content_at,
      "the content group is untouched, so a rename elsewhere still wins on merit"
    );
    Assert.equal(
      after.placement_at,
      before.placement_at,
      "and so is the placement group"
    );
    const row = SvalPanel._rowElementFor(ids.group);
    Assert.equal(
      row.getAttribute("data-sval-color"),
      "green",
      "and the row says which colour it is drawing"
    );
    const green = SvalColor.groupMembers("green");
    Assert.equal(
      row.style.getPropertyValue("--sval-accent"),
      green.base,
      "the preset's ink for a light surface"
    );
    Assert.equal(
      row.style.getPropertyValue("--sval-accent-invert"),
      green.invert,
      "with the dark surface's beside it"
    );
    Assert.ok(
      row.style.getPropertyValue("--sval-accent-text"),
      "and the text solved on its block"
    );
    Assert.equal(
      row.getAttribute("data-sval-fill"),
      "own",
      "the group's row is the one that carries the colour"
    );
  }
);

/**
 * An emoji chosen in a group's Edit dialog, and it is drawn before the name.
 */
add_task(
  async function an_emoji_from_the_edit_dialog_is_drawn_before_the_name() {
    const { engine, ids } = await withAppearancePanel();

    await edit(ids.group, { emoji: PLAIN });

    Assert.deepEqual(
      await storedAppearance(engine, ids.group),
      { emoji: PLAIN },
      "the emoji is in the document"
    );

    const row = SvalPanel._rowElementFor(ids.group);
    const emoji = row.querySelector(".sval-row-emoji");
    Assert.ok(emoji, "the row draws it");
    Assert.equal(emoji.textContent, PLAIN, "exactly as stored");
    Assert.equal(
      row.querySelector(".sval-row-name").compareDocumentPosition(emoji) &
        Node.DOCUMENT_POSITION_PRECEDING,
      Node.DOCUMENT_POSITION_PRECEDING,
      "before the name, which is what spec §10.7 asks for"
    );
    Assert.ok(
      !SvalPanel._rowElementFor(ids.tab).querySelector(".sval-row-emoji"),
      "and a node with no emoji has no element for one, so its name still " +
        "lines up with its siblings'"
    );
  }
);

/**
 * A multi-code-point emoji survives the whole trip byte for byte: chosen,
 * written through the engine, synced to disk, read back, and drawn.
 *
 * A flag is two regional indicators; a skin-toned astronaut is a figure, a
 * skin-tone modifier and a rocket joined by zero-width joiners. Anything that
 * took "the first character" would hand back half of either.
 */
add_task(async function a_flag_and_a_zwj_sequence_survive_the_round_trip() {
  const { engine, ids, root, keys, deviceId } = await withAppearancePanel();

  for (const [id, emoji] of [
    [ids.workspace, FLAG],
    [ids.group, JOINED],
  ]) {
    await edit(id, { emoji });

    const stored = await storedAppearance(engine, id);
    Assert.strictEqual(
      stored.emoji,
      emoji,
      `${emoji} reached the document unmodified`
    );
    Assert.equal(
      Array.from(stored.emoji).length,
      Array.from(emoji).length,
      "every code point of it, not the first one"
    );
  }

  // Read back by a second engine that starts empty, so the emoji comes from
  // the file on disk: through JSON, through encryption and back, where a byte
  // lost anywhere is lost for good.
  await engine.sync(SYNC_DOCUMENT, Date.now());
  const reader = new SvalEngine({ root, ...keys, deviceId });
  let reread;
  try {
    await reader.sync(SYNC_DOCUMENT, Date.now());
    reread = (await reader.tree()).nodes;
  } finally {
    await stopEngine(reader);
  }
  Assert.strictEqual(
    reread[ids.workspace].appearance.emoji,
    FLAG,
    "the flag survives a sync pass"
  );
  Assert.strictEqual(
    reread[ids.group].appearance.emoji,
    JOINED,
    "and so does the ZWJ sequence"
  );

  await SvalPanel.refresh();
  Assert.equal(
    SvalPanel._els.switcher.querySelector(".sval-switcher-emoji").textContent,
    FLAG,
    "the switcher draws the workspace's whole flag"
  );
  Assert.equal(
    SvalPanel._rowElementFor(ids.group).querySelector(".sval-row-emoji")
      .textContent,
    JOINED,
    "and the row draws the whole sequence"
  );
});

/**
 * A right-click on the switcher is where a workspace is edited, because the
 * workspace is not a row (spec §10.7) and so has no row menu. A left-click
 * opens the list of workspaces and offers no edit.
 */
add_task(async function the_switcher_edits_the_workspace() {
  const { engine, ids } = await withAppearancePanel();

  let list = await openSwitcher();
  // Each entry's own submenu edits that entry's workspace.
  Assert.ok(
    !list.querySelector(':scope > [data-command="edit"]'),
    "a left-click lists workspaces and offers no edit"
  );
  let hiddenList = BrowserTestUtils.waitForPopupEvent(list, "hidden");
  list.hidePopup();
  await within(hiddenList, 5_000, "the workspace list's popuphidden");

  const answering = answerEditDialog({ color: "purple" });
  const menu = await openWorkspaceMenu();
  Assert.deepEqual(
    [...menu.querySelectorAll("[data-command]:not([hidden])")].map(
      item => item.dataset.command
    ),
    ["edit", "isolateWorkspace", "deleteWorkspace"],
    "a right-click offers Edit, Isolate and Delete"
  );
  await activate(menu, '[data-command="edit"]');
  let opened = await within(answering, 10_000, "the Edit dialog");
  await TestUtils.waitForCondition(
    async () => (await storedAppearance(engine, ids.workspace)).color,
    "the edit is written"
  );
  // The panel reads the tree back after the write, a round trip past it,
  // so its own copy is waited for; the switcher wears the colour from the
  // dialog's first try of it.
  await TestUtils.waitForCondition(
    () => SvalPanel.workspaceColor(ids.workspace) === "purple",
    "the panel holds the colour"
  );

  Assert.equal(
    opened[0]?.purpose,
    "edit-workspace",
    "the dialog edits a workspace"
  );
  Assert.equal(opened[0]?.name, "Work", "this one");
  Assert.ok(
    opened[0]?.tintsWindow,
    "and previews the tint, as the new-workspace dialog does"
  );
  Assert.deepEqual(
    await storedAppearance(engine, ids.workspace),
    { color: "purple" },
    "the workspace's colour is in the document"
  );
  Assert.equal(
    SvalPanel._els.switcher.getAttribute("data-sval-color"),
    "purple",
    "and the switcher wears it"
  );

  opened = await edit(ids.workspace, { emoji: FLAG });
  Assert.equal(
    opened[0].color,
    "purple",
    "the next edit starts from the colour the workspace holds"
  );
  Assert.deepEqual(
    await storedAppearance(engine, ids.workspace),
    { color: "purple", emoji: FLAG },
    "the emoji joins the colour rather than replacing it: the group is " +
      "written whole, so the field not being changed has to be sent back"
  );
  Assert.equal(
    SvalPanel._els.switcher.querySelector(".sval-switcher-name").textContent,
    "Work",
    "the switcher still names the workspace"
  );

  Assert.equal(
    SvalPanel._els.switcher.querySelector(".sval-switcher-emoji").textContent,
    FLAG,
    "and its tile carries the emoji"
  );
});

/**
 * The Edit dialog renames, through `rename`, so the name is the only fact
 * group the write stamps.
 */
add_task(async function the_edit_dialog_renames_the_workspace() {
  const { engine, ids } = await withAppearancePanel();
  const before = (await engine.tree()).nodes[ids.workspace];

  await edit(ids.workspace, { name: "  Play  " });

  const after = (await engine.tree()).nodes[ids.workspace];
  Assert.equal(
    after.content.name,
    "Play",
    "the workspace is renamed in the document, trimmed"
  );
  Assert.equal(
    after.appearance_at,
    before.appearance_at,
    "and its look is not rewritten, so a recolour elsewhere still wins"
  );
  Assert.equal(
    SvalPanel._els.switcher.querySelector(".sval-switcher-name").textContent,
    "Play",
    "and the switcher names it"
  );
});

/**
 * Both fields can be cleared, separately, and clearing one leaves the other.
 *
 * Setting a look a person cannot unset is a trap, and because the group is
 * written whole, "clear the emoji" and "clear the colour" are each one step from
 * being "clear both".
 */
add_task(async function clearing_one_field_leaves_the_other_alone() {
  const { engine, ids } = await withAppearancePanel();

  await edit(ids.group, { color: "red", emoji: PLAIN });
  Assert.deepEqual(
    await storedAppearance(engine, ids.group),
    { color: "red", emoji: PLAIN },
    "both set"
  );

  await edit(ids.group, { color: null });
  Assert.deepEqual(
    await storedAppearance(engine, ids.group),
    { emoji: PLAIN },
    "No colour clears the colour and keeps the emoji"
  );
  Assert.ok(
    !SvalPanel._rowElementFor(ids.group).hasAttribute("data-sval-color"),
    "and the row stops wearing an accent"
  );
  Assert.equal(
    SvalPanel._rowElementFor(ids.group).style.getPropertyValue("--sval-accent"),
    "",
    "with the variable removed rather than left pointing at the old colour"
  );

  await edit(ids.group, { color: "cyan", emoji: "" });
  Assert.deepEqual(
    await storedAppearance(engine, ids.group),
    { color: "cyan" },
    "No emoji clears the emoji and keeps the colour"
  );
  Assert.ok(
    !SvalPanel._rowElementFor(ids.group).querySelector(".sval-row-emoji"),
    "and the row stops drawing one"
  );

  await edit(ids.group, { color: null });
  Assert.deepEqual(
    await storedAppearance(engine, ids.group),
    {},
    "and a node can end up with no appearance at all again"
  );
});

/**
 * Cancelling the dialog, or saving it unchanged, writes nothing.
 *
 * A write that stamped `appearance_at` or `content_at` with the values the node
 * already holds would beat a change another device made in the meantime.
 */
add_task(async function an_unchanged_or_cancelled_edit_writes_nothing() {
  const { engine, ids } = await withAppearancePanel();

  await edit(ids.group, { color: "orange" });
  const before = (await engine.tree()).nodes[ids.group];

  await edit(ids.group, null);
  await edit(ids.group, {});
  const after = (await engine.tree()).nodes[ids.group];
  Assert.deepEqual(
    after.appearance,
    { color: "orange" },
    "nothing was written"
  );
  Assert.equal(
    after.appearance_at,
    before.appearance_at,
    "nothing was stamped"
  );
  Assert.equal(after.content_at, before.content_at, "in either group");
});

/**
 * A Save that fails for any reason but the look, such as a rename of a group
 * deleted while its dialog is open, says so in the dialog's error line,
 * re-enables Save and keeps the dialog open.
 */
add_task(async function a_failed_rename_is_said_in_the_dialog() {
  const { engine, ids } = await withAppearancePanel();
  const spare = await engine.mutate({
    kind: "addGroup",
    parent: ids.workspace,
    name: "Spare",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await SvalPanel.refresh();

  const done = SvalPanel.run("edit", { id: spare });
  const doc = await dialogDocument(".sval-nw-name");
  try {
    // Deleted elsewhere, in another window of this device, while the
    // dialog is open.
    await engine.mutate({ kind: "remove", id: spare });
    const name = doc.querySelector(".sval-nw-name");
    name.value = "Books";
    name.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
    const error = doc.getElementById("sval-nw-look-error");
    const save = doc.querySelector(".sval-nw-create");
    save.click();
    await TestUtils.waitForCondition(() => error.dataset.failure, "it is said");

    Assert.equal(
      error.dataset.failure,
      "other",
      "the dialog says the changes were not saved"
    );
    Assert.ok(gDialogBox.isOpen, "and stays open");
    Assert.ok(!save.disabled, "with Save enabled");
    Assert.ok(
      !(spare in ((await engine.tree()).nodes ?? {})),
      "and nothing brought the group back"
    );
  } finally {
    if (gDialogBox.isOpen) {
      gDialogBox.dialog._frame.contentDocument
        .querySelector(".sval-nw-cancel")
        .click();
    }
    await within(done, 10_000, "the dialog closing");
  }
});

/**
 * A tab has only a name, so it is offered Rename and not Edit.
 */
add_task(async function a_tab_is_offered_rename_and_not_edit() {
  const { ids } = await withAppearancePanel();

  const menu = await openContextMenu(SvalPanel._rowElementFor(ids.tab));
  Assert.ok(
    menu.querySelector('[data-command="edit"]').hidden,
    "Edit is hidden for a tab"
  );
  Assert.ok(
    !menu.querySelector('[data-command="rename"]').hidden,
    "and Rename is offered"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the popup closing");
});

/**
 * The window's title names the workspace it shows, with its emoji (spec §10.7).
 *
 * The title is the only thing the Dock and ⌘` show of a torn-off window.
 * `titlepreface` is Firefox's own hook for it, so no Mozilla file is patched.
 */
add_task(async function the_window_title_names_the_workspace_it_shows() {
  const { ids } = await withAppearancePanel();

  Assert.equal(
    document.documentElement.getAttribute("titlepreface"),
    "Work — ",
    "a workspace with no emoji is still named in the title"
  );

  await edit(ids.workspace, { emoji: JOINED });

  Assert.equal(
    document.documentElement.getAttribute("titlepreface"),
    `${JOINED} Work — `,
    "and its emoji goes in front of the name, whole"
  );
  // Only the name and the emoji are asserted: `nsWindow::SetTitle` is free to
  // trim what it is given.
  Assert.ok(
    document.title.startsWith(`${JOINED} Work`),
    "the window's actual title, so the Dock and ⌘` read it"
  );
});

/**
 * A workspace's colour tints the whole window, not only its own row, and a
 * workspace with no colour leaves the window untinted.
 */
add_task(async function the_workspaces_colour_tints_the_whole_window() {
  const { ids } = await withAppearancePanel();
  const root = document.documentElement;
  Assert.ok(
    !root.hasAttribute("data-sval-tint"),
    "a workspace with no colour leaves the window untinted"
  );

  await edit(ids.workspace, { color: "purple" });
  Assert.ok(
    root.hasAttribute("data-sval-tint"),
    "setting the workspace's colour tints the window"
  );
  // Purple is deep in dark mode and pale in light mode, so its text is
  // light in one and dark in the other.
  Assert.equal(
    root.getAttribute("data-sval-ink"),
    SvalPanel.windowLookOf("purple").side,
    "and its text takes the side its colour gives it"
  );
  // A window that can see through wears its colour once, on the root, under
  // a clear toolbar (`sval-panel.css`, window tint).
  const ground = root.hasAttribute("data-sval-see-through")
    ? InspectorUtils.colorToRGBA(getComputedStyle(root).backgroundColor)
    : paintedInWindow("var(--toolbar-background-color)");
  Assert.deepEqual(
    ground,
    paintedInWindow(SvalColor.css(SvalPanel.windowLookOf("purple").tint)),
    "the window is the colour SvalColor solves"
  );

  await edit(ids.workspace, { color: null });
  Assert.ok(
    !root.hasAttribute("data-sval-tint"),
    "clearing the colour clears the tint"
  );
});

/**
 * Yellow is dark enough for a group's name on the light panel, and brighter
 * for the dark theme.
 */
add_task(async function yellow_reads_in_both_themes() {
  const { base, invert } = SvalColor.groupMembers("yellow");
  Assert.greaterOrEqual(
    contrastRatio(base, "white"),
    4.5,
    "a dark gold dark enough for a group's name on the light panel"
  );
  Assert.greater(
    contrastRatio(invert, "black"),
    contrastRatio(base, "black"),
    "and a brighter one for the dark theme"
  );
});

/**
 * Makes a second workspace in the panel's document, with `color` and a group
 * in it, so a switch to it has a row to right-click.
 *
 * @param {object} engine A `SvalEngine`.
 * @param {string} color A palette token.
 * @returns {Promise<{id: string, group: string}>} the workspace's id and its
 *   group's.
 */
async function addColouredWorkspace(engine, color) {
  const now = Date.now();
  const id = await engine.mutate({
    kind: "addWorkspace",
    name: "Play",
    id: crypto.randomUUID(),
    now,
  });
  leftWhenTheTaskEnds([id]);
  await engine.mutate({ kind: "setAppearance", id, color, emoji: null, now });
  const group = await engine.mutate({
    kind: "addGroup",
    parent: id,
    name: "Games",
    id: crypto.randomUUID(),
    now,
  });
  await engine.sync(SYNC_DOCUMENT, now);
  await SvalPanel.refresh();
  return { id, group };
}

/**
 * The colour a declaration of `value` paints in this window, read back as
 * RGBA so two routes to the same colour compare equal.
 *
 * @param {string} value A CSS `<color>`, `var()` references included.
 * @returns {object} `{r, g, b, a}`.
 */
function paintedInWindow(value) {
  const probe = document.createElement("div");
  probe.style.backgroundColor = value;
  document.documentElement.append(probe);
  const painted = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return InspectorUtils.colorToRGBA(painted);
}

/**
 * A Sval dialog is a document of its own inside the window's modal box, so it
 * is handed the window's tint when it opens, and its card is that tint.
 */
add_task(async function a_dialog_wears_the_workspaces_tint() {
  const { engine, ids } = await withAppearancePanel();
  const { openSvalDialog } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalDialog.sys.mjs"
  );
  const cardIn = async () => {
    const answer = openSvalDialog(window, { title: "Probe", primary: "OK" });
    await TestUtils.waitForCondition(() => gDialogBox.isOpen, "dialog opens");
    await dialogShown(gDialogBox.dialog, "the dialog's load");
    let doc;
    await TestUtils.waitForCondition(() => {
      doc = gDialogBox.dialog._frame.contentDocument;
      return doc?.querySelector(".sval-dialog-actions button");
    }, "the dialog has drawn its buttons");
    const card = InspectorUtils.colorToRGBA(
      doc.defaultView.getComputedStyle(doc.querySelector(".sval-dialog"))
        .backgroundColor
    );
    gDialogBox.dialog.close();
    await answer;
    return card;
  };

  await edit(ids.workspace, { color: "red" });
  const red = paintedInWindow("var(--sval-tint)");
  Assert.deepEqual(await cardIn(), red, "the dialog's card is the tint");

  const play = await addColouredWorkspace(engine, "yellow");
  Assert.ok(await SvalPanel.switchTo(play.id), "the window switched");
  await SvalPanel.refresh();
  const yellow = paintedInWindow("var(--sval-tint)");
  Assert.notDeepEqual(yellow, red, "the other workspace has its own tint");
  Assert.deepEqual(
    await cardIn(),
    yellow,
    "and after a switch a dialog wears the new workspace's tint"
  );
});

/**
 * A tinted window follows the OS scheme: in each, a workspace wears its
 * colour's tint for that scheme, the toolbar's text reads on it, a group's
 * name reads on its block hovered, and the address bar's focus ring shows on
 * the window.
 */
add_task(async function a_tinted_window_follows_the_os_scheme() {
  const { engine } = await withAppearancePanel();
  const hadDark = Services.prefs.prefHasUserValue("ui.systemUsesDarkTheme");
  const before = hadDark
    ? Services.prefs.getIntPref("ui.systemUsesDarkTheme")
    : null;
  const restore = () => {
    if (before === null) {
      Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
    } else {
      Services.prefs.setIntPref("ui.systemUsesDarkTheme", before);
    }
  };
  registerCleanupFunction(restore);
  const root = document.documentElement;
  const theme = async dark => {
    // The stylesheet's media queries follow the theme a moment after
    // `matchMedia` does, and every tint has a value for each scheme.
    const was = JSON.stringify(paintedInWindow("var(--sval-tint)"));
    Services.prefs.setIntPref("ui.systemUsesDarkTheme", dark ? 1 : 0);
    await TestUtils.waitForCondition(
      () =>
        matchMedia("(prefers-color-scheme: dark)").matches === dark &&
        JSON.stringify(paintedInWindow("var(--sval-tint)")) !== was,
      "the theme changes"
    );
  };

  const workspaces = {};
  const groups = {};
  for (const token of ["yellow", "red", "blue", "black"]) {
    const workspace = await addColouredWorkspace(engine, token);
    workspaces[token] = workspace.id;
    const now = Date.now();
    groups[token] = await engine.mutate({
      kind: "addGroup",
      parent: workspace.id,
      name: "Orange group",
      id: crypto.randomUUID(),
      now,
    });
    await engine.mutate({
      kind: "setAppearance",
      id: groups[token],
      color: "orange",
      emoji: null,
      now,
    });
  }
  await engine.sync(SYNC_DOCUMENT, Date.now());

  const switchTo = async token => {
    await SvalPanel.switchTo(workspaces[token]);
    await SvalPanel.refresh();
    Assert.equal(
      SvalPanel._els.switcher.getAttribute("data-sval-color"),
      token,
      `the window is in the ${token} workspace`
    );
    Assert.ok(root.hasAttribute("data-sval-tint"), "and wears its colour");
  };
  const startedDark = matchMedia("(prefers-color-scheme: dark)").matches;
  for (const dark of [!startedDark, startedDark]) {
    const which = dark ? "dark" : "light";
    // Yellow's tint differs between the schemes, which `theme` waits on.
    await switchTo("yellow");
    await theme(dark);
    for (const token of ["yellow", "red", "blue", "black"]) {
      await switchTo(token);
      const tint = paintedInWindow("var(--sval-tint)");
      Assert.deepEqual(
        tint,
        paintedInWindow(
          SvalColor.css(SvalColor.windowTint(token, which, false))
        ),
        `${token} wears its own colour in the ${which} theme`
      );
      Assert.greaterOrEqual(
        contrastRatio(paintedInWindow("var(--toolbar-text-color)"), tint),
        4.5,
        `with readable text on ${token} in the ${which} theme`
      );
      const row = SvalPanel._rowElementFor(groups[token]);
      EventUtils.synthesizeMouseAtCenter(row, { type: "mousemove" });
      await TestUtils.waitForCondition(
        () => row.matches(":hover"),
        "the group's row is hovered"
      );
      const { color, backgroundColor } = getComputedStyle(row);
      Assert.greaterOrEqual(
        contrastRatio(color, backgroundColor),
        4.5,
        `and its name reads on it hovered, on ${token} in the ${which} theme`
      );
      // Into the page, where hovering changes nothing in the chrome.
      EventUtils.synthesizeMouseAtCenter(gBrowser.selectedBrowser, {
        type: "mousemove",
      });
      await TestUtils.waitForCondition(
        () => !row.matches(":hover"),
        "the group's row is no longer hovered"
      );
    }

    // The address bar's focus ring is the pill's border, on the window.
    gURLBar.focus();
    const container = document.getElementById("urlbar-container");
    const tint = paintedInWindow("var(--sval-tint)");
    await TestUtils.waitForCondition(
      () =>
        contrastRatio(
          getComputedStyle(container, "::before").borderTopColor,
          `rgb(${tint.r}, ${tint.g}, ${tint.b})`
        ) >= 3,
      `the address bar's focus ring shows on blue in the ${which} theme`
    );
    gURLBar.blur();
  }

  restore();
});
