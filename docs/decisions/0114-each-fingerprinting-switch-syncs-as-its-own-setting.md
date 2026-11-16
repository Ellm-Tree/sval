# 0114. Each fingerprinting switch syncs as its own setting

**Status:** Accepted on 2026-10-17.

## Context

Gecko reads every RFP target from one string pref,
`privacy.fingerprintingProtection.overrides`, a comma-separated list of
`+Target` and `-Target` tokens that `nsRFPService::CreateOverridesFromText`
applies in order on top of its built-in default set.

Syncing that string as one value fails. One value for many switches means one
stamp for all of them: a switch changed on one device and another changed on
a second device between passes keep only one change.

## Decision

Each switch backed by RFP targets keeps the user's choice in a pref of its
own, `browser.sval.fingerprinting.switch.<id>`: `true` or `false` once the user
has chosen, no value while it stands at Sval's default. Settings sync carries
each as its own setting, one node per setting (settings-sync spec §2).

The overrides string does not sync. Each device composes it from its own
build's default string and the choices, keeping any token no switch owns. A
string set by hand in `about:config` is read back into choices.

The switch list is the settings' own list in `SvalFingerprinting.sys.mjs`,
and the synced prefs for these settings are derived from it.

## Consequences

- Switches changed on different devices between passes all hold everywhere.
- Each device keeps the targets its own build turns on by default.
- A token set by hand that no switch owns stays on its device.
