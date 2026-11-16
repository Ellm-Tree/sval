/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Installing an extension Sval offers, from addons.mozilla.org (first-run spec
 * §4, spec §7.3). The one place Sval asks the add-on manager to install.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
});

/**
 * The newest release of an AMO listing. AMO redirects it to the file on its
 * own host, so Sval contacts no other.
 *
 * @param {string} slug The listing's slug.
 * @returns {string}
 */
function amoUrl(slug) {
  return `https://addons.mozilla.org/firefox/downloads/latest/${slug}/latest.xpi`;
}

export const SvalAddons = {
  amoUrl,

  /**
   * @param {string} id The add-on's id.
   * @returns {Promise<?{enabled: boolean}>} null when it is not installed.
   */
  async get(id) {
    const addon = await lazy.AddonManager.getAddonByID(id);
    return addon ? { enabled: !addon.userDisabled } : null;
  },

  /**
   * Chrome-initiated installs use the default `promptHandler`, which resolves
   * at once (XPIInstall.sys.mjs, AddonInstall constructor), so no Firefox
   * prompt follows Sval's own screen. Rejects when the install fails.
   *
   * The add-on manager checks AMO's signature. Sval also checks that what
   * arrived is the add-on it asked for: a listing whose latest file became a
   * different extension is refused as it starts to install. A listener that
   * returns false from `onInstallStarted` cancels the install
   * (`AddonInstall.startInstall`), which rejects it.
   *
   * @param {string} url Where the XPI comes from.
   * @param {string} id The id the add-on must have.
   */
  async install(url, id) {
    const install = await lazy.AddonManager.getInstallForURL(url, {
      telemetryInfo: { source: "sval-first-run" },
    });
    install.addListener({
      onInstallStarted: started => started.addon?.id === id,
    });
    await install.install();
  },
};
