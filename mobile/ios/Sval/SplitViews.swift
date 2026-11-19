// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import WebKit

/// The address a pane waiting for a pick loads: Firefox's tab picker,
/// which the phone can't open (split-view spec §5.1).
let splitPickAddress = "about:opentabs"

extension OutlineRow {
    /// Whether this tab is a split's pane waiting for a pick.
    var awaitsPick: Bool { url == splitPickAddress }
}

/// The colours of a split's tray, from the desktop's split row
/// (`sval-panel.css`, `data-kind="split"`), or a coloured group's when it
/// sits in one.
struct SplitColors {
    let border: Color
    let tray: Color
    let cell: Color
    let glyph: Color

    init(_ theme: Theme, group: WorkspaceTint?) {
        let dark = theme.dark
        if let group {
            let ink = group.swatch(dark: dark)
            border = ink.opacity(0.62)
            tray = dark ? Color(hex: 0x03051A, opacity: 0.5) : .white.opacity(0.65)
            cell = ink.opacity(0.26)
            glyph = ink
        } else {
            border = dark ? Color(hex: 0xA6E8FF, opacity: 0.42) : Color(hex: 0x13328F, opacity: 0.40)
            tray = dark ? Color(hex: 0x03051A, opacity: 0.62) : Color(hex: 0x13328F, opacity: 0.14)
            cell = dark ? Color(hex: 0xA6E8FF, opacity: 0.16) : .white
            glyph = theme.body.opacity(0.6)
        }
    }
}

/// A split in the Workspace tree: one row, as on the desktop
/// (split-view spec §6.3), holding a tray with a tile per pane in pane
/// order. It never collapses. A tap on a tile opens the split at that pane.
struct SplitRow<Menu: View>: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint

    let split: OutlineRow
    /// The panes this row draws: the split's, or one run of up to four of
    /// a split holding more.
    let panes: [OutlineRow]
    let indent: CGFloat
    /// The room after the tray, so it ends inside the card of the coloured
    /// group it sits in.
    var trailing: CGFloat = 8
    /// Where the pane count ends, as a group's count does.
    var countTrailing: CGFloat = 10
    /// The coloured group the split sits in, whose colour the tray takes.
    let group: WorkspaceTint?
    /// Opens the split at a pane, or at its last-focused pane for nil.
    let onOpen: (String?) -> Void
    /// A pane's long-press menu.
    @ViewBuilder let menu: (OutlineRow) -> Menu

    /// A tile narrower than this drops its title (12a).
    private static var titledWidth: CGFloat { 88 }

    private var theme: Theme { Theme(scheme, tint: sheetTint) }
    private var browser: Browser { model.browser }
    private var named: Bool { !split.name.isEmpty }
    /// The pane whose tile keeps its title when the others can't.
    private var lastViewed: String? { browser.focusedPane(of: split.id, among: panes.map(\.id)) }

    var body: some View {
        let colors = SplitColors(theme, group: group)
        // The split is a sibling of the rows around it, so its glyph sits
        // where theirs do, and its panes sit under it where a group's
        // children would: the tray's first icon lines up with a child tab's.
        VStack(alignment: .leading, spacing: 6) {
            // A List row with several buttons needs them borderless, or a
            // tap anywhere runs them all.
            Button { onOpen(nil) } label: {
                HStack(spacing: 10) {
                    Image("split").resizable()
                        .frame(width: 20, height: 20)
                        .frame(width: 22)
                        .foregroundStyle(colors.glyph)
                        .accessibilityLabel("Split")
                    Text(named ? split.name : "Split")
                        .font(.system(.body, weight: .semibold))
                        .foregroundStyle(named ? theme.text : theme.muted)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("\(panes.count)")
                        .font(.system(.subheadline))
                        .monospacedDigit()
                        .foregroundStyle(theme.muted)
                }
                .padding(.trailing, countTrailing)
                .frame(minHeight: 24)
                .contentShape(.rect)
            }
            .buttonStyle(.borderless)
            // The tray starts at the glyph's left edge.
            tray(colors)
                .padding(.leading, 1)
                .padding(.trailing, trailing)
        }
        .padding(.leading, 12 + indent)
        .padding(.vertical, 6 + WorkspaceSheet.cardGap)
        .frame(minHeight: 84)
    }

    private func tray(_ colors: SplitColors) -> some View {
        GeometryReader { geometry in
            let gaps = CGFloat(panes.count - 1) * 2 + 4
            let titled = (geometry.size.width - gaps) / CGFloat(max(panes.count, 1)) >= Self.titledWidth
            HStack(spacing: 2) {
                ForEach(panes, id: \.id) { pane in
                    tile(pane, colors: colors, titled: titled || pane.id == lastViewed)
                }
            }
            .padding(2)
            .frame(width: geometry.size.width, height: 44, alignment: .leading)
        }
        .frame(height: 44)
        .background(colors.tray, in: .rect(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(colors.border, lineWidth: 1) }
    }

    private func tile(_ pane: OutlineRow, colors: SplitColors, titled: Bool) -> some View {
        let focused = pane.id == browser.currentTabId
        let loaded = browser.hasPage(pane.id)
        return Button { onOpen(pane.id) } label: {
            HStack(spacing: 8) {
                if pane.awaitsPick {
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(theme.muted, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2]))
                        .frame(width: 20, height: 20)
                        .overlay { Image(systemName: "plus").font(.system(size: 11, weight: .semibold)).foregroundStyle(theme.muted) }
                } else {
                    SiteTile(row: pane, size: 20).opacity(loaded || focused ? 1 : 0.7)
                }
                if titled {
                    Text(pane.awaitsPick ? "Choose a page" : title(pane))
                        .font(.system(.subheadline, weight: focused ? .semibold : .regular))
                        .foregroundStyle(pane.awaitsPick || !(loaded || focused) ? theme.muted : theme.text)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.leading, 8)
            .padding(.trailing, titled ? 10 : 8)
            .frame(maxWidth: titled ? .infinity : 40, maxHeight: .infinity)
            .background(colors.cell, in: .rect(cornerRadius: 10))
            .overlay(alignment: .bottom) {
                if focused {
                    Capsule().fill(theme.accent).frame(height: 4).padding(.horizontal, 8).offset(y: 1)
                }
            }
            .contentShape(.rect(cornerRadius: 10))
        }
        .buttonStyle(.borderless)
        .contextMenu { menu(pane) }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(pane.awaitsPick ? "Choose a page" : title(pane))
        .accessibilityAddTraits(focused ? .isSelected : [])
    }

    private func title(_ pane: OutlineRow) -> String {
        pane.displayTitle
    }
}

/// The panes a split shows, in runs of up to four (split-view spec §5.1,
/// `splitPanes`): a split holding more than four, which only a merge
/// makes, draws as several. A run of one is drawn as a plain tab.
func splitRuns(_ panes: [OutlineRow]) -> [[OutlineRow]] {
    stride(from: 0, to: panes.count, by: 4).map { Array(panes[$0..<min($0 + 4, panes.count)]) }
}

/// Rename Split…, as a system alert with the split's name to edit. An
/// empty name clears it, and the tray shows the pages' titles again
/// (split-view spec §6.3).
struct RenameSplitAlert: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var split: OutlineRow?
    @State private var text = ""

    func body(content: Content) -> some View {
        content
            .alert("Rename Split", isPresented: Binding(get: { split != nil }, set: { if !$0 { split = nil } })) {
                TextField("Name", text: $text)
                    .submitLabel(.done)
                Button("Cancel", role: .cancel) {}
                Button("Rename") {
                    guard let split else { return }
                    Task { await model.renameSplit(split, to: text) }
                }
            }
            .onChange(of: split?.id, initial: true) { text = split?.name ?? "" }
            .focusesAlertField(when: split != nil)
    }
}

extension View {
    func renameSplitAlert(_ split: Binding<OutlineRow?>) -> some View {
        modifier(RenameSplitAlert(split: split))
    }
}

/// The split in front: two panes at once, stacked while the phone is
/// upright and side by side while it's sideways (12b, 12c). Each pane is a
/// card; the focused one, which the bar acts on, has the accent ring, and
/// a touch anywhere in the other focuses it. The divider between them
/// drags.
struct SplitStage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    @Environment(\.verticalSizeClass) private var verticalSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let split: Browser.SplitInFront
    /// The divider's place while it drags, as the first pane's share of
    /// the room.
    @State private var dragging: Double?
    /// The divider's place when the drag began.
    @State private var dragStart: Double?
    /// Where the stacked divider rests, the first pane's share. Stacked
    /// heights are this phone's own, never synced (12b).
    @State private var stacked = 0.5

    /// The divider's height: 16pt, or 48pt while it holds the tray of a
    /// split of three or four (12d).
    private var gap: CGFloat { !sideways && split.run.count > 2 ? 48 : 16 }
    private static let snaps = [1.0 / 3, 0.5, 2.0 / 3]

    private var sideways: Bool { verticalSize == .compact }
    private var theme: Theme { Theme(scheme, tint: sheetTint) }
    private var browser: Browser { model.browser }

    var body: some View {
        GeometryReader { geometry in
            let room = (sideways ? geometry.size.width : geometry.size.height) - gap
            let minimum = sideways ? 240.0 : 160.0
            let share = clamp(dragging ?? (sideways ? sharedWidth : stacked), room: room, minimum: minimum)
            let first = room * share
            let layout = sideways ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(VStackLayout(spacing: 0))
            layout {
                slot(0, width: sideways ? first : geometry.size.width)
                    .frame(width: sideways ? first : nil, height: sideways ? nil : first)
                divider(room: room, minimum: minimum, start: share)
                slot(1, width: sideways ? room - first : geometry.size.width)
            }
        }
        // Sideways the panes run to the edges of the room iOS keeps clear.
        .padding(.horizontal, sideways ? 0 : 4)
        .padding(.top, sideways ? 8 : 2)
        .padding(.bottom, sideways ? 8 : 5)
        .background(theme.sheet)
    }

    /// A slot's pane. While the tray slides the focused pane, the pane
    /// coming in sits beside it, 8pt behind, and both move, clipped to the
    /// slot (12d).
    @ViewBuilder private func slot(_ index: Int, width: CGFloat) -> some View {
        let id = split.slots[index]
        if id == split.focused {
            let slide = browser.paneSlide
            ZStack {
                card(id).offset(x: slide)
                if let target = browser.paneSlideTarget {
                    card(target).offset(x: slide + (slide < 0 ? width + 8 : -(width + 8)))
                }
            }
            .clipped()
            .onAppear { browser.focusedSlotWidth = width }
            .onChange(of: width) { browser.focusedSlotWidth = width }
        } else {
            card(id)
        }
    }

    /// The bar floats over the stage's foot: over the lower pane upright,
    /// less the stage's 5pt margin, and over both panes sideways, less 8.
    private func cover(_ id: String) -> CGFloat {
        if sideways { return Browser.sidewaysBarRoom - 8 }
        return split.slots.last == id ? Browser.barRoom - 5 : 0
    }

    private func card(_ id: String) -> some View {
        let focused = id == split.focused
        return Group {
            if let pane = model.row(id), pane.awaitsPick {
                PickPage(pane: pane)
                    .simultaneousGesture(TapGesture().onEnded { if !focused { browser.select(id) } })
            } else {
                PaneHost(view: browser.paneView(id), bottomCover: cover(id)) {
                    if !focused { browser.select(id) }
                }
            }
        }
        .clipShape(.rect(cornerRadius: Radius.pane))
        .overlay {
            if focused {
                // A light ring outside a dark one, so the focused pane's
                // edge shows on a light page and a dark one alike.
                ZStack {
                    RoundedRectangle(cornerRadius: Radius.pane).strokeBorder(theme.accent, lineWidth: 3)
                    RoundedRectangle(cornerRadius: 13).strokeBorder(Color(hex: 0x060A2E), lineWidth: 2).padding(3)
                }
                .allowsHitTesting(false)
            } else {
                RoundedRectangle(cornerRadius: Radius.pane)
                    .strokeBorder(theme.dark ? theme.divider : theme.line, lineWidth: 1)
                    .allowsHitTesting(false)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(focused ? .isSelected : [])
    }

    /// The landscape divider's place from the split's synced widths: the
    /// pair in view takes its two shares, scaled to fill the width.
    private var sharedWidth: Double {
        let shares = pairShares
        return shares.0 / (shares.0 + shares.1)
    }

    /// The synced shares of the two panes in view, or equal ones when the
    /// split has none that fit.
    private var pairShares: (Double, Double) {
        let all = model.children(of: split.split.id).filter { $0.kind == "tab" }.map(\.id)
        let shares = split.split.shares.flatMap { $0.count == all.count ? $0 : nil }
            ?? Array(repeating: 100 / Double(all.count), count: all.count)
        let at = split.slots.map { slot in all.firstIndex(of: slot) ?? 0 }
        return (shares[at[0]], shares[at[1]])
    }

    private func clamp(_ share: Double, room: CGFloat, minimum: CGFloat) -> Double {
        guard room > minimum * 2 else { return 0.5 }
        return min(max(share, minimum / room), 1 - minimum / room)
    }

    private func divider(room: CGFloat, minimum: CGFloat, start: Double) -> some View {
        ZStack {
            Color.clear
            let grabber = Capsule()
                .fill(dragging != nil ? theme.accent : theme.muted)
                .frame(width: sideways ? 5 : 36, height: sideways ? 36 : 5)
            if !sideways && split.run.count > 2 {
                // The tray takes the divider's middle, so a grabber on each
                // side of it shows the divider still drags.
                HStack(spacing: 0) {
                    grabber.frame(maxWidth: .infinity)
                    PaneTray(split: split)
                    grabber.frame(maxWidth: .infinity)
                }
            } else {
                grabber
            }
        }
        .frame(width: sideways ? gap : nil, height: sideways ? nil : gap)
        // A tap as the divider lands on a third, half or two thirds.
        .sensoryFeedback(.impact(weight: .light), trigger: dragging.flatMap { Self.snaps.firstIndex(of: $0) }) { _, now in
            now != nil
        }
        .contentShape(.rect.inset(by: -14))
        .gesture(
            DragGesture(minimumDistance: 2, coordinateSpace: .global)
                .onChanged { drag in
                    let origin = dragStart ?? start
                    if dragStart == nil { dragStart = start }
                    let moved = sideways ? drag.translation.width : drag.translation.height
                    let raw = clamp(origin + moved / room, room: room, minimum: minimum)
                    dragging = Self.snaps.first { abs($0 - raw) * room < 12 } ?? raw
                }
                .onEnded { _ in
                    guard let share = dragging else { return }
                    if sideways { writeShares(share) } else { stacked = share }
                    dragging = nil
                    dragStart = nil
                })
        .onTapGesture(count: 2) {
            if sideways { writeShares(0.5) } else { stacked = 0.5 }
        }
        .accessibilityLabel("Divider")
        .accessibilityValue("\(Int((start * 100).rounded()))%")
        // The drag's places, a third, half and two thirds, for VoiceOver's
        // swipe up and down.
        .accessibilityAdjustableAction { direction in
            let next = direction == .increment
                ? Self.snaps.first { $0 > start + 0.01 } : Self.snaps.last { $0 < start - 0.01 }
            guard let next else { return }
            let share = clamp(next, room: room, minimum: minimum)
            if sideways { writeShares(share) } else { stacked = share }
        }
    }

    /// Writes the pair's new widths, keeping their sum, so the desktop
    /// shows the same; the other panes keep theirs.
    private func writeShares(_ share: Double) {
        let all = model.children(of: split.split.id).filter { $0.kind == "tab" }.map(\.id)
        var shares = split.split.shares.flatMap { $0.count == all.count ? $0 : nil }
            ?? Array(repeating: 100 / Double(all.count), count: all.count)
        guard let a = all.firstIndex(of: split.slots[0]), let b = all.firstIndex(of: split.slots[1]) else { return }
        let sum = shares[a] + shares[b]
        shares[a] = (sum * share * 100).rounded() / 100
        shares[b] = sum - shares[a]
        // The last share takes what rounding left, so the list sums to 100.
        shares[shares.count - 1] = 100 - shares.dropLast().reduce(0, +)
        Diagnostics.log("splits: widths set to \(shares.map { Int($0.rounded()) })")
        Task { await model.setShares(split.split, shares) }
    }
}

/// Hosts one pane's page in its card. A touch anywhere in it tells the
/// split, and still reaches the page.
struct PaneHost: UIViewRepresentable {
    let view: WKWebView?
    /// How much of the pane's foot the bar covers: the lower pane's while
    /// upright, both panes' while sideways.
    var bottomCover: CGFloat = 0
    let onTouch: () -> Void

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        let touch = TouchDown()
        touch.cancelsTouchesInView = false
        touch.delaysTouchesBegan = false
        touch.delegate = context.coordinator
        container.addGestureRecognizer(touch)
        context.coordinator.touch = touch
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        context.coordinator.touch?.onTouch = onTouch
        if let view, view.obscuredContentInsets.bottom != bottomCover {
            view.obscuredContentInsets = UIEdgeInsets(top: 0, left: 0, bottom: bottomCover, right: 0)
        }
        guard let view, view.superview !== container else { return }
        view.removeFromSuperview()
        container.subviews.forEach { $0.removeFromSuperview() }
        view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            view.topAnchor.constraint(equalTo: container.topAnchor),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        view.accessibilityElementsHidden = false
        view.isUserInteractionEnabled = true
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var touch: TouchDown?
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}

/// Reports a touch as it lands and steps aside, so the page gets it too.
final class TouchDown: UIGestureRecognizer {
    var onTouch: () -> Void = {}

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        onTouch()
        state = .failed
    }
}

/// A pane waiting for a pick, drawn as the phone's own page: this
/// Workspace's tabs that are in no split, any of which fills the pane
/// (12e3). Typing an address in the bar loads it here instead.
struct PickPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint

    let pane: OutlineRow

    private var theme: Theme { Theme(scheme, tint: sheetTint) }

    var body: some View {
        let workspace = model.workspace(of: pane.id).flatMap(model.row)
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                Text("Choose a page for this pane")
                    .font(SvalFont.outfit(20, .bold, relativeTo: .title3))
                Text("You can also type an address in the address bar.")
                    .font(.system(.subheadline))
                    .foregroundStyle(theme.body)
                if let workspace {
                    Text("In \([workspace.emoji, WorkspaceTile.name(workspace)].compactMap { $0 }.joined(separator: " "))")
                        .font(.system(.footnote, weight: .semibold))
                        .foregroundStyle(theme.muted)
                        .padding(.top, 14)
                    ForEach(candidates(in: workspace.id), id: \.id) { tab in
                        Button { pick(tab) } label: {
                            HStack(spacing: 10) {
                                SiteTile(row: tab, size: 22)
                                Text(tab.displayTitle)
                                    .font(.system(.body))
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.horizontal, 12)
                            .frame(minHeight: 48)
                            .contentShape(.rect)
                        }
                    }
                }
            }
            .padding(16)
        }
        .foregroundStyle(theme.text)
        .background(theme.sheet)
    }

    /// The Workspace's tabs in tree order that sit in no split.
    private func candidates(in workspace: String) -> [OutlineRow] {
        model.tabs(in: workspace).filter { tab in
            !tab.awaitsPick && Browser.openable(tab) != nil && tab.parentId.flatMap(model.row)?.kind != "split"
        }
    }

    private func pick(_ tab: OutlineRow) {
        Task {
            guard let undo = await model.pick(tab, for: pane) else { return }
            model.browser.select(tab.id)
            model.browser.toast = Toast(text: "Moved the tab into the Split") { Task { await model.editTree(undo) } }
        }
    }
}

/// A split of three or four's tray: a tile per pane, the two in view
/// ringed and the focused one underlined (12d). It moves only the focused
/// pane: a tap on a tile out of view puts that pane in the focused slot,
/// and a swipe slides the focused pane to the next or previous one, the
/// pane following the finger.
struct PaneTray: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let split: Browser.SplitInFront
    /// The tile's size: 32pt on the divider, 34pt in the bar.
    var tile: CGFloat = 32
    /// Whether the tray sits in the bar, which carries ‹ and › of its own
    /// neither side.
    var inBar = false

    /// A tray drag moves a whole pane in a short swipe (12d).
    private static let reach: CGFloat = 2.6

    private var theme: Theme { Theme(scheme, tint: sheetTint) }
    private var browser: Browser { model.browser }
    /// In the bar, the tray is one of its glass capsules.
    private var glass: BarColors? { inBar ? BarColors(token: sheetTint, dark: scheme == .dark) : nil }
    private var accent: Color { glass?.accent ?? theme.accent }

    var body: some View {
        let colors = SplitColors(theme, group: nil)
        HStack(spacing: 0) {
            if !inBar { stepButton(-1) }
            HStack(spacing: 2) {
                ForEach(split.run, id: \.id) { pane in
                    paneTile(pane, colors: colors)
                }
            }
            .padding(2)
            .background {
                if let glass {
                    RoundedRectangle(cornerRadius: 12).fill(.clear)
                        .glassEffect(workspaceGlass(glass.layer, interactive: false), in: .rect(cornerRadius: 12))
                } else {
                    RoundedRectangle(cornerRadius: 12).fill(colors.tray)
                        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(colors.border, lineWidth: 1) }
                }
            }
            .contentShape(.rect)
            .gesture(slide)
            // In the bar the tray has no ‹ and ›, so the slide's steps are
            // actions of its own.
            .accessibilityElement(children: .contain)
            .accessibilityActions {
                if inBar {
                    if browser.paneStep(-1) != nil { Button("Previous Pane") { step(-1) } }
                    if browser.paneStep(1) != nil { Button("Next Pane") { step(1) } }
                }
            }
            if !inBar { stepButton(1) }
        }
    }

    private func paneTile(_ pane: OutlineRow, colors: SplitColors) -> some View {
        let shown = split.slots.contains(pane.id)
        let focused = pane.id == split.focused
        // A button, so VoiceOver, Switch Control and Full Keyboard Access
        // can press it.
        return Button { if !focused { browser.select(pane.id) } } label: {
            Group {
                if pane.awaitsPick {
                    Image(systemName: "plus").font(.system(size: 12, weight: .semibold)).foregroundStyle(glass?.muted ?? theme.muted)
                } else {
                    SiteTile(row: pane, size: 20).opacity(shown ? 1 : 0.55)
                }
            }
            .frame(width: tile, height: tile)
            .background(shown ? glass?.rule ?? colors.cell : .clear, in: .rect(cornerRadius: 9))
            // The two panes in view are ringed with a dashed line, and the
            // focused one, which the bar acts on, has a thick bar under it.
            .overlay {
                if shown {
                    RoundedRectangle(cornerRadius: 9)
                        .strokeBorder(accent, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                }
            }
            .overlay(alignment: .bottom) {
                if focused { Capsule().fill(accent).frame(height: 4).padding(.horizontal, 5).offset(y: 1) }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(pane.awaitsPick ? "Choose a page" : pane.displayTitle)
        .accessibilityAddTraits(focused ? .isSelected : [])
    }

    private func stepButton(_ direction: Int) -> some View {
        Button { step(direction) } label: {
            Image(systemName: direction < 0 ? "chevron.left" : "chevron.right")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(theme.muted)
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .disabled(browser.paneStep(direction) == nil)
        .opacity(browser.paneStep(direction) == nil ? 0.35 : 1)
        .accessibilityLabel(direction < 0 ? "Previous Pane" : "Next Pane")
    }

    private func step(_ direction: Int) {
        guard let target = browser.paneStep(direction) else { return }
        guard !reduceMotion else { return withAnimation(.easeOut(duration: 0.15)) { browser.select(target) } }
        browser.paneSlideTarget = target
        let width = browser.focusedSlotWidth + 8
        withAnimation(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.3)) {
            browser.paneSlide = direction > 0 ? -width : width
        } completion: { finish(target) }
    }

    /// A sideways drag on the tray slides the focused pane, the next one
    /// coming in beside it. Past 30% of the slot, or a flick, switches;
    /// at the ends it rubber-bands.
    private var slide: some Gesture {
        DragGesture(minimumDistance: 6)
            .onChanged { drag in
                guard !reduceMotion else { return }
                let moved = drag.translation.width * Self.reach
                let target = browser.paneStep(moved < 0 ? 1 : -1)
                browser.paneSlideTarget = target
                browser.paneSlide = target == nil ? moved * 0.25 : moved
            }
            .onEnded { drag in
                let width = browser.focusedSlotWidth + 8
                let moved = drag.translation.width * Self.reach
                let velocity = (drag.predictedEndTranslation.width - drag.translation.width) * Self.reach
                let direction = moved < 0 ? 1 : -1
                guard let target = browser.paneStep(direction),
                      abs(moved) > browser.focusedSlotWidth * 0.3 || abs(velocity) > 120 && velocity.sign == moved.sign
                else {
                    withAnimation(.spring(duration: 0.3)) { browser.paneSlide = 0 } completion: {
                        browser.paneSlideTarget = nil
                    }
                    return
                }
                guard !reduceMotion else {
                    withAnimation(.easeOut(duration: 0.15)) { browser.select(target) }
                    return
                }
                withAnimation(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.3)) {
                    browser.paneSlide = direction > 0 ? -width : width
                } completion: { finish(target) }
            }
    }

    private func finish(_ target: String) {
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) {
            browser.select(target)
            browser.paneSlide = 0
            browser.paneSlideTarget = nil
        }
    }
}

/// Split With…: the rows of the Workspace that can make a split with a
/// tab or a split, what dropping one on its split half does, for a person
/// who can't drag (decision 14). A tap makes the split.
struct SplitWithSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint

    let target: OutlineRow

    private var theme: Theme { Theme(scheme, tint: sheetTint) }

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.splitCandidates(for: target), id: \.id) { row in
                    Button {
                        Task { await model.split(target, with: row) }
                        dismiss()
                    } label: {
                        HStack(spacing: 11) {
                            if row.kind == "split" {
                                Image(systemName: "rectangle.split.2x1")
                                    .font(.system(size: 16))
                                    .frame(width: 22)
                            } else {
                                SiteTile(row: row, size: 22)
                            }
                            Text(name(row))
                                .font(.system(.body))
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(minHeight: RowMetrics.chooser)
                        .contentShape(.rect)
                    }
                    .foregroundStyle(theme.text)
                }
                .listRowBackground(theme.cell)
            }
            .sheetGround()
            .navigationTitle("Split With…")
            .navigationSubtitle(name(target))
            .sheetTitleMode("Split With…", subtitle: name(target))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .close) { dismiss() }
                }
            }
        }
    }

    /// A tab's title, or a split's name or its panes' titles.
    private func name(_ row: OutlineRow) -> String {
        guard row.kind == "split", row.name.isEmpty else { return row.displayTitle }
        return model.children(of: row.id).filter { $0.kind == "tab" }.map(\.displayTitle).joined(separator: " and ")
    }
}
