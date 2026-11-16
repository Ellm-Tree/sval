# 0108. Favorites sync as a third document, and Places holds none

**Status:** Accepted on 2026-10-16. Specified in
2026-10-21-favorites-native-design.md, §16.

## Context

Design spec §5.6 has bookmarks reuse the workspace tree's structure and merge.
Pins on the home page (`2026-10-16-home-favorites-design.md`) follow the user
to every device, and a pin cannot sync without its favorite.

## Decision

- Favorites are a third engine document, `favorites`, on the same pass and
  key as workspaces and settings, with `favorite`, `folder` and `separator`
  kinds and the three Places roots as fixed nodes.
- A favorite's id is a UUIDv5 of a guid Sval mints, which the node carries.
- A favorite added to a folder another device deleted is kept, at the top
  of Favorites, the root Sval shows (0123). New content never revives a
  deleted folder (0106).
- Icons do not sync; each device keeps its favorites' icons locally.

## Consequences

- A new device's favorites show without icons until each site is visited.
- Firefox's bookmark features read an empty store; the address bar, star and
  menu read the document through Sval's code.
