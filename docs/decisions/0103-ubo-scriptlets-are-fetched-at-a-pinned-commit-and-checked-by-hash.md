# 0103. uBlock Origin's scriptlets are fetched at a pinned commit and checked by hash

**Status:** Accepted on 2026-10-15.

## Context

Page rules (protections spec §5.3) need a scriptlet library for `##+js(...)`
rules. Most rules in Sval's lists call uBlock Origin's scriptlets, which are
GPL-3.0 and so may not enter Sval's tree. Brave's scriptlets in
brave/adblock-resources are MPL-2.0, but they fix Brave's own problems:
`brave-fix`, the one Brave's unbreak list calls, hides `navigator.brave` and
spoofs Chromium's client hints brand, which has no meaning in Gecko and throws
there on `NavigatorUAData`. uBlock Origin keeps its scriptlets as ES modules under
`src/js/resources/`, which register each scriptlet's function; Brave builds
adblock-rust's resources by importing `scriptlets.js` and serializing each
function with its dependencies.

A scriptlet runs as code in every page it matches. A library fetched from a
moving branch would run whatever was last pushed, unreviewed.

## Decision

- **Sval ships no scriptlets of its own or of Brave's.** uBlock Origin's are
  the whole library. A `##+js(...)` rule that names a scriptlet the library
  lacks, such as Brave's unbreak list's `brave-fix`, injects nothing, and the
  list's other rules still apply.
- **uBlock Origin's scriptlets are fetched at runtime from uBlock Origin's own
  repository as data**, never committed to Sval.
- **The fetch is pinned to one commit, and every file is checked against its
  SHA-256 before use.** A file that does not match refuses the whole set, and
  no scriptlet runs. The stored copy is checked again each time
  it is read. The pin and its hashes live in one place in Sval
  (`UBO_PIN` in `SvalScriptlets.sys.mjs`), and moving it is a change to Sval,
  reviewed like any other.
- Sval converts the verified modules the way Brave does, by evaluating them and
  serializing each registered function, in a sandbox with a null principal.
- The fetch reuses the blocking lists' fetcher and its guards, happens only
  while page rules are on and the blocking level uses lists, and never in test
  profiles. The host is a named host (decision 0060).
- A uBlock Origin scriptlet marked `requiresTrust` runs only from a trusted
  list: Sval's copies of uBlock Origin's own lists, as uBlock
  Origin trusts its `ublock-` lists by default, an added list the user trusts
  on this device, and the user's own rules once they trust them. Trust never
  syncs as a grant, and `browser.sval.adblock.trustedScriptlets` off trusts
  none.

## Consequences

- `##+js(...)` rules in uBlock Origin's lists work in Sval as uBlock Origin
  wrote them, at the reviewed commit.
- A new uBlock Origin release reaches Sval only when someone moves the pin and
  reviews the change.
- A list the user adds runs no trusted scriptlet until they trust it on that
  device.
