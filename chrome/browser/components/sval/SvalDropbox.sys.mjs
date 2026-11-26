/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Signing in to Dropbox, for a shared folder in the user's Dropbox (desktop
 * connectors spec §3). Sval signs in to the iPhone app's Dropbox app with
 * OAuth 2 and PKCE, so it holds no secret, and asks for a refresh token,
 * which the helper turns into access tokens (`DropboxStore` in
 * `tools/sval-folder/src/remote/dropbox.rs`).
 *
 * Dropbox's page opens in a Peek. Once the user allows Sval, Dropbox answers
 * with a 302 to `REDIRECT`, a scheme no app on the computer handles. Gecko
 * would drop that redirect at `nsExtProtocolChannel::OpenURL`, which gives
 * up on a scheme with no handler before any dispatcher sees it. So while a
 * sign-in is under way Sval reads each HTTP response as it arrives
 * (`http-on-examine-response`), and takes a redirect to `REDIRECT` there:
 * it cancels the load and settles the sign-in from the address.
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** Sval's app on Dropbox (`APP_KEY` in the helper's `dropbox.rs`). */
export const APP_KEY = "94ncbej3k9vjzo7";

/** The scheme Dropbox sends a sign-in back through, as it does a phone app's. */
export const SCHEME = `db-${APP_KEY}`;

export const REDIRECT = `${SCHEME}://2/token`;

const AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

/** Thrown when the user closes Dropbox's page or declines to allow Sval. */
export class SignInCancelled extends Error {
  constructor() {
    super("The Dropbox sign-in was cancelled");
    this.name = "SignInCancelled";
  }
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomText(length) {
  return base64url(crypto.getRandomValues(new Uint8Array(length)));
}

/**
 * The PKCE challenge for `verifier`: its SHA-256, base64url-encoded (RFC 7636
 * §4.2).
 *
 * @param {string} verifier
 * @returns {Promise<string>}
 */
export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64url(new Uint8Array(digest));
}

/**
 * Dropbox's sign-in page, asking for a lasting sign-in (`offline`), as the
 * iPhone app's (`dropbox_sign_in` in `mobile/sval-mobile/src/dropbox.rs`).
 *
 * @param {object} params
 * @param {string} params.challenge
 * @param {string} params.state
 * @returns {string}
 */
export function authorizeURL({ challenge, state }) {
  const url = new URL(AUTHORIZE_URL);
  for (const [name, value] of Object.entries({
    client_id: APP_KEY,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    token_access_type: "offline",
    redirect_uri: REDIRECT,
    state,
  })) {
    url.searchParams.set(name, value);
  }
  return url.href;
}

/**
 * The sign-in under way: what its redirect must carry, and how to settle it.
 * Null when none is.
 */
let pending = null;

/** How many of the page's last loads a failed sign-in's warning lists. */
const KEPT_LOADS = 12;

/** How long the page may sit after its last load before Sval says so. */
const IDLE_MS = 15_000;

/**
 * Follows what the sign-in page does, so a sign-in that never comes back
 * says where it stopped. Each load is kept as its kind, scheme, whether its
 * host is Dropbox's, and how it ended: never an address, a code or a token
 * (`CONTRIBUTING.md` rule 10).
 */
class PageWatch {
  constructor(win) {
    this.win = win;
    this.loads = [];
    this.idle = null;
    this.browser = null;
    this.onResponse = subject => this._response(subject);
    this.listener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onStateChange: (browser, progress, request, flags, status) =>
        this._state(browser, progress, request, flags, status),
      onLocationChange: (browser, progress, request, location) =>
        this._location(browser, progress, location),
    };
    Services.obs.addObserver(this.onResponse, "http-on-examine-response");
    this._attach();
  }

  /** The page's tabs, once the Peek has started. */
  _attach() {
    if (this.win.gBrowser) {
      this.win.gBrowser.addTabsProgressListener(this.listener);
      this.browser = this.win.gBrowser.selectedBrowser;
      return;
    }
    this.started = subject => {
      if (subject !== this.win) {
        return;
      }
      Services.obs.removeObserver(
        this.started,
        "browser-delayed-startup-finished"
      );
      this.started = null;
      this._attach();
    };
    Services.obs.addObserver(this.started, "browser-delayed-startup-finished");
  }

  _note(entry) {
    this.loads.push(entry);
    if (this.loads.length > KEPT_LOADS) {
      this.loads.shift();
    }
    lazy.SvalLog.info(`dropbox: page ${entry}`);
    lazy.clearTimeout(this.idle);
    this.idle = lazy.setTimeout(() => this._idle(), IDLE_MS);
  }

  static place(uri) {
    if (!uri) {
      return "none";
    }
    let host = "";
    try {
      host = uri.host;
    } catch {}
    return `${uri.scheme}${/(^|\.)dropbox(api)?\.com$/.test(host) ? "(dropbox)" : ""}`;
  }

  _ours(browsingContext) {
    return (
      !!this.browser && browsingContext?.top === this.browser.browsingContext
    );
  }

  _response(subject) {
    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch {
      return;
    }
    const info = channel.loadInfo;
    if (
      !this._ours(info?.browsingContext) ||
      info.externalContentPolicyType !== Ci.nsIContentPolicy.TYPE_DOCUMENT
    ) {
      return;
    }
    let entry = `response ${PageWatch.place(channel.URI)} ${channel.responseStatus}`;
    try {
      const to = Services.io.newURI(
        channel.getResponseHeader("Location"),
        null,
        channel.URI
      );
      entry += ` redirect-to ${PageWatch.place(to)}`;
    } catch {}
    this._note(entry);
  }

  _state(browser, progress, request, flags, status) {
    if (browser !== this.browser || !progress.isTopLevel) {
      return;
    }
    const { STATE_STOP, STATE_IS_DOCUMENT } = Ci.nsIWebProgressListener;
    if (!(flags & STATE_STOP) || !(flags & STATE_IS_DOCUMENT)) {
      return;
    }
    let scheme = "none";
    try {
      scheme = PageWatch.place(request.QueryInterface(Ci.nsIChannel).URI);
    } catch {}
    const ended = status ? ChromeUtils.getXPCOMErrorName(status) : "ok";
    this._note(`stopped ${scheme} ${ended}`);
  }

  _location(browser, progress, location) {
    if (browser !== this.browser || !progress.isTopLevel) {
      return;
    }
    this._note(`at ${PageWatch.place(location)}`);
  }

  /** The page has done nothing for a while with no redirect back to Sval. */
  _idle() {
    lazy.SvalLog.warn(
      `dropbox: the sign-in page has sat ${IDLE_MS / 1000} s without ` +
        `sending Sval back; its last loads: ${this.summary()}`
    );
  }

  summary() {
    return this.loads.join("; ") || "none";
  }

  stop() {
    if (this.started) {
      Services.obs.removeObserver(
        this.started,
        "browser-delayed-startup-finished"
      );
      this.started = null;
    }
    lazy.clearTimeout(this.idle);
    Services.obs.removeObserver(this.onResponse, "http-on-examine-response");
    try {
      this.win.gBrowser?.removeTabsProgressListener(this.listener);
    } catch {}
  }
}

export const SvalDropbox = {
  // Replaced in tests.
  _fetch: (...args) => fetch(...args),
  _openPage: url => lazy.SvalPeek.open(Services.io.newURI(url)),
  /** Whether a sign-in follows its page's loads; tests' pages have none. */
  _watchPage: true,

  /**
   * Signs in: opens Dropbox's page, waits for the user to allow Sval, and
   * trades the code for a refresh token. A sign-in already under way is
   * cancelled.
   *
   * @returns {Promise<string>} the refresh token.
   * @throws {SignInCancelled} when the user closes the page or declines.
   */
  async signIn() {
    pending?.reject(new SignInCancelled());
    const verifier = randomText(48);
    const state = randomText(16);
    const challenge = await challengeFor(verifier);
    lazy.SvalLog.info("dropbox: sign-in started");
    const code = await new Promise((resolve, reject) => {
      const mine = { state, resolve, reject, win: null, watch: null };
      pending = mine;
      const onResponse = subject => this._examine(subject);
      const settle = () => {
        if (pending === mine) {
          pending = null;
        }
        Services.obs.removeObserver(onClosed, "domwindowclosed");
        Services.obs.removeObserver(onResponse, "http-on-examine-response");
        mine.watch?.stop();
        if (mine.win && !mine.win.closed) {
          mine.win.close();
        }
      };
      const onClosed = subject => {
        if (subject === mine.win) {
          mine.win = null;
          lazy.SvalLog.warn(
            "dropbox: the sign-in page closed before Dropbox sent Sval " +
              `back; its last loads: ${mine.watch?.summary() ?? "none"}`
          );
          mine.reject(new SignInCancelled());
        }
      };
      mine.resolve = value => {
        settle();
        resolve(value);
      };
      mine.reject = err => {
        settle();
        reject(err);
      };
      Services.obs.addObserver(onClosed, "domwindowclosed");
      Services.obs.addObserver(onResponse, "http-on-examine-response");
      mine.win = this._openPage(authorizeURL({ challenge, state }));
      if (this._watchPage) {
        mine.watch = new PageWatch(mine.win);
      }
      lazy.SvalLog.info("dropbox: sign-in page opened");
    });
    lazy.SvalLog.info("dropbox: Dropbox sent Sval back with a code");
    return this._redeem(code, verifier);
  },

  /**
   * Trades a sign-in's code for a refresh token.
   *
   * @param {string} code
   * @param {string} verifier
   * @returns {Promise<string>}
   */
  async _redeem(code, verifier) {
    const response = await this._fetch(TOKEN_URL, {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: APP_KEY,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
      }).toString(),
    });
    lazy.SvalLog.info(
      `dropbox: the code's exchange answered ${response.status}`
    );
    if (!response.ok) {
      throw new Error(`Dropbox refused the sign-in: ${response.status}`);
    }
    const token = (await response.json())?.refresh_token;
    if (typeof token !== "string" || !token) {
      throw new Error("Dropbox gave no refresh token");
    }
    return token;
  },

  /**
   * Takes a response that redirects to `REDIRECT`: the load stops there, and
   * the address settles the sign-in.
   *
   * @param {nsISupports} subject An `http-on-examine-response` channel.
   */
  _examine(subject) {
    let channel;
    let to;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
      const status = channel.responseStatus;
      if (status < 300 || status > 399) {
        return;
      }
      to = Services.io.newURI(
        channel.getResponseHeader("Location"),
        null,
        channel.URI
      );
    } catch {
      return;
    }
    if (to.scheme !== SCHEME) {
      return;
    }
    channel.cancel(Cr.NS_BINDING_ABORTED);
    this.claimRedirect(to);
  },

  /**
   * Whether `uri` is Dropbox's redirect, which Sval takes so no other app is
   * asked to open it. Its code settles the sign-in under way when its state
   * matches; any other is dropped.
   *
   * @param {nsIURI} uri
   * @returns {boolean}
   */
  claimRedirect(uri) {
    if (uri.scheme !== SCHEME) {
      return false;
    }
    lazy.SvalLog.info(
      `dropbox: claimed the redirect, ${pending ? "with" : "with no"} sign-in under way`
    );
    let params;
    try {
      params = new URL(uri.spec).searchParams;
    } catch {
      return true;
    }
    if (!pending || params.get("state") !== pending.state) {
      lazy.SvalLog.warn(
        pending
          ? "dropbox: a redirect whose state is another sign-in's"
          : "dropbox: a redirect with no sign-in under way"
      );
      return true;
    }
    const code = params.get("code");
    if (code) {
      pending.resolve(code);
    } else {
      // Dropbox answers `error=access_denied` when the user declines.
      lazy.SvalLog.warn(
        `dropbox: Dropbox sent Sval back without a code: ${params.get("error") ?? "no error named"}`
      );
      pending.reject(new SignInCancelled());
    }
    return true;
  },
};
