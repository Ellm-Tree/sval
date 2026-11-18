/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */

/**
 * Copy Markdown Link, Put to Sleep and Keep Awake, from a row's menu and
 * from the Launcher: the clipboard holds the tab's link, an unloaded tab
 * keeps its row, drawn as not loaded, until it is selected, and a tab kept
 * awake is loaded and stays so.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);

add_setup(failOnConsoleErrors);
add_setup(pinsSetup);
add_setup(() =>
  registerCleanupFunction(async () => {
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
  })
);

/** The title `sval_agent_page.html` carries. */
const PAGE_TITLE = "Agent test page";

/**
 * A loaded tab of the workspace, filed in the tree, and removed when the task
 * ends.
 *
 * @param {string} [url]
 * @returns {Promise<{tab: object, id: string}>}
 */
async function aTab(url = PAGE) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, url),
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
 * @param {string} id A node id.
 * @returns {string|null} the `data-loaded` the row of `id` carries.
 */
function loadedState(id) {
  return SvalPanel._rowElementFor(id)?.dataset.loaded ?? null;
}

/**
 * @param {object} tab
 * @param {string} id Its node id.
 * @returns {Promise<void>} once the tab is unloaded and its row says so.
 */
async function unloaded(tab, id) {
  await TestUtils.waitForCondition(
    () => !tab.linkedPanel && loadedState(id) === "false",
    "the tab is unloaded and its row drawn as not loaded"
  );
}

/**
 * @param {object} row A panel row.
 * @returns {boolean} whether the row menu's Put to Sleep is disabled for it.
 */
function unloadDisabled(row) {
  const menu = SvalPanel._els.contextMenu;
  SvalPanel._syncRowMenu(menu, row);
  return menu.querySelector('[data-command="unload"]').hasAttribute("disabled");
}

add_task(async function copy_markdown_link_copies_the_tabs_link() {
  const { id } = await aTab();
  const expected = `[${PAGE_TITLE}](${PAGE})`;
  await within(
    SimpleTest.promiseClipboardChange(expected, () =>
      SvalPanel.run("copyMarkdownLink", SvalPanel._rowFor(id))
    ),
    10_000,
    "the link on the clipboard"
  );
});

add_task(async function unload_keeps_the_row_and_loads_again_on_select() {
  const a = await aTab();
  await aTab();
  Assert.equal(loadedState(a.id), "true", "the tab starts loaded");
  Assert.ok(!unloadDisabled(SvalPanel._rowFor(a.id)), "it can be unloaded");

  await SvalPanel.run("unload", SvalPanel._rowFor(a.id));
  await unloaded(a.tab, a.id);
  Assert.ok(
    unloadDisabled(SvalPanel._rowFor(a.id)),
    "a sleeping tab offers no Put to Sleep"
  );
  Assert.ok(
    (await SvalPanel.engine.tree()).nodes[a.id],
    "the tab stays in the tree"
  );

  await selectTab(a.tab);
  await TestUtils.waitForCondition(
    () => loadedState(a.id) === "true",
    "selecting it loads it again"
  );
});

add_task(async function unload_on_a_group_unloads_its_tabs() {
  const a = await aTab();
  const b = await aTab();
  await aTab();
  const engine = SvalPanel.engine;
  const group = crypto.randomUUID();
  await engine.mutate({
    kind: "addGroup",
    parent: SvalWindowWorkspace.of(window).id,
    name: "Unload me",
    id: group,
    now: Date.now(),
  });
  atTaskEnd(() =>
    engine.mutate({ kind: "remove", id: group, now: Date.now() })
  );
  for (const id of [a.id, b.id]) {
    await engine.mutate({
      kind: "moveNode",
      id,
      newParent: group,
      before: null,
      after: null,
      now: Date.now(),
    });
  }
  SvalPanel.settings.setCollapsed(group, false);
  await SvalPanel.refresh();

  await SvalPanel.run("unload", SvalPanel._rowFor(group));
  await unloaded(a.tab, a.id);
  await unloaded(b.tab, b.id);
  Assert.ok(
    unloadDisabled(SvalPanel._rowFor(group)),
    "a group with every tab asleep offers no Put to Sleep"
  );
});

add_task(async function the_launcher_runs_both_on_the_selected_tab() {
  const a = await aTab();
  const b = await aTab();

  const command = async (value, id) => {
    await within(
      UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value }),
      10_000,
      "the address bar's results"
    );
    for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
      const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
      if (result.payload.commandId === id) {
        UrlbarTestUtils.setSelectedRowIndex(window, i);
        EventUtils.synthesizeKey("KEY_Enter");
        return;
      }
    }
    Assert.ok(false, `the Launcher lists ${id}`);
  };

  await within(
    SimpleTest.promiseClipboardChange(`[${PAGE_TITLE}](${PAGE})`, () =>
      command("copy markdown", "copy-markdown-link")
    ),
    10_000,
    "the link on the clipboard"
  );

  await command("unload this", "unload-tab");
  await unloaded(b.tab, b.id);
  await switchDone(window);
  Assert.notEqual(gBrowser.selectedTab, b.tab, "another tab is selected");
  Assert.ok(a.tab.linkedPanel, "the other tab stays loaded");
});

add_task(async function keep_awake_wakes_the_tab_and_holds_it_awake() {
  const a = await aTab();
  await aTab();
  atTaskEnd(() => (a.tab.undiscardable = false));
  const menu = SvalPanel._els.contextMenu;
  const choose = async command => {
    await rightClickOpens(SvalPanel._rowElementFor(a.id), menu);
    await chooseMenuItem(
      menu.querySelector(`[data-command="${command}"]`),
      menu,
      command
    );
  };

  await choose("keepLoaded");
  Assert.ok(
    unloadDisabled(SvalPanel._rowFor(a.id)),
    "a tab kept awake offers no Put to Sleep"
  );
  await choose("keepLoaded");
  Assert.ok(
    !unloadDisabled(SvalPanel._rowFor(a.id)),
    "letting it sleep offers Put to Sleep again"
  );

  await choose("unload");
  await unloaded(a.tab, a.id);
  await choose("keepLoaded");
  Assert.ok(a.tab.undiscardable, "Keep Awake marks the sleeping tab");
  await TestUtils.waitForCondition(
    () => loadedState(a.id) === "true",
    "and wakes it"
  );
  Assert.ok(!a.tab.selected, "without selecting it");
  await within(
    pageReady(a.tab.linkedBrowser, PAGE),
    10_000,
    "its page loading again"
  );
});
