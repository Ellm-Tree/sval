# 2232. A copy that begins under a used id takes back its earlier writes

**Status:** Accepted on 2026-11-11. Specified in
`2026-09-24-sval-browser-design.md`, §5.4.

## Context

A device's watermark for its own id, `seen[me]`, says its copy holds every
write that id has made, or deleted it. A copy that begins empty under an id
that has written before holds none of those writes, and its first write
still stamps `seen[me]` over all of them. Each node the id made then reads as
deleted on this device and, from its next write, on every peer. A host that
loses the copy and keeps the id causes this: an app that keeps its id in the
iOS Keychain and its copy in its container, a profile whose `sval/` folder
is deleted, or a profile restored only in part. The host contract says an
id lives as long as its copy, and the engine is the one place that can hold
every host to it.

## Decision

- **The engine detects the case and keeps the data.** A copy records
  `began_at` when a pass finds no file of its own and the copy has never
  written. A file whose watermark for the copy's id is below `began_at`
  shows writes the copy never held, and merging it treats that id's stamps
  before `began_at` as news. The copy takes them, and its next write carries
  them to every peer. No host has to do anything, and nothing is held back.
- **`earlier_to` records how much was taken:** the highest such watermark. A
  file no newer than it is merged as any other. A peer that has not written
  since keeps presenting the earlier writes, and without `earlier_to` a
  deletion of one of them would be undone by that peer's file at every pass.
- **Refusing to write, and making the host take a new id, is rejected.** The
  pass that begins the copy reads only the copy's own storage and cannot see
  the folder, so it cannot tell a used id from a new one. A host told to take
  a new id afterwards would have to move the copy's own stamps to that id, and
  on the desktop a device id also names its key files. The data is safe either
  way. This way needs no host change.
- **The two fields are the copy's own bookkeeping.** They are kept in the
  copy's file so a restart keeps them, stay out of the write decision, and are
  ignored by `merge`. Neither is written to the shared folder: when a copy
  began is a fact about that copy.

## Consequences

A copy begun again under a used id brings back what that id made. A file
that shows earlier writes the copy has not yet taken can bring back a node
the copy deleted, which is the direction §5.4 already accepts: keeping a node
some device discarded costs a delete, and the other way loses data. Hosts
still take a new id whenever their copy starts empty (host contract §5); the
engine covers the host that does not.
