// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A section's group boxes, drawn behind its cards. The layers ride in the
/// decoration's kind, the one thing a background decoration is given, with
/// the facts of the theme the box is drawn in: a decoration whose
/// attributes are unchanged is never given them again, so a box drawn in
/// another theme stays as it was drawn until its kind changes.
final class GridBox: UICollectionReusableView {
    static var theme: Theme?

    static func kind(_ layers: [GroupLayer], theme: Theme) -> String {
        "box|" + layers.map { "\($0.tint ?? "-"):\($0.top ? 1 : 0):\($0.bottom ? 1 : 0)" }.joined(separator: ",")
            + "|\(theme.dark ? 1 : 0):\(theme.sheetLightness):\(theme.blockDir)"
    }

    private var layers: [(tint: String?, top: Bool, bottom: Bool)] = []

    override func apply(_ attributes: UICollectionViewLayoutAttributes) {
        super.apply(attributes)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        contentMode = .redraw
        let spec = attributes.representedElementKind?.split(separator: "|").dropFirst().first ?? ""
        layers = spec.split(separator: ",").map { part in
            let bits = part.split(separator: ":")
            return (bits[0] == "-" ? nil : String(bits[0]), bits[1] == "1", bits[2] == "1")
        }
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let theme = Self.theme else { return }
        let closing = layers.indices.filter { layers[$0].bottom }
        for (index, layer) in layers.enumerated() {
            let inset = GridMetrics.edge + CGFloat(index) * GridMetrics.nest
            // The section's bottom holds the row gap, then the room each
            // closing box keeps below the one inside it.
            var bottom: CGFloat = 0
            if layer.bottom {
                let inside = closing.filter { $0 > index }.count
                bottom = GridMetrics.rowGap + CGFloat(closing.count - 1 - inside) * GridMetrics.boxBottom
            }
            let frame = CGRect(x: inset, y: 0, width: bounds.width - 2 * inset, height: bounds.height - bottom)
            let radius = Self.radius(level: index, frame: frame)
            var corners: UIRectCorner = []
            if layer.top { corners.formUnion([.topLeft, .topRight]) }
            if layer.bottom { corners.formUnion([.bottomLeft, .bottomRight]) }
            let path = UIBezierPath(roundedRect: frame, byRoundingCorners: corners,
                                    cornerRadii: CGSize(width: radius, height: radius))
            let tint = layer.tint.flatMap(WorkspaceTint.init(rawValue:))
            let fill = tint.map {
                UIColor(GroupBlock.color($0, dark: theme.dark, surface: theme.sheetLightness, blockDir: theme.blockDir,
                                         selected: false))
            } ?? UIColor.white.withAlphaComponent(theme.dark ? 0.07 : 0.5)
            fill.setFill()
            path.fill()
            if let tint {
                // A box running on into the next section draws its sides
                // only: a full outline would rule a line across it.
                let ring = Self.outline(frame.insetBy(dx: 0.75, dy: 0.75), radius: radius - 0.75,
                                        top: layer.top, bottom: layer.bottom)
                UIColor(tint.swatch(dark: theme.dark)).setStroke()
                ring.lineWidth = 1.5
                ring.stroke()
            }
        }
    }
}

extension GridBox {
    /// The corner of the box `level` groups in, around `frame`. A closed
    /// group's box is shorter than two corners, so they shrink to half its
    /// height: larger, the outline's ends cross themselves and leave the
    /// fill's corners outside it.
    static func radius(level: Int, frame: CGRect) -> CGFloat {
        min(level == 0 ? 22 : 18, frame.height / 2, frame.width / 2)
    }

    /// A box's outline in one section: its sides, with its rounded top or
    /// bottom only where the box starts or ends.
    static func outline(_ frame: CGRect, radius: CGFloat, top: Bool, bottom: Bool) -> UIBezierPath {
        let path = UIBezierPath()
        let r = radius
        if top {
            path.move(to: CGPoint(x: frame.minX, y: frame.minY + r))
            path.addArc(withCenter: CGPoint(x: frame.minX + r, y: frame.minY + r), radius: r,
                        startAngle: .pi, endAngle: 1.5 * .pi, clockwise: true)
            path.addLine(to: CGPoint(x: frame.maxX - r, y: frame.minY))
            path.addArc(withCenter: CGPoint(x: frame.maxX - r, y: frame.minY + r), radius: r,
                        startAngle: 1.5 * .pi, endAngle: 0, clockwise: true)
        } else {
            path.move(to: CGPoint(x: frame.maxX, y: frame.minY))
        }
        path.addLine(to: CGPoint(x: frame.maxX, y: bottom ? frame.maxY - r : frame.maxY))
        if bottom {
            path.addArc(withCenter: CGPoint(x: frame.maxX - r, y: frame.maxY - r), radius: r,
                        startAngle: 0, endAngle: 0.5 * .pi, clockwise: true)
            path.addLine(to: CGPoint(x: frame.minX + r, y: frame.maxY))
            path.addArc(withCenter: CGPoint(x: frame.minX + r, y: frame.maxY - r), radius: r,
                        startAngle: 0.5 * .pi, endAngle: .pi, clockwise: true)
        } else {
            path.move(to: CGPoint(x: frame.minX, y: frame.maxY))
        }
        path.addLine(to: CGPoint(x: frame.minX, y: top ? frame.minY + r : frame.minY))
        return path
    }
}

// MARK: Cards
