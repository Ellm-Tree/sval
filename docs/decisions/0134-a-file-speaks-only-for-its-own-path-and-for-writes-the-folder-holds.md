# 0134. A file speaks only for its own path, and for writes the folder holds

**Status:** Accepted on 2026-10-18.

## Context

A sealed file's path is authenticated (decision 0028), but what the file says
about who wrote it and what it has seen is not. Taken as written, a file under
one device's name can say another wrote it, which records its `written_at` as
that device's watermark, or our own id, which spares it the drop half of the
merge. A file whose `seen` claims a write later than any its device has made
deletes every node it lacks, and the max-merge carries the claim to every
device, after which no device's new nodes are news anywhere and each deletes
its own. Only a holder of the key can
write such a file, but a key can leak.

## Decision

`sync` refuses a file whose `written_by` names a device other than the one
its path names, as a damaged file: skipped and reported. A file with no
writer is read (decision 0019).

`sync` reads every peer file before merging any, and drops from each one's
`seen` every watermark later than the newest write of that device's it can
vouch for: the watermark the document already holds, or the `written_at` of
that device's file in the folder.

## Consequences

One planted file can delete nothing and block nothing by claiming writes
that never happened. A key holder can still delete what any device can, by
writing the file a device that had truly seen those writes would.

Knowledge travels transitively (spec §5.4), as soon as the folder
holds the file it is about. A watermark that is ahead only because its
device's newer file has not reached this folder yet is dropped until it
does, which keeps more nodes: the direction of decision 0018, and a delay,
never a wrong drop.
