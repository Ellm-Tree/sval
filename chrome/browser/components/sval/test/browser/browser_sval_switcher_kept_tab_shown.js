/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * A window shows one workspace, and a workspace lives in one window (spec
 * §10.7). A tab a switch kept loaded is hidden, the window that shows its
 * workspace next takes it, and whatever in Firefox goes to a hidden tab takes
 * the window to that tab's workspace.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { SvalFirefox } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirefox.sys.mjs"
);

const FORM = `<textarea></textarea>`;

/**
 * The first workspace's tab, typed into so a switch keeps it loaded, with the
 * window then switched to another workspace.
 *
 * @param {object} fixture `withSwitcherTabs`'s result.
 * @param {string} [to] Where the window goes: the second workspace unless
 *   another is named.
 * @returns {Promise<Element>} the kept tab.
 */
async function keptAway(fixture, to = fixture.ids.workspaces[1]) {
  const { ids, observer } = fixture;
  const tab = observer.tabFor(ids.tabs[0]);
  await typeInto(tab, "textarea", "half a reply");
  await markPage(tab);
  Assert.ok(await SvalPanel.switchTo(to), "switched away");
  Assert.ok(tab.hidden && tab.linkedPanel, "the typed-into tab is kept");
  return tab;
}

/**
 * Opens a window as ⌘N does (`openWindowOnNextWorkspace`), and waits for its
 * panel to have started.
 *
 * @returns {Promise<DOMWindow>}
 */
async function newWindowOnNextWorkspace() {
  const opening = BrowserTestUtils.waitForNewWindow();
  SvalPanel.openWindowOnNextWorkspace();
  const win = await within(opening, 20_000, "a new window's opening");
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
  return win;
}

add_task(async function going_to_a_kept_tab_goes_to_its_workspace() {
  const fixture = await withSwitcherTabs({ body: FORM });
  const { ids, engine, observer, baseline } = fixture;
  const tab = await keptAway(fixture);

  // As an extension's `tabs.update` goes to a tab.
  await selectTab(tab);
  await TestUtils.waitForCondition(
    () => SvalWindowWorkspace.of(window).id === ids.workspaces[0],
    "the window goes to the tab's workspace"
  );
  await quiet(engine, observer);
  Assert.equal(gBrowser.selectedTab, tab, "showing that tab");
  Assert.ok(gBrowser.visibleTabs.includes(tab), "among the window's tabs");
  Assert.ok(SvalPanel._rowElementFor(ids.tabs[0]), "with its row drawn");
  await TestUtils.waitForCondition(
    () => !gBrowser.visibleTabs.includes(observer.tabFor(ids.tabs[1])),
    "and nothing of the workspace it left within reach"
  );
  const { text, marked } = await pageState(tab, "textarea");
  Assert.ok(text.includes("half a reply") && marked, "the same document");
  Assert.equal(await quiet(engine, observer), baseline, "the tree unchanged");
  await assertNoHandOverFailure();
});

add_task(async function switching_to_a_kept_tab_by_address_goes_there() {
  const fixture = await withSwitcherTabs({ body: FORM });
  const { ids, engine, observer, baseline } = fixture;
  const tab = await keptAway(fixture);
  const untagged = () => gBrowser.tabs.filter(t => !taggedId(t)).length;
  const before = untagged();

  // As a switch-to-tab result in the address bar does.
  Assert.ok(
    switchToTabHavingURI(tab.linkedBrowser.currentURI, false),
    "Firefox finds the kept tab"
  );
  await TestUtils.waitForCondition(
    () => SvalWindowWorkspace.of(window).id === ids.workspaces[0],
    "the window goes to the tab's workspace"
  );
  await quiet(engine, observer);
  Assert.equal(gBrowser.selectedTab, tab, "showing that tab");
  const { text, marked } = await pageState(tab, "textarea");
  Assert.ok(text.includes("half a reply") && marked, "with its text");
  Assert.equal(untagged(), before, "and no blank tab opened");
  Assert.equal(await quiet(engine, observer), baseline, "the tree unchanged");
  await assertNoHandOverFailure();
});

add_task(async function a_new_window_on_a_workspace_takes_its_kept_tab() {
  const fixture = await withSwitcherTabs({ body: FORM });
  const { ids, engine, baseline } = fixture;
  // The profile's own workspace comes first in sibling order, and the first
  // workspace made here right after it.
  const [home] = SvalTree.workspaceIds(SvalPanel.nodes);
  const tab = await keptAway(fixture, home);

  // ⌘N opens a window on the workspace after this window's, which is the one
  // this window just left.
  const win = await newWindowOnNextWorkspace();
  Assert.equal(
    SvalWindowWorkspace.of(win).id,
    ids.workspaces[0],
    "the new window shows the workspace this one left"
  );
  const there = win.gBrowser.tabs.find(t => taggedId(t) === ids.tabs[0]);
  Assert.ok(there, "and holds its kept tab");
  Assert.ok(!gBrowser.tabs.includes(tab), "which left this window");
  Assert.ok(!heldIds().includes(ids.tabs[0]), "leaving no tab of it here");
  const { text, marked } = await pageState(there, "textarea");
  Assert.ok(text.includes("half a reply") && marked, "with its text");
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "the new window's observer settling"
  );
  Assert.equal(await treeJson(engine), baseline, "and no node added");

  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the test window closing"
  );
  await assertNoHandOverFailure();
});

add_task(async function a_picture_in_picture_video_plays_on_through_a_take() {
  const { ids, observer } = await withSwitcherTabs();
  const tab = observer.tabFor(ids.tabs[0]);
  await untilRestored(tab);
  // A site the user lets play media, so the video plays under Sval's own
  // media defaults: a window of this profile opens below, and its settings
  // sync would carry any media pref this file changed into the profile.
  // Allowed before the page loads, so its process has the permission.
  const page = ROOT + "sval_call_page.html";
  const principal =
    Services.scriptSecurityManager.createContentPrincipalFromOrigin(
      new URL(page).origin
    );
  Services.perms.addFromPrincipal(
    principal,
    "autoplay-media",
    Services.perms.ALLOW_ACTION
  );
  registerCleanupFunction(() =>
    Services.perms.removeFromPrincipal(principal, "autoplay-media")
  );
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, page);
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, page);
  await within(loaded, 10_000, "the video's page loading");
  // Opening picture-in-picture records that its toggle was used
  // (`PictureInPictureChild.sys.mjs`). Undone when the file ends.
  await SpecialPowers.pushPrefEnv({
    clear: [["media.videocontrols.picture-in-picture.video-toggle.has-used"]],
  });
  // A video the page draws itself, frame by frame, so it plays for as long
  // as the test needs and loads nothing.
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const doc = content.document;
    const canvas = doc.createElement("canvas");
    const context = canvas.getContext("2d");
    let frame = 0;
    content.setInterval(() => {
      context.fillStyle = frame++ % 2 ? "black" : "white";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }, 20);
    const video = doc.createElement("video");
    video.id = "video";
    video.muted = true;
    doc.body.append(video);
    video.srcObject = canvas.captureStream();
    await video.play();
  });
  const opened = BrowserTestUtils.domWindowOpenedAndLoaded(null);
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const video = content.document.getElementById("video");
    content.windowUtils.dispatchEventToChromeOnly(
      video,
      new content.CustomEvent("MozTogglePictureInPicture", { bubbles: true })
    );
    await ContentTaskUtils.waitForCondition(
      () => video.isCloningElementVisually,
      "the video is shown in picture-in-picture"
    );
  });
  const player = await within(opened, 10_000, "the picture-in-picture window");
  registerCleanupFunction(async () => {
    if (!player.closed) {
      await within(
        BrowserTestUtils.closeWindow(player),
        10_000,
        "the picture-in-picture window closing"
      );
    }
  });
  await within(SimpleTest.promiseFocus(window), 10_000, "focus coming back");
  const playing = where =>
    SpecialPowers.spawn(where.linkedBrowser, [], async () => {
      const video = content.document.getElementById("video");
      const from = video.currentTime;
      await ContentTaskUtils.waitForCondition(
        () => video.currentTime > from,
        "the video moves on"
      );
      return !video.paused && video.isCloningElementVisually;
    });
  Assert.ok(await playing(tab), "the video plays in picture-in-picture");
  const [home] = SvalTree.workspaceIds(SvalPanel.nodes);
  Assert.ok(await SvalPanel.switchTo(home), "switched away");
  Assert.ok(tab.hidden && tab.linkedPanel, "the video's tab is kept");

  // ⌘N takes the workspace after this window's, the one it left, and with
  // it the video's tab.
  const win = await newWindowOnNextWorkspace();
  Assert.equal(
    SvalWindowWorkspace.of(win).id,
    ids.workspaces[0],
    "the new window shows the video's workspace"
  );
  const there = win.gBrowser.tabs.find(t => taggedId(t) === ids.tabs[0]);
  Assert.ok(there, "and holds the video's tab");
  Assert.ok(!player.closed, "the picture-in-picture window is still open");
  Assert.ok(await playing(there), "and the video plays on in it");

  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the test window closing"
  );
});

add_task(async function a_window_taking_a_workspace_takes_its_kept_tab() {
  const fixture = await withSwitcherTabs({ body: FORM });
  const { ids, engine, baseline } = fixture;
  const tab = await keptAway(fixture);

  const win = await tearOff(ids.workspaces[0]);
  const there = win.SvalPanel.observer.tabFor(ids.tabs[0]);
  Assert.ok(there, "the workspace's window holds its tab");
  Assert.ok(!gBrowser.tabs.includes(tab), "which left this window");
  const { text, marked } = await pageState(there, "textarea");
  Assert.ok(text.includes("half a reply") && marked, "with its page");
  await within(
    win.SvalPanel.observer.settled(),
    10_000,
    "win.SvalPanel.observer settling"
  );
  Assert.equal(await treeJson(engine), baseline, "and no node added");

  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the test window closing"
  );
  await assertNoHandOverFailure();
});

add_task(async function a_kept_tab_moved_to_another_windows_workspace() {
  const fixture = await withSwitcherTabs({ body: FORM });
  const { ids, observer } = fixture;
  const [first, second] = ids.workspaces;
  Assert.ok(await SvalPanel.switchTo(second), "switched to the second");
  const win = await tearOff(first);
  window.focus();
  await untilFocused(window, "this window has focus again");

  // A tab typed into, moved to the workspace the other window shows, goes
  // to that window with its page, and neither window moves or comes up.
  const tab = observer.tabFor(ids.tabs[1]);
  await typeInto(tab, "textarea", "half a reply");
  await markPage(tab);
  await SvalPanel.moveToWorkspace(ids.tabs[1], first);
  const there = win.gBrowser.tabs.find(t => taggedId(t) === ids.tabs[1]);
  Assert.ok(there, "the moved tab is in the window showing its workspace");
  Assert.ok(!heldIds().includes(ids.tabs[1]), "and left this window");
  const { text, marked } = await pageState(there, "textarea");
  Assert.ok(text.includes("half a reply") && marked, "with its page");
  Assert.equal(SvalWindowWorkspace.of(window).id, second, "this window stays");
  Assert.equal(SvalWindowWorkspace.of(win).id, first, "as does that one");
  Assert.equal(Services.focus.activeWindow, window, "and keeps the focus");

  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the test window closing"
  );
  await assertNoHandOverFailure();
});

add_task(async function a_kept_tab_a_peer_moves_goes_to_its_window() {
  const fixture = await withSwitcherTabs({ workspaces: 3, body: FORM });
  const { ids, engine } = fixture;
  const tab = await keptAway(fixture);
  const win = await tearOff(ids.workspaces[2]);
  window.focus();
  await untilFocused(window, "this window has focus again");
  Assert.ok(gBrowser.tabs.includes(tab), "the kept tab is still here");

  // Another device moves the kept tab's node into the workspace the other
  // window shows, and this window's poll brings the move in.
  await engine.mutate({
    kind: "moveNode",
    id: ids.tabs[0],
    newParent: ids.workspaces[2],
    before: null,
    after: null,
    now: Date.now(),
  });
  Assert.ok(await SvalPanel._syncInBackground(), "the poll ran");
  await TestUtils.waitForCondition(
    () => win.gBrowser.tabs.some(t => taggedId(t) === ids.tabs[0]),
    "the window showing its workspace takes the tab"
  );
  const there = win.gBrowser.tabs.find(t => taggedId(t) === ids.tabs[0]);
  Assert.ok(!heldIds().includes(ids.tabs[0]), "which left this window");
  const { text, marked } = await pageState(there, "textarea");
  Assert.ok(text.includes("half a reply") && marked, "with its text");
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    ids.workspaces[1],
    "no switch"
  );
  Assert.equal(Services.focus.activeWindow, window, "and no focus taken");

  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the test window closing"
  );
  await assertNoHandOverFailure();
});

add_task(async function a_kept_tab_shown_without_going_to_it_hides_again() {
  const fixture = await withSwitcherTabs({ body: FORM });
  const { ids, observer } = fixture;
  const tab = await keptAway(fixture);

  // As an extension's `tabs.show` does.
  gBrowser.showTab(tab);
  await TestUtils.waitForCondition(
    () => !gBrowser.visibleTabs.includes(tab),
    "the tab goes back out of reach"
  );
  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    ids.workspaces[1],
    "no switch"
  );
  Assert.equal(gBrowser.selectedTab, observer.tabFor(ids.tabs[1]), "or move");
  Assert.ok(
    SvalFirefox.isHiddenForWorkspace(tab) || !tab.linkedPanel,
    "kept for its workspace, or let go"
  );
});

add_task(async function a_tab_an_extension_hid_is_left_alone() {
  const { ids, engine, observer } = await withSwitcherTabs();
  const opened = BrowserTestUtils.addTab(gBrowser, "about:license");
  await within(observer.settled(), 10_000, "observer settling");
  const id = observer.nodeIdFor(opened);
  Assert.ok(id, "a tab of the workspace the window shows");
  gBrowser.hideTab(opened, "an-extension@example.com");
  Assert.ok(opened.hidden, "which an extension hid");

  await selectTab(opened);
  await quiet(engine, observer);
  Assert.equal(gBrowser.selectedTab, opened, "going to it shows it");
  Assert.equal(SvalWindowWorkspace.of(window).id, ids.workspaces[0], "here");
  Assert.ok(gBrowser.tabs.includes(opened), "where it stays");
});

/**
 * A window the session reopens on a workspace holds its own tab for each of
 * the workspace's nodes, from when it closed. Another window that keeps one
 * of those tabs loaded hands it over, and the reopened window's own tab for
 * that node goes: one tab per node, the live one, and no node added.
 */
add_task(async function a_reopened_window_takes_a_kept_tab_without_a_copy() {
  const fixture = await withSwitcherTabs({ body: FORM, workspaces: 3 });
  const { ids, engine } = fixture;
  const [, second, third] = ids.workspaces;
  for (const { closedId } of SessionStore.getClosedWindowData()) {
    SessionStore.forgetClosedWindowById(closedId);
  }
  atTaskEnd(() => {
    for (const { closedId } of SessionStore.getClosedWindowData()) {
      SessionStore.forgetClosedWindowById(closedId);
    }
  });

  // A window on the second workspace, closed, which the session keeps with
  // that workspace's tab in it.
  const closing = await tearOff(second);
  await within(closing.SvalPanel.observer.settled(), 10_000, "its settling");
  await within(
    BrowserTestUtils.closeWindow(closing),
    10_000,
    "the window closing"
  );
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedWindowCount() == 1,
    "the session keeps the closed window"
  );

  // Another window on it, typed into and switched away, keeps the tab.
  const keeping = await tearOff(second);
  const tab = keeping.SvalPanel.observer.tabFor(ids.tabs[1]);
  await typeInto(tab, "textarea", "half a reply");
  await markPage(tab);
  Assert.ok(await keeping.SvalPanel.switchTo(third), "that window moved on");
  Assert.ok(tab.hidden && tab.linkedPanel, "keeping the tab loaded");
  await within(keeping.SvalPanel.observer.settled(), 10_000, "its settling");
  const before = await treeJson(engine);

  const opening = BrowserTestUtils.domWindowOpenedAndLoaded();
  SessionStore.undoCloseWindow(0);
  const reopened = await within(opening, 20_000, "the window reopening");
  atTaskEnd(async () => {
    if (!reopened.closed) {
      await within(
        BrowserTestUtils.closeWindow(reopened),
        10_000,
        "the reopened window closing"
      );
    }
  });
  await within(reopened.SvalPanel.started, 20_000, "its startup");
  for (const win of [reopened, keeping, window]) {
    await within(win.SvalPanel.observer.settled(), 10_000, "a settling");
    await win.SvalPanel.refresh();
  }

  Assert.equal(SvalWindowWorkspace.of(reopened).id, second, "on its workspace");
  Assert.deepEqual(
    reopened.gBrowser.tabs.map(each => taggedId(each) ?? "untagged"),
    [ids.tabs[1]],
    "holding one tab for the workspace's one node"
  );
  const { text, marked } = await pageState(
    reopened.gBrowser.tabs[0],
    "textarea"
  );
  Assert.ok(text.includes("half a reply") && marked, "the kept one");
  Assert.ok(!keeping.gBrowser.tabs.includes(tab), "which left the other");
  Assert.equal(await treeJson(engine), before, "and no node added");
});
