/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Which company owns which domains, so that a company's tracker is not tagged
 * as one on that company's own sites (decision 1051). The tag is the
 * classification Firefox's cookie blocking reads; blocking is not affected.
 *
 * The groups come from AdGuard's companiesdb and Sval's own additions, each
 * bundled under its own license (`tracker-owners/`, refreshed by
 * scripts/update-tracker-owners.py), and from Privacy Badger's
 * multiDomainFirstParties, which is GPL-3.0 and so never ships in Sval:
 * SvalBlockingLists downloads it with the lists and hands its copy to `rules`.
 * Each group is used as its source gives it, never merged with another's, so
 * one source's mistake cannot join two companies.
 *
 * `rules` turns the groups into exception rules for the `trackers-content`
 * feature: for each host of a group that the tracker lists block, itself or
 * below it, an exception for requests to that host from the group's own
 * sites. A host no list names needs none, which keeps the list to what could
 * be tagged. Hosts stay as the sources give them, never widened to their
 * registrable domain, so a company's host on shared hosting
 * (`abc.cloudfront.net`) excepts that host alone; and the group's own sites
 * are only its entries that are registrable domains, so shared hosting is
 * never one of them.
 */

import { OWNERS as ADGUARD } from "chrome://browser/content/sval/tracker-owners/adguard-companiesdb.mjs";
import { HOSTS as SHARED_HOSTING } from "chrome://browser/content/sval/tracker-owners/shared-hosting.mjs";
import { OWNERS as SVAL } from "chrome://browser/content/sval/tracker-owners/sval.mjs";

/** The list id the content classifier asks SvalBlockingLists for. */
export const TRACKER_OWNERS_LIST = "sval-tracker-owners";

/**
 * The pref that holds where Privacy Badger publishes its groups, as a
 * JavaScript module.
 */
export const FIRST_PARTIES_URL_PREF =
  "browser.sval.adblock.source.firstParties";

/** The most the download may weigh: several times its size. */
export const MAX_FIRST_PARTIES_BYTES = 2 * 1024 * 1024;

/** What declares the groups in the module `FIRST_PARTIES_URL_PREF` names. */
const FIRST_PARTIES_START = "let multiDomainFirstPartiesArray = [";

/** A host as Privacy Badger writes one: lower case, ASCII, two labels or more. */
const HOST =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Hosts that hold a public suffix, which `isSuffix` cannot see. */
const SHARED = new Set(SHARED_HOSTING);

/**
 * An error whose reason is fixed text, safe for the log.
 *
 * @param {string} reason
 * @returns {Error}
 */
function refusal(reason) {
  const err = new Error(reason);
  err.reason = reason;
  return err;
}

/**
 * Reads Privacy Badger's groups out of its module as data. The module is
 * JavaScript and is never evaluated: this reads the one array literal it
 * declares, an array of arrays of host strings with optional trailing commas,
 * whitespace and `//` comments between them, and refuses anything else.
 *
 * @param {string} text The downloaded module.
 * @returns {string[][]} Its groups.
 * @throws {Error} With a `reason` when the text is not that shape.
 */
export function parseFirstParties(text) {
  if (typeof text != "string" || text.length > MAX_FIRST_PARTIES_BYTES) {
    throw refusal("too large");
  }
  const start = text.indexOf(FIRST_PARTIES_START);
  if (
    start < 0 ||
    text.includes(FIRST_PARTIES_START, start + FIRST_PARTIES_START.length)
  ) {
    throw refusal("no groups array");
  }
  let at = start + FIRST_PARTIES_START.length;
  const gap = /(?:\s|\/\/[^\n]*)*/y;
  const skip = () => {
    gap.lastIndex = at;
    gap.exec(text);
    at = gap.lastIndex;
  };
  const groups = [];
  let group = null;
  // After an opening bracket or a comma, a value may come next.
  let valueNext = true;
  for (;;) {
    skip();
    const ch = text[at];
    if (ch === undefined) {
      throw refusal("unterminated");
    }
    if (group) {
      if (ch == '"' && valueNext) {
        const end = text.indexOf('"', at + 1);
        const host = end < 0 ? "" : text.slice(at + 1, end);
        if (host.length > 253 || !HOST.test(host)) {
          throw refusal("not a host");
        }
        group.push(host);
        at = end + 1;
        valueNext = false;
      } else if (ch == "," && !valueNext) {
        at++;
        valueNext = true;
      } else if (ch == "]" && group.length) {
        groups.push(group);
        group = null;
        at++;
        valueNext = false;
      } else {
        throw refusal("unexpected text in a group");
      }
    } else if (ch == "[" && valueNext) {
      group = [];
      at++;
      valueNext = true;
    } else if (ch == "," && !valueNext) {
      at++;
      valueNext = true;
    } else if (ch == "]" && groups.length) {
      at++;
      break;
    } else {
      throw refusal("unexpected text between groups");
    }
  }
  skip();
  if (text[at] != ";") {
    throw refusal("unterminated");
  }
  return groups;
}

/** A network rule's target: `||host^` at the start of a blocking rule. */
const BLOCKED_HOST = /^\|\|([a-z0-9.-]+)\^/i;

/**
 * @param {string} host
 * @returns {?string} Its registrable domain, or null for a host the Public
 *   Suffix List gives none.
 */
function registrable(host) {
  try {
    return Services.eTLD.getBaseDomainFromHost(host.toLowerCase());
  } catch {
    return null;
  }
}

/**
 * @param {string} host
 * @returns {boolean} Whether the Public Suffix List names the host, as it
 *   does shared hosting such as cloudfront.net, whose sites are everyone's.
 *   scripts/update-tracker-owners.py drops those, and the hosts above them,
 *   from the bundled sources; this keeps any from the downloaded groups and
 *   Sval's own additions, and `SHARED` the hosts above them.
 */
function isSuffix(host) {
  try {
    return Services.eTLD.getPublicSuffixFromHost(host) == host;
  } catch {
    return true;
  }
}

/**
 * @param {string} host
 * @returns {string} The host as a rule names it: lower case, no `www.`.
 */
function normalized(host) {
  host = host.toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * @param {string[][]} [firstParties] Privacy Badger's groups, as
 *   `parseFirstParties` gives them, when Sval has a copy.
 * @returns {string[][]} Every source's groups of hosts, each with at least
 *   two.
 */
export function ownerGroups(firstParties = []) {
  const groups = [
    ...firstParties,
    ...ADGUARD,
    ...SVAL.map(entry => Object.keys(entry.domains)),
  ];
  return groups
    .map(group =>
      [...new Set(group.map(normalized))]
        .filter(host => !isSuffix(host) && !SHARED.has(host))
        .sort()
    )
    .filter(group => group.length > 1);
}

/**
 * @param {string[]} group
 * @returns {string[]} The group's entries that are sites of their own: a
 *   registrable domain, not a host under someone else's.
 */
export function ownSites(group) {
  return group.filter(host => registrable(host) == host);
}

/**
 * @param {Iterable<string>} texts The tracker lists' rules.
 * @returns {Set<string>} The hosts their blocking rules name, and every host
 *   above each, so that a host covers what a list blocks at or below it.
 */
function trackedHosts(texts) {
  const hosts = new Set();
  for (const text of texts) {
    for (const line of text.split("\n")) {
      const match = BLOCKED_HOST.exec(line);
      if (!match) {
        continue;
      }
      const labels = normalized(match[1]).split(".");
      for (let i = 0; i < labels.length - 1; i++) {
        hosts.add(labels.slice(i).join("."));
      }
    }
  }
  return hosts;
}

/**
 * @param {Iterable<string>} trackerListTexts The active tracker lists' rules.
 * @param {string[][]} [firstParties] As `ownerGroups` takes them.
 * @returns {string} Exception rules, one a line: `@@||host^$domain=` the
 *   host's owner's sites.
 */
export function rules(trackerListTexts, firstParties = []) {
  const tracked = trackedHosts(trackerListTexts);
  const lines = new Set();
  for (const group of ownerGroups(firstParties)) {
    const sites = ownSites(group);
    if (!sites.length) {
      continue;
    }
    for (const host of group) {
      if (tracked.has(host)) {
        lines.add(`@@||${host}^$domain=${sites.join("|")}`);
      }
    }
  }
  return [...lines].join("\n");
}
