# 0130. A page an agent controls does not write the clipboard

**Status:** Accepted on 2026-10-18.

## Context

An agent's input is trusted input to the page, so it gives the page user
activation. Gecko lets a page with activation write the system clipboard
(`nsContentUtils::IsCutCopyAllowed`), so a page the agent clicks in could
replace what the user copied, for example with a command or an account number
the user later pastes elsewhere. No alert sees it, because no request is sent.

## Decision

- **While an agent controls a tab, its pages do not write the system
  clipboard**: `navigator.clipboard`, `execCommand("copy")` and a copy event's
  own data are all refused, and the clipboard keeps what it held.
- **Once the user takes control, the tab writes as any tab does.** None of the
  user's input reaches a tab the agent controls (agent-control spec §6), so no
  copy of the user's own is refused.
- The decision is made in the parent, where every clipboard write from content
  arrives with the window it came from (`nsBaseClipboard::SetData`), by asking
  Sval whose tab it is. Content cannot tell whether the user holds the tab.

## Consequences

- A site that copies something for the agent's task, such as a "copy code"
  button, does nothing in an agent's tab.
- The change is a patch to Gecko, `sval-agent-clipboard.patch`.
