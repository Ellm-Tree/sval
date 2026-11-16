/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_agent_sites_helpers.js */

/**
 * The gate's content policy on its own (agent-control spec §5.2), which is
 * all that stands in front of a load that opens no HTTP channel and of a
 * redirect to a scheme an agent may not open. An http(s) load is decided at
 * `http-on-modify-request`, which `browser_sval_agent_site_gate.js` covers
 * with the gate as a whole.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_agent_sites_helpers.js",
  this
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * A load of an address that is no site, such as an `about:` page, opens no
 * HTTP channel, so only the content policy sees it.
 */
add_task(async function a_load_of_no_site_is_refused_by_the_content_policy() {
  const { tabs, agent, call, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const stops = stopsIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  loadPastLayer(browser, "about:license");
  await refused(stops, browser, "about:license");
  Assert.equal(browser.currentURI.spec, LINKS, "the tab stays on its page");
});

/**
 * A redirect to `data:` is no download a page made, and is refused, however
 * the site it came from is allowed. Gecko refuses one too unless
 * `network.allow_redirect_to_data` is set
 * (`nsHttpChannel::AsyncProcessRedirection`), so it is set here, to see the
 * gate's own refusal.
 */
add_task(async function a_redirect_to_data_is_refused() {
  await SpecialPowers.pushPrefEnv({
    set: [["network.allow_redirect_to_data", true]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const { tabs, agent, call, win } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const stops = stopsIn(win);
  const { tab } = await call("open_tab", { url: LINKS });
  const { browser } = await tabs.tabIn(agent, tab);
  const redirect =
    ROOT +
    "sval_agent_redirect.sjs?" +
    encodeURIComponent("data:text/html,<title>Data page</title>");
  loadPastLayer(browser, redirect);
  await refused(stops, browser, ROOT + "sval_agent_redirect.sjs");
  Assert.equal(await documentURL(browser), LINKS, "the page stays as it was");
});
