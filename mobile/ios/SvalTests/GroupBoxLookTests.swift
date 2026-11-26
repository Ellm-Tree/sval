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

    /// A box's layers come back from its kind as they went in, the only
    /// way a decoration is told what to show.
    func testABoxReadsItsLayersFromItsKind() {
        let grid = [GroupLayer(tint: nil, top: false, bottom: true), GroupLayer(tint: "red", top: true, bottom: false)]
        XCTAssertEqual(GridBox.layers(ofKind: GridBox.kind(grid, theme: Theme(.light))), grid)
        let list = ListBox.layers(ofKind: ListBox.kind(grid, groups: ["g1", "g2"], dimmed: ["g2"], theme: Theme(.dark)))
        XCTAssertEqual(list, [ListBox.Layer(tint: nil, top: false, bottom: true, dimmed: false),
                              ListBox.Layer(tint: WorkspaceTint(rawValue: "red"), top: true, bottom: false, dimmed: true)])
    }

    /// A grid box closing inside another ends a box's bottom room above
    /// it, and the outer box ends the row gap above the section's end.
    func testClosingGridBoxesStepUp() {
        let layers = [GroupLayer(tint: "red", top: true, bottom: true), GroupLayer(tint: "blue", top: false, bottom: true)]
        let pieces = GridBox.pieces(layers, size: CGSize(width: 400, height: 300))
        XCTAssertEqual(pieces.map(\.frame), [
            CGRect(x: 12, y: 0, width: 376, height: 300 - GridMetrics.rowGap),
            CGRect(x: 20, y: 0, width: 360, height: 300 - GridMetrics.rowGap - GridMetrics.boxBottom),
        ])
        XCTAssertEqual(pieces.map(\.radius), [22, 18])
    }

    /// A nested list block sits a card gap inside its parent where it
    /// starts or ends, and ends further in on the right; a level without a
    /// colour draws nothing but keeps its indent.
    func testListBlocksNestInsideTheirParent() {
        let layers = [ListBox.Layer(tint: WorkspaceTint(rawValue: "yellow"), top: true, bottom: false),
                      ListBox.Layer(tint: nil, top: true, bottom: true),
                      ListBox.Layer(tint: WorkspaceTint(rawValue: "blue"), top: true, bottom: false, dimmed: true)]
        let blocks = ListBox.blocks(layers, size: CGSize(width: 400, height: 100))
        XCTAssertEqual(blocks.map(\.frame), [
            CGRect(x: 16, y: 0, width: 368, height: 100),
            CGRect(x: 64, y: 3, width: 314, height: 97),
        ])
        XCTAssertEqual(blocks.map(\.corners), [.rounding(top: true, bottom: false), .rounding(top: true, bottom: false)])
        XCTAssertEqual(blocks.map(\.dimmed), [false, true])
    }

    /// A block rounds its top corners where its group starts and its bottom
    /// ones where the group ends, in a view's downward y.
    func testABlockRoundsWhereItsGroupStartsOrEnds() {
        XCTAssertEqual(CACornerMask.rounding(top: true, bottom: false), [.layerMinXMinYCorner, .layerMaxXMinYCorner])
        XCTAssertEqual(CACornerMask.rounding(top: false, bottom: true), [.layerMinXMaxYCorner, .layerMaxXMaxYCorner])
        XCTAssertEqual(CACornerMask.rounding(top: false, bottom: false), [])
    }
}
