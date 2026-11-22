// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// The pages whose pictures are kept: the tree's tabs and each Workspace's
/// pins, which the tab scrub shows by page key.
@MainActor
final class PinPicturesTests: XCTestCase {
    private func row(_ id: String, _ kind: NodeKind) -> OutlineRow {
        OutlineRow(id: id, parentId: "w1", depth: 1, kind: kind, name: id, url: "https://\(id).example/", icon: nil,
                   local: false, emoji: nil, label: nil, color: nil, transparency: nil, pinned: false, agent: nil,
                   agentDevice: nil, device: nil, isolated: false, shares: nil)
    }

    private func pin(_ guid: String, kind: String = "favorite") -> PinRow {
        PinRow(id: "w1/\(guid)", guid: guid, kind: kind, name: guid, url: "https://\(guid).example/", local: false,
               folder: nil, scope: nil)
    }

    func testAPinsPictureIsKeptUnderItsPageKey() {
        let kept = Browser.pictured([row("tab", .tab), row("group", .group)],
                                    pins: ["w1": [pin("p1"), pin("folder", kind: "folder")], "w2": [pin("p2")]])
        XCTAssertEqual(kept, ["tab", Browser.pinKey("p1", in: "w1"), Browser.pinKey("p2", in: "w2")])
    }
}
