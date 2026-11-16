# 0104. Sval supports only the filter syntax adblock-rust applies, and Strict strips query parameters with Firefox's own list

**Status:** Accepted on 2026-10-15.

## Context

AdGuard URL Tracking is the list that strips tracking parameters. It is almost
entirely `$removeparam` rules, which strip query parameters from a request.
Gecko's content classifier runs adblock-rust and only blocks requests, so it
cannot apply them.

Applying `$removeparam` by redirecting the channel before it connects is
unsafe, and a working version needs all of these:

- adblock-rust refuses `@@…$removeparam` exceptions, and AdGuard's list has
  about a hundred of them; without them, sign-in flows break or loop. adblock-
  rust would need patching to keep and honour them.
- Its `apply_removeparam` ignores site exceptions and allowed domains.
- A redirected cross-origin `fetch` fails CORS unless the redirect fakes
  `Access-Control-Allow-*` headers, as WebRequest does.
- The redirect bypasses `fetch`'s `redirect: "error"` and `"manual"` modes.
- Kagi's Privacy Pass would spend a token on each of the two channels.
- Every unblocked URL with a query costs a second full match.

Firefox has its own query stripping, `privacy.query_stripping.enabled` and
`privacy.query_stripping.enabled.pbmode`, with a list Mozilla curates in the
`query-stripping` Remote Settings collection. Firefox's Strict tracking-
protection category turns both on (`qps` and `qpsPBM` in
`browser.contentblocking.features.strict`).

## Decision

- **Sval does not implement `$removeparam`.**
- **Third-party lists get no support for syntax adblock-rust does not
  apply.** Sval does not chase each list's extensions; a rule adblock-rust
  drops stays dropped.
- **AdGuard URL Tracking stays out of Strict.** Custom's catalogue does not
  offer it either, since none of its rules would act.
- **Strict turns on Firefox's query stripping** in normal and private
  windows, with Mozilla's `query-stripping` list. Strict sets the prefs'
  defaults, so a value the user sets wins at every level, and leaving Strict
  puts the defaults back.

## Consequences

- Strict strips the tracking parameters Mozilla lists, which are fewer than
  AdGuard's.
- No adblock-rust patch, redirect path or second match per request is needed
  for query parameters.
- The `query-stripping` collection is among the Remote Settings
  collections Sval allows, so no new contact is added.
- Supporting another list's extended syntax is a new decision.
