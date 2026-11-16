// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

"use strict";

/**
 * Kagi's answer to a private load that spent a Privacy Pass token (Kagi
 * Privacy Pass spec): a 401 costs the tab one reload with a fresh token, at
 * most once a minute, and a 403 leaves the stock as it is.
 *
 * Kagi is stood in for by Mozilla's Node HTTPS test server, which the harness
 * starts beside every mochitest run. It serves a certificate for `kagi.com`
 * signed by the test CA it installs, and `network.dns.localDomains` sends
 * `kagi.com` to it, so each page is a real private load of
 * `https://kagi.com:<port>/search` that receives the status it asks for.
 *
 * Whether a tab was reloaded is read from the loads that followed: the
 * reload is decided as the tab's load stops, before the test sees the tab
 * settle, and a reload asked for then opens its request before any load the
 * test starts after it.
 */

const { SvalKagi } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagi.sys.mjs"
);
const { SvalKagiPrivacyPass } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagiPrivacyPass.sys.mjs"
);
const { NodeHTTPSServer } = ChromeUtils.importESModule(
  "resource://testing-common/NodeServer.sys.mjs"
);

/** More than the stock at which a spent token starts a refill. */
const STOCK = 60;

let kagi;
let refills = 0;
/** Kagi's responses, in order: see `record`. */
const seen = [];
/** The query of every request opened to Kagi, in order. */
const opened = [];

/** Sets the stock to `STOCK` tokens, the newest last, with no refill. */
function fillStock() {
  const privacyPass = SvalKagiPrivacyPass;
  privacyPass._loaded = Promise.resolve();
  privacyPass._unavailable = false;
  privacyPass._unsupported = false;
  privacyPass._outUntil = 0;
  privacyPass._tokens = Array.from({ length: STOCK }, (_, i) => [
    `t${i}`,
    Date.now(),
  ]);
}

/**
 * Records a response from Kagi in `seen`: its query, its status and the
 * Privacy Pass token its request spent.
 *
 * @param {nsISupports} subject The channel.
 */
function record(subject) {
  const channel = subject.QueryInterface(Ci.nsIHttpChannel);
  if (channel.URI.host !== "kagi.com") {
    return;
  }
  let authorization = null;
  try {
    authorization = channel.getRequestHeader("Authorization");
  } catch (e) {}
  seen.push({
    query: channel.URI.query,
    status: channel.responseStatus,
    token: authorization?.match(/^PrivateToken token="(.*)"$/)?.[1] ?? null,
  });
}

/** @param {nsISupports} subject A channel being opened. */
function recordOpening(subject) {
  const channel = subject.QueryInterface(Ci.nsIHttpChannel);
  if (channel.URI.host === "kagi.com") {
    opened.push(channel.URI.query);
  }
}

function forget() {
  seen.length = 0;
  opened.length = 0;
}

/**
 * Loads `query` from the address bar and waits until the tab has finished
 * with it, and with any reload it caused.
 *
 * @param {Element} browser
 * @param {string} query
 * @param {number} responses How many responses Kagi has sent once it is done.
 */
async function load(browser, query, responses) {
  const url = `${kagi}/search?${query}`;
  BrowserTestUtils.startLoadingURIString(browser, url);
  // The parent hears of a remote tab's load after its response: until the
  // tab shows `url`, a load not yet begun there reads as settled.
  await TestUtils.waitForCondition(
    () =>
      seen.length >= responses &&
      browser.currentURI.spec == url &&
      !browser.webProgress.isLoadingDocument,
    `the tab settles after ${responses} responses`
  );
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["network.dns.localDomains", "kagi.com"]],
  });
  const server = new NodeHTTPSServer();
  await server.start(0, ["kagi.com"]);
  await server.registerPathHandler("/search", (req, resp) => {
    const url = new URL(req.url, "https://kagi.com");
    resp.writeHead(Number(url.searchParams.get("status")), {
      "Content-Type": "text/html",
    });
    // A page Kagi has begun and not finished sending, so its load goes on.
    if (url.searchParams.has("hold")) {
      resp.write("<!-- held -->");
      return;
    }
    resp.end("<title>Kagi</title>");
  });
  kagi = `https://kagi.com:${server.port()}`;

  const privacyPass = SvalKagiPrivacyPass;
  const saved = {
    fetch: privacyPass._fetch,
    persist: privacyPass._persist,
    refill: privacyPass.refill,
  };
  privacyPass._fetch = () => Promise.reject(new Error("no network in tests"));
  privacyPass._persist = () => {};
  privacyPass.refill = () => {
    refills++;
    return Promise.resolve();
  };
  Services.obs.addObserver(record, "http-on-examine-response");
  Services.obs.addObserver(recordOpening, "http-on-opening-request");
  // A stock in hand before the start, so the start reads no other.
  fillStock();
  SvalKagi.start();
  registerCleanupFunction(async () => {
    SvalKagi.stop();
    Services.obs.removeObserver(record, "http-on-examine-response");
    Services.obs.removeObserver(recordOpening, "http-on-opening-request");
    Object.assign(privacyPass, saved);
    privacyPass._reset();
    await server.stop();
  });
});

add_task(async function a_spent_token_reloads_the_tab_once_a_minute() {
  fillStock();
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a new private window opening"
  );
  const browser = win.gBrowser.selectedBrowser;
  forget();

  await load(browser, "status=401&n=1", 2);
  Assert.deepEqual(
    seen,
    [
      { query: "status=401&n=1", status: 401, token: `t${STOCK - 1}` },
      { query: "status=401&n=1", status: 401, token: `t${STOCK - 2}` },
    ],
    "a 401 reloads the tab once, with a fresh token, and the reload's own " +
      "401 does not reload it again"
  );

  await load(browser, "status=401&n=2", 3);
  await load(browser, "status=200&n=3", 4);
  Assert.deepEqual(
    opened.slice(2),
    ["status=401&n=2", "status=200&n=3"],
    "nor does another 401 within the minute"
  );

  SvalKagi._reloads.set(browser, Date.now() - 61 * 1000);
  await load(browser, "status=401&n=4", 6);
  Assert.deepEqual(
    seen.slice(4).map(({ query }) => query),
    ["status=401&n=4", "status=401&n=4"],
    "a minute later, a 401 reloads it again"
  );
  Assert.equal(
    new Set(seen.map(({ token }) => token)).size,
    seen.length,
    "and every load spent a token of its own"
  );

  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the test window closing"
  );
});

add_task(async function a_403_keeps_the_stock_and_shows_kagis_page() {
  fillStock();
  refills = 0;
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a new private window opening"
  );
  const browser = win.gBrowser.selectedBrowser;
  forget();

  await load(browser, "status=403", 1);
  Assert.deepEqual(
    seen,
    [{ query: "status=403", status: 403, token: `t${STOCK - 1}` }],
    "the load spent a token and Kagi refused it"
  );
  Assert.equal(
    SvalKagiPrivacyPass.count(),
    STOCK - 1,
    "the stock keeps every token but the one the load spent"
  );
  Assert.equal(refills, 0, "and no refill starts");
  Assert.equal(
    browser.currentURI.spec,
    `${kagi}/search?status=403`,
    "the tab shows Kagi's own page"
  );
  await load(browser, "status=200", 2);
  Assert.deepEqual(
    opened,
    ["status=403", "status=200"],
    "and the tab is not reloaded"
  );

  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the test window closing"
  );
});

add_task(async function a_401_left_before_it_stops_is_not_reloaded() {
  fillStock();
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a new private window opening"
  );
  const browser = win.gBrowser.selectedBrowser;
  forget();

  BrowserTestUtils.startLoadingURIString(
    browser,
    `${kagi}/search?status=401&hold`
  );
  // Left once it has begun showing: the user sees the page Kagi refused and
  // goes elsewhere before it finishes.
  await TestUtils.waitForCondition(
    () => seen.length && browser.currentURI.spec.endsWith("status=401&hold"),
    "Kagi's 401 begins showing"
  );
  await load(browser, "status=200&n=1", 2);
  await load(browser, "status=401&n=2", 4);
  Assert.deepEqual(
    opened,
    ["status=401&hold", "status=200&n=1", "status=401&n=2", "status=401&n=2"],
    "a 401 the user left before it loaded is not reloaded, and does not " +
      "spend the tab's reload for the minute"
  );

  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the test window closing"
  );
});

add_task(async function a_401_to_a_form_is_not_sent_again() {
  fillStock();
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a new private window opening"
  );
  const browser = win.gBrowser.selectedBrowser;
  forget();
  // The reload of a form asks before it opens a request, so the ask itself
  // is counted.
  let reloads = 0;
  browser.reload = function () {
    reloads++;
    return Object.getPrototypeOf(this).reload.call(this);
  };

  const body = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
    Ci.nsIStringInputStream
  );
  body.setByteStringData("q=sval");
  const postData = Cc[
    "@mozilla.org/network/mime-input-stream;1"
  ].createInstance(Ci.nsIMIMEInputStream);
  postData.addHeader("Content-Type", "application/x-www-form-urlencoded");
  postData.setData(body);
  browser.loadURI(Services.io.newURI(`${kagi}/search?status=401&post`), {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    postData,
  });
  await TestUtils.waitForCondition(
    () => seen.length && !browser.webProgress.isLoadingDocument,
    "the form's 401 settles"
  );
  Assert.ok(seen[0].token, "the form spent a token");
  await load(browser, "status=200", 2);
  Assert.equal(reloads, 0, "the form's tab is not reloaded");
  Assert.deepEqual(
    opened,
    ["status=401&post", "status=200"],
    "nor the form sent again"
  );

  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the test window closing"
  );
});
