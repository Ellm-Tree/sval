# 0063. Launch ships full builds; artifact builds are for development and CI

**Status:** Accepted on 2026-10-07.

## Context

An artifact build downloads every native binary a Gecko build compiled
(`libxul`, `firefox`, `updater`, `crashreporter`, `plugin-container`), and
everything compiled into them is that build's choice. Built on Mozilla's
binaries, six of those choices make it unshippable:

1. **It cannot update itself.** The updater installs only a MAR signed by a
   certificate compiled into it, so it would accept only Mozilla's updates.
2. **It is Firefox to the operating system.** The vendor and profile
   directory are compiled into `libxul` and the launcher, so a plain launch
   resolves Firefox's profile root. On Windows the launcher, skeleton UI and
   default-browser agent use `SOFTWARE\Mozilla\Firefox\...`.
3. **Sval's identity settings are inert in it.** `--with-app-basename` and the
   `MOZ_APP_VENDOR` patch change only `application.ini`, which the compiled-in
   values override.
4. **Its inputs expire.** Taskcluster keeps level-3 build artifacts for one
   year, the length of an ESR cycle.
5. **It asks Mozilla for updates.** The update URL is compiled into the
   launcher, and no pref turns the check off: every launch requests
   `aus5.mozilla.org`. An enterprise policy would silence it and put "managed
   by your organization" in settings, so it is rejected.
6. **It does not block phishing.** libxul maps Safe Browsing's phishing table by
   `MOZILLA_OFFICIAL`, and Mozilla's official libxul and Sval's unofficial
   front-end prefs name different tables. Malware blocking works. Adding the
   second table is rejected: Google pairs list states with names by position.

## Decision

Releases ship full builds. A full build keeps
[the Windows decision](0062-windows-needs-no-windows-to-build-a-windows-vm-only-runs-the-suites.md):
Mozilla's own win64 shippable build compiles on a Linux worker.

Development and CI artifact builds use Sval's own Gecko: Sval's CI
compiles Gecko and publishes the artifact packages that `scripts/build.sh`
fetches.

The release configuration:

- Bundle id `app.sval.sval`, built from the distribution id `app.sval` and
  the display name, from `sval.app`, Sval's public URL. macOS ties
  preferences, Keychain access, permissions, signing and updates to it.
  `MOZ_APP_NAME` stays `firefox`, because the artifact code expects it in
  every package it unpacks (`mozconfig`).
- Crash files stay local unless the user sends one
  ([0076](0076-crash-files-stay-local-unless-the-user-sends-one.md)).
- A release build is on Sval's release update channel. Its updater trusts
  only Sval's MAR certificates and asks Sval's feed at `download.sval.app`
  (spec §8.6, §10.9,
  [0110](0110-releases-are-signed-and-served-statically-from-download-sval-app.md)).
  Every other build is on a channel whose feed is never published, so a
  development build never updates itself.

## Consequences

A compiler toolchain in the image, and builds in hours, paid once per Gecko
key and never per front-end edit. Sval's Gecko checks for updates only at
`download.sval.app` (`update-url-sval-feed.patch`), and `aus5.mozilla.org` is
not on the host list.
