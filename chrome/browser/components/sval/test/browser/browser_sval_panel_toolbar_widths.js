/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * The toolbar in the Workspace panel as drawn at each width (panel toolbar
 * widths spec, §7): each set one pill, nothing past the panel's edge or over
 * another set, every set where the layout put it, and the column's circles
 * as far from the window's edge as from the page. With the setting on as a
 * window opens, and turned on in an open window, with the panel on either
 * side and in either text direction.
 */

const { OVERFLOW_LIST_ID, SvalPanelToolbar } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelToolbar.sys.mjs"
);
const { IN_PANEL_PREF, PANEL_TOOLBAR_ID, RECORDS_AREA } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalHeader.sys.mjs"
  );

add_setup(() => failOnConsoleErrors());

const WIDTHS = [
  48, 72, 73, 120, 191, 192, 200, 239, 240, 247, 248, 280, 400, 600,
];
/** A pill's height, and a circle's width in the column. */
const PILL = 36;

/**
 * Sets the toolbar's place until the task ends.
 *
 * @param {boolean} inPanel
 */
async function toolbarInPanel(inPanel) {
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
}

/**
 * Puts the panel on `side` until the task ends.
 *
 * @param {string} side
 */
async function panelOn(side) {
  await SvalPanel.placePanel(side);
  atTaskEnd(() => SvalPanel.placePanel("left"));
}

/**
 * Draws every window's panel `width` pixels wide until the task ends, and
 * waits for `win`'s toolbar to draw its layout for it. A width between the
 * panel's column and the narrowest its rows hold snaps to one of the two
 * (`SvalPanel._snapWidth`), never standing between them.
 *
 * @param {Window} win
 * @param {number} width
 * @returns {Promise<number>} The width the panel stands at.
 */
async function panelWidth(win, width) {
  SvalPanel._setPanelWidth(width);
  atTaskEnd(() => SvalPanel._setPanelWidth(null));
  const container = win.document.getElementById("sval-panel-container");
  const now = () => container.getBoundingClientRect().width;
  const clear = w =>
    Math.round(w) === 48 || w >= SvalPanelToolbar.rowsMinWidth(win);
  await TestUtils.waitForCondition(
    () =>
      SvalPanelToolbar.drawnLayout(win)?.width === now() &&
      (Math.round(now()) === width || clear(now())),
    `the toolbar drawn at ${width}px`
  );
  const stands = Math.round(now());
  Assert.ok(
    stands === width || clear(stands),
    `${width}px stands at ${stands}px, clear of the widths between`
  );
  return stands;
}

/** @param {Element} el */
const box = el => el.getBoundingClientRect();

/**
 * Asserts what the user sees of `win`'s toolbar at `width`.
 *
 * @param {Window} win
 * @param {number} width
 * @param {string} side
 */
function assertDrawn(win, width, side) {
  const doc = win.document;
  const what = `at ${width}px, on the ${side}`;
  const panel = box(doc.getElementById("sval-panel-container"));
  const drawn = SvalPanelToolbar.drawnLayout(win);
  const setOf = name =>
    doc.querySelector(`#${PANEL_TOOLBAR_ID} > .sval-set[data-set="${name}"]`);
  const sets = [
    ...doc.querySelectorAll(`#${PANEL_TOOLBAR_ID} > .sval-set`),
    doc.getElementById(RECORDS_AREA),
  ]
    .map(el => ({ name: el.dataset.set, el }))
    .filter(({ el }) => el.checkVisibility());

  // » lists its items in the toolbar's order, from every set that shares
  // it (spec §2).
  const areas = [
    ...doc.querySelectorAll(`#${PANEL_TOOLBAR_ID} > .sval-set`),
    doc.getElementById(RECORDS_AREA),
  ];
  const listed = [...doc.getElementById(OVERFLOW_LIST_ID).children].map(
    item => {
      const { area, position } = CustomizableUI.getPlacementOfWidget(item.id);
      return {
        id: item.id,
        set: areas.indexOf(doc.getElementById(area)),
        position,
      };
    }
  );
  for (let i = 1; i < listed.length; i++) {
    const [a, b] = [listed[i - 1], listed[i]];
    Assert.ok(
      a.set < b.set || (a.set == b.set && a.position < b.position),
      `» lists ${a.id} before ${b.id} ${what}`
    );
  }
  info(`» holds ${listed.map(item => item.id).join(" ") || "nothing"} ${what}`);

  // Every item a set shows lies whole inside its pill: an item that has no
  // room leaves for », the Extensions panel or out of sight, and is never
  // cut off at the pill's edge.
  for (const { name, el } of sets) {
    const pill = box(el);
    const target = el.querySelector(":scope > .sval-set-target");
    for (const item of target?.children ?? []) {
      const b = box(item);
      if (!b.width) {
        continue;
      }
      if (b.left < pill.left - 0.5 || b.right > pill.right + 0.5) {
        Assert.ok(false, `${item.id} is cut off in ${name} ${what}`);
      }
    }
  }

  for (const { name, el } of sets) {
    const b = box(el);
    if (b.left < panel.left - 0.5 || b.right > panel.right + 0.5) {
      Assert.ok(false, `${name} crosses the panel's edge ${what}`);
    }
    if (name === "window" || name === "address" || name === "badge") {
      continue;
    }
    if (drawn.column) {
      if (Math.round(b.width) > PILL) {
        Assert.ok(false, `${name} is ${b.width}px wide in the column ${what}`);
      }
    } else if (Math.round(b.height) !== PILL) {
      Assert.ok(false, `${name} is ${b.height}px tall, not one pill, ${what}`);
    }
  }

  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = box(sets[i].el);
      const b = box(sets[j].el);
      const overlap =
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
      if (overlap) {
        Assert.ok(false, `${sets[i].name} and ${sets[j].name} overlap ${what}`);
      }
    }
  }

  if (drawn.column) {
    // Nothing in the panel reverses on the right, so the column lines up
    // on its left on either side.
    const edges = sets
      .filter(({ el }) => doc.getElementById(PANEL_TOOLBAR_ID).contains(el))
      .map(({ el }) => Math.round(box(el).left));
    if (new Set(edges).size !== 1) {
      Assert.ok(
        false,
        `the column's sets share no start edge ${what}: ${edges}`
      );
    }
    const records = box(doc.getElementById(RECORDS_AREA));
    if (Math.round(records.width) > PILL) {
      Assert.ok(false, `the records are ${records.width}px wide ${what}`);
    }
    Assert.less(
      Math.abs(edges[0] - panel.left),
      16,
      `the column starts at the panel's left ${what}`
    );
  } else {
    // The page's frame stands apart from the panel, so the rows stand as
    // far from the window's edge as from the page.
    const address = box(setOf("address"));
    const page = box(win.gBrowser.selectedBrowser.closest(".browserStack"));
    const [edgeRoom, pageRoom] =
      side === "left"
        ? [address.left - panel.left, page.left - address.right]
        : [panel.right - address.right, address.left - page.right];
    if (Math.abs(edgeRoom - pageRoom) > 0.5) {
      Assert.ok(
        false,
        `the rows stand ${edgeRoom}px from the window's edge and ${pageRoom}px from the page ${what}`
      );
    }
    for (const row of drawn.rows) {
      const tops = row
        .map(setOf)
        .filter(el => el.checkVisibility())
        .map(el => Math.round(box(el).top));
      if (new Set(tops).size > 1) {
        Assert.ok(false, `[${row}] is not one row ${what}: ${tops}`);
      }
    }
  }
  Assert.ok(true, `the toolbar is drawn as laid out ${what}`);
}

/**
 * Waits for `win`'s sets to have given up what their room no longer holds:
 * `OverflowableToolbar` checks in a task after the resize it answers, so a
 * set narrows a moment before its items leave. An item that leaves draws the
 * toolbar again in a task of its own (`SvalPanelToolbar`'s `refit`), which
 * hides a column's set left showing nothing. A set that never settles fails
 * here.
 *
 * @param {Window} win
 * @param {number} width
 */
async function settled(win, width) {
  const doc = win.document;
  const panel = box(doc.getElementById("sval-panel-container"));
  // Either edge, since a set overflows toward its end, the left in
  // right-to-left text.
  const inside = (inner, outer) =>
    inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;
  await TestUtils.waitForCondition(() => {
    const column = SvalPanelToolbar.drawnLayout(win)?.column;
    return [
      ...doc.querySelectorAll(`#${PANEL_TOOLBAR_ID} > .sval-set`),
      doc.getElementById(RECORDS_AREA),
    ]
      .filter(el => el.checkVisibility())
      .every(el => {
        const pill = box(el);
        const target = el.querySelector(":scope > .sval-set-target");
        const shown = [...(target?.children ?? [])].filter(
          item => box(item).width
        );
        return (
          inside(pill, panel) &&
          shown.every(item => inside(box(item), pill)) &&
          !(column && target && !shown.length)
        );
      });
  }, `the toolbar settling at ${width}px`);
}

/**
 * Asserts the toolbar at every width in `win`, with the panel on `side`.
 *
 * @param {Window} win
 * @param {string} side
 */
async function everyWidth(win, side) {
  for (const width of WIDTHS) {
    const stands = await panelWidth(win, width);
    await settled(win, stands);
    assertDrawn(win, stands, side);
  }
}

add_task(async function the_setting_turned_on_draws_every_width() {
  await toolbarInPanel(false);
  await toolbarInPanel(true);
  await everyWidth(window, "left");
});

add_task(
  async function a_window_opened_with_the_setting_on_draws_every_width() {
    await toolbarInPanel(true);
    const win = await within(
      BrowserTestUtils.openNewBrowserWindow(),
      10_000,
      "a new window"
    );
    atTaskEnd(() =>
      within(
        BrowserTestUtils.closeWindow(win),
        10_000,
        "the new window closing"
      )
    );
    await within(win.SvalPanel.started, 10_000, "the new window's panel");
    await everyWidth(win, "left");
  }
);

add_task(async function a_panel_on_the_right_draws_every_width() {
  await toolbarInPanel(true);
  await panelOn("right");
  await everyWidth(window, "right");
});

add_task(async function right_to_left_text_draws_every_width() {
  await toolbarInPanel(true);
  await SpecialPowers.pushPrefEnv({ set: [["intl.l10n.pseudo", "bidi"]] });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  await TestUtils.waitForCondition(
    () => document.documentElement.matches(":dir(rtl)"),
    "the window's text turning right to left"
  );
  // The panel stands at the text's start, the window's right.
  await everyWidth(window, "right");
});

add_task(async function privacy_and_security_stands_apart_in_the_column() {
  await toolbarInPanel(true);
  await openPage("https://example.com/browser/");
  const button = document.getElementById("sval-protection-button");
  const slot = document.querySelector(
    `#${PANEL_TOOLBAR_ID} > .sval-set[data-set="shield"]`
  );
  const address = document.querySelector(
    `#${PANEL_TOOLBAR_ID} > .sval-set[data-set="address"]`
  );

  await panelWidth(window, 48);
  Assert.equal(button.parentNode, slot, "it stands in a circle of its own");
  Assert.ok(slot.checkVisibility(), "which shows on a site");
  Assert.lessOrEqual(
    Math.round(box(slot).bottom),
    Math.round(box(address).top),
    "above the address"
  );

  await panelWidth(window, 280);
  Assert.ok(gURLBar.contains(button), "and goes back into the address");
  Assert.ok(!slot.checkVisibility(), "whose circle goes");
});

add_task(async function the_launcher_floats_whole_from_the_column() {
  await toolbarInPanel(true);
  await openPage("https://example.com/browser/");
  await panelWidth(window, 48);
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  gBrowser.selectedBrowser.focus();
  const floating = () => gURLBar.hasAttribute("sval-launcher-floating");

  EventUtils.synthesizeKey("l", { accelKey: true });
  await TestUtils.waitForCondition(floating, "the Launcher floats");
  Assert.ok(gURLBar.focused, "its field takes the keyboard");
  Assert.ok(
    gURLBar.querySelector(".urlbar-input-box").checkVisibility(),
    "and shows"
  );
  // Each key formats the field, which needs its editor
  // (`UrlbarValueFormatter`); the file fails on the error a hidden field
  // logs.
  EventUtils.sendString("@b");

  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !floating(), "Escape closes it");
});

/**
 * Opens Favorites from the column with the panel on `side`, and checks the
 * menu grows from the button into the window, in either text direction,
 * wherever the toolbar stands.
 *
 * @param {string} side
 * @param {boolean} [rtl] Whether the window's text runs right to left.
 * @param {boolean} [inPanel] Whether the toolbar stands in the panel.
 */
async function checkPopoverBesideColumn(side, rtl = false, inPanel = true) {
  await toolbarInPanel(inPanel);
  if (rtl) {
    await SpecialPowers.pushPrefEnv({ set: [["intl.l10n.pseudo", "bidi"]] });
    atTaskEnd(() => SpecialPowers.popPrefEnv());
    await TestUtils.waitForCondition(
      () => document.documentElement.matches(":dir(rtl)"),
      "the window's text turning right to left"
    );
  }
  await panelOn(side);
  if (inPanel) {
    await panelWidth(window, 48);
  } else {
    // With no toolbar to draw, the panel's own 48px layout follows its
    // width (`sval-panel.css`).
    SvalPanel._setPanelWidth(48);
    atTaskEnd(() => SvalPanel._setPanelWidth(null));
    const container = document.getElementById("sval-panel-container");
    await TestUtils.waitForCondition(
      () => Math.round(container.getBoundingClientRect().width) === 48,
      "the panel standing 48px wide"
    );
  }
  const what = `on the ${side}${rtl ? ", right to left" : ""}${inPanel ? "" : ", the toolbar above the page"}`;
  const button = box(SvalPanel._els.favorites);
  const panel = box(document.getElementById("sval-panel-container"));
  const page = box(gBrowser.selectedBrowser.closest(".browserStack"));
  // The column stands at the window's edge and the page beside it.
  const atLeft = panel.left < page.left;
  Assert.ok(
    button.left >= panel.left && button.right <= panel.right,
    `Favorites stands inside the column ${what}`
  );
  Assert.equal(
    Math.round(button.width),
    PILL,
    `Favorites is one circle in its pill ${what}`
  );
  // The column stands each circle, and each row of the tree, as far from
  // the window's edge as from the page, wherever the toolbar is.
  const rowEl = [...document.querySelectorAll(".sval-panel .sval-row")].find(
    el => el.getBoundingClientRect().width
  );
  // A classic scrollbar beside the tree takes its own room, on the side the
  // tree's text ends; an overlay scrollbar, as macOS draws, takes none.
  let scroller = rowEl.parentElement;
  while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
    scroller = scroller.parentElement;
  }
  const gutter = scroller
    ? scroller.getBoundingClientRect().width -
      scroller.clientWidth -
      parseFloat(getComputedStyle(scroller).borderLeftWidth) -
      parseFloat(getComputedStyle(scroller).borderRightWidth)
    : 0;
  const gutterLeft =
    scroller && getComputedStyle(scroller).direction === "rtl" ? gutter : 0;
  const gutterRight = gutter - gutterLeft;
  for (const [name, el, left, right] of [
    ["Favorites", button, 0, 0],
    ["a row of the tree", box(rowEl), gutterLeft, gutterRight],
  ]) {
    const [edgeRoom, pageRoom] = atLeft
      ? [el.left - panel.left - left, page.left - el.right - right]
      : [panel.right - el.right - right, el.left - page.right - left];
    Assert.less(
      Math.abs(edgeRoom - pageRoom),
      0.5,
      `${name} stands ${edgeRoom}px from the window's edge and ${pageRoom}px from the page ${what}`
    );
  }
  const menu = SvalPanel._els.favoritesMenu;
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  SvalPanel.openFavorites();
  await within(shown, 10_000, "the Favorites menu opening");
  atTaskEnd(async () => {
    const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
    menu.hidePopup();
    await within(hidden, 10_000, "the Favorites menu closing");
  });

  // The stem moves the menu beside its button once it has its size.
  const content = () => box(menu.shadowRoot.querySelector('[part~="content"]'));
  await within(
    TestUtils.waitForCondition(() =>
      atLeft ? content().left > button.right : content().right < button.left
    ),
    5_000,
    `the menu standing beside the button, over the page ${what}`
  );
  Assert.equal(
    menu.getAttribute("sval-stem-side"),
    atLeft ? "right" : "left",
    `it grows from the button's side toward the page ${what}`
  );
  // Joined to the button by its stem, shown once placed. A menu that never
  // joins names where everything stood.
  await within(
    TestUtils.waitForCondition(
      () =>
        menu.getAttribute("sval-stem") === "placed" &&
        !menu.hasAttribute("sval-stem-pending")
    ),
    5_000,
    `the menu joined to the button ${what}`
  ).catch(error => {
    const stood = {
      stem: menu.getAttribute("sval-stem"),
      pending: menu.hasAttribute("sval-stem-pending"),
      button,
      content: content(),
      frame: box(menu),
      window: menu.getOuterScreenRect(),
      inner: [window.mozInnerScreenX, window.mozInnerScreenY],
      screen: [
        screen.availLeft,
        screen.availTop,
        screen.availWidth,
        screen.availHeight,
      ],
    };
    throw new Error(`${error.message}: ${JSON.stringify(stood)}`);
  });
}

add_task(async function a_popover_opens_beside_the_column() {
  await checkPopoverBesideColumn("left");
});

add_task(async function a_popover_opens_beside_the_column_on_the_right() {
  await checkPopoverBesideColumn("right");
});

add_task(async function a_popover_opens_into_the_window_right_to_left() {
  await checkPopoverBesideColumn("left", true);
});

add_task(
  async function a_popover_opens_into_the_window_right_to_left_on_the_right() {
    await checkPopoverBesideColumn("right", true);
  }
);

/**
 * Narrows the panel to its column and opens Favorites in the same task,
 * and checks the menu opens beside the column, from the width the panel
 * has as the menu opens.
 *
 * @param {boolean} inPanel Whether the toolbar stands in the panel.
 */
async function checkBesideAsThePanelNarrows(inPanel) {
  await toolbarInPanel(inPanel);
  await panelOn("left");
  const container = document.getElementById("sval-panel-container");
  Assert.greater(
    container.getBoundingClientRect().width,
    48,
    "the panel stands wider than its column"
  );
  const menu = SvalPanel._els.favoritesMenu;
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  SvalPanel._setPanelWidth(48);
  atTaskEnd(() => SvalPanel._setPanelWidth(null));
  SvalPanel.openFavorites();
  await within(shown, 10_000, "the Favorites menu opening");
  atTaskEnd(async () => {
    const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
    menu.hidePopup();
    await within(hidden, 10_000, "the Favorites menu closing");
  });
  Assert.equal(
    menu.getAttribute("sval-stem-side"),
    "right",
    `it opens beside the column ${inPanel ? "" : "with the toolbar above the page "}as the panel narrows`
  );
}

add_task(async function favorites_opens_beside_as_the_panel_narrows() {
  await checkBesideAsThePanelNarrows(true);
});

add_task(
  async function favorites_opens_beside_as_the_panel_narrows_above_the_page() {
    await checkBesideAsThePanelNarrows(false);
  }
);

add_task(async function a_popover_opens_beside_the_column_above_the_page() {
  await checkPopoverBesideColumn("left", false, false);
});

add_task(
  async function a_popover_opens_beside_the_column_on_the_right_above_the_page() {
    await checkPopoverBesideColumn("right", false, false);
  }
);

add_task(async function the_columns_circles_are_alike_and_centred() {
  await toolbarInPanel(true);
  await openPage("https://example.com/browser/");
  await panelWidth(window, 48);
  // Each lone circle in the column: its ring, and the 28px circle its hover
  // washes, which holds its 16px glyph.
  const circles = [
    ...document.querySelectorAll(
      `#${PANEL_TOOLBAR_ID} [sval-stem-face] > :is(toolbarbutton, toolbaritem, #sval-protection-button)`
    ),
  ]
    .filter(button => button.checkVisibility())
    .map(button => {
      const ring = button.parentElement;
      const face =
        button.querySelector(
          ":scope > :is(.toolbarbutton-icon, .toolbarbutton-badge-stack)"
        ) ?? button;
      return { name: button.id, ring, face };
    });
  const glass = gURLBar.querySelector(".searchmode-switcher");
  circles.push({
    name: "the address's glass",
    ring: document.getElementById("urlbar-container"),
    face: glass,
  });
  // The toggle, the site menu, the extensions button and the glass show
  // in every window; the shield and » as the page and folding have them.
  Assert.greaterOrEqual(circles.length, 4, "the column shows its circles");
  for (const { name, ring, face } of circles) {
    const outer = box(ring);
    const inner = box(face);
    Assert.deepEqual(
      [outer.width, outer.height],
      [36, 36],
      `${name}'s ring is 36px`
    );
    Assert.deepEqual(
      [inner.width, inner.height],
      [28, 28],
      `${name}'s circle is 28px`
    );
    Assert.deepEqual(
      [
        inner.left + inner.width / 2 - (outer.left + outer.width / 2),
        inner.top + inner.height / 2 - (outer.top + outer.height / 2),
      ],
      [0, 0],
      `${name}'s circle stands in its ring's middle`
    );
  }
  for (const button of document.querySelectorAll(
    ".sval-panel-footer :is(.sval-favorites, .sval-feedback-button)"
  )) {
    const rect = box(button);
    Assert.deepEqual(
      [rect.left, rect.width, rect.height],
      [box(circles[0].ring).left, 36, 36],
      `${button.className} is a ring where the toolbar's stand`
    );
  }
});
