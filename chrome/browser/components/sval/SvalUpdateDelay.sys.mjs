/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * How long a background check holds an extension update before installing it
 * (extension controls spec, Part 1). The update manifest carries no publish
 * date (`AddonUpdateChecker.sys.mjs` reads version, link, hash, info URL and
 * `applications.gecko`), so the wait counts from when this device first saw
 * the version.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
});

export const WAIT_PREF = "browser.sval.extensions.updateWaitDays";
export const DEFAULT_WAIT_DAYS = 7;
/** A year. A longer wait would put the install date past what a page shows. */
export const MAX_WAIT_DAYS = 365;

/**
 * One pref per extension id, `{version, seen}`. The branch is not in
 * `SvalSettingsRegistry.SYNCED_BRANCHES`: what this device saw stays here.
 */
const SEEN_BRANCH = "browser.sval.extensions.updateSeen.";

const DAY_MS = 24 * 60 * 60 * 1000;

const isWait = value =>
  Number.isInteger(value) && value >= 0 && value <= MAX_WAIT_DAYS;

export const SYNC_RULES = Object.freeze({
  [WAIT_PREF]: Object.freeze({ accepts: isWait }),
});

function readSeen(id) {
  try {
    const record = JSON.parse(
      Services.prefs.getStringPref(SEEN_BRANCH + id, "")
    );
    if (typeof record?.version === "string" && Number.isFinite(record.seen)) {
      return record;
    }
  } catch {}
  return null;
}

function writeSeen(id, record) {
  Services.prefs.setStringPref(SEEN_BRANCH + id, JSON.stringify(record));
}

let started = false;

export const SvalUpdateDelay = {
  /** @returns {number} The set wait in days, or the default for a bad value. */
  waitDays() {
    const days = Services.prefs.getIntPref(WAIT_PREF, DEFAULT_WAIT_DAYS);
    return isWait(days) ? days : DEFAULT_WAIT_DAYS;
  },

  /**
   * Whether a background check may install `version` of `addon` now, and
   * records the version on first sight. Only extensions wait: a language
   * pack must match the app's version.
   *
   * @param {{id: string, type: string}} addon
   * @param {string} version
   * @param {number} [now]
   * @returns {boolean}
   */
  mayInstall(addon, version, now = Date.now()) {
    const days = this.waitDays();
    if (addon.type !== "extension" || days === 0) {
      return true;
    }
    let record = readSeen(addon.id);
    // A first sight in the future means the clock went back; counting from
    // then would hold the update past the set days.
    if (record?.version !== version || record.seen > now) {
      record = { version, seen: now };
      writeSeen(addon.id, record);
    }
    return now >= record.seen + days * DAY_MS;
  },

  /**
   * @param {string} id
   * @param {number} [now]
   * @returns {{version: string, installsOn: number} | null} The update held
   *   for `id`, or null when none is held or its wait has passed.
   */
  waiting(id, now = Date.now()) {
    const days = this.waitDays();
    const record = readSeen(id);
    if (!record || days === 0) {
      return null;
    }
    const installsOn = record.seen + days * DAY_MS;
    return now < installsOn ? { version: record.version, installsOn } : null;
  },

  /**
   * Installs the update held for `addon` at once, if it is still offered.
   * The install asks for any new permission as a background update does
   * (`AddonManager.updatePromptHandler`). A check that offers nothing leaves
   * the held record stale, so it goes; a check that fails keeps it.
   *
   * @param {object} addon The add-on manager's wrapper.
   * @returns {Promise<"installed" | "none" | "failed">}
   */
  updateNow(addon) {
    return new Promise(resolve => {
      let found = false;
      addon.findUpdates(
        {
          onUpdateAvailable(_addon, install) {
            found = true;
            install.promptHandler = info =>
              lazy.AddonManager.updatePromptHandler(info);
            const failed = () => resolve("failed");
            install.addListener({
              onInstallEnded: () => resolve("installed"),
              onInstallFailed: failed,
              onInstallCancelled: failed,
              onDownloadFailed: failed,
              onDownloadCancelled: failed,
            });
            install.install();
          },
          onUpdateFinished: (_addon, error) => {
            if (found) {
              return;
            }
            if (error !== lazy.AddonManager.UPDATE_STATUS_NO_ERROR) {
              resolve("failed");
              return;
            }
            this.forget(addon.id);
            resolve("none");
          },
        },
        lazy.AddonManager.UPDATE_WHEN_USER_REQUESTED
      );
    });
  },

  /** @param {string} id */
  forget(id) {
    Services.prefs.clearUserPref(SEEN_BRANCH + id);
  },

  /**
   * Clears an extension's record when it is installed, updated or removed,
   * so a reinstall starts a fresh wait. Idempotent.
   */
  start() {
    if (started) {
      return;
    }
    started = true;
    lazy.AddonManager.addAddonListener({
      onInstalled: addon => this.forget(addon.id),
      onUninstalled: addon => this.forget(addon.id),
    });
  },
};
