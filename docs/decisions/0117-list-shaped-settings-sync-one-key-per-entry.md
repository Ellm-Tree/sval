# 0117. List-shaped settings sync one key per entry

**Status:** Accepted on 2026-10-17.

## Context

The settings-sync spec gives each setting one node, so each has its own stamp
and writer (§2). A setting that is a list or a map breaks that if it is one
JSON pref synced as one value: each site's protection choices, each site's
JavaScript rule, Custom's lists, the lists the user added and the allowed
domains.

One value for many entries means one stamp for all of them. Two devices that
change different sites between passes keep only one change, and a site
removed on one device comes back from another's whole copy.

## Decision

Each entry of a list-shaped setting is a pref of its own under a branch, named
by the entry: `browser.sval.protection.site.<site>`,
`browser.sval.javascript.site.<site>`, `browser.sval.adblock.customList.<id>`,
`browser.sval.adblock.userList.<id>` and
`browser.sval.adblock.allowedDomain.<domain>`. The registry lists these
branches (`SvalSettingsRegistry.SYNCED_BRANCHES`), and settings sync carries
every pref under a listed branch as its own setting, keyed by the pref's name.
A removed entry is a cleared pref, so it syncs as a reset and stands.

A branch is seeded once, by its name, as decision 0113 seeds a pref: every
entry it holds that the document lacks is seeded together, and from then on
the observer writes each change, an entry added later included.

A synced branch pref's name carries a site, so it is logged by its branch.

The engine does not change.

## Consequences

- Entries changed on different devices between passes all hold everywhere,
  and a removal reaches every device.
- A new list-shaped setting is a branch added to `SYNCED_BRANCHES`, not a JSON
  pref in `SYNCED_PREFS`.
