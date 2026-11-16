# 0107. Taking control takes the agent's whole workspace

**Status:** Accepted on 2026-10-16.

## Context

The overlay covers the whole window whenever the agent controls the selected
tab, so to the user the agent controls the workspace, and taking control reads
as taking the workspace.

Per-tab control fails. A tab the user opens while holding another is the
agent's, under the overlay, so "take control, open a tab, sign in, hand back"
puts the window back under the agent. The agent's own `open_tab` selects its
new tab and brings the overlay back over the tab the user is using.

## Decision

Take control takes the agent's whole workspace. Until the user presses Give
back, every tab in it, including tabs either party opens later, is the
user's: every tool that acts in the workspace, `open_tab` and `close_tab`
included, fails with `user_in_control`, saying the user has control and the
agent cannot act until they give it back. Only the user's Give back returns
control; no tool reclaims it.

`list_tabs` keeps working. It lists every tab with no title or address and
`user_in_control: true`, so the agent can tell why it is refused and poll for
the give-back without seeing what the user browses.

The take is kept by the workspace's node id in the device's local settings,
so a discard, a crash or a restart finds the workspace still the user's.

The overlay and bar say so: "<agent> is controlling this Workspace", "Take
control of Workspace", "You control this Workspace.", "Give Workspace back to
<agent>".

## Consequences

- The user can open tabs, sign in and browse in the agent's workspace, then
  hand it back once.
- The agent cannot work in one tab while the user works in another. Per-tab
  control can come back as an option if users want it.
- A copy of one of the user's tabs that lands in the agent's workspace, or a
  tab restored there from outside it, makes the user take the workspace, so
  the user's history and form data are never the agent's unseen.
