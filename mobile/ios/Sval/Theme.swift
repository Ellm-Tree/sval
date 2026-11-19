// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit

/// Sval's colours on a phone. An untinted surface takes the design
/// handoff's tokens (`handoff/mobile-ios/to-code.md`, "Tokens"). A surface
/// in a Workspace's colour, preset or custom, takes every colour from the
/// desktop's own maths ([`DesktopColor`]), which solves each one on the
/// surface so it reads there.
struct Theme {
    /// Whether the surface reads dark, which picks the ink: the scheme's,
    /// or for a tinted surface the side its colour's text is solved on.
    let dark: Bool
    /// The Workspace colour the surface takes, as the bar does.
    let tint: WorkspaceTint?
    /// Whether the surface is the private session's.
    let isPrivate: Bool
    /// The tinted surface's colours, solved for the appearance.
    private let window: DesktopColor.Window?

    init(_ scheme: ColorScheme, tint token: String? = nil) {
        let tint = token.flatMap(WorkspaceTint.init(rawValue:))
        self.tint = tint
        isPrivate = token == Theme.privateToken
        let window = tint.flatMap { DesktopColor.window($0.rawValue, dark: scheme == .dark) }
        self.window = window
        dark = isPrivate || (window.map { !$0.darkInk } ?? (scheme == .dark))
    }

    /// The appearance the system's own controls take on this surface, so
    /// a navigation title, a toolbar button or a field's text reads on it
    /// whatever the phone's appearance.
    var colorScheme: ColorScheme { dark ? .dark : .light }

    /// How opaque the Workspace's colour lies over the Workspace sheet's
    /// glass (14b1): thin enough for the glass to show, so the bar and its
    /// sheet read as one thing.
    static let glassSheet = 0.8

    /// The token that puts a surface in the private palette, whatever the
    /// appearance (round 5, the desktop's private header palette).
    static let privateToken = "private"
    /// An untinted dark surface: the desktop's untinted window and panel
    /// (`--sval-palette-ink-850`, `sval-header.css`).
    static let navy: UInt32 = 0x0A1140
    /// A card over an untinted dark surface, as the desktop's dialogs are
    /// (`--sval-surface` over `--sval-palette-ink-850`, `sval-dialog.css`).
    static let card: UInt32 = 0x121D4B

    private func pick(_ dark: UInt32, _ light: UInt32) -> Color {
        Color(hex: self.dark ? dark : light)
    }

    var sheet: Color { isPrivate ? Color(hex: 0x0B0628) : window.map { Color(hex: $0.tint) } ?? pick(Theme.card, 0xEEF2FC) }
    /// The oklch lightness group blocks step off: the Workspace's window,
    /// or with no colour Sval's own (`untintedSurface`), as the desktop
    /// panel and the group editor's preview step them.
    var sheetLightness: Double { window?.lightness ?? DesktopColor.surface(ofWorkspace: nil, dark: dark).l }
    /// Which way blocks step off the sheet (`--sval-block-dir`): lighter,
    /// except on a dark tint too light for the panel's ink to step above.
    var blockDir: Double { window?.blockDir ?? 1 }
    var cell: Color { isPrivate ? Color(hex: 0x0E0730) : window.map { Color(hex: $0.field) } ?? pick(0x1A2758, 0xFFFFFF) }
    var popup: Color { cell }
    var menu: Color { isPrivate ? Color(hex: 0x1D1450) : pick(0x18225A, 0xF7F9FE) }
    /// Private Violet: the private notice, tiles and New Tab.
    static let privateViolet = Color(hex: 0x6A55D6)
    /// The private palette's edges and rules (`--sval-private-line`).
    static let privateEdge = Color(hex: 0xA68CFF)
    /// Private Violet's light step, for text on a dark surface.
    static let privateLabel = Color(hex: 0xC9BFFF)
    /// The private backdrop's deepest violet, under the starfield.
    static let privateNight = Color(hex: 0x06031A)
    var text: Color { window.map { Color(hex: $0.strong) } ?? pick(0xFFFFFF, 0x060A2E) }
    var body: Color { isPrivate ? Color(hex: 0xE2DCFF) : window.map { Color(hex: $0.body) } ?? pick(0xD6DDF0, 0x1C2A6B) }
    var muted: Color {
        isPrivate ? Color(hex: 0xA79FD0) : window.map { Color(hex: $0.muted) }
            ?? (more ? pick(0xB4BEE0, 0x444F80) : pick(0x8F9BC7, 0x4F5B8C))
    }
    /// A rule or a control's edge on the surface, 3:1 on the sheet and its
    /// cells, and stronger under Increase Contrast, as a Workspace colour's
    /// is.
    var line: Color { window.map { Color(hex: $0.line) } ?? (more ? pick(0x8A97C4, 0x6B6B6B) : pick(0x6676A3, 0x858585)) }
    /// Whether the phone asks for more contrast (Increase Contrast).
    private var more: Bool { DesktopColor.contrast.more }
    var divider: Color {
        isPrivate ? Theme.privateEdge.opacity(0.14)
            : dark ? Color(hex: 0xA6E8FF, opacity: 0.10) : Color(hex: 0x13328F, opacity: 0.10)
    }
    /// Sval's cyan and, on a light surface, a blue a step darker than the
    /// action blue, so accent text meets 4.5:1 on the light sheet.
    var accent: Color { window.map { Color(hex: $0.focus) } ?? pick(0x5CF2FF, 0x1A62F0) }
    var accentWash: Color { dark ? Color(hex: 0x5CF2FF, opacity: 0.16) : Color(hex: 0x1F6BFF, opacity: 0.12) }
    var well: Color {
        isPrivate ? Theme.privateEdge.opacity(0.10)
            : dark ? Color(hex: 0xA6E8FF, opacity: 0.07) : Color(hex: 0x13328F, opacity: 0.05)
    }
    /// Sval's blue on what a tap acts on (`--sval-palette-blue`), the
    /// app's AccentColor. `accent` marks what is selected or in front.
    var action: Color { Theme.blue }
    static let blue = Color(hex: 0x1F6BFF)
    var switchOff: Color { dark ? Color(hex: 0xA6E8FF, opacity: 0.22) : Color(hex: 0x13328F, opacity: 0.22) }
    var dangerText: Color { pick(0xFF8A90, 0xC42F3A) }
    var dangerFill: Color { pick(0xE5484D, 0xD93A45) }
    var tileRing: Color { pick(0x5A688C, 0x929292) }
    /// A dialog's or toast's edge (`--sval-dialog-border`).
    var toastBorder: Color { dark ? Color(hex: 0xA6E8FF, opacity: 0.18) : Color(hex: 0x13328F, opacity: 0.14) }
    var scrim: Color { dark ? Color(hex: 0x03051A, opacity: 0.6) : Color(hex: 0x060A2E, opacity: 0.3) }
    var warning: Color { pick(0xFFB224, 0xB86E00) }
    /// A mark on a `warning` fill.
    var warningInk: Color { dark ? Color(hex: 0x241600) : .white }
    var error: Color { pick(0xFF6B70, 0xC42F3A) }
}

/// The colours of everything drawn on a Workspace's glass: the bar's
/// capsules, the media ask and now-playing capsule, the media card, the
/// Launcher, toasts and the top notice. The glass carries the Workspace's
/// window colour, the one its sheet takes ([`Theme.sheet`]), with that
/// window's ink, so every surface of a Workspace shows one colour.
struct BarColors {
    /// The colour the glass is tinted with ([`workspaceGlass`]).
    let layer: Color
    let ink: Color
    let muted: Color
    /// Whether the glass's text is dark: its tint reads light.
    let darkInk: Bool

    init(token: String?, dark: Bool) {
        if token == Theme.privateToken {
            layer = Self.privateLayer
            darkInk = Self.readsDark(layer, opacity: Self.glassTint, dark: dark)
        } else {
            let theme = Theme(dark ? .dark : .light, tint: token)
            layer = theme.sheet
            darkInk = !theme.dark
        }
        ink = darkInk ? Color(hex: 0x060A2E) : .white
        muted = darkInk ? Color(hex: 0x060A2E, opacity: 0.6) : Color(hex: 0xFFFFFF, opacity: 0.66)
    }

    /// Sval's accent on the glass: the action blue where the ink is dark,
    /// the cyan where it is white, as on the desktop's light and dark
    /// headers.
    var accent: Color { darkInk ? Theme.blue : Color(hex: 0x5CF2FF) }
    /// The ink on a fill of `accent`.
    var onAccent: Color { darkInk ? .white : Color(hex: 0x060A2E) }
    /// A rule between controls on the glass.
    var rule: Color { ink.opacity(0.22) }
    /// The edge of a tile on the glass (`--sval-dialog-border`).
    var edge: Color { darkInk ? Color(hex: 0x13328F, opacity: 0.14) : Color(hex: 0xA6E8FF, opacity: 0.16) }
    /// A badge's disc on the glass: opaque, on the side of the ink's
    /// contrast, so the badge's mark reads whatever is under the glass.
    var badge: Color { darkInk ? .white : Color(hex: 0x0A1140) }

    /// Dark ink or white, whichever reads better on an opaque `fill`.
    static func ink(on fill: Color, dark: Bool) -> Color {
        readsDark(fill, dark: dark) ? Color(hex: 0x060A2E) : .white
    }

    /// How strongly the Workspace's colour tints the bar's glass.
    static let glassTint = 0.55

    /// Whether dark text reads better than white on `color` at `opacity`
    /// over the glass's ground, light or dark: the higher WCAG contrast of
    /// the two, on the mix's relative luminance.
    static func readsDark(_ color: Color, opacity: Double = 1, dark: Bool) -> Bool {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
        func linear(_ c: CGFloat) -> Double {
            let c = Double(c)
            return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        let ground = dark ? 0.012 : 1.0
        let mix = { (c: CGFloat) in opacity * linear(c) + (1 - opacity) * ground }
        let l = 0.2126 * mix(r) + 0.7152 * mix(g) + 0.0722 * mix(b)
        return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05)
    }

    /// The private session's glass: the desktop's private header violet.
    static let privateLayer = Color(hex: 0x8B6CFF)
}

/// A Workspace's or group's colour as the tree syncs it: a preset's
/// token, or a custom colour's JSON (decision 0057). Everything drawn from
/// it comes from the desktop's maths ([`DesktopColor`]).
struct WorkspaceTint: Hashable, Identifiable {
    let rawValue: String

    init?(rawValue: String) {
        guard TintPreset(rawValue: rawValue) != nil || rawValue.hasPrefix("{") else { return nil }
        self.rawValue = rawValue
    }

    var id: String { rawValue }

    private func window(dark: Bool) -> DesktopColor.Window? {
        DesktopColor.window(rawValue, dark: dark)
    }

    /// Whether the colour's window takes dark text in this appearance.
    func darkInk(dark: Bool) -> Bool {
        window(dark: dark)?.darkInk ?? !dark
    }

    /// The colour as a mark on a row, as the desktop panel draws a group's:
    /// its ink on a light surface, or on a dark one (`markOf`).
    func swatch(dark: Bool) -> Color {
        DesktopColor.group(rawValue).map { Color(hex: dark ? $0.invert : $0.base) } ?? .gray
    }

    /// The tile behind a Workspace's emoji, which is its window's colour.
    func tile(dark: Bool) -> Color {
        window(dark: dark).map { Color(hex: $0.tint) } ?? .gray
    }
}

/// The ten colours a Workspace or group can take by name, in the order
/// the desktop's pickers show them (`SvalColor.PRESETS`).
enum TintPreset: String, CaseIterable, Identifiable {
    case red, orange, yellow, green, cyan, blue, purple, pink, gray, black

    var id: String { rawValue }
}

/// The corner radii Sval's surfaces share.
enum Radius {
    /// Every sheet's corner.
    static let sheet: CGFloat = 38
    /// A card floating over the page: the media card, the Launcher's list.
    static let card: CGFloat = 26
    /// A tab's card in the grid, and a split's pane.
    static let pane: CGFloat = 16
    /// A Workspace's or site's tile, as a share of its size.
    static let tileFactor: CGFloat = 0.28
}

/// The heights Sval's rows share, each at least the 44pt target.
enum RowMetrics {
    /// A row in a chooser sheet: Move to…, Split With….
    static let chooser: CGFloat = 50
    /// A suggestion in the Launcher, with its site under its title.
    static let suggestion: CGFloat = 54
    /// A tab in the Workspace tree, with its site under its title.
    static let tab: CGFloat = 56
    /// A group in the Workspace tree.
    static let group: CGFloat = 48
}

/// A row's title: one line at the standard text sizes, and up to three at
/// the accessibility sizes, where one line holds a word or two.
private struct TitleLines: ViewModifier {
    @Environment(\.dynamicTypeSize) private var typeSize

    func body(content: Content) -> some View {
        content.lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
    }
}

/// A row's least height. At the accessibility sizes its text is taller
/// than that, so the row keeps room above and below it.
private struct RowHeight: ViewModifier {
    @Environment(\.dynamicTypeSize) private var typeSize
    let least: CGFloat

    func body(content: Content) -> some View {
        content
            .padding(.vertical, typeSize.isAccessibilitySize ? 12 : 0)
            .frame(minHeight: least)
    }
}

/// A sheet's title: in the bar at the standard text sizes. A bar holds its
/// title to a few sizes past the standard one, so at the accessibility
/// sizes the title heads the sheet's content, where it grows with the
/// text, and the bar keeps its buttons.
private struct SheetTitleMode: ViewModifier {
    @Environment(\.dynamicTypeSize) private var typeSize
    let title: String
    let subtitle: String?

    func body(content: Content) -> some View {
        if typeSize.isAccessibilitySize {
            content
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) { Color.clear.accessibilityHidden(true) }
                }
                .safeAreaBar(edge: .top, spacing: 0) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(.system(.title3, weight: .bold))
                            .accessibilityAddTraits(.isHeader)
                        if let subtitle {
                            Text(subtitle).font(.system(.footnote)).opacity(0.7)
                        }
                    }
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                }
        } else {
            content.navigationBarTitleDisplayMode(.inline)
        }
    }
}

extension View {
    func sheetTitleMode(_ title: String, subtitle: String? = nil) -> some View {
        modifier(SheetTitleMode(title: title, subtitle: subtitle))
    }
    func titleLines() -> some View { modifier(TitleLines()) }
    func rowHeight(_ least: CGFloat) -> some View { modifier(RowHeight(least: least)) }
}

/// The animations Sval's controls share. Under Reduce Motion each is a
/// short fade or none, as the caller picks.
enum Motion {
    /// A row or group opening or closing in place.
    static let disclose = Animation.easeOut(duration: 0.15)
    /// A card or toast coming and going over the page.
    static let overlay = Animation.easeOut(duration: 0.2)
}

/// Sval's typefaces, scaled with Dynamic Type from the text style each
/// size stands in for. Outfit is for titles and brand marks; lists, forms
/// and controls take the system's text styles, as Apple's apps do.
enum SvalFont {
    static func outfit(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle) -> Font {
        .custom("Outfit", size: size, relativeTo: style).weight(weight)
    }

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle) -> Font {
        .custom("JetBrains Mono", size: size, relativeTo: style).weight(weight)
    }
}

extension Color {
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity)
    }
}

/// A coloured group's block in the tree, as the desktop panel paints it
/// (`sval-panel.css`, `--sval-block`): opaque, its lightness a step off the
/// surface it sits on, stopped where its text still reads, its hue and
/// chroma the group's (`SvalColor.groupBlock`).
enum GroupBlock {
    /// The block of `tint` on a surface of oklch lightness `surface` that
    /// reads dark or light and steps blocks `blockDir`. `selected` is the
    /// row in front, which the desktop lifts further and deepens.
    static func color(_ tint: WorkspaceTint, dark: Bool, surface: Double, blockDir: Double = 1, selected: Bool = false) -> Color {
        let hex = DesktopColor.groupBlock(tint.rawValue, surface: surface, surfaceDark: dark, dir: blockDir,
                                          step: selected ? (dark ? 1.5 : 2.3) : 1, selected: selected)
        return hex.map { Color(hex: $0) } ?? .gray
    }
}

extension EnvironmentValues {
    /// The Workspace colour a sheet over the browser takes, as its bar
    /// does: the Workspace sheet, and what opens from it.
    @Entry var sheetTint: String?

    /// The phone's own appearance, which Sval's colours are solved for. A
    /// sheet in a Workspace's colour sets `colorScheme` to the side its
    /// colour reads on, for the system's controls (`Theme.colorScheme`);
    /// this stays the phone's, so the colours don't flip with it.
    @Entry var appearance: ColorScheme = .light
}

/// Puts a sheet in a Workspace's colour: its views take the colour
/// (`sheetTint`), and the system's controls on it take the side the colour
/// reads on (`Theme.colorScheme`), so a title or a toolbar button reads on
/// a pale colour in dark and on a deep one in light.
struct SheetTint: ViewModifier {
    @Environment(\.appearance) private var appearance
    let token: String?

    func body(content: Content) -> some View {
        content
            .environment(\.sheetTint, token)
            .preferredColorScheme(Theme(appearance, tint: token).colorScheme)
    }
}

/// A sheet over the browser in its Workspace's colour ([`SheetTint`]),
/// with the corner every sheet takes.
struct TintedSheet: ViewModifier {
    let token: String?

    func body(content: Content) -> some View {
        content
            .sheetTint(token)
            .presentationCornerRadius(Radius.sheet)
    }
}

/// A sheet's or a pushed page's ground in its Workspace's colour, under
/// a list that draws none of its own. The Workspace sheet is glass with
/// its colour thin over it, so a page pushed in it takes the same.
struct SheetGround: ViewModifier {
    @Environment(\.appearance) private var appearance
    @Environment(\.sheetTint) private var sheetTint
    var glass = false

    func body(content: Content) -> some View {
        let theme = Theme(appearance, tint: sheetTint)
        content
            .scrollContentBackground(.hidden)
            .background(theme.sheet.opacity(glass ? Theme.glassSheet : 1).ignoresSafeArea())
    }
}

/// Selects a field's whole text as the field starts editing, as the
/// desktop's rename does. SwiftUI's selection binding loses to the caret
/// UIKit places when the field takes focus, so this asks UIKit itself once
/// editing has begun. `text` is what the field holds when it opens, which
/// tells it from any other field starting to edit.
struct SelectsAllWhenEditing: ViewModifier {
    let text: String

    func body(content: Content) -> some View {
        content.onReceive(NotificationCenter.default.publisher(for: UITextField.textDidBeginEditingNotification)) { note in
            guard let field = note.object as? UITextField, field.text == text, !text.isEmpty else { return }
            DispatchQueue.main.async {
                field.selectAll(nil)
                Diagnostics.log("rename: selected the name")
            }
        }
    }
}

/// Puts the keyboard up in an alert's text field with all its text
/// selected, so typing replaces it at once, as every action that asks for
/// text does. SwiftUI draws an alert as a `UIAlertController`, whose field
/// doesn't always take focus, as when the alert opens from a drop, and a
/// modifier on the field in the alert reaches no `UITextField`. So once
/// the alert is up, this finds its field and asks UIKit.
struct FocusesAlertField: ViewModifier {
    let presented: Bool

    func body(content: Content) -> some View {
        content.onChange(of: presented) { _, now in
            guard now else { return }
            Task { @MainActor in
                // The alert is presented a moment after the state that
                // asks for it; a second is far longer than that takes.
                for _ in 0..<40 {
                    if let field = Self.field() {
                        field.becomeFirstResponder()
                        DispatchQueue.main.async { field.selectAll(nil) }
                        Diagnostics.log("alert: the field took focus")
                        return
                    }
                    try? await Task.sleep(for: .milliseconds(25))
                }
                Diagnostics.log("alert: no field to focus")
            }
        }
    }

    /// The first text field of the alert in front, if one is up.
    @MainActor private static func field() -> UITextField? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        for window in windows {
            var controller = window.rootViewController
            while let next = controller?.presentedViewController { controller = next }
            if let alert = controller as? UIAlertController, let field = alert.textFields?.first {
                return field
            }
        }
        return nil
    }
}

extension View {
    /// Puts a sheet in a Workspace's colour ([`SheetTint`]).
    func sheetTint(_ token: String?) -> some View {
        modifier(SheetTint(token: token))
    }

    /// A sheet in a Workspace's colour with the sheets' corner
    /// ([`TintedSheet`]).
    func tintedSheet(_ token: String?) -> some View {
        modifier(TintedSheet(token: token))
    }

    /// See `SheetGround`.
    func sheetGround(glass: Bool = false) -> some View {
        modifier(SheetGround(glass: glass))
    }

    func selectsAllWhenEditing(_ text: String) -> some View {
        modifier(SelectsAllWhenEditing(text: text))
    }

    /// Focuses the text field of the alert `presented` shows, its text
    /// selected ([`FocusesAlertField`]).
    func focusesAlertField(when presented: Bool) -> some View {
        modifier(FocusesAlertField(presented: presented))
    }
}

/// Fades a scrolling list's rows out at an edge with more to scroll to, so
/// rows never end in a hard cut against a header, a footer or a card's
/// edge, as the desktop's Workspace strip fades while it overflows. A
/// run that scrolls sideways, the pins row and the strip, fades at its
/// sides.
struct ScrollEdgeFade: ViewModifier {
    @State private var moreBefore = false
    @State private var moreAfter = false
    let axis: Axis
    var length: CGFloat = 32

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: [Bool].self) { geometry in
                let sideways = axis == .horizontal
                let offset = sideways ? geometry.contentOffset.x + geometry.contentInsets.leading
                    : geometry.contentOffset.y + geometry.contentInsets.top
                let size = sideways ? geometry.contentSize.width + geometry.contentInsets.leading + geometry.contentInsets.trailing
                    : geometry.contentSize.height + geometry.contentInsets.top + geometry.contentInsets.bottom
                let room = sideways ? geometry.containerSize.width : geometry.containerSize.height
                return [offset > 1, size - room - offset > 1]
            } action: { _, edges in
                moreBefore = edges[0]
                moreAfter = edges[1]
            }
            .mask {
                let layout = axis == .horizontal ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(VStackLayout(spacing: 0))
                layout {
                    edge(fades: moreBefore, before: true)
                    Color.black
                    edge(fades: moreAfter, before: false)
                }
            }
    }

    @ViewBuilder private func edge(fades: Bool, before: Bool) -> some View {
        let start: UnitPoint = axis == .horizontal ? (before ? .leading : .trailing) : (before ? .top : .bottom)
        let end: UnitPoint = axis == .horizontal ? (before ? .trailing : .leading) : (before ? .bottom : .top)
        let fill = fades ? AnyShapeStyle(LinearGradient(colors: [.clear, .black], startPoint: start, endPoint: end))
            : AnyShapeStyle(Color.black)
        Rectangle()
            .fill(fill)
            .frame(width: axis == .horizontal ? length : nil, height: axis == .vertical ? length : nil)
    }
}

extension View {
    /// See `ScrollEdgeFade`.
    func scrollEdgeFade(_ axis: Axis = .vertical) -> some View { modifier(ScrollEdgeFade(axis: axis)) }
}
