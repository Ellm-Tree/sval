/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalClock } from "moz-src:///browser/components/sval/SvalClock.sys.mjs";
import { SvalMirror } from "moz-src:///browser/components/sval/SvalMirror.sys.mjs";
import { SvalSettingsRegistry } from "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs";
import { SvalProcessInstance } from "moz-src:///browser/components/sval/SvalEngine.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalFirstRun: "moz-src:///browser/components/sval/SvalFirstRun.sys.mjs",
  SvalLocalSettings:
    "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
});

const {
  SETTINGS_DOCUMENT,
  SEARCH_ENGINE_KEY,
  DEFAULT_SEARCH_ENGINE,
  UNSYNCABLE_URL,
} = SvalSettingsRegistry;

/**
 * @param {*} value A pref's value.
 * @returns {boolean} Whether it is an address no device syncs
 *   (`SvalSettingsRegistry.UNSYNCABLE_URL`), which stays on the device that
 *   holds it and is refused from another.
 */
function isUnsyncableURL(value) {
  return typeof value === "string" && UNSYNCABLE_URL.test(value);
}

/**
 * The process's one instance (settings-sync spec §4.2). Pref observers are
 * process-wide, so a second instance would write every change a second time
 * and write back what the first one applied.
 */
const shared = new SvalProcessInstance((engine, options) =>
  SvalSettingsSync.made(engine, options)
);

/**
 * Mirrors what the user chose into the `settings` document and back
 * (settings-sync spec §4.2), as the adapter of a `SvalMirror` (store-mirror
 * spec §4), which writes only a user's change and never echoes a value it
 * applied. Never touches a locked pref. **Values are never logged**: a
 * homepage is a URL. Nor is the name of a pref in a synced branch, which
 * carries a site; such a pref is logged by its branch.
 */
export class SvalSettingsSync {
  #engine;
  #prefs;
  #search;
  #isSeeded;
  #markSeeded;
  #maySeed;
  #requestPass;
  #keys;
  #branches;
  #rules;
  #now;

  /**
   * `#keys` as a set. Gecko's pref observers match by prefix
   * (`nsPrefBranch::AddObserverImpl` registers `Preferences::PrefixMatch`), so
   * an observer added for a key also hears every pref whose name begins with
   * it, and only an exact match is a synced pref.
   */
  #synced;

  /** False once the search service has failed to start. */
  #searchUsable = true;

  /** setting key -> its node id, as the engine derives it. */
  #ids = new Map();

  #mirror;

  constructor({
    engine,
    prefs,
    search,
    isSeeded,
    markSeeded,
    maySeed = () => true,
    requestPass = () => engine.requestPass(),
    keys = SvalSettingsRegistry.SYNCED_PREFS,
    branches = SvalSettingsRegistry.SYNCED_BRANCHES,
    rules = SvalSettingsRegistry.VALUE_RULES,
    now = () => SvalClock.now(),
  }) {
    this.#engine = engine;
    this.#prefs = prefs;
    this.#search = search;
    this.#isSeeded = isSeeded;
    this.#markSeeded = markSeeded;
    this.#maySeed = maySeed;
    this.#requestPass = requestPass;
    this.#keys = keys;
    this.#synced = new Set(keys);
    this.#branches = branches;
    this.#rules = rules;
    this.#now = now;
    this.#mirror = new SvalMirror({
      engine,
      adapter: this.#adapter(),
      requestPass,
      now,
    });
  }

  /**
   * Registers the document and starts observing. Idempotent. The values this
   * device already held are seeded after a pass, by `#seed`.
   */
  start() {
    return this.#mirror.start();
  }

  stop() {
    this.#mirror.stop();
  }

  /** @returns {Promise<void>} once every queued write either way is done. */
  whenIdle() {
    return this.#mirror.whenIdle();
  }

  /**
   * The store, as the mirror uses it: prefs and the search engine, each
   * setting keyed by its name.
   *
   * @returns {object}
   */
  #adapter() {
    return {
      document: SETTINGS_DOCUMENT,
      keyOf: row => row.key,
      readDocument: async () => {
        const synced = await this.#engine.settings(SETTINGS_DOCUMENT);
        const rows = new Map();
        for (const [key, value] of Object.entries(synced)) {
          const id = await this.#idOf(key);
          rows.set(id, { id, key, value });
        }
        return rows;
      },
      observe: on => this.#observe(on),
      isEcho: (change, applied) => this.#isEcho(change, applied),
      toMutations: changes => this.#toMutations(changes),
      write: (doc, upserts) => this.#write(upserts),
      afterApply: async (report, doc) => {
        const synced = doc
          ? Object.fromEntries([...doc.values()].map(r => [r.key, r.value]))
          : await this.#engine.settings(SETTINGS_DOCUMENT);
        try {
          await this.#seed(synced, report);
        } catch (err) {
          SvalLog.warn(`could not seed settings: ${SvalLog.errorName(err)}`);
        }
      },
    };
  }

  async #idOf(key) {
    if (!this.#ids.has(key)) {
      this.#ids.set(key, await this.#engine.settingId(key));
    }
    return this.#ids.get(key);
  }

  /**
   * Hears every synced pref and the search engine. A pref is reported with
   * the value it publishes: unset when it has no user value, or when this
   * device keeps the value to itself.
   *
   * @param {object} on The mirror's listeners.
   * @param {Function} on.pending Told the keys a change is to, at once.
   * @param {Function} on.changes Told the changes, each with its key.
   * @returns {Function} stops hearing them.
   */
  #observe({ pending, changes }) {
    const observer = {
      observe: (_subject, _topic, pref) => {
        if (!this.#isSynced(pref) || this.#prefs.prefIsLocked(pref)) {
          return;
        }
        let value = this.#userValue(pref);
        if (this.#staysOnDevice(pref, value)) {
          value = null;
        }
        pending([pref]);
        changes([{ key: pref, value }], [pref]);
      },
    };
    const names = [...this.#keys, ...this.#branches];
    for (const name of names) {
      this.#prefs.addObserver(name, observer);
    }
    let stopSearch = this.#search.observe(id => {
      pending([SEARCH_ENGINE_KEY]);
      changes([{ key: SEARCH_ENGINE_KEY, id }], [SEARCH_ENGINE_KEY]);
    });
    this.#stopSearch = () => {
      stopSearch?.();
      stopSearch = null;
    };
    return () => {
      for (const name of names) {
        this.#prefs.removeObserver(name, observer);
      }
      this.#stopSearch();
    };
  }

  #stopSearch = () => {};

  /**
   * Whether a change the store reports is the value being applied. Setting a
   * value equal to the default clears the user value, so the value that took
   * effect is the one compared, and a reset has no user value to compare. A
   * search engine is compared by the id its notification carries.
   *
   * @param {object} change
   * @param {object} applied The row being applied.
   * @returns {boolean}
   */
  #isEcho(change, applied) {
    if (change.key === SEARCH_ENGINE_KEY) {
      return change.id === (applied.value ?? DEFAULT_SEARCH_ENGINE);
    }
    const value = applied.value;
    return (value === null ? change.value : this.#read(change.key)) === value;
  }

  /**
   * The user's changes as `setSetting` operations. A search engine is the one
   * its notification named, and one equal to the synced engine has nothing
   * to write.
   *
   * @param {object[]} changes
   * @returns {Promise<object[]>}
   */
  async #toMutations(changes) {
    const ops = [];
    for (const change of changes) {
      if (change.key !== SEARCH_ENGINE_KEY) {
        ops.push({
          kind: "setSetting",
          key: change.key,
          valueJson:
            change.value === null ? null : JSON.stringify(change.value),
        });
        continue;
      }
      try {
        const id = change.id ?? (await this.#search.currentId());
        const synced = await this.#engine.settings(SETTINGS_DOCUMENT);
        if (id && (synced[SEARCH_ENGINE_KEY] ?? DEFAULT_SEARCH_ENGINE) !== id) {
          ops.push({
            kind: "setSetting",
            key: SEARCH_ENGINE_KEY,
            valueJson: JSON.stringify(id),
          });
        }
      } catch (err) {
        SvalLog.warn(
          `could not record a search engine change: ${SvalLog.errorName(err)}`
        );
      }
    }
    return ops;
  }

  /**
   * Applies every synced setting a pass changed that this build syncs.
   *
   * @param {object[]} rows `{ key, value }`.
   * @returns {Promise<string[]>} ids not written: none, since a value this
   *   build cannot apply is skipped for good.
   */
  async #write(rows) {
    for (const { key, value } of rows) {
      if (key === SEARCH_ENGINE_KEY) {
        if (this.#searchUsable) {
          await this.#applySearch(value);
        }
      } else if (this.#isSynced(key)) {
        this.#applyPref(key, value);
      }
    }
    return [];
  }

  /**
   * Writes, once per key, the value this device held when the key began to
   * sync: on a profile older than settings sync, or for a key a later build
   * added (settings-sync spec §4.2, as decision 0113 amends it).
   *
   * A seed is a change stamped now, so every device takes it as it takes any
   * change. It is written only once a pass has merged what the devices share,
   * and only for a key the document lacks, so it never replaces a choice made
   * on another device: a value already there was applied instead. A device
   * sharing nowhere seeds nothing, and neither does one still in first run or
   * waiting on a pairing (`maySeed`), whose folder and key may not yet be its
   * account's, so joining never overrides what was chosen there.
   *
   * @param {object} synced The document's settings, as `#apply` read them.
   * @param {object} [report] The pass's report.
   */
  async #seed(synced, report) {
    if (!this.#maySeed() || !this.#mergedWhatIsShared(report)) {
      return;
    }
    const considered = [];
    const seeds = [];
    const offer = pref => {
      const value = this.#userValue(pref);
      if (
        !(pref in synced) &&
        value !== null &&
        !this.#staysOnDevice(pref, value)
      ) {
        seeds.push([pref, value]);
      }
    };
    for (const pref of this.#keys) {
      if (this.#isSeeded(pref) || this.#prefs.prefIsLocked(pref)) {
        continue;
      }
      considered.push(pref);
      offer(pref);
    }
    // A branch is seeded as one, by its name: once it is, the observer
    // writes every change to each of its prefs, one added later included.
    for (const branch of this.#branches) {
      if (this.#isSeeded(branch)) {
        continue;
      }
      considered.push(branch);
      for (const pref of this.#prefs.getChildList(branch)) {
        if (!this.#prefs.prefIsLocked(pref)) {
          offer(pref);
        }
      }
    }
    if (!this.#isSeeded(SEARCH_ENGINE_KEY) && this.#searchUsable) {
      try {
        const id =
          SEARCH_ENGINE_KEY in synced ? null : await this.#search.currentId();
        if (id && id !== DEFAULT_SEARCH_ENGINE) {
          seeds.push([SEARCH_ENGINE_KEY, id]);
        }
        considered.push(SEARCH_ENGINE_KEY);
      } catch (err) {
        // The search engine and the prefs are independent (spec §6): a
        // search service that cannot start costs the engine choice alone.
        this.#searchUsable = false;
        this.#stopSearch();
        SvalLog.warn(
          `the search engine will not sync: ${SvalLog.errorName(err)}`
        );
      }
    }
    if (!considered.length) {
      return;
    }
    if (seeds.length) {
      // One batch, so no pass publishes part of it.
      await this.#engine.mutate({
        kind: "batch",
        document: SETTINGS_DOCUMENT,
        ops: seeds.map(([key, value]) => ({
          kind: "seedSetting",
          key,
          valueJson: JSON.stringify(value),
        })),
        now: this.#now(),
      });
    }
    await this.#markSeeded(considered);
    if (seeds.length) {
      this.#requestPass();
    }
  }

  /**
   * Whether the settings document holds what the devices share once the
   * pass `report` describes has run: a shared step reached the folder, or
   * the profile is that folder.
   *
   * @param {object} [report] The pass's report.
   * @returns {boolean}
   */
  #mergedWhatIsShared(report) {
    return (
      report?.shared === "reached" ||
      (report?.shared === "none" &&
        this.#engine.sharedRoot !== null &&
        this.#engine.sharedRoot === this.#engine.root)
    );
  }

  /**
   * @param {string} name
   * @returns {string|null} The synced branch `name` is a pref of, or null.
   */
  #branchOf(name) {
    return this.#branches.find(branch => name.startsWith(branch)) ?? null;
  }

  /**
   * @param {string} name
   * @returns {boolean} Whether `name` is a synced pref.
   */
  #isSynced(name) {
    return this.#synced.has(name) || this.#branchOf(name) !== null;
  }

  /**
   * @param {string} pref
   * @returns {string} What a log line may call `pref`.
   */
  #logName(pref) {
    return this.#branchOf(pref) ?? pref;
  }

  /**
   * @param {string} pref
   * @param {*} value
   * @returns {boolean} Whether this device keeps `value` to itself
   *   (`SvalSettingsRegistry.VALUE_RULES`).
   */
  #staysOnDevice(pref, value) {
    return (
      value !== null &&
      (isUnsyncableURL(value) || !!this.#rules[pref]?.staysOnDevice?.(value))
    );
  }

  #userValue(pref) {
    return this.#prefs.prefHasUserValue(pref) ? this.#read(pref) : null;
  }

  #read(name) {
    switch (this.#prefs.getPrefType(name)) {
      case Ci.nsIPrefBranch.PREF_BOOL:
        return this.#prefs.getBoolPref(name);
      case Ci.nsIPrefBranch.PREF_INT:
        return this.#prefs.getIntPref(name);
      case Ci.nsIPrefBranch.PREF_STRING:
        return this.#prefs.getStringPref(name);
      default:
        return null;
    }
  }

  /**
   * @param {string} pref
   * @param {*} value The synced value.
   */
  #applyPref(pref, value) {
    if (this.#prefs.prefIsLocked(pref)) {
      return;
    }
    const rule = this.#rules[pref];
    if (
      value !== null &&
      (isUnsyncableURL(value) || (rule && !rule.accepts(value)))
    ) {
      SvalLog.debug(
        `refused a synced value that is not valid: ${this.#logName(pref)}`
      );
      return;
    }
    if (this.#staysOnDevice(pref, this.#userValue(pref))) {
      return;
    }
    // A synced reset equals a pref with no user value, and a synced value
    // equals a default that matches it.
    const current = value === null ? this.#userValue(pref) : this.#read(pref);
    if (current === value) {
      return;
    }
    try {
      if (value === null) {
        this.#prefs.clearUserPref(pref);
        return;
      }
      if (!this.#store(pref, value)) {
        SvalLog.debug(
          `skipped a synced setting this build cannot apply: ${this.#logName(pref)}`
        );
      }
    } catch (err) {
      SvalLog.warn(
        `could not apply a synced setting: ${this.#logName(pref)}: ${SvalLog.errorName(err)}`
      );
    }
  }

  /**
   * Sets `pref` to `value` if the value fits the pref's type. A pref nothing
   * has registered yet has no type, so the value's own type stands in for it.
   *
   * @param {string} pref The pref's name.
   * @param {boolean|number|string} value The synced value.
   * @returns {boolean} whether the value was stored.
   */
  #store(pref, value) {
    let type = this.#prefs.getPrefType(pref);
    if (type === Ci.nsIPrefBranch.PREF_INVALID) {
      if (typeof value === "boolean") {
        type = Ci.nsIPrefBranch.PREF_BOOL;
      } else if (Number.isInteger(value)) {
        type = Ci.nsIPrefBranch.PREF_INT;
      } else if (typeof value === "string") {
        type = Ci.nsIPrefBranch.PREF_STRING;
      }
    }
    if (type === Ci.nsIPrefBranch.PREF_BOOL && typeof value === "boolean") {
      this.#prefs.setBoolPref(pref, value);
    } else if (type === Ci.nsIPrefBranch.PREF_INT && Number.isInteger(value)) {
      this.#prefs.setIntPref(pref, value);
    } else if (
      type === Ci.nsIPrefBranch.PREF_STRING &&
      typeof value === "string"
    ) {
      this.#prefs.setStringPref(pref, value);
    } else {
      return false;
    }
    return true;
  }

  async #applySearch(id) {
    const target = id ?? DEFAULT_SEARCH_ENGINE;
    try {
      if ((await this.#search.currentId()) === target) {
        return;
      }
      // The user may have chosen an engine since the caller read the
      // document, so the value to apply is read again just before it is set.
      const latest = (await this.#engine.settings(SETTINGS_DOCUMENT))[
        SEARCH_ENGINE_KEY
      ];
      const wanted = latest ?? DEFAULT_SEARCH_ENGINE;
      // A choice the user made while this read is on its way to the
      // document, and is the later write.
      if (
        this.#mirror.isInFlight(SEARCH_ENGINE_KEY) ||
        (await this.#search.currentId()) === wanted
      ) {
        return;
      }
      if (!(await this.#search.setById(wanted))) {
        SvalLog.debug(
          `skipped a synced search engine this build does not have`
        );
      }
    } catch (err) {
      SvalLog.warn(
        `could not apply the synced search engine: ${SvalLog.errorName(err)}`
      );
    }
  }

  /**
   * Starts settings sync for `engine`, once for the process
   * (`SvalProcessInstance`): every window calls this and gets the same
   * instance. A different engine stops the old instance first.
   *
   * @param {object} engine The profile's engine.
   * @param {object} options
   * @param {object} [options.settings] The `SvalLocalSettings` store that
   *   records which keys are seeded. Defaults to the profile's own, which
   *   every window shares.
   * @param {object} [options.prefs] Defaults to `Services.prefs`.
   * @param {object} [options.search] Defaults to the search service adapter.
   * @param {string[]} [options.keys] As the constructor takes.
   * @param {() => number} [options.now] As the constructor takes.
   * @returns {Promise<SvalSettingsSync>} the process's instance, once started.
   */
  static startFor(engine, options = {}) {
    return shared.startFor(engine, options);
  }

  /**
   * The instance {@link startFor} starts, over the profile's store.
   *
   * @param {object} engine The profile's engine.
   * @param {object} options As {@link startFor} takes.
   * @param {object} [options.settings] As {@link startFor} takes.
   * @param {object} [options.prefs] As {@link startFor} takes.
   * @param {object} [options.search] As {@link startFor} takes.
   * @returns {Promise<SvalSettingsSync>}
   */
  static async made(
    engine,
    {
      settings = null,
      prefs = Services.prefs,
      search = SvalSettingsSync.searchService(),
      ...rest
    } = {}
  ) {
    const store = settings ?? (await lazy.SvalLocalSettings.openProfile());
    return new SvalSettingsSync({
      engine,
      prefs,
      search,
      isSeeded: key => store.isSettingSeeded(key),
      // First run may yet join this profile to another device's account,
      // and a pairing it left claiming will (first-run spec §3.4).
      maySeed: () =>
        !(store.firstRunStarted && !store.firstRunDone) &&
        !lazy.SvalFirstRun.pairing,
      markSeeded: async keys => {
        store.markSettingsSeeded(keys);
        try {
          await store.flush();
        } catch (err) {
          // An unrecorded key is considered again next launch, and a seed
          // is written only for a key the document lacks.
          SvalLog.warn(`could not record the seed: ${SvalLog.errorName(err)}`);
        }
      },
      ...rest,
    });
  }

  /**
   * @returns {{engine: object, sync: SvalSettingsSync|null}|null} the
   *   process's instance and the engine it runs over, or null. `sync` is null
   *   until the instance has been built.
   */
  static get shared() {
    return shared.shared;
  }

  /** Stops the process's instance and forgets it, for tests and shutdown. */
  static stopShared() {
    return shared.stop();
  }

  /**
   * The `search` adapter over Firefox's own search service. A config
   * engine's `id` is its config identifier (`ConfigSearchEngine.sys.mjs`,
   * `id: config.identifier`). The service is the `SearchService` module's
   * export.
   */
  static searchService() {
    return {
      async currentId() {
        await lazy.SearchService.init();
        return lazy.SearchService.defaultEngine?.id ?? null;
      },
      async setById(id) {
        await lazy.SearchService.init();
        const engine = lazy.SearchService.getEngineById(id);
        if (!engine) {
          return false;
        }
        await lazy.SearchService.setDefault(
          engine,
          lazy.SearchService.CHANGE_REASON.USER
        );
        return true;
      },
      /**
       * @param {Function} fn Called with the new default engine's id, which
       *   the notification's subject carries.
       * @returns {Function} stops observing.
       */
      observe(fn) {
        const observer = (subject, _topic, data) => {
          if (data === "engine-default") {
            fn(subject?.wrappedJSObject?.id ?? null);
          }
        };
        Services.obs.addObserver(observer, "browser-search-engine-modified");
        return () =>
          Services.obs.removeObserver(
            observer,
            "browser-search-engine-modified"
          );
      },
    };
  }
}
