/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * `scroll_page` goes through the write gate like the other acting tools
 * (agent-control spec §4.1): what a page sends because it was scrolled is
 * held until the user answers.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

const { QUIET_MS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentWrites.sys.mjs"
);
const { politeRules } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Makes the page in `browser` tall enough to scroll, and has it write once
 * the first time it is scrolled.
 *
 * @param {object} browser
 */
async function writesWhenScrolled(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const tall = doc.createElement("div");
    tall.style.height = "5000px";
    doc.body.append(tall);
    content.addEventListener(
      "scroll",
      () =>
        content.fetch("https://example.com/sval-fetch", {
          method: "POST",
          body: "more",
        }),
      { once: true }
    );
  });
}

/**
 * Asserts the alert open in `win` holds the write the scroll set off, and
 * denies it.
 *
 * @param {Window} win
 * @param {string} kind The alert's `data-kind`.
 */
async function denyTheScrollsWrite(win, kind) {
  const doc = await alertIn(win);
  Assert.equal(doc.querySelector(".sval-aa").dataset.kind, kind);
  Assert.deepEqual(
    heldRequests(doc),
    [{ method: "POST", target: "example.com", path: "/sval-fetch" }],
    "the write the scroll set off is held"
  );
  await choose(doc, "deny");
}

add_task(async function scrolling_is_gated_like_any_other_input() {
  const { call, win, tab, browser } = await dialogsSetup({
    level: "ask-before-writes",
  });
  await writesWhenScrolled(browser);
  const seen = requestsTo("/sval-fetch");
  const scrolled = call("scroll_page", { tab, direction: "down" });
  await denyTheScrollsWrite(win, "writes");
  const result = await scrolled;
  Assert.equal(result.tab, tab);
  Assert.equal(result.writes, "denied");
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT], "the write never went");
});

/**
 * A page sees a scroll at its next refresh tick, which for a page that is
 * not painting can come later than the action window's quiet time. The
 * scroll's answer waits for the page to see it, and its window's quiet time
 * runs from that answer, so what the page sends then is still the scroll's.
 */
add_task(async function a_scroll_the_page_sees_late_is_gated_too() {
  const { call, win, tab, browser, agent } = await dialogsSetup({
    level: "ask-before-writes",
  });
  await writesWhenScrolled(browser);
  const seen = requestsTo("/sval-fetch");
  // With the refresh driver held, the page gets no scroll event until it is
  // let go.
  await SpecialPowers.spawn(browser, [], () =>
    content.windowUtils.advanceTimeAndRefresh(0)
  );
  const sent = performance.now();
  const scrolled = call("scroll_page", { tab, direction: "down" });
  // The scroll may wait its turn on the site (Be polite) before it goes.
  await timePassed(
    sent,
    politeRules(agent.agentId).interval_ms + 3 * QUIET_MS,
    "the page's tick comes later than the window's quiet time"
  );
  await SpecialPowers.spawn(browser, [], () =>
    content.windowUtils.restoreNormalRefresh()
  );
  await denyTheScrollsWrite(win, "writes");
  const result = await scrolled;
  Assert.equal(result.tab, tab);
  Assert.equal(result.writes, "denied");
  await stopped(seen);
  Assert.deepEqual(seen.stopped, [Cr.NS_ERROR_ABORT], "the write never went");
});
