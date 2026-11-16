# 0113. A synced pref is seeded once, by name, as a change, where the document lacks it

**Status:** Accepted on 2026-10-17.

## Context

A device holds values the user set before a pref synced, and those values must
reach the user's other devices once.

Seeding them at timestamp 0, so they lose to every real change, fails: they
also lose to every watermark. The absence rule adopts a node only when its
writer's watermark on the receiving side is older than the node (spec §5.4),
and no watermark is older than 0. A seed that appears after a peer has read
the seeder's file is read by that peer as a deletion, and the seeder's next
merge drops it.

Seeding once per profile, behind one flag, fails for every pref added to the
synced list later: the profile has seeded already, so the new pref is never
seeded, and its value stays on one device until the user changes it again.

## Decision

Seeding is tracked per key. A key this profile has not seeded is seeded once,
after a pass that has merged what the devices share: a shared step that
reached the folder, or a profile that is the folder.

A seed is the device's current value, written as a change stamped when it is
written, so every device takes it as it takes any change. It is written only
for a key the document holds no node for, and the browser asks that question
inside the engine worker's queue, in the same message as the write, so no
pass can bring a value in between. A value the document already holds,
another device's choice or a reset, is applied instead and never replaced.

A device that shares nowhere seeds nothing. When it later joins a folder, its
first pass that reaches the folder merges what was chosen there before any
seed is written, so joining never overrides a choice made elsewhere (spec §1).

The engine does not change.

## Consequences

- A value set before its pref synced reaches the other devices on the next
  pass.
- A choice made on another device and already in the folder wins over this
  device's earlier value. One made on a device that has not yet published,
  and stamped before the seed, loses to the seed, as any two concurrent
  changes are decided by their stamps.
- A device without a folder publishes its earlier values only once it shares
  one.
