/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * What another device's changes, and a failing hand-over, do to the
 * workspace a window shows.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

/**
 * A peer deleting the workspace this window was showing changes what the panel
 * draws. An observer left naming the deleted workspace files every stray tab
 * under a parent that does not exist, which leaves the tab in limbo.
 */
add_task(async function the_observer_is_told_when_a_peer_moves_the_window() {
  const { ids, engine } = await withSwitcherPanel();
  const [, second] = ids.workspaces;
  const [first] = SvalTree.workspaceIds(SvalPanel.nodes);

  const menu = await openSwitcher();
  await activateWorkspace(menu, second);

  await engine.mutate({ kind: "remove", id: ids.tabs[1] });
  await engine.mutate({ kind: "remove", id: second });
  // Through the poll, which is how a peer's deletion arrives at an idle
  // window (`_refreshIfChanged`).
  Assert.ok(await SvalPanel._syncInBackground(), "the poll ran");

  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "the window fell back to the first workspace in sibling order"
  );
  await assertNoHandOverFailure();
  // One of the browser's own pages is filed in the workspace the tab observer
  // was told the window shows, whatever is selected (`SvalTabs`' `fileTab`).
  const page = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "about:license"),
    10_000,
    "a browser page opening"
  );
  Assert.equal(
    (await filedAt(page)).parent,
    first,
    "and the observer was told, so a stray is not filed under the workspace " +
      "that no longer exists"
  );
});

/**
 * A workspace another device closed between the menu being built and an entry
 * being pressed. The press redraws the workspace the window is on and says
 * nothing: the entry's absence from the redrawn menu is the answer (spec
 * §10.7).
 */
add_task(
  async function pressing_a_vanished_workspace_redraws_and_says_nothing() {
    const { ids, engine } = await withSwitcherPanel();
    const [first, second] = ids.workspaces;

    await engine.mutate({ kind: "remove", id: ids.tabs[1] });
    await engine.mutate({ kind: "remove", id: second });
    await SvalPanel.refresh();

    const menu = await openSwitcher();
    Assert.deepEqual(
      switcherEntries(menu, [second]),
      [],
      "a popup built after the pass does not offer it at all"
    );
    await closeSwitcher(menu);

    // A popup opened before the pass leaves the entry pressable. Emptying the
    // tree first makes the redraw assertable: the rows that come back came
    // back from this press.
    SvalPanel._els.tree.textContent = "";
    Assert.strictEqual(
      await SvalPanel.switchTo(second),
      false,
      "the switch is a no-op rather than leaving the window on an id that " +
        "draws nothing"
    );
    Assert.equal(
      SvalWindowWorkspace.of(window).id,
      first,
      "the window did not move"
    );
    Assert.deepEqual(
      drawnIds(),
      [ids.tabs[0]],
      "and the panel redrew the workspace it is on"
    );
    await assertNoHandOverFailure();
  }
);

/**
 * A peer closing the workspace this window shows moves the window on the pass
 * itself, and rebuilds the switcher while it is open (spec §10.7).
 *
 * A popup is a picture of the document as it was when it opened. Rebuilt at
 * the moment the window moves, it holds no entry for the closed workspace.
 *
 * The switcher is held open across the pass. A task that closed it first
 * would pass against a panel that only rebuilt the popup on `popupshowing`.
 */
add_task(async function a_peer_closing_the_shown_workspace_moves_the_window() {
  const { ids, engine, root, keys } = await withSwitcherPanel();
  const [first, second] = ids.workspaces;
  const home = await nameTheProfilesWorkspace("Home");

  const chosen = await openSwitcher();
  await activateWorkspace(chosen, second);
  Assert.equal(SvalWindowWorkspace.of(window).id, second, "showing the second");

  const peer = new SvalEngine({
    root,
    ...keys,
    deviceId: crypto.getRandomValues(new Uint8Array(16)),
  });
  registerCleanupFunction(() => stopEngine(peer));
  // Read before it writes, so this device's watermark is in the peer's file
  // and the absence it publishes is a close (spec §5.4).
  await peer.sync(SYNC_DOCUMENT, Date.now());
  await peer.mutate({ kind: "remove", id: ids.tabs[1] });
  await peer.mutate({ kind: "remove", id: second });
  await peer.sync(SYNC_DOCUMENT, Date.now());

  const menu = await openSwitcher();
  Assert.deepEqual(
    switcherEntries(menu, [home, first, second]).map(
      item => item.dataset.workspaceId
    ),
    [home, first, second],
    "the popup on screen lists every workspace, the shown one included"
  );

  // The pass a poll runs. Nobody clicks anything between here and the
  // assertions below.
  Assert.ok(await SvalPanel._syncInBackground(), "the poll read the folder");

  Assert.ok(
    !(second in SvalPanel.nodes),
    "the close arrived — the node is simply gone (spec \u00a75.4)"
  );
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    home,
    "the window moved to the first workspace in sibling order on the pass " +
      "itself, not when the user next tried something"
  );
  Assert.ok(drawnIds().length, "drawing the workspace it moved to");
  Assert.equal(SvalPanel._els.switcher.textContent, "Home", "and naming it");
  Assert.deepEqual(
    switcherEntries(menu, [home, first, second]).map(
      item => item.dataset.workspaceId
    ),
    [home, first],
    "the popup still on screen was rebuilt without the closed workspace"
  );
  Assert.equal(
    switcherEntries(menu, [home])[0].getAttribute("aria-current"),
    "true",
    "and marks the workspace the window moved to as current"
  );
  await closeSwitcher(menu);
  await assertNoHandOverFailure();

  await engine.sync(SYNC_DOCUMENT, Date.now());
});

/**
 * A peer renaming a workspace while the switcher is open renames its entry
 * there and then. The same set of entries with the same one checked is not an
 * unchanged popup when one of them now says something else.
 */
add_task(
  async function a_peer_renaming_a_workspace_relabels_the_open_switcher() {
    const { ids, engine, root, keys } = await withSwitcherPanel();
    const [, second] = ids.workspaces;

    const peer = new SvalEngine({
      root,
      ...keys,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    registerCleanupFunction(() => stopEngine(peer));
    await peer.sync(SYNC_DOCUMENT, Date.now());
    await peer.mutate({
      kind: "rename",
      id: second,
      name: "Renamed elsewhere",
      now: Date.now(),
    });
    await peer.sync(SYNC_DOCUMENT, Date.now());

    const menu = await openSwitcher();
    const entry = () =>
      menu.querySelector(`[data-workspace-id="${CSS.escape(second)}"]`);
    Assert.notEqual(
      entry().getAttribute("label"),
      "Renamed elsewhere",
      "the popup on screen shows the old name"
    );

    Assert.ok(await SvalPanel._syncInBackground(), "the poll read the folder");

    Assert.equal(
      entry().getAttribute("label"),
      "Renamed elsewhere",
      "and the pass relabelled it while it stayed open"
    );
    await closeSwitcher(menu);

    await engine.sync(SYNC_DOCUMENT, Date.now());
  }
);

/**
 * Two entries pressed faster than a switch completes.
 *
 * A switch unloads the outgoing workspace's tabs and materialises the
 * incoming one's, so two interleaved switches would each do half of the
 * other's work. They run one after the other.
 */
add_task(async function two_switches_in_a_row_do_not_interleave() {
  const { ids } = await withSwitcherPanel();
  const [first, second] = ids.workspaces;

  // Not awaited between them, as a person pressing twice does.
  const both = Promise.all([
    SvalPanel.switchTo(second),
    SvalPanel.switchTo(first),
  ]);
  Assert.deepEqual(
    await within(both, 10_000, "both switches"),
    [true, true],
    "each switch ran to its end"
  );
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    first,
    "the window ends on the one pressed last"
  );
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "the window's observer settling"
  );
  Assert.deepEqual(
    shownIds(),
    [ids.tabs[0]],
    "holding that workspace's tabs and none of the other's, which two " +
      "switches doing half of each other's work would leave behind"
  );
  await assertNoHandOverFailure();
});

/**
 * A node a peer's file puts under one of this device's tabs is drawn beside
 * that tab, in the tab's workspace, after the pass that brings it in.
 *
 * A tab is a leaf, so a node under one is drawn nowhere. This build's own
 * `moveNode` refuses to file anything under a tab, so the peer here gives a
 * group the id of a tab this device makes without having seen it: the merge
 * keeps this device's kind, and the peer's tab inside the group lands under
 * a tab. The tab's place is known, so the engine's repair files the peer's
 * tab immediately after it (spec §5.2). The tab is in the higher-id
 * workspace, so a repair that sent the node to the lowest-id one is caught.
 */
add_task(
  async function a_node_a_peer_filed_under_a_tab_is_drawn_beside_that_tab() {
    const { ids, engine, root, keys } = await withSwitcherPanel();
    const [lowest, higher] = [...ids.workspaces].sort();
    const ownTab = ids.tabs[ids.workspaces.indexOf(higher)];

    const peer = new SvalEngine({
      root,
      ...keys,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    registerCleanupFunction(() => stopEngine(peer));
    await peer.sync(SYNC_DOCUMENT, Date.now());
    const host = crypto.randomUUID();
    await peer.mutate({
      kind: "addGroup",
      parent: lowest,
      name: "The peer's group",
      id: host,
      now: Date.now(),
    });
    const filed = await peer.mutate({
      kind: "addTab",
      parent: host,
      name: "Filed by the peer",
      url: "https://example.com/filed",
      id: crypto.randomUUID(),
      now: Date.now(),
    });
    await peer.sync(SYNC_DOCUMENT, Date.now());

    await engine.mutate({
      kind: "addTab",
      parent: higher,
      name: "Host",
      url: "https://example.com/host",
      id: host,
      now: Date.now() + 1,
    });
    const after = await engine.mutate({
      kind: "addTab",
      parent: higher,
      name: "After the host",
      url: "https://example.com/after",
      id: crypto.randomUUID(),
      now: Date.now() + 1,
    });
    Assert.ok(await SvalPanel._syncInBackground(), "the poll read the folder");
    Assert.equal(SvalPanel.nodes[host].kind, "tab", "the host is this tab");

    if (SvalWindowWorkspace.of(window).id !== higher) {
      const menu = await openSwitcher();
      await activateWorkspace(menu, higher);
    }
    Assert.deepEqual(
      drawnIds(),
      [ownTab, host, filed, after],
      "the peer's tab is drawn in the host's workspace, immediately after it"
    );
    Assert.equal(
      SvalPanel._rowElementFor(filed).getAttribute("aria-level"),
      "1",
      "as one of the workspace's own rows"
    );
  }
);
