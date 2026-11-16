/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */

/**
 * A Peek's page opened in a workspace no window shows, in a new
 * window: the window the user was in keeps its workspace (link routing spec
 * §4).
 */

const { workspaceTitle } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPeek.sys.mjs"
);

const QUICK_PAGE = "https://example.com/browser/?quick-new-window";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

/**
 * A shared workspace named Elsewhere, removed when the task ends.
 *
 * @returns {Promise<string>} its id.
 */
async function sharedWorkspace() {
  const id = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Elsewhere",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    await removeWorkspace(id);
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();
  return id;
}

/**
 * A Peek showing a link from another app.
 *
 * @returns {Promise<Window>}
 */
async function linkFromAnotherApp() {
  const opened = BrowserTestUtils.waitForNewWindow({ url: QUICK_PAGE });
  runCommandLine(["-url", QUICK_PAGE]);
  const win = await within(opened, 20_000, "the Peek");
  atTaskEnd(async () => {
    if (!win.closed) {
      await within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the Peek closing"
      );
    }
  });
  await TestUtils.waitForCondition(
    () => !win.document.getElementById("sval-peek-open").hidden,
    "its open button names a workspace"
  );
  return win;
}

add_task(async function a_workspace_opens_in_a_new_window_from_its_menu() {
  const home = SvalPanel.workspaceId;
  const id = await sharedWorkspace();
  const win = await linkFromAnotherApp();
  const doc = win.document;
  const menu = doc.getElementById("sval-peek-menu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  doc.getElementById("sval-peek-open-more").click();
  await within(shown, 10_000, "the menu of other workspaces");
  const item = [...menu.querySelectorAll(".sval-peek-menu-item")].find(each =>
    each
      .querySelector(".sval-peek-menu-label")
      .textContent.includes(workspaceTitle("Elsewhere"))
  );
  Assert.ok(item, "it offers Elsewhere");

  const opened = BrowserTestUtils.waitForNewWindow();
  const closed = BrowserTestUtils.domWindowClosed(win);
  item.querySelector(".sval-peek-menu-window").click();
  const other = await within(opened, 20_000, "a new window");
  await within(other.SvalPanel.started, 10_000, "its panel's startup");
  await within(closed, 10_000, "the Peek closing");

  Assert.equal(other.SvalPanel.workspaceId, id, "the new window shows it");
  await TestUtils.waitForCondition(
    () =>
      other.gBrowser.tabs.some(
        tab => tab.linkedBrowser.currentURI.spec === QUICK_PAGE
      ),
    "with the page"
  );
  Assert.equal(
    SvalPanel.workspaceId,
    home,
    "the window the user was in keeps its workspace"
  );
  await within(BrowserTestUtils.closeWindow(other), 10_000, "closing it");
});
