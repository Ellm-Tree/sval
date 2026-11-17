/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * What a site is, and the names a choice for one can be saved under
 * (decision 1980). A site is a registrable domain by the Public Suffix List,
 * so `www.ebay.co.uk` and `pay.ebay.co.uk` are one. Hosts with no registrable
 * domain (IP literals, `localhost`, single-label intranet names) are their
 * own site. Only http and https addresses have one.
 */

/**
 * The site of an http or https URI's host, by the Public Suffix List.
 *
 * @param {string} uriHost `nsIURI.host`.
 * @returns {{site: string, host: string, suffix?: true}|null} The site and
 *   the host it was read from, or null for a host this cannot classify. A
 *   host that is itself a public suffix, such as `github.io`, is its own
 *   site and has `suffix`.
 */
function siteOfHost(uriHost) {
  // `example.com.` and `example.com` are one site: a trailing dot must not
  // let a page dodge the decision made for the name without it. Any other
  // empty label, such as a second trailing dot, names no host, and would
  // otherwise be a site of its own.
  const host = uriHost.replace(/\.$/, "");
  if (!host || host.split(".").includes("")) {
    return null;
  }
  try {
    return { site: Services.eTLD.getBaseDomainFromHost(host), host };
  } catch (e) {
    // An IP literal, `localhost` or a single-label host has no registrable
    // domain, so the host is the site. Any other failure is a host this
    // function cannot classify.
    if (e.result === Cr.NS_ERROR_HOST_IS_IP_ADDRESS) {
      return { site: host, host };
    }
    if (e.result === Cr.NS_ERROR_INSUFFICIENT_DOMAIN_LEVELS) {
      return host.includes(".")
        ? { site: host, host, suffix: true }
        : { site: host, host };
    }
    return null;
  }
}

/**
 * The scopes a choice made on a page of `uriHost` can be saved at
 * (decision 1980): the host, and the site above it. A host offers the
 * choice only when it differs from its site. `www.` of a site is the site,
 * and an IP address, `localhost` and a public suffix are their own sites,
 * so none of them offers it.
 *
 * @param {string} uriHost `nsIURI.host`.
 * @returns {{site: string, host: string, choice: boolean}|null} The site,
 *   the host a host rule is named by (the site where there is no choice),
 *   and whether there is a choice; null for a host `siteOfHost` cannot
 *   classify.
 */
export function scopeOfHost(uriHost) {
  const found = siteOfHost(uriHost);
  if (!found) {
    return null;
  }
  const { site, host } = found;
  const choice = !found.suffix && host !== site && host !== `www.${site}`;
  return { site, host: choice ? host : site, choice };
}

/**
 * @param {string} urlString An http or https address.
 * @returns {{site: string, host: string, choice: boolean}|null} Its scopes,
 *   as `scopeOfHost` gives them, or null for any other address.
 */
export function scopeOf(urlString) {
  let uri;
  try {
    uri = Services.io.newURI(urlString);
  } catch {
    return null;
  }
  if (uri.scheme !== "http" && uri.scheme !== "https") {
    return null;
  }
  return scopeOfHost(uri.host);
}

/**
 * The names whose rules can decide for `host`, most specific first: the
 * host, each name above it, then its site. A host rule covers the names
 * under it, so the first of these holding a rule for a control decides it.
 *
 * @param {string} host A host or a site, as `scopeOfHost` names it.
 * @returns {string[]}
 */
export function scopeChain(host) {
  const found = siteOfHost(host);
  if (!found) {
    return [];
  }
  const names = [];
  let name = found.host;
  while (name !== found.site && name.endsWith(`.${found.site}`)) {
    names.push(name);
    name = name.slice(name.indexOf(".") + 1);
  }
  names.push(found.site);
  return names;
}

/**
 * The first answer `ruleOf` gives along `host`'s scope chain.
 *
 * @template T
 * @param {string} host
 * @param {(name: string) => T|undefined} ruleOf A store's own rule for a
 *   name, undefined where it holds none.
 * @returns {{name: string, rule: T}|null} The rule that decides and the
 *   name it is saved under, or null where no name holds one.
 */
export function mostSpecificRule(host, ruleOf) {
  for (const name of scopeChain(host)) {
    const rule = ruleOf(name);
    if (rule !== undefined) {
      return { name, rule };
    }
  }
  return null;
}

/**
 * @param {string} urlString
 * @returns {string|null} The address's site, or null for an address that
 *   has none: anything but an http or https page of a host `scopeOfHost`
 *   can classify.
 */
export function siteOf(urlString) {
  return scopeOf(urlString)?.site ?? null;
}

/**
 * The site a rule the user types covers: what they typed, read as a host or
 * as an address, cut to its registrable domain by the Public Suffix List as
 * `siteOf` cuts a page's address, so the rule is the one a page of it is
 * decided by.
 *
 * @param {string} text
 * @returns {{site: string, host: string, suffix?: true}|{error: string}}
 *   The site and the host it was read from, or why there is none: `"empty"`
 *   or `"not-a-site"`. A host that is itself a public suffix, such as
 *   `github.io`, is its own site, as in `siteOf`, and has `suffix`: the
 *   rule covers that host alone, since each name under it is a site of its
 *   own.
 */
export function siteOfEntry(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return { error: "empty" };
  }
  const spec = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let uri;
  try {
    uri = Services.io.newURI(spec);
  } catch {
    return { error: "not-a-site" };
  }
  if (uri.scheme !== "http" && uri.scheme !== "https") {
    return { error: "not-a-site" };
  }
  return siteOfHost(uri.host) ?? { error: "not-a-site" };
}

/** The schemes a site's own origins are made of (`siteOrigins`). */
export const SITE_SCHEMES = Object.freeze(["http", "https"]);

/**
 * The site a page address has a rule under, or null for an address no rule
 * can cover: anything but an http or https page.
 *
 * @param {nsIURI} uri
 * @returns {string|null}
 */
export function siteForURI(uri) {
  return uri ? siteOf(uri.spec) : null;
}

/**
 * The scopes a choice made on a page address can be saved at (decision
 * 1980), or null for an address no rule can cover.
 *
 * @param {nsIURI} uri
 * @returns {{site: string, host: string, choice: boolean}|null} As
 *   `scopeOf` gives them.
 */
export function scopeForURI(uri) {
  return uri ? scopeOf(uri.spec) : null;
}

/**
 * A site's root address under each scheme, leaving out any that does not
 * parse.
 *
 * @param {string} site As `siteOf` cuts one.
 * @param {string[]} schemes
 * @returns {nsIURI[]}
 */
export function siteOrigins(site, schemes) {
  // `siteOf` gives an IPv6 literal without its brackets.
  const host = site.includes(":") ? `[${site}]` : site;
  const uris = [];
  for (const scheme of schemes) {
    try {
      uris.push(Services.io.newURI(`${scheme}://${host}/`));
    } catch {
      // A name that is no host has no address, and so nothing to enter.
    }
  }
  return uris;
}
