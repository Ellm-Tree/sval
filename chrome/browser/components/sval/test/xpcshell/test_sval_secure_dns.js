/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Secure DNS's checks on resolver URLs and synced values (decision 0105):
 * which resolvers are on the device's own network, the aliases of listed
 * resolvers, and what a synced value must be to apply.
 */

const {
  SvalSecureDns,
  CLOUDFLARE_URL,
  EXCLUDED_PREF,
  MODE_PREF,
  QUAD9_URL,
  SYNC_RULES,
  URI_PREF,
  isLocalResolverURL,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecureDns.sys.mjs"
);

add_task(function local_resolvers_are_recognised() {
  for (const url of [
    "https://192.168.1.2/dns-query",
    "https://10.0.0.53/dns-query",
    "https://172.16.4.4/dns-query",
    "https://169.254.1.1/dns-query",
    "https://100.100.100.100/dns-query",
    "https://127.0.0.1/dns-query",
    "https://localhost/dns-query",
    "https://[::1]/dns-query",
    "https://[fd00::53]/dns-query",
    "https://[fe80::1]/dns-query",
    "https://pihole/dns-query",
    "https://pihole.local/dns-query",
    "https://nas.home.arpa/dns-query",
  ]) {
    Assert.ok(isLocalResolverURL(url), `${url} is local`);
  }
  for (const url of [
    QUAD9_URL,
    CLOUDFLARE_URL,
    "https://1.1.1.1/dns-query",
    "https://[2606:4700:4700::1111]/dns-query",
    "https://resolver.example.com/dns-query",
    "not a url",
  ]) {
    Assert.ok(!isLocalResolverURL(url), `${url} is not local`);
  }
});

add_task(function aliases_name_the_listed_resolver() {
  Assert.equal(
    SvalSecureDns.canonicalURL("https://mozilla.cloudflare-dns.com/dns-query"),
    CLOUDFLARE_URL,
    "Firefox's default provider is Cloudflare"
  );
  Assert.equal(
    SvalSecureDns.canonicalURL("https://one.one.one.one/dns-query"),
    CLOUDFLARE_URL,
    "Cloudflare's other documented host"
  );
  Assert.equal(SvalSecureDns.canonicalURL(QUAD9_URL), QUAD9_URL);
  Assert.equal(
    SvalSecureDns.canonicalURL("https://resolver.example/dns-query"),
    "https://resolver.example/dns-query"
  );
});

add_task(function synced_values_must_be_valid() {
  const mode = SYNC_RULES[MODE_PREF];
  for (const value of [0, 2, 3, 5]) {
    Assert.ok(mode.accepts(value), `mode ${value} applies`);
  }
  for (const value of [1, 4, 6, -1, "2", 2.5]) {
    Assert.ok(!mode.accepts(value), `mode ${value} is refused`);
  }

  const uri = SYNC_RULES[URI_PREF];
  Assert.ok(uri.accepts(QUAD9_URL));
  Assert.ok(uri.accepts("https://resolver.example/dns-query"));
  for (const value of [
    "http://resolver.example/dns-query",
    "resolver.example",
    "https:///dns-query",
    "",
    42,
    "https://192.168.1.2/dns-query",
  ]) {
    Assert.ok(!uri.accepts(value), `${value} is refused`);
  }
  Assert.ok(uri.staysOnDevice("https://192.168.1.2/dns-query"));
  Assert.ok(!uri.staysOnDevice(QUAD9_URL));

  const names = SYNC_RULES[EXCLUDED_PREF];
  for (const value of ["", "nas.example", "a.example, b.example", "printer"]) {
    Assert.ok(names.accepts(value), `${JSON.stringify(value)} applies`);
  }
  for (const value of ["a.example,not/a/host", "x?y", "a@b", 3]) {
    Assert.ok(!names.accepts(value), `${JSON.stringify(value)} is refused`);
  }
});
