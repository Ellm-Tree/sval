# 0118. A join publishes through a candidate and swaps the profile once the key is stored

**Status:** Accepted on 2026-10-17.

## Context

Re-keying the profile's one engine in place to join another device's key
fails. Its document is replaced by the tree it remembered, merged and
published under the new key, and put back by hand if the join fails. While
that runs, the engine's document is not this profile's, so every reader of it
has to check a flag first: a redraw that does not would close every tab in
every window. Changes are held until the join settles, the unload handler is
rewritten at each stage, and a publish whose key does not save leaves the
session on an unsaved key with a retry clock behind it.

## Decision

A join merges and publishes through a separate candidate engine, a worker of
its own for this device that never touches the profile. The profile's engine
stays on its own key and takes every change throughout. Once the folder holds
this device's tree (0043) and the key is stored, the profile's engine moves
onto the key in one step, keeping its document, and its next pass merges the
new directory through the engine's own merge. Abandoning a join is dropping
the candidate. A key that does not save leaves the profile on its own key, and
the user is told the workspaces reached the other device and to try the same
code again; there is no retry clock. The join runs outside any window.

Merging the live document into the candidate fails: the candidate's own
write records this device's watermark after the user's changes, so the
merge reads a tab opened before that write as deleted.

## Consequences

Nothing that reads the profile's engine needs to know a join is in flight, and
quitting does not wait for one. A join costs a second worker and engine
instance for its length: measured at about 17 MiB resident and two seconds
for a thousand-tab tree, published through the helper. The key's store and
the swap are one step among the key's writes, so reading the stored key and
applying it elsewhere cannot land between them, and starting over records the
old key's directories for removal only in that step. After a key that did not
save, the other device holds this device's workspaces as they were published,
and this device's later changes reach it only once the join is tried again.
