/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * What an agent does in its own window leaves the switcher open in the
 * user's window as it is, the submenu under the pointer included, and a
 * rename of the agent's workspace still reaches its entry.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * The switcher, open in the user's window on the agent app's submenu.
 *
 * @param {object} setup From `agentSetup`.
 * @returns {Promise<object>} the switcher, the app's submenu and the agent
 *   workspace's entry in it.
 */
async function openOnTheAgentsMenu(setup) {
  await within(SimpleTest.promiseFocus(window), 10_000, "the window's focus");
  const menu = await openSwitcher();
  atTaskEnd(async () => {
    if (menu.state !== "closed") {
      await closeSwitcher(menu);
    }
  });
  const app = menu.querySelector("menu[data-agent-app]");
  const shown = BrowserTestUtils.waitForPopupEvent(app.menupopup, "shown");
  app.openMenu(true);
  await within(shown, 10_000, "the agent app's submenu opening");
  const entry = app.menupopup.querySelector(
    `[data-workspace-id="${setup.agent.workspaceId}"]`
  );
  Assert.ok(entry, "the agent's workspace is in the app's submenu");
  return { menu, submenu: app.menupopup, entry };
}

add_task(async function an_agents_work_leaves_the_open_submenu_open() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const { tab } = await setup.call("open_tab", { url: LINKS });
  const { menu, submenu, entry } = await openOnTheAgentsMenu(setup);

  await setup.call("navigate_tab", { tab, to: PAGE2 });
  // The user's panel redraws for the document change the load made. It is
  // awaited here so the checks below follow it.
  await within(SvalPanel.refresh(), 10_000, "the user's panel redrawing");

  Assert.equal(menu.state, "open", "the switcher is still open");
  Assert.equal(submenu.state, "open", "and so is the app's submenu");
  Assert.ok(entry.isConnected, "the agent's entry is the one drawn before");
});

add_task(async function a_renamed_agent_workspace_is_drawn_again() {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  await setup.call("open_tab", { url: LINKS });
  const { menu, entry } = await openOnTheAgentsMenu(setup);

  const task = "Compare laptop prices";
  // `set_task` answers in prose, which `call` would read as JSON.
  const renamed = await setup.raw("set_task", { task });
  Assert.ok(!renamed.isError, "the agent renames its workspace");
  const fresh = await TestUtils.waitForCondition(
    () =>
      menu.querySelector(
        `[data-workspace-id="${setup.agent.workspaceId}"][label^="${task}"]`
      ),
    "the entry takes the new task"
  );
  Assert.notEqual(fresh, entry, "the entry was drawn again for its new name");
});
