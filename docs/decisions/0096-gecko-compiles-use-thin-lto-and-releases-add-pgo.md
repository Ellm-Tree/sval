# 0096. Gecko compiles use thin LTO, and releases add PGO

**Status:** Accepted on 2026-10-12.

## Context

Mozilla ships Firefox with profile-guided optimisation (PGO) and link-time
optimisation (LTO): `use-pgo` in `taskcluster/kinds/build/*.yml`, and full LTO
with PGO on Linux and Windows x86_64 (`lto` in
`build/moz.configure/lto-pgo.configure`).

Measured on linux64, with the Speedometer 3 copy in the
Gecko tree, headless, 3 runs of 10 iterations:

| Build | Compile | Peak memory | Speedometer 3 |
|---|---|---|---|
| no LTO, no PGO | 20.3 min | 11.7 GB | 19.8 / 19.8 / 20.1 |
| thin LTO | 20.5 min | 11.5 GB | 21.2 / 21.1 / 21.2 (+6%) |
| PGO and thin LTO | 51.2 min | 11.7 GB | 23.8 / 24.5 / 25.4 (+24%) |

PGO builds the browser twice, with a profiling run between, on the target OS:
Mozilla profiles win64 on Windows, though it compiles it on Linux.

## Decision

- **Every Gecko compile uses thin LTO** (`--enable-lto=thin` in
  `mozconfig.gecko`). On linux64 it cost nothing measurable.
- **Release builds add PGO.** Development Gecko, which every pull request and
  developer builds on, stays without it, because it would double every key
  change's compile.

## Consequences

- Releases with PGO run about a quarter faster than development Gecko on
  Speedometer, so performance work is measured on a release build.
- PGO for releases needs a profiling run per platform: Xvfb in the build image
  for linux64, a Windows machine for win64, and the Mac VM for macOS.
  `scripts/release-build.sh` builds without PGO until a platform has one.
- Full and cross-language LTO stay to be measured. Cross-language LTO needs
  rustc and Mozilla's clang on one LLVM generation, which
  `rust-toolchain.toml` provides.
