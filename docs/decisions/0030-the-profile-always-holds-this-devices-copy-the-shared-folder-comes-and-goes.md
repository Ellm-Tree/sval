# 0030. The profile always holds this device's copy; the shared folder comes and goes

**Status:** Accepted on 2026-10-07.

## Context

NFS, SMB, USB and evicted cloud files all disappear without warning. With the
only copy in the shared folder, every change made while the folder is away is
lost, and Sval launches empty.

## Decision

Every pass runs against the profile first and then the shared folder. The
folder is an exchange point. Design:
`docs/superpowers/specs/2026-10-06-local-copy-shared-folder-design.md`.

## Consequences

Launch, edit and quit lose nothing while the folder is away.
