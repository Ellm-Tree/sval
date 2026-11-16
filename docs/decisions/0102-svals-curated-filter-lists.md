# 0102. Sval's curated filter lists

**Status:** Accepted on 2026-10-14.

## Context

Sval's blocking runs on Gecko's adblock-rust engine with lists Sval downloads
from each publisher (protections spec §1). A survey on 2026-10-14 compared
the lists in use: their
licenses (read from each source), maintenance, syntax support in adblock-rust,
reputation, and which lists uBlock Origin and Brave enable by default.

Findings that shape the choice:

- uBlock Origin's lists plus EasyList and EasyPrivacy are the consensus
  baseline: uBlock Origin's default set, and Brave's core. uBlock filters is
  written to be used with EasyList.
- Licenses: EasyList, EasyPrivacy and the EasyList regional lists are dual
  GPLv3 / CC BY-SA 3.0 with attribution to "The EasyList authors"; uBlock
  Origin's, AdGuard's, HaGeZi's and OISD's lists are GPL-3.0; Fanboy's are
  CC BY 3.0; curben's are CC0 / MIT; Brave's are MPL-2.0. Dan Pollock's hosts,
  Disconnect and DuckDuckGo's lists are non-commercial, Steven Black's hosts
  bundles non-commercial sources, and Peter Lowe's list has no license.
- adblock-rust does not resolve `!#include`, so uBlock Origin's lists are
  fetched as their built files. It drops some options (`$popup`, `$replace`,
  regex rules, AdGuard-only syntax) without failing the list.
- No publisher sets a rate limit, but EasyList's servers were overloaded in
  2020 by a browser fetching on every start.

## Decision

- **Balanced:** uBlock filters, uBlock Badware risks, uBlock Privacy, uBlock
  Unbreak, uBlock Quick fixes, EasyList, EasyPrivacy, curben's Malicious URL
  list, Brave's unbreak list, and the regional list for the browser's
  language, chosen the way uBlock Origin maps languages to lists.
- **Strict:** Balanced, plus HaGeZi Pro mini, curben's Phishing list, uBlock
  Annoyances (others) and Fanboy Social. It also turns on Firefox's query
  stripping ([0104](0104-sval-supports-only-the-filter-syntax-adblock-rust-applies-and-strict-strips-query-parameters-with-firefoxs-own-list.md)). Strict also
  carries the cookie banner lists (EasyList Cookie, uBlock Cookie Notices),
  which page rules apply by hiding elements.
- **Custom** offers, in addition: the other AdGuard lists (Base without
  EasyList, Tracking Protection, Annoyances, Cookie), HaGeZi's other tiers,
  OISD, Fanboy Annoyance and the other regional lists. A user may add any list
  by address, including ones Sval does not curate.
- **No curated list carries non-commercial terms or lacks a license.**
- **Sval downloads lists at runtime and never bundles a copy.** It caches each
  list, honours its `Expires` header, sends conditional requests, never
  fetches on start without checking the cache, and spreads its fetches.
- Attribution for each list is shown where the list appears in settings.

## Consequences

- Sval's Balanced level blocks what uBlock Origin's defaults block, so pages
  break no more than they do for uBlock Origin users.
- Each list's host is a named host (decision 0060).
- Changing the curated sets is a new decision.
