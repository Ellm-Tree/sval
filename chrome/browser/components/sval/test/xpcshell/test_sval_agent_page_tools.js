/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The parts of site tools that need no page (site-tools spec §4, §5.3): what
 * a page's text becomes, how a call is decided, and how the policy's fields
 * are read.
 */

const {
  clean,
  decideCall,
  definitionHash,
  grantMatches,
  invoke,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
  MAX_RESULT_BYTES,
  MAX_SCHEMA_BYTES,
  pageToolSiteOf,
  pageToolsSettingOf,
  toolsOf,
  withinTimeout,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentPageTools.sys.mjs"
);
const { ToolError } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentArgs.sys.mjs"
);

/**
 * Puts `service` where the module reads a page's tools from, for this task.
 * The real service needs a page, and what is under test is what Sval does
 * with whatever the page registered.
 *
 * @param {object} service Stands in for `Services.modelContext`.
 */
function pageToolsFrom(service) {
  const real = Object.getOwnPropertyDescriptor(Services, "modelContext");
  Object.defineProperty(Services, "modelContext", {
    value: service,
    configurable: true,
    writable: true,
  });
  registerCleanupFunction(() => {
    if (real) {
      Object.defineProperty(Services, "modelContext", real);
    } else {
      delete Services.modelContext;
    }
  });
}

add_task(function page_text_is_printable_and_capped() {
  Assert.equal(clean("a‮b​c\nd e", 64), "abcde");
  Assert.equal(clean("  spaced  ", 64), "spaced");
  Assert.equal(clean("😀😀😀", 2), "😀😀", "cut at a whole character");
  Assert.equal(clean(undefined, 5), "");
});

/** The table of spec §4.3, one row at a time. */
add_task(function a_call_is_decided_as_the_spec_tabulates() {
  const cases = [
    // B ask
    ["ask", "read-only", true, false, { action: "ask", always: false }],
    ["ask", "read-only", false, false, { action: "refused" }],
    ["ask", "ask-before-writes", true, false, { action: "ask", always: false }],
    ["ask", "ask-before-writes", false, true, { action: "ask", always: false }],
    ["ask", "full", false, false, { action: "ask", always: false }],
    // B on
    ["on", "read-only", true, false, { action: "run" }],
    ["on", "read-only", false, true, { action: "refused" }],
    ["on", "ask-before-writes", true, false, { action: "run" }],
    ["on", "ask-before-writes", false, true, { action: "run_allowed" }],
    ["on", "ask-before-writes", false, false, { action: "ask", always: true }],
    ["on", "full", false, false, { action: "run" }],
    ["on", "nonsense", false, true, { action: "ask", always: false }],
  ];
  for (const [setting, level, hinted, granted, expected] of cases) {
    Assert.deepEqual(
      decideCall({ setting, level, hinted, granted }),
      expected,
      `${setting} / ${level} / hinted ${hinted} / granted ${granted}`
    );
  }
});

/** Nothing unreadable grants more than asking (spec §4.1). */
add_task(function unreadable_policy_values_ask() {
  for (const policy of [{}, { pageTools: "yes" }, { pageTools: 1 }, null]) {
    Assert.equal(pageToolsSettingOf(policy), "ask", JSON.stringify(policy));
  }
  Assert.equal(pageToolsSettingOf({ pageTools: "off" }), "off");
  Assert.equal(pageToolsSettingOf({ pageTools: "on" }), "on");

  const sites = {
    pageToolSites: { "a.example": "allow", "b.example": "deny", c: "maybe" },
  };
  Assert.equal(pageToolSiteOf(sites, "a.example"), "allow");
  Assert.equal(pageToolSiteOf(sites, "b.example"), "deny");
  Assert.equal(pageToolSiteOf(sites, "c"), null, "unknown answer");
  Assert.equal(pageToolSiteOf(sites, "d.example"), null, "no entry");
  Assert.equal(pageToolSiteOf({ pageToolSites: [] }, "a.example"), null);
  Assert.equal(pageToolSiteOf(sites, "__proto__"), null);
});

/** A grant matches only the definition it was given for (spec §4.3). */
add_task(async function a_grant_matches_only_its_definition() {
  const tool = {
    name: "search",
    description: "Searches the shop.",
    input_schema: { type: "object", properties: { q: { type: "string" } } },
    read_only: false,
  };
  const hash = await definitionHash(tool);
  Assert.equal(hash.length, 64);
  Assert.equal(
    await definitionHash({
      ...tool,
      input_schema: { properties: { q: { type: "string" } }, type: "object" },
    }),
    hash,
    "key order does not matter"
  );
  for (const changed of [
    { description: "Transfers money." },
    { input_schema: null },
    { read_only: true },
    { name: "searches" },
  ]) {
    Assert.notEqual(
      await definitionHash({ ...tool, ...changed }),
      hash,
      JSON.stringify(changed)
    );
  }
  const policy = { pageToolGrants: { "shop.example": { search: hash } } };
  Assert.ok(grantMatches(policy, "shop.example", "search", hash));
  Assert.ok(!grantMatches(policy, "shop.example", "search", "0".repeat(64)));
  Assert.ok(!grantMatches(policy, "other.example", "search", hash));
  Assert.ok(!grantMatches({}, "shop.example", "search", hash));
});

add_task(function a_host_answer_about_tools_beats_its_sites() {
  const hash = "a".repeat(64);
  const policy = {
    pageToolSites: { "example.com": "allow", "mail.example.com": "deny" },
    pageToolGrants: {
      "example.com": { search: hash },
      "mail.example.com": { send: hash },
    },
  };
  Assert.equal(pageToolSiteOf(policy, "mail.example.com"), "deny");
  Assert.equal(pageToolSiteOf(policy, "docs.example.com"), "allow");
  Assert.ok(grantMatches(policy, "mail.example.com", "send", hash));
  Assert.ok(
    grantMatches(policy, "mail.example.com", "search", hash),
    "a tool the host has not remembered follows the site"
  );
  Assert.ok(!grantMatches(policy, "docs.example.com", "send", hash));
});

/**
 * On load, what Sval cannot read in the site-tools fields is dropped and
 * written back, so a lost answer asks again (agent-control spec §5.2).
 */
add_task(function loading_a_policy_drops_what_it_cannot_read() {
  const { cleanPolicy } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs"
  );
  const HASH = "a".repeat(64);
  const { policy, changed } = cleanPolicy({
    version: 2,
    default: "ask",
    sites: {},
    downloads: {},
    uploads: {},
    pageTools: "sometimes",
    pageToolSites: { "a.example": "allow", "b.example": "maybe" },
    pageToolGrants: {
      "a.example": { search: HASH, bad: "short", worse: 7 },
      "b.example": "not a map",
    },
  });
  Assert.ok(changed, "written back");
  Assert.equal(policy.pageTools, "ask", "an unreadable setting asks");
  Assert.deepEqual(policy.pageToolSites, { "a.example": "allow" });
  Assert.deepEqual(policy.pageToolGrants, { "a.example": { search: HASH } });

  const untouched = cleanPolicy({
    version: 3,
    default: "ask",
    sites: {},
    downloads: {},
    uploads: {},
    console: {},
    apps: {},
  });
  Assert.ok(!untouched.changed, "a policy without the fields is left alone");
  Assert.ok(!("pageTools" in untouched.policy));

  for (const bad of [[], "x", null]) {
    const out = cleanPolicy({
      version: 2,
      default: "ask",
      sites: {},
      downloads: {},
      uploads: {},
      pageToolSites: bad,
      pageToolGrants: bad,
    }).policy;
    Assert.deepEqual(out.pageToolSites, {}, JSON.stringify(bad));
    Assert.deepEqual(out.pageToolGrants, {}, JSON.stringify(bad));
  }
});

/**
 * A page decides what its tools say, so what reaches the agent is capped: a
 * name and a description at their lengths, a schema too large to show is
 * left out and said to be, and a second tool by one name, or one with no
 * name, is not listed.
 */
add_task(async function a_pages_tools_are_shown_within_their_limits() {
  const big = { type: "object", description: "s".repeat(MAX_SCHEMA_BYTES) };
  pageToolsFrom({
    async getToolsForWindow() {
      return [
        {
          name: "n".repeat(MAX_NAME_CHARS + 10),
          description: "d".repeat(MAX_DESCRIPTION_CHARS + 10),
        },
        { name: "wide", description: "Wide.", inputSchema: big },
        { name: "wide", description: "A second by the same name." },
        { name: "", description: "No name." },
      ];
    },
  });
  const tools = await toolsOf(1);
  Assert.deepEqual(
    tools.map(tool => tool.name),
    ["n".repeat(MAX_NAME_CHARS), "wide"],
    "names are cut to their length, and a repeat or a blank is dropped"
  );
  Assert.equal(
    tools[0].description,
    "d".repeat(MAX_DESCRIPTION_CHARS),
    "a description is cut to its length"
  );
  Assert.strictEqual(tools[1].input_schema, null, "a huge schema is left out");
  Assert.equal(
    tools[1].description,
    "Wide. (Its input schema was too large to show.)",
    "and the description says so"
  );
});

add_task(async function an_answer_past_the_result_limit_is_refused() {
  let answer = null;
  pageToolsFrom({
    async invokeTool() {
      return answer;
    },
  });
  answer = { text: "x".repeat(MAX_RESULT_BYTES) };
  await Assert.rejects(
    invoke(1, "big", {}),
    e => e instanceof ToolError && e.code === "page_tool_result_too_large",
    "an answer over the limit"
  );
  answer = { text: "x".repeat(MAX_RESULT_BYTES - 100) };
  Assert.deepEqual(
    await invoke(1, "fits", {}),
    answer,
    "and one under it is the answer"
  );
});

add_task(async function a_call_past_its_time_is_refused() {
  await Assert.rejects(
    withinTimeout(new Promise(() => {}), 10),
    e => e instanceof ToolError && e.code === "page_tool_timeout",
    "a call that never answers"
  );
  Assert.equal(
    await withinTimeout(Promise.resolve(5), 10_000),
    5,
    "and one that answers in time is its answer"
  );
});
