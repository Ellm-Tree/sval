# 0124. An answer covers one action, or the site for good

**Status:** Accepted on 2026-10-18.

## Context

The write alert of
[0073](0073-agent-tools-site-policy-and-the-write-gate.md) asks the user about
an agent's writes. An alert that offers several lifetimes for an answer, such
as until the tab leaves the page, until the agent disconnects, or always,
leaves the user unable to tell from the button what their click covers. The
user also needs a way to refuse a site for good from the alert.

## Decision

- **Allow and Deny answer for the action in front of the user**: the writes
  the alert lists. The next write, from the same page or the next click, is
  asked about again.
- **"Always allow writes on <site>"** sets the site to Full access, and
  **"Always deny writes on <site>"** sets it to Read only, in the agent's
  policy. Only Settings undoes either.
- No answer is scoped to a page, a task, a connection or a session.
- A site the user blocked while the alert was up stays Blocked: Always deny
  never loosens it.

## Consequences

- A page that writes repeatedly, such as an autosave, raises an alert per
  write until the user chooses Always allow or Always deny.
- A write the page sends while an alert is up is asked about in an alert of
  its own once that one is answered.
