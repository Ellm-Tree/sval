// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit

/// The list's measures.
enum ListMetrics {
    /// The room between the sheet's edge and a row, on each side.
    static let inset = Space.sheetSide
    /// Each group level's step inward.
    static let indent: CGFloat = 24
    /// How far each nested coloured block ends inside its parent's.
    static let nestTrailing: CGFloat = 6
    /// The room above a coloured group and below it, outside its block.
    static let gap: CGFloat = 4

    /// Whether section `index` keeps `gap` above it: it opens an outermost
    /// coloured group, or the section above closes one. Opening or closing
    /// a group moves no row but those it shows or hides.
    static func gapAbove(_ sections: [TreeSection], _ index: Int) -> Bool {
        func outer(_ section: TreeSection) -> GroupLayer? {
            section.layers.first { $0.tint.flatMap(WorkspaceTint.init(rawValue:)) != nil }
        }
        if outer(sections[index])?.top == true { return true }
        return index > 0 && outer(sections[index - 1])?.bottom == true
    }

    /// Whether the line at `index` draws a separator below it: only between
    /// two tab or split rows of one section, neither of them the row in
    /// front, whose card stands apart. A group's own row, and the last row
    /// of a section, draw none.
    static func separatesBelow(_ lines: [TreeLine], at index: Int, isFront: (TreeLine) -> Bool) -> Bool {
        guard lines.indices.contains(index), lines.indices.contains(index + 1) else { return false }
        let row = lines[index], next = lines[index + 1]
        return row.group == nil && next.group == nil && !isFront(row) && !isFront(next)
    }

    /// How far a section's cells end inside the list's trailing side: at
    /// the sheet's margin, or the innermost coloured block's card, so the
    /// system's swipe actions, which the cell lays out, end inside it.
    /// Every line in a section is inside the same groups, so it holds for
    /// each of them. A cell keeps the list's leading side, so a swiped row
    /// slides out to the sheet's edge.
    static func sectionTrailing(_ section: TreeSection) -> CGFloat {
        inset + RowPlace.cardInset(blocks: section.layers.filter { $0.tint.flatMap(WorkspaceTint.init(rawValue:)) != nil }.count)
    }

    /// How much a lifted row and what it carries fade in place, as the
    /// desktop's dragged rows do (`.sval-row-dragging`,
    /// `--opacity-deemphasized-strong`).
    static let dimmed = 0.6

    /// The desktop's row height, whose top and bottom `TreeDrop.edge`
    /// mean "beside this row" (`--sval-row-h`, `DROP_EDGE_PX`). A phone row
    /// is read at the same proportions: its top and bottom quarters.
    static let desktopRow = TreeDrop.edge * 4

    /// What a drag of `id` over the list would do with the finger at
    /// `point`, as the desktop's panel reads it (`SvalPanelDrag`,
    /// `dropIntent`): before or after a row, first in an open group, at the
    /// Workspace's end below the last row, or a row's middle. Off every
    /// row, the nearest row is read at its edge, so a finger inside the
    /// list always aims somewhere. Nil for a drop that changes nothing.
    static func aim(_ index: OutlineIndex, dragged id: String, spots: [ListSpot], at point: CGPoint,
                    workspace: String, ends: Bool, makesGroups: Bool) -> ListAim? {
        guard let last = spots.last else { return nil }
        if ends, point.y >= last.frame.maxY {
            let end = DropOver(id: workspace, kind: .workspace, expanded: true)
            guard index.dropPlan(id, over: end, .end) != nil else { return nil }
            return .line(y: last.frame.maxY, depth: 0, over: end, kind: .end)
        }
        func distance(_ spot: ListSpot) -> CGFloat {
            max(spot.frame.minY - point.y, point.y - spot.frame.maxY, 0)
        }
        guard let spot = spots.min(by: { distance($0) < distance($1) }) else { return nil }
        let height = spot.frame.height
        let y = min(max(point.y - spot.frame.minY, 0), height - 0.5)
        let rowId = TreeLines.rowId(of: spot.line.id)
        guard let row = index.row(rowId) else { return nil }
        let over = DropOver(id: rowId, kind: spot.line.panes == nil ? row.kind : .split,
                            expanded: spot.line.group?.open == true)
        let place = RowPlace(spot.line)
        let leading = spot.line.panes == nil ? place.indent : place.cardLeading
        let width = spot.frame.width - inset - leading - place.trailing
        let kind = index.dropIntent(id, over: over, x: point.x - spot.frame.minX - inset - leading,
                                    y: y * desktopRow / height, w: width, h: desktopRow, makesGroups: makesGroups)
        switch kind {
        case .before, .after, .firstChild:
            guard index.dropPlan(id, over: over, kind) != nil else { return nil }
            // The line sits at the row's top or bottom, indented to the depth
            // the row lands at (`SvalPanelDrag.paint`).
            return .line(y: kind == .before ? spot.frame.minY : spot.frame.maxY,
                         depth: spot.line.depth + (kind == .firstChild ? 1 : 0), over: over, kind: kind)
        case .into, .newGroup, .split, .join, .merge, .refused(full: true):
            return .middle(id: spot.line.id, over: over, kind: kind)
        default:
            return nil
        }
    }
}

/// A drawn row of the list and its frame in the list.
struct ListSpot: Equatable {
    let line: TreeLine
    let frame: CGRect
}

/// What a drag over the list would do.
enum ListAim: Equatable {
    /// Between rows: where the line goes, the depth it is indented to, and
    /// the landing.
    case line(y: CGFloat, depth: Int, over: DropOver, kind: DropKind)
    /// A row's middle: into a closed group, or a tab's or split's halves.
    case middle(id: String, over: DropOver, kind: DropKind)
}

/// Where a dragged row lands between rows in the list: a line, with a ring
/// at its start (`sval-drop-line`).
final class DropLineView: UIView {
    /// The ring's radius, and half the line's frame height.
    static let ring: CGFloat = 4
    var color = UIColor.tintColor { didSet { setNeedsDisplay() } }
    var ring = UIColor.systemBackground { didSet { setNeedsDisplay() } }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        isUserInteractionEnabled = false
        contentMode = .redraw
    }

    required init?(coder: NSCoder) { nil }

    override func draw(_ rect: CGRect) {
        let r = Self.ring
        color.setFill()
        UIRectFill(CGRect(x: 2 * r - 1, y: r - 1, width: bounds.width - 2 * r + 1, height: 2))
        let circle = UIBezierPath(ovalIn: CGRect(x: 1, y: 1, width: 2 * r - 2, height: 2 * r - 2))
        ring.setFill()
        circle.fill()
        color.setStroke()
        circle.lineWidth = 2
        circle.stroke()
    }
}

/// Where a list row sits among the coloured groups around it: its
/// indent, and each coloured group's level and colour, outermost first.
struct RowPlace {
    let indent: CGFloat
    let blocks: [(level: Int, tint: WorkspaceTint)]

    init(_ line: TreeLine) {
        indent = CGFloat(line.depth) * ListMetrics.indent
        blocks = line.tints.enumerated().compactMap { level, tint in
            tint.flatMap(WorkspaceTint.init(rawValue:)).map { (level, $0) }
        }
    }

    /// How far the innermost block's card ends inside the outermost one's,
    /// where the row's cell ends (`ListMetrics.sectionTrailing`).
    var cardInset: CGFloat { Self.cardInset(blocks: blocks.count) }

    static func cardInset(blocks: Int) -> CGFloat { CGFloat(max(blocks - 1, 0)) * ListMetrics.nestTrailing }

    /// How far the row's own target ends inside its cell's trailing edge:
    /// clear of its coloured block's edge, as a nested block is.
    var trailing: CGFloat { blocks.isEmpty ? 0 : ListMetrics.nestTrailing }

    /// Where a card nested inside the innermost block starts, as a split's
    /// or the front row's.
    var cardLeading: CGFloat { blocks.last.map { CGFloat($0.level) * ListMetrics.indent + ListMetrics.indent } ?? 0 }

    /// The cell's background: from the front row's card at the leading
    /// edge to the cell's end, which is the innermost block's edge, so the
    /// press highlight stays on the group's card.
    var backgroundInsets: NSDirectionalEdgeInsets {
        NSDirectionalEdgeInsets(top: 0, leading: ListMetrics.inset + cardLeading, bottom: 0, trailing: 0)
    }

    /// The row's text and muted text: on a coloured group's block, solved
    /// on the innermost block (`sval-panel.css`, `data-sval-fill`), else
    /// the sheet's.
    func ink(_ theme: Theme) -> (text: Color, muted: Color) {
        let surface = DesktopColor.Surface(l: theme.sheetLightness, surfaceDark: theme.dark, dir: theme.blockDir)
        guard let tint = blocks.last?.tint, let ink = DesktopColor.groupInk(tint.rawValue, on: surface) else {
            return (theme.text, theme.muted)
        }
        return (Color(hex: ink.text), Color(hex: ink.muted))
    }
}

/// The row in front: inside a coloured group it lifts as a card of its own
/// within the group's block, as a split does, never to the block's edges;
/// outside any group it takes the accent wash.
struct FrontCard: View {
    let place: RowPlace
    let front: Bool
    let theme: Theme

    var body: some View {
        if front {
            if let last = place.blocks.last {
                RoundedRectangle(cornerRadius: WorkspaceSheet.cardCorner)
                    .fill(GroupBlock.color(last.tint, dark: theme.dark, surface: theme.sheetLightness,
                                           blockDir: theme.blockDir, selected: true))
                    .padding(.leading, place.cardLeading)
                    .padding(.trailing, place.trailing)
                    .padding(.vertical, WorkspaceSheet.cardGap)
            } else {
                RoundedRectangle(cornerRadius: WorkspaceSheet.cardCorner).fill(theme.accentWash)
            }
        }
    }
}

/// A row's drop mark, as the desktop panel draws them (`SvalPanelDrag.paint`):
/// an outline on a closed group a drop would go into, and on a tab's or
/// split's middle its two halves. The two rows waiting on a new group's
/// name keep dashed outlines. A landing between rows is the list's line
/// (`DropLineView`).
struct RowDropMark: View {
    let id: String
    let leading: CGFloat
    let trailing: CGFloat
    let marked: Bool
    let dropState: TreeDropState
    let theme: Theme

    var body: some View {
        let color = theme.accent
        ZStack {
            if marked {
                RoundedRectangle(cornerRadius: WorkspaceSheet.cardCorner)
                    .strokeBorder(color, style: StrokeStyle(lineWidth: Stroke.ring, dash: Stroke.dash))
            }
            if let hover = dropState.hover, hover.id == id,
               hover.writes || hover.halves.map({ $0.group || $0.splits }) == true {
                if hover.kind == .into {
                    RoundedRectangle(cornerRadius: WorkspaceSheet.cardCorner)
                        .fill(color.opacity(0.3))
                        .strokeBorder(color, lineWidth: Stroke.ring)
                } else if let halves = hover.halves {
                    DropHalvesMark(halves: halves, onSplit: hover.kind != .newGroup, color: color,
                                   muted: theme.muted, cover: theme.sheet)
                }
            }
        }
        .padding(.leading, leading)
        .padding(.trailing, trailing)
        .allowsHitTesting(false)
    }
}

/// Whether a list row's cell has its swipe actions open. The cell's
/// configuration state sets it; the row reads it, so the row redraws
/// without a new content configuration.
@MainActor
@Observable
final class CellSwipe {
    var open = false
}

/// A tab's row in the list. The collection view's cell is the button: its
/// tap, menu, swipe and drag are the system's.
struct TreeTabRow: View {
    let model: AppModel
    /// The tab's row, read here so a change to it redraws this row alone.
    let box: RowBox
    let line: TreeLine
    /// While the swipe actions show, they stand in for the row's ×.
    let swipe: CellSwipe
    let theme: Theme
    let editing: Bool
    let ticked: Bool
    let marked: Bool
    let dimmed: Bool
    let dropState: TreeDropState
    let onClose: () -> Void

    var body: some View {
        let row = box.row
        let browser: Browser = model.browser
        let front = row.id == browser.currentTabId
        let elsewhere = Browser.openable(row) == nil && row.url != nil
        let playing = browser.playingTabs.contains(row.id)
        let muted = browser.mutedTabs.contains(row.id)
        let place = RowPlace(line)
        let ink = place.ink(theme)
        HStack(spacing: Space.rowGap) {
            if editing {
                SelectionTick(ticked: ticked, tick: theme.action, off: ink.muted)
            }
            SiteTile(row: row, size: Tile.row)
                .opacity(elsewhere ? Dim.elsewhere : 1)
            // The title, and under it the page's site as the bar shows
            // it: a title alone can be the same on many pages, and the
            // site tells them apart (Teevan et al., CHI 2009).
            VStack(alignment: .leading, spacing: Space.lines) {
                Text(row.displayTitle)
                    .font(.system(.body, weight: front ? .semibold : .regular))
                    .foregroundStyle(elsewhere ? ink.muted : ink.text)
                    .titleLines()
                if let site = row.site {
                    Text(site)
                        .font(.system(.footnote))
                        .foregroundStyle(ink.muted)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // The list's separator starts under the title.
            .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
            if elsewhere {
                Image(systemName: "laptopcomputer")
                    .font(Glyph.status)
                    .foregroundStyle(ink.muted)
                    .frame(width: 36, height: 36)
                    .accessibilityLabel("Can't open on \(UIDevice.current.model)")
            }
            // Every row closes from its ×, which a playing tab's speaker
            // takes the place of (14b1).
            if !swipe.open {
                RowAccessory(playing: playing, muted: muted, editing: editing, title: row.displayTitle,
                             ink: ink.muted, accent: theme.accent,
                             onMute: { browser.toggleMute(row.id) }, onClose: onClose)
            }
        }
        // The list's separator ends where the row's own content does.
        .alignmentGuide(.listRowSeparatorTrailing) { $0[.trailing] }
        .padding(.leading, Space.rowInset + place.indent)
        .padding(.trailing, 2)
        .rowHeight(RowMetrics.tab)
        .background { FrontCard(place: place, front: front, theme: theme) }
        .opacity(dimmed ? ListMetrics.dimmed : 1)
        .overlay {
            RowDropMark(id: line.id, leading: place.indent, trailing: place.trailing, marked: marked,
                        dropState: dropState, theme: theme)
        }
        // One element, as a grid card is: the title, the site, then any
        // state, with × and the speaker as actions.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.spokenLabel(elsewhere: elsewhere, playing: playing))
        .accessibilityAddTraits(front || (editing && ticked) ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction(named: "Close", onClose)
        .accessibilityActions {
            if playing {
                Button(muted ? "Unmute" : "Mute") { browser.toggleMute(row.id) }
            }
        }
    }
}

/// A group's row in the list: its chevron, emoji or folder, name and the
/// tabs inside it at any depth. A tap opens or closes it.
struct TreeGroupRow: View {
    /// The group's row, read here so a change to it redraws this row alone.
    let box: RowBox
    let line: TreeLine
    let header: GroupHeader
    let theme: Theme
    let marked: Bool
    let dimmed: Bool
    let dropState: TreeDropState

    var body: some View {
        let row = box.row
        let place = RowPlace(line)
        let ink = place.ink(theme)
        HStack(spacing: Space.rowGap) {
            Chevron(open: header.open, color: ink.muted)
                .frame(width: 14)
            GroupMark(row: row, open: header.open, theme: theme)
            Text(row.displayTitle)
                .font(.system(.body, weight: .semibold))
                .foregroundStyle(ink.text)
                .titleLines()
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(header.count)")
                .font(.system(.subheadline))
                .monospacedDigit()
                .foregroundStyle(ink.muted)
                .padding(.trailing, 10)
        }
        .padding(.leading, Space.rowInset + place.indent)
        .rowHeight(RowMetrics.group)
        .opacity(dimmed ? ListMetrics.dimmed : 1)
        .overlay {
            RowDropMark(id: line.id, leading: place.indent, trailing: place.trailing, marked: marked,
                        dropState: dropState, theme: theme)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(header.open ? "Expanded" : "Collapsed")
        .accessibilityAddTraits(.isButton)
    }
}

/// A split's line in the list: its tray of panes (`SplitRow`), reading its
/// rows' boxes so a pane's title redraws this line alone.
struct TreeSplitRow: View {
    let model: AppModel
    let split: RowBox
    let panes: [RowBox]
    let line: TreeLine
    /// While the swipe actions show, the split's count steps aside for them.
    let swipe: CellSwipe
    let theme: Theme
    let marked: Bool
    let dimmed: Bool
    let dropState: TreeDropState
    let onOpen: (String?) -> Void
    let menu: (OutlineRow, OutlineRow, [OutlineRow]) -> [[MenuItem]]

    var body: some View {
        let split = split.row
        let panes = panes.map(\.row)
        let place = RowPlace(line)
        let front = panes.contains { $0.id == (model.browser as Browser).currentTabId }
        // The split's card starts where a group nested at its depth would,
        // and ends 6pt inside its group's card. The tray, which starts at
        // the glyph's left edge, keeps the same room to the card's right
        // edge as to its left.
        let trailing = place.trailing + (Space.rowInset + place.indent + 1 - place.cardLeading)
        SplitRow(split: split, panes: panes, indent: place.indent, trailing: trailing,
                 countTrailing: 10, countShown: !swipe.open, group: place.blocks.last?.tint,
                 onOpen: onOpen) { pane in
            MenuItems(sections: menu(pane, split, panes))
        }
        // The list's separator ends where the tray does.
        .alignmentGuide(.listRowSeparatorTrailing) { $0[.trailing] - trailing }
        .background { FrontCard(place: place, front: front, theme: theme) }
        .opacity(dimmed ? ListMetrics.dimmed : 1)
        .overlay {
            RowDropMark(id: line.id, leading: place.cardLeading, trailing: place.trailing, marked: marked,
                        dropState: dropState, theme: theme)
        }
    }
}

/// A group's emoji, or its folder in its colour's ink: the block carries
/// the colour, and the name stays in the text colour, which reads on every
/// block (`sval-panel.css`, `data-sval-fill="own"`).
struct GroupMark: View {
    let row: OutlineRow
    let open: Bool
    let theme: Theme

    var body: some View {
        let tint = row.color.flatMap(WorkspaceTint.init(rawValue:))
        if let emoji = row.emoji, !emoji.isEmpty {
            Text(emoji).font(.system(size: 20)).accessibilityIgnoresInvertColors().frame(width: Tile.row)
        } else {
            Image(systemName: open ? "folder" : "folder.fill")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(tint?.swatch(dark: theme.dark) ?? theme.body)
                .frame(width: Tile.row)
        }
    }
}

extension OutlineRow {
    /// A tab's site, as the bar shows the page in front's.
    var site: String? {
        guard let host = url.flatMap(URL.init(string:))?.host() else { return nil }
        return SiteRules.site(of: host) ?? host
    }

    /// A tab row's spoken label: its title, its site, and whether it plays
    /// or can't open here.
    @MainActor func spokenLabel(elsewhere: Bool, playing: Bool) -> String {
        [displayTitle, site, playing ? "playing" : nil, elsewhere ? "can't open on \(UIDevice.current.model)" : nil]
            .compactMap { $0 }.joined(separator: ", ")
    }
}

/// A list section's coloured group blocks, drawn behind its rows: each
/// coloured group around the section from its level's indent, a nested one
/// as a card inside its parent's, rounded where the group starts or ends.
/// The layers ride in the decoration's kind, as `GridBox`'s do.
final class ListBox: UICollectionReusableView {
    static var theme: Theme?

    /// The kind for `layers`, the groups around a section; a group in
    /// `dimmed` was lifted by a drag, and its block fades with its rows.
    static func kind(_ layers: [GroupLayer], groups: [String], dimmed: Set<String>, theme: Theme) -> String {
        "list|" + zip(layers, groups).map { layer, group in
            "\(layer.tint ?? "-"):\(layer.top ? 1 : 0):\(layer.bottom ? 1 : 0):\(dimmed.contains(group) ? 1 : 0)"
        }.joined(separator: ",") + "|\(theme.dark ? 1 : 0):\(theme.sheetLightness):\(theme.blockDir)"
    }

    /// Whether any group around a section draws a block.
    static func draws(_ layers: [GroupLayer]) -> Bool {
        layers.contains { $0.tint.flatMap(WorkspaceTint.init(rawValue:)) != nil }
    }

    /// One group around a section, as its kind spells it.
    struct Layer: Equatable {
        var tint: WorkspaceTint?
        var top: Bool
        var bottom: Bool
        var dimmed = false
    }

    /// A coloured group's block in a box `size` big: its frame, and the
    /// corners rounded where the group starts or ends.
    struct Block: Equatable {
        var tint: WorkspaceTint
        var dimmed: Bool
        var frame: CGRect
        var corners: CACornerMask
    }

    /// The blocks of `layers` in a box `size` big, outermost first, so each
    /// nested block sits over its parent's.
    static func blocks(_ layers: [Layer], size: CGSize) -> [Block] {
        var blocks: [Block] = []
        for (level, layer) in layers.enumerated() {
            guard let tint = layer.tint else { continue }
            let nested = blocks.count
            let top = nested > 0 && layer.top ? WorkspaceSheet.cardGap : 0
            let bottom = nested > 0 && layer.bottom ? WorkspaceSheet.cardGap : 0
            let leading = ListMetrics.inset + CGFloat(level) * ListMetrics.indent
            let trailing = ListMetrics.inset + CGFloat(nested) * ListMetrics.nestTrailing
            let frame = CGRect(x: leading, y: top, width: size.width - leading - trailing,
                               height: size.height - top - bottom)
            blocks.append(Block(tint: tint, dimmed: layer.dimmed, frame: frame, corners: .rounding(top: layer.top, bottom: layer.bottom)))
        }
        return blocks
    }

    static func layers(ofKind kind: String?) -> [Layer] {
        let spec = kind?.split(separator: "|").dropFirst().first ?? ""
        return spec.split(separator: ",").map { part in
            let bits = part.split(separator: ":")
            return Layer(tint: WorkspaceTint(rawValue: String(bits[0])), top: bits[1] == "1", bottom: bits[2] == "1",
                         dimmed: bits[3] == "1")
        }
    }

    private var layers: [Layer] = []
    /// One plain view per block, its background filled and rounded by Core
    /// Animation. A box drawn in `draw(_:)` is drawn into a bitmap of its
    /// whole section at the screen's scale (`CALayer.contentsScale`).
    private var pieces: [UIView] = []

    override func apply(_ attributes: UICollectionViewLayoutAttributes) {
        super.apply(attributes)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        layers = Self.layers(ofKind: attributes.representedElementKind)
        let blocks = Self.blocks(layers, size: attributes.size)
        while pieces.count < blocks.count {
            let piece = UIView()
            piece.isUserInteractionEnabled = false
            piece.layer.cornerRadius = WorkspaceSheet.cardCorner
            // `UIBezierPath(roundedRect:byRoundingCorners:cornerRadii:)`,
            // which drew the blocks, starts its corners at the continuous
            // curve's expansion factor.
            piece.layer.cornerCurve = .continuous
            addSubview(piece)
            pieces.append(piece)
        }
        while pieces.count > blocks.count { pieces.removeLast().removeFromSuperview() }
        if let theme = Self.theme {
            for (piece, block) in zip(pieces, blocks) {
                piece.backgroundColor = UIColor(GroupBlock.color(block.tint, dark: theme.dark, surface: theme.sheetLightness,
                                                                 blockDir: theme.blockDir))
                    .withAlphaComponent(block.dimmed ? ListMetrics.dimmed : 1)
                piece.layer.maskedCorners = block.corners
            }
        }
        // Placed here, inside the collection view's animation of the box's
        // frame, the blocks move with the box.
        place(blocks)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        place(Self.blocks(layers, size: bounds.size))
    }

    private func place(_ blocks: [Block]) {
        for (piece, block) in zip(pieces, blocks) where piece.frame != block.frame {
            piece.frame = block.frame
        }
    }
}

extension CACornerMask {
    /// The top two corners where `top`, and the bottom two where `bottom`,
    /// in a view's coordinates, whose y grows downward.
    static func rounding(top: Bool, bottom: Bool) -> CACornerMask {
        var corners: CACornerMask = []
        if top { corners.formUnion([.layerMinXMinYCorner, .layerMaxXMinYCorner]) }
        if bottom { corners.formUnion([.layerMinXMaxYCorner, .layerMaxXMaxYCorner]) }
        return corners
    }
}
