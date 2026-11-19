/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sites and policy levels for agents (agent-control spec §5.2). A site is a
 * registrable domain, so `www.ebay.co.uk` and `pay.ebay.co.uk` share one
 * decision. Hosts with no registrable domain (IP literals, `localhost`,
 * single-label intranet names) are their own site.
 *
 * Agents load only http and https pages, plus `about:blank`. Every other
 * scheme is refused, so an agent cannot read local files through `file:` or
 * reach privileged pages such as `about:config`.
 */

import { ToolError } from "moz-src:///browser/components/sval/SvalAgentErrors.sys.mjs";
import {
  mostSpecificRule,
  scopeChain,
  scopeOfHost,
} from "moz-src:///browser/components/sval/SvalSite.sys.mjs";
import {
  cleanPageToolFields,
  mapOf,
} from "moz-src:///browser/components/sval/SvalAgentPageTools.sys.mjs";

export const LEVELS = ["blocked", "read-only", "ask-before-writes", "full"];

const REFUSED = () =>
  new ToolError(
    "unsupported_url",
    "Sval agents can open http and https pages only."
  );

/**
 * @param {string} urlString
 * @returns {{site: string, host: string, choice: boolean}|null} The scopes
 *   of an address an agent may open (`scopeOfHost`), or null for
 *   about:blank. Every other address is refused.
 */
function scopeOfAddress(urlString) {
  let uri;
  try {
    uri = Services.io.newURI(urlString);
  } catch {
    throw REFUSED();
  }
  if (uri.spec === "about:blank") {
    return null;
  }
  if (uri.scheme !== "http" && uri.scheme !== "https") {
    throw REFUSED();
  }
  const scope = scopeOfHost(uri.host);
  if (!scope) {
    throw REFUSED();
  }
  return scope;
}

/**
 * @param {string} urlString
 * @returns {string|null} The site of an address an agent may open, or null
 *   for about:blank. Every other address is refused.
 */
export function agentSiteOf(urlString) {
  return scopeOfAddress(urlString)?.site ?? null;
}

/**
 * The name an agent's rules are looked up by for an address: its host as
 * `scopeOfHost` names a host rule, which is the site where the host offers
 * no choice. The policy's lookups walk from it to the site
 * (`mostSpecificRule`), so it decides wherever a site would.
 *
 * @param {string} urlString
 * @returns {string|null} The host, or null for about:blank. Every address
 *   `agentSiteOf` refuses is refused.
 */
export function hostOf(urlString) {
  return scopeOfAddress(urlString)?.host ?? null;
}

/**
 * The origin of PDF.js, Firefox's PDF viewer, which shows a PDF from the web
 * at the PDF's own address under a principal of its own
 * (`PromptCollection.asyncBeforeUnloadCheck` tells its pages apart by it).
 */
export const PDFJS_ORIGIN = "resource://pdf.js";

/**
 * @param {string} spec
 * @returns {{site: string, host: string, choice: boolean}} Its scopes. A
 *   page with no site, `about:blank`, is refused like any address `agentSiteOf`
 *   refuses.
 */
function scopeRequired(spec) {
  const scope = scopeOfAddress(spec);
  if (scope === null) {
    throw REFUSED();
  }
  return scope;
}

/** The origin of a network error page's principal. */
const NETERROR_ORIGIN = "about:neterror";

/** The origin of the page a load the agent gate refused shows. */
const AGENT_BLOCKED_ORIGIN = "about:agentblocked";

/**
 * The site whose content a document holds, which is what decides whether an
 * agent may read it. A document's address does not say that: an
 * `about:blank` or `about:srcdoc` document inherits the origin of the page
 * that made it, and a sandboxed one gets a null principal. Every case not
 * named here is refused.
 *
 * - A content principal is its address's site, which must be an http or
 *   https one. PDF.js's is the site of the PDF it shows, the document's
 *   address. A network error page's, `about:neterror`, is the site of the
 *   load that failed, by the failed channel the parent holds for the
 *   document (`WindowGlobalParent.failedChannel`): it is docshell's report
 *   on a load the gate already allowed. Its own address is never trusted
 *   for that, and one with no failed channel is refused. A certificate
 *   error page is refused, because it offers to trust the certificate.
 *   The page a load the agent gate refused shows, `about:agentblocked`, has
 *   no site: its text is Sval's, and the refused site sent nothing. One
 *   with no failed channel is refused, as a network error page's is.
 * - A null principal with a precursor is the precursor's site: the origin
 *   whose page made it (nsIPrincipal.idl `precursorPrincipal`), such as a
 *   sandboxed frame's page, or the page a `data:` or `about:blank` document
 *   was loaded from, which a load hands its null principal as precursor
 *   (nsScriptSecurityManager.cpp `GetChannelResultPrincipal`, LoadInfo.cpp
 *   `FindPrincipalToInherit`). The precursor must be a content principal.
 * - A null principal with no precursor holds nothing any site gave it. On
 *   `about:blank` exactly, as the blank page Sval opens an agent's tab on, it
 *   has no site: null.
 * - A document at a `blob:` or `data:` address is refused, whatever its
 *   principal.
 *
 * @param {nsIPrincipal|null|undefined} principal A document's principal.
 * @param {nsIURI|null|undefined} documentURI The document's address.
 * @param {nsIURI|null|undefined} [failedURI] The address of the load whose
 *   failure the document reports, from the parent's failed channel.
 * @returns {{site: string, host: string, choice: boolean}|null} The
 *   scopes (`scopeOfHost`), or null for a page with no site.
 */
function scopeOfPrincipal(principal, documentURI, failedURI) {
  // A page at a `blob:` or `data:` address is one a page made of itself.
  // The gate lets such loads through as possible downloads (`SvalAgentGate`),
  // so the page they show is refused here.
  if (documentURI?.schemeIs("blob") || documentURI?.schemeIs("data")) {
    throw REFUSED();
  }
  if (principal?.isContentPrincipal) {
    if (principal.originNoSuffix === PDFJS_ORIGIN) {
      return scopeRequired(documentURI?.spec ?? "");
    }
    if (principal.originNoSuffix === NETERROR_ORIGIN) {
      return scopeRequired(failedURI?.spec ?? "");
    }
    if (principal.originNoSuffix === AGENT_BLOCKED_ORIGIN) {
      if (!failedURI) {
        throw REFUSED();
      }
      return null;
    }
    return scopeRequired(principal.URI.spec);
  }
  if (principal?.isNullPrincipal) {
    const precursor = principal.precursorPrincipal;
    if (precursor?.isContentPrincipal) {
      return scopeOfPrincipal(precursor, null);
    }
    if (!precursor && documentURI?.spec === "about:blank") {
      return null;
    }
  }
  throw REFUSED();
}

/**
 * @param {nsIPrincipal|null|undefined} principal
 * @param {nsIURI|null|undefined} documentURI
 * @param {nsIURI|null|undefined} [failedURI]
 * @returns {string|null} The site of a document with this principal, as
 *   `scopeOfPrincipal` reads it, or null for a page with none.
 */
export function siteOfPrincipal(principal, documentURI, failedURI) {
  return scopeOfPrincipal(principal, documentURI, failedURI)?.site ?? null;
}

/**
 * @param {nsIPrincipal|null|undefined} principal
 * @param {nsIURI|null|undefined} documentURI
 * @param {nsIURI|null|undefined} [failedURI]
 * @returns {string|null} The host the agent's rules are looked up by for a
 *   document with this principal (`hostOf`), or null for a page with no
 *   site.
 */
export function hostOfPrincipal(principal, documentURI, failedURI) {
  return scopeOfPrincipal(principal, documentURI, failedURI)?.host ?? null;
}

/**
 * The address an agent is told a document has. about:agentblocked's own
 * address carries the whole refused address, which can hold what a page
 * passed to the blocked site, such as a token in a redirect's query, so it
 * is named without it: the page's text names the refused host.
 *
 * @param {WindowGlobalParent} windowGlobal A document the agent may read.
 * @returns {string|null}
 */
export function addressOfDocument(windowGlobal) {
  if (windowGlobal.documentPrincipal?.originNoSuffix === AGENT_BLOCKED_ORIGIN) {
    return AGENT_BLOCKED_ORIGIN;
  }
  return windowGlobal.documentURI?.spec ?? null;
}

/**
 * @param {WindowGlobalParent|null|undefined} windowGlobal
 * @returns {string|null} The site of the document `windowGlobal` holds, as
 *   {@link siteOfPrincipal} gives it. No document is refused.
 */
export function siteOfDocument(windowGlobal) {
  if (!windowGlobal) {
    throw REFUSED();
  }
  return siteOfPrincipal(
    windowGlobal.documentPrincipal,
    windowGlobal.documentURI,
    windowGlobal.failedChannel?.URI
  );
}

/**
 * @param {WindowGlobalParent|null|undefined} windowGlobal
 * @returns {string|null} The host the agent's rules are looked up by for the
 *   document `windowGlobal` holds (`hostOfPrincipal`). No document is
 *   refused.
 */
export function hostOfDocument(windowGlobal) {
  if (!windowGlobal) {
    throw REFUSED();
  }
  return hostOfPrincipal(
    windowGlobal.documentPrincipal,
    windowGlobal.documentURI,
    windowGlobal.failedChannel?.URI
  );
}

/**
 * The level a site gets when nothing grants it more than asking (spec §5.2):
 * a site with no rule under a policy that asks first, and a site the user
 * allowed at Sval's first-visit prompt under such a policy. Its writes are
 * held for the user.
 */
export const DEFAULT_LEVEL = "ask-before-writes";

/**
 * What a policy's `default` can hold for sites with no rule: `"ask"`, which
 * asks the user on the agent's first visit and makes the answer a site rule,
 * or one of `LEVELS`, which such a site gets without asking.
 */
export const DEFAULTS = ["ask", ...LEVELS];

/** The answers a site can hold for downloads, uploads and its console. */
export const FILE_PERMISSIONS = ["allow", "deny"];

/**
 * The folders an `uploads` entry allows files from, or null when the entry
 * allows none. An entry allows uploads only as `{folders: [...]}`: the
 * folders of the files the user approved with "Always allow", each
 * `{path, subfolders}` (spec §5.2, decision 0129). A folder Sval cannot read
 * is left out, and an entry left with none is no decision. A path that is
 * not absolute holds no file (`SvalAgentUploads`, `inUploadFolders`).
 *
 * @param {unknown} entry An `uploads` value.
 * @returns {Array<{path: string, subfolders: boolean}>|null}
 */
export function uploadFoldersOf(entry) {
  const folders = mapOf(entry)?.folders;
  if (!Array.isArray(folders)) {
    return null;
  }
  const kept = folders.flatMap(folder => {
    const { path, subfolders } = mapOf(folder) ?? {};
    return typeof path === "string" && path && typeof subfolders === "boolean"
      ? [{ path, subfolders }]
      : [];
  });
  return kept.length ? kept : null;
}

/**
 * @param {"downloads"|"uploads"|"console"} kind
 * @param {unknown} value
 * @returns {"allow"|"deny"|null} What a `kind` entry holding `value`
 *   decides, or null for a value Sval cannot read. A download or a console
 *   read is allowed by `"allow"`, an upload only from the folders its entry
 *   names (`uploadFoldersOf`).
 */
export function filePermissionOf(kind, value) {
  if (value === "deny") {
    return "deny";
  }
  if (kind === "uploads") {
    return uploadFoldersOf(value) ? "allow" : null;
  }
  return value === "allow" ? "allow" : null;
}

/** A scheme as `nsIURI.scheme` gives it: RFC 3986's syntax, lower case. */
const SCHEME = /^[a-z][a-z0-9+.-]*$/;

/**
 * What an `apps` entry decides (spec §5.2): `"deny"` for every scheme, or
 * each scheme's own answer, as a map of the schemes Sval can read. A scheme
 * Sval cannot read is left out, and an entry left with none is no decision.
 *
 * @param {unknown} entry An `apps` value.
 * @returns {"deny"|{[scheme: string]: "allow"|"deny"}|null}
 */
export function appsOf(entry) {
  if (entry === "deny") {
    return "deny";
  }
  const map = mapOf(entry);
  if (!map) {
    return null;
  }
  const kept = Object.entries(map).filter(
    ([scheme, value]) => SCHEME.test(scheme) && FILE_PERMISSIONS.includes(value)
  );
  return kept.length ? Object.fromEntries(kept) : null;
}

/**
 * @param {string} scheme
 * @returns {boolean} Whether an `apps` entry can hold `scheme`.
 */
export function isAppScheme(scheme) {
  return typeof scheme === "string" && SCHEME.test(scheme);
}

/**
 * The entry of the most specific name along `host`'s scope chain
 * (`mostSpecificRule`) that holds a rule `read` can read in one of the
 * policy's per-site maps.
 *
 * @template T
 * @param {object|null|undefined} policy
 * @param {string} map
 * @param {string} host A host or a site.
 * @param {(value: unknown) => T|null|undefined} read A name's rule, or null
 *   or undefined where its entry holds none for this control.
 * @returns {T|null}
 */
function ruleFor(policy, map, host, read) {
  const entries = mapOf(policy?.[map]);
  if (!entries) {
    return null;
  }
  const found = mostSpecificRule(host, name =>
    Object.hasOwn(entries, name)
      ? (read(entries[name]) ?? undefined)
      : undefined
  );
  return found ? found.rule : null;
}

/**
 * @param {object|null|undefined} policy
 * @param {string} host A host or a site.
 * @param {string} scheme
 * @returns {"allow"|"deny"|null} What the user decided about `host`
 *   opening `scheme` addresses in other applications, by the most specific
 *   name that decided the scheme, or null when none did, which asks.
 */
export function appPermissionFor(policy, host, scheme) {
  return ruleFor(policy, "apps", host, value => {
    const apps = appsOf(value);
    if (apps === "deny") {
      return "deny";
    }
    return apps && Object.hasOwn(apps, scheme) ? apps[scheme] : null;
  });
}

/**
 * The per-site permissions of their own, beside the level, that answer
 * `"allow"` or `"deny"`: files to and from the site, and reading what its
 * pages write to the console (spec §5.2).
 */
export const FILE_KINDS = ["downloads", "uploads", "console"];

/**
 * The policy's maps keyed by site, each read on its own: a site's level and
 * its file permissions.
 */
const SITE_MAPS = ["sites", ...FILE_KINDS, "apps"];

export const POLICY_VERSION = 3;

/** A new agent's policy: every site asks on its first visit. */
export const DEFAULT_POLICY = Object.freeze({
  version: POLICY_VERSION,
  default: "ask",
  sites: Object.freeze({}),
  downloads: Object.freeze({}),
  uploads: Object.freeze({}),
  console: Object.freeze({}),
  apps: Object.freeze({}),
});

/**
 * A site's value in one of the policy's per-site maps, as Sval reads it: the
 * part Sval can read, or null when there is none.
 *
 * @param {string} map One of `SITE_MAPS`.
 * @param {unknown} value
 * @returns {unknown}
 */
function cleanSiteValue(map, value) {
  switch (map) {
    case "sites":
      return LEVELS.includes(value) ? value : null;
    case "apps":
      return appsOf(value);
    case "uploads": {
      if (value === "deny") {
        return value;
      }
      const folders = uploadFoldersOf(value);
      return folders ? { ...value, folders } : null;
    }
    default:
      return filePermissionOf(map, value) ? value : null;
  }
}

/**
 * @param {string} name A key of one of the policy's per-site maps.
 * @returns {boolean} Whether a lookup can reach a rule saved under it: a
 *   site, or a host under its site that offers a choice (`scopeOfHost`).
 */
function isRuleName(name) {
  return scopeOfHost(name)?.host === name;
}

/**
 * The policy as Sval reads it, and whether that differs from what was stored,
 * so the store writes the clean copy back (spec §5.2). Every field Sval does
 * not know is kept as it was.
 *
 * - A policy with no version Sval can read is given `POLICY_VERSION`.
 * - A default Sval cannot read is `"ask"`, Sval's own default.
 * - An entry is named by a site or by a host under its site, as
 *   `scopeOfHost` names them (decision 1980). One named by anything else,
 *   `www.` of a site included, is deleted, as no lookup reaches it.
 * - A site, download, upload, console or apps entry Sval cannot read is
 *   deleted, so the name follows the names above it (`mostSpecificRule`)
 *   or the agent's default, and Sval asks again about what none of them
 *   decides. An upload folder or an app scheme Sval cannot read is deleted
 *   from its entry.
 * - Sites' tools are read as `cleanPageToolFields` says: an answer or grant
 *   Sval cannot read is deleted, so it asks again, its own default.
 * - A per-site map that is not a map is replaced by an empty one. For
 *   `sites`, the default becomes `"ask"` as for a default Sval cannot read.
 *
 * Only a hand-edited `agents.json` holds anything Sval cannot read, or one a
 * later build wrote, which is left as it is.
 *
 * @param {unknown} stored A policy as `agents.json` holds it.
 * @returns {{policy: object, changed: boolean}}
 */
export function cleanPolicy(stored) {
  const raw = mapOf(stored);
  if (!raw) {
    return { policy: structuredClone(DEFAULT_POLICY), changed: true };
  }
  // A later version is a shape this build does not know. It is read as it
  // is, where what this build cannot read follows the default (`levelFor`),
  // and never rewritten, so running an older build loses nothing a newer
  // one wrote.
  if (Number.isInteger(raw.version) && raw.version > POLICY_VERSION) {
    return { policy: raw, changed: false };
  }
  const policy = { ...raw, version: POLICY_VERSION };
  for (const map of SITE_MAPS) {
    if (policy[map] === undefined) {
      policy[map] = {};
      continue;
    }
    const entries = mapOf(policy[map]);
    if (!entries) {
      policy[map] = {};
      if (map === "sites") {
        policy.default = "ask";
      }
      continue;
    }
    const kept = Object.entries(entries).flatMap(([name, value]) => {
      const clean = isRuleName(name) ? cleanSiteValue(map, value) : null;
      return clean === null ? [] : [[name, clean]];
    });
    if (JSON.stringify(kept) !== JSON.stringify(Object.entries(entries))) {
      policy[map] = Object.fromEntries(kept);
    }
  }
  Object.assign(policy, cleanPageToolFields(policy));
  for (const map of ["pageToolSites", "pageToolGrants"]) {
    if (policy[map] !== undefined) {
      policy[map] = Object.fromEntries(
        Object.entries(policy[map]).filter(([name]) => isRuleName(name))
      );
    }
  }
  if (!DEFAULTS.includes(policy.default)) {
    policy.default = "ask";
  }
  return {
    policy,
    changed: JSON.stringify(policy) !== JSON.stringify(stored),
  };
}

/**
 * @param {object|null|undefined} policy
 * @returns {string} The policy's default, one of `DEFAULTS`, or `"ask"` when
 *   it cannot be read.
 */
export function defaultOf(policy) {
  return DEFAULTS.includes(policy?.default) ? policy.default : "ask";
}

/**
 * @param {object|null|undefined} policy
 * @returns {string} The level a site with no rule gets when it opens: the
 *   default level, or `DEFAULT_LEVEL` when the default asks.
 */
export function defaultLevelOf(policy) {
  const value = defaultOf(policy);
  return value === "ask" ? DEFAULT_LEVEL : value;
}

/**
 * An IPv4-mapped IPv6 address as `nsIURI.host` gives it: the URL parser
 * writes the IPv4 part as two hex groups (`rusturl_parse_ipv6addr`).
 */
const IPV4_MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * Where a site's host is when its name or address says it is on the user's
 * side of the internet (spec §5.2): `"computer"` for this computer, which
 * Gecko's `nsIPrincipal.isLoopbackHost` names (`localhost`, a name under
 * `.localhost`, `127.0.0.0/8`, `::1`) along with the any-address that Gecko
 * puts in the same address space (`NetAddr::GetIpAddressSpace`), and
 * `"network"` for the local network: an address `nsIIOService` calls local
 * or shared (private, link-local and unique local addresses, and
 * `100.64.0.0/10`), a name under `.local`, which multicast DNS answers on the
 * local link, and a name of a single label, which the system resolves
 * against its own search domains. A site is a host for exactly those hosts
 * with no registrable domain (`siteOf`), and a name under `.local` or
 * `.localhost` keeps its last label, so the site alone says where it is.
 *
 * An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is placed by its IPv4
 * address, which is where a connection to it goes. `isLoopbackHost` and
 * `hostnameIsSharedIPAddress` look at IPv4 addresses alone
 * (`NetAddr::IsLoopBackAddressWithoutIPv6Mapping`, `NetAddr::IsIPAddrShared`),
 * so a mapped `127.0.0.1` or `100.64.0.1` would otherwise pass as public.
 *
 * @param {string} site A site from `siteOf`.
 * @returns {"computer"|"network"|null}
 */
export function localPlaceOf(site) {
  let uri;
  try {
    uri = Services.io.newURI(
      `http://${site.includes(":") ? `[${site}]` : site}/`
    );
  } catch {
    return null;
  }
  const mapped = IPV4_MAPPED.exec(uri.host);
  if (mapped) {
    const [high, low] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return localPlaceOf(
      [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".")
    );
  }
  if (
    Services.scriptSecurityManager.createContentPrincipal(uri, {})
      .isLoopbackHost ||
    Services.io.hostnameIsIPAddressAny(uri)
  ) {
    return "computer";
  }
  if (
    Services.io.hostnameIsLocalIPAddress(uri) ||
    Services.io.hostnameIsSharedIPAddress(uri)
  ) {
    return "network";
  }
  try {
    Services.eTLD.getBaseDomainFromHost(uri.host);
  } catch (e) {
    return e.result === Cr.NS_ERROR_INSUFFICIENT_DOMAIN_LEVELS
      ? "network"
      : null;
  }
  return uri.host.endsWith(".local") ? "network" : null;
}

/**
 * @param {object|null|undefined} policy
 * @param {string} host A host or a site.
 * @returns {{level: string, known: boolean, asks: boolean}} The level of the
 *   most specific name along the host's scope chain that has a rule
 *   (`mostSpecificRule`). Where none has, the host follows the default, as
 *   it does past a rule Sval cannot read, which only a policy `cleanPolicy`
 *   has not seen can hold: `asks` says whether its first visit asks the
 *   user, under an `"ask"` default or for a local site (`localPlaceOf`)
 *   under any default but `"blocked"`, and its level is the default level,
 *   or `DEFAULT_LEVEL` while it asks. A sites value that is not a map asks,
 *   as `cleanPolicy` makes it.
 */
export function levelFor(policy, host) {
  const sites = mapOf(policy?.sites);
  const level = ruleFor(policy, "sites", host, value =>
    LEVELS.includes(value) ? value : null
  );
  if (level) {
    return { level, known: true, asks: false };
  }
  const site = scopeChain(host).at(-1) ?? host;
  // A local site with no rule asks whatever default lets a new site open
  // (spec §5.2): the user chose that default for sites on the internet.
  const asks =
    defaultOf(policy) === "ask" ||
    (!sites && policy?.sites !== undefined && policy?.sites !== null) ||
    (defaultOf(policy) !== "blocked" && localPlaceOf(site) !== null);
  return {
    level: asks ? DEFAULT_LEVEL : defaultLevelOf(policy),
    known: false,
    asks,
  };
}

/**
 * @param {object|null|undefined} policy
 * @param {"downloads"|"uploads"|"console"} kind
 * @param {string} host A host or a site.
 * @returns {"allow"|"deny"|null} What the user decided for the most
 *   specific name along `host`'s scope chain with an entry Sval can read,
 *   or null when there is none, which asks again.
 */
export function filePermissionFor(policy, kind, host) {
  return ruleFor(policy, kind, host, value => filePermissionOf(kind, value));
}

/**
 * @param {object|null|undefined} policy
 * @param {string} host A host or a site.
 * @returns {Array<{path: string, subfolders: boolean}>} The folders the
 *   agent may upload files from to `host` without asking, by the entry that
 *   decides its uploads (`filePermissionFor`), none when that entry allows
 *   none.
 */
export function uploadFoldersFor(policy, host) {
  const entry = ruleFor(policy, "uploads", host, value =>
    filePermissionOf("uploads", value) ? value : null
  );
  return uploadFoldersOf(entry) ?? [];
}

/**
 * What a load of `host` gets under `policy`.
 *
 * @param {object|null} policy An agent's policy, as `store.policyOf` gives it.
 *   Null is an agent Sval does not know.
 * @param {string} host A host or a site.
 * @returns {"allow"|"deny"|"ask"}
 */
export function decideLoad(policy, host) {
  if (!policy || typeof policy !== "object") {
    return "deny";
  }
  const { level, asks } = levelFor(policy, host);
  if (asks) {
    return "ask";
  }
  return level === "blocked" ? "deny" : "allow";
}
