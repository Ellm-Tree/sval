# 0097. Sval changes Gecko's native code when a feature needs it

**Status:** Accepted on 2026-10-12.

## Context

Some features need native changes. Blocking needs list ids that come from data
in Gecko's content classifier. Page rules need adblock-rust's cosmetic API
exposed across its Rust and C++ boundary. Avoiding a native patch would mean
counting ads as tracking content, and parsing every filter list twice, in
Gecko and again in a WASM copy.

A cap on the number of Mozilla patches would push Sval into workarounds built
to avoid a patch. Sval's component directory
([0046](0046-sval-owns-a-component-directory.md)) already keeps the count low
by construction.

## Decision

- **Sval patches Gecko's C++ and Rust whenever a feature needs it.**
- There is no patch budget. A patch is judged on its own merits: Sval
  patches Mozilla's code when patching is the right fix, and never routes
  around a patch with a workaround.
- Each patch stays as small as it can be, with the logic in added files, and
  says why in its header (`patches/`).
- The engine is never compiled into Gecko. It reaches the chrome as WASM so one
  artifact serves every desktop platform.

## Consequences

- A native patch moves the Gecko key (`scripts/gecko-key.sh`). Artifact
  builds see it only after `gecko.yml` has compiled and published that key,
  so a native change costs a Gecko compile per platform.
- The annual ESR rebase has more to carry. Keep native patches in a shape the
  next rebase can drop when Mozilla ships the same thing.
