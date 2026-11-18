/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * A workspace the window leaves keeps running, and unloads once it has been
 * out of sight for `HIDDEN_WORKSPACE_UNLOAD_MS` (spec §10.7). The three hours
 * are reached by handing the sweep a later time: the sweep's own timer is
 * the observer's, and the release it makes is the one checked here.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { HIDDEN_WORKSPACE_UNLOAD_MS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
);
const { SvalClock } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalClock.sys.mjs"
);
const { SvalFirefox } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirefox.sys.mjs"
);

/**
 * Starts a tone in `tab`'s page and waits for Firefox to mark it audible.
 *
 * @param {Element} tab A loaded tab.
 */
async function playTone(tab) {
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const context = new content.AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0.2;
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    await context.resume();
  });
  await TestUtils.waitForCondition(
    () => tab.hasAttribute("soundplaying"),
    "the tab is playing sound"
  );
}

add_setup(async function media_plays_without_asking() {
  await SpecialPowers.pushPrefEnv({
    set: [
      // Settings › Sites: "Allow sites to play video and audio" Always
      // allow. This file is about a workspace that goes on playing.
      ["media.autoplay.site-permission-only.default", 1],
    ],
  });
});

add_task(async function coming_back_finds_the_same_page() {
  const { ids, engine, observer, baseline } = await withSwitcherTabs();
  const [first, second] = ids.workspaces;

  const left = observer.tabFor(ids.tabs[0]);
  await untilRestored(left);
  markPage(left);
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(second),
    "the window switched"
  );

  Assert.ok(
    gBrowser.tabs.includes(left),
    "the tab of the workspace left is still the window's"
  );
  Assert.ok(
    SvalFirefox.isHiddenForWorkspace(left),
    "hidden with its workspace"
  );
  Assert.ok(left.linkedPanel, "and still loaded");

  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(first),
    "and switched back"
  );
  Assert.equal(
    observer.tabFor(ids.tabs[0]),
    left,
    "the workspace shows the same tab"
  );
  Assert.ok(!left.hidden, "shown again");
  Assert.ok(
    (await pageState(left, "body")).marked,
    "with the page it had, never reloaded"
  );
  Assert.equal(
    await quiet(engine, observer),
    baseline,
    "and the document is what it was"
  );
});

add_task(async function three_hours_away_unloads_the_workspace() {
  const { ids, engine, observer, baseline } = await withSwitcherTabs();
  const [, second] = ids.workspaces;

  const left = observer.tabFor(ids.tabs[0]);
  await untilRestored(left);
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(second),
    "the window switched"
  );

  const soon = SvalClock.now() + HIDDEN_WORKSPACE_UNLOAD_MS - 60_000;
  await observer.releaseIdle(soon);
  Assert.ok(
    gBrowser.tabs.includes(left) && left.linkedPanel,
    "a minute short of the time, the tab is still loaded"
  );

  await observer.releaseIdle(SvalClock.now() + HIDDEN_WORKSPACE_UNLOAD_MS);
  Assert.ok(
    !gBrowser.tabs.includes(left),
    "at the time, the tab left the window"
  );
  Assert.deepEqual(
    heldIds(),
    [ids.tabs[1]],
    "which holds the workspace it shows and nothing else"
  );
  Assert.equal(
    await quiet(engine, observer),
    baseline,
    "and the node stays: leaving the window is not closing the tab"
  );
});

add_task(async function a_tab_playing_sound_outlasts_the_time() {
  const { ids, observer } = await withSwitcherTabs();
  const [, second] = ids.workspaces;

  const noisy = observer.tabFor(ids.tabs[0]);
  await untilRestored(noisy);
  await playTone(noisy);
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(second),
    "the window switched"
  );
  Assert.ok(
    noisy.hasAttribute("soundplaying"),
    "the workspace left goes on playing"
  );

  await observer.releaseIdle(SvalClock.now() + HIDDEN_WORKSPACE_UNLOAD_MS);
  Assert.ok(
    gBrowser.tabs.includes(noisy) && noisy.linkedPanel,
    "a tab the user can hear stays loaded past the time"
  );
});

add_task(async function closing_the_last_tab_keeps_the_window() {
  const { ids, observer } = await withSwitcherTabs();
  const [, second] = ids.workspaces;
  const left = observer.tabFor(ids.tabs[0]);
  await untilRestored(left);
  Assert.ok(
    await SvalWindowWorkspace.of(window).switchTo(second),
    "the window switched"
  );
  Assert.ok(SvalFirefox.isHiddenForWorkspace(left), "the left tab is hidden");

  const closing = observer.tabFor(ids.tabs[1]);
  await SvalPanel.run("close", SvalPanel._rowFor(ids.tabs[1]));
  // A close waits on its Undo message with the tab hidden
  // (`SvalFirefox.hideForDelete`).
  await TestUtils.waitForCondition(
    () => !gBrowser.tabs.includes(closing) || closing.hidden,
    "the workspace's last tab closed"
  );
  Assert.ok(!window.closed, "the window stays open");
  Assert.ok(
    gBrowser.visibleTabs.length && !gBrowser.selectedTab.hidden,
    "showing a tab of its own"
  );
  expectOpened(gBrowser.selectedTab);
});
