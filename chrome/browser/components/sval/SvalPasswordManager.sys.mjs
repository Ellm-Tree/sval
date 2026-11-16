/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The user's password manager (spec §7.3). Sval keeps no credentials: it
 * installs the extension of the manager the user already has, from
 * addons.mozilla.org, and nothing else.
 *
 * Every manager is offered alike, alphabetically, and none is preset: the
 * default is `none`, which installs nothing. The choice is
 * `browser.sval.passwordManager`. It stays on this device, because an extension
 * installs per device and a choice that arrived by sync would install one
 * nobody asked for here.
 *
 * An install that fails keeps the choice and is recorded in
 * `browser.sval.passwordManager.installFailed`. The next launch retries it
 * once. Separately, every return of the network retries it while it stays
 * failed. A notice on the extensions button says why and offers to try again
 * (messages spec §6).
 */

import { SvalAddons } from "moz-src:///browser/components/sval/SvalAddons.sys.mjs";
import {
  removeNotice,
  showNotice,
} from "moz-src:///browser/components/sval/SvalAppNotices.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalSerialQueue } from "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs";

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const CHOICE_PREF = "browser.sval.passwordManager";
const INSTALL_FAILED_PREF = "browser.sval.passwordManager.installFailed";

const NONE = "none";

const OFFLINE_TOPIC = "network:offline-status-changed";
const RETRY_TOPICS = [
  OFFLINE_TOPIC,
  "network:link-status-changed",
  "xpcom-shutdown",
];

/** The key of the notice a failed install shows. */
const NOTICE_KEY = "password-manager";

/**
 * The managers offered, by AMO listing and add-on id. `platforms`, when
 * present, lists the only `AppConstants.platform` values the extension works
 * on. `importSteps` is where the manager takes a browser's exported CSV, for
 * import's logins hand-off (import spec §5.1); each comes from the vendor's
 * own help pages as of 2026-10.
 */
const MANAGERS = Object.freeze([
  {
    key: "1password",
    name: "1Password",
    slug: "1password-x-password-manager",
    id: "{d634138d-c276-4fc8-924b-40a0ea21d284}",
    importSteps:
      "in the app, File › Import (on Windows and Linux, ⋯ › Import), then choose the browser the file came from",
  },
  {
    key: "bitwarden",
    name: "Bitwarden",
    slug: "bitwarden-password-manager",
    id: "{446900e4-71c2-419f-a6a7-df9c091e268b}",
    importSteps:
      "in the web vault, Tools › Import, then choose the browser the file came from as the format",
  },
  {
    key: "dashlane",
    name: "Dashlane",
    slug: "dashlane",
    id: "jetpack-extension@dashlane.com",
    importSteps: "in the Dashlane web app, Import data",
  },
  {
    key: "icloud",
    name: "iCloud Passwords",
    slug: "icloud-passwords",
    id: "password-manager-firefox-extension@apple.com",
    platforms: ["macosx", "win"],
    importSteps: "in the Passwords app, File › Import Passwords from File…",
  },
  {
    key: "keepassxc",
    name: "KeePassXC",
    slug: "keepassxc-browser",
    id: "keepassxc-browser@keepassxc.org",
    importSteps: "Database › Import… › CSV, then check the columns",
  },
  {
    key: "lastpass",
    name: "LastPass",
    slug: "lastpass-password-manager",
    id: "support@lastpass.com",
    importSteps:
      "in the web vault, Advanced options › Import, then choose the browser the file came from",
  },
  {
    key: "nordpass",
    name: "NordPass",
    slug: "nordpass-password-management",
    id: "nordpassStandalone@nordsecurity.com",
    importSteps:
      "Settings › Import items, then choose the browser the file came from",
  },
  {
    key: "protonpass",
    name: "Proton Pass",
    slug: "proton-pass",
    id: "78272b6fa58f4a1abaac99321d503a20@proton.me",
    importSteps:
      "in the extension, Settings › Import, then choose the browser the file came from",
  },
]);

/**
 * @param {string} key
 * @returns {?object} the manager, or null for `none` and any unknown key.
 */
function managerFor(key) {
  return MANAGERS.find(manager => manager.key === key) ?? null;
}

/**
 * The keys offered on `platform`, `none` last.
 *
 * @param {string} [platform] An `AppConstants.platform` value.
 * @returns {string[]}
 */
function choices(platform = AppConstants.platform) {
  return [
    ...MANAGERS.filter(
      manager => !manager.platforms || manager.platforms.includes(platform)
    ).map(manager => manager.key),
    NONE,
  ];
}

function contextFrom({ addons = SvalAddons, prefs = Services.prefs }) {
  return { addons, prefs };
}

/**
 * The notice's sentence. The only causes Sval can tell apart are no network
 * and everything else, so those are the two it names.
 *
 * @param {string} name The manager's name.
 * @param {boolean} offline Whether the browser was offline at the failure.
 * @returns {string}
 */
export function installFailureText(name, offline) {
  return `${name} couldn't be installed: ${
    offline ? "you're offline" : "the download failed"
  }.`;
}

/**
 * Says that `manager`'s extension did not install, with a Try Again that
 * retries it.
 *
 * @param {object} manager One of {@link MANAGERS}.
 */
function noticeFailed(manager) {
  showNotice(
    NOTICE_KEY,
    installFailureText(manager.name, Services.io.offline),
    [
      {
        label: "Try Again",
        run: () =>
          SvalPasswordManager.reconcile().catch(err => {
            SvalLog.warn(
              `the password manager retry failed: ${SvalLog.errorName(err)}`
            );
          }),
      },
    ],
    { addonId: manager.id, tone: "warning" }
  );
}

/**
 * Retries a failed install when the network returns. It listens only while an
 * install is recorded as failed, and `xpcom-shutdown` ends it.
 */
const networkRetry = {
  context: null,
  listening: false,

  start(context) {
    this.context = context;
    if (this.listening) {
      return;
    }
    this.listening = true;
    for (const topic of RETRY_TOPICS) {
      Services.obs.addObserver(this, topic);
    }
  },

  stop() {
    this.context = null;
    if (!this.listening) {
      return;
    }
    this.listening = false;
    for (const topic of RETRY_TOPICS) {
      Services.obs.removeObserver(this, topic);
    }
  },

  observe(_subject, topic, data) {
    if (topic === "xpcom-shutdown") {
      this.stop();
      return;
    }
    const back = topic === OFFLINE_TOPIC ? data === "online" : data === "up";
    if (!back || Services.io.offline || !this.context) {
      return;
    }
    SvalPasswordManager.reconcile(this.context).catch(err => {
      SvalLog.warn(
        `the password manager retry failed: ${SvalLog.errorName(err)}`
      );
    });
  },
};

/**
 * Installs `manager`'s extension when it is absent, recording a failure.
 *
 * @param {object} manager One of {@link MANAGERS}.
 * @param {object} context
 * @param {object} context.addons The add-on adapter.
 * @param {object} context.prefs The preference service, or a stand-in.
 * @returns {Promise<{installed: boolean, failed: boolean}>}
 */
async function ensureInstalled(manager, { addons, prefs }) {
  try {
    if (await addons.get(manager.id)) {
      prefs.clearUserPref(INSTALL_FAILED_PREF);
      networkRetry.stop();
      removeNotice(NOTICE_KEY);
      return { installed: false, failed: false };
    }
    await addons.install(SvalAddons.amoUrl(manager.slug), manager.id);
  } catch (err) {
    prefs.setBoolPref(INSTALL_FAILED_PREF, true);
    SvalLog.warn(
      `the password manager install failed: ${SvalLog.errorName(err)}`
    );
    noticeFailed(manager);
    networkRetry.start({ addons, prefs });
    return { installed: false, failed: true };
  }
  prefs.clearUserPref(INSTALL_FAILED_PREF);
  networkRetry.stop();
  removeNotice(NOTICE_KEY);
  return { installed: true, failed: false };
}

// A choice and a launch retry both write the prefs the other reads.
const queue = new SvalSerialQueue("password manager");
function serialized(task) {
  return queue.run(task);
}

/** The launch's one {@link SvalPasswordManager.reconcileAtLaunch}. */
let launchReconcile = null;

export const SvalPasswordManager = {
  MANAGERS,
  NONE,
  choices,
  managerFor,

  /**
   * @param {object} [prefs] The preference service, or a stand-in.
   * @returns {string} the chosen key, `none` when there is none.
   */
  current(prefs = Services.prefs) {
    const key = prefs.getStringPref(CHOICE_PREF, NONE);
    return managerFor(key) ? key : NONE;
  },

  /**
   * Records the user's choice and installs its extension when it is absent.
   * `none` installs nothing and removes nothing: an extension the user has is
   * theirs to remove.
   *
   * @param {string} key One of {@link choices}. Anything else changes nothing.
   * @param {object} [options] Test seams: `addons`, `prefs`.
   * @returns {Promise<{installed: boolean, failed: boolean}>}
   */
  choose(key, options = {}) {
    const context = contextFrom(options);
    const manager = managerFor(key);
    if (!manager && key !== NONE) {
      SvalLog.warn("a password manager sval does not know was ignored");
      return Promise.resolve({ installed: false, failed: false });
    }
    return serialized(() => {
      context.prefs.setStringPref(CHOICE_PREF, key);
      if (!manager) {
        context.prefs.clearUserPref(INSTALL_FAILED_PREF);
        networkRetry.stop();
        removeNotice(NOTICE_KEY);
        return { installed: false, failed: false };
      }
      return ensureInstalled(manager, context);
    });
  },

  /**
   * Retries a recorded failed install.
   *
   * @param {object} [options] Test seams, as for {@link choose}.
   * @returns {Promise<{failed: boolean}>} whether it failed again.
   */
  reconcile(options = {}) {
    const context = contextFrom(options);
    return serialized(async () => {
      const manager = managerFor(
        context.prefs.getStringPref(CHOICE_PREF, NONE)
      );
      if (!manager || !context.prefs.getBoolPref(INSTALL_FAILED_PREF, false)) {
        networkRetry.stop();
        return { failed: false };
      }
      const { failed } = await ensureInstalled(manager, context);
      return { failed };
    });
  },

  /**
   * {@link reconcile}, once per process: every window asks for it at launch,
   * and all of them get the first one's answer.
   *
   * @param {object} [options] Test seams, as for {@link choose}.
   * @returns {Promise<{failed: boolean}>}
   */
  reconcileAtLaunch(options = {}) {
    launchReconcile ??= this.reconcile(options);
    return launchReconcile;
  },
};
