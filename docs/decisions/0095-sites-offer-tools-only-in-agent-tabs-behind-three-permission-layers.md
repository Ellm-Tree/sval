# 0095. Sites offer tools only in agent tabs, behind three permission layers

**Status:** Accepted on 2026-10-12.

## Context

WebMCP lets a page offer tools to agents. Firefox ESR 153 carries Mozilla's
prototype (`dom/modelcontext`), gated by one global pref. With the pref on,
every page in every workspace sees `navigator.modelContext`, which marks Sval
users to trackers and changes how pages behave in the user's own browsing.

A tool's description, schema and result are written by the site, and its
arguments can carry the user's data to the site. Mozilla's standards position
is neutral for the same reasons.

## Decision

Sval uses Mozilla's prototype. A Gecko patch exposes the API only to pages whose
top-level browsing context is an agent tab, and only while agent access and the
sites' tools switch are both on.

A tool reaches an agent through three layers, each failing closed: a global
switch, off by default; a setting per agent (off, ask, on), default ask; and a
setting per agent per site (allow, deny, or no entry, which asks). A tool call
is an agent action: it raises a call alert showing its arguments where the
site's level asks, and the write gate judges what it sends.

The spec is `docs/superpowers/specs/2026-10-12-site-tools-for-agents-design.md`.

## Consequences

Sval carries one more Gecko patch, and the ESR rebase must adapt it to Mozilla's
newer API shape. Pages outside agent workspaces cannot tell the feature exists.
Turning the pref on globally is rejected for the reasons above.
