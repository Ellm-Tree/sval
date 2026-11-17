// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Shared data types for workspaces, tabs, and their identifiers.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub type NodeId = Uuid;

/// The namespace every setting id is derived under. Fixed forever: iOS and
/// Android must derive the same ids (settings-sync spec §2).
pub const SETTING_NAMESPACE: Uuid = Uuid::from_u128(0x6b1c2f4e_8a3d_4e7b_9c10_2f4a6d8e0b13);

/// The node id of setting `key`: UUIDv5 under [`SETTING_NAMESPACE`].
///
/// Deterministic, so two devices that each set a key for the first time write
/// the same node rather than two that both claim the key. A pure hash, so it
/// reads no clock and no entropy, which `wasm32-unknown-unknown` lacks.
pub fn setting_id(key: &str) -> NodeId {
    Uuid::new_v5(&SETTING_NAMESPACE, key.as_bytes())
}

/// The namespace every favorite's node id is derived under. Fixed forever,
/// and distinct from [`SETTING_NAMESPACE`], so a setting key and a favorite's guid
/// with the same text never name the same node (favorites-native spec §16).
pub const FAVORITE_NAMESPACE: Uuid = Uuid::from_u128(0x3e9a7c51_0d24_4f86_b1e3_5a7c9e2d4f60);

/// The guids of the favorites document's roots: Favorites, Favorites Menu
/// and Other Favorites, named as Places names the same roots
/// (favorites-native spec §5.1), and the pins root (decision 0137). They are
/// fixed, so every device derives the same root ids.
pub const FAVORITE_ROOT_GUIDS: [&str; 4] =
    ["toolbar_____", "menu________", "unfiled_____", PINS_GUID];

/// The root the pins row reads: a pin is a node under it, at any depth, and
/// its children's order is the row's (pins-root spec §4).
pub const PINS_GUID: &str = "pins________";

/// The root a stranded favorite is filed under: Favorites, the one root Sval
/// shows (decision 0123).
pub const STRANDED_FAVORITES_GUID: &str = "toolbar_____";

/// The node id of the favorite, folder or separator whose guid is `guid`:
/// UUIDv5 under [`FAVORITE_NAMESPACE`]. A host mints a favorite's guid once
/// and the node carries it, so every device names it alike.
pub fn favorite_id(guid: &str) -> NodeId {
    Uuid::new_v5(&FAVORITE_NAMESPACE, guid.as_bytes())
}

/// Whether `id` is one of the Favorites roots, which sit at the top with no
/// parent and are never repaired.
pub fn is_favorite_root(id: NodeId) -> bool {
    FAVORITE_ROOT_GUIDS.iter().any(|g| favorite_id(g) == id)
}

/// The namespace every visit's node id is derived under. Fixed forever: every
/// platform derives the same id for one visit (history-sync spec §3).
pub const VISIT_NAMESPACE: Uuid = Uuid::from_u128(0x9d47e2b0_61c8_4a35_8f1e_7b3d5c9a2e84);

/// The namespace every history shard's index node id is derived under.
pub const SHARD_NAMESPACE: Uuid = Uuid::from_u128(0x2c85f1a6_d93e_4b07_a4c2_e6190b7d58f3);

/// The document that lists every history shard (history-sync spec §2).
pub const HISTORY_INDEX: &str = "history-index";

/// The node id of the visit `device` made to `url` at `visited_at`: UUIDv5
/// under [`VISIT_NAMESPACE`] of the device's sixteen bytes, the time as eight
/// big-endian bytes, then the URL's bytes. Every device derives the same id,
/// so a visit two devices both hold is one node (history-sync spec §2).
pub fn visit_id(device: crate::store::DeviceId, url: &str, visited_at: Timestamp) -> NodeId {
    let mut name = Vec::with_capacity(24 + url.len());
    name.extend_from_slice(device.as_bytes());
    name.extend_from_slice(&visited_at.to_be_bytes());
    name.extend_from_slice(url.as_bytes());
    Uuid::new_v5(&VISIT_NAMESPACE, &name)
}

/// The node id of history shard `name`'s entry in [`HISTORY_INDEX`]: UUIDv5
/// under [`SHARD_NAMESPACE`].
pub fn shard_id(name: &str) -> NodeId {
    Uuid::new_v5(&SHARD_NAMESPACE, name.as_bytes())
}

/// The namespace every Archive entry's id is derived under. Fixed forever:
/// every platform derives the same entry for one archived tab (idle-tab
/// archive spec §3.1).
pub const ARCHIVE_NAMESPACE: Uuid = Uuid::from_u128(0x5f3b9d27_c4e1_4a68_9b0d_8e2f6a1c7d45);

/// The document the Archive syncs under (decision 0136).
pub const ARCHIVE: &str = "archive";

/// The id of the Archive entry for tab `tab`: UUIDv5 under
/// [`ARCHIVE_NAMESPACE`] of the tab id's bytes. Two devices that archive the
/// same tab at once write one entry, and their copies merge.
pub fn archived_id(tab: NodeId) -> NodeId {
    Uuid::new_v5(&ARCHIVE_NAMESPACE, tab.as_bytes())
}

/// Milliseconds since the Unix epoch, from the host's corrected wall clock:
/// the wall clock minus the difference a time server measured (decision
/// 1714). The crate takes the value as it is given.
///
/// **Nothing in this crate reads the clock, or generates ids, itself.**
/// `std::time::SystemTime` panics on `wasm32-unknown-unknown`, and this crate
/// is loaded there as a host-driven library (spec §8.3) with no ambient clock
/// or entropy source of its own. A JS host owns both, and coarsens the clock
/// for Spectre mitigation (spec §5.3). Every constructor that needs a
/// timestamp or a fresh id takes `now: Timestamp` and `id: NodeId` as
/// parameters, as [`crate::sync::sync_to`] does for the `written_at` it stamps.
/// A plain argument keeps every function pure and testable with fixed values.
/// Native callers read `std::time::SystemTime` and `uuid::Uuid::new_v4()` at
/// the call site, outside this crate.
pub type Timestamp = u64;

/// Whether a stamp has never been written, for `skip_serializing_if`.
fn is_unwritten(at: &Timestamp) -> bool {
    *at == 0
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("file schema major version {major} is newer than this build supports ({supported})")]
    SchemaTooNew { major: u32, supported: u32 },
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("key must be 32 bytes, got {got}")]
    InvalidKeyLength { got: usize },
    #[error("encryption failed")]
    EncryptionFailed,
    /// The host's entropy source failed at this call (`docs/host-contract.md`
    /// §2).
    #[error("no entropy source")]
    NoEntropy,
    #[error("decryption failed: wrong key or tampered data")]
    DecryptionFailed,
    /// Bytes that opened under the key, so are exactly the bytes sealed, but
    /// are not UTF-8 text. The key and the data are sound, so this is not
    /// [`Error::DecryptionFailed`].
    #[error("not valid utf-8")]
    NotUtf8,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("no file at path {0}")]
    NotFound(String),
    #[error("storage lock poisoned")]
    Poisoned,
    /// The code entered does not open this pairing file: it was mistyped, or
    /// the file was sealed under a different code. The AES-GCM tag is what
    /// tells these apart from a file that merely expired (spec §6.7).
    #[error("pairing code does not match")]
    BadPairingCode,
    /// A pairing file that is not valid JSON in the expected shape, has an
    /// unsupported schema, or has a field that fails to decode (bad hex, wrong
    /// length). [`Error::BadPairingCode`] is a well-formed file this code does
    /// not open.
    #[error("malformed pairing file")]
    MalformedPairingFile,
}

impl Error {
    /// A stable name for this kind of failure. Hosts branch on this; the
    /// message is for people and may be reworded.
    pub fn code(&self) -> &'static str {
        match self {
            Error::SchemaTooNew { .. } => "schema_too_new",
            Error::Json(_) => "json",
            Error::InvalidKeyLength { .. } => "invalid_key_length",
            Error::EncryptionFailed => "encryption_failed",
            Error::NoEntropy => "no_entropy",
            Error::DecryptionFailed => "decryption_failed",
            Error::NotUtf8 => "not_utf8",
            Error::Io(_) => "io",
            Error::NotFound(_) => "not_found",
            Error::Poisoned => "poisoned",
            Error::BadPairingCode => "bad_pairing_code",
            Error::MalformedPairingFile => "malformed_pairing_file",
        }
    }
}

/// What a node is. Adding a kind is an additive change (spec §5.5): a build
/// that does not recognise a kind holds the node as [`NodeKind::Unknown`],
/// writes the name back verbatim, and never repairs it or anything beneath
/// it. Every kind carries the same four fact groups, so an older build can
/// still merge a node it cannot interpret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeKind {
    Workspace,
    Group,
    Tab,
    /// Tabs shown side by side in one window, its children being the panes
    /// in their sibling order, the first leftmost (split-view spec §5.1). It
    /// sits in a workspace or a group, and holds tabs only, at most
    /// [`SPLIT_MAX_PANES`] of them on a local edit ([`crate::tree::move_node`]).
    Split,
    /// One synced setting, in the `settings` document. A root by nature: it
    /// has no parent and is never drawn (settings-sync spec §3).
    Setting,
    /// A favorite, in the `favorites` document: a page with a URL.
    Favorite,
    /// A Favorites folder. The roots are folders with no parent
    /// ([`is_favorite_root`]).
    Folder,
    /// A separator between favorites.
    Separator,
    /// One visit to a page, in a week's history document. A root by nature,
    /// as a setting is: it has no parent and is never drawn as a tree.
    Visit,
    /// One history shard's entry in [`HISTORY_INDEX`], also a root.
    Shard,
    /// One tab Sval archived for being idle, in the [`ARCHIVE`] document
    /// (decision 0136). A root, as a visit is. It is never a tab: no merge
    /// moves a node between documents or changes its kind.
    Archived,
    /// A kind written by a newer build, held under the name it arrived with.
    Unknown(String),
}

impl NodeKind {
    /// Whether this kind lives in the `favorites` document.
    pub fn is_favorite_kind(&self) -> bool {
        matches!(
            self,
            NodeKind::Favorite | NodeKind::Folder | NodeKind::Separator
        )
    }

    fn as_str(&self) -> &str {
        match self {
            NodeKind::Workspace => "workspace",
            NodeKind::Group => "group",
            NodeKind::Tab => "tab",
            NodeKind::Split => "split",
            NodeKind::Setting => "setting",
            NodeKind::Favorite => "favorite",
            NodeKind::Folder => "folder",
            NodeKind::Separator => "separator",
            NodeKind::Visit => "visit",
            NodeKind::Shard => "shard",
            NodeKind::Archived => "archived",
            NodeKind::Unknown(name) => name,
        }
    }
}

impl Serialize for NodeKind {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for NodeKind {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let name = String::deserialize(deserializer)?;
        Ok(match name.as_str() {
            "workspace" => NodeKind::Workspace,
            "group" => NodeKind::Group,
            "tab" => NodeKind::Tab,
            "split" => NodeKind::Split,
            "setting" => NodeKind::Setting,
            "favorite" => NodeKind::Favorite,
            "folder" => NodeKind::Folder,
            "separator" => NodeKind::Separator,
            "visit" => NodeKind::Visit,
            "shard" => NodeKind::Shard,
            "archived" => NodeKind::Archived,
            _ => NodeKind::Unknown(name),
        })
    }
}

/// The most tabs a local edit puts in one split, side by side (split-view
/// spec §5.1). A merge can leave more, which a host draws in chunks of this
/// many.
pub const SPLIT_MAX_PANES: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Schema {
    pub major: u32,
    pub minor: u32,
}

/// The descriptive fact group: what a node is called and where it points.
/// Timestamped independently as `content_at` so an edit never competes with a
/// concurrent close or move for the same slot (spec §5.1).
///
/// `extra` holds fields a newer build wrote to *this* group that this build
/// doesn't recognise. It is replaced atomically with the rest of the group on
/// merge, and is part of this group's canonical bytes for the tie-break
/// (spec §5.1, §5.3).
///
/// **Each fact group is a nested object on disk.** A `#[serde(flatten)]`
/// catch-all map behaves correctly only as the sole catch-all at its JSON
/// level. Sibling catch-alls flattened into one object each capture the
/// others' named fields, so every key is written once per catch-all. Nested,
/// a group's catch-all competes only with that group's own named fields.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Content {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// A setting's value (settings-sync spec §3). Absent on every other kind,
    /// and absent on a setting that was reset to its default: "reset" must
    /// sync as a change, so it is a node without a value, never no node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    /// A favorite's guid, which the host minted and keys its favorite by
    /// (favorites-native spec §3). A node id derived from it cannot be
    /// turned back into it, so the node carries it. Absent on every other
    /// kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guid: Option<String>,
    /// When a favorite, folder or separator was added (favorites-native spec
    /// §8.4). Written once by [`Document::add_favorite`] and kept by every
    /// later content write, so it survives a rename where `content_at` does
    /// not. Absent on every other kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<Timestamp>,
    /// What a visit node records beyond its URL and title, which are `url`
    /// and `name` (history-sync spec §3). Absent on every other kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visit: Option<Visit>,
    /// What an Archive entry records beyond the tab's URL, title and icon,
    /// which are `url`, `name` and `icon` (idle-tab archive spec §3.1).
    /// Absent on every other kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived: Option<Archived>,
    /// A split's pane widths, one percentage per pane in pane order, summing
    /// to 100 (split-view spec §5.1). Absent means equal widths. Content,
    /// beside the split's name, because a host writes the whole list when the
    /// user lets go of a divider, and it never competes with a move. Absent
    /// on every other kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shares: Option<Vec<f64>>,
    /// Whether the node's address may not leave this device, so the node is
    /// held in this device's profile copy only (decision 1372). The host sets
    /// it on every write that carries an address; the engine never reads an
    /// address to decide it. Content, because the address decides it, so it
    /// is replaced with the address. [`crate::sync::sync_to`] keeps a local
    /// node out of every shared file and drops the mark from every file but
    /// the profile copy.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub local: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// The facts of one visit that its node id cannot be turned back into: when
/// it happened, how, and on which device. Inside [`Content`], since a visit
/// is written once and only its title changes after.
///
/// `extra` holds fields a newer build wrote here, so they travel with the
/// rest (rule 6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Visit {
    /// Milliseconds since the Unix epoch.
    pub at: Timestamp,
    /// Places' transition type (`PlacesUtils.history.TRANSITIONS`).
    pub transition: u32,
    /// The device that made the visit.
    pub device: crate::store::DeviceId,
    /// The workspace the visit was made in (decision 1287). Absent for a
    /// visit made in none, and for one made before visits recorded it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<NodeId>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Where an archived tab was and when it went, so a restore can put it back
/// (idle-tab archive spec §3.1). Inside [`Content`], written once when the
/// tab is archived.
///
/// No group is recorded: a tab in a group is never archived (idle-tab
/// archive spec §4.3).
///
/// `extra` holds fields a newer build wrote here, so they travel with the
/// rest (rule 6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Archived {
    pub tab: NodeId,
    /// The workspace the tab was in, and that workspace's name then.
    pub workspace: NodeId,
    #[serde(default)]
    pub workspace_name: String,
    /// The sibling the tab sorted after, and the one it sorted before. A
    /// pane names its split's neighbours.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<NodeId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<NodeId>,
    /// The split a pane was in. Absent for a tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split: Option<ArchivedSplit>,
    /// When the tab was archived.
    pub closed_at: Timestamp,
    pub device: crate::store::DeviceId,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// An archived pane's split: its id, and the pane's place among its panes,
/// from 0 at the left.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArchivedSplit {
    pub id: NodeId,
    pub pane: u32,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// The tree-position fact group: which node this hangs from, and where among
/// its siblings. Timestamped independently as `placement_at` (spec §5.1,
/// §5.2). Structure is parent pointers plus a fractional sort key, not child
/// lists, so two devices inserting between the same siblings never need to
/// renumber anyone else.
///
/// `extra` is this group's own unrecognised-field bucket (see [`Content::extra`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<NodeId>,
    #[serde(with = "fractional_index::stringify")]
    pub order: fractional_index::FractionalIndex,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// The state fact group: what state the node is in, as distinct from what it
/// says (`Content`) or where it sits (`Placement`). Timestamped independently
/// as `lifecycle_at` (spec §5.1).
///
/// `pinned` lives here because pinning is a state of the node. In `Content`,
/// pinning on one device would collide with a rename on another.
///
/// **A node is visible exactly when it is in `nodes`.** There is no closed
/// state: closing a tab is [`Document::remove`], which deletes the record
/// (spec §5.1, §5.4). This group holds the node's state so that `pinned`,
/// and whatever state a later build adds beside it, merges without competing
/// with a rename or a move.
///
/// `extra` is this group's own unrecognised-field bucket (see [`Content::extra`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Lifecycle {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
    /// A workspace whose tabs use a cookie jar of their own (isolated
    /// workspaces spec §2). It is the workspace's state, so it lives here
    /// beside `pinned`, where a rename or a recolour never competes with it.
    /// Absent reads as `false`: a file written before the field existed holds
    /// only shared workspaces.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub isolated: bool,
    /// A pinned favorite's place in the row of a profile written before the
    /// pins root, a fractional index in its string form (home-favorites spec
    /// §6). Only [`crate::pins::move_pins_to_root`] reads it, and clears it
    /// (pins-root spec §8).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_order: Option<String>,
    /// The workspaces a pin shows in, by workspace node id (pins spec §7).
    /// Absent shows it in every workspace, those made later included.
    /// Lifecycle, beside `pinned`, because it is a state of the pin: a
    /// rename or a move never competes with it. A set, so its canonical JSON
    /// is one sorted array whichever order a host gave it in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_scope: Option<BTreeSet<String>>,
    /// A workspace's own choice for archiving idle tabs, one of
    /// [`crate::archive::CHOICES`] (idle-tab archive spec §5). Absent
    /// follows the global choice. Lifecycle, beside `isolated`, so it merges
    /// by its own timestamp and never competes with a rename.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_archive: Option<String>,
    /// An Archive entry a device has restored (idle-tab archive spec §3.1).
    /// The one write to an entry after it is added.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub restored: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// The look fact group: the colour, transparency and emoji a user chose for
/// a workspace or group, and the label a user gave a tab, as distinct from
/// what the node is called (`Content`). Timestamped independently as
/// `appearance_at` (spec §5.1).
///
/// Separate from `Content` for the reason `Lifecycle` is: in one group,
/// recolouring a workspace on one device while another renames it would lose
/// one of the two. A tab's `Content::name` follows its page's title on every
/// navigation, so a label in `Content` would lose to a navigation on another
/// device that had not seen it.
///
/// `color` is a preset's **token**, a string, or a custom OKLCH colour, an
/// object (decision 0057). A token lets a theme change repaint every node that
/// uses it. This crate stores whatever value it is handed. Which shapes and
/// ranges are valid is a presentation concern, checked at `crate::wasm`, the
/// boundary that can tell a host what it got wrong. A JSON value keeps a
/// colour this build cannot name through a round trip.
///
/// Every field is optional because a node need not have an appearance. The
/// group is `#[serde(default)]` on [`Node`], so a file without it loads with
/// the group empty (spec §5.1).
///
/// `extra` is this group's own unrecognised-field bucket (see [`Content::extra`]).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Appearance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<serde_json::Value>,
    /// How much of what is behind a workspace's window shows through its
    /// colour, from 0 (solid) to 1 (decision 0057).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transparency: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    /// The name a user gave a tab, shown in place of its page's title, which
    /// `Content::name` keeps following. Absent on a tab nobody renamed, and on
    /// every other kind, whose `Content::name` is the user's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// Marks a workspace as a local agent's (agent-control spec §3.5).
///
/// Set when the workspace is created and never changed afterwards, so it is
/// not a fact group and carries no timestamp. `device` is the device whose
/// agent this is: an agent is paired with one device, and other devices show
/// its workspace as "label · device".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentMark {
    pub label: String,
    pub device: crate::store::DeviceId,
}

/// Marks a workspace as a device's own (decision 2254): the one a phone or
/// tablet keeps for the tabs opened on it, which every device shows under
/// Devices.
///
/// Set when the workspace is created and never changed afterwards, as
/// [`AgentMark`] is. `device` is the device whose workspace this is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceMark {
    pub device: crate::store::DeviceId,
}

/// Each fact group records **when** it was last written and **by whom**: the
/// `_at` timestamp decides conflicts between two copies of that group (spec
/// §5.3), and the `_by` device id lets absence be judged against that
/// writer's own watermark (spec §5.4). Both travel with the group and are
/// replaced atomically when it loses a merge.
///
/// `_by` is optional because a file may carry no attribution, and none may be
/// invented. An unattributed group counts as news, so a node Sval cannot
/// attribute is never deleted on the strength of a watermark it cannot check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub kind: NodeKind,

    pub content: Content,
    pub content_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_by: Option<crate::store::DeviceId>,

    pub placement: Placement,
    pub placement_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement_by: Option<crate::store::DeviceId>,

    pub lifecycle: Lifecycle,
    pub lifecycle_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle_by: Option<crate::store::DeviceId>,

    /// Defaulted: a file without an `appearance` key loads with the group
    /// empty. The group is an additive schema change (see
    /// [`crate::SCHEMA_MINOR`]).
    #[serde(default)]
    pub appearance: Appearance,
    #[serde(default)]
    pub appearance_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance_by: Option<crate::store::DeviceId>,

    /// When and by whom work inside this node was last done, which is an edit
    /// to the node itself (decision 0106). It holds no value, so it competes
    /// with no fact the user set: a node the user touched elsewhere keeps
    /// every group it had, and only its absence is judged differently.
    ///
    /// Defaulted and skipped while never written, so an untouched node writes
    /// no stamp, and the absence rule skips it as it skips any unwritten group
    /// (spec §5.4).
    #[serde(default, skip_serializing_if = "is_unwritten")]
    pub touched_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub touched_by: Option<crate::store::DeviceId>,

    /// Present only on an agent's workspace. Defaulted and skipped when absent,
    /// so a file without it loads and an ordinary workspace writes no key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentMark>,

    /// Present only on a device's own workspace, on the same terms as
    /// `agent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_home: Option<DeviceMark>,

    /// Unrecognised keys at the node's own level, which is what a whole fact
    /// group a build does not know looks like. The per-group buckets cannot
    /// hold one, because the unrecognised key *is* the group (rule 6).
    ///
    /// Each group is a nested object with its own bucket, so this is the sole
    /// catch-all at the node level, as [`Document::extra`] is at the document
    /// level (see [`Content`]). A named field always wins over the catch-all,
    /// so the known groups and their timestamps never land here.
    ///
    /// Merged per key by greater canonical JSON bytes, like
    /// [`Document::extra`], since there is no timestamp to arbitrate with. An
    /// unknown group therefore merges key by key, so a build that cannot see
    /// the group can pair its value with another side's timestamp. That is
    /// deterministic and convergent. A build that knows the group merges it
    /// atomically.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Node {
    /// A node of `kind` holding `content` at `placement`, every group written
    /// by `by` at `now`, its touch stamp unwritten.
    pub fn fresh(
        kind: NodeKind,
        content: Content,
        placement: Placement,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> Node {
        Node {
            kind,
            content,
            content_at: now,
            content_by: Some(by),
            placement,
            placement_at: now,
            placement_by: Some(by),
            lifecycle: Lifecycle::default(),
            lifecycle_at: now,
            lifecycle_by: Some(by),
            appearance: Appearance::default(),
            appearance_at: now,
            appearance_by: Some(by),
            touched_at: 0,
            touched_by: None,
            agent: None,
            device_home: None,
            extra: BTreeMap::new(),
        }
    }

    /// This node's fact groups and its touch stamp as `(writer, timestamp)`
    /// pairs, in a fixed order: the input to the absence rule in
    /// [`crate::merge::merge`].
    ///
    /// The destructure names every field and has no `..`, so adding a field
    /// to `Node` stops this compiling until it is classed as a group or not.
    pub fn attributions(&self) -> [(Option<crate::store::DeviceId>, Timestamp); 5] {
        let Node {
            kind: _,
            content: _,
            content_at,
            content_by,
            placement: _,
            placement_at,
            placement_by,
            lifecycle: _,
            lifecycle_at,
            lifecycle_by,
            appearance: _,
            appearance_at,
            appearance_by,
            touched_at,
            touched_by,
            agent: _,
            device_home: _,
            extra: _,
        } = self;
        [
            (*content_by, *content_at),
            (*placement_by, *placement_at),
            (*lifecycle_by, *lifecycle_at),
            (*appearance_by, *appearance_at),
            (*touched_by, *touched_at),
        ]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub schema: Schema,
    /// When this device last wrote this document to a file, supplied by the
    /// caller like every other timestamp (see [`Timestamp`]). `0` until it
    /// has been written. Stamped by [`Self::stamp_write`].
    #[serde(default)]
    pub written_at: Timestamp,
    /// Which device last wrote this document, so a file says who wrote it.
    /// `None` until it has been written by anyone.
    ///
    /// "Never written" must be distinguishable from every device id, and a
    /// host may hand this crate sixteen zero bytes as its own id, as the tests
    /// in `wasm.rs` do.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub written_by: Option<crate::store::DeviceId>,
    /// The version vector: for each peer, the `written_at` of the newest file
    /// from that peer this document has incorporated.
    ///
    /// This is what lets absence carry meaning (spec §5.4). A node missing
    /// here that a peer's file still holds is either something we deleted or
    /// something we have never seen, and with no server to hold tombstones
    /// the only evidence available is in the files themselves: if we have
    /// already incorporated everything that peer knew about a node, and do
    /// not hold it, we deleted it.
    #[serde(default)]
    pub seen: BTreeMap<crate::store::DeviceId, Timestamp>,
    /// When this copy began, empty, under the id that writes it: the time of
    /// the pass that found no file of its own. `0` when unknown. A file showing that
    /// id's writes from before then shows writes this copy never held, which
    /// its own watermark would otherwise claim (decision 2232).
    /// [`crate::sync::sync_to`] sets it and reads it; `merge` ignores it.
    #[serde(default, skip_serializing_if = "is_unwritten")]
    pub began_at: Timestamp,
    /// How much of that id's writes from before `began_at` this copy has
    /// taken from other files: everything up to this time. `0` when none.
    #[serde(default, skip_serializing_if = "is_unwritten")]
    pub earlier_to: Timestamp,
    pub nodes: BTreeMap<NodeId, Node>,
    /// Unrecognised fields outside any node, at the one level with no
    /// timestamp to arbitrate a conflict with. Merged per key by greater
    /// canonical JSON bytes: a `max` over a total order, like the group
    /// tie-break (`merge::remote_group_wins`) without the timestamp. It is
    /// commutative, associative and idempotent, so both devices land on the
    /// same value whatever the merge direction or order.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Document {
    /// A fresh, empty document at the current schema version.
    pub fn new() -> Self {
        Document {
            schema: Schema {
                major: crate::SCHEMA_MAJOR,
                minor: crate::SCHEMA_MINOR,
            },
            written_at: 0,
            written_by: None,
            seen: BTreeMap::new(),
            began_at: 0,
            earlier_to: 0,
            nodes: BTreeMap::new(),
            extra: BTreeMap::new(),
        }
    }

    /// Records that `device` wrote this document at `now`: `written_at` and
    /// `written_by` describe the write, and `seen[device]` records that this
    /// document has incorporated everything in it.
    ///
    /// Both cover every stamp `device` put on a node here, where one is later
    /// than `now`. A host stamps its own clock reading on each edit and hands
    /// a pass the reading taken when the pass began, so an edit made during
    /// the pass is stamped later than the pass. A watermark short of it would
    /// make that node news to this device, in its own file and in a peer's
    /// copy, once it is removed, and the removal would be undone (spec §5.4).
    ///
    /// Keying our own write into `seen` stops our own stored file from
    /// resurrecting a node we deleted since writing it: [`crate::sync::sync_to`]
    /// merges this device's own file before any peer's, and that file
    /// predates the deletion. Its contents are not news, so the deletion
    /// stands. A device restored from a backup carries a rolled-back
    /// `seen[me]` too, so it still sees its own file as news and recovers the
    /// offline writes only that file holds.
    ///
    /// Call this only when the write happens. `written_at` moving on
    /// every poll would defeat the unchanged-document check in `sync` that
    /// keeps idle devices from rewriting their file (spec §6.5).
    pub fn stamp_write(&mut self, device: crate::store::DeviceId, now: Timestamp) {
        let covered = self
            .nodes
            .values()
            .flat_map(Node::attributions)
            .filter(|&(by, _)| by == Some(device))
            .map(|(_, at)| at)
            .fold(now, Timestamp::max);
        self.written_at = covered;
        self.written_by = Some(device);
        let entry = self.seen.entry(device).or_insert(covered);
        *entry = (*entry).max(covered);
    }

    /// Pulls every stamp `device` wrote later than `now` back to `now`: each
    /// fact group and touch stamp it is the writer of, the closing time of an
    /// Archive entry it archived, `seen[device]`, and `written_at` when it
    /// wrote the document. Other devices' stamps are left as they are.
    ///
    /// A host calls this through [`crate::sync::sync_to`] when a device's
    /// first time reading arrives, on stamps taken from a clock that may run
    /// ahead and that it has never published (decision 1714). On published
    /// stamps it would make this device's copy disagree with its peers'.
    pub fn pull_back_own_stamps(&mut self, device: crate::store::DeviceId, now: Timestamp) {
        let pull = |by: &Option<crate::store::DeviceId>, at: &mut Timestamp| {
            if *by == Some(device) && *at > now {
                *at = now;
            }
        };
        for node in self.nodes.values_mut() {
            pull(&node.content_by, &mut node.content_at);
            pull(&node.placement_by, &mut node.placement_at);
            pull(&node.lifecycle_by, &mut node.lifecycle_at);
            pull(&node.appearance_by, &mut node.appearance_at);
            pull(&node.touched_by, &mut node.touched_at);
            if let Some(archived) = node.content.archived.as_mut() {
                pull(&Some(archived.device), &mut archived.closed_at);
            }
        }
        if let Some(at) = self.seen.get_mut(&device) {
            pull(&Some(device), at);
        }
        pull(&self.written_by, &mut self.written_at);
        pull(&Some(device), &mut self.began_at);
    }

    /// Compact JSON: what is sealed into a file and what the host parses.
    /// Ciphertext does not compress, so indentation would be uploaded on
    /// every write.
    pub fn to_json(&self) -> Result<String, Error> {
        Ok(serde_json::to_string(self)?)
    }

    /// The shared part of this document (the schema, the tree, and the
    /// document-level unrecognised fields), serialised canonically, so two
    /// documents can be compared for "is there anything here another device
    /// needs?".
    ///
    /// `written_at`, `written_by` and `seen` are excluded. They describe this
    /// device's relationship to the files, and they move on every poll that
    /// reads a peer's file, so including them would report a difference
    /// whenever a peer wrote anything. [`crate::sync::sync_to`] compares this to
    /// decide whether to write, which keeps an idle device silent (spec §5.4,
    /// §6.3).
    ///
    /// Excluding them can leave our published watermarks older than what this
    /// document has incorporated. That is safe: a lower watermark makes more
    /// nodes news to us, so a peer keeps a node it would otherwise drop.
    /// Watermarks only rise, so no peer is told we have seen something we
    /// have not. The cost is a deletion a peer applies at our next real write
    /// (decision 0018).
    pub fn shared_state_json(&self) -> Result<String, Error> {
        #[derive(Serialize)]
        struct Shared<'a> {
            schema: &'a Schema,
            nodes: &'a BTreeMap<NodeId, Node>,
            #[serde(flatten)]
            extra: &'a BTreeMap<String, serde_json::Value>,
        }
        Ok(serde_json::to_string(&Shared {
            schema: &self.schema,
            nodes: &self.nodes,
            extra: &self.extra,
        })?)
    }

    pub fn from_json(json: &str) -> Result<Self, Error> {
        // Peek the schema before deserialising the rest of the document, so a
        // newer major version is reported as SchemaTooNew even when its
        // nodes have a shape this build cannot read.
        #[derive(Deserialize)]
        struct Header {
            schema: Schema,
        }
        let header: Header = serde_json::from_str(json)?;
        if header.schema.major > crate::SCHEMA_MAJOR {
            return Err(Error::SchemaTooNew {
                major: header.schema.major,
                supported: crate::SCHEMA_MAJOR,
            });
        }
        let doc: Document = serde_json::from_str(json)?;
        Ok(doc)
    }

    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(&id)
    }

    pub fn node_mut(&mut self, id: NodeId) -> Option<&mut Node> {
        self.nodes.get_mut(&id)
    }

    /// Every workspace in the document. A present node is visible, because
    /// closing removes the record (see [`Self::remove`]).
    pub fn workspaces(&self) -> impl Iterator<Item = (&NodeId, &Node)> {
        self.nodes
            .iter()
            .filter(|(_, node)| node.kind == NodeKind::Workspace)
    }

    /// Inserts a node with a given kind, computing an order key that sorts
    /// after any existing sibling under `parent`. `id` and `now` come from
    /// the caller (see [`Timestamp`]). A node already holding `id` is
    /// replaced, so a caller taking ids from a host checks first, as the wasm
    /// boundary does.
    #[expect(clippy::too_many_arguments)]
    fn insert_node(
        &mut self,
        kind: NodeKind,
        name: impl Into<String>,
        parent: Option<NodeId>,
        icon: Option<String>,
        url: Option<String>,
        id: NodeId,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> NodeId {
        let last_order = self
            .nodes
            .values()
            .filter(|n| n.placement.parent == parent)
            .map(|n| n.placement.order.clone())
            .max();
        let order = match last_order {
            Some(last) => fractional_index::FractionalIndex::new_after(&last),
            None => fractional_index::FractionalIndex::default(),
        };
        let content = Content {
            name: name.into(),
            icon,
            url,
            ..Content::default()
        };
        let placement = Placement {
            parent,
            order,
            extra: BTreeMap::new(),
        };
        let node = Node::fresh(kind, content, placement, by, now);
        self.nodes.insert(id, node);
        id
    }

    pub fn add_workspace(
        &mut self,
        name: impl Into<String>,
        icon: Option<String>,
        id: NodeId,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> NodeId {
        self.insert_node(NodeKind::Workspace, name, None, icon, None, id, by, now)
    }

    pub fn add_agent_workspace(
        &mut self,
        name: impl Into<String>,
        label: impl Into<String>,
        id: NodeId,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> NodeId {
        let id = self.insert_node(NodeKind::Workspace, name, None, None, None, id, by, now);
        if let Some(node) = self.nodes.get_mut(&id) {
            node.agent = Some(AgentMark {
                label: label.into(),
                device: by,
            });
        }
        id
    }

    /// A device's own workspace (decision 2254), marked as `by`'s.
    pub fn add_device_workspace(
        &mut self,
        name: impl Into<String>,
        id: NodeId,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> NodeId {
        let id = self.insert_node(NodeKind::Workspace, name, None, None, None, id, by, now);
        if let Some(node) = self.nodes.get_mut(&id) {
            node.device_home = Some(DeviceMark { device: by });
        }
        id
    }

    pub fn add_group(
        &mut self,
        parent: NodeId,
        name: impl Into<String>,
        icon: Option<String>,
        id: NodeId,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> NodeId {
        self.insert_node(NodeKind::Group, name, Some(parent), icon, None, id, by, now)
    }

    /// Adds an empty split under `parent`, after its last child. Its panes
    /// are moved in after it, in the same batch (split-view spec §5.2).
    pub fn add_split(
        &mut self,
        parent: NodeId,
        name: impl Into<String>,
        id: NodeId,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> NodeId {
        self.insert_node(NodeKind::Split, name, Some(parent), None, None, id, by, now)
    }

    pub fn add_tab(
        &mut self,
        parent: NodeId,
        name: impl Into<String>,
        url: impl Into<String>,
        id: NodeId,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> NodeId {
        self.insert_node(
            NodeKind::Tab,
            name,
            Some(parent),
            None,
            Some(url.into()),
            id,
            by,
            now,
        )
    }

    /// Sets `id`'s name, stamping the content group with `now` and `by`.
    ///
    /// It touches `content`, `content_at` and `content_by` and nothing else,
    /// so a name written here never competes with a move or a pin written
    /// elsewhere (spec §5.1). **`placement` and `lifecycle` are left
    /// byte-identical**, timestamps and writers included: stamping
    /// `placement_at` here would let a rename win a placement conflict and
    /// drag the node back to where this device last had it.
    ///
    /// Re-adding under the same id is no rename: [`Self::add_tab`] and its
    /// siblings compute a fresh order key after every sibling, which reorders
    /// the node. Remove-then-add turns an edit into a deletion, which may lose
    /// to a peer's concurrent edit (spec §5.4).
    ///
    /// A no-op if `id` isn't a node here, matching [`Self::remove`]; the WASM
    /// boundary rejects an unknown id first (`crate::wasm`'s `require_node`).
    ///
    /// A rename is [`Self::set_content`] with the url, icon, shares and
    /// `local` mark unchanged, since the group is the unit.
    pub fn rename(
        &mut self,
        id: NodeId,
        name: impl Into<String>,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) {
        let Some(node) = self.node(id) else {
            return;
        };
        let (url, icon, shares, local) = (
            node.content.url.clone(),
            node.content.icon.clone(),
            node.content.shares.clone(),
            node.content.local,
        );
        self.set_content(id, name, url, icon, shares, local, by, now);
    }

    /// Sets `id`'s whole content group (name, url, icon, a split's `shares`
    /// and the [`Content::local`] mark), stamping `content_at` and
    /// `content_by` and nothing else.
    ///
    /// **The group is the unit.** Merge replaces a fact group entire (spec
    /// §5.3), so a caller supplies the group it believes current, and every
    /// field it leaves out is overwritten. Following a tab as it navigates is
    /// therefore a read-modify-write: send the name the document holds with
    /// the new url, or the write clobbers a rename.
    ///
    /// `extra` is carried over. It holds fields a newer build wrote to this
    /// group, which a host cannot name and must not drop.
    ///
    /// As in [`Self::rename`], `placement` and `lifecycle` are left
    /// **byte-identical**, timestamps included, and it is a no-op if `id`
    /// isn't a node here.
    #[expect(clippy::too_many_arguments)]
    pub fn set_content(
        &mut self,
        id: NodeId,
        name: impl Into<String>,
        url: Option<String>,
        icon: Option<String>,
        shares: Option<Vec<f64>>,
        local: bool,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) {
        if let Some(node) = self.node_mut(id) {
            node.content.name = name.into();
            node.content.url = url;
            node.content.icon = icon;
            node.content.shares = shares;
            node.content.local = local;
            node.content_at = now;
            node.content_by = Some(by);
        }
    }

    /// Sets `id`'s whole appearance group (the colour, the emoji and the
    /// transparency), stamping `appearance_at` and `appearance_by` and nothing
    /// else.
    ///
    /// The group is the unit, as in [`Self::set_content`], so anything the
    /// caller leaves out is cleared. `None` for all three removes an
    /// appearance.
    ///
    /// **`content`, `placement` and `lifecycle` are left byte-identical**,
    /// timestamps and writers included, so a recolour on one device survives
    /// a rename on another (spec §5.1).
    ///
    /// The colour and transparency are stored as given and checked at
    /// `crate::wasm` (see
    /// [`Appearance`]). `label` and `extra` are carried over: a recolour
    /// never names a tab, and [`Self::set_label`] writes the label.
    ///
    /// A no-op if `id` isn't a node here; the WASM boundary rejects an unknown
    /// id first.
    pub fn set_appearance(
        &mut self,
        id: NodeId,
        color: Option<serde_json::Value>,
        emoji: Option<String>,
        transparency: Option<f64>,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) {
        if let Some(node) = self.node_mut(id) {
            node.appearance.color = color;
            node.appearance.emoji = emoji;
            node.appearance.transparency = transparency;
            node.appearance_at = now;
            node.appearance_by = Some(by);
        }
    }

    /// Sets the label a tab shows in place of its page's title, or clears it
    /// with `None`, stamping `appearance_at` and `appearance_by` and nothing
    /// else.
    ///
    /// The colour, emoji and `extra` are carried over. **`content` is left
    /// byte-identical**, so a navigation on another device, which rewrites
    /// the tab's title, never competes with the label (spec §5.1).
    ///
    /// A no-op if `id` isn't a node here; the WASM boundary rejects an unknown
    /// id first.
    pub fn set_label(
        &mut self,
        id: NodeId,
        label: Option<String>,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) {
        if let Some(node) = self.node_mut(id) {
            node.appearance.label = label;
            node.appearance_at = now;
            node.appearance_by = Some(by);
        }
    }

    /// Stamps `touched_at` and `touched_by` on `id`, and nothing else: work
    /// was done inside it, such as a tab filed under a workspace nobody had
    /// touched (decision 0106).
    ///
    /// The stamp holds no value, so every fact group is left byte-identical
    /// and no edit made elsewhere can be lost to it. What it changes is the
    /// absence rule's verdict: a peer that deleted `id` without seeing the
    /// stamp loses to it, and the node comes back (spec §5.4, decision
    /// 0017).
    ///
    /// A no-op if `id` isn't a node here; the WASM boundary rejects an unknown
    /// id first.
    pub fn touch(&mut self, id: NodeId, by: crate::store::DeviceId, now: Timestamp) {
        if let Some(node) = self.node_mut(id) {
            node.touched_at = now;
            node.touched_by = Some(by);
        }
    }

    /// Sets whether workspace `id` is isolated, stamping `lifecycle_at` and
    /// `lifecycle_by` and nothing else.
    ///
    /// The lifecycle group is the unit, as in [`Self::set_content`], so the
    /// node's `pinned` and `extra` are carried over as this device holds them.
    /// `content`, `placement` and `appearance` are left byte-identical, so
    /// isolating a workspace on one device never competes with a rename or a
    /// recolour on another (spec §5.1).
    ///
    /// A no-op if `id` isn't a node here; the WASM boundary rejects an unknown
    /// id, and a node that is not a workspace, first.
    pub fn set_isolation(
        &mut self,
        id: NodeId,
        isolated: bool,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) {
        if let Some(node) = self.node_mut(id) {
            node.lifecycle.isolated = isolated;
            node.lifecycle_at = now;
            node.lifecycle_by = Some(by);
        }
    }

    /// Sets setting `key` to `value`, or resets it to its default with `None`.
    ///
    /// Creates the node at [`setting_id`] if absent, otherwise replaces its
    /// `content` group only. Placement is written once, at creation, and never
    /// again: a setting has no parent and no siblings that matter, so a
    /// rewrite would only add a second timestamp to argue over.
    pub fn set_setting(
        &mut self,
        key: &str,
        value: Option<serde_json::Value>,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> NodeId {
        let id = setting_id(key);
        // A JSON null is a reset, the same as `None`: stored as a value it
        // would read back as one here and as a reset after a reload.
        let value = value.filter(|v| !v.is_null());
        let content = Content {
            name: key.to_string(),
            value,
            ..Content::default()
        };
        match self.node_mut(id) {
            Some(node) => {
                // Rule 6: fields a newer build wrote to this group survive,
                // as in `set_content`.
                let extra = std::mem::take(&mut node.content.extra);
                node.content = Content { extra, ..content };
                node.content_at = now;
                node.content_by = Some(by);
            }
            None => self.insert_root(NodeKind::Setting, id, by, now, |c| *c = content),
        }
        id
    }

    /// Every setting's key and value. `None` is a setting reset to default;
    /// a key absent from the map was never set.
    pub fn settings(&self) -> BTreeMap<String, Option<serde_json::Value>> {
        self.nodes
            .values()
            .filter(|node| node.kind == NodeKind::Setting)
            .map(|node| (node.content.name.clone(), node.content.value.clone()))
            .collect()
    }

    /// Adds a favorite, folder or separator whose guid is `guid`, at
    /// [`favorite_id`]`(guid)`, under `parent` between the siblings `before`
    /// and `after` (favorites-native spec §16). A root is a folder with no
    /// parent. A node already at that id is replaced, so adding the same
    /// guid twice leaves one node, and adding a deleted favorite's guid
    /// again at a later stamp, as Undo does, is news to every peer
    /// (decisions 0014, 0016).
    #[expect(clippy::too_many_arguments)]
    pub fn add_favorite(
        &mut self,
        kind: NodeKind,
        guid: &str,
        parent: Option<NodeId>,
        before: Option<NodeId>,
        after: Option<NodeId>,
        name: impl Into<String>,
        url: Option<String>,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> NodeId {
        let id = favorite_id(guid);
        // With no neighbour named, `insert_node` puts it after every sibling.
        let order = (before.is_some() || after.is_some())
            .then(|| crate::tree::order_between(self, before, after));
        self.insert_node(kind, name, parent, None, url, id, by, now);
        if let Some(node) = self.node_mut(id) {
            node.content.guid = Some(guid.to_string());
            node.content.added = Some(now);
            if let Some(order) = order {
                node.placement.order = order;
            }
        }
        id
    }

    /// Whether `id` is a pin: a node under the pins root, at any depth
    /// (pins-root spec §4). The walk stops at a cycle a merge left.
    pub fn is_pin(&self, id: NodeId) -> bool {
        let root = favorite_id(PINS_GUID);
        let mut at = self.node(id).and_then(|n| n.placement.parent);
        for _ in 0..self.nodes.len() {
            match at {
                Some(p) if p == root => return true,
                Some(p) => at = self.node(p).and_then(|n| n.placement.parent),
                None => return false,
            }
        }
        false
    }

    /// Limits the pin at `id` to the workspaces in `scope`, or shows it in
    /// every workspace for `None` (pins spec §7), stamping the lifecycle
    /// group and nothing else. An empty set is every workspace too: a pin
    /// that showed nowhere could not be reached to undo it.
    ///
    /// A no-op if `id` isn't a pin here ([`Self::is_pin`]).
    pub fn set_pin_scope(
        &mut self,
        id: NodeId,
        scope: Option<BTreeSet<String>>,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) {
        let scope = scope.filter(|s| !s.is_empty());
        if !self.is_pin(id) {
            return;
        }
        if let Some(node) = self.node_mut(id) {
            node.lifecycle.pin_scope = scope;
            node.lifecycle_at = now;
            node.lifecycle_by = Some(by);
        }
    }

    /// Adds the visit this device, `by`, made to `url` at `visited_at` in no
    /// workspace, as [`Document::add_visit_in`] does.
    #[cfg(test)]
    pub(crate) fn add_visit(
        &mut self,
        url: &str,
        title: impl Into<String>,
        transition: u32,
        visited_at: Timestamp,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> NodeId {
        self.add_visit_in(url, title, transition, visited_at, None, by, now)
    }

    /// Adds the visit this device, `by`, made to `url` at `visited_at` in
    /// `workspace`, at [`visit_id`] (history-sync spec §3, decision 1287). A
    /// visit has no parent and its placement is never written again. A visit
    /// already here is left as it is: a visit never changes, so seeding it
    /// twice writes nothing new.
    #[expect(clippy::too_many_arguments)]
    pub fn add_visit_in(
        &mut self,
        url: &str,
        title: impl Into<String>,
        transition: u32,
        visited_at: Timestamp,
        workspace: Option<NodeId>,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> NodeId {
        let id = visit_id(by, url, visited_at);
        if self.nodes.contains_key(&id) {
            return id;
        }
        self.insert_root(NodeKind::Visit, id, by, now, |content| {
            content.name = title.into();
            content.url = Some(url.to_string());
            content.visit = Some(Visit {
                at: visited_at,
                transition,
                device: by,
                workspace,
                extra: BTreeMap::new(),
            });
        });
        id
    }

    /// Sets visit `id`'s title, stamping the content group, when it differs
    /// from the title held. The URL and the visit's facts are kept.
    ///
    /// A no-op if `id` isn't a node here.
    pub fn set_visit_title(
        &mut self,
        id: NodeId,
        title: impl Into<String>,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) {
        let title = title.into();
        if let Some(node) = self.node_mut(id)
            && node.content.name != title
        {
            node.content.name = title;
            node.content_at = now;
            node.content_by = Some(by);
        }
    }

    /// Records in [`HISTORY_INDEX`] that `by` wrote to history shard `name`
    /// at `now`: adds the shard's node, or stamps its touch (decision 0106),
    /// so every device learns the shard changed (history-sync spec §3).
    pub fn touch_shard(
        &mut self,
        name: &str,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> NodeId {
        let id = shard_id(name);
        if self.nodes.contains_key(&id) {
            self.touch(id, by, now);
        } else {
            self.insert_root(NodeKind::Shard, id, by, now, |content| {
                content.name = name.to_string();
            });
        }
        id
    }

    /// Adds the Archive entry for the tab `record` names, at
    /// [`archived_id`] of that tab, holding its title, URL and icon
    /// (idle-tab archive spec §3.1). An entry already there is replaced: the
    /// tab is being archived again, so this is the newer record, and only
    /// the fields this build does not know are carried over.
    pub fn add_archived(
        &mut self,
        title: impl Into<String>,
        url: Option<String>,
        icon: Option<String>,
        record: Archived,
        by: crate::store::DeviceId,
        now: Timestamp,
    ) -> NodeId {
        let id = archived_id(record.tab);
        // Rule 6: fields a newer build wrote to the entry survive its
        // replacement.
        let (extra, record_extra) = self
            .node(id)
            .map(|n| {
                let held = n.content.archived.as_ref().map(|a| a.extra.clone());
                (n.content.extra.clone(), held.unwrap_or_default())
            })
            .unwrap_or_default();
        let mut record = record;
        for (key, value) in record_extra {
            record.extra.entry(key).or_insert(value);
        }
        self.insert_root(NodeKind::Archived, id, by, now, |content| {
            content.name = title.into();
            content.url = url;
            content.icon = icon;
            content.archived = Some(record);
            content.extra = extra;
        });
        id
    }

    #[cfg(test)]
    pub(crate) fn visit_ids(&self) -> std::collections::BTreeSet<NodeId> {
        self.nodes
            .iter()
            .filter(|(_, n)| n.kind == NodeKind::Visit)
            .map(|(id, _)| *id)
            .collect()
    }

    /// Inserts a parentless node of `kind` at `id`, every group written by
    /// `by` at `now`, with its content filled by `fill`.
    fn insert_root(
        &mut self,
        kind: NodeKind,
        id: NodeId,
        by: crate::store::DeviceId,
        now: Timestamp,
        fill: impl FnOnce(&mut Content),
    ) {
        let mut content = Content::default();
        fill(&mut content);
        let placement = Placement {
            parent: None,
            order: fractional_index::FractionalIndex::default(),
            extra: BTreeMap::new(),
        };
        let node = Node::fresh(kind, content, placement, by, now);
        self.nodes.insert(id, node);
    }

    /// Removes `id` and everything beneath it from the document. This is
    /// what closing a tab is, and deleting a group or a workspace with its
    /// contents: the records are deleted, not marked (spec §5.1, §5.4).
    /// Deleting a Favorites folder deletes what is in it the same way
    /// (favorites-native spec §16). To delete a container and keep what is in
    /// it, [`crate::tree::remove_keeping_children`] moves its children out
    /// first.
    ///
    /// No timestamp, tombstone or marker is left behind (spec §5.4). The
    /// version vector in [`Self::seen`] stops a peer whose file predates the
    /// delete from re-inserting the node; see [`crate::merge::merge`].
    ///
    /// The subtree is the one this document holds. A node a peer files under
    /// `id` that this device has not yet merged arrives later naming a parent
    /// that is gone, and [`crate::tree::repair_unreachable_ancestry`] makes
    /// it reachable again (spec §5.2).
    ///
    /// Takes no device id: a deletion stores nothing to attribute. The absence
    /// rule reads the attribution on the surviving copies of the node.
    ///
    /// A no-op if `id` isn't a node here.
    pub fn remove(&mut self, id: NodeId) {
        let mut children: BTreeMap<NodeId, Vec<NodeId>> = BTreeMap::new();
        for (child, node) in &self.nodes {
            if let Some(parent) = node.placement.parent {
                children.entry(parent).or_default().push(*child);
            }
        }
        // Each node is taken once, so a cycle a merge left is walked once.
        let mut doomed = vec![id];
        while let Some(next) = doomed.pop() {
            if self.nodes.remove(&next).is_some() {
                doomed.extend(children.remove(&next).unwrap_or_default());
            }
        }
    }
}

impl Default for Document {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    /// The fixed id of the workspace [`base_doc`] creates. Merge tests build
    /// peer documents by calling `base_doc()` more than once, and their edits
    /// to the workspace collide only if every call gives the same id.
    const BASE_WORKSPACE_ID: NodeId = Uuid::from_u128(1);

    /// A `Document` with a single workspace at a fixed id.
    pub fn base_doc() -> Document {
        let mut doc = Document::new();
        let node = Node {
            kind: NodeKind::Workspace,
            content: Content {
                name: "Client A".into(),
                icon: Some("📁".into()),
                url: None,
                value: None,
                guid: None,
                added: None,
                visit: None,
                archived: None,
                shares: None,
                local: false,
                extra: BTreeMap::new(),
            },
            content_at: 0,
            content_by: Some(test_device()),
            placement: Placement {
                parent: None,
                order: fractional_index::FractionalIndex::default(),
                extra: BTreeMap::new(),
            },
            placement_at: 0,
            placement_by: Some(test_device()),
            lifecycle: Lifecycle {
                pinned: false,
                isolated: false,
                home_order: None,
                pin_scope: None,
                auto_archive: None,
                restored: false,
                extra: BTreeMap::new(),
            },
            lifecycle_at: 0,
            lifecycle_by: Some(test_device()),
            appearance: Appearance::default(),
            appearance_at: 0,
            appearance_by: Some(test_device()),
            touched_at: 0,
            touched_by: None,
            agent: None,
            device_home: None,
            extra: BTreeMap::new(),
        };
        doc.nodes.insert(BASE_WORKSPACE_ID, node);
        doc
    }

    /// The fixed id both [`peer_with_changes`] and [`other_peer`] give the tab
    /// they each add, so one peer removing it and the other keeping it is a
    /// disagreement about one node.
    const CONTENDED_TAB_ID: NodeId = Uuid::from_u128(2);

    /// A fixed device id for fixtures whose attribution is not what the test
    /// is about. Tests of the absence rule use the device that wrote the
    /// node, because that is what the rule reads (spec §5.4).
    pub fn test_device() -> crate::store::DeviceId {
        crate::store::DeviceId::from_bytes([9u8; 16])
    }

    /// The part of a document every device must agree on: the tree, plus the
    /// document-level unrecognised fields.
    ///
    /// The [`Document::shared_state_json`] `sync` compares to decide whether
    /// to write, so a convergence assertion covers the bytes that decide a
    /// write.
    pub fn shared_state(doc: &Document) -> String {
        doc.shared_state_json()
            .expect("a test document must serialise")
    }

    /// The id of the workspace created by [`base_doc`].
    pub fn ws_of(doc: &Document) -> NodeId {
        *doc.workspaces().next().unwrap().0
    }

    /// A peer that diverged from [`base_doc`] by adding a tab, editing the
    /// workspace name, and removing the tab at [`CONTENDED_TAB_ID`]. Its
    /// timestamps are fixed. `crate::types::test_support::test_id()` is safe here because this is
    /// test-only code (see [`Timestamp`]).
    pub fn peer_with_changes() -> Document {
        let mut doc = base_doc();
        let ws = ws_of(&doc);

        doc.node_mut(ws).unwrap().content.name = "Client A (renamed by peer 1)".into();
        doc.node_mut(ws).unwrap().content_at = 1_000;

        doc.add_tab(
            ws,
            "peer 1 add",
            "https://peer1.example",
            crate::types::test_support::test_id(),
            test_device(),
            900,
        );

        doc.add_tab(
            ws,
            "contended",
            "https://contended.example",
            CONTENDED_TAB_ID,
            test_device(),
            900,
        );
        doc.remove(CONTENDED_TAB_ID);

        doc
    }

    /// A second peer, diverged from [`base_doc`] independently of
    /// [`peer_with_changes`]: it adds a tab, edits the workspace name, and
    /// keeps the tab the other peer removed.
    pub fn other_peer() -> Document {
        let mut doc = base_doc();
        let ws = ws_of(&doc);

        doc.node_mut(ws).unwrap().content.name = "Client A (renamed by peer 2)".into();
        doc.node_mut(ws).unwrap().content_at = 1_500;

        doc.add_tab(
            ws,
            "peer 2 add",
            "https://peer2.example",
            crate::types::test_support::test_id(),
            test_device(),
            900,
        );

        doc.add_tab(
            ws,
            "contended",
            "https://contended.example",
            CONTENDED_TAB_ID,
            test_device(),
            900,
        );

        doc
    }

    /// Fixed ids shared by every document [`generate_peers`] produces. `id 1`
    /// is the workspace (the root every other id starts parented under);
    /// the rest are groups. Every generated peer mutates this same pool, so
    /// their edits, closes and reparenting collide on shared nodes. Disjoint
    /// per-peer ids would converge by set union alone and miss any bug in the
    /// per-group timestamp comparison.
    const POOL_SIZE: u128 = 6;

    pub fn pool_ids() -> Vec<NodeId> {
        (1..=POOL_SIZE).map(Uuid::from_u128).collect()
    }

    /// The shared starting document every [`generate_peers`] peer diverges
    /// from: one workspace with the rest of the pool as groups under it.
    fn shared_pool_doc() -> Document {
        let mut doc = Document::new();
        let ids = pool_ids();
        let ws = ids[0];
        doc.nodes.insert(
            ws,
            Node {
                kind: NodeKind::Workspace,
                content: Content {
                    name: "W".into(),
                    icon: None,
                    url: None,
                    value: None,
                    guid: None,
                    added: None,
                    visit: None,
                    archived: None,
                    shares: None,
                    local: false,
                    extra: BTreeMap::new(),
                },
                content_at: 0,
                content_by: Some(peer_device(0)),
                placement: Placement {
                    parent: None,
                    order: fractional_index::FractionalIndex::default(),
                    extra: BTreeMap::new(),
                },
                placement_at: 0,
                placement_by: Some(peer_device(0)),
                lifecycle: Lifecycle {
                    pinned: false,
                    isolated: false,
                    home_order: None,
                    pin_scope: None,
                    auto_archive: None,
                    restored: false,
                    extra: BTreeMap::new(),
                },
                lifecycle_at: 0,
                lifecycle_by: Some(peer_device(0)),
                appearance: Appearance::default(),
                appearance_at: 0,
                appearance_by: Some(peer_device(0)),
                touched_at: 0,
                touched_by: None,
                agent: None,
                device_home: None,
                extra: BTreeMap::new(),
            },
        );
        for (i, &id) in ids.iter().enumerate().skip(1) {
            let prev_order = doc
                .nodes
                .get(&ids[i - 1])
                .map(|n| n.placement.order.clone())
                .unwrap_or_default();
            doc.nodes.insert(
                id,
                Node {
                    kind: NodeKind::Group,
                    content: Content {
                        name: format!("n{i}"),
                        icon: None,
                        url: None,
                        value: None,
                        guid: None,
                        added: None,
                        visit: None,
                        archived: None,
                        shares: None,
                        local: false,
                        extra: BTreeMap::new(),
                    },
                    content_at: 0,
                    content_by: Some(peer_device(0)),
                    placement: Placement {
                        parent: Some(ws),
                        order: fractional_index::FractionalIndex::new_after(&prev_order),
                        extra: BTreeMap::new(),
                    },
                    placement_at: 0,
                    placement_by: Some(peer_device(0)),
                    lifecycle: Lifecycle {
                        pinned: false,
                        isolated: false,
                        home_order: None,
                        pin_scope: None,
                        auto_archive: None,
                        restored: false,
                        extra: BTreeMap::new(),
                    },
                    lifecycle_at: 0,
                    lifecycle_by: Some(peer_device(0)),
                    // Every other pool node carries no appearance timestamp
                    // or writer. Mixing those with nodes that carry one makes
                    // the convergence property test cover the rule that an
                    // unwritten group is not news (spec §5.4): if it were,
                    // no peer's deletion of such a node could propagate, and
                    // the test's removal assertion would fail.
                    appearance: Appearance::default(),
                    appearance_at: if i % 2 == 0 { 0 } else { 1 },
                    appearance_by: if i % 2 == 0 {
                        None
                    } else {
                        Some(peer_device(0))
                    },
                    touched_at: 0,
                    touched_by: None,
                    agent: None,
                    device_home: None,
                    extra: BTreeMap::new(),
                },
            );
        }
        doc
    }

    /// A deterministic PRNG (splitmix64), so distinct proptest seeds exercise
    /// different interleavings.
    fn splitmix64(state: &mut u64) -> u64 {
        *state = state.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    /// The watermark every generated peer's version vector carries for every
    /// other peer: "I have incorporated everything you wrote up to here."
    /// Every edit the generator makes is stamped below it and every fresh
    /// node above it, which is what makes each peer's deletions and its own
    /// creations unambiguous to the others (see [`generate_peers`]).
    pub const PUBLISHED_AT: Timestamp = 8;

    /// The device id of generated peer `i`.
    pub fn peer_device(i: usize) -> crate::store::DeviceId {
        crate::store::DeviceId::from_bytes([i as u8 + 1; 16])
    }

    /// Generates `count` peers that all mutate the same pool of node ids
    /// (see [`pool_ids`]), so a property test over the result exercises
    /// contended merges:
    ///
    /// - timestamps are drawn from below [`PUBLISHED_AT`], a range small
    ///   enough that two peers often land on the same timestamp for the same
    ///   node and group, so the tie-break path is exercised;
    /// - edits, removals, pin flips and moves target any pool id, so a peer
    ///   can delete or rename a node another peer touched;
    /// - a node's `parent` is reassigned to another pool id, so concurrent
    ///   reparenting can form a cycle once merged;
    /// - a node is removed, another's `pinned` is flipped and a third is
    ///   recoloured, so every group contends independently. With every
    ///   peer's version vector at [`PUBLISHED_AT`] and every edit stamped
    ///   below it, a removal is evidence to every other peer (spec §5.4) and
    ///   must stick;
    /// - each peer creates one node of its own, stamped above `PUBLISHED_AT`,
    ///   which the others must adopt as news;
    /// - an edited node's content sometimes gains an unrecognised field with
    ///   a value that varies by peer, so peers hold conflicting values for the
    ///   same unknown key in the same group.
    pub fn generate_peers(seed: u64, count: usize) -> Vec<Document> {
        let ids = pool_ids();
        (0..count)
            .map(|i| {
                let mut doc = shared_pool_doc();
                doc.written_at = PUBLISHED_AT;
                doc.written_by = Some(peer_device(i));
                for other in 0..count {
                    doc.seen.insert(peer_device(other), PUBLISHED_AT);
                }
                let mut state = seed.wrapping_mul(1_000_003).wrapping_add(i as u64 * 97 + 1);
                let mut rand = || splitmix64(&mut state);

                // Edit some pool nodes' content, including ones this peer
                // did not create.
                //
                // **The values do not name the peer, and the value space is
                // tiny.** Two peers must be able to land on a byte-identical
                // content group at the same `content_at`, the only case the
                // writer leg of the tie-break decides. A merge that dropped
                // `content_by` from the comparison would leave each peer
                // keeping its own attribution forever. A peer index in the
                // values makes that collision unreachable; do not widen them.
                // `merge::tests::a_byte_identical_content_tie_is_settled_by_the_writer`
                // covers the case deterministically.
                for &id in ids.iter().skip(1) {
                    if rand() % 3 == 0 {
                        let n = doc.node_mut(id).unwrap();
                        n.content.name = format!("edit-{}", rand() % 2);
                        n.content_at = rand() % PUBLISHED_AT;
                        n.content_by = Some(peer_device(i));
                        if rand() % 2 == 0 {
                            n.content.extra.insert(
                                "future_field".into(),
                                serde_json::json!(format!("value-{}", rand() % 2)),
                            );
                        }
                    }
                }

                // Flip some node's `pinned`, not necessarily one this peer
                // just edited above, so the lifecycle group contends
                // independently of content.
                let pin_target = ids[rand() as usize % ids.len()];
                let node = doc.node_mut(pin_target).unwrap();
                node.lifecycle.pinned = rand() % 2 == 0;
                node.lifecycle_at = rand() % PUBLISHED_AT;
                node.lifecycle_by = Some(peer_device(i));

                // Recolour some node, so the appearance group contends
                // independently of the others, sometimes with an
                // unrecognised field of its own.
                let paint_target = ids[rand() as usize % ids.len()];
                // A tiny value space with no peer index, so two peers often
                // land on a byte-identical appearance at the same
                // `appearance_at` with different writers: the case the
                // writer leg of the tie-break decides, as for content above.
                // Do not widen it.
                let palette = ["blue", "purple"];
                let node = doc.node_mut(paint_target).unwrap();
                node.appearance.color = Some(palette[rand() as usize % palette.len()].into());
                node.appearance.emoji = Some(format!("emoji-{}", rand() % 2));
                node.appearance_at = rand() % PUBLISHED_AT;
                node.appearance_by = Some(peer_device(i));
                if rand() % 2 == 0 {
                    node.appearance.extra.insert(
                        "future_paint".into(),
                        serde_json::json!(format!("peer{i}-paint-{}", rand() % 5)),
                    );
                }

                // Remove a node outright, including the workspace itself
                // (`ids[0]`): repair's root choice is only exercised when the
                // lowest-id workspace can go away, so the workspace has to be
                // a candidate here too.
                doc.remove(ids[rand() as usize % ids.len()]);

                // One node of this peer's own, stamped above PUBLISHED_AT, so
                // no other peer can mistake it for something they deleted.
                let mine = Uuid::from_u128(100 + i as u128);
                doc.nodes.insert(
                    mine,
                    Node {
                        kind: NodeKind::Tab,
                        content: Content {
                            name: format!("peer{i}-own"),
                            icon: None,
                            url: Some(format!("https://peer{i}.example")),
                            value: None,
                            guid: None,
                            added: None,
                            visit: None,
                            archived: None,
                            shares: None,
                            local: false,
                            extra: BTreeMap::new(),
                        },
                        content_at: PUBLISHED_AT + 1,
                        content_by: Some(peer_device(i)),
                        placement: Placement {
                            parent: Some(ids[0]),
                            order: fractional_index::FractionalIndex::default(),
                            extra: BTreeMap::new(),
                        },
                        placement_at: PUBLISHED_AT + 1,
                        placement_by: Some(peer_device(i)),
                        lifecycle: Lifecycle {
                            pinned: false,
                            isolated: false,
                            home_order: None,
                            pin_scope: None,
                            auto_archive: None,
                            restored: false,
                            extra: BTreeMap::new(),
                        },
                        lifecycle_at: PUBLISHED_AT + 1,
                        lifecycle_by: Some(peer_device(i)),
                        appearance: Appearance::default(),
                        appearance_at: PUBLISHED_AT + 1,
                        appearance_by: Some(peer_device(i)),
                        touched_at: 0,
                        touched_by: None,
                        agent: None,
                        device_home: None,
                        extra: BTreeMap::new(),
                    },
                );

                // Reassign a parent among the shared ids, including the
                // workspace itself (`ids[0]`). Across peers this is the
                // concurrent-move-into-each-other shape that forms a cycle
                // once merged. This crate's API never gives a workspace a
                // parent, but `merge` accepts whatever a peer's file says, so
                // repair's guard against reparenting a workspace under itself
                // needs the workspace to be able to join a cycle.
                let a = ids[rand() as usize % ids.len()];
                let b = ids[rand() as usize % ids.len()];
                let at = rand() % PUBLISHED_AT;
                // `a` may be the node this peer just removed.
                if a != b
                    && let Some(node) = doc.node_mut(a)
                {
                    node.placement.parent = Some(b);
                    node.placement_at = at;
                    node.placement_by = Some(peer_device(i));
                }

                doc
            })
            .collect()
    }

    /// The first node of `doc` that does not reach a parentless root by
    /// walking `parent`, and why, or `None`: the property read-time repair
    /// guarantees. Convergence alone does not show it, since devices that
    /// skipped repair would still agree on the same unreachable nodes.
    ///
    /// The root need not be a workspace. [`crate::tree::repair_unreachable_ancestry`]
    /// detaches a node (`parent = None`) when the document has no workspace
    /// at the time, and does not revisit it once one appears.
    pub fn unreachable_node(doc: &Document) -> Option<String> {
        for &id in doc.nodes.keys() {
            let mut current = id;
            let mut hops = 0;
            while let Some(parent) = doc.node(current)?.placement.parent {
                if doc.node(parent).is_none() {
                    return Some(format!(
                        "node {id} has an ancestor {parent} that is not in the document"
                    ));
                }
                current = parent;
                hops += 1;
                if hops > doc.nodes.len() {
                    return Some(format!("cycle found walking up from {id}"));
                }
            }
        }
        None
    }

    std::thread_local! {
        static NEXT: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    }

    /// The next of a sequence each test thread starts afresh. Device ids and
    /// keys decide the paths of the files a pass reads, and so the order it
    /// merges them in, and node ids decide repair's choice of workspace. Drawn
    /// from entropy, they would let a test pass on one run and fail on the
    /// next, and a mutant be caught on one run and missed on the next. The
    /// harness runs each test on a thread of its own, so a test sees the same
    /// sequence on every run whatever runs beside it.
    pub fn next_in_sequence() -> u64 {
        NEXT.with(|next| {
            let n = next.get() + 1;
            next.set(n);
            n
        })
    }

    /// A key of its own for each call in a test, the same on every run.
    pub fn test_key() -> crate::crypto::Key {
        let mut bytes = [0x4b; 32];
        bytes[..8].copy_from_slice(&next_in_sequence().to_le_bytes());
        crate::crypto::Key::from_bytes(&bytes).expect("32 bytes are a key")
    }

    /// A node id of its own for each call in a test, the same on every run,
    /// above every id a test spells out.
    pub fn test_id() -> NodeId {
        Uuid::from_u64_pair(0xF00D_0000_0000_0000, next_in_sequence())
    }

    /// The tree document's name in the tests that sync one.
    pub const TREE: &str = "ws-tree";

    pub fn dev_a() -> crate::store::DeviceId {
        crate::store::DeviceId::from_bytes([0xa; 16])
    }

    pub fn dev_b() -> crate::store::DeviceId {
        crate::store::DeviceId::from_bytes([0xb; 16])
    }

    pub fn uid(n: u128) -> NodeId {
        NodeId::from_u128(n)
    }

    /// `a` merged into `b` and `b` into `a`, each repaired, asserting both
    /// directions hold the same nodes.
    pub fn read_both_ways(a: &Document, b: &Document) -> Document {
        let (mut ab, mut ba) = (a.clone(), b.clone());
        crate::merge::merge(&mut ab, b);
        crate::merge::merge(&mut ba, a);
        for doc in [&mut ab, &mut ba] {
            crate::tree::repair_unreachable_ancestry(doc);
        }
        assert_eq!(
            serde_json::to_value(&ab.nodes).unwrap(),
            serde_json::to_value(&ba.nodes).unwrap(),
            "both directions must converge"
        );
        ab
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_known_kind_reads_back_as_itself() {
        // A known kind read as `Unknown` would still round-trip its name, but
        // repair skips an unknown node and everything beneath it.
        //
        // The kinds are walked through a match with no wildcard arm, so a new
        // variant does not compile until it has a place in the walk.
        fn after(kind: &NodeKind) -> Option<NodeKind> {
            match kind {
                NodeKind::Workspace => Some(NodeKind::Group),
                NodeKind::Group => Some(NodeKind::Tab),
                NodeKind::Tab => Some(NodeKind::Split),
                NodeKind::Split => Some(NodeKind::Setting),
                NodeKind::Setting => Some(NodeKind::Favorite),
                NodeKind::Favorite => Some(NodeKind::Folder),
                NodeKind::Folder => Some(NodeKind::Separator),
                NodeKind::Separator => Some(NodeKind::Visit),
                NodeKind::Visit => Some(NodeKind::Shard),
                NodeKind::Shard => Some(NodeKind::Archived),
                NodeKind::Archived => Some(NodeKind::Unknown("from_the_future".into())),
                NodeKind::Unknown(_) => None,
            }
        }
        let mut kind = Some(NodeKind::Workspace);
        while let Some(current) = kind {
            let json = serde_json::to_string(&current).unwrap();
            assert_eq!(serde_json::from_str::<NodeKind>(&json).unwrap(), current);
            kind = after(&current);
        }
    }

    #[test]
    fn error_codes_are_pinned() {
        // Hosts branch on these strings, so renaming one is a contract change.
        let cases: [(Error, &str); 11] = [
            (
                Error::SchemaTooNew {
                    major: 2,
                    supported: 1,
                },
                "schema_too_new",
            ),
            (Error::InvalidKeyLength { got: 1 }, "invalid_key_length"),
            (Error::EncryptionFailed, "encryption_failed"),
            (Error::NoEntropy, "no_entropy"),
            (Error::DecryptionFailed, "decryption_failed"),
            (Error::NotUtf8, "not_utf8"),
            (Error::Io(std::io::Error::other("x")), "io"),
            (Error::NotFound("p".into()), "not_found"),
            (Error::Poisoned, "poisoned"),
            (Error::BadPairingCode, "bad_pairing_code"),
            (Error::MalformedPairingFile, "malformed_pairing_file"),
        ];
        for (err, code) in cases {
            assert_eq!(err.code(), code, "{err}");
        }
        let json = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        assert_eq!(Error::from(json).code(), "json");
    }
    use test_support::test_device;

    #[test]
    fn a_setting_kind_round_trips_as_setting() {
        let json = r#"{
            "schema": { "major": 1, "minor": 4 },
            "nodes": {
                "8720f166-26ba-5865-8179-4a4465ec7234": {
                    "kind": "setting",
                    "content": { "name": "sval.search.engine" }, "content_at": 5,
                    "placement": { "order": "80" }, "placement_at": 5,
                    "lifecycle": {}, "lifecycle_at": 5
                }
            }
        }"#;
        let doc = Document::from_json(json).expect("a setting node must parse");
        let id = Uuid::parse_str("8720f166-26ba-5865-8179-4a4465ec7234").unwrap();
        assert_eq!(doc.node(id).unwrap().kind, NodeKind::Setting);
        let out: serde_json::Value = serde_json::from_str(&doc.to_json().unwrap()).unwrap();
        assert_eq!(out["nodes"][id.to_string()]["kind"], "setting");
    }

    #[test]
    fn content_value_round_trips_and_is_absent_when_none() {
        let mut doc = Document::new();
        let id = crate::types::test_support::test_id();
        doc.add_workspace("W", None, id, test_device(), 10);
        let json = doc.to_json().unwrap();
        assert!(!json.contains("\"value\""), "absent, not null: {json}");

        doc.node_mut(id).unwrap().content.value = Some(serde_json::json!({"a": [1, true]}));
        let back = Document::from_json(&doc.to_json().unwrap()).unwrap();
        assert_eq!(
            back.node(id).unwrap().content.value,
            Some(serde_json::json!({"a": [1, true]}))
        );
        assert!(!back.node(id).unwrap().content.extra.contains_key("value"));
    }

    #[test]
    fn an_older_build_carries_value_through_content_extra() {
        // Rule 6, simulated: a minor-3 build has no `value` field, so the key
        // lands in `Content::extra` and must be written back verbatim.
        let with_value = r#"{"name":"k","value":"ddg"}"#;
        #[derive(serde::Deserialize, serde::Serialize)]
        struct OlderContent {
            name: String,
            #[serde(flatten)]
            extra: BTreeMap<String, serde_json::Value>,
        }
        let older: OlderContent = serde_json::from_str(with_value).unwrap();
        assert_eq!(older.extra.get("value"), Some(&serde_json::json!("ddg")));
        let rewritten = serde_json::to_string(&older).unwrap();
        let ours: Content = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(ours.value, Some(serde_json::json!("ddg")));
    }

    #[test]
    fn setting_id_is_a_pinned_uuid_v5() {
        // Known-answer vectors, computed independently with Python's
        // `uuid.uuid5(UUID('6b1c2f4e-8a3d-4e7b-9c10-2f4a6d8e0b13'), key)`.
        // iOS and Android must derive the same ids, so these may never change.
        assert_eq!(
            setting_id("sval.search.engine").to_string(),
            "8720f166-26ba-5865-8179-4a4465ec7234"
        );
        assert_eq!(
            setting_id("privacy.globalprivacycontrol.enabled").to_string(),
            "4dde9952-c522-5ada-a033-355e9b009ab1"
        );
        assert_eq!(
            setting_id(""),
            setting_id(""),
            "deterministic even when empty"
        );
    }

    #[test]
    fn set_setting_creates_then_replaces_one_node() {
        let mut doc = Document::new();
        let by = test_device();
        let id = doc.set_setting("sval.search.engine", Some(serde_json::json!("ddg")), by, 10);
        assert_eq!(id, setting_id("sval.search.engine"));
        doc.set_setting(
            "sval.search.engine",
            Some(serde_json::json!("kagi")),
            by,
            20,
        );

        assert_eq!(doc.nodes.len(), 1);
        let node = doc.node(id).unwrap();
        assert_eq!(node.kind, NodeKind::Setting);
        assert_eq!(node.content.name, "sval.search.engine");
        assert_eq!(node.content.value, Some(serde_json::json!("kagi")));
        assert_eq!(node.content_at, 20);
        assert_eq!(
            node.placement_at, 10,
            "placement is written once, at creation"
        );
        assert_eq!(node.placement.parent, None);
    }

    #[test]
    fn settings_reads_every_setting_and_only_settings() {
        let mut doc = Document::new();
        let by = test_device();
        doc.add_workspace("W", None, crate::types::test_support::test_id(), by, 1);
        doc.set_setting("a", Some(serde_json::json!(1)), by, 2);
        doc.set_setting("b", None, by, 3);

        let settings = doc.settings();
        assert_eq!(settings.len(), 2);
        assert_eq!(settings["a"], Some(serde_json::json!(1)));
        assert_eq!(settings["b"], None, "a reset reads as None, and is present");
    }

    #[test]
    fn set_setting_keeps_a_newer_builds_unrecognised_fields() {
        // Rule 6: a field a newer build wrote to this setting's content must
        // survive a local change, or this device erases it everywhere once it
        // wins the group.
        let mut doc = Document::new();
        let id = doc.set_setting("k", Some(serde_json::json!(1)), test_device(), 1);
        doc.node_mut(id)
            .unwrap()
            .content
            .extra
            .insert("from_a_newer_build".into(), serde_json::json!(true));

        doc.set_setting("k", Some(serde_json::json!(2)), test_device(), 2);

        assert_eq!(
            doc.node(id)
                .unwrap()
                .content
                .extra
                .get("from_a_newer_build"),
            Some(&serde_json::json!(true))
        );
    }

    #[test]
    fn set_setting_treats_a_json_null_as_a_reset() {
        // iOS and Android call this directly, without the wasm boundary's
        // parser. A stored JSON null would read back as a value here and as a
        // reset after a reload.
        let mut doc = Document::new();
        doc.set_setting("k", Some(serde_json::Value::Null), test_device(), 1);
        assert_eq!(doc.settings()["k"], None);
        assert!(!doc.to_json().unwrap().contains("\"value\""));
    }

    #[test]
    fn schema_major_is_pinned() {
        // A build refuses every file whose major exceeds its own (rule 11),
        // so moving this constant cuts every device on an older build off
        // from every file this build writes. It moves only by decision.
        assert_eq!(crate::SCHEMA_MAJOR, 2);
    }

    #[test]
    fn a_file_from_the_next_minor_reads_and_writes_back_what_it_added() {
        // Rule 6: an additive bump must stay readable by this build, and
        // whatever the newer build added must survive this build rewriting
        // the file, at every level a field can be added.
        let id = "018f0000-0000-7000-8000-000000000001";
        let json = format!(
            r#"{{
            "schema": {{ "major": {major}, "minor": {minor} }},
            "doc_extra": "d",
            "nodes": {{
                "{id}": {{
                    "kind": "workspace",
                    "content": {{ "name": "W", "content_extra": "c" }},
                    "content_at": 10,
                    "placement": {{ "order": "80", "placement_extra": "p" }},
                    "placement_at": 10,
                    "lifecycle": {{ "lifecycle_extra": "l" }},
                    "lifecycle_at": 10,
                    "appearance": {{ "color": "blue", "appearance_extra": "a" }},
                    "appearance_at": 10,
                    "node_extra": "n"
                }}
            }}
        }}"#,
            major = crate::SCHEMA_MAJOR,
            minor = crate::SCHEMA_MINOR + 1,
        );
        let doc = Document::from_json(&json).expect("a newer minor must read");
        let node_id = Uuid::parse_str(id).unwrap();
        assert_eq!(doc.node(node_id).unwrap().content.name, "W");

        let out: serde_json::Value =
            serde_json::from_str(&doc.to_json().expect("serialize")).unwrap();
        let node = &out["nodes"][id];
        assert_eq!(out["doc_extra"], "d");
        assert_eq!(node["node_extra"], "n");
        assert_eq!(node["content"]["content_extra"], "c");
        assert_eq!(node["placement"]["placement_extra"], "p");
        assert_eq!(node["lifecycle"]["lifecycle_extra"], "l");
        assert_eq!(node["appearance"]["appearance_extra"], "a");
    }

    #[test]
    fn an_agent_workspace_carries_its_mark_through_a_round_trip() {
        let mut doc = Document::new();
        let id = crate::types::test_support::test_id();
        let by = test_device();
        doc.add_agent_workspace("Claude Code", "Claude Code", id, by, 10);

        let back = Document::from_json(&doc.to_json().unwrap()).unwrap();
        let node = back.node(id).unwrap();
        assert_eq!(
            node.agent,
            Some(AgentMark {
                label: "Claude Code".into(),
                device: by
            }),
            "the mark names the agent and the device that paired it"
        );
        assert!(
            !node.extra.contains_key("agent"),
            "a named field must never land in the node-level bucket"
        );
    }

    #[test]
    fn a_device_workspace_carries_its_mark_through_a_round_trip() {
        let mut doc = Document::new();
        let id = crate::types::test_support::test_id();
        let by = test_device();
        doc.add_device_workspace("iPhone", id, by, 10);

        let back = Document::from_json(&doc.to_json().unwrap()).unwrap();
        let node = back.node(id).unwrap();
        assert_eq!(node.device_home, Some(DeviceMark { device: by }));
        assert_eq!(node.agent, None);
        assert!(!node.extra.contains_key("device_home"));
    }

    #[test]
    fn an_ordinary_workspace_writes_no_device_key() {
        let mut doc = Document::new();
        let id = crate::types::test_support::test_id();
        doc.add_workspace("W", None, id, test_device(), 10);
        let json = doc.to_json().unwrap();
        assert!(
            !json.contains("\"device_home\""),
            "absent, not null: {json}"
        );
    }

    #[test]
    fn an_ordinary_workspace_writes_no_agent_key() {
        let mut doc = Document::new();
        let id = crate::types::test_support::test_id();
        doc.add_workspace("W", None, id, test_device(), 10);
        let json = doc.to_json().unwrap();
        assert!(!json.contains("\"agent\""), "absent, not null: {json}");
    }

    #[test]
    fn a_file_from_before_the_mark_loads_with_none() {
        let older = r#"{
            "schema": { "major": 1, "minor": 2 },
            "nodes": {
                "018f0000-0000-7000-8000-000000000001": {
                    "kind": "workspace",
                    "content": { "name": "W" }, "content_at": 10,
                    "placement": { "order": "80" }, "placement_at": 10,
                    "lifecycle": {}, "lifecycle_at": 10
                }
            }
        }"#;
        let doc = Document::from_json(older).expect("a 1.2 file must load");
        let id = Uuid::parse_str("018f0000-0000-7000-8000-000000000001").unwrap();
        assert_eq!(doc.node(id).unwrap().agent, None);
    }

    #[test]
    fn document_round_trips_through_json() {
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "Client A",
            Some("📁".into()),
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        assert_eq!(doc.workspaces().count(), 1);

        let json = doc.to_json().expect("serialize");
        let back = Document::from_json(&json).expect("deserialize");

        assert_eq!(back.workspaces().count(), 1);
        assert_eq!(back.node(ws).unwrap().content.name, "Client A");
        assert_eq!(back.node(ws).unwrap().content.icon.as_deref(), Some("📁"));
    }

    #[test]
    fn unknown_fields_survive_a_round_trip() {
        // An older build must not silently delete fields a newer one wrote.
        // "future_field" sits inside the content object, the group it
        // belongs to (spec §5.1).
        let json = r#"{
            "schema": { "major": 1, "minor": 7 },
            "nodes": {
                "018f0000-0000-7000-8000-000000000001": {
                    "kind": "workspace",
                    "content": { "name": "From the future", "future_field": { "nested": true } },
                    "content_at": 1000,
                    "placement": { "order": "80" },
                    "placement_at": 1000,
                    "lifecycle": {},
                    "lifecycle_at": 1000
                }
            }
        }"#;
        let doc = Document::from_json(json).expect("deserialize");
        let out = doc.to_json().expect("serialize");
        assert!(out.contains("future_field"), "unknown field was dropped");
        assert!(out.contains("nested"), "nested unknown content was dropped");
    }

    #[test]
    fn an_entire_unknown_fact_group_survives_a_round_trip() {
        // Rule 6 at the node's own level. A group this build does not know
        // is an unrecognised node-level key, so no per-group bucket can hold
        // it. Without `Node::extra`, a build reading and rewriting this file
        // would delete the whole group.
        let from_a_later_build = r#"{
            "schema": { "major": 1, "minor": 9 },
            "nodes": {
                "018f0000-0000-7000-8000-000000000001": {
                    "kind": "workspace",
                    "content": { "name": "W" },
                    "content_at": 10,
                    "placement": { "order": "80" },
                    "placement_at": 10,
                    "lifecycle": {},
                    "lifecycle_at": 10,
                    "appearance": { "color": "blue" },
                    "appearance_at": 10,
                    "sound": { "chime": "soft", "volume": 3 },
                    "sound_at": 20,
                    "sound_by": "0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"
                }
            }
        }"#;
        let doc = Document::from_json(from_a_later_build).expect("deserialize");
        let id = Uuid::parse_str("018f0000-0000-7000-8000-000000000001").unwrap();
        let node = doc.node(id).unwrap();

        assert_eq!(
            node.extra["sound"],
            serde_json::json!({ "chime": "soft", "volume": 3 }),
            "an unknown group must land in the node's own bucket"
        );
        assert_eq!(node.extra["sound_at"], serde_json::json!(20));
        assert_eq!(
            node.extra["sound_by"],
            serde_json::json!("0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c")
        );

        // Written, read back, and written again: still there, at the node's
        // level.
        let rewritten = doc.to_json().expect("serialize");
        let back = Document::from_json(&rewritten).expect("re-deserialize");
        assert_eq!(
            back.node(id).unwrap().extra,
            node.extra,
            "the unknown group must survive this build reading and rewriting the file"
        );
        assert!(rewritten.contains("\"sound\""));
        assert!(rewritten.contains("\"chime\""));
    }

    #[test]
    fn the_node_level_bucket_does_not_swallow_the_groups_it_knows() {
        // A named field must always win over the node-level flattened map,
        // or the groups and their timestamps would be duplicated into the
        // bucket (see `Content`'s doc comment).
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            10,
        );
        doc.set_appearance(ws, Some("green".into()), None, None, test_device(), 20);

        let node = doc.node(ws).unwrap();
        assert!(
            node.extra.is_empty(),
            "no known field may leak into the node-level bucket: {:?}",
            node.extra
        );

        let json = doc.to_json().unwrap();
        let back = Document::from_json(&json).unwrap();
        let node = back.node(ws).unwrap();
        assert!(
            node.extra.is_empty(),
            "and none may leak back in on deserialise: {:?}",
            node.extra
        );
        assert_eq!(node.content.name, "W");
        assert_eq!(node.content_at, 10);
        assert_eq!(
            node.appearance
                .color
                .as_ref()
                .and_then(serde_json::Value::as_str),
            Some("green")
        );
        assert_eq!(node.appearance_at, 20);
        assert_eq!(node.appearance_by, Some(test_device()));

        // And each key appears once in the file, not once per catch-all.
        assert_eq!(json.matches("\"content_at\"").count(), 1);
        assert_eq!(json.matches("\"appearance\"").count(), 1);
    }

    #[test]
    fn set_label_keeps_the_look_and_leaves_content_byte_identical() {
        // A label never competes with the title a navigation writes, so it
        // touches only appearance, and a recolour never drops it.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            10,
        );
        let tab = doc.add_tab(
            ws,
            "Page",
            "https://e.example",
            crate::types::test_support::test_id(),
            test_device(),
            10,
        );
        doc.set_appearance(
            tab,
            Some("cyan".into()),
            Some("🐟".into()),
            None,
            test_device(),
            15,
        );
        let content_before = serde_json::to_string(&doc.node(tab).unwrap().content).unwrap();

        doc.set_label(tab, Some("Mine".into()), test_device(), 20);
        let node = doc.node(tab).unwrap();
        assert_eq!(node.appearance.label.as_deref(), Some("Mine"));
        assert_eq!(
            node.appearance
                .color
                .as_ref()
                .and_then(serde_json::Value::as_str),
            Some("cyan")
        );
        assert_eq!(node.appearance.emoji.as_deref(), Some("🐟"));
        assert_eq!(node.appearance_at, 20);
        assert_eq!(node.content_at, 10);
        assert_eq!(
            serde_json::to_string(&node.content).unwrap(),
            content_before
        );

        doc.set_appearance(tab, Some("green".into()), None, None, test_device(), 30);
        assert_eq!(
            doc.node(tab).unwrap().appearance.label.as_deref(),
            Some("Mine"),
            "a recolour keeps the label"
        );

        doc.set_label(tab, None, test_device(), 40);
        let node = doc.node(tab).unwrap();
        assert_eq!(node.appearance.label, None);
        assert_eq!(
            node.appearance
                .color
                .as_ref()
                .and_then(serde_json::Value::as_str),
            Some("green")
        );
        assert!(!doc.to_json().unwrap().contains("\"label\""));
    }

    #[test]
    fn refuses_a_newer_major_version() {
        let json = r#"{"schema":{"major":99,"minor":0},"nodes":{}}"#;
        let err = Document::from_json(json).expect_err("must refuse");
        assert!(matches!(err, Error::SchemaTooNew { major: 99, .. }));
    }

    #[test]
    fn rename_stamps_content_and_leaves_placement_and_lifecycle_byte_identical() {
        // Spec §5.1: renaming, moving and pinning are unrelated acts. A
        // rename that stamped any group but `content` would win conflicts it
        // has no part in. The other groups are compared as serialised bytes,
        // so a change to any field inside them fails this too.
        let mut doc = Document::new();
        let author = crate::store::DeviceId::from_bytes([1u8; 16]);
        let renamer = crate::store::DeviceId::from_bytes([2u8; 16]);
        let ws = doc.add_workspace("W", None, crate::types::test_support::test_id(), author, 10);
        let tab = doc.add_tab(
            ws,
            "before",
            "https://e.example",
            crate::types::test_support::test_id(),
            author,
            10,
        );
        doc.node_mut(tab).unwrap().lifecycle.pinned = true;
        doc.node_mut(tab).unwrap().lifecycle_at = 20;
        doc.set_appearance(
            tab,
            Some("cyan".into()),
            Some("🐟".into()),
            None,
            author,
            25,
        );

        let placement_before = serde_json::to_string(&doc.node(tab).unwrap().placement).unwrap();
        let lifecycle_before = serde_json::to_string(&doc.node(tab).unwrap().lifecycle).unwrap();
        let appearance_before = serde_json::to_string(&doc.node(tab).unwrap().appearance).unwrap();

        doc.rename(tab, "after", renamer, 30);

        let node = doc.node(tab).unwrap();
        assert_eq!(node.content.name, "after");
        assert_eq!(node.content_at, 30);
        assert_eq!(node.content_by, Some(renamer));

        assert_eq!(
            serde_json::to_string(&node.placement).unwrap(),
            placement_before,
            "a rename must not touch placement"
        );
        assert_eq!(
            node.placement_at, 10,
            "a rename must not stamp placement_at"
        );
        assert_eq!(node.placement_by, Some(author));
        assert_eq!(
            serde_json::to_string(&node.lifecycle).unwrap(),
            lifecycle_before,
            "a rename must not touch lifecycle"
        );
        assert_eq!(
            node.lifecycle_at, 20,
            "a rename must not stamp lifecycle_at"
        );
        assert_eq!(node.lifecycle_by, Some(author));
        assert_eq!(
            serde_json::to_string(&node.appearance).unwrap(),
            appearance_before,
            "a rename must not touch appearance"
        );
        assert_eq!(
            node.appearance_at, 25,
            "a rename must not stamp appearance_at"
        );
        assert_eq!(node.appearance_by, Some(author));

        // A renamed tab keeps its url.
        assert_eq!(node.content.url.as_deref(), Some("https://e.example"));
    }

    #[test]
    fn set_content_replaces_the_group_and_leaves_the_others_byte_identical() {
        // The group is the unit (spec §5.3): a content write rewrites name,
        // url and icon together under one `content_at`, and touches no other
        // group, so a tab that navigates never wins a placement conflict.
        let mut doc = Document::new();
        let author = crate::store::DeviceId::from_bytes([1u8; 16]);
        let writer = crate::store::DeviceId::from_bytes([2u8; 16]);
        let ws = doc.add_workspace("W", None, crate::types::test_support::test_id(), author, 10);
        let tab = doc.add_tab(
            ws,
            "example.com/",
            "https://example.com/",
            crate::types::test_support::test_id(),
            author,
            10,
        );
        doc.node_mut(tab).unwrap().content.icon = Some("old-icon".into());
        doc.node_mut(tab).unwrap().lifecycle.pinned = true;
        doc.node_mut(tab).unwrap().lifecycle_at = 20;
        doc.set_appearance(tab, Some("orange".into()), None, None, author, 25);

        let placement_before = serde_json::to_string(&doc.node(tab).unwrap().placement).unwrap();
        let lifecycle_before = serde_json::to_string(&doc.node(tab).unwrap().lifecycle).unwrap();
        let appearance_before = serde_json::to_string(&doc.node(tab).unwrap().appearance).unwrap();

        doc.set_content(
            tab,
            "Example Domain",
            Some("https://example.com/welcome".into()),
            Some("new-icon".into()),
            None,
            false,
            writer,
            30,
        );

        let node = doc.node(tab).unwrap();
        assert_eq!(node.content.name, "Example Domain");
        assert_eq!(
            node.content.url.as_deref(),
            Some("https://example.com/welcome"),
            "following a navigation is what this call exists for"
        );
        assert_eq!(node.content.icon.as_deref(), Some("new-icon"));
        assert_eq!(node.content_at, 30);
        assert_eq!(node.content_by, Some(writer));

        assert_eq!(
            serde_json::to_string(&node.placement).unwrap(),
            placement_before,
            "a content write must not touch placement"
        );
        assert_eq!(
            node.placement_at, 10,
            "a content write must not stamp placement_at"
        );
        assert_eq!(node.placement_by, Some(author));
        assert_eq!(
            serde_json::to_string(&node.lifecycle).unwrap(),
            lifecycle_before,
            "a content write must not touch lifecycle"
        );
        assert_eq!(
            node.lifecycle_at, 20,
            "a content write must not stamp lifecycle_at"
        );
        assert_eq!(node.lifecycle_by, Some(author));
        assert_eq!(
            serde_json::to_string(&node.appearance).unwrap(),
            appearance_before,
            "a content write must not touch appearance"
        );
        assert_eq!(
            node.appearance_at, 25,
            "a content write must not stamp appearance_at"
        );
        assert_eq!(node.appearance_by, Some(author));

        assert_eq!(
            crate::tree::children(&doc, ws),
            vec![tab],
            "and it must not reorder the node"
        );
    }

    #[test]
    fn set_content_clears_a_field_the_caller_omits() {
        // The group is the unit: a caller that sends a stale picture of the
        // group overwrites what it left out. Hosts do a read-modify-write for
        // this reason (`docs/host-contract.md` §3).
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let tab = doc.add_tab(
            ws,
            "named",
            "https://e.example/",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        doc.node_mut(tab).unwrap().content.icon = Some("icon".into());

        doc.set_content(tab, "", None, None, None, false, test_device(), 10);

        let content = &doc.node(tab).unwrap().content;
        assert_eq!(content.name, "");
        assert_eq!(content.url, None);
        assert_eq!(content.icon, None);
    }

    #[test]
    fn set_content_keeps_a_newer_builds_unrecognised_fields() {
        // `extra` holds fields a newer build wrote to this group. A host
        // cannot name them, so a local write that dropped them would make this
        // device the one that erases what a newer peer knows.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let tab = doc.add_tab(
            ws,
            "t",
            "https://e.example/",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        doc.node_mut(tab)
            .unwrap()
            .content
            .extra
            .insert("from_a_newer_build".into(), serde_json::json!(true));

        doc.set_content(
            tab,
            "t",
            Some("https://e.example/next".into()),
            None,
            None,
            false,
            test_device(),
            10,
        );

        assert_eq!(
            doc.node(tab).unwrap().content.extra["from_a_newer_build"],
            serde_json::json!(true)
        );
    }

    #[test]
    fn set_content_on_an_unknown_id_changes_nothing() {
        let mut doc = Document::new();
        doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let before = doc.to_json().unwrap();

        doc.set_content(
            crate::types::test_support::test_id(),
            "nobody",
            Some("https://nowhere.example/".into()),
            None,
            None,
            false,
            test_device(),
            100,
        );

        assert_eq!(doc.to_json().unwrap(), before);
    }

    #[test]
    fn rename_does_not_reorder_the_node_among_its_siblings() {
        // `add_*` computes an order key after every existing sibling, so a
        // rename spelled as a re-add would move the node to the end.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let first = doc.add_tab(
            ws,
            "a",
            "https://a.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let second = doc.add_tab(
            ws,
            "b",
            "https://b.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );

        doc.rename(first, "a renamed", test_device(), 100);

        assert_eq!(
            crate::tree::children(&doc, ws),
            vec![first, second],
            "the renamed node must keep its place"
        );
    }

    #[test]
    fn rename_on_an_unknown_id_changes_nothing() {
        // The native mutators no-op on a missing id. The WASM boundary is
        // where an unknown id becomes an error (`wasm::require_node`).
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let before = doc.to_json().unwrap();

        doc.rename(
            crate::types::test_support::test_id(),
            "nobody",
            test_device(),
            100,
        );

        assert_eq!(doc.to_json().unwrap(), before);
        assert_eq!(doc.node(ws).unwrap().content.name, "W");
    }

    #[test]
    fn remove_deletes_the_record_and_leaves_nothing_behind() {
        // Closing a tab is a deletion (spec §5.1, §5.4): no record, no
        // timestamp, no marker.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "Client A",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let tab = doc.add_tab(
            ws,
            "t",
            "https://e.example",
            crate::types::test_support::test_id(),
            test_device(),
            100,
        );

        doc.remove(tab);

        assert!(!doc.nodes.contains_key(&tab), "the record must be gone");
        assert!(doc.node(tab).is_none());
        let json = doc.to_json().unwrap();
        assert!(
            !json.contains(&tab.to_string()),
            "no trace of the removed node may survive serialisation: {json}"
        );
    }

    #[test]
    fn remove_takes_everything_beneath_the_node() {
        // "Delete group" with its contents, and "Delete workspace": nothing
        // that was inside is left anywhere, here or on a peer that merges
        // this file.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let other = doc.add_workspace(
            "Other",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let group = doc.add_group(
            ws,
            "G",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let inner = doc.add_group(
            group,
            "Inner",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let tab = doc.add_tab(
            inner,
            "t",
            "https://e.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );

        doc.remove(group);

        assert!(doc.node(group).is_none());
        assert!(doc.node(inner).is_none(), "a group inside goes too");
        assert!(doc.node(tab).is_none(), "a tab inside goes too");
        assert!(crate::tree::repair_unreachable_ancestry(&mut doc).is_empty());
        assert!(crate::tree::children(&doc, other).is_empty());
        assert!(doc.node(ws).is_some());
    }

    #[test]
    fn stamp_write_records_the_write_in_the_version_vector() {
        let mut doc = Document::new();
        let device = crate::store::DeviceId::from_bytes([3u8; 16]);
        assert_eq!(doc.written_at, 0);
        assert_eq!(doc.written_by, None);

        doc.stamp_write(device, 900);

        assert_eq!(doc.written_at, 900);
        assert_eq!(doc.written_by, Some(device));
        assert_eq!(
            doc.seen.get(&device),
            Some(&900),
            "our own write must be recorded in `seen`, or our own stored file \
             resurrects what we deleted since writing it"
        );

        // Never moves backwards: a stale `now` must not un-see a later write.
        doc.stamp_write(device, 100);
        assert_eq!(doc.seen.get(&device), Some(&900));
    }

    /// Only this device's stamps later than `now` move: a peer's later stamp
    /// is the peer's, and an earlier stamp of our own already happened
    /// (decision 1714).
    #[test]
    fn pulling_back_moves_only_our_own_stamps_ahead_of_now() {
        let (me, peer) = (
            crate::store::DeviceId::from_bytes([0x4a; 16]),
            crate::store::DeviceId::from_bytes([0x4b; 16]),
        );
        let mut doc = Document::new();
        let ws = doc.add_workspace("W", None, Uuid::from_u128(1), me, 100);
        let ahead = doc.add_tab(ws, "A", "https://a.example", Uuid::from_u128(2), me, 900);
        let theirs = doc.add_tab(ws, "P", "https://p.example", Uuid::from_u128(3), peer, 900);
        doc.stamp_write(me, 900);
        doc.seen.insert(peer, 900);

        doc.pull_back_own_stamps(me, 500);

        assert_eq!(doc.node(ahead).unwrap().content_at, 500);
        assert_eq!(doc.node(ahead).unwrap().placement_at, 500);
        assert_eq!(
            doc.node(ws).unwrap().content_at,
            100,
            "an earlier own stamp stays"
        );
        assert_eq!(
            doc.node(theirs).unwrap().content_at,
            900,
            "a peer's stamp stays"
        );
        assert_eq!(doc.seen.get(&me), Some(&500));
        assert_eq!(doc.seen.get(&peer), Some(&900));
        assert_eq!(doc.written_at, 500);
    }

    /// A node nobody touched writes no touch keys, so its file is what a
    /// build without the stamp writes; a touched one round-trips its stamp,
    /// and a touch changes no fact group.
    #[test]
    fn the_touch_stamp_is_written_only_once_touched() {
        let device = crate::store::DeviceId::from_bytes([0x2b; 16]);
        let mut doc = Document::new();
        let ws = doc.add_workspace("W", None, crate::types::test_support::test_id(), device, 5);
        let json = doc.to_json().unwrap();
        assert!(!json.contains("touched_at"), "{json}");
        assert!(!json.contains("touched_by"), "{json}");

        let before = serde_json::to_value(doc.node(ws).unwrap()).unwrap();
        doc.touch(ws, device, 9);
        let mut after = serde_json::to_value(doc.node(ws).unwrap()).unwrap();
        let object = after.as_object_mut().unwrap();
        assert_eq!(object.remove("touched_at"), Some(serde_json::json!(9)));
        assert!(object.remove("touched_by").is_some());
        assert_eq!(after, before, "no fact group moved");

        let back = Document::from_json(&doc.to_json().unwrap()).unwrap();
        assert_eq!(back.node(ws).unwrap().touched_at, 9);
        assert_eq!(back.node(ws).unwrap().touched_by, Some(device));
    }

    #[test]
    fn per_group_attribution_round_trips_and_is_optional() {
        let device = crate::store::DeviceId::from_bytes([0x2b; 16]);
        let mut doc = Document::new();
        let ws = doc.add_workspace("W", None, crate::types::test_support::test_id(), device, 0);

        let back = Document::from_json(&doc.to_json().unwrap()).unwrap();
        let node = back.node(ws).unwrap();
        assert_eq!(node.content_by, Some(device));
        assert_eq!(node.placement_by, Some(device));
        assert_eq!(node.lifecycle_by, Some(device));
        assert_eq!(node.appearance_by, Some(device));
        assert_eq!(
            node.attributions(),
            [
                (Some(device), 0),
                (Some(device), 0),
                (Some(device), 0),
                (Some(device), 0),
                (None, 0)
            ]
        );

        // A file with no attribution reads back as unattributed, which the
        // absence rule treats as news (spec §5.4).
        let older = r#"{
            "schema": { "major": 1, "minor": 0 },
            "nodes": {
                "018f0000-0000-7000-8000-000000000001": {
                    "kind": "tab",
                    "content": { "name": "x" },
                    "content_at": 5,
                    "placement": { "order": "80" },
                    "placement_at": 5,
                    "lifecycle": {},
                    "lifecycle_at": 5
                }
            }
        }"#;
        let doc = Document::from_json(older).unwrap();
        let id = Uuid::parse_str("018f0000-0000-7000-8000-000000000001").unwrap();
        let node = doc.node(id).unwrap();
        assert_eq!(node.content_by, None);
        assert_eq!(node.placement_by, None);
        assert_eq!(node.lifecycle_by, None);
        assert_eq!(node.appearance_by, None);
    }

    #[test]
    fn the_version_vector_round_trips_through_json() {
        let mut doc = Document::new();
        let device = crate::store::DeviceId::from_bytes([0xab; 16]);
        doc.stamp_write(device, 1_234);

        let back = Document::from_json(&doc.to_json().unwrap()).unwrap();

        assert_eq!(back.written_at, 1_234);
        assert_eq!(back.written_by, Some(device));
        assert_eq!(back.seen.get(&device), Some(&1_234));
    }

    #[test]
    fn a_file_without_a_version_vector_still_parses() {
        // A file without these fields reads back as "never written, nothing
        // incorporated", the state in which absence carries no evidence.
        let json = r#"{"schema":{"major":1,"minor":0},"nodes":{}}"#;
        let doc = Document::from_json(json).unwrap();
        assert_eq!(doc.written_at, 0);
        assert_eq!(doc.written_by, None);
        assert!(doc.seen.is_empty());
    }

    #[test]
    fn group_icon_round_trips_through_json() {
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "Client A",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let g = doc.add_group(
            ws,
            "Reading",
            Some("📚".into()),
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );

        let json = doc.to_json().expect("serialize");
        let back = Document::from_json(&json).expect("deserialize");

        assert_eq!(back.node(g).unwrap().content.icon.as_deref(), Some("📚"));
    }

    #[test]
    fn a_node_of_an_unknown_kind_round_trips_verbatim() {
        // Rule 6 for the kind itself: a kind added by a newer build is an
        // additive change, so this build must carry the node and write it
        // back exactly as it arrived.
        let id = "018f0000-0000-7000-8000-000000000002";
        let json = format!(
            r#"{{
            "schema": {{ "major": 1, "minor": 9 }},
            "nodes": {{
                "{id}": {{
                    "kind": "note",
                    "content": {{ "name": "x" }},
                    "content_at": 5,
                    "placement": {{ "order": "80" }},
                    "placement_at": 5,
                    "lifecycle": {{}},
                    "lifecycle_at": 5
                }}
            }}
        }}"#
        );
        let doc = Document::from_json(&json).expect("an unknown kind must parse");
        let out: serde_json::Value =
            serde_json::from_str(&doc.to_json().expect("serialize")).unwrap();
        assert_eq!(out["nodes"][id]["kind"], "note");
    }

    #[test]
    fn refuses_a_newer_major_version_even_with_an_unknown_node_kind() {
        // The schema check runs before the nodes are read, so a newer major
        // version is reported as SchemaTooNew whatever its nodes contain.
        let json = r#"{
            "schema": { "major": 99, "minor": 0 },
            "nodes": {
                "018f0000-0000-7000-8000-000000000001": {
                    "kind": "future_kind",
                    "content": { "name": "x" },
                    "content_at": 0,
                    "placement": { "order": "80" },
                    "placement_at": 0,
                    "lifecycle": {},
                    "lifecycle_at": 0
                }
            }
        }"#;
        let err = Document::from_json(json).expect_err("must refuse");
        assert!(matches!(err, Error::SchemaTooNew { major: 99, .. }));
    }

    #[test]
    fn pinned_lives_in_lifecycle_not_content() {
        // Spec §5.1: in content, pinning on one device would collide with a
        // rename on another.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let tab = doc.add_tab(
            ws,
            "t",
            "https://e.example",
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        doc.node_mut(tab).unwrap().lifecycle.pinned = true;
        doc.node_mut(tab).unwrap().lifecycle_at = 10;

        let json = doc.to_json().unwrap();
        let back = Document::from_json(&json).unwrap();
        assert!(
            back.node(tab).unwrap().lifecycle.pinned,
            "pinned must round-trip"
        );
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let node = &value["nodes"][tab.to_string()];
        assert!(
            node["content"].get("pinned").is_none(),
            "pinned must not serialise as part of content: {}",
            node["content"]
        );
        assert_eq!(node["lifecycle"]["pinned"], serde_json::Value::Bool(true));
    }

    #[test]
    fn set_isolation_writes_lifecycle_only_and_keeps_pinned() {
        // Isolated workspaces spec §3: the flag is lifecycle state, so an
        // isolation write must reach nothing a rename, move or recolour owns.
        let mut doc = Document::new();
        let author = crate::store::DeviceId::from_bytes([1u8; 16]);
        let isolator = crate::store::DeviceId::from_bytes([2u8; 16]);
        let ws = doc.add_workspace("W", None, crate::types::test_support::test_id(), author, 10);
        doc.set_appearance(ws, Some("blue".into()), None, None, author, 15);
        doc.node_mut(ws).unwrap().lifecycle.pinned = true;
        let before = doc.node(ws).unwrap().clone();

        doc.set_isolation(ws, true, isolator, 30);

        let after = doc.node(ws).unwrap();
        assert!(after.lifecycle.isolated);
        assert!(
            after.lifecycle.pinned,
            "the rest of the group is carried over"
        );
        assert_eq!(after.lifecycle_at, 30);
        assert_eq!(after.lifecycle_by, Some(isolator));
        assert_eq!(after.content, before.content);
        assert_eq!(after.content_at, before.content_at);
        assert_eq!(after.placement, before.placement);
        assert_eq!(after.placement_at, before.placement_at);
        assert_eq!(after.appearance, before.appearance);
        assert_eq!(after.appearance_at, before.appearance_at);
    }

    #[test]
    fn isolated_round_trips_and_is_absent_when_false() {
        let mut doc = Document::new();
        let shared = doc.add_workspace(
            "S",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let isolated = doc.add_workspace(
            "I",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        doc.set_isolation(isolated, true, test_device(), 5);

        let json = doc.to_json().unwrap();
        assert_eq!(
            json.matches("\"isolated\"").count(),
            1,
            "a shared workspace writes no isolated key, so older files stay byte-identical"
        );
        let back = Document::from_json(&json).unwrap();
        assert!(back.node(isolated).unwrap().lifecycle.isolated);
        assert!(!back.node(shared).unwrap().lifecycle.isolated);
    }

    #[test]
    fn isolation_and_a_concurrent_rename_both_survive_a_merge() {
        // Spec §5.1: the groups never compete. One device isolates the
        // workspace while another renames it; both edits must win.
        let ws_id = crate::types::test_support::test_id();
        let mut a = Document::new();
        a.add_workspace("W", None, ws_id, test_device(), 0);
        let mut b = a.clone();
        let other = crate::store::DeviceId::from_bytes([7u8; 16]);
        a.set_isolation(ws_id, true, test_device(), 10);
        b.rename(ws_id, "Renamed", other, 20);

        crate::merge::merge(&mut a, &b);
        crate::merge::merge(&mut b, &a);

        for doc in [&a, &b] {
            let node = doc.node(ws_id).unwrap();
            assert!(node.lifecycle.isolated);
            assert_eq!(node.content.name, "Renamed");
        }
    }

    #[test]
    fn set_appearance_replaces_the_group_and_leaves_the_others_byte_identical() {
        // Spec §5.1: a recolour writes `appearance`, `appearance_at` and
        // `appearance_by` and nothing else, so it never competes with a
        // concurrent rename.
        let mut doc = Document::new();
        let author = crate::store::DeviceId::from_bytes([1u8; 16]);
        let painter = crate::store::DeviceId::from_bytes([2u8; 16]);
        let ws = doc.add_workspace("W", None, crate::types::test_support::test_id(), author, 10);
        doc.node_mut(ws).unwrap().lifecycle.pinned = true;
        doc.node_mut(ws).unwrap().lifecycle_at = 20;

        let content_before = serde_json::to_string(&doc.node(ws).unwrap().content).unwrap();
        let placement_before = serde_json::to_string(&doc.node(ws).unwrap().placement).unwrap();
        let lifecycle_before = serde_json::to_string(&doc.node(ws).unwrap().lifecycle).unwrap();

        doc.set_appearance(
            ws,
            Some("purple".into()),
            Some("🌳".into()),
            None,
            painter,
            30,
        );

        let node = doc.node(ws).unwrap();
        assert_eq!(
            node.appearance
                .color
                .as_ref()
                .and_then(serde_json::Value::as_str),
            Some("purple")
        );
        assert_eq!(node.appearance.emoji.as_deref(), Some("🌳"));
        assert_eq!(node.appearance_at, 30);
        assert_eq!(node.appearance_by, Some(painter));

        assert_eq!(
            serde_json::to_string(&node.content).unwrap(),
            content_before,
            "a recolour must not touch content"
        );
        assert_eq!(node.content_at, 10, "a recolour must not stamp content_at");
        assert_eq!(node.content_by, Some(author));
        assert_eq!(
            serde_json::to_string(&node.placement).unwrap(),
            placement_before,
            "a recolour must not touch placement"
        );
        assert_eq!(
            node.placement_at, 10,
            "a recolour must not stamp placement_at"
        );
        assert_eq!(node.placement_by, Some(author));
        assert_eq!(
            serde_json::to_string(&node.lifecycle).unwrap(),
            lifecycle_before,
            "a recolour must not touch lifecycle"
        );
        assert_eq!(
            node.lifecycle_at, 20,
            "a recolour must not stamp lifecycle_at"
        );
        assert_eq!(node.lifecycle_by, Some(author));
    }

    #[test]
    fn set_appearance_clears_a_field_the_caller_omits() {
        // The group is the unit, as in `set_content`: sending `None` removes
        // an appearance.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        doc.set_appearance(
            ws,
            Some("green".into()),
            Some("🌿".into()),
            None,
            test_device(),
            10,
        );

        doc.set_appearance(ws, None, None, None, test_device(), 20);

        let appearance = &doc.node(ws).unwrap().appearance;
        assert_eq!(appearance.color, None);
        assert_eq!(appearance.emoji, None);
        assert_eq!(doc.node(ws).unwrap().appearance_at, 20);
    }

    #[test]
    fn set_appearance_stores_whatever_token_it_is_given() {
        // Validation lives at the WASM boundary, which can report a bad value
        // back to a host (see `Appearance`).
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );

        doc.set_appearance(ws, Some("#ff00ff".into()), None, None, test_device(), 10);

        assert_eq!(
            doc.node(ws)
                .unwrap()
                .appearance
                .color
                .as_ref()
                .and_then(serde_json::Value::as_str),
            Some("#ff00ff")
        );
    }

    #[test]
    fn set_appearance_keeps_a_newer_builds_unrecognised_fields() {
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        doc.node_mut(ws)
            .unwrap()
            .appearance
            .extra
            .insert("gradient".into(), serde_json::json!("dawn"));

        doc.set_appearance(ws, Some("pink".into()), None, None, test_device(), 10);

        assert_eq!(
            doc.node(ws).unwrap().appearance.extra["gradient"],
            serde_json::json!("dawn")
        );
    }

    #[test]
    fn set_appearance_on_an_unknown_id_changes_nothing() {
        let mut doc = Document::new();
        doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let before = doc.to_json().unwrap();

        doc.set_appearance(
            crate::types::test_support::test_id(),
            Some("red".into()),
            None,
            None,
            test_device(),
            100,
        );

        assert_eq!(doc.to_json().unwrap(), before);
    }

    #[test]
    fn an_unknown_field_inside_appearance_round_trips() {
        // Rule 6: a field a newer build wrote inside `appearance` survives
        // this build reading and rewriting the file, inside the group.
        let json = r#"{
            "schema": { "major": 1, "minor": 9 },
            "nodes": {
                "018f0000-0000-7000-8000-000000000001": {
                    "kind": "workspace",
                    "content": { "name": "Painted" },
                    "content_at": 1000,
                    "placement": { "order": "80" },
                    "placement_at": 1000,
                    "lifecycle": {},
                    "lifecycle_at": 1000,
                    "appearance": { "color": "blue", "gradient": { "from": "dawn" } },
                    "appearance_at": 1000
                }
            }
        }"#;
        let doc = Document::from_json(json).expect("deserialize");
        let id = Uuid::parse_str("018f0000-0000-7000-8000-000000000001").unwrap();
        let node = doc.node(id).unwrap();
        assert_eq!(
            node.appearance
                .color
                .as_ref()
                .and_then(serde_json::Value::as_str),
            Some("blue")
        );
        assert_eq!(
            node.appearance.extra["gradient"],
            serde_json::json!({ "from": "dawn" }),
            "the unknown field must land in this group's own bucket"
        );

        let back = Document::from_json(&doc.to_json().expect("serialize")).unwrap();
        assert_eq!(
            back.node(id).unwrap().appearance,
            node.appearance,
            "the appearance group must round-trip untouched, unknown field included"
        );
    }

    #[test]
    fn a_document_written_without_appearance_loads_with_none() {
        // A file with no `appearance` key loads with the group empty.
        let json = r#"{
            "schema": { "major": 1, "minor": 1 },
            "nodes": {
                "018f0000-0000-7000-8000-000000000001": {
                    "kind": "workspace",
                    "content": { "name": "Before colour" },
                    "content_at": 5,
                    "placement": { "order": "80" },
                    "placement_at": 5,
                    "lifecycle": {},
                    "lifecycle_at": 5
                }
            }
        }"#;
        let doc = Document::from_json(json).expect("a file without appearance must load");
        let id = Uuid::parse_str("018f0000-0000-7000-8000-000000000001").unwrap();
        let node = doc.node(id).unwrap();
        assert_eq!(node.appearance.color, None);
        assert_eq!(node.appearance.emoji, None);
        assert!(node.appearance.extra.is_empty());
        assert_eq!(node.appearance_at, 0);
        assert_eq!(
            node.appearance_by, None,
            "nothing may be invented about who wrote a group nobody wrote"
        );
    }

    #[test]
    fn a_recolour_changes_the_shared_state_a_write_is_decided_from() {
        // `sync` writes only when `shared_state_json` differs from what it
        // last published (spec §5.4, §6.5). A recolour absent from it would
        // never leave the device that made it.
        let mut doc = Document::new();
        let ws = doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let before = test_support::shared_state(&doc);

        doc.set_appearance(ws, Some("yellow".into()), None, None, test_device(), 10);

        assert_ne!(
            test_support::shared_state(&doc),
            before,
            "a recolour must change the shared state, or it never publishes"
        );
        assert!(test_support::shared_state(&doc).contains("yellow"));
    }

    #[test]
    fn no_struct_uses_rename_all_and_on_disk_names_stay_snake_case() {
        // Spec §5.1, §5.5: on-disk field names match the Rust field names.
        // This pins the serialised bytes, which catches renaming however it
        // is introduced.
        let mut doc = Document::new();
        doc.add_workspace(
            "W",
            None,
            crate::types::test_support::test_id(),
            test_device(),
            0,
        );
        let json = doc.to_json().unwrap();
        for key in [
            "content_at",
            "placement_at",
            "lifecycle_at",
            "appearance_at",
            "kind",
            "schema",
        ] {
            assert!(
                json.contains(key),
                "expected snake_case key {key} in {json}"
            );
        }
        assert!(!json.contains("contentAt"));
        assert!(!json.contains("placementAt"));
        assert!(!json.contains("lifecycleAt"));
        assert!(!json.contains("appearanceAt"));
        assert!(!json.contains("appearanceBy"));
    }

    proptest::proptest! {
        /// A peer's file is untrusted input: whatever its bytes, reading it
        /// answers `Ok` or `Err` and never panics, which in the wasm build
        /// would take the engine down.
        #[test]
        fn reading_any_text_never_panics(text in ".*") {
            let _ = Document::from_json(&text);
        }

        /// The same, from a real document with one byte changed, which
        /// reaches far deeper into the parser than random text does.
        #[test]
        fn reading_a_damaged_document_never_panics(at in 0usize..4096, byte in 0u8..128) {
            let mut json = test_support::base_doc().to_json().unwrap().into_bytes();
            let at = at % json.len();
            json[at] = byte;
            if let Ok(text) = String::from_utf8(json) {
                let _ = Document::from_json(&text);
            }
        }
    }
}
