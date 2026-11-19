/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Where an agent may go (agent-control spec §5.2), and what its input may
 * send (§5.3): the decisions themselves, with no real channel or window
 * behind them.
 */

const {
  ActionWindow,
  CAP_MS,
  createAgentGate,
  decideLoad,
  inUploadFolders,
  QUIET_MS,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentGate.sys.mjs"
);
const { ToolError } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs"
);
const { SvalAgentStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentStore.sys.mjs"
);
const { LEVELS, levelFor } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs"
);
const { ApprovalWait, MAX_WAITING_CALLS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs"
);
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);
const { SvalTestTemp } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
);
const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const { forgetControl, takeControl } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
);

const policy = (fields = {}) => ({
  version: 2,
  default: "ask",
  sites: {},
  ...fields,
});

add_task(
  function a_known_blocked_site_is_denied_and_every_other_level_allowed() {
    for (const level of LEVELS) {
      Assert.equal(
        decideLoad(policy({ sites: { "example.org": level } }), "example.org"),
        level === "blocked" ? "deny" : "allow",
        level
      );
    }
  }
);

add_task(function a_new_site_is_asked_about() {
  Assert.equal(decideLoad(policy(), "example.org"), "ask");
});

add_task(function a_new_site_gets_a_default_level_without_asking() {
  for (const level of LEVELS) {
    Assert.equal(
      decideLoad(policy({ default: level }), "example.org"),
      level === "blocked" ? "deny" : "allow",
      level
    );
  }
});

/**
 * `agents.json` can be edited by hand. The store drops what Sval cannot read
 * as it loads (`cleanPolicy`), and a value that reaches the gate unread is
 * no rule: an unknown site level follows the default. A sites value that is
 * not a map, and an unknown default, ask.
 */
add_task(function a_value_sval_does_not_know_follows_the_default() {
  Assert.equal(
    decideLoad(
      policy({ sites: { "example.org": "everything" }, default: "full" }),
      "example.org"
    ),
    "allow",
    "an unknown site level follows a full default"
  );
  Assert.equal(
    decideLoad(
      policy({ sites: { "example.org": "everything" }, default: "blocked" }),
      "example.org"
    ),
    "deny",
    "and a blocked one"
  );
  Assert.equal(
    decideLoad(policy({ sites: { "example.org": null } }), "example.org"),
    "ask",
    "and one that asks"
  );
  Assert.equal(
    decideLoad(policy({ sites: "garbage", default: "full" }), "example.org"),
    "ask",
    "a sites value that is not a map asks"
  );
  Assert.equal(
    decideLoad(policy({ default: "Full" }), "example.org"),
    "ask",
    "an unknown default asks"
  );
});

/** No policy means Sval does not know the agent. */
add_task(function no_policy_is_denied() {
  Assert.equal(decideLoad(null, "example.org"), "deny");
  Assert.equal(decideLoad(undefined, "example.org"), "deny");
});

/** Sites named after Object.prototype keys are sites like any other. */
add_task(function prototype_names_are_new_sites() {
  Assert.equal(decideLoad(policy(), "constructor"), "ask");
  Assert.equal(decideLoad(policy(), "__proto__"), "ask");
});

const AGENT = { agentId: "a1", label: "Test Agent", workspaceId: "w1" };
const WIN = {};

/**
 * Sval's agent store, its file holding one agent with a policy of `fields`
 * as a hand edit leaves it, and a gate over the store whose alert is
 * answered by `answer`.
 *
 * @param {object} [options]
 * @param {object} [options.fields] Policy fields.
 * @param {Function} [options.answer] Answers each alert; may return a promise.
 */
async function gateWith({ fields, answer = () => "deny" } = {}) {
  const path = SvalTestTemp.tempPath("sval-agents", ".json");
  await IOUtils.writeJSON(path, {
    version: 1,
    agents: {
      [AGENT.agentId]: {
        label: AGENT.label,
        task: "Test task",
        workspaceId: AGENT.workspaceId,
        policy: policy(fields),
      },
    },
  });
  const store = await SvalAgentStore.open(path);
  const asked = [];
  const windowsFor = [];
  const gate = createAgentGate({
    store,
    ask: (win, options) => {
      asked.push({ win, options });
      return answer(options);
    },
    agentWindow: async workspaceId => {
      windowsFor.push(workspaceId);
      return WIN;
    },
  });
  registerCleanupFunction(() => gate.close());
  const currentPolicy = () => store.policyOf(AGENT.agentId);
  return {
    gate,
    store,
    asked,
    windowsFor,
    sites: () => currentPolicy().sites,
    currentPolicy,
  };
}

/**
 * A call's task, as the session makes one for a call with no progress
 * token.
 *
 * @returns {{wait: ApprovalWait, began: Promise}} `began` settles when the
 *   call starts waiting for the user.
 */
function callTask() {
  const { promise: began, resolve: onWaiting } = Promise.withResolvers();
  return { wait: new ApprovalWait({ onWaiting }), began };
}

async function rejectsWith(promise, code) {
  await Assert.rejects(
    promise,
    e => e instanceof ToolError && e.code === code,
    `refused with ${code}`
  );
}

add_task(async function allow_answers_exactly_true() {
  const { gate } = await gateWith({
    fields: { sites: { "example.com": "full" } },
  });
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "https://www.example.com/x"),
    true
  );
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "about:blank"),
    true,
    "about:blank is no site, and always allowed"
  );
});

add_task(async function a_url_agents_may_not_open_is_refused() {
  const { gate, asked } = await gateWith();
  await rejectsWith(
    gate.allowLoad(AGENT, callTask(), "file:///etc/passwd"),
    "unsupported_url"
  );
  await rejectsWith(
    gate.allowLoad(AGENT, callTask(), "blob:https://example.com/x"),
    "unsupported_url"
  );
  Assert.equal(asked.length, 0);
});

/**
 * A blocked site's load goes on to the tab, whose own load check refuses it
 * with about:agentblocked, the page the agent reads as its answer.
 */
add_task(async function a_blocked_site_goes_on_to_its_blocked_page() {
  const { gate, asked } = await gateWith({
    fields: { sites: { "example.org": "blocked" } },
  });
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "https://example.org/"),
    "blocked"
  );
  Assert.equal(asked.length, 0);
});

add_task(async function an_unknown_level_under_an_ask_default_asks() {
  const { gate, asked, sites } = await gateWith({
    fields: { sites: { "example.org": "everything" } },
    answer: () => "allow",
  });
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "https://example.org/"),
    true
  );
  Assert.equal(asked.length, 1, "the user was asked");
  Assert.deepEqual(sites(), { "example.org": "ask-before-writes" });
});

/**
 * A site whose rule Sval cannot read loses it as the store loads, so it
 * follows the default and is not asked.
 */
add_task(async function a_dropped_rule_follows_the_default() {
  const { gate, asked, sites } = await gateWith({
    fields: { sites: { "example.org": "everything" }, default: "full" },
    answer: () => "allow",
  });
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "https://example.org/"),
    true
  );
  Assert.equal(asked.length, 0, "the user was not asked");
  Assert.deepEqual(sites(), {}, "nothing set");
});

add_task(
  async function allow_with_an_unreadable_default_records_ask_before_writes() {
    const { gate, sites } = await gateWith({
      fields: { default: "Full" },
      answer: () => "allow",
    });
    await gate.allowLoad(AGENT, callTask(), "https://example.org/");
    Assert.deepEqual(sites(), { "example.org": "ask-before-writes" });
  }
);

add_task(async function an_agent_sval_no_longer_knows_is_refused() {
  const { gate } = await gateWith();
  await rejectsWith(
    gate.allowLoad(
      { ...AGENT, agentId: "gone" },
      callTask(),
      "https://example.org/"
    ),
    "policy_denied"
  );
});

add_task(async function allow_records_the_default_level() {
  const { gate, asked, windowsFor, sites } = await gateWith({
    answer: () => "allow",
  });
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "https://shop.example.org/cart"),
    true
  );
  Assert.equal(asked.length, 1);
  Assert.equal(asked[0].win, WIN, "asked in the agent's window");
  Assert.deepEqual(windowsFor, [AGENT.workspaceId], "the agent's own");
  const { question, choices, defaultChoice, scope } = asked[0].options;
  Assert.ok(
    question.includes("Test Agent") && question.includes("shop.example.org"),
    "it names the agent and the host"
  );
  Assert.deepEqual(
    choices.map(c => c.id),
    ["allow", "allow_all", "deny"]
  );
  Assert.equal(defaultChoice, "deny");
  Assert.deepEqual(
    scope.choices.map(c => c.id),
    ["shop.example.org", "example.org"],
    "it offers the host, then its site"
  );
  Assert.equal(scope.value, "shop.example.org", "it starts at the host");
  Assert.deepEqual(sites(), { "shop.example.org": "ask-before-writes" });
  await gate.allowLoad(AGENT, callTask(), "https://shop.example.org/");
  Assert.equal(asked.length, 1, "a recorded host is not asked about again");
  await gate.allowLoad(AGENT, callTask(), "https://example.org/");
  Assert.equal(asked.length, 2, "its site is asked about on its own");
});

add_task(async function an_answer_for_the_whole_site_covers_its_hosts() {
  const { gate, asked, sites } = await gateWith({
    answer: options => ({ choice: "deny", scope: options.scope.choices[1].id }),
  });
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "https://shop.example.org/"),
    "blocked"
  );
  Assert.deepEqual(sites(), { "example.org": "blocked" });
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "https://mail.example.org/"),
    "blocked",
    "a sibling host follows the site"
  );
  Assert.equal(asked.length, 1);
});

add_task(async function a_site_with_no_host_to_choose_has_no_scope_menu() {
  const { gate, asked, sites } = await gateWith({ answer: () => "allow" });
  await gate.allowLoad(AGENT, callTask(), "https://www.example.org/");
  Assert.equal(asked[0].options.scope, undefined);
  Assert.deepEqual(sites(), { "example.org": "ask-before-writes" });
});

/**
 * A rule the user sets while the alert is open stands: Allow never replaces
 * it with the default level, and a site they blocked meanwhile is refused.
 */
add_task(async function allow_keeps_a_rule_set_while_the_alert_was_open() {
  let setup;
  const setMeanwhile = level => async () => {
    await setup.store.setSiteLevel(AGENT.agentId, "example.org", level);
    return "allow";
  };
  setup = await gateWith({ answer: setMeanwhile("read-only") });
  Assert.strictEqual(
    await setup.gate.allowLoad(AGENT, callTask(), "https://example.org/"),
    true
  );
  Assert.deepEqual(setup.sites(), { "example.org": "read-only" });

  setup = await gateWith({ answer: setMeanwhile("blocked") });
  Assert.strictEqual(
    await setup.gate.allowLoad(AGENT, callTask(), "https://example.org/"),
    "blocked",
    "on to the blocked page"
  );
  Assert.deepEqual(setup.sites(), { "example.org": "blocked" });
});

/**
 * Allow all sites makes the default read only, the least a site can get and
 * open without asking, so the next new site opens with no alert. The site
 * the alert was about is one of all sites: it gets no rule of its own, so
 * when the user later raises the default to Full access, it has Full access
 * too.
 */
add_task(async function allow_all_sites_makes_the_site_follow_the_default() {
  const { gate, store, asked, sites, currentPolicy } = await gateWith({
    answer: () => "allow_all",
  });
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "https://example.org/"),
    true
  );
  Assert.equal(currentPolicy().default, "read-only");
  Assert.deepEqual(sites(), {}, "no rule of its own");
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "https://example.net/"),
    true
  );
  Assert.equal(asked.length, 1, "the next new site asked nothing");

  await store.setDefault(AGENT.agentId, "full");
  for (const site of ["example.org", "example.net"]) {
    Assert.equal(
      levelFor(currentPolicy(), site).level,
      "full",
      `${site} follows the raised default`
    );
  }
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "https://example.org/"),
    true
  );
  Assert.equal(asked.length, 1, "and still opens without asking");
});

/** A site the user blocked while the alert was open stays blocked. */
add_task(async function allow_all_sites_keeps_a_rule_set_meanwhile() {
  let setup;
  setup = await gateWith({
    answer: async () => {
      await setup.store.setSiteLevel(AGENT.agentId, "example.org", "blocked");
      return "allow_all";
    },
  });
  Assert.strictEqual(
    await setup.gate.allowLoad(AGENT, callTask(), "https://example.org/"),
    "blocked",
    "on to the blocked page"
  );
  Assert.equal(setup.currentPolicy().default, "read-only");
  Assert.deepEqual(setup.sites(), { "example.org": "blocked" });
});

add_task(async function deny_records_blocked() {
  const { gate, sites } = await gateWith({ answer: () => "deny" });
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "https://example.org/"),
    "blocked",
    "on to the blocked page"
  );
  Assert.deepEqual(sites(), { "example.org": "blocked" });
});

add_task(async function no_window_records_nothing() {
  const { gate, sites } = await gateWith({ answer: () => "no_window" });
  await rejectsWith(
    gate.allowLoad(AGENT, callTask(), "https://example.org/"),
    "no_window"
  );
  Assert.deepEqual(sites(), {});
});

/** Any answer the alert was not offered is a deny. */
add_task(async function an_unexpected_answer_is_deny() {
  const { gate, sites } = await gateWith({ answer: () => "maybe" });
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "https://example.org/"),
    "blocked",
    "on to the blocked page"
  );
  Assert.deepEqual(sites(), { "example.org": "blocked" });
});

add_task(async function a_site_not_asked_about_is_allowed() {
  const { gate, asked } = await gateWith({
    fields: { default: "ask-before-writes" },
  });
  Assert.strictEqual(
    await gate.allowLoad(AGENT, callTask(), "https://example.org/"),
    true
  );
  Assert.equal(asked.length, 0);
});

/**
 * An alert nobody answers in time leaves the call with awaiting_approval and
 * the alert open; a retry for the same site waits on that alert, and the
 * answer, when it comes, is recorded.
 */
add_task(async function an_unanswered_alert_is_shared_by_retries() {
  let answer;
  const answered = new Promise(resolve => (answer = resolve));
  const { gate, asked, sites } = await gateWith({ answer: () => answered });
  for (const url of ["https://example.org/", "https://www.example.org/"]) {
    const task = callTask();
    const opening = gate.allowLoad(AGENT, task, url);
    await within(task.began, 10_000, "the call waiting for the user");
    // The agent cancels the call, which gives up its wait as running out of
    // time does.
    task.wait.cancel();
    await Assert.rejects(
      opening,
      e => e.code === "awaiting_approval" && e.message.includes("example.org"),
      url
    );
  }
  Assert.equal(asked.length, 1, "one alert for both calls");
  const third = gate.allowLoad(AGENT, callTask(), "https://example.org/");
  answer("allow");
  Assert.strictEqual(await third, true);
  Assert.deepEqual(sites(), { "example.org": "ask-before-writes" });
});

add_task(async function each_site_has_its_own_alert() {
  const { gate, asked } = await gateWith({ answer: () => "allow" });
  await gate.allowLoad(AGENT, callTask(), "https://example.org/");
  await gate.allowLoad(AGENT, callTask(), "https://example.net/");
  Assert.equal(asked.length, 2);
  Assert.ok(asked[0].options.question.includes("example.org"));
  Assert.ok(asked[1].options.question.includes("example.net"));
});

/**
 * A task for one call that carries a progress token, as the session makes
 * it.
 *
 * @returns {{task: object, sent: object[], began: Promise}} `began` settles
 *   when the call starts waiting for the user.
 */
function waitingTask() {
  const sent = [];
  const { promise: began, resolve: onWaiting } = Promise.withResolvers();
  const wait = new ApprovalWait({
    progressToken: "t-1",
    notify: n => sent.push(n),
    onWaiting,
  });
  return { task: { wait }, sent, began };
}

/**
 * A call that carries a progress token waits for the user's answer, and
 * Allow carries it on (spec §5.6).
 */
add_task(async function a_call_with_a_progress_token_waits_for_allow() {
  let answer;
  const answered = new Promise(resolve => (answer = resolve));
  const { gate } = await gateWith({ answer: () => answered });
  const { task, sent, began } = waitingTask();
  let settled = false;
  const opening = gate
    .allowLoad(AGENT, task, "https://example.org/")
    .finally(() => (settled = true));
  await within(began, 10_000, "the call waiting for the user");
  await drain();
  Assert.ok(!settled, "waiting for the user");
  Assert.equal(sent.length, 1, "and saying so");
  answer("allow");
  Assert.strictEqual(await opening, true);
});

/**
 * Deny, and a window that closed, end such a call at once: Deny with the
 * load let on to its blocked page, a closed window with `no_window`.
 */
add_task(async function deny_and_no_window_end_a_waiting_call() {
  for (const [given, code] of [
    ["deny", null],
    ["no_window", "no_window"],
  ]) {
    let answer;
    const answered = new Promise(resolve => (answer = resolve));
    const { gate } = await gateWith({ answer: () => answered });
    const { task, began } = waitingTask();
    const opening = gate.allowLoad(AGENT, task, "https://example.org/");
    await within(began, 10_000, "the call waiting for the user");
    answer(given);
    if (code) {
      await rejectsWith(opening, code);
    } else {
      Assert.strictEqual(await opening, "blocked");
    }
  }
});

/**
 * A connection with `MAX_WAITING_CALLS` calls waiting for the user answers a
 * call that would wait awaiting_approval at once: no alert is raised, and no
 * input is performed.
 */
add_task(async function a_full_connection_asks_nothing_more() {
  const { gate, asked } = await gateWith({
    answer: () => new Promise(() => {}),
  });
  const full = () => ({
    wait: new ApprovalWait({ slots: { waiting: MAX_WAITING_CALLS } }),
  });
  await rejectsWith(
    gate.allowLoad(AGENT, full(), "https://example.org/"),
    "awaiting_approval"
  );
  Assert.equal(asked.length, 0, "no alert");
  let ran = false;
  await rejectsWith(
    gate.act({ browsingContext: { browserId: 4343 } }, AGENT, full(), () => {
      ran = true;
    }),
    "awaiting_approval"
  );
  Assert.ok(!ran, "no input");
});

/** Agent access going off ends every call's wait at once. */
add_task(async function access_going_off_ends_a_waiting_call() {
  const { gate } = await gateWith({ answer: () => new Promise(() => {}) });
  const { task, began } = waitingTask();
  const opening = gate.allowLoad(AGENT, task, "https://example.org/");
  await within(began, 10_000, "the call waiting for the user");
  gate.close();
  await Assert.rejects(opening, e => e.code === "awaiting_approval", "at once");
});

/*
 * The write gate's timing and batching (agent-control spec §5.3), as the pure
 * `ActionWindow` on Sval's own timers, and channels that record what was done
 * to them.
 */

/**
 * A channel that records being suspended, resumed and cancelled. It counts
 * as finished, as a quick request would be by the time the window looks
 * again, unless `pending` is set.
 *
 * @param {string} method
 * @param {string} [url]
 * @param {object} [state]
 * @param {boolean} [state.pending]
 * @param {number} [state.status]
 * @param {number} [state.type] The `nsIContentPolicy` type that sent it.
 */
function fakeChannel(
  method,
  url = "https://api.example.com/v1/order?id=7",
  {
    pending = false,
    status = Cr.NS_OK,
    type = Ci.nsIContentPolicy.TYPE_FETCH,
  } = {}
) {
  const uri = Services.io.newURI(url);
  return {
    loadInfo: { externalContentPolicyType: type },
    requestMethod: method,
    URI: { spec: uri.spec, host: uri.host, filePath: uri.filePath },
    pending,
    status,
    isPending() {
      return this.pending;
    },
    done: [],
    suspend() {
      this.done.push("suspend");
    },
    resume() {
      this.done.push("resume");
    },
    cancel(reason) {
      this.done.push(reason === Cr.NS_ERROR_ABORT ? "cancel" : "cancel?");
    },
  };
}

/**
 * An action window whose top-level page is `site` at `level`.
 *
 * @param {object} [options]
 * @param {string} [options.level]
 * @param {string|null} [options.site]
 * @param {?string} [options.allowSite]
 */
function actionWindow({
  level = "ask-before-writes",
  site = "example.com",
  allowSite = null,
} = {}) {
  const held = [];
  const action = new ActionWindow({
    topOf: () => ({ site, level }),
    allowSite,
    onHold: channel => held.push(channel),
  });
  return { action, held };
}

/**
 * Says the input is done and waits for the window to close.
 *
 * @param {ActionWindow} action
 * @param {number} [limit] How long the close may take.
 * @returns {Promise<object>} What the window hands back.
 */
function inputDoneAndClosed(action, limit = QUIET_MS + 10_000) {
  return within(action.inputDone(), limit, "the action window closing");
}

/** Lets the promise callbacks queued so far run. */
const drain = () => new Promise(resolve => executeSoon(resolve));

add_task(async function a_write_in_the_window_is_held_and_a_get_passes() {
  const { action, held } = actionWindow();
  const post = fakeChannel("POST");
  const get = fakeChannel("GET", "https://example.com/page");
  Assert.equal(action.offer(post), "held");
  Assert.deepEqual(post.done, ["suspend"], "the write waits");
  Assert.deepEqual(held, [post], "the gate is told of the held channel");
  Assert.equal(action.offer(get), "pass");
  Assert.deepEqual(get.done, [], "a GET is left alone");
  for (const method of ["HEAD", "OPTIONS"]) {
    Assert.equal(action.offer(fakeChannel(method)), "pass", method);
  }
  for (const method of ["PUT", "PATCH", "DELETE", "PROPFIND"]) {
    Assert.equal(action.offer(fakeChannel(method)), "held", method);
  }
  const { held: batch, refused, sent } = await inputDoneAndClosed(action);
  Assert.equal(batch.length, 5);
  Assert.deepEqual(
    { ...batch[0], channel: batch[0].channel === post },
    {
      channel: true,
      method: "POST",
      site: "example.com",
      target: "api.example.com",
      path: "/v1/order",
    },
    "the batch names the method, the target's host and the path"
  );
  Assert.equal(refused, 0);
  Assert.equal(sent, 0);
});

add_task(async function a_target_with_no_site_is_named_by_its_host() {
  const { action } = actionWindow();
  action.offer(fakeChannel("POST", "http://127.0.0.1:8888/submit"));
  const { held } = await inputDoneAndClosed(action);
  Assert.equal(held[0].target, "127.0.0.1");
  Assert.equal(held[0].path, "/submit");
});

add_task(async function the_window_closes_once_the_network_is_quiet() {
  const { action } = actionWindow();
  action.offer(fakeChannel("GET"));
  action.offer(fakeChannel("POST"));
  const last = ChromeUtils.now();
  const { held } = await inputDoneAndClosed(action);
  Assert.greaterOrEqual(
    ChromeUtils.now() - last,
    QUIET_MS,
    "no sooner than QUIET_MS after the last request"
  );
  Assert.equal(held.length, 1);
});

add_task(async function a_write_after_the_window_closed_passes() {
  const { action } = actionWindow();
  await inputDoneAndClosed(action);
  const post = fakeChannel("POST");
  Assert.equal(action.offer(post), "pass");
  Assert.deepEqual(post.done, [], "nothing held it");
});

add_task(async function read_only_cancels_a_write_at_once() {
  const { action, held } = actionWindow({ level: "read-only" });
  const post = fakeChannel("POST");
  Assert.equal(action.offer(post), "refused");
  Assert.deepEqual(post.done, ["cancel"], "cancelled, never suspended");
  Assert.deepEqual(held, []);
  const get = fakeChannel("GET");
  Assert.equal(action.offer(get), "pass", "a read-only page still reads");
  Assert.deepEqual(await inputDoneAndClosed(action), {
    held: [],
    refused: 1,
    sent: 0,
  });
});

add_task(async function full_access_lets_writes_through() {
  const { action } = actionWindow({ level: "full" });
  const post = fakeChannel("POST");
  Assert.equal(action.offer(post), "pass");
  Assert.deepEqual(post.done, []);
  Assert.deepEqual(await inputDoneAndClosed(action), {
    held: [],
    refused: 0,
    sent: 1,
  });
});

/**
 * A write that would pass, at Full access, for the site an action's alert
 * already allowed, or as a beacon, is cancelled when it goes to a site the
 * agent may not load. One that would be held is still held: its release
 * refuses it (`mayStillSend`).
 */
add_task(async function a_write_to_a_blocked_site_never_passes_unasked() {
  const blocked = (level, allowSite = null) =>
    new ActionWindow({
      topOf: () => ({ site: "example.com", level, targetBlocked: true }),
      allowSite,
    });
  const beacon = () =>
    fakeChannel("POST", "https://stats.example.net/v1/events", {
      type: Ci.nsIContentPolicy.TYPE_BEACON,
    });
  for (const [what, action, channel, expected] of [
    ["full access", blocked("full"), fakeChannel("POST"), "refused"],
    ["a beacon at full", blocked("full"), beacon(), "refused"],
    ["a beacon", blocked("ask-before-writes"), beacon(), "refused"],
    [
      "an allowed site",
      blocked("ask-before-writes", "example.com"),
      fakeChannel("POST"),
      "refused",
    ],
    ["a held write", blocked("ask-before-writes"), fakeChannel("POST"), "held"],
  ]) {
    Assert.equal(action.offer(channel), expected, what);
    Assert.deepEqual(
      channel.done,
      [expected === "held" ? "suspend" : "cancel"],
      what
    );
  }
});

/** Blocked, unknown and unreadable levels fail closed. */
add_task(async function a_write_the_gate_cannot_place_is_cancelled() {
  for (const level of ["blocked", "everything", null]) {
    const { action } = actionWindow({ level });
    const post = fakeChannel("POST");
    Assert.equal(action.offer(post), "refused", String(level));
    Assert.deepEqual(post.done, ["cancel"], String(level));
  }
  const action = new ActionWindow({
    topOf: () => {
      throw new Error("no policy");
    },
  });
  const post = fakeChannel("POST");
  Assert.equal(action.offer(post), "refused");
  Assert.deepEqual(post.done, ["cancel"]);
});

/**
 * A beacon or a ping gets no answer a page can act on, and sites send them
 * for analytics, so the window never holds one (spec §5.3). A site that
 * refuses writes still refuses them.
 */
add_task(async function beacons_and_pings_pass_unless_the_site_refuses_them() {
  for (const type of [
    Ci.nsIContentPolicy.TYPE_BEACON,
    Ci.nsIContentPolicy.TYPE_PING,
  ]) {
    for (const [level, expected] of [
      ["ask-before-writes", "pass"],
      ["full", "pass"],
      ["read-only", "refused"],
      ["blocked", "refused"],
    ]) {
      const { action, held } = actionWindow({ level });
      const sent = fakeChannel("POST", "https://stats.example.net/v1/events", {
        type,
      });
      Assert.equal(action.offer(sent), expected, `type ${type} at ${level}`);
      Assert.deepEqual(sent.done, expected === "pass" ? [] : ["cancel"]);
      Assert.deepEqual(held, [], "never held");
    }
  }
  const { action } = actionWindow();
  Assert.equal(
    action.offer(fakeChannel("POST")),
    "held",
    "a fetch is still held"
  );
});

/**
 * Only what the agent's input went to is the agent's: a request the gate
 * says another document sent passes, whatever it is, and is not counted.
 */
add_task(async function a_request_another_document_sent_passes_uncounted() {
  const action = new ActionWindow({
    topOf: () => ({ site: "example.com", level: "ask-before-writes" }),
    isAgents: channel => !channel.elsewhere,
  });
  const theirs = Object.assign(fakeChannel("POST"), { elsewhere: true });
  Assert.equal(action.offer(theirs), "pass");
  Assert.deepEqual(theirs.done, [], "left alone");
  const slow = Object.assign(
    fakeChannel("GET", "https://example.com/stream", { pending: true }),
    { elsewhere: true }
  );
  Assert.equal(action.offer(slow), "pass");
  Assert.deepEqual(
    await inputDoneAndClosed(action),
    { held: [], refused: 0, sent: 0 },
    "the window closed on its own quiet, not counting either"
  );
});

/** A `<browser>` as far as `act` reads one, showing a blank page. */
const BROWSER = {
  browsingContext: {
    browserId: 4242,
    currentWindowGlobal: {
      documentPrincipal: Services.scriptSecurityManager.createNullPrincipal({}),
      documentURI: Services.io.newURI("about:blank"),
    },
  },
};

add_task(async function act_answers_with_the_input_and_its_writes() {
  const { gate } = await gateWith();
  const task = callTask();
  Assert.deepEqual(
    await gate.act(BROWSER, AGENT, task, async () => ({ value: "x" })),
    { value: "x", writes: "none", held: 0 }
  );
});

/**
 * One input at a time per tab: a second waits until the first one's window
 * has closed, so one batch never holds two inputs' writes.
 */
add_task(async function a_second_input_on_a_tab_waits_for_the_first() {
  const { gate } = await gateWith();
  const task = callTask();
  const order = [];
  const firstStarted = Promise.withResolvers();
  const release = Promise.withResolvers();
  const first = gate.act(BROWSER, AGENT, task, async () => {
    order.push("first starts");
    firstStarted.resolve();
    await release.promise;
    order.push("first ends");
    return {};
  });
  const second = gate.act(BROWSER, AGENT, task, async () => {
    order.push("second starts");
    return {};
  });
  await firstStarted.promise;
  await drain();
  release.resolve();
  await Promise.all([first, second]);
  Assert.deepEqual(order, ["first starts", "first ends", "second starts"]);
});

/**
 * An input that fails still says what became of its writes, so no error
 * hides a write that was held or let through.
 */
add_task(async function a_failed_input_carries_its_writes() {
  const { gate } = await gateWith();
  const task = callTask();
  await Assert.rejects(
    gate.act(BROWSER, AGENT, task, async () => {
      throw new ToolError("not_focusable", "focus moved");
    }),
    e =>
      e instanceof ToolError &&
      e.code === "not_focusable" &&
      e.writes === "none" &&
      e.held === 0
  );
});

add_task(async function act_refuses_a_browser_with_no_content() {
  const { gate } = await gateWith();
  let ran = false;
  await rejectsWith(
    gate.act({}, AGENT, callTask(), async () => {
      ran = true;
    }),
    "no_document"
  );
  Assert.ok(!ran, "nothing was input");
});

/**
 * The user's take is checked as the input is about to go: a tab the user
 * took while the call waited gets no input.
 */
add_task(async function act_refuses_a_tab_the_user_holds() {
  const { gate } = await gateWith();
  takeControl(BROWSER.browsingContext.browserId);
  try {
    let ran = false;
    await rejectsWith(
      gate.act(BROWSER, AGENT, callTask(), async () => {
        ran = true;
      }),
      "user_in_control"
    );
    Assert.ok(!ran, "nothing was input");
  } finally {
    forgetControl(BROWSER.browsingContext.browserId);
  }
});

add_task(async function act_refuses_once_agent_access_is_off() {
  const { gate } = await gateWith();
  gate.close();
  let ran = false;
  await rejectsWith(
    gate.act(BROWSER, AGENT, callTask(), async () => {
      ran = true;
    }),
    "disconnected"
  );
  Assert.ok(!ran, "nothing was input");
});

/**
 * "Quiet" is the network's quiet (spec §5.3): a request still in flight keeps
 * the window open, so a click handler that awaits a slow read before it
 * writes is still caught.
 */
add_task(async function a_request_in_flight_keeps_the_window_open() {
  const { action } = actionWindow();
  const slow = fakeChannel("GET", "https://example.com/token", {
    pending: true,
  });
  action.offer(slow);
  const closing = action.inputDone();
  Assert.ok(action.isOpen, "open while the read is in flight");
  Assert.equal(action.offer(fakeChannel("POST")), "held");
  slow.pending = false;
  // Read before `stopped`, which starts the quiet time, so the measured wait
  // is never shorter than the window's own.
  const quiet = ChromeUtils.now();
  action.stopped(slow);
  await within(closing, QUIET_MS + 10_000, "the action window closing");
  Assert.greaterOrEqual(
    ChromeUtils.now() - quiet,
    QUIET_MS,
    "closed no sooner than QUIET_MS after the network went quiet"
  );
});

/** A request that ended without a stop notice does not hold the window. */
add_task(async function a_finished_request_is_noticed_without_its_stop() {
  const { action } = actionWindow();
  const read = fakeChannel("GET", "https://example.com/x", { pending: true });
  action.offer(read);
  const done = ChromeUtils.now();
  const closing = action.inputDone();
  read.pending = false;
  await within(closing, QUIET_MS + 10_000, "the action window closing");
  Assert.less(ChromeUtils.now() - done, CAP_MS, "well before the cap");
});

/** A held or refused write is not traffic the window waits for. */
add_task(async function held_and_refused_writes_are_not_in_flight() {
  for (const [level, why] of [
    ["ask-before-writes", "a held write does not keep it open"],
    ["read-only", "nor does a refused one"],
  ]) {
    const { action } = actionWindow({ level });
    action.offer(fakeChannel("POST", undefined, { pending: true }));
    const done = ChromeUtils.now();
    await inputDoneAndClosed(action);
    Assert.less(ChromeUtils.now() - done, CAP_MS, why);
  }
});

/** A request the site half already refused is not held or listed. */
add_task(async function a_request_already_cancelled_is_left_alone() {
  const { action, held } = actionWindow();
  const refused = fakeChannel("POST", undefined, {
    status: Cr.NS_ERROR_ABORT,
  });
  Assert.equal(action.offer(refused), "pass");
  Assert.deepEqual(refused.done, []);
  Assert.deepEqual(held, []);
  Assert.deepEqual(await inputDoneAndClosed(action), {
    held: [],
    refused: 0,
    sent: 0,
  });
});

/** With agent access switched off, every write the window sees is cancelled. */
add_task(async function a_window_told_to_refuse_cancels_every_write() {
  const { action } = actionWindow({ level: "full" });
  action.refuseWrites();
  const post = fakeChannel("POST");
  Assert.equal(action.offer(post), "refused");
  Assert.deepEqual(post.done, ["cancel"]);
  Assert.equal(action.offer(fakeChannel("GET")), "pass");
});

/**
 * A page tool call the user allowed sends its writes without a second
 * alert, and a Read-only site still cancels them (site-tools spec §4.3).
 */
add_task(async function an_allowed_action_sends_its_writes_unless_read_only() {
  const allowed = actionWindow({ allowSite: "example.com" });
  Assert.equal(allowed.action.offer(fakeChannel("POST")), "pass");
  Assert.deepEqual(allowed.held, [], "nothing is held");

  const elsewhere = actionWindow({
    allowSite: "other.example",
    site: "example.com",
  });
  Assert.equal(
    elsewhere.action.offer(fakeChannel("POST")),
    "held",
    "a write to a page on another site is judged as usual"
  );

  const readOnly = actionWindow({
    allowSite: "example.com",
    level: "read-only",
  });
  const post = fakeChannel("POST");
  Assert.equal(readOnly.action.offer(post), "refused");
  Assert.ok(post.done.includes("cancel"), "a Read-only site cancels it");
});

/**
 * A tool reads a page only on a site the agent may open now: one the user
 * has not answered about yet is refused like a blocked one, in words that
 * say it was not allowed rather than that it was blocked.
 */
add_task(async function a_page_on_an_unanswered_site_is_refused() {
  const { gate, asked } = await gateWith({
    fields: { sites: { "example.com": "full", "example.org": "blocked" } },
  });
  Assert.strictEqual(gate.checkSite(AGENT, "example.com"), true);
  Assert.strictEqual(gate.checkSite(AGENT, null), true, "no site, no check");
  Assert.throws(
    () => gate.checkSite(AGENT, "example.net"),
    e =>
      e instanceof ToolError &&
      e.code === "policy_denied" &&
      e.details?.reason === "not_allowed",
    "a site nobody answered about is refused"
  );
  Assert.throws(
    () => gate.checkSite(AGENT, "example.org"),
    e =>
      e instanceof ToolError &&
      e.code === "policy_denied" &&
      e.details?.reason === "blocked",
    "and so is a blocked one"
  );
  Assert.equal(asked.length, 0, "and nothing is asked: a read is no load");
});

/**
 * An upload folder allows the files directly in it, and the files in the
 * folders inside it only when its grant says so (decision 0129).
 */
add_task(async function an_upload_folder_covers_what_its_scope_says() {
  const temp = SvalTestTemp;
  // The gate is given resolved paths (`resolvedFile` in `SvalAgentTools`).
  const made = new FileUtils.File(await temp.makeTempDir("sval-upload-scope"));
  made.normalize();
  const dir = made.path;
  const inner = PathUtils.join(dir, "inner");
  await IOUtils.makeDirectory(inner);
  const top = PathUtils.join(dir, "a.txt");
  const deep = PathUtils.join(inner, "b.txt");
  await IOUtils.writeUTF8(top, "a");
  await IOUtils.writeUTF8(deep, "b");
  const only = [{ path: dir, subfolders: false }];
  const all = [{ path: dir, subfolders: true }];
  Assert.ok(inUploadFolders([top], only), "a file in the folder");
  Assert.ok(!inUploadFolders([deep], only), "not one in a folder inside it");
  Assert.ok(!inUploadFolders([top, deep], only), "every file must be allowed");
  Assert.ok(inUploadFolders([top, deep], all), "the folders inside it too");
  Assert.ok(
    inUploadFolders([deep], [{ path: inner, subfolders: false }]),
    "a folder inside it can be allowed on its own"
  );
  Assert.ok(
    !inUploadFolders([top], [{ path: "relative", subfolders: true }]),
    "a path that is not absolute holds nothing"
  );
});
