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

My filters, the user's own filter rules, is such a setting too: text the
user edits as a whole, whose lines are the entries. Remove from this site
writes a line on one device while the user may edit the text on another, and
one value for the whole text keeps only one of the two.

## Decision

Each entry of a list-shaped setting is a pref of its own under a branch, named
by the entry: `browser.sval.protection.site.<site>`,
`browser.sval.javascript.site.<site>`, `browser.sval.adblock.customList.<id>`,
`browser.sval.adblock.userList.<id>`,
`browser.sval.adblock.allowedDomain.<domain>` and
`browser.sval.adblock.myFilter.<key>`, a line of My filters. The registry
lists these branches (`SvalSettingsRegistry.SYNCED_BRANCHES`), and settings
sync carries every pref under a listed branch as its own setting, keyed by
the pref's name.
A removed entry is a cleared pref, so it syncs as a reset and stands.

A branch is seeded once, by its name, as decision 0113 seeds a pref: every
entry it holds that the document lacks is seeded together, and from then on
the observer writes each change, an entry added later included.

A synced branch pref's name carries a site, so it is logged by its branch.

A line of My filters is named by its text and how many lines of the same
text come before it, so devices that add the same line write one entry, and
its value carries an order that places it among the others (settings-sync
spec §4.5). An edit to the text writes only the lines it changes. Keys from
the line's position are rejected: inserting a line would rename every line
after it, and every one would compete with the other device's edits.

The engine does not change.

## Consequences

- Entries changed on different devices between passes all hold everywhere,
  and a removal reaches every device.
- A new list-shaped setting is a branch added to `SYNCED_BRANCHES`, not a JSON
  pref in `SYNCED_PREFS`.
