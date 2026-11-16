# 0051. A window shows one workspace, chosen per window and per device

**Status:** Accepted on 2026-10-07.

## Context

Two devices sitting in different workspaces is most of the point of
workspaces.

## Decision

A window shows one workspace, with a switcher. Which workspace a window shows
is device-local and per-window (`SessionStore.setCustomWindowValue`).
`_showWorkspace` is the single path that changes it. Switching releases the
outgoing workspace's tabs, re-materialises them lazily, and never reads a
release as a close. A workspace can be torn off into its own window.

## Consequences

Which workspace a new window shows is decided by
[0079](0079-a-workspace-has-at-most-one-window.md).
