# 0037. "Last synced" means the shared folder

**Status:** Accepted on 2026-10-07.

## Context

The profile write happens on every edit and says nothing about whether any
other device has the change.

## Decision

"Last synced" is the time of the last successful exchange with the shared
folder. It is the tooltip of the footer's sync indicator, and a label only
while the folder is unreachable. With no folder chosen the footer row is
absent.

## Consequences

The time tells the user what they care about: whether their other devices
can see this one's changes.
