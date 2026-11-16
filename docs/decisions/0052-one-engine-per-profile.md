# 0052. One engine per profile

**Status:** Accepted on 2026-10-07.

## Context

Merge skips the absence rule for a device's own file. With one engine per
window, a tab closed in one window would be republished by the other.

## Decision

All windows in a profile share one engine (`SvalEngine.forProfile`). The
settings page reaches Sval through the profile and creates no engine of its
own.

## Consequences

Every window and page acts on one document state.
