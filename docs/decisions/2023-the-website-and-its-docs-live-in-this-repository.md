# 2023. The website and its docs live in this repository

**Status:** Accepted on 2026-11-05.

## Context

Sval needs documentation a customer reads, detailed enough to show what each
feature does, and a marketing website beside it. Features change quickly, so
the docs stay correct only if the change to a feature and the change to its
docs travel together. `docs/features.md` is a reference list for Sval's
developers. It holds no step-by-step guides and no explanation of how Sval
keeps what it keeps.

This repository is published under AGPL-3.0 (0111). AGPL is a software
license: applied to prose, it puts copyleft terms on anyone who quotes or
adapts a page. Everything committed here becomes public when the repository
is.

## Decision

- **One Astro project in `website/` holds the marketing pages and the docs.**
  The docs are a Starlight site served under `/docs` on the same host as the
  marketing pages, so both share one design system and one deploy. Astro takes
  plain HTML and React. Mintlify is rejected because
  it is hosted and closed source; Docusaurus and Fumadocs are rejected because
  they need React for every page, and Fumadocs needs Next.js as well.
- **The docs follow Diátaxis.** Each page is one of four kinds: a tutorial
  that teaches by doing, a how-to guide that finishes one task, a reference
  that describes what a setting does, or an explanation of why Sval works as
  it does. A page never mixes kinds. `docs/writing-style.md` holds the page
  template and the rules for steps.
- **A change to a user-facing feature updates its docs page in the same pull
  request.** The docs page is the user documentation, so it can never trail
  the build it describes.
- **The docs never name a control the build does not.**
  `scripts/check-ui-labels.py`, which `lint.sh` runs, fails when a step's
  bold control name or a part of a Settings path appears in none of Sval's or
  Firefox's UI strings, so a change that renames a control fails until its
  docs page follows. A check is used because Sval writes most of its labels
  in its JS and HTML, so there is no single strings file to take them from.
- **Screenshots are generated from a Sval build on a seeded profile, and a
  person approves each changed image** before it publishes. A capture can be
  fresh and still wrong, showing test data or an unfinished feature.
- **The site makes no third-party requests and runs no analytics,** in line
  with Sval's own no-telemetry rule. Search is Pagefind, Starlight's default,
  whose index is a static file served with the site.
- **Licenses are set per folder in `REUSE.toml`.** The docs' text and the
  release notes are CC-BY-SA-4.0, so anyone may share or adapt them, a
  business included, with credit and under the same license. Ellm Tree can
  use contributors' docs text the same way. The rest of the site, its code
  included, is the company's marketing site and is licensed to nobody
  (`LicenseRef-sval-website`). Logos, brand art and marketing art stay
  reserved, as under `branding/`.
- **The published source holds the docs and none of the rest of the site.**
  People may improve the docs. Nobody else edits the marketing site.

## Consequences

- `docs/features.md` and the docs site describe the same features, so one of
  them is redundant once the site covers every feature.
- A website change runs this repository's CI.
- If Sval's Help menu links to the site, its host goes on
  `scripts/network-contact/allowed-hosts.txt` and in the spec (§10.9).
