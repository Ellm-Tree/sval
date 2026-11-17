/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Reads and edits one site's lines in the user's "My filters" text (element
 * picker spec §2). The text is plain filter syntax, one rule per line, so a
 * line the picker wrote is a line the user can read and edit.
 *
 * A line belongs to a scope, a site or a host under it (decision 1980), when
 * the scope is one of its plain domains: the left of `##` or `#?#` in a
 * cosmetic rule, the `domain=` option of a network rule. A site's lines are
 * its own and its hosts', each host grouped under `scopeOfHost`'s site. A
 * `~` entry, an exception (`#@#`, `@@`), a scriptlet (`+js(`), an HTML filter
 * (`^`) and any other cosmetic form (`#@?#`, `#$#`, `#%#`) never belong to
 * it: they are not hidden elements. A `#@#` line naming a scope is the
 * picker's "show on this host only", which Forget takes with the rest.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  scopeOfHost: "moz-src:///browser/components/sval/SvalSite.sys.mjs",
});

const COSMETIC = /^([^#\s]*)(##|#\?#)(.+)$/;
const OTHER_COSMETIC = /^[^#\s]*#[@$%]?\??#/;
const EXCEPTION = /^([^#\s]+)#@#(.+)$/;
// Where a would-be domain list holds one of these, the `##` is in a network
// rule's path.
const NOT_A_DOMAIN_LIST = /[/|*]/;
/** A host name of two labels or more, each letters, digits and inner hyphens. */
export const HOST =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * The parts of a line that can name a site, or null for any other line.
 *
 * @param {string} line
 * @returns {?{kind: string, domains: string[], shown: string,
 *   rebuild: (domains: string[]) => string}}
 */
function parse(line) {
  let text = line.trim();
  if (!text || text.startsWith("!") || text.startsWith("@@")) {
    return null;
  }
  let cosmetic = COSMETIC.exec(text);
  if (cosmetic && !NOT_A_DOMAIN_LIST.test(cosmetic[1])) {
    let [, domainList, separator, selector] = cosmetic;
    if (
      !domainList ||
      selector.startsWith("+js(") ||
      selector.startsWith("^")
    ) {
      return null;
    }
    return {
      kind: "hide",
      domains: domainList.split(","),
      shown: selector,
      rebuild: domains => `${domains.join(",")}${separator}${selector}`,
    };
  }
  if (!cosmetic && OTHER_COSMETIC.test(text)) {
    return null;
  }
  let at = text.lastIndexOf("$");
  if (at < 0) {
    return null;
  }
  let pattern = text.slice(0, at);
  let options = text.slice(at + 1).split(",");
  let slot = options.findIndex(option => option.startsWith("domain="));
  if (slot < 0) {
    return null;
  }
  return {
    kind: "network",
    domains: options[slot].slice("domain=".length).split("|"),
    shown: pattern,
    rebuild: domains => {
      let rebuilt = options.slice();
      rebuilt[slot] = `domain=${domains.join("|")}`;
      return `${pattern}$${rebuilt.join(",")}`;
    },
  };
}

/**
 * @param {string} domain A plain domain of a line, lowercased.
 * @returns {?string} The site it is grouped under, or null for a name
 *   `scopeOfHost` cannot classify.
 */
function siteOfDomain(domain) {
  return HOST.test(domain) ? (lazy.scopeOfHost(domain)?.site ?? null) : null;
}

/**
 * @param {?object} parsed
 * @param {string} site
 * @returns {string[]} The plain domains of the line grouped under `site`,
 *   lowercased, each once.
 */
function scopesOfSite(parsed, site) {
  let wanted = site.toLowerCase();
  let found = new Set();
  for (let domain of parsed?.domains ?? []) {
    let lower = domain.toLowerCase();
    if (lower === wanted || siteOfDomain(lower) === wanted) {
      found.add(lower);
    }
  }
  return [...found];
}

function listsSite(parsed, site) {
  let wanted = site.toLowerCase();
  return !!parsed && parsed.domains.some(d => d.toLowerCase() === wanted);
}

/**
 * The `#@#` exception line's domains, or null for any other line.
 *
 * @param {string} line
 * @returns {?{domains: string[], rebuild: (domains: string[]) => string}}
 */
function parseException(line) {
  let found = EXCEPTION.exec(line.trim());
  if (!found) {
    return null;
  }
  let [, domainList, selector] = found;
  return {
    domains: domainList.split(","),
    rebuild: domains => `${domains.join(",")}#@#${selector}`,
  };
}

/**
 * The rule line text with `site` taken out, or null when no plain domain is
 * left: a line with only `~` entries would apply to every other site.
 *
 * @param {{domains: string[], rebuild: Function}} parsed
 * @param {string} site
 * @returns {?string}
 */
function withoutSite(parsed, site) {
  let wanted = site.toLowerCase();
  let rest = parsed.domains.filter(d => d.toLowerCase() !== wanted);
  if (!rest.some(d => !d.startsWith("~"))) {
    return null;
  }
  return parsed.rebuild(rest);
}

/**
 * @param {string} scope A site, or a host under it.
 * @param {string} selector
 * @returns {string} the cosmetic rule that hides `selector` on `scope`.
 */
export function hideLine(scope, selector) {
  return `${scope}##${selector}`;
}

/**
 * @param {string} host
 * @param {string} selector
 * @returns {string} the exception that shows `selector` again on `host`
 *   under a line that hides it on the host's site.
 */
export function exceptionLine(host, selector) {
  return `${host}#@#${selector}`;
}

/**
 * The network rule that blocks `url` on `scope`, a site or a host under it.
 * The scheme, query and fragment are dropped so that the rule covers the
 * resource however it is asked for.
 *
 * @param {string} scope
 * @param {string} url
 * @returns {?string} null when a rule would match more than that one file: a
 *   URL that does not parse, a path of `/`, or a path holding `*`, `^`, `|`
 *   or `$`, which the rule syntax reads as wildcards, a separator, an anchor
 *   or the start of the options.
 */
export function networkLine(scope, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return null;
  }
  let { host, pathname } = parsed;
  // The URL parser percent-encodes some of these, so the text as given is
  // checked too.
  let given = url.split(/[?#]/)[0];
  if (pathname === "/" || /[*^|$]/.test(pathname + given)) {
    return null;
  }
  return `||${host}${pathname}$domain=${scope}`;
}

/**
 * The lines that name `scope` itself, newest (last in the text) first.
 *
 * @param {string} text
 * @param {string} scope A site or a host.
 * @returns {Array<{index: number, line: string, kind: string, shown: string,
 *   scope: string}>}
 */
export function linesForScope(text, scope) {
  let found = [];
  let wanted = scope.toLowerCase();
  text.split("\n").forEach((line, index) => {
    let parsed = parse(line);
    if (listsSite(parsed, scope)) {
      found.push({
        index,
        line,
        kind: parsed.kind,
        shown: parsed.shown,
        scope: wanted,
      });
    }
  });
  return found.reverse();
}

/**
 * The lines of `site` and of its hosts, newest (last in the text) first. A
 * line naming several of them comes once for each, with the one it names in
 * `scope`.
 *
 * @param {string} text
 * @param {string} site
 * @returns {Array<{index: number, line: string, kind: string, shown: string,
 *   scope: string}>}
 */
export function linesForSite(text, site) {
  let found = [];
  text.split("\n").forEach((line, index) => {
    let parsed = parse(line);
    for (let scope of scopesOfSite(parsed, site)) {
      found.push({
        index,
        line,
        kind: parsed.kind,
        shown: parsed.shown,
        scope,
      });
    }
  });
  return found.reverse();
}

/**
 * What `linesForSite` gives for every site at once, from one reading of the
 * text.
 *
 * @param {string} text
 * @returns {Map<string, Array<{index: number, line: string, kind: string,
 *   shown: string, scope: string}>>} Each lowercased site, with its lines
 *   and its hosts' newest first. A site no line names is not in the map. A
 *   domain `scopeOfHost` cannot classify is a key of its own.
 */
export function linesBySite(text) {
  let bySite = new Map();
  text.split("\n").forEach((line, index) => {
    let parsed = parse(line);
    let entries = [];
    for (let scope of new Set(parsed?.domains.map(d => d.toLowerCase()))) {
      let site = siteOfDomain(scope) ?? scope;
      if (!bySite.has(site)) {
        bySite.set(site, []);
      }
      entries.push([site, scope]);
    }
    // Within one line, in the order `linesForSite` lists its scopes.
    for (let [site, scope] of entries) {
      bySite.get(site).unshift({
        index,
        line,
        kind: parsed.kind,
        shown: parsed.shown,
        scope,
      });
    }
  });
  return bySite;
}

/**
 * The sites that lines name, each once, lowercased, in the order the text
 * first names them. A line naming a host counts for the host's site. Only a
 * plain host counts: a `~` entry, a wildcard or an entity (`google.*`) names
 * no one site, and only the lines `linesForSite` reads count.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function sitesInFilters(text) {
  let sites = new Set();
  for (let scope of scopesInFilters(text)) {
    sites.add(siteOfDomain(scope) ?? scope);
  }
  return [...sites];
}

/**
 * The sites and hosts that lines name, each once, lowercased, in the order
 * the text first names them, as `sitesInFilters` reads them.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function scopesInFilters(text) {
  let scopes = new Set();
  for (let line of text.split("\n")) {
    let parsed = parse(line);
    for (let domain of parsed?.domains ?? []) {
      if (HOST.test(domain)) {
        scopes.add(domain.toLowerCase());
      }
    }
  }
  return [...scopes];
}

/**
 * The `#@#` exceptions in the text by the plain host they name, each
 * lowercased, with the selectors it shows again, oldest first: the picker's
 * "show on this host only" (host-scoped rules spec §4).
 *
 * @param {string} text
 * @returns {Map<string, string[]>}
 */
export function exceptionsInFilters(text) {
  let byScope = new Map();
  for (let line of text.split("\n")) {
    let found = EXCEPTION.exec(line.trim());
    if (!found) {
      continue;
    }
    let [, domainList, selector] = found;
    for (let domain of new Set(domainList.toLowerCase().split(","))) {
      if (HOST.test(domain)) {
        byScope.set(domain, [...(byScope.get(domain) ?? []), selector]);
      }
    }
  }
  return byScope;
}

/**
 * The text with each of `scopes` taken out of every `#@#` line that shows
 * `selector` again, a line naming no other host deleted.
 *
 * @param {string} text
 * @param {string[]} scopes A host and the names above it.
 * @param {string} selector
 * @returns {?string} null when no such line names one of them.
 */
export function hideAgain(text, scopes, selector) {
  let wanted = new Set(scopes.map(s => s.toLowerCase()));
  let changed = false;
  let kept = [];
  for (let line of text.split("\n")) {
    let found = EXCEPTION.exec(line.trim());
    if (!found || found[2] !== selector) {
      kept.push(line);
      continue;
    }
    let parsed = parseException(line);
    let rest = parsed.domains.filter(d => !wanted.has(d.toLowerCase()));
    if (rest.length === parsed.domains.length) {
      kept.push(line);
      continue;
    }
    changed = true;
    if (rest.length) {
      let edited = parsed.rebuild(rest);
      kept.push(line.endsWith("\r") ? `${edited}\r` : edited);
    }
  }
  return changed ? kept.join("\n") : null;
}

/**
 * Takes `site` out of the line at `index`. A line left with no other site is
 * deleted. A line that does not name the site, or an index outside the text,
 * leaves the text as it is.
 *
 * @param {string} text
 * @param {number} index
 * @param {string} site
 * @returns {string}
 */
export function removeSiteFromLine(text, index, site) {
  let lines = text.split("\n");
  let result = editLine(lines[index], site);
  if (result === undefined) {
    return text;
  }
  if (result === null) {
    lines.splice(index, 1);
  } else {
    lines[index] = result;
  }
  return lines.join("\n");
}

/**
 * The text with `scope` taken out of the line whose text is `line`, found
 * again by that text so that a change made since the caller read the lines
 * cannot make this edit another one. The last such line is the one edited,
 * as `linesForScope` lists the newest first.
 *
 * @param {string} text
 * @param {string} line
 * @param {string} scope The site or host the line names, its `scope`.
 * @returns {?string} null when no line of `text` that names `scope` reads as
 *   `line`.
 */
export function showAgain(text, line, scope) {
  const found = linesForScope(text, scope).find(l => l.line === line);
  return found ? removeSiteFromLine(text, found.index, scope) : null;
}

/**
 * The edited line, null to delete it, undefined to leave it.
 *
 * @param {string} line
 * @param {string} site
 * @returns {?string|undefined}
 */
function editLine(line, site) {
  if (line === undefined) {
    return undefined;
  }
  let parsed = parse(line);
  if (!listsSite(parsed, site)) {
    return undefined;
  }
  let edited = withoutSite(parsed, site);
  return edited !== null && line.endsWith("\r") ? `${edited}\r` : edited;
}

/**
 * Takes `site` and its hosts out of every line that names them, the `#@#`
 * exceptions that name them included.
 *
 * @param {string} text
 * @param {string} site
 * @returns {{text: string, removed: number}} how many lines named the site
 *   or one of its hosts.
 */
export function forgetSite(text, site) {
  let removed = 0;
  let kept = [];
  for (let line of text.split("\n")) {
    let parsed = parse(line) ?? parseException(line);
    let scopes = scopesOfSite(parsed, site);
    if (!scopes.length) {
      kept.push(line);
      continue;
    }
    removed++;
    let rest = parsed.domains.filter(d => !scopes.includes(d.toLowerCase()));
    if (rest.some(d => !d.startsWith("~"))) {
      let edited = parsed.rebuild(rest);
      kept.push(line.endsWith("\r") ? `${edited}\r` : edited);
    }
  }
  return { text: kept.join("\n"), removed };
}

/**
 * Adds `lines` after the text, each on a line of its own.
 *
 * @param {string} text
 * @param {string[]} lines
 * @returns {string}
 */
export function appendLines(text, lines) {
  if (!lines.length) {
    return text;
  }
  let base = text.replace(/\r?\n$/, "");
  return base ? `${base}\n${lines.join("\n")}` : lines.join("\n");
}
