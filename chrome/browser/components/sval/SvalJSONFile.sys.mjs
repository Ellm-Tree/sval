/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * How Sval reads and saves the JSON files it keeps in the profile, so a
 * damaged file is treated one way in every store.
 *
 * A file that is not there is a first run, and every store starts empty. A
 * file that is there and will not read is one of two kinds:
 *
 * - **A file a fresh start cannot hurt** (device-local settings, the
 *   blocking lists' download state), which names no page:
 *   {@link readJSONOrSetAside} moves it aside as `<name>.corrupt`, logs that
 *   it did, and the store starts from its defaults. The next save cannot
 *   overwrite what the damaged file held.
 * - **A file that holds browsing history** (history sync's state, which names
 *   pages): {@link readJSONOrDiscard} removes it, logs that it did, and the
 *   store starts from its defaults. A copy set aside would outlive Clear
 *   History, and what the file held is rebuilt from Places and the folder.
 * - **A file that holds a key or what a key protects** (the identity, the
 *   secrets file, the agents file): {@link readJSONOrNull} throws, the file
 *   stays where it is, and the feature that needs it does not start. A fresh
 *   start there would make a new key beside the old one and orphan what the
 *   old one encrypted.
 *
 * This follows Firefox's `JSONFile` (toolkit/modules/JSONFile.sys.mjs): the
 * `.corrupt` move-aside in `load`, a `DeferredTask` saver, and a flush at
 * `IOUtils.profileBeforeChange` (`_finalizeAt`). Sval does not use `JSONFile`
 * itself, for two reasons. `JSONFile.load` reports a damaged file with
 * `console.error`, whose message names the file's path, which Sval's log
 * lines never carry. And its saves cannot be awaited, while a store's caller
 * must be able to wait for a step a crash must not undo.
 */

import {
  SvalLog,
  describeError,
} from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  DeferredTask: "resource://gre/modules/DeferredTask.sys.mjs",
});

/**
 * Reads `path` as JSON, for a file whose damage must stop what reads it.
 *
 * @param {string} path
 * @returns {Promise<any>} The file's value, or null when there is no file.
 * @throws What `IOUtils.readJSON` threw, when the file is there and does not
 *   read.
 */
export async function readJSONOrNull(path) {
  try {
    return await IOUtils.readJSON(path);
  } catch (err) {
    if (err?.name === "NotFoundError") {
      return null;
    }
    throw err;
  }
}

/**
 * Reads `path` as JSON, for a file a fresh start cannot hurt. A file that is
 * there and does not read is moved aside as `<name>.corrupt`, unique and
 * mode 0600 as `JSONFile` makes it, and the reader starts from its defaults.
 *
 * @param {string} path
 * @param {string} what The file, as a log line names it.
 * @returns {Promise<any>} The file's value, or null when there is no file or
 *   it did not read.
 */
export async function readJSONOrSetAside(path, what) {
  try {
    return await IOUtils.readJSON(path);
  } catch (err) {
    if (err?.name === "NotFoundError") {
      return null;
    }
    // A warning, because the browser starts and the file is kept.
    SvalLog.warn(
      `${what} could not be read, so it starts over from defaults and the ` +
        `file is kept beside it as .corrupt: ${describeError(err)}`
    );
    try {
      const aside = await IOUtils.createUniqueFile(
        PathUtils.parent(path),
        `${PathUtils.filename(path)}.corrupt`,
        0o600
      );
      await IOUtils.move(path, aside);
    } catch (error) {
      SvalLog.warn(`${what} could not be moved aside: ${describeError(error)}`);
    }
    return null;
  }
}

/**
 * Reads `path` as JSON, for a file that holds browsing history. A file that
 * is there and does not read is removed, so no copy of it outlives Clear
 * History, and the reader starts from its defaults.
 *
 * @param {string} path
 * @param {string} what The file, as a log line names it.
 * @returns {Promise<any>} The file's value, or null when there is no file or
 *   it did not read.
 */
export async function readJSONOrDiscard(path, what) {
  try {
    return await IOUtils.readJSON(path);
  } catch (err) {
    if (err?.name === "NotFoundError") {
      return null;
    }
    SvalLog.warn(
      `${what} could not be read, so it was removed and starts over from ` +
        `defaults: ${describeError(err)}`
    );
    try {
      await IOUtils.remove(path, { ignoreAbsent: true });
    } catch (error) {
      SvalLog.warn(`${what} could not be removed: ${describeError(error)}`);
    }
    return null;
  }
}

/**
 * Saves a store soon after it changes, in one write for every change made in
 * the meantime, and before the profile closes.
 */
export class SvalSaver {
  #what;
  #write;
  #delayMs;
  #finalizeAt;
  #task = null;
  #saving = null;
  #blocker = null;
  #finalized = false;

  /**
   * @param {object} options
   * @param {string} options.what The file, as a log line names it.
   * @param {() => Promise<void>} options.write Writes the store as it
   *   stands. It must reach IOUtils before its first `await`, so a write asked
   *   for ahead of a read or a removal of the file lands first: IOUtils runs
   *   its operations in the order they arrive.
   * @param {number} options.delayMs How long a change waits for others.
   * @param {object} [options.finalizeAt] The shutdown phase that writes what
   *   is waiting; `IOUtils.profileBeforeChange`, or a test's own barrier.
   */
  constructor({ what, write, delayMs, finalizeAt = null }) {
    this.#what = what;
    this.#write = write;
    this.#delayMs = delayMs;
    this.#finalizeAt = finalizeAt;
  }

  /** Whether a change is waiting to be written. */
  get isPending() {
    return !!this.#task?.isArmed;
  }

  /**
   * Writes the store soon. A change made after {@link finalize} is not
   * written: the store is closing, and the next one reads the file again.
   */
  saveSoon() {
    if (this.#finalized) {
      return;
    }
    this.#task ??= new lazy.DeferredTask(() => this.#saveNow(), this.#delayMs);
    this.#task.arm();
    this.#holdShutdown();
  }

  /**
   * Writes at once, taking the place of any write {@link saveSoon} is waiting
   * to make. Settles once the file holds every change made before the call.
   *
   * @returns {Promise<void>}
   */
  flush() {
    this.#task?.disarm();
    return this.#write();
  }

  /**
   * Writes what {@link saveSoon} is waiting to write, or waits for the
   * write it has started.
   *
   * @returns {Promise<void>}
   */
  async flushPending() {
    if (this.#task?.isArmed) {
      await this.flush();
      return;
    }
    await this.#saving;
  }

  /**
   * Writes what is waiting, and stops: the store is closing.
   *
   * @returns {Promise<void>}
   */
  async finalize() {
    this.#finalized = true;
    await this.flushPending();
    if (this.#blocker) {
      this.#finalizeAt?.removeBlocker(this.#blocker);
      this.#blocker = null;
    }
  }

  /** The DeferredTask's write. A failure is logged: nothing awaits it. */
  async #saveNow() {
    this.#saving = this.flush().catch(err =>
      SvalLog.warn(`writing ${this.#what} failed: ${describeError(err)}`)
    );
    await this.#saving;
  }

  /** Has the shutdown phase write what is waiting, once per saver. */
  #holdShutdown() {
    if (this.#blocker) {
      return;
    }
    this.#blocker = () => this.flushPending();
    try {
      // Read here, inside the try: the getter throws once the phase is over.
      this.#finalizeAt ??= IOUtils.profileBeforeChange;
      this.#finalizeAt.addBlocker(`sval: writing ${this.#what}`, this.#blocker);
    } catch (err) {
      // The phase has finished: a change made this late is written by the
      // timer, or not at all.
      SvalLog.warn(
        `could not hold shutdown for ${this.#what}: ${describeError(err)}`
      );
    }
  }
}
