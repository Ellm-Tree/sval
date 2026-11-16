// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

"use strict";

/**
 * Kagi signs in by its own `kagi_session` cookie in normal windows, and Sval
 * reads it only to say so and to fetch Privacy Pass tokens. A private window
 * is sent no session of the normal window's. It signs in with a Privacy Pass
 * token, and with a Session Link the user pasted only when the plan has no
 * Privacy Pass, as an `X-Kagi-Authorization` header (Kagi Privacy Pass spec).
 *
 * The Session Link cases run with the stock set to a plan without Privacy
 * Pass; the token cases set the stock themselves.
 *
 * The header is checked on channels that are announced to
 * `http-on-modify-request` and never opened: the observer is the whole
 * mechanism, and no test can map a real host to `kagi.com` over https.
 */

const { SvalKagi } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagi.sys.mjs"
);
const { SvalKagiPrivacyPass } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagiPrivacyPass.sys.mjs"
);

const HEADER = "X-Kagi-Authorization";
const COOKIE = "kagi_session";

const SYSTEM = Symbol("system principal");
const NULL_PRINCIPAL = Symbol("null principal");

const NORMAL = {};
const PRIVATE = { privateBrowsingId: 1 };

/**
 * @param {string} value
 * @param {string} [host]
 * @param {boolean} [secure]
 * @param {number} [lifetimeMs] How long the cookie lasts from now.
 * @returns {nsICookieValidation} what Gecko made of it.
 */
function setCookie(
  value,
  host = "kagi.com",
  secure = true,
  lifetimeMs = 3600 * 1000
) {
  return Services.cookies.add(
    host,
    "/",
    COOKIE,
    value,
    secure,
    true,
    false,
    // Cookie expiry is in milliseconds.
    Date.now() + lifetimeMs,
    NORMAL,
    Ci.nsICookie.SAMESITE_LAX,
    Ci.nsICookie.SCHEME_HTTPS
  );
}

function removeCookie(host = "kagi.com") {
  Services.cookies.remove(host, COOKIE, "/", NORMAL);
}

/**
 * @param {...*} args As `channelAfterRequest` takes.
 * @returns {string|null} the value of the Kagi header afterwards, or null.
 */
function headerAfterRequest(...args) {
  return header(channelAfterRequest(...args), HEADER);
}

/**
 * @param {nsIHttpChannel} channel
 * @param {string} name
 * @returns {string|null} the value of `name` on `channel`, or null.
 */
function header(channel, name) {
  try {
    return channel.getRequestHeader(name);
  } catch (e) {
    return null;
  }
}

/**
 * A channel to `url` as a window with `originAttributes` would make it,
 * announced to `http-on-modify-request`.
 *
 * @param {string} url
 * @param {object} originAttributes `PRIVATE` or `NORMAL`.
 * @param {number} policyType An `nsIContentPolicy` type.
 * @param {string|null} carried A header value the channel already carries.
 * @param {string|null} initiator The address of the page that started the
 *   load; `url` itself when null; or `SYSTEM` (the address bar, a bookmark, a
 *   search engine) or `NULL_PRINCIPAL` (a sandboxed or data: page).
 * @param {string} method The request method.
 * @returns {nsIHttpChannel} the channel, after the observers have seen it.
 */
function channelAfterRequest(
  url,
  originAttributes,
  policyType = Ci.nsIContentPolicy.TYPE_DOCUMENT,
  carried = null,
  initiator = null,
  method = "GET"
) {
  const uri = Services.io.newURI(url);
  let channel;
  if (initiator === SYSTEM) {
    channel = NetUtil.newChannel({
      uri,
      loadUsingSystemPrincipal: true,
      contentPolicyType: policyType,
    }).QueryInterface(Ci.nsIHttpChannel);
    channel.loadInfo.originAttributes = originAttributes;
  } else {
    const principal =
      initiator === NULL_PRINCIPAL
        ? Services.scriptSecurityManager.createNullPrincipal(originAttributes)
        : Services.scriptSecurityManager.createContentPrincipal(
            Services.io.newURI(initiator ?? url),
            originAttributes
          );
    channel = NetUtil.newChannel({
      uri,
      loadingPrincipal: principal,
      triggeringPrincipal: principal,
      securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
      contentPolicyType: policyType,
    }).QueryInterface(Ci.nsIHttpChannel);
  }
  channel.requestMethod = method;
  Assert.equal(
    channel.loadInfo.originAttributes.privateBrowsingId,
    originAttributes.privateBrowsingId ?? 0,
    "the channel is in the window kind the case asks for"
  );
  Assert.equal(
    channel.loadInfo.triggeringPrincipal.isSystemPrincipal,
    initiator === SYSTEM,
    "and was started by the kind of page the case asks for"
  );
  if (carried) {
    channel.setRequestHeader(HEADER, carried, false);
  }
  Services.obs.notifyObservers(channel, "http-on-modify-request");
  return channel;
}

/**
 * Sets the Privacy Pass stock, with no refill reaching Kagi.
 *
 * @param {object} stock
 * @param {string[]} [stock.tokens]
 * @param {boolean} [stock.unsupported]
 * @param {number} [stock.outUntil]
 */
function setStock({ tokens = [], unsupported = false, outUntil = 0 } = {}) {
  const privacyPass = SvalKagiPrivacyPass;
  privacyPass._loaded = Promise.resolve();
  privacyPass._unavailable = false;
  privacyPass._tokens = tokens.map(token => [token, Date.now()]);
  privacyPass._unsupported = unsupported;
  privacyPass._outUntil = outUntil;
}

/** What Sval's secret store holds for Kagi, as a list of zero or one. */
async function loginsHeld() {
  const stored = await SvalKagi._stored();
  return stored ? [{ password: stored.token, source: stored.source }] : [];
}

// How many times a sign-in has told the Privacy Pass stock to ask Kagi.
let signInCalls = 0;

async function reset() {
  Services.cookies.removeAll();
  await SvalKagi.clearToken();
}

add_setup(async function () {
  const privacyPass = SvalKagiPrivacyPass;
  const saved = {
    fetch: privacyPass._fetch,
    persist: privacyPass._persist,
    refill: privacyPass.refill,
    signedIn: privacyPass.signedIn,
  };
  // Nothing here reaches Kagi or the store: the stock is what each case sets.
  privacyPass._fetch = () => Promise.reject(new Error("no network in tests"));
  privacyPass._persist = () => {};
  privacyPass.refill = () => Promise.resolve();
  // The cookie cases sign in and out of a normal window, which would ask Kagi
  // about the plan again. Each call is counted.
  privacyPass.signedIn = () => {
    signInCalls++;
    return Promise.resolve();
  };
  await reset();
  setStock({ unsupported: true });
  SvalKagi.start();
  registerCleanupFunction(async () => {
    SvalKagi.stop();
    removeCookie();
    await SvalKagi.clearToken();
    Object.assign(privacyPass, saved);
    privacyPass._reset();
  });
});

add_task(async function a_normal_windows_session_never_reaches_a_private_one() {
  Assert.equal(await SvalKagi.token(), null, "nothing is held to begin with");

  setCookie("cookie-token");
  Assert.ok(SvalKagi.signedIn(), "a normal window's sign-in is seen");
  Assert.equal(await SvalKagi.token(), null, "and is not taken as a token");
  Assert.equal(
    headerAfterRequest("https://kagi.com/search?q=x", PRIVATE),
    null,
    "so a private window's request to Kagi carries nothing"
  );
  Assert.equal((await loginsHeld()).length, 0, "and nothing is stored");

  await reset();
});

add_task(async function only_a_new_session_value_asks_kagi_again() {
  await reset();
  const before = signInCalls;

  setCookie("session-a", "kagi.com", true, 3600 * 1000);
  Assert.equal(signInCalls, before + 1, "a new session asks Kagi");

  setCookie("session-a", "kagi.com", true, 7200 * 1000);
  setCookie("session-a", "kagi.com", true, 7200 * 1000);
  Assert.equal(
    signInCalls,
    before + 1,
    "a cookie set again with the same value and a later expiry asks nothing"
  );

  setCookie("session-b", "kagi.com", true, 3600 * 1000);
  Assert.equal(signInCalls, before + 2, "a different session asks again");

  removeCookie();
  Assert.equal(signInCalls, before + 2, "signing out asks nothing");
  Assert.ok(!SvalKagi.signedIn(), "and a normal window is signed out");

  setCookie("session-b", "kagi.com", true, 3600 * 1000);
  Assert.equal(
    signInCalls,
    before + 3,
    "signing in again after a sign-out asks, whatever the value"
  );

  Services.cookies.removeAll();
  setCookie("session-b", "kagi.com", true, 3600 * 1000);
  Assert.equal(
    signInCalls,
    before + 4,
    "and so does signing in after every cookie was cleared"
  );

  await reset();
});

add_task(async function a_cookie_for_another_host_is_not_a_sign_in() {
  setCookie("not-kagis", "example.com");
  Assert.ok(!SvalKagi.signedIn(), "only Kagi's cookie counts");
  removeCookie("example.com");
});

add_task(async function the_token_survives_a_restart() {
  await SvalKagi.setToken("kept-token");
  SvalKagi.stop();
  SvalKagi.start();
  Assert.equal(
    await SvalKagi.token(),
    "kept-token",
    "a fresh start reads the token back from the store"
  );
  await reset();
});

add_task(async function a_session_link_is_accepted() {
  await SvalKagi.setToken("https://kagi.com/search?token=abc&q=%s");
  Assert.equal(
    await SvalKagi.token(),
    "abc",
    "the token is taken from the link"
  );

  await SvalKagi.setToken("https://kagi.com/search?q=%s&token=ab+cd.e-f_g");
  Assert.equal(
    await SvalKagi.token(),
    "ab+cd.e-f_g",
    "a + in a link's token stays a +, and is not read as a space"
  );

  await SvalKagi.setToken("ab+cd.e-f_g");
  Assert.equal(
    await SvalKagi.token(),
    "ab+cd.e-f_g",
    "a raw token may hold a + too, as a link's does"
  );

  await SvalKagi.setToken("  raw-token  ");
  Assert.equal(await SvalKagi.token(), "raw-token", "a raw token is accepted");

  const held = await loginsHeld();
  Assert.equal(held.length, 1, "and replacing a token leaves one entry");

  await Assert.rejects(
    SvalKagi.setToken("https://kagi.com/search?q=hello"),
    err => err.code === "no_token",
    "a Kagi link without a token is refused"
  );
  await Assert.rejects(
    SvalKagi.setToken("https://example.com/search?token=abc"),
    err => err.code === "not_a_session_link",
    "and so is a link to another site"
  );
  await Assert.rejects(
    SvalKagi.setToken("two words"),
    err => err.code === "not_a_token",
    "and so is text that is not a header value"
  );
  await Assert.rejects(
    SvalKagi.setToken(""),
    err => err.code === "not_a_token",
    "and so is nothing"
  );
  for (const [junk, code] of [
    ["javascript:alert(1)", "not_a_token"],
    ["data:,x", "not_a_token"],
    ["kagi.com/search?token=abc", "not_a_token"],
    ["a=b", "not_a_token"],
    ["a/b", "not_a_token"],
    ["a?b", "not_a_token"],
    ["a#b", "not_a_token"],
    ["a&b", "not_a_token"],
    ["https://help.kagi.com/search?token=abc", "not_a_session_link"],
  ]) {
    await Assert.rejects(
      SvalKagi.setToken(junk),
      err => err.code === code,
      `${junk} is not a token or a Kagi link, and is refused`
    );
  }
  Assert.equal(
    await SvalKagi.token(),
    "raw-token",
    "a refusal changes nothing"
  );

  await reset();
});

add_task(async function private_requests_carry_the_header() {
  await SvalKagi.setToken("abc");

  for (const [type, label] of [
    [Ci.nsIContentPolicy.TYPE_DOCUMENT, "a top-level load"],
    [Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST, "an XHR"],
    [Ci.nsIContentPolicy.TYPE_FETCH, "a fetch"],
  ]) {
    Assert.equal(
      headerAfterRequest("https://kagi.com/search?q=x", PRIVATE, type),
      "abc",
      `${label} to kagi.com from a private window carries the token`
    );
  }

  await reset();
});

add_task(async function normal_requests_do_not() {
  await SvalKagi.setToken("abc");

  Assert.equal(
    headerAfterRequest("https://kagi.com/search?q=x", NORMAL),
    null,
    "a normal window has the cookie and sends no header"
  );
  Assert.equal(
    headerAfterRequest("https://kagi.com/search?q=x", PRIVATE),
    "abc",
    "while the same request from a private window does, so the check above " +
      "is not passing because the observer does nothing"
  );

  await reset();
});

add_task(async function other_hosts_and_kinds_do_not() {
  await SvalKagi.setToken("abc");
  Assert.equal(
    headerAfterRequest("https://kagi.com/search?q=x", PRIVATE),
    "abc",
    "the observer is live: a private request to kagi.com carries the token"
  );

  for (const url of [
    "https://example.com/",
    "https://kagisuggest.com/api/autosuggest?q=x",
    "https://notkagi.com/",
    "https://kagi.com.example.com/",
    "https://help.kagi.com/",
  ]) {
    Assert.equal(
      headerAfterRequest(url, PRIVATE),
      null,
      `a private request to ${url} has no header`
    );
  }
  Assert.equal(
    headerAfterRequest(
      "https://kagi.com/logo.png",
      PRIVATE,
      Ci.nsIContentPolicy.TYPE_IMAGE
    ),
    null,
    "a sub-resource of a page is not sent the token"
  );
  Assert.equal(
    // eslint-disable-next-line sdl/no-insecure-url
    headerAfterRequest("http://kagi.com/search?q=x", PRIVATE),
    null,
    "and neither is a request that is not encrypted"
  );

  await reset();
});

add_task(async function a_header_carried_across_a_redirect_is_removed() {
  await SvalKagi.setToken("abc");

  Assert.equal(
    headerAfterRequest(
      "https://example.com/landing",
      PRIVATE,
      Ci.nsIContentPolicy.TYPE_DOCUMENT,
      "abc"
    ),
    null,
    "a request that arrives at another site with the header already on it " +
      "(Kagi redirected away) does not keep it"
  );

  await reset();
});

add_task(async function no_token_means_no_header() {
  Assert.equal(
    headerAfterRequest("https://kagi.com/search?q=x", PRIVATE),
    null,
    "a private request with nothing stored carries nothing"
  );
});

add_task(async function stop_stops_the_header() {
  await SvalKagi.setToken("abc");
  SvalKagi.stop();
  Assert.equal(
    headerAfterRequest("https://kagi.com/search?q=x", PRIVATE),
    null,
    "once stopped, no request is touched"
  );
  SvalKagi.start();
  SvalKagi.start();
  await SvalKagi.token();
  Assert.equal(
    headerAfterRequest("https://kagi.com/search?q=x", PRIVATE),
    "abc",
    "and starting again, twice, restores it"
  );
  await reset();
});

add_task(async function a_token_taken_from_the_cookie_is_forgotten() {
  const { SvalSecretStore } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
  );
  setCookie("session-1");
  await SvalSecretStore.write(
    "kagi token",
    new TextEncoder().encode(
      JSON.stringify({ source: "cookie", token: "session-1" })
    )
  );
  SvalKagi.stop();
  SvalKagi.start();
  Assert.equal(
    await SvalKagi.token(),
    null,
    "a stored token that was a normal window's session is not used"
  );
  Assert.equal(
    headerAfterRequest("https://kagi.com/search?q=x", PRIVATE),
    null,
    "so no private window sends it"
  );
  Assert.equal((await loginsHeld()).length, 0, "and it is removed");
  await reset();
});

add_task(async function a_pasted_token_is_the_users_until_they_clear_it() {
  await SvalKagi.setToken("https://kagi.com/search?token=pasted");

  setCookie("other-session");
  Assert.equal(
    await SvalKagi.token(),
    "pasted",
    "a normal window's sign-in does not replace it"
  );
  removeCookie();
  Assert.equal(await SvalKagi.token(), "pasted", "nor does its sign-out");
  Services.cookies.removeAll();
  Assert.equal(await SvalKagi.token(), "pasted", "nor clearing every cookie");

  await reset();
});

add_task(async function the_token_is_not_a_cookie_or_a_url() {
  await SvalKagi.setToken("secret-value");
  const cookies = Services.cookies.getCookiesFromHost("kagi.com", NORMAL);
  Assert.equal(cookies.length, 0, "setting a token writes no cookie");
  for (const [which, address] of [
    ["sign-in", SvalKagi.SIGNIN_URL],
    ["trial", SvalKagi.TRIAL_URL],
  ]) {
    const url = new URL(address);
    Assert.equal(url.origin, "https://kagi.com", `the ${which} page is Kagi's`);
    Assert.ok(
      !address.includes("secret-value") && !/token/i.test(address),
      `and its address carries no token`
    );
  }
  await reset();
});

add_task(async function a_fetch_of_another_site_cannot_spend_the_token() {
  await SvalKagi.setToken("abc");
  const [fetchType, xhrType] = [
    Ci.nsIContentPolicy.TYPE_FETCH,
    Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST,
  ];
  const target = "https://kagi.com/search?q=x";

  Assert.equal(
    headerAfterRequest(target, PRIVATE, fetchType, null, "https://kagi.com/"),
    "abc",
    "a fetch started by kagi.com carries the token"
  );
  for (const type of [fetchType, xhrType]) {
    Assert.equal(
      headerAfterRequest(target, PRIVATE, type, null, "https://example.com/"),
      null,
      "a fetch or XHR to kagi.com started by another site carries nothing"
    );
  }
  await reset();
});

add_task(
  async function a_navigation_the_user_or_kagi_started_carries_the_token() {
    await SvalKagi.setToken("abc");
    const document = Ci.nsIContentPolicy.TYPE_DOCUMENT;

    Assert.equal(
      headerAfterRequest("https://kagi.com/", PRIVATE, document, null, SYSTEM),
      "abc",
      "an address-bar, bookmark or search-engine load carries the token"
    );
    Assert.equal(
      headerAfterRequest(
        "https://kagi.com/settings",
        PRIVATE,
        document,
        null,
        "https://kagi.com/"
      ),
      "abc",
      "and so does a link or form on kagi.com"
    );
    Assert.equal(
      headerAfterRequest(
        "https://kagi.com/settings",
        PRIVATE,
        document,
        null,
        "https://kagi.com/",
        "POST"
      ),
      "abc",
      "including a POST"
    );

    await reset();
  }
);

add_task(async function a_navigation_another_site_started_does_not() {
  await SvalKagi.setToken("abc");
  const document = Ci.nsIContentPolicy.TYPE_DOCUMENT;
  const subdocument = Ci.nsIContentPolicy.TYPE_SUBDOCUMENT;
  const target = "https://kagi.com/settings";

  Assert.equal(
    headerAfterRequest(target, PRIVATE, document, null, "https://example.com/"),
    null,
    "a link from another site reaches Kagi signed out"
  );
  Assert.equal(
    headerAfterRequest(
      target,
      PRIVATE,
      document,
      null,
      "https://example.com/",
      "POST"
    ),
    null,
    "and so does a form posted from another site"
  );
  Assert.equal(
    headerAfterRequest(target, PRIVATE, document, null, NULL_PRINCIPAL),
    null,
    "and a page with no origin"
  );
  Assert.equal(
    headerAfterRequest(
      target,
      PRIVATE,
      document,
      "abc",
      "https://example.com/"
    ),
    null,
    "and a load from another site that already carries the header loses it"
  );
  for (const initiator of [
    "https://example.com/",
    "https://kagi.com/",
    SYSTEM,
  ]) {
    Assert.equal(
      headerAfterRequest(target, PRIVATE, subdocument, null, initiator),
      null,
      "and a frame is never sent the token"
    );
  }

  await reset();
});

add_task(async function an_expired_cookie_is_not_a_sign_in() {
  const expiry = Date.now() + 2000;
  Services.cookies.add(
    "kagi.com",
    "/",
    COOKIE,
    "short-lived",
    true,
    true,
    false,
    expiry,
    NORMAL,
    Ci.nsICookie.SAMESITE_LAX,
    Ci.nsICookie.SCHEME_HTTPS
  );
  Assert.ok(SvalKagi.signedIn(), "while it lasts");
  // Its expiry, by the clock Sval reads, whatever else the machine is doing.
  await TestUtils.waitForCondition(
    () => Date.now() > expiry,
    "the cookie's expiry passes",
    100,
    100
  );
  Assert.ok(
    !SvalKagi.signedIn(),
    "a cookie past its expiry that Gecko has not purged yet counts as gone"
  );

  await reset();
});

add_task(async function nothing_stale_outlives_a_stop() {
  await SvalKagi.setToken("old");
  SvalKagi.stop();

  // Hold every read of the store, so that one is in flight when Sval starts
  // again, and the restart's own read lands only when the test lets it.
  const logins = SvalKagi._stored;
  const reads = [];
  SvalKagi._stored = async function () {
    const gate = Promise.withResolvers();
    reads.push(gate);
    await gate.promise;
    return logins.call(this);
  };

  try {
    const read = SvalKagi.token();
    await TestUtils.waitForCondition(() => reads.length === 1, "a read starts");
    SvalKagi.start();
    reads[0].resolve();
    await read;
    await TestUtils.waitForCondition(
      () => reads.length === 2,
      "the restart's own read starts"
    );
    Assert.equal(
      headerAfterRequest("https://kagi.com/search?q=x", PRIVATE),
      null,
      "a read begun before the stop does not put its token back after start"
    );
    reads[1].resolve();
    Assert.equal(
      await SvalKagi.token(),
      "old",
      "and the restart's own read does"
    );
  } finally {
    SvalKagi._stored = logins;
    for (const gate of reads) {
      gate.resolve();
    }
  }

  await reset();
});

add_task(async function only_kagis_own_secure_cookie_signs_in() {
  const OK = Ci.nsICookieValidation.eOK;
  Assert.equal(setCookie("host-only").result, OK, "Gecko keeps the cookie");
  Assert.ok(SvalKagi.signedIn(), "a Secure cookie for kagi.com signs in");
  removeCookie();

  // Kagi's own sign-in sets its cookie for .kagi.com.
  Assert.equal(setCookie("kagis-own", ".kagi.com").result, OK);
  Assert.ok(SvalKagi.signedIn(), "and so does Kagi's cookie for .kagi.com");
  Services.cookies.remove(".kagi.com", COOKIE, "/", NORMAL);

  Assert.equal(setCookie("subdomain", "help.kagi.com").result, OK);
  Assert.ok(
    !SvalKagi.signedIn(),
    "a cookie for one subdomain alone is not a sign-in"
  );
  Services.cookies.remove("help.kagi.com", COOKIE, "/", NORMAL);

  Assert.equal(setCookie("insecure", "kagi.com", false).result, OK);
  Assert.ok(!SvalKagi.signedIn(), "and neither is a cookie that is not Secure");

  await reset();
});

add_task(async function only_the_default_cookie_jar_signs_in() {
  for (const [originAttributes, label] of [
    [{ userContextId: 1 }, "a container"],
    [{ partitionKey: "(https,example.com)" }, "a partitioned jar"],
    [{ firstPartyDomain: "example.com" }, "a first-party isolated jar"],
  ]) {
    const added = Services.cookies.add(
      "kagi.com",
      "/",
      COOKIE,
      "other-jar",
      true,
      true,
      false,
      Date.now() + 3600 * 1000,
      originAttributes,
      Ci.nsICookie.SAMESITE_LAX,
      Ci.nsICookie.SCHEME_HTTPS,
      !!originAttributes.partitionKey
    );
    Assert.equal(added.result, Ci.nsICookieValidation.eOK, `${label} is set`);
    Assert.ok(!SvalKagi.signedIn(), `a sign-in in ${label} is not one`);
    Services.cookies.remove("kagi.com", COOKIE, "/", originAttributes);
  }

  await reset();
});

add_task(async function clearing_a_token_is_idempotent() {
  await SvalKagi.clearToken();
  await SvalKagi.clearToken();
  Assert.equal(await SvalKagi.token(), null);
});

const AUTHORIZATION = "Authorization";
const CLIENT = "X-Kagi-PrivacyPass-Client";

add_task(
  async function a_private_load_spends_one_token_and_carries_no_cookie() {
    setStock({ tokens: ["older", "newer"] });
    await SvalKagi.setToken("link-token");
    const channel = channelAfterRequest(
      "https://kagi.com/search?q=x",
      PRIVATE,
      Ci.nsIContentPolicy.TYPE_DOCUMENT,
      null,
      SYSTEM
    );
    Assert.equal(header(channel, AUTHORIZATION), 'PrivateToken token="newer"');
    Assert.equal(header(channel, CLIENT), "true");
    Assert.ok(!header(channel, "Cookie"), "no cookie goes with a token");
    Assert.equal(
      header(channel, HEADER),
      null,
      "a Session Link does not go with a token"
    );
    Assert.equal(SvalKagiPrivacyPass.count(), 1, "one token was spent");
    await reset();
    setStock({ unsupported: true });
  }
);

add_task(async function a_normal_load_spends_nothing() {
  setStock({ tokens: ["only"] });
  const channel = channelAfterRequest("https://kagi.com/search?q=x", NORMAL);
  Assert.equal(header(channel, AUTHORIZATION), null);
  Assert.equal(SvalKagiPrivacyPass.count(), 1);
  setStock({ unsupported: true });
});

add_task(async function a_link_from_another_site_carries_neither_credential() {
  setStock({ tokens: ["only"] });
  await SvalKagi.setToken("link-token");
  const channel = channelAfterRequest(
    "https://kagi.com/search?q=x",
    PRIVATE,
    Ci.nsIContentPolicy.TYPE_DOCUMENT,
    null,
    "https://example.com/"
  );
  Assert.equal(header(channel, AUTHORIZATION), null);
  Assert.equal(header(channel, HEADER), null);
  Assert.equal(SvalKagiPrivacyPass.count(), 1);
  await reset();
  setStock({ unsupported: true });
});

add_task(async function only_kagis_own_pages_spend_a_token() {
  setStock({ tokens: ["only"] });
  for (const url of [
    "https://kagi.com/api/quick_answer",
    "https://kagi.com/favicon.ico",
    "https://kagi.com/signin",
  ]) {
    const channel = channelAfterRequest(url, PRIVATE);
    Assert.equal(header(channel, AUTHORIZATION), null, url);
  }
  Assert.equal(SvalKagiPrivacyPass.count(), 1);
  setStock({ unsupported: true });
});

add_task(async function a_used_allowance_sends_nothing() {
  setStock({ outUntil: Date.now() + 3600 * 1000 });
  await SvalKagi.setToken("link-token");
  for (const type of [
    Ci.nsIContentPolicy.TYPE_DOCUMENT,
    Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST,
  ]) {
    const channel = channelAfterRequest(
      "https://kagi.com/search?q=x",
      PRIVATE,
      type,
      null,
      type === Ci.nsIContentPolicy.TYPE_DOCUMENT ? SYSTEM : "https://kagi.com/"
    );
    Assert.equal(channel.status, Cr.NS_BINDING_ABORTED, "the load is stopped");
    Assert.equal(header(channel, HEADER), null, "no Session Link goes instead");
  }
  await reset();
  setStock({ unsupported: true });
});

add_task(async function signed_out_private_windows_carry_nothing() {
  setStock();
  await SvalKagi.setToken("link-token");
  const channel = channelAfterRequest(
    "https://kagi.com/search?q=x",
    PRIVATE,
    Ci.nsIContentPolicy.TYPE_DOCUMENT,
    null,
    SYSTEM
  );
  Assert.equal(header(channel, AUTHORIZATION), null);
  Assert.equal(
    header(channel, HEADER),
    null,
    "a Session Link is for plans without Privacy Pass"
  );
  await reset();
  setStock({ unsupported: true });
});

add_task(async function a_token_carried_across_a_redirect_is_removed() {
  setStock();
  const uri = Services.io.newURI("https://example.com/");
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    uri,
    PRIVATE
  );
  const channel = NetUtil.newChannel({
    uri,
    loadingPrincipal: principal,
    triggeringPrincipal: principal,
    securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_DOCUMENT,
  }).QueryInterface(Ci.nsIHttpChannel);
  channel.setRequestHeader(AUTHORIZATION, 'PrivateToken token="t"', false);
  channel.setRequestHeader(CLIENT, "true", false);
  Services.obs.notifyObservers(channel, "http-on-modify-request");
  Assert.ok(!header(channel, AUTHORIZATION), "the token is taken off");
  Assert.ok(!header(channel, CLIENT));
  setStock({ unsupported: true });
});
