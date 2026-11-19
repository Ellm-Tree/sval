/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * What an agent's session makes of what the agent and sval-mcp say of
 * themselves (agent-control spec §3.2): labels, tasks, models, launches and
 * the tab list, read the way the session reads them. The session itself, on
 * Sval's listener, is in `browser_sval_agent_protocol.js` and
 * `browser_sval_agent_session_pairing.js`.
 */

const { labelFrom, launchFrom, modelFrom, taskFrom } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentSession.sys.mjs"
  );
const { tabsIn } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs"
);

/** What sval-mcp says of a launch in /work/sval, as `launchFrom` keeps it. */
const LAUNCH = launchFrom({
  dir: "/work/sval",
  started: 1_700_000_000_000,
  id: "7f3a0123456789ab",
});

add_task(async function odd_client_names_become_usable_labels() {
  Assert.equal(labelFrom({ name: "  Claude Code  " }), "Claude Code");
  Assert.equal(labelFrom({ name: "" }), "Agent");
  Assert.equal(labelFrom(undefined), "Agent");
  Assert.equal(labelFrom({ name: 42 }), "Agent");
  Assert.equal(labelFrom({ name: "a\nb\u0007c" }), "abc");
  Assert.equal(labelFrom({ name: "x".repeat(10000) }).length, 64);
});

add_task(async function tabs_in_walks_groups_in_order() {
  const nodes = {
    ws: {
      kind: "workspace",
      content: { name: "W" },
      placement: { parent: null, order: "80" },
    },
    g: {
      kind: "group",
      content: { name: "G" },
      placement: { parent: "ws", order: "81" },
    },
    t2: {
      kind: "tab",
      content: { name: "Two", url: "https://two/" },
      placement: { parent: "ws", order: "82" },
    },
    t1: {
      kind: "tab",
      content: { name: "One", url: "https://one/" },
      placement: { parent: "g", order: "80" },
    },
    other: {
      kind: "tab",
      content: { name: "Elsewhere", url: "https://x/" },
      placement: { parent: "else", order: "80" },
    },
  };
  Assert.deepEqual(tabsIn(nodes, "ws"), [
    { tab: "t1", title: "One", url: "https://one/" },
    { tab: "t2", title: "Two", url: "https://two/" },
  ]);
});

add_task(async function the_dialog_says_when_there_is_no_window() {
  // xpcshell has no browser window at all.
  const { askToPair } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs"
  );
  Assert.deepEqual(await askToPair("Test Agent"), { action: "no_window" });
});

add_task(function a_label_carries_no_format_or_separator_characters() {
  Assert.equal(
    labelFrom({ name: "Cl\u202Eaude\u200B Code\u2028\u2029\uFEFF" }),
    "Claude Code"
  );
  Assert.equal(labelFrom({ name: "\u202E\u2028" }), "Agent", "nothing left");
  Assert.equal(
    labelFrom({ name: "claude-code", title: "Claude Code" }),
    "Claude Code",
    "the display name, where the client gives one"
  );
  Assert.equal(labelFrom({ name: "codex", title: "\u202E" }), "codex");
});

add_task(function a_task_and_a_model_are_kept_to_safe_characters() {
  Assert.equal(taskFrom("  Fix #812: tab crash  "), "Fix #812: tab crash");
  Assert.equal(taskFrom("Docs (A/B), part 2 & 3"), "Docs (A/B), part 2 & 3");
  Assert.equal(taskFrom('a\\b*c?d"e<f>g|h'), "abcdefgh");
  Assert.equal(taskFrom("Cl\u202Eaude\u200B\nCode\u2028"), "ClaudeCode");
  Assert.equal(taskFrom("a   b  c"), "a b c");
  Assert.equal(taskFrom("x".repeat(100)).length, 48);
  Assert.equal(taskFrom("Recherche é 七"), "Recherche é 七");
  Assert.equal(taskFrom(7), "");
  Assert.equal(taskFrom(undefined), "");
  Assert.equal(modelFrom("GPT-5.1 (high)"), "GPT-5.1 (high)");
  Assert.equal(modelFrom("x".repeat(100)).length, 32);
});

add_task(function a_launch_is_kept_only_when_sval_mcp_said_something_usable() {
  Assert.deepEqual(LAUNCH, {
    id: "7f3a0123456789ab",
    dir: "/work/sval",
    started: 1_700_000_000_000,
    build: null,
  });
  for (const raw of [
    null,
    "x",
    {},
    { id: "7f3a" },
    { id: "7F3A0123456789AB" },
    { id: "../0123456789abc" },
  ]) {
    Assert.equal(launchFrom(raw), null, JSON.stringify(raw));
  }
  const odd = launchFrom({
    id: "7f3a0123456789ab",
    dir: `/\u202E${"d".repeat(5000)}\n`,
    started: -1,
  });
  Assert.equal(odd.dir, "d".repeat(1024), "printable, and its end kept");
  Assert.equal(odd.started, null);
  for (const build of ["20261016120000", "0.1.0-dev"]) {
    Assert.equal(launchFrom({ ...LAUNCH, build }).build, build, build);
  }
  for (const build of [7, "", "a b", "x".repeat(65), "\u202E1"]) {
    Assert.equal(
      launchFrom({ ...LAUNCH, build }).build,
      null,
      JSON.stringify(build)
    );
  }
});
