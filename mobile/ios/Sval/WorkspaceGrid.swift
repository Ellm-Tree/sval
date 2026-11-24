// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Where a card held over another's middle would land: the card, what the
/// drop there does, and the halves it shows.
struct GridHover: Equatable {
    let id: String
    let over: DropOver
    let kind: DropKind
    let writes: Bool
    var halves: DropHalves?
}

/// The halves a card's middle shows while a card is held over it, read by
/// the cards as they draw.
@MainActor
@Observable
final class GridDropState {
    var hover: GridHover?
}

/// What the grid asks of the sheet.
struct GridActions {
    /// A tap on a card: open it, or tick it while editing.
    var open: (OutlineRow) -> Void
    var toggle: (OutlineRow) -> Void
    var close: (OutlineRow) -> Void
    var closeSplit: (OutlineRow, [OutlineRow]) -> Void
    var drop: (DropPlan) -> Void
    var tabMenu: (OutlineRow) -> UIMenu
    var splitMenu: (OutlineRow, [OutlineRow]) -> UIMenu
    var groupMenu: (OutlineRow) -> [[MenuItem]]
}

extension WorkspaceSheet {
    /// The Workspace's tree as cards (15b), in the system's collection view,
    /// which reorders by drag and drop.
    var grid: some View {
        VStack(spacing: 0) {
            if panel {
                PinsRow(onOpened: { close() }, tileSize: 48)
            }
            if let workspace {
                TabGrid(grid: TabGridView(
                    model: model, workspace: workspace.id, collapsed: collapsed, editing: editing,
                    selected: selected, scheme: scheme, tint: model.tint(of: workspace), sideways: panel,
                    dropState: gridDrop,
                    actions: gridActions))
            }
        }
        .onAppear {
            // The tab in front has been drawn since it was last left; its
            // card shows the page as it is now.
            if let id = browser.currentTabId { browser.takePreview(id) }
        }
        // A card held over a card, as a row held over a row in the list.
        .sensoryFeedback(.selection, trigger: gridDrop.hover.map { "\($0.id) \($0.kind)" })
    }

    private var gridActions: GridActions {
        GridActions(
            open: { row in
                if row.kind == .split {
                    guard !editing else { return }
                    let panes = model.children(of: row.id).filter { $0.kind == .tab }.map(\.id)
                    if let id = browser.focusedPane(of: row.id, among: panes) ?? panes.first {
                        browser.select(id)
                        close()
                    }
                    return
                }
                if editing {
                    if selected.contains(row.id) { selected.remove(row.id) } else { selected.insert(row.id) }
                    return
                }
                if Browser.openable(row) == nil, row.url != nil {
                    toasts.show(Toast(text: "Sval on \(UIDevice.current.model) can't open this tab", undo: { close(row) }, action: "Close Tab"))
                    return
                }
                browser.select(row.id)
                close()
            },
            toggle: { toggle($0) },
            close: { close($0) },
            closeSplit: { closeSplit($0, panes: $1) },
            drop: { plan in
                switch plan {
                case .ops(let ops): Task { await model.editTree(ops) }
                case .merge(let merge): look = .mergeGroup(merge)
                }
            },
            tabMenu: { row in uiTabMenu(row) },
            splitMenu: { split, panes in uiSplitMenu(split, panes: panes) },
            groupMenu: { groupMenu($0) })
    }

    // MARK: Menus

    // The collection view's own context menus, which the system pairs with
    // its drag: the same items as the list's SwiftUI menus.

    private func uiTabMenu(_ row: OutlineRow) -> UIMenu {
        UIMenu(sections: tabMenu(row, rename: { renameCard(row) }))
    }

    /// A split card's menu: 12e1's, for the pane the split last showed.
    private func uiSplitMenu(_ split: OutlineRow, panes: [OutlineRow]) -> UIMenu {
        let focus = browser.focusedPane(of: split.id, among: panes.map(\.id)) ?? panes[0].id
        let pane = panes.first { $0.id == focus } ?? panes[0]
        return UIMenu(sections: paneMenu(pane, split: split, panes: panes, rename: { renameCard(pane) }))
    }

    /// A row's, a card's or a split pane's rename, in the system's alert.
    func renameCard(_ row: OutlineRow) {
        renamingCard = row
    }
}

// MARK: The collection view

/// What the grid draws from: its sections, the ticks, and what every card
/// takes from the sheet.
struct GridState: Equatable {
    var sections: [TreeSection]
    var editing: Bool
    var ticked: Set<String>
    var look: GridLook
}

/// What every card and box is drawn with: the sheet's colours, whether it
/// is the sideways panel, and the text size the measures follow.
struct GridLook: Equatable {
    let scheme: ColorScheme
    let tint: String?
    let sideways: Bool
    let size: UIContentSizeCategory
}
