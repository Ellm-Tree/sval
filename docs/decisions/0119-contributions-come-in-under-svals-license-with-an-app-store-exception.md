# 0119. Contributions come in under Sval's license, with an app store exception

**Status:** Accepted on 2026-10-17.

## Context

Sval is AGPL-3.0-only (0111), and contributions need terms that let Ellm
Tree, Inc. ship them. Sval's standards are:

1. it ships in Apple's and Google's app stores;
2. it is open source, because that builds trust;
3. its maker can never close new versions of a project others helped build.

A CLA that lets Ellm Tree relicense on any terms fails the third. Its usual
floor, Harmony 1.0's Option Five, keeps each contribution available under the
license it came in under, but new versions could still ship closed, which the
third standard rules out. The Fiduciary License Agreement forbids proprietary
relicensing outright, and with it the App Store. A sunset clause on the KDE
Free Qt Foundation model needs a body to enforce it.

The App Store needs no CLA. Apple's terms conflict with the GPL family's ban on
further restrictions, but a copyright holder may grant an additional
permission (GPL-3.0 §7) that lifts that conflict. Google Play has none.

## Decision

- **No CLA and no DCO.** A contribution comes in under the license of the
  files it touches, and the contributor keeps its copyright. `CONTRIBUTING.md`
  says so.
- **Sval's own files are AGPL-3.0-only with an app store exception**: an
  additional permission under §7 to distribute through an app store whose
  terms add restrictions the license otherwise forbids. Its text is the Sval
  App Store Permission, `LICENSES/AdditionRef-sval-app-store.txt`, and each
  file's notice reads `AGPL-3.0-only WITH AdditionRef-sval-app-store`, the
  prefix SPDX 3.0 gives an addition its list does not hold. Mozilla's files
  keep MPL 2.0, which app stores accept.

## Consequences

- Relicensing Sval needs every contributor's consent, so neither Ellm Tree nor
  a buyer of it can close the project.
- Ellm Tree can sell a proprietary license only for code it owns. A
  contribution enters one only with its author's consent or by being
  rewritten.
- The exception is part of the license, so a fork may use the app stores too.
  The trademark and the reserved brand art (0111) are what keep the name and
  look Sval's.
- Code under another holder's GPL or AGPL, such as uBlock Origin's, carries no
  exception, so it cannot enter anything Sval ships through an app store.
