# 0018. The write decision compares shared state only, and a watermark may be published late

**Status:** Accepted on 2026-10-07.

## Context

`seen` is part of the document, and merging a peer raises it. A comparison over
the whole document differs on every poll, so two idle devices would write on
every poll forever, each write advancing the other's `seen`.

## Decision

`sync` writes only when `Document::shared_state_json` differs: nodes and
document-level `extra`, with `written_at`, `written_by` and `seen` excluded.
`written_at` is stamped only when a write happens.

## Consequences

Watermark advances ride along with the next write that has a real reason.
This is safe because watermarks only rise: a published vector is never ahead
of what a device has incorporated, and a lower watermark makes a peer keep a
node rather than drop it. A deletion reaches a peer at the deleting device's
next real write instead of immediately: a delay, never a wrong drop. Two idle
devices write nothing.
