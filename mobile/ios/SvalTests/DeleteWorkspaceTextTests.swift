// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

@testable import Sval
import XCTest

/// Delete Workspace's question names what the Workspace holds.
final class DeleteWorkspaceTextTests: XCTestCase {
    func testEmpty() {
        XCTAssertNil(DeleteWorkspaceDialog.message(tabs: 0, groups: 0))
    }

    func testTabsOnly() {
        XCTAssertEqual(DeleteWorkspaceDialog.message(tabs: 1, groups: 0), "The tab inside will close on every device.")
        XCTAssertEqual(DeleteWorkspaceDialog.message(tabs: 3, groups: 0),
                       "The 3 tabs inside will close on every device.")
    }

    func testGroupsOnly() {
        XCTAssertEqual(DeleteWorkspaceDialog.message(tabs: 0, groups: 1),
                       "The group inside will be deleted on every device.")
        XCTAssertEqual(DeleteWorkspaceDialog.message(tabs: 0, groups: 2),
                       "The 2 groups inside will be deleted on every device.")
    }

    func testTabsAndGroups() {
        XCTAssertEqual(DeleteWorkspaceDialog.message(tabs: 9, groups: 1),
                       "The 9 tabs and 1 group inside will be deleted on every device.")
        XCTAssertEqual(DeleteWorkspaceDialog.message(tabs: 1, groups: 3),
                       "The tab and 3 groups inside will be deleted on every device.")
    }
}
