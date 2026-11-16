/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_element_picker_helpers.js */

// The snip (element picker design round 3: Snip, Keyboard): it removes
// one element from the open page until reload, writes nothing to My filters,
// and ends after one removal.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_element_picker_helpers.js",
  this
);

const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SvalElementPicker, MODE_TOPIC } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalElementPicker.sys.mjs"
);

const SNIP_PAGE =
  "https://example.net/browser/browser/components/sval/test/browser/sval_element_snip.html";
const MODAL_PAGE = `${SNIP_PAGE}?modal`;
const LOCKED_PAGE = `${SNIP_PAGE}?lock`;
/**
 * @param {?object} state From `overlayState`.
 * @returns {boolean} Whether the outline is on the 200 × 100 box.
 */
function onBox(state) {
  return state.labelElement == "div" && state.labelSize == "200 × 100";
}
const WHOLE_PAGE = ["wrap", "backdrop", "dialog", "app", "notice", "field"];
const APP_PAGE = `${SNIP_PAGE}?app`;
const TIGHT_PAGE = `${SNIP_PAGE}?modal&tight`;

/**
 * @param {Element} browser
 * @returns {Promise<object>} what the page holds of the fixture's parts.
 */
function pageState(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const byId = id => doc.getElementById(id);
    const overflow = el => content.getComputedStyle(el).overflow;
    return {
      box: !!byId("box"),
      backdrop: !!byId("backdrop"),
      dialog: !!byId("dialog"),
      boxParent: byId("box")?.parentElement?.id,
      boxBefore: byId("box")?.previousElementSibling?.id,
      boxAfter: byId("box")?.nextElementSibling?.id,
      backdropNext: byId("backdrop")?.nextSibling?.id,
      app: !!byId("app"),
      toolbar: !!byId("toolbar"),
      notice: !!byId("notice"),
      order: [...doc.body.children].map(child => child.id).filter(Boolean),
      html: overflow(doc.documentElement),
      body: overflow(doc.body),
    };
  });
}

/**
 * Waits for the page to pass `check`.
 *
 * @param {Element} browser
 * @param {(state: object) => boolean} check
 * @param {string} what
 * @returns {Promise<object>} the state that passed.
 */
async function pageUntil(browser, check, what) {
  let state;
  await within(
    TestUtils.waitForCondition(async () => {
      state = await pageState(browser);
      return check(state);
    }, what),
    10_000,
    what
  );
  return state;
}

/**
 * Starts the snip and waits for its bar.
 *
 * @param {Element} browser
 * @returns {Promise<object>} the overlay's state.
 */
async function startZapping(browser) {
  await within(
    SvalElementPicker.start(browser, "snip"),
    10_000,
    "the snip starting"
  );
  return overlayUntil(browser, s => s?.bar, "the pointing bar");
}

/**
 * Clicks a point of the viewport that the modal's dialog does not cover.
 *
 * @param {Element} browser
 */
async function clickBackdrop(browser) {
  const { width } = await SpecialPowers.spawn(browser, [], () => ({
    width: content.innerWidth,
  }));
  await BrowserTestUtils.synthesizeMouseAtPoint(width - 20, 20, {}, browser);
}

/** Waits for the tab's mode to end. */
function modeEnded() {
  return within(
    TestUtils.topicObserved(MODE_TOPIC, (s, data) => !data),
    10_000,
    "the mode ending"
  );
}

add_task(async function starting_the_snip_draws_its_bar() {
  await BrowserTestUtils.withNewTab(SNIP_PAGE, async browser => {
    const state = await startZapping(browser);
    is(state.mode, "snip", "the overlay is in the snip's mode");
    ok(state.bar, "the bar says what to do");
    ok(!state.card, "there is no card");
    is(SvalElementPicker.active(browser), "snip", "the tab is in the snip");
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#box",
      { type: "mousemove" },
      browser
    );
    await overlayUntil(browser, onBox, "the outline");
    const marks = await SpecialPowers.spawn(browser, [], () => {
      const root =
        content.windowGlobalChild.getActor("SvalElementPicker").overlay;
      return {
        barIcon: root.querySelector("#bar > .icon").className,
        labelIcon: !!root.querySelector("#label > .icon-scissors"),
      };
    });
    ok(marks.barIcon.includes("icon-scissors"), "the bar wears the scissors");
    ok(marks.labelIcon, "so does the label");
    SvalElementPicker.stop(browser);
    await overlayUntil(browser, s => !s, "the overlay going on Stop");
  });
});

add_task(async function zapping_removes_the_element_and_writes_nothing() {
  await BrowserTestUtils.withNewTab(SNIP_PAGE, async browser => {
    const before = SvalBlocking.myFilters;
    await startZapping(browser);
    const ended = modeEnded();
    await BrowserTestUtils.synthesizeMouseAtCenter("#box", {}, browser);
    const state = await overlayUntil(browser, s => s?.toast, "the toast");
    await ended;
    is(state.refused, "", "the toast says it is for now");
    ok(!state.bar, "the bar has gone");
    is(SvalElementPicker.active(browser), null, "the mode ended with one");
    await pageUntil(browser, s => !s.box, "the box removed");
    is(SvalBlocking.myFilters, before, "My filters are as they were");
  });
});

add_task(async function undo_puts_the_element_back_where_it_was() {
  await BrowserTestUtils.withNewTab(SNIP_PAGE, async browser => {
    await startZapping(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter("#box", {}, browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    await pageUntil(browser, s => !s.box, "the box removed");

    await clickOverlay(browser, "undo");
    await overlayUntil(browser, s => !s, "the toast going");
    const page = await pageState(browser);
    ok(page.box, "the box is back");
    is(page.boxParent, "wrap", "in its parent");
    is(page.boxBefore, "before", "after the paragraph before it");
    is(page.boxAfter, "after", "and before the one after it");
  });
});

add_task(async function the_snip_button_counts_the_pages_snips() {
  await BrowserTestUtils.withNewTab(SNIP_PAGE, async browser => {
    const button = document.getElementById("sval-snip-button");
    ok(!button.hasAttribute("sval-count"), "a fresh page counts none");
    await startZapping(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter("#box", {}, browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    await within(
      TestUtils.waitForCondition(
        () => button.getAttribute("sval-count") == "1",
        "the count"
      ),
      10_000,
      "the snip counting"
    );
    await clickOverlay(browser, "undo");
    await within(
      TestUtils.waitForCondition(
        () => !button.hasAttribute("sval-count"),
        "no count"
      ),
      10_000,
      "Undo taking the count back"
    );

    await startZapping(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter("#box", {}, browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    await within(
      TestUtils.waitForCondition(
        () => button.getAttribute("sval-count") == "1",
        "the count"
      ),
      10_000,
      "the snip counting again"
    );
    const loaded = BrowserTestUtils.browserLoaded(browser);
    browser.reload();
    await within(loaded, 10_000, "the reload");
    ok(!button.hasAttribute("sval-count"), "a reload brings it back");
  });
});

add_task(async function zapping_a_dialog_removes_its_backdrop_too() {
  await BrowserTestUtils.withNewTab(MODAL_PAGE, async browser => {
    let page = await pageState(browser);
    is(page.html, "hidden", "the page starts locked on <html>");
    is(page.body, "hidden", "and on <body>");

    await startZapping(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter("#dialog", {}, browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    page = await pageUntil(
      browser,
      s => !s.dialog && !s.backdrop,
      "the dialog and its backdrop removed"
    );
    ok(page.box, "the rest of the page stays");
    is(page.html, "visible", "scrolling is unlocked on <html>");
    is(page.body, "visible", "and on <body>");

    await clickOverlay(browser, "undo");
    await overlayUntil(browser, s => !s, "the toast going");
    page = await pageState(browser);
    Assert.deepEqual(page.order, WHOLE_PAGE, "both are back in their places");
    is(page.html, "hidden", "the lock on <html> is back");
    is(page.body, "hidden", "and on <body>");
  });
});

add_task(async function zapping_a_full_screen_layer_unlocks_scrolling() {
  await BrowserTestUtils.withNewTab(MODAL_PAGE, async browser => {
    await startZapping(browser);
    await clickBackdrop(browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    const page = await pageUntil(browser, s => !s.backdrop, "the layer gone");
    ok(page.dialog, "the dialog in front of it stays");
    is(page.html, "visible", "scrolling is unlocked on <html>");
    is(page.body, "visible", "and on <body>");

    await clickOverlay(browser, "undo");
    await overlayUntil(browser, s => !s, "the toast going");
    const back = await pageState(browser);
    is(back.html, "hidden", "Undo locks <html> again");
    is(back.body, "hidden", "and <body>");
    Assert.deepEqual(
      back.order,
      WHOLE_PAGE,
      "the layer is back behind the dialog"
    );
  });
});

add_task(async function zapping_a_plain_element_leaves_the_lock() {
  await BrowserTestUtils.withNewTab(LOCKED_PAGE, async browser => {
    await startZapping(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter("#box", {}, browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    const page = await pageUntil(browser, s => !s.box, "the box removed");
    is(page.html, "hidden", "<html> stays locked");
    is(page.body, "hidden", "and <body>");
  });
});

add_task(async function the_keyboard_removes_one_element() {
  await BrowserTestUtils.withNewTab(SNIP_PAGE, async browser => {
    await startZapping(browser);
    for (let i = 0; i < 3; i++) {
      await BrowserTestUtils.synthesizeKey("KEY_Tab", {}, browser);
    }
    await overlayUntil(browser, onBox, "Tab on the box");
    await BrowserTestUtils.synthesizeKey("KEY_Enter", {}, browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    await pageUntil(browser, s => !s.box, "Enter removed the box");
    is(SvalElementPicker.active(browser), null, "and ended the mode");
  });
});

add_task(async function space_removes_as_enter_does() {
  await BrowserTestUtils.withNewTab(SNIP_PAGE, async browser => {
    await startZapping(browser);
    for (let i = 0; i < 3; i++) {
      await BrowserTestUtils.synthesizeKey("KEY_Tab", {}, browser);
    }
    await overlayUntil(browser, onBox, "Tab on the box");
    await BrowserTestUtils.synthesizeKey(" ", {}, browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    await pageUntil(browser, s => !s.box, "Space removed the box");
  });
});

add_task(async function escape_leaves_without_removing() {
  await BrowserTestUtils.withNewTab(SNIP_PAGE, async browser => {
    await startZapping(browser);
    const ended = modeEnded();
    await BrowserTestUtils.synthesizeKey("KEY_Escape", {}, browser);
    await ended;
    await overlayUntil(browser, s => !s, "the overlay going");
    ok((await pageState(browser)).box, "nothing was removed");
  });
});

add_task(async function a_full_screen_layer_can_be_pointed_at() {
  await BrowserTestUtils.withNewTab(MODAL_PAGE, async browser => {
    await startZapping(browser);
    const { width } = await SpecialPowers.spawn(browser, [], () => ({
      width: content.innerWidth,
    }));
    await BrowserTestUtils.synthesizeMouseAtPoint(
      width - 20,
      20,
      { type: "mousemove" },
      browser
    );
    const state = await overlayUntil(browser, s => s.outline, "the outline");
    const { w, h } = await SpecialPowers.spawn(browser, [], () => ({
      w: content.innerWidth,
      h: content.innerHeight,
    }));
    is(state.labelSize, `${w} × ${h}`, "it is on the layer filling the page");
    SvalElementPicker.stop(browser);
    await overlayUntil(browser, s => !s, "the overlay going on Stop");
  });
});

add_task(async function the_snip_works_in_a_private_window() {
  await inPrivateWindow(SNIP_PAGE, async browser => {
    await startZapping(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter("#box", {}, browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    await pageUntil(browser, s => !s.box, "the box removed");
    await clickOverlay(browser, "undo");
    await overlayUntil(browser, s => !s, "the toast going");
    ok((await pageState(browser)).box, "Undo puts it back");
  });
});

add_task(async function with_reduced_motion_the_element_goes_at_once() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 1]] });
  try {
    await BrowserTestUtils.withNewTab(SNIP_PAGE, async browser => {
      const state = await startZapping(browser);
      ok(state.reducedMotion, "the overlay has reduced motion");
      await BrowserTestUtils.synthesizeMouseAtCenter("#box", {}, browser);
      await overlayUntil(browser, s => s?.toast, "the toast");
      ok(!(await pageState(browser)).box, "removed with the toast, no fade");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function undo_during_the_fade_keeps_the_element() {
  await BrowserTestUtils.withNewTab(SNIP_PAGE, async browser => {
    // A paused refresh driver holds the fade where it starts.
    await SpecialPowers.spawn(browser, [], () =>
      content.windowUtils.advanceTimeAndRefresh(0)
    );
    try {
      await startZapping(browser);
      await BrowserTestUtils.synthesizeMouseAtCenter("#box", {}, browser);
      await overlayUntil(browser, s => s?.toast, "the toast");
      ok((await pageState(browser)).box, "the box fades before it goes");
      await clickOverlay(browser, "undo");
      await overlayUntil(browser, s => !s, "the toast going");
    } finally {
      await SpecialPowers.spawn(browser, [], () =>
        content.windowUtils.restoreNormalRefresh()
      );
    }
    await within(
      SpecialPowers.spawn(browser, [], async () => {
        const box = content.document.getElementById("box");
        ok(box, "the box stays");
        await ContentTaskUtils.waitForCondition(
          () => !box.getAnimations().length,
          "the fade going"
        );
      }),
      10_000,
      "the fade going"
    );
  });
});

add_task(async function the_toast_takes_focus_and_escape_closes_it() {
  await BrowserTestUtils.withNewTab(SNIP_PAGE, async browser => {
    await startZapping(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter("#box", {}, browser);
    const state = await overlayUntil(browser, s => s?.toast, "the toast");
    is(state.focused, "undo", "a keyboard user starts on Undo");
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
    ok(!(await pageState(browser)).box, "and the removal stays");
  });
});

add_task(async function undo_keeps_adjacent_siblings_in_order() {
  await BrowserTestUtils.withNewTab(TIGHT_PAGE, async browser => {
    is(
      (await pageState(browser)).backdropNext,
      "dialog",
      "no whitespace between the backdrop and the dialog"
    );
    await startZapping(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter("#dialog", {}, browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    await pageUntil(browser, s => !s.dialog && !s.backdrop, "both removed");
    await clickOverlay(browser, "undo");
    await overlayUntil(browser, s => !s, "the toast going");
    Assert.deepEqual(
      (await pageState(browser)).order,
      WHOLE_PAGE,
      "the backdrop is back before the dialog"
    );
  });
});

add_task(async function a_layer_with_content_is_not_a_backdrop() {
  await BrowserTestUtils.withNewTab(APP_PAGE, async browser => {
    await startZapping(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter("#notice", {}, browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    const page = await pageUntil(browser, s => !s.notice, "the notice gone");
    ok(page.app, "the app layer behind a fixed element stays");

    await clickOverlay(browser, "undo");
    await overlayUntil(browser, s => !s, "the toast going");
    await startZapping(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter("#dialog", {}, browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    const after = await pageUntil(browser, s => !s.dialog, "the dialog gone");
    ok(after.app, "the app layer behind a dialog stays");
  });
});

add_task(async function a_fixed_toolbar_in_the_app_root_goes_alone() {
  await BrowserTestUtils.withNewTab(APP_PAGE, async browser => {
    await startZapping(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter("#toolbar", {}, browser);
    await overlayUntil(browser, s => s?.toast, "the toast");
    const page = await pageUntil(browser, s => !s.toolbar, "the toolbar gone");
    ok(page.app, "its fixed root stays");
    ok(page.notice && page.dialog, "so does the rest");
  });
});

add_task(async function dismissing_during_the_fade_keeps_the_removal() {
  await BrowserTestUtils.withNewTab(SNIP_PAGE, async browser => {
    // A paused refresh driver holds the fade where it starts.
    await SpecialPowers.spawn(browser, [], () =>
      content.windowUtils.advanceTimeAndRefresh(0)
    );
    try {
      await startZapping(browser);
      await BrowserTestUtils.synthesizeMouseAtCenter("#box", {}, browser);
      await overlayUntil(browser, s => s?.toast, "the toast");
      ok((await pageState(browser)).box, "the box is still fading");
      await clickOverlay(browser, "dismiss");
      await overlayUntil(browser, s => !s, "the toast going");
    } finally {
      await SpecialPowers.spawn(browser, [], () =>
        content.windowUtils.restoreNormalRefresh()
      );
    }
    ok(!(await pageState(browser)).box, "the box is gone all the same");
  });
});
