# 1980. A site rule can cover one host

**Status:** Accepted on 2026-11-04.
Specified in `docs/superpowers/specs/2026-11-04-host-scoped-rules-design.md`.

## Context

Sval keys every choice it stores for a site on `siteOf`, the registrable
domain the Public Suffix List gives. That is the unit browsers use for
cookies and storage, and for most sites it is the unit a person means. It
fails where one domain holds unrelated apps: self-hosted services under a
personal domain (`nas.example.com`, `media.example.com`), or
`mail.google.com` beside `docs.google.com`. An element hidden on one app is
hidden on every other, and JavaScript blocked on one is blocked on all.

## Decision

- **Every rule Sval stores for a site has a scope**: the whole site, or one
  host under it. A host rule covers that host and every name under it.
- **The most specific rule wins**, control by control. A host rule for
  JavaScript does not hide the site's rule for video and audio.
- **The scope is chosen where a rule is made**, and on a host under its
  site every surface opens at the host. The narrower scope is the safe
  default: a choice never reaches an app the person was not looking at
  unless they widen it.
- **A host's choices are undone in one place**, its Reset in Settings. A
  control shows what applies at the scope in view and never offers to fall
  back to the site, so it carries no per-row note of where its value comes
  from.
- **A site stays the unit of Settings.** Host rules are listed under their
  site, on the site's row and on the site's page.
- **Cookies and site data stay site-wide**, and so do Clear and Forget this
  site. Browsers send a site's cookies to every host under it and partition
  storage by site, so a host scope there would promise what Sval cannot keep.
- **Firefox's permissions keep their own keying**, per origin, which is
  narrower than a host rule already.

Gecko decides three of these controls by the site alone: JavaScript
(`nsScriptSecurityManager::PolicyAllowsScript` reads only the list that
flips the default), fingerprinting exceptions (`nsRFPService` keys overrides
by the base domain) and extension switches (Sval's own check reads the site
from the partition key). Sval patches each, as hard rule 2 requires.

A host rule picked from a list of every control at once is rejected: a
person makes a rule for the app in front of them, and the place they make it
is where they know which they mean.

## Consequences

- A rule's pref or entry is named by its host or its site, and
  `siteOfEntry` accepts both. Every reader groups host rules under
  `siteOf` of their host.
- The Gecko key moves, so the change runs every suite on every platform.
- Forget this site removes the site's host rules with its own.
