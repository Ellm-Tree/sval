// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The workspace tree, the merge that makes devices agree on it, and the
//! storage it lives in.
//!
//! No browser APIs and no platform I/O: the same crate serves the desktop fork
//! (compiled to WASM), and later the iOS and Android apps. It never reads the
//! ambient environment. Timestamps and new node ids are passed in, because
//! WebAssembly has neither a clock nor randomness of its own, and a core that
//! reaches for either cannot be driven by a host or tested deterministically.
//!
//! # The model
//!
//! A [`types::Document`] is a flat map of [`types::Node`]s keyed by UUID. The
//! tree is expressed by parent pointers plus a fractional sort key, so moving
//! one node never renumbers its siblings.
//!
//! Every node carries **independently-timestamped facts**:
//!
//! | group | fields | timestamp |
//! |---|---|---|
//! | content | name, icon, url | `content_at` |
//! | placement | parent, order | `placement_at` |
//! | lifecycle | pinned | `lifecycle_at` |
//! | appearance | color, emoji | `appearance_at` |
//!
//! A node also carries a **touch stamp**, `touched_at` and `touched_by`, which
//! holds no value: it records that work was done inside the node, and counts
//! toward the absence rule like a group does (decision 0106).
//!
//! [`merge::merge`] decides each group **separately**: the side whose timestamp
//! for that group is greater wins that group outright. Each group is a
//! last-writer-wins register, and a max over a total order is commutative,
//! associative and idempotent. Any two devices that have seen the same set of
//! records therefore agree, whatever order those records arrived in.
//!
//! # Why a timestamp per group
//!
//! Renaming a tab, moving it, pinning it and recolouring it are unrelated
//! acts. With one timestamp per record they compete for the same slot, and the
//! later act silently overwrites the other's fields:
//!
//! 1. Rename a tab on device A.
//! 2. Pin it on device B, which has not yet seen the rename.
//!
//! Under one timestamp, B's pin is later, so B's whole record wins and A's
//! rename is lost, although nobody renamed the tab on B. With split facts the
//! tab ends up pinned and carrying the rename, with no special case (spec
//! §5.1).
//!
//! See `merge::tests::a_rename_on_one_device_survives_a_pin_on_another` and
//! `merge::tests::a_move_on_one_device_survives_a_rename_on_another`.
//!
//! # How a deletion propagates without a tombstone
//!
//! Closing a tab removes the node ([`types::Document::remove`]). Nothing is
//! left in its place: Firefox's own recently-closed list keeps local history
//! of closed tabs, and Sval keeps none (spec §5.4). What stops a peer whose
//! file predates the deletion from re-inserting the node is a **version
//! vector**: every document records its own `written_at` and, in `seen`, the
//! `written_at` of the newest file it has incorporated from each peer. A node
//! present on one side of a merge only is kept exactly when it is news to the
//! side that lacks it. [`merge::merge`] states the rule and its one accepted
//! resurrection.
//!
//! # Invariants
//!
//! Each of these has a test that fails if it is broken. Read the linked item
//! before changing it.
//!
//! - **Ties break on canonical JSON, never on node id.** Otherwise two devices
//!   editing a node within one clock tick each keep their own value forever.
//!   Canonical means keys in alphabetical order. Struct declaration order would
//!   make an older and a newer build pick opposite winners.
//! - **Repair runs on the read path, never inside `merge`.** A local clock
//!   reading stamped into synced data makes merge output depend on which device
//!   ran it, and lets an automatic repair overwrite a newer edit.
//!   [`tree::repair_unreachable_ancestry`] keeps the stamp of the placement it
//!   repairs and reads no clock.
//! - **Closing deletes the node, and absence is decided per group.** A
//!   file-level verdict cannot tell "deleted here" from "never seen here" when
//!   both arrive in the same peer file, which is why [`merge::merge`] judges
//!   each group against its own writer's watermark.
//! - **Unrecognised fields live in per-group buckets** and move with their
//!   group. One document-wide bucket has no timestamp, so version-skewed
//!   devices would diverge permanently, and a field belonging to one group
//!   would not travel when that group was replaced. A whole *group* a build
//!   cannot name is an unrecognised key at the node's level, so [`types::Node`]
//!   carries a bucket of its own. It and the document's bucket merge by greater
//!   canonical bytes, there being no timestamp at either level to arbitrate
//!   with.
//! - **`BTreeMap`, never `HashMap`.** Serialisation must be deterministic: the
//!   tiebreak and every test that compares documents by JSON depend on it.
//!
//! # Where to start reading
//!
//! [`types`] for the model, [`merge`] for the algorithm, [`tree`] for traversal
//! and the read-time repair, [`crypto`] and [`store`] for what protects and
//! carries a document to and from a `StorageProvider`, and [`sync`] for the
//! loop that ties them together into one call a host makes.

pub mod archive;
pub mod crypto;
mod hex;
pub mod merge;
pub mod pairing;
pub mod pins;
pub mod privacy_pass;
pub mod store;
pub mod sync;
pub mod tree;
pub mod types;

#[cfg(test)]
mod archive_tests;

#[cfg(test)]
mod favorites_tests;

#[cfg(test)]
mod history_tests;

#[cfg(test)]
mod local_tests;

#[cfg(test)]
mod sync_schedule_tests;

/// The `wasm32-unknown-unknown` boundary: an opaque handle plus a
/// host-supplied storage shim. Behind a feature so native builds and
/// `cargo test` never carry `wasm-bindgen` or `js-sys` (see `Cargo.toml`).
#[cfg(feature = "wasm")]
pub mod wasm;

/// The iOS and Android boundary: [`wasm`]'s surface as UniFFI exports.
#[cfg(feature = "ffi")]
pub mod ffi;

#[cfg(feature = "ffi")]
uniffi::setup_scaffolding!();

/// Schema version written into every file.
///
/// Bump `MAJOR` only for a change that an older build cannot safely read; it
/// will refuse the file rather than guess. Additive changes bump `MINOR` and
/// stay readable because unknown fields survive a round trip.
///
/// `2`: a custom colour, an object, in `Appearance::color`, and
/// `Appearance::transparency` (decision 0057). A 1.x build parses
/// `Appearance::color` as a string and would fail on an object colour, so it
/// refuses a 2.x file instead (rule 11), and never reads or rewrites one.
/// This build reads every 1.x file.
pub const SCHEMA_MAJOR: u32 = 2;
/// The minors of major 1, each in every 2.x file:
///
/// `1`: the version vector (`written_at`, `written_by`, `seen`) and per-group
/// attribution (`content_by`, `placement_by`, `lifecycle_by`). Additive, so an
/// older build still reads these files. It sees no attribution, which the
/// absence rule treats as news and therefore never deletes (spec §5.4).
///
/// `2`: the `appearance` fact group with `appearance_at` and `appearance_by`
/// (spec §5.1), and a node-level unrecognised-field bucket (`Node::extra`)
/// alongside the per-group ones. Additive forward: this build reads a 1.1 file
/// as a node with no appearance. Additive backward from this version on: an
/// entire fact group a build cannot name is an unrecognised key at the node's
/// own level, which no per-group bucket can hold, so the node-level bucket
/// carries the *next* group Sval adds through a build that predates it. A 1.1
/// build has no such bucket and drops `appearance` when it rewrites a 1.2 file.
///
/// `3`: the optional `agent` mark on a workspace node (agent-control spec
/// §3.5). Additive both ways: a 1.2 build keeps it in `Node::extra` and writes
/// it back verbatim.
///
/// `4`: the `setting` node kind and `Content::value` (settings-sync spec §3).
/// Additive both ways: a 1.3 build holds a setting as an unknown kind and
/// carries `value` in `Content::extra`, writing both back verbatim.
///
/// `5`: the touch stamp, `touched_at` and `touched_by` on a node (decision
/// 0106, spec §5.4). Additive both ways: written only once a node is touched,
/// and a 1.4 build keeps both keys in `Node::extra` and writes them back
/// verbatim. A 1.4 build cannot read the stamp, so on such a build a delete
/// still wins over it until the build updates.
///
/// `6`: the `favorite`, `folder` and `separator` kinds, `Content::guid` and
/// `Lifecycle::home_order` (favorites-native spec §16, decision 0108). Additive
/// both ways: a 1.5 build holds the kinds as unknown and the fields in its
/// group buckets, writing all of them back verbatim.
///
/// `7`: the `visit` and `shard` kinds and `Content::visit` (history-sync spec
/// §3, decision 0109). Additive both ways: a 1.6 build holds the kinds as
/// unknown and the field in its content bucket, writing both back verbatim.
///
/// `8`: the `split` kind and `Content::shares` (split-view spec §5). Additive
/// both ways: a 1.7 build holds a split as an unknown kind, leaving it and
/// its panes unrepaired, and carries `shares` in its content bucket.
///
/// `9`: the `archived` kind, `Content::archived`, `Lifecycle::restored` and
/// `Lifecycle::auto_archive` (idle-tab archive spec §6.1, decision 0136).
/// Additive both ways: a 1.8 build holds an entry as an unknown kind and the
/// fields in its group buckets, writing all of them back verbatim. It reads
/// no workspace's choice, and archives nothing.
///
/// `10`: `Lifecycle::pin_scope`, the workspaces a pin shows in (pins spec
/// §7, decision 0137). Additive both ways: a 1.9 build carries it in its
/// lifecycle bucket and writes it back verbatim, and shows every pin in
/// every workspace.
///
/// `11`: `Visit::workspace`, the workspace a visit was made in (decision
/// 1287). Additive both ways: a 1.10 build carries it in the visit's own
/// bucket and writes it back verbatim, and shows every visit in every
/// workspace.
///
/// `12`: `Content::local`, an address that stays on this device (decision
/// 1372). Only this device's profile copy holds it.
///
/// `13`: the pins root, `pins________`, a root of the favorites document
/// (pins-root spec §4, decision 0137). A 1.12 build reads it as a stranded
/// folder and files it under Favorites.
///
/// Major 2 starts again at minor `0`.
pub const SCHEMA_MINOR: u32 = 0;

/// The engine code this build was compiled from, as `engineVersion()`
/// reports it across the wasm boundary (`docs/host-contract.md` §11).
///
/// Set at compile time from `SVAL_ENGINE_TREE`, which Sval's
/// `scripts/build-core-wasm.sh` exports: the git tree id of `engine/`, with
/// `-dirty` appended when it built uncommitted changes. A build that does not
/// set it, such as a plain `cargo build`, reports `unknown`. `option_env!`
/// records the variable in rustc's dep-info, so Cargo rebuilds when its value
/// changes and a stale id is never reported.
pub const ENGINE_VERSION: &str = engine_version_from(option_env!("SVAL_ENGINE_TREE"));

/// What [`ENGINE_VERSION`] reports for a given `SVAL_ENGINE_TREE`. An empty
/// value counts as unset, because `SVAL_ENGINE_TREE= cargo build` is how a
/// shell clears an exported variable for one command.
const fn engine_version_from(commit: Option<&'static str>) -> &'static str {
    match commit {
        Some(commit) if !commit.is_empty() => commit,
        _ => "unknown",
    }
}

#[cfg(test)]
mod engine_version_tests {
    use super::*;

    #[test]
    fn an_unset_commit_reports_unknown() {
        assert_eq!(engine_version_from(None), "unknown");
    }

    #[test]
    fn an_empty_commit_reports_unknown() {
        assert_eq!(engine_version_from(Some("")), "unknown");
    }

    #[test]
    fn a_commit_is_reported_verbatim() {
        let sha = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(engine_version_from(Some(sha)), sha);
        let dirty = "0123456789abcdef0123456789abcdef01234567-dirty";
        assert_eq!(engine_version_from(Some(dirty)), dirty);
    }

    /// The constant the boundary exports follows the build's environment: the
    /// tree id when the build set one, `unknown` for a plain `cargo test`.
    #[test]
    fn the_built_version_follows_the_build_environment() {
        match option_env!("SVAL_ENGINE_TREE") {
            Some(commit) if !commit.is_empty() => assert_eq!(ENGINE_VERSION, commit),
            _ => assert_eq!(ENGINE_VERSION, "unknown"),
        }
    }
}
