/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";
const { validateArgs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentArgs.sys.mjs"
);
const { ToolError } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs"
);

const SCHEMA = {
  type: "object",
  properties: {
    tab: { type: "string", maxLength: 64 },
    keys: { type: "array", items: { type: "string", maxLength: 32 } },
    amount: { type: "integer", minimum: 1, maximum: 10 },
    direction: { type: "string", enum: ["up", "down"] },
  },
  required: ["tab"],
  additionalProperties: false,
};

/**
 * @param {unknown} args
 * @param {string} why
 * @param {{field: string, rule: string}} [broken] The field the error
 *   names, and the schema keyword it says the value breaks.
 */
function assertRejected(args, why, broken) {
  Assert.throws(
    () => validateArgs(SCHEMA, args),
    e =>
      e instanceof ToolError &&
      e.code === "invalid_arguments" &&
      (!broken ||
        (e.details?.field === broken.field && e.details?.rule === broken.rule)),
    why
  );
}

add_task(function valid_arguments_pass_through() {
  Assert.deepEqual(
    validateArgs(SCHEMA, {
      tab: "t1",
      keys: ["Enter"],
      amount: 3,
      direction: "up",
    }),
    { tab: "t1", keys: ["Enter"], amount: 3, direction: "up" }
  );
  Assert.deepEqual(validateArgs(SCHEMA, { tab: "t1" }), { tab: "t1" });
});

add_task(function every_rule_is_enforced() {
  const tab = "arguments.tab";
  assertRejected({}, "missing required", { field: tab, rule: "required" });
  assertRejected({ tab: 1 }, "wrong type", { field: tab, rule: "type" });
  assertRejected({ tab: "x".repeat(65) }, "too long", {
    field: tab,
    rule: "maxLength",
  });
  assertRejected({ tab: "t", extra: 1 }, "unknown property", {
    field: "arguments.extra",
    rule: "additionalProperties",
  });
  assertRejected({ tab: "t", amount: 0 }, "below minimum", {
    field: "arguments.amount",
    rule: "minimum",
  });
  assertRejected({ tab: "t", amount: 11 }, "above maximum", {
    field: "arguments.amount",
    rule: "maximum",
  });
  assertRejected({ tab: "t", amount: 1.5 }, "not an integer", {
    field: "arguments.amount",
    rule: "type",
  });
  assertRejected({ tab: "t", direction: "sideways" }, "not in enum", {
    field: "arguments.direction",
    rule: "enum",
  });
  assertRejected({ tab: "t", keys: [1] }, "bad array item", {
    field: "arguments.keys[0]",
    rule: "type",
  });
  assertRejected(null, "not an object", { field: "arguments", rule: "type" });
  assertRejected([], "array is not an object", {
    field: "arguments",
    rule: "type",
  });
});

/**
 * The agent's model reads the error, and a value can be anything the agent
 * sent, so the error never carries one.
 */
add_task(function the_error_never_echoes_the_value() {
  for (const args of [
    { tab: "secret-looking-value", extra: 1 },
    { tab: "t", direction: "secret-looking-value" },
    { tab: "secret-looking-value".repeat(4) },
  ]) {
    Assert.throws(
      () => validateArgs(SCHEMA, args),
      e =>
        e instanceof ToolError &&
        !JSON.stringify([e.message, e.details]).includes(
          "secret-looking-value"
        ),
      JSON.stringify(Object.keys(args))
    );
  }
});

add_task(function inherited_keys_are_unknown_arguments() {
  const smuggled = JSON.parse('{"tab":"t","__proto__":{"amount":999999}}');
  assertRejected(smuggled, "__proto__ is not a known argument");
  for (const key of ["constructor", "toString", "hasOwnProperty"]) {
    assertRejected(JSON.parse(`{"tab":"t","${key}":5}`), key);
  }

  // Without additionalProperties:false an unknown key is dropped, and
  // `__proto__` must not reach the prototype of the cleaned arguments.
  const open = { type: "object", properties: { tab: { type: "string" } } };
  const out = validateArgs(open, smuggled);
  Assert.deepEqual(Object.keys(out), ["tab"]);
  Assert.equal(out.amount, undefined);
});

add_task(function an_unusable_schema_fails_closed() {
  for (const schema of [
    {},
    { type: "number" },
    { type: "object", properties: { a: { type: "nope" } } },
    { type: "object", properties: { a: {} } },
    { type: "object", properties: { a: { type: "array" } } },
  ]) {
    Assert.throws(
      () => validateArgs(schema, { a: [1] }),
      // The module's own global makes `instanceof Error` false here.
      e => e.name === "Error" && !(e instanceof ToolError),
      JSON.stringify(schema)
    );
  }
});

const FORM = {
  type: "object",
  properties: {
    fields: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        properties: {
          ref: { type: "string" },
          text: { type: "string" },
        },
        required: ["ref", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["fields"],
  additionalProperties: false,
};

add_task(function arrays_of_objects_are_checked_item_by_item() {
  const ok = {
    fields: [
      { ref: "e1", text: "a" },
      { ref: "e2", text: "b" },
    ],
  };
  Assert.deepEqual(validateArgs(FORM, ok), ok);
  for (const bad of [
    { fields: [{ ref: "e1" }] },
    { fields: [{ ref: "e1", text: "a", extra: 1 }] },
    { fields: [{ ref: "e1", text: null }] },
    { fields: [null] },
    { fields: null },
    {
      fields: [
        { ref: "1", text: "a" },
        { ref: "2", text: "b" },
        { ref: "3", text: "c" },
      ],
    },
  ]) {
    Assert.throws(
      () => validateArgs(FORM, bad),
      e => e instanceof ToolError && e.code === "invalid_arguments",
      JSON.stringify(bad)
    );
  }
});

/**
 * A free-form object, a page tool's input, passes whole as JSON data, and
 * anything JSON cannot carry is refused.
 */
add_task(function a_free_form_object_passes_as_json() {
  const FREE = {
    type: "object",
    properties: { input: { type: "object", additionalProperties: true } },
    required: ["input"],
    additionalProperties: false,
  };
  const input = { q: "boots", size: 42, tags: ["a"], nested: { ok: true } };
  Assert.deepEqual(validateArgs(FREE, { input }), { input });
  for (const bad of [{ input: [] }, { input: null }, { input: "x" }]) {
    Assert.throws(
      () => validateArgs(FREE, bad),
      e => e instanceof ToolError && e.code === "invalid_arguments",
      JSON.stringify(bad)
    );
  }
});
