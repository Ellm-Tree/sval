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
every automatic submission off, and every crash dialog's send box starts
unticked. A crash file's annotations never hold a page's address: Gecko as
Sval builds it has no such annotation, and no crash dialog offers to add one
(`crash-reports-no-page-address.patch`).

A crash while private browsing is in use keeps no crash file. A minidump
holds the crashed process's stacks and the memory they point at, so one
written while a private window is open can hold parts of that window's
pages, and the file stays on disk after the window closes. Nothing of a
private window stays on disk, and a crash is no exception. A content process
whose remote type is a private one writes no minidump. While a private
browsing context exists, or `browser.privatebrowsing.autostart` is on, the
parent process writes none for itself and removes the minidump of every
child that serves every window: the GPU, media, network and utility
processes, and a content process that is not one site's, such as the one
for local files or for extensions (`private-browsing-no-crash-dump.patch`).
A content process for a normal window's sites holds no private page, and its
crash keeps its file.

## Consequences

A crash leaves a minidump in `Crash Reports/pending`, which the user can
send or leave. No report can reach Mozilla, and none leaves the device
without the user ticking a box or pressing Send (spec §10.6).

A crash while private browsing is in use cannot be reported, and Sval has
nothing to attribute it with. A crash of the parent process then ends Sval
with no crash reporter window and no restart. The decision covers the files
Sval writes: the operating system's own crash log is the system's to keep.
