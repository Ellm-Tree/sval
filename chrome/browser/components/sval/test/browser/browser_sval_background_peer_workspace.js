/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A workspace another device makes reaches a window that does nothing, by
 * the passes Sval runs on its own (`sval_background_helpers.js`).
 */

/* import-globals-from sval_background_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_background_helpers.js",
  this
);

add_task(async function a_peers_workspace_arrives_with_nothing_done_here() {
  const peer = await sharingWithAPeer("arrives");
  const theirs = await peer.mutate({
    kind: "addWorkspace",
    name: "From the other device",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await peer.sync(SYNC_DOCUMENT, Date.now(), { shared: "wait" });

  await shownHere(theirs, "the poll brings the peer's workspace in");
  const menu = SvalPanel._els.switcherMenu;
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  SvalPanel._els.switcher.click();
  await within(shown, 10_000, "the switcher opening");
  Assert.ok(
    menu.querySelector(`[data-workspace-id="${CSS.escape(theirs)}"]`),
    "and the switcher offers it"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the switcher closing");
});
