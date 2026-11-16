# Decisions

Each record is one settled decision with its reason. The reasons are the point:
they stop a settled decision being relitigated. Cite a record by number.

A new record takes the number of the issue it settles, so two pull
requests never reach for the same number. A decision with no issue gets one
opened first. When one issue settles more than one decision, the second record
adds a letter: `1052b`. The records numbered 0001 to 0137 keep their numbers.

This directory has no index to keep: the filenames are the list, and
`ls docs/decisions` reads it.

## A record says what is true now

- **A changed decision is edited in place.** A decision that no longer holds is
  deleted, and its citations are repointed. No record exists to undo or
  narrow another, and no record carries an "Amended" section. Git keeps what a
  record said before.
- **The reasons are present tense.** A rejected alternative stays when its
  rejection stops it coming back, written as why it fails ("Per-tab control
  is rejected: …"), never as the story of trying it.
- **A record holds no history, plans or progress:** no issue or pull request
  numbers, no "was", "once" or "no longer", no migration or older-build
  behaviour, and no note of what is built yet.
- **A record and a spec do different jobs.** The record holds the decision and
  its reason. The spec holds the mechanism and cites the record by number
  rather than restating it.

## Format

Each record has a title, a Status line, then Context, Decision and
Consequences. The Status line is `**Status:** Accepted on <YYYY-MM-DD>.`,
optionally followed by `Specified in <spec file>, §<n>.`

`scripts/check-decisions.py` checks the format, the history words, issue
numbers, and that every decision a tracked file cites exists. CI's `checks`
job and `scripts/lint.sh` run it.
