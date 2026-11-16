/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * A page that never answers (agent-control spec §4.1): every query a tool
 * makes of a page has a deadline, so the agent gets an answer and can go on
 * in its other tabs.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { setPageTimeoutForTests } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

add_task(async function a_page_that_never_answers_times_the_input_out() {
  atTaskEnd(setPageTimeoutForTests(300));
  const setup = await dialogsSetup();
  const ref = await buttonRunning(
    setup,
    "const until = Date.now() + 3000; while (Date.now() < until) {}"
  );
  const result = await setup.raw("click_element", { tab: setup.tab, ref });
  Assert.strictEqual(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  Assert.equal(body.error, "page_unresponsive");
  Assert.equal(
    body.message,
    "page_unresponsive: The page did not respond. Take a new snapshot."
  );
  Assert.equal(body.writes, "none", "the writes are still reported");
  // The busy page answers again once its handler ends.
  await SpecialPowers.spawn(setup.browser, [], () => {});
});

/**
 * A form is one input, with one deadline for all its fields: fields each
 * slow enough to pass alone together run out of time, and the call says how
 * many were filled.
 */
add_task(async function a_form_keeps_to_one_deadline() {
  atTaskEnd(setPageTimeoutForTests(1000));
  const setup = await dialogsSetup();
  await SpecialPowers.spawn(setup.browser, [], () => {
    for (const id of ["email", "pw"]) {
      content.document.getElementById(id).addEventListener(
        "input",
        () => {
          const until = Date.now() + 700;
          while (Date.now() < until) {
            // Holds the page, as a slow handler does.
          }
        },
        { once: true }
      );
    }
  });
  const { snapshot } = await setup.call("get_snapshot", { tab: setup.tab });
  const email = snapshot.match(/textbox "Email" \[(e\d+)\]/)[1];
  const pw = snapshot.match(/textbox "Password" \[(e\d+)\]/)[1];
  const result = await setup.raw("fill_form", {
    tab: setup.tab,
    fields: [
      { ref: email, text: "x" },
      { ref: pw, text: "y" },
    ],
  });
  Assert.strictEqual(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  Assert.equal(body.error, "page_unresponsive");
  Assert.equal(body.filled, 1, "the first field was filled in time");
  // The busy page answers again once its handler ends.
  await SpecialPowers.spawn(setup.browser, [], () => {});
});

add_task(async function a_page_that_never_answers_leaves_the_agent_free() {
  const { call, store, agent, tab, browser } = await dialogsSetup();
  await store.setSiteLevel(agent.agentId, "example.org", "full");
  const other = await call("open_tab", { url: ORG_PAGE });
  atTaskEnd(setPageTimeoutForTests(300));
  // The page's script holds its process from before the agent asks until
  // well past the deadline. The other tab is another site's, so another
  // process (Fission).
  const busy = SpecialPowers.spawn(browser, [], () => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      // Never yields to the page's event loop.
    }
  });
  try {
    await Assert.rejects(
      call("get_snapshot", { tab }),
      err => err.code === "page_unresponsive",
      "the read gives up"
    );
    const { snapshot } = await call("get_snapshot", { tab: other.tab });
    Assert.stringContains(
      snapshot,
      "Second",
      "the agent's next call, in another tab, is answered"
    );
  } finally {
    await busy;
  }
});
