# 2283. HTTPS-Only Mode is on by default, with a synced choice to always open a site

**Status:** Accepted on 2026-11-16.

## Context

Sval opens the secure version of every site that has one
(`dom.security.https_first`). When a site has none, that mode falls back to
plain HTTP without a word, so a person can type a password into a page that
anyone on their network can read or change. Someone on the network can also
make a site's secure version fail on purpose so the fallback happens.

HTTPS-Only Mode stops at a warning page instead, and opens the site only
when the person chooses to. Chrome warns before plain-HTTP sites by default.
Most sites have a secure version, so the warning shows mostly for older
sites and for devices reached by name. Addresses on the local network and
the person's own computer never get it
(`nsHTTPSOnlyUtils::LoopbackOrLocalException`).

The warning page's button lets a site open until Sval quits
(`LOAD_INSECURE_ALLOW_SESSION`). For a site a person trusts and uses often,
such as a device on their network reached by name, the warning would return
after every restart.

## Decision

- **HTTPS-Only Mode is on by default in every window.** The setting's
  choices stay as they are.
- **The warning page's button lasts until Sval quits.** One click on a page
  that may be under attack never trusts a site for good.
- **The Privacy and Security button's certificate view offers "Always open
  this site without a warning"** once the site is open from the warning. It
  is a site choice (`SvalSiteProtections`, `insecure`), saved for the exact
  host and synced with the person's other site choices. Turning the mode back
  on for the site takes the choice away.

## Consequences

- The test harness profiles turn the mode off, since the harness serves its
  own pages over plain HTTP. Sval's HTTPS-Only tests turn it on themselves.
- A saved choice covers the host's default port alone, because Gecko matches
  the exception to the exact origin.
- Settings › Sites lists a site with a saved choice.
