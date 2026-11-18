/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */
/* import-globals-from sval_workspace_windows_helpers.js */

/**
 * What closing a window keeps of the workspace it showed: a new window's
 * untouched workspace goes, a used or emptied one and an agent's stay.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_workspace_windows_helpers.js",
  this
);

add_setup(failOnConsoleErrors);

/**
 * A window opened the way Cmd/Ctrl+N opens one while every workspace has a
 * window: this window shows the first, torn-off ones the second and the
 * profile's own, and the new window gets a new, nameless workspace with its
 * home tab filed in it.
 *
 * @returns {Promise<object>} `ids` and `engine` from the fixture, the new
 *   window `win`, its workspace `shown` and its home tab's node `home`.
 */
async function withNewWindowOnNewWorkspace() {
  const { ids, engine } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });

  // `tearOff` closes its window when the task ends.
  await tearOff(ids.workspaces[1]);
  await tearOff(SvalTree.workspaceIds(SvalPanel.nodes)[0]);
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a new window's opening"
  );
  await within(
    win.SvalPanel.started,
    20_000,
    "the new window's panel starting"
  );
  const shown = SvalWindowWorkspace.of(win).id;
  leftWhenTheTaskEnds([shown]);
  // Registered after, so it runs first: the window closes before its
  // workspace is deleted.
  atTaskEnd(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the test window closing"
      );
    }
  });
  Assert.ok(
    shown && !ids.workspaces.includes(shown),
    "the new window shows a workspace of its own"
  );
  // The harness's windows open on a blank page, which stays unfiled (see
  // `isBlank`). A user's new window shows the home page, and that is filed.
  const [tab] = win.gBrowser.tabs;
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, "about:newtab");
  await TestUtils.waitForCondition(
    () => taggedId(tab),
    "the new window's home tab is filed"
  );
  await settleBoth(engine, win);
  const home = taggedId(tab);
  const nodes = JSON.parse(await treeJson(engine));
  Assert.equal(nodes[home]?.placement?.parent, shown, "in its new workspace");
  return { ids, engine, win, shown, home };
}

/**
 * Closing that window deletes its workspace and the home tab with it, because
 * nobody touched them (decision 0101). Left in the document, every such
 * window would add an empty workspace on every device.
 */
for (const how of ["window", "lastTab"]) {
  add_task(async function closing_a_new_windows_untouched_workspace_drops_it() {
    info(`closed by: ${how}`);
    const { ids, engine, win, shown, home } =
      await withNewWindowOnNewWorkspace();

    await closeWindowBy(win, how);

    const after = JSON.parse(await treeJson(engine));
    Assert.ok(!(shown in after), "the untouched workspace is gone");
    Assert.ok(!(home in after), "and so is its home tab");
    for (const id of [...ids.workspaces, ...ids.tabs]) {
      Assert.ok(id in after, `${id}, in a workspace with a window, is kept`);
    }
  });
}

/**
 * A closed window decides whether to delete its workspace in its last flush,
 * after it has left the window list, and the workspace is no other window's
 * to take until then: a window that took it would be left on a deleted one.
 */
add_task(async function a_closing_windows_workspace_is_held_until_its_flush() {
  const { win, shown } = await withNewWindowOnNewWorkspace();
  const { heldWhileClosing } = SvalPanel._modules.SvalPanelModel;

  // After the panel's own `unload` listener, which was added first.
  let heldAtUnload = false;
  win.addEventListener("unload", () => {
    heldAtUnload = heldWhileClosing().has(shown);
  });
  await closeWindowBy(win, "window");

  Assert.ok(heldAtUnload, "the workspace is held as its window unloads");
  Assert.ok(!heldWhileClosing().has(shown), "and let go once it is deleted");
});

/**
 * A window that starts while a workspace is held makes one of its own, where
 * it would otherwise take the held one, the first no window shows.
 */
add_task(async function a_new_window_does_not_take_a_held_workspace() {
  const { ids } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const free = ids.workspaces[1];
  // The profile's own workspace in a window, so the held one is the only one
  // no window shows.
  await tearOff(SvalTree.workspaceIds(SvalPanel.nodes)[0]);
  let release;
  SvalPanel._modules.SvalPanelModel.holdWhileClosing(
    free,
    new Promise(resolve => (release = resolve))
  );
  registerCleanupFunction(() => release());

  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a new window's opening"
  );
  registerCleanupFunction(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the test window closing"
      );
    }
  });
  await within(
    win.SvalPanel.started,
    20_000,
    "the new window's panel starting"
  );

  const shown = SvalWindowWorkspace.of(win).id;
  leftWhenTheTaskEnds([shown]);
  Assert.ok(shown, "the new window shows a workspace");
  Assert.notEqual(shown, free, "one of its own");
  release();
});

/**
 * A switch to a workspace a closed window may still delete goes there once
 * that window has decided to keep it, and a pass in the meantime does not
 * take the window off it.
 */
add_task(async function a_switch_to_a_held_workspace_waits_for_its_window() {
  const { ids } = await withSwitcherPanel({
    tabUrl: TITLED_TAB_URL,
  });
  const held = ids.workspaces[1];
  let release;
  SvalPanel._modules.SvalPanelModel.holdWhileClosing(
    held,
    new Promise(resolve => (release = resolve))
  );
  registerCleanupFunction(() => release());

  const switched = SvalPanel.switchTo(held);
  // The engine answers in order, so by the second answer the switch has read
  // the tree it goes by.
  await SvalPanel.engine.tree();
  await SvalPanel.engine.tree();
  await SvalPanel.refresh();
  Assert.notEqual(
    SvalWindowWorkspace.of(window).id,
    held,
    "the window waits while the workspace is held"
  );
  release();
  Assert.ok(
    await within(switched, 10_000, "the switch"),
    "the window switches once it is let go"
  );
  await SvalPanel.refresh();
  Assert.equal(SvalWindowWorkspace.of(window).id, held, "and stays there");
});

/**
 * The same window, used: a workspace whose tab went somewhere, or that was
 * given a name, a colour or an emoji, or isolated, is the user's, and closing
 * its window keeps it (spec §5.4).
 */
for (const touch of ["browse", "rename", "colour", "emoji", "isolate"]) {
  add_task(async function closing_a_new_windows_used_workspace_keeps_it() {
    info(`touched by: ${touch}`);
    const { engine, win, shown, home } = await withNewWindowOnNewWorkspace();

    if (touch === "browse") {
      // Closed straight after the load, which is usually inside the
      // observer's debounce: the closing flush writes the address before the
      // workspace is judged.
      const browser = win.gBrowser.selectedBrowser;
      const url = "data:text/html,%3Ctitle%3EBrowsed%3C/title%3E";
      const loaded = BrowserTestUtils.browserLoaded(browser, false, url);
      BrowserTestUtils.startLoadingURIString(browser, url);
      await within(loaded, 15_000, "the data page loading in the window");
    } else if (touch === "rename") {
      await engine.mutate({
        kind: "rename",
        id: shown,
        name: "Kept",
        now: Date.now(),
      });
    } else if (touch === "isolate") {
      await engine.mutate({
        kind: "setIsolation",
        id: shown,
        isolated: true,
        now: Date.now(),
      });
    } else {
      await engine.mutate({
        kind: "setAppearance",
        id: shown,
        color: touch === "colour" ? "blue" : null,
        emoji: touch === "emoji" ? "🌊" : null,
        now: Date.now(),
      });
    }

    await closeWindowBy(win, "window");

    const after = JSON.parse(await treeJson(engine));
    Assert.ok(shown in after, "the workspace was kept");
    Assert.ok(home in after, "and so was its tab");
  });
}

/**
 * A window the session brings back still owns the workspace it created, so
 * closing it deletes that workspace if nobody touched it (decision 0101). The
 * session store carries the record, as it carries the workspace the window
 * shows; Sval stopping without closing the window is the case it is for.
 * `undoCloseWindow` brings the window back the same way, through its
 * `extData`.
 */
add_task(
  async function a_restored_window_still_drops_its_untouched_workspace() {
    const { engine, win, shown } = await withNewWindowOnNewWorkspace();
    Assert.equal(
      SessionStore.getCustomWindowValue(win, SvalPanelModel.MADE_WORKSPACE_KEY),
      shown,
      "the window records the workspace it made"
    );

    // A second history entry, still a home page, so the session keeps the
    // closed window (`_shouldSaveTabState`) and the workspace stays untouched.
    const browser = win.gBrowser.selectedBrowser;
    const loaded = BrowserTestUtils.browserLoaded(browser, false, "about:home");
    BrowserTestUtils.startLoadingURIString(browser, "about:home");
    await within(loaded, 15_000, "the home page loading");
    await settleBoth(engine, win);

    // Named, so this close keeps it; nameless again before the window returns.
    await engine.mutate({
      kind: "rename",
      id: shown,
      name: "Kept",
      now: Date.now(),
    });
    await closeWindowBy(win, "window");
    await engine.mutate({
      kind: "rename",
      id: shown,
      name: "",
      now: Date.now(),
    });
    await SvalPanel.refresh();

    const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
    SessionStore.undoCloseWindow(0);
    const reopened = await within(opening, 20_000, "the window reopening");
    registerCleanupFunction(async () => {
      if (!reopened.closed) {
        await within(
          BrowserTestUtils.closeWindow(reopened),
          10_000,
          "the test window closing"
        );
      }
    });
    await within(
      reopened.SvalPanel.started,
      20_000,
      "the reopened window's panel starting"
    );
    Assert.equal(
      SvalWindowWorkspace.of(reopened).id,
      shown,
      "the reopened window shows its workspace"
    );
    await settleBoth(engine, reopened);

    await closeWindowBy(reopened, "window");

    const after = JSON.parse(await treeJson(engine));
    Assert.ok(!(shown in after), "the untouched workspace is gone");
  }
);

/**
 * A nameless, empty workspace the user made outlives the window it was opened
 * in: only a workspace a window created for itself is its own to delete
 * (decision 0101).
 */
for (const how of ["window", "lastTab"]) {
  add_task(async function closing_a_made_empty_workspaces_window_keeps_it() {
    info(`closed by: ${how}`);
    const { engine } = await withSwitcherTabs();
    const made = await engine.mutate({
      kind: "addWorkspace",
      name: "",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    leftWhenTheTaskEnds([made]);
    await engine.sync(SYNC_DOCUMENT, Date.now());
    await SvalPanel.refresh();

    const win = await tearOff(made);
    Assert.equal(SvalWindowWorkspace.of(win).id, made, "it shows it");
    await settleBoth(engine, win);

    await closeWindowBy(win, how);
    await within(
      SvalPanel.observer?.settled(),
      10_000,
      "SvalPanel.observer settling"
    );

    const after = JSON.parse(await treeJson(engine));
    Assert.ok(made in after, "the workspace was kept");
  });
}

/**
 * Closing an agent's window deletes nothing either. An agent's workspace is a
 * workspace, and its window closes the same way (spec §5.4).
 */
add_task(async function closing_an_agents_window_keeps_its_workspace() {
  const { engine } = await withSwitcherTabs();

  const agentWs = crypto.randomUUID();
  const agentTab = crypto.randomUUID();
  const now = Date.now();
  await engine.mutate({
    kind: "addAgentWorkspace",
    name: "Test Agent",
    agentLabel: "Test Agent",
    id: agentWs,
    now,
  });
  leftWhenTheTaskEnds([agentWs]);
  await engine.mutate({
    kind: "addTab",
    parent: agentWs,
    name: "Agent page",
    url: `${ROOT}sval_switcher_page.sjs?%3Ctitle%3EAgent%20page%3C/title%3E`,
    id: agentTab,
    now,
  });
  await SvalPanel.refresh();

  const win = await tearOff(agentWs);
  await settleBoth(engine, win);
  Assert.equal(
    SvalWindowWorkspace.of(win).id,
    agentWs,
    "the window shows the agent's workspace"
  );

  await closeWindowBy(win, "window");
  const after = JSON.parse(await treeJson(engine));
  Assert.ok(agentWs in after, "the agent's workspace was kept");
  Assert.ok(agentTab in after, "and so was its tab");
});
