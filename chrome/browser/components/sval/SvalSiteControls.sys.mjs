/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The site controls at the address pill's end: what the
 * selected tab's site may do, as the Privacy and Security button
 * (`SvalProtectionButton`) is what Sval does to protect it.
 *
 * - The media button lets video and audio play, or stops them, for this
 *   visit, and saves nothing. It shows whether media plays on the page now,
 *   as the site's saved choice, the default and this visit decide, and
 *   lights up when the page tried to play and the site is on Ask first.
 * - The JavaScript button is `SvalHeader`'s, and saves a choice for the site.
 * - Two buttons start the element picker's modes (`SvalElementPicker`), as
 *   far as the person pinned them; the menu's Elements section starts them
 *   too, pins them, and lists the rules My filters holds for the site.
 * - The site menu button opens the site menu: the site's saved media choice, its
 *   JavaScript choice and every permission it holds, which take the place of
 *   Firefox's permission icons in the address field.
 * - A camera, microphone or screen in use shows as a cell of its own before
 *   the media button, so a person never has to open a menu to see it.
 * - A site's permission prompt opens from the site controls: while it is
 *   open, the same segment shows the permission asked for.
 * - Location has a button of its own beside the segment, shown while the
 *   site asks for it and while the tab uses it. Its prompt opens from there.
 *
 * Nothing here opens on its own: a page's blocked play is told by the media
 * button alone. A page's media attempt is the `GloballyAutoplayBlocked`
 * event the Autoplay actor sends, and a press that played a video is its
 * `SvalMediaPressPlayed`.
 */

import {
  BLOCKING_TOPIC,
  SvalBlocking,
} from "moz-src:///browser/components/sval/SvalBlocking.sys.mjs";
import {
  SvalElementPicker,
  MODE_TOPIC,
  SNIPS_TOPIC,
} from "moz-src:///browser/components/sval/SvalElementPicker.sys.mjs";
import {
  appendLines,
  exceptionLine,
  exceptionsInFilters,
  hideAgain,
  linesForScope,
  showAgain as showAgainIn,
} from "moz-src:///browser/components/sval/SvalElementRules.sys.mjs";
import {
  MEDIA_CHANGED_EVENT,
  SvalFirefox,
} from "moz-src:///browser/components/sval/SvalFirefox.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalScope } from "moz-src:///browser/components/sval/SvalScope.sys.mjs";
import {
  MODE_KEYS,
  MODE_NAMES,
  STYLE_KEY,
  STYLE_NAME,
  describeKey,
} from "moz-src:///browser/components/sval/SvalKeys.sys.mjs";
import { SvalJavascript } from "moz-src:///browser/components/sval/SvalJavascript.sys.mjs";
import {
  SvalKeepLinks,
  SITE_BRANCH as KEEP_LINKS_BRANCH,
} from "moz-src:///browser/components/sval/SvalKeepLinks.sys.mjs";
import {
  scopeChain,
  scopeForURI,
  siteForURI,
} from "moz-src:///browser/components/sval/SvalSite.sys.mjs";
import {
  ScopeDropdown,
  keepsLine,
  scopeChoices,
  scopePhrase,
} from "moz-src:///browser/components/sval/SvalScopeMenu.sys.mjs";
import {
  BUTTON_ID as PROTECTION_BUTTON_ID,
  SvalProtectionButton,
  glyph,
  protectionFooter,
  segments,
} from "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs";
import {
  LISTED_PERMISSIONS,
  MEDIA_PERMISSION,
  PERMISSION_ICONS,
  UNLISTED_PERMISSIONS,
  permissionWords,
} from "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs";
import {
  APPLIED_TOPIC,
  MEDIA_CHOICES,
  MEDIA_DEFAULT_PREF,
  SvalSiteProtections,
} from "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs";
import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";
import {
  STYLES_PREF,
  lookFor,
  styleFor,
} from "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs";
import {
  COLORSHIFT_BUTTON_ID,
  HAS_COLORSHIFT,
  STYLE_MENU_LABEL,
  SvalSiteStylePanel,
  describeStyle,
  styleScopeOf,
} from "moz-src:///browser/components/sval/SvalSiteStylePanel.sys.mjs";
import {
  cleanAddressOf,
  copyCleanAddress,
} from "moz-src:///browser/components/sval/SvalTabActions.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  SvalPanelToolbar:
    "moz-src:///browser/components/sval/SvalPanelToolbar.sys.mjs",
  SvalPrivateJars: "moz-src:///browser/components/sval/SvalPrivateJars.sys.mjs",
  SvalMenu: "moz-src:///browser/components/sval/SvalMenu.sys.mjs",
  SvalPopover: "moz-src:///browser/components/sval/SvalPopover.sys.mjs",
  SvalSiteData: "moz-src:///browser/components/sval/SvalSiteData.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
  ZoomUI: "resource:///modules/ZoomUI.sys.mjs",
});

export const LIVE_ID = "sval-live-devices";
export const LOCATION_BUTTON_ID = "sval-location-button";
export const MEDIA_BUTTON_ID = "sval-media-button";
export const SITE_MENU_BUTTON_ID = "sval-site-menu-button";
export const SITE_MENU_ID = "sval-site-menu";
export const ZOOM_SLIDER_ID = "sval-site-zoom";
const ZOOM_RESET_ID = "sval-site-zoom-reset";
export const REMOVE_BUTTON_ID = "sval-remove-button";
export const SNIP_BUTTON_ID = "sval-snip-button";
export const JAVASCRIPT_BUTTON_ID = "sval-javascript-button";
export const CLEAN_ADDRESS_BUTTON_ID = "sval-clean-address-button";
/** The clean address button's name, as its tooltip and the menu's row say it. */
export const CLEAN_ADDRESS_NAME = "Copy Clean Address";

/**
 * Which buttons sit in the site controls: a JSON array of "javascript",
 * "remove", "snip", "colorshift" and "clean-address". Syncs, and is global. Media, the live devices and the
 * site menu button always show (header signals spec §3).
 */
export const PINS_PREF = "browser.sval.siteControls.toolbarButtons";

/** The buttons a person can pin, in the cluster's order. */
const PINNABLE = [
  "javascript",
  "remove",
  "snip",
  "colorshift",
  "clean-address",
];

/**
 * @returns {string[]} the buttons pinned, in the cluster's order; the default
 *   when the pref holds anything else.
 */
function pinsOf() {
  try {
    const pins = JSON.parse(Services.prefs.getStringPref(PINS_PREF, "[]"));
    if (Array.isArray(pins)) {
      return PINNABLE.filter(id => pins.includes(id));
    }
  } catch {
    // Not JSON: a sync or a hand edit broke it.
  }
  return JSON.parse(
    Services.prefs.getDefaultBranch("").getStringPref(PINS_PREF)
  );
}

/** The element picker's two modes, as the buttons and the menu name them. */
const MODE_ROWS = [
  {
    mode: "remove",
    buttonId: REMOVE_BUTTON_ID,
    name: MODE_NAMES.remove,
    label: `${MODE_NAMES.remove}…`,
    sub: "Every time you visit",
    icon: "ep-eraser",
  },
  {
    mode: "snip",
    buttonId: SNIP_BUTTON_ID,
    name: MODE_NAMES.snip,
    label: `${MODE_NAMES.snip}…`,
    sub: "Until you reload",
    icon: "ep-scissors",
  },
];

/** A mode button's count, as its tooltip words it. */
const COUNT_WORDS = {
  remove: n => `${n} ${n == 1 ? "rule" : "rules"} removing elements here`,
  snip: n => `${n} snipped until you reload`,
};

/**
 * @param {string} text My filters.
 * @param {string[]} chain A host's scope chain (`scopeChain`).
 * @returns {Set<string>} The selectors a `#@#` line shows again on the
 *   host, one naming the host or a name above it.
 */
function shownOn(text, chain) {
  const byScope = exceptionsInFilters(text);
  return new Set(chain.flatMap(name => byScope.get(name) ?? []));
}

/**
 * The lines the site menu lists at `scope` for a page on `host`. At the
 * host they are its own and those of each name above it, which reach it
 * too, so the menu shows every rule that can hide something on the page.
 * `inherited` marks a line saved above the scope, and `excepted` a hiding
 * line a `#@#` line shows again on the host.
 *
 * @param {string} host
 * @param {string} scope
 * @returns {Array<{index: number, line: string, kind: string, shown: string,
 *   scope: string, inherited: boolean, excepted: boolean}>}
 */
function listedOn(host, scope) {
  const text = SvalBlocking.myFilters;
  const chain = scopeChain(host);
  const names = scope === host ? chain : [scope];
  const shown = shownOn(text, chain);
  return names.flatMap(name =>
    linesForScope(text, name).map(entry => ({
      ...entry,
      inherited: entry.scope !== scope.toLowerCase(),
      excepted: entry.kind == "hide" && shown.has(entry.shown),
    }))
  );
}

/**
 * How many of My filters' hiding rules hide something on the tab's page
 * now: those reaching its host, not shown again there, that match an
 * element of the page.
 *
 * @param {Element} browser
 * @returns {Promise<number>}
 */
async function removingOn(browser) {
  const host = scopeForURI(browser.currentURI)?.host;
  if (!host) {
    return 0;
  }
  const selectors = [
    ...new Set(
      listedOn(host, host)
        .filter(e => e.kind == "hide" && !e.excepted)
        .map(e => e.shown)
    ),
  ];
  if (!selectors.length) {
    return 0;
  }
  const counts = await SvalElementPicker.countOn(browser, selectors);
  return counts.filter(n => n > 0).length;
}

/**
 * Shows a count on a header button (header signals spec §1), or none.
 *
 * @param {Element} button
 * @param {number} count
 */
function setCount(button, count) {
  if (count) {
    button.setAttribute("sval-count", count > 99 ? "99+" : String(count));
  } else {
    button.removeAttribute("sval-count");
  }
  button.toggleAttribute("sval-count-wide", count > 9);
}

/** Why a mode is off, by `SvalElementPicker.offers`' answer. */
const OFF_IN_TOOLTIP = {
  private: "off in private windows",
  "no-site": "only on websites",
};
const OFF_IN_MENU = {
  private: "Off in private windows, because it saves a rule.",
};

/**
 * @param {number} [n] How many elements a hiding rule matches on the page.
 * @returns {string} The rule's line in the site menu, empty until counted.
 */
function matchesWords(n) {
  if (n == null) {
    return "";
  }
  if (!n) {
    return "Not currently removing anything on this page";
  }
  return `Removes ${n} ${n == 1 ? "element" : "elements"} on this page`;
}

/** The most rules the site menu lists before it sends the person to Settings. */
const MAX_HIDDEN_ROWS = 6;

/**
 * @param {Element} browser
 * @param {"remove"|"snip"} mode
 * @returns {string} "ok" where the mode is offered, else why not
 *   (`SvalElementPicker.offers`).
 */
function offerOf(browser, mode) {
  return SvalElementPicker.offers(browser)[mode];
}

/**
 * The anchors Firefox's permission prompts name (`PermissionUI`'s
 * `anchorID`), by the permission each asks for. A prompt for one of these
 * opens from the site controls; any other keeps Firefox's anchor.
 */
const PROMPT_ANCHORS = {
  "geo-notification-icon": "geo",
  "web-notifications-notification-icon": "desktop-notification",
  "webRTC-shareDevices-notification-icon": "camera",
  "webRTC-shareMicrophone-notification-icon": "microphone",
  "webRTC-shareScreen-notification-icon": "screen",
  "persistent-storage-notification-icon": "persistent-storage",
  "storage-access-notification-icon": "storage-access",
};

/**
 * browser -> what the loaded page last tried to play and was blocked from:
 * "video", "audio" or "media", as the Autoplay actor reports it.
 */
const tried = new WeakMap();

/**
 * browser -> the site whose visit the media prompt has asked on, so a visit
 * is asked once, however the person answers or closes the prompt.
 */
const askedVisits = new WeakMap();

/** The media prompt's `PopupNotifications` id and anchor id. */
const MEDIA_NOTIFICATION = "sval-media";
const MEDIA_ANCHOR = "sval-media-anchor";

/**
 * browser -> this visit's media: `{site, value, principals}`, `value`
 * "allow" or "block" and `principals` the origins it was written for. What
 * the tab holds now is Gecko's grant (`grantOf`), which its expiry or a
 * reload's `clearTemporaryBlockPermissions` can take away.
 */
const visits = new WeakMap();

/**
 * browser -> the devices the loaded page asked for and was refused because
 * they are blocked for its site: a Set of "camera", "microphone" and
 * "screen", from `WebRTCParent`'s `sval-webrtc-blocked` notification.
 */
const devicesTried = new WeakMap();

/**
 * @param {Element} browser
 * @returns {string} The tab's permissions as `SitePermissions` holds them,
 *   for comparing before and after a change.
 */
function permissionStates(browser) {
  return JSON.stringify(
    lazy.SitePermissions.getAllForBrowser(browser)
      .map(({ id, state, scope }) => [id, state, scope])
      .sort()
  );
}

/** The topic `WebRTCParent`'s `prompt` notifies on a request it denies. */
const WEBRTC_BLOCKED_TOPIC = "sval-webrtc-blocked";

/**
 * The topic `PermissionPrompt` notifies on a request a block or a Block
 * answer refused, with the permission's key.
 */
const PERMISSION_REFUSED_TOPIC = "sval-permission-refused";

/** The browsers whose loaded page asked for location and was refused. */
const locationRefused = new WeakSet();

/** The crossed glyph of each device, for an attempt its block refused. */
const DEVICE_OFF_ICONS = {
  camera: "sc-camera-off",
  microphone: "sc-mic-off",
  screen: "sc-screen-off",
};

/**
 * The header's glyph (`header-icons/`, drawn by `sval-header.css`) for each
 * kind the live segment and the location button show, and the crossed one
 * for a kind a block refused or a device muted. The header's controls draw
 * from that set alone; the site menu draws `PERMISSION_ICONS`.
 */
const HEADER_GLYPHS = {
  camera: "camera",
  microphone: "mic",
  screen: "screen",
  geo: "location",
  "desktop-notification": "bell",
  "persistent-storage": "storage",
  "storage-access": "storage",
};
const HEADER_OFF_GLYPHS = {
  camera: "camera-off",
  microphone: "mic-off",
  screen: "screen-off",
  geo: "location-off",
};

/**
 * @param {Document} doc
 * @param {string} name A key of the header's glyphs in `sval-header.css`.
 * @returns {Element}
 */
function headerGlyph(doc, name) {
  const image = doc.createXULElement("image");
  image.className = "sval-header-glyph";
  image.dataset.icon = name;
  image.setAttribute("aria-hidden", "true");
  return image;
}

/** The live cell's name for each kind it shows. */
export const KIND_NAMES = {
  camera: "Camera",
  microphone: "Microphone",
  screen: "Screen",
  geo: "Location",
  "desktop-notification": "Notifications",
  "persistent-storage": "Storage",
  "storage-access": "Cookies",
};

/**
 * What a tab is capturing, from the sharing state `webrtcUI` keeps on its
 * browser.
 *
 * @param {Element} browser
 * @returns {string[]} "camera", "microphone" and "screen", as are live.
 */
function liveOf(browser) {
  const webRTC = browser._sharingState?.webRTC;
  if (!webRTC?.sharing) {
    return [];
  }
  return ["camera", "microphone", "screen"].filter(kind => !!webRTC[kind]);
}

/**
 * Whether a tab's camera or microphone is muted: still captured, and sending
 * black frames or silence (`DeviceListener::SetDeviceMuted`).
 *
 * @param {Element} browser
 * @param {string} kind
 */
function mutedOf(browser, kind) {
  return (
    browser._sharingState?.webRTC?.[kind] ===
    Ci.nsIMediaManagerService.STATE_CAPTURE_DISABLED
  );
}

/** The location button's name in each of its states. */
const LOCATION_NAMES = {
  asking: "Location: this site is asking. The prompt is open.",
  waiting: "Location: this site is asking. Click to answer.",
  live: "Location: in use. Click to block it on this site and reload the page.",
  blocked:
    "Location: blocked. This page tried to use it. Click to allow it on this site and reload the page.",
};

/** A shared screen's live cell, which opens the site menu. */
const SCREEN_CELL_NAME = "Sharing your screen. Click to stop or change.";

/** The live cell's name for each device it mutes, by whether it is muted. */
const CELL_NAMES = {
  camera: ["Camera: in use. Click to mute.", "Camera: muted. Click to unmute."],
  microphone: [
    "Microphone: in use. Click to mute.",
    "Microphone: muted. Click to unmute.",
  ],
};

/**
 * Whether media plays on a tab's page now, and why.
 *
 * @param {Window} win
 * @param {Element} [browser] The selected tab's, by default.
 * @returns {object|null} Null where the page has no site.
 */
export function mediaOf(win, browser = win.gBrowser.selectedBrowser) {
  const scope = scopeForURI(browser.currentURI);
  if (!scope) {
    return null;
  }
  const { site, host } = scope;
  const isPrivate = lazy.PrivateBrowsingUtils.isBrowserPrivate(browser);
  const session = lazy.SvalPrivateJars.sessionOfBrowser(browser);
  const choice = SvalSiteProtections.mediaFor(host, session);
  const visit = grantOf(browser);
  // A page capturing a device plays whatever the site's choice
  // (`IsWindowAllowedToPlayByTraits` in AutoplayPolicy.cpp), so the button
  // shows it playing and its command has nothing to change.
  const live = liveOf(browser);
  // Sound the page makes shows it playing whatever the choice says: the gate
  // lets a top-level video document play, and a changed choice leaves what
  // already plays playing. A visit's stop pauses the page itself, and the tab
  // keeps its sound indicator a few seconds after the sound ends
  // (`browser.tabs.delayHidingAudioPlayingIconMS`).
  const sounding =
    !visit && !!win.gBrowser.getTabForBrowser(browser)?.soundPlaying;
  const plays = visit ? visit === "allow" : choice === "allow" || sounding;
  let look = plays ? "allowed" : "blocked";
  if (live.length) {
    look = "allowed";
  } else if (visit === "allow") {
    look = "visit";
  } else if (!plays && tried.has(browser)) {
    look = choice === "ask" && !visit ? "asked" : "refused";
  }
  let capture = null;
  if (live.length) {
    capture = live.includes("screen") && live.length == 1 ? "screen" : "device";
  }
  return {
    browser,
    site,
    host,
    scope,
    isPrivate,
    session,
    choice,
    visit,
    look,
    capture,
    tried: tried.get(browser) ?? null,
  };
}

/**
 * What the page tried to play, in words: "a video", "audio" or "media".
 *
 * @param {object} media From `mediaOf`.
 * @returns {string}
 */
function triedWords(media) {
  return { video: "a video", audio: "audio" }[media.tried] ?? "media";
}

/**
 * The media button's tooltip and accessible name, which tell apart the
 * states its look shares (header signals spec §2).
 *
 * @param {object} media From `mediaOf`.
 * @returns {string}
 */
export function mediaNameOf(media) {
  const what = triedWords(media);
  const saved = SvalSiteProtections.resolvedFor(
    media.host,
    "media",
    media.session
  );
  if (media.capture === "screen") {
    return "Video and audio: playing. You can't stop video and audio while this page shares your screen.";
  }
  if (media.capture) {
    return "Video and audio: playing. You can't stop video and audio while this page uses your camera or microphone.";
  }
  switch (media.look) {
    case "visit":
      return "Video and audio: allowed for this visit. Click to stop.";
    case "allowed":
      return saved === "allow"
        ? "Video and audio: always allowed on this site. Click to stop."
        : "Video and audio: allowed. Click to stop.";
    case "asked":
      return `Video and audio: this page tried to play ${what}. Click to allow for this visit.`;
  }
  if (media.visit === "block") {
    return "Video and audio: stopped for this visit. Click to allow for this visit.";
  }
  return saved === "block"
    ? "Video and audio: never allowed on this site. Click to allow for this visit."
    : "Video and audio: blocked. Click to allow for this visit.";
}

/**
 * Writes this visit's media for the tab's page, scoped to the tab, which
 * Gecko's gate reads ahead of the site's own permission.
 *
 * @param {Element} browser
 * @param {nsIPrincipal} principal
 * @param {"allow"|"block"} value
 */
function grantVisit(browser, principal, value) {
  Services.perms.addFromPrincipalForBrowser(
    principal,
    MEDIA_PERMISSION,
    value === "allow"
      ? Ci.nsIPermissionManager.ALLOW_ACTION
      : Ci.nsIPermissionManager.DENY_ACTION,
    browser.browserId,
    lazy.SitePermissions.temporaryPermissionExpireTime
  );
}

/**
 * The media grant scoped to the tab for its page, which Gecko's gate reads
 * ahead of the site's own permission (`GetSiteAutoplayPermission` in
 * AutoplayPolicy.cpp).
 *
 * @param {Element} browser
 * @param {nsIPrincipal} [principal] The page's, by default.
 * @returns {"allow"|"block"|null}
 */
function grantOf(browser, principal = browser.contentPrincipal) {
  if (!principal?.isContentPrincipal) {
    return null;
  }
  switch (
    Services.perms.testForBrowser(
      principal,
      MEDIA_PERMISSION,
      browser.browserId
    )
  ) {
    case Ci.nsIPermissionManager.ALLOW_ACTION:
      return "allow";
    case Ci.nsIPermissionManager.DENY_ACTION:
      return "block";
  }
  return null;
}

/**
 * Starts the tab's visit with media allowed or stopped for its page, in place
 * of any visit it had.
 *
 * @param {Element} browser
 * @param {string} site
 * @param {"allow"|"block"} value
 */
function startVisit(browser, site, value) {
  endVisit(browser);
  const principal = browser.contentPrincipal;
  visits.set(browser, { site, value, principals: [principal] });
  grantVisit(browser, principal, value);
}

/**
 * Ends the tab's visit: what it wrote for media is taken away.
 *
 * @param {Element} browser
 */
function endVisit(browser) {
  const visit = visits.get(browser);
  if (!visit) {
    return;
  }
  visits.delete(browser);
  for (const principal of visit.principals) {
    Services.perms.removeFromPrincipalForBrowser(
      principal,
      MEDIA_PERMISSION,
      browser.browserId
    );
  }
}

/**
 * One window's site controls.
 */
class SiteControls {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    this.panel = null;
    /** The menu, as `SvalPopover.create` gave it. */
    this.popover = null;
    /** The permission an open prompt asks for, or null. */
    this.pending = null;
    /**
     * browser -> `{site, session, before}` for each tab whose media choice
     * the open menu changed, `before` its choice as the menu opened.
     */
    this.mediaChanged = new Map();
    /**
     * browser -> its permissions as the open menu first changed one, from
     * `permissionStates`.
     */
    this.permissionsChanged = new Map();
    /** Whether the menu's list of removal rules is open. */
    this.hiddenOpen = false;
    /** Whether "Clear cookies and site data" is asking to confirm. */
    this.confirmingClear = false;
    /**
     * The scope the open menu's choices are saved at, picked in its title,
     * or null for the page's host, where the menu opens.
     */
    this.picked = null;
    /** The mode a menu row chose, started once the menu has closed. */
    this.pendingMode = null;
    /** Whether the Style row was chosen, opened once the menu has closed. */
    this.pendingStyle = false;
    /**
     * Whether the clean address row was chosen, copied once the menu has
     * closed, so the hint that confirms it shows on the address bar.
     */
    this.pendingCopy = false;
    /** Counts the lists asked for, so only the last answer is drawn. */
    this.countRun = 0;
    /** selector -> how many elements it last matched on the page. */
    this.counted = new Map();
    /**
     * A page's window global -> how many rules hide something on it, from
     * `removingOn`, keyed by the page so a new one starts at none.
     */
    this.removing = new WeakMap();
    /** Counts the header's recounts, so only the last answer is drawn. */
    this.removingRun = 0;
    /**
     * `{browser, button}` while a mode a keyboard press on a button started
     * runs: the button takes the focus back when the person leaves.
     */
    this.restore = null;
  }

  /**
   * Once the menu has hidden: its state goes back to the main view, and
   * what was asked to run once it closed runs.
   */
  #afterHiding() {
    this.hiddenOpen = false;
    this.confirmingClear = false;
    this.picked = null;
    this.counted.clear();
    this.reloadChanged();
    const mode = this.pendingMode;
    this.pendingMode = null;
    if (mode) {
      this.begin(mode, null);
    }
    if (this.pendingStyle) {
      this.pendingStyle = false;
      SvalSiteStylePanel.open(this.win, { focus: true });
    }
    if (this.pendingCopy) {
      this.pendingCopy = false;
      copyCleanAddress(this.win);
    }
  }

  mount() {
    const { doc, win } = this;
    this.popover = lazy.SvalPopover.create(doc, {
      name: SITE_MENU_ID,
      label: "Site settings",
      // An arrow panel's default flip narrows a popover that reaches past
      // the screen (`nsMenuPopupFrame::FlipOrResize`), cutting off its side;
      // a slide moves it whole (`nsMenuPopupFrame::SlideOrResize`).
      attributes: { flip: "slide", orient: "vertical" },
      // Grows from its button, reaching past it as the header's popovers do.
      stem: { hang: true },
      onHidden: () => this.#afterHiding(),
    });
    const panel = this.popover.popup;
    // Esc in the clear-data confirm puts its row back; a further Esc closes
    // the menu. The popup manager closes an open panel on Esc from its
    // listener on the document (`nsXULPopupManager::KeyDown`), so this
    // listens on the window, which sees the key first.
    win.addEventListener(
      "keydown",
      event => {
        if (
          event.key !== "Escape" ||
          !this.confirmingClear ||
          panel.state !== "open" ||
          !panel.contains(doc.activeElement)
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.cancelClear();
      },
      { capture: true }
    );
    this.panel = panel;

    const progress = {
      onStateChange: (browser, webProgress, request, flags) =>
        this.onStateChange(browser, webProgress, request, flags),
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (
          !webProgress?.isTopLevel ||
          flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
        ) {
          return;
        }
        tried.delete(browser);
        devicesTried.delete(browser);
        locationRefused.delete(browser);
        if (askedVisits.get(browser) !== scopeForURI(location)?.site) {
          askedVisits.delete(browser);
        }
        if (browser === win.gBrowser.selectedBrowser) {
          this.update();
        }
      },
    };
    win.gBrowser.addTabsProgressListener(progress);
    this.watchPrompts();
    // Nothing announces a change to a tab's location sharing
    // (`updateBrowserSharing`) but `gPermissionPanel.updateSharingIndicator`
    // marking Firefox's own indicator for the selected tab, which Sval hides.
    const geoSharing = new win.MutationObserver(() => this.drawLocation());
    const geoIcon = doc.getElementById("geo-sharing-icon");
    if (geoIcon) {
      geoSharing.observe(geoIcon, { attributeFilter: ["sharing"] });
    }
    const update = () => this.update();
    const onBlocked = event => {
      const browser = event.target;
      if (!win.gBrowser.browsers.includes(browser)) {
        return;
      }
      tried.set(browser, event.detail?.kind ?? "media");
      if (browser === win.gBrowser.selectedBrowser) {
        this.update();
      }
      this.askMedia(browser);
    };
    const onTabAttr = event => {
      if (!event.target.selected) {
        return;
      }
      const { changed } = event.detail;
      // The media button's look follows the tab's sound (`mediaOf`), and
      // `update` redraws the playing fill with it.
      if (changed.includes("sharing") || changed.includes("soundplaying")) {
        this.update();
      } else if (changed.includes("muted")) {
        this.drawPlaying();
      }
    };
    const onMediaChanged = event => {
      if (event.target.selected) {
        this.drawPlaying();
      }
    };
    const onDeviceBlocked = (browser, topic, data) => {
      if (!win.gBrowser.browsers.includes(browser)) {
        return;
      }
      const kinds = devicesTried.get(browser) ?? new Set();
      for (const id of data.split(",")) {
        if (id in DEVICE_OFF_ICONS) {
          kinds.add(id);
        }
      }
      devicesTried.set(browser, kinds);
      if (browser === win.gBrowser.selectedBrowser) {
        this.drawLive();
      }
    };
    const onRefused = (browser, topic, key) => {
      if (key !== "geo" || !win.gBrowser.browsers.includes(browser)) {
        return;
      }
      locationRefused.add(browser);
      if (browser === win.gBrowser.selectedBrowser) {
        this.drawLocation();
      }
    };
    const onPermission = (subject, topic, data) => {
      if (data !== "cleared") {
        this.update();
      }
    };
    // The mode buttons name their keys, which settings can change while
    // the window is open.
    for (const buttonId of [
      ...MODE_ROWS.map(row => row.buttonId),
      COLORSHIFT_BUTTON_ID,
    ]) {
      for (const type of ["mouseover", "focus"]) {
        doc
          .getElementById(buttonId)
          ?.addEventListener(type, () => this.drawPins(false));
      }
    }
    win.gBrowser.tabContainer.addEventListener("TabSelect", update);
    // Gecko fires these at the window on any zoom change, keys included
    // (`ZoomUI.init` listens for the same).
    const onZoom = () => this.drawZoom();
    win.addEventListener("FullZoomChange", onZoom);
    win.addEventListener("TextZoomChange", onZoom);
    win.gBrowser.tabContainer.addEventListener("TabAttrModified", onTabAttr);
    win.gBrowser.tabContainer.addEventListener(
      MEDIA_CHANGED_EVENT,
      onMediaChanged
    );
    win.gBrowser.tabpanels.addEventListener(
      "GloballyAutoplayBlocked",
      onBlocked
    );
    // The gate let a press on a video play it, which only Ask first does, so
    // the press answers the prompt's "Allow for this visit".
    // The video already plays, so nothing reloads.
    const onPressPlayed = event => {
      const browser = event.target;
      if (!win.gBrowser.browsers.includes(browser)) {
        return;
      }
      const media = mediaOf(win, browser);
      if (!media) {
        return;
      }
      startVisit(browser, media.site, "allow");
      win.PopupNotifications.getNotification(
        MEDIA_NOTIFICATION,
        browser
      )?.remove();
    };
    win.gBrowser.tabpanels.addEventListener(
      "SvalMediaPressPlayed",
      onPressPlayed
    );
    const onMode = (browser, topic, mode) => this.onMode(browser, mode);
    const onSnips = browser => {
      if (browser === win.gBrowser.selectedBrowser) {
        this.drawPins();
      }
    };
    const lifetime = SvalScope.forWindow(win);
    lifetime.add(() => win.gBrowser.removeTabsProgressListener(progress));
    lifetime.add(() => geoSharing.disconnect());
    lifetime.topic(APPLIED_TOPIC, update);
    lifetime.topic("perm-changed", onPermission);
    lifetime.topic("browser-perm-changed", update);
    lifetime.topic(WEBRTC_BLOCKED_TOPIC, onDeviceBlocked);
    lifetime.topic(PERMISSION_REFUSED_TOPIC, onRefused);
    lifetime.topic(BLOCKING_TOPIC, update);
    lifetime.topic(MODE_TOPIC, onMode);
    lifetime.topic(SNIPS_TOPIC, onSnips);
    lifetime.pref(MEDIA_DEFAULT_PREF, update);
    lifetime.pref(PINS_PREF, update);
    lifetime.pref(STYLES_PREF, update);
    lifetime.pref(KEEP_LINKS_BRANCH, update);
    this.update();
  }

  menuButton() {
    return this.doc.getElementById(SITE_MENU_BUTTON_ID);
  }

  /**
   * The element a permission prompt anchors to: the site controls' cell for
   * the permission asked for, shown for as long as the prompt is open, when
   * the selected tab's site has one. Firefox asks the window for a visible
   * anchor as it shows a prompt (`PopupNotifications`'
   * `getVisibleAnchorElement`, which `browser.js` gives it and which asks
   * here), and its anchor icons live in the address field.
   *
   * @param {Element|null} anchor The anchor Firefox asked about.
   * @param {Element|null} fallback Firefox's answer.
   * @returns {Element|null}
   */
  promptAnchor(anchor, fallback) {
    const kind = PROMPT_ANCHORS[anchor?.id];
    if (kind === "geo") {
      this.drawLocation();
      const button = this.doc.getElementById(LOCATION_BUTTON_ID);
      return button?.checkVisibility() ? button : fallback;
    }
    if (!kind || !mediaOf(this.win)) {
      return fallback;
    }
    this.pending = kind;
    this.drawLive();
    const cell = this.doc.querySelector(
      `#${LIVE_ID} .sval-live-ask[data-state="asking"]`
    );
    return cell?.checkVisibility() ? cell : fallback;
  }

  /** Lets go of a prompt's cell once the prompt closes. */
  watchPrompts() {
    const popup = this.doc.getElementById("notification-popup");
    popup?.addEventListener("popupshowing", () => this.drawLocation());
    popup?.addEventListener("popuphidden", () => {
      this.pending = null;
      // `PopupNotifications` marks a prompt closed unanswered as dismissed
      // in its own popuphidden listener, which can run after this one.
      Services.tm.dispatchToMainThread(() => {
        this.drawLive();
        this.drawLocation();
      });
    });
  }

  /**
   * A top-level page started to load. A visit lasts while the tab stays on
   * its site, so leaving the site ends it; a new page on the same site, at
   * an origin the visit has not covered, is covered too, because Gecko
   * matches the permission to the exact origin.
   *
   * @param {Element} browser
   * @param {nsIWebProgress} webProgress
   * @param {nsIRequest} request
   * @param {number} flags
   */
  onStateChange(browser, webProgress, request, flags) {
    const { STATE_START, STATE_STOP, STATE_IS_DOCUMENT, STATE_IS_WINDOW } =
      Ci.nsIWebProgressListener;
    // The picker's availability reads the loaded document, which a location
    // change precedes, and its protections exception, which a load settles.
    if (
      webProgress?.isTopLevel &&
      flags & STATE_STOP &&
      flags & STATE_IS_WINDOW &&
      browser === this.win.gBrowser.selectedBrowser
    ) {
      this.drawPins();
    }
    if (
      !webProgress?.isTopLevel ||
      !(flags & STATE_START) ||
      !(flags & STATE_IS_DOCUMENT)
    ) {
      return;
    }
    const visit = visits.get(browser);
    if (!visit) {
      return;
    }
    let uri;
    try {
      uri = request.QueryInterface(Ci.nsIChannel).URI;
    } catch {
      return;
    }
    // A grant that expired ended the visit with it.
    if (
      siteForURI(uri) !== visit.site ||
      !visit.principals.some(p => grantOf(browser, p))
    ) {
      endVisit(browser);
      return;
    }
    const principal = Services.scriptSecurityManager.createContentPrincipal(
      uri,
      browser.contentPrincipal.originAttributes
    );
    if (!visit.principals.some(p => p.equals(principal))) {
      visit.principals.push(principal);
      grantVisit(browser, principal, visit.value);
    }
  }

  /**
   * Asks whether the page may play, from the media button, once a visit:
   * on a site set to Ask first, a play the gate blocked waits for this answer.
   * A tab not showing asks once it is selected
   * (`PopupNotifications`).
   *
   * @param {Element} browser
   */
  askMedia(browser) {
    const { win } = this;
    const media = mediaOf(win, browser);
    if (media?.look !== "asked" || askedVisits.get(browser) === media.site) {
      return;
    }
    // A prompt the page has open, as a call page's camera prompt, keeps its
    // place; the media button stays lit, and the page's next play asks.
    const open = win.PopupNotifications.getNotificationsForBrowser(browser);
    if (open.some(n => n.id !== MEDIA_NOTIFICATION && !n.dismissed)) {
      return;
    }
    askedVisits.set(browser, media.site);
    const what = triedWords(media);
    const reload = () => browser.reload();
    browser[`${MEDIA_ANCHOR}popupnotificationanchor`] =
      this.doc.getElementById(MEDIA_BUTTON_ID);
    win.PopupNotifications.show(
      browser,
      MEDIA_NOTIFICATION,
      `${media.host} wants to play ${what}.`,
      MEDIA_ANCHOR,
      {
        label: "Allow for this visit",
        accessKey: "A",
        callback: () => {
          startVisit(browser, media.site, "allow");
          reload();
        },
      },
      [
        {
          label: "Don't allow for this visit",
          accessKey: "D",
          callback: () => startVisit(browser, media.site, "block"),
        },
        {
          label: "Always allow",
          accessKey: "L",
          callback: () => {
            SvalSiteProtections.setMedia(media.host, "allow", media.session);
            if (browser.contentPrincipal?.isContentPrincipal) {
              SvalSiteProtections.coverOrigin(browser.contentPrincipal);
            }
            endVisit(browser);
            reload();
          },
        },
      ],
      // Three equal answers, each a button of its own (`SvalPromptButtons`).
      { removeOnDismissal: true, actionButtons: true }
    );
  }

  /**
   * The media button's command: media that plays stops for the rest of the
   * visit, at once, and media that is blocked plays for the visit after a
   * reload, since a page asks to play as it loads.
   */
  toggleMedia() {
    const media = mediaOf(this.win);
    if (!media || media.capture) {
      return;
    }
    const { browser } = media;
    const plays = media.look === "allowed" || media.look === "visit";
    startVisit(browser, media.site, plays ? "block" : "allow");
    if (plays) {
      // The gate stops what starts from here; what already plays is paused
      // through the tab's media controller, as its media keys would.
      browser.browsingContext?.mediaController?.pause();
      this.update();
      return;
    }
    browser.reload();
  }

  /** Draws the media button, the live cells and an open site menu. */
  update() {
    const { doc, win } = this;
    const media = mediaOf(win);
    const button = doc.getElementById(MEDIA_BUTTON_ID);
    if (button) {
      button.toggleAttribute("disabled", !media);
      button.setAttribute("sval-media", media?.look ?? "none");
      if (media?.capture) {
        button.setAttribute("aria-disabled", "true");
      } else {
        button.removeAttribute("aria-disabled");
      }
      const name = media ? mediaNameOf(media) : "Video and audio";
      button.setAttribute("tooltiptext", name);
      button.setAttribute("aria-label", name);
    }
    this.drawLive();
    this.drawLocation();
    this.drawPlaying();
    this.drawPins();
    this.drawZoom();
    const menu = this.menuButton();
    menu?.toggleAttribute("disabled", !media);
    this.drawStyled(menu);
    if (this.panel?.state === "open") {
      if (media) {
        this.render(media);
      } else {
        this.panel.hidePopup();
      }
    }
  }

  /**
   * Marks the Site settings button `sval-styled` while the selected tab's
   * page shows a site style (site styles spec §3), so the person can tell
   * why the page looks as it does, and says so in its name.
   *
   * @param {?Element} menu The Site settings button.
   */
  drawStyled(menu) {
    if (!menu) {
      return;
    }
    const styled =
      !pinsOf().includes("colorshift") &&
      !!lookFor(this.win.gBrowser.selectedBrowser.currentURI);
    menu.toggleAttribute("sval-styled", styled);
    const name = styled ? `Site settings. ${HAS_COLORSHIFT}` : "Site settings";
    menu.setAttribute("tooltiptext", name);
    menu.setAttribute("aria-label", name);
  }

  /**
   * Marks the media button `sval-playing` while the selected tab's media
   * plays, which takes the live fill (header signals spec §1): what the tab
   * row's media button offers to pause or mute (`SvalFirefox.mediaActionOf`).
   * A page capturing a device leaves the button unusable, and the live cells
   * carry the fill for it.
   */
  drawPlaying() {
    const button = this.doc.getElementById(MEDIA_BUTTON_ID);
    const action = SvalFirefox.mediaActionOf([this.win.gBrowser.selectedTab]);
    button?.toggleAttribute(
      "sval-playing",
      (action === "pause" || action === "mute") && !mediaOf(this.win)?.capture
    );
  }

  /**
   * Draws the pinnable buttons: each shown while pinned, and the two mode
   * buttons lit while the selected tab is in the mode, and dimmed, with the
   * reason in the tooltip, where the mode is not offered. The address pill
   * makes room for each shown one (`sval-header.css`, 28px each).
   *
   * @param {boolean} [recount] Whether to ask the page again how many rules
   *   hide something on it (`recountRemoving`).
   */
  drawPins(recount = true) {
    const { doc, win } = this;
    const browser = win.gBrowser.selectedBrowser;
    const pins = pinsOf();
    const active = SvalElementPicker.active(browser);
    const offers = SvalElementPicker.offers(browser);
    const page = browser.browsingContext?.currentWindowGlobal;
    const counts = {
      remove: (page && this.removing.get(page)) ?? 0,
      snip: SvalElementPicker.snippedOn(browser),
    };
    if (recount) {
      this.recountRemoving(browser, page);
    }
    const javascript = doc.getElementById(JAVASCRIPT_BUTTON_ID);
    if (javascript) {
      javascript.hidden = !pins.includes("javascript");
    }
    this.drawColorshift(pins);
    const clean = doc.getElementById(CLEAN_ADDRESS_BUTTON_ID);
    if (clean) {
      clean.hidden = !pins.includes("clean-address");
    }
    for (const { mode, buttonId, name } of MODE_ROWS) {
      const button = doc.getElementById(buttonId);
      if (!button) {
        continue;
      }
      const pinned = pins.includes(mode);
      button.hidden = !pinned;
      const offer = offers[mode];
      const count = counts[mode];
      let label = count ? `${name} (${COUNT_WORDS[mode](count)})` : name;
      if (active == mode) {
        label = `${name}: on. Click to leave.`;
      }
      const tip = offer == "ok" ? label : `${name} (${OFF_IN_TOOLTIP[offer]})`;
      button.dataset.offer = offer;
      button.setAttribute("aria-label", tip);
      if (offer == "ok") {
        button.removeAttribute("aria-disabled");
        describeKey(button, MODE_KEYS[mode], label);
      } else {
        button.setAttribute("aria-disabled", "true");
        button.setAttribute("tooltiptext", tip);
        button.removeAttribute("aria-keyshortcuts");
      }
      button.setAttribute("aria-pressed", String(active == mode));
      setCount(button, pinned ? count : 0);
    }
    const menu = this.menuButton();
    if (menu) {
      setCount(
        menu,
        MODE_ROWS.reduce(
          (sum, { mode }) => sum + (pins.includes(mode) ? 0 : counts[mode]),
          0
        )
      );
    }
  }

  /**
   * Draws the Colorshift button while pinned: dimmed, with the reason in
   * its tooltip, where the page can have no Colorshift, and marked
   * `sval-styled` while the page has one, which then leaves the Site
   * settings button unmarked (`drawStyled`).
   *
   * @param {string[]} pins From `pinsOf`.
   */
  drawColorshift(pins) {
    const button = this.doc.getElementById(COLORSHIFT_BUTTON_ID);
    if (!button) {
      return;
    }
    const browser = this.win.gBrowser.selectedBrowser;
    button.hidden = !pins.includes("colorshift");
    button.toggleAttribute("sval-styled", !!lookFor(browser.currentURI));
    let offer = "ok";
    if (!styleScopeOf(browser)) {
      offer = lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)
        ? "private"
        : "no-site";
    }
    button.dataset.offer = offer;
    if (offer == "ok") {
      button.removeAttribute("aria-disabled");
      describeKey(button, STYLE_KEY, STYLE_NAME);
    } else {
      const tip = `${STYLE_NAME} (${OFF_IN_TOOLTIP[offer]})`;
      button.setAttribute("aria-disabled", "true");
      button.setAttribute("tooltiptext", tip);
      button.setAttribute("aria-label", tip);
      button.removeAttribute("aria-keyshortcuts");
    }
    button.setAttribute(
      "aria-pressed",
      String(SvalSiteStylePanel.isOpen(this.win))
    );
  }

  /**
   * Asks the page how many rules hide something on it and redraws the
   * buttons where the answer changed, unless a later recount or another tab
   * took over.
   *
   * @param {Element} browser
   * @param {?WindowGlobalParent} page The page the answer is for.
   */
  async recountRemoving(browser, page) {
    if (!page) {
      return;
    }
    const run = ++this.removingRun;
    const n = await removingOn(browser);
    if (
      run != this.removingRun ||
      browser.browsingContext?.currentWindowGlobal !== page ||
      (this.removing.get(page) ?? 0) === n
    ) {
      return;
    }
    this.removing.set(page, n);
    if (browser === this.win.gBrowser.selectedBrowser) {
      this.drawPins(false);
    }
  }

  /**
   * A tab's mode changed. The buttons follow it; when a mode a keyboard
   * press started ends because the person left it, the button that started
   * it takes the focus back. A save or a removal leaves the toast holding it.
   *
   * @param {Element} browser
   * @param {string} mode "" when the mode ended.
   */
  onMode(browser, mode) {
    this.drawPins();
    if (mode || this.restore?.browser !== browser) {
      return;
    }
    const { button } = this.restore;
    this.restore = null;
    if (SvalElementPicker.endedBy(browser) == "left" && button.isConnected) {
      button.focus();
    }
  }

  /**
   * Starts a mode on the selected tab where it is offered.
   *
   * @param {"remove"|"snip"} mode
   * @param {?Element} button The button a keyboard press started it from.
   */
  begin(mode, button) {
    const browser = this.win.gBrowser.selectedBrowser;
    if (offerOf(browser, mode) != "ok") {
      return;
    }
    // `start` leaves the tab's own mode first, and that end must not consume
    // the focus return of the mode being started.
    this.restore = null;
    SvalElementPicker.stop(browser);
    this.restore = button ? { browser, button } : null;
    SvalElementPicker.start(browser, mode).catch(err =>
      SvalLog.warn(`could not start the ${mode}: ${SvalLog.errorName(err)}`)
    );
  }

  /**
   * A mode button's command: starts the mode, or leaves it when the tab is
   * in it.
   *
   * @param {"remove"|"snip"} mode
   * @param {boolean} keyboard Whether a key pressed the button.
   */
  toggleMode(mode, keyboard) {
    const browser = this.win.gBrowser.selectedBrowser;
    if (SvalElementPicker.active(browser) == mode) {
      SvalElementPicker.stop(browser);
      return;
    }
    const { buttonId } = MODE_ROWS.find(row => row.mode == mode);
    this.begin(mode, keyboard ? this.doc.getElementById(buttonId) : null);
  }

  /** @returns {string[]} From `liveOf`, for the selected tab. */
  live() {
    return liveOf(this.win.gBrowser.selectedBrowser);
  }

  /**
   * The permission prompts the selected tab holds closed without an answer,
   * by the kind each asks for.
   *
   * @returns {Map<string, object>} kind -> its `PopupNotifications`
   *   notification.
   */
  waiting() {
    const { win } = this;
    const waiting = new Map();
    for (const notification of win.PopupNotifications?.getNotificationsForBrowser(
      win.gBrowser.selectedBrowser
    ) ?? []) {
      const kind = PROMPT_ANCHORS[notification.anchorID];
      if (kind && notification.dismissed && kind !== this.pending) {
        waiting.set(kind, notification);
      }
    }
    return waiting;
  }

  /**
   * What the live segment shows besides the devices in use, each a cell in
   * one state (header signals spec §2), location aside, which has its own
   * button (`drawLocation`): `asking` while its prompt is open,
   * `waiting` while the prompt is closed without an answer, and `blocked`
   * after the page tried to use a device blocked for its site.
   *
   * @param {string[]} live From `live`.
   * @returns {Array<{kind: string, state: string}>}
   */
  asks(live) {
    const asks = [];
    const add = (kind, state) => {
      if (
        kind !== "geo" &&
        !live.includes(kind) &&
        !asks.some(ask => ask.kind === kind)
      ) {
        asks.push({ kind, state });
      }
    };
    if (this.pending) {
      add(this.pending, "asking");
    }
    for (const kind of this.waiting().keys()) {
      add(kind, "waiting");
    }
    const refused = devicesTried.get(this.win.gBrowser.selectedBrowser);
    for (const kind of refused ?? []) {
      add(kind, "blocked");
    }
    return asks;
  }

  drawLive() {
    const item = this.doc.getElementById(LIVE_ID);
    if (!item) {
      return;
    }
    const live = this.live();
    const asks = this.asks(live);
    const count = live.length + asks.length;
    item.hidden = !count;
    // The address pill makes room for the segment (`sval-header.css`): a
    // 26px cell each, then its divider.
    this.doc.documentElement.style.setProperty(
      "--sval-live-w",
      count ? `${26 * count + 7}px` : "0px"
    );
    const browser = this.win.gBrowser.selectedBrowser;
    const cells = item.querySelector(".sval-live-cells");
    // Cells are made again only when what they show changes: an open prompt
    // is anchored to its cell and closes when the cell goes, and a page
    // whose media is blocked redraws the controls on each try to play.
    const cellsKey = live
      .map(kind => (mutedOf(browser, kind) ? `${kind}:muted` : kind))
      .join(" ");
    const focused = cells.querySelector(":focus")?.dataset.kind;
    const redraw = cells.dataset.key !== cellsKey;
    cells.dataset.key = cellsKey;
    if (redraw) {
      cells.replaceChildren(
        ...live.map(kind => {
          const muted = mutedOf(browser, kind);
          const name = CELL_NAMES[kind]?.[muted ? 1 : 0] ?? SCREEN_CELL_NAME;
          const cell = htmlElement(
            this.doc,
            "span",
            {
              className: "sval-live-cell",
              dataset: { kind },
              attrs: {
                role: "button",
                tabindex: "0",
                "aria-label": name,
                title: name,
              },
            },
            headerGlyph(
              this.doc,
              muted ? HEADER_OFF_GLYPHS[kind] : HEADER_GLYPHS[kind]
            )
          );
          cell.toggleAttribute("sval-muted", muted);
          return cell;
        })
      );
      cells.querySelector(`[data-kind="${focused}"]`)?.focus();
    }
    cells.toggleAttribute("sval-live", !!live.length);
    const asksBox = item.querySelector(".sval-live-asks");
    const asksKey = asks.map(({ kind, state }) => `${kind}:${state}`).join(" ");
    if (asksBox.dataset.key !== asksKey) {
      asksBox.dataset.key = asksKey;
      asksBox.replaceChildren(
        ...asks.map(({ kind, state }) =>
          htmlElement(
            this.doc,
            "span",
            { className: "sval-live-ask", dataset: { kind, state } },
            headerGlyph(
              this.doc,
              state === "blocked"
                ? HEADER_OFF_GLYPHS[kind]
                : (HEADER_GLYPHS[kind] ?? "storage")
            )
          )
        )
      );
    }
    const sentences = [];
    const says = [];
    for (const { kind, state } of asks) {
      const name = KIND_NAMES[kind] ?? "Permission";
      says.push(`${kind}:${state}`);
      sentences.push(
        {
          asking: `${name}: this site is asking. The prompt is open.`,
          waiting: `${name}: this site is asking. Click to answer.`,
          blocked: `${name}: blocked on this site. This page tried to use it. Click for site settings.`,
        }[state]
      );
    }
    const name = sentences.join(" ");
    asksBox.dataset.says = says.join(" ");
    if (name) {
      asksBox.setAttribute("aria-label", name);
      asksBox.setAttribute("tooltiptext", name);
    } else {
      asksBox.removeAttribute("aria-label");
      asksBox.removeAttribute("tooltiptext");
    }
  }

  /**
   * A live cell's command: a camera or microphone mutes or unmutes, and a
   * shared screen opens the site menu.
   *
   * @param {string} kind
   * @param {boolean} keyboard
   */
  activateCell(kind, keyboard) {
    if (kind === "camera" || kind === "microphone") {
      this.toggleMute(kind);
      return;
    }
    this.openMenu({ focus: keyboard });
  }

  /**
   * Mutes or unmutes the selected tab's camera or microphone through the
   * `WebRTC` actor's mute messages, which `MediaManager` applies to the
   * window the id names. The capture goes on, so unmuting needs no prompt.
   *
   * @param {"camera"|"microphone"} kind
   */
  toggleMute(kind) {
    const browser = this.win.gBrowser.selectedBrowser;
    const webRTC = browser._sharingState?.webRTC;
    const actor =
      webRTC?.browsingContext?.currentWindowGlobal?.getActor("WebRTC");
    if (!actor || !webRTC.windowId) {
      return;
    }
    const verb = mutedOf(browser, kind) ? "Unmute" : "Mute";
    const device = kind === "camera" ? "Camera" : "Microphone";
    actor.sendAsyncMessage(`webrtc:${verb}${device}`, String(webRTC.windowId));
  }

  /**
   * The selected tab's location, as its button shows it: `asking` while its
   * prompt is open, `waiting` while the prompt is held closed without an
   * answer, and `live` while the tab uses location (`_sharingState.geo`,
   * which `GeolocationPermissionPrompt` sets on an answer and a navigation
   * clears), and `blocked` once a block or a Block answer refused the page
   * until the tab leaves it. A permission prompt is persistent: `PopupNotifications` marks
   * it dismissed whenever its panel closes and opens it again unless
   * something suppresses it, so the open panel tells the two apart.
   *
   * @returns {?{state: string, prompt: ?object}} Null while the tab neither
   *   asks for location nor uses it; `prompt` the location prompt's
   *   `PopupNotifications` notification.
   */
  location() {
    const browser = this.win.gBrowser.selectedBrowser;
    const notifications = this.win.PopupNotifications;
    const prompt = notifications
      ?.getNotificationsForBrowser(browser)
      .find(n => PROMPT_ANCHORS[n.anchorID] === "geo");
    if (prompt) {
      const open =
        notifications.isPanelOpen &&
        [...notifications.panel.children].some(
          el => el.notification === prompt
        );
      return { state: open ? "asking" : "waiting", prompt };
    }
    if (browser._sharingState?.geo) {
      return { state: "live", prompt: null };
    }
    return locationRefused.has(browser)
      ? { state: "blocked", prompt: null }
      : null;
  }

  /**
   * Draws the location button: the glyph with the dot while the site asks,
   * in the live fill while the tab uses location, and crossed once the page
   * was refused (header signals spec §1). The button stays while
   * its state changes, since an open prompt is anchored to it.
   */
  drawLocation() {
    const button = this.doc.getElementById(LOCATION_BUTTON_ID);
    if (!button) {
      return;
    }
    const state = this.location()?.state;
    button.hidden = !state;
    if (!state) {
      return;
    }
    // The asking cell's look, dot included, which the live segment draws.
    const chip =
      button.querySelector(".sval-live-ask") ??
      button.appendChild(
        htmlElement(
          this.doc,
          "span",
          { className: "sval-live-ask", dataset: { kind: "geo" } },
          headerGlyph(this.doc, HEADER_GLYPHS.geo)
        )
      );
    chip.dataset.state = state;
    chip.querySelector(".sval-header-glyph").dataset.icon =
      state === "blocked" ? HEADER_OFF_GLYPHS.geo : HEADER_GLYPHS.geo;
    button.dataset.state = state;
    button.setAttribute("aria-label", LOCATION_NAMES[state]);
    button.setAttribute("tooltiptext", LOCATION_NAMES[state]);
  }

  /**
   * The location button's command, which turns the site's location choice
   * over as the JavaScript button does: the prompt, open or held, opens
   * again; location in use is blocked for the site, and a refused page's
   * location is allowed for it, each with a reload.
   */
  activateLocation() {
    const { state, prompt } = this.location() ?? {};
    if (prompt) {
      prompt.reshow();
      return;
    }
    // Saved as the site menu saves a permission. The reload lets a refused
    // page ask again, and ends the watch an allowed page runs, which a
    // permission change alone leaves running.
    const browser = this.win.gBrowser.selectedBrowser;
    lazy.SitePermissions.setForPrincipal(
      browser.contentPrincipal,
      "geo",
      state === "blocked"
        ? lazy.SitePermissions.ALLOW
        : lazy.SitePermissions.BLOCK
    );
    browser.reload();
  }

  activateLive(keyboard) {
    const live = this.live();
    const asks = this.asks(live);
    if (!live.length && asks.length && asks.every(a => a.state === "waiting")) {
      this.waiting().get(asks[0].kind)?.reshow();
      return;
    }
    this.openMenu({ focus: keyboard });
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.focus] Whether the menu takes the focus.
   */
  /**
   * @param {object} [options]
   * @param {boolean} [options.focus] Whether the menu takes the focus.
   * @param {boolean} [options.confirmClear] Whether it opens on "Clear
   *   cookies and site data" asking to confirm.
   */
  openMenu({ focus = false, confirmClear = false } = {}) {
    const media = mediaOf(this.win);
    // The overflow button while the site menu button is in its panel.
    const anchor = this.menuButton()
      ? lazy.CustomizableUI.getWidget(SITE_MENU_BUTTON_ID).forWindow(this.win)
          .anchor
      : null;
    if (!media || !anchor) {
      return;
    }
    if (confirmClear) {
      this.confirmingClear = true;
    }
    this.render(media);
    if (this.popover.isOpen()) {
      return;
    }
    this.popover.openFrom(anchor, "bottomright topright", {
      focus,
      button: this.menuButton(),
    });
  }

  /**
   * @param {object} media From `mediaOf`.
   * @returns {string} The name the menu's Elements, Video and audio and
   *   JavaScript choices are saved at: the host, or its site once picked.
   */
  scopeAt(media) {
    return this.picked === media.site ? media.site : media.host;
  }

  /**
   * The menu's title: the site, or on a host with a choice of scope, the
   * scope dropdown (host-scoped rules spec §4), and at the site's scope
   * the line naming what the host keeps.
   *
   * @param {object} media From `mediaOf`.
   * @returns {Element[]}
   */
  head(media) {
    const { doc } = this;
    if (!media.scope.choice) {
      return [
        htmlElement(
          doc,
          "div",
          { className: "sval-site-head" },
          htmlElement(
            doc,
            "span",
            { className: "sval-prot-domain" },
            media.site
          ),
          htmlElement(
            doc,
            "span",
            { className: "sval-prot-status" },
            "Site settings"
          )
        ),
      ];
    }
    const at = this.scopeAt(media);
    const dropdown = new ScopeDropdown(doc, {
      id: "sval-site-scope",
      choices: scopeChoices(media.scope),
      current: at,
      onPick: name => {
        this.picked = name;
        this.render(mediaOf(this.win) ?? media);
      },
    }).listen();
    const kinds = [];
    if (at === media.site) {
      if (SvalJavascript.hasRule(media.host)) {
        kinds.push("JavaScript");
      }
      if (SvalKeepLinks.hasRule(media.host)) {
        kinds.push("links");
      }
      if (
        SvalSiteProtections.ruleFor(media.host, media.session).media !==
        undefined
      ) {
        kinds.push("video and audio");
      }
    }
    const keeps = keepsLine(media.host, kinds);
    return [
      htmlElement(doc, "div", { className: "sval-site-head" }, dropdown.root),
      keeps
        ? htmlElement(
            doc,
            "span",
            { className: "sval-scope-keeps", id: "sval-site-keeps" },
            keeps
          )
        : null,
    ];
  }

  /** @param {object} media From `mediaOf`. */
  render(media) {
    const { doc } = this;
    const body = htmlElement(
      doc,
      "div",
      { className: "sval-prot-body sval-site-menu" },
      ...this.head(media),
      this.inUseSection(),
      this.zoomSection(media),
      this.elementsSection(media),
      this.styleSection(media),
      this.addressSection(media),
      this.mediaSection(media),
      this.javascriptSection(media),
      this.keepLinksSection(media),
      this.permissionsSection(media),
      this.confirmingClear ? this.clearConfirm(media) : this.clearRow(),
      this.footer(media)
    );
    const focused = this.panel.querySelector(":focus")?.id;
    // Drawn again on each change while open, the menu keeps its place; it
    // opens at its top.
    const scrolled =
      this.panel.state === "open"
        ? this.panel.querySelector(".sval-site-menu")?.scrollTop
        : 0;
    this.panel.replaceChildren(body);
    this.drawZoom();
    body.scrollTop = scrolled ?? 0;
    if (!focused) {
      return;
    }
    const again = doc.getElementById(focused);
    if (again) {
      again.focus();
    } else if (focused === "sval-site-stop-screen") {
      // A stopped screen takes its row away.
      doc.commandDispatcher.advanceFocusIntoSubtree(this.panel);
    }
  }

  /**
   * @param {string} title
   * @param {string} [note]
   * @returns {Element}
   */
  heading(title, note = "") {
    const { doc } = this;
    return htmlElement(
      doc,
      "div",
      { className: "sval-prot-label sval-site-label" },
      htmlElement(
        doc,
        "h2",
        { className: "sval-prot-heading", attrs: { "aria-label": title } },
        title
      ),
      note
        ? htmlElement(doc, "span", { className: "sval-prot-label-note" }, note)
        : null
    );
  }

  /**
   * The devices the page captures now: a camera or microphone with a Mute,
   * which keeps the page's track so unmuting needs no new request, and a
   * shared screen with a Stop, since screen capture has no mute.
   *
   * @returns {?Element} Null while nothing is live.
   */
  inUseSection() {
    const { doc } = this;
    const live = this.live();
    if (!live.length) {
      return null;
    }
    const heading = this.heading("In use now");
    const screen = {
      Screen: "Sharing a screen",
      Window: "Sharing a window",
      Browser: "Sharing a tab",
    }[this.win.gBrowser.selectedBrowser._sharingState?.webRTC?.screen];
    const browser = this.win.gBrowser.selectedBrowser;
    const rows = live.map(kind => {
      const name =
        kind == "screen" ? (screen ?? "Sharing a screen") : KIND_NAMES[kind];
      const muted = mutedOf(browser, kind);
      let stop = null;
      let mute = null;
      if (kind === "screen") {
        stop = htmlElement(
          doc,
          "button",
          {
            type: "button",
            className: "sval-prot-secondary sval-site-stop",
            id: "sval-site-stop-screen",
            attrs: { "aria-label": "Stop sharing" },
          },
          "Stop"
        );
        stop.addEventListener("click", () => this.stopScreen());
      } else {
        const verb = muted ? "Unmute" : "Mute";
        mute = htmlElement(
          doc,
          "button",
          {
            type: "button",
            className: "sval-prot-secondary sval-site-mute",
            id: `sval-site-mute-${kind}`,
            dataset: { muted: String(muted) },
            attrs: {
              "aria-label": `${verb} ${KIND_NAMES[kind].toLowerCase()}`,
            },
          },
          verb
        );
        mute.addEventListener("click", () => this.toggleMute(kind));
      }
      return htmlElement(
        doc,
        "div",
        { className: "sval-site-live", dataset: { kind } },
        htmlElement(
          doc,
          "span",
          { className: "sval-site-live-tile" },
          glyph(doc, muted ? DEVICE_OFF_ICONS[kind] : PERMISSION_ICONS[kind])
        ),
        htmlElement(doc, "span", { className: "sval-site-live-name" }, name),
        mute,
        stop
      );
    });
    return htmlElement(
      doc,
      "div",
      {
        className: "sval-site-section",
        id: "sval-site-in-use",
        attrs: { role: "group" },
      },
      heading,
      ...rows
    );
  }

  /**
   * Ends the selected tab's screen sharing, through the revoke `MediaManager`
   * takes from the `WebRTC` actor. `webrtcUI`'s
   * `clearPermissionsAndStopSharing` would also end the camera and the
   * microphone, and take the site's saved permissions away.
   */
  stopScreen() {
    const browser = this.win.gBrowser.selectedBrowser;
    const webRTC = browser._sharingState?.webRTC;
    const actor =
      webRTC?.browsingContext?.currentWindowGlobal?.getActor("WebRTC");
    if (!actor || !webRTC.windowId) {
      return;
    }
    actor.sendAsyncMessage("webrtc:StopSharing", `screen:${webRTC.windowId}`);
  }

  /**
   * The Style section: a row that opens the site style editor
   * (`SvalSiteStylePanel`), off in a private window, which keeps nothing.
   *
   * @param {object} media From `mediaOf`.
   */
  styleSection(media) {
    const { doc } = this;
    const scope = styleScopeOf(media.browser);
    const off = !scope;
    const saved = scope ? styleFor(scope.host) : null;
    const styled = !!saved;
    let sub = "Change this site's colors, theme, and font";
    if (off) {
      sub = "Off in private windows, because it saves your changes.";
    } else if (saved) {
      sub = describeStyle(saved.values);
    }
    const words = htmlElement(
      doc,
      "span",
      { className: "sval-prot-sub", id: "sval-site-style-sub" },
      sub
    );
    const label = STYLE_MENU_LABEL;
    const main = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-site-element-main",
        id: "sval-site-style",
        attrs: off ? { "aria-disabled": "true" } : {},
      },
      label
    );
    // The row's icon carries the dot the site controls' button carries while
    // the site has a saved Colorshift, and the row says what the dot means.
    const dot = styled
      ? htmlElement(doc, "span", {
          className: "sval-site-style-dot",
          id: "sval-site-style-dot",
          attrs: { role: "img", "aria-label": HAS_COLORSHIFT },
        })
      : null;
    main.ariaDescribedByElements = dot ? [dot] : [words];
    const key = doc.getElementById(STYLE_KEY);
    if (!off && (key?.hasAttribute("key") || key?.hasAttribute("keycode"))) {
      describeKey(main, STYLE_KEY, label);
    }
    main.addEventListener("click", () => {
      if (!off) {
        this.pendingStyle = true;
        this.panel.hidePopup();
      }
    });
    return htmlElement(
      doc,
      "div",
      {
        className: "sval-site-section",
        id: "sval-site-style-section",
        attrs: { role: "group" },
      },
      this.heading("Colorshift"),
      htmlElement(
        doc,
        "div",
        {
          className: "sval-site-element",
          dataset: { styled: String(styled) },
        },
        dot
          ? htmlElement(
              doc,
              "span",
              { className: "sval-site-style-icon" },
              glyph(doc, "ep-palette", "sval-prot-row-icon"),
              dot
            )
          : glyph(doc, "ep-palette", "sval-prot-row-icon"),
        htmlElement(
          doc,
          "div",
          { className: "sval-prot-row-words" },
          main,
          words
        ),
        this.pinButton("colorshift", pinsOf().includes("colorshift"))
      )
    );
  }

  /**
   * The Address section: a row that copies the page's address without its
   * tracking parameters (`copyCleanAddress`), and says whether it has any.
   *
   * @param {object} media From `mediaOf`.
   */
  addressSection(media) {
    const { doc } = this;
    const uri = Services.io.createExposableURI(media.browser.currentURI);
    const tracked = !!cleanAddressOf(uri);
    const words = htmlElement(
      doc,
      "span",
      {
        className: "sval-prot-sub",
        id: "sval-site-clean-address-sub",
        dataset: { tracked: String(tracked) },
      },
      tracked
        ? "Without its tracking parameters"
        : "No tracking parameters Sval knows of"
    );
    const main = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-site-element-main",
        id: "sval-site-clean-address",
      },
      CLEAN_ADDRESS_NAME
    );
    main.ariaDescribedByElements = [words];
    main.addEventListener("click", () => {
      this.pendingCopy = true;
      this.panel.hidePopup();
    });
    return htmlElement(
      doc,
      "div",
      {
        className: "sval-site-section",
        id: "sval-site-address-section",
        attrs: { role: "group" },
      },
      this.heading("Address"),
      htmlElement(
        doc,
        "div",
        { className: "sval-site-element" },
        glyph(doc, "ep-broom", "sval-prot-row-icon"),
        htmlElement(
          doc,
          "div",
          { className: "sval-prot-row-words" },
          main,
          words
        ),
        this.pinButton("clean-address", pinsOf().includes("clean-address"))
      )
    );
  }

  /**
   * The Elements section: a row to start each mode with a button to pin it
   * to the address bar, and the site's rules from My filters.
   *
   * @param {object} media From `mediaOf`.
   */
  elementsSection(media) {
    const { doc } = this;
    const section = htmlElement(
      doc,
      "div",
      {
        className: "sval-site-section",
        id: "sval-site-elements",
        attrs: { role: "group" },
      },
      this.heading("Elements")
    );
    const pins = pinsOf();
    for (const row of MODE_ROWS) {
      // The picker's card picks its own scope on a host with a choice.
      const shown =
        row.mode === "remove" && media.scope.choice
          ? { ...row, label: "Remove an element…" }
          : row;
      section.append(this.elementRow(media, shown, pins.includes(row.mode)));
    }
    const hidden = this.hiddenSection(media);
    if (hidden) {
      section.append(hidden);
    }
    return section;
  }

  elementRow(media, { mode, label, sub, icon }, pinned) {
    const { doc } = this;
    const offer = offerOf(media.browser, mode);
    const off = offer != "ok";
    const words = htmlElement(
      doc,
      "span",
      { className: "sval-prot-sub", id: `sval-site-element-${mode}-sub` },
      off ? (OFF_IN_MENU[offer] ?? "") : sub
    );
    const main = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-site-element-main",
        id: `sval-site-element-${mode}`,
        attrs: off ? { "aria-disabled": "true" } : {},
      },
      label
    );
    main.ariaDescribedByElements = [words];
    // The mode's key, once the user gives it one, as its button and its
    // Tab menu item name it.
    const key = doc.getElementById(MODE_KEYS[mode]);
    if (!off && (key?.hasAttribute("key") || key?.hasAttribute("keycode"))) {
      describeKey(main, MODE_KEYS[mode], label);
    }
    main.addEventListener("click", () => {
      if (!off) {
        this.pendingMode = mode;
        this.panel.hidePopup();
      }
    });
    const pin = this.pinButton(mode, pinned);
    return htmlElement(
      doc,
      "div",
      { className: "sval-site-element", dataset: { mode, offer } },
      glyph(doc, icon, "sval-prot-row-icon"),
      htmlElement(
        doc,
        "div",
        { className: "sval-prot-row-words" },
        main,
        words
      ),
      pin
    );
  }

  /**
   * A button that pins one of the site controls' buttons to the address bar,
   * or unpins it.
   *
   * @param {"javascript"|"remove"|"snip"|"colorshift"|"clean-address"} id
   * @param {boolean} pinned
   * @returns {Element}
   */
  pinButton(id, pinned) {
    const title = pinned
      ? "Unpin from the address bar"
      : "Pin to the address bar";
    const pin = htmlElement(
      this.doc,
      "button",
      {
        type: "button",
        className: "sval-site-pin",
        id: `sval-site-pin-${id}`,
        title,
        attrs: { "aria-pressed": String(pinned), "aria-label": title },
      },
      glyph(this.doc, "ep-pin")
    );
    pin.addEventListener("click", () =>
      SvalSiteControls.setPinned(id, !pinned)
    );
    return pin;
  }

  /**
   * The rules My filters holds for the site, as a disclosure that opens on
   * a click and starts closed each time the menu opens.
   *
   * @param {object} media From `mediaOf`.
   * @returns {?Element} Null where the site has none.
   */
  hiddenSection(media) {
    const { doc } = this;
    const scopeName = this.scopeAt(media);
    const lines = listedOn(media.host, scopeName);
    if (!lines.length) {
      return null;
    }
    const open = this.hiddenOpen;
    const toggle = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-site-hidden-toggle",
        id: "sval-site-hidden-toggle",
        attrs: {
          "aria-expanded": String(open),
          "aria-controls": "sval-site-hidden-body",
        },
      },
      glyph(doc, "ep-eraser", "sval-prot-row-icon"),
      htmlElement(
        doc,
        "span",
        { className: "sval-site-hidden-label" },
        media.scope.choice
          ? `Removal rules for ${scopePhrase(media.scope, scopeName)}`
          : "Removal rules for this site"
      ),
      htmlElement(
        doc,
        "span",
        { className: "sval-site-hidden-count" },
        String(lines.length)
      ),
      glyph(doc, "sc-next", "sval-site-hidden-chevron")
    );
    const shown = lines.slice(0, MAX_HIDDEN_ROWS);
    const inner = htmlElement(doc, "div", {
      className: "sval-site-hidden-inner",
    });
    shown.forEach((entry, at) =>
      inner.append(this.hiddenRow(media, entry, at))
    );
    const link = htmlElement(
      doc,
      "a",
      {
        className: "sval-prot-link sval-site-hidden-manage",
        href: "#",
        id: "sval-site-hidden-manage",
      },
      lines.length > MAX_HIDDEN_ROWS
        ? `See all ${lines.length} in Settings`
        : "Manage in Settings",
      glyph(doc, "sc-external", "sval-site-hidden-external")
    );
    link.addEventListener("click", event => {
      event.preventDefault();
      this.panel.hidePopup();
      SvalProtectionButton.forWindow(this.win)?.manageSite(media.site, {
        hidden: true,
      });
    });
    inner.append(link);
    const body = htmlElement(
      doc,
      "div",
      { className: "sval-site-hidden-body", id: "sval-site-hidden-body" },
      inner
    );
    body.inert = !open;
    toggle.addEventListener("click", () => {
      const expand = toggle.getAttribute("aria-expanded") != "true";
      toggle.setAttribute("aria-expanded", String(expand));
      body.inert = !expand;
      this.hiddenOpen = expand;
    });
    this.countHidden(media, shown);
    return htmlElement(
      doc,
      "div",
      { className: "sval-site-hidden" },
      toggle,
      body
    );
  }

  hiddenRow(media, entry, at) {
    const { doc } = this;
    const sub = htmlElement(
      doc,
      "span",
      { className: "sval-prot-sub sval-site-hidden-sub" },
      this.hiddenWords(media, entry)
    );
    const words = htmlElement(
      doc,
      "div",
      { className: "sval-site-hidden-words" },
      htmlElement(
        doc,
        "span",
        { className: "sval-site-hidden-rule", title: entry.line },
        entry.shown
      ),
      sub
    );
    if (entry.inherited) {
      words.append(
        htmlElement(
          doc,
          "span",
          { className: "sval-prot-sub sval-site-hidden-from" },
          entry.scope === media.site
            ? `Set for all of ${media.site}`
            : `Set for ${entry.scope}`
        )
      );
    }
    const row = htmlElement(
      doc,
      "div",
      {
        className: "sval-site-hidden-row",
        dataset: {
          selector: entry.kind == "hide" ? entry.shown : "",
          kind: entry.kind,
          matches: this.counted.get(entry.shown) ?? "",
          scope: entry.scope,
          inherited: String(entry.inherited),
          excepted: String(entry.excepted),
        },
      },
      words
    );
    if (!media.isPrivate) {
      let title = "Delete this rule";
      if (entry.excepted) {
        title = "Delete this rule or turn it back on";
      } else if (entry.kind == "hide" && entry.scope !== media.host) {
        title = "Delete or turn off this rule";
      }
      const show = htmlElement(
        doc,
        "button",
        {
          type: "button",
          className: "sval-site-hidden-show",
          id: `sval-site-hidden-show-${at}`,
          title,
          attrs: {
            "aria-label": `${title}: ${entry.shown}`,
          },
        },
        glyph(doc, "sc-x")
      );
      // A click the keyboard made has no mouse presses to count.
      show.addEventListener("click", event =>
        this.showAgain(media, entry, at, show, event.detail == 0)
      );
      row.append(show);
    }
    return row;
  }

  /**
   * What a listed rule does on the page, the line under its text.
   *
   * @param {object} media From `mediaOf`.
   * @param {{kind: string, shown: string, excepted: boolean}} entry
   * @returns {string}
   */
  hiddenWords(media, entry) {
    if (entry.kind == "network") {
      return "Stops a download on this site";
    }
    if (entry.excepted) {
      return `Turned off on ${media.host}`;
    }
    return matchesWords(this.counted.get(entry.shown));
  }

  /**
   * Asks the page how many elements each listed hiding rule matches, and
   * writes the answers into the rows, unless a later render took them over.
   *
   * @param {object} media From `mediaOf`.
   * @param {Array<{kind: string, shown: string}>} entries
   */
  async countHidden(media, entries) {
    const selectors = [
      ...new Set(
        entries.filter(e => e.kind == "hide" && !e.excepted).map(e => e.shown)
      ),
    ];
    if (!selectors.length) {
      return;
    }
    const run = ++this.countRun;
    const counts = await SvalElementPicker.countOn(media.browser, selectors);
    if (run != this.countRun) {
      return;
    }
    selectors.forEach((selector, at) => {
      const n = counts[at];
      if (n == null) {
        return;
      }
      this.counted.set(selector, n);
      for (const row of this.panel.querySelectorAll(".sval-site-hidden-row")) {
        if (
          row.dataset.selector === selector &&
          row.dataset.excepted != "true"
        ) {
          row.dataset.matches = String(n);
          row.querySelector(".sval-site-hidden-sub").textContent =
            matchesWords(n);
        }
      }
    });
  }

  /**
   * Takes the row's scope out of its line in My filters, or on a host for
   * a rule its whole site holds, asks where to show it (`askShowAgain`).
   *
   * @param {object} media From `mediaOf`.
   * @param {{line: string, kind: string, shown: string, scope: string}} entry
   * @param {number} at The row's place in the list.
   * @param {Element} anchor The row's Show again button.
   * @param {boolean} keyboard Whether the keyboard pressed the button.
   */
  showAgain(media, entry, at, anchor, keyboard) {
    if (entry.kind == "hide" && entry.scope !== media.host) {
      this.askShowAgain(media, entry, at, anchor);
      return;
    }
    this.writeShowAgain(
      media,
      entry,
      at,
      showAgainIn(SvalBlocking.myFilters, entry.line, entry.scope),
      keyboard
    );
  }

  /**
   * Show again on a host for a rule a name above it holds (host-scoped rules
   * spec §4): everywhere takes that name out of the line, with any exception
   * the host holds to it, and here alone writes the host's exception to it.
   * A rule already shown on the host offers to hide it there again.
   *
   * @param {object} media From `mediaOf`.
   * @param {{line: string, kind: string, shown: string, scope: string}} entry
   * @param {number} at The row's place in the list.
   * @param {Element} anchor The row's Show again button.
   */
  askShowAgain(media, entry, at, anchor) {
    const { doc } = this;
    const chain = scopeChain(media.host);
    const everywhere = () => {
      const next = showAgainIn(SvalBlocking.myFilters, entry.line, entry.scope);
      return next === null
        ? null
        : (hideAgain(next, chain, entry.shown) ?? next);
    };
    const ruleScope =
      entry.scope === media.site ? `all of ${media.site}` : entry.scope;
    const choices = [
      ["everywhere", `Delete the rule for ${ruleScope}`, everywhere],
      entry.excepted
        ? [
            "hide-here",
            `Turn the rule back on for ${media.host}`,
            () => hideAgain(SvalBlocking.myFilters, chain, entry.shown),
          ]
        : [
            "here",
            `Turn off the rule on ${media.host}`,
            () =>
              appendLines(SvalBlocking.myFilters, [
                exceptionLine(media.host, entry.shown),
              ]),
          ],
    ];
    // A menu of its own over `choose`: the write needs to know whether the
    // keyboard made the choice, which the command's event tells.
    const menu = lazy.SvalMenu.create(doc, {
      name: "sval-site-show-again-menu",
      transient: true,
      items: choices.map(([where, label, next]) => ({
        id: where,
        label,
        data: next,
      })),
      onCommand: (where, next, event) =>
        this.writeShowAgain(
          media,
          entry,
          at,
          next(),
          event.inputSource == MouseEvent.MOZ_SOURCE_KEYBOARD
        ),
    });
    menu.openFrom(anchor, "after_end");
  }

  /**
   * Saves My filters with a rule shown again, or hidden again on the host,
   * and reloads the tab, since the page keeps the rules it loaded with.
   * The change redraws the menu (`BLOCKING_TOPIC`), and the button that had
   * the focus may be gone with its row, so the focus goes to the button that
   * takes its place, the one before it, or the list's toggle. Its ring shows
   * only where the keyboard made the choice.
   *
   * @param {object} media From `mediaOf`.
   * @param {{kind: string, shown: string}} entry
   * @param {number} at The row's place in the list.
   * @param {?string} next My filters as it is to be, null where the rule is
   *   gone already.
   * @param {boolean} keyboard Whether the keyboard made the choice.
   */
  writeShowAgain(media, entry, at, next, keyboard) {
    if (next === null) {
      this.update();
      return;
    }
    try {
      SvalBlocking.setMyFilters(next);
    } catch (err) {
      SvalLog.warn(`could not show a rule again: ${SvalLog.errorName(err)}`);
      return;
    }
    media.browser.reload();
    if (!this.panel.querySelector(":focus")) {
      const { doc } = this;
      (
        doc.getElementById(`sval-site-hidden-show-${at - 1}`) ??
        doc.getElementById(`sval-site-hidden-show-${at}`) ??
        doc.getElementById("sval-site-hidden-toggle")
      )?.focus({ focusVisible: keyboard });
    }
  }

  mediaSection(media) {
    const { doc } = this;
    const at = this.scopeAt(media);
    const group = segments(
      doc,
      "site-media",
      media.scope.choice
        ? `Video and audio on ${scopePhrase(media.scope, at)}`
        : "Video and audio on this site",
      MEDIA_CHOICES.map(([value, text]) => ({ value, text })),
      SvalSiteProtections.mediaFor(at, media.session),
      value => this.chooseMedia(media, value)
    );
    return htmlElement(
      doc,
      "div",
      { className: "sval-site-section", attrs: { role: "group" } },
      this.heading("Video and audio"),
      htmlElement(doc, "div", { className: "sval-site-segments" }, group)
    );
  }

  /**
   * Saves the media choice at the menu's scope. The visit gives way to it,
   * so the choice holds from here. The segments are radios, so the checked
   * one fires no change and choosing it again saves nothing. A site's
   * choice is saved even where it matches the default, so a later change of
   * the default leaves the site as the person set it.
   *
   * @param {object} media From `mediaOf`.
   * @param {"ask"|"allow"|"block"} value
   */
  chooseMedia(media, value) {
    const { browser, host, session } = media;
    if (!this.mediaChanged.has(browser)) {
      this.mediaChanged.set(browser, { host, session, before: media.choice });
    }
    SvalSiteProtections.setMedia(this.scopeAt(media), value, session);
    if (browser.contentPrincipal?.isContentPrincipal) {
      SvalSiteProtections.coverOrigin(browser.contentPrincipal);
    }
    endVisit(browser);
    this.update();
  }

  /**
   * As the menu closes, reloads each tab whose host it moved to Always
   * allow, so its page plays, since a page asks to play as it loads, and
   * each tab whose permissions it changed, since a permission gates only a
   * page's next request and leaves what the page already holds running.
   * What counts is the state the menu closes on, because arrow keys pass
   * through Always allow on the way to another choice, and a person may come
   * back to the one the menu opened with.
   */
  reloadChanged() {
    const reload = new Set();
    for (const [browser, { host, session, before }] of this.mediaChanged) {
      if (
        before !== "allow" &&
        SvalSiteProtections.mediaFor(host, session) === "allow"
      ) {
        reload.add(browser);
      }
    }
    for (const [browser, before] of this.permissionsChanged) {
      if (permissionStates(browser) !== before) {
        reload.add(browser);
      }
    }
    this.mediaChanged.clear();
    this.permissionsChanged.clear();
    for (const browser of reload) {
      browser.reload();
    }
  }

  /**
   * Notes the tab's permissions before the menu changes one.
   *
   * @param {Element} browser
   */
  notePermissions(browser) {
    if (!this.permissionsChanged.has(browser)) {
      this.permissionsChanged.set(browser, permissionStates(browser));
    }
  }

  javascriptSection(media) {
    const { doc, win } = this;
    const at = this.scopeAt(media);
    const on = SvalJavascript.enabledFor(at);
    const toggle = htmlElement(doc, "button", {
      type: "button",
      className: "sval-prot-switch",
      id: "sval-site-js",
      attrs: {
        role: "switch",
        "aria-checked": String(on),
        "aria-label": media.scope.choice
          ? `JavaScript on ${scopePhrase(media.scope, at)}`
          : "JavaScript on this site",
        ...(media.isPrivate ? { "aria-disabled": "true" } : {}),
      },
    });
    toggle.addEventListener("click", () => {
      if (media.isPrivate) {
        return;
      }
      SvalJavascript.setEnabled(at, !on);
      win.gBrowser.selectedBrowser.reload();
      this.update();
    });
    return htmlElement(
      doc,
      "div",
      { className: "sval-site-section", attrs: { role: "group" } },
      this.heading("JavaScript", "Reloads the tab"),
      htmlElement(
        doc,
        "div",
        {
          className: "sval-prot-switch-row",
          dataset: { disabled: media.isPrivate ? "true" : "" },
        },
        htmlElement(
          doc,
          "div",
          { className: "sval-prot-switch-words" },
          htmlElement(
            doc,
            "span",
            { className: "sval-prot-switch-label" },
            on ? "JavaScript is on" : "JavaScript is off"
          )
        ),
        toggle,
        this.pinButton("javascript", pinsOf().includes("javascript"))
      ),
      htmlElement(
        doc,
        "span",
        { className: "sval-prot-sub sval-site-note" },
        media.isPrivate
          ? "A private window can't change it."
          : "Turning it off breaks some sites."
      )
    );
  }

  /**
   * Keep links in this tab, saved at the scope in view. It takes effect on
   * the page in view as it changes (`SvalKeepLinks.start`), so it reloads
   * nothing.
   *
   * @param {object} media From `mediaOf`.
   */
  keepLinksSection(media) {
    const { doc } = this;
    const at = this.scopeAt(media);
    const on = SvalKeepLinks.onFor(at);
    const toggle = htmlElement(doc, "button", {
      type: "button",
      className: "sval-prot-switch",
      id: "sval-site-keep-links",
      attrs: {
        role: "switch",
        "aria-checked": String(on),
        "aria-label": "Keep links in this tab",
        ...(media.isPrivate ? { "aria-disabled": "true" } : {}),
      },
    });
    toggle.addEventListener("click", () => {
      if (media.isPrivate) {
        return;
      }
      SvalKeepLinks.setOn(at, !on);
      this.update();
    });
    return htmlElement(
      doc,
      "div",
      { className: "sval-site-section", attrs: { role: "group" } },
      this.heading("Links"),
      htmlElement(
        doc,
        "div",
        {
          className: "sval-prot-switch-row",
          dataset: { disabled: media.isPrivate ? "true" : "" },
        },
        htmlElement(
          doc,
          "div",
          { className: "sval-prot-switch-words" },
          htmlElement(
            doc,
            "span",
            { className: "sval-prot-switch-label" },
            "Keep links in this tab"
          )
        ),
        toggle
      ),
      htmlElement(
        doc,
        "span",
        { className: "sval-prot-sub sval-site-note" },
        media.isPrivate
          ? "A private window can't change this setting."
          : `Links between ${at} pages can't open a new tab or window.`
      )
    );
  }

  /**
   * The selected tab's zoom, a step of Firefox's zoom ladder
   * (`ZoomManager.zoomValues`) on a slider whose ticks mark each step.
   * `drawZoom` fills in the current step.
   *
   * @param {object} media From `mediaOf`.
   */
  zoomSection(media) {
    const { doc, win } = this;
    const values = win.ZoomManager.zoomValues;
    const last = values.length - 1;
    const heading = this.heading("Zoom");
    const reset = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-prot-secondary sval-site-zoom-reset",
        id: ZOOM_RESET_ID,
      },
      "Reset"
    );
    reset.addEventListener("click", () => win.FullZoom.resetFromURLBar());
    const slider = htmlElement(doc, "input", {
      type: "range",
      className: "sval-site-zoom-slider",
      id: ZOOM_SLIDER_ID,
      min: 0,
      max: last,
      step: 1,
      attrs: { "aria-label": "Zoom" },
    });
    slider.addEventListener("input", () =>
      win.FullZoom.setZoom(values[slider.valueAsNumber], media.browser)
    );
    // The ends, the default and double are labelled.
    const ticks = values.map((value, i) => {
      const named = i == 0 || i == last || value == 1 || value == 2;
      const tick = htmlElement(
        doc,
        "span",
        {
          className: named
            ? "sval-site-zoom-tick named"
            : "sval-site-zoom-tick",
        },
        named
          ? htmlElement(
              doc,
              "span",
              { className: "sval-site-zoom-tick-label" },
              `${Math.round(value * 100)}%`
            )
          : null
      );
      tick.style.setProperty("--sval-at", String(i / last));
      return tick;
    });
    return htmlElement(
      doc,
      "div",
      {
        className: "sval-site-section",
        id: "sval-site-zoom-section",
        attrs: { role: "group", "aria-label": "Zoom" },
      },
      heading,
      htmlElement(
        doc,
        "div",
        { className: "sval-site-zoom-row" },
        htmlElement(
          doc,
          "div",
          { className: "sval-site-zoom-track" },
          slider,
          htmlElement(
            doc,
            "div",
            {
              className: "sval-site-zoom-ticks",
              attrs: { "aria-hidden": "true" },
            },
            ...ticks
          )
        ),
        htmlElement(doc, "output", {
          className: "sval-site-zoom-value",
          htmlFor: ZOOM_SLIDER_ID,
        }),
        reset
      )
    );
  }

  /**
   * Draws the open menu's zoom: the slider's step, the value, and Reset,
   * which is off at the default zoom (`ZoomUI.getGlobalValue`).
   */
  async drawZoom() {
    const { doc, win } = this;
    if (!doc.getElementById(ZOOM_SLIDER_ID)) {
      return;
    }
    const browser = win.gBrowser.selectedBrowser;
    const fallback = await lazy.ZoomUI.getGlobalValue();
    const slider = doc.getElementById(ZOOM_SLIDER_ID);
    if (!slider || browser !== win.gBrowser.selectedBrowser) {
      return;
    }
    const zoom = win.ZoomManager.getZoomForBrowser(browser);
    const percent = Math.round(zoom * 100);
    const atDefault = percent == Math.round(fallback * 100);
    const text = `${percent}%`;
    slider.value = win.ZoomManager.zoomValues.indexOf(
      win.ZoomManager.snap(zoom)
    );
    slider.setAttribute("aria-valuetext", text);
    slider.closest(".sval-site-zoom-row").querySelector("output").value = text;
    doc.getElementById(ZOOM_RESET_ID).disabled = atDefault;
  }

  /**
   * The site's permissions as Firefox keeps them (`SitePermissions`), with
   * the ones a person most often meets always listed.
   *
   * @param {object} media From `mediaOf`.
   */
  permissionsSection(media) {
    const { doc } = this;
    const { browser } = media;
    const held = lazy.SitePermissions.getAllForBrowser(browser);
    const ids = [...LISTED_PERMISSIONS];
    for (const { id } of held) {
      if (
        !ids.includes(id) &&
        !UNLISTED_PERMISSIONS.has(id) &&
        lazy.SitePermissions.getPermissionLabel(id)
      ) {
        ids.push(id);
      }
    }
    const live = this.live();
    const section = htmlElement(
      doc,
      "div",
      { className: "sval-site-section", attrs: { role: "group" } },
      this.heading("Permissions", "Reloads the tab"),
      // Firefox keeps permissions per origin, whatever scope the title picks.
      media.scope.choice
        ? htmlElement(
            doc,
            "span",
            {
              className: "sval-prot-sub sval-site-note",
              id: "sval-site-perm-scope",
            },
            `These permissions are for ${media.host} only.`
          )
        : null
    );
    for (const id of ids) {
      section.append(this.permissionRow(media, id, held, live));
    }
    return section;
  }

  permissionRow(media, id, held, live) {
    const { doc } = this;
    const { browser } = media;
    const SP = lazy.SitePermissions;
    const { state, scope } = SP.getForPrincipal(
      browser.contentPrincipal,
      id,
      browser
    );
    const label = SP.getPermissionLabel(id);
    const words = permissionWords();
    const value = words.get(state) ?? "Ask";
    const choices = SP.getAvailableStates(id).filter(s => words.has(s));
    const menu = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-prot-pill sval-prot-secondary sval-site-value",
        id: `sval-site-perm-${id}`,
        dataset: { state: String(state) },
        attrs: {
          "aria-haspopup": "menu",
          "aria-label": `${label}: ${value}`,
        },
      },
      value,
      glyph(doc, "sc-chevron-down", "sval-site-chevron")
    );
    menu.addEventListener("click", () =>
      this.pickPermission(media, id, choices, state, menu)
    );
    const clear = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-prot-dismiss sval-site-clear",
        id: `sval-site-clear-${id}`,
        attrs: { "aria-label": `Clear ${label}` },
      },
      glyph(doc, "sc-x")
    );
    const isSet = held.some(p => p.id === id);
    clear.inert = !isSet;
    clear.toggleAttribute("sval-unset", !isSet);
    clear.addEventListener("click", () => {
      this.notePermissions(browser);
      SP.removeFromPrincipal(browser.contentPrincipal, id, browser);
      // As Firefox's permission panel does on the same removal
      // (`gPermissionPanel._createPermissionClearButton`).
      if (id === "geo") {
        this.win.gBrowser.updateBrowserSharing(browser, { geo: false });
      }
      this.update();
    });
    const inUse =
      (id === "camera" && live.includes("camera")) ||
      (id === "microphone" && live.includes("microphone"));
    // The address bar has no blocked-popup icon (the permission box is
    // hidden), so the count Firefox keeps for the page shows here.
    const blocked =
      id === "popup"
        ? (browser.popupAndRedirectBlocker?.getBlockedPopupCount() ?? 0)
        : 0;
    let sub = "";
    let why = "";
    if (scope === SP.SCOPE_TEMPORARY && state === SP.ALLOW) {
      sub = "Allowed for this visit";
      why = "visit";
    } else if (blocked) {
      sub = `${blocked} blocked on this page`;
      why = "popups-blocked";
    }
    return htmlElement(
      doc,
      "div",
      { className: "sval-site-perm" },
      glyph(doc, PERMISSION_ICONS[id] ?? "sc-storage", "sval-prot-row-icon"),
      htmlElement(
        doc,
        "div",
        { className: "sval-prot-row-words" },
        htmlElement(
          doc,
          "div",
          { className: "sval-site-perm-name" },
          htmlElement(doc, "span", {}, label),
          inUse
            ? htmlElement(
                doc,
                "span",
                { className: "sval-site-in-use" },
                "In use"
              )
            : null
        ),
        sub
          ? htmlElement(
              doc,
              "span",
              { className: "sval-prot-sub", dataset: { why } },
              sub
            )
          : null
      ),
      menu,
      clear
    );
  }

  /**
   * The value menu of a permission's row, as a native menu of its states.
   *
   * @param {object} media From `mediaOf`.
   * @param {string} id
   * @param {number[]} choices `SitePermissions` states.
   * @param {number} current
   * @param {Element} anchor
   */
  async pickPermission(media, id, choices, current, anchor) {
    const SP = lazy.SitePermissions;
    const words = permissionWords();
    // The state shown as chosen is the one that reads as the current one.
    const shown = choices.find(
      state => words.get(state) === words.get(current)
    );
    const state = await lazy.SvalMenu.choose(
      anchor,
      choices.map(choice => ({ value: choice, label: words.get(choice) })),
      shown,
      { name: "sval-site-perm-menu" }
    );
    if (state === null) {
      return;
    }
    const { browser } = media;
    this.notePermissions(browser);
    if (state === SP.UNKNOWN || state === SP.PROMPT) {
      SP.removeFromPrincipal(browser.contentPrincipal, id, browser);
    } else {
      SP.setForPrincipal(browser.contentPrincipal, id, state);
    }
    this.update();
  }

  clearRow() {
    const { doc } = this;
    const row = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-prot-action",
        id: "sval-site-data-clear",
      },
      glyph(doc, "sc-cookie", "sval-prot-row-icon"),
      htmlElement(doc, "span", {}, "Clear cookies and site data")
    );
    row.addEventListener("click", () => {
      this.confirmingClear = true;
      this.update();
      this.doc.getElementById("sval-site-data-clear-go")?.focus();
    });
    return htmlElement(doc, "div", { className: "sval-prot-clear" }, row);
  }

  /**
   * "Clear cookies and site data" asking to confirm, in the row's place.
   * Clearing removes the site the dialog names from the tab's own jar
   * alone (`SvalSiteData.clearJarOf`): the same site in normal windows,
   * other private sessions and isolated workspaces keeps its data, which a
   * clear by site with an empty pattern would match. The tab reloads once
   * the jar is clear.
   *
   * @param {object} media From `mediaOf`.
   */
  clearConfirm(media) {
    const { doc } = this;
    const cancel = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-prot-pill sval-prot-secondary sval-prot-small",
        id: "sval-site-data-clear-cancel",
      },
      "Cancel"
    );
    cancel.addEventListener("click", () => this.cancelClear());
    const go = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-prot-pill sval-prot-danger sval-prot-small",
        id: "sval-site-data-clear-go",
      },
      "Clear and reload"
    );
    go.addEventListener("click", () =>
      this.clearSiteData(media).catch(err =>
        SvalLog.warn(`clearing site data failed: ${SvalLog.errorName(err)}`)
      )
    );
    const well = htmlElement(
      doc,
      "div",
      { className: "sval-prot-well sval-prot-confirm" },
      htmlElement(
        doc,
        "div",
        { className: "sval-prot-media-line" },
        glyph(doc, "sc-cookie", "sval-prot-confirm-icon"),
        htmlElement(
          doc,
          "div",
          { className: "sval-prot-media-words" },
          htmlElement(
            doc,
            "span",
            { className: "sval-prot-media-title" },
            `Clear cookies and site data for ${media.site}?`
          ),
          htmlElement(
            doc,
            "span",
            { className: "sval-prot-media-body" },
            "You'll be signed out of this site and the tab will reload."
          )
        )
      ),
      htmlElement(
        doc,
        "div",
        { className: "sval-prot-confirm-buttons" },
        cancel,
        go
      )
    );
    return htmlElement(doc, "div", { className: "sval-prot-clear" }, well);
  }

  cancelClear() {
    this.confirmingClear = false;
    this.update();
    this.doc.getElementById("sval-site-data-clear")?.focus();
  }

  async clearSiteData(media) {
    const { browser, site } = media;
    const { failed } = await lazy.SvalSiteData.clearJarOf(
      site,
      browser.browsingContext?.originAttributes ??
        browser.contentPrincipal.originAttributes
    );
    this.confirmingClear = false;
    if (!failed) {
      browser.reload();
    }
    if (this.panel.state !== "closed") {
      this.update();
      this.doc.getElementById("sval-site-data-clear")?.focus();
    }
  }

  footer(media) {
    return protectionFooter(
      this.doc,
      media.isPrivate,
      { className: "sval-prot-link", id: "sval-site-manage" },
      () => {
        this.panel.hidePopup();
        SvalProtectionButton.forWindow(this.win)?.manageSites(media.site);
      }
    );
  }
}

/** window -> its SiteControls. */
const controls = new WeakMap();

export const SvalSiteControls = {
  PINS_PREF,

  /**
   * Opens Colorshift from its button. A keyboard press moves the focus
   * into it, and so does any press while it is open, since closing it
   * would drop unsaved changes.
   *
   * @param {Window} win
   * @param {boolean} keyboard
   */
  openColorshift(win, keyboard) {
    SvalSiteStylePanel.open(win, {
      focus: keyboard || SvalSiteStylePanel.isOpen(win),
    });
  },

  /** @returns {string[]} the buttons pinned in the site controls. */
  pins() {
    return pinsOf();
  },

  /**
   * Pins or unpins a button.
   *
   * @param {"javascript"|"remove"|"snip"|"colorshift"|"clean-address"} id
   * @param {boolean} pinned
   */
  setPinned(id, pinned) {
    if (!PINNABLE.includes(id)) {
      throw new Error("unknown button");
    }
    const pins = new Set(pinsOf());
    if (pinned) {
      pins.add(id);
    } else {
      pins.delete(id);
    }
    Services.prefs.setStringPref(
      PINS_PREF,
      JSON.stringify(PINNABLE.filter(p => pins.has(p)))
    );
  },

  /**
   * Adds the site controls' behaviour to a browser window, after its
   * delayed startup; `SvalHeader` builds their widgets.
   *
   * @param {Window} win
   */
  startWindow(win) {
    if (controls.has(win)) {
      return;
    }
    const control = new SiteControls(win);
    try {
      control.mount();
      controls.set(win, control);
    } catch (err) {
      SvalLog.error(`the site controls failed: ${SvalLog.errorName(err)}`);
    }
  },

  /**
   * @param {Window} win
   * @returns {SiteControls|undefined}
   */
  forWindow(win) {
    return controls.get(win);
  },

  /**
   * `browser.js`'s `getVisibleAnchorElement`: where a permission prompt in
   * `win` anchors ({@link SiteControls#promptAnchor}).
   *
   * @param {Window} win
   * @param {Element|null} anchor
   * @param {Element|null} fallback Firefox's answer.
   * @returns {Element|null}
   */
  promptAnchor(win, anchor, fallback) {
    lazy.SvalPanelToolbar.beforePrompt(win);
    const control = controls.get(win);
    const answer = control ? control.promptAnchor(anchor, fallback) : fallback;
    const drawn = element =>
      element?.checkVisibility({ visibilityProperty: true });
    if (drawn(answer)) {
      return answer;
    }
    // Firefox falls back to its padlock and search switch, which Sval's
    // address field lacks, then to its remote-control icon, which passes a
    // plain `checkVisibility()` while collapsed. A prompt anchored to an
    // element with no box closes as it opens, again and again. The shield
    // stands where the padlock did.
    const shield = win.document.getElementById(PROTECTION_BUTTON_ID);
    return drawn(shield) ? shield : answer;
  },

  /** @param {Window} win */
  activateLocation(win) {
    controls.get(win)?.activateLocation();
  },

  /**
   * @param {Window} win
   * @param {boolean} keyboard Whether a key pressed the segment.
   */
  activateLive(win, keyboard) {
    controls.get(win)?.activateLive(keyboard);
  },

  /**
   * @param {Window} win
   * @param {string} kind
   * @param {boolean} keyboard
   */
  activateCell(win, kind, keyboard) {
    controls.get(win)?.activateCell(kind, keyboard);
  },

  /** @param {Window} win */
  toggleMedia(win) {
    controls.get(win)?.toggleMedia();
  },

  /**
   * @param {Window} win
   * @param {"remove"|"snip"} mode
   * @returns {boolean} whether the window's selected tab offers the mode.
   */
  offered(win, mode) {
    return offerOf(win.gBrowser.selectedBrowser, mode) == "ok";
  },

  /**
   * @param {Window} win
   * @param {"remove"|"snip"} mode
   * @param {boolean} keyboard Whether a key pressed the button.
   */
  toggleMode(win, mode, keyboard) {
    controls.get(win)?.toggleMode(mode, keyboard);
  },

  /**
   * @param {Window} win
   * @param {object} [options]
   * @param {boolean} [options.focus]
   */
  openMenu(win, options) {
    controls.get(win)?.openMenu(options);
  },
};
