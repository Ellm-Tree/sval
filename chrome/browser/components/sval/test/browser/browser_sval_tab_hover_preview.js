/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_ctrl_tab_helpers.js */

/**
 * Pointing at a tab's row in the Workspace panel, or moving keyboard focus
 * to it, shows Firefox's tab preview beside the panel, with the picture the
 * Ctrl+Tab switcher keeps, or for the tab on screen one drawn as it opens
 * (`SvalTabHoverPreview`). Leaving the row, a click
 * and Escape hide it; the first Escape does nothing else. A group's row has
 * no preview, and the switch in Settings turns them all off.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_ctrl_tab_helpers.js",
  this
);

const { keptPreview } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabSwitcher.sys.mjs"
);
const { moveIntoTarget } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

/**
 * @param {Window} [win]
 * @returns {Element} Firefox's tab preview panel.
 */
function previewPanel(win = window) {
  return win.document.getElementById("tab-preview-panel");
}

/**
 * @param {Element} tab
 * @returns {Promise<Element>} the tab's row, once the panel draws it.
 */
async function rowOf(tab) {
  const win = tab.documentGlobal;
  const { observer } = win.SvalPanel;
  await within(observer.settled(), 10_000, "the observer settling");
  const id = observer.nodeIdFor(tab);
  await TestUtils.waitForCondition(
    () => win.document.getElementById(`sval-row-${id}`),
    "the tab's row"
  );
  return win.document.getElementById(`sval-row-${id}`);
}

/**
 * Points at `row` and waits for the preview to show.
 *
 * @param {Element} row
 */
async function pointAt(row) {
  const win = row.documentGlobal;
  // The pointer may rest on the panel from an earlier file, where this row
  // is then drawn under it: the row's preview opens with no pointing, and a
  // tab switch closes it again.
  await pointAway(win);
  // Rows the file's earlier tasks left can push this one past the panel's
  // end, where a person scrolls to it before pointing. A scroll hides the
  // preview, so it is over before the pointer moves.
  const tree = win.document.querySelector(".sval-tree").getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (box.top < tree.top || box.bottom > tree.bottom) {
    const scrolled = BrowserTestUtils.waitForEvent(
      win.document.getElementById("sval-panel-container"),
      "scroll",
      true
    );
    row.scrollIntoView({ block: "nearest" });
    await within(scrolled, 10_000, "the panel scrolling to the row");
  }
  const shown = BrowserTestUtils.waitForPopupEvent(previewPanel(win), "shown");
  EventUtils.synthesizeMouseAtCenter(row, { type: "mousemove" }, win);
  await within(shown, 10_000, "the preview showing");
}

/**
 * Takes the pointer off the panel and waits for the preview to go.
 *
 * @param {Window} [win]
 */
async function pointAway(win = window) {
  const panel = previewPanel(win);
  const hidden =
    panel.state === "closed"
      ? null
      : BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeMouseAtCenter(
    win.gBrowser.selectedBrowser,
    { type: "mousemove" },
    win
  );
  if (hidden) {
    await within(hidden, 10_000, "the preview hiding");
  }
}

add_task(async function the_strip_is_not_where_previews_show() {
  Assert.ok(
    Services.prefs.getBoolPref("browser.tabs.hoverPreview.enabled"),
    "previews are on by default"
  );
  Assert.ok(
    gBrowser.tabs.every(
      tab => !tab.checkVisibility({ visibilityProperty: true })
    ),
    "and no tab of Firefox's hidden strip, which shows them, can be pointed at"
  );
});

add_task(async function a_tab_row_shows_its_preview_beside_the_panel() {
  const left = await openPage(titledPage("Left behind"));
  await openPage(titledPage("Shown now"));
  await TestUtils.waitForCondition(
    () => keptPreview(left),
    "the tab left drawn"
  );

  const row = await rowOf(left);
  await pointAt(row);
  const panel = previewPanel();
  Assert.equal(
    panel.querySelector(".tab-preview-title").textContent,
    "Left behind",
    "the preview names the tab"
  );
  Assert.equal(
    panel.querySelector(".tab-preview-uri").textContent,
    "example.com",
    "and its site"
  );
  const container = panel.querySelector(".tab-preview-thumbnail-container");
  Assert.ok(
    !container.classList.contains("hide-thumbnail") &&
      container.querySelector(".sval-hover-picture"),
    "with the picture the switcher keeps"
  );
  const panelRect = document
    .getElementById("sval-panel-container")
    .getBoundingClientRect();
  const previewRect = panel.getBoundingClientRect();
  Assert.ok(
    previewRect.left >= panelRect.right || previewRect.right <= panelRect.left,
    "beside the Workspace panel, never over it"
  );
  await pointAway();
});

add_task(async function a_tab_never_loaded_shows_its_title_alone() {
  const url = titledPage("Not loaded");
  const tab = BrowserTestUtils.addTab(gBrowser, url, {
    createLazyBrowser: true,
  });
  Assert.ok(!tab.linkedPanel, "the tab has not loaded");
  await pointAt(await rowOf(tab));
  const container = previewPanel().querySelector(
    ".tab-preview-thumbnail-container"
  );
  Assert.ok(
    container.classList.contains("hide-thumbnail"),
    "a tab never loaded shows no picture"
  );
  Assert.equal(
    previewPanel().querySelector(".tab-preview-title").textContent,
    tab.label,
    "and the name its row shows"
  );
  await pointAway();
});

add_task(async function the_tab_on_screen_shows_its_page_as_it_is() {
  await openPage(titledPage("First"));
  const shown = await openPage(titledPage("On screen"));
  await pointAt(await rowOf(shown));
  const container = previewPanel().querySelector(
    ".tab-preview-thumbnail-container"
  );
  Assert.ok(
    !container.classList.contains("hide-thumbnail") &&
      container.querySelector("canvas"),
    "the tab on screen shows a picture drawn as its preview opened"
  );
  Assert.ok(keptPreview(shown), "which is kept for later");
  await pointAway();
});

add_task(async function keyboard_focus_shows_it_and_escape_hides_it_alone() {
  const a = await openPage(titledPage("Keyed A"));
  const b = await openPage(titledPage("Keyed B"));
  const rowA = await rowOf(a);
  const rowB = await rowOf(b);
  rowB.focus();
  EventUtils.synthesizeKey("KEY_ArrowUp", { shiftKey: true });
  Assert.equal(document.activeElement, rowA, "focus moved up a row");
  await TestUtils.waitForCondition(
    () =>
      previewPanel().state === "open" &&
      previewPanel().querySelector(".tab-preview-title").textContent ===
        "Keyed A",
    "the focused row's preview showing"
  );
  Assert.ok(
    rowA.getAttribute("aria-selected") === "true" &&
      rowB.getAttribute("aria-selected") === "true",
    "with both rows selected"
  );

  const hidden = BrowserTestUtils.waitForPopupEvent(previewPanel(), "hidden");
  EventUtils.synthesizeKey("KEY_Escape");
  await within(hidden, 10_000, "Escape hiding the preview");
  Assert.equal(
    rowA.getAttribute("aria-selected"),
    "true",
    "the first Escape leaves the selection"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => rowA.getAttribute("aria-selected") !== "true",
    "the next Escape clearing the selection"
  );
});

add_task(async function a_group_row_and_a_switched_off_preview_show_nothing() {
  const tab = await openPage(titledPage("Grouped away"));
  const group = await SvalPanel.engine.mutate({
    kind: "addGroup",
    parent: SvalPanel.workspaceId,
    name: "Shelf",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    await SvalPanel.engine.mutate({ kind: "remove", id: group });
    await SvalPanel.refresh();
  });
  await SvalPanel.refresh();
  await TestUtils.waitForCondition(
    () => document.getElementById(`sval-row-${group}`),
    "the group's row"
  );
  const groupRow = document.getElementById(`sval-row-${group}`);
  let shows = 0;
  const count = () => shows++;
  previewPanel().addEventListener("popupshown", count);
  atTaskEnd(() => previewPanel().removeEventListener("popupshown", count));
  EventUtils.synthesizeMouseAtCenter(groupRow, { type: "mousemove" });

  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.hoverPreview.enabled", false]],
  });
  EventUtils.synthesizeMouseAtCenter(await rowOf(tab), { type: "mousemove" });
  EventUtils.synthesizeMouseAtCenter(gBrowser.selectedBrowser, {
    type: "mousemove",
  });
  await SpecialPowers.popPrefEnv();

  // Pointed at with previews on, the next tab's preview is the first that
  // shows: neither the group's row nor the tab pointed at while they were
  // off opened one.
  const next = await openPage(titledPage("Pointed at last"));
  await pointAt(await rowOf(next));
  Assert.equal(shows, 1, "one preview showed");
  Assert.equal(
    previewPanel().querySelector(".tab-preview-title").textContent,
    "Pointed at last",
    "for the tab pointed at with previews on"
  );
  await pointAway();
});

add_task(async function a_tab_loaded_behind_shows_its_picture() {
  const url = titledPage("Loaded behind");
  const tab = BrowserTestUtils.addTab(gBrowser, url);
  await pageReady(tab.linkedBrowser, url);
  Assert.ok(!tab.selected, "the tab loaded without being looked at");
  await TestUtils.waitForCondition(
    () => keptPreview(tab),
    "the loaded page drawn"
  );

  await pointAt(await rowOf(tab));
  const container = previewPanel().querySelector(
    ".tab-preview-thumbnail-container"
  );
  Assert.ok(
    !container.classList.contains("hide-thumbnail") &&
      container.querySelector(".sval-hover-picture"),
    "its preview shows a picture of its page"
  );
  await pointAway();
});

add_task(
  async function a_page_that_changes_its_own_address_keeps_its_picture() {
    const left = await openPage(titledPage("Moves itself"));
    await openPage(titledPage("Shown after"));
    await TestUtils.waitForCondition(
      () => keptPreview(left),
      "the tab left drawn"
    );
    await SpecialPowers.spawn(left.linkedBrowser, [], () =>
      content.history.replaceState(null, "", "?moved")
    );
    await TestUtils.waitForCondition(
      () => left.linkedBrowser.currentURI.query === "moved",
      "the page's new address"
    );

    await pointAt(await rowOf(left));
    const container = previewPanel().querySelector(
      ".tab-preview-thumbnail-container"
    );
    Assert.ok(
      !container.classList.contains("hide-thumbnail") &&
        container.querySelector(".sval-hover-picture"),
      "the same page keeps its picture at its new address"
    );
    await pointAway();
  }
);

add_task(async function a_menu_that_never_showed_leaves_previews_on() {
  const tab = await openPage(titledPage("After a menu"));
  await openPage(titledPage("On screen"));
  const row = await rowOf(tab);
  // The panel set exists once a row has been pointed at.
  await pointAt(row);
  await pointAway();

  // A menu whose showing is cancelled, as Firefox's page menu cancels its
  // own when it has nothing to show (`nsContextMenu.shouldDisplay`).
  const menu = document.createXULElement("menupopup");
  document.getElementById("mainPopupSet").append(menu);
  atTaskEnd(() => menu.remove());
  const cancelled = BrowserTestUtils.waitForEvent(menu, "popupshowing");
  menu.addEventListener("popupshowing", event => event.preventDefault());
  menu.openPopupAtScreen(0, 0, true);
  await within(cancelled, 10_000, "the menu's showing, cancelled");
  Assert.equal(menu.state, "closed", "the menu never showed");

  await pointAt(row);
  Assert.equal(
    previewPanel().querySelector(".tab-preview-title").textContent,
    "After a menu",
    "the tab's preview shows all the same"
  );
  await pointAway();
});

add_task(async function a_menu_removed_while_open_leaves_previews_on() {
  const tab = await openPage(titledPage("After a removed menu"));
  await openPage(titledPage("On screen"));
  const row = await rowOf(tab);
  // The panel set exists once a row has been pointed at.
  await pointAt(row);
  await pointAway();

  // A menu taken out of the document while it is open, as a menu Sval draws
  // anew is, closes without a popuphiding.
  const menu = document.createXULElement("menupopup");
  menu.append(document.createXULElement("menuitem"));
  document.getElementById("mainPopupSet").append(menu);
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  menu.openPopup(document.documentElement);
  await within(shown, 10_000, "the menu showing");
  let hiding = false;
  menu.addEventListener("popuphiding", () => (hiding = true));
  menu.remove();
  Assert.ok(!hiding, "the menu went without a popuphiding");

  await pointAt(row);
  Assert.equal(
    previewPanel().querySelector(".tab-preview-title").textContent,
    "After a removed menu",
    "the tab's preview shows all the same"
  );
  await pointAway();
});

add_task(async function a_hint_cut_short_leaves_previews_on() {
  // Firefox's preview takes the popups already open when it first loads in
  // a window, so the hint is cut short in a window that has shown no
  // preview yet.
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    20_000,
    "a new window opening"
  );
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 10_000, "the window closing")
  );
  await within(win.SvalPanel.started, 20_000, "the window's panel starting");
  Assert.ok(
    !win.gBrowser.tabContainer.previewPanel,
    "the window has shown no preview"
  );
  const tab = await openPage(titledPage("After a hint"), win);
  await openPage(titledPage("On screen"), win);

  // A confirmation hint hidden as it opens, as a switch of tab hides it,
  // keeps panel.js's mark of a panel still opening.
  win.ConfirmationHint.show(null, "confirmation-hint-page-bookmarked");
  const hint = win.document.getElementById("confirmation-hint");
  const closed = BrowserTestUtils.waitForPopupEvent(hint, "hidden");
  hint.hidePopup();
  await within(closed, 10_000, "the hint closing");
  Assert.equal(hint.getAttribute("animating"), "true", "the hint is so marked");

  await pointAt(await rowOf(tab));
  Assert.equal(
    previewPanel(win).querySelector(".tab-preview-title").textContent,
    "After a hint",
    "the tab's preview shows all the same"
  );
});

add_task(async function a_row_drawn_anew_takes_its_preview_with_it() {
  const tab = await openPage(titledPage("Moved away"));
  await openPage(titledPage("On screen"));
  const row = await rowOf(tab);
  await pointAt(row);

  // A tab moved into a group, as a sync from another device moves it, has
  // its row drawn anew at the group's depth.
  const group = await SvalPanel.engine.mutate({
    kind: "addGroup",
    parent: SvalPanel.workspaceId,
    name: "Away",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  atTaskEnd(async () => {
    await SvalPanel.engine.mutate({ kind: "remove", id: group });
    await SvalPanel.refresh();
  });
  const hidden = BrowserTestUtils.waitForPopupEvent(previewPanel(), "hidden");
  const target = moveIntoTarget(
    (await SvalPanel.engine.tree()).nodes,
    SvalPanel.observer.nodeIdFor(tab),
    group
  );
  await SvalPanel.engine.mutate({
    kind: "moveNode",
    ...target,
    now: Date.now(),
  });
  await SvalPanel.refresh();
  Assert.ok(!row.isConnected, "the row is drawn anew");
  Assert.notEqual(
    previewPanel().state,
    "open",
    "and its preview closes with it"
  );
  await within(hidden, 10_000, "the preview hiding with its row");
});

add_task(async function a_preview_a_tab_switch_closed_comes_back_on_its_row() {
  const tab = await openPage(titledPage("Stays pointed at"));
  await openPage(titledPage("On screen"));
  const row = await rowOf(tab);
  await pointAt(row);

  // The pointer stays on the row as another tab comes to the front, as a
  // keyboard shortcut brings it, and Firefox closes the preview.
  const hidden = BrowserTestUtils.waitForPopupEvent(previewPanel(), "hidden");
  await selectTab(gBrowser.tabs[0]);
  await within(hidden, 10_000, "the preview closing on the switch");

  const shown = BrowserTestUtils.waitForPopupEvent(previewPanel(), "shown");
  EventUtils.synthesizeMouseAtCenter(
    row.querySelector(".sval-row-icon"),
    { type: "mousemove" },
    window
  );
  await within(shown, 10_000, "the preview showing again");
  Assert.equal(
    previewPanel().querySelector(".tab-preview-title").textContent,
    "Stays pointed at",
    "for the row under the pointer"
  );
  await pointAway();
});
