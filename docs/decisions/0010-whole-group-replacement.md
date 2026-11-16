# 0010. Whole-group replacement

**Status:** Accepted on 2026-10-07.

## Context

A fact group could be merged field by field.

## Decision

The group is the unit of merge. The newer group replaces the older one whole.

## Consequences

Merging field by field would reinstate the per-field bookkeeping the model was
simplified to remove. A mutator that changes one field writes the whole group,
which is why the engine has `setContent`.
