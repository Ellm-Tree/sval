/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * One local change, applied to a `SvalDocument`.
 *
 * Both documents Sval keeps go through here: the profile's, in
 * `SvalSync.worker.mjs`, and a private browsing session's, in
 * `SvalPrivate.worker.mjs`. So an operation means the same thing in both, and
 * an operation cannot exist in one and not the other.
 *
 * Pure: it touches nothing but the document it is given. The caller mints the
 * id and the time, because the engine mints neither (host contract §3).
 */

/**
 * @param {object} doc A `SvalDocument`.
 * @param {object} op
 * @param {string} op.kind One of the kinds the `switch` below handles.
 * @param {Uint8Array} op.deviceId Stamped into whichever fact group the change
 *   touches.
 * @param {object} minted
 * @param {string} minted.id The id a node this adds takes.
 * @param {number} minted.now The time the change is stamped with.
 * @returns {string|null} the affected node's id.
 */
export function applyOp(doc, op, { id, now }) {
  if (op.kind === "setAppearance" || op.kind === "setLabel") {
    return applyAppearanceOp(doc, op, now);
  }
  switch (op.kind) {
    case "addWorkspace":
      doc.addWorkspace(
        op.name,
        op.icon ?? null,
        id,
        op.deviceId,
        now,
        op.isolated === true
      );
      return id;
    case "addAgentWorkspace":
      // An agent's workspace (agent-control spec §3.5). The mark names
      // this device, because an agent is paired with one device.
      doc.addAgentWorkspace(
        op.name,
        op.agentLabel,
        id,
        op.deviceId,
        now,
        op.isolated === true
      );
      return id;
    case "setIsolation":
      // Whether a workspace's tabs use a cookie jar of their own (isolated
      // workspaces spec §2). Only the lifecycle group is stamped, so it never
      // competes with a rename or a recolour made elsewhere (spec §5.1).
      doc.setIsolation(op.id, op.isolated === true, op.deviceId, now);
      return op.id;
    case "touch":
      // Work was done inside the node, which is an edit to it (decision
      // 0106). The stamp holds no value, so it never competes with an edit
      // made elsewhere.
      doc.touch(op.id, op.deviceId, now);
      return op.id;
    case "addGroup":
      doc.addGroup(op.parent, op.name, op.icon ?? null, id, op.deviceId, now);
      return id;
    case "addSplit":
      // An empty split, placed as `addTab` places a tab. The batch that adds
      // it moves its panes in (split-view spec §5.2).
      doc.addSplit(
        op.parent,
        op.name ?? "",
        id,
        op.before ?? null,
        op.after ?? null,
        op.deviceId,
        now
      );
      return id;
    case "addTab":
      doc.addTab(
        op.parent,
        op.name,
        op.url,
        id,
        op.before ?? null,
        op.after ?? null,
        op.deviceId,
        now,
        op.local === true
      );
      return id;
    case "rename":
      // Only the content group is stamped, so a rename never competes
      // with a move or a pin made elsewhere (spec §5.1). Re-adding under
      // the same id would reorder the node.
      doc.rename(op.id, op.name, op.deviceId, now);
      return op.id;
    case "setContent":
      // The whole content group, because the group is the unit: merge
      // replaces a fact group entire, so a caller sends the picture it
      // believes current and whatever it omits is overwritten. Following a
      // tab as it navigates is therefore a read-modify-write, done by the
      // caller against the tree (`docs/host-contract.md` §3). `local` is
      // part of the group, so an address write that leaves it out syncs.
      doc.setContent(
        op.id,
        op.name,
        op.url ?? null,
        op.icon ?? null,
        op.deviceId,
        now,
        op.shares ?? null,
        op.local === true
      );
      return op.id;
    case "setLocal":
      // The `local` mark alone, address kept, for a node this device holds
      // back for a reason other than its address (decision 2237).
      doc.setLocal(op.id, op.local === true, op.deviceId, now);
      return op.id;
    case "moveNode":
      doc.moveNode(
        op.id,
        op.newParent,
        op.before ?? null,
        op.after ?? null,
        op.deviceId,
        now
      );
      return op.id;
    case "moveWorkspace":
      // A workspace's place in the order every device lists them, between
      // the workspaces `before` and `after`. Placement only, as a move is.
      // `moveWorkspaceOp` names both neighbours, null at either end.
      doc.moveWorkspace(op.id, op.before, op.after, op.deviceId, now);
      return op.id;
    case "setAutoArchive":
      // A workspace's own choice for archiving idle tabs, or null to follow
      // the global one (idle-tab archive spec §5). Lifecycle only, as
      // isolation is.
      doc.setAutoArchive(op.id, op.choice ?? null, op.deviceId, now);
      return op.id;
    case "remove":
      // Closing a tab deletes the node, and deleting a group, a workspace or
      // a Favorites folder deletes everything in it with it: no timestamp, no
      // tombstone (spec §5.4).
      doc.remove(op.id);
      return op.id;
    case "removeKeepingChildren":
      // "Delete group" with its contents moved out: they go to the group's
      // parent, in their order, at its place (spec §5.4).
      doc.removeKeepingChildren(op.id, op.deviceId, now);
      return op.id;
    case "batch":
      // Many changes as one: making a group of two tabs, or an import of
      // hundreds of tabs in one round trip to the worker (import spec §7).
      // Each operation names its own id, so a later one can name an earlier
      // one as its parent, and all share one time. The engine applies them
      // all or none (host contract §3), so no sync pass can publish part of
      // one and a refusal part-way leaves the document as it was.
      doc.applyBatch(
        JSON.stringify(seedsDecided(doc, op.ops)),
        op.deviceId,
        now
      );
      return null;
    case "setSetting":
      // A setting (settings-sync spec §3). `valueJson` is JSON text, or
      // null to reset the setting to its default.
      doc.setSetting(op.key, op.valueJson ?? null, op.deviceId, now);
      return null;
    case "seedSetting":
      // A value this device held before its key synced, written as a change
      // only while the document holds nothing for the key, so a seed never
      // replaces what another device chose (settings-sync spec §4.2, as
      // decision 0113 amends it). Asked here, in the worker's queue, so no
      // pass can bring a value in between the question and the write.
      for (const each of seedsDecided(doc, [op])) {
        doc.setSetting(each.key, each.valueJson ?? null, op.deviceId, now);
      }
      return null;
    case "addFavorite":
      // A favorite, folder or separator in the `favorites` document
      // (favorites-native spec §16). Its id derives from the guid Sval
      // mints, so every device names it alike.
      return doc.addFavorite(
        op.favoriteKind,
        op.guid,
        op.parent ?? null,
        op.before ?? null,
        op.after ?? null,
        op.name,
        op.url ?? null,
        op.deviceId,
        now,
        op.local === true
      );
    case "setPinScope":
      // The workspaces a pin shows in, or every one for null (pins spec §7),
      // stamped in the lifecycle group beside the pin itself.
      doc.setPinScope(
        op.id,
        Array.isArray(op.scope) ? op.scope : null,
        op.deviceId,
        now
      );
      return op.id;
    case "addVisit":
      // A visit this device made, in its week's document (history-sync spec
      // §3), with the workspace it was made in or null (decision 1287). Its
      // id derives from the device, the page and the moment, so every device
      // names it alike, and adding it twice changes nothing.
      return doc.addVisit(
        op.url,
        op.title ?? "",
        op.transition,
        op.visitedAt,
        op.workspace ?? null,
        op.deviceId,
        now
      );
    case "setVisitTitle":
      doc.setVisitTitle(op.id, op.title ?? "", op.deviceId, now);
      return op.id;
    case "touchShard":
      // The history index learns that this device wrote to a week, so every
      // device knows to merge it (history-sync spec §3).
      doc.touchShard(op.name, op.deviceId, now);
      return null;
    default:
      throw Object.assign(new Error(`sval: unknown operation "${op.kind}"`), {
        unknownOperation: true,
      });
  }
}

/**
 * The writes to the appearance group, kept apart from {@link applyOp}, whose
 * branches eslint's `complexity` rule caps.
 *
 * @param {object} doc A `SvalDocument`.
 * @param {object} op A `setAppearance` or `setLabel` operation.
 * @param {number} now The time the change is stamped with.
 * @returns {string} the affected node's id.
 */
function applyAppearanceOp(doc, op, now) {
  switch (op.kind) {
    case "setAppearance":
      // The whole appearance group, as `setContent` sends the whole content
      // group (spec §5.3): a caller changing the emoji sends the colour back
      // beside it. Stamping only `appearance_at` keeps recolouring on one
      // device from losing a rename on another (spec §5.1).
      //
      // The colour and transparency are validated by the engine's own
      // boundary, which refuses a shape the node's kind does not take, so
      // the synced document holds no colour a device cannot draw.
      doc.setAppearance(
        op.id,
        op.color ?? null,
        op.emoji ?? null,
        op.transparency ?? null,
        op.deviceId,
        now
      );
      break;
    case "setLabel":
      // A tab's label sits in the appearance group, so a navigation on
      // another device, which rewrites the content group, never competes with
      // it (spec §5.1). `null` clears it, and the tab shows its page's title.
      doc.setLabel(op.id, op.label ?? null, op.deviceId, now);
      break;
  }
  return op.id;
}

/**
 * A batch's operations as the engine takes them, each `seedSetting` decided
 * as `applyOp` decides one alone: a `setSetting` while the key is held
 * neither by the document nor by an earlier operation in the batch, and
 * nothing otherwise.
 *
 * @param {object} doc A `SvalDocument`.
 * @param {object[]} ops
 * @returns {object[]}
 */
function seedsDecided(doc, ops) {
  if (!ops.some(each => each.kind === "seedSetting")) {
    return ops;
  }
  const held = new Set(Object.keys(JSON.parse(doc.settings())));
  const decided = [];
  for (const each of ops) {
    if (each.kind === "seedSetting" && held.has(each.key)) {
      continue;
    }
    if (each.kind === "seedSetting" || each.kind === "setSetting") {
      held.add(each.key);
      decided.push({ ...each, kind: "setSetting" });
    } else {
      decided.push(each);
    }
  }
  return decided;
}
