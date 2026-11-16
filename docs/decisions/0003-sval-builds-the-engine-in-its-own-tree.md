# 0003. Sval builds the engine in its own tree

**Status:** Accepted on 2026-10-20.

## Context

Sval consumes the engine as WASM built from the Rust crate in `engine/`. A sync
bug has to be traceable to the engine code that ran, and a Sval commit has to
build the same engine every time.

## Decision

The engine is built from `engine/` in the same commit as the browser.
`scripts/build-core-wasm.sh` builds it as the checkout stands, and passes in
the git tree id of `engine/`, with `-dirty` for uncommitted changes. The engine
reports it through `engineVersion()`, which Sval logs at engine start
(`docs/host-contract.md` §11).

## Consequences

A Sval commit reproduces its engine, and an engine change reaches Sval in the
pull request that makes it, tested by the same CI run. CI publishes each
engine to the package registry under `scripts/engine-key.sh`'s key, which
hashes the tree of `engine/` with `rust-toolchain.toml`, `build-core-wasm.sh` and
the wasm-bindgen-cli version, so an engine that has not changed is not built
again.
