# 0125. An agent's workspace is named for its task

**Status:** Accepted on 2026-10-18.

## Context

A workspace named after the agent's client, its launch folder and four hex
digits of its launch id, such as "fp-audit · tmp · 8b8f", does not tell the
user, with several agents running, which agent holds it or what it is doing.
Every agent knows its own task. A person
controls each agent somewhere up the chain and can ask it what it is doing in
Sval, so what the agent says about itself is trusted.

## Decision

- A session names its workspace with a `task`: a few words saying what it is
  doing. The pairing call and `set_task` take one, and either makes the
  session's workspace when it has none (decision 1998).
- The agent is named by its client: MCP's `clientInfo.title`, or its `name`
  when no title is given, such as "Claude Code". That name marks the
  workspace as the agent's and is what alerts call the agent. The `model` a
  session gives, such as "Opus 5.5", is kept with its workspace.
- `set_task` renames the session's workspace when it moves on to other work.
- No launch id or folder appears in a name. Each workspace keeps the folder
  its session started in, which Sval shows beside it.

## Consequences

- Two agents may have the same task. Their workspaces then share a name,
  as the user's own workspaces can.
- A workspace the user renames is renamed again by the agent's next
  `set_task`.
