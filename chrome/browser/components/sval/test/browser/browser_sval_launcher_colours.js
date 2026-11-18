/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */
/* import-globals-from sval_launcher_home_helpers.js */

/**
 * The Launcher's card wears the colour scheme of the workspace its window
 * shows, on the address bar in place, floating, and under Home's field: the
 * surface the header's popups take, a step off the workspace's tint. It
 * follows the colour as it changes while open, and the workspace as the
 * window switches.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_launcher_home_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { SvalFirefox } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFirefox.sys.mjs"
);
const { SvalColor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalColor.sys.mjs"
);
const { SvalLauncher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLauncher.sys.mjs"
);

add_setup(failOnConsoleErrors);
add_setup(pinsSetup);
add_setup(function () {
  registerCleanupFunction(async () => {
    await within(
      UrlbarTestUtils.promisePopupClose(window),
      10_000,
      "the address bar's view closing"
    );
    gURLBar.handleRevert();
  });
});

/**
 * Gives a workspace a colour and waits until the window wears it, when the
 * window shows that workspace.
 *
 * @param {string} id
 * @param {string|null} color A palette token.
 */
async function colour(id, color) {
  await pinsFixture.engine.mutate({
    kind: "setAppearance",
    id,
    color,
    emoji: null,
    now: Date.now(),
  });
  await SvalPanel.refresh();
  if (SvalWindowWorkspace.of(window).id === id) {
    await TestUtils.waitForCondition(
      () => SvalPanel.windowColor === color,
      `the window wears ${color}`
    );
  }
}

/**
 * A colour as RGBA, painted in this window, so two routes to one colour
 * compare equal.
 *
 * @param {string} value A CSS `<color>`.
 * @returns {object}
 */
function painted(value) {
  const probe = document.createElement("div");
  probe.style.backgroundColor = value;
  document.documentElement.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return InspectorUtils.colorToRGBA(color);
}

/**
 * The card a workspace of colour `token` wears, worked out from its tint
 * alone: the tint a surface step lighter on a dark window, darker on a light
 * one (`--sval-surface`, `sval-tokens.css`).
 *
 * @param {string} token
 * @returns {object}
 */
function expectedCard(token) {
  const dark =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--sval-surface-dark")
      .trim() === "1";
  const tint = SvalColor.css(SvalPanel.windowLookOf(token).tint);
  return painted(`oklch(from ${tint} calc(l ${dark ? "+" : "-"} 0.04) c h)`);
}

/**
 * The open address bar view's card colour.
 *
 * @returns {{card: object}}
 */
function urlbarLook() {
  const card = gURLBar.hasAttribute("sval-launcher-floating")
    ? gURLBar
    : gURLBar.view.panel;
  return {
    card: InspectorUtils.colorToRGBA(getComputedStyle(card).backgroundColor),
  };
}

add_task(async function the_address_bar_wears_its_workspaces_colours() {
  const { home, work } = pinsFixture;
  await colour(home, "green");
  await colour(work, "purple");
  const untinted = painted("var(--sval-palette-ink-850)");

  await within(
    UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: "sval" }),
    10_000,
    "the address bar's view"
  );
  let look = urlbarLook();
  Assert.deepEqual(look.card, expectedCard("green"), "in place, green's card");
  Assert.notDeepEqual(look.card, untinted, "not Sval's navy");

  await colour(home, "orange");
  look = urlbarLook();
  Assert.deepEqual(
    look.card,
    expectedCard("orange"),
    "a colour changed while it is open repaints the card"
  );
  await within(
    UrlbarTestUtils.promisePopupClose(window),
    10_000,
    "the view closing"
  );
  gURLBar.handleRevert();

  // ⌘L's float, after the window switches to the purple workspace.
  Assert.ok(await SvalPanel.switchTo(work), "the window shows Work");
  await TestUtils.waitForCondition(
    () => SvalPanel.windowColor === "purple",
    "the window wears purple"
  );
  const searched = UrlbarTestUtils.promiseSearchComplete(window);
  document.getElementById("Browser:OpenLocation").doCommand();
  await within(searched, 10_000, "the float's rows");
  Assert.ok(SvalLauncher.isFloating(window), "the Launcher floats");
  look = urlbarLook();
  Assert.deepEqual(look.card, expectedCard("purple"), "floating, purple's");
  SvalLauncher.close(window, { focusPage: true });
  await TestUtils.waitForCondition(
    () => !gURLBar.hasAttribute("sval-launcher-floating"),
    "the float returns to the toolbar"
  );
  Assert.ok(await SvalPanel.switchTo(home), "the window shows Home again");
});

add_task(async function homes_card_wears_its_workspaces_colours() {
  const { home } = pinsFixture;
  await colour(home, "green");
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;

  /** The page's card colour, once it shows rows. */
  const homeLook = () =>
    SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      const card = doc.querySelector(".suggestions-card");
      return {
        card: content.getComputedStyle(card).backgroundColor,
        tint: doc.documentElement.getAttribute("data-sval-tint"),
      };
    });

  await typeInHomeField(browser, "sval");
  await TestUtils.waitForCondition(
    async () => !(await homeList(browser)).hidden,
    "the field's list shows"
  );
  let look = await homeLook();
  Assert.deepEqual(
    InspectorUtils.colorToRGBA(look.card),
    expectedCard("green"),
    "green's card, as the address bar's"
  );

  await colour(home, "purple");
  await TestUtils.waitForCondition(async () => {
    look = await homeLook();
    return look.tint === "purple";
  }, "the page wears purple");
  Assert.ok(!(await homeList(browser)).hidden, "the list stayed open");
  Assert.deepEqual(
    InspectorUtils.colorToRGBA(look.card),
    expectedCard("purple"),
    "and its card repaints in purple's"
  );
});
