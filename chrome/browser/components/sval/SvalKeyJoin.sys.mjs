/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Joining another device's sync key (spec §6.7, decision 0118): this device's
 * workspaces are published into the other document, the key is stored, and
 * only then is the profile's engine moved onto it, in one step.
 *
 * **The profile's engine is never the one that publishes.** A candidate engine
 * (`SvalEngine#candidate`) loads what this device holds, merges the other
 * document's folder into it and publishes the result; the folder is then read
 * back to confirm it (decision 0043). Throughout, the profile's engine stays
 * on its own key and keeps taking every change the user makes, so every reader
 * of it sees this profile's document at every moment. A join that does not
 * finish drops the candidate, and nothing of the other document has reached
 * this device.
 *
 * **The swap keeps the profile's document and changes only its key**
 * (`SvalEngine#useSyncKey`). The next pass reads the new key's directory, where
 * this device's own file is the candidate's publish, and merges it and every
 * peer's through the engine's own merge. That is what carries the changes made
 * during the join: they are in the document the swap keeps. A tab closed
 * during the join stays closed: every pass writes the profile before it reads
 * the shared folder, so this device's watermark covers every node it held
 * when the merge decides what to bring back (spec §5.4).
 *
 * The join runs here, outside any window, because a closed window runs none of
 * what is left of its scripts. The engine and every other window go on.
 */

import { sameBytes } from "moz-src:///browser/components/sval/SvalBytes.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SvalClock: "moz-src:///browser/components/sval/SvalClock.sys.mjs",
  SvalIdentity: "moz-src:///browser/components/sval/SvalIdentity.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalPairing: "moz-src:///browser/components/sval/SvalPairing.sys.mjs",
});
// A namespace, because the module exports functions and no object of its
// name for `defineESModuleGetters` to find.
ChromeUtils.defineLazyGetter(lazy, "SvalTree", () =>
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalTree.sys.mjs"
  )
);

/** The join in flight, or null. See {@link SvalKeyJoin.join}. */
let inFlight = null;

/**
 * Whether every id in `ids` is in the document `engine`'s key names in the
 * shared folder.
 *
 * Read from the folder because whether a pass wrote bytes cannot say: a retry
 * after an attempt that published finds the folder already right and writes
 * nothing, and a write can land and its reply still fail (decision 0043).
 *
 * @param {SvalEngine} engine The candidate.
 * @param {string[]} ids The node ids this device brought.
 * @returns {Promise<boolean|null>} whether the folder holds them all, or null
 *   when it could not be read and the answer is not known.
 */
async function isPublished(engine, ids) {
  try {
    const json = await engine.publishedTree(lazy.SvalTree.SYNC_DOCUMENT);
    const present = JSON.parse(json).nodes ?? {};
    return ids.every(id => id in present);
  } catch (err) {
    lazy.SvalLog.warn(
      `could not read back what is published: ${lazy.describeError(err)}`
    );
    return null;
  }
}

/**
 * Deletes the offer a join used, once the key is stored. Never before: an
 * offer still in the folder is what lets a join that failed be tried again
 * with the same code.
 *
 * @param {string|null} offerPath The claimed offer, or null.
 */
async function withdraw(offerPath) {
  if (!offerPath) {
    return;
  }
  try {
    await lazy.SvalPairing.withdraw(offerPath);
  } catch (err) {
    // An offer that resists deletion expires within the hour and `sweep`
    // takes it then.
    lazy.SvalLog.debug(
      `could not withdraw the pairing offer: ${lazy.describeError(err)}`
    );
  }
}

/**
 * The answer for a key the profile is already on: a second press, or a
 * provider that delivered the same offer twice. Nothing is published. The pass
 * is what makes "adopted" true: holding the key says nothing about whether
 * this device can read the folder it names, and withdrawing the offer on a
 * pass that failed would take away the retry.
 *
 * @param {SvalEngine} engine The profile's engine.
 * @param {string|null} offerPath The claimed offer, or null.
 * @returns {Promise<object>} as {@link SvalKeyJoin.join} answers.
 */
async function alreadyJoined(engine, offerPath) {
  let report;
  try {
    report = await engine.sync(
      lazy.SvalTree.SYNC_DOCUMENT,
      lazy.SvalClock.now(),
      {
        shared: "wait",
      }
    );
  } catch {
    // A pass that failed says nothing about the folder.
    report = null;
  }
  if (report?.shared !== "reached" && report?.shared !== "none") {
    return {
      outcome: "unchanged",
      failure: "folder",
      problem: report?.sharedReason ?? null,
      reason:
        "this device already holds that key, but the shared folder could " +
        "not be read, so nothing was brought in",
    };
  }
  await withdraw(offerPath);
  return { outcome: "adopted", report };
}

/**
 * One join. See {@link SvalKeyJoin.join}.
 *
 * @param {SvalEngine} engine The profile's engine.
 * @param {Uint8Array} keyBytes The key to join.
 * @param {object} options
 * @param {string|null} options.offerPath As {@link SvalKeyJoin.join} takes.
 * @param {object|null} options.retiring As {@link SvalKeyJoin.join} takes.
 * @returns {Promise<object>} as {@link SvalKeyJoin.join} answers.
 */
async function joinOnce(engine, keyBytes, { offerPath, retiring }) {
  const previous = engine.syncKey;
  if (previous && sameBytes(previous, keyBytes)) {
    return alreadyJoined(engine, offerPath);
  }
  if (!engine.sharedRoot || engine.sharedRoot === engine.root) {
    return {
      outcome: "unchanged",
      failure: "no-folder",
      reason: "there is no shared folder to publish into",
    };
  }

  // A device publishes nothing before its first time reading (decision
  // 1714). Without one, the candidate reads and merges the folder and
  // publishes nothing, and the profile's engine publishes this device's
  // workspaces once the reading arrives. With one, the stamps taken before it
  // are pulled back before the candidate carries them.
  const publishHeld = !lazy.SvalClock.hasReading;
  if (!publishHeld) {
    try {
      await engine.settleClock(lazy.SvalTree.SYNC_DOCUMENT);
    } catch (err) {
      return {
        outcome: "unchanged",
        failure: "own-unreadable",
        reason: `could not pull back this device's stamps: ${err?.message ?? err}`,
      };
    }
  }

  // What this device brings, as the engine's own serialisation, so nothing
  // this build does not recognise is lost on the way into the candidate. A
  // device that never shared leaves its untouched first workspace behind.
  let carried;
  let leftBehind = [];
  try {
    carried = await engine.treeJson();
    if (previous === null) {
      ({ json: carried, dropped: leftBehind } =
        lazy.SvalTree.withoutUntouchedWorkspaces(carried));
    }
  } catch (err) {
    return {
      outcome: "unchanged",
      failure: "own-unreadable",
      reason: `could not read what this device holds: ${err?.message ?? err}`,
    };
  }
  // Ids, not a count: a count could stay level while one of this device's
  // nodes was replaced by one of theirs.
  const carriedNodes = JSON.parse(carried).nodes ?? {};
  const ids = Object.keys(carriedNodes);
  // A node whose address stays on this device (`content.local`, decision
  // 1372) is never written to the shared folder, so the folder is asked only
  // for the rest.
  const publishable = ids.filter(id => !carriedNodes[id].content?.local);

  const candidate = engine.candidate(keyBytes);
  let published;
  let failure = null;
  let problem = null;
  let reached = false;
  try {
    try {
      await candidate.loadTree(carried);
      const passed = await candidate.sync(
        lazy.SvalTree.SYNC_DOCUMENT,
        lazy.SvalClock.now()
      );
      problem = passed?.sharedReason ?? null;
      reached = passed?.shared === "reached";
    } catch (err) {
      failure = err?.message ?? String(err);
    }
    // Asked of the folder on every path, the ones that threw included: a
    // write can land and everything after it fail. A held publish leaves
    // nothing to ask about, so the folder having been read is enough.
    published = publishHeld
      ? reached
      : await isPublished(candidate, publishable);
  } finally {
    candidate.terminate();
  }
  if (published === false) {
    return {
      outcome: "unchanged",
      failure: "folder",
      problem,
      reason: failure ?? "this device's workspaces did not reach the folder",
    };
  }
  if (published === null) {
    // Not known either way, so the one thing true either way is said: it did
    // not work, and the code can be used again.
    return {
      outcome: "unchanged",
      failure: "folder",
      problem,
      reason:
        "could not tell whether this device's workspaces reached the " +
        `folder: ${failure ?? "it could not be read back"}`,
    };
  }

  // Published, and past recall: the other device will merge it. A store that
  // fails is tried once more, since the usual cause is a store busy for a
  // moment, and then reported, with the profile still on its own key.
  //
  // The swap runs inside the store's step, so nothing that reads the stored
  // key can land between the two (`SvalIdentity.useStoredSyncKey`), and
  // nothing from the store on may stop it: a restart is on the new key
  // whatever happens next.
  const swap = async () => {
    if (retiring) {
      // Set Up Sync Again's list of what the replaced key could read, recorded
      // only now, so it never names the directories of a key this device is
      // still on.
      const { settings, dirs } = retiring;
      settings.oldKeyDirs = [...settings.oldKeyDirs, ...dirs];
      await settings
        .flush()
        .catch(err =>
          lazy.SvalLog.warn(
            `writing device-local panel state failed: ${lazy.describeError(err)}`
          )
        );
    }
    // The untouched workspaces the candidate left out go first, in the
    // worker, so no pass under the new key can publish them; any the user
    // touched during the join are kept.
    if (leftBehind.length) {
      await engine
        .leaveUntouched(leftBehind)
        .catch(err =>
          lazy.SvalLog.warn(
            `could not leave the untouched workspaces behind: ${lazy.describeError(err)}`
          )
        );
    }
    engine.useSyncKey(keyBytes);
  };
  let storeError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await lazy.SvalIdentity.adoptSyncKey(keyBytes, swap);
      storeError = null;
      break;
    } catch (err) {
      storeError = err;
    }
  }
  if (storeError) {
    return {
      outcome: "published",
      failure: "key-store",
      reason: `the key did not save: ${storeError?.message ?? storeError}`,
    };
  }
  Services.obs.notifyObservers(
    null,
    lazy.SvalIdentity.SYNC_KEY_STATE_TOPIC,
    lazy.SvalIdentity.SYNC_KEY_STATES.present
  );

  // The pass that merges the joined document, which every window draws.
  let report = null;
  try {
    report = await engine.sync(
      lazy.SvalTree.SYNC_DOCUMENT,
      lazy.SvalClock.now(),
      {
        shared: "wait",
      }
    );
  } catch (err) {
    // The key is stored and the profile is on it; the next pass merges.
    lazy.SvalLog.warn(
      `the first pass after joining failed: ${lazy.describeError(err)}`
    );
  }
  await withdraw(offerPath);

  const held = await engine.tree().then(
    tree => Object.keys(tree.nodes ?? {}),
    () => ids
  );
  const lost = ids.filter(id => !held.includes(id));
  if (lost.length) {
    // Merging never removes a node this device holds unless this device
    // removed it, so this is worth saying out loud if it ever happens.
    lazy.SvalLog.error(
      `joining left ${lost.length} of this device's ${ids.length} nodes ` +
        `behind: ${lost.join(", ")}`
    );
  }
  return { outcome: "adopted", report };
}

export const SvalKeyJoin = {
  /**
   * Joins `keyBytes` for the profile whose engine is `engine`, or joins the
   * join already running and answers with its outcome. A person who pressed
   * Join twice, in one window or two, asked one question (spec §6.7); two
   * joins at once would each store a key and swap.
   *
   * @param {SvalEngine} engine The profile's engine.
   * @param {Uint8Array} keyBytes The 32-byte key from the other device.
   * @param {object} [options]
   * @param {string|null} [options.offerPath] The claimed offer, deleted once
   *   the key is stored.
   * @param {object|null} [options.retiring] `{ settings, dirs }`: a
   *   `SvalLocalSettings` and the directories the key being replaced names,
   *   added to its `oldKeyDirs` in the step that stores the key
   *   (key-storage spec, "Starting over with a new sync key"). Data rather
   *   than a callback, because the window that asked may close before it
   *   would run.
   * @returns {Promise<object>} `{ outcome, failure, problem, reason, report }`.
   *   `outcome` is
   *   `"adopted"` (the key is stored and the profile is on it), `"unchanged"`
   *   (nothing of this device's reached the other document, or that is not
   *   known), `"published"` (it did, and the key did not save; the profile
   *   stays on its own key and the same code tries again). `failure` names
   *   what stopped a join that did not finish, for the line Settings shows:
   *   `"no-folder"`, `"folder"`, `"key-store"` or `"own-unreadable"`.
   *   `problem` names why a `"folder"` failure did not reach the folder, as
   *   `SvalSharedFolder.folderProblem` does, or is null when no pass said.
   *   `reason` says the same for the log. `report` is the pass that followed
   *   it.
   */
  join(engine, keyBytes, { offerPath = null, retiring = null } = {}) {
    if (!inFlight) {
      inFlight = joinOnce(engine, keyBytes, {
        offerPath,
        retiring,
      }).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  },
};
