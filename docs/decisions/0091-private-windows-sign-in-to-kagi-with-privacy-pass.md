# 0091. Private windows sign in to Kagi with Privacy Pass

**Status:** Accepted on 2026-10-08.

## Context

Sending the normal window's `kagi_session` from private windows as
`X-Kagi-Authorization`, as Kagi's own extension does once the user consents,
links every private search to the user's Kagi account, which a private window
exists to avoid. Kagi's documented method for private browsing is Privacy Pass
(help.kagi.com, "Kagi Privacy Pass"). Orion builds it in, and Kagi's extension
adds it to Firefox and Chromium browsers.

A signed-in session fetches blind tokens, and each search spends one. Kagi can
check that a token comes from a subscriber, and cannot tell which. Kagi's
extensions do this with Kagi's MIT `privacypass-lib`, a Rust library that
builds to WASM. Privacy Pass needs an unlimited plan, and Kagi allows 3,000
tokens per account a month. Kagi sets `kagi_session` Secure for `.kagi.com`.

## Decision

- The normal window's Kagi session stays in normal windows. Sval reads a
  Secure `kagi_session` for `kagi.com` or `.kagi.com`, in the default cookie
  jar, only to say whether a normal window is signed in, which first run uses
  to know a sign-in finished, and to fetch tokens.
- Private windows sign in to Kagi with Privacy Pass, following the Kagi Privacy
  Pass spec (`2026-10-08-kagi-privacy-pass-design.md`).
- Only chrome code fetches tokens, with the normal window's `kagi_session`, and
  only to `kagi.com`.
- Tokens live in `SvalSecretStore`, per device, and are never synced.
- The VOPRF code compiles into the engine from the `privacypass` crate,
  pinned to the revision Kagi's `privacypass-lib` pins.
- A pasted Session Link signs private windows in only when Kagi says the
  account has no Privacy Pass, or when the build has no engine to make tokens
  with. No setting copies the normal session across.
- When the month's tokens are used, a private search stops at a local page and
  nothing is sent.

## Consequences

Private searches cannot be linked to the account through a credential. Users
on plans without Privacy Pass stay signed out in private windows, unless they
paste a Session Link. Public builds without the engine have no Privacy Pass.
Kagi's sign-in, run in first run's popup, is seen the moment it finishes. Kagi
documents the protocol only through its extension's source, so a nightly
check fetches the live challenge and fails when the engine cannot parse it.
