/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { SvalIdentity } from "moz-src:///browser/components/sval/SvalIdentity.sys.mjs";

/** Each engine's state. */
const states = new WeakMap();

/**
 * What an engine's passes have found: the last report, what the shared
 * folder answered and since when, whether this device's copy is saving,
 * the state of the sync key the engine shares under, and another key's
 * workspaces found in the folder.
 *
 * One per engine, because every window of a profile shares the engine and
 * its one document (`SvalEngine.forProfile`): what a pass found is the
 * profile's news, and each window's footer and the settings page read it
 * here.
 */
export class SvalSyncState {
  /** The last pass's or shared step's report, or null before the first. */
  lastPass = null;

  /**
   * What the shared folder last answered: "none" when none is chosen,
   * "reached", "unreachable" (local-copy spec §4.3), or "too-large" when it
   * holds more than a step reads (decision 0032).
   */
  folderState = "none";

  /**
   * Why the last step could not use the shared folder, as
   * `SvalSharedFolder.folderProblem` names it, or null while it answers.
   */
  folderProblem = null;

  /** When the current outage began, or null while the folder answers. */
  unreachableSince = null;

  /**
   * When a step last reached the shared folder, in milliseconds since the
   * epoch, or null. Always null with no shared folder: nothing is synced
   * then.
   */
  lastSynced = null;

  /**
   * When passes began failing to save this device's copy, on the system
   * clock, or null while they save.
   */
  saveFailingSince = null;

  /**
   * The sync key's state, one of `SvalIdentity.SYNC_KEY_STATES`: `present`
   * while the engine holds the key, and otherwise why it holds none, as
   * `SvalIdentity.syncKey()` last answered. Null with no engine. Set through
   * {@link setKeyState}.
   */
  keyState = null;

  /**
   * Whether the last sync key this device tried to save was refused because
   * the key store cannot open this profile's other secrets
   * (`SvalSecretStore.LostError`). Cleared once a key is present. Set
   * through {@link setKeySealed}.
   */
  keySealed = false;

  /**
   * Another sync key's directories in the shared folder that are not
   * dismissed (`SvalFolderUpkeep`). Set through {@link setOtherWorkspaces}.
   */
  otherWorkspaces = [];

  /** The folder {@link otherWorkspaces} was found in, or null. */
  otherWorkspacesIn = null;

  /**
   * The topic a change the passes do not bring is told on, so every window
   * on the engine redraws its indicator.
   */
  static CHANGED_TOPIC = "sval-sync-state-changed";

  /**
   * The state of an engine nothing has passed on: what a window with no
   * engine, or on a tree in memory, shows.
   */
  static none = Object.freeze(new SvalSyncState());

  /**
   * @param {SvalEngine} engine
   * @returns {SvalSyncState} `engine`'s state, which hears its passes from
   *   the first call on. Asked for before a listener of the caller's own is
   *   added, the state has taken a report by the time that listener runs.
   */
  static of(engine) {
    let state = states.get(engine);
    if (!state) {
      state = new SvalSyncState();
      // Until a read of the stored key says why an engine holds none.
      state.keyState = engine.syncKey
        ? SvalIdentity.SYNC_KEY_STATES.present
        : SvalIdentity.SYNC_KEY_STATES.none;
      states.set(engine, state);
      engine.addSharedListener(report => state.#heard(report));
      engine.addPassListener(report => {
        state.saveFailingSince = null;
        state.#heard(report);
      });
      // The pass's own `now` is corrected time (decision 1714), and how
      // long saving has failed is measured on the system clock.
      engine.addFailureListener(() => {
        state.saveFailingSince ??= Date.now();
      });
    }
    return state;
  }

  /**
   * Records the sync key's state and tells every window on the engine: a
   * key one window put right is put right for all of them.
   *
   * @param {string} state One of `SvalIdentity.SYNC_KEY_STATES`.
   */
  setKeyState(state) {
    if (state === this.keyState) {
      return;
    }
    this.keyState = state;
    if (state === SvalIdentity.SYNC_KEY_STATES.present) {
      this.keySealed = false;
    }
    Services.obs.notifyObservers(null, SvalSyncState.CHANGED_TOPIC);
  }

  /**
   * Records whether saving a sync key was refused because the key store
   * cannot open this profile's other secrets, and tells every window.
   *
   * @param {boolean} sealed
   */
  setKeySealed(sealed) {
    if (sealed === this.keySealed) {
      return;
    }
    this.keySealed = sealed;
    Services.obs.notifyObservers(null, SvalSyncState.CHANGED_TOPIC);
  }

  /**
   * Records another key's workspaces found in `folder`, and tells every
   * window on the engine when they differ from the ones known.
   *
   * @param {string[]} names The directories found and not dismissed.
   * @param {string|null} folder The shared folder they were found in.
   */
  setOtherWorkspaces(names, folder) {
    if (
      folder === this.otherWorkspacesIn &&
      names.join() === this.otherWorkspaces.join()
    ) {
      return;
    }
    this.otherWorkspaces = names;
    this.otherWorkspacesIn = folder;
    Services.obs.notifyObservers(null, SvalSyncState.CHANGED_TOPIC);
  }

  /**
   * Forgets what the folder answered: the profile chose another, or none.
   */
  leftFolder() {
    this.folderState = "none";
    this.folderProblem = null;
    this.unreachableSince = null;
    this.lastSynced = null;
  }

  /**
   * Takes a pass's or a shared step's report.
   *
   * @param {object} report A `SvalEngine.sync()` result.
   */
  #heard(report) {
    this.lastPass = report;
    const now = Date.now();
    if (report.shared === "none") {
      this.leftFolder();
      return;
    }
    // A pass that ran no shared step reports the engine's last known state,
    // which a state made between steps has not heard yet. That is all it can
    // tell: when the step ran and for how long is not its to say.
    if (
      !report.sharedRan &&
      this.folderState === "none" &&
      (report.shared === "reached" ||
        report.shared === "unreachable" ||
        report.shared === "too-large")
    ) {
      this.folderState = report.shared;
      this.folderProblem = report.sharedReason ?? null;
    }
    // A pass that ran no shared step, or whose step has not yet got an answer
    // from the folder, says nothing new about it.
    if (!report.sharedRan || report.shared === "unknown") {
      return;
    }
    this.folderState = report.shared;
    this.folderProblem = report.sharedReason ?? null;
    if (report.shared === "unreachable") {
      // A pass that could not read this device's own file heard from the
      // folder, and Sval recovers that file (messages spec §8.2), so the
      // folder's wait (decision 0032) does not start.
      if (this.folderProblem === "own-file") {
        this.unreachableSince = null;
      } else {
        this.unreachableSince ??= now;
      }
      return;
    }
    this.unreachableSince = null;
    // The folder answered, and nothing in it was synced.
    if (report.shared === "too-large") {
      return;
    }
    this.lastSynced = now;
  }
}
