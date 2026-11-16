# 0104. Sval supports only the filter syntax adblock-rust applies, and strips the query parameters its lists name

**Status:** Accepted on 2026-10-15.

## Context

AdGuard URL Tracking is the list that strips tracking parameters. It is almost
entirely `$removeparam` rules, which strip query parameters from a request.
uBlock filters – Privacy, in Balanced, carries rules that each strip one
named parameter on every site, and a few exceptions. Gecko's content
classifier runs adblock-rust and only blocks requests, so it cannot apply
either list's rules.

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
`privacy.query_stripping.enabled.pbmode`. It strips the parameters in
Mozilla's `query-stripping` Remote Settings collection and in the
`privacy.query_stripping.strip_list` pref, on every site but those in
`privacy.query_stripping.allow_list`, from the address of each page a user
opens. Mozilla's list is short, and leaves out parameters that
privacytests.org checks and that uBlock Origin strips by default.

## Decision

- **Sval does not implement `$removeparam` in the blocking engine.**
- **Third-party lists get no support for syntax adblock-rust does not
  apply.** Sval does not chase each list's extensions; a rule adblock-rust
  drops stays dropped.
- **Every blocking level but Off turns on Firefox's query stripping** in
  normal and private windows. The level sets the prefs' defaults, so a value
  the user sets wins at every level, and Off puts the defaults back.
- **The level's lists add their parameters to Mozilla's.** A rule that names
  one parameter with no other option goes in the strip list. An exception
  puts the sites it names in the allow list, which then keeps every
  parameter there. A rule scoped to a site, a request type or a pattern is
  left out, because the strip list applies to every site. Sval reads the
  rules each time a list downloads, so a list's update reaches stripping on
  the list's own schedule. Both prefs are set as defaults, so a value the
  user sets wins.
- **AdGuard URL Tracking stays out of the curated levels.** Most of its rules
  are scoped, and Custom's catalogue does not offer it.

## Consequences

- Balanced strips the parameters Mozilla lists and those uBlock Privacy
  strips on every site, which together cover every parameter
  privacytests.org checks.
- Sval strips only from the address of a page the user opens. uBlock Origin
  also strips from a page's own requests.
- An exception that uBlock Origin applies to one path lifts stripping for its
  whole site.
- No adblock-rust patch, redirect path or second match per request is needed
  for query parameters.
- The `query-stripping` collection is among the Remote Settings
  collections Sval allows, so no new contact is added.
- Supporting another list's extended syntax is a new decision.
