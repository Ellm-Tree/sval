/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A tab moved to another window keeps its session state: what its page
 * reports, during the move and after it, is filed under the moved tab's own
 * key, so the closed-tab record and a restore carry it.
 */

const { TabStateFlusher } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/TabStateFlusher.sys.mjs"
);

const INPUT = ROOT + "sval_agent_input.html";

function openWindow() {
  return within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "the other window's opening"
  );
}

async function openInput() {
  const tab = BrowserTestUtils.addTab(gBrowser, INPUT);
  await within(
    BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, INPUT),
    10_000,
    "the page's load"
  );
  return tab;
}

function type(browser, value) {
  return within(
    SpecialPowers.spawn(browser, [value], v => {
      const field = content.document.getElementById("field");
      field.value = v;
      field.dispatchEvent(new content.Event("input", { bubbles: true }));
    }),
    10_000,
    "typing into the field"
  );
}

function fieldIn(tab) {
  return JSON.parse(SessionStore.getTabState(tab)).formdata?.id?.field;
}

async function closeWindowOf(tab) {
  const win = tab.documentGlobal;
  await within(BrowserTestUtils.removeTab(tab), 10_000, "the tab's close");
  await within(
    win.SvalPanel?.observer?.settled(),
    10_000,
    "the window's observer"
  );
  await within(BrowserTestUtils.closeWindow(win), 10_000, "the window's close");
}

add_task(async function what_a_moved_tab_reports_is_filed_under_it() {
  const tab = await openInput();
  const other = await openWindow();
  const moved = other.gBrowser.adoptTab(tab);
  ok(moved, "the tab moved");

  await type(moved.linkedBrowser, "after the move");
  await within(
    TabStateFlusher.flush(moved.linkedBrowser),
    10_000,
    "the moved tab's flush"
  );
  Assert.equal(
    fieldIn(moved),
    "after the move",
    "the moved tab's state has what was typed after the move"
  );

  await closeWindowOf(moved);
});

add_task(async function a_tab_moved_while_it_loads_moves_cleanly() {
  const other = await openWindow();
  const tab = BrowserTestUtils.addTab(gBrowser, INPUT);
  const moved = other.gBrowser.adoptTab(tab);
  ok(moved, "the tab moved");
  await within(
    BrowserTestUtils.browserLoaded(moved.linkedBrowser, false, INPUT),
    10_000,
    "the moved tab's load"
  );
  await within(
    TabStateFlusher.flush(moved.linkedBrowser),
    10_000,
    "the moved tab's flush"
  );
  Assert.equal(
    JSON.parse(SessionStore.getTabState(moved)).entries.at(-1)?.url,
    INPUT,
    "the moved tab's history ends at its page"
  );

  await closeWindowOf(moved);
});
