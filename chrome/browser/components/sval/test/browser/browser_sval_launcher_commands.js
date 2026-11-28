/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */

/**
 * Sval's commands as rows of the address bar (launcher spec §4): typing a
 * command's name lists it with its key as the key is now, and Enter runs it.
 * A command that picks lists its choices in the address bar. Commands that
 * do not apply are not listed, and one picked after it stopped applying does
 * nothing. Firefox's own row of quick-action buttons never shows.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { CustomKeys } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customkeys/CustomKeys.sys.mjs"
);
const { ariaShortcut, keyOf, shortcutText, PANEL_TOGGLE_KEY } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
  );
const { SvalArchive } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalArchive.sys.mjs"
);

add_setup(failOnConsoleErrors);
add_setup(pinsSetup);
add_setup(async function () {
  await PlacesUtils.history.clear();
  registerCleanupFunction(async () => {
    CustomKeys.resetAll();
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
    await PlacesUtils.history.clear();
  });
});

/** Workspace and agent commands, which a private window has none of. */
const WORKSPACE_AND_AGENT_COMMANDS = new Set([
  "go-to-workspace",
  "new-workspace",
  "rename-workspace",
  "move-tab",
  "give-back",
  "agent-settings",
]);

/**
 * Types `value` into `win`'s address bar and answers its rows.
 *
 * @param {string} value
 * @param {Window} [win]
 * @returns {Promise<object[]>} `{ result, element }` per row.
 */
async function rowsFor(value, win = window) {
  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window: win, value }),
    10_000,
    "the address bar's results"
  );
  return visibleRows(win);
}

/**
 * @param {Window} [win]
 * @returns {Promise<object[]>} the rows the address bar shows now.
 */
async function visibleRows(win = window) {
  const rows = [];
  for (let i = 0; i < UrlbarTestUtils.getResultCount(win); i++) {
    rows.push({ ...(await UrlbarTestUtils.getDetailsOfResultAt(win, i)), i });
  }
  return rows;
}

/**
 * @param {object[]} rows
 * @param {string} id
 * @returns {object|undefined} The row of command `id`.
 */
function commandRow(rows, id) {
  return rows.find(r => r.result.payload.commandId === id);
}

/**
 * Selects `row` with the arrow keys, as a person does, and presses Enter.
 *
 * @param {object} row
 * @param {Window} [win]
 */
function enterOn(row, win = window) {
  for (
    let left = UrlbarTestUtils.getResultCount(win);
    left && UrlbarTestUtils.getSelectedRowIndex(win) !== row.i;
    left--
  ) {
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
  }
  Assert.equal(
    UrlbarTestUtils.getSelectedRowIndex(win),
    row.i,
    "the arrow keys reach the row"
  );
  EventUtils.synthesizeKey("KEY_Enter", {}, win);
}

/**
 * A tab of the workspace, filed in the tree, and removed when the task ends.
 *
 * @returns {Promise<{tab: object, id: string}>}
 */
async function aTab() {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "a tab opening"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const id = SvalPanel.observer.nodeIdFor(tab);
  atTaskEnd(async () => {
    const all = (await SvalPanel.engine.tree()).nodes ?? {};
    if (all[id]) {
      await SvalPanel.engine.mutate({ kind: "remove", id, now: Date.now() });
    }
  });
  return { tab, id };
}

/**
 * Answers the workspace dialog the window opens as a person does: types
 * `name` and presses Create.
 *
 * @param {string} name
 * @returns {Promise<string>} the purpose the dialog was opened for.
 */
async function answerWorkspaceDialog(name) {
  await TestUtils.waitForCondition(
    () => gDialogBox.isOpen,
    "a sheet opens over the window"
  );
  await dialogShown(gDialogBox.dialog, "the sheet's load");
  const doc = gDialogBox.dialog._frame.contentDocument;
  await TestUtils.waitForCondition(
    () => doc.querySelector(".sval-nw-name"),
    "the sheet has drawn its name field"
  );
  const field = doc.querySelector(".sval-nw-name");
  field.value = name;
  field.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
  const purpose = doc.querySelector(".sval-nw").dataset.purpose;
  doc.querySelector(".sval-nw-create").click();
  return purpose;
}

/**
 * A command's row shows the key its `<key>` carries, read through
 * `SvalShortcuts`, in the row and in `aria-keyshortcuts`, and the key the
 * user gives it in Settings › Keyboard as soon as it is given. A command with
 * no key shows none.
 */
add_task(async function a_command_row_shows_its_key_as_it_is_now() {
  const el = document.getElementById(PANEL_TOGGLE_KEY);
  let row = commandRow(await rowsFor("panel"), "toggle-panel");
  Assert.ok(row, "Show or hide the panel is listed");
  const keycap = () =>
    row.element.row.querySelector(".urlbarView-dynamic-svalCommand-shortcut");
  const inner = () => row.element.row.querySelector(".urlbarView-row-inner");
  await TestUtils.waitForCondition(
    () => keycap().textContent === shortcutText(keyOf(el)),
    "the row shows the panel's key"
  );
  Assert.equal(
    inner().getAttribute("aria-keyshortcuts"),
    ariaShortcut(keyOf(el)),
    "and names it to assistive technology"
  );
  await TestUtils.waitForCondition(
    () =>
      row.element.row.getAttribute("data-l10n-id") ===
      "launcher-section-commands",
    "under the Commands heading"
  );

  registerCleanupFunction(() => CustomKeys.resetKey(PANEL_TOGGLE_KEY));
  const changed = { modifiers: "accel,shift", key: "Y" };
  CustomKeys.changeKey(PANEL_TOGGLE_KEY, changed);
  row = commandRow(await rowsFor("panel"), "toggle-panel");
  await TestUtils.waitForCondition(
    () => keycap().textContent === shortcutText(changed),
    "the row shows the key the user gave it"
  );
  Assert.equal(
    inner().getAttribute("aria-keyshortcuts"),
    ariaShortcut(changed)
  );
  CustomKeys.resetKey(PANEL_TOGGLE_KEY);

  row = commandRow(await rowsFor("new wor"), "new-workspace");
  Assert.ok(row, "New workspace is listed");
  Assert.equal(row.result.payload.shortcut, null, "with no key");
  Assert.ok(keycap().hidden, "and no keycap");
  Assert.ok(!inner().hasAttribute("aria-keyshortcuts"));
});

/**
 * "new wor" and Enter runs New workspace: the dialog asks for its name and
 * the window goes to the workspace made. Its row by name then goes back.
 */
add_task(async function new_workspace_runs_from_its_row() {
  const { engine, home } = pinsFixture;
  enterOn(commandRow(await rowsFor("new wor"), "new-workspace"));
  const purpose = await answerWorkspaceDialog("Trips");
  let trips;
  await TestUtils.waitForCondition(async () => {
    const all = (await engine.tree()).nodes ?? {};
    trips = Object.keys(all).find(id => all[id].content?.name === "Trips");
    return trips && SvalWindowWorkspace.of(window).id === trips;
  }, "the window shows the new workspace");
  // The switch goes on past that: its tab switch moves focus to the page
  // when the tab's layers are ready (AsyncTabSwitcher.updateDisplay), which
  // takes it from the address bar if the next query has begun.
  await switchDone();
  Assert.equal(purpose, "new-workspace", "the dialog asked");
  atTaskEnd(async () => {
    await SvalWindowWorkspace.of(window).switchTo(home);
    await engine.mutate({ kind: "remove", id: trips, now: Date.now() });
    await SvalPanel.refresh();
  });

  const row = commandRow(await rowsFor("go to home"), "go-to-workspace");
  Assert.equal(row?.result.payload.choiceId, home, "each workspace has a row");
  Assert.ok(row.result.payload.title.includes("Home"), "named for it");
  enterOn(row);
  await TestUtils.waitForCondition(
    () => SvalWindowWorkspace.of(window).id === home,
    "Enter goes to it"
  );
});

/** Rename workspace opens today's Edit workspace sheet (launcher spec §3). */
add_task(async function rename_opens_the_edit_workspace_sheet() {
  enterOn(commandRow(await rowsFor("rename"), "rename-workspace"));
  await TestUtils.waitForCondition(
    () => gDialogBox.isOpen,
    "a sheet opens over the window"
  );
  await dialogShown(gDialogBox.dialog, "the sheet's load");
  const doc = gDialogBox.dialog._frame.contentDocument;
  await TestUtils.waitForCondition(
    () => doc.querySelector(".sval-nw")?.dataset.purpose === "edit-workspace",
    "it is Edit workspace"
  );
  Assert.equal(
    doc.querySelector("input")?.value,
    "Home",
    "with the workspace's name"
  );
  await closeLeftoverDialog();
});

/**
 * Move this tab to… lists the workspaces in the address bar: the field
 * empties, the command is a chip at its start, this workspace shows as
 * Current and cannot be chosen, and New workspace… is last, named with what
 * is typed. Typing filters; Enter moves the tab.
 */
add_task(async function move_lists_the_workspaces_then_moves_the_tab() {
  const { home, work } = pinsFixture;
  const { id } = await aTab();
  const move = commandRow(await rowsFor("move"), "move-tab");
  enterOn(move);
  await TestUtils.waitForCondition(
    () => document.getElementById("sval-launcher-chip"),
    "the command shows as a chip"
  );
  Assert.ok(gURLBar.view.isOpen, "the address bar stays open");
  Assert.equal(gURLBar.value, "", "with the field empty");
  Assert.equal(
    document.getElementById("sval-launcher-chip-label").textContent,
    move.result.payload.title,
    "the chip is the command's"
  );
  await TestUtils.waitForCondition(
    () =>
      document.l10n.getAttributes(gURLBar.inputField).id ===
      "launcher-choose-workspace",
    "the field asks for a workspace"
  );

  let rows;
  await TestUtils.waitForCondition(async () => {
    rows = await visibleRows();
    return (
      rows.at(-1)?.result.payload.isNew &&
      rows.some(r => r.result.payload.choiceId === work) &&
      UrlbarTestUtils.getSelectedRowIndex(window) >= 0
    );
  }, "the choices are listed, one selected");
  Assert.deepEqual(
    rows
      .map(r => r.result.payload.choiceId)
      .filter(choice => [home, work, "new-workspace"].includes(choice)),
    [home, work, "new-workspace"],
    "the workspaces, then a new one"
  );
  Assert.ok(
    rows.every(r => r.result.providerName === "SvalLauncherCommands"),
    "and nothing else"
  );
  const current = rows.find(r => r.result.payload.choiceId === home);
  Assert.ok(current.result.payload.current, "this workspace is Current");
  const inner = current.element.row.querySelector(".urlbarView-row-inner");
  Assert.equal(inner.getAttribute("aria-disabled"), "true");
  Assert.ok(!inner.hasAttribute("selectable"), "Current cannot be chosen");
  Assert.equal(
    UrlbarTestUtils.getSelectedRowIndex(window),
    rows.findIndex(r => !r.result.payload.current),
    "the first workspace that can be chosen is selected"
  );

  EventUtils.sendString("wo");
  await TestUtils.waitForCondition(async () => {
    rows = await visibleRows();
    return (
      rows.at(-1)?.result.payload.isNew &&
      rows.at(-1).result.payload.title.includes("wo") &&
      !rows.some(r => r.result.payload.choiceId === home) &&
      UrlbarTestUtils.getSelectedRowIndex(window) === 0
    );
  }, "typing filters, and names the new workspace");
  Assert.deepEqual(
    rows
      .map(r => r.result.payload.choiceId)
      .filter(choice => [work, "new-workspace"].includes(choice)),
    [work, "new-workspace"]
  );

  enterOn(rows.find(r => r.result.payload.choiceId === work));
  await TestUtils.waitForCondition(async () => {
    const all = (await SvalPanel.engine.tree()).nodes ?? {};
    return all[id]?.placement.parent === work;
  }, "the tab moved to Work");
  Assert.ok(!gURLBar.view.isOpen, "the address bar closed");
  Assert.ok(!document.getElementById("sval-launcher-chip"), "with no chip");
  Assert.equal(SvalWindowWorkspace.of(window).id, home, "the window stayed");
});

/**
 * Back, the chip's button, Backspace in the empty field or Escape, goes to
 * the first list with the query and the command's row as they were. Escape
 * at the first list closes the address bar.
 */
add_task(async function back_and_escape_from_the_choices() {
  await aTab();
  const placeholder = gURLBar.inputField.placeholder;
  enterOn(commandRow(await rowsFor("move"), "move-tab"));
  await TestUtils.waitForCondition(
    () => document.getElementById("sval-launcher-chip"),
    "the choices show"
  );
  EventUtils.synthesizeKey("KEY_Backspace");
  await TestUtils.waitForCondition(
    () =>
      !document.getElementById("sval-launcher-chip") &&
      gURLBar.value === "move" &&
      gURLBar.view.selectedResult?.payload.commandId === "move-tab",
    "Backspace goes back, to the command's row"
  );
  const selected = await UrlbarTestUtils.getDetailsOfResultAt(
    window,
    UrlbarTestUtils.getSelectedRowIndex(window)
  );
  Assert.ok(selected, "a row is selected");
  Assert.equal(selected.result.payload.commandId, "move-tab", "on its row");
  await TestUtils.waitForCondition(
    () => gURLBar.inputField.placeholder === placeholder,
    "the placeholder is the address bar's again"
  );

  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => document.getElementById("sval-launcher-chip"),
    "the choices show again"
  );
  // Back keeps the focus in the field, so it takes none itself; Escape and
  // Backspace are the keyboard's Back.
  AccessibilityUtils.setEnv({ focusableRule: false });
  EventUtils.synthesizeMouseAtCenter(
    document.getElementById("sval-launcher-chip-back"),
    {}
  );
  AccessibilityUtils.resetEnv();
  await TestUtils.waitForCondition(
    () =>
      !document.getElementById("sval-launcher-chip") &&
      gURLBar.view.selectedResult?.payload.commandId === "move-tab",
    "the chip's Back goes back"
  );

  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => document.getElementById("sval-launcher-chip"),
    "the choices show once more"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () =>
      gURLBar.view.isOpen &&
      !document.getElementById("sval-launcher-chip") &&
      gURLBar.view.selectedResult?.payload.commandId === "move-tab",
    "Escape steps back to the first list"
  );
  await gURLBar.lastQueryContextPromise;
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !gURLBar.view.isOpen,
    "Escape there closes the address bar"
  );
});

/**
 * Enter pressed as soon as a choice is typed, before the list for it is in,
 * picks the first choice that matches and never searches for the text.
 */
add_task(async function enter_before_the_choices_arrive_picks_the_first() {
  // A name that matches no other workspace, the profile's own included, so
  // the first choice that matches is this one.
  const engine = SvalPanel.engine;
  const quokka = await engine.mutate({
    kind: "addWorkspace",
    name: "Quokka",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    await engine.mutate({ kind: "remove", id: quokka, now: Date.now() });
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();
  const { id } = await aTab();
  enterOn(commandRow(await rowsFor("move"), "move-tab"));
  await TestUtils.waitForCondition(
    () => document.getElementById("sval-launcher-chip"),
    "the choices show"
  );
  EventUtils.sendString("quo");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(async () => {
    const all = (await SvalPanel.engine.tree()).nodes ?? {};
    return all[id]?.placement.parent === quokka;
  }, "the tab moved to Quokka");
  const { SearchService } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/search/SearchService.sys.mjs"
  );
  const searchHost = SearchService.defaultEngine.searchURLWithNoTerms.host;
  Assert.ok(
    !gBrowser.tabs.some(
      t => URL.parse(t.linkedBrowser.currentURI.spec)?.host === searchHost
    ),
    "nothing was searched for"
  );
  Assert.ok(!gURLBar.view.isOpen, "the address bar closed");
});

/**
 * A name typed with an input method filters the choices as it composes, and
 * Enter picks once the text is confirmed. Firefox closes the address bar's
 * list when a composition starts, which would end the choices.
 */
add_task(async function an_input_method_filters_the_choices() {
  const engine = SvalPanel.engine;
  const shigoto = await engine.mutate({
    kind: "addWorkspace",
    name: "仕事",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    await engine.mutate({ kind: "remove", id: shigoto, now: Date.now() });
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();
  const { id } = await aTab();
  enterOn(commandRow(await rowsFor("move"), "move-tab"));
  await TestUtils.waitForCondition(
    () => document.getElementById("sval-launcher-chip"),
    "the choices show"
  );
  await gURLBar.lastQueryContextPromise;

  const compose = string =>
    EventUtils.synthesizeCompositionChange({
      composition: {
        string,
        clauses: [
          {
            length: string.length,
            attr: Ci.nsITextInputProcessor.ATTR_RAW_CLAUSE,
          },
        ],
      },
      caret: { start: string.length, length: 0 },
      key: { key: string.at(-1) },
    });
  compose("し");
  compose("しご");
  compose("仕事");
  Assert.ok(gURLBar.view.isOpen, "the choices stay open while composing");
  Assert.ok(
    document.getElementById("sval-launcher-chip"),
    "with the command's chip"
  );
  let rows;
  await TestUtils.waitForCondition(async () => {
    rows = await visibleRows();
    return rows[0]?.result.payload.choiceId === shigoto && rows.length === 2;
  }, "the composed text filters the choices");

  EventUtils.synthesizeComposition({
    type: "compositioncommitasis",
    key: { key: "KEY_Enter" },
  });
  Assert.equal(gURLBar.value, "仕事", "the text is confirmed");
  await TestUtils.waitForCondition(async () => {
    rows = await visibleRows();
    return (
      rows.length === 2 &&
      rows[0].result.payload.choiceId === shigoto &&
      UrlbarTestUtils.getSelectedRowIndex(window) === 0
    );
  }, "the confirmed text lists 仕事, selected");
  Assert.deepEqual(
    rows.map(r => r.result.payload.choiceId),
    [shigoto, "new-workspace"]
  );

  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(async () => {
    const all = (await SvalPanel.engine.tree()).nodes ?? {};
    return all[id]?.placement.parent === shigoto;
  }, "the tab moved to 仕事");
  Assert.ok(!gURLBar.view.isOpen, "the address bar closed");
});

/** Close split is listed only for a tab in a split, and Enter separates it. */
add_task(async function close_split_is_listed_only_in_a_split() {
  // Firefox notes the first split.
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed")
  );
  const a = await aTab();
  const b = await aTab();
  Assert.ok(
    !commandRow(await rowsFor("close split"), "close-split"),
    "no Close split without a split"
  );
  await UrlbarTestUtils.promisePopupClose(window);

  Assert.ok(await SvalPanel.splitBeside(b.id, a.id), "a split is made");
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab.splitview,
    "the window shows the split"
  );
  const row = commandRow(await rowsFor("close split"), "close-split");
  Assert.ok(row, "Close split is listed in a split");
  enterOn(row);
  await TestUtils.waitForCondition(async () => {
    const all = (await SvalPanel.engine.tree()).nodes ?? {};
    return !Object.values(all).some(n => n.kind === "split");
  }, "the split is gone from the tree");
});

/**
 * Rename this tab opens the tab's Rename dialog and gives the tab the name
 * typed; Remove this tab's name is listed only then, and takes the name
 * away.
 */
add_task(
  async function rename_tab_names_the_tab_and_use_page_title_unnames_it() {
    const { id } = await aTab();
    const label = async () =>
      ((await SvalPanel.engine.tree()).nodes ?? {})[id]?.appearance?.label;
    Assert.ok(
      !commandRow(await rowsFor("remove this tab"), "remove-tab-name"),
      "no Remove name on a tab with no name"
    );
    await UrlbarTestUtils.promisePopupClose(window);

    enterOn(commandRow(await rowsFor("rename this tab"), "rename-tab"));
    await TestUtils.waitForCondition(
      () => gDialogBox.isOpen,
      "a dialog opens over the window"
    );
    await dialogShown(gDialogBox.dialog, "the dialog's load");
    const doc = gDialogBox.dialog._frame.contentDocument;
    await TestUtils.waitForCondition(
      () => doc.querySelector(".sval-dialog-input"),
      "the dialog has drawn its field"
    );
    const input = doc.querySelector(".sval-dialog-input");
    input.value = "Mine";
    input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
    doc.querySelector('sval-dialog [data-button="ok"]').click();
    await TestUtils.waitForCondition(
      async () => (await label()) === "Mine",
      "the tab is named"
    );
    await TestUtils.waitForCondition(
      () =>
        SvalPanel._rowElementFor(id)?.querySelector(".sval-row-name")
          ?.textContent === "Mine",
      "and its row shows the name"
    );

    enterOn(commandRow(await rowsFor("remove this tab"), "remove-tab-name"));
    await TestUtils.waitForCondition(
      async () => (await label()) === undefined,
      "the name is taken away"
    );
  }
);

/** Archive puts the tab the window shows in the Archive. */
add_task(async function archive_puts_the_tab_in_the_archive() {
  const { engine } = pinsFixture;
  const archive = await within(
    SvalArchive.startFor(engine),
    10_000,
    "the profile's Archive"
  );
  const { id } = await aTab();
  enterOn(commandRow(await rowsFor("archive"), "archive"));
  await TestUtils.waitForCondition(async () => {
    await within(archive.whenIdle(), 10_000, "archive going idle");
    return (await archive.entries()).some(e => e.url === PAGE);
  }, "the tab is in the Archive");
  const all = (await engine.tree()).nodes ?? {};
  Assert.ok(!all[id], "and out of the tree");
});

/**
 * Pin this tab pins it; Move this pin to Favorites is then listed. Such a row
 * picked after the pin went another way does nothing, and the address bar
 * closes.
 */
add_task(async function a_stale_unpin_does_nothing_and_closes() {
  const { store } = pinsFixture;
  const { tab } = await aTab();
  enterOn(commandRow(await rowsFor("pin this"), "pin"));
  await TestUtils.waitForCondition(
    () => selectedPinGuid(),
    "the tab is a pin's page"
  );
  const guid = selectedPinGuid();
  atTaskEnd(async () => {
    closePinPages();
    await store.delete(guid);
  });
  Assert.equal(gBrowser.selectedTab, tab, "the same tab");

  const row = commandRow(await rowsFor("unpin"), "unpin");
  Assert.ok(row, "Unpin is listed");
  await SvalPanel.pins.moveToFavoritesGuid(guid);
  await TestUtils.waitForCondition(
    () => !selectedPinGuid(),
    "moved to Favorites from elsewhere"
  );
  Assert.ok(gURLBar.view.isOpen, "the stale row is still shown");
  enterOn(row);
  await TestUtils.waitForCondition(
    () => !gURLBar.view.isOpen,
    "the address bar closes"
  );
  Assert.ok(!selectedPinGuid(), "nothing was pinned again");
  Assert.ok(store.isFavorite(PAGE), "and the favorite the move made stays");
  Assert.equal(gBrowser.selectedTab, tab, "and the tab is where it was");
});

/**
 * A private window lists no workspace or agent commands (launcher spec §6),
 * and still lists the rest.
 */
add_task(async function a_private_window_has_no_workspace_or_agent_commands() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "a private window opening"
  );
  try {
    await within(win.SvalPanel.started, 20_000, "its panel starting");
    for (const text of [
      "workspace",
      "move",
      "rename",
      "take control",
      "agent",
    ]) {
      const listed = (await rowsFor(text, win))
        .map(r => r.result.payload.commandId)
        .filter(id => WORKSPACE_AND_AGENT_COMMANDS.has(id));
      Assert.deepEqual(listed, [], `none for "${text}"`);
    }
    Assert.ok(
      commandRow(await rowsFor("print", win), "print"),
      "Print is listed"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the private window closing"
    );
  }
});

/**
 * Firefox's quick-action buttons never show; Sval's row for the same command
 * does, and runs it.
 */
add_task(async function firefoxs_quick_action_buttons_never_show() {
  // A page in the tab, which Firefox would otherwise load Downloads in.
  await aTab();
  const rows = await rowsFor("downloads");
  Assert.ok(
    !rows.some(r => r.result.providerName === "UrlbarProviderGlobalActions"),
    "no row of buttons"
  );
  Assert.ok(
    !gURLBar.view.panel.querySelector(".urlbarView-action-btn"),
    "and no button"
  );
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, "about:downloads");
  enterOn(commandRow(rows, "downloads"));
  const tab = await within(opened, 10_000, "Downloads opening");
  expectOpened(tab);
  BrowserTestUtils.removeTab(tab);
});
