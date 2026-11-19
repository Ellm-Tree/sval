/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { ERRORS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs"
);

const {
  asAgentLoad,
  beginAgentNavigation,
  isAgentLoadDispatch,
  isAgentNavigating,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
);

/**
 * The layer over an agent's tab lets a load through only while the agent's
 * own load is dispatched (`asAgentLoad`). The mark is up for exactly the
 * synchronous call, however it ends, and a load that would do its loading
 * later is refused, so the mark can never be up while anything else runs.
 */
add_task(async function the_agents_load_is_marked_for_its_call_alone() {
  Assert.ok(!isAgentLoadDispatch(), "nothing is marked at rest");
  let during;
  Assert.equal(
    asAgentLoad(() => {
      during = isAgentLoadDispatch();
      return "loaded";
    }),
    "loaded"
  );
  Assert.ok(during, "marked during the call");
  Assert.ok(!isAgentLoadDispatch(), "and not after it");

  Assert.throws(
    () =>
      asAgentLoad(() => {
        throw new Error("load failed");
      }),
    /load failed/
  );
  Assert.ok(!isAgentLoadDispatch(), "nor after one that threw");

  let later;
  Assert.throws(
    () =>
      asAgentLoad(async () => {
        await Promise.resolve();
        later = isAgentLoadDispatch();
      }),
    /synchronously/,
    "a load that does its loading later is refused"
  );
  await Promise.resolve();
  await Promise.resolve();
  Assert.strictEqual(later, false, "and it runs unmarked");
  Assert.ok(!isAgentLoadDispatch());

  asAgentLoad(() =>
    asAgentLoad(() => Assert.ok(isAgentLoadDispatch(), "nested"))
  );
  Assert.ok(!isAgentLoadDispatch(), "and down after nesting");
});

/**
 * The overlay's activity line: what a tool does, then the site it does it on.
 */
add_task(function an_activity_line_names_the_tool_and_the_site() {
  const { activityText } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
  );
  const typing = activityText("Typing", "127.0.0.1:8384");
  Assert.ok(
    typing.length > " · 127.0.0.1:8384".length &&
      typing.endsWith(" · 127.0.0.1:8384"),
    `the site follows what the tool does: ${typing}`
  );
  Assert.equal(activityText("Clicking", ""), "Clicking", "no site, no dot");
});

/**
 * A take is of a whole workspace, kept in the device's settings: while it
 * holds, every tool in the workspace is refused with `user_in_control`, and
 * every window hears of each change. Before the settings are read, every
 * workspace counts as taken, and a take that cannot be kept is not made.
 */
add_task(function a_take_holds_the_whole_workspace() {
  const {
    CONTROL_TOPIC,
    holdWorkspace,
    isWorkspaceHeld,
    refuseIfWorkspaceHeld,
    useSettings,
  } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
  );
  const held = new Set();
  const settings = {
    isUserHeld: id => held.has(id),
    setUserHeld: (id, on) => (on ? held.add(id) : held.delete(id)),
    isAgentStopped: () => false,
    flush: () => Promise.resolve(),
  };
  const heard = [];
  const observer = (_s, _t, data) => heard.push(data);
  Services.obs.addObserver(observer, CONTROL_TOPIC);
  try {
    useSettings(settings);
    Assert.ok(!isWorkspaceHeld("ws"), "the agent's until taken");
    refuseIfWorkspaceHeld("ws");

    holdWorkspace("ws", true);
    Assert.ok(isWorkspaceHeld("ws"), "taken");
    Assert.ok(held.has("ws"), "and kept");
    Assert.ok(!isWorkspaceHeld("other"), "another workspace is not");
    Assert.throws(
      () => refuseIfWorkspaceHeld("ws"),
      e => e.code === "user_in_control" && e.message === ERRORS.user_in_control,
      "every tool in it is refused"
    );
    Assert.deepEqual(heard, ["0"], "and every window hears of it");

    holdWorkspace("ws", false);
    Assert.ok(!isWorkspaceHeld("ws"), "given back");
    refuseIfWorkspaceHeld("ws");
    Assert.deepEqual(heard, ["0", "0"]);

    useSettings(null);
    Assert.ok(isWorkspaceHeld("ws"), "an unknown take counts as made");
    Assert.throws(
      () => holdWorkspace("ws", true),
      /not read yet/,
      "and a take that cannot be kept is not made"
    );
  } finally {
    Services.obs.removeObserver(observer, CONTROL_TOPIC);
    useSettings(null);
  }
});

/**
 * Stop refuses every call of the agent's until Resume, and ends a call
 * already waiting on it at once (agent-control spec §6).
 */
add_task(async function stop_refuses_the_agent_until_resume() {
  const {
    CONTROL_TOPIC,
    isWorkspaceStopped,
    refuseIfWorkspaceHeld,
    stopWorkspace,
    untilStopped,
    useSettings,
  } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
  );
  const stopped = new Set();
  const settings = {
    isUserHeld: () => false,
    isAgentStopped: id => stopped.has(id),
    setAgentStopped: (id, on) => (on ? stopped.add(id) : stopped.delete(id)),
    flush: () => Promise.resolve(),
  };
  const heard = [];
  const observer = (_s, _t, data) => heard.push(data);
  Services.obs.addObserver(observer, CONTROL_TOPIC);
  try {
    useSettings(settings);
    const running = untilStopped("ws");
    Assert.ok(!running.stopped, "the agent may act until stopped");
    const other = untilStopped("other");

    stopWorkspace("ws", true);
    Assert.ok(isWorkspaceStopped("ws"), "stopped");
    Assert.ok(stopped.has("ws"), "and kept");
    await Assert.rejects(
      running.promise,
      e => e.code === "stopped_by_user" && e.message === ERRORS.stopped_by_user,
      "a call already running is answered at once"
    );
    Assert.throws(
      () => refuseIfWorkspaceHeld("ws"),
      e => e.code === "stopped_by_user",
      "and every tool is refused"
    );
    Assert.ok(untilStopped("ws").stopped, "so no call starts");
    Assert.ok(!isWorkspaceStopped("other"), "another agent goes on");
    other.done();
    Assert.deepEqual(heard, ["0"], "and every window hears of it");

    stopWorkspace("ws", false);
    Assert.ok(!isWorkspaceStopped("ws"), "resumed");
    refuseIfWorkspaceHeld("ws");
    Assert.ok(!untilStopped("ws").stopped, "and the agent may act again");

    useSettings(null);
    Assert.ok(isWorkspaceStopped("ws"), "an unknown Stop counts as made");
    Assert.throws(
      () => stopWorkspace("ws", true),
      /not read yet/,
      "and a Stop that cannot be kept is not made"
    );
  } finally {
    Services.obs.removeObserver(observer, CONTROL_TOPIC);
    useSettings(null);
  }
});

/**
 * A call Stop answered acts no more, though the user presses Resume while
 * its tool still runs, and the agent's next call starts once it has ended.
 */
add_task(async function a_call_stop_answered_acts_no_more_after_resume() {
  const { refuseIfWorkspaceHeld, stopWorkspace, untilStopped, useSettings } =
    ChromeUtils.importESModule(
      "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
    );
  const stopped = new Set();
  useSettings({
    isUserHeld: () => false,
    isAgentStopped: id => stopped.has(id),
    setAgentStopped: (id, on) => (on ? stopped.add(id) : stopped.delete(id)),
    flush: () => Promise.resolve(),
  });
  try {
    const call = untilStopped("ws");
    Assert.equal(call.drained, null, "nothing holds the first call back");
    const tool = Promise.withResolvers();
    stopWorkspace("ws", true);
    await Assert.rejects(call.promise, e => e.code === "stopped_by_user");
    call.keepStopped(tool.promise);
    call.done();

    stopWorkspace("ws", false);
    Assert.throws(
      () => refuseIfWorkspaceHeld("ws"),
      e => e.code === "stopped_by_user",
      "the stopped call's tool is refused after Resume"
    );
    const next = untilStopped("ws");
    Assert.ok(!next.stopped, "the agent may call again");
    Assert.ok(next.drained, "once the stopped call has ended");

    tool.resolve();
    await next.drained;
    refuseIfWorkspaceHeld("ws");
    Assert.equal(untilStopped("ws").drained, null, "and nothing holds it back");
    next.done();
  } finally {
    useSettings(null);
  }
});

/**
 * Two of the agent's navigations can be under way in one tab, as one waits
 * its turn or on the user while the other loads. A load the gate holds then
 * is the agent's until both have ended, whichever ends first, so a take
 * cancels it.
 */
add_task(function a_tabs_navigations_each_end_only_their_own() {
  const first = beginAgentNavigation(7);
  const second = beginAgentNavigation(7);
  first();
  Assert.ok(isAgentNavigating(7), "the second still navigates");
  first();
  Assert.ok(isAgentNavigating(7), "ending one twice ends it once");
  second();
  Assert.ok(!isAgentNavigating(7), "both ended");
});
