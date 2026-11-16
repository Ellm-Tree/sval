/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The Privacy Pass stock (Kagi Privacy Pass spec): what is kept, what is
 * spent, when it refills, and what each of Kagi's answers makes the state.
 * Kagi's issuer is a stand-in here, because only Kagi holds the key; the
 * engine's request is checked against the real engine.
 */

const { SvalSecretStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs"
);
const { SvalKagi } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagi.sys.mjs"
);
const { SvalKagiPrivacyPass: PP } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKagiPrivacyPass.sys.mjs"
);
const { BasePromiseWorker } = ChromeUtils.importESModule(
  "resource://gre/modules/PromiseWorker.sys.mjs"
);
const { within } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestWait.sys.mjs"
);

do_get_profile();

const SECRET_NAME = "kagi privacy pass";
/** 2026-10-15, mid-month, so "the previous month" is September. */
const NOW = Date.UTC(2026, 9, 15, 12);

/**
 * Kagi as this module sees it: a challenge, and an issuer whose answer each
 * test sets. Records every request.
 */
class FakeKagi {
  requests = [];
  answer = { status: 200, body: "issued" };
  tokens = count => Array.from({ length: count }, (_, i) => `token${i}`);

  fetch = async (url, options) => {
    this.requests.push({ url, options });
    if (url.endsWith("/pp/wwwa")) {
      return {
        status: 401,
        headers: new Headers({ "WWW-Authenticate": "PrivateToken x" }),
        text: async () => "",
      };
    }
    const { status, body } = this.answer;
    if (status === "network") {
      throw new TypeError("NetworkError");
    }
    return { status, headers: new Headers(), text: async () => body };
  };

  /** The engine worker, answering with `tokens` for an `issued` body. */
  makeWorker = () => {
    const kagi = this;
    return {
      async post(method, [args] = []) {
        if (method === "ready") {
          return undefined;
        }
        if (method === "tokenRequest") {
          return { body: `request for ${args.count}`, state: "state" };
        }
        return args.response === "issued" ? kagi.tokens(PP.BATCH) : [];
      },
      terminate() {},
    };
  };

  get issued() {
    return this.requests.filter(r => r.url.endsWith("/pp/gettokens")).length;
  }
}

/**
 * Runs `work` against a profile with no secrets file, a fresh module state and
 * `kagi`, signed in to Kagi in a normal window unless `session` says otherwise.
 *
 * @param {Function} work Called with `kagi`.
 * @param {object} [options]
 * @param {string|null} [options.session]
 */
async function withKagi(work, { session = "session-value" } = {}) {
  const path = PathUtils.join(PathUtils.profileDir, "sval-secrets.json");
  await IOUtils.remove(path, { ignoreAbsent: true });
  const sessionValue = SvalKagi.sessionValue;
  SvalKagi.sessionValue = () => session;
  const kagi = new FakeKagi();
  PP._reset();
  PP._now = () => NOW;
  PP._fetch = kagi.fetch;
  PP._makeWorker = kagi.makeWorker;
  try {
    await work(kagi);
  } finally {
    await PP._refilling;
    await within(PP._tail.idle(), 10_000, "PP._tail going idle");
    PP._reset();
    await IOUtils.remove(path, { ignoreAbsent: true });
    SvalKagi.sessionValue = sessionValue;
  }
}

async function store(value) {
  await SvalSecretStore.write(
    SECRET_NAME,
    new TextEncoder().encode(JSON.stringify(value))
  );
}

async function stored() {
  await within(PP._tail.idle(), 10_000, "PP._tail going idle");
  const bytes = await SvalSecretStore.read(SECRET_NAME);
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
}

add_task(async function tokens_from_before_the_previous_month_are_dropped() {
  await withKagi(
    async () => {
      await store({
        tokens: [
          ["august", Date.UTC(2026, 7, 31)],
          ["september", Date.UTC(2026, 8, 1)],
          ["october", Date.UTC(2026, 9, 2)],
        ],
      });
      await PP.start();
      Assert.equal(PP.count(), 2);
      Assert.deepEqual(
        (await stored()).tokens.map(([token]) => token),
        ["september", "october"]
      );
    },
    { session: null }
  );
});

add_task(
  async function the_newest_token_is_spent_first_and_the_spend_is_kept() {
    await withKagi(
      async () => {
        const tokens = Array.from({ length: 60 }, (_, i) => [`t${i}`, NOW - i]);
        await store({ tokens });
        await PP.start();
        Assert.equal(PP.state(), "ready");
        Assert.equal(PP.take(), "t59");
        Assert.equal(PP.take(), "t58");
        Assert.equal((await stored()).tokens.length, 58);

        PP._reset();
        PP._now = () => NOW;
        await PP.start();
        Assert.equal(PP.count(), 58);
      },
      { session: null }
    );
  }
);

add_task(
  async function a_low_stock_refills_and_an_empty_one_refills_at_start() {
    await withKagi(async kagi => {
      await store({
        tokens: Array.from({ length: PP.LOW + 1 }, (_, i) => [`t${i}`, NOW]),
      });
      await PP.start();
      Assert.equal(kagi.issued, 0, "a stock above the threshold waits");
      PP.take();
      await PP._refilling;
      Assert.equal(kagi.issued, 1, "the stock at the threshold refills");
      Assert.equal(PP.count(), PP.LOW + PP.BATCH);
    });

    await withKagi(async kagi => {
      await PP.start();
      await PP._refilling;
      Assert.equal(kagi.issued, 1, "an empty stock refills at start");
      Assert.equal(PP.state(), "ready");
    });
  }
);

add_task(
  async function the_issuance_request_carries_the_session_and_nothing_else() {
    await withKagi(async kagi => {
      await PP.start();
      await PP._refilling;
      const [challenge, issue] = kagi.requests;
      Assert.equal(challenge.url, "https://kagi.com/pp/wwwa");
      Assert.equal(issue.url, "https://kagi.com/pp/gettokens");
      for (const { options } of kagi.requests) {
        Assert.equal(options.credentials, "omit");
        Assert.equal(options.referrerPolicy, "no-referrer");
        Assert.equal(options.headers["X-Kagi-PrivacyPass-Client"], "true");
      }
      Assert.equal(issue.options.headers.Authorization, "session-value");
      Assert.equal(challenge.options.headers.Authorization, undefined);
    });
  }
);

add_task(async function no_refill_runs_without_a_normal_window_session() {
  await withKagi(
    async kagi => {
      await PP.start();
      await PP.refill();
      Assert.equal(kagi.requests.length, 0);
      Assert.equal(PP.state(), "signedOut");
    },
    { session: null }
  );
});

add_task(async function each_issuance_answer_sets_the_state() {
  const cases = [
    [{ status: 401, body: '{"error_code":"not_logged_in"}' }, "signedOut"],
    [{ status: 403, body: '{"error_code":"no_subscription"}' }, "unsupported"],
    [
      { status: 403, body: '{"error_code":"unsupported_subscription"}' },
      "unsupported",
    ],
    [{ status: 429, body: "" }, "out"],
    [{ status: 200, body: "" }, "out"],
    [{ status: 200, body: "nothing issued" }, "out"],
    [{ status: 500, body: "" }, "signedOut"],
    [{ status: "network" }, "signedOut"],
  ];
  for (const [answer, state] of cases) {
    await withKagi(async kagi => {
      kagi.answer = answer;
      await PP.start();
      await PP._refilling;
      Assert.equal(PP.state(), state, JSON.stringify(answer));
      if (state === "out") {
        Assert.equal(PP.outUntil(), Date.UTC(2026, 10, 1));
      }
    });
  }
});

add_task(async function a_settled_answer_persists_and_stops_refills() {
  await withKagi(async kagi => {
    kagi.answer = { status: 403, body: '{"error_code":"no_subscription"}' };
    await PP.start();
    await PP._refilling;
    Assert.equal((await stored()).unsupported, true);

    PP._reset();
    PP._now = () => NOW;
    await PP.start();
    await PP._refilling;
    Assert.equal(PP.state(), "unsupported");
    Assert.equal(
      kagi.issued,
      1,
      "a plan without Privacy Pass is not asked again"
    );

    kagi.answer = { status: 200, body: "issued" };
    await PP.checkAgain();
    Assert.equal(PP.state(), "ready");
    Assert.equal((await stored()).unsupported, false);
  });

  await withKagi(async kagi => {
    kagi.answer = { status: 429, body: "" };
    await PP.start();
    await PP._refilling;
    await PP.refill();
    Assert.equal(kagi.issued, 1, "a used allowance waits for next month");
    PP._now = () => Date.UTC(2026, 10, 1, 0, 1);
    kagi.answer = { status: 200, body: "issued" };
    Assert.equal(
      PP.state(),
      "signedOut",
      "the first look after the reset finds no tokens yet"
    );
    await PP._refilling;
    Assert.equal(kagi.issued, 2, "and asks Kagi again without a restart");
    Assert.equal(PP.state(), "ready");
  });
});

add_task(async function a_failed_refill_is_retried_later() {
  await withKagi(async kagi => {
    // The retry's wait is cut to nothing, so the retry itself is what runs.
    // Kagi fails the first issuance and answers the next.
    PP._retryMs = 0;
    let answered = 0;
    Object.defineProperty(kagi, "answer", {
      get: () =>
        answered++
          ? { status: 200, body: "issued" }
          : { status: 500, body: "" },
    });
    const ready = new Promise(resolve => {
      const stop = PP.addListener(() => {
        if (PP.state() === "ready") {
          stop();
          resolve();
        }
      });
    });
    await PP.start();
    await within(ready, 10_000, "the retried refill");
    Assert.equal(kagi.issued, 2, "after one failure, the retry asked again");
  });
});

add_task(async function a_build_without_the_engine_is_unavailable() {
  await withKagi(async kagi => {
    PP._makeWorker = () => ({
      async post() {
        throw Object.assign(new Error("not built"), {
          code: "engine_not_built",
        });
      },
      terminate() {},
    });
    await PP.start();
    await PP._refilling;
    Assert.equal(PP.state(), "unavailable");
    Assert.equal(kagi.issued, 0);
  });
});

/**
 * A challenge as Kagi's `/pp/wwwa` sends it, for the batched ristretto255
 * token type, under the ristretto255 base point as the issuer key.
 *
 * @returns {string} a `WWW-Authenticate` value.
 */
function challengeHeader() {
  const issuer = new TextEncoder().encode("kagi.com");
  const challenge = new Uint8Array([
    0xf9,
    0x1a,
    0,
    issuer.length,
    ...issuer,
    0,
    0,
    0,
  ]);
  const key = Uint8Array.from(
    "e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76".match(
      /../g
    ),
    byte => parseInt(byte, 16)
  );
  const b64url = bytes => ChromeUtils.base64URLEncode(bytes, { pad: true });
  return `PrivateToken challenge=${b64url(challenge)}, token-key=${b64url(key)}`;
}

add_task(async function the_engine_makes_a_request_kagi_can_read() {
  const worker = new BasePromiseWorker(
    "chrome://browser/content/sval/SvalKagi.worker.mjs",
    { type: "module" }
  );
  worker.ExceptionHandlers.SvalError = data =>
    Object.assign(new Error(data.message), { code: data.code });
  registerCleanupFunction(() => worker.terminate());

  const { body, state } = await worker.post("tokenRequest", [
    { challenge: challengeHeader(), count: 3 },
  ]);
  const bytes = new Uint8Array(
    ChromeUtils.base64URLDecode(body, { padding: "require" })
  );
  // token type, truncated key id, then a u16 length of 32-byte elements.
  Assert.deepEqual([bytes[0], bytes[1]], [0xf9, 0x1a]);
  Assert.equal((bytes[3] << 8) | bytes[4], 3 * 32);
  Assert.equal(bytes.length, 5 + 3 * 32);
  Assert.ok(state.length, "a client state comes back");

  await Assert.rejects(
    worker.post("tokenRequest", [{ challenge: "PrivateToken x", count: 3 }]),
    err => err.code === "invalid_challenge"
  );
  await Assert.rejects(
    worker.post("finalize", [{ state, response: "AAAA" }]),
    err => err.code === "invalid_response"
  );
});
