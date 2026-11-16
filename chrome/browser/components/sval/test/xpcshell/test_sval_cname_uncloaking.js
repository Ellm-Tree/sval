/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

// A request whose host is a CNAME to a host on another site is matched again
// by that canonical name (protections spec §1.1). Requests go to a local
// server, with the native resolver's override answering for the test hosts.

do_get_profile();

const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

const LISTS_LOADED = "test-content-classifier-filter-lists-loaded";

const RULES = [
  "||listed.test^",
  "||tracker.test^",
  "||cdn.first.test^",
  "@@||excepted.first.test^",
];

const dnsOverride = Cc["@mozilla.org/network/native-dns-override;1"].getService(
  Ci.nsINativeDNSResolverOverride
);

let server;
let port;

/**
 * @param {string} host
 * @param {string} [cname] The host's canonical name.
 */
function serveAs(host, cname) {
  server.identity.add("http", host, port);
  dnsOverride.addIPOverride(host, "127.0.0.1");
  if (cname) {
    dnsOverride.setCnameOverride(host, cname);
  }
}

/**
 * Loads `url` as a script of a page on first.test.
 *
 * @param {string} url
 * @returns {Promise<number>} The request's status.
 */
function load(url) {
  const channel = NetUtil.newChannel({
    uri: url,
    loadingPrincipal:
      Services.scriptSecurityManager.createContentPrincipalFromOrigin(
        "http://first.test"
      ),
    securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_SCRIPT,
  });
  return within(
    new Promise(resolve => {
      channel.asyncOpen({
        onStartRequest() {},
        onDataAvailable(request, stream, offset, count) {
          NetUtil.readInputStreamToString(stream, count);
        },
        onStopRequest(request, status) {
          resolve(status);
        },
      });
    }),
    10_000,
    `the load of ${url}`
  );
}

add_setup(async function () {
  server = new HttpServer();
  server.start(-1);
  port = server.identity.primaryPort;
  server.registerPathHandler("/list.txt", (request, response) => {
    response.setHeader("Content-Type", "text/plain");
    response.write(RULES.join("\n") + "\n");
  });
  server.registerPathHandler("/script.js", (request, response) => {
    response.setHeader("Content-Type", "text/javascript");
    response.write("");
  });
  serveAs("listed.test");
  serveAs("metrics.first.test", "x.tracker.test");
  serveAs("excepted.first.test", "x.tracker.test");
  serveAs("www.first.test", "cdn.first.test");
  serveAs("cdn.other.test", "edge.cdn-host.test");
  serveAs("proxied.first.test", "x.tracker.test");

  for (const [pref, value] of [
    ["network.proxy.type", 0],
    ["privacy.trackingprotection.content.testing", true],
    ["privacy.trackingprotection.content.protection.enabled", true],
    [
      "privacy.trackingprotection.urlclassifier.disable_for_channel_classifier",
      true,
    ],
    [
      "privacy.trackingprotection.content.protection.test_list_urls",
      `http://localhost:${port}/list.txt`,
    ],
  ]) {
    if (typeof value == "number") {
      Services.prefs.setIntPref(pref, value);
    } else if (typeof value == "boolean") {
      Services.prefs.setBoolPref(pref, value);
    } else {
      Services.prefs.setStringPref(pref, value);
    }
  }
  Cc["@mozilla.org/url-classifier/dbservice;1"].getService(
    Ci.nsIUrlClassifierDBService
  );
  Cc["@mozilla.org/content-classifier-service;1"].getService(
    Ci.nsIContentClassifierService
  );
  const loaded = within(
    TestUtils.topicObserved(LISTS_LOADED, (s, installed) =>
      installed.split(",").includes("test_block")
    ),
    10_000,
    "the test list's engine"
  );
  Services.prefs.setStringPref(
    "privacy.trackingprotection.content.protection.engines",
    "test_block"
  );
  await loaded;

  registerCleanupFunction(async () => {
    dnsOverride.clearOverrides();
    Services.dns.clearCache(true);
    await new Promise(resolve => server.stop(resolve));
  });
});

add_task(async function a_listed_host_is_blocked() {
  Assert.equal(
    await load(`http://listed.test:${port}/script.js`),
    Cr.NS_ERROR_TRACKING_URI
  );
});

add_task(async function a_host_cloaking_a_listed_one_is_blocked() {
  Assert.equal(
    await load(`http://metrics.first.test:${port}/script.js`),
    Cr.NS_ERROR_TRACKING_URI
  );
});

add_task(async function an_exception_for_the_address_lets_it_through() {
  Assert.equal(
    await load(`http://excepted.first.test:${port}/script.js`),
    Cr.NS_OK
  );
});

add_task(async function a_canonical_name_on_the_same_site_is_ignored() {
  Assert.equal(await load(`http://www.first.test:${port}/script.js`), Cr.NS_OK);
});

add_task(async function an_unlisted_canonical_name_loads() {
  Assert.equal(await load(`http://cdn.other.test:${port}/script.js`), Cr.NS_OK);
});

add_task(async function behind_a_proxy_only_the_host_is_matched() {
  Services.prefs.setIntPref("network.proxy.type", 1);
  Services.prefs.setStringPref("network.proxy.http", "localhost");
  Services.prefs.setIntPref("network.proxy.http_port", port);
  registerCleanupFunction(() => {
    Services.prefs.setIntPref("network.proxy.type", 0);
    Services.prefs.clearUserPref("network.proxy.http");
    Services.prefs.clearUserPref("network.proxy.http_port");
  });
  Assert.equal(
    await load(`http://proxied.first.test:${port}/script.js`),
    Cr.NS_OK
  );
});
