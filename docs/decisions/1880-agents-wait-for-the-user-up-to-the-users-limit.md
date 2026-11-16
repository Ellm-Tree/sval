# 1880. An agent's call waits for the user up to the user's limit

**Status:** Accepted on 2026-11-02. Specified in
2026-10-06-agent-control-design.md, §5.6.

## Context

An agent's tool call can raise an alert and wait for the user's answer. MCP
clients differ in how long they let a call run, and a client can change that
at any time.

## Decision

Sval waits for the user's answer up to the limit the user chooses in
Settings › Agents, and it does not guess at client timeouts.

## Consequences

- Every call waits the same way, whether or not it carries a progress token.
- A call still unanswered at the limit answers `awaiting_approval`, and the
  alert stays open.
