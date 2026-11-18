/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from sval_panel_startup_helpers.js */

/**
 * What a launch has to look like: no Firefox tab strip, a workspace that
 * exists without being configured, and nothing asked of anybody.
 *
 * These run against the window the harness opened, which went through
 * `gBrowserInit.onLoad` and so through `SvalPanel.init`, so the strip
 * assertions are about a real startup.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_startup_helpers.js",
  this
);

/**
 * The strip is gone at startup and stays gone through the events that ask
 * Firefox to reconsider it.
 *
 * Opening and closing a tab matters here: `TabBarVisibility.update` runs on
 * both (`tabbrowser.js`), and it is the only thing in Firefox that assigns
 * `TabsToolbar.collapsed` after startup. A window opened later is checked
 * too, because `setToolbarVisibility` persists the attribute through
 * `XULStore` and a second window is where that shows up.
 */
add_task(async function the_tab_strip_is_not_visible() {
  const strip = document.getElementById("TabsToolbar");
  Assert.ok(strip, "the strip's elements still exist — gBrowser needs them");
  Assert.ok(BrowserTestUtils.isHidden(strip), "and none of it is visible");

  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"),
    10_000,
    "a blank tab's load"
  );
  try {
    Assert.ok(
      BrowserTestUtils.isHidden(strip),
      "still not visible after a tab opened"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
  Assert.ok(
    BrowserTestUtils.isHidden(strip),
    "still not visible after a tab closed"
  );

  const second = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a second window's opening"
  );
  try {
    Assert.ok(
      BrowserTestUtils.isHidden(second.document.getElementById("TabsToolbar")),
      "and a window opened afterwards has no strip either"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(second),
      10_000,
      "the second window closing"
    );
  }
});

/**
 * A private window gets Sval's panel on its private session, and no tab strip
 * (private-windows spec): nothing is restored into it and the profile's
 * engine is not its tree. A Sval window opened while it is open changes
 * nothing about it.
 */
add_task(async function a_private_window_has_the_panel_and_no_tab_strip() {
  const priv = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "the private window's opening"
  );
  try {
    await within(priv.SvalPanel.started, 10_000, "the private panel's startup");
    const strip = priv.document.getElementById("TabsToolbar");
    Assert.ok(BrowserTestUtils.isHidden(strip), "the strip is hidden");
    Assert.ok(
      !priv.document.getElementById("sval-panel-container").hidden,
      "and the panel is shown"
    );
    Assert.equal(priv.SvalPanel.engine.isPrivate, true, "on a private tree");
    Assert.equal(priv.gBrowser.tabs.length, 1, "with nothing restored into it");

    const later = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      20_000,
      "a later window's opening"
    );
    try {
      Assert.ok(
        BrowserTestUtils.isHidden(later.document.getElementById("TabsToolbar")),
        "a sval window opened afterwards has no strip"
      );
      Assert.ok(
        BrowserTestUtils.isHidden(strip),
        "and the private window still has none"
      );
    } finally {
      await within(
        BrowserTestUtils.closeWindow(later),
        10_000,
        "the later window closing"
      );
    }
  } finally {
    await within(
      BrowserTestUtils.closeWindow(priv),
      10_000,
      "the private window closing"
    );
  }
});

/**
 * Hiding the strip does not take the window's own buttons with it.
 *
 * Only a custom titlebar draws them in the toolbox; otherwise the system draws
 * them. They sit in the topmost toolbar: the menu bar where the window draws
 * one (`SvalHeader.showMenuBar`), and the nav-bar on macOS, whose menu bar is
 * native. `browser-shared.css` hides every other copy.
 */
add_task(async function the_window_buttons_are_visible() {
  const top = Services.appinfo.nativeMenubar ? "nav-bar" : "toolbar-menubar";
  const buttons = () =>
    document.querySelector(`#${top} > .titlebar-buttonbox-container`);
  const check = when => {
    Assert.ok(
      gNavToolbox.hasAttribute("tabs-hidden"),
      `the toolbox knows the strip is hidden ${when}`
    );
    if (CustomTitlebar.enabled) {
      Assert.ok(
        BrowserTestUtils.isVisible(buttons()),
        `the ${top} shows the window buttons ${when}`
      );
      Assert.ok(
        document.getElementById(top).classList.contains("browser-titlebar"),
        `and acts as the titlebar ${when}`
      );
    }
  };

  check("at startup");
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank"),
    10_000,
    "a blank tab's load"
  );
  try {
    check("after a tab opened");
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
  check("after a tab closed");
});

/**
 * A pass one window runs is drawn in every window. They share one engine and
 * one document, so a window whose idle poll lands just after another window's
 * pass runs none of its own and still shows what it brought in.
 */
add_task(async function a_pass_in_one_window_is_drawn_in_the_others() {
  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "the other window's opening"
  );
  try {
    await within(other.SvalPanel.started, 10_000, "the other panel's startup");
    Assert.equal(other.SvalPanel.engine, SvalPanel.engine, "one engine");
    const report = await within(
      SvalPanel.syncNow(),
      10_000,
      "this window's pass"
    );
    Assert.ok(report, "this window ran a pass");
    Assert.equal(
      other.SvalPanel.syncState.lastPass,
      report,
      "which the other window reads too"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(other),
      10_000,
      "the other window closing"
    );
  }
});

/**
 * Sval mounts the panel from its own category hooks (`sval.manifest`), with no
 * patch to Mozilla's window markup or startup code: the container is the first
 * child of `#browser`, and the script has defined `SvalPanel` before the
 * window started it.
 */
add_task(async function the_panel_mounts_from_svals_own_files() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a new window's opening"
  );
  try {
    await within(win.SvalPanel.started, 10_000, "its panel's startup");
    const container = win.document.getElementById("sval-panel-container");
    Assert.equal(
      win.document.getElementById("browser").firstElementChild,
      container,
      "the container leads #browser, beside Firefox's sidebar"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});

/**
 * A device that has configured nothing still has a workspace, and was asked
 * nothing to get it.
 *
 * Two independent things are watched for a question. A window-modal
 * dialog opens a window of its own, which a `domwindowopened` observer
 * catches, and a dialog in the window is in its `gDialogBox`.
 */
add_task(async function a_fresh_profile_gets_a_workspace_unasked() {
  // The default is asserted before the fixture moves it: a workspace that
  // exists at launch and evaporates before the next one does not exist by
  // default.
  Assert.equal(
    SvalLocalSettings.localRoot(),
    PathUtils.profileDir,
    "a profile's workspaces live under sval/ in the profile and survive a restart"
  );
  const profile = await freshProfile();
  Assert.equal(
    profile.settings.sharedFolder,
    null,
    "a fresh profile has configured no folder, which is the state under test"
  );

  const opened = [];
  const observer = {
    observe(subject, topic) {
      if (topic === "domwindowopened") {
        opened.push(subject);
      }
    },
  };
  Services.ww.registerNotification(observer);
  atTaskEnd(() => Services.ww.unregisterNotification(observer));

  const win = await profile.open();
  const panel = win.SvalPanel;
  Assert.deepEqual(
    opened.filter(each => each !== win),
    [],
    "no dialog was opened"
  );
  Assert.ok(!win.gDialogBox.isOpen, "and nothing was asked in the window");

  Assert.ok(panel.engine instanceof SvalEngine, "there is an engine");
  const nodes = (await panel.engine.tree()).nodes;
  const workspaces = Object.entries(nodes).filter(
    ([, node]) => node.kind === "workspace"
  );
  Assert.equal(workspaces.length, 1, "exactly one workspace exists");
  const [id, workspace] = workspaces[0];
  Assert.equal(
    SvalWindowWorkspace.of(win).id,
    id,
    "and it is the one this window files under"
  );
  Assert.strictEqual(
    workspace.content.name,
    "",
    "carrying no name: the document holds only names its owner typed"
  );

  // A window shows one workspace and the panel draws its children (spec
  // §10.7). The workspace's only children are the window's own tabs, so
  // every row is one of them; the switcher above the tree is what names it.
  const filed = new Set(
    Array.from(win.gBrowser.tabs, tab => panel.observer.nodeIdFor(tab))
  );
  const rows = [...panel._els.tree.querySelectorAll(".sval-row")];
  Assert.ok(
    rows.every(row => filed.has(row.dataset.nodeId)),
    "the tree draws nothing but the window's own tabs"
  );
  const placeholder = panel._els.switcher.textContent;
  Assert.ok(placeholder, "the switcher names it under a placeholder");
  Assert.ok(
    !JSON.stringify(nodes).includes(JSON.stringify(placeholder)),
    "which is nowhere in the document"
  );
  Assert.ok(
    !panel._els.switcher.disabled,
    "with one workspace the switcher still works, rather than vanishing and " +
      "leaving no way to reach another"
  );
  Assert.strictEqual(panel._els.tree.hidden, false, "the tree is on screen");
  Assert.ok(
    !panel._els.footer.hidden,
    "and the sync controls are on screen, because there is always somewhere " +
      "sval is reading and writing"
  );
  Assert.ok(
    await within(panel.syncNow(), 10_000, "a sync pass"),
    "a pass runs against the storage location without anyone configuring one"
  );

  // The workspace that exists at launch is still there at the next launch:
  // every window closes, its engine stops, and a new one reads the folder.
  const relaunched = await profile.relaunch();
  Assert.notEqual(relaunched.SvalPanel.engine, panel.engine, "on a new engine");
  Assert.equal(
    SvalWindowWorkspace.of(relaunched).id,
    id,
    "the relaunch shows the same workspace, by its id"
  );
});
