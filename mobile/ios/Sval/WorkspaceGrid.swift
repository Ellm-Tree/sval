// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// How the Workspace sheet draws the tree: rows, or cards with a picture of
/// each page (round 7). This phone's own; the desktop's sidebar has no grid.
enum TabLayout: String, CaseIterable {
    case list, grid
    static let key = "tabLayout"

    /// The choice as Settings and the Workspace sheet's menu offer it.
    var label: Label<Text, Image> {
        switch self {
        case .list: Label("List", systemImage: "list.bullet")
        case .grid: Label("Grid", systemImage: "square.grid.2x2")
        }
    }
}

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

/// A finger resting on a card's side: the side, where the rest began, and
/// since when.
struct EdgeRest: Equatable {
    let key: String
    let at: CGPoint
    let since: Date
}

/// Where a finger is in a card's cell: the room between the card and the
/// sheet's edge, the room between it and the next card, the card's outer
/// fifths, or its middle; and which half of each.
enum GridZone: Equatable {
    case edge(left: Bool)
    case crack(left: Bool)
    case side(left: Bool)
    case middle(left: Bool)
}

/// The grid's measures (15b, 15d, 15h).
enum GridMetrics {
    /// Room inside each cell for the ring of the tab in front, so the
    /// system's lift and menu previews, cut to the cell, keep it.
    static let ring: CGFloat = 5
    static let columnGap: CGFloat = 11 - 2 * ring
    static let rowGap: CGFloat = 14 - 2 * ring
    /// The room a cell keeps above and below its card: the ring's, and
    /// half the gap to the next row. The rows meet with no space between
    /// them, so a finger between two rows is over a cell, where the system
    /// has a place to open a gap.
    static let padY = ring + rowGap / 2
    /// The sheet's edge to a box's edge, and each level's step inward.
    static let edge: CGFloat = 12
    static let nest: CGFloat = 8
    /// A group's header, and the box's room above it and below its cards.
    /// The header grows with its name's text.
    static var header: CGFloat { ceil(UIFont.preferredFont(forTextStyle: .body).lineHeight) + 22 }
    static var nestedHeader: CGFloat { ceil(UIFont.preferredFont(forTextStyle: .subheadline).lineHeight) + 20 }
    /// The bar over the top of a card's picture, which grows with its
    /// title's text.
    static var bar: CGFloat { ceil(UIFont.preferredFont(forTextStyle: .subheadline).lineHeight) + 12 }
    /// Cards across: two, or one at the accessibility text sizes, where
    /// half the sheet's width holds a few letters of a title.
    static var columns: Int { UIApplication.shared.preferredContentSizeCategory.isAccessibilityCategory ? 1 : 2 }
    static let boxTop: CGFloat = 2
    static let boxBottom: CGFloat = 10
    /// The part of a card at each side that drops before or after it, a
    /// fifth of its width; the three fifths between are the middle (15f2).
    static func side(_ width: CGFloat) -> CGFloat { width / 5 }

    /// How far a card sits in from its cell's sides in `column` of
    /// `columns`, leading and trailing. The cells split the grid's whole
    /// width evenly, so the margin beside a card is over its cell. Toward
    /// the sheet's edge, a card keeps the margin to every box around it;
    /// toward the next column, the ring's room and half the gap.
    static func insets(layers: Int, column: Int, columns: Int) -> (leading: CGFloat, trailing: CGFloat) {
        let outer = edge + CGFloat(layers) * nest
        let inner = ring + columnGap / 2
        return (column == 0 ? outer : inner, column == columns - 1 ? outer : inner)
    }

    /// The zone of a cell that `point` is in, given the cell's `card` and
    /// which of the cell's sides face the sheet's edge.
    static func zone(_ point: CGPoint, card: CGRect, outer: (left: Bool, right: Bool)) -> GridZone {
        guard card.contains(point) else {
            if point.x < card.minX, outer.left { return .edge(left: true) }
            if point.x >= card.maxX, outer.right { return .edge(left: false) }
            return .crack(left: point.x < card.midX)
        }
        let side = side(card.width)
        if point.x < card.minX + side { return .side(left: true) }
        if point.x >= card.maxX - side { return .side(left: false) }
        return .middle(left: point.x < card.midX)
    }

    /// Where `point` falls in the middle of `card`, over the card's whole
    /// height: how far across the middle, the middle's width and the
    /// card's height. A `latched` card's middle takes the whole cell,
    /// drawn in to the middle's nearest point.
    static func middle(_ point: CGPoint, card: CGRect, latched: Bool = false) -> (x: CGFloat, span: CGFloat, picture: CGFloat)? {
        let side = side(card.width)
        let span = card.width - 2 * side
        var x = point.x - card.minX - side
        if latched {
            x = min(max(x, 0), span)
        } else {
            guard card.contains(point), x >= 0, x < span else { return nil }
        }
        return (x, span, card.height)
    }

    /// The card whose halves stay up: `latched` while the finger is over
    /// that card's cell, which keeps every part of the cell in the
    /// halves, and none once the finger leaves it or reaches the room
    /// toward the sheet's edge, which is off the card.
    static func latch(_ latched: String?, over: String?, zone: GridZone) -> String? {
        if case .edge = zone { return nil }
        return latched == over ? latched : nil
    }

    /// How long a finger rests still in `zone` before the gap opens: off
    /// the card, which offers nothing else, at once; a card's side, long
    /// enough to pass through on the way to the middle.
    static func restTime(_ zone: GridZone) -> TimeInterval {
        switch zone {
        case .edge, .crack: 0.1
        case .side, .middle: 0.25
        }
    }

    /// How far a finger may drift on a card's side and still rest there.
    /// A finger crossing the side on its way to the middle leaves this
    /// radius, so its rest starts over and never completes.
    static let restDrift: CGFloat = 10

    /// The rest on the card side `key` once the finger is at `point`:
    /// `rest` while the finger stays on that side within `restDrift` of
    /// where `rest` began, or a rest beginning `now` at `point`.
    static func rest(_ rest: EdgeRest?, key: String, at point: CGPoint, now: Date) -> EdgeRest {
        if let rest, rest.key == key, hypot(point.x - rest.at.x, point.y - rest.at.y) <= restDrift { return rest }
        return EdgeRest(key: key, at: point, since: now)
    }

    /// A card's picture height at `depth` groups in: 140, 132, 124, and on
    /// in 8pt steps, or 104, 96, 90 sideways, where the page is wide.
    static func picture(depth: Int, sideways: Bool) -> CGFloat {
        if sideways { return [104, 96, 90][min(depth, 2)] - CGFloat(max(depth - 2, 0)) * 6 }
        return max(140 - CGFloat(depth) * 8, 80)
    }

    /// A cell's height: the picture, which carries the bar, and the
    /// cell's room above and below.
    static func cell(depth: Int, sideways: Bool) -> CGFloat {
        picture(depth: depth, sideways: sideways) + 2 * padY
    }
}

/// A card's cell. The card sits in from the cell's sides by its column's
/// insets, set from the cell's frame as each frame is applied, so a card
/// the system moves to the other column takes that column's insets in the
/// same animation.
final class GridCell: UICollectionViewCell {
    /// The groups around the card, and the columns across.
    var layers = 0
    var columns = 2
    private var column = 0

    private var insets: (leading: CGFloat, trailing: CGFloat) {
        GridMetrics.insets(layers: layers, column: column, columns: columns)
    }

    /// The card in the cell's bounds.
    var card: CGRect {
        let insets = insets
        return CGRect(x: insets.leading, y: GridMetrics.padY, width: bounds.width - insets.leading - insets.trailing,
                      height: bounds.height - 2 * GridMetrics.padY)
    }

    /// Which of the cell's sides face the sheet's edge.
    var outer: (left: Bool, right: Bool) { (column == 0, column == columns - 1) }

    override func apply(_ attributes: UICollectionViewLayoutAttributes) {
        super.apply(attributes)
        place(attributes.frame)
    }

    /// The content ends at the card's ring, so its width is the card's
    /// own; it starts at the first column's leading inset, moved to the
    /// card.
    override func layoutSubviews() {
        super.layoutSubviews()
        let leading = GridMetrics.insets(layers: layers, column: 0, columns: columns).leading
        let card = card
        contentView.frame = CGRect(x: card.minX - leading, y: 0, width: leading + card.width + GridMetrics.ring,
                                   height: bounds.height)
    }

    /// Takes the insets of the column `frame` is in. Within the system's
    /// animation of the cell's frame, the move is part of it.
    func place(_ frame: CGRect) {
        column = frame.minX > 1 && columns > 1 ? 1 : 0
        setNeedsLayout()
        layoutIfNeeded()
    }
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

/// What a new `GridState` asks of the collection view: a new snapshot
/// where cards or sections came, went or moved; the cards and headers whose
/// own facts changed; and a new layout where a section's shape changed. A
/// change to a row's content alone asks for nothing: each card and header
/// reads its row's `RowBox`.
struct GridUpdate: Equatable {
    var apply = false
    var reconfigure: [String] = []
    var headers: [String] = []
    var relayout = false

    static func between(_ old: GridState?, _ new: GridState) -> GridUpdate {
        var update = GridUpdate()
        guard let old else {
            update.apply = true
            return update
        }
        update.apply = old.sections.map(\.id) != new.sections.map(\.id)
            || old.sections.map(\.items) != new.sections.map(\.items)
        let looks = old.look != new.look
        let before = Dictionary(old.sections.flatMap(\.lines).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for line in new.sections.flatMap(\.lines) {
            guard let was = before[line.id] else { continue }
            if looks || old.editing != new.editing || was != line
                || old.ticked.contains(line.id) != new.ticked.contains(line.id) {
                update.reconfigure.append(line.id)
            }
        }
        update.relayout = looks || old.sections.map(\.layout) != new.sections.map(\.layout)
        let headers = Dictionary(old.sections.map { ($0.id, $0.header) }, uniquingKeysWith: { a, _ in a })
        for section in new.sections where section.header != nil {
            if let was = headers[section.id], looks || was != section.header { update.headers.append(section.id) }
        }
        return update
    }
}

/// Which of the grid's edges have more cards to scroll to.
@MainActor
@Observable
final class GridEdges {
    var before = false
    var after = false
}

/// The grid, faded at an edge with more to scroll to, as the list is
/// (`ScrollEdgeFade`).
struct TabGrid: View {
    let grid: TabGridView
    @State private var edges = GridEdges()

    var body: some View {
        grid.edges(edges).edgeFade(.vertical, before: edges.before, after: edges.after)
    }
}

/// The grid: the system's collection view, with its compositional layout,
/// diffable data source, drag and drop and context menus. The cards and
/// group headers are SwiftUI views in its cells; the group boxes are the
/// sections' background decorations.
struct TabGridView: UIViewRepresentable {
    let model: AppModel
    let workspace: String
    let collapsed: Set<String>
    let editing: Bool
    let selected: Set<String>
    let scheme: ColorScheme
    let tint: String?
    let sideways: Bool
    let dropState: GridDropState
    let actions: GridActions
    /// Where the grid reports which edges have more to scroll to.
    var reportsEdges: GridEdges?

    func edges(_ edges: GridEdges) -> TabGridView {
        var grid = self
        grid.reportsEdges = edges
        return grid
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UICollectionView {
        context.coordinator.make(self)
    }

    func updateUIView(_ view: UICollectionView, context: Context) {
        context.coordinator.update(self)
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDelegate, UICollectionViewDragDelegate,
        UICollectionViewDropDelegate, UIGestureRecognizerDelegate {
        private var parent: TabGridView!
        private var state: GridState?
        /// Each card's line, by id, as `state` holds it.
        private var lines: [String: TreeLine] = [:]
        private var theme = Theme(.light)
        private var dataSource: UICollectionViewDiffableDataSource<String, String>!
        private weak var view: UICollectionView?
        private var scrolledToFront = false
        private var registered: Set<String> = []
        /// Where the card would land at the gap last opened. While a card
        /// is held, the system moves it into the gap, so the finger rests
        /// over the card itself, which keeps that landing.
        private var lastLanding: (DropOver, DropKind)?
        /// The card side the finger rests on, where and since when.
        private var edge: EdgeRest?
        /// The card showing its halves until the finger leaves its cell.
        private var latched: String?
        /// Where the card lands with the finger off every card: the end
        /// of the group or Workspace around the finger.
        private var placed: (DropOver, DropKind)?
        /// The card a sideways swipe holds, and the card flying off as it
        /// closes, which stays off until the tree drops it.
        private var swiped: (id: String, cell: UICollectionViewCell)?
        private var closing: String?

        private var sections: [TreeSection] { state?.sections ?? [] }

        func make(_ parent: TabGridView) -> UICollectionView {
            self.parent = parent
            let layout = UICollectionViewCompositionalLayout { [weak self] index, _ in
                self?.layout(section: index)
            }
            let view = GridCollectionView(frame: .zero, collectionViewLayout: layout)
            // Each layout pass, a scroll's included, says which edges have
            // more to scroll to.
            view.laidOut = { [weak self] view in self?.reportEdges(view) }
            view.backgroundColor = .clear
            view.delegate = self
            view.dragDelegate = self
            view.dropDelegate = self
            view.dragInteractionEnabled = true
            view.contentInset.top = 6
            self.view = view
            // A sideways swipe closes a card. The scroll waits on it, which
            // fails at once on an upright drag.
            let swipe = UIPanGestureRecognizer(target: self, action: #selector(swipe(_:)))
            swipe.delegate = self
            view.addGestureRecognizer(swipe)
            view.panGestureRecognizer.require(toFail: swipe)

            let card = UICollectionView.CellRegistration<GridCell, String> { [weak self] cell, _, id in
                self?.configure(cell, id: id)
            }
            dataSource = UICollectionViewDiffableDataSource(collectionView: view) { view, index, id in
                view.dequeueConfiguredReusableCell(using: card, for: index, item: id)
            }
            let header = UICollectionView.SupplementaryRegistration<UICollectionViewCell>(
                elementKind: UICollectionView.elementKindSectionHeader
            ) { [weak self] cell, _, index in
                self?.configureHeader(cell, section: index.section)
            }
            dataSource.supplementaryViewProvider = { view, _, index in
                view.dequeueConfiguredReusableSupplementary(using: header, for: index)
            }
            update(parent)
            return view
        }

        /// Draws the grid from the tree as it is: a card or header whose
        /// own facts changed is configured again, and the rest are left.
        @discardableResult
        func update(_ parent: TabGridView) -> GridUpdate {
            self.parent = parent
            let look = GridLook(scheme: parent.scheme, tint: parent.tint, sideways: parent.sideways,
                                size: UIApplication.shared.preferredContentSizeCategory)
            let new = GridState(sections: TreeLines.grid(parent.model.tree, workspace: parent.workspace,
                                                         collapsed: parent.collapsed),
                                editing: parent.editing, ticked: parent.selected, look: look)
            let update = GridUpdate.between(state, new)
            theme = Theme(parent.scheme, tint: parent.tint)
            GridBox.theme = theme
            state = new
            lines = Dictionary(new.sections.flatMap(\.lines).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            if let closing, lines[closing] == nil { self.closing = nil }
            if update.apply || !update.reconfigure.isEmpty {
                var snapshot: NSDiffableDataSourceSnapshot<String, String>
                if update.apply {
                    snapshot = NSDiffableDataSourceSnapshot()
                    for section in new.sections {
                        snapshot.appendSections([section.id])
                        snapshot.appendItems(section.items, toSection: section.id)
                    }
                } else {
                    snapshot = dataSource.snapshot()
                }
                snapshot.reconfigureItems(update.reconfigure)
                dataSource.apply(snapshot, animatingDifferences: false)
            }
            // The headers and boxes follow the sections, which the
            // snapshot doesn't carry.
            if update.relayout { view?.collectionViewLayout.invalidateLayout() }
            for id in update.headers {
                guard let section = new.sections.firstIndex(where: { $0.id == id }) else { continue }
                let path = IndexPath(item: 0, section: section)
                if let header = view?.supplementaryView(forElementKind: UICollectionView.elementKindSectionHeader, at: path)
                    as? UICollectionViewCell {
                    configureHeader(header, section: section)
                }
            }
            if !scrolledToFront, let front = parent.model.browser.currentTabId, let path = indexPath(holding: front) {
                scrolledToFront = true
                DispatchQueue.main.async { [weak self] in
                    self?.view?.scrollToItem(at: path, at: .centeredVertically, animated: false)
                }
            }
            return update
        }

        private func reportEdges(_ view: UICollectionView) {
            guard let edges = parent.reportsEdges else { return }
            let inset = view.adjustedContentInset
            let more = EdgeFade.edges(offset: view.contentOffset.y + inset.top,
                                      size: view.contentSize.height + inset.top + inset.bottom, room: view.bounds.height)
            if edges.before != more[0] { edges.before = more[0] }
            if edges.after != more[1] { edges.after = more[1] }
        }

        private func indexPath(holding id: String) -> IndexPath? {
            let model = parent.model
            let split = model.row(id)?.parentId.flatMap(model.row).flatMap { $0.kind == .split ? $0.id : nil }
            for (s, section) in sections.enumerated() {
                if let i = section.items.firstIndex(where: { $0 == id || $0 == split }) {
                    return IndexPath(item: i, section: s)
                }
            }
            return nil
        }

        // MARK: Layout

        private func layout(section index: Int) -> NSCollectionLayoutSection? {
            guard sections.indices.contains(index) else { return nil }
            let section = sections[index]
            let height = GridMetrics.cell(depth: section.depth, sideways: parent.sideways)
            let columns = GridMetrics.columns
            let item = NSCollectionLayoutItem(layoutSize: .init(widthDimension: .fractionalWidth(1 / CGFloat(columns)),
                                                                heightDimension: .absolute(height)))
            let row = NSCollectionLayoutGroup.horizontal(
                layoutSize: .init(widthDimension: .fractionalWidth(1), heightDimension: .absolute(height)),
                repeatingSubitem: item, count: columns)
            let layout = NSCollectionLayoutSection(group: row)
            let gap = GridMetrics.padY - GridMetrics.ring
            let closes = section.layers.filter(\.bottom).count
            // A box holding only its header, a collapsed group's, keeps the
            // header's room above it below it too, so the header sits in
            // the middle.
            let headerOnly = section.header != nil && section.items.isEmpty && section.layers.last?.bottom == true
            let room = CGFloat(closes) * GridMetrics.boxBottom - (headerOnly ? GridMetrics.boxBottom - GridMetrics.boxTop : 0)
            layout.contentInsets = NSDirectionalEdgeInsets(
                top: (section.layers.isEmpty ? GridMetrics.rowGap : 0) - gap, leading: 0,
                bottom: room + (closes > 0 ? GridMetrics.rowGap : 0) - gap, trailing: 0)
            if section.header != nil {
                let nested = section.layers.count > 1
                let size = NSCollectionLayoutSize(
                    widthDimension: .fractionalWidth(1),
                    heightDimension: .absolute((nested ? GridMetrics.nestedHeader : GridMetrics.header) + GridMetrics.boxTop))
                let header = NSCollectionLayoutBoundarySupplementaryItem(
                    layoutSize: size, elementKind: UICollectionView.elementKindSectionHeader, alignment: .top)
                let inset = GridMetrics.edge + CGFloat(section.layers.count - 1) * GridMetrics.nest
                header.contentInsets = NSDirectionalEdgeInsets(top: GridMetrics.boxTop, leading: inset, bottom: 0, trailing: inset)
                layout.boundarySupplementaryItems = [header]
                layout.supplementaryContentInsetsReference = .none
            }
            if !section.layers.isEmpty {
                let kind = GridBox.kind(section.layers)
                if !registered.contains(kind) {
                    registered.insert(kind)
                    view?.collectionViewLayout.register(GridBox.self, forDecorationViewOfKind: kind)
                }
                layout.decorationItems = [NSCollectionLayoutDecorationItem.background(elementKind: kind)]
            }
            return layout
        }

        // MARK: Cells

        private func configure(_ cell: GridCell, id: String) {
            guard let line = lines[id], let box = parent.model.treeStore.box(id), let state else { return }
            if id != closing, id != swiped?.id {
                cell.transform = .identity
                cell.alpha = 1
            }
            cell.layers = line.depth
            cell.columns = GridMetrics.columns
            let leading = GridMetrics.insets(layers: cell.layers, column: 0, columns: cell.columns).leading - GridMetrics.ring
            let height = GridMetrics.picture(depth: line.depth, sideways: state.look.sideways)
            let model = parent.model, theme = theme, dropState = parent.dropState, editing = state.editing
            if let panes = line.panes {
                let boxes = panes.compactMap(model.treeStore.box)
                cell.contentConfiguration = UIHostingConfiguration {
                    GridSplitCard(model: model, split: box, panes: boxes, height: height, theme: theme,
                                  editing: editing, dropState: dropState,
                                  onClose: { [weak self] in self?.close(id) })
                }
                .margins(.leading, leading)
                .margins(.trailing, 0)
                .margins(.vertical, GridMetrics.padY - GridMetrics.ring)
            } else {
                let ticked = state.ticked.contains(id)
                cell.contentConfiguration = UIHostingConfiguration {
                    GridCard(model: model, box: box, height: height, theme: theme,
                             editing: editing, ticked: ticked,
                             dropState: dropState, onClose: { [weak self] in self?.close(id) })
                }
                .margins(.leading, leading)
                .margins(.trailing, 0)
                .margins(.vertical, GridMetrics.padY - GridMetrics.ring)
            }
            // The configuration's content view takes the card's place.
            cell.place(cell.frame)
        }

        private func configureHeader(_ cell: UICollectionViewCell, section index: Int) {
            guard sections.indices.contains(index), let header = sections[index].header,
                  let box = parent.model.treeStore.box(header.id) else {
                cell.contentConfiguration = nil
                return
            }
            let theme = theme
            let icons = header.icons.compactMap(parent.model.treeStore.box)
            cell.contentConfiguration = UIHostingConfiguration {
                GridGroupHeader(box: box, header: header, icons: icons, theme: theme,
                                onToggle: { [weak self] in self?.act(on: header.id) { $0.toggle($1) } },
                                menu: { [weak self] in self?.parent.actions.groupMenu($0) ?? [] })
            }
            .margins(.all, 0)
        }

        /// Runs `action` on the row `id` as the tree holds it now: a cell
        /// keeps its closures while its row's content changes.
        private func act(on id: String, _ action: (GridActions, OutlineRow) -> Void) {
            guard let row = parent.model.row(id) else { return }
            action(parent.actions, row)
        }

        private func close(_ id: String) {
            let model = parent.model
            act(on: id) { actions, row in
                if row.kind == .split {
                    actions.closeSplit(row, model.children(of: row.id).filter { $0.kind == .tab })
                } else {
                    actions.close(row)
                }
            }
        }

        // MARK: Swipe to close

        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard let pan = gesture as? UIPanGestureRecognizer, let view else { return false }
            let velocity = pan.velocity(in: view)
            guard abs(velocity.x) > abs(velocity.y) * 1.5,
                  let path = view.indexPathForItem(at: pan.location(in: view)),
                  let id = dataSource.itemIdentifier(for: path), let cell = view.cellForItem(at: path) else { return false }
            swiped = (id, cell)
            return true
        }

        @objc private func swipe(_ pan: UIPanGestureRecognizer) {
            guard let view, let (id, cell) = swiped else { return }
            let dx = pan.translation(in: view).x
            let width = cell.bounds.width
            switch pan.state {
            case .changed:
                cell.transform = CGAffineTransform(translationX: dx, y: 0)
                cell.alpha = 1 - min(abs(dx) / width, 1) * 0.7
            case .ended, .cancelled, .failed:
                swiped = nil
                let vx = pan.velocity(in: view).x
                let flung = abs(vx) > 800 && (vx > 0) == (dx > 0)
                guard pan.state == .ended, abs(dx) > width * 0.4 || flung, parent.model.row(id) != nil else {
                    UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0) {
                        cell.transform = .identity
                        cell.alpha = 1
                    }
                    return
                }
                closing = id
                let off = (dx > 0 ? 1 : -1) * (view.bounds.width)
                UIView.animate(withDuration: 0.2, delay: 0, options: .curveEaseOut) {
                    cell.transform = CGAffineTransform(translationX: off, y: 0)
                    cell.alpha = 0
                } completion: { [weak self] _ in
                    self?.close(id)
                }
            default:
                break
            }
        }

        // MARK: Taps and menus

        func collectionView(_ view: UICollectionView, didSelectItemAt path: IndexPath) {
            view.deselectItem(at: path, animated: false)
            guard let id = dataSource.itemIdentifier(for: path), let row = parent.model.row(id) else { return }
            parent.actions.open(row)
        }

        func collectionView(_ view: UICollectionView, contextMenuConfigurationForItemsAt paths: [IndexPath],
                            point: CGPoint) -> UIContextMenuConfiguration? {
            // While editing, a press picks a card up at once, with no menu.
            guard !parent.editing, paths.count == 1, let id = dataSource.itemIdentifier(for: paths[0]),
                  let row = parent.model.row(id) else { return nil }
            let actions = parent.actions
            let model = parent.model
            return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in
                if row.kind == .split {
                    return actions.splitMenu(row, model.children(of: row.id).filter { $0.kind == .tab })
                }
                return actions.tabMenu(row)
            }
        }

        // MARK: Drag and drop

        /// A card moves at any time, as a row in the list does. Outside
        /// Edit Tabs a press that holds still opens the card's menu, and
        /// moving the finger lifts the card from it.
        func collectionView(_ view: UICollectionView, itemsForBeginning session: UIDragSession,
                            at path: IndexPath) -> [UIDragItem] {
            guard let id = dataSource.itemIdentifier(for: path) else { return [] }
            let provider = NSItemProvider()
            provider.registerDataRepresentation(forTypeIdentifier: UTType.svalNode.identifier, visibility: .ownProcess) { done in
                done(Data(id.utf8), nil)
                return nil
            }
            let item = UIDragItem(itemProvider: provider)
            item.localObject = id
            return [item]
        }

        /// The lifted card's outline: the card's own rounded shape, where
        /// the system would draw the cell's square bounds.
        func collectionView(_ view: UICollectionView, dragPreviewParametersForItemAt path: IndexPath) -> UIDragPreviewParameters? {
            preview(at: path, in: view)
        }

        func collectionView(_ view: UICollectionView, dropPreviewParametersForItemAt path: IndexPath) -> UIDragPreviewParameters? {
            preview(at: path, in: view)
        }

        private func preview(at path: IndexPath, in view: UICollectionView) -> UIDragPreviewParameters? {
            guard let cell = view.cellForItem(at: path) as? GridCell else { return nil }
            let parameters = UIDragPreviewParameters()
            let room = cell.card.insetBy(dx: -GridMetrics.ring, dy: -GridMetrics.ring)
            parameters.visiblePath = UIBezierPath(roundedRect: room, cornerRadius: 14 + GridMetrics.ring)
            parameters.backgroundColor = .clear
            return parameters
        }

        func collectionView(_ view: UICollectionView, canHandle session: UIDropSession) -> Bool {
            dragged(session) != nil
        }

        /// Over a card's middle, the drop goes into it, as a new group or a
        /// split, and the card shows its halves; anywhere else the system
        /// opens a gap where the card will land.
        func collectionView(_ view: UICollectionView, dropSessionDidUpdate session: UIDropSession,
                            withDestinationIndexPath path: IndexPath?) -> UICollectionViewDropProposal {
            guard let id = dragged(session) else { return UICollectionViewDropProposal(operation: .cancel) }
            let point = session.location(in: view)
            let overPath = view.indexPathForItem(at: point)
            if let over = overPath, let overId = dataSource.itemIdentifier(for: over), overId != id,
               let cell = view.cellForItem(at: over) as? GridCell {
                let at = cell.convert(point, from: view)
                let zone = GridMetrics.zone(at, card: cell.card, outer: cell.outer)
                latched = GridMetrics.latch(latched, over: overId, zone: zone)
                if let hover = middle(of: overId, cell: cell, at: point, in: view, dragged: id, latched: latched != nil) {
                    #if DEBUG
                    if parent.dropState.hover?.id != hover.id { Diagnostics.log("grid drop: on a card's middle, \(hover.kind)") }
                    #endif
                    // Once a card shows its halves it keeps them until the
                    // finger leaves its cell, so the card can't move from
                    // under a finger drifting toward its side.
                    latched = overId
                    edge = nil
                    if parent.dropState.hover != hover { parent.dropState.hover = hover }
                    return UICollectionViewDropProposal(operation: hover.writes ? .move : .forbidden,
                                                        intent: .insertIntoDestinationIndexPath)
                }
                // On a card's side, or in the room around it, the gap
                // opens only once the finger rests still there: opening it
                // at once moves the card from under a finger on its way to
                // the card's middle.
                if parent.dropState.hover != nil { parent.dropState.hover = nil }
                let key = "\(overId) \(at.x < cell.bounds.midX)"
                let now = Date.now
                let rest = GridMetrics.rest(edge, key: key, at: point, now: now)
                #if DEBUG
                if rest.key != edge?.key { Diagnostics.log("grid drop: on a card's side") }
                #endif
                edge = rest
                if now.timeIntervalSince(rest.since) < GridMetrics.restTime(zone) {
                    return UICollectionViewDropProposal(operation: .move, intent: .unspecified)
                }
            } else {
                edge = nil
                latched = nil
            }
            if parent.dropState.hover != nil { parent.dropState.hover = nil }
            placed = overPath == nil ? empty(at: point, in: view, dragged: id) : nil
            if placed != nil { return UICollectionViewDropProposal(operation: .move, intent: .unspecified) }
            guard let path else { return UICollectionViewDropProposal(operation: .forbidden) }
            if dataSource.itemIdentifier(for: path) == id, lastLanding != nil {
                return UICollectionViewDropProposal(operation: .move, intent: .insertAtDestinationIndexPath)
            }
            guard let landing = landing(at: path, dragged: id) else {
                lastLanding = nil
                return UICollectionViewDropProposal(operation: .forbidden)
            }
            lastLanding = landing
            return UICollectionViewDropProposal(operation: .move, intent: .insertAtDestinationIndexPath)
        }

        func collectionView(_ view: UICollectionView, dropSessionDidExit session: UIDropSession) {
            parent.dropState.hover = nil
        }

        func collectionView(_ view: UICollectionView, dropSessionDidEnd session: UIDropSession) {
            parent.dropState.hover = nil
            lastLanding = nil
            edge = nil
            latched = nil
            placed = nil
        }

        func collectionView(_ view: UICollectionView, performDropWith coordinator: UICollectionViewDropCoordinator) {
            defer { parent.dropState.hover = nil }
            let model = parent.model
            if let (over, kind) = placed, let id = dragged(coordinator.session),
               let plan = model.dropPlan(id, over: over, kind) {
                Diagnostics.log("sheet: dropped in the grid off the cards, \(kind)")
                if let item = coordinator.items.first, let path = moveAhead(id, over: over, kind) {
                    coordinator.drop(item.dragItem, toItemAt: path)
                }
                parent.actions.drop(plan)
                return
            }
            guard let id = dragged(coordinator.session), let item = coordinator.items.first,
                  let path = coordinator.destinationIndexPath else { return }
            if coordinator.proposal.intent == .unspecified { return }
            if coordinator.proposal.intent == .insertIntoDestinationIndexPath {
                guard let hover = parent.dropState.hover, let plan = model.dropPlan(id, over: hover.over, hover.kind),
                      let cell = view.cellForItem(at: path) as? GridCell else { return }
                Diagnostics.log("sheet: dropped in the grid, \(hover.kind)")
                let room = cell.card.insetBy(dx: -GridMetrics.ring, dy: -GridMetrics.ring)
                coordinator.drop(item.dragItem, intoItemAt: path, rect: room)
                parent.actions.drop(plan)
                return
            }
            let held = dataSource.itemIdentifier(for: path) == id ? lastLanding : nil
            guard let (over, kind) = held ?? landing(at: path, dragged: id),
                  let plan = model.dropPlan(id, over: over, kind) else { return }
            Diagnostics.log("sheet: dropped in the grid, \(kind)")
            coordinator.drop(item.dragItem, toItemAt: moveAhead(id, over: over, kind) ?? path)
            parent.actions.drop(plan)
        }

        /// Moves the dropped card to where it lands in the grid at once, and
        /// gives its place. The tree's edit is written after, and the grid
        /// drawn from it then matches: without the move, the system puts
        /// the card back until that edit arrives. Nil where the landing
        /// opens a section the grid doesn't have yet.
        private func moveAhead(_ id: String, over: DropOver, _ kind: DropKind) -> IndexPath? {
            var snapshot = dataSource.snapshot()
            let items = Set(snapshot.itemIdentifiers)
            guard items.contains(id) else { return nil }
            /// The last section `container` holds directly.
            func lastSection(of container: String) -> String? {
                sections.last { $0.container == container }?.id
            }
            switch kind {
            case .before where items.contains(over.id) && over.id != id:
                snapshot.moveItem(id, beforeItem: over.id)
            case .after where items.contains(over.id) && over.id != id:
                snapshot.moveItem(id, afterItem: over.id)
            case .after:
                // After a group: the start of the section that follows the
                // group's own, in the group's parent.
                guard let last = sections.lastIndex(where: { $0.groups.contains(over.id) }),
                      let parentId = parent.model.row(over.id)?.parentId,
                      last + 1 < sections.count, sections[last + 1].container == parentId else { return nil }
                if let first = sections[last + 1].items.first(where: { $0 != id }) {
                    snapshot.moveItem(id, beforeItem: first)
                } else {
                    snapshot.deleteItems([id])
                    snapshot.appendItems([id], toSection: sections[last + 1].id)
                }
            case .into, .end:
                guard let section = lastSection(of: over.id) else { return nil }
                snapshot.deleteItems([id])
                snapshot.appendItems([id], toSection: section)
            default:
                return nil
            }
            // The moved sections stand as the grid's state, so the tree's
            // edit, once it arrives, finds the grid already drawn.
            for index in sections.indices {
                let items = snapshot.itemIdentifiers(inSection: sections[index].id)
                state?.sections[index].lines = items.compactMap { lines[$0] }
            }
            dataSource.apply(snapshot, animatingDifferences: true)
            return dataSource.indexPath(for: id)
        }

        private func dragged(_ session: UIDropSession) -> String? {
            session.localDragSession?.items.first?.localObject as? String
        }

        /// The halves under the finger, when it's over a card's middle, or
        /// anywhere in the cell of a `latched` card (15f2).
        private func middle(of id: String, cell: GridCell, at point: CGPoint, in view: UICollectionView,
                            dragged: String, latched: Bool) -> GridHover? {
            guard let row = parent.model.row(id) else { return nil }
            guard let (x, span, picture) = GridMetrics.middle(cell.convert(point, from: view), card: cell.card,
                                                              latched: latched)
            else { return nil }
            let model = parent.model
            let over = DropOver(id: id, kind: row.kind, expanded: false)
            let kind = model.dropIntent(dragged, over: over, x: x, y: picture / 2, w: span, h: picture)
            guard [DropKind.newGroup, .split, .join, .merge, .refused(full: true)].contains(kind) else { return nil }
            let split = model.dropIntent(dragged, over: over, x: span - 1, y: picture / 2, w: span, h: picture)
            var hover = GridHover(id: id, over: over, kind: kind, writes: model.dropPlan(dragged, over: over, kind) != nil)
            hover.halves = DropHalves(groups: model.makesGroups(in: parent.workspace),
                                      group: model.dropPlan(dragged, over: over, .newGroup) != nil, split: split,
                                      splits: model.dropPlan(dragged, over: over, split) != nil)
            return hover
        }

        /// Whether `point` is below the last card.
        private func below(_ point: CGPoint, in view: UICollectionView) -> Bool {
            guard let section = sections.indices.last(where: { !sections[$0].items.isEmpty }),
                  let last = view.layoutAttributesForItem(
                      at: IndexPath(item: sections[section].items.count - 1, section: section))
            else { return false }
            return point.y > last.frame.maxY
        }

        /// Where a card lands let go off every card: below them all, at
        /// the Workspace's end; in a group's box, after the last card of
        /// the row of cards the finger is beside, or at the group's end;
        /// and the same outside every box, in the Workspace.
        private func empty(at point: CGPoint, in view: UICollectionView, dragged id: String) -> (DropOver, DropKind)? {
            let model = parent.model
            func row(_ id: String) -> DropOver {
                DropOver(id: id, kind: model.row(id)?.kind ?? .tab, expanded: false)
            }
            func valid(_ landing: (DropOver, DropKind)) -> (DropOver, DropKind)? {
                model.dropPlan(id, over: landing.0, landing.1) == nil ? nil : landing
            }
            func end(of container: String) -> (DropOver, DropKind)? {
                if let last = model.children(of: container).last(where: { $0.id != id }) {
                    return valid((row(last.id), .after))
                }
                return container == parent.workspace
                    ? valid((DropOver(id: container, kind: .workspace, expanded: true), .end))
                    : valid((DropOver(id: container, kind: .group, expanded: false), .into))
            }
            if below(point, in: view) { return end(of: parent.workspace) }
            guard let index = section(at: point.y, in: view) else { return nil }
            let section = sections[index]
            // The innermost box around the finger; each level's box is
            // inset a step further.
            var level = -1
            for i in section.groups.indices {
                let inset = GridMetrics.edge + CGFloat(i) * GridMetrics.nest
                guard point.x >= inset, point.x <= view.bounds.width - inset else { break }
                level = i
            }
            let container = level < 0 ? parent.workspace : section.groups[level]
            if container == section.container, let last = section.items.last(where: { $0 != id }) {
                return valid((row(last), .after))
            }
            // Beside a group inside the container: after that group.
            if level + 1 < section.groups.count {
                return valid((row(section.groups[level + 1]), .after))
            }
            return end(of: container)
        }

        /// The section whose rows run past `y`: the last one starting at or
        /// above it.
        private func section(at y: CGFloat, in view: UICollectionView) -> Int? {
            var found: Int?
            for index in sections.indices {
                let top: CGFloat?
                if sections[index].header != nil {
                    top = view.layoutAttributesForSupplementaryElement(
                        ofKind: UICollectionView.elementKindSectionHeader, at: IndexPath(item: 0, section: index))?.frame.minY
                } else if !sections[index].items.isEmpty {
                    top = view.layoutAttributesForItem(at: IndexPath(item: 0, section: index))?.frame.minY
                } else {
                    top = nil
                }
                if let top, top <= y { found = index }
            }
            return found
        }

        /// Where a card lands at the system's gap: before the card that
        /// will follow it, after the last one, or in the section's group or
        /// the Workspace when the section has no other card.
        private func landing(at path: IndexPath, dragged id: String) -> (DropOver, DropKind)? {
            guard sections.indices.contains(path.section) else { return nil }
            let section = sections[path.section]
            let others = section.items.filter { $0 != id }
            let model = parent.model
            func over(_ other: String) -> DropOver {
                DropOver(id: other, kind: model.row(other)?.kind ?? .tab, expanded: false)
            }
            let landing: (DropOver, DropKind)
            if path.item < others.count {
                landing = (over(others[path.item]), .before)
            } else if let last = others.last {
                landing = (over(last), .after)
            } else if section.container == parent.workspace {
                landing = (DropOver(id: section.container, kind: .workspace, expanded: true), .end)
            } else {
                landing = (DropOver(id: section.container, kind: .group, expanded: false), .into)
            }
            return model.dropPlan(id, over: landing.0, landing.1) == nil ? nil : landing
        }
    }
}

/// The grid's collection view, which says when it lays out.
final class GridCollectionView: UICollectionView {
    var laidOut: ((UICollectionView) -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        laidOut?(self)
    }
}

/// A section's group boxes, drawn behind its cards. The layers ride in the
/// decoration's kind, the one thing a background decoration is given.
final class GridBox: UICollectionReusableView {
    static var theme: Theme?

    static func kind(_ layers: [GroupLayer]) -> String {
        "box|" + layers.map { "\($0.tint ?? "-"):\($0.top ? 1 : 0):\($0.bottom ? 1 : 0)" }.joined(separator: ",")
    }

    private var layers: [(tint: String?, top: Bool, bottom: Bool)] = []

    override func apply(_ attributes: UICollectionViewLayoutAttributes) {
        super.apply(attributes)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        contentMode = .redraw
        let spec = attributes.representedElementKind?.dropFirst(4) ?? ""
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
            let radius: CGFloat = index == 0 ? 22 : 18
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

/// A tab's card (15b, 15c): its picture, under a bar with the site's icon,
/// the title and ×, and the speaker in the corner while it plays. The
/// collection view's cell is the button: its tap, menu and drag are the
/// system's.
struct GridCard: View {
    let model: AppModel
    /// The tab's row, read here so a change to it redraws this card alone.
    let box: RowBox
    let height: CGFloat
    let theme: Theme
    let editing: Bool
    let ticked: Bool
    let dropState: GridDropState
    let onClose: () -> Void

    private var row: OutlineRow { box.row }

    var body: some View {
        let browser: Browser = model.browser
        let front = row.id == browser.currentTabId
        let elsewhere = Browser.openable(row) == nil && row.url != nil
        let playing = browser.playingTabs.contains(row.id)
        let muted = browser.mutedTabs.contains(row.id)
        CardPicture(row: row, height: height, elsewhere: elsewhere, theme: theme, loading: browser.hasPage(row.id),
                    top: GridMetrics.bar)
            .overlay { GridHalves(id: row.id, dropState: dropState, theme: theme) }
            .overlay(alignment: .top) {
                CardBar(theme: theme, title: row.displayTitle, bold: front, dim: elsewhere,
                        closeLabel: "Close \(row.displayTitle)", onClose: onClose) {
                    SiteTile(row: row, size: 16).opacity(elsewhere ? 0.4 : 1)
                }
            }
            .overlay(alignment: .bottomLeading) {
                if editing {
                    // Over a picture of any colour, the tick sits on a
                    // white disc.
                    SelectionTick(ticked: ticked, tick: theme.action, off: theme.muted, onPicture: true)
                        .padding(8)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if playing {
                    HStack(spacing: 6) {
                        mediaButton("stop.fill", label: "Stop") { Task { await browser.stopMedia(row.id) } }
                        mediaButton(muted ? "speaker.slash.fill" : "speaker.wave.2.fill", label: muted ? "Unmute" : "Mute") {
                            browser.toggleMute(row.id)
                        }
                    }
                    .padding(6)
                    .environment(\.colorScheme, theme.dark ? .dark : .light)
                }
            }
            .clipShape(.rect(cornerRadius: 14))
            .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(CardPicture.ring(theme), lineWidth: 1) }
            .modifier(FrontRing(front: front, color: theme.accent))
            .padding(GridMetrics.ring)
            // VoiceOver reads the title, the site, then any state; the tab in
            // front says so through the selected trait, and × is an action.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label(elsewhere: elsewhere, playing: playing))
            .accessibilityAddTraits(front || (editing && ticked) ? [.isButton, .isSelected] : .isButton)
            .accessibilityAction(named: "Close", onClose)
            .accessibilityActions {
                if playing {
                    Button("Stop") { Task { await browser.stopMedia(row.id) } }
                    Button(muted ? "Unmute" : "Mute") { browser.toggleMute(row.id) }
                }
            }
    }

    /// A media control in the picture's corner, on a disc of the sheet's
    /// material so it reads over any page.
    private func mediaButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(theme.accent)
                .frame(width: 38, height: 38)
                .background(.regularMaterial, in: .circle)
                .contentShape(.circle)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(label)
    }

    private func label(elsewhere: Bool, playing: Bool) -> String {
        var parts = [row.displayTitle]
        if let host = row.url.flatMap(URL.init(string:))?.host() { parts.append(SiteRules.site(of: host) ?? host) }
        if playing { parts.append("playing") }
        if elsewhere { parts.append("can't open on \(UIDevice.current.model)") }
        return parts.joined(separator: ", ")
    }
}

/// The bar over the top of a card's picture: icons, the title cut to fit,
/// and ×, on the sheet's material so the page shows through.
struct CardBar<Icon: View>: View {
    let theme: Theme
    let title: String
    let bold: Bool
    var dim = false
    let closeLabel: String
    let onClose: () -> Void
    @ViewBuilder let icon: Icon

    var body: some View {
        HStack(spacing: 7) {
            icon
            Text(title)
                .font(.system(.subheadline, weight: bold ? .semibold : .medium))
                .foregroundStyle(dim ? theme.muted : theme.text)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.muted)
                    .frame(width: 36, height: GridMetrics.bar)
                    .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(closeLabel)
        }
        .padding(.leading, 9)
        .frame(height: GridMetrics.bar)
        .background(.regularMaterial)
        .environment(\.colorScheme, theme.dark ? .dark : .light)
    }
}

/// A split as one card (15e): each pane's picture, laid out as the split
/// shows them upright.
struct GridSplitCard: View {
    let model: AppModel
    /// The split's row and its panes', read here so a change to any of
    /// them redraws this card alone.
    let split: RowBox
    let panes: [RowBox]
    let height: CGFloat
    let theme: Theme
    let editing: Bool
    let dropState: GridDropState
    let onClose: () -> Void

    var body: some View {
        let panes = panes.map(\.row)
        let split = split.row
        let front = panes.contains { $0.id == (model.browser as Browser).currentTabId }
        let first = panes[0]
        let title = split.name.isEmpty ? first.displayTitle : split.name
        let closeName = panes.count == 2 ? "Close Both" : "Close All"
        SplitPicture(panes: panes, height: height, theme: theme)
            .overlay { GridHalves(id: split.id, dropState: dropState, theme: theme) }
            .overlay(alignment: .top) {
                CardBar(theme: theme, title: title, bold: front, closeLabel: closeName, onClose: onClose) {
                    HStack(spacing: -5) {
                        ForEach(panes, id: \.id) { pane in
                            SiteTile(row: pane, size: 16)
                                .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(theme.sheet, lineWidth: 1.5) }
                        }
                    }
                    .padding(.trailing, 2)
                }
            }
            .clipShape(.rect(cornerRadius: 14))
            .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(CardPicture.ring(theme), lineWidth: 1) }
            .modifier(FrontRing(front: front, color: theme.accent))
            .padding(GridMetrics.ring)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Split, \(title)")
            .accessibilityAddTraits(front ? [.isButton, .isSelected] : .isButton)
            .accessibilityAction(named: closeName, onClose)
    }
}

/// A card's halves while a card is held over its middle (15f2).
private struct GridHalves: View {
    let id: String
    let dropState: GridDropState
    let theme: Theme

    var body: some View {
        if let hover = dropState.hover, hover.id == id, let halves = hover.halves {
            DropHalvesMark(halves: halves, onSplit: hover.kind != .newGroup, color: theme.accent,
                           muted: theme.muted, cover: theme.sheet, compact: true)
                .allowsHitTesting(false)
        }
    }
}

/// A group's header in the grid (15d): its tile, name, count and chevron,
/// and when closed, the first three icons inside it.
struct GridGroupHeader: View {
    /// The group's row, read here so a change to it redraws this header.
    let box: RowBox
    let header: GroupHeader
    /// The first three tabs inside the group, whose icons show while it's
    /// closed.
    let icons: [RowBox]
    let theme: Theme
    let onToggle: () -> Void
    let menu: (OutlineRow) -> [[MenuItem]]

    private var group: OutlineRow { box.row }

    var body: some View {
        let tint = group.color.flatMap(WorkspaceTint.init(rawValue:))
        let open = header.open, nested = header.nested
        Button(action: onToggle) {
            HStack(spacing: nested ? 9 : 10) {
                tile(tint, size: nested ? 24 : 28)
                Text(group.displayTitle)
                    .font(.system(nested ? .subheadline : .body, weight: .semibold))
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !open {
                    HStack(spacing: -6) {
                        ForEach(icons.map(\.row), id: \.id) { tab in SiteTile(row: tab, size: 20) }
                    }
                    .padding(.trailing, 6)
                }
                Text("\(header.count)")
                    .font(.system(.subheadline))
                    .monospacedDigit()
                    .foregroundStyle(theme.muted)
                Chevron(open: open, color: theme.muted)
            }
            .padding(.horizontal, 12)
            .frame(maxHeight: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityValue(open ? "Expanded" : "Collapsed")
        // The header is a supplementary view, which the collection view's
        // item menus don't cover.
        .contextMenu { MenuItems(sections: menu(group)) }
    }

    private func tile(_ tint: WorkspaceTint?, size: CGFloat) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.29).fill(theme.cell)
            if let emoji = group.emoji, !emoji.isEmpty {
                Text(emoji).font(.system(size: size * 0.57)).accessibilityIgnoresInvertColors()
            } else {
                Image(systemName: "folder")
                    .font(.system(size: size * 0.55, weight: .medium))
                    .foregroundStyle(tint?.swatch(dark: theme.dark) ?? theme.body)
            }
        }
        .frame(width: size, height: size)
    }
}

/// A card's picture: the top of its page, or the site's icon and domain
/// when the phone has no picture of it (15c).
struct CardPicture: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let row: OutlineRow
    let height: CGFloat
    let elsewhere: Bool
    let theme: Theme
    /// Whether the page is open on this phone, so its picture is on its
    /// way (15c, "picture loading").
    var loading = false
    /// The bar over the picture's top, which the icon in its place sits
    /// below.
    var top: CGFloat = 0
    @State private var sweep = false

    var body: some View {
        let picture = elsewhere ? nil : PagePreviews.shared.picture(for: row.id)
        Color.clear
            .frame(height: height)
            .frame(maxWidth: .infinity)
            .background(theme.cell)
            .overlay(alignment: .top) {
                if let picture {
                    Image(uiImage: picture).resizable().scaledToFill()
                        .accessibilityIgnoresInvertColors()
                        .transition(.opacity.animation(.easeOut(duration: 0.15)))
                } else if loading {
                    SiteTile(row: row, size: 28)
                        .opacity(0.45)
                        .frame(maxHeight: .infinity)
                        .padding(.top, top)
                        .overlay {
                            if !reduceMotion {
                                LinearGradient(colors: [.clear, theme.text.opacity(0.08), .clear],
                                               startPoint: .leading, endPoint: .trailing)
                                    .frame(width: 120)
                                    .offset(x: sweep ? 200 : -200)
                                    .onAppear {
                                        withAnimation(.linear(duration: 1.2).repeatForever(autoreverses: false)) { sweep = true }
                                    }
                            }
                        }
                } else {
                    VStack(spacing: 8) {
                        SiteTile(row: row, size: 44).opacity(elsewhere ? 0.4 : 1)
                        if let host = row.url.flatMap(URL.init(string:))?.host() {
                            Text(SiteRules.site(of: host) ?? host)
                                .font(.system(.footnote))
                                .foregroundStyle(theme.muted)
                                .lineLimit(1)
                        }
                        if elsewhere {
                            Label("Can't open on \(UIDevice.current.model)", systemImage: "laptopcomputer")
                                .font(.system(.caption, weight: .semibold))
                                .foregroundStyle(theme.text)
                                .padding(.horizontal, 9)
                                .frame(height: 24)
                                .background(theme.well, in: .capsule)
                        }
                    }
                    .padding(.horizontal, 12)
                    .frame(maxHeight: .infinity)
                    .padding(.top, top)
                }
            }
    }

    /// The card's 1pt ring, drawn around the picture and bar.
    static func ring(_ theme: Theme) -> Color {
        theme.divider
    }
}

/// A split's picture: each pane's, two stacked, three as one over two,
/// four as two by two, with 3pt gaps (15e).
struct SplitPicture: View {
    let panes: [OutlineRow]
    let height: CGFloat
    let theme: Theme

    var body: some View {
        let rows: [[OutlineRow]] = switch panes.count {
        case 2: [[panes[0]], [panes[1]]]
        case 3: [[panes[0]], [panes[1], panes[2]]]
        default: [Array(panes.prefix(2)), Array(panes.dropFirst(2).prefix(2))]
        }
        VStack(spacing: 3) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, line in
                HStack(spacing: 3) {
                    ForEach(line, id: \.id) { row in
                        cell(row)
                    }
                }
            }
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .background(theme.cell)
    }

    private func cell(_ pane: OutlineRow) -> some View {
        Color.clear
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.well)
            .overlay(alignment: .top) {
                if let picture = PagePreviews.shared.picture(for: pane.id) {
                    Image(uiImage: picture).resizable().scaledToFill()
                        .accessibilityIgnoresInvertColors()
                } else {
                    SiteTile(row: pane, size: 24).frame(maxHeight: .infinity)
                }
            }
            .clipShape(.rect(cornerRadius: 3))
    }
}

/// The tab in front's ring: 2.5pt of accent outside a 2pt gap (15c).
struct FrontRing: ViewModifier {
    let front: Bool
    let color: Color
    let radius: CGFloat = 14

    func body(content: Content) -> some View {
        content.overlay {
            if front {
                RoundedRectangle(cornerRadius: radius + 4.5)
                    .strokeBorder(color, lineWidth: 2.5)
                    .padding(-4.5)
                    .allowsHitTesting(false)
            }
        }
    }
}
