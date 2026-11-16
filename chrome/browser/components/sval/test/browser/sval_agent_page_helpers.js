/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What the page-actor files share. Each file loads this with `loadSubScript`
 * into its own scope.
 */

/* exported pageActor, openPage */

const { pageActor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPageParent.sys.mjs"
);
const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

/**
 * Opens `url` in the window of an agent that has full access to
 * example.com, which closes when the task ends: a window costs the parent
 * process over a hundred megabytes.
 *
 * @param {string} [url]
 * @returns {Promise<{tabs: object, browser: object, page: object}>}
 */
async function openPage(url = PAGE) {
  const { tabs, agent, call } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url });
  const { browser } = await tabs.tabIn(agent, tab);
  SvalAgents.registerPageActorForTests();
  return { tabs, browser, page: pageActor(browser) };
}
