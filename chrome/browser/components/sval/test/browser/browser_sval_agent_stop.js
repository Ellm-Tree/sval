/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * Stop on the overlay's card (agent-control spec §6): it refuses every call
 * of the agent's with `stopped_by_user` until the user presses Resume in its
 * place, ends a call already running, and leaves the workspace the agent's.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_take_control_helpers.js",
  this
);

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { isWorkspaceStopped, stopWorkspace } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * An agent's tab under the overlay, with its Stop put back when the task
 * ends, since Stops are kept in the profile's settings.
 *
 * @returns {Promise<object>} What `layerSetup` gives, with the card's Stop
 *   and Resume.
 */
async function stopSetup() {
  const setup = await layerSetup();
  atTaskEnd(() => stopWorkspace(setup.ws, false));
  const { card } = partsOf(setup.browser);
  return {
    ...setup,
    card,
    stop: card.querySelector(".sval-agent-stop"),
    resume: card.querySelector(".sval-agent-resume"),
  };
}

const isStopped = e => e.code === "stopped_by_user";

const STOP_ICON = "chrome://browser/content/sval/agent-stop.svg";

/**
 * Stop refuses the agent's calls, on every tab of its workspace, and Resume
 * takes its place on the card until pressed. The overlay stays up, and the
 * workspace stays the agent's.
 */
add_task(async function stop_refuses_the_agent_until_resume() {
  const { call, tab, win, ws, browser, card, stop, resume } = await stopSetup();
  const { overlay } = partsOf(browser);
  Assert.equal(card.dataset.stopped, "false");
  Assert.ok(!stop.hidden && resume.hidden, "Stop shows, Resume does not");
  const icon = win.getComputedStyle(stop, "::before").backgroundImage;
  Assert.ok(icon.includes(STOP_ICON), "Stop wears the stop square");
  const loaded = await fetch(STOP_ICON);
  Assert.ok(loaded.ok, "which the build carries");

  await EventUtils.synthesizeMouseAtCenter(stop, {}, win);
  Assert.ok(isWorkspaceStopped(ws), "the agent is stopped");
  Assert.equal(card.dataset.stopped, "true");
  Assert.ok(stop.hidden && !resume.hidden, "Resume takes Stop's place");
  Assert.ok(!overlay.hidden, "the overlay stays up");
  Assert.ok(
    !isUserInControl(browser.browsingContext.browserId),
    "and the workspace stays the agent's"
  );
  for (const [name, args] of [
    ["get_snapshot", { tab }],
    ["click_element", { tab, ref: "e1" }],
    ["navigate_tab", { tab, to: PAGE }],
    ["open_tab", { url: PAGE }],
    ["close_tab", { tab }],
  ]) {
    await Assert.rejects(
      call(name, args),
      isStopped,
      `${name} fails with stopped_by_user`
    );
  }

  await EventUtils.synthesizeMouseAtCenter(resume, {}, win);
  Assert.ok(!isWorkspaceStopped(ws), "Resume lets the agent go on");
  Assert.equal(card.dataset.stopped, "false");
  Assert.ok(!stop.hidden && resume.hidden, "and Stop is back");
  Assert.ok(
    (await call("get_snapshot", { tab })).snapshot,
    "the agent's calls work again"
  );
});

/**
 * Tab reaches Stop from the card, after Take control, and Enter or Space on
 * it presses it. The keyboard follows the press to Resume, and back.
 */
add_task(async function stop_is_reached_and_pressed_from_the_keyboard() {
  const { win, ws, card, stop, resume } = await stopSetup();
  card.focus();
  EventUtils.synthesizeKey("KEY_Tab", {}, win);
  Assert.equal(
    win.document.activeElement,
    card.querySelector(".sval-agent-take"),
    "Tab reaches Take control"
  );
  EventUtils.synthesizeKey("KEY_Tab", {}, win);
  Assert.equal(win.document.activeElement, stop, "then Stop");
  Assert.ok(stop.getAttribute("aria-label"), "Stop has a name of its own");

  EventUtils.synthesizeKey("KEY_Enter", {}, win);
  Assert.ok(isWorkspaceStopped(ws), "Enter presses Stop");
  Assert.equal(win.document.activeElement, resume, "the keyboard is on Resume");

  EventUtils.synthesizeKey(" ", {}, win);
  Assert.ok(!isWorkspaceStopped(ws), "Space presses Resume");
  Assert.equal(win.document.activeElement, stop, "and back on Stop");
});

/**
 * A call already running when the user presses Stop is answered with
 * `stopped_by_user` at once, without waiting out its time.
 */
add_task(async function stop_ends_a_running_call() {
  const { call, tab, browser, stop } = await stopSetup();
  const started = Date.now();
  const pending = call("wait_for_text", {
    tab,
    text: "Never on this page",
    timeout_ms: 30_000,
  });
  pending.catch(() => {});
  await settle(browser);
  stop.click();
  await Assert.rejects(pending, isStopped, "the wait answers stopped_by_user");
  Assert.less(Date.now() - started, 30_000, "without waiting out its time");
});

/**
 * A load of the agent's that waits on a site alert when the user presses
 * Stop is cancelled: allowing the site afterwards does not move the tab.
 */
add_task(async function stop_cancels_a_load_waiting_on_the_user() {
  const { call, tab, win, browser, stop } = await stopSetup();
  const pending = call("navigate_tab", { tab, to: ORG_PAGE });
  pending.catch(() => {});
  const doc = await alertIn(win);
  stop.click();
  await choose(doc, "allow");
  await Assert.rejects(
    pending,
    isStopped,
    "the navigation answers stopped_by_user"
  );
  await settle(browser);
  Assert.equal(browser.currentURI.spec, INPUT, "and the tab did not move");
});

/**
 * Through the agent's session, Stop answers the call it is running, and
 * every call after it, list_tabs included, until Resume.
 */
add_task(async function the_session_refuses_every_call_until_resume() {
  const { call, tab, browser, stop, resume } = await stopSetup();
  const running = call("wait_for_text", {
    tab,
    text: "Never on this page",
    timeout_ms: 30_000,
  });
  running.catch(() => {});
  await settle(browser);
  stop.click();
  await Assert.rejects(running, isStopped, "the running call is stopped");
  await Assert.rejects(
    call("list_tabs", {}),
    isStopped,
    "list_tabs is refused"
  );
  resume.click();
  Assert.ok(
    (await call("list_tabs", {})).tabs.some(t => t.tab === tab),
    "resumed, list_tabs lists the agent's tab"
  );
});
