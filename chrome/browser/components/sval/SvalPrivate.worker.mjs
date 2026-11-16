/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The tree behind Sval's private windows, held in memory and nowhere else
 * (private-windows spec).
 *
 * A worker because the engine is WASM, and the parent process's system CSP
 * refuses to compile WASM on the main thread. It is a separate worker from
 * `SvalSync.worker.mjs` so that the code holding a private window's tabs has
 * no file, network or sync code anywhere in reach: it imports the engine
 * module, `SvalDocumentOps.mjs` and `SvalWorkerHost.mjs` and nothing else.
 * `test_sval_private.js` reads this file and fails if that changes.
 *
 * The engine's `SvalDocument` gives a private window the same ordering, moves
 * and repair as every other window, without a second implementation.
 */

import initWasm, {
  SvalDocument,
  init as installPanicHook,
} from "chrome://browser/content/sval/sval_core.mjs";
import { applyOp } from "chrome://browser/content/sval/SvalDocumentOps.mjs";
import {
  SvalError,
  describe,
  loadEngine,
  serve,
} from "chrome://browser/content/sval/SvalWorkerHost.mjs";

/**
 * The operations a private window makes. An agent's workspace and a setting
 * belong to saved, synced state, so they are refused here.
 */
const PRIVATE_OPS = new Set([
  "addWorkspace",
  "addGroup",
  "addSplit",
  "addTab",
  "rename",
  "setContent",
  "setAppearance",
  "moveNode",
  "remove",
  "removeKeepingChildren",
]);

/** The private tree, and the methods the worker serves over it. */
class SvalPrivateWorker {
  #ready = null;
  #doc = null;

  constructor() {
    this.#connectToPromiseWorker();
  }

  async #ensureReady() {
    if (!this.#ready) {
      this.#ready = (async () => {
        await loadEngine(initWasm);
        installPanicHook();
      })().catch(err => {
        this.#ready = null;
        throw new SvalError(
          `sval: the engine failed to load: ${describe(err)}`,
          err
        );
      });
    }
    await this.#ready;
    this.#doc ??= new SvalDocument();
  }

  /**
   * Applies one change to the private tree.
   *
   * @param {object} op As `SvalDocumentOps.applyOp` takes, without `document`.
   *   A batch is refused if any operation in it is.
   * @returns {Promise<string|null>} the affected node's id.
   */
  async mutate(op) {
    const kinds =
      op.kind === "batch" ? (op.ops ?? []).map(each => each.kind) : [op.kind];
    const refused = kinds.find(kind => !PRIVATE_OPS.has(kind));
    if (refused !== undefined || op.document !== undefined) {
      throw new SvalError(
        `sval: a private window cannot ${refused ?? op.kind}`,
        { code: "not_in_private" }
      );
    }
    await this.#ensureReady();
    try {
      return applyOp(this.#doc, op, {
        id: op.id ?? crypto.randomUUID(),
        now: op.now ?? Date.now(),
      });
    } catch (err) {
      throw new SvalError(`sval: ${op.kind} failed: ${describe(err)}`, err);
    }
  }

  /** @returns {Promise<string>} the private tree as JSON text. */
  async tree() {
    await this.#ensureReady();
    try {
      return this.#doc.toJson();
    } catch (err) {
      throw new SvalError(`sval: ${describe(err)}`, err);
    }
  }

  /**
   * Removes workspace `id` and everything under it, in one engine call
   * (`remove`). A workspace already gone, deleted from the panel before its
   * window closed, leaves nothing to remove.
   *
   * @param {string} id A workspace id.
   */
  async removeWorkspace(id) {
    await this.#ensureReady();
    try {
      this.#doc.remove(id);
    } catch (err) {
      if (err?.code !== "no_such_node") {
        throw new SvalError(
          `sval: removeWorkspace failed: ${describe(err)}`,
          err
        );
      }
    }
  }

  /** Frees the private tree. The next call starts an empty one. */
  reset() {
    this.#doc?.free();
    this.#doc = null;
  }

  #connectToPromiseWorker() {
    serve(method =>
      ["mutate", "tree", "removeWorkspace", "reset"].includes(method)
        ? (...args) => this[method](...args)
        : undefined
    );
  }
}

new SvalPrivateWorker();
