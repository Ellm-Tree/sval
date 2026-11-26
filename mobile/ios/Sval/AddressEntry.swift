// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// Typing an address: the field rides on the keyboard, and suggestions grow
/// up from it, so the best match sits right above the thumb.
struct AddressEntry: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.verticalSizeClass) private var verticalSize
    /// Whether what's entered opens in a new tab in the Workspace shown.
    let newTab: Bool
    let onDone: () -> Void

    @State private var text = ""
    /// The address the field opened with, selected so typing replaces it.
    @State private var original = ""
    @State private var selection: TextSelection?
    @State private var listHeight: CGFloat = 0
    /// The site the field completed what was typed to, with the completed
    /// part selected, as Firefox's autofill does.
    @State private var autofill: (typed: String, text: String, url: URL)?
    /// The suggestions for what was typed, searched off the main thread.
    /// They stay on screen until the next key's are ready.
    @State private var found = LauncherResults()
    /// The search engine's suggestions for what was typed. They arrive
    /// apart from `found`, which never waits for the network, and stay on
    /// screen until the next key's are ready.
    @State private var suggested: [String] = []
    @FocusState private var focused: Bool

    /// In the private palette while a private tab is in front (13g).
    private var theme: Theme { Theme(scheme, tint: browser.inPrivate ?Theme.privateToken : nil) }
    private var browser: Browser { model.browser }
    /// The address of the tab in front. A tab whose load became a
    /// download has no page, so its address is the tab's own, as the bar
    /// shows it.
    private var address: URL? {
        browser.currentURL ?? browser.currentTabId.flatMap { model.row($0)?.url }.flatMap(URL.init(string:))
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
                .contentShape(.rect)
                .onTapGesture(perform: onDone)
            suggestions
            field
        }
        .background(theme.scrim.ignoresSafeArea().onTapGesture(perform: onDone))
        // Over the page, as a sheet is: VoiceOver stays in it, and the
        // escape gesture closes it.
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, onDone)
        // Esc on a hardware keyboard closes it too.
        .onKeyPress(.escape) {
            onDone()
            return .handled
        }
        .onAppear {
            if !newTab, let address {
                text = address.absoluteString
                original = text
            }
            focused = true
        }
        .onChange(of: text) { old, new in complete(old, new) }
        .task(id: Search(query: query, generation: model.launcherIndex.generation, inPrivate: browser.inPrivate,
                         currentTabId: browser.currentTabId, workspaceId: browser.workspaceId,
                         currentPin: browser.currentPin?.guid)) {
            await search()
        }
        .task(id: SuggestionSearch(query: query, engine: SearchEngine(settings: model.settings).id,
                                   limit: SearchSuggestions.limit(settings: model.settings, inPrivate: browser.inPrivate))) {
            await suggest()
        }
        .onChange(of: focused) { _, now in
            // Selected once the field has focus: a selection set before
            // that is replaced by the caret focus puts at the end.
            guard now, !original.isEmpty, text == original else { return }
            Task { @MainActor in
                selection = TextSelection(range: text.startIndex..<text.endIndex)
            }
        }
    }

    /// What the user typed: nothing while the field still holds the address
    /// it opened with, as the desktop's Launcher reads it.
    private var query: String {
        text == original ? "" : (autofill?.typed ?? text).trimmingCharacters(in: .whitespaces)
    }

    /// What a search for suggestions depends on: a change to any of it
    /// cancels the search under way and starts another.
    private struct Search: Equatable {
        let query: String
        let generation: Int
        let inPrivate: Bool
        let currentTabId: String?
        let workspaceId: String?
        let currentPin: String?
    }

    /// What asking the engine depends on, of all the synced settings: the
    /// engine, and the limit its switches set.
    private struct SuggestionSearch: Equatable {
        let query: String
        let engine: String
        let limit: Int
    }

    /// Asks the engine for suggestions. Each key cancels the request
    /// before it.
    private func suggest() async {
        let query = query
        let settings = model.settings
        let limit = SearchSuggestions.limit(settings: settings, inPrivate: browser.inPrivate)
        guard let rows = try? await SearchSuggestions.fetch(query, settings: settings, limit: limit),
              !Task.isCancelled else { return }
        suggested = rows
    }

    /// Searches the Launcher's index for what was typed. The search runs off
    /// the main thread, so typing never waits for it, and each key cancels
    /// the search before it. A key that types on searches only what the
    /// last key's search matched.
    private func search() async {
        let query = query
        guard !query.isEmpty else {
            found = LauncherResults()
            return
        }
        let index = model.launcherIndex
        let context = LauncherResults.Context(
            inPrivate: browser.inPrivate, currentTabId: browser.currentTabId, workspaceId: browser.workspaceId,
            currentPin: browser.currentPin?.guid, usedAt: browser.usedAtSnapshot)
        let previous = found.matched
        let task = Task.detached(priority: .userInitiated) {
            try LauncherResults(query: query, index: index, context: context, after: previous)
        }
        let results = await withTaskCancellationHandler {
            try? await task.value
        } onCancel: {
            task.cancel()
        }
        guard let results, !Task.isCancelled else { return }
        found = results
    }

    /// Completes a site from history as the user types forward; deleting,
    /// or typing past the completion, takes it away.
    private func complete(_ old: String, _ new: String) {
        if let autofill, new == autofill.text { return }
        let typed = autofill?.typed ?? old
        autofill = nil
        guard focused, new != original, new.count > typed.count,
              !browser.inPrivate,
              let found = model.launcherIndex.autofill(new), found.text != new else { return }
        autofill = (new, found.text, found.url)
        text = found.text
        let start = found.text.index(found.text.startIndex, offsetBy: new.count)
        selection = TextSelection(range: start..<found.text.endIndex)
    }

    /// A history row loads its page in this tab, or in the new tab the
    /// Launcher was opened for, as typing its address would.
    private func historyRow(_ page: HistoryPage) -> some View {
        let host = URL(string: page.url)?.host() ?? page.url
        return Button {
            guard let url = URL(string: page.url) else { return }
            onDone()
            Task {
                if newTab || browser.currentTabId == nil,
                   let workspace = model.newTabWorkspace(from: browser.workspaceId) {
                    await browser.openNewTab(url, in: workspace, transition: HistoryPage.typed)
                } else {
                    await browser.open(url, transition: HistoryPage.typed)
                }
            }
        } label: {
            LauncherRow(title: page.title.isEmpty ? host : page.title, subtitle: host, colors: colors) {
                SiteTile(url: page.url, name: page.title, size: Tile.row)
            }
        }
        // As Shift+Delete removes a history row on the desktop: every visit
        // to the page goes, on every device.
        .contextMenu {
            Button("Delete", systemImage: "trash", role: .destructive) {
                Task { await model.deleteFromHistory(page.url) }
            }
        }
    }

    /// A pin brings its page to the front; a Favorite opens a new tab
    /// (pins spec §1).
    private func keptRow(_ kept: LauncherResults.Kept) -> some View {
        let host = URL(string: kept.url)?.host() ?? kept.url
        return Button {
            if let pin = kept.pin {
                browser.selectPin(pin)
                onDone()
            } else if let url = URL(string: kept.url), let workspace = model.newTabWorkspace(from: browser.workspaceId) {
                onDone()
                Task { await browser.openNewTab(url, in: workspace, transition: HistoryPage.bookmark) }
            }
        } label: {
            LauncherRow(title: kept.name.isEmpty ? host : kept.name, subtitle: host, colors: colors) {
                SiteTile(url: kept.url, name: kept.name, size: Tile.row)
            } trailing: {
                if kept.pin != nil {
                    Image(systemName: "pin.fill")
                        .font(Glyph.status)
                        .foregroundStyle(colors.muted)
                        .accessibilityLabel("Pinned")
                }
            }
        }
    }

    @ViewBuilder private var suggestions: some View {
        let query = query
        if query.isEmpty {
            emptySuggestions
        } else {
            let results = found
            list {
                // The list grows up from the field, so it runs in the
                // desktop's order read from the bottom: the row Enter takes
                // sits right above the field, and each section's best row
                // nearest it. Sideways, History is the left column (12f4).
                let sideways = verticalSize == .compact
                let layout = sideways
                    ? AnyLayout(HStackLayout(alignment: .bottom, spacing: 8)) : AnyLayout(VStackLayout(spacing: 0))
                layout {
                    let order = results.order(suggesting: !suggested.isEmpty)
                    if sideways && order.contains(.history) {
                        section(.history, results)
                    }
                    VStack(spacing: 0) {
                        ForEach(order.reversed().filter { !sideways || $0 != .history }, id: \.self) { section in
                            self.section(section, results)
                        }
                        // Sval's own command, offered when the text names
                        // it or the desktop's synonyms for it
                        // (`launcher-command-private-window-synonyms`, 13a3);
                        // never from inside the session.
                        if !browser.inPrivate, LauncherMatch.words(query).allSatisfy({ word in
                            ["New Private Tab", "incognito, private browsing"].contains { LauncherMatch.onBoundary(word, $0) }
                        }) {
                            privateCommandRow
                                .accessibilitySortPriority(1)
                        }
                        // The row Enter takes: the completed site, the
                        // address typed, or the search. VoiceOver reads it
                        // first, as the desktop lists it.
                        searchRow(autofill.flatMap { $0.text == text ? $0.text : nil } ?? query)
                            .accessibilitySortPriority(2)
                    }
                    .accessibilityElement(children: .contain)
                }
            }
        }
    }

    /// With nothing typed: this iPhone's recently closed tabs, the most
    /// recently used tabs, and this Workspace's pins (round 1, 2h).
    @ViewBuilder private var emptySuggestions: some View {
        let recent = LauncherResults.suggests("openpage", settings: model.settings) ? browser.recentTabs() : []
        // Closed tabs are the user's: a private tab leaves none.
        let closed = browser.inPrivate ? [] : Array(browser.recentlyClosed.prefix(3))
        let pins = (browser.inPrivate ? [] : browser.workspaceId.flatMap { model.pinsByWorkspace[$0] } ?? [])
            .filter { $0.kind == "favorite" && $0.guid != browser.currentPin?.guid }
            .compactMap { pin in pin.url.map { LauncherResults.Kept(id: pin.id, name: pin.name, url: $0, pin: pin) } }
            .prefix(3)
        if !recent.isEmpty || !closed.isEmpty || !pins.isEmpty {
            list {
                VStack(spacing: 0) {
                    if !closed.isEmpty {
                        caption("Recently closed")
                        ForEach(closed) { closedRow($0) }
                    }
                    if !recent.isEmpty {
                        caption("Recent tabs")
                        ForEach(recent, id: \.id) { tabRow($0) }
                    }
                    if !pins.isEmpty {
                        caption("Pins")
                        ForEach(Array(pins)) { keptRow($0) }
                    }
                }
            }
        }
    }

    /// The suggestions' card. Rows stay inside it, and fade at an edge with
    /// more to scroll to, as the pins row and the Workspace strip do.
    private func list<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.card)
        return ScrollView {
            content()
                .padding(8)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { listHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .defaultScrollAnchor(.bottom)
        .scrollEdgeFade()
        .frame(maxHeight: listHeight)
        .clipShape(shape)
        // Glass in the Workspace's colour, as the bar's (14i).
        .glassEffect(workspaceGlass(layer, interactive: false), in: shape)
        .padding(.horizontal, 8)
        .padding(.top, 8)
    }

    /// One section, its best row at the bottom, nearest the field.
    @ViewBuilder private func section(_ section: LauncherResults.Section, _ results: LauncherResults) -> some View {
        VStack(spacing: 0) {
            switch section {
            case .tabs:
                caption(browser.inPrivate ?"Private tabs" : "Open tabs").accessibilitySortPriority(1)
                ForEach(Array(results.tabs.enumerated()).reversed(), id: \.element.id) { rank, tab in
                    tabRow(tab).accessibilitySortPriority(Double(-rank))
                }
            case .favorites:
                caption("Pins and Favorites").accessibilitySortPriority(1)
                ForEach(Array(results.kept.enumerated()).reversed(), id: \.element.id) { rank, kept in
                    keptRow(kept).accessibilitySortPriority(Double(-rank))
                }
            case .history:
                caption("History").accessibilitySortPriority(1)
                ForEach(Array(results.history.enumerated()).reversed(), id: \.element.url) { rank, page in
                    historyRow(page).accessibilitySortPriority(Double(-rank))
                }
            case .suggestions:
                caption("Search suggestions").accessibilitySortPriority(1)
                ForEach(Array(suggested.enumerated()).reversed(), id: \.element) { rank, suggestion in
                    suggestionRow(suggestion).accessibilitySortPriority(Double(-rank))
                }
            }
        }
        // The rows are drawn best last, nearest the field; VoiceOver reads
        // the heading, then the best row first, in the desktop's order.
        .accessibilityElement(children: .contain)
        .accessibilitySortPriority(Double(-(results.order(suggesting: !suggested.isEmpty).firstIndex(of: section) ?? 0)))
    }

    private var privateCommandRow: some View {
        Button {
            onDone()
            Task { await model.showPrivateSession() }
        } label: {
            LauncherRow(title: "New Private Tab", subtitle: "Nothing in it is saved or synced", colors: colors) {
                PrivateTile(size: Tile.row)
            }
        }
    }

    private func searchRow(_ query: String) -> some View {
        Button { go() } label: {
            HStack(spacing: Space.rowGap) {
                Image(systemName: Address.isSearch(query) ? "magnifyingglass" : "globe")
                    .font(.system(size: Glyph.row, weight: .semibold))
                    .frame(width: 28, height: 28)
                Text(Address.isSearch(query) ? "Search for “\(query)”" : query)
                    .font(.system(.body, weight: .medium))
                    .lineLimit(1)
                Spacer()
            }
            .foregroundStyle(colors.ink)
            .padding(.horizontal, Space.rowInset)
            .frame(minHeight: RowMetrics.suggestion)
            .background(theme.accentWash, in: .rect(cornerRadius: Radius.well))
            .contentShape(.rect)
        }
    }

    /// A suggestion searches the synced engine for its words.
    private func suggestionRow(_ suggestion: String) -> some View {
        Button {
            if let url = SearchEngine(settings: model.settings).search(suggestion) { open(url) }
        } label: {
            HStack(spacing: Space.rowGap) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: Glyph.row, weight: .semibold))
                    .frame(width: 28, height: 28)
                    .accessibilityHidden(true)
                Text(suggestion)
                    .font(.system(.body, weight: .medium))
                    .lineLimit(1)
                Spacer()
            }
            .foregroundStyle(colors.ink)
            .padding(.horizontal, Space.rowInset)
            .rowHeight(RowMetrics.suggestion)
            .contentShape(.rect)
        }
        .accessibilityLabel("Search for \(suggestion)")
        .accessibilityInputLabels([suggestion])
    }

    private func caption(_ title: String) -> some View {
        SectionCaption(title, color: colors.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Space.rowInset)
            .padding(.top, 6)
            .padding(.bottom, 2)
    }

    private func tabRow(_ tab: OutlineRow) -> some View {
        let workspace = model.workspace(of: tab.id)
        let elsewhere = workspace != browser.workspaceId
        let host = tab.url.flatMap { URL(string: $0)?.host() } ?? ""
        let subtitle = elsewhere
            ? workspace.flatMap(model.row).map { [$0.emoji, WorkspaceTile.name($0)].compactMap { $0 }.joined(separator: " ") } ?? host
            : host
        return Button {
            onDone()
            browser.select(tab.id)
        } label: {
            LauncherRow(title: tab.title.isEmpty ? host : tab.title, subtitle: subtitle, colors: colors) {
                SiteTile(row: tab, size: Tile.row)
            } trailing: {
                LauncherRow<EmptyView, EmptyView>.action("Switch to Tab", colors: colors)
            }
        }
        .accessibilityLabel("Switch to \(tab.title), \(subtitle)")
        // Voice Control takes the words on screen first.
        .accessibilityInputLabels([tab.title.isEmpty ? host : tab.title, "Switch to Tab"])
    }

    private func closedRow(_ entry: Browser.ClosedTab) -> some View {
        let host = entry.row.url.flatMap { URL(string: $0)?.host() } ?? ""
        return Button {
            onDone()
            Task { await browser.reopen(entry) }
        } label: {
            LauncherRow(title: entry.row.title.isEmpty ? host : entry.row.title, subtitle: host, colors: colors) {
                SiteTile(row: entry.row, size: Tile.row)
            } trailing: {
                LauncherRow<EmptyView, EmptyView>.action("Reopen", colors: colors)
            }
        }
        .accessibilityLabel("Reopen \(entry.row.title), \(host)")
        .accessibilityInputLabels([entry.row.title.isEmpty ? host : entry.row.title, "Reopen"])
    }

    /// The Workspace's glass under the list and the field, as under the
    /// bar. In private the Launcher is dark, as Firefox's is, so its glass
    /// lies on a dark ground.
    private var colors: BarColors {
        BarColors(token: model.tint(of: browser.workspaceId.flatMap(model.row)), dark: scheme == .dark || browser.privateInFront)
    }
    private var layer: Color { colors.layer }

    /// The field: a glass capsule in the Workspace's colour, riding on the
    /// keyboard in the bar's place (14k3), with a
    /// round Close beside it.
    private var field: some View {
        GlassEffectContainer(spacing: 6) {
            HStack(spacing: BarShape.gap) {
                HStack(spacing: 2) {
                    if !newTab, let url = address {
                        ShareLink(item: url) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: Glyph.control, weight: .medium))
                                .frame(width: RowMetrics.target, height: BarShape.standard.address)
                        }
                        .accessibilityLabel("Share")
                        CopyButton(title: "Copy Address", text: url.absoluteString, localOnly: browser.inPrivate, url: url,
                                   glyphFrame: CGSize(width: RowMetrics.target, height: BarShape.standard.address))
                            .font(.system(size: Glyph.control, weight: .medium))
                    }
                    TextField("Search or enter address", text: $text, selection: $selection)
                        .font(.system(.callout))
                        .keyboardType(.webSearch)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .focused($focused)
                        .onSubmit(go)
                        .padding(.leading, browser.currentURL == nil || newTab ? 14 : 4)
                    if !text.isEmpty {
                        Button { text = "" } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(colors.muted)
                                .frame(width: RowMetrics.target, height: BarShape.standard.address)
                        }
                        .accessibilityLabel("Clear")
                    }
                }
                .padding(.horizontal, 4)
                .frame(minHeight: BarShape.standard.address)
                .glassCapsule(layer)
                CloseCircle(label: "Cancel", diameter: 48, glass: workspaceGlass(layer), action: onDone)
            }
        }
        .foregroundStyle(colors.ink)
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
    }

    private func go() {
        guard let url = autofill.flatMap({ $0.text == text ? $0.url : nil }) ?? Address.resolve(text, settings: model.settings) else { return }
        open(url)
    }

    /// Loads `url` in this tab, or in the new tab the Launcher was opened
    /// for.
    private func open(_ url: URL) {
        onDone()
        Task {
            if newTab || browser.currentTabId == nil,
               let workspace = model.newTabWorkspace(from: browser.workspaceId) {
                await browser.openNewTab(url, in: workspace, transition: HistoryPage.typed)
            } else {
                await browser.open(url, transition: HistoryPage.typed)
            }
        }
    }
}

/// One of the Launcher's suggestions: its tile, its title over its site,
/// and what a tap does when it isn't opening the page.
private struct LauncherRow<Tile: View, Trailing: View>: View {
    let title: String
    let subtitle: String
    let colors: BarColors
    @ViewBuilder let tile: () -> Tile
    @ViewBuilder var trailing: () -> Trailing
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At the accessibility sizes the row's action goes under its site,
        // so the title has the row's width.
        let stacked = typeSize.isAccessibilitySize
        HStack(spacing: Space.rowGap) {
            tile()
            VStack(alignment: .leading, spacing: Space.lines) {
                Text(title)
                    .font(.system(.body, weight: .medium))
                    .foregroundStyle(colors.ink)
                    .titleLines()
                Text(subtitle)
                    .font(.system(.footnote))
                    .foregroundStyle(colors.muted)
                    .lineLimit(1)
                if stacked { trailing() }
            }
            Spacer(minLength: 4)
            if !stacked { trailing() }
        }
        .padding(.horizontal, Space.rowInset)
        .rowHeight(RowMetrics.suggestion)
        .contentShape(.rect)
    }

    /// The word for a row that switches or reopens, in the glass's ink:
    /// Sval's blue on the blue glass of a Workspace with no colour can't
    /// be read.
    static func action(_ text: String, colors: BarColors) -> some View {
        Text(text)
            .font(.system(.footnote, weight: .semibold))
            .foregroundStyle(colors.ink)
    }
}

extension LauncherRow where Trailing == EmptyView {
    init(title: String, subtitle: String, colors: BarColors, @ViewBuilder tile: @escaping () -> Tile) {
        self.init(title: title, subtitle: subtitle, colors: colors, tile: tile, trailing: { EmptyView() })
    }
}

/// A site's tile: its icon once this phone has learned it, else the letter
/// of its host on a well.
struct SiteTile: View {
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    let url: String?
    let name: String
    let size: CGFloat

    init(row: OutlineRow, size: CGFloat) {
        self.init(url: row.url, name: row.name, size: size)
    }

    init(url: String?, name: String, size: CGFloat) {
        self.url = url
        self.name = name
        self.size = size
    }

    var body: some View {
        let theme = Theme(scheme, tint: sheetTint)
        let host = url.flatMap { URL(string: $0)?.host() } ?? name
        let letter = (SiteRules.site(of: host) ?? host).prefix(1).uppercased()
        Group {
            if let icon = SiteIcons.shared.icon(for: host) {
                Image(uiImage: icon)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    // Smart Invert leaves pictures as they are.
                    .accessibilityIgnoresInvertColors()
                    .clipShape(.rect(cornerRadius: Radius.tile(size)))
            } else {
                RoundedRectangle(cornerRadius: Radius.tile(size))
                    .fill(theme.well)
                    .overlay {
                        Text(letter)
                            .font(SvalFont.outfit(size * 0.5, .semibold, relativeTo: .body))
                            .foregroundStyle(theme.body)
                    }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
