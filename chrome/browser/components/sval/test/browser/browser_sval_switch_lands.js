/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_on_helpers.js */

/**
 * Where a person finds themselves after going to another workspace through
 * the switcher (spec §10.7): on the tab they left there, with one way into
 * the panel for the keyboard, and with what they open next filed where they
 * are.
 * Each task reads the window as a person does: the switcher, the rows, the
 * tab on screen and the address bar.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_on_helpers.js",
  this
);

add_setup(failOnConsoleErrors);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  expectWorkspaceTabs();
});

/**
 * @param {string} title
 * @returns {{url: string, title: string}} a page for `workspaceWith`.
 */
function page(title) {
  return { url: titledRed(title), title };
}

/** @returns {string[]} the rows the panel marks as the tab on screen. */
function selectedRowIds() {
  return rowIdsIn(window).filter(
    id => rowIn(window, id).getAttribute("aria-selected") === "true"
  );
}

/**
 * @param {Element} tree The panel's tree.
 * @returns {Element[]} the elements in it a Tab key press can land on. The
 *   tree keeps one (roving `tabindex`), so Tab leaves the panel in one press.
 */
function tabStopsIn(tree) {
  return Array.from(tree.querySelectorAll('[tabindex="0"]'));
}

add_task(async function switching_back_lands_on_the_tab_that_was_left() {
  const reading = await workspaceWith("Reading", {
    pages: [page("One"), page("Two"), page("Three")],
  });
  const errands = await workspaceWith("Errands", {
    pages: [page("Elsewhere")],
  });
  const two = reading.tabs[1];

  await switchVia(window, reading.id);
  Assert.deepEqual(rowIdsIn(window), reading.tabs, "its three tabs are drawn");
  await clickRowShows(window, two, titledRed("Two"), "the second tab");

  await switchVia(window, errands.id);
  Assert.equal(switcherNameIn(window), "Errands", "the switcher names it");
  await selectedShows(window, titledRed("Elsewhere"), "the other's page");

  await switchVia(window, reading.id);
  Assert.equal(switcherNameIn(window), "Reading", "back where it was");
  Assert.equal(
    taggedId(gBrowser.selectedTab),
    two,
    "the tab on screen is the one that was left"
  );
  await selectedShows(window, titledRed("Two"), "the tab that was left");
  Assert.deepEqual(
    selectedRowIds(),
    [two],
    "and its row alone is the selected one"
  );
});

/**
 * A switch puts another tab on screen, and Firefox takes the keyboard off
 * whatever held it as a tab switch starts and gives it to the new tab's page
 * (`_adjustFocusBeforeTabSwitch`, `_adjustFocusAfterTabSwitch`). The row
 * that held it belongs to the workspace being left, so the tree's one tab
 * stop has to move with the window, or Tab would find no way back into the
 * panel.
 */
add_task(async function the_panel_keeps_one_way_in_through_a_switch() {
  const reading = await workspaceWith("Reading", {
    pages: [page("One"), page("Two")],
  });
  const errands = await workspaceWith("Errands", {
    pages: [page("Elsewhere"), page("Further")],
  });

  await switchVia(window, reading.id);
  const left = reading.tabs[1];
  await clickRowShows(window, left, titledRed("Two"), "the second tab");
  // A press on a row puts the keyboard on it.
  EventUtils.synthesizeMouseAtCenter(rowIn(window, left), {});
  await TestUtils.waitForCondition(
    () => document.activeElement === rowIn(window, left),
    "the row pressed holds the keyboard"
  );

  await switchVia(window, errands.id);
  Assert.deepEqual(rowIdsIn(window), errands.tabs, "the other's rows show");
  Assert.equal(
    document.activeElement,
    gBrowser.selectedBrowser,
    "the keyboard is on the page the switch put on screen"
  );
  const onScreen = taggedId(gBrowser.selectedTab);
  Assert.ok(errands.tabs.includes(onScreen), "a tab of that workspace");
  const stop = rowIn(window, onScreen);
  Assert.deepEqual(
    tabStopsIn(stop.closest('[role="tree"]')),
    [stop],
    "and the tree's one tab stop is that tab's row"
  );

  // Where Tab lands when it comes back to the panel.
  stop.focus();
  EventUtils.synthesizeKey("KEY_ArrowDown");
  const next = document.activeElement;
  Assert.equal(
    next,
    rowIn(window, errands.tabs[1]),
    "from there the arrow keys move among that workspace's rows"
  );
  Assert.deepEqual(
    tabStopsIn(next.closest('[role="tree"]')),
    [next],
    "with one tab stop still"
  );
});

/**
 * A page of the workspace on screen gains a link to `target` that opens in a
 * new tab.
 *
 * @param {string} target
 */
function addLinkTo(target) {
  return SpecialPowers.spawn(gBrowser.selectedBrowser, [target], url => {
    const link = content.document.createElement("a");
    link.id = "new";
    link.href = url;
    link.target = "_blank";
    link.textContent = "new";
    link.style = "display:block;font-size:40px;color:white";
    content.document.body.prepend(link);
  });
}

/**
 * The window files a new tab under the workspace it shows, which a switch
 * changes. A tab filed under the workspace just left would have no row in
 * the panel on screen, and Sval has no other tab surface.
 */
add_task(async function tabs_opened_after_a_switch_are_filed_where_it_went() {
  const reading = await workspaceWith("Reading", { pages: [page("One")] });
  const errands = await workspaceWith("Errands", { pages: [page("Links")] });

  await switchVia(window, reading.id);
  await selectedShows(window, titledRed("One"), "the first workspace's page");
  await switchVia(window, errands.id);
  await selectedShows(window, titledRed("Links"), "the second's page");

  const target = titledRed("Linked");
  await addLinkTo(target);
  const linking = BrowserTestUtils.waitForNewTab(gBrowser, target, true);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#new",
    {},
    gBrowser.selectedBrowser
  );
  const linked = await nodeOfTab(
    await within(linking, 10_000, "the link's new tab")
  );

  const fresh = await nodeOfTab(await newTabCommand(window));

  await TestUtils.waitForCondition(
    () => rowIn(window, linked) && rowIn(window, fresh),
    "both tabs have rows in the workspace on screen"
  );
  Assert.deepEqual(
    rowIdsIn(window).toSorted(),
    [...errands.tabs, linked, fresh].toSorted(),
    "beside the tab it already had, and none of the other workspace's"
  );

  await switchVia(window, reading.id);
  Assert.deepEqual(
    rowIdsIn(window),
    reading.tabs,
    "the workspace that was left draws neither"
  );
  Assert.deepEqual(
    shownTabIdsIn(window),
    reading.tabs,
    "and has neither on show"
  );

  await switchVia(window, errands.id);
  Assert.ok(
    rowIn(window, linked) && rowIn(window, fresh),
    "and both are still where they were opened"
  );
});
