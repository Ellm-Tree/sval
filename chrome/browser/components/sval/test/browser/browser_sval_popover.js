/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * SvalPopover: popovers made in the popupset, their buttons, focus,
 * placement and removal, the look `sval-popover.css` gives them over
 * Firefox's, the window's colours and inks they take, and a see-through
 * window's material in place of a stem. Then every popover Sval makes
 * through it, each checked for the same.
 */

const { SvalPopover } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPopover.sys.mjs"
);
const { SvalMenu } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalMenu.sys.mjs"
);
const { SvalBatterySaver, MODE_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBatterySaver.sys.mjs"
);
const { SvalNoticesButton } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalNoticesButton.sys.mjs"
);
const { SvalProtectionButton } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs"
);
const { SvalSiteControls } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs"
);
const { SvalSiteStylePanel } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs"
);
const { SvalPeek } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPeek.sys.mjs"
);
ChromeUtils.defineESModuleGetters(this, {
  AppMenuNotifications: "resource://gre/modules/AppMenuNotifications.sys.mjs",
});

/**
 * Removes a popover the task made when the task ends.
 *
 * @param {{popup: Element}} handle
 * @returns {{popup: Element}} `handle`.
 */
function made(handle) {
  atTaskEnd(() => handle.popup.remove());
  return handle;
}

/** @returns {Element} a header button a popover can grow from. */
function anchor() {
  return document.getElementById("reload-button");
}

/**
 * @param {Element} popup
 * @returns {Element} its content box, which draws its fill and edge.
 */
function contentOf(popup) {
  return popup.shadowRoot.querySelector('[part~="content"]');
}

/**
 * @param {string} value A CSS colour, as a custom property holds it.
 * @param {Document} [doc]
 * @returns {string} the colour as computed.
 */
function resolve(value, doc = document) {
  const probe = doc.createElement("div");
  probe.style.color = value;
  doc.documentElement.append(probe);
  const color = doc.defaultView.getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/**
 * Asserts `popup` is drawn by Sval's sheet alone: no system appearance or
 * fill of its own, and its content in the panel roles it reads.
 *
 * @param {Element} popup
 * @param {string} what
 */
function checkSolid(popup, what) {
  const win = popup.documentGlobal;
  const style = win.getComputedStyle(popup);
  const content = win.getComputedStyle(contentOf(popup));
  Assert.ok(popup.hasAttribute("sval-popover"), `${what} is a popover`);
  Assert.equal(style.appearance, "none", `${what} has no system look`);
  Assert.equal(
    style.backgroundColor,
    "rgba(0, 0, 0, 0)",
    `${what}'s popup window has no fill of its own`
  );
  const rgba = color => {
    const { r, g, b, a } = InspectorUtils.colorToRGBA(color);
    return [r, g, b].map(Math.round).concat(+a.toFixed(3));
  };
  const role = name =>
    rgba(resolve(style.getPropertyValue(name), popup.ownerDocument));
  // A stem's outline draws the fill and edge of a popover grown from its
  // button (`SvalStem`), in the same roles.
  const fill = popup.hasAttribute("sval-stem")
    ? win.getComputedStyle(
        popup.shadowRoot.querySelector('[part~="sval-stem-fill"]')
      ).fill
    : content.backgroundColor;
  Assert.deepEqual(
    rgba(fill),
    role("--panel-background-color"),
    `${what} is filled in its panel colour`
  );
  Assert.deepEqual(
    rgba(content.color),
    role("--panel-text-color"),
    `${what}'s text is its panel text`
  );
  if (!popup.hasAttribute("sval-stem")) {
    Assert.deepEqual(
      rgba(content.borderTopColor),
      role("--panel-border-color"),
      `${what}'s edge is its panel edge`
    );
  }
}

/**
 * @param {Element} popup
 * @param {string} accent The window's `--sval-tint-accent`.
 * @param {string} what
 * @returns {Promise<void>} `checkSeeThroughLook`'s.
 */
function checkSeeThrough(popup, accent, what) {
  return checkSeeThroughLook(popup, accent, what);
}

/**
 * Makes the window see-through until the task ends, as `_applyWindowTint`
 * does for a window some of whose backdrop shows.
 *
 * @returns {string} the colour it wears over the backdrop.
 */
function seeThrough() {
  const root = document.documentElement;
  const accent = "rgba(40, 60, 120, 0.4)";
  root.style.setProperty("--sval-tint-accent", accent);
  root.setAttribute("data-sval-translucent", "");
  watchWindowShapes(window);
  atTaskEnd(() => {
    root.removeAttribute("data-sval-translucent");
    root.style.removeProperty("--sval-tint-accent");
  });
  return accent;
}

/**
 * @param {Document} [doc]
 * @returns {Element} a popover's body with two buttons.
 */
function body(doc = document) {
  const box = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  for (const name of ["first", "second"]) {
    const button = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button"
    );
    button.className = name;
    button.textContent = name;
    box.append(button);
  }
  return box;
}

// Sval's default window is see-through where the system allows it: the
// file's tasks check the solid look, and make a window see-through where
// they check that look.
add_setup(() => windowSeeThrough(false));

add_task(async function test_made_in_the_popupset() {
  const handle = made(
    SvalPopover.create(document, {
      name: "sval-test-popover",
      label: "Test",
      className: "sval-test",
      attributes: { orient: "vertical", flip: "slide", skipped: null },
      stem: { side: "left", hang: true },
    })
  );
  const { popup } = handle;
  Assert.equal(popup.localName, "panel", "a XUL panel");
  Assert.equal(
    popup.parentNode,
    document.getElementById("mainPopupSet"),
    "in the window's popupset"
  );
  Assert.equal(popup.getRootNode(), document, "in the light DOM");
  Assert.equal(popup.id, "sval-test-popover");
  Assert.equal(popup.getAttribute("type"), "arrow", "an arrow panel");
  Assert.equal(popup.getAttribute("role"), "dialog", "a dialog");
  Assert.equal(popup.getAttribute("aria-label"), "Test");
  Assert.ok(popup.classList.contains("sval-test"), "its class");
  Assert.equal(popup.getAttribute("orient"), "vertical");
  Assert.equal(popup.getAttribute("flip"), "slide");
  Assert.ok(!popup.hasAttribute("skipped"), "a null attribute is left out");
  Assert.ok(popup.hasAttribute("sval-stem-host"), "grows from its button");
  Assert.equal(popup.getAttribute("sval-stem-side"), "left");
  Assert.ok(popup.hasAttribute("sval-stem-hang"), "hanging past it");

  const again = made(
    SvalPopover.create(document, {
      name: "sval-test-popover",
      arrow: false,
      labelledBy: "sval-test-heading",
      role: "alertdialog",
    })
  );
  Assert.ok(!popup.isConnected, "one of a name replaces the one before");
  Assert.ok(!again.popup.hasAttribute("type"), "a plain panel");
  Assert.equal(again.popup.getAttribute("role"), "alertdialog");
  Assert.equal(
    again.popup.getAttribute("aria-labelledby"),
    "sval-test-heading"
  );
  Assert.ok(!again.popup.hasAttribute("sval-stem-host"), "with no stem");
});

add_task(async function test_its_button_shows_it_open() {
  const shown = [];
  const hidden = [];
  const handle = made(
    SvalPopover.create(document, {
      label: "Test",
      onShowing: () => shown.push("showing"),
      onShown: () => shown.push("shown"),
      onHidden: () => hidden.push("hidden"),
    })
  );
  handle.popup.append(body());
  const button = anchor();
  button.setAttribute("aria-expanded", "false");
  atTaskEnd(() => button.removeAttribute("aria-expanded"));

  Assert.ok(!handle.isOpen(), "closed");
  await openPopover(handle, () => handle.openFrom(button));
  Assert.ok(handle.isOpen(), "open");
  Assert.equal(handle.button, button, "it knows its button");
  Assert.equal(button.getAttribute("open"), "true", "the button is open");
  Assert.equal(button.getAttribute("aria-expanded"), "true", "and expanded");
  Assert.deepEqual(shown, ["showing", "shown"], "each handler ran once");

  // A menu it holds sends its own events through it.
  const menu = SvalMenu.create(document, {
    items: [{ id: "one", label: "One" }],
  });
  handle.popup.append(menu.popup);
  await openMenu(menu, () =>
    menu.openFrom(handle.popup.querySelector("button"))
  );
  const menuHidden = BrowserTestUtils.waitForPopupEvent(menu.popup, "hidden");
  menu.close();
  await within(menuHidden, 10_000, "the inner menu hiding");
  Assert.deepEqual(shown, ["showing", "shown"], "a menu's showing is its own");
  Assert.deepEqual(hidden, [], "and its hiding");
  Assert.ok(handle.isOpen(), "the popover stays open");

  await closePopover(handle);
  Assert.deepEqual(hidden, ["hidden"], "its own hiding");
  Assert.ok(!button.hasAttribute("open"), "the button is closed");
  Assert.equal(button.getAttribute("aria-expanded"), "false", "collapsed");
  Assert.equal(handle.button, null, "it has no button while closed");

  button.removeAttribute("aria-expanded");
  const other = document.getElementById("back-button");
  await openPopover(handle, () =>
    handle.openFrom(anchor(), "bottomleft topleft", { button: other })
  );
  Assert.equal(other.getAttribute("open"), "true", "the button it names");
  Assert.ok(
    !anchor().hasAttribute("aria-expanded"),
    "a button with no aria-expanded is given none"
  );
  await closePopover(handle);
  Assert.ok(!other.hasAttribute("open"), "closed again");

  await openPopover(handle, () =>
    handle.openFrom(anchor(), "bottomleft topleft", { button: null })
  );
  Assert.equal(handle.button, null, "no button at all for null");
  await closePopover(handle);
});

add_task(async function test_the_keyboard_moves_in_when_asked() {
  const handle = made(SvalPopover.create(document, { label: "Test" }));
  handle.popup.append(body());
  const first = handle.popup.querySelector(".first");

  gURLBar.focus();
  await openPopover(handle, () => handle.openFrom(anchor()));
  Assert.notEqual(
    document.activeElement,
    first,
    "opened by a pointer, the focus stays out"
  );
  await closePopover(handle);

  await openPopover(handle, () =>
    handle.openFrom(anchor(), "bottomleft topleft", { focus: true })
  );
  Assert.equal(document.activeElement, first, "by a key, it moves in");
  await closePopover(handle);

  await openPopover(handle, () =>
    handle.openAt(window.screenX + 80, window.screenY + 80, { focus: true })
  );
  Assert.equal(document.activeElement, first, "at a point too");
  await closePopover(handle);
});

add_task(async function test_it_opens_at_a_point() {
  const handle = made(
    SvalPopover.create(document, { label: "Test", arrow: false })
  );
  handle.popup.append(body());
  const x = window.screenX + 120;
  const y = window.screenY + 140;
  await openPopover(handle, () => handle.openAt(x, y));
  const box = handle.popup.getOuterScreenRect();
  const margin = parseFloat(getComputedStyle(handle.popup).marginLeft);
  Assert.less(
    Math.abs(box.left - margin - x),
    2,
    "its left is where it was put"
  );
  Assert.equal(handle.button, null, "with no button");
  await closePopover(handle);
});

add_task(async function test_a_transient_popover_goes() {
  const handle = SvalPopover.create(document, {
    label: "Test",
    transient: true,
  });
  handle.popup.append(body());
  await openPopover(handle, () => handle.openFrom(anchor()));
  await closePopover(handle);
  Assert.ok(!handle.popup.isConnected, "removed once it hides");
});

add_task(async function test_no_firefox_style_reaches_it() {
  for (const arrow of [true, false]) {
    const what = arrow ? "an arrow popover" : "a plain popover";
    const handle = made(SvalPopover.create(document, { label: "Test", arrow }));
    handle.popup.append(body());
    await openPopover(handle, () => handle.openFrom(anchor()));
    checkSolid(handle.popup, what);
    const root = getComputedStyle(document.documentElement);
    Assert.equal(
      getComputedStyle(contentOf(handle.popup)).backgroundColor,
      resolve(root.getPropertyValue("--sval-popup-bg")),
      `${what} is the window's popup colour, whatever its placement`
    );
    // Firefox's `popup.css` gives a plain panel the system menu's colours.
    handle.popup.style.setProperty("--menu-background-color", "rgb(255, 0, 0)");
    handle.popup.style.setProperty("--arrowpanel-background", "rgb(255, 0, 0)");
    Assert.notEqual(
      getComputedStyle(contentOf(handle.popup)).backgroundColor,
      "rgb(255, 0, 0)",
      `Firefox's popup colours do not reach ${what}`
    );
    await closePopover(handle);
  }
});

add_task(async function test_it_takes_the_windows_ink() {
  const root = document.documentElement;
  const before = root.getAttribute("data-sval-ink");
  atTaskEnd(() =>
    before === null
      ? root.removeAttribute("data-sval-ink")
      : root.setAttribute("data-sval-ink", before)
  );
  const handle = made(
    SvalPopover.create(document, { label: "Test", arrow: false })
  );
  for (const [ink, scheme] of [
    ["light", "dark"],
    ["dark", "light"],
  ]) {
    root.setAttribute("data-sval-ink", ink);
    Assert.equal(
      getComputedStyle(handle.popup).colorScheme,
      scheme,
      `a window of ${ink} text gives its popovers a ${scheme} scheme`
    );
  }
});

add_task(async function test_a_see_through_window_shows_through_it() {
  const accent = seeThrough();
  const handle = made(
    SvalPopover.create(document, { label: "Test", stem: { hang: true } })
  );
  handle.popup.append(body());
  await openPopover(handle, () => handle.openFrom(anchor()));
  await checkSeeThrough(handle.popup, accent, "a stemmed popover");
  if (handle.popup.hasAttribute("sval-stem")) {
    Assert.ok(anchor().hasAttribute("sval-stem"), "from its button");
  }
  await closePopover(handle);

  document.documentElement.removeAttribute("data-sval-translucent");
  await openPopover(handle, () => handle.openFrom(anchor()));
  await TestUtils.waitForCondition(
    () => handle.popup.hasAttribute("sval-stem"),
    "in a solid window it grows its stem"
  );
  Assert.ok(anchor().hasAttribute("sval-stem"), "from its button");
  Assert.equal(
    getComputedStyle(handle.popup).appearance,
    "none",
    "and draws its own look"
  );
  Assert.ok(!handle.popup.hasWindowShape, "with no backdrop to shape");
  await closePopover(handle);
});

add_task(async function test_a_stemmed_menu_keeps_its_stem_too() {
  const accent = seeThrough();
  const handle = SvalMenu.create(document, {
    items: [{ id: "one", label: "One" }],
    stem: { hang: true },
  });
  atTaskEnd(() => handle.popup.remove());
  await openMenu(handle, () => handle.openFrom(anchor()));
  await checkSeeThroughLook(handle.popup, accent, "a stemmed menu");
  const hidden = BrowserTestUtils.waitForPopupEvent(handle.popup, "hidden");
  handle.close();
  await within(hidden, 10_000, "the menu hiding");
});

add_task(async function test_battery_saver_is_a_popover() {
  const stand = new EventTarget();
  stand.charging = false;
  atTaskEnd(SvalBatterySaver.useBatteryForTests(stand));
  await SpecialPowers.pushPrefEnv({ set: [[MODE_PREF, "unplugged"]] });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  Assert.ok(SvalBatterySaver.active, "Battery Saver is on");
  const handle = SvalBatterySaver.popoverOf(window);
  const button = document.getElementById("sval-battery-saver-button");

  await openPopover(handle, () => SvalBatterySaver.open(window));
  checkSolid(handle.popup, "Battery Saver");
  Assert.equal(handle.button, button, "it opens from its button");
  Assert.ok(button.hasAttribute("open"), "which shows it open");
  await TestUtils.waitForCondition(
    () => handle.popup.hasAttribute("sval-stem"),
    "Battery Saver grows its stem"
  );
  await closePopover(handle);

  const accent = seeThrough();
  await openPopover(handle, () =>
    SvalBatterySaver.open(window, { focus: true })
  );
  await checkSeeThrough(handle.popup, accent, "Battery Saver");
  Assert.ok(
    handle.popup.contains(document.activeElement),
    "opened by a key, its button takes the focus"
  );
  await closePopover(handle);
});

add_task(async function test_notices_are_a_popover() {
  atTaskEnd(() => AppMenuNotifications.removeNotification(/.*/));
  const handle = SvalNoticesButton.popoverOf(window);
  const shown = BrowserTestUtils.waitForPopupEvent(handle.popup, "shown");
  AppMenuNotifications.showNotification(
    "update-available",
    { callback() {} },
    { callback() {}, dismiss: true }
  );
  await within(shown, 10_000, "an undismissed notice opening it");
  checkSolid(handle.popup, "the notices");
  Assert.equal(
    handle.button,
    document.getElementById("sval-notices-button"),
    "it opens from its button"
  );
  await TestUtils.waitForCondition(
    () => handle.popup.hasAttribute("sval-stem"),
    "the notices grow their stem"
  );
  await closePopover(handle);

  const accent = seeThrough();
  await openPopover(handle, () => SvalNoticesButton.open(window));
  await checkSeeThrough(handle.popup, accent, "the notices");
  await closePopover(handle);
});

add_task(async function test_the_site_menu_is_a_popover() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const button = document.getElementById("sval-site-menu-button");
    const handle = SvalSiteControls.forWindow(window).popover;
    await openPopover(handle, () => button.click());
    checkSolid(handle.popup, "the site menu");
    Assert.ok(button.hasAttribute("open"), "its button shows it open");
    await TestUtils.waitForCondition(
      () => handle.popup.hasAttribute("sval-stem"),
      "the site menu grows its stem"
    );
    await closePopover(handle);
    Assert.ok(!button.hasAttribute("open"), "and closed");

    const accent = seeThrough();
    await openPopover(handle, () => button.click());
    await checkSeeThrough(handle.popup, accent, "the site menu");
    await closePopover(handle);
  });
});

add_task(async function test_protections_are_a_popover() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const controls = SvalProtectionButton.forWindow(window);
    const handle = controls.popover;
    await openPopover(handle, () => controls.open());
    checkSolid(handle.popup, "the protections");
    Assert.equal(handle.button, controls.button, "it opens from its button");
    await closePopover(handle);

    const accent = seeThrough();
    await openPopover(handle, () => controls.open({ focus: true }));
    await checkSeeThrough(handle.popup, accent, "the protections");
    Assert.ok(
      handle.popup.contains(document.activeElement),
      "opened by a key, its first control takes the focus"
    );
    await closePopover(handle);
  });
});

add_task(async function test_colorshift_is_a_popover() {
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    SvalSiteStylePanel.open(window);
    const handle = SvalSiteStylePanel.popoverOf(window);
    await TestUtils.waitForCondition(
      () => handle.popup.state === "open",
      "Colorshift showing"
    );
    checkSolid(handle.popup, "Colorshift");
    Assert.ok(!handle.popup.hasAttribute("type"), "placed where it is put");
    Assert.equal(handle.button, null, "with no button");
    await closePopover(handle);

    const accent = seeThrough();
    await openPopover(handle, () => SvalSiteStylePanel.open(window));
    await checkSeeThrough(handle.popup, accent, "Colorshift");
    await closePopover(handle);
  });
});

add_task(async function test_the_pins_popover_is_a_popover() {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  const handle = SvalPanel.pins.popoverHandle;
  checkSolid(handle.popup, "the pins popover");
  Assert.ok(!handle.popup.hasAttribute("type"), "placed as Gecko puts it");
  Assert.ok(
    handle.popup.hasAttribute("sval-stem-host"),
    "it grows from its tile"
  );
  Assert.equal(
    handle.popup.getAttribute("noautofocus"),
    "true",
    "it places the focus itself"
  );
});

add_task(async function test_a_peeks_popovers_are_popovers() {
  const url = "https://example.com/browser/?popover";
  const opened = BrowserTestUtils.waitForNewWindow({ url });
  runCommandLine(["-url", url]);
  const win = await within(opened, 20_000, "the Peek");
  atTaskEnd(() =>
    within(BrowserTestUtils.closeWindow(win), 10_000, "the Peek closing")
  );
  const { menu, switcher } = SvalPeek.popoversOf(win);
  checkSolid(menu.popup, "a Peek's Workspace menu");
  checkSolid(switcher.popup, "a Peek's switcher");
  Assert.equal(switcher.popup.getAttribute("orient"), "vertical");

  const tag = win.document.getElementById("sval-peek-tag");
  await openPopover(switcher, () =>
    switcher.openFrom(tag, "bottomleft topleft")
  );
  Assert.ok(tag.hasAttribute("open"), "the tag shows it open");
  checkSolid(switcher.popup, "a Peek's open switcher");
  await closePopover(switcher);
  Assert.ok(!tag.hasAttribute("open"), "and closed");
});

add_task(async function test_every_stem_spans_one_gap() {
  const stand = new EventTarget();
  stand.charging = false;
  atTaskEnd(SvalBatterySaver.useBatteryForTests(stand));
  await SpecialPowers.pushPrefEnv({ set: [[MODE_PREF, "unplugged"]] });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  await BrowserTestUtils.withNewTab("https://example.com/", async () => {
    const protections = SvalProtectionButton.forWindow(window);
    const siteMenu = SvalSiteControls.forWindow(window);
    const popovers = [
      [
        "Battery Saver",
        () => SvalBatterySaver.popoverOf(window).popup,
        () => SvalBatterySaver.open(window),
      ],
      [
        "the protections",
        () => protections.popover.popup,
        () => protections.open(),
      ],
      [
        "the site menu",
        () => siteMenu.popover.popup,
        () => document.getElementById("sval-site-menu-button").click(),
      ],
      [
        "the extensions panel",
        () => document.getElementById("unified-extensions-panel"),
        () => gUnifiedExtensions.openPanel(),
      ],
    ];
    const gaps = [];
    for (const [what, popupOf, open] of popovers) {
      const shown = BrowserTestUtils.waitForEvent(
        document,
        "popupshown",
        false,
        event => event.target === popupOf()
      );
      await open();
      await within(shown, 10_000, `${what} opening`);
      const popup = popupOf();
      await TestUtils.waitForCondition(
        () =>
          popup.getAttribute("sval-stem") === "placed" &&
          !popup.hasAttribute("sval-stem-pending"),
        `${what} grows its stem`
      );
      const face = document
        .querySelector("[sval-stem-anchor]")
        .getBoundingClientRect();
      const box = popup.getOuterScreenRect();
      const frame = popup.getBoundingClientRect();
      const content = popup.shadowRoot
        .querySelector('[part~="content"]')
        .getBoundingClientRect();
      gaps.push([
        what,
        box.top +
          content.top -
          frame.top -
          (window.mozInnerScreenY + face.bottom),
      ]);
      const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
      PanelMultiView.hidePopup(popup);
      await within(hidden, 10_000, `${what} closing`);
    }
    const [, first] = gaps[0];
    for (const [what, gap] of gaps) {
      Assert.lessOrEqual(
        Math.abs(gap - first),
        1,
        `${what}'s stem spans ${gap}px, as ${gaps[0][0]}'s spans ${first}px`
      );
    }
  });
});

add_task(async function test_a_stem_anchor_shows_no_adornment() {
  const button = document.getElementById("unified-extensions-button");
  const icon = button.querySelector(".toolbarbutton-icon");
  button.setAttribute("sval-notice", "");
  atTaskEnd(() => button.removeAttribute("sval-notice"));
  const dot = () => getComputedStyle(button, "::after").content;
  const cut = () => getComputedStyle(icon).maskImage;
  Assert.notEqual(dot(), "none", "the extensions button shows its dot");
  Assert.notEqual(cut(), "none", "which cuts its gap in the icon");
  for (const look of ["solid", "see-through"]) {
    if (look === "see-through") {
      seeThrough();
    }
    const shown = BrowserTestUtils.waitForEvent(
      document,
      "popupshown",
      false,
      event => event.target.id === "unified-extensions-panel"
    );
    await gUnifiedExtensions.openPanel();
    await within(shown, 10_000, "the extensions panel opening");
    Assert.ok(
      button.hasAttribute("sval-stem"),
      `${look}: its stem grows from the button`
    );
    Assert.equal(dot(), "none", `${look}: the open button hides its dot`);
    Assert.equal(cut(), "none", `${look}: and its icon is whole`);
    const open = document.getElementById("unified-extensions-panel");
    const hidden = BrowserTestUtils.waitForPopupEvent(open, "hidden");
    PanelMultiView.hidePopup(open);
    await within(hidden, 10_000, "the extensions panel closing");
    // `SvalExtensionNotices.update` sets the mark from the notices it
    // finds unseen, of which this window has none.
    button.setAttribute("sval-notice", "");
    Assert.notEqual(dot(), "none", `${look}: closed, a dot shows again`);
  }
});

add_task(async function test_a_window_moving_as_it_opens_keeps_the_stem() {
  await moveWindowOnScreen();
  const was = { x: window.screenX, y: window.screenY };
  atTaskEnd(async () => {
    window.moveTo(was.x, was.y);
    await TestUtils.waitForCondition(
      () => window.screenX === was.x && window.screenY === was.y,
      "the window going back"
    );
  });
  const handle = made(
    SvalPopover.create(document, { label: "Test", stem: { hang: true } })
  );
  handle.popup.append(body());
  // The window moves as the popover opens, between Gecko placing it and
  // the stem measuring it, and again once it is placed.
  let moves = 0;
  const move = () => {
    if (moves++ < 2) {
      window.moveBy(0, 40);
    }
  };
  handle.popup.addEventListener("popupshowing", move);
  handle.popup.addEventListener("popuppositioned", move);
  await openPopover(handle, () => handle.openFrom(anchor()));
  // The task asks for the moves and checks the stem whether or not the
  // window manager carries them out.
  await TestUtils.waitForCondition(
    () => moves >= 2,
    "the window asked to move as the popover opens"
  );
  await TestUtils.waitForCondition(
    () =>
      handle.popup.getAttribute("sval-stem") === "placed" &&
      !handle.popup.hasAttribute("sval-stem-pending"),
    "the popover keeps its stem through the move"
  );
  Assert.ok(anchor().hasAttribute("sval-stem"), "grown from its button");
  await closePopover(handle);
});

add_task(async function test_a_measure_taken_mid_move_keeps_the_stem() {
  const handle = made(
    SvalPopover.create(document, { label: "Test", stem: { hang: true } })
  );
  handle.popup.append(body());
  await openPopover(handle, () => handle.openFrom(anchor()));
  const placed = () =>
    handle.popup.getAttribute("sval-stem") === "placed" &&
    !handle.popup.hasAttribute("sval-stem-pending");
  await TestUtils.waitForCondition(placed, "the popover grows its stem");
  // The button stands past the popover's top for one measure, as it does
  // while its window moves and the popover has not yet followed.
  const button = anchor();
  button.style.translate = "0 80px";
  atTaskEnd(() => button.style.removeProperty("translate"));
  handle.popup.dispatchEvent(new Event("popuppositioned"));
  Assert.ok(
    button.hasAttribute("sval-stem"),
    "one measure off its side does not let the button go"
  );
  button.style.removeProperty("translate");
  await TestUtils.waitForCondition(
    placed,
    "the stem grows again once the button is back"
  );
  await closePopover(handle);
});
