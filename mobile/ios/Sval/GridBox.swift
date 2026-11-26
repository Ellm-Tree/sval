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

    /// One group's box in a section `size` big: its frame, its corner, and
    /// whether the group starts or ends in the section.
    struct Piece: Equatable {
        var tint: String?
        var top: Bool
        var bottom: Bool
        var frame: CGRect
        var radius: CGFloat

        /// The box's fill, rounded where the group starts or ends.
        var fill: UIBezierPath {
            var corners: UIRectCorner = []
            if top { corners.formUnion([.topLeft, .topRight]) }
            if bottom { corners.formUnion([.bottomLeft, .bottomRight]) }
            return UIBezierPath(roundedRect: frame, byRoundingCorners: corners,
                                cornerRadii: CGSize(width: radius, height: radius))
        }

        /// The outline of a coloured box, inside its edge. A box running on
        /// into the next section has its sides only: a full outline would
        /// rule a line across it.
        var ring: UIBezierPath {
            GridBox.outline(frame.insetBy(dx: 0.75, dy: 0.75), radius: radius - 0.75, top: top, bottom: bottom)
        }
    }

    /// The boxes of `layers`, outermost first, in a section `size` big.
    static func pieces(_ layers: [GroupLayer], size: CGSize) -> [Piece] {
        let closing = layers.indices.filter { layers[$0].bottom }
        return layers.enumerated().map { index, layer in
            let inset = GridMetrics.edge + CGFloat(index) * GridMetrics.nest
            // The section's bottom holds the row gap, then the room each
            // closing box keeps below the one inside it.
            var bottom: CGFloat = 0
            if layer.bottom {
                let inside = closing.filter { $0 > index }.count
                bottom = GridMetrics.rowGap + CGFloat(closing.count - 1 - inside) * GridMetrics.boxBottom
            }
            let frame = CGRect(x: inset, y: 0, width: size.width - 2 * inset, height: size.height - bottom)
            return Piece(tint: layer.tint, top: layer.top, bottom: layer.bottom, frame: frame,
                         radius: radius(level: index, frame: frame))
        }
    }

    static func layers(ofKind kind: String?) -> [GroupLayer] {
        let spec = kind?.split(separator: "|").dropFirst().first ?? ""
        return spec.split(separator: ",").map { part in
            let bits = part.split(separator: ":")
            return GroupLayer(tint: bits[0] == "-" ? nil : String(bits[0]), top: bits[1] == "1", bottom: bits[2] == "1")
        }
    }

    private var layers: [GroupLayer] = []
    /// Each box's fill and, for a coloured box, its outline: shape layers,
    /// which keep the drawn paths exactly (a closed box's capsule and an
    /// outline open at one end are shapes a layer's own corner and border
    /// can't take). A box drawn in `draw(_:)` is drawn into a bitmap of its
    /// whole section at the screen's scale (`CALayer.contentsScale`).
    private var fills: [ShapeView] = []
    private var rings: [ShapeView] = []

    override func apply(_ attributes: UICollectionViewLayoutAttributes) {
        super.apply(attributes)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        layers = Self.layers(ofKind: attributes.representedElementKind)
        let pieces = Self.pieces(layers, size: attributes.size)
        while fills.count < pieces.count {
            let fill = ShapeView()
            let ring = ShapeView()
            fill.shape.fillColor = nil
            ring.shape.fillColor = nil
            ring.shape.lineWidth = 1.5
            addSubview(fill)
            addSubview(ring)
            fills.append(fill)
            rings.append(ring)
        }
        while fills.count > pieces.count {
            fills.removeLast().removeFromSuperview()
            rings.removeLast().removeFromSuperview()
        }
        // Each box's outline is over its own fill and under the boxes
        // inside it, as the boxes were drawn.
        for (fill, ring) in zip(fills, rings) {
            bringSubviewToFront(fill)
            bringSubviewToFront(ring)
        }
        if let theme = Self.theme {
            for (index, piece) in pieces.enumerated() {
                let tint = piece.tint.flatMap(WorkspaceTint.init(rawValue:))
                let fill = tint.map {
                    UIColor(GroupBlock.color($0, dark: theme.dark, surface: theme.sheetLightness, blockDir: theme.blockDir,
                                             selected: false))
                } ?? UIColor.white.withAlphaComponent(theme.dark ? 0.07 : 0.5)
                fills[index].shape.fillColor = fill.cgColor
                rings[index].shape.strokeColor = tint.map { UIColor($0.swatch(dark: theme.dark)).cgColor }
            }
        }
        place(pieces, size: attributes.size)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        place(Self.pieces(layers, size: bounds.size), size: bounds.size)
    }

    private func place(_ pieces: [Piece], size: CGSize) {
        let frame = CGRect(origin: .zero, size: size)
        for (index, piece) in pieces.enumerated() where fills[index].placed != piece {
            fills[index].placed = piece
            fills[index].frame = frame
            rings[index].frame = frame
            fills[index].shape.path = piece.fill.cgPath
            rings[index].shape.path = piece.tint == nil ? nil : piece.ring.cgPath
        }
    }
}

/// A view whose layer is a shape layer, for a group box's fill or outline.
final class ShapeView: UIView {
    override static var layerClass: AnyClass { CAShapeLayer.self }

    var shape: CAShapeLayer { layer as! CAShapeLayer }
    /// The box the path was last made for.
    var placed: GridBox.Piece?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
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
