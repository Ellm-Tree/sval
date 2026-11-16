/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The latest tree each engine has handed out, for readers that must answer
 * at once and cannot wait for the engine: a content policy, a channel's
 * redirect, a file picker. Every read of an engine's tree passes through
 * `SvalEngine.tree`, which notes what it read here, so the copy is the tree
 * as of the latest read. Whoever writes the tree reads it back once the
 * write has landed (`SvalTabs`' observer does after each change), so the copy
 * holds every write that has landed and been read.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

/** @type {WeakMap<object, {json: string, nodes: object}>} */
const latest = new WeakMap();

/** Told each time a tree that differs from the last one is noted. */
const listeners = new Set();

/**
 * Notes the tree `engine` just answered.
 *
 * @param {object} engine
 * @param {string} json The tree as the engine serialised it.
 * @param {object} nodes Its `nodes` map, parsed.
 */
export function noteTree(engine, json, nodes) {
  if (latest.get(engine)?.json === json) {
    return;
  }
  latest.set(engine, { json, nodes });
  for (const listener of listeners) {
    try {
      listener(engine);
    } catch (err) {
      SvalLog.warn(`a tree listener failed: ${SvalLog.errorName(err)}`);
    }
  }
}

/**
 * @param {object} engine
 * @returns {object|null} The `nodes` of the latest tree read from `engine`,
 *   or null before its first read.
 */
export function latestNodes(engine) {
  return latest.get(engine)?.nodes ?? null;
}

/**
 * Tells `listener` of each tree that differs from the last one noted for
 * its engine.
 *
 * @param {(engine: object) => void} listener
 */
export function onTree(listener) {
  listeners.add(listener);
}
