// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// The bar at the foot of the browser: four glass capsules floating over
/// the page, each in the Workspace's colour (round 6). Back and Forward,
/// the address with the site menu and reload, New Tab, and the Workspace.
/// As the page scrolls down they fold into one pill (`Browser.barFold`).
struct BrowserBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.verticalSizeClass) private var verticalSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let workspace: OutlineRow?
    let colors: BarColors
    let onSite: () -> Void
    let onAddress: () -> Void
    /// Opens the Workspace sheet.
    let onWorkspace: () -> Void
    let onNewTab: () -> Void
    /// The tab whose media card is open, if one is.
    var mediaCard: String?
    /// Opens the media card for a tab.
    var onMedia: (String) -> Void = { _ in }
    /// What the star in the address pill asks for.
    var onStar: (StarAction) -> Void = { _ in }
    /// What the split menu asks for.
    var onSplit: (SplitAction) -> Void = { _ in }
    /// Opens a tab in the private session, or ends the session (false).
    var onPrivate: (Bool) -> Void = { _ in }

    /// The progress line's length, which eases toward the page's progress
    /// and runs to the end before it fades once the load is done.
    @State private var line = 0.0
    @State private var lineShown = false

    private var browser: Browser { model.browser }
    private var theme: Theme { Theme(scheme) }

    /// Another tab whose media the bar shows: playing, or paused a moment
    /// ago.
    private var otherMedia: String? {
        guard let id = browser.mediaTab, id != browser.currentTabId, browser.mediaShown(id) else { return nil }
        return id
    }

    /// Whether the bar asks to allow the page in front's media: Ask first
    /// refused it, and nothing of its plays.
    private var asks: Bool { browser.frontAsks && frontMedia == nil }

    /// Whether the page in front has media to show in the address capsule.
    private var frontMedia: String? {
        guard let id = browser.currentTabId, browser.mediaShown(id) else { return nil }
        return id
    }

    /// The Workspace colour the capsules' glass is tinted with.
    private var layer: Color { colors.layer }

    var body: some View {
        Group {
            // Sideways the bar is one row already, so it stays as it is
            // while the page scrolls.
            if verticalSize == .compact {
                sideways
            } else {
                GlassFold(progress: browser.barFold) { at, t in
                    capsules(at, t)
                }
                // Above the full bar and the folded pill alike, and above
                // another tab's now-playing capsule while that shows.
                .overlay(alignment: .top) {
                    if asks {
                        MediaAsk(colors: colors)
                            .offset(y: otherMedia != nil && browser.barFold < 1 ? -112 : -52)
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .onChange(of: browser.progress, initial: true) { _, progress in
            guard browser.loading else { return }
            if !lineShown {
                line = 0
                lineShown = true
            }
            withAnimation(.easeOut(duration: 0.3)) { line = max(line, progress) }
        }
        .onChange(of: browser.loading) { _, loading in
            guard !loading, lineShown else { return }
            withAnimation(.easeOut(duration: 0.2)) { line = 1 } completion: {
                withAnimation(.easeOut(duration: 0.2)) { lineShown = false }
            }
        }
    }

    /// The upright bar at fold `t`, its capsules at `at`: Back and Forward,
    /// the address, New Tab and the Workspace button (14a1). Folded, they
    /// slide into one pill holding the shield, the address and a dot in the
    /// Workspace colour (14i5). The shield and the address stay as they
    /// are; the rest fade over the first third of the fold, and the dot
    /// over the last.
    private func capsules(_ at: [CGRect], _ t: Double) -> some View {
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
                            HStack(spacing: 0) {
                                navButton("Back", "back", size: 24, frame: 40, enabled: browser.canGoBack) { browser.goBack() }
                                navButton("Forward", "forward", size: 24, frame: 40, enabled: browser.canGoForward) {
                                    browser.goForward()
                                }
                            }
                            .opacity(buttons)
                            .allowsHitTesting(t == 0)
                            .accessibilityHidden(t > 0)
                        }
                    }
                    capsule(address) { addressCapsule(address, t: t, buttons: buttons, dot: dot) }
                    if t < 1 {
                        capsule(at[2], interactive: t == 0) {
                            newTabButton(size: 24, frame: 48)
                                .opacity(buttons)
                                .allowsHitTesting(t == 0)
                                .accessibilityHidden(t > 0)
                        }
                        capsule(at[3], interactive: t == 0) {
                            workspaceButton(size: 48)
                                .opacity(buttons)
                                .allowsHitTesting(t == 0)
                                .accessibilityHidden(t > 0)
                        }
                    }
                }
            }
            // Media playing, in this tab or another, rides above the bar in
            // its own capsule (14k4, 17c). Folded, the page in front's is the
            // speaker in the pill, and another tab's is its icon beside it.
            if let media = frontMedia ?? otherMedia {
                NowPlayingCapsule(tabId: media, colors: colors) { onMedia(media) }
                    .frame(width: at[3].maxX - 8)
                    .offset(x: 8, y: -60)
                    .opacity(buttons)
                    .allowsHitTesting(t == 0)
                    .accessibilityHidden(t > 0)
            }
            if frontMedia == nil, let media = otherMedia {
                Button { onMedia(media) } label: {
                    Group { if let row = model.row(media) { SiteTile(row: row, size: 26) } }
                        .frame(width: 48, height: 48)
                }
                .glassEffect(workspaceGlass(layer), in: .circle)
                .offset(x: address.maxX + 6, y: address.minY)
                .opacity(dot)
                .allowsHitTesting(t == 1)
                .accessibilityHidden(t < 1)
                .accessibilityLabel("Video and Audio")
            }
        }
        .foregroundStyle(colors.ink)
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

    /// The address capsule's content. The shield and the address hold their
    /// place, 36pt tall on the capsule's midline, as it shrinks to the pill;
    /// Reload fades at its end, where the Workspace's dot fades in. Partway
    /// or folded, a tap anywhere on it brings the full bar back.
    private func addressCapsule(_ address: CGRect, t: Double, buttons: Double, dot: Double) -> some View {
        let inset = 4 * (1 - t)
        // With no page there is nothing to reload, and the address takes
        // Reload's room.
        let reloads = browser.currentURL != nil
        let room = address.width - inset - ((reloads ? 40 : 8) * (1 - t) + (frontMedia != nil ? 60 : 30) * t)
        return ZStack(alignment: .leading) {
            addressRow(height: 36)
                .frame(width: max(0, room), height: 36, alignment: .leading)
                .padding(.leading, inset)
                // Partway or folded, the pill is one button.
                .allowsHitTesting(t == 0)
                .accessibilityHidden(t > 0)
            reload.frame(width: 36, height: 44)
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
                Button { browser.openBar() } label: { Color.clear.contentShape(.capsule) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Show the toolbar")
            }
            if let media = frontMedia {
                speaker(media)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.trailing, 32)
                    .opacity(dot)
                    .allowsHitTesting(t == 1)
                    .accessibilityHidden(t < 1)
            }
        }
        .frame(width: address.width, height: address.height)
        .overlay(alignment: .bottom) { progressLine.padding(.bottom, 1) }
    }

    /// The shield, the pane mark of a split in front, the JavaScript-off
    /// mark and the address, left-aligned, which stay put as the bar folds.
    private func addressRow(height: Double) -> some View {
        HStack(spacing: 0) {
            shield(size: 21, frame: CGSize(width: 36, height: height))
            if let split = browser.splitInFront {
                splitMenu(split)
            }
            Button(action: onAddress) {
                HStack(spacing: 6) {
                    if javaScriptOff {
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
                : "Address, \(address.text)\(javaScriptOff ? ", JavaScript off" : "")")
            // Voice Control takes the words on screen first.
            .accessibilityInputLabels(address.placeholder ? [address.text] : [address.text, "Address"])
            // The bar keeps its height at every text size, so its controls
            // show enlarged on a long press, as a tab bar's do.
            .accessibilityShowsLargeContentViewer()
        }
    }

    /// The sideways bar (12f1): the same capsules in one row, with the
    /// Workspace's name beside its emoji. It doesn't fold.
    private var sideways: some View {
        GlassEffectContainer(spacing: 3) {
            HStack(spacing: 6) {
                HStack(spacing: 0) {
                    navButton("Back", "back", size: 22, frame: 40, enabled: browser.canGoBack) { browser.goBack() }
                    navButton("Forward", "forward", size: 22, frame: 40, enabled: browser.canGoForward) { browser.goForward() }
                }
                .glassCapsule(layer)
                HStack(spacing: 0) {
                    addressRow(height: 36)
                    if let media = frontMedia { speaker(media) }
                    reload.frame(width: 36, height: 44)
                }
                .padding(.horizontal, 4)
                .overlay(alignment: .bottom) { progressLine }
                .glassCapsule(layer)
                if let split = browser.splitInFront, split.run.count > 2 {
                    PaneTray(split: split, tile: 34, inBar: true)
                }
                if frontMedia == nil, let media = otherMedia {
                    CompactMediaButton(tabId: media, colors: colors) { onMedia(media) }
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
            if asks {
                MediaAsk(colors: colors).offset(y: -52)
            }
        }
        // Clear of the screen's rounded corners.
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
    }

    // MARK: Parts

    /// The page in front's media in the address capsule, folded or
    /// sideways (6f): the speaker on an accent wash.
    private func speaker(_ media: String) -> some View {
        PillSpeaker(colors: colors, frame: CGSize(width: 30, height: 36), disc: 28, glyph: 13,
                    open: mediaCard == media) { onMedia(media) }
    }

    /// The pane mark: the split drawn as its panes sit, the focused one
    /// filled. It opens the split menu (12b, 12e2).
    private func splitMenu(_ split: Browser.SplitInFront) -> some View {
        let sideways = verticalSize == .compact
        let all = model.children(of: split.split.id).filter { $0.kind == "tab" }
        let at = all.firstIndex { $0.id == split.focused } ?? 0
        let titles = split.slots.compactMap { model.row($0)?.displayTitle }
        return Menu {
            Section(split.split.name.isEmpty ? titles.joined(separator: " and ") : split.split.name) {
                let moves = PaneMove.labels(sideways: sideways)
                Button(moves.back.title, systemImage: moves.back.symbol) { onSplit(.move(-1)) }
                    .disabled(at == 0)
                Button(moves.ahead.title, systemImage: moves.ahead.symbol) { onSplit(.move(1)) }
                    .disabled(at == all.count - 1)
                Button("Separate", systemImage: "rectangle.split.2x1.slash") { onSplit(.separate) }
                Button("Rename Split…", systemImage: "character.cursor.ibeam") { onSplit(.rename) }
            }
            Section {
                Button("Close Tab", systemImage: "xmark", role: .destructive) { onSplit(.closeTab) }
                Button(all.count == 2 ? "Close Both" : "Close All", systemImage: "xmark.square", role: .destructive) {
                    onSplit(.closeAll)
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
        let state = ShieldState(url: browser.currentURL, rules: model.siteRules(private: browser.privateInFront))
        // My filters' lines that remove something on this site, which
        // apply at every level and with protections off (decision 1993).
        let removals = state == .plain ? 0
            : browser.currentURL?.host().map { MyFilters.removals(on: $0, settings: model.settings).count } ?? 0
        return Button(action: onSite) {
            Image(state.image)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
                .foregroundStyle(state == .off ? colors.muted : colors.ink)
                // Always deny refused the page's media (17e). No system badge
                // sits on a symbol in a bar button, so the mark is drawn: a
                // badge inside the shield's slot.
                .overlay(alignment: .bottomTrailing) {
                    if browser.frontDenied {
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
                             browser.frontDenied ? "Video and audio blocked" : nil,
                             removals == 0 ? nil : removals == 1 ? "1 removal rule" : "\(removals) removal rules"]
            .compactMap { $0 }.joined(separator: ", "))
    }

    /// Reload, which turns while the page loads, as the desktop's does
    /// (`sval-busy-turn`); a tap then stops the load. Under Reduce Motion
    /// the stop glyph shows for the whole load instead.
    private var reload: some View {
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
            .frame(width: 19, height: 19)
            .frame(width: 46, height: 44)
            .contentShape(.rect)
        }
        .disabled(browser.currentURL == nil)
        .accessibilityLabel(browser.loading ? "Stop" : "Reload")
        .accessibilityShowsLargeContentViewer()
    }

    private var progressLine: some View {
        GeometryReader { geometry in
            Capsule()
                .fill(colors.accent)
                .frame(width: geometry.size.width * line, height: 3)
        }
        .frame(height: 3)
        .padding(.horizontal, 20)
        .opacity(lineShown ? 1 : 0)
        .accessibilityHidden(true)
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

    /// Whether the page in front runs without JavaScript, by its site's
    /// rule, which the full bar marks before the address.
    private var javaScriptOff: Bool {
        guard let host = browser.currentURL?.host() else { return false }
        return !SiteRules(settings: model.settings).javaScriptEnabled(on: host)
    }

    private var tabCount: Int { model.tabs(in: browser.workspaceId).count }

    private var countText: String { tabCount > 99 ? "∞" : "\(tabCount)" }

    @ViewBuilder private var privateMenu: some View {
        NewPrivateTabButton { onPrivate(true) }
        Button("Exit Private Workspace", systemImage: "xmark", role: .destructive) { onPrivate(false) }
    }

    private var isPrivateSession: Bool { workspace.map { model.isPrivate($0.id) } ?? false }

    /// The Workspace button: its emoji, or the private mask, with the tab
    /// count at its corner, and sideways its name beside. It opens the
    /// Workspace sheet, or the private one.
    private func workspaceButton(size: CGFloat, named: Bool = false) -> some View {
        Button(action: onWorkspace) {
            HStack(spacing: 6) {
                workspaceMark(size: 22)
                    .overlay(alignment: .bottomTrailing) {
                        Text(countText)
                            .font(.system(.caption2, weight: .bold))
                            .monospacedDigit()
                            .foregroundStyle(colors.badge)
                            .padding(.horizontal, 4)
                            .frame(minWidth: 16, minHeight: 16)
                            .background(colors.ink, in: .capsule)
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
        .contextMenu {
            if isPrivateSession { privateMenu }
        }
        .accessibilityLabel(isPrivateSession
            ? (tabCount == 1 ? "Private, 1 tab" : "Private, \(tabCount) tabs")
            : "\(workspace.map(WorkspaceTile.name) ?? "Workspace"), \(tabCount) tabs")
        .accessibilityInputLabels(isPrivateSession ? ["Private"] : [workspace.map(WorkspaceTile.name) ?? "Workspace", "Workspace"])
        .accessibilityShowsLargeContentViewer()
    }

    private func workspaceMark(size: CGFloat) -> some View {
        WorkspaceMark(workspace: workspace, isPrivate: isPrivateSession, size: size)
    }

    /// The folded pill's dot: the Workspace colour, solid, with its emoji.
    private var workspaceDot: some View {
        Circle()
            .fill(layer)
            .frame(width: 24, height: 24)
            .overlay {
                workspaceMark(size: 13)
                    .foregroundStyle(BarColors.ink(on: layer, dark: scheme == .dark))
            }
            .accessibilityHidden(true)
    }

    private func newTabButton(size: CGFloat, frame: CGFloat) -> some View {
        Button(action: onNewTab) {
            Image(systemName: "plus")
                .font(.system(size: size - 2, weight: .medium))
                .frame(width: frame, height: frame)
                .contentShape(.circle)
        }
        .accessibilityLabel("New Tab")
        .accessibilityShowsLargeContentViewer()
        // A long press offers a new tab of either kind (13a2).
        .contextMenu {
            Button("New Tab", systemImage: "plus", action: onNewTab)
            NewPrivateTabButton { onPrivate(true) }
        }
    }

    private var address: (text: String, placeholder: Bool) {
        if let id = browser.currentTabId, model.row(id)?.awaitsPick == true {
            return ("Choose a page", true)
        }
        if browser.onPrivateHome {
            return ("Search or enter address", true)
        }
        // A pin's page reads as the pin, and once off its saved page, where
        // it is now (pins spec §4).
        if let pin = browser.currentPin {
            let name = pin.name.isEmpty ? (pin.url ?? "") : pin.name
            guard browser.pinOffSaved, let title = browser.currentTitle, !title.isEmpty else { return (name, false) }
            return ("\(name) / \(title)", false)
        }
        if let url = browser.currentURL, let host = url.host() {
            return (SiteRules.site(of: host) ?? host, false)
        }
        if let id = browser.currentTabId, let row = model.row(id), let address = row.url {
            let url = URL(string: address)
            if let host = url?.host(), Browser.openable(row) != nil {
                return (SiteRules.site(of: host) ?? host, false)
            }
            return (url?.lastPathComponent ?? address, false)
        }
        return ("Search or enter address", true)
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
    var scale: CGFloat = 1

    var body: some View {
        let layout = sideways ? AnyLayout(HStackLayout(spacing: 2 * scale)) : AnyLayout(VStackLayout(spacing: 2 * scale))
        layout {
            ForEach(split.slots, id: \.self) { slot in
                let focused = slot == split.focused
                RoundedRectangle(cornerRadius: 3 * scale)
                    .fill(focused ? colors.accent : .clear)
                    .overlay {
                        if !focused { RoundedRectangle(cornerRadius: 3 * scale).strokeBorder(colors.muted, lineWidth: 1.5 * max(scale, 0.7)) }
                    }
                    .frame(width: (sideways ? 9 : 15) * scale, height: (sideways ? 15 : 9) * scale)
            }
        }
        .accessibilityHidden(true)
    }
}

/// What the address bar's star asks for.
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
    /// How far the bar it stands beside is folded.
    var fold = 0.0

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
                GlassFold(progress: fold) { at, t in
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
                        mark(size: 22)
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
