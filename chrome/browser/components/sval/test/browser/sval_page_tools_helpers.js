/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * What the site-tools test files share: an agent with site tools on, and a
 * tab on the tools page. Each file loads this with `loadSubScript` into its
 * own scope.
 */

/* exported TOOLS_PAGE, postAgain, toolsSetup */

const TOOLS_PAGE = ROOT + "sval_agent_tools.html";

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

/**
 * An agent with site tools set to `setting`, and a tab on the tools page.
 *
 * @param {object} options
 * @param {string} [options.setting] Layer B.
 * @param {string} [options.level] The level of example.com.
 * @param {string} [options.siteTools] Layer C for example.com, if decided.
 * @returns {Promise<object>} `agentSetup`'s, with the tab, and `call` as
 *   its `reply`: a failed call answers its error's JSON.
 */
async function toolsSetup({
  setting = "on",
  level = "ask-before-writes",
  siteTools,
} = {}) {
  // Site tools run through the page actor, which this file registers itself
  // rather than relying on an earlier file to have done so.
  SvalAgents.registerPageActorForTests();
  const made = await agentSetup({ sites: { "example.com": level } });
  await made.store.setPageTools(made.agent.agentId, setting);
  if (siteTools) {
    await made.store.setPageToolSite(
      made.agent.agentId,
      "example.com",
      siteTools
    );
  }
  const { tab } = await made.call("open_tab", { url: TOOLS_PAGE });
  return { ...made, call: made.reply, tab };
}

/**
 * Has a tool of `sval_agent_tools.html` that waits to post again do so now.
 *
 * @param {object} browser The tab showing the tools page.
 */
function postAgain(browser) {
  return SpecialPowers.spawn(browser, [], () =>
    content.postMessage("again", "*")
  );
}
