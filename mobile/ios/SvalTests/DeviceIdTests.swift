// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import XCTest
@testable import Sval

/// A phone that starts over keeps its device id, and so its own Workspace
/// (decisions 2232 and 2254). Each test runs the app's own syncer, whose
/// copy lives in the test host's container, and leaves no copy behind.
final class DeviceIdTests: XCTestCase {
    private let syncKey = Data((0..<32).map { _ in UInt8.random(in: 0...255) })

    override func setUpWithError() throws {
        try Syncer.deleteLocalCopy()
    }

    override func tearDownWithError() throws {
        try Syncer.deleteLocalCopy()
    }

    private func edit(_ syncer: Syncer, _ ops: [[String: Any]]) async throws {
        let json = try JSONSerialization.data(withJSONObject: ops)
        try await syncer.edit(workspacesDocument, opsJson: String(decoding: json, as: UTF8.self))
    }

    /// Makes `syncer`'s own Workspace with one tab in it, and returns the
    /// tab's id.
    private func ownWorkspace(_ syncer: Syncer, tab url: String) async throws -> String {
        let workspace = UUID().uuidString.lowercased()
        let tab = UUID().uuidString.lowercased()
        try await edit(syncer, [
            ["kind": "addDeviceWorkspace", "name": "iPhone", "id": workspace],
            ["kind": "addTab", "parent": workspace, "name": url, "url": url, "id": tab],
        ])
        return tab
    }

    func testAPhoneThatStartsOverKeepsItsDeviceId() async throws {
        let before = try Syncer.make()
        try await before.leave()
        let after = try Syncer.make()
        XCTAssertEqual(after.device, before.device)
    }

    func testAPhoneThatStartsOverAndJoinsAgainHasOneWorkspaceOfItsOwnWithEveryTab() async throws {
        let folder = MemoryFolder()
        let before = try Syncer.make()
        let earlier = try await ownWorkspace(before, tab: "https://example.com/before")
        _ = try await before.sync(shared: folder, syncKey: syncKey, starting: true)
        try await before.leave()

        // Started over, the phone browses in a fresh Workspace of its own,
        // then joins the same folder again.
        let after = try Syncer.make()
        let later = try await ownWorkspace(after, tab: "https://example.com/after")
        _ = try await after.sync(shared: folder, syncKey: syncKey)
        let joined = OutlineIndex(await after.outline())
        let mine = joined.rows.filter { $0.parentId == nil && $0.device == after.device }
        XCTAssertEqual(mine.count, 2, "the folder brings back the Workspace the id made before")

        try await edit(after, AppModel.foldOps(mine, in: joined))
        let folded = OutlineIndex(await after.outline())
        let own = folded.rows.filter { $0.parentId == nil && $0.device == after.device }
        XCTAssertEqual(own.count, 1)
        XCTAssertEqual(Set(folded.children(of: own[0].id).map(\.id)), [earlier, later])
    }
}
