/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Be polite (`SvalAgentPolite`): the limiter that spaces an agent's actions on
 * a site, the user's tick for each agent, and the rate setting.
 */

const {
  createLimiter,
  isPolite,
  MAX_QUEUED,
  POLITE_RATE_PREF,
  politeRules,
  RateLimited,
  POLITE_TOPIC,
  politeRate,
  forgetPolite,
  limiterFor,
  setPolite,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs"
);

/**
 * A limiter on a clock that moves only when a sleep ends or the test advances
 * it, so actions that arrive together all read the same time.
 */
function manual() {
  const clock = { t: 0, slept: [] };
  const limiter = createLimiter({
    now: () => clock.t,
    sleep: async ms => {
      clock.slept.push(ms);
      await null;
      clock.t += ms;
    },
  });
  return { clock, limiter };
}

add_task(async function actions_on_a_site_are_a_second_apart_at_one_a_second() {
  const { clock, limiter } = manual();
  Assert.equal(
    await limiter.wait("example.com", 1),
    0,
    "the first goes at once"
  );
  Assert.equal(await limiter.wait("example.com", 1), 1000, "the next waits");
  Assert.equal(await limiter.wait("example.com", 1), 1000, "and the next");
  Assert.deepEqual(clock.slept, [1000, 1000]);
});

add_task(async function the_rate_sets_the_gap() {
  const { limiter } = manual();
  await limiter.wait("example.com", 4);
  Assert.equal(await limiter.wait("example.com", 4), 250);
});

add_task(async function a_pause_pays_for_the_wait() {
  const { clock, limiter } = manual();
  await limiter.wait("example.com", 1);
  clock.t += 600;
  Assert.equal(await limiter.wait("example.com", 1), 400, "only what is left");
  clock.t += 5000;
  Assert.equal(await limiter.wait("example.com", 1), 0, "nothing after a rest");
});

add_task(async function each_site_has_its_own_clock() {
  const { limiter } = manual();
  await limiter.wait("example.com", 1);
  Assert.equal(await limiter.wait("example.org", 1), 0);
  Assert.equal(await limiter.wait("example.com", 1), 1000);
});

add_task(async function actions_that_arrive_together_queue_in_order() {
  const { limiter } = manual();
  const waits = await Promise.all(
    [1, 2, 3].map(() => limiter.wait("example.com", 1))
  );
  Assert.deepEqual(waits, [0, 1000, 2000]);
});

add_task(async function a_fractional_wait_is_rounded_to_whole_milliseconds() {
  const { clock, limiter } = manual();
  await limiter.wait("example.com", 3);
  clock.t += 0.2;
  const waited = await limiter.wait("example.com", 3);
  Assert.ok(Number.isInteger(waited), "whole milliseconds");
  Assert.equal(waited, 333);
});

add_task(function every_agent_starts_polite_and_the_user_can_waive_it() {
  const seen = [];
  const observer = { observe: (s, t, id) => seen.push(id) };
  Services.obs.addObserver(observer, POLITE_TOPIC);
  registerCleanupFunction(() =>
    Services.obs.removeObserver(observer, POLITE_TOPIC)
  );

  Assert.ok(isPolite("agent-a"), "ticked by default");
  setPolite("agent-a", false);
  Assert.ok(!isPolite("agent-a"));
  Assert.ok(isPolite("agent-b"), "for that agent alone");
  setPolite("agent-a", false);
  setPolite("agent-a", true);
  Assert.ok(isPolite("agent-a"));
  Assert.deepEqual(
    seen,
    ["agent-a", "agent-a"],
    "each change is announced once"
  );
});

add_task(function forgetting_an_agent_ticks_it_again() {
  setPolite("agent-c", false);
  forgetPolite("agent-c");
  Assert.ok(isPolite("agent-c"));
  forgetPolite("agent-never-seen");
  Assert.ok(isPolite("agent-never-seen"));
});

add_task(function the_rate_is_a_setting_that_holds_whole_numbers_from_one() {
  Services.prefs.clearUserPref(POLITE_RATE_PREF);
  Assert.equal(politeRate(), 1, "one a second by default");
  Services.prefs.setIntPref(POLITE_RATE_PREF, 5);
  Assert.equal(politeRate(), 5);
  Services.prefs.setIntPref(POLITE_RATE_PREF, 0);
  Assert.equal(politeRate(), 1, "zero does not mean unlimited");
  Services.prefs.setIntPref(POLITE_RATE_PREF, -3);
  Assert.equal(politeRate(), 1);
  Services.prefs.clearUserPref(POLITE_RATE_PREF);
});

/**
 * A limiter whose sleeps end only when the test ends them, so actions stay
 * queued for as long as the test needs.
 */
function held() {
  const clock = { t: 0, sleeps: [] };
  const limiter = createLimiter({
    now: () => clock.t,
    sleep: ms => {
      const { promise, resolve } = Promise.withResolvers();
      clock.sleeps.push({ ms, resolve });
      return promise;
    },
  });
  return { clock, limiter };
}

add_task(async function a_full_queue_refuses_with_when_to_try_again() {
  const { clock, limiter } = held();
  let queued = 0;
  const onQueued = () => queued++;
  Assert.equal(await limiter.wait("example.com", 1, onQueued), 0);
  Assert.equal(queued, 0, "an action that goes at once is not queued");
  const waits = [];
  for (let i = 0; i < MAX_QUEUED; i++) {
    waits.push(limiter.wait("example.com", 1, onQueued));
  }
  Assert.equal(queued, MAX_QUEUED, "each is told it waits, as it is queued");

  const refused = await limiter.wait("example.com", 1, onQueued).then(
    () => null,
    err => err
  );
  Assert.ok(refused instanceof RateLimited, "one more is refused");
  Assert.equal(refused.retryAfterMs, 1000, "until the first queued one goes");
  Assert.equal(queued, MAX_QUEUED, "and is not queued");
  Assert.equal(
    await limiter.wait("example.org", 1, onQueued),
    0,
    "another site's queue is its own"
  );

  clock.t = 400;
  const later = await limiter.wait("example.com", 1).catch(err => err);
  Assert.equal(later.retryAfterMs, 600, "what is left of that wait");

  clock.t = 1000;
  clock.sleeps.shift().resolve();
  Assert.equal(await waits[0], 1000, "the first queued one goes");
  const next = limiter.wait("example.com", 1);
  Assert.equal(clock.sleeps.at(-1).ms, MAX_QUEUED * 1000, "its place is taken");
  for (const sleep of clock.sleeps.splice(0)) {
    clock.t += 1000;
    sleep.resolve();
  }
  Assert.deepEqual(await Promise.all(waits.slice(1)), [2000, 3000, 4000]);
  Assert.equal(await next, 4000);
});

/**
 * A queued action's sleep can end after its start has passed. Until it does,
 * that action holds no place in the queue.
 */
add_task(async function an_action_past_its_start_holds_no_place() {
  const { clock, limiter } = held();
  await limiter.wait("example.com", 1);
  const waits = [];
  for (let i = 0; i < MAX_QUEUED; i++) {
    waits.push(limiter.wait("example.com", 1));
  }
  clock.t = 1500;
  let queued = false;
  const next = limiter
    .wait("example.com", 1, () => (queued = true))
    .catch(err => err);
  Assert.ok(
    queued || (await next).retryAfterMs > 0,
    "the next action is queued, or refused until a wait still ahead"
  );
  for (const sleep of clock.sleeps.splice(0)) {
    sleep.resolve();
  }
  await Promise.all([...waits, next]);
});

add_task(function the_rules_an_agent_is_told() {
  Services.prefs.clearUserPref(POLITE_RATE_PREF);
  Assert.deepEqual(politeRules("agent-r"), {
    on: true,
    actions_per_second: 1,
    interval_ms: 1000,
    max_queued: MAX_QUEUED,
  });
  Services.prefs.setIntPref(POLITE_RATE_PREF, 3);
  setPolite("agent-r", false);
  Assert.deepEqual(politeRules("agent-r"), {
    on: false,
    actions_per_second: 3,
    interval_ms: 333,
    max_queued: MAX_QUEUED,
  });
  forgetPolite("agent-r");
  Services.prefs.clearUserPref(POLITE_RATE_PREF);
});

add_task(async function an_agent_has_one_limiter_across_its_sessions() {
  const first = limiterFor("agent-one");
  Assert.equal(limiterFor("agent-one"), first, "a second session shares it");
  Assert.notEqual(limiterFor("agent-two"), first, "another agent has its own");

  Assert.equal(await first.wait("example.com", 1), 0, "the first goes at once");
  const waited = limiterFor("agent-one").wait("example.com", 1);
  Assert.equal(
    await limiterFor("agent-two").wait("example.com", 1),
    0,
    "another agent's turn on the site is its own"
  );
  Assert.greater(await waited, 0, "the agent's next action waits its turn");

  forgetPolite("agent-one");
  Assert.notEqual(limiterFor("agent-one"), first, "unpairing drops it");
  forgetPolite("agent-one");
  forgetPolite("agent-two");
});
