# 2210. A tab's name is a label in the appearance group

**Status:** Accepted on 2026-11-10. Specified in
`2026-09-24-sval-browser-design.md`, §5.1.

## Context

A tab's `content.name` follows its page's title: the host writes the title
there on every navigation, so a restart and another device show the page the
tab is on. A name the user gives a tab has to survive those writes. Zen keeps
a renamed tab's name in a field of its own, shown in place of every title the
page sets, and an empty name gives the title back.

## Decision

- **A tab's user name is `appearance.label`, shown in place of
  `content.name`.** `content.name` keeps following the page, so taking the
  label away shows the title the page has now, on any device, loaded or not.
  A flag in `content` saying "renamed" is rejected: the title it froze would
  be gone, and the tab would have nothing to show once the name was cleared.
- **The label is in the appearance group.** A navigation rewrites the whole
  content group, so a label in `content` would lose to a navigation on
  another device that had not yet seen it. In appearance, renaming and
  navigating are unrelated acts that never compete, as renaming and
  recolouring are.
- **Only a tab carries a label.** A workspace's, group's or split's name is
  the user's own and stays `content.name`.
- **An empty rename clears the label**, as an empty Rename Split clears a
  split's name. The tab menu's Remove Name and the Launcher's Remove this
  tab's name clear it too, because an empty answer is hard to find.

## Consequences

`setLabel` writes the label and keeps the colour and emoji, and
`setAppearance` keeps the label. Every place that shows a tab's name reads
the label first.
