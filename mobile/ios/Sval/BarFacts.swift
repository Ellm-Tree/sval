// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// What the bar shows of the browser and the model, worked out outside the
/// bar's body, so the bar redraws when one of these changes and never for
/// a page's progress (`Browser.refreshBar`). A view that follows the load
/// itself reads `Browser` on its own (`ProgressLine`, `ReloadButton`).
struct BarFacts: Equatable {
    /// What the address capsule says.
    enum Address: Equatable {
        /// The empty address's words, which depend on the screen's width.
        case search
        case text(String, placeholder: Bool)
    }

    /// The Workspace shown.
    var workspace: OutlineRow?
    var isPrivateSession = false
    var tabCount = 0
    var canGoBack = false
    var canGoForward = false
    var address = Address.search
    /// Whether the page in front has an address: Reload has nothing to
    /// reload without one.
    var reloads = false
    var shield = ShieldState.plain
    /// How many of My filters' lines remove something on the page's site.
    var removals = 0
    /// Whether the page in front runs without JavaScript, by its site's
    /// rule.
    var javaScriptOff = false
    /// Whether Always deny refused the page in front's media.
    var denied = false
    /// Whether the bar asks to allow the page in front's media: Ask first
    /// refused it, and nothing of its plays.
    var asks = false
    /// The page in front, when it has media to show.
    var frontMedia: String?
    /// Another tab whose media the bar shows: playing, or paused a moment
    /// ago, and its row when it is a tab of the tree.
    var otherMedia: String?
    var otherMediaRow: OutlineRow?
    var split: Browser.SplitInFront?
    /// The split's row and its panes' rows, whole. `SplitInFront` compares
    /// their ids alone, and the pane tray draws the rows.
    var splitRows: [OutlineRow] = []
}

extension BarFacts {
    @MainActor init(_ browser: Browser, _ model: AppModel) {
        workspace = browser.workspaceId.flatMap(model.row)
        isPrivateSession = workspace.map { model.isPrivate($0.id) } ?? false
        tabCount = model.tabs(in: browser.workspaceId).count
        canGoBack = browser.canGoBack
        canGoForward = browser.canGoForward
        let url = browser.currentURL
        reloads = url != nil
        shield = ShieldState(url: url, rules: model.siteRules(private: browser.privateInFront))
        let host = url?.host()
        // My filters' lines that remove something on this site, which
        // apply at every level and with protections off (decision 1993).
        removals = shield == .plain ? 0 : host.map { model.myFilters.removals(on: $0).count } ?? 0
        javaScriptOff = host.map { !SiteRules(settings: model.settings).javaScriptEnabled(on: $0) } ?? false
        denied = browser.frontDenied
        frontMedia = browser.currentTabId.flatMap { browser.mediaShown($0) ? $0 : nil }
        asks = browser.frontAsks && frontMedia == nil
        otherMedia = browser.mediaTab.flatMap { id in
            id != browser.currentTabId && browser.mediaShown(id) ? id : nil
        }
        otherMediaRow = otherMedia.flatMap(model.row)
        split = browser.splitInFront
        splitRows = split.map { [$0.split] + $0.run } ?? []
        address = Self.address(browser, model)
    }

    @MainActor private static func address(_ browser: Browser, _ model: AppModel) -> Address {
        if let id = browser.currentTabId, model.row(id)?.awaitsPick == true {
            return .text("Choose a page", placeholder: true)
        }
        if browser.onPrivateHome {
            return .search
        }
        // A pin's page reads as the pin, and once off its saved page, where
        // it is now (pins spec §4).
        if let pin = browser.currentPin {
            let name = pin.name.isEmpty ? (pin.url ?? "") : pin.name
            guard browser.pinOffSaved, let title = browser.currentTitle, !title.isEmpty else {
                return .text(name, placeholder: false)
            }
            return .text("\(name) / \(title)", placeholder: false)
        }
        if let url = browser.currentURL, let host = url.host() {
            return .text(SiteRules.site(of: host) ?? host, placeholder: false)
        }
        if let id = browser.currentTabId, let row = model.row(id), let address = row.url {
            let url = URL(string: address)
            if let host = url?.host(), Browser.openable(row) != nil {
                return .text(SiteRules.site(of: host) ?? host, placeholder: false)
            }
            return .text(url?.lastPathComponent ?? address, placeholder: false)
        }
        return .search
    }
}

/// What the bar's controls do, made once by the view that shows the bar,
/// so the bar's inputs compare equal from one redraw of that view to the
/// next. That view sets the closures again each time it draws, so they
/// act on its latest state.
@MainActor
final class BarActions {
    var site: () -> Void = {}
    var address: () -> Void = {}
    /// Opens the Workspace sheet.
    var workspace: () -> Void = {}
    var newTab: () -> Void = {}
    /// Opens the media card for a tab.
    var media: (String) -> Void = { _ in }
    /// What the split menu asks for.
    var split: (SplitAction) -> Void = { _ in }
    /// A hold on the address or the Workspace button and the slide after
    /// it, which move through the Workspace's tabs or the Workspaces.
    var scrub: (ScrubPhase) -> Void = { _ in }
    /// Opens a tab in the private session, or ends the session (false).
    var privateSession: (Bool) -> Void = { _ in }
}
