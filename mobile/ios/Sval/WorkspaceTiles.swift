// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// A Workspace's tile: its emoji, or its name's first letter, on its tint.
/// An agent's or a device's own wears its mark (`AppModel.markImage`).
struct WorkspaceTile: View {
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    let workspace: OutlineRow?
    let size: CGFloat
    /// The tile's fill where it sits on the Workspace's own tint, as in the
    /// bar; elsewhere the tint itself.
    var fill: Color?
    var radius: CGFloat?

    static func name(_ row: OutlineRow) -> String {
        row.displayTitle
    }

    @Environment(AppModel.self) private var model

    var body: some View {
        if let workspace, model.isPrivate(workspace.id) {
            PrivateTile(size: size, radius: radius ?? size * Radius.tileFactor)
        } else {
            tile
        }
    }

    private var tile: some View {
        let tint = workspace?.color.flatMap(WorkspaceTint.init(rawValue:))
        let dark = scheme == .dark
        // The surface the tile sits on, for its edge and a colourless
        // tile's fill.
        let surface = Theme(scheme, tint: sheetTint)
        let background = fill ?? tint?.tile(dark: dark) ?? surface.cell
        let corner = radius ?? size * Radius.tileFactor
        return RoundedRectangle(cornerRadius: corner)
            .fill(background)
            .overlay {
                RoundedRectangle(cornerRadius: corner)
                    .strokeBorder(surface.tileRing, lineWidth: 1.5)
            }
            .overlay {
                if let image = workspace.flatMap(model.markImage) {
                    Image(image)
                        .resizable()
                        .scaledToFit()
                        .frame(width: size * 0.5, height: size * 0.5)
                        .foregroundStyle(tint == nil && fill == nil ? surface.text : Theme(scheme, tint: workspace?.color).text)
                } else if let emoji = workspace?.emoji, !emoji.isEmpty {
                    Text(emoji).font(.system(size: size * 0.55)).accessibilityIgnoresInvertColors()
                } else {
                    Text(workspace.map { String(Self.name($0).prefix(1)).uppercased() } ?? "")
                        .font(SvalFont.outfit(size * 0.45, .bold, relativeTo: .body))
                        // A colourless tile is the surface's cell, so its
                        // letter takes the surface's ink.
                        .foregroundStyle(tint == nil && fill == nil ? surface.text : Theme(scheme, tint: workspace?.color).text)
                }
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// A Workspace's mark in the bar: its emoji, its name's initial when it
/// has none, the private mask, or an agent's or device's mark
/// (`AppModel.markImage`), in the ink around it.
struct WorkspaceMark: View {
    @Environment(AppModel.self) private var model
    let workspace: OutlineRow?
    let isPrivate: Bool
    let size: CGFloat

    var body: some View {
        if isPrivate {
            Image("private").resizable().scaledToFit().frame(width: size, height: size)
        } else if let image = workspace.flatMap(model.markImage) {
            Image(image).resizable().scaledToFit().frame(width: size * 0.8, height: size * 0.8)
        } else if let emoji = workspace?.emoji, !emoji.isEmpty {
            Text(emoji).font(.system(size: size * 0.9)).accessibilityIgnoresInvertColors()
        } else {
            Text(workspace.map { String(WorkspaceTile.name($0).prefix(1)).uppercased() } ?? "")
                .font(SvalFont.outfit(size * 0.8, .bold, relativeTo: .body))
        }
    }
}

/// The private session's tile: Private Violet with the desktop's private
/// mask (round 5, 13a1).
struct PrivateTile: View {
    let size: CGFloat
    var radius: CGFloat?

    var body: some View {
        let corner = radius ?? size * Radius.tileFactor
        RoundedRectangle(cornerRadius: corner)
            .fill(Theme.privateViolet)
            .overlay { RoundedRectangle(cornerRadius: corner).strokeBorder(Theme.privateEdge.opacity(0.6), lineWidth: 1.5) }
            .overlay {
                Image("private").resizable().scaledToFit()
                    .frame(width: size * 0.52, height: size * 0.52)
                    .foregroundStyle(.white)
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
