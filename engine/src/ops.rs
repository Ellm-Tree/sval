// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The changes a host makes to a document: each operation as a host spells
//! it, the checks on what a host passes, and the batch that applies several
//! operations or none. The `wasm` and `ffi` boundaries both apply a change
//! through [`apply_op`] or [`apply_batch`], so a desktop and a phone refuse
//! the same input with the same failure.

use crate::failure::{Failure, Invalid, Reason};
use crate::store::DeviceId;
use crate::types::{Document, NodeId, NodeKind, Timestamp};

/// JS's `Number.MAX_SAFE_INTEGER` (`2^53 - 1`): the largest integer an `f64`
/// represents exactly. A timestamp beyond it lost precision on the JS side,
/// so it is rejected.
pub(crate) const MAX_SAFE_TIMESTAMP: f64 = 9_007_199_254_740_991.0;

/// Validates and converts a host-supplied timestamp.
///
/// `as u64` saturates: `NaN` and negatives become `0`, and huge values
/// become `u64::MAX`. A host passing `undefined` (coerced to `NaN`) would
/// get timestamp `0`, and the edit would lose every last-writer-wins
/// comparison. `Infinity` would pin a node at `u64::MAX`, un-editable on
/// every device. Both are rejected.
pub(crate) fn parse_timestamp(now: f64) -> Result<Timestamp, Invalid> {
    if !now.is_finite() {
        return Err(Invalid::new(
            Reason::TimestampNotFinite,
            format!("timestamp must be a finite number, got {now}"),
        ));
    }
    if !(0.0..=MAX_SAFE_TIMESTAMP).contains(&now) {
        return Err(Invalid::new(
            Reason::TimestampOutOfRange,
            format!(
                "timestamp out of range 0..={MAX_SAFE_TIMESTAMP} (JS's Number.MAX_SAFE_INTEGER): got {now}"
            ),
        ));
    }
    Ok(now as u64)
}

pub(crate) fn parse_id(id: &str) -> Result<NodeId, Invalid> {
    NodeId::parse_str(id)
        .map_err(|_| Invalid::new(Reason::BadNodeId, format!("not a valid node id: {id}")))
}

/// The preset colour tokens Sval's palette draws
/// (`SvalPanelModel.COLOR_TOKENS`). A synced document holding a colour outside
/// [`parse_color`]'s shapes is a rendering bug on every device that reads it.
/// `Document::set_appearance` stores whatever it is given, because the palette
/// is a presentation concern, so this boundary refuses an invalid colour.
const COLOR_TOKENS: [&str; 10] = [
    "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray", "black",
];

/// The keys of a workspace's custom colour: OKLCH hue, chroma and lightness,
/// and the appearance it was picked in (decision 0057).
const WORKSPACE_COLOR_KEYS: [&str; 4] = ["c", "h", "l", "mode"];

/// The keys of a group's custom colour: OKLCH hue and chroma. Its window sets
/// its lightness (decision 0057).
const GROUP_COLOR_KEYS: [&str; 2] = ["c", "h"];

/// The largest chroma a custom colour may carry, past the most any sRGB
/// colour reaches in OKLCH.
const MAX_CHROMA: f64 = 0.4;
/// An agent label is shown on every device the document reaches, so an empty
/// one is refused.
fn parse_agent_label(label: &str) -> Result<String, Invalid> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err(Invalid::new(
            Reason::EmptyAgentLabel,
            "an agent label must not be empty",
        ));
    }
    Ok(trimmed.to_owned())
}

/// Checks `color` for a node of `kind`: a preset token on any node, or a
/// custom colour object in the shape its kind takes (decision 0057). `None`
/// clears the colour and is always accepted.
///
/// A custom colour is rebuilt from its parsed numbers, so a whole number a
/// host sends as `200` is stored as `200.0` on every device, whichever way
/// that host's JSON writes it.
fn parse_color(
    kind: &NodeKind,
    color: Option<serde_json::Value>,
) -> Result<Option<serde_json::Value>, Invalid> {
    let bad = |message: String| Invalid::new(Reason::BadColor, message);
    let fields = match color {
        None => return Ok(None),
        Some(serde_json::Value::String(token)) => {
            if COLOR_TOKENS.contains(&token.as_str()) {
                return Ok(Some(serde_json::Value::String(token)));
            }
            return Err(bad(format!(
                "not a valid colour token: {token} (expected one of {})",
                COLOR_TOKENS.join(", ")
            )));
        }
        Some(serde_json::Value::Object(fields)) => fields,
        Some(other) => {
            return Err(bad(format!(
                "a colour is a token or an object: got {other}"
            )));
        }
    };
    let keys: &[&str] = match kind {
        NodeKind::Workspace => &WORKSPACE_COLOR_KEYS,
        NodeKind::Group => &GROUP_COLOR_KEYS,
        _ => {
            return Err(bad(format!(
                "only a workspace or a group takes a custom colour: this is a {kind:?}"
            )));
        }
    };
    if !fields.keys().map(String::as_str).eq(keys.iter().copied()) {
        let got: Vec<&str> = fields.keys().map(String::as_str).collect();
        return Err(bad(format!(
            "a {kind:?}'s custom colour takes exactly the keys {}: got {}",
            keys.join(", "),
            got.join(", ")
        )));
    }
    let number = |key: &str, max: f64, max_included: bool| -> Result<f64, Invalid> {
        let value = &fields[key];
        match value.as_f64() {
            Some(n) if n >= 0.0 && (n < max || max_included && n == max) => Ok(n),
            _ => {
                let close = if max_included { "]" } else { ")" };
                Err(bad(format!(
                    "a custom colour's {key} must be a number in [0, {max}{close}: got {value}"
                )))
            }
        }
    };
    let h = number("h", 360.0, false)?;
    let c = number("c", MAX_CHROMA, true)?;
    if *kind == NodeKind::Group {
        return Ok(Some(serde_json::json!({ "h": h, "c": c })));
    }
    let l = number("l", 1.0, true)?;
    let mode = match fields["mode"].as_str() {
        Some(mode @ ("dark" | "light")) => mode,
        _ => {
            return Err(bad(format!(
                "a custom colour's mode must be \"dark\" or \"light\": got {}",
                fields["mode"]
            )));
        }
    };
    Ok(Some(
        serde_json::json!({ "h": h, "c": c, "l": l, "mode": mode }),
    ))
}

/// Checks a transparency for a node of `kind`: only a workspace's window
/// shows what is behind it (decision 0057). `None` is solid and always
/// accepted.
fn parse_transparency(kind: &NodeKind, transparency: Option<f64>) -> Result<Option<f64>, Invalid> {
    let Some(t) = transparency else {
        return Ok(None);
    };
    if *kind != NodeKind::Workspace {
        return Err(Invalid::new(
            Reason::BadColor,
            format!("only a workspace takes a transparency: this is a {kind:?}"),
        ));
    }
    if !(0.0..=1.0).contains(&t) {
        return Err(Invalid::new(
            Reason::BadColor,
            format!("transparency must be a number in [0, 1]: got {t}"),
        ));
    }
    Ok(Some(t))
}

/// Parses a host-supplied device id: exactly the 16 bytes the host generated
/// once and persists (`docs/host-contract.md` §3). Any other length is
/// rejected.
///
/// Every mutator that stamps a fact group takes this, because the group
/// records who last wrote it as well as when (spec §5.4), and the crate has no
/// identity of its own, as it has no clock. It must be the value the host
/// uses for its own file name, the same across the device's lifetime, or its
/// peers' watermarks name a device that never writes again.
pub(crate) fn parse_device_id(bytes: &[u8]) -> Result<DeviceId, Invalid> {
    let bytes: [u8; 16] = bytes.try_into().map_err(|_| {
        Invalid::new(
            Reason::BadDeviceId,
            format!("device id must be exactly 16 bytes, got {}", bytes.len()),
        )
    })?;
    Ok(DeviceId::from_bytes(bytes))
}

/// Confirms `id` names a node that exists, so a mutator either succeeds or
/// reports an error.
///
/// The `Document` methods no-op on a missing id, so without this a host's
/// `remove` or `rename` of an unknown id would report success. `addTab` under
/// a missing parent would create an orphan that
/// `tree::repair_unreachable_ancestry` later reparents somewhere the user
/// never put it.
fn require_node(doc: &Document, id: NodeId) -> Result<(), Failure> {
    node_kind(doc, id).map(|_| ())
}

/// The kind of `id`, refusing an id the document does not hold as
/// [`require_node`] does.
fn node_kind(doc: &Document, id: NodeId) -> Result<&NodeKind, Failure> {
    match doc.node(id) {
        Some(node) => Ok(&node.kind),
        None => Err(Failure::coded(
            "no_such_node",
            format!("no such node: {id}"),
        )),
    }
}

/// Refuses a node that is not a pin. [`Document::set_pin_scope`] leaves
/// any other node as it is, so without this the host would be told a scope
/// was set that was not.
fn require_pin(doc: &Document, id: NodeId) -> Result<(), Failure> {
    if doc.is_pin(id) {
        Ok(())
    } else {
        Err(Failure::coded("not_a_pin", format!("not a pin: {id}")))
    }
}

/// Refuses a node that is not a visit. [`Document::set_visit_title`] writes
/// the content name of whatever node it is given, which on a tab is the
/// tab's name.
fn require_visit(doc: &Document, id: NodeId) -> Result<(), Failure> {
    match doc.node(id) {
        Some(node) if node.kind == NodeKind::Visit => Ok(()),
        _ => Err(Failure::coded("not_a_visit", format!("not a visit: {id}"))),
    }
}

/// Refuses a node that is not a workspace, for a call only a workspace can
/// take. `id` is known to be in the document.
pub(crate) fn require_workspace(doc: &Document, id: NodeId) -> Result<(), Failure> {
    match doc.node(id) {
        Some(node) if node.kind == crate::types::NodeKind::Workspace => Ok(()),
        _ => Err(Invalid::new(Reason::NotAWorkspace, format!("not a workspace: {id}")).into()),
    }
}

/// Refuses an id a node already has. [`Document`]'s `add_*` methods replace
/// whatever is there, which is never what a host adding a node means.
fn require_unused(doc: &Document, id: NodeId) -> Result<(), Failure> {
    if doc.node(id).is_none() {
        return Ok(());
    }
    Err(Failure::coded(
        "id_in_use",
        format!("a node already has id {id}"),
    ))
}

/// A history shard's name from the host: `history-YYYY-Www`, the ISO week
/// its visits fall in (history-sync spec §2).
fn parse_shard_name(name: &str) -> Result<&str, Invalid> {
    let b = name.as_bytes();
    let valid = b.len() == 16
        && name.starts_with("history-")
        && b[8..12].iter().all(u8::is_ascii_digit)
        && b[12] == b'-'
        && b[13] == b'W'
        && b[14..16].iter().all(u8::is_ascii_digit)
        && matches!(name[14..16].parse::<u8>(), Ok(1..=53));
    if valid {
        Ok(name)
    } else {
        Err(Invalid::new(
            Reason::BadShardName,
            format!("not a history shard name: {name} (expected history-YYYY-Www)"),
        ))
    }
}

/// A setting key from the host. Empty is refused: a nameless setting is a
/// host bug, and once synced it would sit on every device unreadable.
fn parse_setting_key(key: &str) -> Result<&str, Invalid> {
    if key.is_empty() {
        return Err(Invalid::new(
            Reason::EmptySettingKey,
            "a setting needs a key",
        ));
    }
    Ok(key)
}

/// A setting value from the host, as JSON text. Absent and JSON `null` both
/// mean "reset to default"; storing a JSON null would read back as a value.
fn parse_setting_value(json: Option<String>) -> Result<Option<serde_json::Value>, Invalid> {
    match json {
        None => Ok(None),
        Some(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(serde_json::Value::Null) => Ok(None),
            Ok(value) => Ok(Some(value)),
            Err(err) => Err(Invalid::new(
                Reason::SettingNotJson,
                format!("a setting value must be JSON: {err}"),
            )),
        },
    }
}

/// A favorite-document node kind from the host: `favorite`, `folder` or
/// `separator`. Any other kind belongs to another document.
fn parse_favorite_kind(kind: &str) -> Result<NodeKind, Invalid> {
    match kind {
        "favorite" => Ok(NodeKind::Favorite),
        "folder" => Ok(NodeKind::Folder),
        "separator" => Ok(NodeKind::Separator),
        other => Err(Invalid::new(
            Reason::BadFavoriteKind,
            format!("not a Favorites kind: {other} (expected favorite, folder or separator)"),
        )),
    }
}

/// A favorite's guid from the host: twelve characters of the URL-safe base64
/// alphabet, the shape Places gives its own guids (`PlacesUtils.isValidGuid`),
/// which the host mints its guids with and the bookmarks HTML file and the
/// extensions' API still carry.
pub(crate) fn parse_favorite_guid(guid: &str) -> Result<&str, Invalid> {
    let valid = guid.len() == 12
        && guid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if valid {
        Ok(guid)
    } else {
        Err(Invalid::new(
            Reason::BadFavoriteGuid,
            format!("not a favorite guid: {guid}"),
        ))
    }
}

/// One change to a document, as a host spells it: the shape
/// `SvalDocumentOps.mjs` sends, named by `kind`, with every node id as a
/// string. The device and the time are not part of it, because every change
/// in a batch shares them.
///
/// Each `#[wasm_bindgen]` mutator on `wasm::SvalDocument` builds one of these and
/// applies it through [`apply_op`], and a batch applies a list of them
/// through [`apply_batch`], so an operation is checked the same way alone and
/// inside a batch.
#[derive(Debug, serde::Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Op {
    AddWorkspace {
        name: String,
        icon: Option<String>,
        id: String,
        isolated: Option<bool>,
    },
    AddAgentWorkspace {
        name: String,
        agent_label: String,
        id: String,
        isolated: Option<bool>,
    },
    AddDeviceWorkspace {
        name: String,
        id: String,
    },
    SetIsolation {
        id: String,
        #[serde(default)]
        isolated: bool,
    },
    AddGroup {
        parent: String,
        name: String,
        icon: Option<String>,
        id: String,
    },
    AddSplit {
        parent: String,
        #[serde(default)]
        name: String,
        id: String,
        before: Option<String>,
        after: Option<String>,
    },
    AddTab {
        parent: String,
        name: String,
        url: String,
        id: String,
        before: Option<String>,
        after: Option<String>,
        #[serde(default)]
        local: bool,
    },
    MoveNode {
        id: String,
        new_parent: String,
        before: Option<String>,
        after: Option<String>,
    },
    MoveWorkspace {
        id: String,
        before: Option<String>,
        after: Option<String>,
    },
    Rename {
        id: String,
        name: String,
    },
    SetContent {
        id: String,
        name: String,
        url: Option<String>,
        icon: Option<String>,
        shares: Option<Vec<f64>>,
        #[serde(default)]
        local: bool,
    },
    SetLocal {
        id: String,
        local: bool,
    },
    SetAppearance {
        id: String,
        color: Option<serde_json::Value>,
        emoji: Option<String>,
        transparency: Option<f64>,
    },
    SetLabel {
        id: String,
        label: Option<String>,
    },
    Touch {
        id: String,
    },
    SetSetting {
        key: String,
        value_json: Option<String>,
    },
    AddFavorite {
        favorite_kind: String,
        guid: String,
        parent: Option<String>,
        before: Option<String>,
        after: Option<String>,
        name: String,
        url: Option<String>,
        #[serde(default)]
        local: bool,
    },
    /// The pass that moves a profile's pins into the pins root (pins-root
    /// spec §8).
    MovePinsToRoot,
    SetPinScope {
        id: String,
        #[serde(default)]
        scope: Option<Vec<String>>,
    },
    RemoveKeepingChildren {
        id: String,
    },
    AddVisit {
        url: String,
        #[serde(default)]
        title: String,
        transition: u32,
        visited_at: f64,
        #[serde(default)]
        workspace: Option<String>,
    },
    SetVisitTitle {
        id: String,
        #[serde(default)]
        title: String,
    },
    TouchShard {
        name: String,
    },
    SetAutoArchive {
        id: String,
        choice: Option<String>,
    },
    MarkUsed {
        id: String,
    },
    Remove {
        id: String,
    },
}

fn parse_optional_id(id: Option<String>) -> Result<Option<NodeId>, Invalid> {
    id.map(|id| parse_id(&id)).transpose()
}

/// Applies `op` to `doc`, stamped with `by` and `now`, and returns the id of
/// the node it added, where it added one.
///
/// Every check comes before the change, and the change itself cannot fail,
/// so a refused operation leaves `doc` exactly as it was.
pub(crate) fn apply_op(
    doc: &mut Document,
    op: Op,
    by: DeviceId,
    now: Timestamp,
) -> Result<Option<NodeId>, Failure> {
    match op {
        Op::AddWorkspace {
            name,
            icon,
            id,
            isolated,
        } => {
            let id = parse_id(&id)?;
            require_unused(doc, id)?;
            doc.add_workspace(name, icon, id, by, now);
            isolate_at_creation(doc, id, isolated);
            Ok(Some(id))
        }
        Op::AddAgentWorkspace {
            name,
            agent_label,
            id,
            isolated,
        } => {
            // An agent's workspace (agent-control spec §3.5). The device in
            // the mark is `by`, the device the agent paired with.
            let label = parse_agent_label(&agent_label)?;
            let id = parse_id(&id)?;
            require_unused(doc, id)?;
            doc.add_agent_workspace(name, label, id, by, now);
            isolate_at_creation(doc, id, isolated);
            Ok(Some(id))
        }
        Op::AddDeviceWorkspace { name, id } => {
            // A device's own workspace (decision 2254). The device in the
            // mark is `by`, the device that made it.
            let id = parse_id(&id)?;
            require_unused(doc, id)?;
            doc.add_device_workspace(name, id, by, now);
            Ok(Some(id))
        }
        Op::SetIsolation { id, isolated } => {
            // Only a workspace has a cookie jar to choose (isolated
            // workspaces spec §5).
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            require_workspace(doc, id)?;
            doc.set_isolation(id, isolated, by, now);
            Ok(None)
        }
        Op::AddGroup {
            parent,
            name,
            icon,
            id,
        } => {
            let parent = parse_id(&parent)?;
            let id = parse_id(&id)?;
            crate::tree::validate_parent(doc, None, &NodeKind::Group, parent)?;
            require_unused(doc, id)?;
            doc.add_group(parent, name, icon, id, by, now);
            Ok(Some(id))
        }
        Op::AddSplit {
            parent,
            name,
            id,
            before,
            after,
        } => {
            // An empty split, at the place the host names; the batch that
            // adds it moves its panes in (split-view spec §5.2).
            let parent = parse_id(&parent)?;
            let id = parse_id(&id)?;
            let before = parse_optional_id(before)?;
            let after = parse_optional_id(after)?;
            crate::tree::validate_parent(doc, None, &NodeKind::Split, parent)?;
            require_unused(doc, id)?;
            doc.add_split(parent, name, id, by, now);
            if before.is_some() || after.is_some() {
                let order = crate::tree::order_between(doc, before, after);
                if let Some(node) = doc.node_mut(id) {
                    node.placement.order = order;
                }
            }
            Ok(Some(id))
        }
        Op::AddTab {
            parent,
            name,
            url,
            id,
            before,
            after,
            local,
        } => {
            let parent = parse_id(&parent)?;
            let id = parse_id(&id)?;
            let before = parse_optional_id(before)?;
            let after = parse_optional_id(after)?;
            crate::tree::validate_parent(doc, None, &NodeKind::Tab, parent)?;
            require_unused(doc, id)?;
            // With neither neighbour the tab goes after the parent's last
            // child, as `add_tab` places it: where a tab opened at the end of
            // a strip belongs. With one, a tab opened mid-strip is filed where
            // it sits in a single placement fact.
            if before.is_none() && after.is_none() {
                doc.add_tab(parent, name, url, id, by, now);
            } else {
                crate::tree::insert_tab_between(doc, parent, before, after, name, url, id, by, now);
            }
            mark_local(doc, id, local);
            Ok(Some(id))
        }
        Op::MoveNode {
            id,
            new_parent,
            before,
            after,
        } => {
            let id = parse_id(&id)?;
            let new_parent = parse_id(&new_parent)?;
            let before = parse_optional_id(before)?;
            let after = parse_optional_id(after)?;
            // `tree::move_node` validates the node and its new parent itself,
            // so a native caller gets the same refusals a host does.
            crate::tree::move_node(doc, id, new_parent, before, after, by, now)?;
            Ok(None)
        }
        Op::MoveWorkspace { id, before, after } => {
            let id = parse_id(&id)?;
            let before = parse_optional_id(before)?;
            let after = parse_optional_id(after)?;
            crate::tree::move_workspace(doc, id, before, after, by, now)?;
            Ok(None)
        }
        Op::Rename { id, name } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            doc.rename(id, name, by, now);
            Ok(None)
        }
        Op::SetContent {
            id,
            name,
            url,
            icon,
            shares,
            local,
        } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            if let Some(shares) = &shares {
                check_shares(doc, id, shares)?;
            }
            require_address_if_local(url.as_deref(), local)?;
            // The mark follows the address (decision 1372): a write that sends
            // back the address the node holds keeps the node's mark, so one
            // another device wrote stays refused however it is re-sent.
            let local = match doc.node(id) {
                Some(node) if node.content.url == url => node.content.local,
                _ => local,
            };
            doc.set_content(id, name, url, icon, shares, local, by, now);
            Ok(None)
        }
        Op::SetLocal { id, local } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            let content = doc.node(id).map(|node| node.content.clone());
            if let Some(content) = content.filter(|content| content.local != local) {
                require_address_if_local(content.url.as_deref(), local)?;
                // Stamped now, so a node coming back is news to every peer,
                // as an address crossing back is (decision 1372).
                doc.set_content(
                    id,
                    content.name,
                    content.url,
                    content.icon,
                    content.shares,
                    local,
                    by,
                    now,
                );
            }
            Ok(None)
        }
        Op::SetAppearance {
            id,
            color,
            emoji,
            transparency,
        } => {
            let id = parse_id(&id)?;
            let kind = node_kind(doc, id)?;
            let color = parse_color(kind, color)?;
            let transparency = parse_transparency(kind, transparency)?;
            doc.set_appearance(id, color, emoji, transparency, by, now);
            Ok(None)
        }
        Op::SetLabel { id, label } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            doc.set_label(id, label, by, now);
            Ok(None)
        }
        Op::Touch { id } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            doc.touch(id, by, now);
            Ok(None)
        }
        Op::SetSetting { key, value_json } => {
            let key = parse_setting_key(&key)?;
            let value = parse_setting_value(value_json)?;
            doc.set_setting(key, value, by, now);
            Ok(None)
        }
        Op::AddFavorite {
            favorite_kind,
            guid,
            parent,
            before,
            after,
            name,
            url,
            local,
        } => {
            let kind = parse_favorite_kind(&favorite_kind)?;
            let guid = parse_favorite_guid(&guid)?;
            let parent = parse_optional_id(parent)?;
            let before = parse_optional_id(before)?;
            let after = parse_optional_id(after)?;
            if let Some(parent) = parent {
                crate::tree::validate_parent(doc, None, &kind, parent)?;
            }
            require_address_if_local(url.as_deref(), local)?;
            let id = doc.add_favorite(kind, guid, parent, before, after, name, url, by, now);
            mark_local(doc, id, local);
            Ok(Some(id))
        }
        Op::MovePinsToRoot => {
            crate::pins::move_pins_to_root(doc, by, now);
            Ok(None)
        }
        Op::SetPinScope { id, scope } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            require_pin(doc, id)?;
            doc.set_pin_scope(id, scope.map(|s| s.into_iter().collect()), by, now);
            Ok(None)
        }
        Op::RemoveKeepingChildren { id } => {
            let id = parse_id(&id)?;
            crate::tree::remove_keeping_children(doc, id, by, now)?;
            Ok(None)
        }
        Op::AddVisit {
            url,
            title,
            transition,
            visited_at,
            workspace,
        } => {
            let at = parse_timestamp(visited_at)?;
            if url.is_empty() {
                return Err(Invalid::new(Reason::VisitWithoutUrl, "a visit needs a URL").into());
            }
            let workspace = workspace.as_deref().map(parse_id).transpose()?;
            Ok(Some(doc.add_visit_in(
                &url, title, transition, at, workspace, by, now,
            )))
        }
        Op::SetVisitTitle { id, title } => {
            let id = parse_id(&id)?;
            require_node(doc, id)?;
            require_visit(doc, id)?;
            doc.set_visit_title(id, title, by, now);
            Ok(None)
        }
        Op::TouchShard { name } => {
            let name = parse_shard_name(&name)?;
            doc.touch_shard(name, by, now);
            Ok(None)
        }
        Op::SetAutoArchive { id, choice } => {
            let id = parse_id(&id)?;
            crate::archive::set_auto_archive(doc, id, choice.as_deref(), by, now)?;
            Ok(None)
        }
        Op::MarkUsed { id } => {
            let id = parse_id(&id)?;
            crate::archive::mark_used(doc, id, by, now)?;
            Ok(None)
        }
        Op::Remove { id } => remove(doc, &id).map(|_| None),
    }
}

/// Refuses `shares` unless `id` is a split and the list gives each of its
/// panes a positive width, in pane order, summing to 100 (split-view spec
/// §5.1). A list nothing can draw must not reach the synced document.
fn check_shares(doc: &Document, id: NodeId, shares: &[f64]) -> Result<(), Failure> {
    if doc.node(id).is_none_or(|n| n.kind != NodeKind::Split) {
        return Err(Invalid::new(
            Reason::SharesNotOnASplit,
            format!("only a split has shares: {id}"),
        )
        .into());
    }
    let panes = crate::tree::children(doc, id)
        .into_iter()
        .filter(|&pane| doc.node(pane).is_some_and(|n| n.kind == NodeKind::Tab))
        .count();
    if shares.len() != panes {
        return Err(Invalid::new(
            Reason::SharesCountMismatch,
            format!(
                "split {id} has {panes} panes, and shares gives {}",
                shares.len()
            ),
        )
        .into());
    }
    if shares
        .iter()
        .any(|share| !share.is_finite() || *share <= 0.0)
    {
        return Err(Invalid::new(
            Reason::ShareNotPositive,
            "each share must be a positive number",
        )
        .into());
    }
    let total: f64 = shares.iter().sum();
    if (total - 100.0).abs() > SHARES_TOLERANCE {
        return Err(Invalid::new(
            Reason::SharesNotHundred,
            format!("shares must sum to 100, got {total}"),
        )
        .into());
    }
    Ok(())
}

/// Refuses a `local` mark on a write that carries no address: only an
/// address can keep a node on this device (decision 1372), and a workspace
/// or folder held back from the shared folder would take its children's
/// parent from every peer.
fn require_address_if_local(url: Option<&str>, local: bool) -> Result<(), Failure> {
    if local && url.is_none() {
        return Err(Invalid::new(
            Reason::LocalWithoutUrl,
            "only a node with an address can be local",
        )
        .into());
    }
    Ok(())
}

/// Sets the [`crate::types::Content::local`] mark of node `id`, which an add
/// just made, under the add's own content stamp.
fn mark_local(doc: &mut Document, id: NodeId, local: bool) {
    if let Some(node) = doc.node_mut(id) {
        node.content.local = local;
    }
}

/// How far from 100 a host's shares may sum, for percentages it computed from
/// pixel widths and rounded.
const SHARES_TOLERANCE: f64 = 0.1;

/// Deletes `id` and everything beneath it, the one operation that stamps
/// nothing: a deletion leaves no record (spec §5.4).
pub(crate) fn remove(doc: &mut Document, id: &str) -> Result<(), Failure> {
    let id = parse_id(id)?;
    require_node(doc, id)?;
    doc.remove(id);
    Ok(())
}

/// Marks a workspace just added as isolated. The flag is part of the
/// lifecycle group the add already stamped, so it shares that stamp: a
/// second write at the same instant would be one write described twice.
fn isolate_at_creation(doc: &mut Document, id: NodeId, isolated: Option<bool>) {
    if isolated == Some(true)
        && let Some(node) = doc.node_mut(id)
    {
        node.lifecycle.isolated = true;
    }
}

/// Applies the JSON array of [`Op`]s `ops_json` to `doc`, all of them or none.
///
/// A batch is one act to the user, such as making a group of two tabs, so no
/// write may carry part of one. The operations are applied in order to a
/// copy of `doc`, so a later one can name a node an earlier one added, and
/// the copy replaces `doc` only once every one has been applied. A refusal
/// anywhere leaves `doc` as it was, its stamps and watermarks included, and
/// answers with the refused operation's own failure.
///
/// A single operation is applied to `doc` directly: [`apply_op`] refuses one
/// with the document untouched, so it needs no copy.
pub(crate) fn apply_batch(
    doc: &mut Document,
    ops_json: &str,
    device_id: &[u8],
    now: f64,
) -> Result<(), Failure> {
    let mut ops: Vec<Op> = serde_json::from_str(ops_json).map_err(|err| {
        Invalid::new(
            Reason::BadBatch,
            format!("not a batch of operations: {err}"),
        )
    })?;
    let by = parse_device_id(device_id)?;
    let now = parse_timestamp(now)?;
    if ops.len() == 1
        && let Some(op) = ops.pop()
    {
        return apply_op(doc, op, by, now).map(|_| ());
    }
    let mut candidate = doc.clone();
    for op in ops {
        apply_op(&mut candidate, op, by, now)?;
    }
    *doc = candidate;
    Ok(())
}

/// What the tests of this module and of `host` share.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub(crate) fn key_bytes() -> Vec<u8> {
        crate::types::test_support::test_key().to_bytes().to_vec()
    }

    pub(crate) const ALICE: [u8; 16] = [0xa1; 16];
    pub(crate) const BOB: [u8; 16] = [0xb0; 16];

    pub(crate) fn apply(doc: &mut Document, device: &[u8; 16], now: f64, op: serde_json::Value) {
        apply_batch(doc, &serde_json::json!([op]).to_string(), device, now).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{ALICE, BOB, apply, key_bytes};
    use super::*;
    use crate::host::run_sync;
    use crate::store::DeviceId as StoreDeviceId;
    use crate::types::test_support::{test_device, uid};
    use crate::views::visits_json;

    // --- timestamp validation ----------------------------------------

    #[test]
    fn parse_timestamp_accepts_zero_and_the_max_safe_integer() {
        assert_eq!(parse_timestamp(0.0), Ok(0));
        assert_eq!(
            parse_timestamp(MAX_SAFE_TIMESTAMP),
            Ok(MAX_SAFE_TIMESTAMP as u64)
        );
    }

    #[test]
    fn parse_timestamp_rejects_nan_rather_than_silently_becoming_zero() {
        assert_eq!(
            parse_timestamp(f64::NAN).unwrap_err().reason,
            Reason::TimestampNotFinite
        );
    }

    #[test]
    fn parse_timestamp_rejects_negative_values() {
        assert_eq!(
            parse_timestamp(-5.0).unwrap_err().reason,
            Reason::TimestampOutOfRange
        );
    }

    #[test]
    fn parse_timestamp_rejects_infinity_rather_than_pinning_to_u64_max() {
        assert_eq!(
            parse_timestamp(f64::INFINITY).unwrap_err().reason,
            Reason::TimestampNotFinite
        );
    }

    #[test]
    fn parse_timestamp_rejects_values_past_the_max_safe_integer() {
        assert_eq!(
            parse_timestamp(MAX_SAFE_TIMESTAMP + 2.0)
                .unwrap_err()
                .reason,
            Reason::TimestampOutOfRange
        );
    }

    // --- node existence ----------------------------------------------

    #[test]
    fn require_node_rejects_an_id_the_document_does_not_contain() {
        let doc = Document::new();
        let missing = crate::types::test_support::test_id();
        let err = require_node(&doc, missing).unwrap_err();
        assert_eq!((err.code, err.reason), ("no_such_node", None));
    }

    #[test]
    fn require_unused_refuses_an_id_already_in_the_document() {
        let mut doc = Document::new();
        let id = crate::types::test_support::test_id();
        assert_eq!(require_unused(&doc, id), Ok(()));
        doc.add_workspace("W", None, id, test_device(), 0);
        assert_eq!(require_unused(&doc, id).unwrap_err().code, "id_in_use");
    }

    #[test]
    fn require_node_accepts_an_id_the_document_contains() {
        let mut doc = Document::new();
        let id = crate::types::test_support::test_id();
        doc.add_workspace("W", None, id, test_device(), 0);
        assert_eq!(require_node(&doc, id), Ok(()));
    }

    // --- appearance: colour is a token, validated at this boundary --------

    #[test]
    fn parse_agent_label_refuses_an_empty_or_blank_label() {
        for blank in ["", "   "] {
            assert_eq!(
                parse_agent_label(blank).unwrap_err().reason,
                Reason::EmptyAgentLabel,
                "{blank:?}"
            );
        }
    }

    #[test]
    fn parse_agent_label_trims() {
        assert_eq!(parse_agent_label("  Claude Code ").unwrap(), "Claude Code");
    }

    // --- appearance: preset tokens, custom colours, transparency ----------

    use serde_json::json;

    /// A document holding workspace 1, group 2 in it and tab 3 in the group.
    fn painted_tree() -> Document {
        let mut doc = Document::new();
        let ops = json!([
            { "kind": "addWorkspace", "name": "W", "id": uid(1) },
            { "kind": "addGroup", "parent": uid(1), "name": "G", "id": uid(2) },
            { "kind": "addTab", "parent": uid(2), "name": "T", "url": "https://t.example/", "id": uid(3) },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &ALICE, 1.0).unwrap();
        doc
    }

    /// Applies one `setAppearance` to `doc` at time `now` from `device`.
    fn paint(
        doc: &mut Document,
        device: &[u8; 16],
        now: f64,
        id: NodeId,
        color: serde_json::Value,
        transparency: serde_json::Value,
    ) -> Result<(), Failure> {
        let op = json!({
            "kind": "setAppearance", "id": id, "color": color, "transparency": transparency,
        });
        apply_batch(doc, &json!([op]).to_string(), device, now)
    }

    /// Asserts that painting `id` with `color` and `transparency` is refused
    /// as a bad colour and leaves the document as it was.
    fn assert_refused(id: NodeId, color: serde_json::Value, transparency: serde_json::Value) {
        let mut doc = painted_tree();
        let before = doc.to_json().unwrap();
        let err = paint(
            &mut doc,
            &ALICE,
            2.0,
            id,
            color.clone(),
            transparency.clone(),
        )
        .unwrap_err();
        assert_eq!(
            (err.code, err.reason),
            ("invalid_argument", Some(Reason::BadColor)),
            "{color} {transparency}: {err:?}"
        );
        assert_eq!(doc.to_json().unwrap(), before, "{color} {transparency}");
    }

    fn workspace_color() -> serde_json::Value {
        json!({ "h": 200, "c": 0.12, "l": 0.3, "mode": "dark" })
    }

    #[test]
    fn every_palette_token_paints_a_workspace_a_group_and_a_tab() {
        for token in COLOR_TOKENS {
            for id in [uid(1), uid(2), uid(3)] {
                let mut doc = painted_tree();
                paint(&mut doc, &ALICE, 2.0, id, json!(token), json!(null)).unwrap();
                assert_eq!(doc.node(id).unwrap().appearance.color, Some(json!(token)));
            }
        }
    }

    #[test]
    fn a_null_colour_clears_the_colour() {
        let mut doc = painted_tree();
        paint(&mut doc, &ALICE, 2.0, uid(1), json!("blue"), json!(null)).unwrap();
        paint(&mut doc, &ALICE, 3.0, uid(1), json!(null), json!(null)).unwrap();
        assert_eq!(doc.node(uid(1)).unwrap().appearance.color, None);
    }

    #[test]
    fn a_workspace_custom_colour_and_transparency_round_trip_through_the_document() {
        let mut doc = painted_tree();
        paint(&mut doc, &ALICE, 2.0, uid(1), workspace_color(), json!(0.5)).unwrap();

        let reloaded = Document::from_json(&doc.to_json().unwrap()).unwrap();
        let appearance = &reloaded.node(uid(1)).unwrap().appearance;
        assert_eq!(
            appearance.color,
            Some(json!({ "h": 200.0, "c": 0.12, "l": 0.3, "mode": "dark" }))
        );
        assert_eq!(appearance.transparency, Some(0.5));
        assert_eq!(reloaded.to_json().unwrap(), doc.to_json().unwrap());
    }

    #[test]
    fn a_custom_colour_is_stored_alike_however_its_numbers_are_written() {
        let mut whole = painted_tree();
        paint(
            &mut whole,
            &ALICE,
            2.0,
            uid(1),
            workspace_color(),
            json!(null),
        )
        .unwrap();
        let mut decimal = painted_tree();
        let color = json!({ "h": 200.0, "c": 0.12, "l": 0.3, "mode": "dark" });
        paint(&mut decimal, &ALICE, 2.0, uid(1), color, json!(null)).unwrap();
        assert_eq!(whole.to_json().unwrap(), decimal.to_json().unwrap());
    }

    #[test]
    fn a_group_takes_a_custom_hue_and_chroma() {
        let mut doc = painted_tree();
        let color = json!({ "h": 30.5, "c": 0.08 });
        paint(&mut doc, &ALICE, 2.0, uid(2), color.clone(), json!(null)).unwrap();
        assert_eq!(doc.node(uid(2)).unwrap().appearance.color, Some(color));
    }

    #[test]
    fn a_custom_colour_takes_every_value_at_the_edges_of_its_ranges() {
        for (h, c, l, mode) in [(0.0, 0.0, 0.0, "light"), (359.999, MAX_CHROMA, 1.0, "dark")] {
            let mut doc = painted_tree();
            let color = json!({ "h": h, "c": c, "l": l, "mode": mode });
            paint(&mut doc, &ALICE, 2.0, uid(1), color.clone(), json!(null)).unwrap();
            assert_eq!(doc.node(uid(1)).unwrap().appearance.color, Some(color));
            let group = json!({ "h": h, "c": c });
            paint(&mut doc, &ALICE, 2.0, uid(2), group.clone(), json!(null)).unwrap();
            assert_eq!(doc.node(uid(2)).unwrap().appearance.color, Some(group));
        }
    }

    #[test]
    fn a_transparency_at_either_end_is_taken() {
        for t in [0.0, 1.0] {
            let mut doc = painted_tree();
            paint(&mut doc, &ALICE, 2.0, uid(1), json!("blue"), json!(t)).unwrap();
            assert_eq!(doc.node(uid(1)).unwrap().appearance.transparency, Some(t));
        }
    }

    #[test]
    fn a_colour_outside_the_tokens_and_shapes_is_refused() {
        let ws = |change: serde_json::Value| {
            let mut color = workspace_color();
            for (key, value) in change.as_object().unwrap() {
                color[key] = value.clone();
            }
            color
        };
        let mut no_mode = workspace_color();
        no_mode.as_object_mut().unwrap().remove("mode");
        for color in [
            json!("#ff00ff"),
            json!("turquoise"),
            json!(5),
            json!(["blue"]),
            json!(true),
            ws(json!({ "h": 360 })),
            ws(json!({ "h": -1 })),
            ws(json!({ "h": "200" })),
            // `JSON.stringify` writes NaN as `null`.
            ws(json!({ "h": null })),
            ws(json!({ "c": 0.41 })),
            ws(json!({ "c": -0.01 })),
            ws(json!({ "l": 1.01 })),
            ws(json!({ "l": -0.01 })),
            ws(json!({ "mode": "dim" })),
            ws(json!({ "mode": null })),
            ws(json!({ "extra": 1 })),
            no_mode,
            json!({ "h": 200, "c": 0.1 }),
        ] {
            assert_refused(uid(1), color, json!(null));
        }
        for color in [
            json!({ "h": 360, "c": 0.1 }),
            json!({ "h": 10, "c": 0.5 }),
            json!({ "h": 10 }),
            json!({ "h": 10, "c": 0.1, "x": 0 }),
            workspace_color(),
        ] {
            assert_refused(uid(2), color, json!(null));
        }
        for color in [workspace_color(), json!({ "h": 10, "c": 0.1 })] {
            assert_refused(uid(3), color, json!(null));
        }
    }

    #[test]
    fn a_transparency_out_of_range_or_off_a_workspace_is_refused() {
        for t in [json!(-0.01), json!(1.01)] {
            assert_refused(uid(1), json!("blue"), t);
        }
        for id in [uid(2), uid(3)] {
            assert_refused(id, json!("blue"), json!(0.5));
        }
    }

    #[test]
    fn a_nan_transparency_is_refused() {
        // JSON has no NaN, so this reaches the check as `setAppearance`
        // hands it over.
        let err = parse_transparency(&NodeKind::Workspace, Some(f64::NAN)).unwrap_err();
        assert_eq!(err.reason, Reason::BadColor);
    }

    #[test]
    fn the_later_appearance_carries_its_colour_and_transparency_together() {
        // Alice picks a custom colour with a transparency, Bob a token with
        // an emoji. The appearance group merges whole (spec §5.3), so the
        // later write's every field wins and none of the earlier one's
        // survives beside it.
        let custom = json!({ "h": 200.0, "c": 0.12, "l": 0.3, "mode": "dark" });
        for (alice_at, bob_at) in [(30.0, 20.0), (20.0, 30.0)] {
            let mut alice = painted_tree();
            let mut bob = painted_tree();
            paint(
                &mut alice,
                &ALICE,
                alice_at,
                uid(1),
                custom.clone(),
                json!(0.7),
            )
            .unwrap();
            let op =
                json!({ "kind": "setAppearance", "id": uid(1), "color": "blue", "emoji": "🌊" });
            apply(&mut bob, &BOB, bob_at, op);

            crate::merge::merge(&mut alice, &bob);
            crate::merge::merge(&mut bob, &alice);

            for doc in [&alice, &bob] {
                let appearance = &doc.node(uid(1)).unwrap().appearance;
                if alice_at > bob_at {
                    assert_eq!(appearance.color, Some(custom.clone()));
                    assert_eq!(appearance.transparency, Some(0.7));
                    assert_eq!(appearance.emoji, None);
                } else {
                    assert_eq!(appearance.color, Some(json!("blue")));
                    assert_eq!(appearance.transparency, None);
                    assert_eq!(appearance.emoji.as_deref(), Some("🌊"));
                }
            }
        }
    }

    #[test]
    fn parse_setting_value_treats_json_null_as_a_reset() {
        assert_eq!(parse_setting_value(None).unwrap(), None);
        assert_eq!(parse_setting_value(Some("null".into())).unwrap(), None);
        assert_eq!(
            parse_setting_value(Some("\"ddg\"".into())).unwrap(),
            Some(serde_json::json!("ddg"))
        );
        let err = parse_setting_value(Some("{not json".into())).unwrap_err();
        assert_eq!(err.reason, Reason::SettingNotJson);
    }

    #[test]
    fn parse_setting_key_refuses_an_empty_key() {
        assert_eq!(
            parse_setting_key("").unwrap_err().reason,
            Reason::EmptySettingKey
        );
        assert_eq!(
            parse_setting_key("sval.search.engine").unwrap(),
            "sval.search.engine"
        );
    }

    #[test]
    fn a_set_label_op_sets_and_clears_a_tab_label_and_refuses_an_unknown_id() {
        let mut doc = two_groups();
        let set = serde_json::json!([{ "kind": "setLabel", "id": uid(11), "label": "Mine" }]);
        apply_batch(&mut doc, &set.to_string(), &ALICE, 200.0).unwrap();
        let node = doc.node(uid(11)).unwrap();
        assert_eq!(node.appearance.label.as_deref(), Some("Mine"));
        assert_eq!(node.appearance_at, 200);

        let clear = serde_json::json!([{ "kind": "setLabel", "id": uid(11), "label": null }]);
        apply_batch(&mut doc, &clear.to_string(), &ALICE, 300.0).unwrap();
        assert_eq!(doc.node(uid(11)).unwrap().appearance.label, None);

        let unknown = serde_json::json!([{ "kind": "setLabel", "id": uid(99), "label": "x" }]);
        let err = apply_batch(&mut doc, &unknown.to_string(), &ALICE, 400.0).unwrap_err();
        assert_eq!(err.code, "no_such_node");
    }

    #[test]
    fn set_appearance_clears_a_field_left_none_rather_than_leaving_it_alone() {
        let mut doc = Document::new();
        let id = crate::types::test_support::test_id();
        doc.add_workspace("W", None, id, test_device(), 0);
        doc.set_appearance(
            id,
            Some("green".into()),
            Some("🐟".into()),
            None,
            test_device(),
            10,
        );
        // The group is the unit, so `None` clears the colour.
        doc.set_appearance(id, None, Some("🐟".into()), None, test_device(), 20);
        let node = doc.node(id).unwrap();
        assert_eq!(node.appearance.color, None);
        assert_eq!(node.appearance.emoji, Some("🐟".to_string()));
    }

    #[test]
    fn set_appearance_round_trips_a_flag_and_a_zwj_sequence_byte_identical() {
        // An emoji is a grapheme cluster: a flag is two regional-indicator
        // code points, and a family emoji is several scalar values joined by
        // zero-width joiners. This boundary must never truncate either.
        let mut doc = Document::new();
        let id = crate::types::test_support::test_id();
        doc.add_workspace("W", None, id, test_device(), 0);

        let flag = "\u{1F1EF}\u{1F1F5}"; // 🇯🇵
        doc.set_appearance(
            id,
            Some("cyan".into()),
            Some(flag.to_string()),
            None,
            test_device(),
            10,
        );
        assert_eq!(
            doc.node(id).unwrap().appearance.emoji.as_deref(),
            Some(flag)
        );

        // family: man, woman, girl, boy joined by ZWJ
        let zwj_family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
        doc.set_appearance(
            id,
            Some("orange".into()),
            Some(zwj_family.to_string()),
            None,
            test_device(),
            20,
        );
        assert_eq!(
            doc.node(id).unwrap().appearance.emoji.as_deref(),
            Some(zwj_family)
        );
    }

    #[test]
    fn a_shard_name_is_a_history_iso_week() {
        assert!(parse_shard_name("history-2026-W42").is_ok());
        assert!(parse_shard_name("history-2026-W01").is_ok());
        for bad in [
            "",
            "history-2026-W00",
            "history-2026-W54",
            "history-2026-42",
            "history-26-W42",
            "favorites",
            "history-2026-W4x",
        ] {
            assert!(parse_shard_name(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn a_visit_added_in_a_workspace_lists_it_and_one_in_none_lists_null() {
        let device = [1; 16];
        let workspace = "3c1d9e2a-77b0-4f15-a8c6-5e0d2b9f1a47";
        let mut doc = Document::new();
        let ops = serde_json::json!([
            { "kind": "addVisit", "url": "https://1.example/", "title": "One",
              "transition": 1, "visitedAt": 10.0, "workspace": workspace },
            { "kind": "addVisit", "url": "https://2.example/", "title": "Two",
              "transition": 1, "visitedAt": 20.0 },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &device, 30.0).unwrap();

        let rows: serde_json::Value = serde_json::from_str(&visits_json(&doc).unwrap()).unwrap();
        assert_eq!(rows[0]["workspace"], workspace);
        assert_eq!(rows[1]["workspace"], serde_json::Value::Null);

        let bad = serde_json::json!([
            { "kind": "addVisit", "url": "https://3.example/", "transition": 1,
              "visitedAt": 40.0, "workspace": "not an id" },
        ]);
        assert!(apply_batch(&mut doc, &bad.to_string(), &device, 50.0).is_err());
        assert_eq!(doc.visit_ids().len(), 2);
    }

    #[test]
    fn a_pin_scope_on_a_node_that_is_not_a_pin_is_refused() {
        let by = StoreDeviceId::from_bytes([1; 16]);
        let mut doc = Document::new();
        let page = doc.add_favorite(
            NodeKind::Favorite,
            "page00000001",
            None,
            None,
            None,
            "One",
            Some("https://1.example/".into()),
            by,
            5,
        );
        let before = doc.to_json().unwrap();
        let op = Op::SetPinScope {
            id: page.to_string(),
            scope: Some(vec!["work".into()]),
        };

        let err = apply_op(&mut doc, op, by, 6).unwrap_err();

        assert_eq!(err.code, "not_a_pin");
        assert_eq!(doc.to_json().unwrap(), before);
    }

    #[test]
    fn a_visit_title_on_a_node_that_is_not_a_visit_is_refused() {
        let by = StoreDeviceId::from_bytes([1; 16]);
        let ws = NodeId::from_u128(1);
        let mut doc = Document::new();
        doc.add_workspace("W", None, ws, by, 1);
        let before = doc.to_json().unwrap();
        let op = Op::SetVisitTitle {
            id: ws.to_string(),
            title: "Elsewhere".into(),
        };

        let err = apply_op(&mut doc, op, by, 2).unwrap_err();

        assert_eq!(err.code, "not_a_visit");
        assert_eq!(doc.to_json().unwrap(), before);

        let visit = doc.add_visit("https://1.example/", "One", 1, 10, by, 11);
        let op = Op::SetVisitTitle {
            id: visit.to_string(),
            title: "Uno".into(),
        };
        apply_op(&mut doc, op, by, 12).unwrap();
        assert_eq!(doc.node(visit).unwrap().content.name, "Uno");
    }

    #[test]
    fn a_content_write_that_keeps_the_address_keeps_its_mark() {
        let device = [1; 16];
        let ws = "00000000-0000-0000-0000-000000000001";
        let tab = "00000000-0000-0000-0000-000000000002";
        let mut doc = Document::new();
        let ops = serde_json::json!([
            { "kind": "addWorkspace", "name": "W", "id": ws },
            { "kind": "addTab", "parent": ws, "name": "Planted",
              "url": "chrome://browser/content/browser.xhtml", "id": tab },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &device, 10.0).unwrap();
        let resent = serde_json::json!([
            { "kind": "setContent", "id": tab, "name": "Renamed",
              "url": "chrome://browser/content/browser.xhtml", "local": true },
        ]);
        apply_batch(&mut doc, &resent.to_string(), &device, 20.0).unwrap();
        let held = &doc.node(parse_id(tab).unwrap()).unwrap().content;
        assert_eq!(held.name, "Renamed");
        assert!(!held.local, "an unmarked address stays unmarked");

        let moved = serde_json::json!([
            { "kind": "setContent", "id": tab, "name": "Renamed",
              "url": "file:///notes.html", "local": true },
        ]);
        apply_batch(&mut doc, &moved.to_string(), &device, 30.0).unwrap();
        assert!(doc.node(parse_id(tab).unwrap()).unwrap().content.local);
    }

    #[test]
    fn set_local_moves_a_node_across_the_line_and_stamps_only_a_change() {
        let device = [1; 16];
        let ws = "00000000-0000-0000-0000-000000000001";
        let tab = "00000000-0000-0000-0000-000000000002";
        let mut doc = Document::new();
        let ops = serde_json::json!([
            { "kind": "addWorkspace", "name": "W", "id": ws },
            { "kind": "addTab", "parent": ws, "name": "Call",
              "url": "https://meet.example/abc", "id": tab },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &device, 10.0).unwrap();
        let tab_id = parse_id(tab).unwrap();

        let local = serde_json::json!([{ "kind": "setLocal", "id": tab, "local": true }]);
        apply_batch(&mut doc, &local.to_string(), &device, 20.0).unwrap();
        let held = doc.node(tab_id).unwrap();
        assert!(held.content.local);
        assert_eq!(
            held.content.url.as_deref(),
            Some("https://meet.example/abc")
        );
        assert_eq!(held.content.name, "Call");
        assert_eq!(held.content_at, 20);

        apply_batch(&mut doc, &local.to_string(), &device, 30.0).unwrap();
        assert_eq!(
            doc.node(tab_id).unwrap().content_at,
            20,
            "a mark already as asked writes nothing"
        );

        let back = serde_json::json!([{ "kind": "setLocal", "id": tab, "local": false }]);
        apply_batch(&mut doc, &back.to_string(), &device, 40.0).unwrap();
        let held = doc.node(tab_id).unwrap();
        assert!(!held.content.local);
        assert_eq!(held.content_at, 40);

        let bare = serde_json::json!([{ "kind": "setLocal", "id": ws, "local": true }]);
        let err = apply_batch(&mut doc, &bare.to_string(), &device, 50.0).unwrap_err();
        assert!(
            err.message.contains("only a node with an address"),
            "{err:?}"
        );
        assert!(!doc.node(parse_id(ws).unwrap()).unwrap().content.local);
    }

    #[test]
    fn a_places_guid_is_twelve_url_safe_characters() {
        assert_eq!(parse_favorite_guid("toolbar_____"), Ok("toolbar_____"));
        assert_eq!(parse_favorite_guid("aB3-_xyz0912"), Ok("aB3-_xyz0912"));
        for bad in ["", "short", "thirteen_char", "has space 12", "slash/slash1"] {
            assert_eq!(
                parse_favorite_guid(bad).unwrap_err().reason,
                Reason::BadFavoriteGuid,
                "{bad} must be refused"
            );
        }
    }

    #[test]
    fn only_favorite_kinds_are_accepted_for_the_favorites_document() {
        assert_eq!(parse_favorite_kind("folder"), Ok(NodeKind::Folder));
        for other in ["tab", "workspace"] {
            let err = parse_favorite_kind(other).unwrap_err();
            assert_eq!(err.reason, Reason::BadFavoriteKind, "{other}");
        }
    }

    // --- a batch lands whole or not at all -----------------------------

    /// A workspace holding two groups, A (tabs 11, 12) and B (tabs 21, 22),
    /// as Alice wrote and synced it: every group stamped, and `seen`
    /// carrying a watermark, so a batch that disturbed either would show.
    fn two_groups() -> Document {
        let by = DeviceId::from_bytes(ALICE);
        let mut doc = Document::new();
        doc.add_workspace("W", None, uid(1), by, 100);
        doc.add_group(uid(1), "A", None, uid(10), by, 110);
        doc.add_group(uid(1), "B", None, uid(20), by, 120);
        doc.add_tab(uid(10), "a1", "https://a1.example/", uid(11), by, 111);
        doc.add_tab(uid(10), "a2", "https://a2.example/", uid(12), by, 112);
        doc.add_tab(uid(20), "b1", "https://b1.example/", uid(21), by, 121);
        doc.add_tab(uid(20), "b2", "https://b2.example/", uid(22), by, 122);
        doc.stamp_write(by, 130);
        doc
    }

    /// Merging group B into group A, as the panel does: B's tabs move into
    /// A after A's own, and B goes.
    fn merge_b_into_a() -> serde_json::Value {
        serde_json::json!([
            { "kind": "moveNode", "id": uid(21), "newParent": uid(10), "before": uid(12) },
            { "kind": "moveNode", "id": uid(22), "newParent": uid(10), "before": uid(21) },
            { "kind": "remove", "id": uid(20) },
        ])
    }

    #[test]
    fn move_workspace_reorders_workspaces_and_refuses_anything_else() {
        let mut doc = two_groups();
        let by = DeviceId::from_bytes(ALICE);
        doc.add_workspace("V", None, uid(2), by, 101);
        let first = |doc: &Document| {
            doc.workspaces()
                .min_by_key(|(id, node)| (node.placement.order.clone(), **id))
                .map(|(id, _)| *id)
        };
        assert_eq!(first(&doc), Some(uid(1)), "test setup");

        let ops = serde_json::json!([{ "kind": "moveWorkspace", "id": uid(2), "after": uid(1) }]);
        apply_batch(&mut doc, &ops.to_string(), &ALICE, 200.0).unwrap();
        assert_eq!(first(&doc), Some(uid(2)));
        assert_eq!(doc.node(uid(2)).unwrap().placement_at, 200);

        let before = doc.to_json().unwrap();
        let ops = serde_json::json!([{ "kind": "moveWorkspace", "id": uid(10), "after": uid(1) }]);
        let err = apply_batch(&mut doc, &ops.to_string(), &ALICE, 300.0).unwrap_err();
        assert_eq!(err.code, "not_a_root_workspace", "{err:?}");
        assert_eq!(doc.to_json().unwrap(), before);
    }

    #[test]
    fn a_merge_refused_halfway_leaves_both_groups_byte_identical() {
        let mut doc = two_groups();
        let before = doc.to_json().unwrap();
        let mut ops = merge_b_into_a();
        // Refused after every other step has been applied: A cannot go
        // inside its own tab.
        ops.as_array_mut().unwrap().push(serde_json::json!(
            { "kind": "moveNode", "id": uid(10), "newParent": uid(11) }
        ));
        let err = apply_batch(&mut doc, &ops.to_string(), &ALICE, 200.0).unwrap_err();
        assert_eq!(err.code, "parent_is_a_tab", "{err:?}");
        assert_eq!(doc.to_json().unwrap(), before);
    }

    #[test]
    fn a_batch_refused_at_its_first_step_or_its_input_changes_nothing() {
        let mut doc = two_groups();
        let before = doc.to_json().unwrap();
        let refusals = [
            (
                serde_json::json!([{ "kind": "remove", "id": uid(99) }]).to_string(),
                &ALICE[..],
                200.0,
                ("no_such_node", None),
            ),
            (
                serde_json::json!([
                    { "kind": "rename", "id": uid(11), "name": "x" },
                    { "kind": "batch", "ops": [] },
                ])
                .to_string(),
                &ALICE[..],
                200.0,
                ("invalid_argument", Some(Reason::BadBatch)),
            ),
            (
                serde_json::json!([
                    { "kind": "addTab", "parent": uid(10), "name": "t", "url": "u" },
                ])
                .to_string(),
                &ALICE[..],
                200.0,
                ("invalid_argument", Some(Reason::BadBatch)),
            ),
            (
                merge_b_into_a().to_string(),
                &ALICE[..15],
                200.0,
                ("invalid_argument", Some(Reason::BadDeviceId)),
            ),
            (
                merge_b_into_a().to_string(),
                &ALICE[..],
                f64::NAN,
                ("invalid_argument", Some(Reason::TimestampNotFinite)),
            ),
        ];
        for (ops, device, now, expected) in refusals {
            let err = apply_batch(&mut doc, &ops, device, now).unwrap_err();
            assert_eq!((err.code, err.reason), expected, "{ops}: {err:?}");
            assert_eq!(doc.to_json().unwrap(), before, "{ops}");
        }
    }

    #[test]
    fn a_batch_applies_in_order_and_a_peer_receives_it_in_one_write() {
        let mut alice = two_groups();
        let mut ops = merge_b_into_a();
        // A later step names a node an earlier one added.
        ops.as_array_mut().unwrap().extend([
            serde_json::json!({ "kind": "addGroup", "parent": uid(1), "name": "C", "id": uid(30) }),
            serde_json::json!({ "kind": "setAppearance", "id": uid(30), "color": "blue" }),
            serde_json::json!({ "kind": "moveNode", "id": uid(10), "newParent": uid(30) }),
        ]);
        apply_batch(&mut alice, &ops.to_string(), &ALICE, 200.0).unwrap();

        let key = key_bytes();
        let (_, write) = run_sync(&mut alice, &key, &ALICE, "ws-1", vec![], 300.0).unwrap();
        let mut bob = Document::new();
        run_sync(&mut bob, &key, &BOB, "ws-1", vec![write.unwrap()], 300.0).unwrap();

        assert!(bob.node(uid(20)).is_none(), "B is gone");
        assert_eq!(
            crate::tree::children(&bob, uid(10)),
            vec![uid(11), uid(12), uid(21), uid(22)]
        );
        let c = bob.node(uid(30)).unwrap();
        assert_eq!(
            c.appearance
                .color
                .as_ref()
                .and_then(serde_json::Value::as_str),
            Some("blue")
        );
        assert_eq!(bob.node(uid(10)).unwrap().placement.parent, Some(uid(30)));
        for id in [21, 22, 10] {
            let node = bob.node(uid(id)).unwrap();
            assert_eq!(node.placement_at, 200, "{id} carries the batch's time");
            assert_eq!(node.placement_by, Some(DeviceId::from_bytes(ALICE)));
        }
    }

    // --- splits ----------------------------------------------------------

    /// Splitting tab 11 with tab 12 in group A, as the panel does: the split
    /// takes 11's place, and 11 then 12 move into it (split-view spec §5.2).
    fn split_11_with_12() -> serde_json::Value {
        serde_json::json!([
            { "kind": "addSplit", "parent": uid(10), "id": uid(40), "before": uid(11), "after": uid(12) },
            { "kind": "moveNode", "id": uid(11), "newParent": uid(40) },
            { "kind": "moveNode", "id": uid(12), "newParent": uid(40), "before": uid(11) },
        ])
    }

    #[test]
    fn a_tab_given_one_neighbour_lands_beside_it() {
        let mut doc = two_groups();
        let ops = serde_json::json!([
            { "kind": "addTab", "parent": uid(10), "name": "t", "url": "https://t.example/", "id": uid(40), "after": uid(11) },
        ]);

        apply_batch(&mut doc, &ops.to_string(), &ALICE, 200.0).unwrap();

        assert_eq!(
            crate::tree::children(&doc, uid(10)),
            vec![uid(40), uid(11), uid(12)]
        );
    }

    #[test]
    fn a_split_given_one_neighbour_lands_beside_it() {
        let mut doc = two_groups();
        let ops = serde_json::json!([
            { "kind": "addSplit", "parent": uid(10), "id": uid(40), "after": uid(11) },
        ]);

        apply_batch(&mut doc, &ops.to_string(), &ALICE, 200.0).unwrap();

        assert_eq!(
            crate::tree::children(&doc, uid(10)),
            vec![uid(40), uid(11), uid(12)]
        );
    }

    #[test]
    fn splitting_two_tabs_is_one_batch_that_leaves_one_split_in_their_place() {
        let mut doc = two_groups();
        apply_batch(&mut doc, &split_11_with_12().to_string(), &ALICE, 200.0).unwrap();

        assert_eq!(crate::tree::children(&doc, uid(10)), vec![uid(40)]);
        assert_eq!(crate::tree::children(&doc, uid(40)), vec![uid(11), uid(12)]);
        let split = doc.node(uid(40)).unwrap();
        assert_eq!(split.kind, NodeKind::Split);
        assert_eq!(split.content.name, "", "a split is unnamed by default");
        assert!(crate::tree::repair_unreachable_ancestry(&mut doc).is_empty());
    }

    #[test]
    fn moving_a_pane_left_within_a_full_split_is_allowed() {
        let mut doc = two_groups();
        let mut ops = split_11_with_12();
        ops.as_array_mut().unwrap().extend([
            serde_json::json!({ "kind": "moveNode", "id": uid(21), "newParent": uid(40), "before": uid(12) }),
            serde_json::json!({ "kind": "moveNode", "id": uid(22), "newParent": uid(40), "before": uid(21) }),
        ]);
        apply_batch(&mut doc, &ops.to_string(), &ALICE, 200.0).unwrap();
        assert_eq!(crate::tree::children(&doc, uid(40)).len(), 4, "test setup");

        // The last pane moves to before the third.
        let left = serde_json::json!([
            { "kind": "moveNode", "id": uid(22), "newParent": uid(40), "before": uid(12), "after": uid(21) },
        ]);
        apply_batch(&mut doc, &left.to_string(), &ALICE, 300.0).unwrap();
        assert_eq!(
            crate::tree::children(&doc, uid(40)),
            vec![uid(11), uid(12), uid(22), uid(21)]
        );
    }

    #[test]
    fn add_device_workspace_marks_it_as_the_writing_devices() {
        let mut doc = Document::new();
        let ops = serde_json::json!([
            { "kind": "addDeviceWorkspace", "name": "iPhone", "id": uid(70) },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &ALICE, 300.0).unwrap();
        let node = doc.node(uid(70)).unwrap();
        assert_eq!(node.kind, NodeKind::Workspace);
        assert_eq!(
            node.device_home.as_ref().map(|mark| mark.device),
            Some(DeviceId::from_bytes(ALICE))
        );
        assert_eq!(node.agent, None);
    }

    #[test]
    fn a_pane_moves_within_a_split_a_merge_left_with_more_than_four() {
        let by = DeviceId::from_bytes(ALICE);
        let mut doc = two_groups();
        doc.add_split(uid(1), "", uid(40), by, 140);
        for n in 41..=45 {
            doc.add_tab(uid(40), "p", "https://p.example/", uid(n), by, 141);
        }
        let ops = serde_json::json!([
            { "kind": "moveNode", "id": uid(45), "newParent": uid(40), "after": uid(41) },
        ]);
        apply_batch(&mut doc, &ops.to_string(), &ALICE, 300.0).unwrap();
        assert_eq!(
            crate::tree::children(&doc, uid(40)),
            vec![uid(45), uid(41), uid(42), uid(43), uid(44)]
        );
    }

    #[test]
    fn every_shape_a_split_cannot_hold_is_refused_and_changes_nothing() {
        let mut doc = two_groups();
        let mut ops = split_11_with_12();
        ops.as_array_mut().unwrap().extend([
            serde_json::json!({ "kind": "addTab", "parent": uid(40), "name": "c", "url": "https://c.example/", "id": uid(13) }),
            serde_json::json!({ "kind": "addTab", "parent": uid(40), "name": "d", "url": "https://d.example/", "id": uid(14) }),
        ]);
        apply_batch(&mut doc, &ops.to_string(), &ALICE, 200.0).unwrap();
        let before = doc.to_json().unwrap();

        let refusals = [
            // A fifth tab, moved or added.
            (
                serde_json::json!({ "kind": "moveNode", "id": uid(21), "newParent": uid(40) }),
                "split_is_full",
            ),
            (
                serde_json::json!({ "kind": "addTab", "parent": uid(40), "name": "e", "url": "https://e.example/", "id": uid(15) }),
                "split_is_full",
            ),
            // Anything but a tab, moved or added.
            (
                serde_json::json!({ "kind": "moveNode", "id": uid(20), "newParent": uid(40) }),
                "only_tabs_in_a_split",
            ),
            (
                serde_json::json!({ "kind": "addGroup", "parent": uid(40), "name": "G", "id": uid(50) }),
                "only_tabs_in_a_split",
            ),
            (
                serde_json::json!({ "kind": "addSplit", "parent": uid(40), "id": uid(50) }),
                "only_tabs_in_a_split",
            ),
            // A split anywhere but a workspace or a group.
            (
                serde_json::json!({ "kind": "moveNode", "id": uid(40), "newParent": uid(21) }),
                "parent_is_a_tab",
            ),
            (
                serde_json::json!({ "kind": "addSplit", "parent": uid(21), "id": uid(50) }),
                "parent_is_a_tab",
            ),
            (
                serde_json::json!({ "kind": "addSplit", "parent": uid(99), "id": uid(50) }),
                "no_such_parent",
            ),
        ];
        for (op, code) in refusals {
            let ops = serde_json::json!([op]).to_string();
            let err = apply_batch(&mut doc, &ops, &ALICE, 300.0).unwrap_err();
            assert_eq!(err.code, code, "{ops}: {err:?}");
            assert_eq!(doc.to_json().unwrap(), before, "{ops}");
        }
    }

    #[test]
    fn a_split_is_refused_under_any_parent_but_a_workspace_or_a_group() {
        // A favorites folder is a container, but no split row is drawn in
        // it.
        let by = DeviceId::from_bytes(ALICE);
        let mut doc = two_groups();
        doc.add_split(uid(1), "", uid(40), by, 140);
        doc.add_favorite(
            NodeKind::Folder,
            "folder000001",
            None,
            None,
            None,
            "F",
            None,
            by,
            140,
        );
        let folder = crate::types::favorite_id("folder000001");
        let before = doc.to_json().unwrap();
        for op in [
            serde_json::json!({ "kind": "moveNode", "id": uid(40), "newParent": folder }),
            serde_json::json!({ "kind": "addSplit", "parent": folder, "id": uid(50) }),
        ] {
            let ops = serde_json::json!([op]).to_string();
            let err = apply_batch(&mut doc, &ops, &ALICE, 300.0).unwrap_err();
            assert_eq!(err.code, "split_outside_a_place", "{ops}: {err:?}");
            assert_eq!(doc.to_json().unwrap(), before, "{ops}");
        }
        // Into a group it goes.
        let ops = serde_json::json!([{ "kind": "moveNode", "id": uid(40), "newParent": uid(20) }]);
        apply_batch(&mut doc, &ops.to_string(), &ALICE, 300.0).unwrap();
        assert_eq!(doc.node(uid(40)).unwrap().placement.parent, Some(uid(20)));
    }

    #[test]
    fn a_split_s_shares_are_set_whole_and_checked_against_its_panes() {
        let mut doc = two_groups();
        apply_batch(&mut doc, &split_11_with_12().to_string(), &ALICE, 200.0).unwrap();
        let share = |shares: serde_json::Value| {
            serde_json::json!([{ "kind": "setContent", "id": uid(40), "name": "Docs", "shares": shares }])
                .to_string()
        };
        apply_batch(
            &mut doc,
            &share(serde_json::json!([30.5, 69.5])),
            &ALICE,
            300.0,
        )
        .unwrap();
        let split = doc.node(uid(40)).unwrap();
        assert_eq!(split.content.shares, Some(vec![30.5, 69.5]));
        assert_eq!((split.content_at, split.placement_at), (300, 200));

        let before = doc.to_json().unwrap();
        for (bad, reason) in [
            (serde_json::json!([50, 30, 20]), Reason::SharesCountMismatch),
            (serde_json::json!([60, 30]), Reason::SharesNotHundred),
            (serde_json::json!([100, 0]), Reason::ShareNotPositive),
            (serde_json::json!([-10, 110]), Reason::ShareNotPositive),
            (serde_json::json!([]), Reason::SharesCountMismatch),
        ] {
            let err = apply_batch(&mut doc, &share(bad.clone()), &ALICE, 400.0).unwrap_err();
            assert_eq!(err.reason, Some(reason), "{bad}: {err:?}");
            assert_eq!(doc.to_json().unwrap(), before, "{bad}");
        }
        let on_a_tab = serde_json::json!([
            { "kind": "setContent", "id": uid(11), "name": "a1", "url": "https://a1.example/", "shares": [50, 50] }
        ]);
        let err = apply_batch(&mut doc, &on_a_tab.to_string(), &ALICE, 400.0).unwrap_err();
        assert_eq!(err.reason, Some(Reason::SharesNotOnASplit), "{err:?}");

        // A rename keeps the shares, and a setContent without them clears
        // them: the group is the unit.
        let rename = serde_json::json!([{ "kind": "rename", "id": uid(40), "name": "Reading" }]);
        apply_batch(&mut doc, &rename.to_string(), &ALICE, 500.0).unwrap();
        assert_eq!(
            doc.node(uid(40)).unwrap().content.shares,
            Some(vec![30.5, 69.5])
        );
        let clear = serde_json::json!([{ "kind": "setContent", "id": uid(40), "name": "Reading" }]);
        apply_batch(&mut doc, &clear.to_string(), &ALICE, 600.0).unwrap();
        assert_eq!(doc.node(uid(40)).unwrap().content.shares, None);
    }
}
