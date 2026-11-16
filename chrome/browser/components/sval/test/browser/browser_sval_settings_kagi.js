/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The Kagi card on Sval's settings page: when it shows, the sign-in it
 * offers, how private windows sign in, the Session Link field, and a link
 * saved here reaching private requests. The rest of the settings page is in
 * `browser_sval_settings.js`.
 */

const { SvalKagi } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagi.sys.mjs"
);
const { SvalKagiPrivacyPass } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagiPrivacyPass.sys.mjs"
);
const { SvalSettingsSync } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs"
);
const { SearchService } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);
/* import-globals-from ../../sval-panel.js */

const SETTINGS_URL = "about:preferences";

/**
 * Makes `engine` the default search engine until the task ends, and puts
 * Kagi's observers back as they were: making Kagi the engine starts them.
 *
 * @param {string} engine A config engine's id.
 */
async function useEngine(engine) {
  const search = SvalSettingsSync.searchService();
  const was = await search.currentId();
  const wasStarted = SvalKagi._started;
  await search.setById(engine);
  atTaskEnd(async () => {
    await search.setById(was);
    if (!wasStarted) {
      SvalKagi.stop();
    }
  });
}

/**
 * Says a normal window is or is not signed in to Kagi until the task ends,
 * as Kagi's cookie would, without a cookie: one would start a refill from
 * kagi.com.
 *
 * @param {boolean} signedIn
 */
function fakeSignedIn(signedIn) {
  const real = Object.getOwnPropertyDescriptor(SvalKagi, "signedIn");
  SvalKagi.signedIn = () => signedIn;
  atTaskEnd(() => Object.defineProperty(SvalKagi, "signedIn", real));
}

/**
 * Sets the Privacy Pass stock's fields and tells its listeners, until the
 * task ends.
 *
 * @param {object} fields
 */
function setStock(fields) {
  Object.assign(SvalKagiPrivacyPass, {
    _unavailable: false,
    _tokens: [],
    _unsupported: false,
    _outUntil: 0,
    ...fields,
  });
  SvalKagiPrivacyPass._changed();
}

/**
 * The card shows while Kagi is the default engine or private windows'
 * engine, or while a Session Link is saved, and follows the engine as it
 * changes.
 */
add_task(async function the_card_shows_while_kagi_is_an_engine() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await SvalKagi.clearToken();
  removeSessionCookie();
  await useEngine("ddg");
  const ui = await freshSettingsPage("search", { shown: false });
  const card = ui.page.document.getElementById("sval-kagi-card");
  await TestUtils.waitForCondition(
    () => card.hidden,
    "no card under another engine"
  );

  await SvalSettingsSync.searchService().setById("kagi");
  await TestUtils.waitForCondition(
    () => card.checkVisibility(),
    "the card shows once Kagi is the default"
  );
  await SvalSettingsSync.searchService().setById("ddg");
  await TestUtils.waitForCondition(() => card.hidden, "and goes with it");

  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.search.separatePrivateDefault", true],
      ["browser.search.separatePrivateDefault.ui.enabled", true],
    ],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  await SearchService.init();
  const privateWas = SearchService.defaultPrivateEngine;
  atTaskEnd(() =>
    SearchService.setDefaultPrivate(
      privateWas,
      SearchService.CHANGE_REASON.USER
    )
  );
  await SearchService.setDefaultPrivate(
    SearchService.getEngineById("kagi"),
    SearchService.CHANGE_REASON.USER
  );
  await TestUtils.waitForCondition(
    () => card.checkVisibility(),
    "the card shows while Kagi is private windows' engine"
  );
  await SearchService.setDefaultPrivate(
    privateWas,
    SearchService.CHANGE_REASON.USER
  );
  await TestUtils.waitForCondition(() => card.hidden, "and goes with it");
});

/**
 * Signed out, the card offers first run's sign-in and nothing about private
 * windows. The sign-in opens Kagi's page in a window of its own, which
 * Kagi's session cookie closes, and the card follows the cookie as it
 * changes.
 *
 * `network.dns.localDomains` sends `kagi.com` to this machine, where nothing
 * answers, so Kagi's page and any refill the session starts fail to connect
 * and nothing leaves the machine.
 */
add_task(async function signed_out_the_card_offers_the_sign_in() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await SpecialPowers.pushPrefEnv({
    set: [["network.dns.localDomains", "kagi.com,account.kagi.com"]],
  });
  atTaskEnd(() => SpecialPowers.popPrefEnv());
  await SvalKagi.clearToken();
  removeSessionCookie();
  atTaskEnd(removeSessionCookie);
  await useEngine("kagi");

  const ui = await freshSettingsPage("search");
  const byId = id => ui.page.document.getElementById(id);
  const signIn = byId("sval-kagi-sign-in");
  await TestUtils.waitForCondition(
    () => signIn.checkVisibility(),
    "signed out, the card offers Kagi's sign-in"
  );
  Assert.ok(signIn.textContent.trim(), "with words on it");
  Assert.ok(!byId("sval-kagi-form").checkVisibility(), "and no Session Link");
  Assert.ok(!byId("sval-kagi-privacy-pass").checkVisibility());

  const opened = BrowserTestUtils.waitForNewWindow();
  signIn.click();
  const popup = await within(opened, 20_000, "Kagi's sign-in window");
  await committed(
    popup.gBrowser.selectedBrowser,
    SvalKagi.SIGNIN_URL,
    "the window loads the sign-in first run opens"
  );
  Assert.ok(signIn.disabled, "once");

  const closed = BrowserTestUtils.domWindowClosed(popup);
  addSessionCookie();
  await within(closed, 10_000, "signing in closing Kagi's window");
  await TestUtils.waitForCondition(
    () =>
      byId("sval-kagi-account").dataset.state === "signed-in" &&
      byId("sval-kagi-account").checkVisibility(),
    "signed in, the card says so"
  );
  Assert.ok(!signIn.checkVisibility(), "and offers no sign-in");

  removeSessionCookie();
  await TestUtils.waitForCondition(
    () => signIn.checkVisibility() && !signIn.disabled,
    "a sign-out elsewhere brings the sign-in back"
  );
  Assert.ok(!byId("sval-kagi-account").checkVisibility());
});

/**
 * Signs a normal window in to Kagi as Kagi's sign-in does, with its Secure
 * session cookie in the default jar (`isSessionCookie` in SvalKagi.sys.mjs).
 */
function addSessionCookie() {
  Services.cookies.add(
    "kagi.com",
    "/",
    "kagi_session",
    "session-a",
    true,
    true,
    false,
    Date.now() + 3600 * 1000,
    {},
    Ci.nsICookie.SAMESITE_LAX,
    Ci.nsICookie.SCHEME_HTTPS
  );
}

/** Signs a normal window out of Kagi, as Kagi's sign-out does. */
function removeSessionCookie() {
  Services.cookies.remove("kagi.com", "kagi_session", "/", {});
}

/**
 * The page says how private windows sign in to Kagi, follows the stock as it
 * changes, and offers "Check again" only for a plan without Privacy Pass.
 */
add_task(async function settings_says_how_private_windows_sign_in_to_kagi() {
  const privacyPass = SvalKagiPrivacyPass;
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await SvalKagi.clearToken();
  await useEngine("kagi");
  fakeSignedIn(true);
  const saved = { checkAgain: privacyPass.checkAgain };
  let checked = 0;
  privacyPass.checkAgain = async () => {
    checked++;
  };
  const set = fields => {
    Object.assign(privacyPass, {
      _unavailable: false,
      _tokens: [],
      _unsupported: false,
      _outUntil: 0,
      ...fields,
    });
    privacyPass._changed();
  };
  registerCleanupFunction(() => {
    Object.assign(privacyPass, saved);
    privacyPass._reset();
  });

  set({
    _tokens: [
      ["a", Date.now()],
      ["b", Date.now()],
    ],
  });
  const ui = await openSvalSettings();
  const doc = ui.page.document;
  const line = doc.getElementById("sval-kagi-privacy-pass");
  const again = doc.getElementById("sval-kagi-check-again");
  await TestUtils.waitForCondition(
    () => line.dataset.state === "ready" && line.textContent.includes("2"),
    "a stock says how many searches are left"
  );
  Assert.ok(again.hidden, "and offers no check");
  // The page opens on another category, so the card's own state is read.
  const sessionLink = doc.getElementById("sval-kagi-session-link");
  Assert.ok(sessionLink.hidden, "nor the Session Link");

  set({ _unsupported: true });
  await TestUtils.waitForCondition(
    () => line.dataset.state === "unsupported",
    "a plan without Privacy Pass is said"
  );
  Assert.ok(!again.hidden, "with a way to check again");
  Assert.ok(!sessionLink.hidden, "and the Session Link field");
  again.click();
  await TestUtils.waitForCondition(() => checked === 1, "which asks Kagi");

  set({ _outUntil: Date.now() + 86400 * 1000 });
  await TestUtils.waitForCondition(
    () => line.dataset.state === "out",
    "a used allowance says when it resets"
  );

  set({ _unavailable: true });
  await TestUtils.waitForCondition(
    () => line.hidden,
    "a build without the engine says nothing"
  );
});

/**
 * The Session Link field keeps a shown label while the user types, and that
 * label is the name a screen reader gives the field.
 */
add_task(async function the_session_link_field_is_labelled() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await useEngine("kagi");
  fakeSignedIn(true);
  setStock({ _unsupported: true });
  atTaskEnd(() => SvalKagiPrivacyPass._reset());
  const ui = await freshSettingsPage("search");
  const field = ui.page.document.getElementById("sval-kagi-link");
  field.value = "https://kagi.com/search?token=a";
  const [label] = field.labels;
  Assert.ok(label?.checkVisibility(), "a label is shown");
  const text = label.textContent.trim();
  Assert.ok(text, "with words in it");
  Assert.notEqual(field.placeholder, text, "the placeholder is an example");
  const acc = await accessibleOf(field);
  Assert.equal(acc.name, text, "the label names the field");
});

/**
 * Kagi in private windows: a Session Link is stored and forgotten from this
 * page, junk is refused, and nothing on the page ever says the token.
 */
add_task(async function settings_stores_and_clears_the_kagi_token() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  await SvalKagi.clearToken();
  registerCleanupFunction(() => SvalKagi.clearToken());
  await useEngine("kagi");
  fakeSignedIn(true);
  setStock({ _unsupported: true });
  atTaskEnd(() => SvalKagiPrivacyPass._reset());

  let ui = await openSvalSettings();
  const doc = ui.page.document;
  const field = doc.getElementById("sval-kagi-link");
  const status = doc.getElementById("sval-kagi-status");
  Assert.equal(field.type, "password", "the field hides what is typed");
  await TestUtils.waitForCondition(
    () => status.dataset.state === "not-set",
    "the page says no token is stored"
  );

  field.value = "https://example.com/search?token=abc";
  doc.getElementById("sval-kagi-save").click();
  await TestUtils.waitForCondition(
    () => status.dataset.state === "refused",
    "a link that is not Kagi's is refused with a sentence"
  );
  Assert.equal(await SvalKagi.token(), null, "and nothing was stored");

  const token = "tok_en-1234.abcd~XYZ";
  field.value = `https://kagi.com/search?token=${token}`;
  doc.getElementById("sval-kagi-save").click();
  await TestUtils.waitForCondition(
    async () => (await SvalKagi.token()) === token,
    "saving stores the token"
  );
  await TestUtils.waitForCondition(
    () => field.value === "",
    "and empties the field"
  );
  // The field empties before the page has read the store back to say so.
  await TestUtils.waitForCondition(
    () => status.dataset.state === "saved",
    "and the page says a token is stored"
  );
  Assert.ok(!status.textContent.includes(token), "the status never says it");

  await closeSvalSettings(ui);
  ui = await openSvalSettings();
  const reopened = ui.page.document.getElementById("sval-kagi-status");
  await TestUtils.waitForCondition(
    () => reopened.dataset.state === "saved",
    "a reopened page says a token is stored"
  );
  Assert.equal(
    ui.page.document.getElementById("sval-kagi-link").value,
    "",
    "and never shows it"
  );
  Assert.ok(!ui.page.document.body.textContent.includes(token));

  ui.page.document.getElementById("sval-kagi-clear").click();
  await TestUtils.waitForCondition(
    async () => (await SvalKagi.token()) === null,
    "Clear forgets the token"
  );
  await TestUtils.waitForCondition(
    () => reopened.dataset.state === "not-set",
    "and the page says none is stored"
  );
});

/**
 * Opens the settings page afresh, at `category`. The panel focuses a page that
 * is already open instead of opening another, and an open one still shows what
 * an earlier task left.
 *
 * @param {string} category `search`, for Kagi's sign-in.
 * @param {object} [options]
 * @param {boolean} [options.shown] Whether to wait for the Kagi card.
 * @returns {Promise<object>} `openSvalSettings`'s result.
 */
async function freshSettingsPage(category, { shown = true } = {}) {
  for (const tab of [...gBrowser.tabs]) {
    if (tab.linkedBrowser.currentURI?.spec.startsWith(SETTINGS_URL)) {
      BrowserTestUtils.removeTab(tab);
    }
  }
  const ui = await openSvalSettings();
  // A control in a hidden category takes no keyboard focus.
  await showPane(ui.page, category);
  await TestUtils.waitForCondition(
    () =>
      ui.page.document
        .querySelector(shown ? "#sval-kagi-card" : "#sval-launcher-sections")
        ?.checkVisibility(),
    `the ${category} category is showing`
  );
  return ui;
}

/**
 * Makes a request from a private window to kagi.com as the address bar would,
 * and returns the Kagi header it ends up with.
 *
 * @returns {string|null}
 */
function privateKagiHeader() {
  const channel = NetUtil.newChannel({
    uri: Services.io.newURI("https://kagi.com/search?q=x"),
    loadUsingSystemPrincipal: true,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_DOCUMENT,
  }).QueryInterface(Ci.nsIHttpChannel);
  channel.loadInfo.originAttributes = { privateBrowsingId: 1 };
  Services.obs.notifyObservers(channel, "http-on-modify-request");
  try {
    return channel.getRequestHeader("X-Kagi-Authorization");
  } catch {
    return null;
  }
}

/**
 * A Session Link saved here signs private windows in to Kagi whatever the
 * default engine is, because the user's saving it is the request. It does so
 * as soon as the page takes it: saving starts Kagi's request observer, which
 * reads the store again, and a private request sent while that read is still
 * out carries the token all the same. The card stays under another engine
 * while the link is saved, so it can be cleared.
 */
add_task(async function a_saved_link_signs_private_windows_in() {
  const privacyPass = SvalKagiPrivacyPass;
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const search = SvalSettingsSync.searchService();
  const wasStarted = SvalKagi._started;
  await useEngine("kagi");
  fakeSignedIn(true);
  SvalKagi.stop();
  await SvalKagi.clearToken();
  // A Session Link is what signs private windows in when the build has no
  // engine to make Privacy Pass tokens with.
  privacyPass._unavailable = true;

  // Every read of the store from here on waits until the header is checked.
  const stored = SvalKagi._stored;
  let release;
  const gate = new Promise(resolve => (release = resolve));
  SvalKagi._stored = async function () {
    await gate;
    return stored.call(this);
  };
  registerCleanupFunction(async () => {
    release();
    SvalKagi._stored = stored;
    SvalKagi.stop();
    await SvalKagi.clearToken();
    privacyPass._reset();
    if (wasStarted) {
      SvalKagi.start();
    }
  });

  const ui = await freshSettingsPage("search");
  const doc = ui.page.document;
  const token = "tok_en-5678.efgh~XYZ";
  doc.getElementById("sval-kagi-link").value = token;
  doc.getElementById("sval-kagi-save").click();
  await TestUtils.waitForCondition(
    () => doc.getElementById("sval-kagi-link").value === "",
    "the link was taken"
  );
  await search.setById("ddg");
  Assert.equal(
    privateKagiHeader(),
    token,
    "a private request to kagi.com carries it with another engine"
  );

  release();
  Assert.equal(await SvalKagi.token(), token, "and the store holds it");
  Assert.equal(privateKagiHeader(), token, "which the read back keeps");
  await TestUtils.waitForCondition(
    () =>
      doc.getElementById("sval-kagi-status").dataset.state === "saved" &&
      doc.getElementById("sval-kagi-card").checkVisibility(),
    "the card stays while the link is saved"
  );
  Assert.ok(
    doc.getElementById("sval-kagi-clear").checkVisibility(),
    "with Clear"
  );
});
