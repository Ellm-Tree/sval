// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// How the Workspace sheet draws the tree: rows, or cards with a picture of
/// each page (round 7). This phone's own; the desktop's sidebar has no grid.
enum TabLayout: String, CaseIterable {
    case list, grid
    static let key = "tabLayout"

    /// The choice as Settings and the Workspace sheet's menu offer it.
    var label: Label<Text, Image> {
        switch self {
        case .list: Label("List", systemImage: "list.bullet")
        case .grid: Label("Grid", systemImage: "square.grid.2x2")
        }
    }
}

/// A finger resting on a card's side: the side, where the rest began, and
/// since when.
struct EdgeRest: Equatable {
    let key: String
    let at: CGPoint
    let since: Date
}

/// Where a finger is in a card's cell: the room between the card and the
/// sheet's edge, the room between it and the next card, the card's outer
/// fifths, or its middle; and which half of each.
enum GridZone: Equatable {
    case edge(left: Bool)
    case crack(left: Bool)
    case side(left: Bool)
    case middle(left: Bool)
}

/// The grid's measures (15b, 15d, 15h).
enum GridMetrics {
    /// Room inside each cell for the ring of the tab in front, so the
    /// system's lift and menu previews, cut to the cell, keep it.
    static let ring: CGFloat = 5
    static let columnGap: CGFloat = 11 - 2 * ring
    static let rowGap: CGFloat = 14 - 2 * ring
    /// The room a cell keeps above and below its card: the ring's, and
    /// half the gap to the next row. The rows meet with no space between
    /// them, so a finger between two rows is over a cell, where the system
    /// has a place to open a gap.
    static let padY = ring + rowGap / 2
    /// The sheet's edge to a box's edge, and each level's step inward.
    static let edge: CGFloat = 12
    static let nest: CGFloat = 8
    /// A group's header, and the box's room above it and below its cards.
    /// The header grows with its name's text.
    static var header: CGFloat { ceil(UIFont.preferredFont(forTextStyle: .body).lineHeight) + 22 }
    static var nestedHeader: CGFloat { ceil(UIFont.preferredFont(forTextStyle: .subheadline).lineHeight) + 20 }
    /// The bar over the top of a card's picture, which grows with its
    /// title's text.
    static var bar: CGFloat { ceil(UIFont.preferredFont(forTextStyle: .subheadline).lineHeight) + 12 }
    /// Cards across: two, or one at the accessibility text sizes, where
    /// half the sheet's width holds a few letters of a title.
    static var columns: Int { UIApplication.shared.preferredContentSizeCategory.isAccessibilityCategory ? 1 : 2 }
    static let boxTop: CGFloat = 2
    static let boxBottom: CGFloat = 10
    /// The part of a card at each side that drops before or after it, a
    /// fifth of its width; the three fifths between are the middle (15f2).
    static func side(_ width: CGFloat) -> CGFloat { width / 5 }

    /// How far a card sits in from its cell's sides in `column` of
    /// `columns`, leading and trailing. The cells split the grid's whole
    /// width evenly, so the margin beside a card is over its cell. Toward
    /// the sheet's edge, a card keeps the margin to every box around it;
    /// toward the next column, the ring's room and half the gap.
    static func insets(layers: Int, column: Int, columns: Int) -> (leading: CGFloat, trailing: CGFloat) {
        let outer = edge + CGFloat(layers) * nest
        let inner = ring + columnGap / 2
        return (column == 0 ? outer : inner, column == columns - 1 ? outer : inner)
    }

    /// The zone of a cell that `point` is in, given the cell's `card` and
    /// which of the cell's sides face the sheet's edge.
    static func zone(_ point: CGPoint, card: CGRect, outer: (left: Bool, right: Bool)) -> GridZone {
        guard card.contains(point) else {
            if point.x < card.minX, outer.left { return .edge(left: true) }
            if point.x >= card.maxX, outer.right { return .edge(left: false) }
            return .crack(left: point.x < card.midX)
        }
        let side = side(card.width)
        if point.x < card.minX + side { return .side(left: true) }
        if point.x >= card.maxX - side { return .side(left: false) }
        return .middle(left: point.x < card.midX)
    }

    /// Where `point` falls in the middle of `card`, over the card's whole
    /// height: how far across the middle, the middle's width and the
    /// card's height. A `latched` card's middle takes the whole cell,
    /// drawn in to the middle's nearest point.
    static func middle(_ point: CGPoint, card: CGRect, latched: Bool = false) -> (x: CGFloat, span: CGFloat, picture: CGFloat)? {
        let side = side(card.width)
        let span = card.width - 2 * side
        var x = point.x - card.minX - side
        if latched {
            x = min(max(x, 0), span)
        } else {
            guard card.contains(point), x >= 0, x < span else { return nil }
        }
        return (x, span, card.height)
    }

    /// The card whose halves stay up: `latched` while the finger is over
    /// that card's cell, which keeps every part of the cell in the
    /// halves, and none once the finger leaves it or reaches the room
    /// toward the sheet's edge, which is off the card.
    static func latch(_ latched: String?, over: String?, zone: GridZone) -> String? {
        if case .edge = zone { return nil }
        return latched == over ? latched : nil
    }

    /// How long a finger rests still in `zone` before the gap opens: off
    /// the card, which offers nothing else, at once; a card's side, long
    /// enough to pass through on the way to the middle.
    static func restTime(_ zone: GridZone) -> TimeInterval {
        switch zone {
        case .edge, .crack: 0.1
        case .side, .middle: 0.25
        }
    }

    /// How far a finger may drift on a card's side and still rest there.
    /// A finger crossing the side on its way to the middle leaves this
    /// radius, so its rest starts over and never completes.
    static let restDrift: CGFloat = 10

    /// The rest on the card side `key` once the finger is at `point`:
    /// `rest` while the finger stays on that side within `restDrift` of
    /// where `rest` began, or a rest beginning `now` at `point`.
    static func rest(_ rest: EdgeRest?, key: String, at point: CGPoint, now: Date) -> EdgeRest {
        if let rest, rest.key == key, hypot(point.x - rest.at.x, point.y - rest.at.y) <= restDrift { return rest }
        return EdgeRest(key: key, at: point, since: now)
    }

    /// A card's picture height at `depth` groups in: 140, 132, 124, and on
    /// in 8pt steps, or 104, 96, 90 sideways, where the page is wide.
    static func picture(depth: Int, sideways: Bool) -> CGFloat {
        if sideways { return [104, 96, 90][min(depth, 2)] - CGFloat(max(depth - 2, 0)) * 6 }
        return max(140 - CGFloat(depth) * 8, 80)
    }

    /// A cell's height: the picture, which carries the bar, and the
    /// cell's room above and below.
    static func cell(depth: Int, sideways: Bool) -> CGFloat {
        picture(depth: depth, sideways: sideways) + 2 * padY
    }
}
