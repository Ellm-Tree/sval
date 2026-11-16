/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Argument checking for agent tools (agent-control spec §3.2). Covers exactly
 * the JSON Schema subset Sval's tool definitions use. A message names the
 * field and never echoes its value, because the agent's model reads it and a
 * value can be anything the agent sent.
 */

/**
 * A tool failure, which the agent sees as JSON carrying `error: code` and
 * `message` (`SvalAgentSession`'s `toolError`).
 */
export class ToolError extends Error {
  /**
   * @param {string} code A stable snake_case code, e.g. `not_controlled`.
   * @param {string} message A sentence for the agent.
   * @param {object} [details] More fields for the result, each one the
   *   agent may see.
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

/**
 * `text` without control and format characters (bidi overrides, zero-width
 * joiners) or line and paragraph separators, which change how the text
 * around them reads wherever it is drawn: an alert, a window title, a screen
 * reader's line, an agent's context.
 *
 * @param {string} text
 * @returns {string}
 */
export function printable(text) {
  return (
    String(text)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/gu, "")
      .trim()
  );
}

/**
 * @param {string} field Where the value is, as `arguments.tab`.
 * @param {string} why
 * @param {string} rule The JSON Schema keyword the value breaks, such as
 *   `type` or `maxLength`.
 */
function fail(field, why, rule) {
  throw new ToolError("invalid_arguments", `${field} ${why}.`, {
    field,
    rule,
  });
}

function check(schema, value, field) {
  switch (schema.type) {
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(field, "must be an object", "type");
      }
      if (schema.additionalProperties === true && !schema.properties) {
        // Free-form data, such as a page tool's input: it passes whole, as
        // JSON, so nothing JSON cannot carry reaches the page.
        try {
          return JSON.parse(JSON.stringify(value));
        } catch {
          fail(field, "must be JSON data", "type");
        }
      }
      const out = {};
      for (const required of schema.required ?? []) {
        if (!Object.hasOwn(value, required)) {
          fail(`${field}.${required}`, "is required", "required");
        }
      }
      for (const [prop, v] of Object.entries(value)) {
        // Own keys only: `__proto__` and `constructor` resolve on an object
        // literal's prototype, and would pass as a schema for themselves.
        const sub = Object.hasOwn(schema.properties ?? {}, prop)
          ? schema.properties[prop]
          : null;
        if (!sub) {
          if (schema.additionalProperties === false) {
            fail(
              `${field}.${prop}`,
              "is not a known argument",
              "additionalProperties"
            );
          }
          continue;
        }
        out[prop] = check(sub, v, `${field}.${prop}`);
      }
      return out;
    }
    case "string":
      if (typeof value !== "string") {
        fail(field, "must be a string", "type");
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        fail(
          field,
          `must be at most ${schema.maxLength} characters`,
          "maxLength"
        );
      }
      if (schema.enum && !schema.enum.includes(value)) {
        fail(field, `must be one of ${schema.enum.join(", ")}`, "enum");
      }
      return value;
    case "integer":
      if (!Number.isInteger(value)) {
        fail(field, "must be an integer", "type");
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        fail(field, `must be at least ${schema.minimum}`, "minimum");
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        fail(field, `must be at most ${schema.maximum}`, "maximum");
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") {
        fail(field, "must be true or false", "type");
      }
      return value;
    case "array":
      if (!Array.isArray(value)) {
        fail(field, "must be an array", "type");
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        fail(field, `must have at most ${schema.maxItems} items`, "maxItems");
      }
      if (!schema.items) {
        throw new Error("array schema has no items");
      }
      return value.map((item, i) =>
        check(schema.items, item, `${field}[${i}]`)
      );
    default:
      // A schema Sval wrote wrongly. Accepting the value would skip every
      // check the schema was meant to make.
      throw new Error("unsupported schema type");
  }
}

/**
 * @param {object} schema A tool's `inputSchema`.
 * @param {unknown} args The call's `arguments`.
 * @returns {object} The arguments, with unknown keys rejected.
 */
export function validateArgs(schema, args) {
  return check(schema, args === undefined ? {} : args, "arguments");
}
