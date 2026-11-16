/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * How an open_tab waits on its site alert (agent-control spec §5.2, §5.6): a
 * call waits until the user answers, a retry joins the alert left open, and
 * the answer carries every waiting call on.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * The agent's window with an alert open, once there is one.
 *
 * @param {string} workspaceId
 * @returns {Promise<Window>}
 */
function agentWindowAsking(workspaceId) {
  return TestUtils.waitForCondition(() => {
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.SvalPanel?.workspaceId === workspaceId && w.gDialogBox?.isOpen) {
        return w;
      }
    }
    return null;
  }, "the agent's window asks");
}

/**
 * A call with a progress token that a retry joins: the alert stays open
 * while both wait, the retry opens no second alert, and the answer is
 * recorded and carries both on.
 */
add_task(async function a_retry_joins_the_alert_a_call_waits_on() {
  const { agent, store, call, callWithProgress, win, alerts } =
    await agentSetup();
  const first = callWithProgress("open_tab", { url: PAGE });
  const doc = await alertIn(win);
  await TestUtils.waitForCondition(
    () => first.progress.length,
    "the first call waits"
  );
  const retry = callWithProgress("open_tab", { url: PAGE });
  await TestUtils.waitForCondition(
    () => retry.progress.length,
    "the retry waits"
  );
  Assert.ok(win.gDialogBox.isOpen, "the alert stays open");
  Assert.equal(alerts.opened, 1, "the retry attached to the same alert");
  Assert.equal(win.gDialogBox._queued.length, 0, "nothing queued behind it");
  await choose(doc, "allow");
  Assert.equal((await first.result).url, PAGE);
  Assert.equal((await retry.result).url, PAGE);
  await TestUtils.waitForCondition(
    () => store.policyOf(agent.agentId).sites["example.com"],
    "the answer is recorded"
  );
  Assert.equal((await call("open_tab", { url: PAGE })).url, PAGE);
  Assert.equal(alerts.opened, 1, "and is not asked again");
});

/** Deny ends a call that carries a progress token at once. */
add_task(async function deny_ends_a_waiting_open_tab() {
  const { callWithProgress, win } = await agentSetup();
  const denied = callWithProgress("open_tab", { url: NET_PAGE });
  const doc = await alertIn(win);
  await TestUtils.waitForCondition(
    () => denied.progress.length,
    "the call waits"
  );
  await choose(doc, "deny");
  Assert.equal(
    (await denied.result).status,
    403,
    "Deny opens the blocked page"
  );
});
