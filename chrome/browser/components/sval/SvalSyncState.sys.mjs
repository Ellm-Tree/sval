/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { SvalIdentity } from "moz-src:///browser/components/sval/SvalIdentity.sys.mjs";

/** Each engine's state. */
const states = new WeakMap();

/**
 * What an engine's passes have found: the last report, what the shared
 * folder answered and how many steps in a row it has not answered, when it
 * last synced, whether this device's copy is saving,
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

  /**
   * The helper's own reason for the last step that did not reach the folder,
   * as the engine's report carries it (`sharedCause`), or null while the
   * folder answers.
   */
  folderCause = null;

  /**
   * How many shared steps in a row have not reached the folder, as the
   * engine counts them (`sharedFailures`). 0 while the folder answers.
   */
  failedSteps = 0;

  /**
   * Whether a pass someone waited on (`SvalPanel.syncWithFolder`) found the
   * folder unreachable. A person who asks what the folder says gets its
   * answer, so the indicator shows the outage without waiting for a second
   * step (decision 0032). Cleared once a step reaches the folder.
   */
  failureAsked = false;

  /** How many passes in a row have failed to save this device's copy. */
  saveFailures = 0;

  /**
   * The profile's `SvalLocalSettings` store, which keeps {@link lastSynced}
   * across a restart, or null before {@link keepIn}.
   */
  #settings = null;

  /** {@link lastSynced} for a state with no store to keep it in. */
  #lastSynced = null;

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
      // A pass that carries a shared step's outcome waited for that step:
      // background steps report through the shared listener alone.
      engine.addPassListener(report => {
        state.saveFailures = 0;
        state.#heard(report, { waited: !!report?.sharedRan });
      });
      engine.addFailureListener(() => {
        state.saveFailures++;
      });
    }
    return state;
  }

  /**
   * When a step last reached the shared folder chosen now, in milliseconds
   * since the epoch, or null when none has. Kept in the profile's settings
   * once {@link keepIn} has named them, so a launch knows when this device
   * last synced before its first step answers. Always null with no shared
   * folder: nothing is synced then.
   *
   * @returns {number|null}
   */
  get lastSynced() {
    return this.#settings ? this.#settings.lastSynced : this.#lastSynced;
  }

  set lastSynced(at) {
    if (!this.#settings) {
      this.#lastSynced = at;
      return;
    }
    this.#settings.lastSynced = at;
    this.#settings.saveSoon();
  }

  /**
   * Keeps {@link lastSynced} in `settings` from now on.
   *
   * @param {object} settings The profile's `SvalLocalSettings` store.
   */
  keepIn(settings) {
    if (this.#settings === settings) {
      return;
    }
    const heard = this.#lastSynced;
    this.#settings = settings;
    // A step heard before the store was named is newer than the store's.
    if (heard !== null && heard > (settings.lastSynced ?? -Infinity)) {
      this.lastSynced = heard;
    }
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
    this.#forgetAnswer();
    this.lastSynced = null;
  }

  /** Forgets what the folder last answered, and keeps when it last synced. */
  #forgetAnswer() {
    this.folderState = "none";
    this.folderProblem = null;
    this.folderCause = null;
    this.failedSteps = 0;
    this.failureAsked = false;
  }

  /**
   * Takes a pass's or a shared step's report.
   *
   * @param {object} report A `SvalEngine.sync()` result.
   * @param {object} [options]
   * @param {boolean} [options.waited] Someone waited on the report's step.
   */
  #heard(report, { waited = false } = {}) {
    this.lastPass = report;
    const now = Date.now();
    if (report.shared === "none") {
      // The engine shares nowhere, which a key that is locked for now also
      // makes it do. The folder is still the profile's choice, so when it
      // last synced stays: choosing another or none is `leftFolder`.
      this.#forgetAnswer();
      if (!this.#settings) {
        this.#lastSynced = null;
      }
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
      this.#took(report);
    }
    // A pass that ran no shared step, or whose step has not yet got an answer
    // from the folder, says nothing new about it.
    if (!report.sharedRan || report.shared === "unknown") {
      return;
    }
    this.#took(report);
    if (report.shared === "unreachable") {
      // A pass that could not read this device's own file heard from the
      // folder, and Sval recovers that file (messages spec §8.2).
      if (waited && this.folderProblem !== "own-file") {
        this.failureAsked = true;
      }
      return;
    }
    this.failureAsked = false;
    // The folder answered, and nothing in it was synced.
    if (report.shared === "too-large") {
      return;
    }
    this.lastSynced = now;
  }

  /**
   * Takes what `report` says the folder last answered.
   *
   * @param {object} report A `SvalEngine.sync()` result.
   */
  #took(report) {
    this.folderState = report.shared;
    this.folderProblem = report.sharedReason ?? null;
    this.folderCause = report.sharedCause ?? null;
    this.failedSteps = report.sharedFailures ?? 0;
  }
}
