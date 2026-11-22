/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Extensions that Sval's changes to Firefox break, decided from what each one
 * asks for and never from a list of extension ids
 * (extension-compatibility spec §2):
 *
 * - A theme, or an extension asking for `contextualIdentities`, is refused:
 *   Sval draws its own colours (`SvalThemes`) and has no containers, so neither
 *   can work. Its install is cancelled and a doorhanger on the extensions
 *   button says why.
 * - An extension asking for `tabHide` installs, then a notice warns that it
 *   sees only the workspace on screen, until the user answers it.
 * - Anything else installs silently.
 *
 * The notices are the extensions button's (`SvalExtensionNotices`), worded
 * as messages spec §6 gives them.
 *
 * An install is refused through the add-on manager's install listener rather
 * than an `ExtensionSettings` policy, whose blocklist would do the same but
 * makes every settings page say the browser is managed by an organisation.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { showNotice } from "moz-src:///browser/components/sval/SvalAppNotices.sys.mjs";
import { SvalExtensionNotices } from "moz-src:///browser/components/sval/SvalExtensionNotices.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  iconURL: "moz-src:///browser/components/sval/SvalIcons.sys.mjs",
});

/**
 * The id of the doorhanger that says an install was refused.
 * `gXPInstallObserver.NOTIFICATION_IDS` (`browser-addons.js`) names it, as
 * Firefox requires of a doorhanger on the extensions button
 * (`gUnifiedExtensions.getPopupAnchorID`); being there also removes the
 * refusal when a page enters full screen.
 */
export const REFUSED_NOTIFICATION = "sval-install-refused";

/** The permission behind `browser.contextualIdentities`, Firefox's containers. */
export const CONTAINERS_PERMISSION = "contextualIdentities";

/** The permission behind `tabs.hide` and `tabs.show`. */
export const TAB_HIDE_PERMISSION = "tabHide";

/**
 * The ids of the extensions whose `tabHide` warning the user has answered, a
 * JSON array. Local, as the extensions installed are.
 */
export const TAB_HIDE_WARNED_PREF = "browser.sval.extensions.tabHideWarned";

/**
 * Whether `addon`'s manifest asks for `permission`, as a required or an
 * optional permission.
 *
 * @param {object|null} addon An `AddonWrapper`.
 * @param {string} permission
 * @returns {boolean}
 */
export function asksFor(addon, permission) {
  return [addon?.userPermissions, addon?.optionalPermissions].some(set =>
    set?.permissions?.includes(permission)
  );
}

function warnedIds() {
  try {
    const ids = JSON.parse(
      Services.prefs.getStringPref(TAB_HIDE_WARNED_PREF, "[]")
    );
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

function dismiss() {
  return { label: "OK" };
}

/**
 * A notice's Remove: uninstalls `addon`, then runs `then`.
 *
 * @param {object} addon An `AddonWrapper`.
 * @param {() => void} [then]
 * @returns {object}
 */
function remove(addon, then) {
  return {
    label: "Remove",
    run: () => {
      then?.();
      addon.uninstall().catch(err => {
        SvalLog.error(`extension uninstall: ${SvalLog.errorName(err)}`);
      });
    },
  };
}

/**
 * Says why an install was refused, in a doorhanger on the extensions button,
 * where Firefox shows its install prompt (messages spec §6). It replaces the
 * download's "addon-progress" doorhanger, which a download that is cancelled
 * leaves up.
 *
 * @param {object} install The cancelled `AddonInstall`.
 */
function noticeRefused(install) {
  const win = lazy.BrowserWindowTracker.getTopWindow();
  if (!win) {
    return;
  }
  const { PopupNotifications, gUnifiedExtensions } = win;
  const browser = win.gBrowser.selectedBrowser;
  const progress = PopupNotifications.getNotification(
    "addon-progress",
    browser
  );
  if (progress) {
    PopupNotifications.remove(progress);
  }
  const text =
    install.type === "theme"
      ? "Sval doesn't support themes."
      : `Sval doesn't support ${install.addon?.name ?? install.name}. Use ` +
        `isolated Workspaces instead.`;
  PopupNotifications.show(
    browser,
    REFUSED_NOTIFICATION,
    text,
    gUnifiedExtensions.getPopupAnchorID(browser, win),
    { label: "OK", accessKey: "O", callback() {} },
    null,
    {
      refusal: install.type === "theme" ? "theme" : "containers",
      popupIconURL: lazy.iconURL("refused"),
      removeOnDismissal: true,
      popupOptions: { position: "bottomright topright" },
    }
  );
}

function markWarned(id) {
  const warned = warnedIds();
  if (!warned.includes(id)) {
    Services.prefs.setStringPref(
      TAB_HIDE_WARNED_PREF,
      JSON.stringify([...warned, id])
    );
  }
}

/**
 * Warns that an installed `tabHide` extension sees only this workspace's
 * tabs, until the user answers. The answer is what is recorded, because a
 * notice lasts only as long as the session: one Sval quit on is shown again
 * at the next start ({@link warnUnansweredTabHide}).
 *
 * @param {object} addon An `AddonWrapper`.
 * @param {object} [options]
 * @param {boolean} [options.open] Opens the extensions panel on the warning,
 *   as it does at install (messages spec §6).
 */
function warnTabHide(addon, { open = false } = {}) {
  if (warnedIds().includes(addon.id)) {
    return;
  }
  showNotice(
    `tab-hide:${addon.id}`,
    `${addon.name} may not work as expected in Sval. It only sees tabs in ` +
      `the current Workspace.`,
    [
      remove(addon, () => markWarned(addon.id)),
      { label: "Keep", run: () => markWarned(addon.id) },
    ],
    { addonId: addon.id, tone: "warning" }
  );
  const win = open && lazy.BrowserWindowTracker.getTopWindow();
  if (win) {
    SvalExtensionNotices.open(win);
  }
}

/**
 * Shows the `tabHide` warning for every enabled extension whose warning the
 * user has not answered.
 */
export async function warnUnansweredTabHide() {
  const addons = await lazy.AddonManager.getAddonsByTypes(["extension"]);
  for (const addon of addons) {
    if (!addon.userDisabled && asksFor(addon, TAB_HIDE_PERMISSION)) {
      warnTabHide(addon);
    }
  }
}

/**
 * Sval's answer for an add-on, by the rules above.
 *
 * @param {object|null} addon An `AddonWrapper`.
 * @returns {"refused"|"warned"|"works"} `refused` for one Sval refuses or
 *   turns off, `warned` for one that sees only the workspace on screen.
 */
export function verdictOf(addon) {
  if (addon?.type === "theme" || asksFor(addon, CONTAINERS_PERMISSION)) {
    return "refused";
  }
  return asksFor(addon, TAB_HIDE_PERMISSION) ? "warned" : "works";
}

/**
 * @param {AddonInstall} install
 * @returns {boolean}
 */
function refuses(install) {
  return install.type === "theme" || verdictOf(install.addon) === "refused";
}

/**
 * Refuses `install` with a doorhanger, unless it updates an extension the user
 * already has turned off: the add-on manager checks those for updates too,
 * and an answer nobody asked for says nothing new.
 *
 * @param {AddonInstall} install
 */
function refuse(install) {
  if (!install.existingAddon?.userDisabled) {
    noticeRefused(install);
  }
}

const installListener = {
  /**
   * A download holds its manifest from here, before Firefox's install prompt,
   * so a refused add-on is refused before the user is asked to add it.
   *
   * @param {AddonInstall} install
   * @returns {boolean}
   */
  onDownloadEnded(install) {
    if (!refuses(install)) {
      return true;
    }
    refuse(install);
    install.cancel();
    return false;
  },

  /**
   * An install from a file has no download, so this is where it is refused.
   * Returning false cancels the install (`AddonInstall.startInstall`).
   *
   * @param {AddonInstall} install
   * @returns {boolean}
   */
  onInstallStarted(install) {
    if (!refuses(install)) {
      return true;
    }
    refuse(install);
    return false;
  },

  onInstallEnded(install, addon) {
    if (addon?.type === "extension" && asksFor(addon, TAB_HIDE_PERMISSION)) {
      warnTabHide(addon, { open: true });
    }
  },
};

/**
 * Turns off every installed extension that asks for containers, such as one
 * a profile imported from Firefox brought, each with its own notice. It is
 * disabled rather than uninstalled, so the data it holds stays and removing
 * it is the user's choice.
 */
export async function disableContainerExtensions() {
  const addons = await lazy.AddonManager.getAddonsByTypes(["extension"]);
  for (const addon of addons) {
    if (addon.userDisabled || !asksFor(addon, CONTAINERS_PERMISSION)) {
      continue;
    }
    try {
      await addon.disable();
    } catch (err) {
      SvalLog.error(`extension disable: ${SvalLog.errorName(err)}`);
      continue;
    }
    showNotice(
      `disabled-containers:${addon.id}`,
      `Sval turned off ${addon.name} because it doesn't support it. Use ` +
        `isolated Workspaces instead.`,
      [remove(addon), dismiss()],
      { addonId: addon.id, tone: "warning" }
    );
  }
}

let started = false;

export const SvalExtensionCompat = {
  /** Starts deciding installs, and turns off what cannot work. Idempotent. */
  start() {
    if (started) {
      return;
    }
    started = true;
    lazy.AddonManager.addInstallListener(installListener);
    disableContainerExtensions().catch(err => {
      SvalLog.error(`extension check: ${SvalLog.errorName(err)}`);
    });
    warnUnansweredTabHide().catch(err => {
      SvalLog.error(`extension check: ${SvalLog.errorName(err)}`);
    });
  },
};
