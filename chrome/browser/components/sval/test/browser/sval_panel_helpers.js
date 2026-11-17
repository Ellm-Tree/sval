/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What the panel's browser test files share: a workspace written into the
 * window's own document through its own engine and shown by the window's own
 * switch, so what a test asserts went through the whole stack, tab observer
 * included. Each file loads this with `loadSubScript` into its own scope.
 */

/* exported SvalEngine, SvalIdentity, SvalLocalSettings, PlacesTestUtils, SvalPanelModel, SETTINGS_URL, withFreshPanel, viewTab, dialogDocument, dialogGone, answerDialog, answerContainerDialog, shareFolder, dismissUndoMessage, openContextMenu, activateMenuItem, chooseOnRow, chooseOnWorkspace, childrenOf */

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalIdentity } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalIdentity.sys.mjs"
);
const { SvalLocalSettings } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const SvalTree = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

/** Sval's settings page, which the panel's notices open. */
const SETTINGS_URL = "about:preferences";

/**
 * Adds a workspace to the window's own document and switches the window to
 * it, as the switcher does. The document also holds the profile's startup
 * workspace and whatever earlier tasks in the file made, so a test asserts on
 * the ids it is handed.
 *
 * The switch opens the workspace's tabs, one per tab node, and they are
 * declared as the task's (`expectWorkspaceTabs`), so its end closes them. A
 * tab node written after the switch has no tab in the window, so `before`
 * writes what a task needs a tab for.
 *
 * @param {object} [options]
 * @param {Function} [options.before] Given `{ engine, settings, ids }` once
 *   the fixture's nodes are written, before the switch.
 * @returns {Promise<object>} `{ tree, settings, engine, ids }`; `ids` names
 *   the nodes the fixture created.
 */
async function withFreshPanel({ before } = {}) {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  const { engine, settings } = SvalPanel;

  const now = Date.now();
  const ids = {
    workspace: crypto.randomUUID(),
    groupA: crypto.randomUUID(),
    loose: crypto.randomUUID(),
    groupB: crypto.randomUUID(),
    tab1: crypto.randomUUID(),
    tab2: crypto.randomUUID(),
    tab3: crypto.randomUUID(),
    tab4: crypto.randomUUID(),
  };
  await engine.mutate({
    kind: "addWorkspace",
    name: "Work",
    id: ids.workspace,
    now,
  });
  // A workspace holds tabs and groups as siblings in one ordered list, so this
  // fixture puts a loose tab *between* two groups: nothing about the panel may
  // sort by kind, and a fixture with tabs only below groups could not tell.
  // Each node is appended after its parent's last child, so the insertion
  // order here is the sibling order.
  await engine.mutate({
    kind: "addGroup",
    parent: ids.workspace,
    name: "Reading",
    id: ids.groupA,
    now,
  });
  await engine.mutate({
    kind: "addTab",
    parent: ids.workspace,
    name: "Loose",
    url: "https://example.com/Loose",
    id: ids.loose,
    now,
  });
  await engine.mutate({
    kind: "addGroup",
    parent: ids.workspace,
    name: "Shipping",
    id: ids.groupB,
    now,
  });
  for (const [id, name, parent] of [
    [ids.tab1, "One", ids.groupA],
    [ids.tab2, "Two", ids.groupA],
    [ids.tab3, "Three", ids.groupA],
    [ids.tab4, "Four", ids.groupB],
  ]) {
    await engine.mutate({
      kind: "addTab",
      parent,
      name,
      url: `https://example.com/${name}`,
      id,
      now,
    });
  }

  await before?.({ engine, settings, ids });

  // Everything expanded: the §5.6 default is collapsed, and a tree with one
  // visible row proves nothing about nesting. Set before the switch, which
  // draws the rows.
  for (const id of [ids.workspace, ids.groupA, ids.groupB]) {
    settings.setCollapsed(id, false);
  }
  expectWorkspaceTabs();
  Assert.ok(
    await within(
      SvalPanel.switchTo(ids.workspace),
      10_000,
      "the switch to the fixture's workspace"
    ),
    "the window shows the fixture's workspace"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "the observer filing the switch's tabs"
  );

  return { tree: SvalPanel._els.tree, settings, engine, ids };
}

/**
 * Selects the window's tab for the node `id`, as a click on it in the tab
 * strip does, and waits for the observer to record it as the selection. The
 * switch to a workspace selects one of its tabs, and a group drawn collapsed
 * still draws the selection inside it (`SvalPanelModel.rows`), so a task
 * about folding views a tab outside the group first.
 *
 * @param {string} id A tab node's id.
 * @returns {Promise<void>}
 */
async function viewTab(id) {
  const tab = SvalPanel.observer.tabFor(id);
  Assert.ok(tab, "the window holds the node's tab");
  await selectTab(tab);
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "the observer recording the selection"
  );
}

/**
 * The document of the window's dialog once it has drawn `selector`. A dialog
 * that is closing is still `gDialogBox.dialog` until it goes, so it is passed
 * over for the one after it.
 *
 * @param {string} selector What the dialog draws once its script has run.
 * @returns {Promise<Document>}
 */
async function dialogDocument(selector) {
  let dialog;
  await TestUtils.waitForCondition(() => {
    dialog = gDialogBox.dialog;
    return dialog && !dialog._isClosing;
  }, "a dialog opens");
  await dialogShown(dialog, "the dialog's load");
  const doc = dialog._frame.contentDocument;
  await TestUtils.waitForCondition(
    () => doc.querySelector(selector),
    `the dialog has drawn ${selector}`
  );
  return doc;
}

/**
 * Waits until the dialog whose document is `doc` has closed.
 *
 * @param {Document} doc
 * @returns {Promise<void>}
 */
async function dialogGone(doc) {
  await TestUtils.waitForCondition(
    () => gDialogBox.dialog?._frame?.contentDocument !== doc,
    "the dialog closes"
  );
}

/**
 * Answers the Sval dialog the window shows (`openSvalDialog`) as a person
 * does: types `value` into its field when it is given, presses `button`, and
 * waits for the dialog to close.
 *
 * @param {object} [answer]
 * @param {string} [answer.value] What is typed into the field.
 * @param {string} [answer.button] `"ok"`, `"cancel"`, or `"extra"` for the
 *   third answer.
 * @param {Function} [answer.meanwhile] Run while the dialog is open, before
 *   it is answered.
 * @returns {Promise<object>} `{ title, body, value }`: the title and body the
 *   dialog showed, and what its field started with.
 */
async function answerDialog({ value, button = "ok", meanwhile } = {}) {
  const doc = await dialogDocument(".sval-dialog-actions button");
  const input = doc.querySelector(".sval-dialog-input");
  const shown = {
    title: doc.getElementById("sval-dialog-title").textContent,
    body: doc.getElementById("sval-dialog-body").textContent,
    value: input?.value,
  };
  await meanwhile?.();
  if (value !== undefined) {
    input.value = value;
    input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
  }
  const target =
    button === "extra"
      ? doc.querySelector(".sval-dialog-extra")
      : doc.querySelector(`.sval-dialog-actions [data-button="${button}"]`);
  await TestUtils.waitForCondition(
    () => !target.disabled,
    `${button} is enabled`
  );
  target.click();
  await dialogGone(doc);
  return shown;
}

/**
 * Answers the new group or workspace dialog the window shows
 * (`SvalNewWorkspace`) as a person does: types `name` and presses Create, or
 * presses Cancel when `name` is null.
 *
 * @param {string|null} name
 * @param {Function} [meanwhile] Run while the dialog is open, before it is
 *   answered.
 * @returns {Promise<string>} the purpose the dialog was opened for.
 */
async function answerContainerDialog(name, meanwhile) {
  const doc = await dialogDocument(".sval-nw-name");
  const purpose = doc.querySelector(".sval-nw").dataset.purpose;
  await meanwhile?.();
  if (name === null) {
    doc.querySelector(".sval-nw-cancel").click();
  } else {
    const field = doc.querySelector(".sval-nw-name");
    field.value = name;
    field.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
    doc.querySelector(".sval-nw-create").click();
  }
  await dialogGone(doc);
  return purpose;
}

/**
 * Makes `path` the window's shared folder, chosen as Settings' Change… does
 * on a device that holds a sync key, and stops sharing when the task ends.
 *
 * A device without a key adopts one first, as pairing does, and the panel
 * reads it from the store as Allow Access does. A device that makes its key
 * in the choice offers its backup in a dialog
 * (`SvalPanel._offerBackupLater`), which would hold the window's focus past
 * the task.
 *
 * @param {string} path
 * @returns {Promise<object>} `chooseSharedFolder`'s answer.
 */
async function shareFolder(path) {
  const { present } = SvalIdentity.SYNC_KEY_STATES;
  if ((await SvalIdentity.syncKey()).state !== present) {
    await SvalIdentity.adoptSyncKey(crypto.getRandomValues(new Uint8Array(32)));
  }
  if (SvalPanel.syncKeyState !== present) {
    await within(SvalPanel.run("retrySyncKey"), 30_000, "the key read");
  }
  atTaskEnd(() =>
    within(SvalPanel.chooseSharedFolder(null), 10_000, "sharing stopping")
  );
  return within(
    SvalPanel.chooseSharedFolder(path, { mint: true }),
    30_000,
    "the shared folder chosen"
  );
}

/**
 * Dismisses the panel's Undo message as its ✕ does, which makes the delete
 * the message held back (`SvalPanel.dismissUndo`), and waits for the delete
 * to have been made or refused. `dismissUndo` does not wait for it, and the
 * panel redraws once it ends.
 */
async function dismissUndoMessage() {
  const region = SvalPanel._els.undoRegion;
  const dismiss = await TestUtils.waitForCondition(
    () => region.querySelector('.sval-undo [data-command="dismissUndo"]'),
    "the Undo message shows"
  );
  dismiss.click();
  await TestUtils.waitForCondition(
    () => !region.querySelector(".sval-undo") && !SvalPanel._pendingDelete,
    "the delete the message held is made"
  );
}

/**
 * Opens the row context menu with a right-click on the row.
 *
 * @param {Element} row A `.sval-row` element.
 * @returns {Promise<Element>} the open `menupopup`.
 */
function openContextMenu(row) {
  return rightClickOpens(row, SvalPanel._els.contextMenu);
}

/**
 * Chooses the item whose `data-command` is `command` in an open menu.
 *
 * @param {Element} menu An open `menupopup`.
 * @param {string} command A `data-command` value.
 * @returns {Promise<void>}
 */
function activateMenuItem(menu, command) {
  return chooseMenuItem(
    menu.querySelector(`[data-command="${command}"]`),
    menu,
    `"${command}"`
  );
}

/**
 * Chooses `command` in the row menu of node `id`, opened with a right-click
 * on its row, as a person does. A command that asks something leaves its
 * dialog open.
 *
 * @param {string} id A node drawn as a row.
 * @param {string} command A `data-command` value.
 * @returns {Promise<void>}
 */
async function chooseOnRow(id, command) {
  await activateMenuItem(
    await openContextMenu(SvalPanel._rowElementFor(id)),
    command
  );
}

/**
 * Chooses `command` in the menu of workspace `id`: the switcher's own
 * right-click for the workspace the window shows, and a right-click on the
 * workspace's entry in the open switcher for any other.
 *
 * @param {string} id A workspace id.
 * @param {string} command A `data-command` value.
 * @returns {Promise<void>}
 */
async function chooseOnWorkspace(id, command) {
  const menu = SvalPanel._els.workspaceMenu;
  if (id === SvalPanel.workspaceId) {
    await activateMenuItem(
      await rightClickOpens(SvalPanel._els.switcher, menu),
      command
    );
    return;
  }
  const switcher = SvalPanel._els.switcherMenu;
  const opened = BrowserTestUtils.waitForPopupEvent(switcher, "shown");
  SvalPanel._els.switcher.click();
  await within(opened, 10_000, "the switcher showing");
  const entry = switcher.querySelector(
    `menu[data-workspace-id="${CSS.escape(id)}"]`
  );
  Assert.ok(entry, "the switcher lists the workspace");
  // An agent's workspace is listed in its app's submenu, which a person
  // opens on the way to it.
  const app = entry.closest("menu[data-agent-app]");
  if (app) {
    const shown = BrowserTestUtils.waitForPopupEvent(
      app.querySelector("menupopup"),
      "shown"
    );
    app.openMenu(true);
    await within(shown, 10_000, "the app's submenu showing");
  }
  const closed = BrowserTestUtils.waitForPopupEvent(switcher, "hidden");
  await activateMenuItem(await rightClickOpens(entry, menu), command);
  if (switcher.state !== "closed") {
    switcher.hidePopup();
  }
  await within(closed, 10_000, "the switcher closing");
}

/**
 * The children of `parent`, in sibling order, as the engine holds them.
 *
 * @param {object} engine A `SvalEngine`.
 * @param {string} parent A node id.
 * @returns {Promise<string[]>}
 */
async function childrenOf(engine, parent) {
  const nodes = (await engine.tree()).nodes;
  return SvalTree.childrenByParent(nodes).get(parent) ?? [];
}
