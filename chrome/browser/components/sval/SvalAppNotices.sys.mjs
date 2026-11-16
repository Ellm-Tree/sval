/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The notices Firefox raises on its app menu, as lines Sval draws itself.
 * Sval's header has no app menu button, so Firefox's doorhangers, badge and
 * banners have nothing to anchor to; `PanelUI.updateNotifications` stands
 * down while that button is not drawn
 * (`app-menu-notices-need-the-button.patch`).
 *
 * {@link updateLines} are the update notices the header's notices button
 * lists (`SvalNoticesButton`). {@link noticeLines} are the lines about
 * extensions, which the extensions panel shows (`SvalExtensionNotices`).
 *
 * The notices are `AppMenuNotifications`' own, and each action is the
 * notification's own action, called the way Firefox's doorhanger calls it.
 * A doorhanger's "Learn more" link is on the line too, and the installed
 * extension's line offers to pin it (messages spec §6).
 * The extension alerts behind the `addon-alert` badge are `ExtensionsUI`'s
 * sideloads and permission updates, with the commands
 * `gExtensionsNotifications.updateAlerts` gives their app menu entries.
 *
 * Sval's own notices about the browser, such as an extension it turned off
 * ({@link showNotice}), are lines too, ahead of Firefox's. They are kept
 * apart from `AppMenuNotifications`, which dismisses every other notice when
 * one is shown and would fold an update notice into its banner.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppMenuNotifications: "resource://gre/modules/AppMenuNotifications.sys.mjs",
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  ExtensionsUI: "resource:///modules/ExtensionsUI.sys.mjs",
});
ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () =>
    new Localization(
      [
        "branding/brand.ftl",
        "browser/appmenu.ftl",
        "browser/appMenuNotifications.ftl",
        "browser/addonNotifications.ftl",
        "toolkit/global/popupnotification.ftl",
      ],
      true
    )
);

/** The topic `AppMenuNotifications` notifies on every change. */
const NOTICES_TOPIC = "appMenu-notifications";

/**
 * The update notices, by notification id: the Fluent message whose
 * attributes label the buttons, and the sentence the line says.
 */
const UPDATE_STRINGS = {
  "update-available": [
    "appmenu-update-available2",
    "appmenu-update-available-message2",
  ],
  "update-manual": ["appmenu-update-manual2", "appmenu-update-manual-message2"],
  "update-unsupported": [
    "appmenu-update-unsupported2",
    "appmenu-update-unsupported-message2",
  ],
  "update-restart": [
    "appmenu-update-restart2",
    "appmenu-update-restart-message2",
  ],
};

/**
 * The update notices Sval words itself, by notification id. Firefox's
 * "another copy running" notice runs to three sentences (messages spec §5).
 */
const SVAL_UPDATE_WORDS = {
  "update-other-instance": {
    text: "Close the other copy of Sval to finish updating.",
    main: "Update and Restart Anyway",
    secondary: "Not Now",
  },
};

/**
 * Firefox keeps a dismissed update notice in its app menu as a banner that
 * runs the main action, and so does the notices button.
 */
const UPDATE_BANNERS = {
  "update-downloading": "appmenuitem-banner-update-downloading",
  "update-available": "appmenuitem-banner-update-available",
  "update-manual": "appmenuitem-banner-update-manual",
  "update-unsupported": "appmenuitem-banner-update-unsupported",
  "update-restart": "appmenuitem-banner-update-restart",
};

/** The topic {@link showNotice} and {@link removeNotice} notify on. */
const SVAL_NOTICES_TOPIC = "sval-app-notices";

/**
 * Sval's own notices, newest first, each
 * `{ key, text, actions, addonId, tone }`.
 */
const svalNotices = [];

/** How many extension alerts the app menu lists at most. */
const MAX_EXTENSION_ALERTS = 4;

function attribute(message, name) {
  return message?.attributes?.find(a => a.name === name)?.value ?? "";
}

/**
 * One update notice's line: `{ key, text, actions }`, the main action first,
 * then the secondary, then the release notes as a `link` where the notice
 * has them. A dismissed notice, and one Firefox shows only as a banner, is
 * `{ key, banner, run }` instead: the banner's words and its main action.
 *
 * @param {Window} win
 * @param {object} notification An `AppMenuNotification`.
 * @returns {object|null}
 */
function updateLine(win, notification) {
  const { AppMenuNotifications } = lazy;
  const strings = UPDATE_STRINGS[notification.id];
  const own = SVAL_UPDATE_WORDS[notification.id];
  if ((own || strings) && !notification.dismissed) {
    const [labels, text] = own ? [] : lazy.l10n.formatMessagesSync(strings);
    const actions = [
      {
        label: own?.main ?? attribute(labels, "buttonlabel"),
        run: () => AppMenuNotifications.callMainAction(win, notification, true),
      },
      {
        label: own?.secondary ?? attribute(labels, "secondarybuttonlabel"),
        run: () => AppMenuNotifications.callSecondaryAction(win, notification),
      },
    ];
    // The release notes, opened as the doorhanger's link opens them
    // (`BrowserGlue`'s `handle-xul-text-link`).
    const { learnMoreURL } = notification.options;
    if (learnMoreURL) {
      const [label] = lazy.l10n.formatValuesSync([
        "popup-notification-learn-more",
      ]);
      actions.push({
        label,
        link: true,
        run: () => win.openTrustedLinkIn(learnMoreURL, "tab"),
      });
    }
    return {
      key: notification.id,
      text: own?.text ?? text.value,
      actions,
    };
  }
  const banner = UPDATE_BANNERS[notification.id];
  if (!banner) {
    return null;
  }
  const [message] = lazy.l10n.formatMessagesSync([banner]);
  return {
    key: notification.id,
    banner: attribute(message, "label"),
    run: () => AppMenuNotifications.callMainAction(win, notification, false),
  };
}

/**
 * The installed extension's "Pin to toolbar", offered on the terms Firefox's
 * doorhanger offers its pin checkbox (`MozAddonInstalledNotification`): the
 * extension has a toolbar button in this window, and that button is in the
 * extensions panel. Pinning answers the notice, as its OK does.
 *
 * @param {Window} win
 * @param {string} addonId
 * @param {() => void} answer Takes the notice away.
 * @returns {object|null}
 */
function pinAction(win, addonId, answer) {
  const { CustomizableUI } = lazy;
  const { gUnifiedExtensions } = win;
  const policy = WebExtensionPolicy.getByID(addonId);
  const widgetId =
    policy?.canAccessWindow(win) &&
    gUnifiedExtensions.browserActionFor(policy)?.id;
  const area = widgetId && CustomizableUI.getPlacementOfWidget(widgetId)?.area;
  if (area !== CustomizableUI.AREA_ADDONS) {
    return null;
  }
  return {
    label: "Pin to toolbar",
    run: () => {
      gUnifiedExtensions._maybeMoveWidgetNodeBack(widgetId);
      gUnifiedExtensions.pinToToolbar(widgetId, true);
      answer();
    },
  };
}

/**
 * An installed extension's line: Firefox's "<name> was added." with its OK,
 * and "Pin to toolbar" when the doorhanger would offer its pin checkbox.
 *
 * @param {Window} win
 * @param {object} notification
 * @returns {object|null}
 */
function installedLine(win, notification) {
  if (notification.dismissed) {
    return null;
  }
  const {
    message = "",
    name = "",
    customElementOptions,
  } = notification.options;
  const answer = () =>
    lazy.AppMenuNotifications.callMainAction(win, notification, true);
  const addonId = customElementOptions?.addonId ?? null;
  const actions = [{ label: "OK", run: answer }];
  const pin = addonId && pinAction(win, addonId, answer);
  if (pin) {
    actions.push(pin);
  }
  return {
    key: notification.id,
    text: message.replace("<>", name),
    actions,
    addonId,
    tone: "info",
  };
}

/**
 * The extension alerts the `addon-alert` badge stands for, in
 * `gExtensionsNotifications.updateAlerts`' order and number. Each is one
 * button and no text, as its app menu entry is, and `prompts`: its action
 * opens Firefox's permission prompt on the extensions button.
 *
 * @param {Window} win
 * @returns {object[]}
 */
function extensionLines(win) {
  const { ExtensionsUI } = lazy;
  const lines = [];
  const line = (key, id, addon, run) => {
    const [label] = lazy.l10n.formatValuesSync([
      { id, args: { addonName: addon.name } },
    ]);
    lines.push({
      key,
      text: "",
      actions: [{ label, run }],
      addonId: addon.id,
      tone: "info",
      prompts: true,
    });
  };
  for (const update of ExtensionsUI.updates) {
    if (lines.length >= MAX_EXTENSION_ALERTS) {
      return lines;
    }
    line(
      `addon-update:${update.addon.id}`,
      "webext-perms-update-menu-item",
      update.addon,
      () => ExtensionsUI.showUpdate(win.gBrowser, update)
    );
  }
  for (const addon of ExtensionsUI.sideloaded) {
    if (lines.length >= MAX_EXTENSION_ALERTS) {
      return lines;
    }
    line(
      `addon-sideload:${addon.id}`,
      "webext-perms-sideload-menu-item",
      addon,
      () => ExtensionsUI.showSideloaded(win.gBrowser, addon)
    );
  }
  return lines;
}

/**
 * The lines about extensions for a window: Sval's own notices, newest first,
 * then Firefox's installed extension, then its extension alerts.
 *
 * Each line is `{ key, text, actions, addonId, tone }`: `actions` follow the
 * text, each `{ label, run }`; `addonId` is the extension the line is about,
 * or null; `tone` is `"info"` or `"warning"`. A line Firefox draws as an app
 * menu entry is one button and no text.
 *
 * @param {Window} win A browser window.
 * @returns {object[]}
 */
export function noticeLines(win) {
  const lines = svalNotices.map(({ key, text, actions, addonId, tone }) => ({
    key,
    text,
    addonId,
    tone,
    actions: actions.map(({ label, run }) => ({
      label,
      run: () => {
        removeNotice(key);
        run?.();
      },
    })),
  }));
  const { notifications } = lazy.AppMenuNotifications;
  const installed = notifications.find(n => n.id === "addon-installed");
  const line = installed && installedLine(win, installed);
  if (line) {
    lines.push(line);
  }
  if (notifications.some(n => n.id === "addon-alert")) {
    lines.push(...extensionLines(win));
  }
  return lines;
}

/**
 * The update notices for a window, newest first, as `AppMenuNotifications`
 * keeps them; each as {@link updateLine} gives it.
 *
 * @param {Window} win A browser window.
 * @returns {object[]}
 */
export function updateLines(win) {
  const lines = [];
  for (const notification of lazy.AppMenuNotifications.notifications) {
    if (notification.id.startsWith("update-")) {
      const line = updateLine(win, notification);
      if (line) {
        lines.push(line);
      }
    }
  }
  return lines;
}

/**
 * Calls `onChange` whenever a window's lines may differ: a notice raised or
 * dealt with, an extension alert added or answered, which `ExtensionsUI`
 * reports without the `addon-alert` notice changing, and a toolbar button
 * made or moved, which decides the pin button, as the doorhanger's
 * `BrowserActionWidgetObserver` watches for.
 *
 * @param {() => void} onChange
 * @returns {() => void} Stops watching.
 */
export function watchNotices(onChange) {
  const observer = () => onChange();
  const widgets = {
    onWidgetCreated: observer,
    onWidgetAdded: observer,
    onWidgetMoved: observer,
  };
  Services.obs.addObserver(observer, NOTICES_TOPIC);
  Services.obs.addObserver(observer, SVAL_NOTICES_TOPIC);
  lazy.ExtensionsUI.on("change", observer);
  lazy.CustomizableUI.addListener(widgets);
  return () => {
    Services.obs.removeObserver(observer, NOTICES_TOPIC);
    Services.obs.removeObserver(observer, SVAL_NOTICES_TOPIC);
    lazy.ExtensionsUI.off("change", observer);
    lazy.CustomizableUI.removeListener(widgets);
  };
}

/**
 * Adds a notice of Sval's own to every window's {@link noticeLines} until
 * one of its actions is taken. Each action takes the notice away, then runs.
 * A notice shown again under the same key replaces the one before.
 *
 * @param {string} key Names the notice.
 * @param {string} text
 * @param {object[]} actions `{ label, run }` each, `run` optional.
 * @param {object} [options]
 * @param {?string} [options.addonId] The extension the notice is about.
 * @param {"info"|"warning"} [options.tone]
 */
export function showNotice(
  key,
  text,
  actions,
  { addonId = null, tone = "info" } = {}
) {
  const at = svalNotices.findIndex(notice => notice.key === key);
  if (at !== -1) {
    svalNotices.splice(at, 1);
  }
  svalNotices.unshift({ key, text, actions, addonId, tone });
  Services.obs.notifyObservers(null, SVAL_NOTICES_TOPIC);
}

/**
 * Takes away the notice {@link showNotice} showed under `key`, if any.
 *
 * @param {string} key
 */
export function removeNotice(key) {
  const at = svalNotices.findIndex(notice => notice.key === key);
  if (at !== -1) {
    svalNotices.splice(at, 1);
    Services.obs.notifyObservers(null, SVAL_NOTICES_TOPIC);
  }
}
