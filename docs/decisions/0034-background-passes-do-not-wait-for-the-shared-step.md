# 0034. Background passes do not wait for the shared step

**Status:** Accepted on 2026-10-07.

## Context

`SvalTabs` flushes edits through a queue. Waiting on a shared step there would
stall the queue for up to 20 seconds.

## Decision

A background pass writes the profile and returns. Shared-step results arrive
through `addSharedListener`.

## Consequences

Local saves stay immediate. A caller that needs the folder's answer asks for
it explicitly (`shared: "wait"`).
