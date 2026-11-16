/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Archiving idle tabs (idle-tab archive spec, decision 0136): a tab nobody
 * has used for a while leaves the tree and goes to the Archive, a synced
 * document of its own that keeps each entry for the retention period. The
 * History sidebar lists it (`SvalHistorySidebar`), and a click there brings
 * the tab back.
 *
 * The engine decides what is idle and what an entry holds. This module runs
 * the sweep on the profile's tree, after a pass that reached the shared
 * folder or, with none, after any pass, at most every 30 minutes (spec
 * §7.1); it hands the engine the tabs only a live window can say are in use
 * (spec §4.3). A private window's tree is never swept: it is not this
 * engine's.
 *
 * **Addresses and titles are never logged** (Sval `CONTRIBUTING.md` rule 10).
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalSerialQueue } from "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs";
import { SvalClock } from "moz-src:///browser/components/sval/SvalClock.sys.mjs";
import {
  SvalEngine,
  SvalProcessInstance,
} from "moz-src:///browser/components/sval/SvalEngine.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  refusedAddress:
    "moz-src:///browser/components/sval/SvalSyncableAddress.sys.mjs",
  SvalFirefox: "moz-src:///browser/components/sval/SvalFirefox.sys.mjs",
  SvalLocalSettings:
    "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs",
  SvalSettingsRegistry:
    "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs",
  SvalTabs: "moz-src:///browser/components/sval/SvalTabs.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

/** The Archive's document (host contract §10, "The Archive"). */
export const ARCHIVE_DOCUMENT = "archive";

/** Notified, with no subject, when the Archive's entries may have changed. */
export const ARCHIVE_CHANGED_TOPIC = "sval-archive-changed";

/** The global choice, synced (spec §5). */
export const AUTO_ARCHIVE_PREF = "browser.sval.tabs.autoArchive";

/** How many days an entry is kept, synced (spec §5). */
export const RETENTION_PREF = "browser.sval.tabs.archiveRetentionDays";

export const NEVER = "never";

/** What turning archiving on chooses (spec §5). */
export const DEFAULT_CHOICE = "7d";

/** The times a tab may go unused before it is archived, shortest first. */
export const ARCHIVE_TIMES = Object.freeze([
  Object.freeze({ value: "12h", label: "12 Hours" }),
  Object.freeze({ value: "24h", label: "24 Hours" }),
  Object.freeze({ value: "7d", label: "7 Days" }),
  Object.freeze({ value: "30d", label: "30 Days" }),
]);

export const RETENTION_DAYS = Object.freeze([7, 30, 90]);

/** The retention a profile that has chosen none, or chosen out of range, keeps. */
const DEFAULT_RETENTION_DAYS = 30;

const CHOICES = new Set([...ARCHIVE_TIMES.map(t => t.value), NEVER]);

/** What `SvalSettingsSync` lets a synced value of either pref be. */
export const SYNC_RULES = Object.freeze({
  [AUTO_ARCHIVE_PREF]: Object.freeze({ accepts: value => CHOICES.has(value) }),
  [RETENTION_PREF]: Object.freeze({
    accepts: value => RETENTION_DAYS.includes(value),
  }),
});

/**
 * @param {string} choice One of the choices, or anything else.
 * @returns {string} how a menu names it.
 */
export function choiceLabel(choice) {
  return (
    ARCHIVE_TIMES.find(time => time.value === choice)?.label ??
    (choice === NEVER ? "Never" : choice)
  );
}

/** How often the sweep runs at most (spec §7.1). */
const SWEEP_EVERY_MS = 30 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The tabs only a live window can say are in use (spec §4.3): the tab each
 * normal window shows, which keeps its whole split with it, a tab playing
 * audio or kept loaded, one in picture-in-picture or a call, and a page with
 * form data, asked
 * as `SvalTabs`' discard asks it, after a flush. A page whose process did not
 * answer the flush in time may hold work, so it is kept too.
 *
 * @returns {Promise<string[]>} their node ids.
 */
export async function liveExemptions() {
  const exempt = new Set();
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (win.closed || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      continue;
    }
    for (const tab of win.gBrowser?.tabs ?? []) {
      const id = lazy.SvalTabs.nodeIdOf(tab);
      if (!id || exempt.has(id)) {
        continue;
      }
      if (tab.selected || tab.soundPlaying || tab.undiscardable) {
        exempt.add(id);
        continue;
      }
      // A lazy tab holds no page, and no form data.
      if (lazy.SvalFirefox.isLazy(tab)) {
        continue;
      }
      if (
        lazy.SvalFirefox.isInPictureInPictureOrCall(tab) ||
        (tab.linkedBrowser?.isRemoteBrowser &&
          !(await lazy.SvalFirefox.flushState(win, tab))) ||
        lazy.SvalFirefox.hasFormData(tab)
      ) {
        exempt.add(id);
      }
    }
  }
  return [...exempt];
}

/** The process's one instance, over the profile's engine. */
const shared = new SvalProcessInstance(
  (engine, options) =>
    new SvalArchive({
      engine,
      canBegin: () => SvalEngine.pastFirstRun,
      ...options,
    })
);

/**
 * The sweep and the Archive for one engine: what the panel, the History
 * sidebar and Settings reach through {@link SvalArchive.instance}.
 */
export class SvalArchive {
  #engine;
  #canBegin;
  #settings;
  #exempt;
  #prefs;
  #now;
  #requestPass;

  #started = false;
  #begun = false;
  #stopListening = [];

  /** Every sweep and restore, in order. */
  #queue = new SvalSerialQueue("archive");

  /** When the last sweep began, or null before the first. */
  #lastSweep = null;

  /**
   * Whether a pass this session has merged the settings document, and
   * whether it was registered when the last pass ended. Entries expire only
   * once the first is true, so a device starting with a stale retention
   * period drops nothing a longer period keeps (spec §7.1).
   */
  #settingsMerged = false;
  #settingsHeld = false;

  /** Whether the Archive's document is registered, so it can be listed. */
  #opened = false;

  /** Settles once the Archive's document is registered. */
  #whenOpened = Promise.withResolvers();

  /**
   * @param {object} options
   * @param {object} options.engine The profile's engine.
   * @param {() => boolean} [options.canBegin] Whether this device's sync key
   *   is settled.
   * @param {object} [options.settings] The profile's `SvalLocalSettings`
   *   store, where `lastActive` is; opened when absent.
   * @param {() => Promise<string[]>} [options.exempt] The tabs live checks
   *   keep; {@link liveExemptions} by default.
   * @param {object} [options.prefs] Where the two settings are read.
   * @param {() => number} [options.now] Milliseconds since the epoch.
   * @param {Function} [options.requestPass] Asks for a pass soon.
   */
  constructor({
    engine,
    canBegin = () => true,
    settings = null,
    exempt = liveExemptions,
    prefs = Services.prefs,
    now = () => SvalClock.now(),
    requestPass = () => engine.requestPass(),
  }) {
    this.#engine = engine;
    this.#canBegin = canBegin;
    this.#settings = settings;
    this.#exempt = exempt;
    this.#prefs = prefs;
    this.#now = now;
    this.#requestPass = requestPass;
  }

  /**
   * Starts once this device's sync key is settled: at once if it is,
   * otherwise after the first pass that finds it so. Idempotent.
   */
  async start() {
    if (this.#started) {
      return;
    }
    this.#started = true;
    if (this.#canBegin()) {
      await this.#begin();
      return;
    }
    const stop = this.#engine.addPassListener(() => {
      if (this.#started && !this.#begun && this.#canBegin()) {
        this.#begin().catch(err =>
          SvalLog.warn(`the archive did not start: ${SvalLog.errorName(err)}`)
        );
      }
    });
    this.#stopListening.push(stop);
  }

  async #begin() {
    if (this.#begun) {
      return;
    }
    this.#begun = true;
    try {
      this.#settings ??= await lazy.SvalLocalSettings.openProfile();
      if (!this.#started) {
        return;
      }
      await this.#engine.openDocument(
        ARCHIVE_DOCUMENT,
        report => this.#afterPass(report),
        { retention: () => this.#retention() }
      );
    } catch (err) {
      // Tried again by the next pass that finds it may begin.
      this.#begun = false;
      throw err;
    }
    this.#opened = true;
    this.#whenOpened.resolve();
    this.#stopListening.push(
      this.#engine.addPassListener(report => this.#onPass(report)),
      // A background shared step ends after its pass, so it is heard here.
      this.#engine.addSharedListener(report => {
        if (report.shared === "reached") {
          // With a shared folder, the settings that count are the ones a
          // step merged from it.
          if (
            report.exchanged &&
            lazy.SvalSettingsRegistry.SETTINGS_DOCUMENT in report.exchanged
          ) {
            this.#settingsMerged = true;
          }
          this.#sweepIfDue();
        }
      })
    );
    this.#notify();
  }

  stop() {
    this.#started = false;
    for (const stop of this.#stopListening.splice(0)) {
      stop();
    }
  }

  /** @returns {Promise<void>} once every sweep and restore asked for is done. */
  whenIdle() {
    return this.#queue.idle();
  }

  /** Whether the Archive is loaded, so there is a list to show. */
  get ready() {
    return this.#opened && this.#started;
  }

  /**
   * Every entry, newest first (host contract §10), each with `refused` for
   * an address another device wrote that no device opens (decision 1372),
   * which is listed and never restored.
   *
   * @returns {Promise<object[]>}
   */
  async entries() {
    const rows = await this.#engine.archived(ARCHIVE_DOCUMENT, this.#now());
    return rows.map(row => ({ ...row, refused: lazy.refusedAddress(row) }));
  }

  /**
   * Restores entry `entry` as a new tab, or with the rest of its split as a
   * new split, in its workspace or, with that gone, in `current`, and marks
   * it restored (spec §2).
   *
   * @param {string} entry The entry's id.
   * @param {string} current The workspace the window asking shows.
   * @returns {Promise<object>} `{ tabs, split, workspace }`.
   */
  restore(entry, current) {
    return this.#queue.run(async () => {
      const row = (await this.entries()).find(each => each.id === entry);
      if (!row) {
        throw Object.assign(new Error("sval: no such Archive entry"), {
          code: "no_such_entry",
        });
      }
      if (row.refused) {
        throw Object.assign(
          new Error("sval: another device wrote that entry's address"),
          { code: "refused_entry" }
        );
      }
      const ids = Array.from({ length: row.restoreIds }, () =>
        crypto.randomUUID()
      );
      const restored = await this.#engine.restore(
        ARCHIVE_DOCUMENT,
        { entry, current, ids },
        this.#now()
      );
      this.#notify();
      this.#requestPass();
      return restored;
    });
  }

  /**
   * One sweep (spec §4.2), queued behind any other.
   *
   * @returns {Promise<object>} `{ tabs, entries }`.
   */
  sweep() {
    return this.#queue.run(() => this.#sweepOnce());
  }

  async #sweepOnce() {
    const swept = await this.#engine.archiveIdle(
      ARCHIVE_DOCUMENT,
      {
        default: this.#prefs.getStringPref(AUTO_ARCHIVE_PREF, NEVER),
        lastActive: this.#settings.lastActiveTimes(),
        exempt: await this.#exempt(),
      },
      this.#now()
    );
    if (swept.tabs.length) {
      SvalLog.info(`archived ${swept.tabs.length} idle tabs`);
    }
    this.#afterArchiving(swept);
    return swept;
  }

  /**
   * Archives tab `id` now, whatever its workspace's choice and whether it is
   * in use: the Launcher's Archive command (launcher spec §4). A pane takes
   * its split with it, as a sweep keeps a split whole. Queued behind any
   * sweep or restore.
   *
   * @param {string} id A tab's node id: one at a workspace's top level or a
   *   pane of a split there, in no agent's workspace. The engine refuses
   *   anything else.
   * @returns {Promise<object>} `{ tabs, entries }`.
   */
  archiveNow(id) {
    return this.#queue.run(async () => {
      const swept = await this.#engine.archiveNow(
        ARCHIVE_DOCUMENT,
        id,
        this.#now()
      );
      this.#afterArchiving(swept);
      return swept;
    });
  }

  /**
   * Adds an entry for each tab another browser archived (spec §7.6), once
   * the Archive's document is registered, which is past first run, where an
   * import can run. Queued behind any sweep or restore.
   *
   * @param {object[]} entries `{ title, url, workspace, workspaceName,
   *   closedAt }`, as `SvalImportModel.planArchived` makes them.
   * @returns {Promise<string[]>} the entries' ids.
   */
  async importEntries(entries) {
    if (!entries.length) {
      return [];
    }
    await this.#whenOpened.promise;
    return this.#queue.run(async () => {
      const ids = await this.#engine.importArchived(
        ARCHIVE_DOCUMENT,
        entries.map(entry => ({ ...entry, tab: crypto.randomUUID() })),
        this.#now()
      );
      this.#notify();
      this.#requestPass();
      return ids;
    });
  }

  /**
   * What follows tabs leaving the tree for the Archive.
   *
   * @param {object} swept `{ tabs, entries }`.
   */
  #afterArchiving(swept) {
    if (!swept.tabs.length) {
      return;
    }
    for (const id of swept.tabs) {
      this.#settings.forgetLastActive(id);
    }
    this.#settings.saveSoon();
    this.#notify();
    // Its pass writes the tree's removals, and every window takes out its
    // tab for a node that is gone (`SvalTabObserver.closeOrphanTabs`).
    this.#requestPass();
  }

  /**
   * A pass ended: with no shared folder, the sweep may run after it.
   *
   * @param {object} report The pass's report.
   */
  #onPass(report) {
    if (report?.shared !== "none") {
      return;
    }
    // With no shared folder, the profile's own settings are all there are,
    // read by any pass that began with the document registered.
    if (this.#settingsHeld) {
      this.#settingsMerged = true;
    }
    this.#settingsHeld = this.#engine.hasDocument(
      lazy.SvalSettingsRegistry.SETTINGS_DOCUMENT
    );
    this.#sweepIfDue();
  }

  /** Sweeps if none has begun in the last 30 minutes, or the clock went back. */
  #sweepIfDue() {
    if (!this.#started) {
      return;
    }
    const now = this.#now();
    if (
      this.#lastSweep !== null &&
      now >= this.#lastSweep &&
      now - this.#lastSweep < SWEEP_EVERY_MS
    ) {
      return;
    }
    this.#lastSweep = now;
    this.sweep().catch(err =>
      SvalLog.warn(`the sweep failed: ${SvalLog.errorName(err)}`)
    );
  }

  /**
   * @returns {number|undefined} how long a pass keeps entries, or undefined
   *   until a pass this session has merged the settings document.
   */
  #retention() {
    if (!this.#settingsMerged) {
      return undefined;
    }
    // A value only about:config can give, such as 0, would expire the
    // whole Archive; synced values are checked by `SYNC_RULES`.
    const days = this.#prefs.getIntPref(RETENTION_PREF, DEFAULT_RETENTION_DAYS);
    return (
      (RETENTION_DAYS.includes(days) ? days : DEFAULT_RETENTION_DAYS) * DAY_MS
    );
  }

  #afterPass(report) {
    if (report?.changedIds?.length || report?.removedIds?.length) {
      this.#notify();
    }
  }

  #notify() {
    Services.obs.notifyObservers(null, ARCHIVE_CHANGED_TOPIC);
  }

  /**
   * Starts the archive for `engine`, once for the process
   * (`SvalProcessInstance`), as `SvalHistorySync.startFor` does.
   *
   * @param {object} engine The profile's engine.
   * @param {object} [options] As the constructor takes, beside `engine`.
   * @returns {Promise<SvalArchive>}
   */
  static startFor(engine, options = {}) {
    return shared.startFor(engine, options);
  }

  /** @returns {SvalArchive|null} the process's instance, once made. */
  static get instance() {
    return shared.instance;
  }

  /** Stops the process's instance and forgets it, for tests and shutdown. */
  static stopShared() {
    return shared.stop();
  }
}
