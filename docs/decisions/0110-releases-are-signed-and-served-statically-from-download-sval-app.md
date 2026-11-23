# 0110. Releases are signed, and served statically from download.sval.app

**Status:** Accepted on 2026-10-16.

## Context

Sval needs a place for releases to live, a way to sign each platform's
packages, its own version, and a way for the updater to find updates. GitHub
Releases cannot serve an APT repository, and GitHub Pages refuses files over
100 MB, which Sval's packages are close to.

## Decision

- **Hosting.** Every release file, the APT and DNF repositories and the update
  feed live in a Cloudflare R2 bucket served as `download.sval.app`.
  It is static: no server code runs, as decision 0005 requires. R2 charges
  nothing for bandwidth. The website goes on Cloudflare Pages at
  `sval.app`, separately.
- **Windows** is Authenticode-signed as Ellm Tree, Inc. with jsign, with an
  organization-validated certificate from SSL.com whose key is held in a
  hardware security module.
- **macOS** is signed with Ellm Tree's Developer ID and notarised, with
  rcodesign.
- **Linux** `.deb` and `.rpm` installs update through a signed APT and DNF
  repository. Their key is an OpenPGP key of its own.
- **Versions.** Sval has its own version numbers (`1.0.0`, …), named by the
  release tag, shown everywhere users see a version, with the ESR version
  alongside. The application version Gecko compares stays the ESR version,
  because extensions declare their minimum Firefox version against it; Sval
  releases on one ESR differ by build ID. The build reads both from
  `--with-version-file-path`, so Mozilla's version files are not patched.
- **Updates.** Windows, macOS and the Linux tarball update with Firefox's own
  updater, from a static feed per platform:
  `https://download.sval.app/update/1/%CHANNEL%/%BUILD_TARGET%/update.xml`.
  A check reveals the channel and platform only, never the version, build,
  OS or locale. The `release` channel carries releases; `beta`, which a user
  reads by turning on release candidates, carries every release candidate
  and every release. Packaged Linux installs have
  the updater off and use apt or dnf.
- **Update signing.** Two RSA-4096 MAR keys, kept apart from every other key,
  replace Mozilla's certificates in the updater. CI signs with the primary;
  the secondary is kept offline, to ship a new updater if the primary leaks.
- **Windows keeps the maintenance service**, so updates install silently. The
  installer registers the certificate's issuing CA, and a release fails when
  the CA that signed it is not registered.
- **The service is Sval's own**, the Sval Update Service, and shares nothing
  with an installed Firefox's Mozilla Maintenance Service: its Windows service
  is `SvalUpdate`, its registry key `HKLM\Software\Sval\UpdateService`, its
  Programs entry `SvalUpdateService`, and its folder, which holds its logs and
  the updater's secure output, `Program Files (x86)\Sval Update Service`.
  Windows keeps one service per name, so under Mozilla's names the two apps
  would share one service: the first to install it would name it, the newer
  binary would replace the other's, and uninstalling it from either app would
  remove it for both. Sval's updates, shortcut logs and
  instance locks live under a ProgramData folder of its own,
  `Sval-43d64005-7132-4159-8cf9-84d0ed938db3`.

## Consequences

- A release is one tag, and one run feeds every path: the update feed, the
  repositories and the download files.
- Rotating the MAR primary needs a release signed with the secondary.
- When Microsoft adds an issuing CA, Windows updates fall back to a UAC prompt
  until a release lists it.
