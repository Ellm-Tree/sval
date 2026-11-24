// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UniformTypeIdentifiers

/// Each drawn line's frame in the Workspace tree, and the tree's own.
final class TreeFrames {
    /// Each line's last frame. A List row's appearing and disappearing
    /// is no guide to whether it's on screen, so a frame is kept and
    /// checked against the tree's own.
    var rows: [String: CGRect] = [:]
    /// The tree's own frame, in screen space as the rows' are.
    var tree: CGRect = .zero
    /// When a drag last scrolled the tree.
    var scrolled = Date.distantPast

    /// The line's frame, when it lies inside the tree.
    /// Its sides are the tree's, inside the List's row insets, which every
    /// row spans.
    func shown(_ id: String) -> CGRect? {
        rows[id].flatMap { row in
            row.intersects(tree)
                ? CGRect(x: tree.minX + Self.inset, y: row.minY, width: tree.width - 2 * Self.inset, height: row.height)
                : nil
        }
    }

    /// The List's row inset on each side (`listRowInsets`).
    static let inset: CGFloat = 16
}

/// The line under a drag in the Workspace tree, and what a drop there
/// would do.
struct DropHover: Equatable {
    let entry: String
    let over: DropOver
    let kind: DropKind
    let depth: Int
    /// Whether a drop here writes anything.
    let writes: Bool
    /// Over a tab's or split's middle, both of its halves: whether a new
    /// group writes anything, and what the split half would do.
    var halves: DropHalves?
}

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

struct TreeDropDelegate: DropDelegate {
    let update: (CGPoint) -> Bool
    let exit: () -> Void
    let perform: () -> Bool

    func validateDrop(info: DropInfo) -> Bool {
        return info.hasItemsConforming(to: [.svalNode])
    }

    func dropEntered(info: DropInfo) { _ = update(info.location) }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        return DropProposal(operation: update(info.location) ? .move : .forbidden)
    }

    func dropExited(info: DropInfo) { exit() }

    func performDrop(info: DropInfo) -> Bool { perform() }
}

/// Where a dragged row lands in the list: a line, with a ring at its
/// start (`sval-drop-line`).
struct DropLine: View {
    let color: Color
    let background: Color

    var body: some View {
        HStack(spacing: 0) {
            Circle()
                .strokeBorder(color, lineWidth: 2)
                .background(background, in: .circle)
                .frame(width: 8, height: 8)
            Rectangle().fill(color).frame(height: 2)
        }
        .frame(height: 8)
    }
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
            Image(systemName: icon).font(.system(size: 15, weight: .semibold))
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
        .background(active && enabled ? color : .clear, in: .rect(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(enabled ? color : muted, style: StrokeStyle(lineWidth: 1.5, dash: enabled ? [] : [4, 3]))
        }
        .opacity(enabled ? 1 : 0.6)
    }

    var body: some View {
        HStack(spacing: 6) {
            if halves.groups {
                half(compact ? "Group" : "New Group", icon: "folder", active: !onSplit, enabled: halves.group)
            }
            half(splitLabel, icon: "rectangle.split.2x1", active: onSplit, enabled: halves.splits)
        }
        .padding(4)
        .background(cover.opacity(0.85), in: .rect(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }
}

/// Tells when a drag from the view is under way, and when it ends
/// wherever it's let go, on the systems that report its session.
struct DragSessionPhases: ViewModifier {
    let began: () -> Void
    let ended: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 27.0, *) {
            content.onDragSessionUpdated { session in
                switch session.phase {
                case .initial, .active: began()
                case .ended: ended()
                default: break
                }
            }
        } else {
            content
        }
    }
}
