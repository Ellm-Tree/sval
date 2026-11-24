// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import WebKit

extension Browser {
    /// The page key of pin `guid` in Workspace `workspace`. A pin's page
    /// belongs to the pin and the Workspace it is open in (pins spec §5),
    /// and is no node of the tree.
    static func pinKey(_ guid: String, in workspace: String) -> String {
        "pin:\(guid)@\(workspace)"
    }

    /// The pin and Workspace a pin's page key names.
    static func pinParts(_ key: String) -> (guid: String, workspace: String)? {
        guard key.hasPrefix("pin:"), let at = key.lastIndex(of: "@") else { return nil }
        return (String(key[key.index(key.startIndex, offsetBy: 4)..<at]), String(key[key.index(after: at)...]))
    }

    /// The pin a page key names, while it shows in its Workspace.
    func pin(for key: String) -> PinRow? {
        guard let parts = Self.pinParts(key) else { return nil }
        return model.pinsByWorkspace[parts.workspace]?.first { $0.guid == parts.guid && $0.kind == "favorite" }
    }

    /// The pin whose page is in front.
    var currentPin: PinRow? {
        currentTabId.flatMap(pin(for:))
    }

    /// Brings pin `pin`'s page in this Workspace to the front. A page not
    /// loaded loads the saved address; a loaded one is left where it is.
    func selectPin(_ pin: PinRow) {
        guard let workspace = workspaceId else { return }
        select(Self.pinKey(pin.guid, in: workspace))
        Diagnostics.log("pins: a pin is in front")
    }

    /// Takes the pin in front back to its saved address.
    func backToSaved() {
        guard let id = currentTabId, let pin = pin(for: id),
              let saved = pin.url.flatMap(URL.init(string:)), let page = pages[id] else { return }
        page.returnToSaved(saved)
        Diagnostics.log("pins: back to the saved page")
    }

    /// The address the pin in front is at, for "Save Current Page as This
    /// Pin".
    var pinCurrentURL: URL? {
        currentPin == nil ? nil : currentURL
    }

    /// Turns pin `pin`'s page in this Workspace into a normal tab at the top
    /// of the Workspace once the pin is unpinned, so unpinning throws no page
    /// away (pins spec §3).
    /// Returns the tab, if the page was open.
    @discardableResult
    func keepUnpinnedPage(_ pin: PinRow) async -> String? {
        guard let workspace = workspaceId else { return nil }
        let key = Self.pinKey(pin.guid, in: workspace)
        guard let page = pages[key], let url = page.view.url else { return nil }
        let front = currentTabId == key
        let state = page.keptState?.state
        let first = model.children(of: workspace).first?.id
        guard let id = await model.addTab(to: workspace, url: url, before: first) else { return nil }
        if let state { keepOffloaded(id, state: state, address: url.absoluteString) }
        // The page stays in front only if it was: unpinning a pin behind
        // files its page as a tab and leaves the front alone.
        if front { select(id) }
        let at = model.children(of: workspace).firstIndex { $0.id == id }
        Diagnostics.log("pins: an unpinned pin's page is a tab at \(at.map(String.init) ?? "none") of \(model.children(of: workspace).count), \(front ? "in front" : "behind")")
        return id
    }

    /// Gives tab `tabId`'s page back to pin `guid`, as it is, and takes the
    /// tab out of the tree: what Undo of a Move to Favorites does.
    func returnToPin(_ tabId: String, guid: String) async {
        guard let row = model.row(tabId) else { return }
        let front = currentTabId == tabId
        handOver(row, toPin: guid)
        _ = await model.closeTab(row)
        if front, let pin = workspaceId.flatMap({ model.pinsByWorkspace[$0] })?.first(where: { $0.guid == guid }) {
            selectPin(pin)
        }
    }

    /// Hands a tab's page to the pin made from it, as it is (pins spec
    /// §8.1).
    func handOver(_ tab: OutlineRow, toPin guid: String) {
        guard let workspace = model.workspace(of: tab.id) else { return }
        let key = Self.pinKey(guid, in: workspace)
        if let page = pages[tab.id], let kept = page.keptState {
            keepOffloaded(key, state: kept.state, address: kept.address, from: page)
        }
        frontTabs[workspace] = key
    }

    func pinPage(_ key: String, _ pin: PinRow) -> Page {
        if let page = pages[key] { return page }
        let saved = pin.url.flatMap(URL.init(string:))
        let site = saved?.host().map { SiteRules.site(of: $0) ?? $0 } ?? ""
        let page = makePage(key, address: nil, opens: nil, pin: true)
        page.pinRules = Page.PinRules(site: site) { [weak self] in
            self?.model.settings[Self.pinLinksKey] as? Bool ?? true
        } onLeave: { [weak self] url in
            guard let self, let workspace = Self.pinParts(key)?.workspace else { return }
            Diagnostics.log("pins: a link to another site opens as a tab")
            Task { await self.openNewTab(url, in: workspace) }
        }
        if let restored = offloaded.take(key) {
            page.restore(restored.state, at: restored.address)
            page.startsSaved(restored.savedPage ?? restored.address.flatMap(URL.init(string:)))
        } else if let saved {
            page.load(saved)
        }
        return page
    }

    /// The desktop's synced setting for where a pin's link to another site
    /// opens: in Quick Peek, which a phone opens as a new tab, or in the pin.
    static let pinLinksKey = "browser.sval.pins.quickPeekLinks"
}
