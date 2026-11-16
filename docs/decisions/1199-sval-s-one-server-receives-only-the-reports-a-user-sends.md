# 1199. Sval's one server receives only the reports a user sends

**Status:** Accepted on 2026-10-22. Specified in
2026-10-22-feedback-design.md, §7.

## Context

A user who hits a problem has no way to tell the developer about it with
enough detail to act on. A report copied to the clipboard leaves the user to
find somewhere to paste it, and crash files sit in `Crash Reports/pending`
until the user deletes them. Decision 0005 says Sval
runs no servers, so any collector is an exception to it.

## Decision

**Sval's one server receives only the reports a user sends.**
`feedback.sval.app` accepts a report the user has read and pressed Send on,
or a crash report the user chose to send, and files it for the developer. It
stores no IP address and no identifier, holds no synced or browsing state,
and Sval never contacts it on its own. Principle 1's promise stands for
everything a user keeps in Sval: nothing of theirs lives on a Sval server, so
there is nothing to breach, sell or shut down. A report is something the user
gave away, and if the collector goes down, Sval loses only the ability to
send one.

## Consequences

- The Send Feedback form posts to `browser.sval.support.reportURL`,
  `https://feedback.sval.app/report`, in every build.
- `--with-crashreporter-url` is `https://feedback.sval.app`, so Gecko's
  crash dialogs post a report the user chose to send to its `/submit`.
- `feedback.sval.app` is listed as `opt-in` in
  `scripts/network-contact/allowed-hosts.txt`: a session in which the user
  sends nothing contacts it never.
- Automatic crash upload stays off (spec §10.6).
