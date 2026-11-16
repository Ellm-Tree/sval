# 0081. The Kagi header goes only to kagi.com, for loads the user or Kagi started

**Status:** Accepted on 2026-10-08.

## Context

Private windows have no cookies, so Kagi cannot see the user's sign-in there.
Sval adds `X-Kagi-Authorization: <token>` to private-window requests to Kagi
instead. A header is not a cookie, so SameSite never applies to it. Added
without care, it would let any site in a private window make requests to Kagi
as the user, and a Kagi subdomain hosted by a third party would receive the
token. A cookie set by a subdomain, a container or a private window could also
replace the stored token with someone else's.

## Decision

The header goes only to the host `kagi.com`, over https. A top-level document
gets it when the system principal (the user's own navigation) or
`https://kagi.com` started the load. XHR and fetch get it only when
`https://kagi.com` started them. Frames get nothing. The header is removed from
every other private request. The header's token comes only from a Session Link
the user pasted into Sval's own Settings field. Kagi's `kagi_session` cookie,
which counts only for `kagi.com` or `.kagi.com`, Secure, and in the default
cookie jar, is read only to tell whether a normal window is signed in and to
fetch Privacy Pass tokens. A private window never carries the normal window's
session ([0091](0091-private-windows-sign-in-to-kagi-with-privacy-pass.md)).

## Consequences

A link from another site reaches Kagi signed out in a private window, and the
user signs in with one more click. A load the user started that another site
redirects into Kagi keeps the header. That matches what SameSite=Lax allows
Kagi's cookie in a normal window.
