# 0058. Sval draws its own emoji picker

**Status:** Accepted on 2026-10-07.

## Context

Gecko cannot open the OS emoji picker from chrome code. macOS offers it only
through the native Edit menu, and Windows only through Win+. typed by the user.

## Decision

Sval draws its own picker, as a page in the window's modal dialog
(`gDialogBox`), from Unicode's `emoji-test.txt` via
`scripts/generate-emoji-data.py`.

## Consequences

The picker goes behind other apps with its window, and its data updates with a
script run.
