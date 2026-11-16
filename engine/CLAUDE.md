# The engine: rules for contributors

The workspace tree, its merge, and its storage: the `sval-core` crate,
consumed by the desktop browser as WASM and later by the iOS and Android
apps. Run the commands below from `engine/`; paths in `docs/` are from the repository root.

## Where authority lives

Read §5, §6 and §8.3 of `docs/superpowers/specs/2026-09-24-sval-browser-design.md`
before changing anything structural. A decision record in `docs/decisions/`
overrides the spec where they differ; cite it by number. If code and spec
disagree, one of them is a bug: say which. Every decision gets a record,
numbered and written as `docs/decisions/README.md` describes.

## Hard rules

1. **No CRDT.** Each node carries four independently-timestamped facts:
   content, placement, lifecycle and appearance. Merge is a last-writer-wins
   max over each group separately (decision 0008, spec §5.3). Do not
   reintroduce a history-bearing format, and do not add compaction: file size
   is bounded by the tree, never by edit count.
2. **No browser APIs, and no direct platform I/O outside `store`.** Everything
   goes through `StorageProvider`. This is what makes one crate serve three
   platforms.
3. **WASM has no filesystem and no network**, so a provider must be
   satisfiable by a host-supplied shim.
4. **Never compile this crate into Gecko.** One WASM artifact serves every
   desktop platform.
5. **Closing a tab deletes the node.** `Document::remove` removes the record:
   no closed state, no tombstone, no retention window, no marker. Visibility
   is presence in `nodes`. Sval keeps no history of closed tabs: Firefox's own
   recently-closed list does, locally. A closed record kept forever was
   rejected (spec §5.4); do not reintroduce one, nor `retention`, in the tree
   document. Auto-archived tabs go to the separate `archive` document, which
   only adds entries and expires them itself (decision 0136); nothing in it
   becomes a tree node by merging.

   `Lifecycle` stays one of the four fact groups because a node's state
   (`pinned`, and whatever a later build adds beside it) lives there. The
   groups never compete: renaming, moving, pinning and recolouring are
   unrelated acts, and one shared timestamp would lose a rename to an
   unrelated pin. That is why `Appearance` (colour, emoji, a tab's label) is
   its own group (spec §5.1).

6. **Preserve unknown fields** when rewriting a file, or an older build silently
   deletes data a newer one wrote.
7. **Tests assert behaviour, not beliefs.** A convergence test runs the merge.
8. **Repair never runs inside `merge`.** `tree::repair_unreachable_ancestry`
   lives on the read path only. Inside `merge` it would stamp a local clock
   reading into synced data and make merge output device-dependent.
9. **The tie-break compares canonical JSON, never the node id.** On an equal
   timestamp within a fact group, serialise that group through a value map so
   keys sort alphabetically, and compare those bytes, never raw struct
   serialisation. Raw struct order makes an older and a newer build pick
   opposite winners on the same tie.
10. **Fact timestamps are corrected wall-clock time, accepted as-is.** The
    host stamps with the wall clock minus the difference Remote Settings
    measures against its server, following the monotonic clock between
    readings (decision 1714, spec §5.3). The crate takes each `now` as it is
    given. Do not "improve" timestamps into logical or hybrid clocks: a
    logical clock would not survive the WASM host shim boundary cleanly, and a
    wrong clock is the host's to correct. This rule governs fact timestamps in
    conflict resolution; a clock reading stuck in synced bookkeeping (a
    watermark) may be bounded on read (decision 0135). Pulling a device's own
    unpublished stamps back when its first time reading arrives runs on the
    read path, never inside `merge` (rule 8, decision 1714).
11. **Refuse a file whose major schema version exceeds ours.** Never guess at an
    unknown major version: stop syncing that file and tell the user to update.
12. **`BTreeMap`, never `HashMap`**, for every map that round-trips through
    serialization. The canonical-JSON tie-break and every test that compares
    documents by JSON depend on it: a `HashMap`'s iteration order is not
    deterministic.
13. **Absence is decided per group, against that group's own writer.** Every
    document carries `written_at`, `written_by` and `seen`; every fact group
    carries `_by` beside its `_at` (spec §5.4). A node present on one side of a
    merge only is kept exactly when it is news to the side that lacks it. It is
    news when *any* group's writer has no watermark on that side, or one older
    than that group's timestamp (decision 0014).

    - A watermark is evidence only about the device it names (decision 0015).
    - Both halves evaluate the same predicate about the *lacking* side. That
      symmetry is the convergence guarantee.
    - Unattributed is news, and any one group being news keeps the node
      (decisions 0016, 0017).
    - The touch stamp (`touched_at`/`touched_by`) is judged exactly like a
      group, unwritten included. It holds no value, so it is the way to make
      work inside a node an edit to the node (decision 0106).

    Do not reduce this to a per-file verdict (spec §5.4 scenario 3). Stamp
    `written_at` only when a write happens, after `sync`'s
    unchanged-document check.

    **The write decision compares shared state only:**
    `Document::shared_state_json`, nodes plus document-level `extra`, with
    `written_at`, `written_by` and `seen` excluded. A watermark may be
    published late (decision 0018).

## Comments

`CONTRIBUTING.md`'s "Comments" section sets the rules. A decision a future
contributor must not undo ("X was rejected, because Y") belongs in the spec or
this file.

## Commands

CI runs this verification set; run the same commands
locally.

    cargo test --all-targets
    cargo test --all-targets --features wasm
    cargo test --all-targets --no-default-features
    cargo clippy --all-targets -- -D warnings
    cargo clippy --all-targets --features wasm -- -D warnings
    cargo clippy --target wasm32-unknown-unknown --features wasm -- -D warnings
    cargo fmt --check
    cargo build --target wasm32-unknown-unknown
    cargo build --target wasm32-unknown-unknown --features wasm
    RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --features wasm --target wasm32-unknown-unknown

`clippy` needs `--all-targets`, or it lints only the lib target and misses
the test code, where most of this crate's code lives. A feature-gated
deliverable needs its feature in the set: `src/wasm.rs`, the file the browser
consumes, compiles only with `--features wasm`. Both wasm clippy lines are
needed, because only the native `cargo clippy --all-targets --features wasm`
lints `wasm.rs`'s `#[cfg(test)]` modules with the feature on.

`engine/rust-toolchain.toml` pins the compiler and lists the
wasm32-unknown-unknown target, so rustup installs both on first use. The
browser consumes this crate as WASM (spec §8.3), so a change that passes only
native `cargo test` is not verified. For the same reason the crate never calls
`std::time::SystemTime` or `Uuid::new_v4()`, which need host support that
target lacks (see `Timestamp` in `src/types.rs`).

**`wasm-bindgen-cli` in `.forgejo/docker/Dockerfile` must match** this
crate's `wasm-bindgen` exactly. A mismatch builds, then fails at
instantiation.

Mutation testing runs in CI. It mutates every function a pull
request changes, and the nightly mutates the whole crate on Sundays, both
through `scripts/engine-mutants.sh`, which fails on a mutant no test fails.
`.cargo/mutants.toml` holds the settings every run shares (the `wasm`
feature, whose file holds tests of the sync rules a host reaches through it,
and optimised dependencies) and the equivalent mutants, each with its reason.
Run it on a branch's change before pushing, or on one file:

    git diff --relative main... -- . > ../.scratch/change.diff
    ../scripts/engine-mutants.sh --in-diff "$PWD/../.scratch/change.diff"
    ../scripts/engine-mutants.sh -f src/merge.rs

A surviving mutant is either equivalent (no behaviour changes), which goes in
`exclude_re` with its reason, or a missing test; write the test.
