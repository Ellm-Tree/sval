# 0076. Crash files stay local unless the user sends one

**Status:** Accepted on 2026-10-08.

## Context

Spec §10.6 keeps crash files locally so the user can attach one to a bug
report, and forbids pointing Firefox's crash reporter at Mozilla.
`--disable-crashreporter` keeps no crash file at all, so a crash in a build
without the reporter cannot be attributed.

## Decision

The crash reporter stays compiled in, in every build. Crash files stay local
unless the user chooses to send one, through the Send Feedback form or a
crash dialog's box, to `feedback.sval.app`
([1199](1199-sval-s-one-server-receives-only-the-reports-a-user-sends.md)).
`--with-crashreporter-url` points the submit URL there. Sval's prefs turn
every automatic submission off, and every crash dialog's send box and
include-address box start unticked.

## Consequences

A crash leaves a minidump in `Crash Reports/pending`, which the user can
send or leave. No report can reach Mozilla, and none leaves the device
without the user ticking a box or pressing Send (spec §10.6).
