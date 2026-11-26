// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit
import UniformTypeIdentifiers

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

/// What a new `TreeState` asks of the collection view: a new snapshot
/// where cards or sections came, went or moved; the cards and headers whose
/// own facts changed; and a new layout where a section's shape changed. A
/// change to a row's content alone asks for nothing: each card and header
/// reads its row's `RowBox`.
struct TreeUpdate: Equatable {
    var apply = false
    var reconfigure: [String] = []
    var headers: [String] = []
    var relayout = false

    static func between(_ old: TreeState?, _ new: TreeState) -> TreeUpdate {
        var update = TreeUpdate()
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
                || old.ticked.contains(line.id) != new.ticked.contains(line.id)
                || old.marked.contains(line.id) != new.marked.contains(line.id)
                || old.dimmed.contains(line.id) != new.dimmed.contains(line.id) {
                update.reconfigure.append(line.id)
            }
        }
        // A lifted group's box dims with its rows.
        update.relayout = looks || old.sections.map(\.layout) != new.sections.map(\.layout) || old.dimmed != new.dimmed
        let headers = Dictionary(old.sections.map { ($0.id, $0.header) }, uniquingKeysWith: { a, _ in a })
        for section in new.sections where section.header != nil {
            if let was = headers[section.id], looks || was != section.header { update.headers.append(section.id) }
        }
        return update
    }
}

/// Which of the tree's edges have more to scroll to.
@MainActor
@Observable
final class TreeEdges {
    var before = false
    var after = false
}

/// The tree, faded at an edge with more to scroll to (`ScrollEdgeFade`).
struct FadedTree: View {
    let tree: TreeView
    @State private var edges = TreeEdges()

    var body: some View {
        tree.edges(edges).edgeFade(.vertical, before: edges.before, after: edges.after)
    }
}

/// The list and the grid: the system's collection view, with its
/// compositional layout, diffable data source, drag and drop, context
/// menus and, in the list, swipe actions. The rows, cards and group
/// headers are SwiftUI views in its cells; the group boxes are the
/// sections' background decorations.
struct TreeView: UIViewRepresentable {
    let model: AppModel
    let workspace: String
    let layout: TabLayout
    let collapsed: Set<String>
    let editing: Bool
    let selected: Set<String>
    let marked: Set<String>
    let scheme: ColorScheme
    let tint: String?
    let sideways: Bool
    let reduceMotion: Bool
    let dropState: TreeDropState
    let actions: TreeActions
    /// Where the tree reports which edges have more to scroll to.
    var reportsEdges: TreeEdges?

    func edges(_ edges: TreeEdges) -> TreeView {
        var tree = self
        tree.reportsEdges = edges
        return tree
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
        UICollectionViewDropDelegate, UICollectionViewDataSourcePrefetching, UIGestureRecognizerDelegate {
        private var parent: TreeView!
        private var state: TreeState?
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
        /// The live pages this sheet has taken a picture of, once each.
        private var photographed: Set<String> = []
        /// The rows a drag in the list lifted: the row, and a group's rows
        /// under it, dimmed in place while the row is held.
        private var lifted: Set<String> = []
        /// What a drag over the list would do, and the line that shows a
        /// landing between rows.
        private var aim: ListAim?
        private var lineView: DropLineView?
        #if DEBUG
        /// The last drag trace line written, so a line is written when the
        /// decision changes.
        private var traced = ""
        #endif
        /// The closed groups the list was last drawn with.
        private var drawnCollapsed: Set<String> = []

        private var isList: Bool { parent.layout == .list }

        private var sections: [TreeSection] { state?.sections ?? [] }

        func make(_ parent: TreeView) -> UICollectionView {
            self.parent = parent
            let layout: UICollectionViewCompositionalLayout
            if parent.layout == .list {
                let configuration = UICollectionViewCompositionalLayoutConfiguration()
                if parent.sideways {
                    // In the sideways panel the pins scroll away with the
                    // rows (12f3).
                    configuration.boundarySupplementaryItems = [NSCollectionLayoutBoundarySupplementaryItem(
                        layoutSize: .init(widthDimension: .fractionalWidth(1), heightDimension: .estimated(64)),
                        elementKind: Self.pinsKind, alignment: .top)]
                }
                layout = UICollectionViewCompositionalLayout(sectionProvider: { [weak self] index, environment in
                    self?.listLayout(section: index, environment: environment)
                }, configuration: configuration)
            } else {
                layout = UICollectionViewCompositionalLayout { [weak self] index, _ in
                    self?.layout(section: index)
                }
            }
            let view = TreeCollectionView(frame: .zero, collectionViewLayout: layout)
            // Each layout pass, a scroll's included, says which edges have
            // more to scroll to.
            view.laidOut = { [weak self] view in self?.reportEdges(view) }
            view.backgroundColor = .clear
            view.delegate = self
            view.dragDelegate = self
            view.dropDelegate = self
            view.prefetchDataSource = self
            view.dragInteractionEnabled = true
            self.view = view
            if parent.layout == .list {
                view.contentInset.top = 7
                let row = UICollectionView.CellRegistration<UICollectionViewListCell, String> { [weak self] cell, _, id in
                    self?.configure(row: cell, id: id)
                }
                dataSource = UICollectionViewDiffableDataSource(collectionView: view) { view, index, id in
                    view.dequeueConfiguredReusableCell(using: row, for: index, item: id)
                }
                let pins = UICollectionView.SupplementaryRegistration<UICollectionViewCell>(
                    elementKind: Self.pinsKind
                ) { [weak self] cell, _, _ in
                    self?.configurePins(cell)
                }
                dataSource.supplementaryViewProvider = { view, _, index in
                    view.dequeueConfiguredReusableSupplementary(using: pins, for: index)
                }
                update(parent)
                return view
            }
            view.contentInset.top = 6
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

        static let pinsKind = "pins"

        /// Draws the grid from the tree as it is: a card or header whose
        /// own facts changed is configured again, and the rest are left.
        @discardableResult
        func update(_ parent: TreeView) -> TreeUpdate {
            self.parent = parent
            let look = TreeLook(scheme: parent.scheme, tint: parent.tint, sideways: parent.sideways,
                                size: UIApplication.shared.preferredContentSizeCategory)
            let sections = parent.layout == .list
                ? TreeLines.list(parent.model.tree, workspace: parent.workspace, collapsed: parent.collapsed)
                : TreeLines.grid(parent.model.tree, workspace: parent.workspace, collapsed: parent.collapsed)
            let new = TreeState(sections: sections, editing: parent.editing, ticked: parent.selected, look: look,
                                marked: parent.marked, dimmed: lifted)
            let update = TreeUpdate.between(state, new)
            theme = Theme(parent.scheme, tint: parent.tint)
            GridBox.theme = theme
            ListBox.theme = theme
            // A group opening or closing in the list takes the data source's
            // own animation.
            let animates = isList && state != nil && parent.collapsed != drawnCollapsed && !parent.reduceMotion
            drawnCollapsed = parent.collapsed
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
                dataSource.apply(snapshot, animatingDifferences: animates)
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
            for (s, section) in sections.enumerated() {
                if let i = section.items.firstIndex(where: { $0 == id || lines[$0]?.panes?.contains(id) == true }) {
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
                let kind = GridBox.kind(section.layers, theme: theme)
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
                                  sideways: state.look.sideways, dropState: dropState,
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
            photograph(line.panes.map { Array($0.prefix(4)) } ?? [id])
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
        private func act(on id: String, _ action: (TreeActions, OutlineRow) -> Void) {
            guard let row = parent.model.row(id) else { return }
            action(parent.actions, row)
        }

        private func close(_ id: String) {
            let model = parent.model
            act(on: TreeLines.rowId(of: id)) { actions, row in
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
                UIView.animate(withDuration: Motion.overlayDuration, delay: 0, options: .curveEaseOut) {
                    cell.transform = CGAffineTransform(translationX: off, y: 0)
                    cell.alpha = 0
                } completion: { [weak self] _ in
                    self?.close(id)
                }
            default:
                break
            }
        }

        // MARK: Pictures

        /// The pictures the card at `path` draws: its tab's, or a split's
        /// first four panes' (`SplitPicture`). A tab open elsewhere draws
        /// none, and the list draws none.
        private func pictures(at path: IndexPath) -> [String] {
            guard !isList, let id = dataSource.itemIdentifier(for: path), let line = lines[id] else { return [] }
            if let panes = line.panes { return Array(panes.prefix(4)) }
            guard let row = parent.model.row(id), Browser.openable(row) != nil || row.url == nil else { return [] }
            return [id]
        }

        /// Takes the picture of each of `ids`' pages that is live in a
        /// window and has none, so its card shows the page in place of its
        /// icon. A page out of a window is left, as
        /// `Page.webView(_:didFinish:)` leaves one.
        private func photograph(_ ids: [String]) {
            let browser: Browser = parent.model.browser
            for id in ids where browser.paneView(id)?.window != nil && !PagePreviews.shared.has(id)
                && photographed.insert(id).inserted {
                browser.takePreview(id)
            }
        }

        func collectionView(_ view: UICollectionView, prefetchItemsAt paths: [IndexPath]) {
            PagePreviews.shared.prefetch(paths.flatMap(pictures))
        }

        func collectionView(_ view: UICollectionView, cancelPrefetchingForItemsAt paths: [IndexPath]) {
            PagePreviews.shared.cancel(paths.flatMap(pictures))
        }

        func collectionView(_ view: UICollectionView, didEndDisplaying cell: UICollectionViewCell,
                            forItemAt path: IndexPath) {
            PagePreviews.shared.cancel(pictures(at: path))
        }

        // MARK: Taps and menus

        func collectionView(_ view: UICollectionView, didSelectItemAt path: IndexPath) {
            view.deselectItem(at: path, animated: isList)
            guard let id = dataSource.itemIdentifier(for: path),
                  let row = parent.model.row(TreeLines.rowId(of: id)) else { return }
            if row.kind == .group {
                parent.actions.toggle(row)
            } else {
                parent.actions.open(row)
            }
        }

        func collectionView(_ view: UICollectionView, contextMenuConfigurationForItemsAt paths: [IndexPath],
                            point: CGPoint) -> UIContextMenuConfiguration? {
            if isList { return listMenu(at: paths) }
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
        /// A row lifted in the list stays in place, dimmed, with a group's
        /// rows under it, as the desktop's panel dims a dragged row.
        func collectionView(_ view: UICollectionView, dragSessionWillBegin session: UIDragSession) {
            guard isList, let id = session.items.first?.localObject as? String else { return }
            lifted = [id]
            if lines[id]?.group != nil {
                lifted.formUnion(sections.filter { $0.groups.contains(id) }.flatMap(\.items))
            }
            update(parent)
        }

        func collectionView(_ view: UICollectionView, dragSessionDidEnd session: UIDragSession) {
            guard isList, !lifted.isEmpty else { return }
            lifted = []
            update(parent)
        }

        func collectionView(_ view: UICollectionView, dragPreviewParametersForItemAt path: IndexPath) -> UIDragPreviewParameters? {
            preview(at: path, in: view)
        }

        func collectionView(_ view: UICollectionView, dropPreviewParametersForItemAt path: IndexPath) -> UIDragPreviewParameters? {
            preview(at: path, in: view)
        }

        private func preview(at path: IndexPath, in view: UICollectionView) -> UIDragPreviewParameters? {
            if isList, let cell = view.cellForItem(at: path) {
                // The row's own rounded shape, inside the sheet's margin;
                // the cell ends at the trailing one.
                let parameters = UIDragPreviewParameters()
                parameters.visiblePath = UIBezierPath(roundedRect: Self.rowShape(cell.bounds),
                                                      cornerRadius: WorkspaceSheet.cardCorner)
                parameters.backgroundColor = UIColor(theme.sheet)
                return parameters
            }
            guard let cell = view.cellForItem(at: path) as? GridCell else { return nil }
            let parameters = UIDragPreviewParameters()
            let room = cell.card.insetBy(dx: -GridMetrics.ring, dy: -GridMetrics.ring)
            parameters.visiblePath = UIBezierPath(roundedRect: room, cornerRadius: Radius.picture + GridMetrics.ring)
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
            if isList { return listDropUpdate(session, dragged: id, in: view) }
            let point = session.location(in: view)
            let overPath = view.indexPathForItem(at: point)
            // Written before any return: a drop reads it ahead of a card's
            // middle or side, so a finger over a card must find it nil.
            placed = overPath == nil ? empty(at: point, in: view, dragged: id) : nil
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
            if isList { show(nil, in: view) }
            parent.dropState.hover = nil
        }

        func collectionView(_ view: UICollectionView, dropSessionDidEnd session: UIDropSession) {
            if isList { show(nil, in: view) }
            parent.dropState.hover = nil
            lastLanding = nil
            edge = nil
            latched = nil
            placed = nil
        }

        func collectionView(_ view: UICollectionView, performDropWith coordinator: UICollectionViewDropCoordinator) {
            defer { parent.dropState.hover = nil }
            if isList {
                listDrop(coordinator, in: view)
                return
            }
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
                            dragged: String, latched: Bool) -> TreeHover? {
            guard let row = parent.model.row(id) else { return nil }
            guard let (x, span, picture) = GridMetrics.middle(cell.convert(point, from: view), card: cell.card,
                                                              latched: latched)
            else { return nil }
            let model = parent.model
            let over = DropOver(id: id, kind: row.kind, expanded: false)
            let kind = model.dropIntent(dragged, over: over, x: x, y: picture / 2, w: span, h: picture)
            guard [DropKind.newGroup, .split, .join, .merge, .refused(full: true)].contains(kind) else { return nil }
            let split = model.dropIntent(dragged, over: over, x: span - 1, y: picture / 2, w: span, h: picture)
            var hover = TreeHover(id: id, over: over, kind: kind, writes: model.dropPlan(dragged, over: over, kind) != nil)
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

// MARK: The list

extension TreeView.Coordinator {
    /// A list section: the system's plain list, with its separators only
    /// between two tab or split rows, the room above a coloured group and
    /// below it, and the section's coloured blocks behind its rows.
    fileprivate func listLayout(section index: Int, environment: NSCollectionLayoutEnvironment) -> NSCollectionLayoutSection? {
        guard sections.indices.contains(index) else { return nil }
        var configuration = UICollectionLayoutListConfiguration(appearance: .plain)
        configuration.showsSeparators = true
        configuration.itemSeparatorHandler = { [weak self] path, resolved in
            var separator = resolved
            separator.topSeparatorVisibility = .hidden
            separator.bottomSeparatorVisibility = self?.separatesBelow(path) == true ? .visible : .hidden
            if let self { separator.color = UIColor(self.theme.divider) }
            return separator
        }
        configuration.backgroundColor = .clear
        configuration.trailingSwipeActionsConfigurationProvider = { [weak self] path in self?.swipeActions(at: path) }
        let layout = NSCollectionLayoutSection.list(using: configuration, layoutEnvironment: environment)
        let gap = ListMetrics.gapAbove(sections, index) ? ListMetrics.gap : 0
        layout.contentInsets = NSDirectionalEdgeInsets(top: gap, leading: 0, bottom: 0,
                                                       trailing: ListMetrics.sectionTrailing(sections[index]))
        let layers = sections[index].layers
        if ListBox.draws(layers) {
            let kind = ListBox.kind(layers, groups: sections[index].groups, dimmed: state?.dimmed ?? [], theme: theme)
            if !registered.contains(kind) {
                registered.insert(kind)
                view?.collectionViewLayout.register(ListBox.self, forDecorationViewOfKind: kind)
            }
            // A background decoration spans the section's insets; the
            // block starts below the room above it.
            let box = NSCollectionLayoutDecorationItem.background(elementKind: kind)
            box.contentInsets = NSDirectionalEdgeInsets(top: gap, leading: 0, bottom: 0, trailing: 0)
            layout.decorationItems = [box]
        }
        return layout
    }

    fileprivate func configure(row cell: UICollectionViewListCell, id: String) {
        guard let line = lines[id], let state, let box = parent.model.treeStore.box(TreeLines.rowId(of: id)) else {
            cell.contentConfiguration = nil
            return
        }
        let model = parent.model, theme = theme, dropState = parent.dropState
        let scheme: ColorScheme = parent.scheme
        let token: String? = parent.tint
        let marked = state.marked.contains(id), dimmed = state.dimmed.contains(id)
        let swipe = CellSwipe()
        if let header = line.group {
            cell.contentConfiguration = UIHostingConfiguration {
                TreeGroupRow(box: box, line: line, header: header, theme: theme, marked: marked, dimmed: dimmed,
                             dropState: dropState)
                    .treeCell(model, scheme: scheme, token: token)
            }
            .margins(.leading, ListMetrics.inset)
            .margins(.trailing, 0)
            .margins(.vertical, 0)
        } else if let panes = line.panes {
            let boxes = panes.compactMap(model.treeStore.box)
            let actions = parent.actions
            cell.contentConfiguration = UIHostingConfiguration {
                TreeSplitRow(model: model, split: box, panes: boxes, line: line, swipe: swipe, theme: theme, marked: marked,
                             dimmed: dimmed, dropState: dropState,
                             onOpen: { pane in
                                 let split = box.row.id
                                 guard let id = pane ?? model.browser.focusedPane(of: split, among: panes) else { return }
                                 actions.openPane(id)
                             },
                             menu: actions.paneMenu)
                    .treeCell(model, scheme: scheme, token: token)
            }
            .margins(.leading, ListMetrics.inset)
            .margins(.trailing, 0)
            .margins(.vertical, 0)
        } else {
            let ticked = state.ticked.contains(id), editing = state.editing
            cell.contentConfiguration = UIHostingConfiguration {
                TreeTabRow(model: model, box: box, line: line, swipe: swipe, theme: theme, editing: editing, ticked: ticked,
                           marked: marked, dimmed: dimmed, dropState: dropState,
                           onClose: { [weak self] in self?.close(id) })
                    .treeCell(model, scheme: scheme, token: token)
            }
            .margins(.leading, ListMetrics.inset)
            .margins(.trailing, 0)
            .margins(.vertical, 0)
        }
        // The system's press highlight, in the row's rounded shape on its
        // group's card; the row's block lies behind it. A group's own row
        // keeps the sheet's margins, since its block starts at its level.
        let insets = line.group == nil ? RowPlace(line).backgroundInsets
            : NSDirectionalEdgeInsets(top: 0, leading: ListMetrics.inset, bottom: 0, trailing: 0)
        cell.configurationUpdateHandler = { [weak self] cell, state in
            // A swiped row shows as a card pushed aside, in the press
            // highlight's fill; the row in front has its own card.
            var shown = state
            if state.isSwiped, self?.isFront(line) == false { shown.isHighlighted = true }
            var background = UIBackgroundConfiguration.listCell().updated(for: shown)
            if !shown.isHighlighted { background.backgroundColor = .clear }
            background.cornerRadius = WorkspaceSheet.cardCorner
            background.backgroundInsets = insets
            cell.backgroundConfiguration = background
            if swipe.open != state.isSwiped { swipe.open = state.isSwiped }
        }
    }

    /// Whether the row at `path` draws a separator below it.
    fileprivate func separatesBelow(_ path: IndexPath) -> Bool {
        guard sections.indices.contains(path.section) else { return false }
        return ListMetrics.separatesBelow(sections[path.section].lines, at: path.item, isFront: isFront)
    }

    /// Whether `line` is the row in front: its tab, or a pane of its split.
    fileprivate func isFront(_ line: TreeLine) -> Bool {
        guard let front = parent.model.browser.currentTabId else { return false }
        return line.panes?.contains(front) ?? (TreeLines.rowId(of: line.id) == front)
    }

    fileprivate func configurePins(_ cell: UICollectionViewCell) {
        let model = parent.model, actions = parent.actions
        let scheme: ColorScheme = parent.scheme
        let token: String? = parent.tint
        cell.contentConfiguration = UIHostingConfiguration {
            PinsRow(onOpened: actions.pinOpened, tileSize: 48)
                .treeCell(model, scheme: scheme, token: token)
                .environment(model.toasts)
        }
        .margins(.all, 0)
    }

    /// A row's swipe: Close, which a full swipe runs, and Move to…; a
    /// split's closes all its panes and takes no full swipe. A group's row
    /// has none. Each action shows its symbol alone, in the colour its
    /// style gives it.
    fileprivate func swipeActions(at path: IndexPath) -> UISwipeActionsConfiguration? {
        guard let id = dataSource.itemIdentifier(for: path), let line = lines[id], line.group == nil,
              let row = parent.model.row(TreeLines.rowId(of: id)) else { return nil }
        let actions = parent.actions
        let move = UIContextualAction(style: .normal, title: nil) { _, _, done in
            actions.move(row)
            done(true)
        }
        move.image = Self.swipeImage("folder.fill", named: "Move to…")
        guard let panes = line.panes else {
            let close = UIContextualAction(style: .destructive, title: nil) { _, _, done in
                actions.close(row)
                done(true)
            }
            close.image = Self.swipeImage("xmark", named: "Close")
            return UISwipeActionsConfiguration(actions: [close, move])
        }
        let paneRows = panes.compactMap(parent.model.row)
        let close = UIContextualAction(style: .destructive, title: nil) { _, _, done in
            actions.closeSplit(row, paneRows)
            done(true)
        }
        close.image = Self.swipeImage("xmark", named: paneRows.count == 2 ? "Close Both" : "Close All")
        let configuration = UISwipeActionsConfiguration(actions: [close, move])
        configuration.performsFirstActionWithFullSwipe = false
        return configuration
    }

    /// A list row's shape in its cell: inside the sheet's leading margin,
    /// to the cell's trailing end, which the section sets at the row's card.
    fileprivate static func rowShape(_ bounds: CGRect) -> CGRect {
        CGRect(x: bounds.minX + ListMetrics.inset, y: bounds.minY, width: bounds.width - ListMetrics.inset,
               height: bounds.height)
    }

    /// A swipe action's symbol, carrying the name VoiceOver reads for an
    /// action with no title. The symbol is copied first, so the name stays
    /// on this action's image.
    private static func swipeImage(_ symbol: String, named name: String) -> UIImage? {
        let image = UIImage(systemName: symbol)?.withRenderingMode(.alwaysTemplate)
        image?.accessibilityLabel = name
        return image
    }

    /// A row's long-press menu, built when it opens: a tab's or a group's.
    /// A split's line has none of its own: each pane in its tray has its
    /// menu (12e1).
    fileprivate func listMenu(at paths: [IndexPath]) -> UIContextMenuConfiguration? {
        guard paths.count == 1, let id = dataSource.itemIdentifier(for: paths[0]), let line = lines[id],
              line.panes == nil, let row = parent.model.row(id) else { return nil }
        let actions = parent.actions
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in
            row.kind == .group ? UIMenu(sections: actions.groupMenu(row)) : actions.tabMenu(row)
        }
    }

    /// Reads a drag over the list as the desktop's panel does
    /// (`SvalPanelDrag`): a line between rows where the row would land, an
    /// outline on a closed group it would go into, a tab's or split's
    /// halves. The rows hold still: every answer holds the layout, and the
    /// list draws its line itself.
    fileprivate func listDropUpdate(_ session: UIDropSession, dragged id: String,
                                    in view: UICollectionView) -> UICollectionViewDropProposal {
        let model = parent.model
        let point = session.location(in: view)
        let spots = view.indexPathsForVisibleItems.compactMap { path -> ListSpot? in
            guard let item = dataSource.itemIdentifier(for: path), let line = lines[item],
                  let frame = view.layoutAttributesForItem(at: path)?.frame else { return nil }
            return ListSpot(line: line, frame: frame)
        }.sorted { $0.frame.minY < $1.frame.minY }
        let last = sections.last?.lines.last?.id
        let next = ListMetrics.aim(model.tree, dragged: id, spots: spots, at: point, workspace: parent.workspace,
                                   ends: spots.last?.line.id == last, makesGroups: model.makesGroups(in: parent.workspace))
        show(next, in: view)
        #if DEBUG
        traceDrop(point, spots: spots, aim: next, in: view)
        #endif
        guard case .middle(let item, let over, let kind) = next, let spot = spots.first(where: { $0.line.id == item }) else {
            if parent.dropState.hover != nil { parent.dropState.hover = nil }
            return UICollectionViewDropProposal(operation: next == nil ? .forbidden : .move, intent: .unspecified)
        }
        var hover = TreeHover(id: item, over: over, kind: kind, writes: model.dropPlan(id, over: over, kind) != nil)
        if kind != .into {
            let place = RowPlace(spot.line)
            let leading = spot.line.panes == nil ? place.indent : place.cardLeading
            let width = spot.frame.width - ListMetrics.inset - leading - place.trailing
            let row = ListMetrics.desktopRow
            let split = model.dropIntent(id, over: over, x: width - 1, y: row / 2, w: width, h: row)
            hover.halves = DropHalves(groups: model.makesGroups(in: parent.workspace),
                                      group: model.dropPlan(id, over: over, .newGroup) != nil, split: split,
                                      splits: model.dropPlan(id, over: over, split) != nil)
        }
        if parent.dropState.hover != hover { parent.dropState.hover = hover }
        return UICollectionViewDropProposal(operation: hover.writes ? .move : .forbidden,
                                            intent: .insertIntoDestinationIndexPath)
    }

    /// Shows the line for `aim` between its rows, or hides it.
    fileprivate func show(_ aim: ListAim?, in view: UICollectionView) {
        self.aim = aim
        guard case .line(let y, let depth, _, _) = aim else {
            lineView?.isHidden = true
            if parent.dropState.line != nil { parent.dropState.line = nil }
            return
        }
        let line = lineView ?? DropLineView()
        if lineView == nil {
            lineView = line
            line.layer.zPosition = 10
            view.addSubview(line)
        }
        line.color = UIColor(theme.accent)
        line.ring = UIColor(theme.sheet)
        // The line starts at the content of a row at its depth, where the
        // desktop indents it (`sval-drop-line`, `--sval-drop-depth`).
        let leading = ListMetrics.inset + 12 + CGFloat(depth) * ListMetrics.indent - DropLineView.ring
        line.frame = CGRect(x: leading, y: y - DropLineView.ring, width: view.bounds.width - leading - ListMetrics.inset - 8,
                            height: DropLineView.ring * 2)
        line.isHidden = false
        let mark = "\(Int(y)) \(depth)"
        if parent.dropState.line != mark { parent.dropState.line = mark }
    }

    /// Writes the drop the list showed last.
    fileprivate func listDrop(_ coordinator: UICollectionViewDropCoordinator, in view: UICollectionView) {
        defer { show(nil, in: view) }
        guard let id = dragged(coordinator.session) else { return }
        let model = parent.model
        switch aim {
        case .line(_, _, let over, let kind)?:
            guard let plan = model.dropPlan(id, over: over, kind) else { return }
            Diagnostics.log("sheet: dropped in the list, \(kind)")
            parent.actions.drop(plan)
        case .middle(_, let over, let kind)?:
            guard let plan = model.dropPlan(id, over: over, kind) else { return }
            Diagnostics.log("sheet: dropped in the list, \(kind)")
            if let item = coordinator.items.first, let path = coordinator.destinationIndexPath,
               let cell = view.cellForItem(at: path) {
                coordinator.drop(item.dragItem, intoItemAt: path, rect: Self.rowShape(cell.bounds))
            }
            parent.actions.drop(plan)
        case nil:
            return
        }
    }

    #if DEBUG
    /// A drag's trace in the Debug log, one line each time what the list
    /// shows changes or the list scrolls: the row under the finger by its
    /// place, how far down it the finger is and its height, the row's
    /// quarter, what a drop there does, and the list's scroll offset.
    /// Places and counts alone.
    fileprivate func traceDrop(_ point: CGPoint, spots: [ListSpot], aim: ListAim?, in view: UICollectionView) {
        var row = "off", zone = "off"
        if let over = view.indexPathForItem(at: point), let frame = view.layoutAttributesForItem(at: over)?.frame {
            let y = point.y - frame.minY
            row = "\(over.section).\(over.item) y=\(Int(y))/\(Int(frame.height))"
            zone = y < frame.height / 4 ? "top" : y >= frame.height * 3 / 4 ? "bottom" : "middle"
        }
        let shown = switch aim {
        case .line(let y, let depth, _, let kind)?: "line y=\(Int(y)) depth=\(depth) \(kind)"
        case .middle(_, _, let kind)?: "middle \(kind)"
        case nil: "none"
        }
        let key = "zone=\(zone) aim=\(shown) offset=\(Int(view.contentOffset.y))"
        guard key != traced else { return }
        traced = key
        Diagnostics.log("list trace: row=\(row) \(key)")
    }
    #endif

}

extension View {
    /// What a list cell's SwiftUI view reads from its sheet: the model and
    /// the sheet's colours, which a hosting configuration in a cell isn't
    /// given from the views around the collection view.
    func treeCell(_ model: AppModel, scheme: ColorScheme, token: String?) -> some View {
        environment(model).environment(\.appearance, scheme).environment(\.sheetTint, token)
    }
}

/// The tree's collection view, which says when it lays out.
final class TreeCollectionView: UICollectionView {
    var laidOut: ((UICollectionView) -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        laidOut?(self)
    }
}
