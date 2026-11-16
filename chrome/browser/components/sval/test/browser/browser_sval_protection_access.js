/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The protection panel for keyboard and screen-reader users: where the
 * focus goes as it opens and closes, what the button and the panel's
 * controls expose, its radio groups' keys, and its switches' contrast.
 */

const { SvalSiteProtections, SITE_BRANCH } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
);

const accService = Cc["@mozilla.org/accessibilityService;1"].getService(
  Ci.nsIAccessibilityService
);

const PROT_PAGE = "https://example.com/";
const PROT_SITE = "example.com";

function button() {
  return document.getElementById("sval-protection-button");
}

/**
 * @param {nsIAccessible} acc
 * @param {number} state An `nsIAccessibleStates` flag.
 * @returns {boolean}
 */
function has(acc, state) {
  const s = {};
  acc.getState(s, {});
  return !!(s.value & state);
}

/** Opens the panel as a keyboard user does, from the focused button. */
async function openByKey() {
  const shown = BrowserTestUtils.waitForEvent(panelIn(), "popupshown");
  button().focus();
  EventUtils.synthesizeKey("KEY_Enter");
  await within(shown, 5_000, "the protection panel's popupshown");
  return panelIn();
}

async function closePanel() {
  const panel = panelIn();
  if (panel.state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.hidePopup();
  await within(hidden, 5_000, "the protection panel's popuphidden");
}

function reset() {
  Services.prefs.clearUserPref(SITE_BRANCH + PROT_SITE);
  Services.perms.removeAll();
}

add_setup(() => {
  registerCleanupFunction(reset);
});

add_task(async function the_keyboard_goes_into_the_panel_and_back() {
  reset();
  await BrowserTestUtils.withNewTab(PROT_PAGE, async () => {
    const buttonAcc = await accessibleOf(button());
    // The accessible can exist before the button shows for the new tab;
    // its state follows once it does.
    await TestUtils.waitForCondition(
      () => has(buttonAcc, Ci.nsIAccessibleStates.STATE_COLLAPSED),
      "the button says its panel is closed"
    );

    const panel = await openByKey();
    Assert.equal(
      document.activeElement,
      panel.querySelector("#sval-prot-conn"),
      "the focus lands on the panel's first control, the connection line"
    );
    Assert.ok(
      has(buttonAcc, Ci.nsIAccessibleStates.STATE_EXPANDED),
      "the button says its panel is open"
    );

    const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
    EventUtils.synthesizeKey("KEY_Escape");
    await within(hidden, 5_000, "Escape closing the panel");
    Assert.equal(
      document.activeElement,
      button(),
      "Escape gives the focus back to the button"
    );
    Assert.ok(
      has(buttonAcc, Ci.nsIAccessibleStates.STATE_COLLAPSED),
      "and the button says the panel is closed"
    );
  });
});

add_task(async function sections_are_headed_groups() {
  reset();
  await BrowserTestUtils.withNewTab(PROT_PAGE, async () => {
    const panel = await openByKey();
    for (const section of [".sval-prot-rows", ".sval-prot-site"]) {
      const heading = panel.querySelector(`${section} h2`);
      const acc = await accessibleOf(heading);
      Assert.equal(acc.role, Ci.nsIAccessibleRole.ROLE_HEADING, section);
      Assert.equal(
        acc.name,
        heading.textContent,
        "named as written, not in capitals"
      );
    }
    const group = panel.querySelector(".sval-prot-site");
    const site = await accessibleOf(group);
    Assert.equal(site.role, Ci.nsIAccessibleRole.ROLE_GROUPING);
    Assert.equal(
      site.name,
      group.querySelector("h2").textContent,
      "named by its heading"
    );
    Assert.equal(
      site.description,
      group.querySelector(".sval-prot-label-note").textContent,
      "described by its note"
    );
    await closePanel();
  });
});

add_task(async function a_switch_keeps_the_focus_over_its_reload() {
  reset();
  await BrowserTestUtils.withNewTab(PROT_PAGE, async browser => {
    const panel = await openByKey();
    const main = panel.querySelector("#sval-prot-main");
    const line = main
      .closest(".sval-prot-switch-row")
      .querySelector(".sval-prot-sub");
    Assert.ok(line.textContent, "the switch has a line under it");
    Assert.equal(
      (await accessibleOf(main)).description,
      line.textContent,
      "the switch is described by the line under it"
    );
    main.focus();
    const reloaded = BrowserTestUtils.browserLoaded(browser);
    EventUtils.synthesizeKey(" ");
    await within(reloaded, 15_000, "the reload after protections off");
    await TestUtils.waitForCondition(
      () =>
        panel.querySelector("#sval-prot-main")?.getAttribute("aria-checked") ===
        "false",
      "the panel shows protections off"
    );
    Assert.equal(
      document.activeElement,
      panel.querySelector("#sval-prot-main"),
      "the focus is still on the switch"
    );

    const fp = await accessibleOf(panel.querySelector("#sval-prot-fp"));
    Assert.ok(
      has(fp, Ci.nsIAccessibleStates.STATE_UNAVAILABLE),
      "fingerprinting reads as unavailable while protections are off"
    );
    Assert.ok(
      has(fp, Ci.nsIAccessibleStates.STATE_FOCUSABLE),
      "and stays reachable"
    );

    const back = BrowserTestUtils.browserLoaded(browser);
    EventUtils.synthesizeKey(" ");
    await within(back, 15_000, "the reload after protections back on");
    await closePanel();
  });
  reset();
});

add_task(async function an_off_switch_can_be_seen() {
  reset();
  SvalSiteProtections.setProtections(PROT_SITE, "off");
  for (const dark of [0, 1]) {
    await SpecialPowers.pushPrefEnv({
      set: [["ui.systemUsesDarkTheme", dark]],
    });
    await TestUtils.waitForCondition(
      () => matchMedia("(prefers-color-scheme: dark)").matches === !!dark,
      "the theme changes"
    );
    await BrowserTestUtils.withNewTab(PROT_PAGE, async () => {
      const shown = BrowserTestUtils.waitForEvent(panelIn(), "popupshown");
      button().click();
      await within(shown, 5_000, "the protection panel's popupshown");
      const main = panelIn().querySelector("#sval-prot-main");
      Assert.equal(main.getAttribute("aria-checked"), "false");
      const popup = getComputedStyle(panelIn()).getPropertyValue(
        "--panel-background-color"
      );
      // Off is an outline around a knob on the panel (header signals spec
      // §1), so both are read against the panel.
      const outline =
        getComputedStyle(main).boxShadow.match(/rgba?\([^)]*\)/)?.[0];
      const knob = getComputedStyle(main, "::after").backgroundColor;
      const theme = dark ? "dark" : "light";
      Assert.ok(outline, "the off track has an outline");
      Assert.greaterOrEqual(
        contrastRatio(outline, popup),
        3,
        `the off track's outline stands out from the ${theme} panel`
      );
      Assert.greaterOrEqual(
        contrastRatio(knob, popup),
        3,
        `the knob stands out from the ${theme} panel`
      );
      await closePanel();
    });
    await SpecialPowers.popPrefEnv();
  }
  reset();
});
