# 1998. An AI app pairs once, and each session has its own workspace

**Status:** Accepted on 2026-11-05.

## Context

A person allows an AI app or not. They do not allow it once per folder it
runs in, and a session started somewhere new that has no tools until it is
approved again looks broken. Each session of an app is still its own piece of
work, which the person watches and tells apart from the others by its task.

An MCP client over stdio gives the server nothing that names a session. Claude
Code sets `CLAUDE_CODE_SESSION_ID` in the server's environment, and Codex puts
a session id in each tool call's `_meta` under `x-codex-turn-metadata`.
Cursor, Claude Desktop, Gemini CLI and Mistral Vibe give none. A session that
resumes days later is the same conversation, holding what its tools returned.

## Decision

- **A pairing is the app's, per profile.** `sval-mcp` keeps one secret per
  MCP client name and profile, so every session of the app on this device
  connects as the one agent the user allowed. Its site rules are the app's.
- **Each session has its own workspace.** A connection starts with none. The
  first call that needs one, the pairing call or `set_task`, makes it, named
  for the task the call gives. The answer gives the workspace's id and tells
  the agent that without it, it cannot come back to that workspace.
- **`use_workspace` takes a session back to its workspace.** It takes the id
  of one of the app's workspaces. It answers `workspace_in_use` while another
  open connection holds that workspace, so two sessions never act in the same
  tabs, and `not_found` for an id of no workspace of the app. A session that
  resumes calls it with the id its conversation kept.
- **A connection holds its workspace for as long as it is open.** The shim
  names the workspace it held in its handshake when it connects again, after
  Sval restarts or the shim replaces itself, and gets it back while no other
  connection holds it.
- **Deleting a workspace leaves the pairing.** The user deletes an agent's
  workspace like any other, and the agent deletes its own with
  `delete_workspace`. A connection whose workspace is gone has none until its
  next call makes one or `use_workspace` takes another.
- **An unused workspace goes after a time the user sets.** Sval deletes an
  agent workspace no session has held for 30 days, or the 7 or 90 the user
  picks, or never. A workspace a session holds stays, as does one the user
  has taken control of. The agents file is the device's own, so only the
  device whose sessions used a workspace deletes it.
- **Stop and take control belong to a workspace and the session holding
  it.** The user stops the work they are watching in that window, and the
  app's other sessions go on. A stopped session can neither make a workspace
  nor take another until the user resumes it, and no session takes a
  workspace the user holds.
- **The app's identity is a claim, its secret the proof.** Any session holding
  the app's secret may ask for any of the app's workspaces. That reaches only
  what the user allowed that app.

## Consequences

- An agent that loses the id, as a summary of its conversation may, cannot
  reach its old workspace, which stays until someone deletes it.
- Workspaces collect, one per session, until the user, the agent or the
  sweep deletes them.
- Pairings made per folder before this match no app, so each app asks once
  more.
