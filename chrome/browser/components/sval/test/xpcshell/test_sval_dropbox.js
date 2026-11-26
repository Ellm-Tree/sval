/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Signing in to Dropbox (`SvalDropbox`): the page it opens, the redirect it
 * claims, and the code it trades for a refresh token.
 */

const { SvalDropbox, APP_KEY, REDIRECT, authorizeURL, challengeFor } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalDropbox.sys.mjs"
  );
const { within, waitForCondition } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

const WAIT_MS = 5000;

/** Stands in for the Peek the page opens in: one `close()` call to count. */
function fakePage() {
  const opened = [];
  SvalDropbox._watchPage = false;
  SvalDropbox._openPage = url => {
    const win = {
      url,
      closed: false,
      close() {
        this.closed = true;
      },
    };
    opened.push(win);
    return win;
  };
  return opened;
}

function redirect(params) {
  return Services.io.newURI(`${REDIRECT}?${new URLSearchParams(params)}`);
}

add_task(async function the_challenge_is_rfc_7636s() {
  // RFC 7636 appendix B's example.
  Assert.equal(
    await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  );
});

add_task(function the_page_asks_for_a_lasting_sign_in_without_a_secret() {
  const url = new URL(authorizeURL({ challenge: "c", state: "s" }));
  Assert.equal(url.origin, "https://www.dropbox.com");
  const query = Object.fromEntries(url.searchParams);
  Assert.deepEqual(query, {
    client_id: APP_KEY,
    response_type: "code",
    code_challenge: "c",
    code_challenge_method: "S256",
    token_access_type: "offline",
    redirect_uri: REDIRECT,
    state: "s",
  });
});

add_task(async function a_sign_in_trades_its_code_for_a_refresh_token() {
  const opened = fakePage();
  const asked = [];
  SvalDropbox._fetch = async (url, init) => {
    asked.push({ url, body: new URLSearchParams(init.body), init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ refresh_token: "refresh" }),
    };
  };
  const signedIn = SvalDropbox.signIn();
  await waitForCondition(() => opened.length, "Dropbox's page");
  const page = new URL(opened[0].url);
  const state = page.searchParams.get("state");

  Assert.ok(
    SvalDropbox.claimRedirect(redirect({ code: "c1", state: "other" })),
    "a redirect for another sign-in is still Sval's"
  );
  Assert.ok(!opened[0].closed, "and leaves this one waiting");

  Assert.ok(SvalDropbox.claimRedirect(redirect({ code: "c1", state })));
  Assert.equal(await within(signedIn, WAIT_MS, "the token"), "refresh");
  Assert.ok(opened[0].closed, "the page closes");

  Assert.equal(asked.length, 1);
  Assert.equal(asked[0].url, "https://api.dropboxapi.com/oauth2/token");
  Assert.equal(asked[0].init.credentials, "omit");
  Assert.equal(asked[0].body.get("code"), "c1");
  Assert.equal(asked[0].body.get("grant_type"), "authorization_code");
  Assert.equal(
    await challengeFor(asked[0].body.get("code_verifier")),
    page.searchParams.get("code_challenge"),
    "the verifier is the one the challenge was made from"
  );
});

add_task(async function declining_cancels_the_sign_in() {
  const opened = fakePage();
  const signedIn = SvalDropbox.signIn();
  await waitForCondition(() => opened.length, "Dropbox's page");
  const state = new URL(opened[0].url).searchParams.get("state");
  SvalDropbox.claimRedirect(redirect({ error: "access_denied", state }));
  await Assert.rejects(
    within(signedIn, WAIT_MS, "the refusal"),
    err => err.name === "SignInCancelled"
  );
});

/**
 * Runs a sign-in to the point Dropbox sends Sval back with a code, with the
 * token endpoint answering `answer`.
 *
 * @param {object} answer What `fetch` resolves to.
 * @returns {Promise<string>} the sign-in.
 */
async function signInAnswered(answer) {
  const opened = fakePage();
  SvalDropbox._fetch = async () => answer;
  const signedIn = SvalDropbox.signIn();
  await waitForCondition(() => opened.length, "Dropbox's page");
  const state = new URL(opened[0].url).searchParams.get("state");
  SvalDropbox.claimRedirect(redirect({ code: "c3", state }));
  return signedIn;
}

add_task(async function a_refused_exchange_fails_the_sign_in() {
  await Assert.rejects(
    within(
      signInAnswered({ ok: false, status: 400, json: async () => ({}) }),
      WAIT_MS,
      "the refused exchange"
    ),
    err => err.name !== "SignInCancelled",
    "as a failure, which the page reports"
  );
  await Assert.rejects(
    within(
      signInAnswered({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "only" }),
      }),
      WAIT_MS,
      "the exchange with no refresh token"
    ),
    err => err.name !== "SignInCancelled",
    "and an exchange that gives no lasting sign-in fails too"
  );
});

add_task(async function a_new_sign_in_cancels_the_one_before() {
  const opened = fakePage();
  const first = SvalDropbox.signIn();
  await waitForCondition(() => opened.length, "the first page");
  const second = SvalDropbox.signIn();
  await Assert.rejects(
    within(first, WAIT_MS, "the first sign-in"),
    err => err.name === "SignInCancelled"
  );
  Assert.ok(opened[0].closed, "its page closes");
  await waitForCondition(() => opened.length === 2, "the second page");
  const state = new URL(opened[1].url).searchParams.get("state");
  SvalDropbox.claimRedirect(redirect({ error: "access_denied", state }));
  await Assert.rejects(
    within(second, WAIT_MS, "the second sign-in"),
    err => err.name === "SignInCancelled"
  );
});

/**
 * A response as `http-on-examine-response` hands it to `_examine`.
 *
 * @param {number} status
 * @param {string} [location] Its `Location` header.
 * @returns {object}
 */
function response(status, location) {
  const channel = {
    URI: Services.io.newURI("https://www.dropbox.com/oauth2/authorize_submit"),
    responseStatus: status,
    cancelled: null,
    QueryInterface: () => channel,
    getResponseHeader(name) {
      if (name !== "Location" || !location) {
        throw Components.Exception("", Cr.NS_ERROR_NOT_AVAILABLE);
      }
      return location;
    },
    cancel(why) {
      this.cancelled = why;
    },
  };
  return channel;
}

add_task(async function dropboxs_302_settles_the_sign_in_and_goes_no_further() {
  const opened = fakePage();
  SvalDropbox._fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ refresh_token: "refresh" }),
  });
  const signedIn = SvalDropbox.signIn();
  await waitForCondition(() => opened.length, "Dropbox's page");
  const state = new URL(opened[0].url).searchParams.get("state");

  const page = response(200);
  SvalDropbox._examine(page);
  const elsewhere = response(302, "https://www.dropbox.com/home");
  SvalDropbox._examine(elsewhere);
  Assert.equal(page.cancelled, null, "a page loads as it would");
  Assert.equal(elsewhere.cancelled, null, "and so does a redirect elsewhere");

  const back = response(
    302,
    `${REDIRECT}?${new URLSearchParams({ code: "c2", state })}`
  );
  SvalDropbox._examine(back);
  Assert.equal(back.cancelled, Cr.NS_BINDING_ABORTED, "the redirect stops");
  Assert.equal(await within(signedIn, WAIT_MS, "the token"), "refresh");
  Assert.ok(opened[0].closed, "and the page closes");
});

add_task(function only_dropboxs_scheme_is_claimed() {
  Assert.ok(!SvalDropbox.claimRedirect(Services.io.newURI("mailto:a@b.c")));
  Assert.ok(
    SvalDropbox.claimRedirect(redirect({ code: "x", state: "y" })),
    "with no sign-in under way, the redirect still reaches no other app"
  );
});
