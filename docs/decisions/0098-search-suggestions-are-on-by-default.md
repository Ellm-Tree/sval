# 0098. Search suggestions are on by default

**Status:** Accepted on 2026-10-13.

## Context

Searching tells the engine what the user chose to submit, and suggestions
tell it everything they typed. Firefox, Chrome, Safari and Edge all suggest by
default, and Sval matches them.

Every engine Sval ships offers suggestions from its own host, and each was
checked to answer in the OpenSearch format Firefox reads.

## Decision

- **`browser.search.suggest.enabled` defaults to on.** Suggestions go only to
  the engine the user chose, which already receives what they search for.
- **Private windows keep Firefox's default of off**
  (`browser.search.suggest.enabled.private`). The user can turn them on.
- **The home page suggests through the address bar's own providers**
  (`SvalHomeSearchParent`), under the same settings as the address bar.
- Trending searches, partner-engine rows and the pre-connect on focus stay
  off.

## Consequences

- The default engine's suggestion host (`duckduckgo.com`) is contacted in a
  default session as soon as the user types, so it is listed as allowed in
  `scripts/network-contact/allowed-hosts.txt`.
- The setting is Firefox's own, in Settings' Search and Launcher category.
