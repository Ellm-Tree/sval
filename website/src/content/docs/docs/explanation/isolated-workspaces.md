---
title: What an isolated Workspace keeps apart
description: An isolated Workspace has its own cookies and site data, kept on each device, and why its tabs reload when that changes.
---

Websites remember who you are with cookies and other data they store in
your browser. Sval keeps that data in a store. Which store a tab uses
depends on the tab's Workspace.

## Shared and isolated

Every Workspace starts out shared. All shared Workspaces use one store, so
when you sign in to Fastmail in Home, Fastmail sees you as signed in from
Work too.

An isolated Workspace has a store of its own. Every tab in that Workspace
uses the store, and no other tab does. Sites in an isolated Workspace can't
see the sign-ins you made in your other Workspaces. Sites in your other
Workspaces can't see the sign-ins you made in the isolated one. That's how
you can be signed in to two accounts on the same site at once, one in each
Workspace.

You isolate a whole Workspace. You can't isolate a single tab, and a tab
always uses the store of the Workspace it's in.

## Why tabs reload

A page that's open can't change stores while it runs. So when a tab moves
to another store, Sval reloads the tab in the new store. That happens when you
isolate a Workspace, when you stop isolating one, and when you move a tab
into or out of an isolated Workspace. Sval asks before each of these.

Sval doesn't copy sign-ins from one store to another. A Workspace you
isolate starts out signed in nowhere. When you stop isolating a Workspace,
Sval deletes the data kept only in that Workspace's store. The Workspace's
tabs then use the sign-ins in the shared store.

## Each device keeps its own

Your Workspaces sync, and so does whether each Workspace is isolated. The
store itself stays on the device. Sval never syncs cookies or sign-ins, so
you sign in once in an isolated Workspace on each of your devices.

When you delete an isolated Workspace, the deletion syncs to your other
devices. Each device then deletes the Workspace's store, along with the
sign-ins and site data in the store.

## Private windows

A private window already has its own store, apart from every Workspace.
Isolating a Workspace doesn't change that.

## Related pages

- [Isolate a Workspace](/docs/how-to/workspaces/isolate-a-workspace/)
- [Move a tab to another Workspace](/docs/how-to/workspaces/move-a-tab-to-another-workspace/)
- [How sync works](/docs/explanation/sync/)
