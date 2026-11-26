// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit
import UniformTypeIdentifiers

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
    let dropState: TreeDropState
    let onClose: () -> Void

    private var row: OutlineRow { box.row }

    var body: some View {
        let browser: Browser = model.browser
        let front = row.id == browser.currentTabId
        let elsewhere = Browser.openable(row) == nil && row.url != nil
        let playing = browser.playingTabs.contains(row.id)
        let muted = browser.mutedTabs.contains(row.id)
        CardPicture(row: row, height: height, elsewhere: elsewhere, theme: theme, top: GridMetrics.bar)
            .overlay { GridHalves(id: row.id, dropState: dropState, theme: theme) }
            .overlay(alignment: .top) {
                CardBar(theme: theme, title: row.displayTitle, bold: front, dim: elsewhere,
                        closeLabel: "Close \(row.displayTitle)", onClose: onClose) {
                    SiteTile(row: row, size: Tile.strip).opacity(elsewhere ? Dim.elsewhere : 1)
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
            .cardFrame(theme)
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

    /// A media control in the picture's corner, on a disc of the card's
    /// fill so it reads over any page.
    private func mediaButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: Glyph.control, weight: .semibold))
                .foregroundStyle(theme.accent)
                .frame(width: 38, height: 38)
                .background(theme.cell, in: .circle)
                .contentShape(.circle)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(label)
    }

    private func label(elsewhere: Bool, playing: Bool) -> String {
        var parts = [row.displayTitle]
        if let site = row.site { parts.append(site) }
        if playing { parts.append("playing") }
        if elsewhere { parts.append("can't open on \(UIDevice.current.model)") }
        return parts.joined(separator: ", ")
    }
}

/// The bar over the top of a card's picture: icons, the title cut to fit,
/// and ×, on the card's fill so it reads over any page.
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
                    .font(Glyph.mark)
                    .foregroundStyle(theme.muted)
                    .frame(width: 36, height: GridMetrics.bar)
                    .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(closeLabel)
        }
        .padding(.leading, 9)
        .frame(height: GridMetrics.bar)
        .background(theme.cell.opacity(0.92))
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
    /// Whether the phone is sideways, where a split's two panes sit side
    /// by side, as `SplitStage` shows them.
    let sideways: Bool
    let dropState: TreeDropState
    let onClose: () -> Void

    var body: some View {
        let panes = panes.map(\.row)
        let split = split.row
        let front = panes.contains { $0.id == (model.browser as Browser).currentTabId }
        let first = panes[0]
        let title = split.name.isEmpty ? first.displayTitle : split.name
        let closeName = panes.count == 2 ? "Close Both" : "Close All"
        SplitPicture(panes: panes, height: height, theme: theme, sideways: sideways)
            .overlay { GridHalves(id: split.id, dropState: dropState, theme: theme) }
            .overlay(alignment: .top) {
                CardBar(theme: theme, title: title, bold: front, closeLabel: closeName, onClose: onClose) {
                    // The split's mark goes first, so the card reads as a
                    // split however far its title is cut.
                    Image(systemName: SplitPicture.symbol(sideways: sideways))
                        .font(Glyph.mark)
                        .foregroundStyle(theme.muted)
                    HStack(spacing: -5) {
                        ForEach(panes, id: \.id) { pane in
                            SiteTile(row: pane, size: Tile.strip)
                                .overlay {
                                    RoundedRectangle(cornerRadius: Radius.tile(Tile.strip))
                                        .strokeBorder(theme.sheet, lineWidth: Stroke.ring)
                                }
                        }
                    }
                    .padding(.trailing, 2)
                }
            }
            .cardFrame(theme)
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
    let dropState: TreeDropState
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
                        ForEach(icons.map(\.row), id: \.id) { tab in SiteTile(row: tab, size: Tile.pane) }
                    }
                    .padding(.trailing, 6)
                }
                Text("\(header.count)")
                    .font(.system(.subheadline))
                    .monospacedDigit()
                    .foregroundStyle(theme.muted)
                Chevron(open: open, color: theme.muted)
            }
            .padding(.horizontal, Space.rowInset)
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
            RoundedRectangle(cornerRadius: Radius.tile(size)).fill(theme.cell)
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
/// while the phone has no picture of it (15c).
struct CardPicture: View {
    let row: OutlineRow
    let height: CGFloat
    let elsewhere: Bool
    let theme: Theme
    /// The bar over the picture's top, which the icon in its place sits
    /// below.
    var top: CGFloat = 0

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
                        .transition(.opacity.animation(Motion.disclose))
                } else {
                    VStack(spacing: 8) {
                        SiteTile(row: row, size: Tile.large).opacity(elsewhere ? Dim.elsewhere : 1)
                        if let site = row.site {
                            Text(site)
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
                    .padding(.horizontal, Space.rowInset)
                    .frame(maxHeight: .infinity)
                    .padding(.top, top)
                }
            }
    }
}

/// A split's picture: each pane's, two stacked upright and side by side
/// sideways, three as one over two, four as two by two, each pane ringed
/// on the sheet's colour as `SplitStage` draws them (15e).
struct SplitPicture: View {
    let panes: [OutlineRow]
    let height: CGFloat
    let theme: Theme
    let sideways: Bool

    /// The split's symbol, its panes laid out as this picture lays out two.
    static func symbol(sideways: Bool) -> String {
        sideways ? "rectangle.split.2x1" : "rectangle.split.1x2"
    }

    var body: some View {
        let rows: [[OutlineRow]] = switch panes.count {
        case 2: sideways ? [[panes[0], panes[1]]] : [[panes[0]], [panes[1]]]
        case 3: [[panes[0]], [panes[1], panes[2]]]
        default: [Array(panes.prefix(2)), Array(panes.dropFirst(2).prefix(2))]
        }
        VStack(spacing: 6) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, line in
                HStack(spacing: 6) {
                    ForEach(line, id: \.id) { row in
                        cell(row)
                    }
                }
            }
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .background(theme.sheet)
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
            .clipShape(.rect(cornerRadius: 6))
            .overlay {
                RoundedRectangle(cornerRadius: 6).strokeBorder(theme.dark ? theme.divider : theme.line, lineWidth: Stroke.hairline)
            }
    }
}

/// The tab in front's ring: 2.5pt of accent outside a 2pt gap (15c).
struct FrontRing: ViewModifier {
    let front: Bool
    let color: Color
    let radius = Radius.picture

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

extension View {
    /// A card's corners and its 1pt ring, around the picture and bar.
    func cardFrame(_ theme: Theme) -> some View {
        clipShape(.rect(cornerRadius: Radius.picture))
            .overlay { RoundedRectangle(cornerRadius: Radius.picture).strokeBorder(theme.divider, lineWidth: Stroke.hairline) }
    }
}
