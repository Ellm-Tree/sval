// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import AVFoundation
import Foundation
import Security
import Observation
import UIKit

extension AppModel {
    /// This phone's own Workspace (decision 2254): where it opens, and
    /// where a new tab goes when another device's Workspace is in front.
    var ownWorkspace: OutlineRow? {
        guard let me = syncer?.device else { return nil }
        return workspaces.first { $0.device == me }
    }

    /// Whether tabs in this Workspace can be put in groups: every one but
    /// the private session's, a device's own Workspace included
    /// (decision 2254).
    func makesGroups(in workspace: String?) -> Bool {
        guard let workspace, row(workspace) != nil else { return false }
        return !isPrivate(workspace)
    }

    /// What an agent's Workspaces go under: the agent's label, then the
    /// device that paired the agent once its name has arrived, as the
    /// desktop's `agentLabelOf` reads for another device (agent-control spec
    /// §3.5). An agent pairs with a computer, so on the phone it is always
    /// another device. Nil for a Workspace that is no agent's.
    func agentName(_ row: OutlineRow) -> String? {
        guard let label = row.agent else { return nil }
        let name = label.trimmingCharacters(in: .whitespaces).isEmpty ? "An agent" : label
        guard let device = row.agentDevice,
              let other = settings["sval.device.name.\(device.map { String(format: "%02x", $0) }.joined())"] as? String,
              !other.isEmpty
        else { return name }
        return "\(name) · \(other)"
    }

    /// The mark a Workspace wears in place of an emoji, as on the desktop:
    /// an agent's app's mark, or the robot for an app Sval doesn't know, and
    /// a phone or a tablet for a device's own, as that device says it is.
    /// Nil for the user's own Workspaces.
    func markImage(_ row: OutlineRow) -> String? {
        if let label = row.agent { return AgentBrands.image(for: label) ?? "agent-robot" }
        guard let device = row.device else { return nil }
        let hex = device.map { String(format: "%02x", $0) }.joined()
        return settings["sval.device.kind.\(hex)"] as? String == "tablet" ? "device-tablet" : "device-phone"
    }

    /// Whether `row` is another device's own Workspace.
    func isOtherDevices(_ row: OutlineRow) -> Bool {
        guard let device = row.device else { return false }
        return device != syncer?.device
    }

    /// Where a new tab opens from the Workspace in front: there, unless
    /// it's another device's, when it opens in this phone's own.
    func newTabWorkspace(from id: String?) -> String? {
        if let id, let row = row(id), !isOtherDevices(row) { return id }
        return ownWorkspace?.id ?? workspaces.first?.id
    }

    #if DEBUG
    /// A tab at the end of `parent`, for the demo tree.
    func demoTab(_ name: String, _ url: String, in parent: String) async -> String? {
        let id = UUID().uuidString.lowercased()
        var op: [String: Any] = ["kind": "addTab", "parent": parent, "name": name, "url": url, "id": id]
        op["before"] = children(of: parent).last?.id
        return await edit([op]) ? id : nil
    }

    /// A split of `tabs`, each a name and an address, for the demo tree.
    func demoSplit(_ tabs: [(String, String)], in parent: String) async -> String? {
        let id = UUID().uuidString.lowercased()
        var split: [String: Any] = ["kind": "addSplit", "parent": parent, "name": "", "id": id]
        split["before"] = children(of: parent).last?.id
        var ops = [split]
        var previous: String?
        for (name, url) in tabs {
            let tab = UUID().uuidString.lowercased()
            var add: [String: Any] = ["kind": "addTab", "parent": id, "name": name, "url": url, "id": tab]
            add["before"] = previous
            ops.append(add)
            previous = tab
        }
        return await edit(ops) ? id : nil
    }
    #endif

    /// Makes this phone's own Workspace when it has none: on first run, or
    /// after another device deleted it, when it comes back empty under a
    /// new id (decision 2254).
    func keepOwnWorkspace() async {
        await foldOwnWorkspaces()
        guard browsing, syncer != nil, ownWorkspace == nil, !makingOwnWorkspace else { return }
        makingOwnWorkspace = true
        defer { makingOwnWorkspace = false }
        let id = UUID().uuidString.lowercased()
        if await edit([["kind": "addDeviceWorkspace", "name": UIDevice.current.name, "id": id]]) {
            Diagnostics.log("workspaces: made this device's own Workspace")
        }
    }

    /// Folds every Workspace of this phone's own into the first. A phone
    /// that starts over makes a fresh one before it joins again, and the
    /// folder then brings back the one its device id made before
    /// (decision 2232), where each phone keeps one (decision 2254).
    private func foldOwnWorkspaces() async {
        guard let me = syncer?.device else { return }
        let mine = workspaces.filter { $0.device == me }
        guard let keep = mine.first, mine.count > 1 else { return }
        if await edit(Self.foldOps(mine, in: tree)) {
            Diagnostics.log("workspaces: folded \(mine.count - 1) more of this device's own into one")
            if let shown = browser.workspaceId, mine.dropFirst().contains(where: { $0.id == shown }) {
                browser.showWorkspace(keep.id)
            }
        }
    }

    /// The edits that move what every Workspace after the first in `mine`
    /// holds to the end of the first, in order, and remove the others.
    nonisolated static func foldOps(_ mine: [OutlineRow], in tree: OutlineIndex) -> [[String: Any]] {
        guard let keep = mine.first else { return [] }
        var ops: [[String: Any]] = []
        var last = tree.children(of: keep.id).last?.id
        for extra in mine.dropFirst() {
            for child in tree.children(of: extra.id) {
                var move: [String: Any] = ["kind": "moveNode", "id": child.id, "newParent": keep.id]
                move["before"] = last
                ops.append(move)
                last = child.id
            }
            ops.append(["kind": "remove", "id": extra.id])
        }
        return ops
    }

    /// Names this phone for the other devices, once: their History shows
    /// its visits under the name (history-sync spec §3.1). iOS gives apps
    /// the model's name, such as "iPhone".
    func nameThisDevice() async {
        guard let syncer else { return }
        let key = "sval.device.name.\(syncer.deviceHex)"
        if settings[key] == nil {
            await setSetting(key, to: UIDevice.current.name)
        }
        // Whether this is a phone or a tablet, so every device draws its
        // Workspace with that device's mark.
        let kindKey = "sval.device.kind.\(syncer.deviceHex)"
        let kind = UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "phone"
        if settings[kindKey] as? String != kind {
            await setSetting(kindKey, to: kind)
        }
    }
}
