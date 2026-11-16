/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file A test that checks what the UI says: an element's text or a text
 * attribute (`TEXT_PROPERTIES`, `TEXT_ATTRIBUTES`) compared with a string or
 * matched with a regular expression written in the test. Wording changes with
 * every copy pass, so such a test fails for no fault in Sval. A test asserts
 * the state instead: a Fluent id, a `data-` attribute, hidden or disabled.
 *
 * Text the test made itself is data, such as a Workspace's name it typed, so
 * a string that appears in the file other than in the comparison passes. So
 * does one with no letter (an empty label, a count, a key), one with no
 * space that holds `.`, `:`, `/`, `-` or `_`, which is a host or an id, and
 * one with a double quote, a brace or a bracket, which is a piece of JSON. A regular expression passes when its letters are
 * all in escapes such as `\d` and `\b`: it reads a count or a format.
 *
 * The comparisons seen: `Assert`'s and the harness's equality and string
 * assertions, `==` and `!=` in either form, and `includes`, `startsWith`,
 * `endsWith` and a regular expression's `test`. A text read reaches
 * them directly or through a `const` it initialises.
 */

import { calledName, propertyName, variableOf } from "../ast.mjs";

/** The properties that hold what an element says. */
const TEXT_PROPERTIES = new Set([
  "innerHTML",
  "innerText",
  "label",
  "textContent",
  "tooltipText",
]);

/** The attributes that hold what an element says. */
const TEXT_ATTRIBUTES = new Set([
  "aria-label",
  "label",
  "placeholder",
  "title",
  "tooltiptext",
]);

/** Assertions whose first two arguments are compared. */
const COMPARISONS = new Set([
  "equal",
  "notEqual",
  "strictEqual",
  "notStrictEqual",
  "stringContains",
  "stringMatches",
  "is",
  "isnot",
]);

/** String methods that match a text against a pattern. */
const MATCHES = new Set(["includes", "startsWith", "endsWith"]);

/**
 * Whether a string a test compares UI text with is wording.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isWording(value) {
  return (
    /\p{L}/u.test(value) &&
    !/^\S*[.:/\-_]\S*$/u.test(value) &&
    !/["{}[\]]/u.test(value)
  );
}

/**
 * Whether a regular expression matches wording: a letter outside an escape.
 *
 * @param {object} literal A regular expression Literal.
 * @returns {boolean}
 */
function matchesWording(literal) {
  return /\p{L}/u.test(literal.regex.pattern.replace(/\\./g, ""));
}

/**
 * @param {object} node An expression.
 * @returns {object} `node` without a `ChainExpression` around it.
 */
function unchained(node) {
  return node?.type === "ChainExpression" ? node.expression : node;
}

/**
 * Whether `node` reads an element's text directly.
 *
 * @param {object} node An expression.
 * @returns {boolean}
 */
function readsTextDirectly(node) {
  const n = unchained(node);
  if (n?.type === "MemberExpression") {
    return TEXT_PROPERTIES.has(propertyName(n));
  }
  if (n?.type === "CallExpression") {
    const callee = unchained(n.callee);
    const [name] = n.arguments;
    return (
      callee.type === "MemberExpression" &&
      propertyName(callee) === "getAttribute" &&
      name?.type === "Literal" &&
      TEXT_ATTRIBUTES.has(name.value)
    );
  }
  return false;
}

/**
 * The string a literal holds, or null when `node` is not one: a string
 * literal or a template literal with no expressions.
 *
 * @param {object} node An expression.
 * @returns {string|null}
 */
function stringOf(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && !node.expressions.length) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallows asserting the UI's wording in a test",
    },
    messages: {
      wording:
        "this checks what the UI says, which changes with every copy pass; assert a Fluent id, a data- attribute or other state",
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;
    const counts = new Map();
    const candidates = [];

    function readsText(node) {
      const n = unchained(node);
      if (readsTextDirectly(n)) {
        return true;
      }
      if (n?.type !== "Identifier") {
        return false;
      }
      const def = variableOf(sourceCode, n)?.defs[0];
      return (
        def?.type === "Variable" &&
        def.parent.kind === "const" &&
        readsTextDirectly(def.node.init)
      );
    }

    // `pattern` is compared with a text read; report it unless it is data.
    function compared(pattern) {
      if (pattern?.type === "Literal" && pattern.regex) {
        if (matchesWording(pattern)) {
          context.report({ node: pattern, messageId: "wording" });
        }
        return;
      }
      const value = stringOf(pattern);
      if (value !== null && isWording(value)) {
        candidates.push({ node: pattern, value });
      }
    }

    function pair(a, b) {
      if (readsText(a)) {
        compared(b);
      } else if (readsText(b)) {
        compared(a);
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === "string") {
          counts.set(node.value, (counts.get(node.value) ?? 0) + 1);
        }
      },
      TemplateLiteral(node) {
        const value = stringOf(node);
        if (value !== null) {
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
      },
      BinaryExpression(node) {
        if (["===", "==", "!==", "!="].includes(node.operator)) {
          pair(node.left, node.right);
        }
      },
      CallExpression(node) {
        const callee = unchained(node.callee);
        const name = calledName({ callee });
        if (COMPARISONS.has(name) && node.arguments.length >= 2) {
          pair(node.arguments[0], node.arguments[1]);
          return;
        }
        if (callee.type !== "MemberExpression") {
          return;
        }
        if (MATCHES.has(name) && readsText(callee.object)) {
          compared(node.arguments[0]);
        } else if (
          name === "test" &&
          callee.object.type === "Literal" &&
          callee.object.regex &&
          matchesWording(callee.object) &&
          readsText(node.arguments[0])
        ) {
          context.report({ node: callee.object, messageId: "wording" });
        }
      },
      "Program:exit": function () {
        for (const { node, value } of candidates) {
          if ((counts.get(value) ?? 0) < 2) {
            context.report({ node, messageId: "wording" });
          }
        }
      },
    };
  },
};
