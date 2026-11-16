# 1437. The shared-folder helper is a native program

**Status:** Accepted on 2026-10-26. Specified in
2026-10-26-native-shared-folder-helper-design.md, §4.

## Context

[0031](0031-only-a-helper-process-touches-the-shared-folder.md) keeps every
shared-folder read and write in a helper process, because a read on a hung
network mount can block in the kernel without end, and a process can be
abandoned where a thread cannot.

A whole Firefox started in background-task mode fails as that helper. On an
M5 Mac a request that starts one takes a median of 350 to 635 ms, and a live
one holds about 130 MiB. Keeping one alive between requests does not pay for
itself: a background shared step runs every 30 s and a pairing look claims
every 5 s, so nearly every step still pays a start, and the browser and the
helper can talk only through files they each poll.

A native program beside the browser binary, as sval-mcp is, starts and
answers in about 5 ms, answers a live request over a pipe in about 0.1 ms,
and holds about 2 MiB.

## Decision

- **The helper is `sval-folder`, a separate Rust program packaged beside the
  browser binary**, built, staged, signed and updated as sval-mcp is, and not
  a subcommand of sval-mcp. It performs every shared-folder operation with
  0031's checks and limits, and never sees the key.
- **The browser talks to it over its stdin and stdout** through `Subprocess`,
  in sval-mcp's length-prefixed JSON frames. File contents travel as files in
  the profile's private request directory, never on the pipe.
- **The first frame each way is `hello`, with the protocol version,** checked
  as Sval checks sval-mcp's: a helper of any build that speaks the browser's
  version or the one before is accepted. One that speaks neither is refused,
  and shared requests fail, until Sval restarts.
- **One helper serves the browser run** from its first shared request until
  its stdin closes: when the user clears the shared folder, or when the
  browser exits for any reason. It has no idle exit and no lifetime cap.
- **Each request has its own 20 s deadline.** A request past it has the
  helper killed, its pipes dropped and the helper abandoned. One helper is
  alive at a time
  ([0033](0033-at-most-one-helper-is-alive-and-a-request-waits-within-its-own-deadline.md)),
  and a helper ends itself 21 s into one request.

## Consequences

- A shared step, a pairing claim or a settings change starts no browser. A
  user with a shared folder runs one small extra process.
- A helper whose browser has gone exits on end of file, so the helper needs
  no session ids and neither side polls.
- Sval runs no background task of its own, and the browser's packages carry a
  second Sval program, which the package manifest names.
