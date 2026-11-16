/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Which known product an agent's app or model is, so its Workspace can wear
 * that product's mark in place of the robot (agent-control spec §6).
 *
 * The app is read from the agent's label, the name its MCP client gives
 * itself (`SvalAgentSession.labelFrom`). The model is read from what the
 * agent said it runs on in `set_task`, which is optional and only as true as
 * the agent makes it. A name no rule matches keeps the robot.
 *
 * Each mark is `agent-brands/<slug>.svg`, made by
 * `scripts/generate-agent-brands.py`, and is a third-party logo shown only to
 * say which product a Workspace belongs to (`REUSE.toml`).
 */

/** The folder the marks are served from. */
const BRANDS_URL = "chrome://browser/content/sval/agent-brands/";

/**
 * Agent apps, first match wins. A product's own coding tool comes before the
 * product, so "Claude Code" is told from "Claude" and "Gemini CLI" from
 * "Gemini", and an editor built on VS Code before VS Code, whose name its
 * client carries ("cursor-vscode"). Each pattern runs on the label in lower
 * case.
 */
const APP_RULES = [
  ["claudecode", /\bclaude[\s_-]*code\b|\bclaudecode\b/],
  ["claude", /\bclaude\b/],
  ["codex", /\bcodex\b/],
  ["openai", /\bchatgpt\b|\bopenai\b/],
  ["grokbot", /\bgrok[\s_-]*bot\b/],
  ["grok", /\bgrok\b|\bxai\b/],
  ["muse", /\bmuse\b/],
  ["mistral", /\bmistral\b|\ble[\s_-]*chat\b/],
  ["geminicli", /\bgemini[\s_-]*cli\b/],
  ["gemini", /\bgemini\b/],
  ["cursor", /\bcursor\b/],
  ["windsurf", /\bwindsurf\b|\bcodeium\b/],
  ["githubcopilot", /\bcopilot\b|\bvisual studio code\b|\bvs[\s_-]*code\b/],
  ["cline", /\bcline\b/],
  ["goose", /\bgoose\b/],
  ["opencode", /\bopen[\s_-]*code\b/],
  ["amp", /\bamp\b/],
  ["lmstudio", /\blm[\s_-]*studio\b/],
  ["ollama", /\bollama\b/],
  ["qwen", /\bqwen\b/],
  ["deepseek", /\bdeep[\s_-]*seek\b/],
  ["kimi", /\bkimi\b|\bmoonshot\b/],
  ["perplexity", /\bperplexity\b/],
];

/**
 * A model family's names, each at the start of a word and followed by no
 * letter: a model's name runs its version on ("gemma3", "phi-4"), and a word
 * that only begins with a family's letters ("graphite") is no model of it.
 *
 * @param {...string} names Regular expression sources.
 * @returns {RegExp}
 */
function family(...names) {
  return new RegExp(`\\b(?:${names.join("|")})(?![a-z])`);
}

/**
 * Model families, first match wins, run on the model's name in lower case.
 * A family is drawn with its maker's mark where the family has none of its
 * own: Llama with Meta's, Phi with Microsoft's, Nemotron with NVIDIA's.
 */
const MODEL_RULES = [
  ["claude", family("claude", "opus", "sonnet", "haiku", "fable")],
  ["openai", family("gpt", "chatgpt", "o[1-9]", "codex")],
  ["grok", family("grok")],
  ["muse", family("muse")],
  ["gemma", family("gemma")],
  ["gemini", family("gemini")],
  ["meta", family("llama")],
  ["qwen", family("qwen", "qwq")],
  ["deepseek", family("deep[\\s_-]*seek")],
  [
    "mistral",
    family(
      "mistral",
      "mixtral",
      "codestral",
      "devstral",
      "magistral",
      "ministral",
      "pixtral"
    ),
  ],
  ["microsoft", family("phi")],
  ["kimi", family("kimi")],
  ["zhipu", family("glm")],
  ["minimax", family("minimax")],
  ["nvidia", family("nemotron")],
  ["cohere", family("command[\\s_-]?[ar]", "aya")],
];

/**
 * @param {Array<[string, RegExp]>} rules
 * @param {unknown} name
 * @returns {string|null} the first matching rule's slug.
 */
function match(rules, name) {
  if (typeof name !== "string" || !name.trim()) {
    return null;
  }
  const lower = name.toLowerCase();
  return rules.find(([, pattern]) => pattern.test(lower))?.[0] ?? null;
}

/**
 * The known app an agent's label names, or null.
 *
 * @param {unknown} label The agent's label (`AgentMark.label`).
 * @returns {string|null} A slug of {@link APP_RULES}.
 */
export function agentBrandOf(label) {
  return match(APP_RULES, label);
}

/**
 * The known model family an agent said it runs on, or null.
 *
 * @param {unknown} model What the session gave `set_task` as its model.
 * @returns {string|null} A slug of {@link MODEL_RULES}.
 */
export function modelBrandOf(model) {
  return match(MODEL_RULES, model);
}

/**
 * @param {string|null} slug An {@link agentBrandOf} or {@link modelBrandOf}
 *   answer.
 * @returns {string|null} the mark's chrome URL.
 */
export function brandURL(slug) {
  return slug ? `${BRANDS_URL}${slug}.svg` : null;
}

/** Every slug a rule can answer, which `generate-agent-brands.py` makes. */
export const BRAND_SLUGS = Object.freeze([
  ...new Set([...APP_RULES, ...MODEL_RULES].map(([slug]) => slug)),
]);
