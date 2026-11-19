/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * An agent's tools (agent-control spec §4), called by a paired agent over
 * Sval's listener, on the stack the product builds.
 */

const { createToolRunner } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentToolRunner.sys.mjs"
);
const { SESSION_TOOLS, TOOLS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentToolTable.sys.mjs"
);
/** The tools every paired agent has for its tabs. */
const OWN_TOOLS = TOOLS.filter(
  tool => !tool.when && !SESSION_TOOLS.includes(tool)
);
const SITE_TOOLS = TOOLS.filter(tool => tool.when === "siteTools");
const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { validateArgs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentArgs.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * Has the second page show "Arrived late", which it does only when told.
 *
 * @param {object} browser A tab showing `sval_agent_page2.html`.
 */
function arrive(browser) {
  return SpecialPowers.spawn(browser, [], () =>
    content.postMessage("arrive", "*")
  );
}

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
 * @param {object} result A tool's result.
 * @returns {object} Its JSON, an error's included.
 */
const bodyOf = result => JSON.parse(result.content[0].text);

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
 * A description names only parameters its own tool takes: a sentence copied
 * from another tool tells the agent to pass something the schema refuses.
 * Parameter names that are also everyday words are left out, and a tool may
 * name a parameter it hands back for other tools to take.
 */
add_task(function no_description_names_a_parameter_its_tool_does_not_take() {
  const everyday = new Set(["to", "text", "input", "name", "tab", "url"]);
  const returns = { get_snapshot: ["ref"] };
  const definitions = [...OWN_TOOLS, ...SITE_TOOLS];
  const all = new Set(
    definitions.flatMap(d => [...parameterNames(d.inputSchema)])
  );
  for (const definition of definitions) {
    const own = parameterNames(definition.inputSchema);
    for (const name of all) {
      if (
        everyday.has(name) ||
        own.has(name) ||
        returns[definition.name]?.includes(name)
      ) {
        continue;
      }
      Assert.ok(
        !new RegExp(`\\b${name}s?\\b`, "i").test(definition.description),
        `${definition.name}'s description does not name ${name}`
      );
    }
  }
});

add_task(async function every_tool_is_defined_for_an_agent() {
  const { toolNames } = await agentTools();
  Assert.deepEqual(
    (await toolNames())
      .filter(
        name =>
          ![
            "list_tabs",
            "set_task",
            "use_workspace",
            "close_window",
            "delete_workspace",
          ].includes(name)
      )
      .sort(),
    OWN_TOOLS.map(t => t.name).sort(),
    "the agent is offered every tool there is a definition for"
  );
  for (const definition of OWN_TOOLS) {
    Assert.ok(definition.title && definition.description, definition.name);
    Assert.equal(definition.inputSchema.type, "object");
    Assert.equal(definition.inputSchema.additionalProperties, false);
    const readOnly =
      definition.name.startsWith("get_") ||
      definition.name.startsWith("list_") ||
      definition.name === "wait_for_text";
    // Input can place an order or accept a "Delete?". A load or a scroll
    // changes only what the tab shows, and closing one of its own tabs
    // reaches nothing outside Sval.
    const moves = ["open_tab", "navigate_tab", "scroll_page"];
    let expected = {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    };
    if (readOnly) {
      expected = { readOnlyHint: true };
    } else if (moves.includes(definition.name)) {
      expected = { ...expected, destructiveHint: false };
    } else if (definition.name === "close_tab") {
      expected = {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      };
    }
    Assert.deepEqual(
      definition.annotations,
      expected,
      `${definition.name}'s annotations`
    );
  }
});

add_task(async function open_snapshot_click_and_close() {
  const { ws, call, tabs } = await agentTools();
  const opened = await call("open_tab", { url: PAGE });
  Assert.equal(opened.url, PAGE);
  Assert.equal(opened.title, "Agent test page");
  Assert.equal(opened.status, 200);

  const shot = await call("get_snapshot", { tab: opened.tab });
  Assert.equal(shot.tab, opened.tab);
  Assert.equal(shot.url, PAGE);
  Assert.ok(/heading "Sign in" \[e\d+\]/.test(shot.snapshot), shot.snapshot);
  Assert.equal(shot.truncated, false);

  const next = shot.snapshot.match(/link "Next page" \[(e\d+)\]/)[1];
  const clicked = await call("click_element", { tab: opened.tab, ref: next });
  Assert.equal(clicked.url, PAGE2);
  Assert.equal(clicked.title, "Second page");
  Assert.equal(clicked.writes, "none", "the click went through the gate");

  Assert.deepEqual(await call("close_tab", { tab: opened.tab }), {
    closed: opened.tab,
  });
  await TestUtils.waitForCondition(
    async () => !(await tabs.listTabs(ws)).length,
    "the tab's node is gone"
  );
});

add_task(async function forms_are_filled_chosen_and_submitted_by_keys() {
  const { call, reply } = await agentTools();
  const { tab } = await call("open_tab", { url: PAGE });
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = re => snapshot.match(re)[1];

  const filled = await call("fill_form", {
    tab,
    fields: [
      { ref: ref(/textbox "Email" \[(e\d+)\]/), text: "me@x.com" },
      { ref: ref(/textbox "Password" \[(e\d+)\]/), text: "pw" },
    ],
  });
  Assert.equal(filled.filled, 2);
  Assert.equal(filled.writes, "none");

  const stopped = await reply("fill_form", {
    tab,
    fields: [
      { ref: ref(/textbox "Email" \[(e\d+)\]/), text: "again@x.com" },
      { ref: ref(/checkbox "Keep me signed in" \[(e\d+)\]/), text: "x" },
      { ref: ref(/textbox "Password" \[(e\d+)\]/), text: "never" },
    ],
  });
  Assert.equal(stopped.error, "not_editable", "it stops at the first failure");
  Assert.equal(stopped.filled, 1, "and says how far it got");

  const chosen = await call("select_option", {
    tab,
    ref: ref(/combobox[^\[]*\[(e\d+)\]/),
    values: ["b"],
  });
  Assert.equal(chosen.writes, "none", "an option is chosen by its value");
  const typed = await call("type_text", {
    tab,
    ref: ref(/textbox "Email" \[(e\d+)\]/),
    text: "me@x.com",
  });
  Assert.equal(typed.value, "me@x.com");

  const pressed = await call("press_keys", { tab, keys: ["Tab", "Escape"] });
  Assert.equal(pressed.url, PAGE);
  Assert.equal(pressed.writes, "none", "the keys went through the gate");
});

add_task(async function page_source_comes_in_small_contiguous_chunks() {
  const { call, tabs, agent } = await agentTools();
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  await SpecialPowers.spawn(browser, [], () => {
    const filler = content.document.createElement("pre");
    filler.textContent = "x".repeat(60_000);
    content.document.body.append(filler);
  });

  const first = await call("get_page_source", { tab });
  Assert.equal(first.html.length, 20_000, "a chunk is 20 000 characters");
  Assert.equal(first.next_offset, 20_000);

  let html = "";
  let offset = 0;
  while (offset !== null) {
    const chunk = await call("get_page_source", {
      tab,
      offset,
      max_chars: 15_000,
    });
    Assert.equal(
      chunk.offset,
      offset,
      "each chunk starts where the last ended"
    );
    Assert.lessOrEqual(chunk.html.length, 15_000);
    html += chunk.html;
    offset = chunk.next_offset;
  }
  const whole = await call("get_page_source", { tab, max_chars: 100_000 });
  Assert.strictEqual(whole.next_offset, null, "max_chars can take it all");
  Assert.equal(html, whole.html, "the chunks join into the whole source");
  Assert.equal(html.length, whole.total);

  const { inputSchema } = OWN_TOOLS.find(d => d.name === "get_page_source");
  Assert.deepEqual(validateArgs(inputSchema, { tab, max_chars: 100_000 }), {
    tab,
    max_chars: 100_000,
  });
  for (const max_chars of [0, 100_001]) {
    Assert.throws(
      () => validateArgs(inputSchema, { tab, max_chars }),
      e => e.code === "invalid_arguments",
      `max_chars ${max_chars} is out of range`
    );
  }
});

add_task(async function reading_tools_answer_what_the_page_shows() {
  const { call, raw, tabs, agent } = await agentTools();
  const { tab } = await call("open_tab", { url: PAGE });

  const image = await raw("get_screenshot", { tab });
  Assert.equal(image.content.length, 1);
  Assert.equal(image.content[0].type, "image");
  Assert.equal(image.content[0].mimeType, "image/png");
  Assert.ok(atob(image.content[0].data).startsWith("\x89PNG"));

  const source = await call("get_page_source", { tab, offset: 0 });
  Assert.equal(source.tab, tab);
  Assert.ok(source.html.startsWith("<html"));
  Assert.equal(source.offset, 0);
  Assert.strictEqual(source.next_offset, null);
  Assert.equal(source.total, source.html.length);

  const read = await call("get_page_text", { tab });
  Assert.equal(read.tab, tab);
  Assert.ok(read.text.includes("Plain words here."));
  Assert.ok(!read.text.includes("<p>"), "text, not markup");
  Assert.strictEqual(read.next_offset, null);
  Assert.equal(read.total, read.text.length);
  const short = await call("get_page_text", { tab, max_chars: 5 });
  Assert.equal(short.text, read.text.slice(0, 5), "max_chars sizes the chunk");
  Assert.equal(short.next_offset, 5);
  const { snapshot } = await call("get_snapshot", { tab });
  const form = snapshot.match(/form \[(e\d+)\]/)[1];
  const scoped = await call("get_snapshot", { tab, ref: form });
  Assert.ok(scoped.snapshot.startsWith(`form [${form}]`));
  Assert.ok(!scoped.snapshot.includes("Plain words here."));
  const inView = await call("get_snapshot", { tab, viewport_only: true });
  Assert.ok(inView.snapshot.includes("Plain words here."));

  Assert.equal(
    (await call("scroll_page", { tab, direction: "down" })).writes,
    "none"
  );
  await Assert.rejects(
    call("scroll_page", { tab }),
    e => e.code === "invalid_arguments",
    "a scroll needs a ref or a direction"
  );

  const navigated = await call("navigate_tab", { tab, to: PAGE2 });
  Assert.equal(navigated.url, PAGE2);
  Assert.equal(navigated.title, "Second page");
  Assert.equal(navigated.status, 200);
  const { browser } = await tabs.tabIn(agent, tab);
  const waited = call("wait_for_text", { tab, text: "Arrived late" });
  await arrive(browser);
  Assert.deepEqual(await waited, { tab, found: true });
  Assert.deepEqual(
    await call("wait_for_text", { tab, text: "Never", timeout_ms: 300 }),
    { tab, found: false }
  );
});

/**
 * A wait for text follows the tab across a load the page makes itself. The
 * connection runs one call at a time, so the load cannot be the agent's.
 */
add_task(async function waiting_for_text_follows_the_page_across_a_load() {
  const { call, tabs, agent } = await agentTools();
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  const waiting = call("wait_for_text", {
    tab,
    text: "Arrived late",
    timeout_ms: 10000,
  });
  const loaded = pageReady(browser, PAGE2);
  await SpecialPowers.spawn(browser, [PAGE2], url => {
    content.location = url;
  });
  await within(loaded, 10_000, "the page's own load");
  await arrive(browser);
  Assert.deepEqual(await waiting, { tab, found: true });
});

add_task(async function a_user_tab_is_not_controlled() {
  const { call } = await agentTools();
  const userTab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE),
    10_000,
    "a new tab's load"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(userTab));
  await within(
    SvalPanel.observer?.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  const userNode = SvalPanel.observer?.nodeIdFor(userTab);
  Assert.ok(userNode, "the user's tab has a node");
  for (const [name, args] of [
    ["get_snapshot", {}],
    ["get_screenshot", {}],
    ["click_element", { ref: "e1" }],
    ["navigate_tab", { to: PAGE2 }],
    ["close_tab", {}],
  ]) {
    await Assert.rejects(
      call(name, { tab: userNode, ...args }),
      e => e.code === "not_controlled",
      `${name} refuses the user's tab`
    );
  }
  Assert.ok(userTab.linkedBrowser, "the user's tab is still open");
});

add_task(async function bad_arguments_never_reach_a_handler() {
  const { reply } = await agentTools();
  const body = await reply("scroll_page", { tab: "t", amount: 11 });
  Assert.equal(body.error, "invalid_arguments");
  Assert.equal(body.field, "arguments.amount");
});

add_task(async function a_failed_fill_still_reports_its_writes() {
  const { call, reply } = await agentTools();
  const { tab } = await call("open_tab", { url: PAGE });
  const { snapshot } = await call("get_snapshot", { tab });
  const body = await reply("fill_form", {
    tab,
    fields: [
      { ref: snapshot.match(/textbox "Email" \[(e\d+)\]/)[1], text: "a@b.c" },
      { ref: "e99999", text: "x" },
    ],
  });
  Assert.equal(body.error, "stale_ref");
  Assert.equal(body.filled, 1);
  Assert.equal(body.writes, "none", "the writes are still reported");
  Assert.equal(body.held, 0);
  Assert.equal(body.tab, tab);
});

/** Every acting tool answers a failed input with the writes it set off. */
add_task(async function a_failed_input_still_reports_its_writes() {
  const { call, reply } = await agentTools();
  const { tab } = await call("open_tab", { url: PAGE });
  for (const [name, args] of [
    ["click_element", { ref: "e99999" }],
    ["type_text", { ref: "e99999", text: "x" }],
    ["select_option", { ref: "e99999", values: ["a"] }],
    ["press_keys", { keys: ["NoSuchKey"] }],
    ["scroll_page", { ref: "e99999" }],
  ]) {
    const body = await reply(name, { tab, ...args });
    const code = name === "press_keys" ? "unknown_key" : "stale_ref";
    Assert.equal(body.error, code, name);
    Assert.equal(body.tab, tab, name);
    Assert.equal(body.writes, "none", `${name} still reports its writes`);
    Assert.equal(body.held, 0, name);
  }
});

/** The tools are built only with every part the product gives them. */
add_task(async function the_tools_need_every_part() {
  const { tabs } = await agentTools();
  const parts = {
    tabs,
    gate: SvalAgents.gate,
    sites: SvalAgents.gate,
    dialogs: SvalAgents.dialogs,
    siteToolsVisibleTo: () => true,
  };
  createToolRunner(parts);
  for (const missing of ["gate", "sites", "dialogs"]) {
    const deps = { ...parts };
    delete deps[missing];
    Assert.throws(
      () => createToolRunner(deps),
      /gate|sites|dialogs/,
      `createToolRunner without ${missing} throws`
    );
  }
});

add_task(async function a_click_never_lands_on_what_covers_its_element() {
  const { call, reply, tabs, agent } = await agentTools();
  const refusal = reply;
  const { tab } = await call("open_tab", { url: PAGE });
  const { browser } = await tabs.tabIn(agent, tab);
  const { snapshot } = await call("get_snapshot", { tab });
  const alertRef = snapshot.match(/button "Alert" \[(e\d+)\]/)[1];
  const fetchRef = snapshot.match(/button "Send by fetch" \[(e\d+)\]/)[1];
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    for (const id of ["alert", "fetch"]) {
      const button = doc.getElementById(id);
      button.onclick = () => {
        doc.body.dataset[id] = "clicked";
      };
    }
    const veil = doc.createElement("div");
    veil.style.cssText =
      "position:fixed;inset:0;z-index:10;background:transparent";
    doc.body.append(veil);
  });
  Assert.equal(
    (await refusal("click_element", { tab, ref: alertRef })).error,
    "click_intercepted",
    "a transparent cover intercepts the click"
  );

  await SpecialPowers.spawn(browser, [ROOT], root => {
    const doc = content.document;
    doc.querySelector("div[style*='fixed']").remove();
    const frame = doc.createElement("iframe");
    frame.src =
      root.replace("example.com", "example.org") + "sval_agent_page2.html";
    frame.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;border:0;opacity:0;z-index:10";
    doc.body.append(frame);
  });
  Assert.equal(
    (await refusal("click_element", { tab, ref: fetchRef })).error,
    "click_intercepted",
    "a cross-origin frame laid over the button intercepts the click"
  );
  Assert.deepEqual(
    await SpecialPowers.spawn(browser, [], () => ({
      ...content.document.body.dataset,
    })),
    {},
    "neither button heard a click"
  );
});
