# 0074. A private window uses Sval's panel and saves nothing

**Status:** Accepted on 2026-10-07.

## Context

Sval's panel is the only place tabs live. Giving private windows Firefox's tab
strip instead would make Sval two products, and under "Always use private
browsing mode" it would turn Sval off entirely. People who browse privately
are also the most sensitive to anything being kept, so a private window must
save nothing at all.

## Decision

A private window shows Sval's panel with one temporary workspace holding just
its own tabs, and a notice that nothing in it is saved or synced and that it is
gone when the window closes. It is safe because the window is handed objects
that cannot write, rather than the profile's objects with care taken around
them:

- **The tree** is a `SvalDocument` in `SvalPrivate.worker.mjs`. That worker
  imports only the engine module, `SvalDocumentOps.mjs` and
  `SvalWorkerHost.mjs`.
- **Settings** are held in memory, and `flush` writes nothing.
- **Tab ids** are kept in a `WeakMap` keyed by `permanentKey`, never in
  SessionStore.
- **`SvalTabs.attach` refuses both mixes**: a private window on the profile's
  engine, and a normal window on a private tree.

## Consequences

- **The guarantee is proved on disk as well as by code path.** After a private
  session, Sval's files are byte-identical and no marker appears anywhere in the
  profile or the shared folder. The sessions tested include one beside a
  syncing window, the shutdown publish, two private windows, permanent private
  browsing, and a SIGKILL (`scripts/private-browsing-test.sh`, nightly).
- **No new workspaces.** A private window cannot make a workspace, switch
  workspaces, pair, or be seen by an agent.
- **The one fallback.** If its panel fails to start, the window shows Firefox's
  tab strip, which is live underneath. That keeps the window's tabs visible.
- Design: `docs/superpowers/specs/2026-10-07-private-windows-design.md`.
