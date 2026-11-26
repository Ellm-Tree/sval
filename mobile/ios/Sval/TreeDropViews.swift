// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UniformTypeIdentifiers

/// A tab's or split's middle under a drag: a new group on the left half,
/// a split on the right.
struct DropHalves: Equatable {
    /// Whether the Workspace offers groups at all; without, the split
    /// takes the whole row.
    let groups: Bool
    let group: Bool
    let split: DropKind
    let splits: Bool
}

/// A tab's or split's middle under a drag (`sval-drop-mark`): the row's
/// own content fades, and its two halves show both drops, New group on the
/// left and the split on the right, the one under the finger filled. A
/// half that would write nothing is drawn faint.
struct DropHalvesMark: View {
    let halves: DropHalves
    /// Whether the finger is on the split half.
    let onSplit: Bool
    let color: Color
    let muted: Color
    /// The sheet's colour, laid over the row to fade it.
    let cover: Color
    /// A grid card's halves, too narrow for the list's labels: Group and
    /// Split, the glyph above each.
    var compact = false

    /// The cover's room around the halves.
    private static let inset: CGFloat = 4
    /// A half's corner, concentric with the cover's.
    private static let halfCorner = WorkspaceSheet.cardCorner - inset

    private var splitLabel: String {
        if compact { return "Split" }
        return switch halves.split {
        case .join: "Join Split"
        case .merge: "Merge Splits"
        case .refused(full: true): "\(TreeDrop.maxPanes) Pages Max"
        default: "Create Split"
        }
    }

    private func half(_ label: String, icon: String, active: Bool, enabled: Bool) -> some View {
        let layout = compact ? AnyLayout(VStackLayout(spacing: 4)) : AnyLayout(HStackLayout(spacing: 6))
        return layout {
            Image(systemName: icon).font(Glyph.besideCaption)
            Text(label)
                .font(.system(.subheadline, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .foregroundStyle(active && enabled ? BarColors.ink(on: color, dark: true) : (enabled ? color : muted))
        .padding(.horizontal, 8)
        // On a card, the label sits at the half's foot, clear of the card
        // held over it.
        .padding(.bottom, compact ? 10 : 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: compact ? .bottom : .center)
        .background(active && enabled ? color : .clear, in: .rect(cornerRadius: Self.halfCorner))
        .overlay {
            RoundedRectangle(cornerRadius: Self.halfCorner)
                .strokeBorder(enabled ? color : muted, style: StrokeStyle(lineWidth: Stroke.ring, dash: enabled ? [] : Stroke.dash))
        }
        .opacity(enabled ? 1 : Dim.disabled)
    }

    var body: some View {
        HStack(spacing: 6) {
            if halves.groups {
                half(compact ? "Group" : "New Group", icon: "folder", active: !onSplit, enabled: halves.group)
            }
            half(splitLabel, icon: "rectangle.split.2x1", active: onSplit, enabled: halves.splits)
        }
        .padding(Self.inset)
        .background(cover.opacity(Dim.overPicture), in: .rect(cornerRadius: WorkspaceSheet.cardCorner))
        .accessibilityElement(children: .combine)
    }
}
