/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The filter lists Sval knows, and the loader that keeps a copy of each one
 * the engine uses (protections spec §1.2, decision 0102).
 *
 * Sval downloads each list from its publisher and never bundles one. A copy
 * lives in the profile's `sval-blocking` directory beside `lists.json`, which
 * records for each list its validators, when it was last downloaded, when it
 * expires and when a download last failed. A list is fetched again only once
 * it has expired: at the later of the HTTP `Expires` and the list's own
 * `! Expires:` line, bounded to between half a day and two weeks, plus a
 * random part so that browsers started together do not fetch together. A
 * fetch is conditional, and a failed one keeps the copy there is. A list that
 * has never downloaded is skipped by the engine until it does.
 *
 * Gecko's content classifier asks for list bytes through its Remote Settings
 * client, which hands ids starting with `sval-` here (the
 * content-classifier-sval-lists patch). `attach` gives this module the
 * service, so that a list that changes rebuilds its engine.
 *
 * Privacy Badger's groups of the domains one company owns, which the owners'
 * exceptions read (`SvalTrackerOwners`), are GPL-3.0 and kept the same way:
 * downloaded on the lists' schedule while the tracker tag runs the owners'
 * exceptions, stored beside the lists, and replaced only by a download that
 * `parseFirstParties` accepts. Before the first, the exceptions are built
 * without them.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalScope } from "moz-src:///browser/components/sval/SvalScope.sys.mjs";
import {
  FIRST_PARTIES_URL_PREF,
  MAX_FIRST_PARTIES_BYTES,
  parseFirstParties,
  rules as trackerOwnerRules,
  TRACKER_OWNERS_LIST,
} from "moz-src:///browser/components/sval/SvalTrackerOwners.sys.mjs";
import { readJSONOrSetAside } from "moz-src:///browser/components/sval/SvalJSONFile.sys.mjs";
import { sha256HexSync } from "moz-src:///browser/components/sval/SvalBytes.sys.mjs";
import { HOST } from "moz-src:///browser/components/sval/SvalElementRules.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** What Sval says after any change to blocking: the level, a list, a domain. */
export const BLOCKING_TOPIC = "sval-blocking-changed";

/** The ad feature's list ids, which the content classifier reads. */
export const ENGINE_LISTS_PREF =
  "privacy.trackingprotection.content.ads.list_ids";
/** The lists of the `trackers` feature, which blocks (decision 1051). */
export const TRACKER_LISTS_PREF =
  "privacy.trackingprotection.content.trackers.list_ids";
/**
 * The lists of the `trackers-content` feature, which only tags requests as
 * trackers: the tracker lists, the fixes and the owners' exceptions.
 */
export const TRACKER_TAG_LISTS_PREF =
  "privacy.trackingprotection.content.trackers_content.list_ids";
/**
 * The lists the content classifier parses with adblock-rust's trusted
 * permission bit, so that uBlock Origin's trusted scriptlets run from them.
 */
export const TRUSTED_LISTS_PREF =
  "privacy.trackingprotection.content.trusted_list_ids";
/**
 * The user's allowed domains: a pref each, this branch and the domain,
 * `true`. Settings sync carries each as a setting of its own, as it does
 * each list in `USER_LIST_BRANCH`, so two devices that add or remove
 * different entries both keep the change.
 */
export const ALLOWED_DOMAIN_BRANCH = "browser.sval.adblock.allowedDomain.";
/**
 * The lists the user added in Custom: a pref each, this branch and the list's
 * id (`userListId`), holding `{url, category}` as JSON, with `trusted: true`
 * on a list the user trusts with trusted scriptlets.
 */
export const USER_LIST_BRANCH = "browser.sval.adblock.userList.";
/** Whether lists download on their schedule. Test harnesses turn it off. */
export const UPDATES_PREF = "browser.sval.adblock.updates.enabled";
/** The user's own filter rules, one per line: "My filters". */
export const MY_FILTERS_PREF = "browser.sval.adblock.myFilters";

export const ALLOWED_DOMAINS_LIST = "sval-allowed-domains";
export const MY_FILTERS_LIST = "sval-my-filters";
export const USER_LIST_PREFIX = "sval-user-";
/**
 * The addresses of lists the user added on this device, a JSON array. Local:
 * a list that arrives only through sync is not downloaded until the user
 * confirms it here, so a synced value never makes Sval contact a host nobody
 * chose on this device.
 */
export const CONFIRMED_LISTS_PREF = "browser.sval.adblock.userListsConfirmed";
/**
 * The addresses of added lists the user trusts on this device, a JSON array.
 * Local, as `CONFIRMED_LISTS_PREF` is: a list's `trusted` syncs, and says
 * another device trusts it, but its trusted scriptlets run on a device only
 * once the user trusts it there too, so no device grants another the power
 * to run code in every page.
 */
export const TRUSTED_HERE_PREF = "browser.sval.adblock.userListsTrustedHere";

/** The most a list and all its includes may weigh together. */
const MAX_LIST_BYTES = 32 * 1024 * 1024;
/** The most includes one list may pull in. */
const MAX_INCLUDES = 32;

/**
 * An error whose reason is fixed text, safe for the log: never an address.
 *
 * @param {string} reason
 * @returns {Error}
 */
function listError(reason) {
  const err = new Error(reason);
  err.reason = reason;
  return err;
}

/**
 * The `!#if` tokens uBlock Origin defines, and their value for Sval: Firefox on
 * the desktop, with uBlock Origin's syntax, user stylesheets and no HTML
 * filtering. An unknown `cap_` token is false; any other unknown token leaves
 * its block in, as uBlock Origin does.
 */
const PREPARSER_TOKENS = new Map([
  ["ext_ublock", true],
  ["ext_ubol", false],
  ["ext_devbuild", false],
  ["env_brave", false],
  ["env_chromium", false],
  ["env_edge", false],
  ["env_firefox", true],
  ["env_legacy", false],
  ["env_mobile", false],
  ["env_mv3", false],
  ["env_safari", false],
  ["cap_html_filtering", false],
  ["cap_ipaddress", false],
  ["cap_user_stylesheet", true],
  ["false", false],
  ["ext_abp", false],
  ["adguard", false],
  ["adguard_app_android", false],
  ["adguard_app_cli", false],
  ["adguard_app_ios", false],
  ["adguard_app_mac", false],
  ["adguard_app_windows", false],
  ["adguard_ext_android_cb", false],
  ["adguard_ext_chromium", false],
  ["adguard_ext_chromium_mv3", false],
  ["adguard_ext_edge", false],
  ["adguard_ext_firefox", true],
  ["adguard_ext_opera", false],
  ["adguard_ext_safari", false],
]);

/**
 * The value of an `!#if` expression: tokens with `!`, `&&`, `||` and
 * parentheses. Undefined when a token is unknown or the expression does not
 * parse.
 *
 * @param {string} expr
 * @returns {boolean|undefined}
 */
function evaluateCondition(expr) {
  const tokens = expr.match(/\(|\)|&&|\|\||!|[^\s()!&|]+/g) ?? [];
  let at = 0;
  const unknown = Symbol("unknown");
  const combine = (a, b, op) => {
    if (a === unknown || b === unknown) {
      return unknown;
    }
    return op == "&&" ? a && b : a || b;
  };
  const primary = () => {
    const token = tokens[at++];
    if (token === undefined) {
      throw new Error("parse");
    }
    if (token == "!") {
      const value = primary();
      return value === unknown ? unknown : !value;
    }
    if (token == "(") {
      const value = either();
      if (tokens[at++] != ")") {
        throw new Error("parse");
      }
      return value;
    }
    if (PREPARSER_TOKENS.has(token)) {
      return PREPARSER_TOKENS.get(token);
    }
    return token.startsWith("cap_") ? false : unknown;
  };
  const both = () => {
    let value = primary();
    while (tokens[at] == "&&") {
      at++;
      value = combine(value, primary(), "&&");
    }
    return value;
  };
  const either = () => {
    let value = both();
    while (tokens[at] == "||") {
      at++;
      value = combine(value, both(), "||");
    }
    return value;
  };
  try {
    const value = either();
    if (at != tokens.length || value === unknown) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

/**
 * A list with its `!#if`/`!#else`/`!#endif` blocks resolved for Sval, nested
 * blocks included. adblock-rust ignores the directives, so without this both
 * branches would apply. A block whose condition is unknown stays.
 *
 * @param {string} text
 * @returns {string}
 */
export function preprocessList(text) {
  if (!text.includes("!#if")) {
    return text;
  }
  const kept = [];
  // Each open block: false when its lines are dropped, true when kept,
  // undefined when its condition is unknown.
  const stack = [];
  for (const line of text.split(/\r?\n/)) {
    const directive = /^!#(if|else|endif)\b(.*)$/.exec(line);
    if (directive?.[1] == "if") {
      stack.push(evaluateCondition(directive[2].trim()));
      continue;
    }
    if (directive?.[1] == "else") {
      if (stack.length) {
        const top = stack.pop();
        stack.push(top === undefined ? undefined : !top);
      }
      continue;
    }
    if (directive?.[1] == "endif") {
      stack.pop();
      continue;
    }
    if (!stack.includes(false)) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

/**
 * The user's own filter rules as stored, or "" when there are none or they
 * are not plain text. The value syncs, so it is checked here, where it
 * reaches the engine, as an allowed domain is. Its size is bounded by the
 * pref store, which refuses a string past `MAX_PREF_LENGTH`
 * (`nsPrefBranch::CheckSanityOfStringLength`).
 *
 * @returns {string}
 */
export function myFilters() {
  const text = Services.prefs.getStringPref(MY_FILTERS_PREF, "");
  return isPlainText(text) ? text : "";
}

/**
 * Whether `text` is text a filter list could hold: no control characters
 * but tabs and line breaks.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isPlainText(text) {
  return (
    typeof text == "string" &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)
  );
}

/**
 * An allowed domain as stored, or null when `text` is not a registrable
 * hostname. The URL parser normalises it (IDN to punycode, case), and only
 * letters, digits, dots and hyphens survive, so no value can carry filter
 * syntax or a second line into the rules built from it. A bare public suffix
 * is refused, by `Services.eTLD`.
 *
 * @param {string} text A domain or an address.
 * @returns {?string}
 */
export function normalizeDomain(text) {
  if (typeof text != "string" || /[\s^$|,*#!@]/.test(text.trim())) {
    return null;
  }
  let host;
  try {
    const trimmed = text.trim().toLowerCase();
    const url = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`
    );
    if (url.username || url.password) {
      return null;
    }
    host = url.hostname.replace(/\.+$/, "");
  } catch {
    return null;
  }
  if (!HOST.test(host)) {
    return null;
  }
  try {
    Services.eTLD.getBaseDomainFromHost(host);
  } catch {
    return null;
  }
  return host;
}

/** A rule that strips one named parameter on every site and in every request. */
const REMOVEPARAM_RULE = /^\*?\$removeparam=([\w.%[\]-]+)$/;
/** An exception to `$removeparam`: its pattern, then its options. */
const REMOVEPARAM_EXCEPTION = /^@@(?:\|\|)?([^$]*)\$(.*removeparam.*)$/;

/**
 * @param {string} host A host from a rule, which may hold a wildcard.
 * @returns {?string} Its site, as Firefox's query stripping allow list keys
 *   sites (`URLQueryStringStripper::CheckAllowList`), or null.
 */
function ruleSite(host) {
  const domain = normalizeDomain(host);
  if (!domain) {
    return null;
  }
  try {
    return Services.eTLD.getBaseDomainFromHost(domain);
  } catch {
    return null;
  }
}

/**
 * The part of a list's `$removeparam` rules Firefox's query stripping can
 * apply (decision 0104). Its strip list is parameter names stripped on every
 * site, so only a rule naming one parameter with no other option counts; a
 * rule scoped to sites, request types or a pattern is left out.
 *
 * An exception lifts stripping for every parameter on the sites it names, its
 * pattern's host and its `to=` and `domain=` sites, because the allow list
 * holds sites alone. That lifts more than the exception did, never less. An
 * exception with no pattern keeps the parameter it names everywhere.
 *
 * @param {string} text A list, its `!#if` blocks resolved.
 * @returns {{params: string[], sites: string[], kept: string[]}} Parameters
 *   to strip, sites to leave alone and parameters never to strip, each
 *   lower-cased as Gecko compares them.
 */
export function removeparamRules(text) {
  const params = new Set();
  const sites = new Set();
  const kept = new Set();
  for (const [raw] of text.matchAll(/^.*removeparam.*$/gm)) {
    const line = raw.trim();
    const rule = REMOVEPARAM_RULE.exec(line);
    if (rule) {
      params.add(rule[1].toLowerCase());
      continue;
    }
    const exception = REMOVEPARAM_EXCEPTION.exec(line);
    if (!exception) {
      continue;
    }
    const [, pattern, optionText] = exception;
    const options = optionText.split(",");
    if (pattern == "" || pattern == "*") {
      const named = options
        .find(option => option.startsWith("removeparam="))
        ?.slice("removeparam=".length);
      if (named && /^[\w.%[\]-]+$/.test(named)) {
        kept.add(named.toLowerCase());
      }
      continue;
    }
    const hosts = [
      pattern.replace(/^\|?(?:[a-z]+:\/\/)?/, "").split(/[/^:?|]/)[0],
    ];
    for (const option of options) {
      const [name, value] = option.split("=");
      if ((name == "to" || name == "domain") && value) {
        hosts.push(...value.split("|").filter(h => !h.startsWith("~")));
      }
    }
    for (const candidate of hosts) {
      const site = ruleSite(candidate);
      if (site) {
        sites.add(site);
      }
    }
  }
  return { params: [...params], sites: [...sites], kept: [...kept] };
}

/**
 * Whether an address may be fetched as a list the user added: https, no
 * credentials, and a public host name. IP literals, single-label names and the
 * local-only suffixes are refused. A name that resolves to a local address is
 * refused when the list is downloaded ({@link download}).
 *
 * @param {string} text
 * @returns {?string} the normalised address, or null.
 */
export function publicListUrl(text) {
  let url;
  try {
    url = new URL(String(text).trim());
  } catch {
    return null;
  }
  if (url.protocol != "https:" || url.username || url.password) {
    return null;
  }
  const host = url.hostname;
  if (
    !host.includes(".") ||
    host.startsWith("[") ||
    /^[0-9.]+$/.test(host) ||
    /\.(local|localhost|internal|lan|home|arpa|test|invalid|example)$/.test(
      host
    )
  ) {
    return null;
  }
  try {
    Services.eTLD.getBaseDomain(Services.io.newURI(url.href));
  } catch {
    return null;
  }
  return url.href;
}

/**
 * Downloads a list over its own channel, uncached and without cookies, and
 * stops reading once the budget is spent, so an oversized body is never held.
 * What it reads is taken from the budget, which a list shares with its
 * includes.
 * For a list the user added it follows no redirect, and refuses a server
 * whose connected address Gecko places in the local or private address space
 * (`nsILoadInfo.ipAddressSpace`, set from the peer address when the response
 * starts, as local network access uses it), so a public name that resolves
 * to a local address is refused. Through a proxy Gecko leaves the space
 * unknown, since the proxy resolved the name, and the list loads.
 *
 * @param {string} url
 * @param {object} options
 * @param {object} options.headers Request headers.
 * @param {{remaining: number}} options.budget
 * @param {boolean} options.user Whether the user added the list.
 * @returns {Promise<Response>}
 */
export function download(url, { headers = {}, budget, user = false }) {
  return new Promise((resolve, reject) => {
    let channel;
    try {
      channel = lazy.NetUtil.newChannel({
        uri: url,
        loadUsingSystemPrincipal: true,
        contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER,
      }).QueryInterface(Ci.nsIHttpChannel);
    } catch {
      reject(listError("bad address"));
      return;
    }
    channel.loadFlags |=
      Ci.nsIRequest.LOAD_BYPASS_CACHE |
      Ci.nsIRequest.INHIBIT_CACHING |
      Ci.nsIRequest.LOAD_ANONYMOUS;
    for (const [name, value] of Object.entries(headers)) {
      channel.setRequestHeader(name, value, false);
    }
    if (user) {
      channel.redirectionLimit = 0;
    }
    const chunks = [];
    let size = 0;
    let refused = null;
    const refuse = (request, reason) => {
      refused = listError(reason);
      request.cancel(Cr.NS_BINDING_ABORTED);
    };
    channel.asyncOpen({
      onStartRequest(request) {
        // A channel that failed before any response (no connection, no DNS
        // answer) still starts, and has no response head: `contentLength`
        // throws NS_ERROR_NOT_AVAILABLE (`HttpBaseChannel::GetContentLength`).
        // onStopRequest reports the failure.
        if (!Components.isSuccessCode(request.status)) {
          return;
        }
        const space = channel.loadInfo.ipAddressSpace;
        if (
          user &&
          (space == Ci.nsILoadInfo.Local || space == Ci.nsILoadInfo.Private)
        ) {
          refuse(request, "not a public address");
        } else if (channel.contentLength > budget.remaining) {
          refuse(request, "list too large");
        }
      },
      onDataAvailable(request, stream, offset, count) {
        const data = lazy.NetUtil.readInputStream(stream, count);
        if (refused) {
          return;
        }
        size += count;
        budget.remaining -= count;
        if (budget.remaining < 0) {
          refuse(request, "list too large");
          return;
        }
        chunks.push(new Uint8Array(data));
      },
      onStopRequest(request, status) {
        if (refused) {
          reject(refused);
          return;
        }
        if (!Components.isSuccessCode(status)) {
          reject(listError("network error"));
          return;
        }
        let responseStatus;
        const responseHeaders = new Headers();
        try {
          responseStatus = channel.responseStatus;
          channel.visitResponseHeaders({
            visitHeader(name, value) {
              responseHeaders.append(name, value);
            },
          });
        } catch {
          reject(listError("no response"));
          return;
        }
        const body = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) {
          body.set(chunk, at);
          at += chunk.byteLength;
        }
        const nullBody = [101, 204, 205, 304].includes(responseStatus);
        resolve(
          new Response(nullBody ? null : body, {
            status: responseStatus,
            headers: responseHeaders,
          })
        );
      },
    });
  });
}

const DIR_NAME = "sval-blocking";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DEFAULT_LIFETIME = 4 * DAY;
const MIN_LIFETIME = 12 * HOUR;
const MAX_LIFETIME = 14 * DAY;
// How long after start a list that has never downloaded, or has expired, is
// fetched: soon, but not in the first moments of a launch.
const FIRST_FETCH_DELAY = [5 * 1000, 30 * 1000];
const EXPIRED_FETCH_DELAY = [60 * 1000, 10 * 60 * 1000];
// A failed download is tried again after this, plus jitter.
const RETRY_DELAY = 2 * HOUR;
// Lists are fetched one at a time, this far apart.
const BETWEEN_FETCHES = 2000;

const EASYLIST = "GPL-3.0 or CC BY-SA 3.0, The EasyList authors";
const UBO = "GPL-3.0, uBlock Origin contributors";
const ADGUARD = "GPL-3.0, AdGuard";
const HAGEZI = "GPL-3.0, HaGeZi";
const OISD = "GPL-3.0, oisd";
const FANBOY = "CC BY 3.0, Fanboy";
const CURBEN = "CC0 or MIT, curben";
const BRAVE = "MPL-2.0, Brave Software";

/** Every list Sval offers. Each one's address is `listUrlPref(id)`. */
const CURATED = [
  ["ublock-filters", "uBlock filters", "ads", UBO],
  ["easylist", "EasyList", "ads", EASYLIST],
  ["adguard-base", "AdGuard Base filter", "ads", ADGUARD],
  ["hagezi-light", "HaGeZi Multi Light", "ads", HAGEZI],
  ["hagezi-normal", "HaGeZi Multi Normal", "ads", HAGEZI],
  ["hagezi-pro-mini", "HaGeZi Multi Pro mini", "ads", HAGEZI],
  ["hagezi-pro", "HaGeZi Multi Pro", "ads", HAGEZI],
  ["hagezi-pro-plus", "HaGeZi Multi Pro++", "ads", HAGEZI],
  ["hagezi-ultimate", "HaGeZi Multi Ultimate", "ads", HAGEZI],
  ["oisd-small", "oisd small", "ads", OISD],
  ["oisd-big", "oisd big", "ads", OISD],
  ["easyprivacy", "EasyPrivacy", "trackers", EASYLIST],
  ["ublock-privacy", "uBlock filters – Privacy", "trackers", UBO],
  [
    "adguard-tracking",
    "AdGuard Tracking Protection filter",
    "trackers",
    ADGUARD,
  ],
  [
    "ublock-annoyances-others",
    "uBlock filters – Other Annoyances",
    "annoyances",
    UBO,
  ],
  ["fanboy-social", "Fanboy's Social Blocking List", "annoyances", FANBOY],
  ["fanboy-annoyance", "Fanboy's Annoyance List", "annoyances", FANBOY],
  ["adguard-annoyances", "AdGuard Annoyances filter", "annoyances", ADGUARD],
  ["easylist-cookie", "EasyList Cookie List", "annoyances", EASYLIST],
  ["ublock-cookies", "uBlock filters – Cookie Notices", "annoyances", UBO],
  ["adguard-cookies", "AdGuard Cookie Notices filter", "annoyances", ADGUARD],
  ["ublock-badware", "uBlock filters – Badware risks", "malware", UBO],
  ["curben-urlhaus", "Online Malicious URL Blocklist", "malware", CURBEN],
  ["curben-phishing", "Phishing URL Blocklist", "malware", CURBEN],
  ["ublock-unbreak", "uBlock filters – Unbreak", "fixes", UBO],
  ["ublock-quick-fixes", "uBlock filters – Quick fixes", "fixes", UBO],
  ["brave-unbreak", "Brave Unbreak", "fixes", BRAVE],
];

/**
 * The regional lists, with the languages uBlock Origin's `assets.json` maps to
 * each, and the license each publisher states (decision 0102 admits no list
 * without one, or with non-commercial terms).
 */
const REGIONAL = [
  ["ara", "Liste AR", "ar kab", EASYLIST],
  ["chn", "AdGuard Chinese", "ug zh", ADGUARD],
  [
    "cze",
    "EasyList Czech and Slovak",
    "cs sk",
    "CC BY-SA 4.0, EasyList Czech and Slovak authors",
  ],
  ["deu", "EasyList Germany", "de dsb hsb lb rm", EASYLIST],
  [
    "fin",
    "Adblock List for Finland",
    "fi",
    "Unlicense, Finnish Easylist Addition",
  ],
  ["fra", "AdGuard Français", "ar br ff fr kab lb oc son", ADGUARD],
  ["grc", "Greek AdBlock Filter", "el", "CC BY-SA 4.0, kargig"],
  ["hun", "hufilter", "hu", "CC BY 4.0, hufilter"],
  ["idn", "ABPindo", "id ms", "GPL-3.0 or CC BY-SA 3.0, ABPindo"],
  ["ind", "IndianList", "as bn gu hi kn ml mr ne pa sat si ta te", EASYLIST],
  ["irn", "PersianBlocker", "fa ps tg", "AGPL-3.0, PersianBlocker"],
  ["isr", "EasyList Hebrew", "he", EASYLIST],
  ["ita", "EasyList Italy", "fur it lij sc", EASYLIST],
  ["jpn", "AdGuard Japanese", "ja", ADGUARD],
  ["kor", "Korean filters", "ko", "GPL-3.0, FilteringDev"],
  ["ltu", "EasyList Lithuania", "lt", "GPL-3.0, EasyList Lithuania"],
  ["lva", "Latvian List", "lv", "CC BY-SA 4.0, Latvian List"],
  ["nld", "AdGuard Dutch", "af fy nl", ADGUARD],
  ["rou", "Romanian Ad (ROad) Block List Light", "ro", "MIT, ROad-Block"],
  ["rus", "RU AdList", "be kk tt ru uz", "GPL-3.0, RU AdList"],
  ["spa", "EasyList Spanish", "an ast ca cak es eu gl gn trs quz", EASYLIST],
  [
    "por",
    "AdGuard Spanish/Portuguese",
    "an ast ca cak es eu gl gn trs pt quz",
    ADGUARD,
  ],
  ["svn", "Slovenian List", "sl", "Unlicense, Slovenian List"],
  ["swe", "Frellwit's Swedish Filter", "sv", "GPL-3.0, Frellwit"],
  ["tha", "EasyList Thailand", "th", "Apache-2.0, EasyList Thailand"],
  ["tur", "AdGuard Turkish", "tr", ADGUARD],
  ["ukr", "AdGuard Ukrainian", "uk", ADGUARD],
  ["vie", "ABPVN List", "vi", "GPL-3.0, ABPVN"],
];

/**
 * The id Privacy Badger's groups are kept under, as a list is. It has no
 * `sval-` prefix, so the content classifier never asks for its bytes as a
 * list's.
 */
export const FIRST_PARTIES_ID = "privacy-badger-first-parties";

const FIRST_PARTIES = Object.freeze({
  id: FIRST_PARTIES_ID,
  get url() {
    return Services.prefs.getStringPref(FIRST_PARTIES_URL_PREF);
  },
  maxBytes: MAX_FIRST_PARTIES_BYTES,
});

/**
 * @param {string} id A curated list's id.
 * @returns {string} The pref that holds the list's address, which is read at
 *   each download.
 */
export function listUrlPref(id) {
  return `browser.sval.adblock.list.${id}.url`;
}

/**
 * @param {object} fields A curated list's entry, without its address.
 * @returns {object} The entry, its address read from `listUrlPref`.
 */
function curated(fields) {
  return Object.freeze({
    ...fields,
    get url() {
      return Services.prefs.getStringPref(listUrlPref(fields.id));
    },
  });
}

const KNOWN = Object.freeze([
  ...CURATED.map(([key, title, category, license]) =>
    curated({ id: `sval-${key}`, title, category, license })
  ),
  ...REGIONAL.map(([key, title, langs, license]) =>
    curated({
      id: `sval-region-${key}`,
      title,
      category: "other",
      license,
      langs: Object.freeze(langs.split(" ")),
    })
  ),
]);

/**
 * @param {string} name A pref of comma-separated list ids.
 * @returns {string[]} Its ids.
 */
function listIds(name) {
  return Services.prefs
    .getStringPref(name, "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);
}

/**
 * @param {string} name
 * @param {Array} fallback
 * @returns {Array} the pref's JSON array, or `fallback`.
 */
export function readJSONPref(name, fallback) {
  try {
    const value = JSON.parse(Services.prefs.getStringPref(name, ""));
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * How long a list says it stays fresh, from its `! Expires: 4 days` line.
 *
 * @param {string} text The list.
 * @returns {?number} milliseconds.
 */
function listLifetime(text) {
  const match = /^!\s*Expires:\s*(\d+)\s*(day|hour)/im.exec(
    text.slice(0, 4096)
  );
  if (!match) {
    return null;
  }
  return Number(match[1]) * (match[2].toLowerCase() == "hour" ? HOUR : DAY);
}

/**
 * A header line's value, such as `! Title:`.
 *
 * @param {string} text The list.
 * @param {string[]} names The header's names.
 * @returns {?string}
 */
function headerLine(text, names) {
  const head = text.slice(0, 4096);
  for (const name of names) {
    const match = new RegExp(`^!\\s*${name}:\\s*(.+)$`, "im").exec(head);
    if (match) {
      return match[1].trim().slice(0, 200);
    }
  }
  return null;
}

/**
 * @param {number[]} range The least and most, in milliseconds.
 * @returns {number} a random time between them.
 */
function between([min, max]) {
  return min + Math.random() * (max - min);
}

/**
 * Up to a tenth more, so that fetches spread.
 *
 * @param {number} ms
 * @returns {number}
 */
function jitter(ms) {
  return ms + Math.random() * ms * 0.1;
}

/**
 * @param {string} name
 * @returns {boolean} Whether the pref is a bool and true: an entry of a
 *   branch whose entries are `true`.
 */
export function isTrue(name) {
  return (
    Services.prefs.getPrefType(name) === Ci.nsIPrefBranch.PREF_BOOL &&
    Services.prefs.getBoolPref(name)
  );
}

/**
 * @returns {string[]} The allowed domains, sorted. A pref that is not a
 *   domain as `normalizeDomain` gives one, or is not `true`, is none.
 */
export function allowedDomains() {
  return Services.prefs
    .getChildList(ALLOWED_DOMAIN_BRANCH)
    .filter(isTrue)
    .map(name => name.slice(ALLOWED_DOMAIN_BRANCH.length))
    .filter(domain => normalizeDomain(domain) === domain)
    .sort();
}

/**
 * @returns {object[]} The lists the user added, `{url, category, trusted?}`,
 *   by address. A pref whose list is not a public address, or is filed under
 *   another list's id, is none.
 */
export function userLists() {
  const lists = [];
  for (const name of Services.prefs.getChildList(USER_LIST_BRANCH)) {
    let entry;
    try {
      entry = JSON.parse(Services.prefs.getStringPref(name, ""));
    } catch {
      continue;
    }
    const url = publicListUrl(entry?.url);
    if (url && USER_LIST_BRANCH + userListId(url) === name) {
      lists.push({ ...entry, url });
    }
  }
  return lists.sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * Stores a list the user added, under its id.
 *
 * @param {object} entry `{url, category, trusted?}`, its address public.
 */
export function storeUserList(entry) {
  Services.prefs.setStringPref(
    USER_LIST_BRANCH + userListId(entry.url),
    JSON.stringify(entry)
  );
}

/**
 * A stable id for a list the user added, from its address.
 *
 * @param {string} url
 * @returns {string}
 */
function userListId(url) {
  return USER_LIST_PREFIX + sha256HexSync(url).slice(0, 16);
}

/** Keeps the enabled lists' copies and serves them to the engine. */
class ListLoader {
  #service = null;
  #meta = null;
  #metaLoad = null;
  /**
   * Whether `status` has asked for the state file's read, after which it
   * tells settings once that what it answered before the read is out of
   * date.
   */
  #metaAsked = false;
  #timer = null;
  #running = null;
  #started = false;
  #listening = new SvalScope();
  /** Lists that changed during an update pass, rebuilt together after it. */
  #pendingChanges = new Set();
  #inPass = false;
  #nextDue = Infinity;

  get dir() {
    return PathUtils.join(PathUtils.profileDir, DIR_NAME);
  }

  /** The curated catalog and the user's lists, with their addresses. */
  catalog() {
    const here = readJSONPref(TRUSTED_HERE_PREF, []);
    const user = userLists().map(entry =>
      Object.freeze({
        id: userListId(entry.url),
        title: null,
        category: KNOWN_CATEGORIES.has(entry.category)
          ? entry.category
          : "other",
        url: entry.url,
        license: null,
        user: true,
        trusted: entry.trusted === true && here.includes(entry.url),
        trustedElsewhere: entry.trusted === true && !here.includes(entry.url),
      })
    );
    return [...KNOWN, ...user];
  }

  userListId(url) {
    return userListId(url);
  }

  /**
   * @param {string} url A user list's address.
   * @returns {boolean} whether the user added or confirmed it on this device.
   */
  isConfirmed(url) {
    return readJSONPref(CONFIRMED_LISTS_PREF, []).includes(url);
  }

  /**
   * Records that the user chose a list on this device, so it downloads.
   *
   * @param {string} url
   */
  confirm(url) {
    const confirmed = readJSONPref(CONFIRMED_LISTS_PREF, []);
    if (!confirmed.includes(url)) {
      confirmed.push(url);
      Services.prefs.setStringPref(
        CONFIRMED_LISTS_PREF,
        JSON.stringify(confirmed)
      );
    }
    const entry = this.#meta?.[userListId(url)];
    if (entry) {
      delete entry.dueAt;
    }
    this.schedule();
  }

  /**
   * Records whether the user trusts a list on this device
   * (`TRUSTED_HERE_PREF`).
   *
   * @param {string} url
   * @param {boolean} trusted
   */
  trustHere(url, trusted) {
    const here = readJSONPref(TRUSTED_HERE_PREF, []).filter(
      item => item !== url
    );
    if (trusted) {
      here.push(url);
    }
    Services.prefs.setStringPref(TRUSTED_HERE_PREF, JSON.stringify(here));
  }

  /**
   * Withdraws this device's trust in every list that is gone or trusted on
   * no device, so a list added again later, from here or from
   * another device, asks again.
   */
  dropLapsedTrust() {
    const here = readJSONPref(TRUSTED_HERE_PREF, []);
    const trusted = new Set(
      userLists()
        .filter(entry => entry.trusted === true)
        .map(entry => entry.url)
    );
    const kept = here.filter(url => trusted.has(url));
    if (kept.length != here.length) {
      Services.prefs.setStringPref(TRUSTED_HERE_PREF, JSON.stringify(kept));
    }
  }

  /**
   * The regional lists uBlock Origin would pick for a locale, by its primary
   * language.
   *
   * @param {string} locale A BCP 47 tag.
   * @returns {string[]} list ids.
   */
  regionalFor(locale) {
    const lang = String(locale).split("-")[0].toLowerCase();
    return KNOWN.filter(list => list.langs?.includes(lang)).map(
      list => list.id
    );
  }

  /**
   * What the lists' `$removeparam` rules give Firefox's query stripping
   * (`removeparamRules`), together. Each list's part is read when the list
   * downloads and kept in `lists.json`; a list whose entry lacks it is read
   * from its copy here, once.
   *
   * @param {string[]} ids
   * @returns {Promise<{params: string[], sites: string[]}>} Both sorted.
   */
  async removeparams(ids) {
    await this.#loadMeta();
    const params = new Set();
    const sites = new Set();
    const kept = new Set();
    for (const id of ids) {
      const entry = this.#meta[id];
      if (!entry?.fetchedAt) {
        continue;
      }
      if (!entry.removeparam) {
        try {
          entry.removeparam = removeparamRules(
            await IOUtils.readUTF8(this.#path(id))
          );
        } catch (err) {
          SvalLog.warn(
            `a blocking list's copy could not be read: ${id}: ${SvalLog.errorName(err)}`
          );
          continue;
        }
      }
      entry.removeparam.params.forEach(param => params.add(param));
      entry.removeparam.sites.forEach(site => sites.add(site));
      entry.removeparam.kept.forEach(param => kept.add(param));
    }
    return {
      params: [...params].filter(param => !kept.has(param)).sort(),
      sites: [...sites].sort(),
    };
  }

  /** The list ids the engine uses. */
  enabledIds() {
    return listIds(ENGINE_LISTS_PREF);
  }

  /**
   * @returns {string[]} What the schedule keeps: the lists either blocking
   *   engine runs, and Privacy Badger's groups while the tag runs the owners'
   *   exceptions.
   */
  #keptIds() {
    const ids = new Set([...this.enabledIds(), ...listIds(TRACKER_LISTS_PREF)]);
    if (listIds(TRACKER_TAG_LISTS_PREF).includes(TRACKER_OWNERS_LIST)) {
      ids.add(FIRST_PARTIES.id);
    }
    return [...ids];
  }

  /**
   * Starts keeping the enabled lists. Reads what is cached and schedules
   * each list's next fetch, and fetches nothing itself.
   */
  async start() {
    if (this.#started) {
      return;
    }
    this.#started = true;
    await this.#loadMeta();
    const observer = (subject, topic, data) => {
      if (data.startsWith(ALLOWED_DOMAIN_BRANCH)) {
        this.#allowedChanged();
      } else {
        this.schedule();
      }
    };
    for (const pref of SCHEDULE_PREFS) {
      this.#listening.pref(pref, observer);
    }
    this.#listening.pref(ALLOWED_DOMAIN_BRANCH, observer);
    this.schedule();
  }

  #allowedPending = false;

  /**
   * Rebuilds the allowed domains' list once for all the domains that changed
   * in one turn, as a sync pass changes several at once.
   */
  #allowedChanged() {
    if (this.#allowedPending) {
      return;
    }
    this.#allowedPending = true;
    Promise.resolve().then(() => {
      this.#allowedPending = false;
      this.#notify([ALLOWED_DOMAINS_LIST]);
    });
  }

  /**
   * Has the engine read the user's own rules again, for an edit that leaves
   * the engine's list ids as they were. `SvalBlocking` alone follows
   * `MY_FILTERS_PREF`, because an edit that adds or removes the list changes
   * those ids, and that change rebuilds the engine by itself.
   */
  myFiltersChanged() {
    this.#notify([MY_FILTERS_LIST]);
  }

  /** Stops the schedule. Used by tests. */
  stop() {
    this.#listening.end();
    lazy.clearTimeout(this.#timer);
    this.#timer = null;
    this.#started = false;
  }

  /** @param {nsIContentClassifierService} service */
  attach(service) {
    this.#service = service;
  }

  detach() {
    this.#service = null;
  }

  /**
   * The content classifier service while its Remote Settings client has it
   * attached, which page rules ask for a page's rules (SvalPageRules).
   *
   * @returns {?nsIContentClassifierService}
   */
  get service() {
    return this.#service;
  }

  /**
   * What the engine asked for: a list's cached bytes, the allowed domains as
   * exception rules, or the user's own rules. Rejects for a list that has
   * never downloaded.
   *
   * @param {string} id
   * @returns {Promise<Uint8Array>}
   */
  async getListBytes(id) {
    if (id == ALLOWED_DOMAINS_LIST) {
      // `$important` says what the feature's mOverridesImportant does: these
      // exceptions beat every list's important rules.
      const rules = allowedDomains().map(domain => `@@||${domain}^$important`);
      Services.obs.notifyObservers(null, "sval-blocking-list-served", id);
      return new TextEncoder().encode(rules.join("\n"));
    }
    if (id == TRACKER_OWNERS_LIST) {
      const firstParties = await this.#firstParties();
      const texts = [];
      for (const listId of this.#trackerLists()) {
        try {
          texts.push(await IOUtils.readUTF8(this.#path(listId)));
        } catch {
          // A tracker list without a copy yet names no tracker to except.
        }
      }
      Services.obs.notifyObservers(null, "sval-blocking-list-served", id);
      return new TextEncoder().encode(trackerOwnerRules(texts, firstParties));
    }
    if (id == MY_FILTERS_LIST) {
      const text = myFilters();
      if (!text && Services.prefs.getStringPref(MY_FILTERS_PREF, "")) {
        SvalLog.warn("my filters are not plain text and are not used");
      }
      Services.obs.notifyObservers(null, "sval-blocking-list-served", id);
      return new TextEncoder().encode(preprocessList(text));
    }
    try {
      const bytes = await IOUtils.read(this.#path(id));
      Services.obs.notifyObservers(null, "sval-blocking-list-served", id);
      return bytes;
    } catch (err) {
      SvalLog.info(`a blocking list has no copy yet and is skipped: ${id}`);
      throw new Error("not downloaded", { cause: err });
    }
  }

  /**
   * How a list stands, for settings: "ok", "stale" when its last download
   * failed and an older copy serves, "never" when downloads have failed and
   * there is no copy, and "pending" before its first download.
   *
   * @param {string} id
   * @returns {{state: string, ageDays: ?number, title: ?string,
   *   license: ?string}}
   */
  status(id) {
    if (!this.#meta && !this.#metaAsked) {
      this.#metaAsked = true;
      this.#loadMeta().then(() =>
        Services.obs.notifyObservers(null, BLOCKING_TOPIC)
      );
    }
    const entry = this.#meta?.[id];
    const list = id.startsWith(USER_LIST_PREFIX)
      ? this.catalog().find(item => item.id == id)
      : null;
    if (list && !this.isConfirmed(list.url) && !entry?.fetchedAt) {
      return {
        state: "unconfirmed",
        ageDays: null,
        title: null,
        license: null,
      };
    }
    if (!entry?.fetchedAt) {
      return {
        state: entry?.failedAt ? "never" : "pending",
        ageDays: null,
        title: null,
        license: null,
      };
    }
    return {
      // A download that succeeds clears `failedAt`, so one left is a failure
      // since the copy there is, in the same millisecond or not.
      state: entry.failedAt ? "stale" : "ok",
      ageDays: Math.floor((Date.now() - entry.fetchedAt) / DAY),
      title: entry.title ?? null,
      license: entry.license ?? null,
    };
  }

  /**
   * Sets the timer for the next list due. A list already due is fetched after a
   * short random delay, so that a launch is never held up by a download.
   */
  schedule() {
    if (!this.#started || !this.#meta) {
      return;
    }
    lazy.clearTimeout(this.#timer);
    this.#timer = null;
    this.#nextDue = Infinity;
    if (!Services.prefs.getBoolPref(UPDATES_PREF, true)) {
      return;
    }
    const now = Date.now();
    let next = Infinity;
    for (const id of this.#keptIds()) {
      next = Math.min(next, this.#dueAt(id, now));
    }
    this.#nextDue = next;
    if (next == Infinity) {
      return;
    }
    this.#timer = lazy.setTimeout(
      () => this.updateDue(),
      Math.max(0, next - now)
    );
  }

  /** When the schedule next wakes, in the clock `now` reads; Infinity when it does not. */
  get nextDue() {
    return this.#nextDue;
  }

  #dueAt(id, now) {
    // A list Sval builds from prefs has nothing to download.
    if (
      id != FIRST_PARTIES.id &&
      !id.startsWith(USER_LIST_PREFIX) &&
      !KNOWN.some(list => list.id == id)
    ) {
      return Infinity;
    }
    // A list that arrived through sync waits for the user to confirm it.
    if (id.startsWith(USER_LIST_PREFIX)) {
      const list = this.catalog().find(item => item.id == id);
      if (!list || !this.isConfirmed(list.url)) {
        return Infinity;
      }
    }
    const entry = (this.#meta[id] ??= {});
    if (!entry.dueAt) {
      entry.dueAt =
        now +
        between(entry.fetchedAt ? EXPIRED_FETCH_DELAY : FIRST_FETCH_DELAY);
      if (entry.fetchedAt && entry.expiresAt > now) {
        entry.dueAt = entry.expiresAt;
      }
    }
    return entry.dueAt;
  }

  /** Fetches every enabled list that is due, one at a time. */
  updateDue() {
    this.#running ??= (async () => {
      this.#inPass = true;
      try {
        for (const id of this.#keptIds()) {
          if (this.#dueAt(id, Date.now()) <= Date.now()) {
            await this.update(id);
            await new Promise(resolve =>
              lazy.setTimeout(resolve, BETWEEN_FETCHES)
            );
          }
        }
      } finally {
        this.#inPass = false;
        if (this.#pendingChanges.size) {
          this.#notify([...this.#pendingChanges]);
          this.#pendingChanges.clear();
        }
        this.#running = null;
        this.schedule();
      }
    })();
    return this.#running;
  }

  /**
   * Downloads one list, conditionally. A failure keeps the copy there is.
   *
   * @param {string} id
   * @returns {Promise<boolean>} whether the list's bytes changed.
   */
  async update(id) {
    await this.#loadMeta();
    const list =
      id == FIRST_PARTIES.id
        ? FIRST_PARTIES
        : this.catalog().find(entry => entry.id == id);
    if (!list) {
      return false;
    }
    if (list.user && !this.isConfirmed(list.url)) {
      return false;
    }
    const entry = (this.#meta[id] ??= {});
    const headers = {};
    const hasCopy = entry.fetchedAt && (await IOUtils.exists(this.#path(id)));
    if (hasCopy && entry.etag) {
      headers["If-None-Match"] = entry.etag;
    }
    if (hasCopy && entry.lastModified) {
      headers["If-Modified-Since"] = entry.lastModified;
    }
    const now = Date.now();
    let changed = false;
    try {
      const budget = {
        remaining: list.maxBytes ?? MAX_LIST_BYTES,
        includes: 0,
      };
      const response = await download(list.url, {
        headers,
        budget,
        user: !!list.user,
      });
      if (response.status == 304 && hasCopy) {
        entry.fetchedAt = now;
        entry.failedAt = null;
        entry.expiresAt = now + this.#lifetime(response, null, entry);
      } else if (response.ok && list == FIRST_PARTIES) {
        const text = await response.text();
        parseFirstParties(text);
        await this.#store(id, text);
        entry.etag = response.headers.get("ETag") ?? null;
        entry.lastModified = response.headers.get("Last-Modified") ?? null;
        entry.fetchedAt = now;
        entry.failedAt = null;
        entry.expiresAt = now + this.#lifetime(response, null, entry);
        changed = true;
      } else if (response.ok) {
        const text = await this.#resolveIncludes(
          await response.text(),
          list,
          list.url,
          budget,
          new Set([list.url])
        );
        if (!text.trim()) {
          throw listError("empty list");
        }
        await this.#store(id, text);
        entry.etag = response.headers.get("ETag") ?? null;
        entry.lastModified = response.headers.get("Last-Modified") ?? null;
        entry.title = headerLine(text, ["Title"]);
        entry.license = headerLine(text, ["License", "Licence"]);
        entry.listLifetime = listLifetime(text);
        entry.removeparam = removeparamRules(text);
        entry.fetchedAt = now;
        entry.failedAt = null;
        entry.expiresAt = now + this.#lifetime(response, text, entry);
        changed = true;
      } else {
        throw listError(`status ${Number(response.status)}`);
      }
      entry.dueAt = jitter(entry.expiresAt - now) + now;
    } catch (err) {
      SvalLog.warn(
        `a blocking list could not be downloaded: ${id}: ${err?.reason ?? err?.name}`
      );
      entry.failedAt = now;
      entry.dueAt = now + jitter(RETRY_DELAY);
    }
    await this.#saveMeta();
    if (changed && this.#inPass) {
      this.#pendingChanges.add(id);
    } else if (changed) {
      this.#notify([id]);
    }
    Services.obs.notifyObservers(null, BLOCKING_TOPIC, id);
    return changed;
  }

  /**
   * Resolves a list's `!#if` blocks and inlines its `!#include` lines, which
   * adblock-rust does neither of. Like uBlock Origin, Sval follows only a
   * relative include beside the list, on its own origin, and only in a block
   * that applies. The list and its includes share one byte budget and an
   * include count, so the inlined result cannot pass `MAX_LIST_BYTES`. A
   * failed include fails the download, so the copy there is stays.
   *
   * @param {string} text The list.
   * @param {object} list Its catalog entry.
   * @param {string} base The address the text came from.
   * @param {{remaining: number, includes: number}} budget
   * @param {Set<string>} seen Addresses already inlined.
   * @returns {Promise<string>}
   */
  async #resolveIncludes(text, list, base, budget, seen) {
    text = preprocessList(text);
    if (!text.includes("!#include")) {
      return text;
    }
    const origin = new URL(base).origin;
    const lines = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /^!#include\s+(\S+)/.exec(line);
      if (!match) {
        lines.push(line);
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(match[1]) || match[1].includes("..")) {
        continue;
      }
      const url = new URL(match[1], base);
      if (url.origin != origin || seen.has(url.href)) {
        continue;
      }
      if (++budget.includes > MAX_INCLUDES) {
        throw listError("too many includes");
      }
      seen.add(url.href);
      const response = await download(url.href, {
        budget,
        user: !!list.user,
      });
      if (!response.ok) {
        throw listError(`include status ${Number(response.status)}`);
      }
      lines.push(
        await this.#resolveIncludes(
          await response.text(),
          list,
          url.href,
          budget,
          seen
        )
      );
    }
    return lines.join("\n");
  }

  /**
   * Replaces a copy whole, so a crash leaves the last good one.
   *
   * @param {string} id
   * @param {string} text
   */
  async #store(id, text) {
    await IOUtils.makeDirectory(this.dir, { ignoreExisting: true });
    await IOUtils.writeUTF8(this.#path(id), text, {
      tmpPath: this.#path(id) + ".tmp",
    });
  }

  /**
   * @returns {Promise<string[][]>} Privacy Badger's groups from the copy Sval
   *   keeps, or none before the first download.
   */
  async #firstParties() {
    let text;
    try {
      text = await IOUtils.readUTF8(this.#path(FIRST_PARTIES.id));
    } catch {
      return [];
    }
    try {
      return parseFirstParties(text);
    } catch (err) {
      SvalLog.warn(
        `the tracker owners' copy does not parse and is not used: ${err?.reason ?? err?.name}`
      );
      return [];
    }
  }

  #lifetime(response, text, entry) {
    let lifetime = text ? listLifetime(text) : entry.listLifetime;
    const expires = Date.parse(response.headers.get("Expires") ?? "");
    if (!Number.isNaN(expires)) {
      lifetime = Math.max(lifetime ?? 0, expires - Date.now());
    }
    return Math.min(
      MAX_LIFETIME,
      Math.max(MIN_LIFETIME, lifetime || DEFAULT_LIFETIME)
    );
  }

  /** @returns {string[]} The `trackers` feature's lists in the tag's list. */
  #trackerLists() {
    const tagged = new Set(
      Services.prefs.getStringPref(TRACKER_TAG_LISTS_PREF, "").split(",")
    );
    return this.catalog()
      .filter(list => list.category == "trackers" && tagged.has(list.id))
      .map(list => list.id);
  }

  /**
   * Tells the classifier which lists changed. The owners' exceptions are
   * built from the tracker lists, so a tracker list's change is theirs too.
   *
   * @param {string[]} ids
   */
  #notify(ids) {
    if (
      ids.some(
        id => id == FIRST_PARTIES.id || this.#trackerLists().includes(id)
      )
    ) {
      ids = [...ids.filter(id => id != FIRST_PARTIES.id), TRACKER_OWNERS_LIST];
    }
    try {
      this.#service?.onListsChanged(ids, []);
    } catch (err) {
      SvalLog.warn(
        `the content classifier refused a list change: ${SvalLog.errorName(err)}`
      );
    }
  }

  #path(id) {
    return PathUtils.join(this.dir, `${id}.txt`);
  }

  /**
   * Reads the lists' state once; every caller waits for the one read, so
   * none clears the due times `schedule` set after it.
   *
   * @returns {Promise<void>}
   */
  #loadMeta() {
    this.#metaLoad ??= (async () => {
      const meta = await readJSONOrSetAside(
        PathUtils.join(this.dir, "lists.json"),
        "the blocking lists' state file"
      );
      this.#meta = meta && typeof meta == "object" ? meta : {};
      for (const entry of Object.values(this.#meta)) {
        delete entry.dueAt;
      }
    })();
    return this.#metaLoad;
  }

  async #saveMeta() {
    await IOUtils.makeDirectory(this.dir, { ignoreExisting: true });
    const saved = {};
    for (const [id, entry] of Object.entries(this.#meta)) {
      saved[id] = { ...entry };
      delete saved[id].dueAt;
    }
    await IOUtils.writeJSON(PathUtils.join(this.dir, "lists.json"), saved, {
      tmpPath: PathUtils.join(this.dir, "lists.json.tmp"),
    });
  }

  /** Forgets what is in memory, so tests can start from the disk again. */
  resetForTesting() {
    this.stop();
    this.#meta = null;
    this.#metaLoad = null;
    this.#metaAsked = false;
    this.#service = null;
    this.#running = null;
  }
}

/** The prefs whose lists the schedule keeps (`#keptIds`). */
const SCHEDULE_PREFS = [
  ENGINE_LISTS_PREF,
  TRACKER_LISTS_PREF,
  TRACKER_TAG_LISTS_PREF,
];

const KNOWN_CATEGORIES = new Set([
  "ads",
  "trackers",
  "annoyances",
  "malware",
  "fixes",
  "other",
]);

export const SvalBlockingLists = new ListLoader();
