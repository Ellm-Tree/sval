// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// The upright bar's four capsules at any point of their fold into the
/// pill, laid out frame by frame from `progress`, so the whole bar follows
/// one value and a fold turned partway goes back from where it is. The
/// geometry is round 6's Glass Merging demo, which Design made the
/// reference: at rest, Back and Forward (80pt), the address, then New Tab
/// and the Workspace button as 48pt circles, 8pt from the sides and 6pt
/// apart; folded, all four inside one 200 x 48 pill at the centre, as tall as
/// the open bar, Back and
/// the address at its start, New Tab and the Workspace button at its end.
struct GlassFold<Content: View>: View, Animatable {
    var progress: Double
    let content: ([CGRect], Double) -> Content

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    init(progress: Double, @ViewBuilder content: @escaping ([CGRect], Double) -> Content) {
        self.progress = progress
        self.content = content
    }

    static func rest(width: Double) -> [CGRect] {
        let address = width - 8 - 80 - 6 - 48 - 6 - 48 - 6 - 8
        return [CGRect(x: 8, y: 0, width: 80, height: 48), CGRect(x: 94, y: 0, width: address, height: 48),
                CGRect(x: 100 + address, y: 0, width: 48, height: 48), CGRect(x: 154 + address, y: 0, width: 48, height: 48)]
    }

    static func folded(width: Double) -> [CGRect] {
        let x = (width - 200) / 2
        return [CGRect(x: x, y: 0, width: 48, height: 48), CGRect(x: x, y: 0, width: 200, height: 48),
                CGRect(x: x + 152, y: 0, width: 48, height: 48), CGRect(x: x + 152, y: 0, width: 48, height: 48)]
    }

    var body: some View {
        GeometryReader { geometry in
            let t = min(1, max(0, progress))
            let at = zip(Self.rest(width: geometry.size.width), Self.folded(width: geometry.size.width)).map { a, b in
                CGRect(x: a.minX + (b.minX - a.minX) * t, y: a.minY + (b.minY - a.minY) * t,
                       width: a.width + (b.width - a.width) * t, height: a.height + (b.height - a.height) * t)
            }
            content(at, t)
        }
        .frame(height: 48)
    }
}

/// The bar's glass in the Workspace's colour (round 6, 14i): Liquid Glass
/// tinted with it, as `Glass.tint` does for prominence, so the colour
/// belongs to the glass and morphs with it as the capsules merge. A
/// Workspace with no colour has plain glass.
func workspaceGlass(_ color: Color?, interactive: Bool = true) -> Glass {
    let glass = color.map { Glass.regular.tint($0.opacity(BarColors.glassTint)) } ?? .regular
    return interactive ? glass.interactive() : glass
}

/// How far along the fold a part has gone, as the demo's `sm`: 0 before
/// `a`, 1 after `b`, easing between.
func foldStep(_ a: Double, _ b: Double, _ x: Double) -> Double {
    let u = min(1, max(0, (x - a) / (b - a)))
    return u * u * (3 - 2 * u)
}

extension View {
    /// A capsule of glass in the Workspace's colour.
    func glassCapsule(_ color: Color?) -> some View {
        glassEffect(workspaceGlass(color), in: .capsule)
    }
}
