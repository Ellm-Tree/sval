# 0026. A node of a kind a newer build added is kept and not drawn

**Status:** Accepted on 2026-10-07.

## Context

A newer build may add node kinds this one does not know.

## Decision

The engine carries an unknown kind through merge and rewrite (engine/CLAUDE.md rule
6). The panel draws no row for it or its subtree.

## Consequences

An older build never deletes what a newer one wrote, and never shows the user
something it cannot operate.
