// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// Another Workspace's bar as it slides in under a swipe: the same glass
/// capsules, folded as the bar beside it is, over that Workspace's
/// colour, with its emoji where the Workspace button sits.
struct BarPreview: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.verticalSizeClass) private var verticalSize
    let workspace: OutlineRow

    private var colors: BarColors { BarColors(token: model.tint(of: workspace), dark: scheme == .dark) }
    private var layer: Color { colors.layer }

    var body: some View {
        Group {
            if verticalSize == .compact {
                GlassEffectContainer(spacing: 3) {
                    HStack(spacing: 6) {
                        Color.clear.frame(width: 80, height: 44).glassCapsule(layer)
                        Color.clear.frame(maxWidth: .infinity, minHeight: 44, maxHeight: 44).glassCapsule(layer)
                        Color.clear.frame(width: 44, height: 44).glassCapsule(layer)
                        HStack(spacing: 6) {
                            mark(size: 22)
                            Text(WorkspaceTile.name(workspace))
                                .font(.system(.body, weight: .semibold))
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .glassCapsule(layer)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 8)
            } else {
                // Folded as the bar it stands beside is.
                GlassFold(folded: model.browser.fold.folded) { at, folded, shape in
                    ZStack(alignment: .topLeading) {
                        GlassEffectContainer(spacing: 6) {
                            ZStack(alignment: .topLeading) {
                                ForEach(at.indices, id: \.self) { index in
                                    Color.clear
                                        .frame(width: at[index].width, height: at[index].height)
                                        .glassEffect(workspaceGlass(layer, interactive: false), in: .capsule)
                                        .offset(x: at[index].minX, y: at[index].minY)
                                }
                            }
                        }
                        mark(size: 22 * shape.scale)
                            .frame(width: 48, height: 48)
                            .offset(x: at[3].midX - 24, y: at[3].midY - 24)
                            .opacity(folded ? 0 : 1)
                        Circle().fill(layer).frame(width: 24, height: 24)
                            .overlay {
                                mark(size: 13)
                                    .foregroundStyle(BarColors.ink(on: layer, dark: scheme == .dark))
                            }
                            .offset(x: at[1].maxX - 30, y: at[1].midY - 12)
                            .opacity(folded ? 1 : 0)
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .foregroundStyle(colors.ink)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func mark(size: CGFloat) -> some View {
        WorkspaceMark(workspace: workspace, isPrivate: model.isPrivate(workspace.id), size: size)
    }
}
