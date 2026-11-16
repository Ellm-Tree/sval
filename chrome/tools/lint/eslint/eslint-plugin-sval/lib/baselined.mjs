/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file Holds a rule's hits against the baseline (`baseline.mjs`).
 */

import path from "node:path";

/** The top of the tree, which the baseline's paths start from. */
export const TREE_ROOT = path.resolve(import.meta.dirname, "../../../../..");

/**
 * The baseline's key for a linted file.
 *
 * @param {string} filename An absolute path.
 * @returns {string}
 */
export function treePath(filename) {
  return path.relative(TREE_ROOT, filename).split(path.sep).join("/");
}

/**
 * A context whose reports go to `sink` rather than to ESLint.
 *
 * @param {object} context A rule context.
 * @param {Function} sink Takes each report's descriptor.
 * @returns {object}
 */
function capturing(context, sink) {
  return Object.create(context, { report: { value: sink } });
}

/**
 * Listeners that run `extra` after the listeners `base` already has for the
 * same selectors.
 *
 * @param {object} base A rule's listeners.
 * @param {object} extra More listeners.
 * @returns {object}
 */
function merged(base, extra) {
  const out = { ...base };
  for (const [selector, listener] of Object.entries(extra)) {
    const first = out[selector];
    out[selector] = first
      ? (...args) => {
          first(...args);
          listener(...args);
        }
      : listener;
  }
  return out;
}

/**
 * `rule`, with a file's hits reported only when there are more than
 * `baseline` allows it for `name`; then every one is.
 *
 * @param {string} name The rule's name in the plugin.
 * @param {object} rule An ESLint rule.
 * @param {object} baseline Counts by tree path, then by rule name.
 * @returns {object} An ESLint rule.
 */
export function baselined(name, rule, baseline) {
  return {
    meta: rule.meta,
    create(context) {
      const allowed = baseline[treePath(context.filename)]?.[name] ?? 0;
      if (!allowed) {
        return rule.create(context);
      }
      const held = [];
      const listeners = rule.create(capturing(context, d => held.push(d)));
      return merged(listeners, {
        "Program:exit": function () {
          if (held.length > allowed) {
            held.forEach(descriptor => context.report(descriptor));
          }
        },
      });
    },
  };
}

/**
 * The rule that warns about a baseline entry allowing more hits than its
 * file has.
 *
 * @param {object} rules The baselined rules, raw, by name.
 * @param {object} baseline Counts by tree path, then by rule name.
 * @returns {object} An ESLint rule.
 */
export function staleBaseline(rules, baseline) {
  return {
    meta: {
      type: "suggestion",
      docs: {
        description:
          "Warns about a test-hygiene baseline entry that allows more hits than its file has",
      },
      messages: {
        stale:
          "the baseline allows {{allowed}} {{rule}} in this file, which has {{found}}; {{fix}} in eslint-plugin-sval/lib/baseline.mjs",
      },
      schema: [],
    },
    create(context) {
      const entry = baseline[treePath(context.filename)];
      if (!entry) {
        return {};
      }
      const counts = {};
      let listeners = {};
      for (const name of Object.keys(entry)) {
        counts[name] = 0;
        listeners = merged(
          listeners,
          rules[name].create(capturing(context, () => counts[name]++))
        );
      }
      return merged(listeners, {
        "Program:exit": function (node) {
          for (const [name, allowed] of Object.entries(entry)) {
            const found = counts[name];
            if (found < allowed) {
              context.report({
                node,
                messageId: "stale",
                data: {
                  allowed,
                  rule: name,
                  found,
                  fix: found ? `lower it to ${found}` : "delete it",
                },
              });
            }
          }
        },
      });
    },
  };
}
