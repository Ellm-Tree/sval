# 1144. A damaged own file is moved aside

**Status:** Accepted on 2026-10-21. Specified in
2026-10-21-messages-design.md, §8.2.

## Context

This device's own file in the shared folder can be unreadable: a write the
cloud client cut short, or a download it has not finished. Nothing the user
can do repairs it, and the device that wrote it is this one, whose document is
in the profile. A message about it would ask the user to act on something only
Sval can fix.

## Decision

When this device's own file in the shared folder has been unreadable for 10
minutes, Sval renames it to `<name>.damaged-<time>` in the same directory,
the time being the pass's in milliseconds since the epoch. The next pass
writes a fresh file from this device's document. Each set-aside keeps a copy
of its own: nothing is ever replaced or deleted, so a later set-aside cannot
destroy an earlier copy. The user is told nothing.

A file that a newer build wrote (`schemaTooNew`) is never moved. That device
is told to update.

## Consequences

- The ten minutes cover a cloud client still downloading the file. Time the
  folder spends out of reach does not count.
- A copy's name does not end in `.json`, so no device reads it as a device's
  file.
- A device's file in the folder is replaced by its profile copy, which holds
  everything the file did, so no workspace is lost.
- An unreadable file from another device is not touched. It clears when that
  device next writes.
