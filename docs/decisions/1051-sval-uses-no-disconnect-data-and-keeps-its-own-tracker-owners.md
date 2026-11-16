# 1051. Sval uses no Disconnect data, and keeps its own map of trackers' owners

**Status:** Accepted on 2026-10-26.

## Context

Firefox's tracker protection runs on Disconnect's lists, which Mozilla
republishes in its `content-classifier-lists` and `tracking-protection-lists`
Remote Settings collections: the tracker, social, fingerprinter, cryptominer,
email, consent-manager and anti-fraud categories, and Disconnect's entity list
of which company owns which domains. Disconnect licenses them CC BY-NC-SA 4.0
(Mozilla's `shavar-prod-lists` LICENSE), and Sval is a commercial product. The
other maintained datasets that know trackers' owners, DuckDuckGo's Tracker
Radar and Ghostery's TrackerDB, carry the same NonCommercial license.

Sval's own lists (decision 0102) block trackers: EasyPrivacy, uBlock
filters – Privacy and AdGuard Tracking Protection. What they lack is the
owners: they cannot tell Google Analytics on a stranger's site from Google
Analytics on youtube.com. Firefox uses the owners when it tags a request as a
tracker, which its cookie rules read.

Two maintained datasets of owners permit commercial use: Privacy Badger's
`multiDomainFirstParties.js` (EFF, GPL-3.0-or-later), groups of domains that
one company owns, and AdGuard's companiesdb (CC BY-SA 4.0), which maps
tracker and property domains to their companies. companiesdb began from
WhoTracks.me, whose content is CC BY 4.0, and is maintained independently.

## Decision

- **Sval fetches and runs none of Disconnect's data.** Its Remote Settings
  allowlist drops `content-classifier-lists`, and the URL classifier's
  tracking, entity, social, fingerprinting, cryptomining, email,
  consent-manager and anti-fraud tables are empty, so none is requested.
  `tracking-protection-lists` stays allowed for one table: Mozilla's harmful
  add-on blocklist, MPL 2.0 in `shavar-prod-lists`, which the URL classifier
  runs. Each table there is downloaded only when a feature asks for it.
- **Two blocking engines, by Sval's list categories.** The content
  classifier's `trackers` feature runs the active lists whose catalog
  category is `trackers`; its `ads` feature runs every other active list.
  Both also run the active `fixes` lists, so an unbreak rule reaches whatever
  it unbreaks. Each feature takes its list ids from a pref, as `ads` does. The protection panel counts each engine's blocks apart.
- **The tracker tag comes from Sval's tracker lists and its own owners map.**
  The `trackers-content` feature annotates, without blocking, with the
  tracker lists, the fixes and `sval-tracker-owners`: exception rules that
  stop a company's domain being tagged on that company's own sites. Blocking
  keeps no such exception, so a tracker the lists name is blocked everywhere,
  its owner's sites included.
- **The owners map is built from Privacy Badger's groups, AdGuard's
  companiesdb and Sval's own additions**, each kept apart under its own
  license and read as its source gives it. companiesdb ships in Sval
  (`tracker-owners/`), refreshed by `scripts/update-tracker-owners.py` and
  reviewed like any change, and about:license credits it with its license.
  Sval's own additions are compiled from primary sources (a company's
  published domain lists, certificate transparency, RDAP), each with the
  source it came from, and never copied from a NonCommercial dataset.
- **Privacy Badger's groups are fetched at runtime and never ship.** They are
  GPL-3.0-or-later, EFF's work, and Sval's app store permission (0119) covers
  only Sval's own code, so a copy in the package would convey them on terms
  their license forbids. Sval downloads the current
  `multiDomainFirstParties.js` from EFF's repository, unpinned, because the
  latest groups are the point: the filter lists are fetched the same way
  (decision 0102). It is fetched on the lists' schedule while the tracker tag
  runs, and only while list updates are on, which test profiles turn off.
  The file is JavaScript and is read as data, never run: a strict reader
  takes its one array of host strings and refuses anything else, and a
  refused or oversized download keeps the last good copy in the profile.
  Until the first download, the map is companiesdb and Sval's additions
  alone. Hosts that hold shared hosting are dropped from the downloaded
  groups by a list taken from the Public Suffix List (MPL 2.0), since
  `Services.eTLD` names a public suffix but not the hosts above one.

## Consequences

- At the Off level there are no lists, so nothing is tagged as a tracker; Total
  Cookie Protection still partitions every third party's storage.
- Mozilla's `major-exceptions` and `minor-exceptions`, written to unbreak
  Disconnect's lists, are not run. uBlock Origin's and Brave's unbreak lists do
  that job for Sval's.
- The pref-driven features are a patch to Gecko's content classifier, an input
  of the Gecko key.
- Changing which datasets feed the owners map is a change to this decision,
  checked against its license first.
