// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

@testable import Sval
import XCTest

/// What each text prompt saves from what was typed in it.
@MainActor
final class TextPromptTests: XCTestCase {
    func testTabName() {
        XCTAssertEqual(PromptValue.tabName("  Reading \n"), "Reading")
        XCTAssertEqual(PromptValue.tabName(" \n"), "", "an empty name is saved, which takes the label away")
    }

    func testSplitAndPinNamesAsTyped() {
        XCTAssertEqual(PromptValue.asTyped(" Docs "), " Docs ", "the model trims them")
        XCTAssertEqual(PromptValue.asTyped(""), "")
    }

    func testFavoriteName() {
        XCTAssertEqual(PromptValue.favoriteName("  News\n"), "News")
        XCTAssertNil(PromptValue.favoriteName("  \n"), "an empty name changes nothing")
    }

    func testPinFolderName() {
        XCTAssertEqual(PromptValue.pinFolderName("  Work  "), "Work")
        XCTAssertEqual(PromptValue.pinFolderName("   "), PinsRow.newPinFolderName, "Create always makes the folder")
    }

    func testAddress() {
        XCTAssertEqual(PromptValue.address(" example.com ")?.host(), "example.com")
        XCTAssertNil(PromptValue.address("two words"), "a search saves nothing")
    }
}
