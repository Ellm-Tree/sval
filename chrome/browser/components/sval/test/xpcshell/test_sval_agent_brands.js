/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * An agent's Workspace wears its app's mark, and each Workspace row its
 * model's, when Sval knows the product (agent-control spec §6). A name Sval
 * does not know keeps the robot, so a wrong guess never names a product.
 */

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const { agentBrandOf, modelBrandOf, brandURL, BRAND_SLUGS } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalAgentBrands.sys.mjs"
  );
const SvalPanelModel = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

add_task(function apps_are_told_apart_by_the_name_their_client_gives() {
  for (const [label, brand] of [
    ["Claude Code", "claudecode"],
    ["claude-code", "claudecode"],
    ["Claude Desktop", "claude"],
    ["claude-ai", "claude"],
    ["codex-mcp-client", "codex"],
    ["ChatGPT", "openai"],
    ["Grok Bot", "grokbot"],
    ["Grok", "grok"],
    ["Muse", "muse"],
    ["Mistral Vibe", "mistral"],
    ["gemini-cli-mcp-client", "geminicli"],
    ["Visual Studio Code", "githubcopilot"],
    ["cursor-vscode", "cursor"],
    ["LM Studio", "lmstudio"],
    ["goose", "goose"],
    ["qwen-code", "qwen"],
  ]) {
    Assert.equal(agentBrandOf(label), brand, `"${label}" is ${brand}'s`);
  }
});

add_task(function an_unknown_or_missing_name_keeps_the_robot() {
  for (const label of ["Agent", "my-script", "", "   ", null, undefined, 7]) {
    Assert.strictEqual(agentBrandOf(label), null, `${label} names no app`);
    Assert.strictEqual(modelBrandOf(label), null, `${label} names no model`);
  }
  Assert.strictEqual(
    agentBrandOf("Museum guide"),
    null,
    "a name only containing a product's letters is not that product"
  );
  Assert.strictEqual(brandURL(null), null, "and no mark has no URL");
});

add_task(function models_are_told_apart_by_family() {
  for (const [model, brand] of [
    ["Opus 5.5", "claude"],
    ["claude-sonnet-5-5", "claude"],
    ["GPT-5", "openai"],
    ["o3-mini", "openai"],
    ["Qwen3-Coder-30B", "qwen"],
    ["qwq-32b", "qwen"],
    ["DeepSeek-V3", "deepseek"],
    ["deepseek-r1:14b", "deepseek"],
    ["Llama 3.3 70B", "meta"],
    ["gemma3:27b", "gemma"],
    ["Gemini 3 Pro", "gemini"],
    ["Devstral Small", "mistral"],
    ["mixtral-8x7b", "mistral"],
    ["phi-4", "microsoft"],
    ["Kimi K2", "kimi"],
    ["GLM-4.6", "zhipu"],
    ["grok-4", "grok"],
  ]) {
    Assert.equal(modelBrandOf(model), brand, `"${model}" is ${brand}'s`);
  }
  Assert.strictEqual(
    modelBrandOf("graphite"),
    null,
    "a word that merely holds a family's letters names none"
  );
});

add_task(function every_slug_has_its_mark() {
  for (const slug of BRAND_SLUGS) {
    const channel = NetUtil.newChannel({
      uri: brandURL(slug),
      loadUsingSystemPrincipal: true,
    });
    const stream = channel.open();
    try {
      const svg = NetUtil.readInputStreamToString(stream, stream.available());
      Assert.ok(
        svg.includes('fill="context-fill black"'),
        `${slug}'s mark ships, filled in the chrome's colour`
      );
    } finally {
      stream.close();
    }
  }
});

add_task(function the_switcher_carries_the_apps_mark() {
  const workspace = (order, agent) => ({
    kind: "workspace",
    content: { name: order },
    placement: { parent: null, order },
    ...(agent && { agent }),
  });
  const nodes = {
    mine: workspace("20"),
    code: workspace("40", { label: "Claude Code", device: "d" }),
    other: workspace("60", { label: "Some Agent", device: "d" }),
  };
  Assert.deepEqual(
    SvalPanelModel.switcherItems(nodes, "mine").map(item => item.brand),
    [null, "claudecode", null],
    "the agent's app is known by its label, and the user's has none"
  );
});
