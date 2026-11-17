// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit

/// A mark at the corner of a tile, a button or the sync moon: its glyph on
/// an opaque disc, ringed in the surface under it so it stands clear of
/// what it sits on. It's a mark only, too small to tap; what it marks is
/// said by the control it sits on, or by its own label.
struct Badge<Mark: View>: View {
    let diameter: CGFloat
    let fill: Color
    /// The surface the badge sits on, which rings it.
    let ring: Color
    var ringWidth: CGFloat = 2
    @ViewBuilder let mark: () -> Mark

    var body: some View {
        mark()
            .frame(width: diameter, height: diameter)
            .background(fill, in: .circle)
            .overlay { Circle().strokeBorder(ring, lineWidth: ringWidth).padding(-ringWidth) }
    }
}

/// A dot for each page, step or Workspace, the current one a wider pill,
/// as the desktop's Workspace strip marks where it stands. With
/// `through`, the steps before the current one are lit too.
struct PageDots: View {
    let count: Int
    let current: Int
    let on: Color
    let off: Color
    var height: CGFloat = 5
    var wide: CGFloat = 14
    var through = false

    var body: some View {
        HStack(spacing: height - 1) {
            ForEach(0..<count, id: \.self) { index in
                Capsule()
                    .fill(index == current || (through && index < current) ? on : off)
                    .frame(width: index == current ? wide : height, height: height)
            }
        }
    }
}

/// One item of a long-press menu. The list draws its menus in SwiftUI and
/// the grid's collection view in UIKit, which pairs them with its drag;
/// both draw the same items from one list of these.
struct MenuItem {
    let title: String
    let symbol: String
    var destructive = false
    var disabled = false
    let action: () -> Void
}

/// A menu's items in SwiftUI, a divider between sections.
struct MenuItems: View {
    let sections: [[MenuItem]]

    var body: some View {
        let sections = sections.filter { !$0.isEmpty }
        ForEach(sections.indices, id: \.self) { index in
            if index > 0 { Divider() }
            ForEach(sections[index].indices, id: \.self) { at in
                let item = sections[index][at]
                Button(item.title, systemImage: item.symbol, role: item.destructive ? .destructive : nil, action: item.action)
                    .disabled(item.disabled)
            }
        }
    }
}

extension UIMenu {
    /// A menu's items in UIKit, each section inline.
    convenience init(sections: [[MenuItem]]) {
        self.init(children: sections.filter { !$0.isEmpty }.map { section in
            UIMenu(options: .displayInline, children: section.map { item in
                var attributes: UIMenuElement.Attributes = []
                if item.destructive { attributes.insert(.destructive) }
                if item.disabled { attributes.insert(.disabled) }
                return UIAction(title: item.title, image: UIImage(systemName: item.symbol), attributes: attributes) { _ in
                    item.action()
                }
            })
        })
    }
}

/// Moving a pane along its split, named for the way its panes lie: side
/// by side in a tray or a sideways split, stacked in an upright one.
enum PaneMove {
    static func labels(sideways: Bool) -> (back: (title: String, symbol: String), ahead: (title: String, symbol: String)) {
        sideways ? (("Move Pane Left", "arrow.left"), ("Move Pane Right", "arrow.right"))
            : (("Move Pane Up", "arrow.up"), ("Move Pane Down", "arrow.down"))
    }
}

/// New Private Tab in a menu, marked with the private mask wherever it
/// shows, beside New Tab or on its own.
struct NewPrivateTabButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) { Label("New Private Tab", image: "private") }
    }
}

/// The round close button at a card's or a sheet's corner: the system's
/// mark on a circle of glass, with a 44pt target however small it is
/// drawn.
struct CloseCircle: View {
    var label = "Close"
    var diameter: CGFloat = 44
    /// The circle's glass: in the Workspace's colour where the card is.
    var glass: Glass = .regular.interactive()
    let action: () -> Void

    var body: some View {
        Button(role: .close, action: action) {
            Image(systemName: "xmark")
                .font(.system(size: diameter < 44 ? 14 : 17, weight: .semibold))
                .frame(width: diameter, height: diameter)
                .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .glassEffect(glass, in: .circle)
        .contentShape(.circle.inset(by: min(0, (diameter - 44) / 2)))
        .accessibilityLabel(label)
    }
}

/// A tab's trailing control in the list and on a grid card: the speaker,
/// which mutes, while its media plays, else × to close it; nothing while
/// rows are being picked.
struct RowAccessory: View {
    let playing: Bool
    let muted: Bool
    let editing: Bool
    /// What × closes, for its label.
    let title: String
    let ink: Color
    let accent: Color
    /// The control's height: the list row's target, or the card's line.
    var height: CGFloat = 44
    let onMute: () -> Void
    let onClose: () -> Void

    var body: some View {
        if playing {
            Button(action: onMute) {
                Image(systemName: muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(accent)
                    .frame(width: 44, height: height)
                    .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(muted ? "Unmute" : "Mute")
        } else if !editing {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(ink)
                    .frame(width: 44, height: height)
                    .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Close \(title)")
        }
    }
}

/// The tick on a row or a card while tabs are being picked. Over a
/// card's picture, which can be any colour, it sits on a white disc.
struct SelectionTick: View {
    let ticked: Bool
    let tick: Color
    /// The empty circle's colour where it sits on the sheet.
    let off: Color
    var onPicture = false

    var body: some View {
        Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 22))
            .foregroundStyle(ticked ? tick : (onPicture ? Color(hex: 0x060A2E, opacity: 0.55) : off))
            .background { if onPicture { Circle().fill(.white.opacity(0.9)).padding(1) } }
            .accessibilityHidden(true)
    }
}

/// The chevron of a row that opens a page or a choice, and, given `open`,
/// of a group or a Workspace that opens in place, turned down while open.
struct Chevron: View {
    var open: Bool?
    let color: Color

    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(color)
            .rotationEffect(.degrees(open == true ? 90 : 0))
            .accessibilityHidden(true)
    }
}

/// A section's caption, in a form's header or over a list's rows: the
/// system's footnote in the surface's muted ink, in the case it's written
/// in.
struct SectionCaption: View {
    let text: String
    let color: Color

    init(_ text: String, color: Color) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(color)
            .textCase(nil)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A place a Move to… sheet can move to: its glyph and name, indented
/// for its depth, and Current where what's moving already is, which it
/// can't move to.
struct DestinationRow: View {
    let text: String
    let icon: String
    let indent: CGFloat
    let current: Bool
    let theme: Theme
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                Image(systemName: icon).font(.system(size: 16)).frame(width: 20).opacity(0.85)
                Text(text).font(.system(.body)).lineLimit(1)
                Spacer(minLength: 4)
                if current {
                    Text("Current").font(.system(.footnote))
                }
            }
            .foregroundStyle(current ? theme.muted : theme.text)
            .padding(.leading, indent)
            .padding(.trailing, 14)
            .frame(minHeight: RowMetrics.chooser)
            .contentShape(.rect)
        }
        .disabled(current)
    }
}

/// A Move to… sheet's row that makes a new place first: New Group…, New
/// Folder….
struct NewDestinationRow: View {
    let text: String
    let indent: CGFloat
    let theme: Theme
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                Image(systemName: "folder.badge.plus").font(.system(size: 16)).frame(width: 20)
                Text(text).font(.system(.body, weight: .medium))
                Spacer()
            }
            .foregroundStyle(theme.action)
            .padding(.leading, indent)
            .padding(.trailing, 14)
            .frame(minHeight: RowMetrics.chooser)
            .contentShape(.rect)
        }
    }
}
