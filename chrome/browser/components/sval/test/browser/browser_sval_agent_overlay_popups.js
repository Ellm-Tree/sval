/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * The window's own popups are native widgets drawn above an agent's overlay,
 * where the user could click them without taking control. While the overlay
 * is up none opens, one already open closes, and a page's permission prompt
 * waits until the user takes control.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_take_control_helpers.js",
  this
);

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * A prompt the agent's page raises under the overlay is not shown over it,
 * and shows once the user takes control.
 */
add_task(async function a_permission_prompt_waits_for_take_control() {
  const { win, browser } = await layerSetup();
  const notifications = win.PopupNotifications;
  const panel = notifications.panel;
  const id = "sval-test-prompt";
  atTaskEnd(() => {
    const left = notifications.getNotification(id, browser);
    if (left) {
      notifications.remove(left);
    }
  });

  // The panel calls back "showing" in `show` itself when it goes to show
  // the prompt (`_showPanel`), before opening on a later turn.
  const topics = [];
  notifications.show(
    browser,
    id,
    "A page asks",
    null,
    { label: "Allow", accessKey: "A", callback() {} },
    null,
    {
      eventCallback: topic => {
        topics.push(topic);
      },
    }
  );
  Assert.ok(
    notifications.getNotification(id, browser),
    "the prompt is pending"
  );
  Assert.ok(!topics.includes("showing"), "and not shown over the overlay");

  const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
  await takeControlOf(win, browser);
  await within(shown, 10_000, "the prompt's panel showing");
  Assert.ok(
    [...panel.children].some(n => n.notification?.id === id),
    "the user sees the prompt once they hold the workspace"
  );
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  notifications.remove(notifications.getNotification(id, browser));
  await within(hidden, 10_000, "the prompt's panel closing");
});

/**
 * A panel open as the overlay goes up closes, and none opens while it is
 * up.
 */
add_task(async function the_windows_panels_do_not_show_over_the_overlay() {
  const { win, browser } = await layerSetup();
  const doc = win.document;
  await takeControlOf(win, browser);

  const panel = doc.getElementById("downloadsPanel");
  const shown = BrowserTestUtils.waitForEvent(panel, "popupshown");
  win.DownloadsPanel.showPanel();
  await within(shown, 10_000, "the downloads panel opening");

  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  partsOf(browser).bar.querySelector(".sval-agent-give").click();
  Assert.ok(!partsOf(browser).overlay.hidden, "the overlay is up");
  await within(hidden, 10_000, "the downloads panel closing");

  const showing = BrowserTestUtils.waitForEvent(
    panel,
    "popupshowing",
    false,
    e => {
      Assert.ok(e.defaultPrevented, "the panel's opening is refused");
      return true;
    }
  );
  win.DownloadsPanel.showPanel();
  await within(showing, 10_000, "the downloads panel's popupshowing");
  Assert.equal(panel.state, "closed", "and it stays closed");
});
