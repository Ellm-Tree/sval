/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */

/**
 * A pin's page is in no session Firefox keeps (pins spec §5: after a restart
 * each pin starts at its saved address). Its mark is an attribute of the
 * live tab, so a page brought back from a session, a closed window or the
 * recently closed tabs would come back as a hidden tab of no pin, and the
 * tab observer would file it as a tab of the window's workspace.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);

const { TabStateFlusher } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/TabStateFlusher.sys.mjs"
);

add_setup(pinsSetup);

/**
 * @param {object} state A window's state, as `SessionStore` collects it.
 * @returns {string[]} the address each of its tabs shows.
 */
function savedAddresses(state) {
  return state.tabs.map(tab => tab.entries[tab.index - 1]?.url ?? "");
}

add_task(async function a_pins_page_is_left_out_of_the_windows_state() {
  const url = `${PAGE}?session=state`;
  const guid = await pinFavorite(url, "Saved");
  await clickTile(guid, url);
  await TabStateFlusher.flushWindow(window);

  let state = SessionStore.getWindowState(window).windows[0];
  Assert.ok(
    !savedAddresses(state).includes(url),
    "the selected pin's page is in no saved tab"
  );
  Assert.equal(state.selected, 1, "the window restores on its first tab");

  // A tab opened after the page sits after it in the strip.
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE2),
    10_000,
    "a tab opening after the page"
  );
  await TabStateFlusher.flushWindow(window);
  state = SessionStore.getWindowState(window).windows[0];
  Assert.ok(
    !savedAddresses(state).includes(url),
    "the page out of sight is in no saved tab"
  );
  Assert.equal(
    savedAddresses(state)[state.selected - 1],
    PAGE2,
    "the window restores on the tab it shows"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_closed_pins_page_is_no_recently_closed_tab() {
  const url = `${PAGE}?session=closed`;
  const guid = await pinFavorite(url, "Closed");
  const page = await clickTile(guid, url);
  await TabStateFlusher.flush(page.linkedBrowser);
  const before = SessionStore.getClosedTabCountForWindow(window);
  // Closed as Firefox closes a tab, which records it.
  gBrowser.removeTab(page, { animate: false });
  Assert.equal(
    SessionStore.getClosedTabCountForWindow(window),
    before,
    "Undo Close Tab cannot bring it back"
  );
});
