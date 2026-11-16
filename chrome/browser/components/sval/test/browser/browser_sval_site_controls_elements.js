/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_blocking_helpers.js */
/* import-globals-from sval_element_picker_helpers.js */

// The element picker's entry points: the two pinnable buttons in the site
// controls, the site menu's Elements section, and its list of removal
// rules.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_element_picker_helpers.js",
  this
);

const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SvalBlockingLists } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
);
const { SvalElementPicker, MODE_TOPIC } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalElementPicker.sys.mjs"
);
const { SvalSiteControls, PINS_PREF } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSiteControls.sys.mjs"
);
const { SvalSettingsRegistry } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs"
);
const { ContentBlockingAllowList } = ChromeUtils.importESModule(
  "resource://gre/modules/ContentBlockingAllowList.sys.mjs"
);

const SITE_PAGE =
  "https://example.net/browser/browser/components/sval/test/browser/sval_element_picker.html";
const SITE = "example.net";
const AD = `${SITE}##.sval-test-ad`;
const MISSING = `${SITE}##.sval-test-missing`;
const NETWORK = `||example.org/ads/banner.png$domain=${SITE}`;
const OTHER_SITE_RULE = "example.org##.sval-test-ad";

function byId(id, win = window) {
  return win.document.getElementById(id);
}

function menuIn(win = window) {
  return byId("sval-site-menu", win);
}

async function openMenu(win = window) {
  const shown = BrowserTestUtils.waitForEvent(menuIn(win), "popupshown");
  byId("sval-site-menu-button", win).click();
  await within(shown, 5_000, "the site menu's popupshown");
}

async function closeMenu(win = window) {
  if (menuIn(win).state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(menuIn(win), "popuphidden");
  menuIn(win).hidePopup();
  await within(hidden, 5_000, "the site menu's popuphidden");
}

/**
 * @param {Function} check
 * @param {string} what
 * @returns {Promise<void>} once `check` passes, bounded.
 */
function until(check, what) {
  return within(TestUtils.waitForCondition(check, what), 10_000, what);
}

/**
 * Waits for a window's site controls to know its page.
 *
 * @param {Window} win
 */
function menuReady(win) {
  return within(
    TestUtils.waitForCondition(
      () =>
        !byId("sval-site-menu-button", win).disabled &&
        buttonFor("snip", win).dataset.offer === "ok",
      "the site controls reading the page"
    ),
    10_000,
    "the site controls reading the page"
  );
}

/** @returns {string[]} the modes the pref pins. */
function pinned() {
  return JSON.parse(Services.prefs.getStringPref(PINS_PREF));
}

/**
 * @param {string} mode
 * @param {boolean} on
 */
function pin(mode, on) {
  const pins = new Set(pinned());
  if (on) {
    pins.add(mode);
  } else {
    pins.delete(mode);
  }
  Services.prefs.setStringPref(PINS_PREF, JSON.stringify([...pins]));
}

function buttonFor(mode, win = window) {
  return byId(`sval-${mode}-button`, win);
}

/**
 * The Elements section's row for a mode, in the open menu.
 *
 * @param {string} mode
 * @param {Window} [win]
 */
function rowFor(mode, win = window) {
  return byId(`sval-site-element-${mode}`, win).closest(".sval-site-element");
}

/**
 * @param {"remove"|"snip"} mode
 * @param {Window} [win]
 * @returns {string} Why the site menu's row is off, or "ok".
 */
function offerOf(mode, win = window) {
  return rowFor(mode, win).dataset.offer;
}

/**
 * Sets My filters; the engine rebuilds on its own.
 *
 * @param {string} text
 */
function useFilters(text) {
  SvalBlocking.setMyFilters(text);
}

/**
 * @param {Window} [win]
 * @returns {Element[]} the removal rule rows in the open menu.
 */
function hiddenRows(win = window) {
  return [...menuIn(win).querySelectorAll(".sval-site-hidden-row")];
}

/**
 * Opens the list of removal rules as a user does, so its rows are
 * reachable: a collapsed list is inert.
 *
 * @param {Window} [win]
 */
function openHiddenList(win = window) {
  const toggle = byId("sval-site-hidden-toggle", win);
  if (toggle.getAttribute("aria-expanded") != "true") {
    toggle.click();
  }
  ok(!byId("sval-site-hidden-body", win).inert, "the list takes focus");
}

function rulesShown(win = window) {
  return hiddenRows(win).map(
    row => row.querySelector(".sval-site-hidden-rule").textContent
  );
}

function modeEnded() {
  return within(
    TestUtils.topicObserved(MODE_TOPIC, (s, data) => !data),
    10_000,
    "the mode ending"
  );
}

/**
 * Presses a toolbar button as a key does.
 *
 * @param {Element} button
 */
function pressByKeyboard(button) {
  const command = document.createEvent("xulcommandevent");
  command.initCommandEvent(
    "command",
    true,
    true,
    window,
    0,
    false,
    false,
    false,
    false,
    false,
    null,
    MouseEvent.MOZ_SOURCE_KEYBOARD
  );
  button.dispatchEvent(command);
}

add_setup(async function () {
  keepPrefs(
    PINS_PREF,
    "browser.sval.adblock.",
    "privacy.trackingprotection.",
    "privacy.query_stripping.",
    "browser.contentblocking.category"
  );
  await SpecialPowers.pushPrefEnv({
    set: [...CONTENT_BLOCKING_TEST_PREFS],
    clear: [
      ["browser.sval.adblock.customFrom"],
      ["browser.sval.adblock.myFilters"],
      ["browser.sval.adblock.myFiltersTrustedHere"],
    ],
  });
  await serveLists();
  registerCleanupFunction(async () => {
    SvalBlocking.setLevel("off");
    await IOUtils.remove(SvalBlockingLists.dir, {
      recursive: true,
      ignoreAbsent: true,
    });
  });
  SvalBlocking.setLevel("off");
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  ok(await SvalBlockingLists.update("sval-easylist"), "a list downloads");
  await listsInForce();
  isnot(SvalBlocking.level, "off", "ad blocking is on");
  Services.prefs.clearUserPref(PINS_PREF);
});

add_task(async function by_default_javascript_and_the_snip_button_show() {
  await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
    ok(!byId("sval-javascript-button").hidden, "JavaScript is pinned");
    ok(buttonFor("remove").hidden, "Remove from this site is not pinned");
    ok(!buttonFor("snip").hidden, "Snip is");
    is(buttonFor("snip").dataset.offer, "ok", "and offered");
    is(buttonFor("snip").getAttribute("aria-pressed"), "false");
    ok(buttonFor("colorshift").hidden, "Colorshift is not pinned");
    Assert.strictEqual(
      buttonFor("snip").nextElementSibling,
      buttonFor("colorshift"),
      "Colorshift's place follows Snip"
    );
    Assert.strictEqual(
      buttonFor("colorshift").nextElementSibling,
      byId("sval-site-menu-button"),
      "and comes before the chevron"
    );
    ok(SvalSettingsRegistry.SYNCED_PREFS.includes(PINS_PREF), "the pins sync");
  });
});

add_task(async function pinning_from_the_menu_shows_the_button() {
  atTaskEnd(() => Services.prefs.clearUserPref(PINS_PREF));
  await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
    await openMenu();
    try {
      const pinButton = byId("sval-site-pin-remove");
      is(pinButton.getAttribute("aria-pressed"), "false", "starts unpinned");
      pinButton.click();
      Assert.deepEqual(
        pinned().sort(),
        ["javascript", "remove", "snip"],
        "the pref moved"
      );
      ok(!buttonFor("remove").hidden, "the button shows");
      is(
        byId("sval-site-pin-remove").getAttribute("aria-pressed"),
        "true",
        "the menu shows it pinned"
      );
      is(menuIn().state, "open", "the menu stays open");
      byId("sval-site-pin-remove").click();
      Assert.deepEqual(
        pinned(),
        ["javascript", "snip"],
        "unpinning takes it out"
      );
      ok(buttonFor("remove").hidden, "and the button goes");
      byId("sval-site-pin-snip").click();
      Assert.deepEqual(pinned(), ["javascript"], "Snip can be unpinned too");
      ok(buttonFor("snip").hidden, "and its button goes");
      const javascript = byId("sval-site-pin-javascript");
      is(javascript.getAttribute("aria-pressed"), "true", "JavaScript's pin");
      javascript.click();
      Assert.deepEqual(pinned(), [], "JavaScript can be unpinned");
      ok(buttonFor("javascript").hidden, "and its button goes");
      ok(byId("sval-site-js"), "while its section stays in the menu");
    } finally {
      await closeMenu();
    }
  });
});

add_task(async function unpinning_javascript_hides_its_button() {
  atTaskEnd(() => Services.prefs.clearUserPref(PINS_PREF));
  await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
    ok(!buttonFor("javascript").hidden, "JavaScript shows by default");
    pin("javascript", false);
    await until(() => buttonFor("javascript").hidden, "JavaScript unpinned");
    pin("javascript", true);
    await until(() => !buttonFor("javascript").hidden, "JavaScript pinned");
  });
});

add_task(async function a_pinned_button_starts_the_mode_and_lights() {
  atTaskEnd(() => Services.prefs.clearUserPref(PINS_PREF));
  await BrowserTestUtils.withNewTab(SITE_PAGE, async browser => {
    pin("remove", true);
    for (const mode of ["remove", "snip"]) {
      const button = buttonFor(mode);
      is(button.getAttribute("aria-pressed"), "false", `${mode} starts off`);
      button.click();
      await overlayUntil(browser, s => s?.mode == mode, `${mode}'s overlay`);
      is(SvalElementPicker.active(browser), mode, "the tab is in the mode");
      is(button.getAttribute("aria-pressed"), "true", "the button lights");
      const ended = modeEnded();
      button.click();
      await ended;
      await overlayUntil(browser, s => !s, "the overlay going");
      is(button.getAttribute("aria-pressed"), "false", "and goes out");
    }
  });
});

add_task(async function the_lit_button_follows_the_selected_tab() {
  await BrowserTestUtils.withNewTab(SITE_PAGE, async first => {
    buttonFor("snip").click();
    await overlayUntil(first, s => s?.mode == "snip", "the snip's overlay");
    await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
      is(
        buttonFor("snip").getAttribute("aria-pressed"),
        "false",
        "another tab is not in the mode"
      );
    });
    is(
      buttonFor("snip").getAttribute("aria-pressed"),
      "true",
      "coming back, the tab's mode is lit"
    );
    SvalElementPicker.stop(first);
    await overlayUntil(first, s => !s, "the overlay going");
  });
});

add_task(async function a_menu_row_starts_the_mode_and_closes_the_menu() {
  await BrowserTestUtils.withNewTab(SITE_PAGE, async browser => {
    for (const mode of ["remove", "snip"]) {
      await openMenu();
      const hidden = BrowserTestUtils.waitForEvent(menuIn(), "popuphidden");
      byId(`sval-site-element-${mode}`).click();
      await within(hidden, 5_000, "the menu closing");
      await overlayUntil(browser, s => s?.mode == mode, `${mode}'s overlay`);
      SvalElementPicker.stop(browser);
      await overlayUntil(browser, s => !s, "the overlay going");
    }
  });
});

add_task(async function the_rows_say_what_each_does() {
  await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
    await openMenu();
    try {
      const rows =
        byId("sval-site-elements").querySelectorAll(".sval-site-element");
      Assert.deepEqual(
        [...rows].map(row => [
          row.dataset.mode,
          row.dataset.offer,
          !!row.querySelector(".sval-prot-sub").textContent,
        ]),
        [
          ["remove", "ok", true],
          ["snip", "ok", true],
        ],
        "the Hide row, then Snip, each offered and saying what it does"
      );
      const zoom = menuIn().querySelector(".sval-site-head").nextElementSibling;
      is(zoom.id, "sval-site-zoom-section", "the zoom follows the head");
      is(
        zoom.nextElementSibling.id,
        "sval-site-elements",
        "and the section follows the zoom"
      );
    } finally {
      await closeMenu();
    }
  });
});

add_task(async function a_private_window_turns_off_hide_an_element() {
  atTaskEnd(() => Services.prefs.clearUserPref(PINS_PREF));
  pin("remove", true);
  await inPrivateWindow(SITE_PAGE, async browser => {
    const win = browser.documentGlobal;
    await menuReady(win);
    const button = buttonFor("remove", win);
    is(button.getAttribute("aria-disabled"), "true", "the button is dimmed");
    is(button.dataset.offer, "private", "and says why");
    button.click();
    is(SvalElementPicker.active(browser), null, "a click starts nothing");
    Assert.notEqual(
      buttonFor("snip", win).getAttribute("aria-disabled"),
      "true",
      "Snip stays"
    );
    await openMenu(win);
    try {
      is(
        byId("sval-site-element-remove", win).getAttribute("aria-disabled"),
        "true",
        "the row is dimmed"
      );
      is(offerOf("remove", win), "private", "and says why");
      byId("sval-site-element-remove", win).click();
      is(SvalElementPicker.active(browser), null, "the row starts nothing");
      byId("sval-site-pin-remove", win).click();
      Assert.deepEqual(pinned(), ["javascript", "snip"], "the pin still works");
    } finally {
      await closeMenu(win);
    }
  });
});

add_task(async function remove_stays_offered_where_the_lists_are_off() {
  atTaskEnd(() => Services.prefs.clearUserPref(PINS_PREF));
  pin("remove", true);
  await BrowserTestUtils.withNewTab(SITE_PAGE, async browser => {
    ContentBlockingAllowList.add(browser);
    await SpecialPowers.pushPrefEnv({
      set: [["browser.sval.adblock.level", "off"]],
    });
    try {
      const loaded = BrowserTestUtils.browserLoaded(browser);
      browser.reload();
      await within(loaded, 15_000, "the reload with protections off");
      is(buttonFor("remove").dataset.offer, "ok", "the button is offered");
      ok(!buttonFor("remove").hasAttribute("aria-disabled"), "and not dimmed");
      await openMenu();
      is(offerOf("remove"), "ok", "so is the row");
    } finally {
      await closeMenu();
      await SpecialPowers.popPrefEnv();
      ContentBlockingAllowList.remove(browser);
    }
  });
});

add_task(async function a_page_with_no_site_dims_both_buttons() {
  atTaskEnd(() => Services.prefs.clearUserPref(PINS_PREF));
  pin("remove", true);
  await BrowserTestUtils.withNewTab("about:support", async () => {
    for (const mode of ["remove", "snip"]) {
      is(buttonFor(mode).getAttribute("aria-disabled"), "true");
      is(buttonFor(mode).dataset.offer, "no-site", `${mode} says why`);
    }
  });
});

const PROCEDURAL = `${SITE}##script:has-text(x)`;

add_task(async function hidden_on_this_site_lists_newest_first_collapsed() {
  useFilters([AD, OTHER_SITE_RULE, NETWORK, PROCEDURAL, MISSING].join("\n"));
  try {
    await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
      await openMenu();
      try {
        const toggle = byId("sval-site-hidden-toggle");
        is(toggle.getAttribute("aria-expanded"), "false", "collapsed on open");
        is(
          toggle.querySelector(".sval-site-hidden-count").textContent,
          "4",
          "the pill counts the site's lines"
        );
        ok(toggle.querySelector(".sval-site-hidden-label"), "its label");
        ok(byId("sval-site-hidden-body").inert, "collapsed takes no focus");
        Assert.deepEqual(
          rulesShown(),
          [
            ".sval-test-missing",
            "script:has-text(x)",
            "||example.org/ads/banner.png",
            ".sval-test-ad",
          ],
          "newest first, each without its domain"
        );
        toggle.click();
        is(toggle.getAttribute("aria-expanded"), "true", "it opens");
        ok(!byId("sval-site-hidden-body").inert, "and takes focus");
        is(hiddenRows().length, 4);
        is(
          hiddenRows()[2].querySelector(".sval-site-hidden-rule").title,
          NETWORK,
          "the tooltip is the whole line"
        );
        is(hiddenRows()[2].dataset.kind, "network", "a download's line");
        ok(
          hiddenRows()[2].querySelector(".sval-site-hidden-sub").textContent,
          "says what it stops"
        );
        ok(
          !/\d/.test(byId("sval-site-hidden-manage").textContent),
          "every line is listed, so the link counts none"
        );
      } finally {
        await closeMenu();
      }
    });
  } finally {
    useFilters("");
  }
});

add_task(async function the_menu_scrolls_only_up_and_down() {
  useFilters(AD);
  try {
    await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
      await openMenu();
      try {
        ok(byId("sval-site-hidden-toggle"), "the menu lists the removed");
        const body = menuIn().querySelector(".sval-site-menu");
        Assert.lessOrEqual(
          body.scrollWidth,
          body.clientWidth,
          "nothing reaches past the menu's sides"
        );
      } finally {
        await closeMenu();
      }
    });
  } finally {
    useFilters("");
  }
});

add_task(async function the_menu_opens_collapsed_again() {
  useFilters(AD);
  try {
    await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
      await openMenu();
      byId("sval-site-hidden-toggle").click();
      await closeMenu();
      await openMenu();
      is(
        byId("sval-site-hidden-toggle").getAttribute("aria-expanded"),
        "false",
        "it resets"
      );
      await closeMenu();
    });
  } finally {
    useFilters("");
  }
});

add_task(async function a_site_with_no_rules_has_no_hidden_row() {
  await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
    await openMenu();
    try {
      ok(!byId("sval-site-hidden-toggle"), "no disclosure row");
    } finally {
      await closeMenu();
    }
  });
});

add_task(async function the_header_counts_the_rules_hiding_something_now() {
  atTaskEnd(() => Services.prefs.clearUserPref(PINS_PREF));
  await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
    const menu = byId("sval-site-menu-button");
    ok(!menu.hasAttribute("sval-count"), "a site with no rules counts none");
    // Only AD matches an element of the page: MISSING matches none, the
    // network rule hides no element, and the other site's rule is not here.
    useFilters([AD, MISSING, OTHER_SITE_RULE, NETWORK].join("\n"));
    try {
      await within(
        TestUtils.waitForCondition(
          () => menu.getAttribute("sval-count") == "1",
          "the chevron's count"
        ),
        10_000,
        "the chevron counting the site's rules"
      );
      ok(
        !buttonFor("remove").hasAttribute("sval-count"),
        "Remove is unpinned, so the chevron counts for it"
      );
      pin("remove", true);
      is(
        buttonFor("remove").getAttribute("sval-count"),
        "1",
        "pinned, it counts"
      );
      ok(!menu.hasAttribute("sval-count"), "and the chevron counts none");
    } finally {
      useFilters("");
    }
    await within(
      TestUtils.waitForCondition(
        () => !buttonFor("remove").hasAttribute("sval-count"),
        "no rules, no count"
      ),
      10_000,
      "the count clearing"
    );
  });
});

add_task(async function a_hiding_rule_counts_what_it_hides_on_the_page() {
  useFilters([AD, MISSING].join("\n"));
  try {
    await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
      await openMenu();
      try {
        const subs = () => hiddenRows().map(r => r.dataset.matches);
        await within(
          TestUtils.waitForCondition(
            () => subs().every(Boolean),
            "the counts arriving"
          ),
          10_000,
          "the counts"
        );
        Assert.deepEqual(subs(), ["0", "1"]);
        ok(
          hiddenRows().every(
            r => r.querySelector(".sval-site-hidden-sub").textContent
          ),
          "each row says its count"
        );
      } finally {
        await closeMenu();
      }
    });
  } finally {
    useFilters("");
  }
});

add_task(async function show_again_takes_the_line_out() {
  useFilters([AD, NETWORK].join("\n"));
  try {
    await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
      await openMenu();
      try {
        openHiddenList();
        const button = hiddenRows()[0].querySelector(".sval-site-hidden-show");
        ok(button.title, "the button has a tooltip");
        Assert.stringContains(
          button.getAttribute("aria-label"),
          "||example.org/ads/banner.png",
          "and names the line it shows again"
        );
        button.click();
        is(SvalBlocking.myFilters, AD, "only that line went");
        Assert.deepEqual(rulesShown(), [".sval-test-ad"], "and the list");
        is(
          byId("sval-site-hidden-toggle").querySelector(
            ".sval-site-hidden-count"
          ).textContent,
          "1"
        );
      } finally {
        await closeMenu();
      }
    });
  } finally {
    useFilters("");
  }
});

add_task(async function a_shared_line_loses_only_this_site() {
  useFilters(`${SITE},example.org##.sval-test-ad`);
  try {
    await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
      await openMenu();
      try {
        openHiddenList();
        hiddenRows()[0].querySelector(".sval-site-hidden-show").click();
        is(SvalBlocking.myFilters, "example.org##.sval-test-ad");
      } finally {
        await closeMenu();
      }
    });
  } finally {
    useFilters("");
  }
});

add_task(async function show_again_reloads_the_tab_with_it_back() {
  useFilters("");
  try {
    await BrowserTestUtils.withNewTab(SITE_PAGE, async browser => {
      await within(
        SvalElementPicker.start(browser, "remove"),
        10_000,
        "the picker starting"
      );
      await overlayUntil(browser, s => s?.bar, "the pointing bar");
      await BrowserTestUtils.synthesizeMouseAtCenter("#ad", {}, browser);
      await overlayUntil(browser, s => s?.card, "the card");
      await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
      await overlayUntil(browser, s => s?.toast, "the toast");
      await within(
        TestUtils.waitForCondition(
          async () => (await displayOf(browser, "ad")) == "none",
          "the element hidden"
        ),
        10_000,
        "the element hidden"
      );
      await openMenu();
      try {
        openHiddenList();
        const loaded = BrowserTestUtils.browserLoaded(browser);
        hiddenRows()[0].querySelector(".sval-site-hidden-show").click();
        await within(loaded, 10_000, "the tab reloading");
        await within(
          TestUtils.waitForCondition(
            async () => (await displayOf(browser, "ad")) != "none",
            "the element shown again"
          ),
          10_000,
          "the element shown again"
        );
      } finally {
        await closeMenu();
      }
    });
  } finally {
    useFilters("");
  }
});

add_task(async function a_private_window_lists_rules_without_buttons() {
  useFilters(AD);
  try {
    await inPrivateWindow(SITE_PAGE, async browser => {
      const win = browser.documentGlobal;
      await menuReady(win);
      await openMenu(win);
      try {
        is(hiddenRows(win).length, 1, "the rule is listed");
        ok(
          !menuIn(win).querySelector(".sval-site-hidden-show"),
          "with no way to remove it"
        );
      } finally {
        await closeMenu(win);
      }
    });
  } finally {
    useFilters("");
  }
});

add_task(async function more_than_six_rules_link_to_settings() {
  const lines = Array.from({ length: 8 }, (_, i) => `${SITE}##.rule-${i}`);
  useFilters(lines.join("\n"));
  try {
    await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
      await openMenu();
      try {
        is(hiddenRows().length, 6, "six rows");
        is(rulesShown()[0], ".rule-7", "the newest first");
        is(
          byId("sval-site-hidden-toggle").querySelector(
            ".sval-site-hidden-count"
          ).textContent,
          "8",
          "the pill counts them all"
        );
        Assert.stringContains(
          byId("sval-site-hidden-manage").textContent,
          "8",
          "the link counts every line"
        );
      } finally {
        await closeMenu();
      }
    });
  } finally {
    useFilters("");
  }
});

add_task(async function a_moved_tab_ends_its_mode() {
  await BrowserTestUtils.withNewTab(SITE_PAGE, async browser => {
    const tab = gBrowser.getTabForBrowser(browser);
    await within(
      SvalElementPicker.start(browser, "snip"),
      10_000,
      "the snip starting"
    );
    await overlayUntil(browser, s => s?.bar, "the pointing bar");
    const opened = BrowserTestUtils.waitForNewWindow();
    const win = gBrowser.replaceTabWithWindow(tab);
    const moved = await within(opened, 15_000, "the window opening");
    try {
      is(moved, win, "the tab has its own window");
      await until(
        () => SvalElementPicker.active(browser) === null,
        "the old browser's mode ending"
      );
      const adopted = moved.gBrowser.selectedBrowser;
      is(SvalElementPicker.active(adopted), null, "the new one has no mode");
      is(
        buttonFor("snip", moved).getAttribute("aria-pressed"),
        "false",
        "its button is not lit"
      );
      await overlayUntil(adopted, s => !s, "the overlay going");
    } finally {
      await within(
        BrowserTestUtils.closeWindow(moved),
        10_000,
        "the moved tab's window closing"
      );
    }
  });
});

add_task(
  async function leaving_with_the_keyboard_returns_focus_to_the_button() {
    await BrowserTestUtils.withNewTab(SITE_PAGE, async browser => {
      const button = buttonFor("snip");
      // A headless window grants no focus to a toolbar button, so the button
      // is asked and the ask is recorded.
      const asked = [];
      button.focus = () => asked.push("focus");
      try {
        const press = () => pressByKeyboard(button);
        press();
        await overlayUntil(browser, s => s?.mode == "snip", "the overlay");
        let ended = modeEnded();
        SvalElementPicker.stop(browser);
        await ended;
        Assert.deepEqual(
          asked,
          ["focus"],
          "leaving gives the button the focus"
        );

        button.click();
        await overlayUntil(browser, s => s?.mode == "snip", "the overlay");
        ended = modeEnded();
        SvalElementPicker.stop(browser);
        await ended;
        Assert.deepEqual(asked, ["focus"], "a mouse press asks nothing");
      } finally {
        delete button.focus;
      }
    });
  }
);

add_task(async function switching_modes_by_keyboard_keeps_the_focus_return() {
  SvalSiteControls.setPinned("remove", true);
  SvalSiteControls.setPinned("snip", true);
  await BrowserTestUtils.withNewTab(SITE_PAGE, async browser => {
    const picker = buttonFor("remove");
    const snip = buttonFor("snip");
    const asked = [];
    picker.focus = () => asked.push("remove");
    snip.focus = () => asked.push("snip");
    try {
      pressByKeyboard(picker);
      await overlayUntil(browser, s => s?.mode == "remove", "the picker");
      pressByKeyboard(snip);
      await overlayUntil(browser, s => s?.mode == "snip", "the snip");
      Assert.deepEqual(asked, [], "switching returns the focus to no one");
      const ended = modeEnded();
      SvalElementPicker.stop(browser);
      await ended;
      Assert.deepEqual(
        asked,
        ["snip"],
        "leaving the second mode gives its button the focus"
      );
    } finally {
      delete picker.focus;
      delete snip.focus;
    }
  });
});

add_task(async function removing_a_rule_keeps_the_keyboard_in_the_list() {
  useFilters(
    [`${SITE}##.rule-0`, `${SITE}##.rule-1`, `${SITE}##.rule-2`].join("\n")
  );
  try {
    await BrowserTestUtils.withNewTab(SITE_PAGE, async () => {
      await openMenu();
      try {
        byId("sval-site-hidden-toggle").click();
        const focused = () => menuIn().querySelector(":focus")?.id;
        // Newest first: rule-2, rule-1, rule-0.
        byId("sval-site-hidden-show-1").focus();
        byId("sval-site-hidden-show-1").click();
        is(
          focused(),
          "sval-site-hidden-show-1",
          "the next row's button takes the focus"
        );
        Assert.deepEqual(rulesShown(), [".rule-2", ".rule-0"]);
        byId("sval-site-hidden-show-1").click();
        is(
          focused(),
          "sval-site-hidden-show-0",
          "the last row hands it to the one before"
        );
        byId("sval-site-hidden-show-0").click();
        ok(!byId("sval-site-hidden-toggle"), "the list is gone");
      } finally {
        await closeMenu();
      }
    });
  } finally {
    useFilters("");
  }
});
