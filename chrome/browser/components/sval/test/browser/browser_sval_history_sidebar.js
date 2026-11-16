/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Firefox's History sidebar as Sval shows it (`SvalHistorySidebar.sys.mjs`):
 * opened by the header's history button, on the panel's other side, with no
 * switcher menu, site icons on site folders, visit times in every view,
 * and a way to clear history.
 */

ChromeUtils.defineESModuleGetters(this, {
  PlacesTestUtils: "resource://testing-common/PlacesTestUtils.sys.mjs",
});

const { CLEAR_BUTTON_ID, DATE_COLUMN_ID } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHistorySidebar.sys.mjs"
);
const { SvalHistorySync, CLEAR_SCOPE_ID } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs"
);

const SITE_PAGE = "https://example.com/history-a";

/**
 * Shows the History sidebar and waits for Sval's additions to it, and for it
 * to have slid in.
 */
async function showHistory() {
  await SidebarController.show("viewHistorySidebar");
  const doc = SidebarController.browser.contentDocument;
  const tree = doc.getElementById("historyTree");
  await TestUtils.waitForCondition(
    () =>
      tree._svalDecorated &&
      !document.getElementById("sidebar-box").hasAttribute("sval-overlay"),
    "sval dressed the sidebar"
  );
  return { doc, tree };
}

/** Hides the sidebar, which closes once it has slid out. */
async function hideHistory() {
  SidebarController.hide();
  await TestUtils.waitForCondition(
    () => !SidebarController.isOpen,
    "the sidebar closes"
  );
}

/**
 * @param {Document} doc The sidebar's document.
 * @param {string} id The view menu's item.
 */
async function viewBy(doc, id) {
  doc.getElementById(id).doCommand();
  await TestUtils.waitForTick();
}

add_setup(async function () {
  await PlacesUtils.history.clear();
  await PlacesTestUtils.addVisits({ uri: SITE_PAGE, title: "History A" });
  registerCleanupFunction(async () => {
    await hideHistory();
    await PlacesUtils.history.clear();
  });
});

/**
 * Whether a screen reader hears `node` as pressed.
 *
 * @param {Element} node
 * @returns {Promise<boolean>}
 */
async function heardPressed(node) {
  const acc = await accessibleOf(node);
  const state = {};
  acc.getState(state, {});
  return !!(state.value & Ci.nsIAccessibleStates.STATE_PRESSED);
}

add_task(async function the_history_button_toggles_the_sidebar() {
  const button = document.getElementById("sval-history-button");
  Assert.ok(!button.querySelector("menupopup"), "the button has no menu");
  Assert.ok(!(await heardPressed(button)), "it is heard as off");
  button.doCommand();
  await TestUtils.waitForCondition(
    () =>
      SidebarController.isOpen &&
      SidebarController.currentID === "viewHistorySidebar",
    "the History sidebar opens"
  );
  await TestUtils.waitForCondition(
    () => heardPressed(button),
    "and the button is heard as pressed"
  );
  button.doCommand();
  await TestUtils.waitForCondition(
    () => !SidebarController.isOpen,
    "and closes again"
  );
  await TestUtils.waitForCondition(
    async () => !(await heardPressed(button)),
    "and the button is heard as off again"
  );
});

/**
 * A slide that leaves the box where it already is starts no transition, as
 * a slide reversed before the window's next style flush does. It ends at
 * once, so a hide asked for then still hides.
 */
add_task(async function a_slide_to_where_the_box_is_ends_at_once() {
  const { slide } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalHeader.sys.mjs"
  );
  await showHistory();
  const box = document.getElementById("sidebar-box");
  const out = Promise.withResolvers();
  slide(box, false, out.resolve);
  await within(out.promise, 10_000, "the sidebar slides out");
  // Reversed and sent out again with no style flush between.
  box.removeAttribute("sval-collapsed");
  const again = Promise.withResolvers();
  slide(box, false, again.resolve);
  await within(again.promise, 10_000, "the second slide out ends");
  slide(box, true);
  await TestUtils.waitForCondition(
    () => !box.hasAttribute("sval-overlay"),
    "the sidebar slides back in"
  );
  await hideHistory();
});

add_task(async function the_sidebar_slides_in_and_out_as_the_panel_does() {
  const box = document.getElementById("sidebar-box");
  const shown = SidebarController.show("viewHistorySidebar");
  await TestUtils.waitForCondition(
    () => box.hasAttribute("sval-overlay"),
    "the sidebar starts out over the page"
  );
  await shown;
  await showHistory();
  SidebarController.hide();
  Assert.ok(SidebarController.isOpen, "a hide slides it out first");
  Assert.ok(box.hasAttribute("sval-collapsed"));
  await TestUtils.waitForCondition(
    () => !SidebarController.isOpen,
    "and closes once out"
  );
  Assert.ok(
    !box.hasAttribute("sval-overlay") && !box.hasAttribute("sval-collapsed"),
    "leaving nothing for the next showing"
  );
});

add_task(async function a_press_mid_slide_reverses_it() {
  const box = document.getElementById("sidebar-box");
  const button = document.getElementById("sval-history-button");
  await showHistory();
  button.doCommand();
  Assert.ok(box.hasAttribute("sval-collapsed"), "the slide out starts");
  // The box goes back into the layout once it has stopped moving, or a
  // click aimed at where it rests misses it.
  let settledMoving = null;
  const watch = new MutationObserver(() => {
    if (!box.hasAttribute("sval-overlay") && settledMoving === null) {
      settledMoving = box
        .getAnimations()
        .some(a => a.transitionProperty === "transform");
    }
  });
  watch.observe(box, { attributeFilter: ["sval-overlay"] });
  atTaskEnd(() => watch.disconnect());
  button.doCommand();
  Assert.ok(!box.hasAttribute("sval-collapsed"), "a second press reverses it");
  await TestUtils.waitForCondition(
    () => !box.hasAttribute("sval-overlay"),
    "it slides back in"
  );
  Assert.strictEqual(
    settledMoving,
    false,
    "and back into the layout only once it has stopped"
  );
  Assert.ok(SidebarController.isOpen, "and stays open");
  await hideHistory();
});

add_task(async function the_header_names_the_sidebar_and_offers_no_menu() {
  await showHistory();
  Assert.ok(
    document.getElementById("sidebar-switcher-target").hidden,
    "the switcher button is hidden"
  );
  const title = document.getElementById("sidebar-title");
  Assert.ok(title.checkVisibility(), "the title shows");
  Assert.ok(
    !document.getElementById("sidebar-icon").checkVisibility(),
    "and no icon, which Firefox draws only inside the switcher"
  );
  Assert.equal(title.value, SidebarController.title);
  Assert.ok(
    document.getElementById("sidebar-close").checkVisibility(),
    "and the close button"
  );
  await hideHistory();
});

add_task(async function the_sidebar_opens_opposite_the_panel() {
  const settings = SvalPanel.settings;
  const original = settings.placement;
  const content = document.getElementById("tabbrowser-tabbox");
  const box = document.getElementById("sidebar-box");
  const panel = document.getElementById("sval-panel-container");
  await showHistory();
  for (const side of ["left", "right"]) {
    settings.placement = side;
    SvalPanel._applyPlacement();
    await TestUtils.waitForTick();
    const sidebarLeft = box.getBoundingClientRect().left;
    const panelLeft = panel.getBoundingClientRect().left;
    const contentLeft = content.getBoundingClientRect().left;
    if (side === "left") {
      Assert.less(panelLeft, contentLeft, "the panel is left");
      Assert.greater(sidebarLeft, contentLeft, "the sidebar is right");
    } else {
      Assert.greater(panelLeft, contentLeft, "the panel is right");
      Assert.less(sidebarLeft, contentLeft, "the sidebar is left");
    }
  }
  settings.placement = original;
  SvalPanel._applyPlacement();
  await hideHistory();
});

add_task(async function a_site_folder_shows_its_sites_icon() {
  const { doc, tree } = await showHistory();
  await viewBy(doc, "bysite");
  const row = await TestUtils.waitForCondition(() => {
    for (let i = 0; i < (tree.view?.rowCount ?? 0); i++) {
      if (PlacesUtils.nodeIsHost(tree.view.nodeForTreeIndex(i))) {
        return { index: i };
      }
    }
    return null;
  }, "a site folder is listed");
  // The icon is asked of Places off the main thread, and drawn once it
  // arrives.
  const title = tree.columns.getNamedColumn("title");
  await TestUtils.waitForCondition(
    () => tree.view.getImageSrc(row.index, title) === `page-icon:${SITE_PAGE}`,
    "the folder shows its page's icon"
  );
  await hideHistory();
});

add_task(async function every_view_shows_when_each_page_was_visited() {
  const { doc, tree } = await showHistory();
  const date = doc.getElementById(DATE_COLUMN_ID);
  const column = () => tree.columns.getNamedColumn(DATE_COLUMN_ID);
  /** The row of `SITE_PAGE`, opening the folders on the way to it. */
  const pageRow = () =>
    TestUtils.waitForCondition(() => {
      for (let i = 0; i < (tree.view?.rowCount ?? 0); i++) {
        if (tree.view.nodeForTreeIndex(i).uri === SITE_PAGE) {
          return { index: i };
        }
        if (tree.view.isContainer(i) && !tree.view.isContainerOpen(i)) {
          tree.view.toggleOpenState(i);
        }
      }
      return null;
    }, "the page is listed");
  for (const view of [
    "bydayandsite",
    "bysite",
    "byday",
    "byvisited",
    "bylastvisited",
  ]) {
    await viewBy(doc, view);
    Assert.ok(!date.hidden, `${view} has the date column`);
    const { index } = await pageRow();
    Assert.notEqual(
      tree.view.getCellText(index, column()),
      "",
      `${view} says when the page was visited`
    );
  }
  await viewBy(doc, "bysite");
  const search = doc.getElementById("search-box");
  search.value = "History";
  search.dispatchEvent(new CustomEvent("MozInputSearch:search"));
  const { index } = await pageRow();
  Assert.ok(!date.hidden, "a search has the date column");
  Assert.notEqual(tree.view.getCellText(index, column()), "", "and says when");
  search.value = "";
  search.dispatchEvent(new CustomEvent("MozInputSearch:search"));
  await viewBy(doc, "byday");
  await hideHistory();
});

/**
 * A screen reader that reads the list as the sidebar loads, before Sval adds
 * its columns, still hears it as a table once they are there, cell by cell
 * under each shown column, in either view.
 */
add_task(async function the_list_read_as_it_loads_is_heard_as_a_table() {
  const service = Cc["@mozilla.org/accessibilityService;1"].getService(
    Ci.nsIAccessibilityService
  );
  if (SidebarController.isOpen) {
    await hideHistory();
  }
  let readEarly = false;
  const onLoad = event => {
    const early = event.target.getElementById?.("historyTree");
    if (early && !early._svalDecorated) {
      // A screen reader reads the page as soon as Gecko has built its
      // accessible tree, which it does on a refresh tick after the load.
      // Two forced ticks build it before SidebarShown decorates the list,
      // as AccessibilityUtils' forceRefreshDriverTick does. They advance no
      // time, so the sidebar's slide keeps its own clock.
      // eslint-disable-next-line sval/accessible-read
      service.getAccessibleFor(event.target);
      const utils = event.target.defaultView.windowUtils;
      utils.advanceTimeAndRefresh(0);
      utils.advanceTimeAndRefresh(0);
      utils.restoreNormalRefresh();
      // eslint-disable-next-line sval/accessible-read
      readEarly = !!service.getAccessibleFor(early);
    }
  };
  SidebarController.browser.addEventListener("load", onLoad, true);
  atTaskEnd(() =>
    SidebarController.browser.removeEventListener("load", onLoad, true)
  );
  const { doc, tree } = await showHistory();
  Assert.ok(readEarly, "the list was read before Sval's columns");

  const heardAs = async (view, columns) => {
    await viewBy(doc, view);
    const row = await TestUtils.waitForCondition(() => {
      for (let i = 0; i < (tree.view?.rowCount ?? 0); i++) {
        if (tree.view.nodeForTreeIndex(i).uri === SITE_PAGE) {
          return { index: i };
        }
        if (tree.view.isContainer(i) && !tree.view.isContainerOpen(i)) {
          tree.view.toggleOpenState(i);
        }
      }
      return null;
    }, `the ${view} view lists the page`);
    const acc = await TestUtils.waitForCondition(() => {
      const found = service.getAccessibleFor(tree);
      return found instanceof Ci.nsIAccessibleTable && found;
    }, `the ${view} view is heard as a table`);
    Assert.equal(service.getStringRole(acc.role), "tree table", view);
    const table = acc.QueryInterface(Ci.nsIAccessibleTable);
    Assert.deepEqual(
      Array.from({ length: table.columnCount }, (_, i) =>
        table.getColumnDescription(i)
      ),
      columns,
      `under the ${view} view's columns`
    );
    columns.forEach((name, i) =>
      Assert.equal(
        table.getCellAt(row.index, i).name,
        tree.view.getCellText(
          row.index,
          tree.columns.getNamedColumn(
            { Page: "title", Visited: DATE_COLUMN_ID }[name]
          )
        ),
        `with the row's ${name} a cell under it`
      )
    );
  };
  await heardAs("bylastvisited", ["Page", "Visited"]);
  await heardAs("byday", ["Page", "Visited"]);
  await heardAs("bylastvisited", ["Page", "Visited"]);
  await viewBy(doc, "byday");
  await hideHistory();
});

add_task(async function clear_recent_history_is_below_the_list() {
  const { doc } = await showHistory();
  const { Sanitizer } = ChromeUtils.importESModule(
    "resource:///modules/Sanitizer.sys.mjs"
  );
  const showUI = Sanitizer.showUI;
  let shown = 0;
  Sanitizer.showUI = () => shown++;
  try {
    const clear = doc.getElementById(CLEAR_BUTTON_ID);
    Assert.ok(clear.getAttribute("label"), "the button is labelled");
    clear.doCommand();
    Assert.equal(shown, 1, "it opens Firefox's Clear Recent History");
  } finally {
    Sanitizer.showUI = showUI;
  }
  await hideHistory();
});

add_task(async function clearing_history_asks_whose_history() {
  const { Sanitizer } = ChromeUtils.importESModule(
    "resource:///modules/Sanitizer.sys.mjs"
  );
  SvalHistorySync.watchClears();
  // Opening the dialog brings Firefox's clearing prefs forward to its
  // current set (`Sanitizer.maybeMigratePrefs`).
  keepPrefs("privacy.clearHistory.", "privacy.sanitize.", "privacy.cpd.");
  const opened = BrowserTestUtils.promiseAlertDialogOpen(
    null,
    "chrome://browser/content/sanitize_v2.xhtml",
    { isSubDialog: true }
  );
  Sanitizer.showUI(window, "browser");
  const dialog = await within(opened, 10_000, "Clear Recent History opens");
  const doc = dialog.document;
  const group = doc.getElementById(CLEAR_SCOPE_ID);
  Assert.ok(group, "it asks whose history");
  Assert.deepEqual(
    [...group.querySelectorAll("radio")].map(r => r.value),
    ["device", "all"]
  );
  Assert.equal(group.value, "device", "this device's is the default");
  const history = doc.getElementById("browsingHistoryAndDownloads");
  // The choice follows the checkbox as it is observed to change.
  const toggle = async () => {
    history.checked = !history.checked;
    await TestUtils.waitForTick();
  };
  if (!history.checked) {
    await toggle();
  }
  Assert.ok(!group.disabled, "the choice is open while history is cleared");
  await toggle();
  Assert.ok(group.disabled, "and closed while it is not");
  await toggle();
  group.value = "all";
  doc.querySelector("dialog").cancelDialog();
  Assert.equal(
    SvalHistorySync.nextClearScope,
    "device",
    "a cancelled dialog leaves the next clear to this device"
  );
});

/**
 * A page leaving the list while a screen reader is reading it is heard
 * going: its row's accessible is hidden once the view has dropped the row.
 */
add_task(async function a_page_removed_under_a_screen_reader_is_heard_going() {
  const gone = "https://example.com/history-gone";
  // The oldest visit, so the last row: the one past the list once it goes.
  await PlacesTestUtils.addVisits({
    uri: gone,
    title: "History gone",
    visitDate: (Date.now() - 86400 * 1000) * 1000,
  });
  const { doc, tree } = await showHistory();
  await viewBy(doc, "bylastvisited");
  await TestUtils.waitForCondition(
    () => tree.view?.rowCount === 2,
    "both pages are listed"
  );
  const table = await accessibleOf(tree);
  const last = await TestUtils.waitForCondition(
    () => table.getChildAt(table.childCount - 1),
    "its rows are"
  );
  Assert.ok(last.name.includes("History gone"), "the last row is the page");

  // The view's row count drops at once, and the hide comes on a later turn:
  // `nsTreeBodyFrame::FireRowCountChangedEvent` posts the event from which
  // `RootAccessible::HandleTreeRowCountChangedEvent` has
  // `XULTreeAccessible::InvalidateCache` fire it. A check of the count can
  // pass before the hide, so the wait is for the hide.
  const heard = Promise.withResolvers();
  const listen = subject => {
    const event = subject.QueryInterface(Ci.nsIAccessibleEvent);
    if (
      event.eventType === Ci.nsIAccessibleEvent.EVENT_HIDE &&
      event.accessible === last
    ) {
      heard.resolve(tree.view.rowCount);
    }
  };
  Services.obs.addObserver(listen, "accessible-event");
  atTaskEnd(() => Services.obs.removeObserver(listen, "accessible-event"));
  await PlacesUtils.history.remove(gone);
  const rows = await within(heard.promise, 10_000, "its row is heard going");
  Assert.equal(rows, 1, "once the page has left the list");
  await viewBy(doc, "byday");
  await hideHistory();
});
