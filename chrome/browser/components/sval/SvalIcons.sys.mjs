/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Every icon Sval draws, named for what it stands for: one name per action,
 * state or thing, so the header, the Launcher, Site Settings, menus and
 * settings show one glyph for it.
 *
 * Stylesheets read an icon as `var(--sval-icon-<name>)` from `sval-icons.css`,
 * which `scripts/check-icons.py --write` generates from this table. Code that
 * needs a URL calls `iconURL`. `scripts/check-icons.py` fails on a Sval icon
 * URL written anywhere else, on a name this table lacks, and on a
 * `sval-icons.css` that has drifted from it.
 *
 * Each path is relative to `chrome://browser/content/sval/` and registered in
 * Sval's `jar.mn`.
 */

const BASE = "chrome://browser/content/sval/";

export const ICONS = Object.freeze({
  // Navigation and the address field.
  back: "header-icons/back.svg",
  forward: "header-icons/forward.svg",
  go: "header-icons/forward.svg",
  reload: "header-icons/reload.svg",
  stop: "header-icons/stop.svg",
  home: "header-icons/home.svg",
  history: "header-icons/history.svg",
  "switch-tab": "header-icons/switch-tab.svg",
  previous: "icons/arrow-left.svg",

  // Sval's commands, in the header, the Launcher and the menus.
  panel: "icons/panel-left.svg",
  "panel-on-left": "icons/panel-left.svg",
  "full-screen": "icons/maximize.svg",
  "exit-full-screen": "icons/minimize.svg",
  "panel-on-right": "icons/panel-right.svg",
  split: "header-icons/split.svg",
  pin: "icons/pin.svg",
  pinned: "icons/pin-fill.svg",
  favorite: "header-icons/star.svg",
  favorited: "header-icons/star-filled.svg",
  copy: "icons/copy.svg",
  "clean-address": "icons/broom.svg",
  reader: "header-icons/book-open.svg",
  translate: "header-icons/languages.svg",
  media: "header-icons/media.svg",
  "media-off": "header-icons/media-off.svg",
  javascript: "header-icons/javascript.svg",
  "javascript-off": "header-icons/javascript-off.svg",
  "site-settings": "header-icons/sliders-horizontal.svg",
  colorshift: "icons/palette.svg",
  snip: "icons/scissors.svg",
  "remove-element": "icons/eraser.svg",
  "hide-element": "icons/eye-off.svg",
  private: "header-icons/private.svg",
  extensions: "header-icons/extensions.svg",
  notices: "icons/bell.svg",
  update: "icons/circle-arrow-up.svg",
  feedback: "icons/message-circle.svg",
  command: "icons/square-terminal.svg",

  // A page's use of the camera, microphone and the rest, in the header.
  camera: "header-icons/camera.svg",
  "camera-off": "header-icons/camera-off.svg",
  mic: "header-icons/mic.svg",
  "mic-off": "header-icons/mic-off.svg",
  screen: "header-icons/screen.svg",
  "screen-off": "header-icons/screen-off.svg",
  location: "header-icons/location.svg",
  "location-off": "header-icons/location-off.svg",
  notifications: "header-icons/bell.svg",
  storage: "header-icons/storage.svg",

  // Site Settings and protection: a site's permissions and what Sval blocks.
  "site-camera": "protection-icons/sc-camera.svg",
  "site-camera-off": "protection-icons/sc-camera-off.svg",
  "site-mic": "protection-icons/sc-mic.svg",
  "site-mic-off": "protection-icons/sc-mic-off.svg",
  "site-screen": "protection-icons/sc-screen.svg",
  "site-screen-off": "protection-icons/sc-screen-off.svg",
  "site-location": "protection-icons/sc-location.svg",
  "site-notifications": "protection-icons/sc-bell.svg",
  "site-storage": "protection-icons/sc-storage.svg",
  "site-popups": "protection-icons/sc-popup.svg",
  "site-network": "protection-icons/sc-network.svg",
  "site-devices": "protection-icons/sc-laptop.svg",
  "site-vr": "protection-icons/sc-glasses.svg",
  "site-key": "protection-icons/sc-key.svg",
  "site-alert": "protection-icons/sc-alert.svg",
  "site-warning": "protection-icons/sc-shield-alert.svg",
  "site-shield": "protection-icons/sc-shield-plain.svg",
  "site-back": "protection-icons/sc-back.svg",
  "site-next": "protection-icons/sc-next.svg",
  "site-close": "protection-icons/sc-x.svg",
  "site-expand": "protection-icons/sc-chevron-down.svg",
  certificate: "protection-icons/sc-cert.svg",
  cookies: "protection-icons/sc-cookie.svg",
  external: "protection-icons/sc-external.svg",
  protection: "protection-icons/pr-shield.svg",
  "protection-on": "protection-icons/pr-shield-fill.svg",
  "protection-off": "protection-icons/pr-shield-off.svg",
  "protection-info": "protection-icons/pr-info.svg",
  "autoplay-blocked": "protection-icons/pr-media-off.svg",
  trackers: "protection-icons/pr-tracker.svg",
  fingerprinting: "protection-icons/pr-fingerprint.svg",
  ads: "protection-icons/pr-ads.svg",
  blocked: "icons/shield-ban.svg",
  refused: "icons/ban.svg",
  "page-error": "icons/shield-off.svg",

  // Settings' categories and rows.
  sync: "icons/cloud.svg",
  links: "icons/route.svg",
  sites: "icons/globe.svg",
  workspaces: "icons/panel-left.svg",
  privacy: "icons/shield-half.svg",
  "extensions-settings": "icons/puzzle.svg",
  agents: "icons/bot.svg",
  "agents-on": "icons/shield-check.svg",
  "agents-off": "icons/shield-off.svg",
  "agent-pointer": "icons/mouse-pointer-2.svg",
  keyboard: "icons/keyboard.svg",
  password: "icons/key-round.svg",
  device: "icons/laptop.svg",
  folder: "icons/folder.svg",
  "folder-sync": "icons/folder-sync.svg",
  "import-file": "icons/folder-open.svg",
  "choose-folder": "icons/folder-open.svg",
  "bookmark-folder": "icons/folder-open.svg",
  "unknown-browser": "icons/globe.svg",
  card: "icons/id-card.svg",
  drag: "icons/grip-vertical.svg",
  search: "icons/search.svg",

  // First run's choices.
  "new-sync": "icons/user-plus.svg",
  "privacy-off": "icons/shield-ban.svg",
  "privacy-balanced": "icons/shield-half.svg",
  "privacy-strict": "icons/shield-check.svg",
  none: "icons/badge-minus.svg",
  "default-browser": "icons/app-window.svg",

  // Sync's state in the Workspace panel.
  "sync-moon": "sync-icons/moon.svg",
  "sync-moon-off": "sync-icons/moon-off.svg",
  "sync-moon-syncing": "sync-icons/satellite.svg",
  "sync-offline": "sync-icons/badge-pause.svg",
  "sync-warning": "sync-icons/badge-bang.svg",
  "sync-error": "sync-icons/badge-x.svg",

  // Firefox's own pages and panels, through `jar.mn`'s overrides.
  verified: "icons/badge-check.svg",
  columns: "icons/columns-3.svg",
  images: "icons/image.svg",
  "download-finished": "icons/circle-check.svg",
  downloads: "icons/download.svg",
  more: "icons/ellipsis.svg",
  eye: "icons/eye.svg",
  help: "icons/circle-help.svg",
  settings: "icons/settings.svg",
  performance: "icons/gauge.svg",
  tabs: "icons/panels-top-left.svg",
  "quick-actions": "icons/zap.svg",
  import: "icons/import.svg",
  contrast: "icons/contrast.svg",
  "site-data": "icons/cookie.svg",
  restore: "icons/rotate-ccw.svg",
  next: "icons/chevron-right.svg",
  "open-external": "icons/external-link.svg",
  link: "icons/link.svg",
  light: "icons/sun.svg",
  dark: "icons/moon.svg",
  spellcheck: "icons/spell-check.svg",
  plugins: "icons/plug.svg",
  policies: "icons/file-check.svg",
  "policy-docs": "icons/file-text.svg",
  profiler: "icons/activity.svg",
  license: "icons/scale.svg",
  browsing: "icons/mouse-pointer-2.svg",
  page: "icons/globe.svg",
  "new-window": "icons/app-window.svg",

  // Generic actions and states.
  add: "icons/plus.svg",
  check: "icons/check.svg",
  close: "icons/x.svg",
  undo: "icons/undo-2.svg",
  edit: "dialog-icons/pencil.svg",
  delete: "dialog-icons/trash-2.svg",
  "dialog-check": "dialog-icons/check.svg",
  expand: "icons/chevron-down.svg",
  collapse: "icons/chevron-up.svg",
  success: "icons/circle-check.svg",
  error: "icons/circle-alert.svg",
  warning: "icons/triangle-alert.svg",
  critical: "sync-icons/critical.svg",
  info: "icons/badge-info.svg",
  attention: "icons/badge-alert.svg",
  failed: "icons/badge-x.svg",
  waiting: "icons/clock-3.svg",
  loading: "icons/loader-circle.svg",
  syncing: "icons/refresh-cw.svg",

  // The notification bar's own set.
  "notice-info": "notification-icons/info.svg",
  "notice-warning": "notification-icons/warning.svg",
  "notice-critical": "notification-icons/critical.svg",
  "notice-close": "notification-icons/close.svg",
  "notice-expand": "notification-icons/chevron-down.svg",
});

/**
 * Firefox's icons that Sval's art replaces wherever Firefox draws them, by
 * URL: `[name, width, height, sized]`. Width and height are the Firefox
 * file's own, and `sized` says whether it states them; a file that does not
 * is drawn at the size its page gives it, in its viewBox's proportions.
 * `scripts/check-icons.py --write` makes a copy of each name's art at that
 * size in `firefox-icons/`, because Firefox's CSS draws many of these at
 * their own size, and adds `jar.mn`'s override for it. The copy falls back
 * to Sval's ink where no context paint reaches it.
 */
export const FIREFOX_ICONS = Object.freeze({
  "chrome://global/skin/icons/info-filled.svg": ["info", 16, 16, true],
  "chrome://global/skin/icons/menu-check.svg": ["check", 16, 16, true],
  "chrome://global/skin/icons/arrow-down-12.svg": ["expand", 12, 12, true],
  "chrome://global/skin/icons/arrow-up-12.svg": ["collapse", 12, 12, true],
  "chrome://global/skin/icons/arrow-up.svg": ["collapse", 16, 16, true],
  "chrome://global/skin/icons/arrow-left-12.svg": ["previous", 12, 12, true],
  "chrome://global/skin/icons/folder.svg": ["folder", 16, 16, true],
  "chrome://global/skin/icons/reload.svg": ["reload", 16, 16, true],
  "chrome://browser/skin/notification-icons/camera-blocked.svg": [
    "camera-off",
    16,
    16,
    true,
  ],
  "chrome://browser/skin/notification-icons/microphone.svg": [
    "mic",
    16,
    16,
    true,
  ],
  "chrome://browser/skin/notification-icons/microphone-blocked.svg": [
    "mic-off",
    16,
    16,
    true,
  ],
  "chrome://browser/skin/notification-icons/screen.svg": [
    "screen",
    16,
    16,
    true,
  ],
  "chrome://browser/skin/notification-icons/screen-blocked.svg": [
    "screen-off",
    16,
    16,
    true,
  ],
  "chrome://browser/skin/notification-icons/geo-blocked.svg": [
    "location-off",
    16,
    16,
    true,
  ],
  "chrome://browser/skin/notification-icons/desktop-notification.svg": [
    "notifications",
    16,
    16,
    true,
  ],
  "chrome://browser/skin/notification-icons/persistent-storage.svg": [
    "storage",
    16,
    16,
    true,
  ],
  "chrome://global/skin/icons/columnpicker.svg": ["columns", 12, 12, true],
  "chrome://browser/content/policies/policies-active.svg": [
    "policies",
    16,
    16,
    true,
  ],
  "chrome://browser/content/policies/policies-documentation.svg": [
    "policy-docs",
    16,
    16,
    true,
  ],
  "chrome://browser/content/preferences/spell-check-promo.svg": [
    "spellcheck",
    162,
    100,
    true,
  ],
  "chrome://browser/content/preferences/web-appearance-dark.svg": [
    "dark",
    54,
    42,
    false,
  ],
  "chrome://browser/content/preferences/web-appearance-light.svg": [
    "light",
    54,
    42,
    false,
  ],
  "chrome://browser/skin/bookmark.svg": ["favorite", 16, 16, true],
  "chrome://browser/skin/contrast.svg": ["contrast", 16, 16, true],
  "chrome://browser/skin/controlcenter/3rdpartycookies.svg": [
    "site-data",
    16,
    16,
    true,
  ],
  "chrome://browser/skin/downloads/downloads.svg": ["downloads", 16, 16, true],
  "chrome://browser/skin/flame.svg": ["delete", 16, 16, true],
  "chrome://browser/skin/fxa/avatar-empty.svg": ["sync", 16, 16, true],
  "chrome://browser/skin/history.svg": ["history", 16, 16, true],
  "chrome://browser/skin/import.svg": ["import", 16, 16, true],
  "chrome://browser/skin/notification-icons/camera.svg": [
    "camera",
    16,
    16,
    true,
  ],
  "chrome://browser/skin/notification-icons/geo.svg": [
    "location",
    16,
    16,
    true,
  ],
  "chrome://browser/skin/preferences/category-privacy-security.svg": [
    "privacy",
    20,
    20,
    true,
  ],
  "chrome://browser/skin/preferences/category-search.svg": [
    "search",
    20,
    20,
    true,
  ],
  "chrome://browser/skin/quickactions.svg": ["quick-actions", 16, 16, true],
  "chrome://browser/skin/tabs.svg": ["tabs", 16, 16, true],
  "chrome://browser/skin/translations.svg": ["translate", 17, 16, true],
  "chrome://browser/skin/update-badge.svg": ["update", 16, 16, true],
  "chrome://browser/skin/window-firefox.svg": ["new-window", 16, 14, true],
  "chrome://devtools/skin/images/tool-profiler.svg": ["profiler", 16, 16, true],
  "chrome://global/skin/icons/arrow-counterclockwise-16.svg": [
    "restore",
    16,
    16,
    true,
  ],
  "chrome://global/skin/icons/arrow-down.svg": ["expand", 16, 16, true],
  "chrome://global/skin/icons/arrow-left.svg": ["previous", 16, 16, true],
  "chrome://global/skin/icons/arrow-right-12.svg": ["next", 12, 12, true],
  "chrome://global/skin/icons/arrow-right.svg": ["next", 16, 16, true],
  "chrome://global/skin/icons/check.svg": ["check", 16, 16, true],
  "chrome://global/skin/icons/chevron.svg": ["performance", 16, 16, true],
  "chrome://global/skin/icons/close.svg": ["close", 16, 16, true],
  "chrome://global/skin/icons/cursor-arrow.svg": ["browsing", 16, 16, true],
  "chrome://global/skin/icons/defaultFavicon.svg": ["page", 16, 16, true],
  "chrome://global/skin/icons/delete.svg": ["delete", 16, 16, true],
  "chrome://global/skin/icons/edit-outline.svg": ["edit", 16, 16, true],
  "chrome://global/skin/icons/eye.svg": ["eye", 16, 16, true],
  "chrome://global/skin/icons/help.svg": ["help", 16, 16, true],
  "chrome://global/skin/icons/link.svg": ["link", 16, 16, true],
  "chrome://global/skin/icons/more.svg": ["more", 16, 16, true],
  "chrome://global/skin/icons/move-16.svg": ["drag", 16, 16, true],
  "chrome://global/skin/icons/open-in-new.svg": ["open-external", 16, 16, true],
  "chrome://global/skin/icons/plus.svg": ["add", 16, 16, true],
  "chrome://global/skin/icons/search-glass.svg": ["search", 16, 16, true],
  "chrome://global/skin/icons/search-textbox.svg": ["search", 12, 12, true],
  "chrome://global/skin/icons/settings.svg": ["settings", 16, 16, true],
  "chrome://global/skin/icons/warning.svg": ["warning", 16, 16, true],
  "chrome://global/skin/illustrations/about-license.svg": [
    "license",
    300,
    300,
    true,
  ],
  "chrome://mozapps/skin/extensions/category-extensions.svg": [
    "extensions-settings",
    20,
    20,
    true,
  ],
  "chrome://mozapps/skin/extensions/category-plugins.svg": [
    "plugins",
    20,
    20,
    true,
  ],
  "chrome://mozapps/skin/extensions/extension.svg": [
    "extensions-settings",
    16,
    16,
    true,
  ],
  "chrome://mozapps/skin/extensions/extensionGeneric.svg": [
    "extensions-settings",
    16,
    16,
    true,
  ],
  "chrome://mozapps/skin/extensions/line.svg": ["verified", 16, 16, true],
});

/**
 * The URL of the icon named `name`.
 *
 * @param {string} name A key of `ICONS`.
 * @returns {string}
 */
export function iconURL(name) {
  const path = ICONS[name];
  if (!path) {
    throw new Error(`Sval has no icon named ${name}`);
  }
  return BASE + path;
}
