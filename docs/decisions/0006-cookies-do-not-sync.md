# 0006. Cookies do not sync

**Status:** Accepted on 2026-10-07.

## Context

Syncing cookies would carry sessions between devices. Cookies are post-MFA
bearer tokens, and the industry is moving the other way: Chrome's DBSC binds
them to hardware.

## Decision

Sval does not sync cookies. Cookie jars stay local: the profile's default jar,
which shared workspaces use, and each isolated workspace's own jar.

## Consequences

A user signs in once per device.
