# 0126. Every default is a setting

**Status:** Accepted on 2026-10-12.

## Context

Sval sets many defaults, privacy protections among them. Hiding a protection
that is "on and breaks nothing" looks tidy and takes a choice from the user.
The user should always be able to change Sval's defaults: it is their
browser.

## Decision

- Every default Sval sets is changeable in Settings. Obscure or risky ones sit
  behind "Show advanced", each with a one-line note on what it breaks, and
  Settings offers a restore-defaults action. Nothing is reachable only in
  `about:config`, and no setting has a "never shown" tier.
- A small interaction choice, such as whether a click on history or Favorites
  opens a new tab, is decided and shipped with no switch. A pref backs
  it, so `about:config` can change it, and Settings makes `about:config` easy
  to reach.
- A choice that would strand the user without core UI is not offered. The menu
  bar on Windows and Linux is always shown, because it is the only path to the
  browser's commands there.

## Consequences

A Mozilla upstream test that fails only because of a Sval default runs with the
user-reachable setting switched (a `<pref>=<value>` on its line in
`scripts/upstream-tests.txt`, which `scripts/upstream-tests.sh` passes as
`--setpref`), which proves the opt-in works. Only removed or locked features go in
`upstream-test-known-failures.txt`.
