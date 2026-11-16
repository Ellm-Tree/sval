# 0111. Sval is AGPL-3.0-only, in one public repository

**Status:** Accepted on 2026-10-17.

## Context

Sval takes a strong public stance on privacy, and a privacy product whose
source is closed or merely source-available is distrusted. A noncommercial
license such as PolyForm Noncommercial fails because it is not open source,
and a closed sync engine beside an open browser would be the first thing a
critic found.

An open-source license cannot forbid commercial use. What it can do is stop
anyone building a closed product on Sval's code:

- MPL 2.0 and LGPL-3.0 are copyleft per file or per library, so a closed
  browser or app can wrap sval-core and ship.
- GPL-3.0 makes everything distributed with Sval's code GPL, but running it as
  a service is not distributing it, so a hosted sync service built on sval-core
  could stay closed.
- AGPL-3.0 adds that running modified code as a network service obliges its
  source. Sval itself runs no servers (0005), so the clause costs the browser
  nothing.

Keeping the engine and the design in a repository of their own costs two pull
requests for work that spans both, an engine pin and its Renovate pull
requests, and a stub engine for clones that cannot read the engine's
repository.

## Decision

- **Every file Sval wrote is AGPL-3.0-only**, owned by Ellm Tree, Inc. Mozilla's
  files and Sval's modifications of them keep MPL 2.0, which names AGPL-3.0 as
  a Secondary License (§1.12, §3.3), so they combine in one browser.
- **-only.** A later version the FSF publishes does not apply. Moving to one
  needs every contributor's consent (0119).
- **One public repository.** `sval` holds the browser, the engine crate in
  `engine/`, and its design documents and decisions in `docs/`.
- **Contributions** come in as decision 0119 sets out.
- **The brand art stays reserved** (`branding/sval/LICENSE`), and the name is
  protected by trademark. A fork must rename and replace the art.

## Consequences

- Sval is open source under an OSI-approved license. Nobody can ship a closed
  product, or run a closed service, on Sval's code.
- Apple's App Store terms are incompatible with the GPL family, so Sval's own
  files carry an additional permission for app stores (0119). A fork may use
  it too.
- GPL-3.0 code, such as uBlock Origin's and AdGuard's, may enter Sval (GPL-3.0
  §13), though not anything shipped through an app store, because it carries
  no such exception (0119).
- Work that spans the engine and the browser is one change, tested by one CI
  run (0003).
