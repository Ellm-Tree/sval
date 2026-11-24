// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// The bar at the foot of the browser: four glass capsules floating over
/// the page, each in the Workspace's colour (round 6). Back and Forward,
/// the address with the site menu and reload, New Tab, and the Workspace.
/// As the page scrolls down they fold into one pill (`BarFold`).
/// The bar's Workspace button, as the bar draws it.
struct WorkspaceButtonBounds: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = value ?? nextValue()
    }
}

struct BrowserBar: View {
    @Environment(\.horizontalSizeClass) private var horizontalSize
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.verticalSizeClass) private var verticalSize
    /// A line of the address's text, which is `.subheadline`, as
    /// `GlassFold` sizes the bar by it.
    @ScaledMetric(relativeTo: .subheadline) private var addressLine: CGFloat = 20

    let facts: BarFacts
    let colors: BarColors
    let actions: BarActions
    /// The tab whose media card is open, if one is.
    var mediaCard: String?

    /// The progress line's length, which eases toward the page's progress
    /// and runs to the end before it fades once the load is done. Only
    /// `ProgressLine` and `ProgressFollower` read them, so the load's
    /// progress redraws them alone.
    @State private var line = 0.0
    @State private var lineShown = false
    /// What is held for a scrub: the address or the Workspace button.
    @GestureState private var scrubbing: ScrubKind?
    /// Whether the touch on the address or the Workspace button became a
    /// scrub, which then opens no Launcher or sheet as it lifts.
    @State private var heldForScrub = false

    private var browser: Browser { model.browser }
    private var workspace: OutlineRow? { facts.workspace }
    private var otherMedia: String? { facts.otherMedia }
    private var frontMedia: String? { facts.frontMedia }

    /// The Workspace colour the capsules' glass is tinted with.
    private var layer: Color { colors.layer }

    var body: some View {
        Group {
            // Sideways the bar is one row already, so it stays as it is
            // while the page scrolls.
            if verticalSize == .compact {
                sideways
            } else {
                upright
            }
        }
        .background { ProgressFollower(line: $line, shown: $lineShown) }
        .onChange(of: scrubbing) { _, held in
            if held == nil { actions.scrub(.ended) }
        }
    }

    /// The upright bar. Its controls are built here, once for each change
    /// of what the bar shows, and `FoldingBar` places them at each step of
    /// the fold, so a page's scrolling builds none of them again.
    private var upright: some View {
        let shape = BarShape(typeSize, line: addressLine)
        let k = shape.scale
        return FoldingBar(
            facts: facts, colors: colors, scrubbing: scrubbing,
            nav: HStack(spacing: 0) {
                navButton("Back", "back", size: 24 * k, frame: 40 * k, enabled: facts.canGoBack) { browser.goBack() }
                navButton("Forward", "forward", size: 24 * k, frame: 40 * k, enabled: facts.canGoForward) {
                    browser.goForward()
                }
            },
            // The address capsule's height, open or folded, less its 6pt
            // margins.
            row: addressRow(height: shape.address - 12, scale: k),
            newTab: newTabButton(size: 24 * k, frame: shape.control),
            workspaceButton: workspaceButton(size: shape.control, scale: k),
            workspaceLabel: workspaceLabel(size: shape.control, named: false, scale: k),
            otherMedia: frontMedia == nil ? otherMedia.map(otherMediaButton) : nil,
            rider: (frontMedia ?? otherMedia).map { media in
                NowPlayingCapsule(tabId: media, colors: colors) { actions.media(media) }
            },
            speaker: frontMedia.map(speaker),
            progress: ProgressLine(line: $line, shown: $lineShown, colors: colors),
            openBar: { browser.fold.openBar() })
            .padding(.bottom, 24)
    }

    /// Another tab's media beside the folded pill: its site's icon.
    private func otherMediaButton(_ media: String) -> some View {
        Button { actions.media(media) } label: {
            Group { if let row = facts.otherMediaRow { SiteTile(row: row, size: 26) } }
                .frame(width: 48, height: 48)
        }
        .glassEffect(workspaceGlass(layer), in: .circle)
        .accessibilityLabel("Video and Audio")
    }

    /// The shield, the pane mark of a split in front, the JavaScript-off
    /// mark and the address, left-aligned, which stay put as the bar folds.
    private func addressRow(height: Double, scale k: Double = 1) -> some View {
        HStack(spacing: 0) {
            shield(size: 21 * k, frame: CGSize(width: 36 * k, height: height))
            if let split = facts.split {
                splitMenu(split)
            }
            Button {
                if !heldForScrub { actions.address() }
            } label: {
                HStack(spacing: 6) {
                    if facts.javaScriptOff {
                        Image("javascript-off").resizable().frame(width: 15, height: 15).foregroundStyle(colors.muted)
                            .accessibilityLabel("JavaScript off")
                    }
                    Text(address.text)
                        .font(.system(.subheadline, weight: address.placeholder ? .regular : .semibold))
                        .foregroundStyle(address.placeholder ? colors.muted : colors.ink)
                        .lineLimit(1)
                        // A placeholder shrinks to fit whole; an address
                        // keeps its size and loses its middle.
                        .minimumScaleFactor(address.placeholder ? 0.85 : 1)
                        .truncationMode(.middle)
                }
                .padding(.leading, 4)
                .frame(maxWidth: .infinity, minHeight: height, maxHeight: height, alignment: .leading)
                .contentShape(.rect)
            }
            .accessibilityLabel(address.placeholder ? "Search or enter address"
                : "Address, \(address.text)\(facts.javaScriptOff ? ", JavaScript off" : "")")
            // Voice Control takes the words on screen first.
            .accessibilityInputLabels(address.placeholder ? [address.text] : [address.text, "Address"])
            // The bar keeps its height at every text size, so its controls
            // show enlarged on a long press, as a tab bar's do. That long
            // press is the large content viewer's at those sizes.
            .accessibilityShowsLargeContentViewer()
            // Beside the button's tap, which a priority gesture would stop
            // firing at all: the tap skips a touch the hold took instead.
            .simultaneousGesture(scrubGesture(.tabs), isEnabled: !typeSize.isAccessibilitySize)
        }
    }

    /// Hold the address, then slide sideways through the Workspace's tabs;
    /// or the Workspace button, through the Workspaces. SwiftUI has no
    /// press-and-slide gesture of its own, so this is a hold followed by a
    /// drag that starts where the hold left the finger.
    private func scrubGesture(_ kind: ScrubKind) -> some Gesture {
        LongPressGesture(minimumDuration: 0.3)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .global))
            // The state resets when the gesture ends or the system cancels
            // it, and either ends the scrub.
            .updating($scrubbing) { value, held, _ in
                if case .second(true, _) = value { held = kind }
            }
            .onChanged { value in
                // A new touch starts as a press, which may yet be a tap.
                if case .first(true) = value { heldForScrub = false }
                guard case .second(true, let drag) = value else { return }
                heldForScrub = true
                if let drag {
                    actions.scrub(.moved(drag.location))
                } else {
                    actions.scrub(.began(kind))
                }
            }
    }

    /// The sideways bar (12f1): the same capsules in one row, with the
    /// Workspace's name beside its emoji. It doesn't fold.
    private var sideways: some View {
        GlassEffectContainer(spacing: 3) {
            HStack(spacing: 6) {
                HStack(spacing: 0) {
                    navButton("Back", "back", size: 22, frame: 40, enabled: facts.canGoBack) { browser.goBack() }
                    navButton("Forward", "forward", size: 22, frame: 40, enabled: facts.canGoForward) { browser.goForward() }
                }
                .glassCapsule(layer)
                HStack(spacing: 0) {
                    addressRow(height: 36)
                    if let media = frontMedia { speaker(media) }
                    ReloadButton(reloads: facts.reloads).frame(width: 36, height: 44)
                }
                .padding(.horizontal, 4)
                .overlay(alignment: .bottom) { ProgressLine(line: $line, shown: $lineShown, colors: colors) }
                .glassCapsule(layer)
                if let split = facts.split, split.run.count > 2 {
                    PaneTray(split: split, tile: 34, inBar: true)
                }
                if frontMedia == nil, let media = otherMedia {
                    CompactMediaButton(tabId: media, colors: colors) { actions.media(media) }
                        .frame(width: 44, height: 44)
                        .glassEffect(workspaceGlass(layer), in: .circle)
                }
                newTabButton(size: 22, frame: 44)
                    .glassCapsule(layer)
                workspaceButton(size: 44, named: true)
                    .glassCapsule(layer)
            }
        }
        .foregroundStyle(colors.ink)
        .overlay(alignment: .top) {
            BarNotices(colors: colors, asks: facts.asks).offset(y: -52)
        }
        // Clear of the screen's rounded corners.
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
    }

    // MARK: Parts

    /// The page in front's media in the address capsule, folded or
    /// sideways (6f): the speaker on an accent wash.
    private func speaker(_ media: String) -> PillSpeaker {
        PillSpeaker(colors: colors, frame: CGSize(width: 30, height: 36), disc: 28, glyph: 13,
                    open: mediaCard == media) { actions.media(media) }
    }

    /// The pane mark: the split drawn as its panes sit, the focused one
    /// filled. It opens the split menu (12b, 12e2).
    private func splitMenu(_ split: Browser.SplitInFront) -> some View {
        let sideways = verticalSize == .compact
        let all = model.children(of: split.split.id).filter { $0.kind == .tab }
        let at = all.firstIndex { $0.id == split.focused } ?? 0
        let titles = split.slots.compactMap { model.row($0)?.displayTitle }
        return Menu {
            Section(split.split.name.isEmpty ? titles.joined(separator: " and ") : split.split.name) {
                let moves = PaneMove.labels(sideways: sideways)
                Button(moves.back.title, systemImage: moves.back.symbol) { actions.split(.move(-1)) }
                    .disabled(at == 0)
                Button(moves.ahead.title, systemImage: moves.ahead.symbol) { actions.split(.move(1)) }
                    .disabled(at == all.count - 1)
                Button("Separate", systemImage: "rectangle.split.2x1.slash") { actions.split(.separate) }
                Button("Rename Split…", systemImage: "character.cursor.ibeam") { actions.split(.rename) }
            }
            Section {
                Button("Close Tab", systemImage: "xmark", role: .destructive) { actions.split(.closeTab) }
                Button(all.count == 2 ? "Close Both" : "Close All", systemImage: "xmark.square", role: .destructive) {
                    actions.split(.closeAll)
                }
            }
        } label: {
            PaneMark(split: split, sideways: sideways, colors: colors)
                .frame(width: 30, height: 36)
                .contentShape(.rect)
        }
        .accessibilityLabel("Split")
        .accessibilityShowsLargeContentViewer()
    }

    private func shield(size: CGFloat, frame: CGSize) -> some View {
        let state = facts.shield
        let removals = facts.removals
        return Button(action: actions.site) {
            Image(state.image)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(state == .off ? colors.muted : colors.ink)
                // Always deny refused the page's media (17e). No system badge
                // sits on a symbol in a bar button, so the mark is drawn: a
                // badge inside the shield's slot.
                .overlay(alignment: .bottomTrailing) {
                    if facts.denied {
                        Badge(diameter: 13, fill: colors.badge, ring: colors.badge, ringWidth: 1) {
                            Image(systemName: "speaker.slash")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(colors.ink)
                        }
                        .offset(x: 5, y: 4)
                        .accessibilityHidden(true)
                    }
                }
                // How many removal rules the site has, as the desktop's
                // Remove from this site button counts them.
                .overlay(alignment: .topTrailing) {
                    if removals > 0 {
                        Text(removals > 99 ? "99+" : String(removals))
                            .font(.system(size: 9, weight: .bold))
                            .monospacedDigit()
                            .foregroundStyle(colors.ink)
                            .padding(.horizontal, 3)
                            .frame(minWidth: 13, minHeight: 13)
                            .background(colors.badge, in: .capsule)
                            .offset(x: 7, y: -5)
                            .accessibilityHidden(true)
                    }
                }
                .frame(width: frame.width, height: frame.height)
                .contentShape(.rect)
        }
        .disabled(state == .plain)
        .accessibilityLabel("Site settings")
        .accessibilityShowsLargeContentViewer()
        .accessibilityValue([state == .off ? "Protections off" : nil,
                             facts.denied ? "Video and audio blocked" : nil,
                             removals == 0 ? nil : removals == 1 ? "1 removal rule" : "\(removals) removal rules"]
            .compactMap { $0 }.joined(separator: ", "))
    }

    private func navButton(
        _ label: String, _ symbol: String, size: CGFloat, frame: CGFloat, enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(symbol)
                .resizable()
                .frame(width: size, height: size)
                .frame(width: frame, height: frame)
                // A 48pt target, the capsule's height, round the 40pt glyph.
                .contentShape(.rect.inset(by: -4))
        }
        .opacity(enabled ? 1 : 0.35)
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityShowsLargeContentViewer()
    }

    private var tabCount: Int { facts.tabCount }

    private var countText: String { tabCount > 99 ? "∞" : "\(tabCount)" }

    @ViewBuilder private var privateMenu: some View {
        NewPrivateTabButton { actions.privateSession(true) }
        Button("Exit Private Workspace", systemImage: "xmark", role: .destructive) { actions.privateSession(false) }
    }

    private var isPrivateSession: Bool { facts.isPrivateSession }

    /// The Workspace button: its emoji, or the private mask, with the tab
    /// count at its corner, and sideways its name beside. It opens the
    /// Workspace sheet, or the private one.
    private func workspaceButton(size: CGFloat, named: Bool = false, scale k: Double = 1) -> some View {
        Button {
            if !heldForScrub { actions.workspace() }
        } label: {
            workspaceLabel(size: size, named: named, scale: k)
        }
        .contextMenu {
            if isPrivateSession { privateMenu }
        }
        // Where the iPad's Workspace popover points.
        .anchorPreference(key: WorkspaceButtonBounds.self, value: .bounds) { $0 }
        .accessibilityLabel(isPrivateSession
            ? (tabCount == 1 ? "Private, 1 tab" : "Private, \(tabCount) tabs")
            : "\(workspace.map(WorkspaceTile.name) ?? "Workspace"), \(tabCount) tabs")
        .accessibilityInputLabels(isPrivateSession ? ["Private"] : [workspace.map(WorkspaceTile.name) ?? "Workspace", "Workspace"])
        .accessibilityShowsLargeContentViewer()
        // The private session is one Workspace, and its button's long
        // press is the session's menu.
        .simultaneousGesture(scrubGesture(.workspaces), isEnabled: !typeSize.isAccessibilitySize && !isPrivateSession)
    }

    private func workspaceLabel(size: CGFloat, named: Bool, scale k: Double) -> some View {
        HStack(spacing: 6) {
            workspaceMark(size: 22 * k)
                .overlay(alignment: .bottomTrailing) {
                    Text(countText)
                        .font(.system(.caption2, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(colors.badge)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 16, minHeight: 16)
                        .background(colors.ink, in: .capsule)
                        // A badge is a mark on its button, which holds
                        // it to the first accessibility size.
                        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                        .offset(x: 9, y: 7)
                }
            if named && !typeSize.isAccessibilitySize {
                Text(isPrivateSession ? "Private" : workspace.map(WorkspaceTile.name) ?? "Sval")
                    .font(.system(.body, weight: .semibold))
                    .lineLimit(1)
                    .padding(.leading, 6)
            }
        }
        .padding(.horizontal, named ? 12 : 0)
        .frame(minWidth: size, minHeight: size)
        .frame(maxWidth: named ? 190 : size)
        .contentShape(.capsule)
    }

    private func workspaceMark(size: CGFloat) -> some View {
        WorkspaceMark(workspace: workspace, isPrivate: isPrivateSession, size: size)
    }

    private func newTabButton(size: CGFloat, frame: CGFloat) -> some View {
        Button(action: actions.newTab) {
            Image(systemName: "plus")
                .font(.system(size: size - 2, weight: .medium))
                .frame(width: frame, height: frame)
                .contentShape(.circle)
        }
        .accessibilityLabel("New Tab")
        .accessibilityShowsLargeContentViewer()
        // A long press offers a new tab of either kind (13a2).
        .contextMenu {
            Button("New Tab", systemImage: "plus", action: actions.newTab)
            NewPrivateTabButton { actions.privateSession(true) }
        }
    }

    /// The empty address's words. An iPhone's address capsule fits only
    /// "Search" at the standard text size; VoiceOver reads the whole phrase.
    private var placeholder: String {
        horizontalSize == .compact ? "Search" : "Search or enter address"
    }

    private var address: (text: String, placeholder: Bool) {
        switch facts.address {
        case .search: (placeholder, true)
        case .text(let text, let placeholder): (text, placeholder)
        }
    }
}

/// The capsules above the bar: the download under way, then the ask for
/// video and audio, which stays nearest the bar. Each rises by its own
/// height and spacing above the one under it.
struct BarNotices: View {
    let colors: BarColors
    let asks: Bool

    var body: some View {
        VStack(spacing: 8) {
            DownloadCapsule(colors: colors)
            if asks { MediaAsk(colors: colors) }
        }
        .alignmentGuide(.top) { $0[.bottom] - 44 }
    }
}
