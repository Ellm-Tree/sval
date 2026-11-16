/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * An agent closes its window when it is done, and its workspace keeps its
 * tabs for when it comes back.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

add_task(async function an_agent_closes_its_window_and_keeps_its_tabs() {
  const { win, ws, call, raw, tabs } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await call("open_tab", { url: PAGE });
  const closed = BrowserTestUtils.windowClosed(win);
  const reply = await raw("close_window");
  Assert.ok(!reply.isError, "close_window succeeds");
  await within(closed, 10_000, "the agent's window closing");
  Assert.equal(await tabs.windowFor(ws), null, "no window shows the workspace");
  Assert.ok(!window.closed, "the user's window stays open");

  const { tabs: listed } = await call("list_tabs");
  Assert.deepEqual(
    listed.map(t => [t.tab, t.url]),
    [[tab, PAGE]],
    "the workspace keeps its tab"
  );

  const { snapshot } = await call("get_snapshot", { tab });
  Assert.ok(snapshot.length, "the agent can act in its tab again");
  const reopened = await tabs.windowFor(ws);
  Assert.ok(reopened && reopened !== window, "in a window of its own");
});
