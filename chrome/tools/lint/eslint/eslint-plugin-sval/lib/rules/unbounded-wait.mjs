/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file A call to one of Mozilla's event-waiting helpers (`EVENT_WAITS`)
 * whose promise does not reach `within(promise, ms, what)`. Unbounded, a wait
 * for something that never happens runs until the harness ends the whole
 * file, and the failure names only the task.
 *
 * The promise is bounded when the call sits in the first argument of a
 * `within(…)` that passes all three arguments, directly or inside
 * `Promise.all(…)`, `.then(…)` or any other expression there, and is not
 * awaited before `within` is called; or when it is assigned to a variable
 * (`const loaded = …;` or `loaded = …;`) that, read later in the same
 * function, is itself bounded the same way, so a variable feeding
 * `Promise.all` into a second one that reaches `within` counts. What a
 * callback returns is the callback's own value, so
 * `.then(dialog => wait(dialog))` goes on as the chain it is part of.
 * Anything else is a hit: an `await` of the call or its variable, a `return`
 * of it from a named function (a helper bounds its own wait), a property or
 * an argument of something that is not `within`.
 *
 * Left out of `EVENT_WAITS`, each because it cannot hang on an event:
 * `waitForCondition` (both namespaces) and `waitForTransition` reject on
 * their own deadline, naming themselves; `waitForTick` and `executeSoon`
 * settle on the next tick; `removeTab`, `addTab` and `startLoadingURIString`
 * return without waiting. Helpers that act and then wait for the action's
 * result, such as `openNewBrowserWindow` and `closeWindow`, are in
 * `EVENT_WAITS` too, for the event can still never come.
 *
 * Sval's own settling waits are hits by method name, on any receiver
 * (`SVAL_WAITS`): each waits on queued work that a hung worker or a stuck
 * shared-folder helper never finishes. So is `SvalPanel._started.promise`,
 * which a window whose panel never starts leaves pending.
 *
 * What the rule cannot see: `withNewTab`, whose promise is the task's own
 * body, so its load wait is not bounded; a wait reached through a function
 * that is not in `EVENT_WAITS`, such as `crashFrame`, the `synthesize…`
 * helpers, `UrlbarTestUtils`'s and Sval's own helpers (those are checked
 * where they call one); a call inside a callback in `within`'s first
 * argument whose result the outer promise never waits on; and a wait that is
 * not a call (`new Promise(r => x.addEventListener(…, r))`).
 */

import {
  contains,
  inWithin,
  isFunction,
  propertyName,
  variableOf,
} from "../ast.mjs";

/** The helpers whose promise waits for an event, by namespace. */
const EVENT_WAITS = {
  BrowserTestUtils: new Set([
    "browserLoaded",
    "browserStarted",
    "browserStopped",
    "closeWindow",
    "contentTopicObserved",
    "domWindowClosed",
    "domWindowOpened",
    "domWindowOpenedAndLoaded",
    "firstBrowserLoaded",
    "loadURIString",
    "openNewBrowserWindow",
    "openNewForegroundTab",
    "promiseAlertDialog",
    "promiseAlertDialogOpen",
    "reloadTab",
    "switchTab",
    "waitForAttribute",
    "waitForAttributeRemoval",
    "waitForBrowserStateChange",
    "waitForContentEvent",
    "waitForDateTimePickerPanelShown",
    "waitForDialogClose",
    "waitForDocLoadAndStopIt",
    "waitForErrorPage",
    "waitForEvent",
    "waitForGlobalNotificationBar",
    "waitForLocationChange",
    "waitForMessage",
    "waitForMutationCondition",
    "waitForNewTab",
    "waitForNewWindow",
    "waitForNotificationBar",
    "waitForNotificationInNotificationBox",
    "waitForPopupEvent",
    "waitForSelectPopupShown",
    "waitForSessionStoreUpdate",
    "waitForTabClosing",
    "windowClosed",
  ]),
  TestUtils: new Set([
    "consoleMessageObserved",
    "topicObserved",
    "waitForPrefChange",
  ]),
  PromptTestUtils: new Set([
    "handleNextPrompt",
    "handlePrompt",
    "waitForPrompt",
  ]),
};

/**
 * Sval's methods that wait for its own queued work to finish: the tab
 * observer's `settled`, the stores' and syncs' `whenIdle`, and
 * `SvalSerialQueue`'s `idle`.
 */
const SVAL_WAITS = new Set(["settled", "whenIdle", "idle"]);

/** How many variables a wait may pass through on its way to `within`. */
const MAX_HOPS = 4;

/** The expressions a promise passes through on its way to a variable. */
const CARRIERS = new Set([
  "ArrayExpression",
  "ArrowFunctionExpression",
  "BinaryExpression",
  "CallExpression",
  "ChainExpression",
  "ConditionalExpression",
  "FunctionExpression",
  "LogicalExpression",
  "MemberExpression",
  "NewExpression",
  "SequenceExpression",
  "SpreadElement",
  "TaggedTemplateExpression",
  "TemplateLiteral",
  "UnaryExpression",
]);

/**
 * The innermost function holding `node`, or null.
 *
 * @param {object} node An ESTree node.
 * @returns {object|null}
 */
function functionOf(node) {
  let at = node.parent;
  while (at && !isFunction(at)) {
    at = at.parent;
  }
  return at;
}

/**
 * The identifier the expression holding `node` is assigned to, or null if it
 * is not an assignment's value.
 *
 * @param {object} node An expression.
 * @returns {object|null} The target Identifier.
 */
function assignedTo(node) {
  let child = node;
  let parent = node.parent;
  while (parent) {
    switch (parent.type) {
      case "VariableDeclarator":
        return parent.init === child && parent.id.type === "Identifier"
          ? parent.id
          : null;
      case "AssignmentExpression":
        return parent.operator === "=" &&
          parent.right === child &&
          parent.left.type === "Identifier"
          ? parent.left
          : null;
      case "ReturnStatement": {
        const fn = functionOf(parent);
        if (!fn || fn.type === "FunctionDeclaration") {
          return null;
        }
        child = fn;
        parent = fn.parent;
        continue;
      }
    }
    if (!CARRIERS.has(parent.type)) {
      return null;
    }
    child = parent;
    parent = parent.parent;
  }
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Requires every event wait in a test to be bounded",
    },
    messages: {
      unbounded:
        "{{ns}}.{{name}} waits for an event with no bound; pass its promise to within(promise, ms, what)",
      unboundedSval:
        "{{name}} waits for Sval's queued work with no bound; pass its promise to within(promise, ms, what)",
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;

    function bounded(node, hops) {
      if (inWithin(node)) {
        return true;
      }
      if (hops >= MAX_HOPS) {
        return false;
      }
      const target = assignedTo(node);
      const variable = target && variableOf(sourceCode, target);
      if (!variable) {
        return false;
      }
      const fn = functionOf(target);
      return variable.references.some(
        ref =>
          ref.isRead() &&
          ref.identifier.range[0] > target.range[1] &&
          (!fn || contains(fn, ref.identifier)) &&
          bounded(ref.identifier, hops + 1)
      );
    }

    function reportSval(node, name) {
      const expression =
        node.parent.type === "ChainExpression" ? node.parent : node;
      if (!bounded(expression, 0)) {
        context.report({
          node,
          messageId: "unboundedSval",
          data: { name },
        });
      }
    }

    return {
      MemberExpression(node) {
        if (
          propertyName(node) === "promise" &&
          node.object.type === "MemberExpression" &&
          propertyName(node.object) === "_started"
        ) {
          reportSval(node, "_started.promise");
        }
      },
      CallExpression(node) {
        const { callee } = node;
        if (
          callee.type === "MemberExpression" &&
          node.arguments.length === 0 &&
          SVAL_WAITS.has(propertyName(callee))
        ) {
          reportSval(node, `${propertyName(callee)}()`);
          return;
        }
        if (
          callee.type !== "MemberExpression" ||
          callee.object.type !== "Identifier"
        ) {
          return;
        }
        const ns = callee.object.name;
        const name = propertyName(callee);
        if (!EVENT_WAITS[ns]?.has(name)) {
          return;
        }
        const expression =
          node.parent.type === "ChainExpression" ? node.parent : node;
        if (!bounded(expression, 0)) {
          context.report({
            node: callee.property,
            messageId: "unbounded",
            data: { ns, name },
          });
        }
      },
    };
  },
};
