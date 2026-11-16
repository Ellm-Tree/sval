# 0015. A watermark is evidence only about the device it names

**Status:** Accepted on 2026-10-07.

## Context

Judging a node's absence against the reader's own watermark mixes a per-node
timestamp with a per-file one. A node that reached the reader after its last
write can predate a peer's watermark for that write, so a peer that never saw
it looks authoritative about its deletion. A tab created on an offline device
would be deleted everywhere, with every device agreeing on the loss.

## Decision

A node's absence is judged only against the watermark for the device that
wrote the group in question.

## Consequences

Convergence tests cannot see this class of bug, because every device agrees.
The property test asserts that every node created on a device while it was
away survives on all of them.
