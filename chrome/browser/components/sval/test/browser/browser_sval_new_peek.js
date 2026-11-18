/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * New Peek, from the File menu, the Launcher or Accel+Alt+N, opens an empty
 * Peek signed in as the window it was asked for in: a page the user
 * opens and closes without filing it in a workspace. A Peek opens where the
 * last one closed.
 */

const { PLACE_KEYS, PLACE_STORE, SvalPeek, isPeek, nextPlace, workspaceTitle } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPeek.sys.mjs"
  );

const PEEK_PAGE = "https://example.com/browser/?new-peek";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
});

function forgetPlace() {
  for (const key of PLACE_KEYS) {
    Services.xulStore.removeValue(PLACE_STORE.doc, PLACE_STORE.id, key);
  }
}

/**
 * Runs `open`, and returns the Peek it opened, closed when the task ends.
 *
 * @param {Function} open
 * @returns {Promise<Window>}
 */
async function peekFrom(open) {
  const opened = BrowserTestUtils.waitForNewWindow({
    url: BROWSER_NEW_TAB_URL,
  });
  open();
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
  return win;
}

/**
 * An isolated workspace named Work, which this window shows until the task
 * ends.
 *
 * @returns {Promise<string>} its id.
 */
async function showIsolatedWorkspace() {
  const home = SvalWindowWorkspace.of(window).id;
  const id = await SvalPanel.engine.mutate({
    kind: "addWorkspace",
    name: "Work",
    isolated: true,
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    if (SvalWindowWorkspace.of(window).id !== home) {
      await SvalPanel.switchTo(home);
      await within(
        SvalPanel.observer.settled(),
        10_000,
        "SvalPanel.observer settling"
      );
      // A workspace with no tab of its own opens a blank one when the window
      // switches back to it.
      expectOpened(...gBrowser.tabs);
    }
    await removeWorkspace(id);
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();
  Assert.ok(await SvalPanel.switchTo(id), "the window shows Work");
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  expectOpened(...gBrowser.tabs);
  return id;
}

add_task(async function the_file_menu_offers_new_peek_on_its_key() {
  const popup = document.getElementById("menu_FilePopup");
  popup.dispatchEvent(new Event("popupshowing"));
  const item = document.getElementById("sval-menu-new-peek");
  Assert.equal(item.parentNode, popup, "New Peek is in the File menu");
  Assert.equal(
    item.previousElementSibling.id,
    "menu_newPrivateWindow",
    "after New Private Window"
  );
  const key = document.getElementById(item.getAttribute("key"));
  Assert.equal(key.getAttribute("key"), "N", "on N");
  Assert.equal(key.getAttribute("modifiers"), "accel,alt", "with Accel+Alt");
  Assert.equal(
    item.getAttribute("acceltext"),
    ShortcutUtils.prettifyShortcut(key),
    "and names it"
  );

  const win = await peekFrom(() => item.doCommand());
  Assert.ok(isPeek(win), "it opens a Peek");
});

add_task(async function the_key_opens_an_empty_peek_in_no_workspace() {
  forgetPlace();
  const before = Object.keys(await nodes(SvalPanel.engine)).length;
  const win = await peekFrom(() =>
    EventUtils.synthesizeKey("n", { accelKey: true, altKey: true })
  );
  Assert.ok(isPeek(win), "a Peek");
  Assert.deepEqual(SvalPeek.windows(), [win], "the only one");
  await TestUtils.waitForCondition(
    () => win.gURLBar.focused,
    "with its address bar focused"
  );
  const tab = win.gBrowser.selectedTab;
  Assert.equal(tab.userContextId, 0, "in the shared jar, as the window's");

  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, PEEK_PAGE);
  await pageReady(tab.linkedBrowser, PEEK_PAGE);
  Assert.equal(
    Object.keys(await nodes(SvalPanel.engine)).length,
    before,
    "and the page is in no workspace"
  );
});

add_task(async function a_peek_from_an_isolated_workspace_uses_its_jar() {
  await showIsolatedWorkspace();
  const jar = gBrowser.defaultUserContextId;
  Assert.greater(jar, 0, "Work has a jar of its own");

  const win = await peekFrom(() => SvalPeek.openEmpty(window));
  const tab = win.gBrowser.selectedTab;
  Assert.equal(tab.userContextId, jar, "the Peek is signed in as Work");
  Assert.equal(
    win.gBrowser.defaultUserContextId,
    jar,
    "and a tab opened in it would be too"
  );

  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, PEEK_PAGE);
  await pageReady(tab.linkedBrowser, PEEK_PAGE);
  const another = await peekFrom(() => SvalPeek.openEmpty(win));
  Assert.equal(
    another.gBrowser.selectedTab.userContextId,
    jar,
    "a Peek from that Peek is signed in as Work as well"
  );
});

add_task(async function moving_it_to_a_shared_workspace_reloads_it_there() {
  const home = SvalWindowWorkspace.of(window).id;
  const homeName = SvalPanel.nodes[home]?.content?.name || "Untitled Workspace";
  await showIsolatedWorkspace();
  const win = await peekFrom(() => SvalPeek.openEmpty(window));
  const browser = win.gBrowser.selectedBrowser;
  BrowserTestUtils.startLoadingURIString(browser, PEEK_PAGE);
  await pageReady(browser, PEEK_PAGE);

  const doc = win.document;
  const menu = doc.getElementById("sval-peek-menu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  doc.getElementById("sval-peek-open-more").click();
  await within(shown, 10_000, "the menu of other workspaces");
  const row = [...menu.querySelectorAll(".sval-peek-menu-row")].find(each =>
    each
      .querySelector(".sval-peek-menu-label")
      .textContent.includes(workspaceTitle(homeName))
  );
  Assert.ok(row, "it offers the shared workspace");
  row.click();
  await TestUtils.waitForCondition(
    () => win.gDialogBox.dialog && !win.gDialogBox.dialog._isClosing,
    "the Peek asks before it reloads the page"
  );
  await dialogShown(win.gDialogBox.dialog, "the dialog");
  const question = win.gDialogBox.dialog._frame.contentDocument;
  const closed = BrowserTestUtils.domWindowClosed(win);
  question.querySelector('button[data-button="ok"]').click();
  await within(closed, 10_000, "the Peek closing");

  Assert.equal(
    SvalWindowWorkspace.of(window).id,
    home,
    "the window switched back"
  );
  const tab = expectOpened(gBrowser.selectedTab);
  await pageReady(tab.linkedBrowser, PEEK_PAGE);
  Assert.equal(tab.userContextId, 0, "and the page loaded in the shared jar");
});

add_task(async function a_peek_opens_where_the_last_one_closed() {
  forgetPlace();
  const first = await peekFrom(() => SvalPeek.openEmpty(window));
  const { availLeft, availTop } = first.screen;
  const place = {
    left: availLeft + 40,
    top: availTop + 50,
    // Wider than a Peek's minimum (`sval-peek.css`).
    width: 760,
    height: 520,
  };
  first.moveTo(place.left, place.top);
  first.resizeBy(
    place.width - first.innerWidth,
    place.height - first.innerHeight
  );
  await TestUtils.waitForCondition(
    () =>
      first.screenX === place.left &&
      first.screenY === place.top &&
      first.innerWidth === place.width &&
      first.innerHeight === place.height,
    "the user moves and sizes the Peek"
  );
  await within(BrowserTestUtils.closeWindow(first), 10_000, "it closing");

  const second = await peekFrom(() => SvalPeek.openEmpty(window));
  await TestUtils.waitForCondition(
    () =>
      second.screenX === place.left &&
      second.screenY === place.top &&
      second.innerWidth === place.width &&
      second.innerHeight === place.height,
    "the next Peek opens there, at that size"
  );
});

add_task(function a_place_off_the_screen_is_not_used() {
  const area = { left: 0, top: 0, width: 1440, height: 875 };
  const kept = { left: 100, top: 80, width: 600, height: 400 };
  Assert.deepEqual(nextPlace(area, null, kept), kept, "one on it is");
  Assert.notDeepEqual(
    nextPlace(area, null, { ...kept, left: 1600 }),
    { ...kept, left: 1600 },
    "one past its edge, on a screen since unplugged, is not"
  );
});
