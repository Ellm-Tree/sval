# 2122. Intel Macs get a build of their own

**Status:** Accepted on 2026-11-09. Specified in
`2026-09-24-sval-browser-design.md`, §12.

## Context

Apple sells only Apple silicon Macs, and many Intel Macs are still in use.
Gecko at Sval's ESR pin builds for both: macOS 11 or later on Apple silicon,
and macOS 10.15 or later on Intel. Apple's SDK holds both architectures, so
the Apple silicon Mac runner cross-compiles the Intel build with configure's
`--target`, as Mozilla's own Mac builds cross-compile both.

A universal app, Mozilla's choice for Firefox, holds both architectures in one
bundle and is about twice the size of either.

## Decision

- **Sval ships two Mac builds, one per architecture**: a disk image and a
  complete update for Apple silicon, and the same for Intel. The universal app
  is rejected: every Apple silicon user would download an Intel copy they
  never run.
- **An Intel copy running under Rosetta moves to the Apple silicon build at its
  next update.** Migration Assistant carries the Intel copy to a new Mac, and a
  user can download the wrong image. Under Rosetta the update check's
  `BUILD_TARGET` ends in `-aarch64`, as a Windows build's names the CPU it runs
  on, and the update feed answers that target with the Apple silicon update.
  A complete update replaces the whole bundle, so the next launch is native.
- **CI compiles the Intel Gecko for every key, and a nightly check starts it
  under Rosetta.** No suite runs on Intel: the Mac runner is Apple silicon, and
  the suites run on the Apple silicon build.

## Consequences

- A release compiles both Macs, each in one of the Mac runner's two slots, side
  by side.
- An Intel Mac's support ends where Apple's and Gecko's do.
- The website offers the Apple silicon image first, and the Intel image where
  the visitor's browser reports an Intel Mac.
