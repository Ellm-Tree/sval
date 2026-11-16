# 0014. Absence is judged per node and fact group, against the group writer's watermark

**Status:** Accepted on 2026-10-07.

## Context

After a merge, a node present on one side only is either news to the other
side or a deletion it already made. A file-level version vector is
insufficient: in one peer file, a node we deleted and a
node we have never seen are both "present there, absent here", and one file
carries one verdict (spec §5.4 scenario 3). A rule with no mirror clause
cannot delete anything at all (scenario 1).

## Decision

Each file records `written_at`, `written_by` and a `seen` map; each fact group
records its writer. A node present on one side only is adopted when it is news
to the side that lacks it, and dropped when that side had already incorporated
a state newer than the group's own change. Both halves evaluate the same
predicate about the lacking side's knowledge of the holding side (engine/CLAUDE.md
rule 13).

## Consequences

The symmetry is the convergence guarantee. An asymmetric refinement breaks
convergence, because one device then adopts what the other drops, forever. Do not simplify this to a per-file verdict.
