/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * How often Kagi in a normal window reaches the system store. On macOS every
 * call to it can be a Keychain prompt, so browsing Kagi must not make one,
 * and an answered prompt must not come back. The store here records each
 * call; the cookie service is the real one, as Kagi's responses drive it.
 */

const { tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;
const { SvalSecretStore, MemoryKeyStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
);
const { SvalKagi } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagi.sys.mjs"
);
const { SvalKagiPrivacyPass: PP } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagiPrivacyPass.sys.mjs"
);

const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

do_get_profile();

/** A system store that counts every call, refused ones included. */
class CountingKeyStore extends MemoryKeyStore {
  calls = 0;
}
for (const method of [
  "asyncGenerateSecret",
  "asyncGetRecoveryPhrase",
  "asyncDeleteSecret",
]) {
  CountingKeyStore.prototype[method] = async function (...args) {
    this.calls++;
    return MemoryKeyStore.prototype[method].apply(this, args);
  };
}

const NO_SUBSCRIPTION = {
  status: 403,
  body: '{"error_code":"no_subscription"}',
};

/**
 * Kagi sets a cookie on a response, with a later expiry each time.
 *
 * @param {string} name
 * @param {string} value
 */
function kagiSets(name, value) {
  Services.cookies.add(
    "kagi.com",
    "/",
    name,
    value,
    true,
    true,
    false,
    Date.now() + 3600 * 1000 + Math.floor(Math.random() * 1000),
    {},
    Ci.nsICookie.SAMESITE_LAX,
    Ci.nsICookie.SCHEME_HTTPS
  );
}

/** Waits for every read, write and refill the last event started. */
async function settled() {
  for (let i = 0; i < 10; i++) {
    await PP._refilling;
    await within(PP._tail.idle(), 10_000, "PP._tail going idle");
    await within(SvalKagi._tail.idle(), 10_000, "SvalKagi._tail going idle");
    await within(
      SvalSecretStore._writes.idle(),
      10_000,
      "SvalSecretStore._writes going idle"
    );
    await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
  }
}

/**
 * Runs `work` with Kagi the default engine, watched as a window's start
 * watches it, over a system store that already holds this user's secret, as
 * one an earlier Sval made does. Kagi's issuer answers `answer`.
 *
 * @param {Function} work Called with the store and the engine observer.
 * @param {object} answer
 */
async function withKagiEngine(work, answer = NO_SUBSCRIPTION) {
  const previous = {
    path: SvalSecretStore.path,
    keyStore: SvalSecretStore.keyStore,
    systemStoreUsable: SvalSecretStore.systemStoreUsable,
  };
  const keyStore = new CountingKeyStore();
  await keyStore.asyncGenerateSecret(SvalSecretStore.userLabel());
  keyStore.calls = 0;
  SvalSecretStore.path = tempPath("sval-secrets", ".json");
  SvalSecretStore.keyStore = keyStore;
  SvalSecretStore.systemStoreUsable = true;
  PP._reset();
  PP._fetch = async url =>
    url.endsWith("/pp/wwwa")
      ? {
          status: 401,
          headers: new Headers({ "WWW-Authenticate": "PrivateToken x" }),
          text: async () => "",
        }
      : {
          status: answer.status,
          headers: new Headers(),
          text: async () => answer.body,
        };
  PP._makeWorker = () => ({
    async post(method) {
      return method === "tokenRequest" ? { body: "b", state: "s" } : [];
    },
    terminate() {},
  });
  let engineChanged;
  const search = {
    currentId: async () => "kagi",
    observe: observer => {
      engineChanged = observer;
      return () => {};
    },
  };
  try {
    await SvalKagi.watchSearch(search);
    await work(keyStore, () => engineChanged());
  } finally {
    await settled();
    Services.cookies.removeAll();
    SvalKagi._stopWatchingSearch();
    SvalKagi.stop();
    PP._reset();
    await IOUtils.remove(SvalSecretStore.path, { ignoreAbsent: true });
    Object.assign(SvalSecretStore, previous);
  }
}

add_task(async function a_signed_out_kagi_search_never_reaches_the_store() {
  await withKagiEngine(async (keyStore, engineChanged) => {
    await settled();
    Assert.equal(keyStore.calls, 0, "Kagi starting asks the store nothing");
    // A signed-out search: Kagi sets its own visitor cookie, and the search
    // service says its engine was used.
    kagiSets("_kagi_search_", "visitor");
    engineChanged();
    await settled();
    kagiSets("_kagi_search_", "visitor-again");
    await settled();
    Assert.equal(keyStore.calls, 0, "and neither does searching");
  });
});

add_task(async function a_session_kagi_sets_again_writes_nothing_new() {
  await withKagiEngine(async keyStore => {
    kagiSets("kagi_session", "session");
    await settled();
    Assert.equal(PP.state(), "unsupported", "Kagi says the plan has none");
    Assert.greater(keyStore.calls, 0, "which is stored once");

    keyStore.calls = 0;
    kagiSets("kagi_session", "session");
    await settled();
    kagiSets("kagi_session", "session");
    await settled();
    Assert.equal(
      keyStore.calls,
      0,
      "the same answer to the same session is not stored again"
    );
    Assert.equal(PP.state(), "unsupported");
  });
});

add_task(async function a_refused_write_is_not_tried_again() {
  await withKagiEngine(async keyStore => {
    SvalSecretStore.retry();
    keyStore.failing.asyncGetRecoveryPhrase = new Error("denied");
    kagiSets("kagi_session", "session");
    await settled();
    Assert.greater(keyStore.calls, 0, "the first answer is offered");
    Assert.equal(PP.state(), "unsupported", "and kept in memory");

    keyStore.calls = 0;
    kagiSets("kagi_session", "session");
    await settled();
    kagiSets("kagi_session", "session");
    await settled();
    Assert.equal(keyStore.calls, 0, "a refusal is not asked again");
  });
});

add_task(async function a_refused_read_is_not_tried_again() {
  await withKagiEngine(async keyStore => {
    await settled();
    await SvalSecretStore.write(
      "kagi privacy pass",
      new TextEncoder().encode(JSON.stringify({ unsupported: true }))
    );
    PP._reset();
    SvalSecretStore.retry();
    keyStore.failing.asyncGetRecoveryPhrase = new Error("denied");
    keyStore.calls = 0;
    await PP.start();
    Assert.equal(keyStore.calls, 1, "the stock is asked for once");

    kagiSets("kagi_session", "session");
    await settled();
    kagiSets("kagi_session", "session");
    await settled();
    await PP.refill();
    Assert.equal(keyStore.calls, 1, "and not again after a refusal");
  });
});
