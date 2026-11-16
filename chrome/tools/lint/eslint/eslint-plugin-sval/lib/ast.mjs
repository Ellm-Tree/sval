/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file The ESTree questions Sval's rules share.
 */

const FUNCTIONS = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const LOOPS = new Set([
  "DoWhileStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "WhileStatement",
]);

/**
 * @param {object} node An ESTree node.
 * @returns {boolean}
 */
export function isFunction(node) {
  return FUNCTIONS.has(node.type);
}

/**
 * @param {object} node An ESTree node.
 * @returns {boolean}
 */
export function isLoop(node) {
  return LOOPS.has(node.type);
}

/**
 * The name a non-computed member expression reads, `#name` for a private
 * one; null for a computed one.
 *
 * @param {object} member A MemberExpression.
 * @returns {string|null}
 */
export function propertyName(member) {
  if (member.computed) {
    return null;
  }
  if (member.property.type === "PrivateIdentifier") {
    return `#${member.property.name}`;
  }
  return member.property.type === "Identifier" ? member.property.name : null;
}

/**
 * The name a call calls: the identifier for `f()`, the property for
 * `a.b.f()`; null for anything else.
 *
 * @param {object} call A CallExpression or NewExpression.
 * @returns {string|null}
 */
export function calledName(call) {
  const { callee } = call;
  if (callee.type === "Identifier") {
    return callee.name;
  }
  return callee.type === "MemberExpression" ? propertyName(callee) : null;
}

/**
 * The node a report on a call points at: the property for `a.b.f()`, the
 * callee for anything else.
 *
 * @param {object} call A CallExpression or NewExpression.
 * @returns {object}
 */
export function calleeNameNode(call) {
  const { callee } = call;
  return callee.type === "MemberExpression" ? callee.property : callee;
}

/**
 * Whether `node` lies in a function passed as an argument to a call that
 * `isCall` accepts.
 *
 * @param {object} node An ESTree node.
 * @param {Function} isCall Called with the CallExpression and the function's
 *   index among its arguments.
 * @returns {boolean}
 */
export function inFunctionArgumentOf(node, isCall) {
  for (let child = node; child.parent; child = child.parent) {
    const parent = child.parent;
    if (
      isFunction(child) &&
      parent.type === "CallExpression" &&
      parent.arguments.includes(child) &&
      isCall(parent, parent.arguments.indexOf(child))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `node` is in the first argument of a three-argument `within(…)`,
 * and not awaited before `within` is called. An `await` inside a function
 * there is part of the promise `within` bounds.
 *
 * @param {object} node An expression.
 * @returns {boolean}
 */
export function inWithin(node) {
  let awaited = false;
  for (let child = node; child.parent; child = child.parent) {
    const parent = child.parent;
    if (parent.type === "AwaitExpression") {
      awaited = true;
    } else if (isFunction(parent)) {
      awaited = false;
    } else if (
      parent.type === "CallExpression" &&
      parent.callee.type === "Identifier" &&
      parent.callee.name === "within" &&
      parent.arguments.length >= 3 &&
      parent.arguments[0] === child &&
      !awaited
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `node` is `ns.name`, with `ns` a plain identifier.
 *
 * @param {object} node An ESTree node.
 * @param {string} ns The object's name.
 * @param {string} name The property's name.
 * @returns {boolean}
 */
export function isQualified(node, ns, name) {
  return (
    node.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === ns &&
    propertyName(node) === name
  );
}

/**
 * Whether `inner` is `outer` or lies inside it.
 *
 * @param {object} outer An ESTree node.
 * @param {object} inner An ESTree node.
 * @returns {boolean}
 */
export function contains(outer, inner) {
  return outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1];
}

/**
 * Whether `node` is one of `call`'s arguments, or inside one, rather than
 * its callee.
 *
 * @param {object} call A CallExpression or NewExpression.
 * @param {object} node A node inside `call`.
 * @returns {boolean}
 */
export function inArguments(call, node) {
  return call.arguments.some(arg => contains(arg, node));
}

/**
 * Whether a loop's body is one statement, or a block of one.
 *
 * @param {object} loop A loop statement.
 * @returns {object|null} That statement, or null.
 */
export function onlyStatement(loop) {
  const { body } = loop;
  if (body.type !== "BlockStatement") {
    return body;
  }
  return body.body.length === 1 ? body.body[0] : null;
}

/**
 * Whether the subtree at `node` holds an identifier named `name`, the
 * properties of member expressions included.
 *
 * @param {object} node An ESTree node.
 * @param {string} name The identifier.
 * @param {object} visitorKeys The source's visitor keys.
 * @returns {boolean}
 */
export function mentions(node, name, visitorKeys) {
  if (!node || typeof node.type !== "string") {
    return false;
  }
  if (node.type === "Identifier" && node.name === name) {
    return true;
  }
  for (const key of visitorKeys[node.type] ?? []) {
    const child = node[key];
    const children = Array.isArray(child) ? child : [child];
    if (children.some(c => mentions(c, name, visitorKeys))) {
      return true;
    }
  }
  return false;
}

/**
 * The variable an identifier names, looked up from the scope it is used in.
 *
 * @param {object} sourceCode The rule's `SourceCode`.
 * @param {object} identifier An Identifier.
 * @returns {object|null} An eslint-scope Variable, or null for a global
 *   nothing declares.
 */
export function variableOf(sourceCode, identifier) {
  for (
    let scope = sourceCode.getScope(identifier);
    scope;
    scope = scope.upper
  ) {
    const ref = scope.references.find(r => r.identifier === identifier);
    if (ref) {
      return ref.resolved;
    }
    const variable = scope.set.get(identifier.name);
    if (variable?.identifiers.includes(identifier)) {
      return variable;
    }
  }
  return null;
}
