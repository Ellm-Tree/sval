# 0040. The helper reads only regular files, bounded by `maxBytes`

**Status:** Accepted on 2026-10-07.

## Context

Anyone who can write to the shared folder can plant a link, a FIFO or a
device in it, or fill it. Opening a FIFO or a device can block without end,
and a link can point a read outside the folder.

## Decision

The helper reads an entry only when it is a regular file. A link, a
directory, a FIFO or a device is listed as unreadable and never opened. The
file is opened without following a link and without blocking, and its handle
is checked again, so an entry swapped between the look and the open is
refused too. Each file is read up to its listing's `maxBytes`, and each
listing and each step have caps of their own (`tools/sval-folder/src/ops.rs`).

## Consequences

A planted entry costs Sval nothing but an unreadable line in the listing. A
folder holding more than a step's cap is not synced
([0032](0032-the-sync-limits-are-the-owners.md)).
