/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * Be polite (agent-control spec §5.5): an agent's actions on a site are
 * spaced out at the rate the user sets, reads never are, and only the user
 * can lift the limit.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { PAGE_TOOL_DEFINITIONS, TOOL_DEFINITIONS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentTools.sys.mjs"
);
const { validateArgs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentArgs.sys.mjs"
);
const { isPolite, POLITE_RATE_PREF, setPolite } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPolite.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/** The levels the agents here have: full access to the test pages' sites. */
const SITES = { "example.com": "full", "example.org": "full" };

/**
 * A paired agent, on the stack the product builds.
 *
 * @param {object} [sites] Its levels.
 * @returns {Promise<object>} `agentSetup`'s.
 */
function agentTools(sites = SITES) {
  return agentSetup({ sites });
}

/**
 * @param {object} schema
 * @returns {Set<string>} The names of every property `schema` takes, at any
 *   depth, so a field of `fill_form`'s `fields` counts as one it takes.
 */
function parameterNames(schema) {
  const names = new Set();
  const walk = s => {
    if (!s) {
      return;
    }
    for (const [name, property] of Object.entries(s.properties ?? {})) {
      names.add(name);
      walk(property);
    }
    walk(s.items);
  };
  walk(schema);
  return names;
}

/**
 * @param {object} result A tool's result.
 * @returns {object} Its JSON, an error's included.
 */
const bodyOf = result => JSON.parse(result.content[0].text);

/**
 * Be polite: an agent's actions on a site are spaced out, whichever of its
 * tabs they are in, and a result says how long it waited when it did.
 */
add_task(async function be_polite_spaces_actions_per_site_across_tabs() {
  const { call } = await agentTools();
  const first = await call("open_tab", { url: PAGE });
  const second = await call("open_tab", { url: PAGE });
  Assert.greater(second.throttled_ms, 0, "the next, in another tab, waits");
  Assert.lessOrEqual(second.throttled_ms, 1000, "a second at most");
  const scrolled = await call("scroll_page", {
    tab: first.tab,
    direction: "down",
  });
  Assert.greater(scrolled.throttled_ms, 0, "so does one in the first tab");
  const other = await call("open_tab", { url: ORG_PAGE });
  Assert.ok(!("throttled_ms" in other), "another site has its own pace");
});

/**
 * An input waits out its page's quiet window (`QUIET_MS`), longer than a
 * quarter second, so an action sent after another's answer finds a quarter
 * second's turn gone. Two sent together are spaced by the limiter alone: the
 * first waits for the turn the open_tab left at the default rate, which lets
 * the connection take the second at once, and the second's turn comes one
 * interval, at the rate set when the first claimed its turn, after the first's.
 */
add_task(async function be_polite_uses_the_rate_the_user_set() {
  const { call } = await agentTools();
  const { tab } = await call("open_tab", { url: PAGE });
  await SpecialPowers.pushPrefEnv({ set: [[POLITE_RATE_PREF, 4]] });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  const [first, second] = await Promise.all([
    call("scroll_page", { tab, direction: "down" }),
    call("scroll_page", { tab, direction: "up" }),
  ]);
  Assert.greater(first.throttled_ms, 0, "the first waits its turn");
  const gap = second.throttled_ms - first.throttled_ms;
  Assert.greater(gap, 0, "the second waits longer");
  Assert.lessOrEqual(gap, 250, "by a quarter second at most: four a second");
});

add_task(async function every_acting_tool_waits_and_no_reading_tool_does() {
  const { call, raw } = await agentTools();
  const { tab } = await call("open_tab", { url: PAGE });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = re => snapshot.match(re)[1];
  for (const [name, args] of [
    ["get_snapshot", { tab }],
    ["get_page_source", { tab, offset: 0 }],
    ["get_page_text", { tab }],
    ["wait_for_text", { tab, text: "Sign in", timeout_ms: 300 }],
    ["list_downloads", {}],
  ]) {
    Assert.ok(!("throttled_ms" in (await call(name, args))), `${name} reads`);
  }
  await raw("get_screenshot", { tab });
  const spare = (await call("open_tab", { url: PAGE2 })).tab;
  Assert.ok(
    !("throttled_ms" in (await call("close_tab", { tab: spare }))),
    "close_tab never waits"
  );
  for (const [name, args] of [
    ["navigate_tab", { tab, to: PAGE }],
    ["click_element", { tab, ref: ref(/link "Next page" \[(e\d+)\]/) }],
    ["scroll_page", { tab, direction: "down" }],
    ["press_keys", { tab, keys: ["Escape"] }],
  ]) {
    const body = bodyOf(await raw(name, args));
    Assert.greater(body.throttled_ms, 0, `${name} is rate limited`);
  }
});

add_task(async function a_refused_action_still_says_it_waited() {
  const { call, reply } = await agentTools();
  const { tab } = await call("open_tab", { url: PAGE });
  const stale = await reply("click_element", { tab, ref: "e9999" });
  Assert.equal(stale.error, "stale_ref");
  Assert.greater(stale.throttled_ms, 0, "an error result says it too");
  const refused = await reply("scroll_page", { tab });
  Assert.equal(refused.error, "invalid_arguments");
  Assert.greater(refused.throttled_ms, 0, "and so does a refusal");
});

add_task(async function unticking_be_polite_lifts_the_limit() {
  const { call, agent } = await agentTools();
  Assert.ok(isPolite(agent.agentId), "an agent starts polite");
  atTaskEnd(() => setPolite(agent.agentId, true));
  const { tab } = await call("open_tab", { url: PAGE });

  setPolite(agent.agentId, false);
  for (const direction of ["down", "up"]) {
    const scrolled = await call("scroll_page", { tab, direction });
    Assert.ok(!("throttled_ms" in scrolled), "the user's untick lifts it");
  }

  setPolite(agent.agentId, true);
  await call("scroll_page", { tab, direction: "down" });
  Assert.greater(
    (await call("scroll_page", { tab, direction: "up" })).throttled_ms,
    0,
    "ticking it again holds the agent to the rate"
  );
});

/**
 * Only the user can untick Be polite: no tool takes an argument for it, and
 * an argument an agent invents for it is refused.
 */
add_task(async function an_agent_cannot_change_be_polite() {
  const { agent, call, toolNames } = await agentTools();
  const definitions = [...TOOL_DEFINITIONS, ...PAGE_TOOL_DEFINITIONS];
  for (const definition of definitions) {
    for (const name of parameterNames(definition.inputSchema)) {
      Assert.ok(
        !/polite|throttle|rate|limit/i.test(name),
        `${definition.name} takes no ${name}`
      );
    }
    const filler = { boolean: true, array: [], object: {}, integer: 1 };
    const args = Object.fromEntries(
      (definition.inputSchema.required ?? []).map(name => [
        name,
        filler[definition.inputSchema.properties[name].type] ?? "x",
      ])
    );
    for (const extra of ["polite", "be_polite", "throttled_ms", "rate"]) {
      Assert.throws(
        () => validateArgs(definition.inputSchema, { ...args, [extra]: false }),
        e => e.code === "invalid_arguments",
        `${definition.name} refuses ${extra}`
      );
    }
  }
  Assert.deepEqual(
    (await toolNames()).filter(name =>
      /polite|throttle|rate|limit/i.test(name)
    ),
    [],
    "no tool is for it"
  );
  Assert.ok(isPolite(agent.agentId));
  const { tab } = await call("open_tab", { url: PAGE });
  await call("scroll_page", { tab, direction: "down" });
  Assert.ok(isPolite(agent.agentId), "and nothing an agent does unticks it");
});

/**
 * Each agent's own tick governs its own actions, whatever name it has taken:
 * the user's untick for one never reaches another with the same name.
 */
add_task(async function be_polite_is_each_agents_own_whatever_its_name() {
  const one = await agentTools();
  const twin = await agentTools();
  Assert.equal(one.agent.label, twin.agent.label, "the same name");
  atTaskEnd(() => setPolite(one.agent.agentId, true));
  const tab = (await one.call("open_tab", { url: PAGE })).tab;
  const twinTab = (await twin.call("open_tab", { url: PAGE })).tab;

  setPolite(one.agent.agentId, false);
  Assert.ok(
    isPolite(twin.agent.agentId),
    "the same name is not the same agent"
  );
  for (const direction of ["down", "up"]) {
    const free = await one.call("scroll_page", { tab, direction });
    Assert.ok(!("throttled_ms" in free), "the unticked agent is not held");
  }
  await twin.call("scroll_page", { tab: twinTab, direction: "down" });
  const held = await twin.call("scroll_page", {
    tab: twinTab,
    direction: "up",
  });
  Assert.greater(held.throttled_ms, 0, "its namesake still is");
});
