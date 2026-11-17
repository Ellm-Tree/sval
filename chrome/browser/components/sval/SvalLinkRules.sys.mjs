/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Link routing's rules (link routing spec §6): each sends the links from
 * other apps that match it straight to a workspace, the first match in the
 * list winning. A rule matches a site, its subdomains included, or an
 * address that contains some text.
 *
 * The rules are one synced setting, a JSON list in {@link RULES_PREF}, so
 * the list's order travels with it and a reorder on one device is the order
 * on every other. A rule names its workspace by the tree's id; whether that
 * workspace is still there, and still one a link may open in, is read from
 * the tree each time it is needed, never kept here.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  siteOfEntry: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
});

export const RULES_PREF = "browser.sval.links.rules";

/** A rule's kinds: a site and its subdomains, or text in the address. */
export const SITE = "site";
export const CONTAINS = "contains";

/** The shortest text an "address contains" rule may hold. */
const CONTAINS_MIN = 3;

/**
 * The host a site rule holds for what the user typed or pasted: the host of
 * an address, with its scheme, port, path and a leading `www.` dropped. A
 * public suffix, such as `co.uk`, is refused: every site under it is a site
 * of its own, and a rule for it would take them all. The Public Suffix List
 * is read as `siteOfEntry` reads it for an agent's site rules.
 *
 * @param {string} text
 * @returns {string|null} the host, or null when it names no site.
 */
export function siteValue(text) {
  const read = lazy.siteOfEntry(text);
  if (read.error || read.suffix) {
    return null;
  }
  const host = read.host.toLowerCase().replace(/^www\./, "");
  if (host === read.host.toLowerCase()) {
    return host;
  }
  const bare = lazy.siteOfEntry(host);
  return bare.error || bare.suffix ? null : host;
}

/**
 * The text an "address contains" rule holds: what was typed, in lower case,
 * when it is long enough to mean something and has no spaces, which an
 * address never holds.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function containsValue(text) {
  const value = String(text ?? "")
    .trim()
    .toLowerCase();
  return value.length >= CONTAINS_MIN && !/\s/.test(value) ? value : null;
}

/**
 * @param {string} kind {@link SITE} or {@link CONTAINS}.
 * @param {string} text
 * @returns {string|null} what a rule of `kind` holds for `text`.
 */
export function ruleValue(kind, text) {
  return kind === SITE ? siteValue(text) : containsValue(text);
}

/**
 * @param {*} rule
 * @returns {boolean} whether `rule` is one this build can apply, as it was
 *   saved: a kind, a value of that kind's shape, and a workspace id. A saved
 *   site is checked for the shape of a host alone: the Public Suffix List
 *   it was checked against when it was typed is updated as Sval runs, and a
 *   change there must not make every rule unreadable.
 */
function isRule(rule) {
  return (
    !!rule &&
    typeof rule === "object" &&
    (rule.kind === SITE || rule.kind === CONTAINS) &&
    typeof rule.value === "string" &&
    (rule.kind === SITE
      ? /^[a-z0-9._:-]+$/.test(rule.value)
      : containsValue(rule.value) === rule.value) &&
    typeof rule.workspace === "string" &&
    rule.workspace !== ""
  );
}

/**
 * @param {string} text The pref's value.
 * @returns {object[]|null} its rules, `{ kind, value, workspace }`, or null
 *   when it is not a list of rules.
 */
function parse(text) {
  if (text === "") {
    return [];
  }
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || !list.every(isRule)) {
    return null;
  }
  return list.map(({ kind, value, workspace }) => ({ kind, value, workspace }));
}

/** What `SvalSettingsSync` lets a synced list of rules be. */
export const SYNC_RULES = Object.freeze({
  [RULES_PREF]: Object.freeze({
    accepts: value => typeof value === "string" && parse(value) !== null,
  }),
});

/**
 * @returns {object[]} the rules, in order.
 */
export function rules() {
  const list = parse(Services.prefs.getStringPref(RULES_PREF, ""));
  if (!list) {
    lazy.SvalLog.warn("the link rules are not a list of rules");
    return [];
  }
  return list;
}

/**
 * Saves the rules, in order, as one write. None is no user value, which
 * syncs as a reset.
 *
 * @param {object[]} list
 */
export function setRules(list) {
  if (!list.length) {
    Services.prefs.clearUserPref(RULES_PREF);
    return;
  }
  Services.prefs.setStringPref(
    RULES_PREF,
    JSON.stringify(
      list.map(({ kind, value, workspace }) => ({ kind, value, workspace }))
    )
  );
}

/**
 * Whether a link matches a rule. A site rule matches its host and every
 * host under it (`nsIEffectiveTLDService.hasRootDomain`); a contains rule
 * matches an address holding its text, in any case.
 *
 * @param {object} rule
 * @param {nsIURI} uri An http or https address.
 * @returns {boolean}
 */
export function matches(rule, uri) {
  if (rule.kind === SITE) {
    const host = uri.asciiHost.replace(/\.$/, "");
    return !!host && Services.eTLD.hasRootDomain(host, rule.value);
  }
  return addressForms(uri).some(form => form.includes(rule.value));
}

/**
 * An address as it is sent, and as a person reads it: the host in Unicode
 * and the path decoded, so text typed with accents matches too.
 *
 * @param {nsIURI} uri
 * @returns {string[]} in lower case.
 */
function addressForms(uri) {
  const forms = [uri.spec, uri.displaySpec];
  try {
    forms.push(decodeURI(uri.displaySpec));
  } catch {
    // Percent-escapes that are not UTF-8 stay as they are sent.
  }
  return forms.map(form => form.toLowerCase());
}

/**
 * Whether every link `later` matches, `earlier` matches too, so that
 * `later` can never apply below it: a site under the same site or a parent
 * one, text that holds a contains rule's text, or a site whose name holds
 * it. A site rule never covers a contains rule, whose text can match other
 * sites.
 *
 * @param {object} earlier
 * @param {object} later
 * @returns {boolean}
 */
export function alwaysMatchesFirst(earlier, later) {
  if (earlier.kind === SITE) {
    return (
      later.kind === SITE &&
      Services.eTLD.hasRootDomain(later.value, earlier.value)
    );
  }
  return later.value.includes(earlier.value);
}

/**
 * The rule above `at` that always matches first, so that rule `at` never
 * applies. A rule whose workspace is gone is skipped by every link, so it
 * covers nothing.
 *
 * @param {object[]} list
 * @param {number} at
 * @param {Set<string>} workspaces The ids a link may open in.
 * @returns {number} its index, or -1.
 */
export function coveredBy(list, at, workspaces) {
  for (let i = 0; i < at; i++) {
    if (
      workspaces.has(list[i].workspace) &&
      alwaysMatchesFirst(list[i], list[at])
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * How a rule is named in Settings' sentences: its site, or its text in
 * quotation marks.
 *
 * @param {object} rule
 * @returns {string}
 */
export function describe(rule) {
  return rule.kind === SITE ? rule.value : `"${rule.value}"`;
}

/**
 * The workspaces the rules send a link to, in the order they are tried.
 *
 * @param {nsIURI} uri An http or https address.
 * @returns {string[]} workspace ids, first match first.
 */
export function workspacesFor(uri) {
  return rules()
    .filter(rule => matches(rule, uri))
    .map(rule => rule.workspace);
}

export const SvalLinkRules = {
  RULES_PREF,
  SITE,
  CONTAINS,
  alwaysMatchesFirst,
  containsValue,
  coveredBy,
  describe,
  matches,
  ruleValue,
  rules,
  setRules,
  siteValue,
  workspacesFor,
};
