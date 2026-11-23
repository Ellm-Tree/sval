// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import XCTest
@testable import Sval

/// A group's box in the grid: drawn in the sheet's theme of the moment,
/// and one clean shape when closed.
@MainActor
final class GroupBoxLookTests: XCTestCase {
    private let layers = [GroupLayer(tint: "yellow", top: true, bottom: true)]

    /// A box drawn in one theme is a different decoration from the same
    /// box in another, so a Workspace recoloured or an appearance switched
    /// with the sheet open draws the boxes again.
    func testABoxInAnotherThemeIsAnotherDecoration() {
        let pale = GridBox.kind(layers, theme: Theme(.light, tint: "cyan"))
        XCTAssertNotEqual(pale, GridBox.kind(layers, theme: Theme(.dark, tint: "cyan")))
        XCTAssertNotEqual(pale, GridBox.kind(layers, theme: Theme(.light, tint: "black")))
        XCTAssertEqual(pale, GridBox.kind(layers, theme: Theme(.light, tint: "cyan")))
    }

    /// A closed group's box, shorter than two corners, rounds to a
    /// capsule; a taller box keeps its corners.
    func testAClosedBoxIsACapsule() {
        XCTAssertEqual(GridBox.radius(level: 0, frame: CGRect(x: 0, y: 0, width: 360, height: 38)), 19)
        XCTAssertEqual(GridBox.radius(level: 0, frame: CGRect(x: 0, y: 0, width: 360, height: 200)), 22)
        XCTAssertEqual(GridBox.radius(level: 1, frame: CGRect(x: 0, y: 0, width: 340, height: 200)), 18)
    }
}
