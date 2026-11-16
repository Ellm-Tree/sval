# 0062. Windows needs no Windows to build; a Windows VM only runs the suites

**Status:** Accepted on 2026-10-07.

## Context

`--enable-artifact-builds` implies `--disable-compile-environment`, so no MSVC
and no Windows SDK are needed, and the artifact job is chosen from the target
(`artifacts.py` keys on `XP_WIN` and `TARGET_CPU`). A cross-target configure
stops only at `Cannot find wine`, an apt package on Linux.

## Decision

Building needs no Windows. Running browser-chrome needs a real desktop
session, so `windows-test` runs on a Windows 11 VM and builds natively there.
The engine is built once on Linux and consumed by every platform as an
artifact.

## Consequences

Every platform tests the same engine bytes, and the browser's artifact build
on Windows compiles no Rust and needs no MSVC linker. The win64 Gecko package
and its NSIS installer are cross-compiled on Linux.
