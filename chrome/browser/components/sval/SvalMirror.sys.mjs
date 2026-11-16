/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalClock } from "moz-src:///browser/components/sval/SvalClock.sys.mjs";
import { SvalSerialQueue } from "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs";

/**
 * Keeps one Firefox store and its engine document in step (store-mirror
 * spec §4). The store stays what the rest of Firefox reads and writes; where
 * the two differ, the document wins.
 *
 * The mirror owns what every store shares: one queue for every write either
 * way, telling its own writes to the store from the user's (echo), keeping a
 * user's change on its way to the document from being undone by a pass (in
 * flight), applying what a pass changed, and trying again what the store
 * refused. An adapter owns only its store.
 *
 * An adapter is `{ document, keyOf(row), readDocument(), write(doc, upserts,
 * removedIds), observe(on), toMutations(changes) }`, with optionally
 * `afterApply(report, doc)` and `isEcho(change, applied)`. `keyOf` names the
 * store's item a row is; a change the store reports carries the same key as
 * `change.key`.
 */
export class SvalMirror {
  #engine;
  #adapter;
  #requestPass;
  #now;

  #started = false;
  #stopObserving = null;

  /** Every apply and every outgoing write, in order. */
  #queue;

  /** key -> how many of the user's changes have not reached the document. */
  #inFlight = new Map();

  /** key -> the row being written to the store. */
  #applying = new Map();

  /** Ids the store refused at the last apply, offered again at the next. */
  #retry = new Set();

  /**
   * @param {object} options
   * @param {object} options.engine The profile's engine.
   * @param {object} options.adapter The store's adapter.
   * @param {Function} [options.requestPass] Asks for a pass soon.
   * @param {() => number} [options.now] Milliseconds since the epoch.
   */
  constructor({
    engine,
    adapter,
    requestPass = () => engine.requestPass(),
    now = () => SvalClock.now(),
  }) {
    this.#engine = engine;
    this.#adapter = adapter;
    this.#requestPass = requestPass;
    this.#now = now;
    this.#queue = new SvalSerialQueue("store mirror");
  }

  /** Registers the document and observes the store. Idempotent. */
  async start() {
    if (this.#started) {
      return;
    }
    this.#started = true;
    await this.#engine.addDocument(this.#adapter.document, report =>
      this.#queue.post(() => this.#afterPass(report))
    );
    if (!this.#started) {
      return;
    }
    this.#stopObserving = this.#adapter.observe({
      pending: keys => this.#markInFlight(keys),
      changes: (changes, keys) => this.#local(changes, keys),
    });
  }

  stop() {
    if (!this.#started) {
      return;
    }
    this.#started = false;
    this.#stopObserving?.();
    this.#stopObserving = null;
  }

  /** @returns {Promise<void>} once every queued write either way is done. */
  whenIdle() {
    return this.#queue.idle();
  }

  /**
   * @param {string} key A store item's key.
   * @returns {boolean} whether a user's change to it is on its way.
   */
  isInFlight(key) {
    return this.#inFlight.has(key);
  }

  async #afterPass(report) {
    if (!this.#started) {
      return;
    }
    await this.#apply(report);
  }

  /**
   * Writes into the store what the pass changed, and takes out what it
   * removed. A row whose item the user is changing waits for that change to
   * reach the document, and is offered again at the next apply. A row the
   * store refuses is offered again by the next apply, and so is a row the pass
   * reported that the read did not find, which a read racing a pass can
   * miss; each is offered once more, so a node gone for good is not
   * offered forever. A row whose item the user changed while it was being
   * written is offered again too.
   *
   * @param {object} report The pass's report.
   */
  async #apply(report) {
    const adapter = this.#adapter;
    const reported = report?.changedIds ?? [];
    const changed = new Set([...reported, ...this.#retry]);
    const removed = report?.removedIds ?? [];
    const gone = new Set(removed);
    this.#retry.clear();
    let doc = null;
    if (changed.size || removed.length) {
      doc = await adapter.readDocument();
      const upserts = [];
      for (const id of changed) {
        const row = doc.get(id);
        if (!row) {
          continue;
        }
        // The user's change may be to another fact group than the pass's,
        // and then the pass's change is not reported again: it is offered
        // again until the user's change has landed.
        if (this.#inFlight.has(adapter.keyOf(row))) {
          this.#retry.add(id);
        } else {
          upserts.push(row);
        }
      }
      for (const row of upserts) {
        this.#applying.set(adapter.keyOf(row), row);
      }
      let failed;
      try {
        failed = await adapter.write(doc, upserts, removed);
      } finally {
        this.#applying.clear();
      }
      for (const id of failed ?? []) {
        if (doc.has(id)) {
          this.#retry.add(id);
        }
      }
      for (const id of reported) {
        if (!doc.has(id) && !gone.has(id)) {
          this.#retry.add(id);
        }
      }
      // A user's change heard while the store was being written may have
      // been written over: the document, holding it once it lands, is
      // written again at the next apply.
      for (const row of upserts) {
        if (this.#inFlight.has(adapter.keyOf(row))) {
          this.#retry.add(row.id);
        }
      }
    }
    await adapter.afterApply?.(report, doc);
  }

  #markInFlight(keys) {
    for (const key of keys) {
      this.#inFlight.set(key, (this.#inFlight.get(key) ?? 0) + 1);
    }
  }

  #settle(keys) {
    for (const key of keys) {
      const left = (this.#inFlight.get(key) ?? 1) - 1;
      if (left > 0) {
        this.#inFlight.set(key, left);
      } else {
        this.#inFlight.delete(key);
      }
    }
  }

  /**
   * The user's changes to the store, each as the adapter reported it. What
   * the mirror is writing itself is dropped as it arrives; the rest becomes
   * one batch of mutations.
   *
   * @param {object[]} changes Each with `key`.
   * @param {string[]} keys Every key `pending` was told of for them.
   */
  #local(changes, keys) {
    const adapter = this.#adapter;
    const theirs = changes.filter(change => {
      const applied = this.#applying.get(change.key);
      return !applied || !(adapter.isEcho?.(change, applied) ?? true);
    });
    if (!theirs.length) {
      this.#settle(keys);
      return;
    }
    this.#queue.post(async () => {
      try {
        const ops = await adapter.toMutations(theirs);
        if (!ops.length) {
          return;
        }
        await this.#engine.mutate({
          kind: "batch",
          document: adapter.document,
          ops,
          now: this.#now(),
        });
        this.#requestPass();
      } catch (err) {
        SvalLog.warn(
          `a change did not reach its document: ${SvalLog.errorName(err)}`
        );
      } finally {
        this.#settle(keys);
      }
    });
  }
}
