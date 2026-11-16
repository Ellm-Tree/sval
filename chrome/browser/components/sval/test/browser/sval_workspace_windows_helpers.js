/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * What the workspace-window files share. Each file loads this with
 * `loadSubScript` into its own scope.
 */

/* exported settleBoth, addAgentWorkspace, closeWindowBy */

/**
 * Waits until neither window has anything left to write, redraws both, and
 * answers with the document.
 *
 * Stability across two consecutive rounds is the condition, the same
 * judgement {@link quiet} makes for one window: a materialised tab the new
 * window shows loads its page, and that window's observer brings the node up
 * to what the tab shows several turns later.
 *
 * @param {object} engine The engine both windows share.
 * @param {DOMWindow} win The torn-off window.
 * @returns {Promise<string>} the document's nodes as one comparable string.
 */
async function settleBoth(engine, win) {
  const shown = win.gBrowser.selectedTab;
  if (shown?.linkedPanel) {
    await TestUtils.waitForCondition(
      () => !shown.hasAttribute("busy"),
      "the tab the new window shows has finished loading"
    );
  }
  let last = null;
  await TestUtils.waitForCondition(async () => {
    await within(
      win.SvalPanel.observer?.settled(),
      10_000,
      "win.SvalPanel.observer settling"
    );
    await within(
      SvalPanel.observer?.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
    await win.SvalPanel.refresh();
    await SvalPanel.refresh();
    const now = await treeJson(engine);
    const stable = now === last;
    last = now;
    return stable;
  }, "both windows have stopped writing");
  await assertNoHandOverFailure();
  return last;
}

/**
 * Adds an agent's workspace to `engine`'s document, the way pairing does,
 * for the running task.
 *
 * @param {object} engine A `SvalEngine`.
 * @returns {Promise<string>} its id.
 */
async function addAgentWorkspace(engine) {
  const id = await engine.mutate({
    kind: "addAgentWorkspace",
    name: "Test Agent",
    agentLabel: "Test Agent",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  leftWhenTheTaskEnds([id]);
  return id;
}

/**
 * Closes `win` the way `how` names, and waits for its observer to have
 * finished everything the close queued.
 *
 * @param {DOMWindow} win A torn-off window.
 * @param {string} how `"window"` for the window's own close box, `"lastTab"`
 *   for Cmd/Ctrl+W on its only tab.
 * @returns {Promise<void>}
 */
async function closeWindowBy(win, how) {
  const observer = win.SvalPanel.observer;
  Assert.ok(observer, "the window has a tab observer to file any deletion");
  if (how === "lastTab") {
    Assert.equal(win.gBrowser.tabs.length, 1, "the window has one tab");
    const closed = BrowserTestUtils.domWindowClosed(win);
    // The window's own `unload` detaches its observer with what the panel
    // knows, so the detach below has to come after it.
    const unloaded = BrowserTestUtils.waitForEvent(win, "unload");
    // The handler behind Cmd/Ctrl+W (`cmd_close`).
    win.BrowserCommands.closeTabOrWindow();
    await within(
      Promise.all([closed, unloaded]),
      10_000,
      "the window closing with its last tab"
    );
  } else {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
  // Settles once every `TabClose` the window raised has been acted on.
  await stopFixture({ observer });
}
