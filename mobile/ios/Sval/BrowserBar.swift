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
private struct BarNotices: View {
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

/// The upright bar at its fold: the one view of the bar that reads the
/// fold's value, which changes with each scroll report. It places the
/// controls `BrowserBar` built, so a page's scrolling runs neither
/// `BrowserBar`'s body nor its builders.
private struct FoldingBar<Nav: View, Row: View, NewTab: View, WorkspaceButton: View, WorkspaceLabel: View, OtherMedia: View>: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let facts: BarFacts
    let colors: BarColors
    /// What is held for a scrub: the address or the Workspace button.
    let scrubbing: ScrubKind?
    /// Back and Forward.
    let nav: Nav
    /// The shield, the pane mark, the JavaScript-off mark and the address.
    let row: Row
    let newTab: NewTab
    let workspaceButton: WorkspaceButton
    /// The Workspace button's label, lifted while it is held for a scrub.
    let workspaceLabel: WorkspaceLabel
    /// Another tab's media, beside the folded pill.
    let otherMedia: OtherMedia?
    /// The media playing, in this tab or another, above the open bar.
    let rider: NowPlayingCapsule?
    /// The page in front's media, in the folded pill.
    let speaker: PillSpeaker?
    let progress: ProgressLine
    let openBar: () -> Void

    /// The Workspace colour the capsules' glass is tinted with.
    private var layer: Color { colors.layer }

    var body: some View {
        let fold = model.browser.fold.value
        GlassFold(progress: fold) { at, t, shape in
            capsules(at, t, shape)
        }
        // Above the full bar and the folded pill alike, and above
        // another tab's now-playing capsule while that shows.
        .overlay(alignment: .top) {
            BarNotices(colors: colors, asks: facts.asks)
                .offset(y: facts.otherMedia != nil && fold < 1 ? -112 : -52)
        }
    }

    /// The upright bar at fold `t`, its capsules at `at`: Back and Forward,
    /// the address, New Tab and the Workspace button (14a1). Folded, they
    /// slide into one pill holding the shield, the address and a dot in the
    /// Workspace colour (14i5). The shield and the address stay as they
    /// are; the rest fade over the first third of the fold, and the dot
    /// over the last.
    private func capsules(_ at: [CGRect], _ t: Double, _ shape: BarShape) -> some View {
        let k = shape.scale
        let buttons = 1 - foldStep(0, 0.35, t)
        let dot = foldStep(0.65, 1, t)
        let address = at[1]
        // Each capsule's controls are its glass's own content, so they move
        // with the glass when it answers a touch.
        return ZStack(alignment: .topLeading) {
            GlassEffectContainer(spacing: 3) {
                ZStack(alignment: .topLeading) {
                    // Folded, Back, New Tab and the Workspace button lie
                    // inside the pill's ends, where their glass would show
                    // at its edge and answer a touch meant for the pill;
                    // they go once the fold is done, and their glass stops
                    // answering touches once it starts.
                    if t < 1 {
                        capsule(at[0], interactive: t == 0) {
                            nav
                                .opacity(buttons)
                                .allowsHitTesting(t == 0)
                                .accessibilityHidden(t > 0)
                        }
                    }
                    capsule(address) { addressCapsule(address, t: t, buttons: buttons, dot: dot, scale: k) }
                    if t < 1 {
                        capsule(at[2], interactive: t == 0) {
                            newTab
                                .opacity(buttons)
                                .allowsHitTesting(t == 0)
                                .accessibilityHidden(t > 0)
                        }
                        // Held for a scrub, its glass stays still under the
                        // lifted button, which would show it swelling and
                        // following the finger past its edge.
                        capsule(at[3], interactive: t == 0 && scrubbing != .workspaces) {
                            workspaceButton
                                .opacity(buttons)
                                .allowsHitTesting(t == 0)
                                .accessibilityHidden(t > 0)
                        }
                    }
                }
            }
            if scrubbing == .tabs && t == 0 {
                liftedAddress(address, t: t, buttons: buttons, dot: dot, scale: k)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.87).combined(with: .opacity))
            }
            if scrubbing == .workspaces && t == 0 {
                liftedWorkspaceButton(at[3])
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.87).combined(with: .opacity))
            }
            // Media playing, in this tab or another, rides above the bar in
            // its own capsule (14k4, 17c). Folded, the page in front's is the
            // speaker in the pill, and another tab's is its icon beside it.
            if let rider {
                rider
                    .frame(width: at[3].maxX - 8)
                    .offset(x: 8, y: -60)
                    .opacity(buttons)
                    .allowsHitTesting(t == 0)
                    .accessibilityHidden(t > 0)
            }
            if let otherMedia {
                otherMedia
                    .offset(x: address.maxX + 6, y: address.minY)
                    .opacity(dot)
                    .allowsHitTesting(t == 1)
                    .accessibilityHidden(t < 1)
            }
        }
        .foregroundStyle(colors.ink)
        .animation(.spring(duration: 0.35, bounce: 0.2), value: scrubbing)
    }

    /// One capsule: its content centred in its frame, on glass of the
    /// frame's shape, at its place in the fold.
    private func capsule<Content: View>(_ frame: CGRect, interactive: Bool = true,
                                        @ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(width: frame.width, height: frame.height)
            .glassEffect(workspaceGlass(layer, interactive: interactive), in: .capsule)
            .glassEffectTransition(.identity)
            .offset(x: frame.minX, y: frame.minY)
    }

    /// The address lifted over the bar while it is held for a scrub, grown
    /// past the buttons beside it. It is drawn outside the bar's glass
    /// container, which would merge its glass with theirs where they
    /// overlap, and it takes no touches, so the hold under it carries on.
    private func liftedAddress(_ address: CGRect, t: Double, buttons: Double, dot: Double, scale k: Double) -> some View {
        let grown: CGFloat = 1.15
        let lifted = address.insetBy(dx: -address.width * (grown - 1) / 2, dy: -address.height * (grown - 1) / 2)
        return addressCapsule(address, t: t, buttons: buttons, dot: dot, scale: k)
            .scaleEffect(grown)
            .frame(width: lifted.width, height: lifted.height)
            .glassEffect(workspaceGlass(layer, interactive: false), in: .capsule)
            .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
            .offset(x: lifted.minX, y: lifted.minY)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    /// The Workspace button lifted over the bar while it is held for a
    /// scrub, drawn as `liftedAddress` is.
    private func liftedWorkspaceButton(_ frame: CGRect) -> some View {
        let grown: CGFloat = 1.15
        let lifted = frame.insetBy(dx: -frame.width * (grown - 1) / 2, dy: -frame.height * (grown - 1) / 2)
        return workspaceLabel
            .scaleEffect(grown)
            .frame(width: lifted.width, height: lifted.height)
            .glassEffect(workspaceGlass(layer, interactive: false), in: .capsule)
            .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
            .offset(x: lifted.minX, y: lifted.minY)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    /// The address capsule's content. The shield and the address hold their
    /// place, 36pt tall on the capsule's midline, as it shrinks to the pill;
    /// Reload fades at its end, where the Workspace's dot fades in. Partway
    /// or folded, a tap anywhere on it brings the full bar back.
    private func addressCapsule(_ address: CGRect, t: Double, buttons: Double, dot: Double, scale k: Double) -> some View {
        let height = address.height - 12
        let inset = 4 * (1 - t)
        // With no page there is nothing to reload, and the address takes
        // Reload's room.
        let reloads = facts.reloads
        let room = address.width - inset - ((reloads ? 40 * k : 8) * (1 - t) + (speaker != nil ? 60 : 30) * t)
        return ZStack(alignment: .leading) {
            row
                .frame(width: max(0, room), height: height, alignment: .leading)
                .padding(.leading, inset)
                // Partway or folded, the pill is one button.
                .allowsHitTesting(t == 0)
                .accessibilityHidden(t > 0)
            ReloadButton(reloads: reloads, scale: k).frame(width: 36 * k, height: 44)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, 4)
                .opacity(reloads ? buttons : 0)
                .allowsHitTesting(t == 0)
                .accessibilityHidden(t > 0)
            workspaceDot
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, 6)
                .opacity(dot)
            if t > 0 {
                Button(action: openBar) { Color.clear.contentShape(.capsule) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Show the toolbar")
            }
            if let speaker {
                speaker
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.trailing, 32)
                    .opacity(dot)
                    .allowsHitTesting(t == 1)
                    .accessibilityHidden(t < 1)
            }
        }
        .frame(width: address.width, height: address.height)
        .overlay(alignment: .bottom) { progress.padding(.bottom, 1) }
    }

    /// The folded pill's dot: the Workspace colour, solid, with its emoji.
    private var workspaceDot: some View {
        Circle()
            .fill(layer)
            .frame(width: 24, height: 24)
            .overlay {
                WorkspaceMark(workspace: facts.workspace, isPrivate: facts.isPrivateSession, size: 13)
                    .foregroundStyle(BarColors.ink(on: layer, dark: scheme == .dark))
            }
            .accessibilityHidden(true)
    }
}

/// Reload, which turns while the page loads, as the desktop's does
/// (`sval-busy-turn`); a tap then stops the load. Under Reduce Motion the
/// stop glyph shows for the whole load instead.
private struct ReloadButton: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Whether the page in front has an address to reload.
    let reloads: Bool
    var scale: Double = 1

    var body: some View {
        let browser = model.browser!
        let k = scale
        Button {
            browser.loading ? browser.stopLoading() : browser.reload()
        } label: {
            Group {
                if browser.loading && reduceMotion {
                    Image("stop").resizable()
                } else if browser.loading {
                    TimelineView(.animation) { context in
                        Image("reload").resizable()
                            .rotationEffect(.degrees(context.date.timeIntervalSinceReferenceDate
                                .truncatingRemainder(dividingBy: 1) * 360))
                    }
                } else {
                    Image("reload").resizable()
                }
            }
            .frame(width: 19 * k, height: 19 * k)
            .frame(width: 46, height: 44)
            .contentShape(.rect)
        }
        .disabled(!reloads)
        .accessibilityLabel(browser.loading ? "Stop" : "Reload")
        .accessibilityShowsLargeContentViewer()
    }
}

/// The page's load under the address: a line in the Workspace's accent.
private struct ProgressLine: View {
    @Binding var line: Double
    @Binding var shown: Bool
    let colors: BarColors

    var body: some View {
        GeometryReader { geometry in
            Capsule()
                .fill(colors.accent)
                .frame(width: geometry.size.width * line, height: 3)
        }
        .frame(height: 3)
        .padding(.horizontal, 20)
        .opacity(shown ? 1 : 0)
        .accessibilityHidden(true)
    }
}

/// Moves the progress line with the page in front's load: it eases toward
/// the load's progress, then runs to the end and fades once the load is
/// done. It draws nothing.
private struct ProgressFollower: View {
    @Environment(AppModel.self) private var model
    @Binding var line: Double
    @Binding var shown: Bool

    var body: some View {
        let browser = model.browser!
        Color.clear
            .onChange(of: browser.progress, initial: true) { _, progress in
                guard browser.loading else { return }
                if !shown {
                    line = 0
                    shown = true
                }
                withAnimation(.easeOut(duration: 0.3)) { line = max(line, progress) }
            }
            .onChange(of: browser.loading) { _, loading in
                guard !loading, shown else { return }
                withAnimation(.easeOut(duration: 0.2)) { line = 1 } completion: {
                    withAnimation(.easeOut(duration: 0.2)) { shown = false }
                }
            }
    }
}

/// What the split menu asks for, acting on the focused pane.
enum SplitAction {
    case move(Int)
    case separate
    case rename
    case closeTab
    case closeAll
}

/// The split drawn as its two panes in view sit: stacked while the phone
/// is upright, side by side while sideways, the focused one filled.
struct PaneMark: View {
    let split: Browser.SplitInFront
    let sideways: Bool
    let colors: BarColors

    var body: some View {
        let layout = sideways ? AnyLayout(HStackLayout(spacing: 2)) : AnyLayout(VStackLayout(spacing: 2))
        layout {
            ForEach(split.slots, id: \.self) { slot in
                let focused = slot == split.focused
                RoundedRectangle(cornerRadius: 3)
                    .fill(focused ? colors.accent : .clear)
                    .overlay {
                        if !focused { RoundedRectangle(cornerRadius: 3).strokeBorder(colors.muted, lineWidth: 1.5) }
                    }
                    .frame(width: sideways ? 9 : 15, height: sideways ? 15 : 9)
            }
        }
        .accessibilityHidden(true)
    }
}

/// What the site menu's page group asks for (14d3).
enum PageAction {
    case move(OutlineRow)
    case pin(OutlineRow, URL)
    case moveToFavorites(PinRow)
    case star(StarAction)
    /// Remove from This Site: pick an element on the page to hide there.
    case removeElement
}

enum StarAction {
    case add(URL, title: String)
    case rename(Favorite)
    case move(Favorite)
    case remove(Favorite)
}

/// Whether the page in front is a favorite, as the star shows it
/// (`SvalFavorites.isCurrentFavorite`). A pin is no favorite, so a pin's
/// page shows whether its address is in Favorites (pins-root spec §6).
enum StarState {
    case none
    case add(URL, title: String)
    case favorite(Favorite)

    @MainActor init(_ model: AppModel) {
        let browser: Browser = model.browser
        // Favorites sync, so a private tab has no star, as on the desktop.
        if browser.privateInFront {
            self = .none
            return
        }
        guard let url = browser.currentURL, AppModel.opensHere(url.absoluteString) else {
            self = .none
            return
        }
        let matches = model.favorites(of: url)
        if let item = matches.first(where: { !$0.pinned }) {
            self = .favorite(item)
        } else {
            self = .add(url, title: browser.currentTitle ?? "")
        }
    }
}

/// What the shield says about the page in front, as the desktop's
/// protection button does. WebKit's content rule lists report nothing of
/// what they block, so the filled "something was blocked" shield has no
/// counterpart here.
enum ShieldState {
    case on, off, plain

    init(url: URL?, rules: SiteRules) {
        guard let url, let host = url.host(), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            self = .plain
            return
        }
        let blocking = rules.settings[ContentBlocker.levelKey] as? String ?? "balanced"
        self = blocking != "off" && rules.protectionsOn(for: host) ? .on : .off
    }

    var image: String {
        switch self {
        case .on: "pr-shield"
        case .off: "pr-shield-off"
        case .plain: "sc-shield-plain"
        }
    }
}

/// A Workspace's tile: its emoji, or its name's first letter, on its tint.
/// An agent's or a device's own wears its mark (`AppModel.markImage`).
struct WorkspaceTile: View {
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    let workspace: OutlineRow?
    let size: CGFloat
    /// The tile's fill where it sits on the Workspace's own tint, as in the
    /// bar; elsewhere the tint itself.
    var fill: Color?
    var radius: CGFloat?

    static func name(_ row: OutlineRow) -> String {
        row.displayTitle
    }

    @Environment(AppModel.self) private var model

    var body: some View {
        if let workspace, model.isPrivate(workspace.id) {
            PrivateTile(size: size, radius: radius ?? size * Radius.tileFactor)
        } else {
            tile
        }
    }

    private var tile: some View {
        let tint = workspace?.color.flatMap(WorkspaceTint.init(rawValue:))
        let dark = scheme == .dark
        // The surface the tile sits on, for its edge and a colourless
        // tile's fill.
        let surface = Theme(scheme, tint: sheetTint)
        let background = fill ?? tint?.tile(dark: dark) ?? surface.cell
        let corner = radius ?? size * Radius.tileFactor
        return RoundedRectangle(cornerRadius: corner)
            .fill(background)
            .overlay {
                RoundedRectangle(cornerRadius: corner)
                    .strokeBorder(surface.tileRing, lineWidth: 1.5)
            }
            .overlay {
                if let image = workspace.flatMap(model.markImage) {
                    Image(image)
                        .resizable()
                        .scaledToFit()
                        .frame(width: size * 0.5, height: size * 0.5)
                        .foregroundStyle(tint == nil && fill == nil ? surface.text : Theme(scheme, tint: workspace?.color).text)
                } else if let emoji = workspace?.emoji, !emoji.isEmpty {
                    Text(emoji).font(.system(size: size * 0.55)).accessibilityIgnoresInvertColors()
                } else {
                    Text(workspace.map { String(Self.name($0).prefix(1)).uppercased() } ?? "")
                        .font(SvalFont.outfit(size * 0.45, .bold, relativeTo: .body))
                        // A colourless tile is the surface's cell, so its
                        // letter takes the surface's ink.
                        .foregroundStyle(tint == nil && fill == nil ? surface.text : Theme(scheme, tint: workspace?.color).text)
                }
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Another Workspace's bar as it slides in under a swipe: the same glass
/// capsules, folded as far as the bar beside it, over that Workspace's
/// colour, with its emoji where the Workspace button sits.
struct BarPreview: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.verticalSizeClass) private var verticalSize
    let workspace: OutlineRow

    private var colors: BarColors { BarColors(token: model.tint(of: workspace), dark: scheme == .dark) }
    private var layer: Color { colors.layer }

    var body: some View {
        Group {
            if verticalSize == .compact {
                GlassEffectContainer(spacing: 3) {
                    HStack(spacing: 6) {
                        Color.clear.frame(width: 80, height: 44).glassCapsule(layer)
                        Color.clear.frame(maxWidth: .infinity, minHeight: 44, maxHeight: 44).glassCapsule(layer)
                        Color.clear.frame(width: 44, height: 44).glassCapsule(layer)
                        HStack(spacing: 6) {
                            mark(size: 22)
                            Text(WorkspaceTile.name(workspace))
                                .font(.system(.body, weight: .semibold))
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .glassCapsule(layer)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 8)
            } else {
                // Folded as far as the bar it stands beside.
                GlassFold(progress: model.browser.fold.value) { at, t, shape in
                    ZStack(alignment: .topLeading) {
                        GlassEffectContainer(spacing: 3) {
                            ZStack(alignment: .topLeading) {
                                ForEach(at.indices, id: \.self) { index in
                                    Color.clear
                                        .frame(width: at[index].width, height: at[index].height)
                                        .glassEffect(workspaceGlass(layer, interactive: false), in: .capsule)
                                        .offset(x: at[index].minX, y: at[index].minY)
                                }
                            }
                        }
                        mark(size: 22 * shape.scale)
                            .frame(width: 48, height: 48)
                            .offset(x: at[3].midX - 24, y: at[3].midY - 24)
                            .opacity(1 - foldStep(0, 0.35, t))
                        Circle().fill(layer).frame(width: 24, height: 24)
                            .overlay {
                                mark(size: 13)
                                    .foregroundStyle(BarColors.ink(on: layer, dark: scheme == .dark))
                            }
                            .offset(x: at[1].maxX - 30, y: at[1].midY - 12)
                            .opacity(foldStep(0.65, 1, t))
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .foregroundStyle(colors.ink)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func mark(size: CGFloat) -> some View {
        WorkspaceMark(workspace: workspace, isPrivate: model.isPrivate(workspace.id), size: size)
    }
}

/// A Workspace's mark in the bar: its emoji, its name's initial when it
/// has none, the private mask, or an agent's or device's mark
/// (`AppModel.markImage`), in the ink around it.
struct WorkspaceMark: View {
    @Environment(AppModel.self) private var model
    let workspace: OutlineRow?
    let isPrivate: Bool
    let size: CGFloat

    var body: some View {
        if isPrivate {
            Image("private").resizable().scaledToFit().frame(width: size, height: size)
        } else if let image = workspace.flatMap(model.markImage) {
            Image(image).resizable().scaledToFit().frame(width: size * 0.8, height: size * 0.8)
        } else if let emoji = workspace?.emoji, !emoji.isEmpty {
            Text(emoji).font(.system(size: size * 0.9)).accessibilityIgnoresInvertColors()
        } else {
            Text(workspace.map { String(WorkspaceTile.name($0).prefix(1)).uppercased() } ?? "")
                .font(SvalFont.outfit(size * 0.8, .bold, relativeTo: .body))
        }
    }
}

/// The private session's tile: Private Violet with the desktop's private
/// mask (round 5, 13a1).
struct PrivateTile: View {
    let size: CGFloat
    var radius: CGFloat?

    var body: some View {
        let corner = radius ?? size * Radius.tileFactor
        RoundedRectangle(cornerRadius: corner)
            .fill(Theme.privateViolet)
            .overlay { RoundedRectangle(cornerRadius: corner).strokeBorder(Theme.privateEdge.opacity(0.6), lineWidth: 1.5) }
            .overlay {
                Image("private").resizable().scaledToFit()
                    .frame(width: size * 0.52, height: size * 0.52)
                    .foregroundStyle(.white)
            }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
