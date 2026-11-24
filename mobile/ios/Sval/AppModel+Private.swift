// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import AVFoundation
import Foundation
import Security
import Observation
import UIKit

extension AppModel {
    /// The site rules a tab's pages take: a private tab's carry the
    /// session's own choices.
    func siteRules(private isPrivate: Bool) -> SiteRules {
        SiteRules(settings: settings, session: isPrivate ? privateMedia : nil,
                  sessionProtections: isPrivate ? privateProtections : nil)
    }

    /// Turns protections `on` for `name` in the private session's tabs.
    func setPrivateProtections(_ name: String, on: Bool) {
        privateProtections = siteRules(private: true).sessionProtectionsChange(for: name, on: on)
    }

    /// Gives `name` the video and audio choice `choice` for the private
    /// session's tabs.
    func setPrivateMedia(_ name: String, to choice: SiteRules.Media) {
        privateMedia = siteRules(private: true).sessionMediaChange(for: name, to: choice)
        browser.applyMediaChoices()
    }

    func isPrivate(_ id: String) -> Bool {
        privateIds.contains(id) || Browser.pinParts(id).map { privateIds.contains($0.workspace) } == true
    }

    /// Opens the private session, if none is open, and returns its
    /// Workspace.
    func openPrivateSession() async -> String? {
        if let privateWorkspace { return privateWorkspace }
        let document = SvalDocument()
        privateDevice = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        let id = UUID().uuidString.lowercased()
        let ops: [[String: Any]] = [["kind": "addWorkspace", "name": "Private", "id": id]]
        do {
            let json = try JSONSerialization.data(withJSONObject: ops)
            try document.applyBatch(opsJson: String(decoding: json, as: UTF8.self), deviceId: privateDevice,
                                    now: privateClock.now())
        } catch {
            Diagnostics.debug("private: the session did not open: \(Diagnostics.name(error))")
            return nil
        }
        privateDocument = document
        privateWorkspace = id
        Diagnostics.debug("private: a session opened")
        await refreshRows()
        return id
    }

    /// Shows the private session, opening it first if none is open. A
    /// session with no tabs shows the private home behind the bar, and its
    /// first tab is the first page opened from there.
    @discardableResult
    func showPrivateSession() async -> Bool {
        guard let workspace = await openPrivateSession() else { return false }
        browser.showWorkspace(workspace)
        return true
    }

    /// Ends the private session: its tree, its pages and its WebKit store
    /// go, and nothing of it remains.
    func endPrivateSession() async {
        guard privateWorkspace != nil else { return }
        browser.endPrivateSession(privateIds)
        privateDocument = nil
        privateWorkspace = nil
        privateDevice = Data()
        privateMedia = [:]
        privateProtections = [:]
        Diagnostics.debug("private: the session ended")
        await refreshRows()
    }

    /// Whether `ops` act on the private session's tree.
    func touchesPrivate(_ ops: [[String: Any]]) -> Bool {
        ops.contains { op in
            ["id", "parent", "newParent"].contains { key in (op[key] as? String).map(privateIds.contains) == true }
        }
    }

    /// Applies a change to the private session's tree. Nothing is synced
    /// or saved. A change that would move anything between the session and
    /// the user's Workspaces is refused, as the desktop refuses moves
    /// between a private window and any other.
    func editPrivate(_ ops: [[String: Any]]) async -> Bool {
        guard let privateDocument else { return false }
        // A node the user's Workspaces hold, named by a private change.
        let crosses = ops.contains { op in
            ["id", "parent", "newParent", "before", "after"].contains { key in
                (op[key] as? String).map { row($0) != nil && !privateIds.contains($0) } == true
            }
        }
        guard !crosses else {
            Diagnostics.debug("private: a change between the session and a Workspace was refused")
            return false
        }
        do {
            let json = try JSONSerialization.data(withJSONObject: ops)
            try privateDocument.applyBatch(opsJson: String(decoding: json, as: UTF8.self), deviceId: privateDevice,
                                           now: privateClock.now())
        } catch {
            Diagnostics.debug("private: a change was refused: \(Diagnostics.name(error))")
            return false
        }
        await refreshRows()
        return true
    }

    static let keyUnconfirmedKey = "syncKeyUnconfirmed"

    static let startingKey = "startingFolder"
}
