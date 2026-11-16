/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_blocking_helpers.js */
/* import-globals-from sval_element_picker_helpers.js */

// The element picker's parent side (element picker spec §2, §3): where Hide an
// element is offered, the rules a save writes into My filters and Undo takes
// out again, and the mode a tab is in. The test calls the parent actor as its
// child does.

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

const PICKER_PAGE =
  "https://example.net/browser/browser/components/sval/test/browser/sval_element_picker.html";
const SAVE = "SvalElementPicker:Save";
const UNDO = "SvalElementPicker:Undo";
const HIDE_AD = "example.net##.sval-test-ad";
const BLOCK_IMAGE = "||example.org/ads/banner.png$domain=example.net";
const IMAGE_URL = "https://example.org/ads/banner.png?size=2#top";
// The longest string the pref store takes (`MAX_PREF_LENGTH`).
const PREF_LIMIT = 1024 * 1024;

/**
 * What the child's messages reach: the tab's parent actor.
 *
 * @param {Element} browser
 * @returns {JSWindowActorParent}
 */
function actorOf(browser) {
  return browser.browsingContext.currentWindowGlobal.getActor(
    "SvalElementPicker"
  );
}

/**
 * Sends the actor a message as its child does.
 *
 * @param {Element} browser
 * @param {string} name
 * @param {object} [data]
 * @returns {*} the actor's answer.
 */
function send(browser, name, data) {
  return actorOf(browser).receiveMessage({ name, data });
}

/**
 * Puts the tab in the picker and sends a Save, as the child does while the
 * user has the picker open. The picker stays on if the save is refused.
 *
 * @param {Element} browser
 * @param {object} data The Save message's data.
 * @param {boolean} [start] Whether to start the picker first.
 * @returns {Promise<object>} the parent's answer.
 */
async function saveFrom(browser, data, start = true) {
  if (start && SvalElementPicker.active(browser) != "remove") {
    await within(
      SvalElementPicker.start(browser, "remove"),
      10_000,
      "the picker starting"
    );
  }
  return send(browser, SAVE, data);
}

/** @returns {string} the user's My filters. */
function filters() {
  return SvalBlocking.myFilters;
}

/**
 * Reloads the selected tab, which is how a site's protection exception takes
 * effect on its page.
 */
async function reload() {
  await within(
    BrowserTestUtils.reloadTab(gBrowser.selectedTab),
    15_000,
    "the page reloading"
  );
}

add_setup(async function () {
  keepPrefs(
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
});

add_task(async function the_pins_default_to_javascript_and_the_snip() {
  is(
    Services.prefs.getDefaultBranch("").getStringPref(PINS_PREF),
    '["javascript","snip"]',
    "JavaScript and Snip are pinned and Remove from this site is not"
  );
  ok(SvalSettingsRegistry.SYNCED_PREFS.includes(PINS_PREF), "the pins sync");
});

add_task(async function a_website_offers_the_picker() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    is(SvalElementPicker.offers(browser).remove, "ok", "the picker is offered");
    is(SvalElementPicker.offers(browser).snip, "ok", "so is the snip");
  });
});

add_task(async function a_page_without_a_site_offers_neither() {
  await BrowserTestUtils.withNewTab("about:blank", async browser => {
    is(
      SvalElementPicker.offers(browser).remove,
      "no-site",
      "about:blank has no site"
    );
    is(SvalElementPicker.offers(browser).snip, "no-site", "no snip either");
  });
  await BrowserTestUtils.withNewTab("about:support", async browser => {
    is(
      SvalElementPicker.offers(browser).remove,
      "no-site",
      "an about: page has no site"
    );
    is(SvalElementPicker.offers(browser).snip, "no-site", "no snip there");
  });
});

add_task(async function a_private_window_offers_the_snip_only() {
  await inPrivateWindow(PICKER_PAGE, async browser => {
    is(
      SvalElementPicker.offers(browser).remove,
      "private",
      "the picker saves a rule, which a private window does not"
    );
    is(SvalElementPicker.offers(browser).snip, "ok", "the snip is offered");
  });
});

add_task(async function the_picker_stays_where_the_lists_are_off() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    ContentBlockingAllowList.add(browser);
    try {
      await reload();
      is(
        SvalElementPicker.offers(browser).remove,
        "ok",
        "My filters apply with the site's protections off"
      );
    } finally {
      ContentBlockingAllowList.remove(browser);
    }
  });
});

add_task(async function a_save_writes_the_hiding_rule() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    const before = filters();
    Assert.deepEqual(
      await saveFrom(browser, { selector: ".sval-test-ad" }),
      { ok: true, lines: [HIDE_AD] },
      "the rule is for the parent's site"
    );
    is(filters(), HIDE_AD, "it is in My filters");
    await send(browser, UNDO, { lines: [HIDE_AD] });
    is(filters(), before, "undo takes it out");
  });
});

add_task(async function a_save_with_a_url_writes_the_network_rule_after() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    const before = filters();
    const answer = await saveFrom(browser, {
      selector: ".sval-test-ad",
      url: IMAGE_URL,
    });
    Assert.deepEqual(
      answer,
      { ok: true, lines: [HIDE_AD, BLOCK_IMAGE] },
      "two lines, the hiding rule first"
    );
    is(filters(), `${HIDE_AD}\n${BLOCK_IMAGE}`, "both are in My filters");
    await send(browser, UNDO, { lines: answer.lines });
    is(filters(), before, "undo takes out both");
  });
});

add_task(async function a_save_takes_the_host_or_the_site_and_nothing_else() {
  const page = PICKER_PAGE.replace(
    "https://example.net",
    "https://test1.example.com"
  );
  await BrowserTestUtils.withNewTab(page, async browser => {
    const before = filters();
    let answer = await saveFrom(browser, {
      selector: ".sval-test-ad",
      url: IMAGE_URL,
      scope: "test1.example.com",
    });
    Assert.deepEqual(
      answer,
      {
        ok: true,
        lines: [
          "test1.example.com##.sval-test-ad",
          "||example.org/ads/banner.png$domain=test1.example.com",
        ],
      },
      "a save for the host names the host"
    );
    await send(browser, UNDO, { lines: answer.lines });

    answer = await saveFrom(browser, {
      selector: ".sval-test-ad",
      scope: "example.com",
    });
    Assert.deepEqual(
      answer.lines,
      ["example.com##.sval-test-ad"],
      "a save for the site names the site"
    );
    await send(browser, UNDO, { lines: answer.lines });

    for (const scope of ["test2.example.com", "example.org", "com", 7]) {
      Assert.deepEqual(
        await saveFrom(browser, { selector: ".sval-test-ad", scope }),
        { ok: false, error: "invalid" },
        `a scope the page is not on is refused: ${scope}`
      );
    }
    is(filters(), before, "nothing else was written");
    SvalElementPicker.stop(browser);
  });
});

add_task(async function a_url_without_a_narrow_rule_saves_the_hiding_rule() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    const answer = await saveFrom(browser, {
      selector: ".sval-test-ad",
      url: "https://example.org/",
    });
    Assert.deepEqual(answer.lines, [HIDE_AD], "a site's root address is not");
    await send(browser, UNDO, { lines: answer.lines });
  });
});

add_task(async function a_url_on_the_page_s_own_site_is_refused() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    Assert.deepEqual(
      await saveFrom(browser, {
        selector: ".sval-test-ad",
        url: "https://www.example.net/ads/banner.png",
      }),
      { ok: false, error: "invalid" },
      "the engine would never block it"
    );
    is(filters(), "", "nothing was written");
    SvalElementPicker.stop(browser);
  });
});

add_task(async function a_save_appends_to_what_is_there() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    SvalBlocking.setMyFilters(`${HIDE_AD}\nexample.org##.other\n`);
    const answer = await saveFrom(browser, { selector: ".sval-test-ad" });
    is(
      filters(),
      `${HIDE_AD}\nexample.org##.other\n${HIDE_AD}`,
      "the rule goes after the user's lines, My filters read at save time"
    );
    await send(browser, UNDO, { lines: answer.lines });
    is(
      filters(),
      `${HIDE_AD}\nexample.org##.other`,
      "undo takes the last occurrence, so the user's own line stays"
    );
    SvalBlocking.setMyFilters("");
  });
});

add_task(async function undo_takes_out_only_what_was_saved() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    SvalBlocking.setMyFilters("example.org##.theirs");
    await send(browser, UNDO, { lines: ["example.org##.theirs"] });
    is(
      filters(),
      "example.org##.theirs",
      "a line the picker did not save stays"
    );
    SvalBlocking.setMyFilters("");
  });
});

add_task(async function a_selector_that_is_not_plain_css_is_refused() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    for (const selector of [
      ".a{display:block}",
      ".a}",
      ".a\n.b",
      ".a\r.b",
      ".a/*",
      "*/.a",
      "",
      "   ",
      42,
      null,
      "+js(trusted-set-cookie, a, b)",
      "^script",
      "div:has-text(x)",
      "div:style(color: red)",
      "div:remove()",
      "div:xpath(//a)",
      "div:matches-css(display: block)",
      "a[",
      "x".repeat(1025),
    ]) {
      Assert.deepEqual(
        await saveFrom(browser, { selector }),
        { ok: false, error: "invalid" },
        `${JSON.stringify(selector)?.slice(0, 40)} is refused`
      );
    }
    Assert.deepEqual(
      await saveFrom(browser, {
        selector: ".sval-test-ad",
        url: `https://example.net/${"a".repeat(2048)}`,
      }),
      { ok: false, error: "invalid" },
      "an address past 2048 characters is refused"
    );
    is(filters(), "", "nothing was written");
    is(SvalElementPicker.active(browser), "remove", "the picker stays on");
    SvalElementPicker.stop(browser);
  });
});

add_task(async function a_selector_of_plain_css_is_saved_as_given() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    const selector = 'div > .a:not(.b), [data-x="1"] + p:nth-of-type(2)';
    const answer = await saveFrom(browser, { selector });
    Assert.deepEqual(answer, { ok: true, lines: [`example.net##${selector}`] });
    await send(browser, UNDO, { lines: answer.lines });
    is(filters(), "", "undo takes it out");
  });
});

add_task(async function a_save_ends_the_picker() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    const ended = within(
      TestUtils.topicObserved(MODE_TOPIC, (s, data) => !data),
      10_000,
      "the mode ending"
    );
    const answer = await saveFrom(browser, { selector: ".sval-test-ad" });
    ok(answer.ok, "the rule is saved");
    await ended;
    is(SvalElementPicker.active(browser), null, "the picker is off");
    Assert.deepEqual(
      await send(browser, SAVE, { selector: ".sval-test-ad" }),
      { ok: false, error: "unavailable" },
      "a second save in the session is refused"
    );
    is(filters(), HIDE_AD, "one rule was written");
    await send(browser, UNDO, { lines: answer.lines });
    is(filters(), "", "the toast's undo still works");
  });
});

add_task(async function a_save_needs_the_picker_running_on_that_actor() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    Assert.deepEqual(
      await saveFrom(browser, { selector: ".sval-test-ad" }, false),
      { ok: false, error: "unavailable" },
      "a tab not in the picker refuses"
    );
    await within(
      SvalElementPicker.start(browser, "snip"),
      10_000,
      "the snip starting"
    );
    Assert.deepEqual(
      await saveFrom(browser, { selector: ".sval-test-ad" }, false),
      { ok: false, error: "unavailable" },
      "the snip saves nothing"
    );
    ok(
      !SvalElementPicker.isRunning(browser, {}, "snip"),
      "another actor does not run the tab's mode"
    );
    SvalElementPicker.stop(browser);
    is(filters(), "", "nothing was written");
  });
});

add_task(async function a_save_past_the_pref_limit_is_too_large() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    const full = "!".repeat(PREF_LIMIT - 10);
    SvalBlocking.setMyFilters(full);
    Assert.deepEqual(
      await saveFrom(browser, { selector: ".sval-test-ad" }),
      { ok: false, error: "too-large" },
      "the pref store's limit is reported"
    );
    is(filters(), full, "nothing changed");
    SvalBlocking.setMyFilters("");
  });
});

add_task(async function a_save_in_a_private_window_is_refused() {
  await inPrivateWindow(PICKER_PAGE, async browser => {
    Assert.deepEqual(
      await send(browser, SAVE, { selector: ".sval-test-ad" }),
      { ok: false, error: "unavailable" },
      "the picker is off there"
    );
    is(filters(), "", "nothing was written");
  });
});

add_task(async function a_save_on_a_site_with_protections_off_is_refused() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    ContentBlockingAllowList.add(browser);
    try {
      await reload();
      Assert.deepEqual(
        await send(browser, SAVE, { selector: ".sval-test-ad" }),
        { ok: false, error: "unavailable" },
        "the rule would not run there"
      );
    } finally {
      ContentBlockingAllowList.remove(browser);
    }
    is(filters(), "", "nothing was written");
  });
});

add_task(async function a_tab_is_in_one_mode_at_a_time() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    const seen = [];
    const observer = (subject, topic, data) => {
      is(subject, browser, "the browser is the subject");
      seen.push(data);
    };
    Services.obs.addObserver(observer, MODE_TOPIC);
    try {
      is(SvalElementPicker.active(browser), null, "no mode at first");
      await within(
        SvalElementPicker.start(browser, "remove"),
        10_000,
        "the picker starting"
      );
      is(SvalElementPicker.active(browser), "remove", "the picker is on");
      await within(
        SvalElementPicker.start(browser, "snip"),
        10_000,
        "the snip starting"
      );
      is(SvalElementPicker.active(browser), "snip", "the snip replaces it");
      SvalElementPicker.stop(browser);
      is(SvalElementPicker.active(browser), null, "stop leaves the mode");
      Assert.deepEqual(
        seen,
        ["remove", "", "snip", ""],
        "each change is announced, the mode or empty"
      );

      await within(
        SvalElementPicker.start(browser, "remove"),
        10_000,
        "the picker starting again"
      );
      await send(browser, "SvalElementPicker:Ended", {
        mode: "remove",
        saved: false,
      });
      is(SvalElementPicker.active(browser), null, "the child ends the mode");
    } finally {
      Services.obs.removeObserver(observer, MODE_TOPIC);
      SvalElementPicker.stop(browser);
    }
  });
});

add_task(async function navigating_ends_the_mode() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    await within(
      SvalElementPicker.start(browser, "snip"),
      10_000,
      "the snip starting"
    );
    const ended = within(
      TestUtils.topicObserved(MODE_TOPIC, (s, data) => !data),
      10_000,
      "the mode ending"
    );
    BrowserTestUtils.startLoadingURIString(browser, "about:blank");
    await ended;
    is(SvalElementPicker.active(browser), null, "the document took it along");
  });
});

add_task(async function the_snip_works_where_the_picker_does_not() {
  await inPrivateWindow(PICKER_PAGE, async browser => {
    await Assert.rejects(
      SvalElementPicker.start(browser, "remove"),
      /unavailable/,
      "the picker does not start in a private window"
    );
    is(SvalElementPicker.active(browser), null, "and leaves no mode");
    await within(
      SvalElementPicker.start(browser, "snip"),
      10_000,
      "the snip starting"
    );
    is(SvalElementPicker.active(browser), "snip", "the snip does");
    SvalElementPicker.stop(browser);
  });
});

add_task(async function ad_blocking_off_keeps_the_picker() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    SvalBlocking.setLevel("off");
    try {
      is(
        SvalElementPicker.offers(browser).remove,
        "ok",
        "My filters apply with ad blocking Off"
      );
      Assert.deepEqual(
        await saveFrom(browser, { selector: ".sval-test-ad" }),
        { ok: true, lines: [HIDE_AD] },
        "a save is written"
      );
      await send(browser, UNDO, { lines: [HIDE_AD] });
    } finally {
      SvalElementPicker.stop(browser);
      // Ad blocking back on, as the file's setup turned it on.
      SvalBlocking.setListEnabled("sval-easylist", true);
      SvalBlocking.flush();
      await listsInForce();
    }
  });
});

// The overlay the child draws (element picker design round 3: Pointing bar,
// Card, After saving, Keyboard).

// The image is another site's: the classifier leaves a page's requests to its
// own site alone (`ContentClassifierEngine::CheckNetworkRequest`).
const IMAGE_SJS =
  "https://example.org/browser/browser/components/sval/test/browser/sval_element_picker_image.sjs";
const HIDE_IMAGE = "example.net###image";
const BLOCK_IMAGE_SJS =
  "||example.org/browser/browser/components/sval/test/browser/sval_element_picker_image.sjs$domain=example.net";

/**
 * Starts the picker and waits for its bar.
 *
 * @param {Element} browser
 * @returns {Promise<object>} the overlay's state.
 */
async function startPicking(browser) {
  await within(
    SvalElementPicker.start(browser, "remove"),
    10_000,
    "the picker starting"
  );
  return overlayUntil(browser, s => s?.bar, "the pointing bar");
}

/**
 * Points at an element of the page and clicks it.
 *
 * @param {Element} browser
 * @param {string} selector
 * @returns {Promise<object>} the overlay's state with its card.
 */
async function choose(browser, selector) {
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, {}, browser);
  return overlayUntil(browser, s => s?.card, "the card");
}

/** @returns {Promise<number>} how many times the test image was requested. */
async function imageRequests() {
  return Number(await (await fetch(`${IMAGE_SJS}?count`)).text());
}

add_task(async function starting_the_picker_draws_over_the_page() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    const count = () =>
      SpecialPowers.spawn(
        browser,
        [],
        () => content.document.querySelectorAll("*").length
      );
    const before = await count();
    is(await overlayState(browser), null, "no overlay before the picker");
    const state = await startPicking(browser);
    ok(state.bar, "the bar says what to do");
    is(state.mode, "remove", "for removing");
    ok(!state.card, "no card while pointing");
    is(await count(), before, "the page's own tree is unchanged");
    is(
      state.reducedMotion,
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      "motion as the chrome asks"
    );
    is(
      state.scheme,
      window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark",
      "and the chrome's colour scheme"
    );
    SvalElementPicker.stop(browser);
    await overlayUntil(browser, s => !s, "the overlay going on Stop");
  });
});

add_task(async function choosing_an_element_shows_the_card() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    await startPicking(browser);
    let state = await choose(browser, "#ad");
    Assert.stringContains(
      state.title,
      "example.net",
      "the card names the site"
    );
    is(state.matches, 1, "one element matches");
    is(state.selector, ".sval-test-ad", "the selector is its class");
    Assert.deepEqual(state.rules, [HIDE_AD], "the rule is shown");
    is(state.download, null, "a box has no download to stop");
    is(state.focused, "hide", "focus starts on Hide");

    await BrowserTestUtils.synthesizeKey("KEY_ArrowUp", {}, browser);
    state = await overlayUntil(
      browser,
      s => s.selector == ".sval-test-rail",
      "one stop wider"
    );
    is(state.matches, 2, "the count follows");
    await BrowserTestUtils.synthesizeKey("KEY_ArrowDown", {}, browser);
    await overlayUntil(
      browser,
      s => s.selector == ".sval-test-ad",
      "one stop narrower"
    );
    is(filters(), "", "nothing is written before Hide");
    SvalElementPicker.stop(browser);
    await overlayUntil(browser, s => !s, "the overlay going on Stop");
  });
});

add_task(async function the_outline_follows_the_pointer_and_the_page() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    await startPicking(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#ad",
      { type: "mousemove" },
      browser
    );
    const state = await overlayUntil(
      browser,
      s => s.labelElement == "div" && s.labelSize == "200 × 100",
      "the outline on the box"
    );
    await SpecialPowers.spawn(browser, [], () => content.scrollBy(0, 30));
    const top = parseFloat(state.outlineTop);
    Assert.greater(top, 30, "the box starts below the scroll");
    await overlayUntil(
      browser,
      s => Math.abs(parseFloat(s.outlineTop) - (top - 30)) < 0.5,
      "the outline moving with the page"
    );
    SvalElementPicker.stop(browser);
    await overlayUntil(browser, s => !s, "the overlay going on Stop");
  });
});

add_task(async function a_frame_can_be_chosen() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    await startPicking(browser);
    const state = await choose(browser, "#frame");
    is(state.element, "iframe", "the click on the frame chose the frame");
    is(state.selector, "#frame", "by its id");
    SvalElementPicker.stop(browser);
    await overlayUntil(browser, s => !s, "the overlay going on Stop");
  });
});

// A fixed layer filling the viewport, as a paywall or a consent wall is.
const FULL_SCREEN_PAGE =
  "https://example.net/browser/browser/components/sval/test/browser/sval_element_snip.html?modal";

add_task(async function a_full_screen_layer_can_be_chosen() {
  await BrowserTestUtils.withNewTab(FULL_SCREEN_PAGE, async browser => {
    await startPicking(browser);
    const { width } = await SpecialPowers.spawn(browser, [], () => ({
      width: content.innerWidth,
    }));
    await BrowserTestUtils.synthesizeMouseAtPoint(width - 20, 20, {}, browser);
    const state = await overlayUntil(browser, s => s?.card, "the card");
    is(state.selector, "#backdrop", "the layer filling the page");
    SvalElementPicker.stop(browser);
    await overlayUntil(browser, s => !s, "the overlay going on Stop");
  });
});

// Another site's page, which a frame on example.net loads in another process.
const OTHER_SITE_FRAME =
  "https://example.org/browser/browser/components/sval/test/browser/sval_element_picker_shadow.html";
const HIDE_OTHER_SITE_FRAME = "example.net###other-site-frame";
const BLOCK_OTHER_SITE_FRAME =
  "||example.org/browser/browser/components/sval/test/browser/sval_element_picker_shadow.html$domain=example.net";

add_task(async function a_frame_in_another_process_can_be_chosen() {
  await clearingFilters(async () => {
    await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
      await SpecialPowers.spawn(browser, [OTHER_SITE_FRAME], async src => {
        const frame = content.document.createElement("iframe");
        frame.id = "other-site-frame";
        frame.width = 100;
        frame.height = 50;
        frame.src = src;
        const loaded = new Promise(resolve =>
          frame.addEventListener("load", resolve, { once: true })
        );
        content.document.body.prepend(frame);
        await loaded;
      });
      const inner = browser.browsingContext.children[0].currentWindowGlobal;
      ok(!inner.isInProcess, "the frame is in a process of its own");

      await startPicking(browser);
      const state = await choose(browser, "#other-site-frame");
      is(state.element, "iframe", "the click chose the frame element");
      is(state.selector, "#other-site-frame", "by its id");
      is(state.download, "true", "Stop the download too is offered");
      Assert.deepEqual(
        state.rules,
        [HIDE_OTHER_SITE_FRAME, BLOCK_OTHER_SITE_FRAME],
        "the network rule names the frame's address"
      );
      await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
      await overlayUntil(browser, s => s?.toast, "the toast");
      is(
        filters(),
        `${HIDE_OTHER_SITE_FRAME}\n${BLOCK_OTHER_SITE_FRAME}`,
        "both lines are saved"
      );
    });
  });
});

add_task(async function the_keyboard_points_and_chooses() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    await startPicking(browser);
    await BrowserTestUtils.synthesizeKey("KEY_Tab", {}, browser);
    await overlayUntil(
      browser,
      s => s.labelElement == "p",
      "Tab on the first element, the paragraph"
    );
    await BrowserTestUtils.synthesizeKey("KEY_Tab", {}, browser);
    await overlayUntil(
      browser,
      s => s.labelElement == "div" && s.labelSize == "320 × 120",
      "the rail"
    );
    await BrowserTestUtils.synthesizeKey("KEY_Tab", {}, browser);
    await overlayUntil(
      browser,
      s => s.labelElement == "div" && s.labelSize == "200 × 100",
      "the box"
    );
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
    let state = await overlayUntil(browser, s => s.card, "the card");
    is(state.selector, ".sval-test-ad", "Enter chose the box");

    await BrowserTestUtils.synthesizeKey("KEY_Tab", {}, browser);
    state = await overlayUntil(browser, s => s.focused != "hide", "Tab");
    is(state.focused, "slider", "Tab from Hide goes round to the slider");
    await BrowserTestUtils.synthesizeKey(
      "KEY_Tab",
      { shiftKey: true },
      browser
    );
    await overlayUntil(browser, s => s.focused == "hide", "Shift+Tab back");
    SvalElementPicker.stop(browser);
    await overlayUntil(browser, s => !s, "the overlay going on Stop");
  });
});

add_task(async function space_presses_the_focused_control() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    await startPicking(browser);
    await choose(browser, "#image");
    for (const to of ["slider", "download-box"]) {
      await BrowserTestUtils.synthesizeKey("KEY_Tab", {}, browser);
      await overlayUntil(browser, s => s.focused == to, `Tab to ${to}`);
    }
    await BrowserTestUtils.synthesizeKey(" ", {}, browser);
    let state = await overlayUntil(
      browser,
      s => s.download == "false",
      "the option off"
    );
    Assert.deepEqual(state.rules, [HIDE_IMAGE], "only the hiding rule shows");

    await BrowserTestUtils.synthesizeKey("KEY_Tab", {}, browser);
    await overlayUntil(browser, s => s.focused == "card-cancel", "on Cancel");
    const ended = within(
      TestUtils.topicObserved(MODE_TOPIC, (s, data) => !data),
      10_000,
      "the mode ending"
    );
    await BrowserTestUtils.synthesizeKey(" ", {}, browser);
    await ended;
    await overlayUntil(browser, s => !s, "Space on Cancel leaving");
    is(filters(), "", "nothing is written");
  });
});

/**
 * Runs `test`, then empties My filters whatever happened.
 *
 * @param {Function} test
 */
async function clearingFilters(test) {
  try {
    await test();
  } finally {
    if (filters()) {
      SvalBlocking.setMyFilters("");
    }
  }
}

/**
 * Starts the picker, chooses the box and saves.
 *
 * @param {Element} browser
 * @returns {Promise<object>} the overlay's state with its toast.
 */
async function hideTheBox(browser) {
  await startPicking(browser);
  await choose(browser, "#ad");
  await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
  return overlayUntil(browser, s => s?.toast, "the toast");
}

add_task(
  async function a_refused_save_shows_an_error_toast_and_saves_nothing() {
    await clearingFilters(async () => {
      await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
        const full = "!".repeat(PREF_LIMIT - 10);
        SvalBlocking.setMyFilters(full);
        await startPicking(browser);
        await choose(browser, "#ad");
        const ended = within(
          TestUtils.topicObserved(MODE_TOPIC, (s, data) => !data),
          10_000,
          "the mode ending"
        );
        await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
        const state = await overlayUntil(browser, s => s?.toast, "the toast");
        await ended;
        is(state.refused, "too-large", "the toast says why");
        is(state.focused, "dismiss", "focus starts on Dismiss");
        ok(!state.bar && !state.card, "the picker has gone");
        const undo = await SpecialPowers.spawn(
          browser,
          [],
          () =>
            !!content.windowGlobalChild
              .getActor("SvalElementPicker")
              .overlay.getElementById("undo")
        );
        ok(!undo, "there is no Undo");
        is(filters(), full, "nothing was saved");
        is(await displayOf(browser, "ad"), "block", "the element stays");

        await clickOverlay(browser, "dismiss");
        await overlayUntil(browser, s => !s, "the toast going");
        is(await displayOf(browser, "ad"), "block", "and stays after it");
      });
    });
  }
);

add_task(async function enter_hides_the_element_and_undo_shows_it() {
  await clearingFilters(() => enterHidesAndUndoShows());
});

async function enterHidesAndUndoShows() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    await startPicking(browser);
    await choose(browser, "#ad");
    const ended = within(
      TestUtils.topicObserved(MODE_TOPIC, (s, data) => !data),
      10_000,
      "the mode ending"
    );
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
    const state = await overlayUntil(browser, s => s?.toast, "the toast");
    await ended;
    is(state.refused, "", "the toast says it was saved");
    Assert.stringContains(state.toast, "example.net", "and names the site");
    ok(!state.bar && !state.card, "the picker has gone");
    is(filters(), HIDE_AD, "the rule is in My filters");
    await within(
      TestUtils.waitForCondition(
        async () => (await displayOf(browser, "ad")) == "none",
        "the element hidden"
      ),
      10_000,
      "the element hidden"
    );

    await clickOverlay(browser, "undo");
    await overlayUntil(browser, s => !s, "the toast going");
    is(await displayOf(browser, "ad"), "block", "Undo shows it again");
    is(filters(), "", "and takes the rule out");
  });
}

add_task(async function with_reduced_motion_the_element_goes_at_once() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  try {
    await clearingFilters(async () => {
      await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
        const state = await hideTheBox(browser);
        ok(state.reducedMotion, "the overlay has reduced motion");
        await SpecialPowers.spawn(browser, [], () => {
          const ad = content.document.getElementById("ad");
          is(content.getComputedStyle(ad).display, "none", "hidden at once");
          is(ad.getAnimations().length, 0, "with no fade");
        });
        await clickOverlay(browser, "undo");
        await overlayUntil(browser, s => !s, "the toast going");
        is(await displayOf(browser, "ad"), "block", "Undo shows it again");
        is(filters(), "", "and takes the rule out");
      });
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function undo_during_the_fade_keeps_the_element() {
  await clearingFilters(async () => {
    await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
      // A paused refresh driver holds the fade where it starts.
      await SpecialPowers.spawn(browser, [], () =>
        content.windowUtils.advanceTimeAndRefresh(0)
      );
      try {
        await hideTheBox(browser);
        await SpecialPowers.spawn(browser, [], () => {
          const fading = content.document.getElementById("ad").getAnimations();
          Assert.greater(fading.length, 0, "the box is fading");
          // Taken before Undo: a cancelled animation's `finished` is a new promise.
          content.faded = Promise.allSettled(
            fading.map(animation => animation.finished)
          );
        });
        await clickOverlay(browser, "undo");
        await overlayUntil(browser, s => !s, "the toast going");
      } finally {
        await SpecialPowers.spawn(browser, [], () =>
          content.windowUtils.restoreNormalRefresh()
        );
      }
      // The fade's own end, which would apply the rule if Undo had left it.
      await within(
        SpecialPowers.spawn(browser, [], async () => {
          await content.faded;
          const ad = content.document.getElementById("ad");
          is(content.getComputedStyle(ad).display, "block", "it stays shown");
          is(ad.getAnimations().length, 0, "its fade is gone");
        }),
        10_000,
        "the fade settling"
      );
      is(filters(), "", "the rule is out");
    });
  });
});

add_task(async function dismissing_during_the_fade_keeps_the_element_hidden() {
  await clearingFilters(async () => {
    await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
      // A paused refresh driver holds the fade where it starts.
      await SpecialPowers.spawn(browser, [], () =>
        content.windowUtils.advanceTimeAndRefresh(0)
      );
      try {
        await hideTheBox(browser);
        await clickOverlay(browser, "dismiss");
        await overlayUntil(browser, s => !s, "the toast going");
      } finally {
        await SpecialPowers.spawn(browser, [], () =>
          content.windowUtils.restoreNormalRefresh()
        );
      }
      await within(
        TestUtils.waitForCondition(
          async () => (await displayOf(browser, "ad")) == "none",
          "the element hidden"
        ),
        10_000,
        "the element hidden"
      );
      is(filters(), HIDE_AD, "and the rule stays");
    });
  });
});

add_task(async function the_toast_takes_focus_on_undo() {
  await clearingFilters(async () => {
    await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
      const state = await hideTheBox(browser);
      is(state.focused, "undo", "a keyboard user starts on Undo");
      await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
      await overlayUntil(browser, s => !s, "the toast going");
      is(filters(), "", "Enter on Undo takes the rule out");
    });
  });
});

add_task(async function escape_reaches_the_page_unless_the_toast_has_focus() {
  await clearingFilters(async () => {
    await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
      await hideTheBox(browser);
      await SpecialPowers.spawn(browser, [], () => {
        const field = content.document.getElementById("field");
        field.addEventListener(
          "keydown",
          e => e.key == "Escape" && field.setAttribute("escaped", ""),
          { once: true }
        );
        field.focus();
      });
      await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
      ok(
        await SpecialPowers.spawn(browser, [], () =>
          content.document.getElementById("field").hasAttribute("escaped")
        ),
        "the page got the Escape"
      );
      ok((await overlayState(browser))?.toast, "the toast stays");

      await SpecialPowers.spawn(browser, [], () =>
        content.windowGlobalChild
          .getActor("SvalElementPicker")
          .overlay.getElementById("undo")
          .focus()
      );
      await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
      await overlayUntil(browser, s => !s, "Escape in the toast closes it");
    });
  });
});

add_task(async function escape_twice_leaves_without_a_write() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    await startPicking(browser);
    await choose(browser, "#ad");
    await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
    const state = await overlayUntil(
      browser,
      s => s.bar && !s.card,
      "back to pointing"
    );
    ok(state.outline, "the outline stays on the chosen element");
    Assert.deepEqual(
      [state.mode, state.labelElement, state.labelSize],
      ["remove", "div", "200 × 100"],
      "its label names the action, the element and its size"
    );
    const ended = within(
      TestUtils.topicObserved(MODE_TOPIC, (s, data) => !data),
      10_000,
      "the mode ending"
    );
    await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
    await ended;
    await overlayUntil(browser, s => !s, "the overlay going");
    is(filters(), "", "nothing was written");
  });
});

add_task(async function navigating_mid_pick_leaves_nothing_behind() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    await startPicking(browser);
    await choose(browser, "#ad");
    const ended = within(
      TestUtils.topicObserved(MODE_TOPIC, (s, data) => !data),
      10_000,
      "the mode ending"
    );
    await within(
      BrowserTestUtils.loadURIString({
        browser,
        uriString: `${PICKER_PAGE}?next`,
      }),
      15_000,
      "the next page loading"
    );
    await ended;
    is(await overlayState(browser), null, "the next page has no overlay");
    await SpecialPowers.spawn(browser, [], () => {
      const ad = content.document.getElementById("ad");
      ad.addEventListener("click", () => ad.setAttribute("clicked", ""), {
        once: true,
      });
    });
    await BrowserTestUtils.synthesizeMouseAtCenter("#ad", {}, browser);
    await within(
      SpecialPowers.spawn(browser, [], () =>
        ContentTaskUtils.waitForCondition(
          () => content.document.getElementById("ad").hasAttribute("clicked"),
          "the click"
        )
      ),
      10_000,
      "the page getting its click"
    );
    is(filters(), "", "nothing was written");
  });
});

add_task(async function an_image_on_the_page_s_site_has_no_download_option() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    await startPicking(browser);
    const state = await choose(browser, "#local-image");
    is(state.download, null, "no option, which could never block it");
    Assert.deepEqual(state.rules, ["example.net###local-image"], "one rule");
    SvalElementPicker.stop(browser);
    await overlayUntil(browser, s => !s, "the overlay going on Stop");
  });
});

add_task(async function hiding_an_image_can_stop_its_download() {
  await clearingFilters(() => hidingAnImageStopsItsDownload());
});

async function hidingAnImageStopsItsDownload() {
  await BrowserTestUtils.withNewTab(PICKER_PAGE, async browser => {
    let before = await imageRequests();
    await reload();
    Assert.greater(
      await imageRequests(),
      before,
      "a reload asks for the image"
    );

    await startPicking(browser);
    const state = await choose(browser, "#image");
    is(state.download, "true", "Stop the download too is on");
    Assert.deepEqual(
      state.rules,
      [HIDE_IMAGE, BLOCK_IMAGE_SJS],
      "both rules are shown"
    );
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    is(filters(), `${HIDE_IMAGE}\n${BLOCK_IMAGE_SJS}`, "both lines are saved");
    await untilBlocked(browser, IMAGE_SJS, "the image's network rule in force");

    before = await imageRequests();
    await reload();
    is(await imageRequests(), before, "the reload does not ask for the image");
  });
}
