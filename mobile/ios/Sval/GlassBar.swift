// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// The upright bar's four capsules, open or folded into the pill. It has
/// no animatable data, so a fold redraws it once and SwiftUI animates each
/// capsule's frame from one layout to the other. The
/// geometry is round 6's Glass Merging demo, which Design made the
/// reference: at rest, Back and Forward (80pt), the address, then New Tab
/// and the Workspace button as 48pt circles, 8pt from the sides and 6pt
/// apart; folded, all four inside one 200 x 48 pill at the centre, as tall as
/// the open bar, Back and
/// the address at its start, New Tab and the Workspace button at its end.
///
/// At the accessibility text sizes the open bar is two rows
/// ([`BarShape`]): the address across the top, as tall as its text, and
/// under it Back and Forward at the start and New Tab and the Workspace
/// button at the end. Its pill is as tall as the address and wider.
struct GlassFold<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    /// A line of the address's text, which is `.subheadline`.
    @ScaledMetric(relativeTo: .subheadline) private var line: CGFloat = BarShape.line
    let folded: Bool
    let content: ([CGRect], Bool, BarShape) -> Content

    init(folded: Bool, @ViewBuilder content: @escaping ([CGRect], Bool, BarShape) -> Content) {
        self.folded = folded
        self.content = content
    }

    static func rest(width: Double, shape: BarShape = .standard) -> [CGRect] {
        guard shape.tall else {
            let address = width - 8 - 80 - 6 - 48 - 6 - 48 - 6 - 8
            return [CGRect(x: 8, y: 0, width: 80, height: 48), CGRect(x: 94, y: 0, width: address, height: 48),
                    CGRect(x: 100 + address, y: 0, width: 48, height: 48), CGRect(x: 154 + address, y: 0, width: 48, height: 48)]
        }
        let side = shape.control
        let y = shape.address + 6
        return [CGRect(x: 8, y: y, width: side * 2 - 16, height: side), CGRect(x: 8, y: 0, width: width - 16, height: shape.address),
                CGRect(x: width - 14 - side * 2, y: y, width: side, height: side),
                CGRect(x: width - 8 - side, y: y, width: side, height: side)]
    }

    static func folded(width: Double, shape: BarShape = .standard) -> [CGRect] {
        let pill = shape.tall ? min(width - 16, 300) : 200
        let tall = shape.tall ? shape.address : 48
        let x = (width - pill) / 2
        let y = shape.height - tall
        return [CGRect(x: x, y: y, width: 48, height: tall), CGRect(x: x, y: y, width: pill, height: tall),
                CGRect(x: x + pill - 48, y: y, width: 48, height: tall), CGRect(x: x + pill - 48, y: y, width: 48, height: tall)]
    }

    var body: some View {
        let shape = BarShape(typeSize, line: line)
        GeometryReader { geometry in
            let width = geometry.size.width
            content(folded ? Self.folded(width: width, shape: shape) : Self.rest(width: width, shape: shape),
                    folded, shape)
        }
        .frame(height: shape.height)
    }
}

/// The upright bar's sizes: one 48pt row at the standard text sizes, and
/// two at the accessibility sizes, where one row leaves the address a
/// letter or two.
struct BarShape: Equatable {
    var tall = false
    /// The address capsule's height.
    var address = 48.0
    /// A side of New Tab and the Workspace button, and the height of Back
    /// and Forward's capsule.
    var control = 48.0

    static let standard = BarShape()

    /// A line of the address's subheadline text, before Dynamic Type
    /// scales it.
    static let line: CGFloat = 20
    /// The gap between capsules side by side.
    static let gap: CGFloat = 6
    /// A mark to the label beside it inside one capsule.
    static let labelGap: CGFloat = 6
    /// The bar from the screen's sides, clear of its rounded corners.
    static let side: CGFloat = 20
    /// The upright bar's foot above the screen's edge.
    static let foot = 24.0
    /// The sideways bar's foot above the screen's edge.
    static let sidewaysFoot = 8.0

    init() {}

    init(_ typeSize: DynamicTypeSize, line: Double) {
        guard typeSize.isAccessibilitySize else { return }
        tall = true
        address = line + 20
        control = 60
    }

    var height: Double { tall ? address + 6 + control : 48 }
    /// How much larger the bar's glyphs are drawn.
    var scale: Double { control / 48 }
}

/// The bar's glass in the Workspace's colour (round 6, 14i): Liquid Glass
/// tinted with it, as `Glass.tint` does for prominence, so the colour
/// belongs to the glass and morphs with it as the capsules merge. A
/// Workspace with no colour has plain glass.
func workspaceGlass(_ color: Color?, interactive: Bool = true) -> Glass {
    let glass = color.map { Glass.regular.tint($0.opacity(BarColors.glassTint)) } ?? .regular
    return interactive ? glass.interactive() : glass
}

extension View {
    /// A capsule of glass in the Workspace's colour.
    func glassCapsule(_ color: Color?) -> some View {
        glassEffect(workspaceGlass(color), in: .capsule)
    }
}
