# 0001. Firefox ESR, not rapid release

**Status:** Accepted on 2026-10-07.

## Context

Sval's patches are mostly to Firefox's front end, and the front end is where
Mozilla's UI churn lands. Sval also changes Gecko's native code when a feature
needs it ([0097](0097-sval-changes-geckos-native-code-when-a-feature-needs-it.md)). Every Firefox release is a rebase.

## Decision

Sval forks Firefox ESR. The pinned upstream commit is in `upstream.txt`.

## Consequences

One deliberate rebase a year instead of thirteen. Sval ships security fixes on
ESR's point-release cadence and gets new web-platform features a year late.
