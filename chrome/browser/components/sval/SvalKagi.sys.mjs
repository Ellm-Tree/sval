/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Kagi sign-in across normal and private windows (first-run spec §5).
 *
 * A normal window signs in to Kagi with Kagi's own `kagi_session` cookie, and
 * needs nothing from Sval. Sval reads that cookie to say whether a normal window
 * is signed in (`signedIn`), and to fetch Privacy Pass tokens with it
 * (`sessionValue`, for `SvalKagiPrivacyPass` alone). It never carries it into a
 * private window, which would link the user's private searches to their
 * account.
 *
 * **Private windows sign in with Privacy Pass** (Kagi Privacy Pass spec):
 * each request spends one token, which Kagi can check comes
 * from a subscriber and cannot link to an account. A Session Link the user
 * pastes into Settings signs private windows in only when Kagi says the
 * account's plan has no Privacy Pass, or the build has no engine to make
 * tokens with. Its token goes as `X-Kagi-Authorization: <token>`.
 *
 * Either credential goes to `kagi.com` itself, and to nothing else, from
 * private windows, and only on requests the user or Kagi started. A header is
 * not a cookie, so SameSite does not limit it. A top-level load is signed in
 * when its triggering principal is the system principal (the address bar, a
 * bookmark, a search engine) or kagi.com, so a link or form from another
 * site reaches Kagi signed out. A load the user started keeps its triggering
 * principal through a redirect, so another site redirecting it into Kagi
 * reaches Kagi signed in, as SameSite=Lax lets Kagi's cookie through in a
 * normal window. XHR/fetch are signed in only when kagi.com started them.
 * Frames never are. A subdomain may be hosted by a third party and is out of
 * scope. The path must also be one of Kagi's own pages, the list Kagi's
 * extension uses. No credential enters a URL, history or a cookie jar.
 *
 * **The token is a credential.** It lives in `SvalSecretStore`, beside the
 * sync key, encrypted under the system store's secret, so a copy of the
 * profile does not carry it. It is per device, because each sign-in is its own
 * Kagi session and signing out on one device must not break the others. No
 * diagnostic here names it, a Session Link or an address. It goes only when
 * the user clears it or pastes another.
 *
 * Only the default cookie jar counts as signed in: a `kagi_session` in a
 * container, a partitioned jar or a first-party isolated jar is another
 * session. Kagi's sign-in has been seen to set `kagi_session` Secure, for
 * `.kagi.com`, but Kagi documents neither, so a Secure cookie for `kagi.com`
 * or `.kagi.com` is read. A cookie for one subdomain alone is not Kagi's
 * session.
 *
 * **Risk.** Kagi documents Privacy Pass and the header through its
 * extension's source alone, so a change on Kagi's side would break private
 * windows silently. The nightly checks Kagi's live Privacy Pass challenge.
 *
 * This crosses into private windows, which belong to Firefox. The header
 * touches neither a workspace nor the disk.
 */

import { SvalSerialQueue } from "moz-src:///browser/components/sval/SvalSerialQueue.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalKagiPrivacyPass:
    "moz-src:///browser/components/sval/SvalKagiPrivacyPass.sys.mjs",
  CLIENT_HEADER:
    "moz-src:///browser/components/sval/SvalKagiPrivacyPass.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalSecretStore: "moz-src:///browser/components/sval/SvalSecretStore.sys.mjs",
});

const SIGNIN_URL = "https://kagi.com/signin";
/** Kagi's search engine, as Sval's search configuration names it. */
const KAGI_ENGINE_ID = "kagi";
const TRIAL_URL = "https://kagi.com/signup?plan_id=trial";

const HEADER = "X-Kagi-Authorization";
const PRIVACY_PASS_SCHEME = "PrivateToken ";
/** Where a private window that has spent this month's tokens is sent. */
const OUT_OF_TOKENS_URL = "chrome://browser/content/sval/kagi-tokens.html";
/** A tab is reloaded after a spent token at most this often. */
const RELOAD_INTERVAL_MS = 60 * 1000;

/**
 * Kagi's own pages, which are the only ones signed in: the path list of Kagi's
 * Privacy Pass extension. Matched against the path and query.
 */
const KAGI_PAGES =
  /^\/(html\/|socket\/)?($|\?|search|images|videos|news|podcasts|settings|summarizer|mother\/|reverse\/)/;
const COOKIE_NAME = "kagi_session";
const KAGI_HOST = "kagi.com";

const SECRET_NAME = "kagi token";
/**
 * Where a stored token came from. `cookie` marks one taken from the
 * `kagi_session` cookie: a normal window's session, which no private window
 * may carry, so it is forgotten when read.
 */
const SOURCES = new Set(["cookie", "link"]);

/** A header value: visible ASCII and no whitespace, so it cannot split one. */
const HEADER_VALUE = /^[\x21-\x7e]+$/;

/**
 * What a pasted raw token may be made of. Kagi calls its token opaque and
 * documents no alphabet, but a Session Link carries it unescaped in a query,
 * so it is made of URL unreserved characters, and `+`, which a link's token
 * keeps as itself (`tokenFrom`). Anything else, such as `javascript:…` or
 * half a link, is a mispaste, and storing it would replace a working token.
 */
const RAW_TOKEN = /^[A-Za-z0-9._~+-]+$/;

/**
 * @param {string} host A host name.
 * @returns {boolean} whether it is exactly `kagi.com`.
 */
function isKagiHost(host) {
  return host.toLowerCase() === KAGI_HOST;
}

/**
 * A refused token, with a `code` saying why: `not_a_session_link`,
 * `no_usable_token`, `no_token` or `not_a_token`.
 *
 * @param {string} code
 * @param {string} message What was refused, for people.
 * @returns {Error}
 */
function tokenError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * The token in what the user gave, which is a raw token or a Session Link
 * (`https://kagi.com/search?token=…`).
 *
 * The error never carries the input, because the input is a credential.
 *
 * @param {string} input
 * @returns {string} the token.
 */
function tokenFrom(input) {
  const text = typeof input === "string" ? input.trim() : "";
  let token = text;
  const isLink = text.includes("://");
  if (isLink) {
    let url;
    try {
      url = new URL(text);
    } catch (e) {
      throw tokenError(
        "not_a_session_link",
        "sval: that is not a Kagi Session Link, so no token was taken"
      );
    }
    if (url.protocol !== "https:" || !isKagiHost(url.hostname)) {
      throw tokenError(
        "not_a_session_link",
        "sval: that is not a Kagi Session Link, so no token was taken"
      );
    }
    // The raw query, because `searchParams` reads a `+` as a space.
    const pair = url.search
      .slice(1)
      .split("&")
      .find(part => part.startsWith("token="));
    try {
      token = pair ? decodeURIComponent(pair.slice("token=".length)) : "";
    } catch (e) {
      throw tokenError(
        "no_usable_token",
        "sval: that Kagi link carries no usable token"
      );
    }
    if (!token) {
      throw tokenError("no_token", "sval: that Kagi link carries no token");
    }
  }
  if (!(isLink ? HEADER_VALUE : RAW_TOKEN).test(token)) {
    throw tokenError("not_a_token", "sval: that is not a Kagi token");
  }
  return token;
}

/**
 * @param {nsICookie} cookie
 * @returns {boolean} whether it is Kagi's session cookie: Secure, for
 *   `kagi.com` or `.kagi.com`, and in the default jar (no container, no
 *   partition, no first-party isolation, not private).
 */
function isSessionCookie(cookie) {
  const attributes = cookie?.originAttributes;
  return (
    cookie?.name === COOKIE_NAME &&
    (cookie.host === KAGI_HOST || cookie.host === `.${KAGI_HOST}`) &&
    cookie.isSecure &&
    !attributes.privateBrowsingId &&
    !attributes.userContextId &&
    !attributes.firstPartyDomain &&
    !attributes.partitionKey &&
    HEADER_VALUE.test(cookie.value)
  );
}

/**
 * @param {nsICookie} cookie
 * @returns {boolean} whether it is still valid. The cookie service hands back
 *   expired cookies until it purges them, and tells no one when one expires.
 */
function isLive(cookie) {
  return cookie.isSession || cookie.expiry > Date.now();
}

/**
 * @returns {string|null} the value of the live session cookie in the default
 *   jar.
 */
function sessionCookieValue() {
  const cookies = Services.cookies.getCookiesFromHost(KAGI_HOST, {});
  return cookies.find(c => isSessionCookie(c) && isLive(c))?.value ?? null;
}

/**
 * @param {nsISupports} subject A channel.
 * @returns {nsIHttpChannel|null} it, when it belongs to a private window.
 */
function privateChannel(subject) {
  let channel;
  try {
    channel = subject.QueryInterface(Ci.nsIHttpChannel);
  } catch (e) {
    return null;
  }
  return channel.loadInfo?.originAttributes.privateBrowsingId > 0
    ? channel
    : null;
}

/**
 * @param {nsIHttpChannel} channel A private window's request.
 * @returns {boolean} whether it may be signed in to Kagi: one of Kagi's own
 *   pages on exactly `kagi.com` over https, loaded top-level by the user or
 *   Kagi, or fetched by Kagi's own page.
 */
function isEligible(channel) {
  const { loadInfo, URI } = channel;
  const type = loadInfo.externalContentPolicyType;
  const trigger = loadInfo.triggeringPrincipal;
  const startedByKagi = trigger.originNoSuffix === "https://" + KAGI_HOST;
  const startedByUser = trigger.isSystemPrincipal;
  return (
    URI.schemeIs("https") &&
    isKagiHost(URI.host) &&
    KAGI_PAGES.test(URI.pathQueryRef) &&
    ((type === Ci.nsIContentPolicy.TYPE_DOCUMENT &&
      (startedByUser || startedByKagi)) ||
      (startedByKagi &&
        (type === Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST ||
          type === Ci.nsIContentPolicy.TYPE_FETCH)))
  );
}

/**
 * Empties `name` on `channel`, when it carries it.
 *
 * @param {nsIHttpChannel} channel
 * @param {string} name
 */
function clearHeader(channel, name) {
  try {
    channel.getRequestHeader(name);
  } catch (e) {
    return;
  }
  channel.setRequestHeader(name, "", false);
}

/**
 * Takes every Kagi credential off a private request: the Session Link's
 * header, and a Privacy Pass token. Another `Authorization` is the page's own
 * and stays.
 *
 * @param {nsIHttpChannel} channel
 */
function scrub(channel) {
  clearHeader(channel, HEADER);
  clearHeader(channel, lazy.CLIENT_HEADER);
  let authorization;
  try {
    authorization = channel.getRequestHeader("Authorization");
  } catch (e) {
    return;
  }
  if (authorization.startsWith(PRIVACY_PASS_SCHEME)) {
    channel.setRequestHeader("Authorization", "", false);
  }
}

/**
 * Shows the out-of-tokens page in the tab whose load `channel` was. Nothing
 * reaches Kagi: the request was cancelled before it was sent.
 *
 * @param {nsIHttpChannel} channel A cancelled top-level load.
 */
function showOutOfTokens(channel) {
  const browser = channel.loadInfo.browsingContext?.top?.embedderElement;
  if (!browser) {
    return;
  }
  Services.tm.dispatchToMainThread(() => {
    browser.fixupAndLoadURIString(OUT_OF_TOKENS_URL, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  });
}

export const SvalKagi = {
  SIGNIN_URL,
  TRIAL_URL,
  ENGINE_ID: KAGI_ENGINE_ID,

  _started: false,
  _token: null,
  _source: null,
  _loaded: null,
  _tail: new SvalSerialQueue("kagi token store"),
  // Bumped by every start and stop, so a read begun in an earlier run cannot
  // put its result back.
  _run: 0,
  // The process's watch on the default search engine: `{ stop, checked }`.
  _searchWatch: null,
  // The `kagi_session` value `_onCookie` last told Privacy Pass about, so that
  // Kagi setting the same session again asks nothing. Never logged.
  _handledSession: null,

  /**
   * Starts the private-window header whenever Kagi is the default search
   * engine: at once if it is, and whenever it becomes so, by any route. Also
   * at once when a token is stored, because a Session Link the user pasted
   * signs private windows in under any engine and must survive a restart.
   * Once per process; later calls answer with the first one's check.
   *
   * @param {object} search The adapter `SvalSettingsSync.searchService()` makes.
   * @returns {Promise<void>} once the current engine has been checked; never
   *   rejects.
   */
  watchSearch(search) {
    if (!this._searchWatch) {
      const check = async () => {
        if (
          (await search.currentId()) === KAGI_ENGINE_ID ||
          (await this.token()) !== null
        ) {
          this.start();
        }
      };
      const stop = search.observe(() => check().catch(err => this._warn(err)));
      this._searchWatch = {
        stop,
        checked: check().catch(err => this._warn(err)),
      };
    }
    return this._searchWatch.checked;
  },

  /** So a test can start another watch. */
  _stopWatchingSearch() {
    this._searchWatch?.stop();
    this._searchWatch = null;
  },

  /** @returns {boolean} whether a normal window is signed in to Kagi. */
  signedIn() {
    return sessionCookieValue() !== null;
  },

  /**
   * The normal window's session, for `SvalKagiPrivacyPass` to fetch tokens
   * with. Nothing else may use it, and no private request carries it.
   *
   * @returns {string|null}
   */
  sessionValue() {
    return sessionCookieValue();
  },

  /**
   * Starts watching private windows' requests and responses, and normal-window
   * sign-ins, and reads the Privacy Pass stock. Idempotent, and process-wide:
   * one set of observers serves every window.
   *
   * The store is read again, and a read already in flight is set aside. The
   * token in memory stays until that read lands: `stop` empties it, so
   * whatever it holds here was read or saved since, and a Session Link the
   * user saved just before this start signs in the very next request.
   */
  start() {
    if (this._started) {
      return;
    }
    this._started = true;
    this._run++;
    this._loaded = null;
    Services.obs.addObserver(this, "http-on-modify-request");
    Services.obs.addObserver(this, "http-on-examine-response");
    Services.obs.addObserver(this, "cookie-changed");
    this._queue(() => this._load()).catch(this._warn);
    lazy.SvalKagiPrivacyPass.start();
  },

  /**
   * Stops watching, and forgets the cached token so that the next start reads
   * the store again.
   */
  stop() {
    if (!this._started) {
      return;
    }
    this._started = false;
    Services.obs.removeObserver(this, "http-on-modify-request");
    Services.obs.removeObserver(this, "http-on-examine-response");
    Services.obs.removeObserver(this, "cookie-changed");
    this._handledSession = null;
    this._forget();
  },

  _forget() {
    this._run++;
    this._token = null;
    this._source = null;
    this._loaded = null;
  },

  /**
   * @returns {Promise<string|null>} the token, once every change already
   *   observed has landed, or null when there is none or the store
   *   cannot be read.
   */
  async token() {
    try {
      await this._queue(() => this._load());
    } catch (err) {
      this._warn(err);
      return null;
    }
    return this._token;
  },

  /**
   * Stores a token the user pasted, replacing any other. Callers pass only
   * text the user typed or pasted into Sval's own field: a Session Link taken
   * from a page, a protocol handler or the clipboard would fix the user's
   * private-window Kagi session to someone else's account.
   *
   * @param {string} tokenOrSessionLink A raw token or a Session Link.
   */
  async setToken(tokenOrSessionLink) {
    const token = tokenFrom(tokenOrSessionLink);
    await this._queue(async () => {
      await this._load();
      await this._adopt(token, "link");
    });
  },

  /** Forgets the token. A normal window's cookie is left alone. */
  async clearToken() {
    await this._queue(async () => {
      await this._load();
      await this._adopt(null, null);
    });
  },

  observe(subject, topic) {
    if (topic === "http-on-modify-request") {
      this._onRequest(subject);
    } else if (topic === "http-on-examine-response") {
      this._onResponse(subject);
    } else if (topic === "cookie-changed") {
      this._onCookie(subject);
    }
  },

  /**
   * Signs in a private window's requests to Kagi that the user or Kagi started,
   * by the Privacy Pass state: a token, the Session Link's header, the
   * out-of-tokens page, or nothing. Every other private request loses any
   * Kagi credential, because an internal or HSTS-upgrade redirect copies a
   * request's headers to the replacement channel, which could be for another
   * host.
   *
   * @param {nsISupports} subject The channel.
   */
  _onRequest(subject) {
    const channel = privateChannel(subject);
    if (!channel) {
      return;
    }
    const type = channel.loadInfo.externalContentPolicyType;
    const isDocument = type === Ci.nsIContentPolicy.TYPE_DOCUMENT;
    if (!isEligible(channel)) {
      scrub(channel);
      return;
    }

    const privacyPass = lazy.SvalKagiPrivacyPass;
    switch (privacyPass.state()) {
      case "ready": {
        const token = privacyPass.take();
        if (token) {
          channel.setRequestHeader(
            "Authorization",
            `${PRIVACY_PASS_SCHEME}token="${token}"`,
            false
          );
          channel.setRequestHeader(lazy.CLIENT_HEADER, "true", false);
          channel.setRequestHeader("Cookie", "", false);
          channel.setRequestHeader("Referer", "", false);
          clearHeader(channel, HEADER);
          return;
        }
        break;
      }
      case "unsupported":
      case "unavailable":
        if (this._token) {
          channel.setRequestHeader(HEADER, this._token, false);
          clearHeader(channel, "Authorization");
          return;
        }
        break;
      case "out":
        channel.cancel(Cr.NS_BINDING_ABORTED);
        if (isDocument) {
          showOutOfTokens(channel);
        }
        return;
    }
    scrub(channel);
  },

  /**
   * Follows Kagi's answer to a private request that spent a token. A token
   * Kagi says was already spent costs one reload with a fresh one. Any other
   * answer, a 403 included, is Kagi's page to show, and the stock stays as
   * it is, as in Kagi's own extension (Kagi Privacy Pass spec).
   *
   * @param {nsISupports} subject The channel.
   */
  _onResponse(subject) {
    const channel = privateChannel(subject);
    if (!channel || !isKagiHost(channel.URI.host)) {
      return;
    }
    let authorization;
    try {
      authorization = channel.getRequestHeader("Authorization");
    } catch (e) {
      return;
    }
    if (!authorization.startsWith(PRIVACY_PASS_SCHEME)) {
      return;
    }
    if (
      channel.responseStatus === 401 &&
      channel.loadInfo.externalContentPolicyType ===
        Ci.nsIContentPolicy.TYPE_DOCUMENT
    ) {
      this._reloadOnce(channel);
    }
  },

  /** @type {WeakMap<Element, number>} when each tab was last reloaded. */
  _reloads: new WeakMap(),

  /**
   * @type {WeakMap<Element, nsIWebProgressListener>} each tab's reload that
   *   waits for its load to stop. The tab's web progress holds its listeners
   *   weakly, so this holds each one for as long as its tab lives.
   */
  _pendingReloads: new WeakMap(),

  /**
   * Reloads the tab whose load `channel` was, once that load has stopped:
   * until then the tab still shows the page before it, and a reload would
   * load that one again. A load the user left before it finished, a tab that
   * by then shows another page, has closed or has moved to another window,
   * and a tab reloaded within the minute are left alone. A POST is never
   * reloaded, since its reload asks to send the form again.
   *
   * @param {nsIHttpChannel} channel A top-level load Kagi answered with 401.
   */
  _reloadOnce(channel) {
    const browser = channel.loadInfo.browsingContext?.top?.embedderElement;
    const progress = browser?.webProgress;
    if (
      !progress ||
      channel.requestMethod !== "GET" ||
      this._pendingReloads.has(browser)
    ) {
      return;
    }
    const { URI } = channel;
    const { STATE_STOP, STATE_IS_NETWORK } = Ci.nsIWebProgressListener;
    const listener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onStateChange: (webProgress, request, flags, status) => {
        if (
          browser.isConnected &&
          (!webProgress.isTopLevel ||
            (flags & (STATE_STOP | STATE_IS_NETWORK)) !==
              (STATE_STOP | STATE_IS_NETWORK))
        ) {
          return;
        }
        progress.removeProgressListener(listener);
        this._pendingReloads.delete(browser);
        const now = Date.now();
        if (
          browser.isConnected &&
          Components.isSuccessCode(status) &&
          browser.currentURI.equalsExceptRef(URI) &&
          now - (this._reloads.get(browser) ?? 0) >= RELOAD_INTERVAL_MS
        ) {
          this._reloads.set(browser, now);
          browser.reload();
        }
      },
    };
    this._pendingReloads.set(browser, listener);
    progress.addProgressListener(
      listener,
      Ci.nsIWebProgress.NOTIFY_STATE_NETWORK
    );
  },

  /**
   * A sign-in to Kagi in a normal window: the plan may have changed, and the
   * stock may need refilling. Only a session value not handled yet counts:
   * Kagi sets the same session again with a later expiry as the user browses,
   * and that is no new sign-in. A sign-out forgets the handled value, so
   * signing in again counts.
   *
   * @param {nsISupports} subject The cookie notification.
   */
  _onCookie(subject) {
    let notification;
    try {
      notification = subject.QueryInterface(Ci.nsICookieNotification);
    } catch (e) {
      return;
    }
    const added =
      notification.action === Ci.nsICookieNotification.COOKIE_ADDED ||
      notification.action === Ci.nsICookieNotification.COOKIE_CHANGED;
    if (!added) {
      if (this._handledSession !== null && sessionCookieValue() === null) {
        this._handledSession = null;
      }
      return;
    }
    const { cookie } = notification;
    if (
      isSessionCookie(cookie) &&
      isLive(cookie) &&
      cookie.value !== this._handledSession
    ) {
      this._handledSession = cookie.value;
      lazy.SvalKagiPrivacyPass.signedIn();
    }
  },

  /**
   * Runs `task` after every task already queued, so user actions and reads
   * never interleave their reads and writes of the store.
   *
   * @param {Function} task
   * @returns {Promise} the task's own outcome.
   */
  _queue(task) {
    return this._tail.run(task);
  },

  async _load() {
    this._loaded ??= this._read().catch(err => {
      this._loaded = null;
      throw err;
    });
    await this._loaded;
  },

  async _read() {
    const run = this._run;
    const stored = await this._stored();
    if (run !== this._run) {
      return;
    }
    if (!stored) {
      this._token = null;
      this._source = null;
      return;
    }
    if (stored.source !== "link") {
      // A normal window's session, which no private window may carry.
      await this._adopt(null, null);
      return;
    }
    this._token = stored.token;
    this._source = stored.source;
  },

  /**
   * Makes `token` the token, from `source`, in memory first and then in the
   * store.
   *
   * @param {string|null} token Null forgets the token.
   * @param {"link"|null} source
   */
  async _adopt(token, source) {
    this._token = token;
    this._source = source;
    const { SvalSecretStore } = lazy;
    if (!token) {
      await SvalSecretStore.remove(SECRET_NAME);
      return;
    }
    await SvalSecretStore.write(
      SECRET_NAME,
      new TextEncoder().encode(JSON.stringify({ source, token }))
    );
  },

  /**
   * What the store holds, or null when it holds no usable token. A store that
   * cannot be read is no token for this session, and is said once.
   *
   * @returns {Promise<{token: string, source: string}|null>}
   */
  async _stored() {
    let bytes;
    try {
      bytes = await lazy.SvalSecretStore.read(SECRET_NAME);
    } catch (err) {
      this._warn(err);
      return null;
    }
    if (!bytes) {
      return null;
    }
    let stored;
    try {
      stored = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
    return SOURCES.has(stored?.source) &&
      typeof stored.token === "string" &&
      HEADER_VALUE.test(stored.token)
      ? { token: stored.token, source: stored.source }
      : null;
  },

  _warn(err) {
    lazy.SvalLog.warn(
      `Kagi sign-in state not updated: ${lazy.SvalLog.errorName(err)}`
    );
  },
};
