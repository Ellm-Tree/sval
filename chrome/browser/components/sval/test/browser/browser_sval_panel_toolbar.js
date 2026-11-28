/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * The toolbar in the Workspace panel: the header's widgets placed in the
 * panel's toolbar areas (`SvalHeader.arrange`, `SvalPanelToolbar`), in every
 * kind of window, the address floating the Launcher, and a prompt sliding
 * the hidden panel in.
 */

const { IN_PANEL_ATTR, OVERFLOW_LIST_ID, SvalPanelToolbar } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalPanelToolbar.sys.mjs"
  );
const {
  EXTENSIONS_BUTTON_ID,
  HEADER_WIDGETS,
  IN_PANEL_PREF,
  PANEL_TOOLBAR_ID,
  PRIVATE_BADGE_ID,
  RECORD_WIDGETS,
  RECORDS_AREA,
  SET_AREAS,
  SET_OVERFLOW,
  SET_WIDGETS,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalHeader.sys.mjs"
);
const { FLOATING, SvalLauncher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLauncher.sys.mjs"
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);

add_setup(() => failOnConsoleErrors());

const RECORDS = RECORD_WIDGETS.filter(id => id !== PRIVATE_BADGE_ID);
const IN_THE_PANEL = [
  ...HEADER_WIDGETS,
  EXTENSIONS_BUTTON_ID,
  PRIVATE_BADGE_ID,
];

/** @param {Document} [doc] */
const container = (doc = document) =>
  doc.getElementById("sval-panel-container");

/**
 * Whether every widget stands where the setting puts it.
 *
 * @param {boolean} inPanel
 * @returns {boolean}
 */
function arranged(inPanel) {
  const area = id => CustomizableUI.getPlacementOfWidget(id)?.area;
  return inPanel
    ? Object.entries(SET_WIDGETS).every(([set, ids]) =>
        ids.every(id => area(id) === SET_AREAS[set])
      )
    : [...IN_THE_PANEL, ...RECORDS].every(
        id => area(id) === CustomizableUI.AREA_NAVBAR
      );
}

/**
 * Sets the toolbar's place until the task ends, and waits for the widgets
 * to stand there.
 *
 * @param {boolean} inPanel
 */
async function toolbarInPanel(inPanel = true) {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  // Firefox marks Home as taken out of `#nav-bar` once it moves
  // (`BrowserUsageTelemetry`), which the file puts back.
  await SpecialPowers.pushPrefEnv({
    set: [
      [IN_PANEL_PREF, inPanel],
      ["browser.engagement.home-button.has-removed", false],
    ],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  await TestUtils.waitForCondition(
    () => arranged(inPanel),
    "the header's widgets taking their places"
  );
}

/**
 * Asserts that each set stands once in `doc`, where `doc`'s kind of window
 * hosts it, with the widgets the setting puts there.
 *
 * @param {Document} doc
 * @param {boolean} hasPanel
 */
function assertHosted(doc, hasPanel) {
  for (const id of [PANEL_TOOLBAR_ID, ...Object.values(SET_AREAS)]) {
    Assert.equal(doc.querySelectorAll(`#${id}`).length, 1, `one ${id}`);
  }
  const toolbar = doc.getElementById(PANEL_TOOLBAR_ID);
  const records = doc.getElementById(RECORDS_AREA);
  if (hasPanel) {
    Assert.equal(
      container(doc).firstElementChild,
      toolbar,
      "the toolbar stands at the panel's top"
    );
    Assert.ok(
      records.closest(".sval-panel-footer"),
      "the records stand in the panel's footer"
    );
  } else {
    Assert.ok(
      doc.getElementById("navigator-toolbox").contains(toolbar),
      "the toolbar stands in the header row"
    );
  }
  Assert.ok(
    toolbar.contains(doc.getElementById("urlbar-container")),
    "the address is in the toolbar"
  );
  for (const id of RECORDS) {
    Assert.ok(records.contains(doc.getElementById(id)), `${id} is a record`);
  }
  Assert.ok(
    doc.getElementById("nav-bar"),
    "Firefox's toolbar stays in the window"
  );
}

add_task(
  async function the_setting_moves_the_widgets_into_the_panel_and_back() {
    await toolbarInPanel(true);
    Assert.ok(
      document.documentElement.hasAttribute(IN_PANEL_ATTR),
      "the window is marked for the layout"
    );
    assertHosted(document, true);
    Assert.ok(
      gURLBar.checkVisibility(),
      "the address shows at the panel's top"
    );

    await toolbarInPanel(false);
    Assert.ok(
      !document.documentElement.hasAttribute(IN_PANEL_ATTR),
      "the window's mark goes"
    );
    const target = document.getElementById("nav-bar-customization-target");
    for (const id of [...HEADER_WIDGETS, ...RECORDS]) {
      Assert.equal(
        document.getElementById(id)?.parentNode,
        target,
        `${id} goes back to the header`
      );
    }
    Assert.ok(gURLBar.checkVisibility(), "the address shows above the page");
  }
);

add_task(async function a_window_opened_with_the_setting_on_has_its_toolbar() {
  await toolbarInPanel(true);
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    10_000,
    "a new window"
  );
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 10_000, "the new window closing")
  );
  await within(win.SvalPanel.started, 10_000, "the new window's panel");
  // The window builds each record's button in its set after the panel starts.
  const doc = win.document;
  await within(
    TestUtils.waitForCondition(() =>
      RECORDS.every(id =>
        doc.getElementById(RECORDS_AREA).contains(doc.getElementById(id))
      )
    ),
    10_000,
    "the new window's records"
  );
  assertHosted(doc, true);
  Assert.ok(
    win.document.getElementById("urlbar").checkVisibility(),
    "and the address shows"
  );
});

add_task(async function a_popup_keeps_its_address_in_its_header() {
  await toolbarInPanel(true);
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"),
    10_000,
    "a page"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(tab));
  const opened = BrowserTestUtils.waitForNewWindow();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.window.open("about:blank", "", "popup,width=400,height=300");
  });
  const popup = await within(opened, 10_000, "a page's popup");
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(popup), 10_000, "the popup closing")
  );
  assertHosted(popup.document, false);
});

/**
 * Asserts that each shown button of the header's pills holds its icon's
 * round wash as far from each outlined end as from the outline's top, in
 * whichever row the setting puts it.
 *
 * @param {boolean} inPanel
 */
function assertWashesConcentric(inPanel) {
  const ids = [
    "sval-panel-button",
    EXTENSIONS_BUTTON_ID,
    "sval-notices-button",
    "downloads-button",
    "sval-history-button",
    "back-button",
    "forward-button",
    "reload-button",
  ];
  let checked = 0;
  for (const id of ids) {
    const button = document.getElementById(id);
    if (!button?.checkVisibility()) {
      continue;
    }
    const wash = button
      .querySelector(
        ":scope > :is(.toolbarbutton-icon, .toolbarbutton-badge-stack)"
      )
      .getBoundingClientRect();
    // Reload stands in a toolbar item, which carries the pill's outline.
    const outlined = id === "reload-button" ? button.parentNode : button;
    const box = outlined.getBoundingClientRect();
    const style = getComputedStyle(outlined);
    const top = wash.top - box.top;
    Assert.equal(box.bottom - wash.bottom, top, `${id}: bottom as top`);
    if (parseFloat(style.borderLeftWidth)) {
      Assert.equal(wash.left - box.left, top, `${id}: left end as top`);
    }
    if (parseFloat(style.borderRightWidth)) {
      Assert.equal(box.right - wash.right, top, `${id}: right end as top`);
    }
    // A shadow's vertical offset, the second length of each shadow, would
    // shade one border and not the other.
    for (const shadow of style.boxShadow.split(/,(?![^(]*\))/)) {
      const lengths = shadow.match(/-?[\d.]+px/g) ?? [];
      Assert.equal(
        parseFloat(lengths[1] ?? "0"),
        0,
        `${id}: no shadow on one side`
      );
    }
    checked++;
  }
  Assert.greaterOrEqual(checked, 3, `pills measured, in panel: ${inPanel}`);
}

add_task(async function a_pills_icon_washes_sit_in_its_ends() {
  for (const inPanel of [false, true]) {
    await toolbarInPanel(inPanel);
    assertWashesConcentric(inPanel);
  }
});

add_task(async function the_site_controls_row_matches_the_rows_pills() {
  await toolbarInPanel(true);
  const tab = await openPage("https://example.com/");
  atTaskEnd(() => BrowserTestUtils.removeTab(tab));
  const menu = document.getElementById("sval-site-menu-button");
  await TestUtils.waitForCondition(
    () => menu.checkVisibility(),
    "the site's controls showing"
  );
  const extensions = document.getElementById(EXTENSIONS_BUTTON_ID);
  Assert.equal(
    menu.getBoundingClientRect().height,
    extensions.getBoundingClientRect().height,
    "the site controls' pill is as tall as the extensions'"
  );
  const wash = menu
    .querySelector(".toolbarbutton-icon")
    .getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  const top = wash.top - box.top;
  Assert.equal(box.bottom - wash.bottom, top, "its wash is centred");
  Assert.equal(box.right - wash.right, top, "and as far from the pill's end");
});

add_task(async function the_site_controls_leave_out_of_sight() {
  await toolbarInPanel(true);
  const tab = await openPage("https://example.com/");
  atTaskEnd(() => BrowserTestUtils.removeTab(tab));
  SvalPanel._setPanelWidth(48);
  atTaskEnd(() => SvalPanel._setPanelWidth(null));
  const hidden = document.getElementById(`${SET_AREAS.site}-hidden`);
  const leaving = SET_OVERFLOW.site.leave.filter(id =>
    document.getElementById(id)
  );
  Assert.greater(leaving.length, 0, "the site set has controls that leave");
  await within(
    TestUtils.waitForCondition(
      () => leaving.every(id => hidden.contains(document.getElementById(id))),
      "the site's controls leaving in the column"
    ),
    10_000,
    "the site's controls leaving"
  );
  const overflowList = document.getElementById(OVERFLOW_LIST_ID);
  for (const id of leaving) {
    Assert.ok(
      !overflowList.contains(document.getElementById(id)),
      `${id} stays out of »`
    );
  }
  SvalPanel._setPanelWidth(null);
  await within(
    TestUtils.waitForCondition(
      () => leaving.every(id => !hidden.contains(document.getElementById(id))),
      "the site's controls coming back"
    ),
    10_000,
    "the site's controls coming back"
  );
});

add_task(async function the_floating_launchers_address_clears_the_pills_end() {
  await moveWindowOnScreen();
  const tab = await openPage("https://example.com/");
  atTaskEnd(() => BrowserTestUtils.removeTab(tab));
  for (const inPanel of [false, true]) {
    await toolbarInPanel(inPanel);
    // A moved field breaks out of its row again a frame later
    // (`UrlbarInput.#updateLayoutBreakoutDimensions`), and only then floats.
    await TestUtils.waitForCondition(
      () => gURLBar.hasAttribute("breakout"),
      "the field breaking out of its row"
    );
    const shown = UrlbarTestUtils.promisePopupOpen(window, () =>
      document.getElementById("Browser:OpenLocation").doCommand()
    );
    await within(shown, 10_000, "the Launcher's list");
    await TestUtils.waitForCondition(
      () => gURLBar.hasAttribute(FLOATING),
      "the Launcher floating over the page"
    );
    const pill = document.getElementById("urlbar-container");
    const address = document.getElementById("sval-launcher-address");
    Assert.ok(address.checkVisibility(), "the pill keeps the address");
    const pillStart =
      pill.getBoundingClientRect().left +
      parseFloat(getComputedStyle(pill, "::before").insetInlineStart);
    const radius = pill.getBoundingClientRect().height / 2;
    Assert.greaterOrEqual(
      address.getBoundingClientRect().left - pillStart,
      radius,
      `the address clears the pill's rounded start, in panel: ${inPanel}`
    );
    EventUtils.synthesizeKey("KEY_Escape");
    await TestUtils.waitForCondition(
      () => !gURLBar.hasAttribute(FLOATING),
      "Escape returning the address bar"
    );
  }
});

add_task(async function a_peek_keeps_its_address_and_its_own_parts() {
  await toolbarInPanel(true);
  const url = "https://example.com/browser/?panel-toolbar-peek";
  const opened = BrowserTestUtils.waitForNewWindow({ url });
  runCommandLine(["-url", url]);
  const peek = await within(opened, 20_000, "the Peek");
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(peek), 10_000, "the Peek closing")
  );
  const doc = peek.document;
  assertHosted(doc, false);
  Assert.ok(
    doc.getElementById("urlbar").checkVisibility(),
    "the Peek's address shows"
  );
  const target = doc.getElementById("urlbar-container").parentNode;
  Assert.equal(
    doc.getElementById("sval-peek-tag").nextElementSibling,
    target,
    "the Peek's tag stands before the address's row"
  );
  Assert.equal(
    doc.getElementById("sval-peek-open").previousElementSibling,
    target,
    "and its open button after it"
  );
  // With no panel, the sets are the header row: one line, side by side.
  const sets = [...doc.querySelectorAll("#sval-toolbar-host .sval-set")].filter(
    set => set.checkVisibility()
  );
  Assert.greater(sets.length, 1, "the Peek shows several sets");
  const middle = el => {
    const { top, bottom } = el.getBoundingClientRect();
    return (top + bottom) / 2;
  };
  for (const set of sets) {
    Assert.less(
      Math.abs(middle(set) - middle(sets[0])),
      1,
      `${set.id} stands in the header row`
    );
  }
});

add_task(async function a_click_on_the_address_floats_the_launcher() {
  await toolbarInPanel(true);
  atTaskEnd(() => SvalLauncher.close(window));
  // A moved field breaks out of its row again a frame later
  // (`UrlbarInput.#updateLayoutBreakoutDimensions`), and only then floats.
  await TestUtils.waitForCondition(
    () => gURLBar.hasAttribute("breakout"),
    "the field breaking out of its row"
  );
  // The press floats the field away before the release, so the click lands
  // on the container it leaves, which has no accessible of its own.
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  atTaskEnd(() => AccessibilityUtils.resetEnv());
  EventUtils.synthesizeMouseAtCenter(gURLBar.inputField, {});
  await TestUtils.waitForCondition(
    () => gURLBar.hasAttribute(FLOATING),
    "the Launcher floating over the page"
  );
  // The Launcher opens on a query, whose results open its view; the task's
  // end moves the field back, which has no box to place the view by.
  await within(
    gURLBar.lastQueryContextPromise,
    10_000,
    "the Launcher's first results"
  );
});

add_task(async function a_prompt_slides_the_hidden_panel_in() {
  await toolbarInPanel(true);
  for (const see of [false, true]) {
    const kind = see ? "see-through" : "solid";
    await windowSeeThrough(see);
    SvalPanel.toggleVisible();
    atTaskEnd(() => {
      if (container().hasAttribute("sval-collapsed")) {
        SvalPanel.toggleVisible();
      }
    });
    await TestUtils.waitForCondition(
      () => container().hasAttribute("sval-collapsed"),
      "the panel hiding"
    );
    SvalPanelToolbar.beforePrompt(window);
    Assert.equal(
      container().getAttribute("sval-reveal"),
      "shown",
      `${kind}: the panel is in, so the prompt has its button to drop from`
    );
    Assert.ok(
      document
        .getElementById(PANEL_TOOLBAR_ID)
        .checkVisibility({ visibilityProperty: true }),
      `${kind}: and the toolbar shows`
    );
    Assert.ok(
      container().hasAttribute("sval-overlay"),
      `${kind}: the panel is lifted over the page`
    );
    const fill = getComputedStyle(container()).backgroundColor;
    Assert.equal(
      fill,
      getComputedStyle(container().querySelector(".sval-panel"))
        .backgroundColor,
      `${kind}: the toolbar stands on the panel's own fill`
    );
    // A see-through panel is clear, and the page is cut where it stands
    // (`sval-header.css`, panel reveal), so the window shows through it.
    const panels = document.getElementById("tabbrowser-tabpanels");
    if (see) {
      Assert.notEqual(
        getComputedStyle(panels).maskImage,
        "none",
        `${kind}: the page is cut under the panel`
      );
    } else {
      Assert.greater(
        InspectorUtils.colorToRGBA(fill).a,
        0,
        `${kind}: the fill hides the page under it`
      );
    }
    SvalPanel.toggleVisible();
    await TestUtils.waitForCondition(
      () => !container().hasAttribute("sval-collapsed"),
      "the panel showing"
    );
  }
});

/**
 * The window's buttons and the panel's toggle: their boxes, from the panel's
 * toolbar or from the hidden panel's corner.
 *
 * @param {Element} root
 * @param {Element} toggle
 */
function windowRowBoxes(root, toggle) {
  const lights = root
    .querySelector(".titlebar-buttonbox-container")
    .getBoundingClientRect();
  const icon = toggle.querySelector(".toolbarbutton-icon");
  return {
    lights,
    lightsMiddle: lights.top + lights.height / 2,
    toggle: icon.getBoundingClientRect(),
  };
}

/** @param {boolean} hidden */
async function panelHidden(hidden) {
  await TestUtils.waitForCondition(
    () => container().hasAttribute("sval-collapsed") === hidden,
    `the panel ${hidden ? "hiding" : "showing"}`
  );
  // A hidden panel stays lifted over the page.
  if (!hidden) {
    await TestUtils.waitForCondition(
      () => !container().hasAttribute("sval-overlay"),
      "the panel's slide ending"
    );
  }
}

add_task(
  async function the_hidden_panels_corner_keeps_the_window_row_in_place() {
    await toolbarInPanel(true);
    // The row moved off its own place, with its buttons further from the
    // toggle: the corner follows the row as drawn.
    const row = document.getElementById(SET_AREAS.window);
    const buttons = row.querySelector(".titlebar-buttonbox-container");
    row.style.paddingInlineStart = "19px";
    buttons.style.marginInlineEnd = "23px";
    atTaskEnd(() => {
      row.style.removeProperty("padding-inline-start");
      buttons.style.removeProperty("margin-inline-end");
      if (container().hasAttribute("sval-collapsed")) {
        SvalPanel.toggleVisible();
      }
    });
    const shown = windowRowBoxes(
      row,
      document.getElementById("sval-panel-button")
    );
    SvalPanel.toggleVisible();
    await panelHidden(true);
    const corner = document.getElementById("sval-panel-corner");
    Assert.ok(corner.checkVisibility(), "the corner stands in for the panel");
    const toggle = document.getElementById("sval-panel-corner-button");
    const hidden = windowRowBoxes(corner, toggle);
    // Where the window's buttons end the row, the corner keeps them beside
    // the toggle.
    if (shown.lights.width && shown.lights.right <= shown.toggle.left) {
      Assert.equal(
        hidden.lights.left,
        shown.lights.left,
        "the window's buttons start where they did"
      );
      Assert.equal(
        hidden.lightsMiddle,
        shown.lightsMiddle,
        "at the height they stood"
      );
    }
    for (const side of ["left", "top", "width", "height"]) {
      Assert.equal(
        hidden.toggle[side],
        shown.toggle[side],
        `the toggle's circle keeps its ${side}`
      );
    }

    toggle.doCommand();
    await panelHidden(false);
    Assert.ok(!corner.checkVisibility(), "the corner goes with the panel back");
  }
);

add_task(async function the_panels_toggle_keeps_the_keyboard_as_it_hides() {
  await toolbarInPanel(true);
  atTaskEnd(() => {
    if (container().hasAttribute("sval-collapsed")) {
      SvalPanel.toggleVisible();
    }
  });
  const toolbar = document.getElementById(SET_AREAS.window);
  Assert.equal(
    toolbar.getAttribute("keyNav"),
    "true",
    "the panel's toolbar is in the toolbar keyboard navigation"
  );
  const panelToggle = document.getElementById("sval-panel-button");
  toolbar.querySelector(":scope > toolbartabstop").focus();
  Assert.equal(
    document.activeElement,
    panelToggle,
    "its tab stop takes the keyboard to the toggle"
  );

  EventUtils.synthesizeKey(" ");
  await panelHidden(true);
  const cornerToggle = document.getElementById("sval-panel-corner-button");
  Assert.equal(
    document.activeElement,
    cornerToggle,
    "the corner's toggle takes the keyboard as the panel hides"
  );
  Assert.equal(
    cornerToggle.getAttribute("aria-pressed"),
    "false",
    "and says the panel is hidden"
  );
  Assert.equal(
    document.getElementById("sval-panel-corner").getAttribute("keyNav"),
    "true",
    "the corner is in the toolbar keyboard navigation too"
  );

  EventUtils.synthesizeKey(" ");
  await panelHidden(false);
  Assert.equal(
    document.activeElement,
    panelToggle,
    "the panel's toggle takes it back as the panel shows"
  );
  Assert.equal(
    panelToggle.getAttribute("aria-pressed"),
    "true",
    "and says the panel shows"
  );
});

add_task(async function the_page_keeps_its_gap_below_the_windows_top() {
  for (const inPanel of [false, true]) {
    await toolbarInPanel(inPanel);
    const panels = document.getElementById("tabbrowser-tabpanels");
    const page = panels.querySelector(
      ":scope > .browserSidebarContainer.deck-selected"
    );
    const side = page.getBoundingClientRect().right;
    const gap =
      page.getBoundingClientRect().top - panels.getBoundingClientRect().top;
    Assert.equal(
      gap,
      inPanel ? panels.getBoundingClientRect().right - side : 0,
      `the page's top gap, in panel: ${inPanel}`
    );
  }
});

add_task(async function the_extensions_button_opens_its_menu_from_the_panel() {
  await toolbarInPanel(true);
  const panel = gUnifiedExtensions.panel;
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  EventUtils.synthesizeMouseAtCenter(
    document.getElementById("unified-extensions-button"),
    {}
  );
  await within(shown, 10_000, "the extensions menu");
  atTaskEnd(async () => {
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    panel.hidePopup();
    await within(hidden, 10_000, "the extensions menu closing");
  });
  Assert.ok(
    document
      .getElementById("unified-extensions-view")
      .querySelector("unified-extensions-item"),
    "it lists the extensions"
  );
});

add_task(async function downloads_open_upward_from_the_footer() {
  await toolbarInPanel(true);
  await moveWindowOnScreen();
  const button = document.getElementById("downloads-button");
  const panel = document.getElementById("downloadsPanel");
  const shown = BrowserTestUtils.waitForPopupEvent(panel, "shown");
  EventUtils.synthesizeMouseAtCenter(button, {});
  await within(shown, 10_000, "the Downloads panel");
  atTaskEnd(async () => {
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    panel.hidePopup();
    await within(hidden, 10_000, "the Downloads panel closing");
  });
  await TestUtils.waitForCondition(
    () =>
      panel.getAttribute("sval-stem") === "placed" &&
      !panel.hasAttribute("sval-stem-pending"),
    "its stem placed, and it shown"
  );
  Assert.equal(
    panel.getAttribute("sval-stem-side"),
    "top",
    "it grows from the button's top, where the window has room"
  );
  // A popup's frame is laid out against the window's root
  // (`nsMenuPopupFrame::PerformMove`), so its rects are the window's.
  const content = panel.shadowRoot
    .querySelector('[part~="content"]')
    .getBoundingClientRect();
  Assert.lessOrEqual(
    content.bottom,
    button.getBoundingClientRect().top + 1,
    "its content stands above the button"
  );
  Assert.greater(content.height, 60, "with room for its rows");
});

/**
 * Opens a popover from its button and records, at each paint until its stem
 * is placed, where its window stands while it can be seen.
 *
 * @param {string} buttonId
 * @param {function(): Element} popoverOf
 * @returns {Promise<{seen: {left: number, top: number}[], rest: {left:
 *   number, top: number}}>} The seen places, and where it stands once placed.
 */
async function seenPlaces(buttonId, popoverOf) {
  const seen = [];
  // Each paint of the window, the popover's among them: where it can be
  // seen then is where it was seen.
  const record = () => {
    const popover = popoverOf();
    if (popover && popover.state !== "closed") {
      if (window.getComputedStyle(popover).opacity !== "0") {
        const { left, top } = popover.getOuterScreenRect();
        seen.push({ left, top });
      }
    }
  };
  window.addEventListener("MozAfterPaint", record);
  const shown = BrowserTestUtils.waitForEvent(
    window,
    "popupshown",
    false,
    e => e.target === popoverOf()
  );
  EventUtils.synthesizeMouseAtCenter(document.getElementById(buttonId), {});
  await within(shown, 10_000, `${buttonId}'s popover`);
  const popover = popoverOf();
  // A stem is placed against the popover's last move (`SvalStem`), so a
  // placed stem with no move pending marks where the popover rests.
  try {
    await TestUtils.waitForCondition(
      () =>
        popover.getAttribute("sval-stem") === "placed" &&
        !popover.hasAttribute("sval-stem-pending"),
      `${buttonId}'s popover placing its stem`
    );
  } catch (e) {
    throw new Error(
      `${e.message}: ${JSON.stringify({
        stem: popover.getAttribute("sval-stem"),
        pending: popover.getAttribute("sval-stem-pending"),
        state: popover.state,
        seen,
      })}`
    );
  }
  window.removeEventListener("MozAfterPaint", record);
  const { left, top } = popover.getOuterScreenRect();
  const hidden = BrowserTestUtils.waitForPopupEvent(popover, "hidden");
  popover.hidePopup();
  await within(hidden, 10_000, `${buttonId}'s popover closing`);
  return { seen, rest: { left, top } };
}

add_task(async function a_popover_is_first_seen_where_it_stays() {
  await toolbarInPanel(true);
  await moveWindowOnScreen();
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, "https://example.com/"),
    10_000,
    "a page"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(tab));
  const extensions = () => gUnifiedExtensions.panel;
  const siteMenu = () => document.getElementById("sval-site-menu");
  // Each opened after the other, which places it afresh.
  for (const [buttonId, popoverOf] of [
    ["unified-extensions-button", extensions],
    ["sval-site-menu-button", siteMenu],
    ["unified-extensions-button", extensions],
    [
      "sval-protection-button",
      () => document.getElementById("sval-protection-panel"),
    ],
  ]) {
    const { seen, rest } = await seenPlaces(buttonId, popoverOf);
    Assert.deepEqual(
      seen.filter(p => p.left !== rest.left || p.top !== rest.top),
      [],
      `${buttonId}'s popover is seen only where it comes to rest`
    );
  }
});

add_task(async function an_extensions_pinned_button_stands_in_the_tools_set() {
  await toolbarInPanel(true);
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: "pinned@sval.test" } },
      browser_action: { default_area: "navbar", default_title: "Pinned" },
    },
    useAddonManager: "temporary",
  });
  await extension.startup();
  atTaskEnd(() => extension.unload());
  const widget = gUnifiedExtensions.browserActionFor(
    WebExtensionPolicy.getByID("pinned@sval.test")
  ).widget.id;
  const tools = CustomizableUI.getWidgetIdsInArea(SET_AREAS.tools);
  Assert.ok(tools.includes(widget), "it is placed in the tools set");
  Assert.less(
    tools.indexOf(widget),
    tools.indexOf("unified-extensions-button"),
    "before the extensions button"
  );
  // The set widens for it once the layout measures it.
  const node = document.getElementById(widget);
  await TestUtils.waitForCondition(
    () => node.checkVisibility(),
    "it shows in the set"
  );
  Assert.equal(
    node.getBoundingClientRect().width,
    document.getElementById("unified-extensions-button").getBoundingClientRect()
      .width,
    "as one circle, as the extensions button is"
  );

  await toolbarInPanel(false);
  Assert.equal(
    CustomizableUI.getPlacementOfWidget(widget)?.area,
    CustomizableUI.AREA_NAVBAR,
    "above the page it stands in the header"
  );
});

add_task(async function a_set_brings_back_only_its_own_buttons() {
  await toolbarInPanel(true);
  SvalPanel._setPanelWidth(192);
  atTaskEnd(() => SvalPanel._setPanelWidth(null));
  const widgets = [];
  for (let i = 1; i <= 6; i++) {
    const extension = ExtensionTestUtils.loadExtension({
      manifest: {
        browser_specific_settings: { gecko: { id: `own${i}@sval.test` } },
        browser_action: {
          default_area: "menupanel",
          default_title: `Own ${i}`,
        },
      },
      useAddonManager: "temporary",
    });
    await extension.startup();
    atTaskEnd(() => extension.unload());
    widgets.push(
      gUnifiedExtensions.browserActionFor(
        WebExtensionPolicy.getByID(`own${i}@sval.test`)
      ).widget.id
    );
  }
  // Pinned into the column, where every button that may leave has left, each
  // lands in the list the sets share.
  SvalPanel._setPanelWidth(48);
  await TestUtils.waitForCondition(
    () =>
      document.getElementById(PANEL_TOOLBAR_ID).hasAttribute("sval-column") &&
      document.getElementById("home-button").hasAttribute("overflowedItem"),
    "the column's buttons in the list"
  );
  for (const id of widgets) {
    CustomizableUI.addWidgetToArea(id, SET_AREAS.tools, 1);
  }
  await TestUtils.waitForCondition(
    () =>
      widgets.some(id =>
        document.getElementById(id).hasAttribute("overflowedItem")
      ),
    "a pinned button in the shared list"
  );
  // Room again: each set brings back what left it.
  SvalPanel._setPanelWidth(279);
  await TestUtils.waitForCondition(
    () =>
      !document.getElementById(PANEL_TOOLBAR_ID).hasAttribute("sval-column"),
    "the rows back"
  );
  // Each pinned button back in the tools set, and Home in Navigation.
  await within(
    TestUtils.waitForCondition(
      () =>
        !document
          .getElementById("home-button")
          .hasAttribute("overflowedItem") &&
        widgets.every(
          id =>
            document.getElementById(id).closest(".sval-set")?.id ===
            SET_AREAS.tools
        )
    ),
    10_000,
    "every button back in its own set"
  );
  for (const set of document.querySelectorAll(
    `#${PANEL_TOOLBAR_ID} > .sval-set`
  )) {
    if (!Object.values(SET_AREAS).includes(set.id)) {
      continue;
    }
    const placed = CustomizableUI.getWidgetIdsInArea(set.id);
    for (const node of set.querySelector(":scope > .sval-set-target")
      .children) {
      Assert.ok(
        !node.id || placed.includes(node.id),
        `${node.id} stands in ${set.dataset.set} only if placed there`
      );
    }
  }
});
