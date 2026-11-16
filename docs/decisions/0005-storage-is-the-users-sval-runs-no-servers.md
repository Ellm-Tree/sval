# 0005. Storage is the user's; Sval runs no servers

**Status:** Accepted on 2026-10-07.

## Context

A sync service means accounts, servers and a party holding users' browsing
state. Users already have storage that syncs: iCloud, OneDrive, Drive, SMB, a
plain folder.

## Decision

Sval syncs through storage the user chooses. v1 ships only the local-folder
provider. Cloud APIs come later, because each needs OAuth registration and
scope review.

## Consequences

The channel is slow, eventually consistent and offline-prone (spec §6.4), and
every sync design choice follows from that. No account, no server, nothing for Sval to breach. No design routes user data or
secrets through a sval-run host, or makes them depend on one, and that includes
a static page that only reads a URL fragment: the visit and the page's script
still make the claim depend on a server never being compromised
([0089](0089-the-sync-key-reaches-a-password-manager-as-a-secure-note.md)).
The one host Sval runs, `feedback.sval.app`, receives only the reports a user
chooses to send, and holds no synced or browsing state
([1199](1199-sval-s-one-server-receives-only-the-reports-a-user-sends.md)).
