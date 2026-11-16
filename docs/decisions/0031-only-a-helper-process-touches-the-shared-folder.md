# 0031. Only a helper process touches the shared folder

**Status:** Accepted on 2026-10-07.

## Context

Firefox runs every `IOUtils` call in a process through one serial queue, so one
read stuck on a hung NFS mount would stall every file operation in the
browser, Firefox's own included. A thread stuck in that read cannot be
interrupted by anything. A separate process can be abandoned. Sval allows no
stuck threads.

## Decision

The helper is `sval-folder`, a program beside the browser binary that the
browser talks to over its stdin and stdout
([1437](1437-the-shared-folder-helper-is-a-native-program.md)). The browser
never calls `IOUtils` on a shared path. A shared step gets 20 seconds, at most
one helper is alive, and the helper is never handed the key.

Pairing reads and writes the shared folder, so it goes through the helper
too. An offer is written only into a folder that already holds `sval/`, and
an offer counts as gone only while `sval/pair/` is there: an unmounted mount
point is an empty directory, from which every offer looks gone. Each pairing
request waits its turn at the helper within its own 20-second deadline
([0033](0033-at-most-one-helper-is-alive-and-a-request-waits-within-its-own-deadline.md)).

## Consequences

A hung share costs a helper process, never the browser. A helper stuck in one
request ends itself after 21 seconds (`HARD_EXIT_MS` in
`tools/sval-folder/src/serve.rs`), and one whose stdin closes exits at once. A
pairing action can wait up to 20 seconds when a helper is stuck.
