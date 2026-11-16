# Kagi in private windows signs in with Privacy Pass

Date: 2026-10-08. Status: built. Decision 0091 holds the rules and their
reasons: private windows sign in to Kagi with Privacy Pass, the normal
window's `kagi_session` serves only to fetch tokens from chrome code, and a
pasted Session Link (decision 0081) signs private windows in only when Kagi
says the account cannot use Privacy Pass or the build has no engine.

## What Kagi does

These facts come from the source of Kagi's extension, `privacypass-extension`
v1.0.13 (`beec34d`), and of its library, `privacypass-lib` (`8bdacc1`). Both
are MIT licensed.

- **Scheme.** Batched tokens over the privately verifiable VOPRF on
  ristretto255 (`privacypass::batched_tokens_ristretto255`). That is RFC 9578
  §5 and RFC 9497 with the batched-tokens draft on top.
- **Key.** `GET https://kagi.com/pp/wwwa` with `X-Kagi-PrivacyPass-Client:
  true`. The response's `WWW-Authenticate` header carries one `PrivateToken`
  challenge, and the issuer key is in its `token-key`. Kagi rotates the key
  monthly.
- **Issuance.** `POST https://kagi.com/pp/gettokens` with these headers:
  - `Content-Type: application/private-token-request`
  - `X-Kagi-PrivacyPass-Client: true`
  - `Authorization: <kagi_session value>`

  The body is the base64url of the TLS-serialised batched token request, and
  the response is text the library finalises. Kagi answers:

  | Response | Meaning |
  |---|---|
  | 200 | a batch of 300 tokens |
  | 401 `not_logged_in` | no valid session |
  | 403 `no_subscription` or `unsupported_subscription` | the plan has no Privacy Pass |
  | 429, or 200 with no tokens | this month's allowance is used |

  The allowance is 10 batches, which is 3,000 tokens, a month.
- **Redemption.** Each request carries one token, as
  `Authorization: PrivateToken token="<base64url token>"`, plus
  `X-Kagi-PrivacyPass-Client: true`. A token is spent on use. The request
  carries no `Cookie` and no `Referer`. Kagi answers:
  - **401:** the token was already spent.
  - **403:** Kagi does not accept the token. Kagi's extension expects this
    only against a staging server, and keeps its tokens.
- **Paths.** The extension adds a token only to Kagi's own pages: `/`, `/html/`
  and `/socket/`, each followed by `search`, `images`, `videos`, `news`,
  `podcasts`, `settings`, `summarizer`, `mother/` or `reverse/`, or by the end
  of the path or a query.
- **Autosuggest.** Kagi points it at `kagisuggest.com`, which takes no
  credential. Privacy Pass does not touch it.

## Components

### The engine: `privacy_pass`

A module of the engine crate (`sval-core`, `engine/src/privacy_pass.rs`)
over the `privacypass` crate that Kagi's `privacypass-lib` builds on,
pinned to the same git revision, so Sval sends what Kagi's issuer is known to
accept. It does what `privacypass-lib`'s client does, in safe Rust; that
library's own crate is a C-string FFI layer with a native async runtime,
which a WASM engine has no use for. The module exposes two WASM functions and
keeps no state between calls (`docs/host-contract.md` §12):

- `kagiTokenRequest(wwwAuthenticate, count)` returns `{ body, state }`.
  `body` is the issuance POST body. `state` is the opaque client state that
  finalisation needs, and carries the challenge. It throws when the header
  carries no usable challenge, or more than one.
- `kagiTokenFinalize(state, response)` returns the tokens, each as the
  base64url string the redemption header carries. It throws on a response that
  does not verify against the challenge's key.

The randomness comes from the host's `crypto.getRandomValues`, as for the rest
of the engine. Unit tests run natively against the `privacypass` crate's own
issuer. The browser calls both functions in `SvalKagi.worker.mjs`, a worker
of its own that lives only for one refill, because the parent process's
system CSP refuses to compile WASM on the main thread.

### Sval: `SvalKagiPrivacyPass.sys.mjs`

The module that owns the token stock. It is separate from `SvalKagi`, which
keeps the request observer and the Session Link.

**Stock.** The stock lives in `SvalSecretStore` under one name,
`kagi privacy pass`, as JSON:
`{ tokens: [[token, issuedMs], …], unsupported, outUntil }`. It is kept per
device and never synced. Tokens are spent newest first. Tokens issued before
the start of the previous calendar month are dropped on read, because the key
they were issued under has been retired. The stock survives signing out of a
normal window, because a token carries nothing that identifies the account.

**State,** read by `SvalKagi` and by Settings:

| State | When |
|---|---|
| `unavailable` | the engine is the public stub |
| `signedOut` | no tokens, and no normal-window session |
| `ready` | at least one token |
| `out` | no tokens, and `outUntil` is in the future |
| `unsupported` | Kagi answered 403 `no_subscription` or `unsupported_subscription` |

**`take()`** removes and returns one token, synchronously, from a copy held in
memory. It schedules the write to the store. Then it checks the refill
threshold.

**Refill.**
- **Who refills:** only chrome code. It refills only while the normal cookie
  store holds a live `kagi_session`, read the way `SvalKagi.signedIn()` reads
  it. The value goes only into the `Authorization` header of the issuance POST.
- **How:** a privileged `fetch` with `credentials: "omit"` and no referrer.
  It first GETs `/pp/wwwa` for the current key, then POSTs to `/pp/gettokens`.
  One refill runs at a time.
- **When:**
  - The stock falls to 50 or fewer.
  - At start, when the stock is empty and a normal window is signed in.
  - When a sign-in to Kagi in a normal window adds `kagi_session`.
  - The first time the state is read after `outUntil` has passed.

**How each issuance answer is handled:**

| Answer | What Sval does |
|---|---|
| 200 with tokens | adds them, and clears `unsupported` and `outUntil` |
| 401 | does nothing. The state stays `signedOut` once the stock runs dry. |
| 403 `no_subscription` or `unsupported_subscription` | sets `unsupported`, and stops refilling until a new `kagi_session` appears or the user presses "Check again" in Settings |
| 429, or 200 with no tokens | sets `outUntil` to the 1st of next month, 00:00 UTC |
| a network error, or another status | retries with backoff, up to 1 hour between tries, for as long as Sval runs |

`unsupported` and `outUntil` persist, so a restart does not ask Kagi again.

### Sval: `SvalKagi` request observer

`SvalKagi` keeps the eligibility rules of decision 0081. A request is eligible
when it is private, `https`, for exactly `kagi.com`, and one of these:
- a top-level document load the system principal or `https://kagi.com`
  started;
- an XHR or fetch `https://kagi.com` started.

Frames are never eligible. On top of that, the path must match Kagi's
extension path list, quoted above.

Each eligible request is handled by state:

| State | What the request gets |
|---|---|
| `ready` | one token from `take()`, the `X-Kagi-PrivacyPass-Client` header, and no `Cookie`, `Referer` or `X-Kagi-Authorization` |
| `unsupported` or `unavailable`, with a Session Link stored | `X-Kagi-Authorization` |
| `out` | a top-level load is cancelled, and the tab loads the out-of-tokens page. An XHR is cancelled. |
| `signedOut`, or `unsupported` or `unavailable` with no link | nothing, so Kagi sees a signed-out request |

Every other private request to Kagi loses any `Authorization` or
`X-Kagi-Authorization` header a redirect copied onto it.

**Responses.** An `http-on-examine-response` observer watches eligible
private responses that carried a token:
- **401:** the token is already gone. Sval reloads the tab once with a fresh
  token, at most once a minute per tab. This is what Kagi's extension does.
- **403:** Sval keeps the stock and does not refill or reload. Kagi's page
  shows. This is what Kagi's extension does: a 403 here can come from
  something other than the token, and a refill spends one of the month's
  batches.

### The out-of-tokens page

`chrome://browser/content/sval/kagi-tokens.html` is a local page, a chrome
page like Sval's home page, and contacts nothing. It says the
private-window allowance for this month is used and when it resets. It also
says normal windows still search as usual. It offers no way to sign in from
the private window.

### Settings, Kagi section

Settings › Search and Launcher has a Kagi card while Kagi is the default
engine or private windows' engine, or while a Session Link is stored (design
spec §10.8). Signed out in normal windows, it offers "Sign in to Kagi", which
opens first run's sign-in window, and says nothing about private windows
unless a Session Link is stored. Signed in, it says "Signed in to Kagi." and
one line for private windows, by state:

| State | Line |
|---|---|
| `ready` | signed in with Privacy Pass, and the searches left |
| `out` | this month's searches are used, and the date they reset |
| `unsupported` | the plan has no Privacy Pass, so private windows are signed out or use the stored Session Link, then a "Check again" button |
| `signedOut` | private windows sign in once Kagi sends tokens, or use the stored Session Link |
| `unavailable` | no private-window line |

The Session Link field shows under `unsupported` and `unavailable` while
signed in, and whenever a Session Link is stored, so Clear stays reachable.

## Network contact

Every request goes to `kagi.com`, which `scripts/network-contact/allowed-hosts.txt`
lists as opt-in. Sval does not use Kagi's
onion host. The issuance requests run only when Kagi is the search engine or a
Session Link is stored, under the same conditions that start `SvalKagi`.

## What Sval logs

Sval logs state names, counts and HTTP status codes. It never logs a token, a
challenge, a request body, a session value or a URL. `test_sval_log.js` covers
the module.

## Tests

**Engine (native):**
- Tokens from `kagiTokenRequest` and `kagiTokenFinalize` redeem at the
  `privacypass` crate's issuer, once each.
- A challenge header with zero or two challenges throws.
- A response under the wrong key throws.

**Sval (xpcshell), `test_sval_kagi_privacy_pass.js`:**
- Tokens from before the previous month are dropped on read.
- `take()` spends the newest token first, and persists.
- A refill starts at 50 tokens, and at start with an empty stock.
- Each issuance answer sets the state in the table above. The issuer is a
  test server, and the engine is the real one.
- No refill runs without a live normal-window `kagi_session`.

**Sval (browser), `browser_sval_kagi.js` and `browser_sval_kagi_response.js`:**
- A private top-level load of `kagi.com/search` carries exactly one token, and
  no cookie. The stock drops by one.
- A normal-window load carries no token.
- With the stock at `out`, a private load is cancelled before it is sent.
- With `unsupported` and a stored Session Link, the load carries
  `X-Kagi-Authorization` and no token.
- A link from another site to `kagi.com` carries neither header.
- A 401 response reloads once with a new token.

## Nightly

The network-contact nightly runs
`scripts/kagi-privacy-pass-check.py`. It fetches `kagi.com/pp/wwwa` live and
checks the answer is what `kagiTokenRequest` accepts: exactly one
`PrivateToken` challenge of type `0xF91A`, with a 32-byte key. That step needs
no engine and no account. A failure means Kagi changed its endpoint or its scheme, so it
opens an issue. Issuance itself needs a paid account, so the nightly does not
test it.

## Not in scope

- Copying the normal window's session into private windows, or a setting that
  would allow it.
- Pinning the User-Agent and other request headers the way Kagi's extension
  does. Firefox private windows set their own fingerprinting stance, and Sval
  leaves it alone.
- Kagi's onion host.
- Privacy Pass in normal windows.
