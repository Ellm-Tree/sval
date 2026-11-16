# 1549. History syncs what Firefox's history engine syncs

**Status:** Accepted on 2026-10-29. Specified in
2026-10-16-history-sync-design.md, §2.

## Context

Places stores a visit each time a page that redirects to itself loads again
(the hidden-visit exception in `History::VisitURI`), so a captive portal doing that every few
milliseconds puts tens of thousands of visits into one week. Every sync pass
reads, decrypts and merges each loaded week, so one such week slows every
pass, including the one a new window waits on before it draws.

Firefox's history engine bounds this. It sends a page with its 20 newest
visits (`PlacesSyncUtils.history.fetchVisitsForURL`), leaves out hidden
pages, framed-link visits and downloads (`IGNORED_TRANSITIONS_AS_SQL_LIST`),
inserts an incoming visit only where Places holds no visit at that time with
that transition and, once a page has 20 visits, none older than those
(`HistoryStore`), and first uploads the 5,000 pages with the highest
frecency visited in the last 30 days (`HistoryStore.getAllIDs`).

## Decision

- Sval syncs history by Firefox's history engine's rules.
- Each device keeps its newest 20 visits to a page in each week's document.
  A new visit past that removes the device's oldest one there, and a week
  that loads holding more is trimmed to the newest.
- Hidden pages, framed-link visits and downloads stay on their device.
- An incoming visit is inserted by Firefox's rule.
- The seed writes what Firefox first uploads, with each page's newest 20
  visits.

## Consequences

- Places keeps every visit made on its own device. Another device sees at
  most 20 of them for a page in a week.
- A trimmed visit reaches the other devices as a deletion, and they remove it
  from Places.
- A page visited across many weeks syncs up to 20 visits for each week. The
  limit is per week because one device's visits to a page then live in one
  document.
- A device seeded on first publication shares its last 30 days. Older
  history stays on that device.
