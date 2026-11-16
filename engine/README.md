# Sval

A web browser with workspaces that actually sync.

Nested groups of tabs, carrying live tab state, converging across every device
you own — through storage **you** choose, with no server in the middle.

## Why it exists

The gap is precise: everyone who built workspaces skipped sync, and everyone who
built sync skipped workspaces.

## The engine

`engine/` is a Rust library: the workspace tree, the merge that makes devices
agree, encryption, and storage. No browser code. It compiles to WASM for the
desktop browser, and later to native for iOS and Android. The rest of this
repository is the browser, a fork of Firefox ESR that hosts it.

## Read these, in this order

1. **`docs/superpowers/specs/2026-09-24-sval-browser-design.md`** — the design.
   Start at §5 (the data model) and §6 (sync and storage). Its §15 lists what
   it asserts and nothing yet delivers.
2. **`docs/decisions/`** — the decisions, each with its reason. A decision
   overrides the design spec where they differ.
3. **`engine/CLAUDE.md`**, and the repository's `CONTRIBUTING.md` — the rules that
   bind anyone working in each. Each rule exists because ignoring it cost
   something.

## Building

The engine needs a Rust toolchain. `engine/rust-toolchain.toml` pins it, and
`engine/CLAUDE.md` lists the commands that verify a change.
`scripts/build-core-wasm.sh` builds it for the browser; the repository's
`README.md` covers building the browser.
