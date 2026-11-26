// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import WebKit

/// The page's site: protections and JavaScript for it, and the blocking
/// level for every site, as the desktop's site controls set them. Each
/// change syncs, and the page reloads to take it.
struct SiteMenuView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    /// Told when protections go off for a site, so the browser can say so
    /// once the page has reloaded.
    var onProtectionsOff: (String) -> Void = { _ in }
    /// What the page group asks for, done once the menu has closed.
    var onPage: (PageAction) -> Void = { _ in }

    /// The page's zoom as the zoom row last set or found it.
    @State private var zoom: Double = 1
    @State private var rulesShown = false
    /// How many elements each hiding rule matches on the page, by line.
    @State private var ruleCounts: [String: Int?] = [:]

    private var theme: Theme { Theme(scheme, tint: sheetTint) }
    private var host: String? { model.browser.currentURL?.host() }
    private var rules: SiteRules { model.siteRules(private: inPrivate) }
    private var inPrivate: Bool { model.browser.privateInFront }

    var body: some View {
        let site = host.flatMap { host in
            SiteRules.scope(of: host).flatMap { scope in SiteRules.site(of: host).map { (host, scope, $0) } }
        }
        Form {
                pageGroup
                if let (host, scope, _) = site {
                    let protections = rules.protectionsOn(for: host)
                    let javaScript = rules.javaScriptEnabled(on: host)
                    Section {
                        toggleRow(
                            icon: "pr-shield", title: "Protections",
                            detail: protections ? "Blocks ads and trackers on this site." : "Protections are off, so ads and trackers load on this site.",
                            isOn: Binding(get: { protections }, set: { on in
                                if inPrivate {
                                    model.setPrivateProtections(scope, on: on)
                                    model.browser.reload()
                                } else {
                                    change(rules.protectionsChange(for: scope, on: on))
                                }
                                if !on { onProtectionsOff(scope) }
                            }))
                        toggleRow(
                            icon: "javascript", title: "JavaScript",
                            detail: javaScript ? "Lets this site run scripts." : "JavaScript is off, so this site's scripts don't run.",
                            isOn: Binding(get: { javaScript }, set: { on in
                                change(rules.javaScriptChange(for: scope, enabled: on))
                            }))
                            // The desktop's private window can't change it
                            // either (`SvalSiteControls`).
                            .disabled(inPrivate)
                        // Takes effect at the next link, so nothing reloads.
                        toggleRow(
                            icon: "sc-external", title: "Keep Links in This Tab",
                            detail: "Links between \(scope) pages can't open a new tab or window.",
                            isOn: Binding(get: { rules.keepLinks(on: host) }, set: { on in
                                let change = rules.keepLinksChange(for: scope, on: on)
                                Task { await model.setSetting(change.key, to: change.value) }
                            }))
                            .disabled(inPrivate)
                        // The site's video and audio choice, as the desktop's
                        // site menu sets it. The page is made again for it.
                        Picker(selection: Binding(get: { rules.media(for: host) }, set: { choice in
                            if inPrivate {
                                model.setPrivateMedia(scope, to: choice)
                                return
                            }
                            let change = rules.mediaChange(for: scope, to: choice)
                            Task { await model.setSetting(change.key, to: change.value) }
                        })) {
                            ForEach(SiteRules.Media.allCases) { Text($0.words).tag($0) }
                        } label: {
                            Label {
                                Text("Video and Audio")
                            } icon: {
                                Image("media").resizable().frame(width: Glyph.slot, height: Glyph.slot).foregroundStyle(theme.muted)
                            }
                        }
                        // A rule names the site and syncs, so a private
                        // page can't make one (element picker spec).
                        pageRow(icon: "eraser", title: "Remove from This Site",
                                detail: inPrivate ? "Off in private, because it saves a rule." : nil) {
                            act(.removeElement)
                        }
                        .disabled(inPrivate)
                        removalRules(on: host)
                    }
                    .listRowBackground(theme.cell)
                    Section {
                        zoomRow
                    } header: {
                        SectionCaption("Zoom", color: theme.muted)
                    }
                    .listRowBackground(theme.cell)
                }
        }
        .listSectionSpacing(.compact)
        // A bar keeps the rows' scroll edge effect under the header.
        .safeAreaBar(edge: .top) {
            header(title: site?.1 ?? "Sval", protections: site.map { rules.protectionsOn(for: $0.0) })
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 12)
        }
        .foregroundStyle(theme.text)
        .sheetGround()
    }

    /// The page's zoom on this iPhone, for its host (decision 12): − and +
    /// step along Firefox's zoom steps, and the level between them goes
    /// back to 100%.
    private var zoomRow: some View {
        HStack(spacing: 0) {
            Button { setZoom(PageZoom.step(zoom, by: -1)) } label: {
                Image(systemName: "minus").frame(maxWidth: .infinity, minHeight: RowMetrics.target)
            }
            .accessibilityLabel("Zoom Out")
            .disabled(zoom <= PageZoom.steps[0])
            Button { setZoom(1) } label: {
                Text("\(Int((zoom * 100).rounded()))%")
                    .monospacedDigit()
                    .frame(maxWidth: .infinity, minHeight: RowMetrics.target)
            }
            .accessibilityLabel("Zoom")
            .accessibilityValue("\(Int((zoom * 100).rounded()))%")
            .accessibilityAdjustableAction { direction in
                setZoom(PageZoom.step(zoom, by: direction == .increment ? 1 : -1))
            }
            Button { setZoom(PageZoom.step(zoom, by: 1)) } label: {
                Image(systemName: "plus").frame(maxWidth: .infinity, minHeight: RowMetrics.target)
            }
            .accessibilityLabel("Zoom In")
            .disabled(zoom >= PageZoom.steps[PageZoom.steps.count - 1])
        }
        .buttonStyle(.borderless)
        .font(.system(.body, weight: .medium))
        .foregroundStyle(theme.text)
        .onAppear { zoom = model.browser.currentZoom }
    }

    private func setZoom(_ level: Double) {
        model.browser.setZoom(level)
        zoom = level
    }

    private func header(title: String, protections: Bool?) -> some View {
        HStack(spacing: Space.rowGap) {
            Image(protections == false ? "pr-shield-off" : (protections == nil ? "sc-shield-plain" : "pr-shield"))
                .resizable()
                .frame(width: 22, height: 22)
                .foregroundStyle(protections == false ? theme.muted : theme.text)
                .frame(width: 46, height: 46)
                .well(theme.well, edge: theme.divider, radius: Radius.tile(46))
            VStack(alignment: .leading, spacing: Space.lines) {
                Text(title)
                    .font(SvalFont.title(.title3))
                    .titleLines()
                Text(protections == nil ? "Not a website. Protections don't apply."
                     : (protections! ? "Protections on" : "Protections off for this site"))
                    .font(.system(.subheadline))
                    .foregroundStyle(theme.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            CloseCircle { dismiss() }
        }
    }

    private func toggleRow(icon: String, title: String, detail: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            Label {
                VStack(alignment: .leading, spacing: Space.lines) {
                    Text(title).font(.system(.body))
                    Text(detail)
                        .font(.system(.footnote))
                        .foregroundStyle(theme.muted)
                }
            } icon: {
                Image(icon).resizable().frame(width: Glyph.slot, height: Glyph.slot).foregroundStyle(theme.muted)
            }
        }
        .tint(theme.action)
    }

    /// The page's own group (14d3): Move to Workspace…, Pin Tab or Move to
    /// Favorites, and Add to Favorites or where it is in Favorites. None of it
    /// applies to a private tab.
    @ViewBuilder private var pageGroup: some View {
        let browser: Browser = model.browser
        let tab = browser.currentTabId.flatMap(model.row).flatMap { $0.kind == .tab ? $0 : nil }
        let star = StarState(model)
        if !browser.privateInFront, tab != nil || browser.currentPin != nil {
            Section {
                if let tab, let home = model.workspace(of: tab.id).flatMap(model.row) {
                    pageRow(icon: "folder", title: "Move to Workspace…", detail: "In \(WorkspaceTile.name(home))",
                            chevron: true) { act(.move(tab)) }
                }
                if let pin = browser.currentPin {
                    pageRow(icon: "star", title: "Move to Favorites") { act(.moveToFavorites(pin)) }
                } else if let tab, !model.isPane(tab), let url = browser.currentURL ?? tab.url.flatMap(URL.init(string:)),
                          AppModel.opensHere(url.absoluteString) {
                    pageRow(icon: "pin", title: "Pin Tab") { act(.pin(tab, url)) }
                }
                switch star {
                case .add(let url, let title):
                    pageRow(icon: "star", title: "Add to Favorites") { act(.star(.add(url, title: title))) }
                case .favorite(let item):
                    Menu {
                        Button("Rename…", systemImage: "pencil") { act(.star(.rename(item))) }
                        Button("Move to…", systemImage: "folder") { act(.star(.move(item))) }
                        Button("Remove from Favorites", systemImage: "star.slash", role: .destructive) {
                            act(.star(.remove(item)))
                        }
                    } label: {
                        pageLabel(icon: "star.fill", title: favoritePlace(item), detail: nil, chevron: false)
                    }
                case .none:
                    EmptyView()
                }
            }
            .listRowBackground(theme.cell)
        }
    }

    /// The site's removal rules, collapsed each time the menu opens, as
    /// the desktop's site menu lists them (element picker spec §6): a row
    /// for each line that removes something here, newest first. Its X
    /// takes this site out of the line; a private page lists them alone.
    @ViewBuilder private func removalRules(on host: String) -> some View {
        let removals = MyFilters.removals(on: host, settings: model.settings)
        if !removals.isEmpty {
            DisclosureGroup(isExpanded: $rulesShown) {
                ForEach(removals) { removal in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: Space.lines) {
                            Text(removal.shown)
                                .font(.system(.footnote).monospaced())
                                .lineLimit(2)
                                .truncationMode(.middle)
                            Text(removalWords(removal))
                                .font(.system(.footnote))
                                .foregroundStyle(theme.muted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if !inPrivate {
                            Button { showAgain(removal) } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 20))
                                    .foregroundStyle(theme.muted)
                                    .frame(width: RowMetrics.target, height: RowMetrics.target)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Delete Rule")
                        }
                    }
                    .frame(minHeight: RowMetrics.target)
                }
            } label: {
                HStack(spacing: Space.rowGap) {
                    Image(systemName: "list.bullet")
                        .font(.system(size: Glyph.row))
                        .foregroundStyle(theme.muted)
                        .frame(width: Glyph.slot, height: Glyph.slot)
                    Text("Removed from This Site").font(.system(.body))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("\(removals.count)")
                        .monospacedDigit()
                        .foregroundStyle(theme.muted)
                }
                .frame(minHeight: RowMetrics.target)
            }
            .tint(theme.muted)
            .task(id: rulesShown ? removals.map(\.line) : []) {
                guard rulesShown, let view = model.browser.currentPage() else { return }
                let hiding = removals.filter { $0.kind == .hide }
                let found = await ElementPick.counts(hiding.map(\.shown), in: view)
                ruleCounts = Dictionary(zip(hiding.map(\.id), found), uniquingKeysWith: { a, _ in a })
            }
        }
    }

    /// What a rule's row says it does on this page.
    private func removalWords(_ removal: MyFilters.Removal) -> String {
        if removal.kind == .network { return "Stops a download" }
        guard let n = ruleCounts[removal.id] ?? nil else { return "" }
        return n == 0 ? "Not currently removing anything on this page"
            : "Removes \(n) \(n == 1 ? "element" : "elements") on this page"
    }

    /// Takes this site out of the rule, and shows what it hid in the open
    /// page where Remove hid it this visit.
    private func showAgain(_ removal: MyFilters.Removal) {
        let writes = MyFilters.showingAgain(removal, settings: model.settings)
        Task {
            await model.setSettings(writes.map { ($0.key, $0.value as Any?) })
            if removal.kind == .hide, let view = model.browser.currentPage() {
                await ElementPick.showAgain(removal.shown, in: view)
            }
        }
    }

    private func act(_ action: PageAction) {
        onPage(action)
        dismiss()
    }

    private func pageRow(icon: String, title: String, detail: String? = nil, chevron: Bool = false,
                         action: @escaping () -> Void) -> some View {
        Button(action: action) { pageLabel(icon: icon, title: title, detail: detail, chevron: chevron) }
            .buttonStyle(.plain)
    }

    private func pageLabel(icon: String, title: String, detail: String?, chevron: Bool) -> some View {
        HStack(spacing: Space.rowGap) {
            Image(systemName: icon)
                .font(.system(size: Glyph.row))
                .foregroundStyle(theme.muted)
                .frame(width: Glyph.slot, height: Glyph.slot)
            VStack(alignment: .leading, spacing: Space.lines) {
                Text(title).font(.system(.body))
                if let detail {
                    Text(detail)
                        .font(.system(.footnote))
                        .foregroundStyle(theme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if chevron {
                Chevron(color: theme.muted)
            }
        }
        .foregroundStyle(theme.text)
        .frame(minHeight: RowMetrics.target)
        .contentShape(.rect)
    }

    /// "In Favorites", or "In Favorites › Travel" for one in a folder.
    private func favoritePlace(_ item: Favorite) -> String {
        guard let parent = item.parent, parent != model.favoritesRootId, let folder = model.favorite(parent) else {
            return "In Favorites"
        }
        return "In Favorites › \(FavoritesView.name(folder))"
    }

    /// Saves `setting` and reloads the page to take it, once the script
    /// rules a JavaScript choice changes are compiled.
    private func change(_ setting: (key: String, value: Any?)) {
        Task {
            await model.setSetting(setting.key, to: setting.value)
            await model.browser.blocker.scriptsApplied()
            model.browser.reload()
            Diagnostics.log("page: reloaded for a site setting")
        }
    }
}
