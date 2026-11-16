# 1540. A blocked embed asks in the browser before it loads

**Status:** Accepted on 2026-10-29.

## Context

Firefox's SmartBlock draws a placeholder where blocking stops a known embed
(Instagram, TikTok, X, Disqus). The placeholder's button opens Firefox's
protections panel, whose toggle unblocks the embed for the site. Sval has no
Firefox protections panel ([0131](0131-one-privacy-and-security-button.md)),
so the button has nowhere to go. The page can send its shim's messages to
the webcompat extension itself (`Shims._onMessageFromShim`), and the
placeholder takes every click in its box, so a button in the page that
unblocked directly would let a site lift Sval's block on its own embed.

## Decision

The placeholders stay. Their button asks on the Privacy and Security button,
"Allow Instagram on example.com?", for each embed the page's content-blocking
log shows replaced, and only Allow there sends Firefox's own unblock. The
answer lasts the session, as Firefox's does.

## Consequences

The page asks and the browser decides, as with any permission prompt, and
`PopupNotifications` gives the prompt its usual delay before a click counts.
Sval's panel has no row to block an embed again; a restart does.
