// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Where a card held over another's middle would land: the card, what the
/// drop there does, and the halves it shows.
struct TreeHover: Equatable {
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
final class TreeDropState {
    var hover: TreeHover?
    /// Where the list's line between rows is, while a drag shows one.
    var line: String?
}

/// What the list and the grid ask of the sheet.
struct TreeActions {
    /// A tap on a card or row: open it, or tick it while editing.
    var open: (OutlineRow) -> Void
    var toggle: (OutlineRow) -> Void
    var close: (OutlineRow) -> Void
    var closeSplit: (OutlineRow, [OutlineRow]) -> Void
    /// Move to…, from a row's swipe.
    var move: (OutlineRow) -> Void
    var drop: (DropPlan) -> Void
    var tabMenu: (OutlineRow) -> UIMenu
    var splitMenu: (OutlineRow, [OutlineRow]) -> UIMenu
    var groupMenu: (OutlineRow) -> [[MenuItem]]
    /// A pane's menu in the list's tray: the pane, its split and the
    /// panes the line draws.
    var paneMenu: (OutlineRow, OutlineRow, [OutlineRow]) -> [[MenuItem]]
    /// A tap on a pane in a split's tray: opens the split at that pane,
    /// while editing too.
    var openPane: (String) -> Void
    /// Closes the sheet once a pin in the list's pins row opened.
    var pinOpened: () -> Void
}

extension WorkspaceSheet {
    /// The Workspace's tree as cards (15b), in the system's collection view,
    /// which reorders by drag and drop.
    var grid: some View {
        VStack(spacing: 0) {
            if panel {
                PinsRow(onOpened: { close() }, tileSize: 48)
            }
            treeView(.grid)
        }
        .onAppear {
            // The tab in front has been drawn since it was last left; its
            // card shows the page as it is now.
            if let id = browser.currentTabId { browser.takePreview(id) }
        }
        // A card held over a card, as a row held over a row in the list.
        .sensoryFeedback(.selection, trigger: treeDrop.hover.map { "\($0.id) \($0.kind)" })
    }

    /// The Workspace's tree as rows, in the same collection view as the
    /// grid, in list sections. In the sideways panel the pins scroll away
    /// with the rows (12f3).
    var list: some View {
        treeView(.list)
            .onAppear { revealFront() }
            .sensoryFeedback(.selection, trigger: treeDrop.hover.map { "\($0.id) \($0.kind)" } ?? treeDrop.line)
    }

    @ViewBuilder private func treeView(_ layout: TabLayout) -> some View {
        if let workspace {
            // The two rows of a merge waiting on its new group's name.
            let merging: Set<String> = if case .mergeGroup(let plan) = look { [plan.id, plan.target] } else { [] }
            FadedTree(tree: TreeView(
                model: model, workspace: workspace.id, layout: layout, collapsed: collapsed, editing: editing,
                selected: selected, marked: merging, scheme: scheme, tint: model.tint(of: workspace), sideways: panel,
                reduceMotion: reduceMotion, dropState: treeDrop, actions: treeActions))
        }
    }

    private var treeActions: TreeActions {
        TreeActions(
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
            move: { moving = $0 },
            drop: { plan in
                switch plan {
                case .ops(let ops): Task { await model.editTree(ops) }
                case .merge(let merge): look = .mergeGroup(merge)
                }
            },
            tabMenu: { row in uiTabMenu(row) },
            splitMenu: { split, panes in uiSplitMenu(split, panes: panes) },
            groupMenu: { groupMenu($0) },
            paneMenu: { pane, split, panes in paneMenu(pane, split: split, panes: panes, rename: { renameCard(pane) }) },
            openPane: { id in
                browser.select(id)
                close()
            },
            pinOpened: { close() })
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
struct TreeState: Equatable {
    var sections: [TreeSection]
    var editing: Bool
    var ticked: Set<String>
    var look: TreeLook
    /// The rows a merge waiting on its new group's name outlines.
    var marked: Set<String> = []
    /// The rows a drag in the list lifted, dimmed in place.
    var dimmed: Set<String> = []
}

/// What every card and box is drawn with: the sheet's colours, whether it
/// is the sideways panel, and the text size the measures follow.
struct TreeLook: Equatable {
    let scheme: ColorScheme
    let tint: String?
    let sideways: Bool
    let size: UIContentSizeCategory
}
