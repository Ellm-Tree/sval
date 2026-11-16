# 0131. One Privacy and Security button in the address bar

**Status:** Accepted on 2026-10-18.

## Context

Sval's protection button covers trackers and fingerprinting. Firefox's padlock
opens its site panel, which, with its tracking-protection parts hidden
([0127](0127-no-firefox-tracking-protection-ui.md)), holds the connection's
security, the certificate, a breach alert, "Clear cookies and site data" and a
settings link. Two icons beside the address would speak about privacy and
security, and one of them looks like Firefox.

## Decision

- **The protection button is the one Privacy and Security button.** The
  padlock's icon is not drawn, and its panel's contents move into Sval's.
- **The icon keeps its protection states** (protected, off for this site, not
  applicable) and takes a colour only when the connection is wrong: **amber**
  for a page with no encryption (plain http), **orange** for a certificate the
  person chose to trust, **red** for a certificate error or a blocked
  dangerous site. A secure connection adds no mark.
- **The panel's header** names the site, its protection state and its
  connection. The connection line opens a certificate view hosted in Sval's
  panel and drawn in Sval's style, from Firefox's certificate data. It carries
  the HTTPS-Only exception and Page Info.
- **A page that is not secure** shows its warning as the panel's first card.
- **"Clear cookies and site data" is in the site menu**
  ([0132](0132-site-controls-in-the-address-pill.md)), using Firefox's own
  clearing. Clearing acts on what the site keeps, which the site menu
  decides. The Privacy and Security panel shows how Sval protects the
  person on the site.
- **Breach alerts show**, from Firefox's `fxmonitor-breaches` Remote Settings
  collection, which Sval syncs from the Remote Settings server it
  contacts. The data is Have I Been Pwned's, under CC BY 4.0, so the card names
  Have I Been Pwned and links to haveibeenpwned.com wherever it shows breach
  data. A switch in Settings, under Privacy and protection, turns breach
  warnings off (decision 0126). Off, Sval looks nothing up and the collection
  does not sync.
- **Dismissing a breach is remembered on the device**, in Firefox's own store.
  Dismissals do not sync, because most people never touch the card.
- **The certificate view shows no exception date and no error reason.** Gecko
  does not record when an exception was added, and the error page below the
  panel explains the error.
- **Clearing site data names no size.** Firefox measures it by scanning every
  site's storage, which is too slow for the confirm.
- **Secure DNS is not in this panel**: it is one choice for every site, and it
  lives in Settings ([0105](0105-secure-dns-is-the-networks-dns-by-default-with-encrypted-dns-a-choice-away.md)).
- Firefox's privacy settings link is not carried over: "Manage sites" covers
  it.

## Consequences

- Firefox's site panel does not open from the address bar.
- `fxmonitor-breaches` is in `browser.sval.remoteSettings.collections`, tied to
  the switch's pref, and in the design spec §10.9.
- Media is in the site controls
  ([0132](0132-site-controls-in-the-address-pill.md)), outside this button.
