# 0039. Launch draws the profile copy, and waits for the folder only when the copy is empty

**Status:** Accepted on 2026-10-20.

## Context

A device whose profile holds no workspace yet, such as a new install pointed
at a folder other devices already use, must not launch empty. Two devices
that each create a first workspace without knowing of the other's end up
with two.

## Decision

When the profile copy holds workspaces, Sval draws them at once and syncs with
the folder in the background. When it holds none, launch waits for the shared
folder's answer, and retries silently while the folder does not answer.

Sval creates the first workspace only when the document holds none, and not
while a shared folder is chosen and has not answered.

## Consequences

A device whose only copy is on the share gets it copied into the profile
before anything is drawn. A user whose share is down still sees what the
profile holds. A user with an empty shared folder that is down gets a slower
first run.
