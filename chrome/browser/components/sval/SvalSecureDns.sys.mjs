/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Secure DNS: one global choice between the network's own
 * DNS and encrypted DNS, with or without falling back to the network's.
 * Settings' Protections card and the protection button's panel both read and
 * write it here, so the two always say the same thing.
 *
 * The choice is Gecko's `network.trr.mode` and nothing else. Which resolver
 * encrypted DNS uses is `network.trr.uri`, which Firefox's own controls in the
 * card set; while it is empty Gecko uses `network.trr.default_provider_uri`
 * (`TRRServiceBase::CheckURIPrefs`). ECH needs nothing here: Gecko's
 * `network.dns.echconfig.enabled` and `network.dns.http3_echconfig.enabled`
 * are on by default, and encrypted DNS is what brings sites' ECH configs.
 */

export const MODE_PREF = "network.trr.mode";
export const URI_PREF = "network.trr.uri";
export const EXCLUDED_PREF = "network.trr.excluded-domains";

export const QUAD9_URL = "https://dns.quad9.net/dns-query";
export const CLOUDFLARE_URL = "https://cloudflare-dns.com/dns-query";

/**
 * Other URLs for a resolver Sval lists, each to the URL Sval lists it under:
 * Firefox's own default provider, Mozilla's endpoint at Cloudflare
 * (`network.trr.default_provider_uri` in `StaticPrefList.yaml`), and the
 * other host Cloudflare's DoH documentation gives.
 */
const ALIASES = new Map([
  ["https://mozilla.cloudflare-dns.com/dns-query", CLOUDFLARE_URL],
  ["https://one.one.one.one/dns-query", CLOUDFLARE_URL],
]);

/**
 * Names that only mean something on the network that defines them: mDNS
 * (RFC 6762) and home networks (RFC 8375).
 */
const LOCAL_SUFFIXES = ["local", "home.arpa"];

/** Where Settings shows the card. */
export const SETTINGS_URL = "about:preferences#privacy-secureDns";

/**
 * The choices, in the order they are offered. `mode` is the
 * `nsIDNSService` resolver mode each writes: Firefox's Default, Increased
 * and Max Protection levels.
 */
export const CHOICES = Object.freeze([
  Object.freeze({
    value: "network",
    mode: Ci.nsIDNSService.MODE_NATIVEONLY,
    label: "Your network's DNS",
    short: "Network",
    description:
      "Works with internal names, VPNs and router filters. Your network can see the sites you look up.",
  }),
  Object.freeze({
    value: "fallback",
    mode: Ci.nsIDNSService.MODE_TRRFIRST,
    label: "Encrypted, with fallback",
    short: "Encrypted",
    description:
      "Looks sites up through the resolver below, and through your network's DNS when that fails.",
  }),
  Object.freeze({
    value: "strict",
    mode: Ci.nsIDNSService.MODE_TRRONLY,
    label: "Encrypted only",
    short: "Encrypted only",
    description:
      "Looks sites up only through the resolver below. If it can't be reached, sites don't load.",
  }),
]);

/**
 * Whether a resolver URL's host is on the device's own network, where another
 * device cannot be assumed to reach it: a private, shared, link-local or
 * loopback address (`hostnameIsLocalIPAddress`, `hostnameIsSharedIPAddress`,
 * a principal's `isLoopbackHost`), a single-label name, or a name under
 * `LOCAL_SUFFIXES`.
 *
 * @param {string} url
 * @returns {boolean} false for a URL that does not parse.
 */
export function isLocalResolverURL(url) {
  let uri;
  try {
    uri = Services.io.newURI(url);
  } catch {
    return false;
  }
  let host;
  try {
    host = uri.host.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  if (!host) {
    return false;
  }
  if (
    Services.io.hostnameIsLocalIPAddress(uri) ||
    Services.io.hostnameIsSharedIPAddress(uri) ||
    Services.scriptSecurityManager.createContentPrincipal(uri, {})
      .isLoopbackHost
  ) {
    return true;
  }
  // An IPv6 literal has no dots and is not a name.
  if (!host.includes(":") && !host.includes(".")) {
    return true;
  }
  return LOCAL_SUFFIXES.some(
    suffix => host === suffix || host.endsWith(`.${suffix}`)
  );
}

/**
 * @param {string} url
 * @returns {boolean} Whether `url` is an https URL with a host, as a DoH
 *   resolver's is (RFC 8484 §3).
 */
function isResolverURL(url) {
  try {
    const uri = Services.io.newURI(url);
    return uri.schemeIs("https") && !!uri.host;
  } catch {
    return false;
  }
}

/**
 * @param {string} list
 * @returns {boolean} Whether `list` is hostnames separated by commas or
 *   whitespace, as `TRRService::ReadPrefs` reads it. A name is what Firefox's
 *   exceptions dialog stores for it (`gDoHExceptionsManager.addException`):
 *   the host of `http://<name>`.
 */
function isHostList(list) {
  return list
    .split(/[\s,]+/)
    .filter(Boolean)
    .every(name => {
      try {
        return Services.io.newURI(`http://${name}`).host === name;
      } catch {
        return false;
      }
    });
}

/** The modes a synced value may set: the choices', and Firefox's Off. */
const SYNCED_MODES = new Set([
  ...CHOICES.map(c => c.mode),
  Ci.nsIDNSService.MODE_TRROFF,
]);

/**
 * How `SvalSettingsSync` treats each Secure DNS pref (`SvalSettingsRegistry`'s
 * `VALUE_RULES`). `accepts` is what a synced value must be to apply; anything
 * else leaves this device's value as it is. `staysOnDevice` marks a value
 * that is never published: a resolver on this device's own network.
 * The other devices then use their own resolver, Quad9 if
 * they have none.
 */
export const SYNC_RULES = Object.freeze({
  [MODE_PREF]: Object.freeze({
    accepts: value => SYNCED_MODES.has(value),
  }),
  [URI_PREF]: Object.freeze({
    accepts: value =>
      typeof value === "string" &&
      isResolverURL(value) &&
      !isLocalResolverURL(value),
    staysOnDevice: value =>
      typeof value === "string" && isLocalResolverURL(value),
  }),
  [EXCLUDED_PREF]: Object.freeze({
    accepts: value => typeof value === "string" && isHostList(value),
  }),
});

export const SvalSecureDns = {
  /**
   * @param {string} url A resolver URL.
   * @returns {string} The URL Sval lists the same resolver under, or `url`.
   */
  canonicalURL(url) {
    return ALIASES.get(url) ?? url;
  },

  /**
   * @param {number} mode A `network.trr.mode` value.
   * @returns {string} The choice it is. Gecko treats every other mode as
   *   not using encrypted DNS (`ModeFromPrefs`), which is the network's DNS.
   */
  choiceOf(mode) {
    return CHOICES.find(c => c.mode === mode)?.value ?? "network";
  },

  /**
   * @param {string} value A choice's `value`.
   * @returns {number} The `network.trr.mode` it writes.
   */
  modeOf(value) {
    const choice = CHOICES.find(c => c.value === value);
    if (!choice) {
      throw new Error(`not a Secure DNS choice: ${value}`);
    }
    return choice.mode;
  },

  /** @returns {object} The current choice, one of `CHOICES`. */
  current() {
    const value = this.choiceOf(Services.prefs.getIntPref(MODE_PREF, 0));
    return CHOICES.find(c => c.value === value);
  },

  /** @param {string} value A choice's `value`. */
  choose(value) {
    Services.prefs.setIntPref(MODE_PREF, this.modeOf(value));
  },
};
