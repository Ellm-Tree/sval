/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A tab opened in a window and a change another device makes at the same
 * time both land, by the passes Sval runs on its own
 * (`sval_background_helpers.js`): neither device's write loses the other's.
 */

/* import-globals-from sval_background_helpers.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_background_helpers.js",
  this
);

add_task(async function a_tab_opened_here_and_a_peers_change_both_land() {
  const peer = await sharingWithAPeer("both");
  const url = "https://example.com/?opened-here";
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, url),
    10_000,
    "the tab opened here"
  );
  registerCleanupFunction(() => BrowserTestUtils.removeTab(tab));
  const theirs = await peer.mutate({
    kind: "addWorkspace",
    name: "Made there meanwhile",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  await peer.sync(SYNC_DOCUMENT, Date.now(), { shared: "wait" });

  await shownHere(theirs, "the peer's change reaches this window");
  await TestUtils.waitForCondition(
    async () => {
      await peer.sync(SYNC_DOCUMENT, Date.now(), { shared: "wait" });
      const nodes = (await peer.tree()).nodes ?? {};
      return Object.values(nodes).some(node => node.content?.url === url);
    },
    "and the tab opened here reaches the peer",
    500,
    80
  );
});
