// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

@testable import Sval
import XCTest

/// Delete Group's question names what the group holds, and its buttons
/// name what they keep or remove.
final class DeleteGroupTextTests: XCTestCase {
    func testTabsOnly() {
        let one = WorkspaceSheet.deleteGroupText(tabs: 1, groups: 0)
        XCTAssertEqual([one.message, one.keep, one.delete], ["Keep or close the tab inside.", "Keep Tab", "Close Tab"])
        let three = WorkspaceSheet.deleteGroupText(tabs: 3, groups: 0)
        XCTAssertEqual([three.message, three.keep, three.delete],
                       ["Keep or close the 3 tabs inside.", "Keep Tabs", "Close Tabs"])
    }

    func testGroupsOnly() {
        let one = WorkspaceSheet.deleteGroupText(tabs: 0, groups: 1)
        XCTAssertEqual([one.message, one.keep, one.delete],
                       ["Keep or delete the group inside.", "Keep Group", "Delete Group"])
        let two = WorkspaceSheet.deleteGroupText(tabs: 0, groups: 2)
        XCTAssertEqual([two.message, two.keep, two.delete],
                       ["Keep or delete the 2 groups inside.", "Keep Groups", "Delete Groups"])
    }

    func testTabsAndGroups() {
        let text = WorkspaceSheet.deleteGroupText(tabs: 3, groups: 1)
        XCTAssertEqual([text.message, text.keep, text.delete],
                       ["Keep or delete the 3 tabs and 1 group inside.", "Keep All", "Delete All"])
    }
}
