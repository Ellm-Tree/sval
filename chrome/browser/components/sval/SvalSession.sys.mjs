/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  askToPair: "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs",
  ensureCard: "moz-src:///browser/components/sval/SvalCard.sys.mjs",
  SvalAgents: "moz-src:///browser/components/sval/SvalAgents.sys.mjs",
  SvalArchive: "moz-src:///browser/components/sval/SvalArchive.sys.mjs",
  SvalDeviceNames: "moz-src:///browser/components/sval/SvalDeviceNames.sys.mjs",
  SvalEngine: "moz-src:///browser/components/sval/SvalEngine.sys.mjs",
  SvalFavoritesStore:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  SvalHistorySync: "moz-src:///browser/components/sval/SvalHistorySync.sys.mjs",
  SvalIdentity: "moz-src:///browser/components/sval/SvalIdentity.sys.mjs",
  SvalKagi: "moz-src:///browser/components/sval/SvalKagi.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalSettingsSync:
    "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs",
  SvalSyncState: "moz-src:///browser/components/sval/SvalSyncState.sys.mjs",
});

/**
 * The profile's session: its engine, and what runs over that engine for
 * every window.
 *
 * One profile is one device and one device is one document
 * (`SvalEngine.forProfile`), so none of this is a window's. A window asks
 * for it as it starts because the first window is when the profile's
 * session begins, and each part starts once for the process however many
 * windows ask.
 */
export const SvalSession = {
  /**
   * Starts the profile's engine and the modules that run over it, or
   * answers with the engine already running.
   *
   * Settings sync has started when this resolves: a seed that lands after
   * this device's first publication is read by its peers as a deletion
   * (settings-sync spec §2), so a caller's first pass comes after. The
   * documents are independent (spec §6), so settings sync that cannot start
   * costs the settings and never the tabs. Nothing else is waited for.
   *
   * @param {object} options
   * @param {string} options.root This device's own location.
   * @param {string|null} options.sharedRoot The shared folder, or null.
   * @param {object} options.settings The profile's `SvalLocalSettings`
   *   store, which also says whether first run is under way.
   * @returns {Promise<SvalEngine>} the profile's engine.
   */
  async start({ root, sharedRoot, settings }) {
    // The sync key is read before the first pass: a device with a shared
    // folder waits for that folder before it makes a first workspace, and it
    // can only wait for a folder it holds the key to. A key that cannot be
    // read starts the engine without sharing, and its state says why.
    const [deviceId, localKey, sync] = await Promise.all([
      lazy.SvalIdentity.deviceId(),
      lazy.SvalIdentity.localKey(),
      lazy.SvalIdentity.syncKey(),
    ]);
    if (sync.reason) {
      lazy.SvalLog.warn(`not syncing: ${sync.reason}`);
    }
    // A later window's read is not the engine's news: the engine keeps the
    // keys its first window gave it.
    const first = !lazy.SvalEngine.sharedInstance;
    const engine = lazy.SvalEngine.forProfile({
      root,
      sharedRoot,
      localKey,
      syncKey: sync.bytes,
      deviceId,
    });
    const state = lazy.SvalSyncState.of(engine);
    if (first) {
      state.setKeyState(sync.state);
    }

    // Agent access (agent-control spec §3.2). One listener per process.
    lazy.SvalAgents.start({
      profileDir: PathUtils.profileDir,
      engine,
      askToPair: lazy.askToPair,
      version: AppConstants.MOZ_APP_VERSION_DISPLAY,
    });

    try {
      await this.startSettingsSync(engine, settings);
    } catch (err) {
      lazy.SvalLog.warn(
        `settings sync did not start, and tab sync goes on: ${lazy.SvalLog.errorName(err)}`
      );
    }
    // Favorites are the profile's from its engine's start, first run
    // included, so an import there lands in them (favorites-native spec
    // §5.1). Whatever writes them waits until they are read.
    lazy.SvalFavoritesStore.startFor(engine).catch(err =>
      lazy.SvalLog.warn(
        `favorites did not start, and tab sync goes on: ${lazy.SvalLog.errorName(err)}`
      )
    );
    // History begins past first run. Device names go through the settings
    // document, so they start once settings sync has.
    lazy.SvalHistorySync.startFor(engine).catch(err =>
      lazy.SvalLog.warn(
        `history sync did not start, and tab sync goes on: ${lazy.SvalLog.errorName(err)}`
      )
    );
    // The archive begins past first run, and its sweep waits for a pass
    // (idle-tab archive spec §7.1).
    lazy.SvalArchive.startFor(engine).catch(err =>
      lazy.SvalLog.warn(
        `the archive did not start: ${lazy.SvalLog.errorName(err)}`
      )
    );
    lazy.SvalDeviceNames.startFor(engine).catch(err =>
      lazy.SvalLog.warn(
        `device names did not start: ${lazy.SvalLog.errorName(err)}`
      )
    );

    // Private windows sign in to Kagi whenever it is the engine, on every
    // launch (first-run spec §5). Once per process.
    lazy.SvalKagi.watchSearch(lazy.SvalSettingsSync.searchService());
    return engine;
  },

  /**
   * Starts settings sync for `engine`. There is one instance for the
   * process (settings-sync spec §4.2), and the module answers with the one
   * that is running.
   *
   * @param {SvalEngine} engine The profile's engine.
   * @param {object} settings The profile's `SvalLocalSettings` store.
   */
  async startSettingsSync(engine, settings) {
    // The user's card is made before settings sync starts, so sync takes it
    // as a value this device already held: written to the document only
    // where no other device's card is there, which is applied in its place
    // (settings-sync spec §4.2).
    try {
      await lazy.ensureCard();
    } catch (err) {
      lazy.SvalLog.warn(
        `the card could not be made: ${lazy.SvalLog.errorName(err)}`
      );
    }
    await lazy.SvalSettingsSync.startFor(engine, { settings });
  },
};
