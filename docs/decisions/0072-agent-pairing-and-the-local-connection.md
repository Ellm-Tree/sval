# 0072. Agent pairing and the local connection

**Status:** Accepted on 2026-10-07.

## Context

A local agent connects to Sval through `sval-mcp`, which relays stdio MCP to a
loopback listener in Sval's parent process. Loopback is shared by every OS user,
and a port file outlives a crash. Spec:
`docs/superpowers/specs/2026-10-06-agent-control-design.md`.

## Decision

- **Each side proves it can read the port file with a challenge-response, and
  Sval stays silent for a peer that cannot.** Without Sval's proof, a stale port
  file lets another process collect a secret. Without the client's proof, any
  local process can raise a pairing alert naming itself "Claude Code" (spec
  §3.3).
- **The token never crosses the wire.** A token-first banner is rejected:
  whoever connects learns the token, can wait for a stale port file, and
  replay it to `sval-mcp`.
- **The two proofs sign under different prefixes (`sval:` and `agent:`).** Sval
  answers any valid challenge, so without them a peer could feed Sval its own
  nonce and use the answer as the client proof.
- **`port.json` and `agents.json` live in `<profile>/sval-agents/`, created 0700
  and tightened if loose.** A file created and then chmod'ed can be opened by
  another user in between, and the handle stays valid.
- **Pre-handshake input is capped at 4 KiB, with a 5 s client deadline and a 10 s
  Sval window.** A peer that proves nothing must not make Sval buffer, hold a
  connection open, or reveal anything.
- **A stale port file is removed whenever access is off,** at start and before
  quit, or a bridge could send its secret to whatever holds the port next.
- **Pairing and unpairing write the new state to disk before swapping it into
  memory.** Otherwise a failed write plus a retry finds nothing to revoke, and
  the revoked agent returns after a restart.
- **A request always gets one reply, and a notification gets none and runs
  nothing.** Errors name only the error's type, because a message can carry a
  path and the agent's model reads it.
- **No window to ask in is `no_window`, never a decline.** On macOS Sval often
  runs with no window, and the agent would otherwise tell the user they refused
  something they never saw.
- **Pairing uses the name the agent reports.** Settings › Agents lists each
  paired agent under that name and offers no rename.
- **The secret is stored hashed in Sval, and `sval-mcp` keeps it in a file only its
  owner can read** ([0088](0088-an-agents-pairing-secret-is-a-file-only-its-owner-can-read.md)).
  Both languages pin the same independently computed HMAC vectors.

## Consequences

The feature is behind `browser.sval.agents.enabled`, off by default. CI cannot
show a focus steal on Windows, because the runner's session never loses
foreground.
