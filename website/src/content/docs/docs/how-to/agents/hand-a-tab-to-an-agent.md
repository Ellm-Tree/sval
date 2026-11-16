---
title: Hand a tab to an agent
description: Move one of your tabs into an agent's Workspace so the agent can read it and act in it.
---

An agent sees only the tabs in its own Workspace. To give the agent a page
you already have open, move the tab into the agent's Workspace.

You've found a Codeberg issue you want Claude Code to work on. You'd rather
hand Claude Code the tab than paste the address.

## Steps

1. In the Workspace, right-click the tab, then choose **Move to Workspace**.
2. Under **Agent Workspaces**, choose the agent.
3. In the dialog, select **Hand Over**.

The tab moves to the agent's Workspace, and the agent can read it and act
in it.

## Details

- The dialog says whether the agent gets your sign-ins with the tab. In a
  shared Workspace, the tab keeps your sign-ins. In an isolated Workspace,
  the tab reloads signed out, so the agent can't use your sign-ins.
- The agent can't go back to the pages you visited earlier in the tab. When
  the tab has earlier pages, the dialog offers **Include the pages you
  visited earlier in this tab**. The box stays unchecked unless you check
  it.
- You can hand over a group, or several selected tabs, the same way. Sval
  asks once for all of them.
- Once the agent has the tab, the tab follows the agent's rules for sites.

## Related pages

- [Take control of an agent's Workspace](/docs/how-to/agents/take-control-of-an-agents-workspace/)
- [Move a tab to another Workspace](/docs/how-to/workspaces/move-a-tab-to-another-workspace/)
- [Agent settings and controls](/docs/reference/agents/)
