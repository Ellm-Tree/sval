/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Privacy and Security button in the address pill, and its panel
 * (protections spec §2.1 and §2.2, decision 0131). It
 * stands in for Firefox's shield and padlock, which `sval-protection.css`
 * hides, so the page's connection is told here too: what `gIdentityHandler`
 * reads from the page's security state colours the button when the
 * connection is wrong, and the panel hosts the certificate's details.
 *
 * What the button shows comes from what Firefox already records: the tab's
 * content-blocking log (`getContentBlockingLog`), read with the blockers
 * `gProtectionsHandler` classifies it with, and the canvas and font
 * fingerprinting states Gecko reports into the same log. The site's
 * choices are `SvalSiteProtections`'. What a site may do, media included, is
 * the site controls' (`SvalSiteControls`, decision 0132).
 *
 * Clicking only opens the panel, since every change reloads the tab.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { scopeForURI } from "moz-src:///browser/components/sval/SvalSite.sys.mjs";
import {
  ScopeDropdown,
  keepsLine,
  scopeChoices,
} from "moz-src:///browser/components/sval/SvalScopeMenu.sys.mjs";
import {
  APPLIED_TOPIC,
  SvalSiteProtections,
  GRANULAR_PREFS,
  OVERRIDE_PREFS,
  REMOTE_OVERRIDES_PREF,
  readGranular,
} from "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs";
import { htmlElement } from "moz-src:///browser/components/sval/SvalDom.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalBlocking: "moz-src:///browser/components/sval/SvalBlocking.sys.mjs",
  BreachAlertStorage: "resource://gre/modules/BreachAlertStore.sys.mjs",
  SvalPreferences: "moz-src:///browser/components/sval/SvalPreferences.sys.mjs",
  ContentBlockingAllowList:
    "resource://gre/modules/ContentBlockingAllowList.sys.mjs",
  SvalPrivateJars: "moz-src:///browser/components/sval/SvalPrivateJars.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  RemoteSettings: "resource://services-settings/remote-settings.sys.mjs",
  SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
});

const PROTECTION_CSS = "chrome://browser/content/sval/sval-protection.css";
const SETTINGS_URL = "about:preferences#svalSites-sites";
/** Have I Been Pwned's breach list, as Firefox's site panel reads it. */
const BREACH_COLLECTION = "fxmonitor-breaches";
/**
 * Whether the panel warns of breaches. The list's Remote Settings entry
 * names this pref, so it syncs only while the pref is on.
 */
export const BREACH_WARNINGS_PREF = "browser.sval.breachWarnings";
const HIBP_URL = "https://haveibeenpwned.com";
const HTTPS_ONLY_PERMISSION = "https-only-load-insecure";

export const BUTTON_ID = "sval-protection-button";
export const PANEL_ID = "sval-protection-panel";

/**
 * A blocked embed's placeholder asks here when its button is clicked
 * (`smartblock-embed-prompt.patch`).
 */
const EMBED_CLICKED_TOPIC = "sval-smartblock-embed-clicked";
const EMBED_NOTIFICATION = "sval-smartblock-embed";
const EMBED_ANCHOR = "sval-smartblock-embed-anchor";

/**
 * The embeds the page's placeholders stand in for: Firefox's SmartBlock
 * embeds whose origins the tab's content-blocking log shows replaced and not
 * allowed, as `gProtectionsHandler` finds them for its panel's toggles.
 *
 * @param {Window} win
 * @param {Element} browser
 * @returns {object[]} entries of `gProtectionsHandler.smartblockEmbedInfo`.
 */
function replacedEmbeds(win, browser) {
  let log;
  try {
    log = JSON.parse(browser.getContentBlockingLog() || "{}");
  } catch {
    return [];
  }
  const { STATE_REPLACED_TRACKING_CONTENT, STATE_ALLOWED_TRACKING_CONTENT } =
    Ci.nsIWebProgressListener;
  const found = new Set();
  for (const [origin, actions] of Object.entries(log)) {
    const replaced = actions.some(
      ([flag]) => flag & STATE_REPLACED_TRACKING_CONTENT
    );
    const allowed = actions.some(
      ([flag]) => flag & STATE_ALLOWED_TRACKING_CONTENT
    );
    if (!replaced || allowed) {
      continue;
    }
    const embed = win.gProtectionsHandler.smartblockEmbedInfo.find(info =>
      new MatchPatternSet(info.matchPatterns).matches(origin)
    );
    if (embed) {
      found.add(embed);
    }
  }
  return [...found];
}

/**
 * What the tab's content-blocking log says: how many origins were blocked
 * and how many loaded that protections would have blocked, by the blockers
 * Firefox's shield uses, and which fingerprinting heuristics fired. A blocked
 * origin that Sval's ad lists blocked counts as an ad
 * (`SvalBlocking.adOriginsFor`), one blocked for probing as a fingerprinter,
 * and every other one as a tracker.
 *
 * @param {Window} win
 * @param {Element} browser
 * @returns {{blocked: number, ads: number, allowed: number,
 *   fingerprinting: number, canvas: boolean, fonts: boolean}}
 */
export function readLog(win, browser) {
  let log;
  try {
    log = JSON.parse(browser.getContentBlockingLog() || "{}");
  } catch {
    log = {};
  }
  const blockers = Object.values(win.gProtectionsHandler?.blockers ?? {});
  const {
    STATE_ALLOWED_CANVAS_FINGERPRINTING,
    STATE_ALLOWED_FONT_FINGERPRINTING,
    STATE_BLOCKED_SUSPICIOUS_FINGERPRINTING,
  } = Ci.nsIWebProgressListener;
  const adOrigins = lazy.SvalBlocking.adOriginsFor(browser);
  const result = {
    blocked: 0,
    ads: 0,
    allowed: 0,
    fingerprinting: 0,
    canvas: false,
    fonts: false,
  };
  for (const [origin, actions] of Object.entries(log)) {
    const suspicious = actions.some(
      ([state]) => state & STATE_BLOCKED_SUSPICIOUS_FINGERPRINTING
    );
    const states = actions
      .map(([state]) => state)
      .filter(s => !(s & STATE_BLOCKED_SUSPICIOUS_FINGERPRINTING));
    if (states.some(s => blockers.some(b => b.isBlocking(s)))) {
      if (adOrigins.has(origin)) {
        result.ads++;
      } else {
        result.blocked++;
      }
    } else if (states.some(s => blockers.some(b => b.isAllowing(s)))) {
      result.allowed++;
    }
    const canvas = states.some(s => s & STATE_ALLOWED_CANVAS_FINGERPRINTING);
    const fonts = states.some(s => s & STATE_ALLOWED_FONT_FINGERPRINTING);
    if (canvas || fonts || suspicious) {
      result.fingerprinting++;
    }
    result.canvas ||= canvas;
    result.fonts ||= fonts;
  }
  return result;
}

/**
 * Whether one of Mozilla's fingerprinting compatibility fixes covers the
 * site: `nsRFPService` holds an override for its first-party keys
 * (`GetOverriddenFingerprintingSettingsForURI`) and none of the site's local
 * granular entries, which win over the remote ones, put it there. Sval's own
 * exception entry carries the fix's tokens along, so with one the fix
 * applies when Mozilla has one for the site, unless the site's choice is
 * `"full"`, whose entry leaves them out. A private window reads no local
 * entry, so there the remote one applies whatever the local ones are.
 *
 * @param {string} site
 * @param {boolean} isPrivate
 * @returns {boolean}
 */
export function compatFixApplies(site, isPrivate) {
  if (!Services.prefs.getBoolPref(REMOTE_OVERRIDES_PREF, true)) {
    return false;
  }
  const forSite = names =>
    names
      .flatMap(name => readGranular(name))
      .filter(entry => entry?.firstPartyDomain === site);
  const own = forSite(OVERRIDE_PREFS);
  const foreign = forSite(GRANULAR_PREFS);
  if (!isPrivate && foreign.length) {
    return false;
  }
  const local = [...foreign, ...own];
  const fpp =
    Services.prefs.getBoolPref("privacy.fingerprintingProtection", false) ||
    (isPrivate &&
      Services.prefs.getBoolPref(
        "privacy.fingerprintingProtection.pbmode",
        false
      ));
  const baseline = fpp ? "0" : "1";
  if (local.length) {
    if (!isPrivate && SvalSiteProtections.protectionsFor(site) === "full") {
      return false;
    }
    return !!SvalSiteProtections.remoteTokensFor(site, !fpp).length;
  }
  return [`${site},${baseline}`, `${site},*,${baseline}`].some(key => {
    try {
      return !!Services.rfp.getFingerprintingOverrides(key);
    } catch {
      return false;
    }
  });
}

/**
 * What the selected page's connection is, as `gIdentityHandler` reads it
 * from the page's security state for Firefox's own site panel.
 *
 * `tone` names the colour a wrong connection gives the button: "http" for
 * no encryption, "exc" for a certificate the person chose to trust, "err"
 * for a certificate error or a blocked dangerous site. `loaded` is false
 * for an error page, which shows no protections because nothing loaded.
 *
 * @param {Window} win
 * @returns {{kind: string, tone: string|null, loaded: boolean}}
 */
export function connectionOf(win) {
  // A page with no web address of its own is internal only where Firefox
  // vouches for it: a privileged page of the browser's own, a file, or an
  // extension's page. Any other, such as a data: page, view-source or an
  // unprivileged about: page, is a page with no site, whose panel claims
  // nothing about it. An error page keeps the address it failed to load.
  const id = win.gIdentityHandler;
  const uri = win.gBrowser.currentURI;
  if (!uri.schemeIs("http") && !uri.schemeIs("https")) {
    const vouched =
      id._isSecureInternalUI ||
      id._isURILoadedFromFile ||
      !!id._pageExtensionPolicy;
    return { kind: vouched ? "internal" : "local", tone: null, loaded: true };
  }
  if (id._isAboutBlockedPage) {
    return { kind: "dangerous", tone: "err", loaded: false };
  }
  // Firefox words a potentially trustworthy origin, such as localhost, as it
  // words a file.
  switch (id.getConnectionSecurityInformation()) {
    case "file":
    case "secure":
    case "secure-ev":
    case "secure-etsi":
      if (id._isAboutNetErrorPage) {
        return { kind: "net-error", tone: null, loaded: false };
      }
      return id._isMixedPassiveContentLoaded
        ? { kind: "mixed", tone: "http", loaded: true }
        : { kind: "secure", tone: null, loaded: true };
    case "secure-cert-user-overridden":
      return { kind: "exception", tone: "exc", loaded: true };
    case "cert-error-page":
      return { kind: "cert-error", tone: "err", loaded: false };
    case "https-only-error-page":
      return { kind: "https-only-error", tone: "http", loaded: false };
    case "net-error-page":
      return { kind: "net-error", tone: null, loaded: false };
  }
  return { kind: "http", tone: "http", loaded: true };
}

/**
 * What the connection of a page that is not the selected one is.
 * `gIdentityHandler` holds the selected page's state alone, so this reads the
 * page's own security state (`securityUI.state`), as Firefox's split-view
 * footer does for a pane, and its error page from its document's address.
 * The answer is `connectionOf`'s, for a web address.
 *
 * @param {Element} browser
 * @returns {{kind: string, tone: string|null, loaded: boolean}|null} null for
 *   a page with no web address.
 */
export function connectionOfPage(browser) {
  const uri = browser.currentURI;
  if (!uri?.schemeIs("http") && !uri?.schemeIs("https")) {
    return null;
  }
  const doc = browser.documentURI;
  const error = doc?.schemeIs("about") ? doc.filePath : null;
  if (error === "blocked") {
    return { kind: "dangerous", tone: "err", loaded: false };
  }
  if (error === "certerror") {
    return { kind: "cert-error", tone: "err", loaded: false };
  }
  if (error === "httpsonlyerror") {
    return { kind: "https-only-error", tone: "http", loaded: false };
  }
  if (error === "neterror") {
    return { kind: "net-error", tone: null, loaded: false };
  }
  const state = browser.securityUI?.state ?? 0;
  const {
    STATE_IS_SECURE,
    STATE_CERT_USER_OVERRIDDEN,
    STATE_LOADED_MIXED_DISPLAY_CONTENT,
  } = Ci.nsIWebProgressListener;
  if (state & STATE_CERT_USER_OVERRIDDEN) {
    return { kind: "exception", tone: "exc", loaded: true };
  }
  if (state & STATE_IS_SECURE) {
    return state & STATE_LOADED_MIXED_DISPLAY_CONTENT
      ? { kind: "mixed", tone: "http", loaded: true }
      : { kind: "secure", tone: null, loaded: true };
  }
  return { kind: "http", tone: "http", loaded: true };
}

/** The word a wrong connection adds beside the button's shield. */
const CONNECTION_LABELS = {
  http: "Not secure",
  "https-only-error": "Not secure",
  "cert-error": "Not secure",
  dangerous: "Dangerous site",
};

/**
 * What an internal page is, for the panel's header.
 *
 * @param {Window} win
 * @returns {{kind: string, title: string, status: string, name?: string,
 *   line?: string, vouched: boolean}} For a page Firefox vouches for, `name` begins the
 *   button's accessible name and `line` is the panel's connection line.
 */
function internalOf(win) {
  const id = win.gIdentityHandler;
  const uri = win.gBrowser.currentURI;
  // The page's own title is never shown here: a page could name itself
  // after one of Sval's.
  if (
    !id._isSecureInternalUI &&
    !id._isURILoadedFromFile &&
    !id._pageExtensionPolicy
  ) {
    return {
      kind: "other",
      title: uri.schemeIs("about") ? uri.spec : `${uri.scheme}:`,
      status: "Not a website",
      vouched: false,
    };
  }
  if (id._pageExtensionPolicy) {
    return {
      kind: "extension",
      title: id._pageExtensionPolicy.name,
      status: "An extension's page",
      name: `${id._pageExtensionPolicy.name}, an extension's page`,
      line: "From an extension",
      vouched: true,
    };
  }
  if (id._isURILoadedFromFile) {
    return {
      kind: "file",
      title: "Local file",
      status: "On this device",
      name: "Local file",
      line: "A file on this device",
      vouched: true,
    };
  }
  return {
    kind: "sval",
    title: "Sval",
    status: "Sval's own page",
    name: "Sval page",
    line: "Built into Sval",
    vouched: true,
  };
}

/**
 * site -> its newest undismissed breach of the last year, or null. A lookup
 * that failed is kept as null too, so it is tried again, and logged again,
 * only once the list next syncs.
 */
const breaches = new Map();
/** site -> the callbacks waiting on the lookup under way. */
const breachLookups = new Map();
let breachSyncWatched = false;

/**
 * The site's newest breach of the last year that the person has not
 * dismissed, from the list as it is on this device, or undefined until the
 * lookup it starts has answered. Null while breach warnings are off, which
 * leaves the list unread.
 *
 * @param {string} site
 * @param {function(): void} onAnswer Called once the lookup under way for
 *   the site has answered.
 * @returns {object|null|undefined}
 */
export function breachFor(site, onAnswer) {
  if (!Services.prefs.getBoolPref(BREACH_WARNINGS_PREF, true)) {
    return null;
  }
  if (breaches.has(site)) {
    return breaches.get(site);
  }
  if (!breachSyncWatched) {
    breachSyncWatched = true;
    lazy.RemoteSettings(BREACH_COLLECTION).on("sync", () => breaches.clear());
  }
  const waiting = breachLookups.get(site);
  if (waiting) {
    waiting.add(onAnswer);
    return undefined;
  }
  const callbacks = new Set([onAnswer]);
  breachLookups.set(site, callbacks);
  lookUpBreach(site)
    .catch(err => {
      SvalLog.warn(`breach lookup failed: ${SvalLog.errorName(err)}`);
      return null;
    })
    .then(found => {
      breachLookups.delete(site);
      breaches.set(site, found);
      for (const callback of callbacks) {
        callback();
      }
    });
  return undefined;
}

/** Forgets every looked-up breach, so the next draw reads the list again. */
export function forgetBreaches() {
  breaches.clear();
}

let breachStorage = null;

function storage() {
  breachStorage ??= (async () => {
    const store = new lazy.BreachAlertStorage();
    await store.initialize();
    return store;
  })();
  return breachStorage;
}

/**
 * The list's entries are matched as Firefox's site panel matches them
 * (`gTrustPanelHandler`): by the site's registrable domain, breached within
 * the last year, and not dismissed.
 *
 * @param {string} site
 * @returns {Promise<object|null>}
 */
async function lookUpBreach(site) {
  // The list syncs on Remote Settings' own schedule, so looking a site up
  // never makes a request of its own.
  const list = await lazy.RemoteSettings(BREACH_COLLECTION).get({
    syncIfEmpty: false,
  });
  const yearAgo = Temporal.Now.plainDateISO().subtract({ years: 1 });
  const recent = list.filter(
    breach =>
      breach.Domain &&
      Services.eTLD.hasRootDomain(site, breach.Domain) &&
      isRecent(breach, yearAgo)
  );
  if (!recent.length) {
    return null;
  }
  const dismissed = new Set(
    (
      await (
        await storage()
      ).getBreachAlertDismissals(recent.map(breach => breach.Name))
    ).map(dismissal => dismissal.breachName)
  );
  const open = recent.filter(breach => !dismissed.has(breach.Name));
  open.sort((a, b) =>
    Temporal.PlainDate.compare(
      Temporal.PlainDate.from(b.BreachDate),
      Temporal.PlainDate.from(a.BreachDate)
    )
  );
  return open[0] ?? null;
}

/**
 * @param {object} breach An entry of the list.
 * @param {Temporal.PlainDate} since
 * @returns {boolean} Whether the entry's breach is dated `since` or later.
 *   An entry whose date does not parse is passed over, so it cannot fail
 *   the lookup of every other entry.
 */
function isRecent(breach, since) {
  try {
    return (
      Temporal.PlainDate.compare(
        Temporal.PlainDate.from(breach.BreachDate),
        since
      ) >= 0
    );
  } catch {
    return false;
  }
}

/**
 * @param {object} breach
 * @returns {string} The breach's month, as "March 2026".
 */
function breachMonth(breach) {
  return new Date(`${breach.BreachDate}T00:00:00`).toLocaleDateString(
    undefined,
    { month: "long", year: "numeric" }
  );
}

/**
 * Everything the button and panel draw for the selected tab, or null where
 * the button does not apply (a page with no site, such as `about:blank`).
 * Given another page of the window, such as a Quick Peek's (`SvalQuickPeek`), it
 * answers for that page, which shows a shield only on a web address.
 *
 * @param {Window} win
 * @param {Element} [browser] The page, the selected one by default.
 * @returns {object|null}
 */
export function stateOf(win, browser = win.gBrowser.selectedBrowser) {
  const isPrivate = lazy.PrivateBrowsingUtils.isBrowserPrivate(browser);
  const session = lazy.SvalPrivateJars.sessionOfBrowser(browser);
  const connection =
    browser === win.gBrowser.selectedBrowser
      ? connectionOf(win)
      : connectionOfPage(browser);
  if (!connection) {
    return null;
  }
  if (connection.kind === "internal" || connection.kind === "local") {
    return {
      browser,
      isPrivate,
      connection,
      internal: internalOf(win),
      look: "internal",
    };
  }
  const scope = scopeForURI(browser.currentURI);
  if (!scope) {
    return null;
  }
  const { site, host } = scope;
  const breach = breachFor(site, () => {
    if (!win.closed) {
      SvalProtectionButton.forWindow(win)?.update();
    }
  });
  if (!connection.loaded) {
    return {
      browser,
      site,
      host,
      scope,
      isPrivate,
      connection,
      breach,
      look: "error",
    };
  }
  if (!lazy.ContentBlockingAllowList.canHandle(browser)) {
    return null;
  }
  // Firefox's allow list is what Gecko reads, so an exception made before
  // Sval's store, or on one origin of the site, reads as off too.
  const stored = SvalSiteProtections.protectionsFor(host, session);
  const protections = lazy.ContentBlockingAllowList.includes(browser)
    ? "off"
    : stored;
  const log = readLog(win, browser);
  let look = "on";
  if (protections === "off") {
    look = "off";
  } else if (log.blocked || log.ads || log.fingerprinting) {
    look = "active";
  }
  return {
    browser,
    site,
    host,
    scope,
    isPrivate,
    session,
    connection,
    breach,
    protections,
    log,
    look,
    compat: protections === "on" && compatFixApplies(site, isPrivate),
  };
}

/**
 * @param {object} state From `stateOf`.
 * @returns {string} The button's accessible name.
 */
export function nameOf(state) {
  const name = protectionName(state);
  return state.breach
    ? `${name} · Data breach in ${breachMonth(state.breach)}`
    : name;
}

const CONNECTION_NAMES = {
  dangerous: "Dangerous site. Sval blocked it.",
  "cert-error": "Certificate error. Sval didn't load the page.",
  "https-only-error": "Connection not secure. Sval didn't load the page.",
  "net-error": "Page not loaded.",
};

function protectionName(state) {
  const { kind } = state.connection;
  if (state.internal) {
    return state.internal.vouched
      ? `${state.internal.name}. Protections don't apply.`
      : "Not a website. Protections don't apply.";
  }
  if (CONNECTION_NAMES[kind]) {
    return CONNECTION_NAMES[kind];
  }
  const prefix =
    {
      http: "Connection not secure. ",
      mixed: "Parts of this page aren't secure. ",
      exception: "You trust this site's certificate. Sval couldn't verify it. ",
    }[kind] ?? "";
  return prefix + pageName(state);
}

function pageName(state) {
  if (state.look === "off") {
    return "Protections off for this site";
  }
  const { blocked, ads, fingerprinting } = state.log;
  const counts = [
    blocked && `${blocked} ${blocked === 1 ? "tracker" : "trackers"}`,
    ads && `${ads} ${ads === 1 ? "ad" : "ads"}`,
  ].filter(Boolean);
  const parts = [
    counts.length && `${counts.join(" and ")} blocked`,
    fingerprinting &&
      `${fingerprinting} ${
        fingerprinting === 1 ? "fingerprinter" : "fingerprinters"
      } foiled`,
  ].filter(Boolean);
  return parts.length ? `Protections: ${parts.join(", ")}` : "Protections on";
}

/**
 * The foot of a site's panel: in a private window, how long its choices
 * last; otherwise that they sync, and a link to manage sites.
 *
 * @param {Document} doc
 * @param {boolean} isPrivate
 * @param {object} linkProps The link's own `el` properties.
 * @param {Function} onManage Runs when the link is clicked.
 * @returns {Element}
 */
export function protectionFooter(doc, isPrivate, linkProps, onManage) {
  if (isPrivate) {
    return htmlElement(
      doc,
      "div",
      { className: "sval-prot-footer" },
      htmlElement(
        doc,
        "span",
        {},
        "Choices made in private windows last until you close them, and never sync."
      )
    );
  }
  const link = htmlElement(
    doc,
    "a",
    { ...linkProps, href: "#" },
    "Manage sites"
  );
  link.addEventListener("click", event => {
    event.preventDefault();
    onManage();
  });
  return htmlElement(
    doc,
    "div",
    { className: "sval-prot-footer" },
    htmlElement(doc, "span", {}, "Your choices sync to all your devices."),
    link
  );
}

/**
 * @param {Document} doc
 * @param {string} name A protection icon's name.
 * @param {string} [className]
 * @returns {Element}
 */
export function glyph(doc, name, className = "") {
  return htmlElement(doc, "span", {
    className: `sval-prot-glyph ${className}`.trim(),
    dataset: { icon: name },
    attrs: { "aria-hidden": "true" },
  });
}

/** The glyph each look draws. */
const SHIELDS = {
  on: "pr-shield",
  off: "pr-shield-off",
  active: "pr-shield-fill",
  internal: "sc-shield-plain",
  error: "sc-shield-alert",
};

/**
 * @param {object} state From `stateOf`.
 * @returns {string} The glyph the button and the panel's tile draw.
 */
export function shieldOf(state) {
  return state.connection.tone ? "sc-shield-alert" : SHIELDS[state.look];
}

/**
 * @param {nsIX509Cert} cert
 * @returns {string} The certificate's validity, as "2 Sep – 1 Dec 2026".
 */
function validityOf(cert) {
  const { notBefore, notAfter } = cert.validity;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatRange(new Date(notBefore / 1000), new Date(notAfter / 1000));
}

const TLS_VERSIONS = ["SSL 3", "TLS 1.0", "TLS 1.1", "TLS 1.2", "TLS 1.3"];

/**
 * @param {nsITransportSecurityInfo} info
 * @returns {string} The protocol and the cipher, as "TLS 1.3 · AES-128-GCM".
 */
function encryptionOf(info) {
  // A suite's name, such as TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256 or
  // TLS_AES_128_GCM_SHA256, carries the cipher between its key exchange and
  // its hash.
  const cipher = (info.cipherName ?? "")
    .replace(/^TLS_(.*_WITH_)?/, "")
    .replace(/_SHA\d*$/, "")
    .replaceAll("_", "-");
  return [TLS_VERSIONS[info.protocolVersion], cipher]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A choice of one among a few, as a segmented row of native radios, which
 * give it one Tab stop and arrow keys that move the choice.
 *
 * @param {Document} doc
 * @param {string} name The group's name, unique in the window.
 * @param {string} label The group's accessible name.
 * @param {{value: string, text: string, title?: string}[]} choices
 * @param {string} current The checked choice's value.
 * @param {function(string): void} pick Called with a newly checked value.
 * @returns {Element}
 */
export function segments(doc, name, label, choices, current, pick) {
  const group = htmlElement(doc, "div", {
    className: "sval-prot-segments",
    attrs: { role: "radiogroup", "aria-label": label },
  });
  for (const { value, text, title } of choices) {
    const radio = htmlElement(doc, "input", {
      type: "radio",
      className: "sval-prot-radio",
      name: `sval-prot-${name}`,
      id: `sval-prot-${name}-${value}`,
      value,
      checked: value === current,
    });
    radio.addEventListener("change", () => pick(value));
    const seg = htmlElement(
      doc,
      "label",
      { className: "sval-prot-segment", dataset: { value } },
      radio,
      text
    );
    if (title) {
      seg.title = title;
    }
    group.append(seg);
  }
  return group;
}

/**
 * One window's button and panel.
 */
export class ProtectionButton {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    this.button = null;
    this.panel = null;
    /** Whether the panel moves the focus into itself once it shows. */
    this.focusOnShow = false;
    /**
     * The tab whose page the panel had the focus over as it began to close,
     * or null when the focus was elsewhere.
     */
    this.returnFocusTo = null;
    /** "main", or "connection" while the certificate view shows. */
    this.view = "main";
    /**
     * The scope the panel's choices are saved at, picked in its title, or
     * null for the page's host, where the panel opens.
     */
    this.picked = null;
  }

  /**
   * @param {object} state From `stateOf`, or the site menu's `mediaOf`.
   * @returns {string} The name the panel's choices are saved at.
   */
  scopeAt(state) {
    return this.picked === state.site ? state.site : state.host;
  }

  mount() {
    const { doc, win } = this;
    const anchor = win.gURLBar?.querySelector(".searchmode-switcher");
    if (!anchor) {
      return false;
    }
    win.windowUtils.loadSheetUsingURIString(
      PROTECTION_CSS,
      win.windowUtils.AUTHOR_SHEET
    );

    const button = htmlElement(doc, "div", {
      id: BUTTON_ID,
      tabIndex: 0,
      attrs: {
        role: "button",
        "aria-haspopup": "dialog",
        "aria-expanded": "false",
      },
    });
    button.append(
      glyph(doc, "pr-shield", "sval-prot-shield"),
      htmlElement(doc, "span", {
        className: "sval-prot-dot",
        attrs: { "aria-hidden": "true" },
      }),
      htmlElement(doc, "span", {
        className: "sval-prot-count",
        attrs: { "aria-hidden": "true" },
      }),
      htmlElement(doc, "span", {
        className: "sval-prot-label-word",
        attrs: { "aria-hidden": "true" },
      })
    );
    // The address field takes focus on a mousedown anywhere in its pill.
    button.addEventListener("mousedown", event => {
      event.stopPropagation();
      event.preventDefault();
    });
    button.addEventListener("click", event => {
      if (event.button === 0) {
        this.open({
          focus: event.inputSource === win.MouseEvent.MOZ_SOURCE_KEYBOARD,
        });
      }
    });
    button.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        this.open({ focus: true });
      }
    });
    // `PopupNotifications` anchors a prompt outside its icon box only to a XUL
    // element (`getAnchorFromBrowser`).
    this.promptAnchor = doc.createXULElement("box");
    this.promptAnchor.className = "sval-prot-prompt-anchor";
    button.append(this.promptAnchor);
    anchor.before(button);
    this.button = button;

    const panel = doc.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.setAttribute("type", "arrow");
    // The panel hangs past the button's outer edge, and the button stands
    // near the window's; a slide keeps it whole at the screen's edge
    // (`nsMenuPopupFrame::SlideOrResize`) where a flip would narrow it.
    panel.setAttribute("flip", "slide");
    panel.setAttribute("orient", "vertical");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Protections");
    // Gecko blurs whatever has the focus as a panel shows and again as it
    // hides (`nsXULPopupManager`, the `noautofocus` checks), so the panel
    // places it itself both ways. Opened from the keyboard it focuses its
    // first control, as `PanelMultiView.openPopup` does for a keyboard
    // trigger, through the call `PopupNotifications` uses. Closed while the
    // focus was in it, the focus goes back to the button, unless something
    // else took it or another tab is showing.
    panel.addEventListener("popupshown", () => {
      button.setAttribute("open", "true");
      button.setAttribute("aria-expanded", "true");
      if (this.focusOnShow) {
        this.focusOnShow = false;
        doc.commandDispatcher.advanceFocusIntoSubtree(panel);
      }
    });
    // Esc in the certificate view goes back to the main view; a further
    // Esc closes the panel. The popup manager closes an open panel on Esc from its
    // listener on the document (`nsXULPopupManager::KeyDown`), so this
    // listens on the window, which sees the key first.
    win.addEventListener(
      "keydown",
      event => {
        if (
          event.key !== "Escape" ||
          panel.state !== "open" ||
          !panel.contains(doc.activeElement) ||
          this.view === "main"
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.showMain();
      },
      { capture: true }
    );
    panel.addEventListener("popuphiding", () => {
      this.returnFocusTo = panel.contains(doc.activeElement)
        ? win.gBrowser.selectedTab
        : null;
    });
    panel.addEventListener("popuphidden", () => {
      button.removeAttribute("open");
      button.setAttribute("aria-expanded", "false");
      this.focusOnShow = false;
      this.view = "main";
      this.picked = null;
      const tab = this.returnFocusTo;
      this.returnFocusTo = null;
      if (
        tab === win.gBrowser.selectedTab &&
        !doc.commandDispatcher.focusedElement &&
        !button.hidden
      ) {
        button.focus();
      }
    });
    doc.getElementById("mainPopupSet").append(panel);
    this.panel = panel;

    const progress = {
      onLocationChange: (browser, webProgress, request, location, flags) =>
        this.onLocationChange(browser, webProgress, flags),
      onStateChange: (browser, webProgress, request, flags) =>
        this.onStateChange(browser, webProgress, request, flags),
      onContentBlockingEvent: browser => {
        if (browser === win.gBrowser.selectedBrowser) {
          this.update();
        }
      },
      // `gBrowser` calls the window's own listeners first, so
      // `gIdentityHandler` holds the new state by the time this runs.
      onSecurityChange: browser => {
        if (browser === win.gBrowser.selectedBrowser) {
          this.update();
        }
      },
    };
    win.gBrowser.addTabsProgressListener(progress);
    // Gecko calls `onContentBlockingEvent` only when the page's set of
    // blocking states changes (`ContentBlockingLog::RecordLogParent`), so a
    // second tracker blocked calls nothing. The classifier service tells its
    // listeners of every channel it is about to block, and the block enters
    // the log in the same task (`ChannelClassifierUtils::MaybeBlockChannel`),
    // so the button reads the log in the next one, once for a burst.
    let recounting = false;
    const blocked = {
      observe: subject => {
        let browserId;
        try {
          browserId = subject.QueryInterface(
            Ci.nsIUrlClassifierBlockedChannel
          ).browserId;
        } catch {
          // A channel with no browsing context, such as a service worker's.
          return;
        }
        if (
          recounting ||
          browserId !== win.gBrowser.selectedBrowser.browserId
        ) {
          return;
        }
        recounting = true;
        Services.tm.dispatchToMainThread(() => {
          recounting = false;
          if (!win.closed) {
            this.update({ counts: true });
          }
        });
      },
    };
    const classifier = Cc[
      "@mozilla.org/url-classifier/channel-classifier-service;1"
    ].getService(Ci.nsIChannelClassifierService);
    classifier.addListener(blocked);
    // A block the classifier did not make, such as a tracker's cookies,
    // reaches the log with no signal; the name is read again when it is
    // about to be shown or spoken.
    const onSelect = () => this.update();
    const recount = () => this.update({ counts: true });
    button.addEventListener("mouseenter", recount);
    button.addEventListener("focus", recount);
    win.gBrowser.tabContainer.addEventListener("TabSelect", onSelect);
    // The choices as Gecko's stores hold them, which they do only once
    // `SvalSiteProtections` has applied the branch.
    Services.obs.addObserver(onSelect, APPLIED_TOPIC);
    Services.prefs.addObserver(BREACH_WARNINGS_PREF, onSelect);
    const onEmbed = context => this.askToAllowEmbeds(context);
    Services.obs.addObserver(onEmbed, EMBED_CLICKED_TOPIC);
    win.addEventListener(
      "unload",
      () => {
        win.gBrowser.removeTabsProgressListener(progress);
        classifier.removeListener(blocked);
        Services.obs.removeObserver(onSelect, APPLIED_TOPIC);
        Services.obs.removeObserver(onEmbed, EMBED_CLICKED_TOPIC);
        Services.prefs.removeObserver(BREACH_WARNINGS_PREF, onSelect);
      },
      { once: true }
    );
    this.update();
    return true;
  }

  /**
   * A top-level page started to load: the page's origin takes its site's
   * media choice before its document exists, because Gecko matches the
   * media permission to the exact origin.
   *
   * @param {Element} browser
   * @param {nsIWebProgress} webProgress
   * @param {nsIRequest} request
   * @param {number} flags
   */
  onStateChange(browser, webProgress, request, flags) {
    const { STATE_START, STATE_IS_DOCUMENT } = Ci.nsIWebProgressListener;
    if (
      !webProgress?.isTopLevel ||
      !(flags & STATE_START) ||
      !(flags & STATE_IS_DOCUMENT)
    ) {
      return;
    }
    let uri;
    try {
      uri = request.QueryInterface(Ci.nsIChannel).URI;
    } catch {
      return;
    }
    if (!uri?.schemeIs("http") && !uri?.schemeIs("https")) {
      return;
    }
    SvalSiteProtections.coverOrigin(
      Services.scriptSecurityManager.createContentPrincipal(
        uri,
        browser.browsingContext?.originAttributes ?? {}
      )
    );
  }

  /**
   * A new page: its origin takes its site's media choice.
   *
   * @param {Element} browser
   * @param {nsIWebProgress} webProgress
   * @param {number} flags
   */
  onLocationChange(browser, webProgress, flags) {
    if (
      !webProgress?.isTopLevel ||
      flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
    ) {
      return;
    }
    if (browser.contentPrincipal?.isContentPrincipal) {
      SvalSiteProtections.coverOrigin(browser.contentPrincipal);
    }
    if (browser === this.win.gBrowser.selectedBrowser) {
      this.update();
    }
  }

  /**
   * Draws the button for the selected tab, and the panel if it is open.
   *
   * @param {object} [options]
   * @param {boolean} [options.counts] Only the log moved: an open panel
   *   redraws its counts alone, which hold no control, so the control the
   *   user is on keeps its focus however often the page blocks.
   */
  update({ counts = false } = {}) {
    const state = stateOf(this.win);
    const button = this.button;
    if (!button) {
      return;
    }
    button.hidden = !state;
    if (!state) {
      if (this.panel.state !== "closed") {
        this.panel.hidePopup();
      }
      return;
    }
    button.dataset.look = state.look;
    button.dataset.tone = state.connection.tone ?? "";
    button.dataset.connection = state.connection.kind;
    button.dataset.page = state.internal?.kind ?? "";
    button
      .querySelector(".sval-prot-shield")
      .setAttribute("data-icon", shieldOf(state));
    const word = CONNECTION_LABELS[state.connection.kind] ?? "";
    button.querySelector(".sval-prot-label-word").textContent = word;
    button.toggleAttribute("sval-label", !!word);
    button.toggleAttribute("sval-breach", !!state.breach);
    // The sum of the panel's rows, as the name counts them. A breach's dot
    // takes the same corner and outranks it (header signals spec §1).
    const { log } = state;
    const done =
      state.look === "active" ? log.blocked + log.ads + log.fingerprinting : 0;
    const count = state.breach ? 0 : done;
    button.querySelector(".sval-prot-count").textContent =
      count > 99 ? "99+" : String(count);
    button.toggleAttribute("sval-count", !!count);
    button.toggleAttribute("sval-count-wide", count > 9);
    const name = nameOf(state);
    button.setAttribute("aria-label", name);
    button.setAttribute("title", name);
    if (this.panel.state === "closed") {
      return;
    }
    if (counts && this.view !== "main") {
      return;
    }
    const rows = counts && this.panel.querySelector(".sval-prot-rows");
    if (rows) {
      rows.replaceWith(this.rows(state));
    } else {
      this.render(state);
    }
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.focus] Whether the panel takes the focus once
   *   it shows.
   */
  open({ focus = false } = {}) {
    const state = stateOf(this.win);
    if (!state) {
      return;
    }
    this.render(state);
    if (this.panel.state === "closed") {
      this.focusOnShow = focus;
    }
    this.panel.openPopup(this.button, {
      position: "bottomleft topleft",
      y: 6,
      triggerEvent: null,
    });
  }

  close() {
    this.panel.hidePopup();
  }

  /**
   * Asks, on the button, whether to let the page's blocked embeds load. The
   * page's placeholder button only asks: a page can send its shim's messages
   * itself (`Shims._onMessageFromShim`), so the choice is made here, where
   * the page cannot reach. Allowing sends Firefox's own unblock for each
   * embed, which the webcompat extension answers by opting the site in and
   * putting the embed back (`onSmartBlockEmbedUnblock`).
   *
   * @param {BrowsingContext} context The clicked page's top context.
   */
  askToAllowEmbeds(context) {
    const { win } = this;
    const browser = context?.embedderElement;
    if (!browser || browser !== win.gBrowser.selectedBrowser) {
      return;
    }
    const embeds = replacedEmbeds(win, browser);
    if (!embeds.length) {
      return;
    }
    const names = new Intl.ListFormat("en", { type: "conjunction" }).format(
      embeds.map(embed => embed.displayName)
    );
    browser[`${EMBED_ANCHOR}popupnotificationanchor`] = this.promptAnchor;
    win.PopupNotifications.show(
      browser,
      EMBED_NOTIFICATION,
      `Allow ${names} on ${browser.currentURI.displayHost}?`,
      EMBED_ANCHOR,
      {
        label: "Allow",
        accessKey: "A",
        callback() {
          const tab = win.gBrowser.getTabForBrowser(browser);
          for (const { shimId } of embeds) {
            Services.obs.notifyObservers(
              tab,
              "smartblock:unblock-embed",
              shimId
            );
          }
        },
      },
      [{ label: "Not now", accessKey: "N", callback() {} }],
      {
        popupIconURL:
          "chrome://browser/content/sval/protection-icons/pr-shield.svg",
        removeOnDismissal: true,
      }
    );
  }

  /** @param {object} state From `stateOf`. */
  render(state) {
    // A page with no certificate to show, reached while the view was open,
    // goes back to the main view.
    if (
      this.view === "connection" &&
      (state.internal || state.connection.kind === "net-error")
    ) {
      this.view = "main";
    }
    const body =
      this.view === "connection"
        ? this.connectionView(state)
        : this.mainView(state);
    // A choice, and the reload a switch makes, redraw the panel while it
    // stays open; the focus stays on the control it was on, which keeps its
    // id across a redraw.
    const focused = this.panel.querySelector(":focus")?.id;
    this.panel.replaceChildren(body);
    if (focused) {
      this.doc.getElementById(focused)?.focus();
    }
  }

  mainView(state) {
    const { doc } = this;
    const body = htmlElement(doc, "div", { className: "sval-prot-body" });
    body.dataset.look = state.look;
    body.dataset.tone = state.connection.tone ?? "";
    body.dataset.connection = state.connection.kind;
    body.dataset.page = state.internal?.kind ?? "";
    body.append(this.header(state), this.connectionLine(state));
    const card = this.connectionCard(state);
    if (card) {
      body.append(card);
    }
    if (state.breach) {
      body.append(this.breachCard(state));
    }
    if (state.internal) {
      body.append(this.internalWell(state));
      return body;
    }
    if (!state.connection.loaded) {
      return body;
    }
    body.append(this.rows(state));
    if (state.compat) {
      body.append(this.compatLine());
    }
    body.append(this.switches(state), this.footer(state));
    return body;
  }

  header(state) {
    const { doc } = this;
    let title = state.site;
    let status =
      state.protections === "off"
        ? "Protections off for this site"
        : "Protections on";
    if (state.internal) {
      ({ title, status } = state.internal);
    } else if (!state.connection.loaded) {
      status = "Page not loaded";
    } else if (state.scope.choice) {
      title = this.scopeDropdown(state).root;
    }
    const head = htmlElement(
      doc,
      "div",
      { className: "sval-prot-head" },
      htmlElement(
        doc,
        "span",
        { className: "sval-prot-tile" },
        glyph(doc, shieldOf(state))
      ),
      htmlElement(
        doc,
        "div",
        { className: "sval-prot-head-words" },
        typeof title == "string"
          ? htmlElement(doc, "span", { className: "sval-prot-domain" }, title)
          : title,
        htmlElement(doc, "span", { className: "sval-prot-status" }, status)
      )
    );
    const keeps =
      typeof title != "string" && this.scopeAt(state) === state.site
        ? this.keeps(state)
        : null;
    if (!keeps) {
      return head;
    }
    const wrap = doc.createDocumentFragment();
    wrap.append(
      head,
      htmlElement(
        doc,
        "span",
        { className: "sval-scope-keeps", id: "sval-prot-keeps" },
        keeps
      )
    );
    return wrap;
  }

  /**
   * The panel's title on a host with a choice of scope (host-scoped rules
   * spec §4). Picking redraws the panel in place.
   *
   * @param {object} state From `stateOf`.
   * @returns {ScopeDropdown}
   */
  scopeDropdown(state) {
    return new ScopeDropdown(this.doc, {
      id: "sval-prot-scope",
      choices: scopeChoices(state.scope),
      current: this.scopeAt(state),
      onPick: name => {
        this.picked = name;
        const now = stateOf(this.win);
        if (now) {
          this.render(now);
        }
      },
    }).listen();
  }

  /**
   * @param {object} state From `stateOf`.
   * @returns {?string} The line naming the protections choice the host
   *   keeps at the site's scope, or null where it keeps none.
   */
  keeps(state) {
    const own = SvalSiteProtections.ruleFor(
      state.host,
      state.session
    ).protections;
    if (own === undefined) {
      return null;
    }
    return keepsLine(state.host, [
      own === "fingerprinting" ? "fingerprinting" : "protections",
    ]);
  }

  /**
   * The connection's line under the header, which opens the certificate
   * view. An internal page's line only says what the page is.
   *
   * @param {object} state From `stateOf`.
   */
  connectionLine(state) {
    const { doc } = this;
    const text = {
      secure: "Connection secure",
      http: "Connection not secure",
      mixed: "Parts of this page aren't secure",
      exception: "Certificate exception",
      "cert-error": "Certificate error",
      "https-only-error": "Connection not secure",
      dangerous: "Dangerous site",
      "net-error": "Not connected",
      internal: state.internal?.line,
      local: "No connection to show",
    }[state.connection.kind];
    const icon = state.connection.tone ? "sc-shield-alert" : "sc-cert";
    const opens = !state.internal && state.connection.kind !== "net-error";
    const line = htmlElement(
      doc,
      opens ? "button" : "div",
      {
        className: "sval-prot-conn",
        id: "sval-prot-conn",
        ...(opens ? { type: "button" } : {}),
      },
      glyph(doc, icon, "sval-prot-conn-icon"),
      htmlElement(doc, "span", { className: "sval-prot-conn-text" }, text),
      opens ? glyph(doc, "sc-next", "sval-prot-next") : null
    );
    if (opens) {
      line.addEventListener("click", () => this.showConnection());
    }
    return line;
  }

  /**
   * The warning a wrong connection shows first in the panel.
   *
   * @param {object} state From `stateOf`.
   * @returns {Element|null}
   */
  connectionCard(state) {
    const words = {
      http: [
        "This connection isn't private",
        "Anything you type here, like passwords or card numbers, can be read or changed by others on the network.",
      ],
      mixed: [
        "Parts of this page aren't private",
        "Some images or media on this page load without encryption, so others on the network can see or change them.",
      ],
      exception: [
        "You chose to trust this certificate",
        "Sval couldn't verify who runs this site.",
      ],
      "cert-error": [
        "Sval didn't load this page",
        "Sval couldn't verify this site's certificate. Someone may be pretending to be the site.",
      ],
      "https-only-error": [
        "Sval didn't load this page",
        "This site doesn't offer a secure connection, and HTTPS-Only Mode is on.",
      ],
      dangerous: [
        "Sval blocked this site",
        "It's reported to steal information or install harmful software.",
      ],
    }[state.connection.kind];
    if (!words) {
      return null;
    }
    const { doc } = this;
    return htmlElement(
      doc,
      "div",
      { className: "sval-prot-card", attrs: { role: "alert" } },
      glyph(doc, "sc-alert", "sval-prot-card-icon"),
      htmlElement(
        doc,
        "div",
        { className: "sval-prot-card-words" },
        htmlElement(
          doc,
          "span",
          { className: "sval-prot-card-title" },
          words[0]
        ),
        htmlElement(doc, "span", { className: "sval-prot-card-body" }, words[1])
      )
    );
  }

  /**
   * The site's breach, with Have I Been Pwned named as its source, which its
   * license (CC BY 4.0) asks wherever its data shows.
   *
   * @param {object} state From `stateOf`.
   */
  breachCard(state) {
    const { doc } = this;
    const { breach } = state;
    const meta = [breachMonth(breach)];
    if (breach.PwnCount) {
      meta.push(
        `${new Intl.NumberFormat(undefined, {
          notation: "compact",
          compactDisplay: "long",
          maximumFractionDigits: 1,
        }).format(breach.PwnCount)} accounts`
      );
    }
    const classes = (breach.DataClasses ?? []).map((name, i) =>
      i ? name.toLowerCase() : name
    );
    const exposed = classes.length
      ? `${new Intl.ListFormat(undefined, { type: "conjunction" }).format(classes)} were exposed. `
      : "";
    const source = htmlElement(
      doc,
      "a",
      { className: "sval-prot-link", href: HIBP_URL, id: "sval-prot-hibp" },
      "Have I Been Pwned"
    );
    source.addEventListener("click", event => {
      event.preventDefault();
      this.close();
      this.win.openTrustedLinkIn(HIBP_URL, "tab");
    });
    const dismiss = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-prot-dismiss",
        id: "sval-prot-breach-dismiss",
        attrs: { "aria-label": "Dismiss" },
      },
      glyph(doc, "sc-x")
    );
    dismiss.addEventListener("click", () => this.dismissBreach(state));
    return htmlElement(
      doc,
      "div",
      { className: "sval-prot-breach", attrs: { role: "alert" } },
      glyph(doc, "sc-key", "sval-prot-breach-icon"),
      htmlElement(
        doc,
        "div",
        { className: "sval-prot-card-words" },
        htmlElement(
          doc,
          "span",
          { className: "sval-prot-breach-title" },
          "This site had a data breach"
        ),
        htmlElement(
          doc,
          "span",
          { className: "sval-prot-breach-meta" },
          meta.join(" · ")
        ),
        htmlElement(
          doc,
          "span",
          { className: "sval-prot-card-body" },
          `${exposed}If you have an account here, change its password.`
        ),
        htmlElement(
          doc,
          "span",
          { className: "sval-prot-breach-source" },
          "Data from ",
          source
        )
      ),
      dismiss
    );
  }

  async dismissBreach(state) {
    const name = state.breach.Name;
    try {
      await (
        await storage()
      ).setBreachAlertDismissals([
        { breachName: name, timeDismissed: Date.now() },
      ]);
    } catch (err) {
      SvalLog.warn(`breach dismissal failed: ${SvalLog.errorName(err)}`);
      return;
    }
    forgetBreaches();
    this.update();
  }

  internalWell(state) {
    const { doc } = this;
    return htmlElement(
      doc,
      "div",
      { className: "sval-prot-well sval-prot-compat sval-prot-internal" },
      glyph(doc, "pr-info", "sval-prot-info"),
      htmlElement(
        doc,
        "span",
        {},
        state.internal.vouched
          ? "Blocking and site controls don't apply to Sval's own pages, local files or extensions. Nothing on this page reaches the network unless you ask it to."
          : "This page has no web address, so blocking and site controls don't apply to it."
      )
    );
  }

  showConnection() {
    this.view = "connection";
    this.update();
    this.doc.getElementById("sval-prot-back")?.focus();
  }

  showMain() {
    this.view = "main";
    this.update();
    this.doc.getElementById("sval-prot-conn")?.focus();
  }

  /**
   * The certificate view, drawn from what `gIdentityHandler` holds for the
   * page: the certificate the connection presented and how it is
   * encrypted.
   *
   * @param {object} state From `stateOf`.
   */
  connectionView(state) {
    const { doc, win } = this;
    const id = win.gIdentityHandler;
    const { kind, tone } = state.connection;
    const body = htmlElement(doc, "div", {
      className: "sval-prot-body sval-prot-subview",
    });
    body.dataset.tone = tone ?? "";
    const back = htmlElement(
      doc,
      "button",
      {
        type: "button",
        className: "sval-prot-back",
        id: "sval-prot-back",
        attrs: { "aria-label": "Back" },
      },
      glyph(doc, "sc-back")
    );
    back.addEventListener("click", () => this.showMain());
    body.append(
      htmlElement(
        doc,
        "div",
        { className: "sval-prot-subhead" },
        back,
        htmlElement(
          doc,
          "span",
          { className: "sval-prot-subhead-domain" },
          state.site
        )
      )
    );

    const cert = id._secInfo?.serverCert ?? null;
    const [title, sub] = {
      secure: [
        "Connection secure",
        `This is ${state.site}, and what you send is encrypted.`,
      ],
      mixed: [
        "Parts of this page aren't secure",
        "The page is encrypted, but some of its images or media are not.",
      ],
      exception: [
        "You trust this certificate",
        "Sval couldn't verify it. You added an exception for this site.",
      ],
      http: [
        "Connection not secure",
        `${state.site} doesn't use HTTPS. Anything you send can be read on the network.`,
      ],
      "cert-error": [
        "Certificate error",
        "Sval couldn't verify this site's certificate, so it didn't load the page.",
      ],
      "https-only-error": [
        "Connection not secure",
        `${state.site} doesn't offer HTTPS, so Sval didn't load it.`,
      ],
      dangerous: [
        "Dangerous site",
        "This site is reported as harmful, so Sval didn't load it.",
      ],
    }[kind];
    body.append(
      htmlElement(
        doc,
        "div",
        { className: "sval-prot-cert-head" },
        htmlElement(
          doc,
          "span",
          { className: "sval-prot-tile" },
          glyph(doc, tone ? "sc-shield-alert" : "sc-cert")
        ),
        htmlElement(
          doc,
          "div",
          { className: "sval-prot-head-words" },
          htmlElement(doc, "span", { className: "sval-prot-domain" }, title),
          htmlElement(doc, "span", { className: "sval-prot-card-body" }, sub)
        )
      )
    );

    const details = htmlElement(doc, "div", { className: "sval-prot-details" });
    const detail = (name, key, value, warn = false) =>
      details.append(
        htmlElement(doc, "span", { className: "sval-prot-detail-key" }, key),
        htmlElement(
          doc,
          "span",
          {
            className: warn
              ? "sval-prot-detail-value sval-prot-tone"
              : "sval-prot-detail-value",
            dataset: warn ? { detail: name, warn: "" } : { detail: name },
          },
          value
        )
      );
    const verified = kind === "secure" || kind === "mixed";
    if (cert) {
      detail(
        "verified",
        "Verified as",
        verified ? cert.organization || state.site : "Not verified",
        !verified
      );
      const selfSigned = cert.issuerName === cert.subjectName;
      detail(
        "issuer",
        "Issued by",
        selfSigned
          ? `${cert.commonName || state.site} (self-signed)`
          : [cert.issuerOrganization, cert.issuerCommonName]
              .filter(Boolean)
              .join(" · ")
      );
      detail("validity", "Valid", validityOf(cert));
      detail("encryption", "Encryption", encryptionOf(id._secInfo));
    } else {
      detail("verified", "Verified as", "Not verified", true);
      detail("encryption", "Encryption", "None", true);
    }
    body.append(details);

    if (
      id._isHttpsOnlyModeActive(state.isPrivate) &&
      id._getHttpsOnlyPermission() > 0
    ) {
      body.append(this.httpsOnlySwitch());
      const host = this.httpPrincipal().host;
      if (
        !state.isPrivate &&
        id._getHttpsOnlyPermission() === 2 &&
        SvalSiteProtections.canChooseFor(host)
      ) {
        body.append(this.httpsOnlyAlways(host));
      }
    }
    if (kind === "exception") {
      const remove = htmlElement(
        doc,
        "button",
        {
          type: "button",
          className: "sval-prot-pill sval-prot-secondary sval-prot-remove",
          id: "sval-prot-remove-exception",
        },
        "Remove certificate exception"
      );
      remove.addEventListener("click", () => {
        this.close();
        id.removeCertException();
      });
      body.append(
        htmlElement(
          doc,
          "div",
          { className: "sval-prot-remove-row" },
          remove,
          htmlElement(
            doc,
            "span",
            { className: "sval-prot-hint" },
            "Sval will warn you again and stop loading this site."
          )
        )
      );
    }
    const more = htmlElement(
      doc,
      "button",
      { type: "button", className: "sval-prot-action", id: "sval-prot-more" },
      htmlElement(
        doc,
        "span",
        { className: "sval-prot-action-label" },
        "More information"
      ),
      htmlElement(
        doc,
        "span",
        { className: "sval-prot-muted sval-prot-sub" },
        "Page Info"
      ),
      glyph(doc, "sc-external", "sval-prot-external")
    );
    more.addEventListener("click", () => {
      this.close();
      win.displaySecurityInfo();
    });
    body.append(
      htmlElement(doc, "div", { className: "sval-prot-clear" }, more)
    );
    return body;
  }

  /**
   * The HTTPS-Only switch, shown off where the site has an exception from
   * HTTPS-Only Mode. Turning it on removes the exception and reloads, as
   * Firefox's site panel does (`gIdentityHandler.changeHttpsOnlyPermission`).
   */
  /**
   * @returns {nsIPrincipal} The http origin of the tab's page, which holds
   *   HTTPS-Only Mode's exception: HTTPS-Only checks it before it upgrades a
   *   load.
   */
  httpPrincipal() {
    const { gBrowser } = this.win;
    let uri = gBrowser.currentURI;
    if (uri instanceof Ci.nsINestedURI) {
      uri = uri.QueryInterface(Ci.nsINestedURI).innermostURI;
    }
    return Services.scriptSecurityManager.createContentPrincipal(
      uri.mutate().setScheme("http").finalize(),
      gBrowser.contentPrincipal.originAttributes
    );
  }

  /**
   * Turns the exception the warning page made until quit into one saved for
   * the host on every device (`SvalSiteProtections.setInsecure`).
   *
   * @param {string} host
   * @returns {Element}
   */
  httpsOnlyAlways(host) {
    const always = htmlElement(
      this.doc,
      "button",
      {
        type: "button",
        className: "sval-prot-pill sval-prot-secondary",
        id: "sval-prot-https-only-always",
      },
      "Always open this site without a warning"
    );
    always.addEventListener("click", () => {
      SvalSiteProtections.setInsecure(host, true);
      this.close();
    });
    return htmlElement(
      this.doc,
      "div",
      { className: "sval-prot-remove-row" },
      always
    );
  }

  httpsOnlySwitch() {
    const { doc, win } = this;
    const saved = SvalSiteProtections.insecureFor(this.httpPrincipal().host);
    const line = htmlElement(
      doc,
      "span",
      { className: "sval-prot-sub" },
      saved
        ? "Off for this site on every device. Turn on to see the warning again. Reloads the tab."
        : "Off because you made an exception. Turn on to try HTTPS first. Reloads the tab."
    );
    const toggle = htmlElement(doc, "button", {
      type: "button",
      className: "sval-prot-switch",
      id: "sval-prot-https-only",
      attrs: {
        role: "switch",
        "aria-checked": "false",
        "aria-label": "HTTPS-Only on this site",
      },
    });
    toggle.ariaDescribedByElements = [line];
    toggle.addEventListener("click", () => {
      const principal = this.httpPrincipal();
      if (saved) {
        SvalSiteProtections.setInsecure(principal.host, false);
      }
      lazy.SitePermissions.removeFromPrincipal(
        principal,
        HTTPS_ONLY_PERMISSION
      );
      this.close();
      win.BrowserCommands.reloadSkipCache();
    });
    return htmlElement(
      doc,
      "div",
      { className: "sval-prot-switch-row" },
      htmlElement(
        doc,
        "div",
        { className: "sval-prot-switch-words" },
        htmlElement(
          doc,
          "span",
          { className: "sval-prot-switch-label" },
          "HTTPS-Only on this site"
        ),
        line
      ),
      toggle
    );
  }

  segments(name, label, choices, current, pick) {
    return segments(this.doc, name, label, choices, current, pick);
  }

  /**
   * A section's title, as a heading named in the case it is written in,
   * which its uppercase look would otherwise give the name.
   *
   * @param {string} text
   * @param {string} [className]
   * @returns {Element}
   */
  heading(text, className = "") {
    return htmlElement(
      this.doc,
      "h2",
      {
        className: `sval-prot-heading ${className}`.trim(),
        attrs: { "aria-label": text },
      },
      text
    );
  }

  rows(state) {
    const { doc } = this;
    const off = state.protections === "off";
    const { log } = state;
    const fpKinds = [log.canvas && "canvas", log.fonts && "fonts"]
      .filter(Boolean)
      .join(" and ");
    const fpSub = fpKinds
      ? `${fpKinds[0].toUpperCase()}${fpKinds.slice(1)} gave false answers`
      : "";
    const items = off
      ? [["pr-tracker", "Trackers loaded", log.allowed, ""]]
      : [
          ["pr-tracker", "Trackers blocked", log.blocked, ""],
          ["pr-ads", "Ads blocked", log.ads, ""],
          [
            "pr-fingerprint",
            "Fingerprinting foiled",
            log.fingerprinting,
            fpSub,
          ],
        ];
    const title = this.heading(
      off ? "Allowed on this page" : "On this page",
      "sval-prot-label"
    );
    const section = htmlElement(
      doc,
      "div",
      {
        className: "sval-prot-section sval-prot-rows",
        attrs: { role: "group" },
      },
      title
    );
    section.ariaLabelledByElements = [title];
    for (const [icon, label, count, sub] of items) {
      section.append(
        htmlElement(
          doc,
          "div",
          { className: "sval-prot-row", dataset: { row: icon } },
          glyph(doc, icon, "sval-prot-row-icon"),
          htmlElement(
            doc,
            "div",
            { className: "sval-prot-row-words" },
            htmlElement(doc, "span", {}, label),
            sub
              ? htmlElement(doc, "span", { className: "sval-prot-sub" }, sub)
              : null
          ),
          htmlElement(
            doc,
            "span",
            {
              className: off
                ? "sval-prot-count sval-prot-muted"
                : "sval-prot-count",
            },
            String(count)
          )
        )
      );
    }
    return section;
  }

  compatLine() {
    const { doc } = this;
    return htmlElement(
      doc,
      "div",
      { className: "sval-prot-well sval-prot-compat" },
      glyph(doc, "pr-info", "sval-prot-info"),
      htmlElement(
        doc,
        "span",
        {},
        "Mozilla's fix weakens protection on this site, so the site can recognize your device more easily."
      )
    );
  }

  switches(state) {
    const { doc } = this;
    const at = this.scopeAt(state);
    // The page's own value counts Firefox's allow list; the site's scope
    // shows the site's choice.
    const protections =
      at === state.host
        ? state.protections
        : SvalSiteProtections.protectionsFor(at, state.session);
    const choice = state.scope.choice;
    const mainOn = protections !== "off";
    // A Mozilla fix that applies leaves fingerprinting protection partly
    // off, so the switch shows it off.
    const fpOn =
      (protections === "on" && !state.compat) || protections === "full";
    // Turned on where Mozilla has a fix for the site, the switch keeps the
    // fix out (`SvalSiteProtections`' `"full"`).
    const turnOn = [false, true].some(
      isBaseline =>
        SvalSiteProtections.remoteTokensFor(state.site, isBaseline).length
    )
      ? "full"
      : "on";
    // Turning it back on stays possible for a site that has it off.
    const unwritable =
      protections === "on" && !SvalSiteProtections.canWriteFor(state.site);
    let fpReason = "";
    let fpWhy = "";
    if (state.isPrivate && state.compat) {
      // Mozilla's webcompat entries apply in every window, and a site's own
      // entries in normal windows alone
      // (`FingerprintingOverride.appliesInPrivateBrowsing`).
      fpReason =
        "Private windows always use Mozilla's fix on this site, so you can't turn full protection on here.";
      fpWhy = "private-fix";
    } else if (state.isPrivate) {
      // Gecko applies a site's fingerprinting entries to normal windows
      // alone (`FingerprintingOverride.appliesInPrivateBrowsing`).
      fpReason =
        "A private window can't turn fingerprinting protection off on its own. Turn off all protections for this site instead.";
      fpWhy = "private";
    } else if (unwritable) {
      fpReason = SvalSiteProtections.UNWRITABLE_NOTE;
      fpWhy = "unwritable";
    } else if (state.compat) {
      fpReason = "Turn on to keep full protection on this site.";
      fpWhy = "fix";
    }
    // A switch that can't be used stays focusable, so the line under it,
    // which says why where there is a reason, reaches the keyboard and is
    // the switch's description.
    const row = (id, label, sub, on, disabled, act, why = "") => {
      const line = htmlElement(
        doc,
        "span",
        { className: "sval-prot-sub" },
        sub
      );
      const toggle = htmlElement(doc, "button", {
        type: "button",
        className: "sval-prot-switch",
        id,
        dataset: { reason: why },
        attrs: {
          role: "switch",
          "aria-checked": String(on),
          "aria-label": label,
          ...(disabled ? { "aria-disabled": "true" } : {}),
        },
      });
      toggle.ariaDescribedByElements = [line];
      toggle.addEventListener("click", () => {
        if (!disabled) {
          act();
        }
      });
      return htmlElement(
        doc,
        "div",
        {
          className: "sval-prot-switch-row",
          dataset: { disabled: disabled ? "true" : "" },
        },
        htmlElement(
          doc,
          "div",
          { className: "sval-prot-switch-words" },
          htmlElement(
            doc,
            "span",
            { className: "sval-prot-switch-label" },
            label
          ),
          line
        ),
        toggle
      );
    };
    return this.section(
      choice ? "Choices" : "This site",
      "Changes reload the tab",
      "sval-prot-section sval-prot-site",
      row(
        "sval-prot-main",
        choice ? "Protections" : "Protections for this site",
        "Blocks trackers and ads and resists fingerprinting.",
        mainOn,
        false,
        () => this.setProtections(state, mainOn ? "off" : "on")
      ),
      row(
        "sval-prot-fp",
        "Fingerprinting protection",
        fpReason || "Turn off to let the site read your real device values.",
        mainOn && fpOn,
        !mainOn || state.isPrivate || unwritable,
        () => this.setProtections(state, fpOn ? "fingerprinting" : turnOn),
        fpWhy
      )
    );
  }

  /**
   * A titled section of controls: a group named by its heading and
   * described by the note beside it.
   *
   * @param {string} title
   * @param {string} note
   * @param {string} className
   * @param {...Element} children
   * @returns {Element}
   */
  section(title, note, className, ...children) {
    const { doc } = this;
    const heading = this.heading(title);
    const noteEl = htmlElement(
      doc,
      "span",
      { className: "sval-prot-label-note" },
      note
    );
    const section = htmlElement(
      doc,
      "div",
      { className, attrs: { role: "group" } },
      htmlElement(
        doc,
        "div",
        { className: "sval-prot-label sval-prot-label-row" },
        heading,
        noteEl
      ),
      ...children
    );
    section.ariaLabelledByElements = [heading];
    section.ariaDescribedByElements = [noteEl];
    return section;
  }

  footer(state) {
    return protectionFooter(
      this.doc,
      state.isPrivate,
      { className: "sval-prot-link sval-prot-manage" },
      () => {
        this.close();
        this.manageSites(state.site);
      }
    );
  }

  /**
   * @param {object} state From `stateOf`, or the site menu's `mediaOf`.
   * @param {"on"|"off"|"fingerprinting"|"full"} value
   */
  setProtections(state, value) {
    SvalSiteProtections.setProtections(
      this.scopeAt(state),
      value,
      state.session
    );
    if (
      value !== "off" &&
      lazy.ContentBlockingAllowList.includes(state.browser)
    ) {
      lazy.ContentBlockingAllowList.remove(state.browser);
    }
    state.browser.reload();
  }

  /**
   * Opens Settings › Sites, filtered to `site`, in this
   * window's settings tab if it has one.
   *
   * @param {string} site
   */
  manageSites(site) {
    SvalSiteProtections.manageFilter = site;
    this.openSettings(SETTINGS_URL, page => page.SvalSettings.showSites());
  }

  /**
   * Opens the site's page in Settings, in this window's settings tab if it
   * has one.
   *
   * @param {string} site
   * @param {object} [options]
   * @param {boolean} [options.hidden] Scrolls to its hidden elements.
   */
  manageSite(site, { hidden = false } = {}) {
    const section = hidden ? "hidden" : undefined;
    const query = new URLSearchParams(
      section ? { host: site, section } : { host: site }
    );
    this.openSettings(`about:preferences#svalSites-site?${query}`, page =>
      page.SvalSettings.showSite(site, { section })
    );
  }

  /**
   * Opens `url` in a new settings tab, or, where this window has a settings
   * tab whose Sval settings have loaded, selects it and hands its page to
   * `show`.
   *
   * @param {string} url
   * @param {function(Window): void} show
   */
  openSettings(url, show) {
    const { gBrowser } = this.win;
    const existing = Array.from(gBrowser.tabs).find(tab =>
      lazy.SvalPreferences.isPreferencesURL(
        tab.linkedBrowser?.currentURI?.spec ?? ""
      )
    );
    if (existing) {
      gBrowser.selectedTab = existing;
      const page = existing.linkedBrowser.contentWindow;
      if (page?.SvalSettings) {
        show(page);
        return;
      }
    }
    // At the end of the strip, as Firefox's `openPreferences` opens it, so
    // the tab observer files it last in the workspace, and owned by the tab
    // it was opened from, which closing it goes back to.
    gBrowser.selectedTab = gBrowser.addTrustedTab(url, {
      ownerTab: gBrowser.selectedTab,
    });
  }
}

/** window -> its ProtectionButton. */
const buttons = new WeakMap();

export const SvalProtectionButton = {
  /**
   * Adds the button and panel to a browser window, after its delayed
   * startup.
   *
   * @param {Window} win
   */
  startWindow(win) {
    if (buttons.has(win)) {
      return;
    }
    const button = new ProtectionButton(win);
    try {
      if (button.mount()) {
        buttons.set(win, button);
      }
    } catch (err) {
      SvalLog.error(`the protection button failed: ${SvalLog.errorName(err)}`);
    }
  },

  /**
   * @param {Window} win
   * @returns {ProtectionButton|undefined}
   */
  forWindow(win) {
    return buttons.get(win);
  },
};
