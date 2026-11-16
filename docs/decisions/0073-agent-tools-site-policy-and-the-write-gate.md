# 0073. Agent tools, site policy and the write gate

**Status:** Accepted on 2026-10-07.

## Context

A paired agent opens, reads and acts on pages in its own workspace. Pages are
hostile, and the user must stay in control of what the agent reads and what
its actions send. Spec: `docs/superpowers/specs/2026-10-06-agent-control-design.md`
§3.2 to §5.6, §7.3.

## Decision

**Reading pages**

- Snapshots come from a DOM walk with heuristic roles and names. The
  accessibility service would start in every content process asked of it and
  build trees in both processes, and it has no ARIA role or name API without
  that.
- Refs never repeat within a tab: each snapshot gets a block of numbers no
  earlier snapshot of the tab used, so an old page's ref cannot resolve on a new
  page.
- Names and text are JSON-escaped, so a page cannot forge a line pointing the
  agent at another ref. Every password field is masked whatever the page does
  to its type, and the page-source tool strips it.
- `list_tabs` and tool results name a page only when the agent may read it now,
  from one window global per tab.

**Where an agent may go**

- Only `http`, `https` and `about:blank`, in every load in an agent's tab.
- Every load an agent starts carries a null principal. Back and forward refuse
  history entries carrying the system principal.
- A site decision is made on the document's principal, never its address, and
  fails closed: a blank page holds its writer's content, a sandboxed frame is
  its precursor's site, a PDF is the site it came from.
- Site policy also applies to page-started top-level loads, which wait for the
  user with no timeout. A tab holds one pending page-started alert; further new
  sites are refused unasked.
- A policy value Sval cannot read counts as no decision, so the site asks
  first.

**Acting**

- The level for a write is the top-level page's site.
- The write alert lists one item per request, 20 at most plus a count.
- The action window is quiet for 500 ms, capped at 10 s after the input and 30
  s from its start. Quiet follows the network, so a click handler that waits on
  a slow GET and then POSTs is still held.
- The gate holds only the agent's own writes, never beacons.
- A tab with an unanswered write alert refuses further input. Every acting
  tool goes through the gate, `scroll_page` and `select_option` included.
- A call waits for the user's answer with progress, one deadline per call,
  eight waiting calls per connection, ended by a cancel or access going off,
  and one input at a time per tab.
- Acting tools time out at 30 s with `page_unresponsive`; a load that does not
  finish in 60 s fails with `navigation_failed`.
- A click lands only on what the agent named: Sval refuses when anything but the
  element, a descendant, or its own label covers its centre, and checks again
  between press and release.
- History entries holding POST data are never replayed by `navigate_tab`.
- Files reach a page only through `upload_file`. Pickers a page opens are
  refused in the parent while the agent drives the tab.
- Downloads and uploads are per-site permissions, asked once per site.
- The write alert offers "Always allow writes on this site".

**Dialogs and windows**

- `confirm` and `prompt` wait for the agent's `answer_dialog`, which runs
  through the write gate. Sval accepts `alert`, leaves `beforeunload`, and
  leaves PDF.js's leave-page prompt through "Don't save". A message reaches the
  agent only when both the page's and the raising frame's sites are readable.
- Everything a watched page opens belongs to the agent's workspace, and a new
  tab takes no focus.
- Taking a tab back works whether or not agent access is on. A tab taken out is
  released for good.
- Every alert opens in the agent's own full window, because a page can move,
  resize or close a popup.
- Allow waits out `security.dialog_enable_delay`; Deny never does.
- Closing the window under an alert records nothing and is not a Deny.

## Consequences

The gate's header in `SvalAgentGate.sys.mjs` lists what the mechanism cannot
gate. Each gap is an issue labelled `agents`.
