# 0008. No CRDT

**Status:** Accepted on 2026-10-07.

## Context

A CRDT such as Automerge brings a history-bearing binary format, mandatory
compaction and about a megabyte of WASM.

## Decision

No CRDT. Each node carries independently timestamped fact groups, and merge is
a last-writer-wins maximum over each group separately (spec §5.3, engine/CLAUDE.md
rule 1).

## Consequences

File size is bounded by the tree whatever the edit count, and there is no
compaction. The engine ships at about 250 KB gzipped inside `omni.ja`. Do not
reintroduce a history-bearing format.
