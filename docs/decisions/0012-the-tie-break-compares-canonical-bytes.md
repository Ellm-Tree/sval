# 0012. The tie-break compares canonical bytes

**Status:** Accepted on 2026-10-07.

## Context

On an equal timestamp a group needs a deterministic winner on every device and
every build. Raw struct serialisation order differs between a build that
knows a field and one that keeps it in `extra`, and serde_json's text can
change between its releases, as its float printing has (`1e16` and `1e+16`).

## Decision

The tie-break compares the group's canonical encoding (`write_canonical`):
keys in byte order, minimal escaping, integers in decimal, floats as `f` plus
their IEEE bits in hex. Never the node id (engine/CLAUDE.md rule 9).

## Consequences

An older and a newer build pick the same winner on the same tie, whatever the
JSON library does to its output.
