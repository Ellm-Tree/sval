# 1738. Firefox and Sval run side by side and never interleave

**Status:** Accepted on 2026-11-01.

## Context

Sval is built from Firefox, and Gecko names much of what it keeps after
Mozilla or Firefox whatever the application calls itself. Some names come
from the identity Sval sets (`MOZ_APP_VENDOR`, `MOZ_APP_PROFILE`,
`MOZ_APP_BASENAME`, the remoting name, the bundle id), but others are
hard-coded, or come from `MOZ_APP_NAME` and the application id, which Sval
keeps as Firefox's (`firefox` for the artifact tooling, the id for add-on
compatibility). Each such name is a place where one app can read, overwrite,
or delete the other's state.

## Decision

- Firefox and Sval can run at the same time on the same machine, as the same
  user, and never interleave. Neither reads, writes, opens, registers over,
  signals, or updates the other's files, settings, services, processes,
  windows, or permissions, on macOS, Windows, and Linux.
- Development builds follow the same rule against the installed Sval.
- A name Sval shares with Firefox is fixed at its root: in the identity
  options in `mozconfig`, in a Gecko patch, or in packaging. A runtime
  workaround is not acceptable.
- Import (spec §12) reads Firefox's profile when the user opens it. That is
  the user moving their data, so the two apps are not interleaving.
- Native messaging, managed storage, and PKCS#11 manifests are read from
  Sval's own folders and registry key, never from the Mozilla ones that
  Firefox-family browsers share. A desktop app that sets itself up only for
  Firefox does not reach Sval until it lists Sval, or until the user copies
  its manifest across (`docs/native-messaging-hosts.md`). Sharing Firefox's
  folders gives little in return: Bitwarden's desktop app writes the Firefox
  manifest on macOS and Linux only where Firefox's folder exists, so on a
  machine with Sval alone it never helps.
- The one exception is on macOS, where Sval reads a single manifest from a
  Mozilla folder: `com.apple.passwordmanager.json` in
  `/Library/Application Support/Mozilla/NativeMessagingHosts`. macOS installs
  the file there for the iCloud Passwords extension and writes no copy to a
  folder of Sval's. The file is Apple's and Firefox never writes it, so
  reading it reads none of Firefox's state. Sval carrying a copy of its own
  is rejected: the manifest names the path of Apple's helper app inside the
  system volume and the ids of Apple's extension, and a copy goes stale when
  a macOS update changes either.
- The Firefox coexistence audit of 2026-11-01 has a verdict for each name.

## Consequences

- Sval loads no add-on from the shared system and user extension folders.
- A password manager's desktop integration needs the manager to list Sval,
  or a manifest the user copies. iCloud Passwords on macOS needs neither.
- On Linux, Sval's data directory is `~/.sval` from the first launch.
- On Linux, Sval's application id is `app.sval.sval`. The desktop portal,
  notifications, and MPRIS know Sval by it, and it names Sval's desktop
  entry.
- The Windows installer writes only Sval's own registry keys. It leaves the
  `firefox.exe` App Paths entry to an installed Firefox.
- Sval's executable is `sval.exe` on Windows, `sval` on Linux, and
  `Sval.app/Contents/MacOS/sval` on macOS (`--with-app-name=sval`). The
  process name and every Windows registration keyed by the executable are
  Sval's own, and its ProgIDs are `SvalHTML`, `SvalURL`, and `SvalPDF`. An
  artifact build on Mozilla's Gecko keeps Mozilla's `firefox`, since its
  binaries are Mozilla's.
- Every helper executable Sval starts has a name of its own, so that
  `killall`, `pkill`, and `taskkill` given a Firefox process name leave Sval
  alone. `pkill` matches any part of a name, so no Sval helper's name contains
  a Firefox helper's name. The names follow `MOZ_APP_NAME` as `sval-<role>`:
  `sval-child` (`plugin-container`), `sval-crash-helper`,
  `sval-crash-reporter`, `sval-update` (`updater`, and
  `org.mozilla.updater` on macOS), `sval-update-service` and
  `sval-update-service-installer` (`maintenanceservice`),
  `sval-private-browsing`, `sval-default-agent`, and the Linux probes
  `sval-glx-test`, `sval-vaapi-test`, `sval-v4l2-test`, and
  `sval-vulkan-test`. A helper Sval never starts keeps Mozilla's name:
  `pingsender`, because telemetry upload is locked off, and `nmhproxy`,
  because the Firefox Bridge that registers it is off.
- Any new integration with the operating system has to pick a name of
  Sval's own.
