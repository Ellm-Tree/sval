# 1997. A new window lands on its workspace's last tab

**Status:** Accepted on 2026-11-05.

## Context

Firefox opens every new window on a startup tab, which shows the home page
under Sval's `browser.startup.page`. A window then takes a workspace: the one
the switcher's "Open in new window" hands it, the next one down for ⌘N, or
the first no window shows. Every tab showing something is filed in its
workspace ([0085](0085-every-screen-in-the-viewport-is-a-filed-tab.md)), so a
startup tab left open becomes a "New tab" row in that workspace, kept and
restored on every launch.

## Decision

- **A window opened on a workspace that has tabs lands on the tab this device
  last looked at there**, as a switch to the workspace does, and its startup
  tab closes. However the window was opened, it adds no row.
- **Only a workspace with no tabs opens on the startup tab**, which is filed
  as that workspace's tab. A new, nameless workspace, as ⌘N makes when every
  workspace is open, is one.
- A window opened on a page of its own, such as a link from another app,
  keeps that page.

## Consequences

Opening a window never changes the tree when the workspace has tabs. A person
who wants a new tab in the window opens one. Each window restores its
workspace's tabs as lazy tabs, and loads only the one it shows.
