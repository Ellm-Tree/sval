# 1685. Mozilla's fingerprinting compatibility fixes are off by default

**Status:** Accepted on 2026-10-31.

## Context

Mozilla publishes fingerprinting-protection overrides through Remote
Settings (`fingerprinting-protection-overrides`), which
`FingerprintingWebCompatService.sys.mjs` applies while
`privacy.fingerprintingProtection.remoteOverrides.enabled` is true. Firefox
ships it true. Almost every entry is one of Google's domains; the others are
bing.com and wpt.fyi. For Google the entries turn off canvas
noise and WebGL vendor bucketing. Testing with the fixes off showed no
breakage on those sites.

The user decides whether a site such as Google can fingerprint them, and
Mozilla's list decides it for them while it is on.

## Decision

- Sval sets `privacy.fingerprintingProtection.remoteOverrides.enabled` to
  false by default (`branding/sval/pref/app-sval-prefs.js`).
- Settings keeps the "Mozilla's compatibility fixes" switch, so a user can
  turn the fixes on.
- With the fixes on, each site's fingerprinting switch in the protection
  button still decides for that site: turned on, it keeps Mozilla's fix out
  of the site, and the choice syncs (protections spec §2.2).
- Sval fetches the collection with the switch off, so turning the switch on
  applies the current list at once.

## Consequences

Google's sites and bing.com get Sval's full fingerprinting protection out of
the box. A site Mozilla adds to the list later gets no fix unless the user
turns the fixes on. Private windows apply Mozilla's fixes whenever the switch
is on, because Gecko applies a site's own entries in normal windows alone.
