---
title: What an agent can and can't reach
description: An agent works only in its own Workspace, under rules you set for its app, and why Sval draws the lines where it does.
---

Sval has no built-in AI. An AI
app you already use can browse in Sval for you. Sval decides what the app
can reach, and the app never decides that for itself.

## One approval for the app

You approve an app once. After that, every session of the app can use
Sval. Sval treats each app as one agent, so the site rules you set for the
app apply to all of its sessions. You either allow an app or you don't. If
you had to approve the app again for each folder it runs in, a new session
would only look broken.

The app stays approved until you unpair it. Deleting one of the app's
Workspaces doesn't change that.

## A Workspace for each session

Each session is a separate piece of work, so each session gets a Workspace
of its own, in a separate window. The agent sees and acts only in the tabs of
that Workspace. Your other Workspaces and tabs are out of the agent's
reach. Two sessions never act in the same tabs.

The agent's window opens behind yours and never takes your focus. While the
agent works in that window, your clicks and key presses stay out of it.
That way you can't type into a page by mistake while the agent is using
the page. Your media keys, a game controller, and picture-in-picture stay
yours too.

When the agent finishes a task, Sval asks the agent to close its window.
The agent's Workspace keeps its tabs. The window opens again when the agent
opens a tab or acts in one. If the agent's window is Sval's only window,
Sval keeps it open.

You can take control of the agent's Workspace at any time, or stop the
agent. Either one affects only that Workspace. The app's other sessions
carry on.

## Your sign-ins, or none

Which sign-ins an agent can use depends on its Workspace.

- **A shared Workspace.** The agent uses the same sign-ins as your own
  shared Workspaces, so the agent can work in your accounts for you. The
  agent never sees your passwords, because Sval removes password values
  from what the agent reads.
- **An isolated Workspace.** The agent starts signed out of every site and
  can't reach your accounts. Where a task needs a sign-in, the agent signs
  in itself.

The app asks for one kind of Workspace when it pairs. You can pick the
other kind in the pairing alert. See
[What an isolated Workspace keeps apart](/docs/explanation/isolated-workspaces/).

## Rules for sites

A rule for each site decides what an agent can do there. When a site has
no rule, the agent's default applies. When an agent is new, Sval asks you
the first time the agent opens each site. Your answer becomes that site's
rule, so Sval asks once per site instead of on every page.

The rules treat reading and acting differently. Reading a page changes
nothing. Clicking, typing, and submitting can buy, send, post, or delete.
That's why Sval can let an agent read a site freely and still ask before the agent
sends anything. When Sval asks, it shows you what the page is about to
send.

Sval asks about some things separately on each site, because each one can
reach past the page:

- Downloads put files on your computer.
- Uploads send files from your computer. Sval allows them only from folders
  you've approved.
- Opening another app hands an address to something outside Sval.
- A page's developer console can hold account details, sign-in codes, or
  what you typed.
- A service on this computer or a device on your local network isn't on the
  open web, so Sval asks before an agent opens one, whatever the default.

## What an agent can't do

- It can't see or act in a tab outside its own Workspace.
- It can't run its own scripts in a page, act inside frames, or open a
  file chooser. It sends files only through Sval's upload question.
- It can't write to your clipboard from its pages.
- It can't read a page's title or address on a site it isn't allowed to
  read.
- It can't complete a check that asks whether you're human. Sval asks you
  to take control and complete the check yourself.
- It can't change its own rules or turn off Be polite. Only you can.

## Sval doesn't hide the agent

Sval doesn't try to make an agent pass for a person. It tells agents to
work at the pace a task needs, with no random delays. Be polite limits an
agent to a set number of actions a second on each site. That way the agent
doesn't overload the sites it visits.

## Related pages

- [Connect an AI app to Sval](/docs/how-to/agents/connect-an-ai-app/)
- [Allow or block a site for an agent](/docs/how-to/agents/allow-or-block-a-site-for-an-agent/)
- [Take control of an agent's Workspace](/docs/how-to/agents/take-control-of-an-agents-workspace/)
- [Agent settings and controls](/docs/reference/agents/)
