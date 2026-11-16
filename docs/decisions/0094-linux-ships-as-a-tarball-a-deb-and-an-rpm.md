# 0094. Linux ships as a tarball, a .deb and an .rpm

**Status:** Accepted on 2026-10-09.

## Context

Linux is a v1 platform beside macOS and Windows (spec §12). CI compiles Gecko
for linux64 beside win64 and macOS, and Gecko's `LibSecret.cpp` gives Sval's
keys the Secret Service.

Mozilla's tree carries repackagers for .deb, .rpm, Flatpak and Snap
(`python/mozbuild/mozbuild/repackaging/`), so building any of them is cheap.
What costs is getting each to users and keeping it up to date.

- A bare .deb or .rpm never updates. Only a signed APT or DNF repository
  updates one, and that needs a GPG key and public hosting.
- Flathub builds and updates a Flatpak, but its sandbox needs a hole for each
  of Sval's sync folders, native messaging for password managers and the
  sval-mcp bridge, and Flathub's reviewers judge each one.
- Snap has Flatpak's confinement problems, and Ubuntu users can install the
  .deb.
- AppImage has no support in the tree and no update story.

## Decision

Linux ships as the release tarball, a .deb and an .rpm.
`scripts/package-linux.sh` makes the last two from the tarball with
`mach repackage deb|rpm` and Sval's templates in `packaging/linux`, and
`scripts/release-build.sh` installs each on a clean Debian and Fedora and
starts it.

They are attached to the release, and
[0110](0110-releases-are-signed-and-served-statically-from-download-sval-app.md)
serves them from signed APT and DNF repositories. Flatpak, Snap and AppImage
are not built.

## Consequences

- CI builds and tests on Linux.
- The tarball updates itself through Sval's update channel (0110). The .deb
  and .rpm update through the signed repository, with the in-app updater off
  for them, as Mozilla does for its own .deb.
- The package metadata names a maintainer address, `packages@sval.app`.
- Adding Flatpak costs its sandbox review; the build itself is cheap.
