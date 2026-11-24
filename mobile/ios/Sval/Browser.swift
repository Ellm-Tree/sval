// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import Observation
import SwiftUI
import UIKit
import WebKit

/// The tabs this device has open as live pages, and which one is in front.
/// A tab of the tree is a row; a page is made for it when it is first shown.
/// A page is let go as the desktop lets a tab go (main spec §10.7): when iOS
/// warns that memory is short, every page but the one in front, and three
/// hours after the user left a workspace, its pages. A page let go keeps its
/// back and forward history and scroll position, put back when the tab is
/// next shown, as Firefox for iOS keeps them
/// (`TabManager.offloadBackgroundWebViews`).
///
/// A page that would lose something by going stays, as the desktop keeps
/// it: one the user typed into, one playing sound, and one using the camera
/// or microphone.
@MainActor
@Observable
final class Browser {
    private(set) var currentTabId: String? {
        didSet { refreshBar() }
    }
    /// The workspace the tab list shows. It follows the tab in front.
    private(set) var workspaceId: String? {
        didSet {
            refreshBar()
            if (oldValue.map(model.isPrivate) ?? false) != inPrivate {
                pauseOtherSide()
                if !inPrivate { downloads.hidePrivatePreview() }
            }
            // The private session's Workspace is never saved.
            guard !(workspaceId.map(model.isPrivate) ?? false) else { return }
            UserDefaults.standard.set(workspaceId, forKey: Self.workspaceKey)
        }
    }
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var loading = false
    /// How far the page in front has loaded, from 0 to 1.
    private(set) var progress = 0.0
    /// The failed load that left the page in front empty.
    private(set) var loadFailure: Page.LoadFailure?
    /// The bar's fold, which follows the page in front as it scrolls.
    let fold = BarFold()

    @ObservationIgnored var pages: [String: Page] = [:] {
        didSet { if Set(oldValue.keys) != Set(pages.keys) { pagesChanged += 1 } }
    }
    /// Counts the pages made and let go, so the window takes up a page made
    /// after it last drew: the tab in front's, at launch, is made once the
    /// window has drawn without it.
    var pagesChanged = 0
    /// The saved state of each tab's and pin's page, and the address it was
    /// at, by page key.
    @ObservationIgnored let offloaded: PageStates
    @ObservationIgnored let model: AppModel
    @ObservationIgnored let blocker: ContentBlocker
    /// The files the pages download.
    let downloads = Downloads()
    @ObservationIgnored let audio = BackgroundAudio()
    /// When the user left each workspace they have left, by id.
    @ObservationIgnored private var leftAt: [String: Date] = [:]

    /// How long after the user leaves a workspace its pages are let go
    /// (`HIDDEN_WORKSPACE_UNLOAD_MS` on the desktop).
    static let hiddenWorkspaceUnload: TimeInterval = 3 * 60 * 60

    private static let currentKey = "currentTab"
    private static let workspaceKey = "currentWorkspace"
    private static let usedKey = "tabsUsed"

    /// When each tab was last brought to the front, for the Launcher's
    /// recent tabs.
    @ObservationIgnored private var usedAt: [String: Double] =
        UserDefaults.standard.dictionary(forKey: usedKey) as? [String: Double] ?? [:]

    // MARK: Private session

    /// The private session's WebKit store: cookies, cache and site storage
    /// in memory, shared by the session's tabs as a private window's are,
    /// and dropped with it. WebKit keeps one per store, so a store is made
    /// once a session and never again (Firefox for iOS,
    /// `DefaultWKEngineConfigurationProvider`).
    @ObservationIgnored private var sessionStore: WKWebsiteDataStore?
    var privateStore: WKWebsiteDataStore {
        if let sessionStore { return sessionStore }
        let store = WKWebsiteDataStore.nonPersistent()
        sessionStore = store
        return store
    }

    #if DEBUG
    /// Loads `html` into a tab's page, for the privacy check alone.
    func loadForCheck(_ id: String, html: String, base: URL) {
        model.row(id).map { page(for: $0) }?.view.loadHTMLString(html, baseURL: base)
    }
    #endif

    /// The Workspace last shown outside the private session, as saved.
    var savedWorkspace: String? { UserDefaults.standard.string(forKey: Self.workspaceKey) }

    /// Whether the private session is in front with no tab open, which
    /// shows the private home.
    var onPrivateHome: Bool {
        currentTabId == nil && workspaceId.map(model.isPrivate) == true
    }

    /// Whether the private session's Workspace is the one shown.
    var inPrivate: Bool { workspaceId.map(model.isPrivate) ?? false }

    /// Pauses the media of every page on the other side of the private
    /// session from the Workspace shown. Private and other Workspaces never
    /// share media, its controls or its sound, either way. Every page is
    /// paused, as media a page's frames don't report plays as well.
    private func pauseOtherSide() {
        let other = pages.filter { $0.value.isPrivate != inPrivate }
        for (id, page) in other {
            page.view.pauseAllMediaPlayback(completionHandler: nil)
            if page.playing || media[id] != nil {
                page.view.evaluateJavaScript(MediaInfo.holdScript, in: nil, in: .defaultClient)
            }
        }
        mediaLog("\(inPrivate ? "entered" : "left") the private session, \(other.count) page(s) of the other side paused",
                 privateOnly: true)
    }

    /// Pauses every private page's media and holds it suspended until Sval
    /// is in front again, so iOS's Now Playing and lock screen get nothing
    /// of it. A suspended page's media is never theirs
    /// (`HTMLMediaElement::isNowPlayingEligible`), whatever its script
    /// does. It is muted as well, and held as a pause from Sval's controls
    /// holds it, once Sval is back, until the user next taps in the page.
    /// Its Picture in Picture and fullscreen end, which would show it
    /// outside Sval.
    private func pausePrivateMedia() {
        let held = pages.filter { $0.value.isPrivate }
        guard !held.isEmpty else { return }
        for (id, page) in held {
            page.view.closeAllMediaPresentations(completionHandler: nil)
            page.suspend(.privacy)
            if page.playing || media[id] != nil {
                page.view.evaluateJavaScript(MediaInfo.holdScript, in: nil, in: .defaultClient)
            }
            page.runInMediaFrames(MediaInfo.muteForPrivacy)
        }
        mediaLog("Sval lost focus, \(held.count) private page(s) paused, suspended and muted", privateOnly: true)
    }

    /// Unmutes what `pausePrivateMedia` muted, and lifts its suspension.
    private func unmutePrivateMedia() {
        for page in pages.values where page.isPrivate {
            page.runInMediaFrames(MediaInfo.unmuteAfterPrivacy)
            page.lift([.privacy])
        }
    }

    /// Whether the tab in front is a private tab.
    var privateInFront: Bool { currentTabId.map(model.isPrivate) ?? false }

    /// Closes the private session's pages and drops its store, so nothing
    /// of the session stays, even in memory, and goes back to the user's
    /// Workspaces. Every private page closes, told by the page itself: a
    /// window a private page opened has a page before it has a tab.
    func endPrivateSession(_ ids: Set<String>) {
        for id in ids.union(pages.filter { $0.value.isPrivate }.keys) {
            pages.removeValue(forKey: id)?.close()
            windowsOpening[id] = nil
            openers[id] = nil
            offloaded.forget(id)
            visits[id] = nil
            usedAt[id] = nil
            frontTabs[id] = nil
            splitFocus[id] = nil
            splitSlots[id] = nil
            lastVisit[id] = nil
            visitTransition[id] = nil
            restoring.remove(id)
        }
        frontTabs = frontTabs.filter { !ids.contains($0.value) }
        downloads.endPrivateSession()
        sessionStore = nil
        PageZoom.endSession()
        let wasPrivate = currentTabId.map(ids.contains) ?? false || workspaceId.map(ids.contains) ?? false
        if wasPrivate {
            currentTabId = nil
            workspaceId = nil
            if let home = UserDefaults.standard.string(forKey: Self.workspaceKey) ?? model.workspaces.first?.id {
                showWorkspace(home)
            }
        }
    }

    /// A window a page asked for, whose page is made before its tab:
    /// WebKit takes the new page at once, and the tab waits for a web
    /// address, since the phone writes no other into the tree. `adding`
    /// while the tab's edit runs.
    struct OpeningWindow {
        let parent: String
        let opener: String
        var adding = false
    }
    private var windowsOpening: [String: OpeningWindow] = [:]
    /// The tab each page-opened window came from, which comes back to the
    /// front when the page closes its window.
    private var openers: [String: String] = [:]

    /// Opens a link with a target, or a script's `window.open`, in a new
    /// tab at the end of the opener's Workspace, its own Workspace for
    /// another device's. WebKit requires the page made with the
    /// configuration it passes (`UIDelegate::UIClient::createNewPage`),
    /// which keeps the opener's session and its `window.opener`, so a
    /// sign-in window can hand its result back.
    func openWindow(from opener: String, configuration: WKWebViewConfiguration,
                    for action: WKNavigationAction) -> WKWebView? {
        if keepsInTab(action, opener: opener), let page = pages[opener] {
            page.view.load(action.request)
            return nil
        }
        guard let workspace = model.workspace(of: opener) ?? Self.pinParts(opener)?.workspace,
              let parent = model.newTabWorkspace(from: workspace) else { return nil }
        let id = UUID().uuidString.lowercased()
        windowsOpening[id] = OpeningWindow(parent: parent, opener: opener)
        openers[id] = opener
        let page = makePage(id, address: nil, opens: nil, pin: false,
                            privately: model.isPrivate(opener), configuration: configuration)
        Diagnostics.log("tabs: a page opened a window")
        // A window opened on a blank page gets its tab once a script sends
        // it to a web address (`navigated`).
        if let url = action.request.url, AppModel.opensHere(url.absoluteString) {
            addWindowTab(id, url: url)
        }
        return page.view
    }

    /// Whether a page's link that asks for a new tab loads in its own tab,
    /// under Keep links in this tab (`SvalKeepLinks.sys.mjs`): the tab's
    /// page has the rule on, the link is in the page itself, and the page
    /// and the address are of one site. A frame's link opens its tab, as on
    /// the desktop, since loading here would navigate the page from a frame. A link or a form, without a modifier key,
    /// as the desktop keeps one. WebKit doesn't say whether a script's
    /// `window.open` keeps its window, so the app keeps none.
    private func keepsInTab(_ action: WKNavigationAction, opener: String) -> Bool {
        guard action.navigationType == .linkActivated || action.navigationType == .formSubmitted,
              action.sourceFrame.isMainFrame,
              action.modifierFlags.isEmpty,
              let top = pages[opener]?.view.url?.host(),
              let url = action.request.url, let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              let site = SiteRules.site(of: top),
              SiteRules.site(of: url.host() ?? "") == site
        else { return false }
        return model.siteRules(private: model.isPrivate(opener)).keepLinks(on: top)
    }

    private func addWindowTab(_ id: String, url: URL) {
        guard var opening = windowsOpening[id] else { return }
        opening.adding = true
        windowsOpening[id] = opening
        Task {
            let last = model.children(of: opening.parent).last?.id
            let added = await model.addTab(to: opening.parent, url: url, after: last, id: id)
            windowsOpening[id] = nil
            guard added != nil else {
                closePage(id)
                return
            }
            select(id)
        }
    }

    /// Closes the tab of a window its page closed, with `window.close`,
    /// and brings back the tab that opened it.
    func closeWindow(_ id: String) {
        let opener = openers.removeValue(forKey: id)
        guard windowsOpening.removeValue(forKey: id) == nil, let row = model.row(id) else {
            closePage(id)
            return
        }
        Task {
            _ = await close(row)
            if let opener, model.row(opener) != nil { select(opener) }
        }
    }

    /// Lets go of a tab's page ahead of the tab, which `reconcile` would
    /// close only after the edit that removes it.
    func closePage(_ id: String) {
        pages.removeValue(forKey: id)?.close()
    }

    /// Pins a tab: its page becomes the pin's, and it leaves the tree
    /// (pins spec §8.1). A tab in front stays in front as the pin.
    func pin(_ row: OutlineRow, url: URL) async {
        let page = currentTabId == row.id ? currentPage()?.url ?? url : url
        guard let guid = await model.pinTab(url: page, title: row.title) else { return }
        handOver(row, toPin: guid)
        let front = currentTabId == row.id
        _ = await model.closeTab(row)
        if front, let pin = workspaceId.flatMap({ model.pinsByWorkspace[$0] })?.first(where: { $0.guid == guid }) {
            selectPin(pin)
        }
    }

    /// The room the open bar covers at the page's foot: upright, the 48pt
    /// capsules 24pt above the screen's edge; sideways, 44pt capsules 8pt
    /// above it.
    static let barRoom = 48.0 + 24.0
    static let sidewaysBarRoom = 44.0 + 8.0

    /// When each tab was last brought to the front on this phone.
    var usedAtSnapshot: [String: Double] { usedAt }

    /// The tabs most recently brought to the front on this phone, newest
    /// first, across every Workspace: the empty Launcher's list
    /// (`recentTabs`, `RECENT_TABS`). A tab never brought to the front here
    /// was never used here, so it is no recent tab.
    func recentTabs() -> [OutlineRow] {
        model.rows
            .filter { $0.kind == .tab && $0.id != currentTabId && Self.openable($0) != nil }
            // The private session and the user's Workspaces never see each
            // other's tabs.
            .filter { model.isPrivate($0.id) == inPrivate }
            .compactMap { row in usedAt[row.id].map { (row, $0) } }
            .sorted { $0.1 > $1.1 }
            .prefix(6)
            .map(\.0)
    }
    private static let frontKey = "frontTabs"

    /// The tab each Workspace last had in front, so switching back to a
    /// Workspace returns to it.
    @ObservationIgnored var frontTabs: [String: String] =
        UserDefaults.standard.dictionary(forKey: frontKey) as? [String: String] ?? [:]

    /// The wait before the tab in front counts as used, which syncs as a
    /// touch (idle-tab archive spec §4.1): the desktop's `USE_DWELL_MS`, so
    /// a tab passed on the way to another counts for nothing.
    private static let useDwell: Duration = .milliseconds(2500)
    @ObservationIgnored private var useTimer: Task<Void, Never>?

    private static let splitFocusKey = "splitFocus"

    /// The pane each split last had in focus, by split id. It is this
    /// phone's own view of the split, never synced.
    @ObservationIgnored private var splitFocus: [String: String] =
        UserDefaults.standard.dictionary(forKey: splitFocusKey) as? [String: String] ?? [:]

    /// The pane of `split` in focus: the tab in front when it is one of
    /// `panes`, else the one last focused, else the first.
    func focusedPane(of split: String, among panes: [String]) -> String? {
        if let current = currentTabId, panes.contains(current) { return current }
        if let last = splitFocus[split], panes.contains(last) { return last }
        return panes.first
    }

    /// The split in front, as this phone shows it: two of its panes at
    /// once, in screen order (12b). A split of more than four shows the
    /// run of up to four holding the focused pane (split-view spec §5.1).
    struct SplitInFront: Equatable {
        let split: OutlineRow
        let run: [OutlineRow]
        let slots: [String]
        let focused: String

        static func == (a: Self, b: Self) -> Bool {
            a.split.id == b.split.id && a.run.map(\.id) == b.run.map(\.id) && a.slots == b.slots && a.focused == b.focused
                && a.split.name == b.split.name && a.split.shares == b.split.shares
        }
    }

    /// How far the tray has slid the focused pane, in points, while it is
    /// dragged, and the pane coming in beside it (12d).
    var paneSlide: CGFloat = 0
    var paneSlideTarget: String?
    /// The focused slot's width, which a slide is measured against.
    @ObservationIgnored var focusedSlotWidth: CGFloat = 390

    /// The pane a step from the focused one in split order, skipping the
    /// pane in the other slot: what the tray's ‹ and › and a swipe bring.
    func paneStep(_ direction: Int) -> String? {
        guard let split = splitInFront else { return nil }
        let other = split.slots.first { $0 != split.focused }
        var at = split.run.firstIndex { $0.id == split.focused } ?? 0
        while true {
            at += direction
            guard split.run.indices.contains(at) else { return nil }
            if split.run[at].id != other { return split.run[at].id }
        }
    }

    /// The two panes each split shows, by split id: this phone's own view,
    /// never synced, so any two panes can show together (12d). They're
    /// drawn in the split's order (`splitInFront`).
    private var splitSlots: [String: [String]] = [:]

    var splitInFront: SplitInFront? {
        guard let id = currentTabId, let (split, run) = splitRun(of: id) else { return nil }
        let slots = splitSlots[split.id] ?? []
        guard slots.count == 2, slots.contains(id), slots.allSatisfy({ slot in run.contains { $0.id == slot } }) else {
            return SplitInFront(split: split, run: run, slots: Self.pair(for: id, in: run), focused: id)
        }
        // Which two panes show is this phone's; their order is the tree's,
        // so Move Pane Up and Down, here or on another device, swap them.
        let ordered = slots.sorted { a, b in
            (run.firstIndex { $0.id == a } ?? 0) < (run.firstIndex { $0.id == b } ?? 0)
        }
        return SplitInFront(split: split, run: run, slots: ordered, focused: id)
    }

    /// Whether tab `id` is in front of the user: the tab in front, a pane
    /// shown beside it, or one in Picture in Picture or a call. Another
    /// device's close never takes such a tab (decision 2237).
    func isInFront(_ id: String) -> Bool {
        if id == currentTabId || splitInFront?.slots.contains(id) == true { return true }
        guard let page = pages[id] else { return false }
        return page.inPictureInPicture || page.view.cameraCaptureState != .none
            || page.view.microphoneCaptureState != .none
    }

    /// The split tab `id` is a pane of, and its run of panes, when that run
    /// holds two or more.
    private func splitRun(of id: String) -> (OutlineRow, [OutlineRow])? {
        guard let parent = model.row(id)?.parentId, let split = model.row(parent), split.kind == .split else { return nil }
        let panes = model.children(of: split.id).filter { $0.kind == .tab }
        guard let run = splitRuns(panes).first(where: { $0.contains { $0.id == id } }), run.count >= 2 else { return nil }
        return (split, run)
    }

    /// A pane and its neighbour, in split order: the next pane, or the one
    /// before the last.
    private static func pair(for id: String, in run: [OutlineRow]) -> [String] {
        let at = run.firstIndex { $0.id == id } ?? 0
        return at + 1 < run.count ? [id, run[at + 1].id] : [run[at - 1].id, id]
    }

    /// Puts pane `id` in the split's focused slot, keeping the other slot's
    /// pane, so the tray moves only the focused pane (12d).
    private func placeInSlot(_ id: String, replacing previous: String?) {
        guard let (split, run) = splitRun(of: id) else { return }
        var slots = (splitSlots[split.id] ?? []).filter { slot in run.contains { $0.id == slot } }
        if slots.contains(id), slots.count == 2 { return }
        if slots.count == 2, let previous, let at = slots.firstIndex(of: previous) {
            slots[at] = id
        } else {
            slots = Self.pair(for: id, in: run)
        }
        splitSlots[split.id] = slots
        Diagnostics.log("splits: panes \(slots.compactMap { slot in run.firstIndex { $0.id == slot }.map { $0 + 1 } }) of \(run.count) in view")
    }

    /// The page of a pane the split shows, if it is loaded
    /// (`makeShownPages`).
    func paneView(_ id: String) -> WKWebView? {
        pages[id]?.view
    }

    /// Whether a tab's page is loaded on this phone.
    func hasPage(_ id: String) -> Bool { pages[id] != nil }

    init(model: AppModel, blocker made: ContentBlocker, states: PageStates) {
        self.model = model
        blocker = made
        offloaded = states
        currentTabId = UserDefaults.standard.string(forKey: Self.currentKey)
        workspaceId = UserDefaults.standard.string(forKey: Self.workspaceKey)
        downloads.inPrivate = { [weak self] in self?.inPrivate ?? false }
        blocker.onChange = { [weak self] in
            guard let self else { return }
            for page in pages.values { page.useRules(blocker.rules) }
            if reloadWhenRulesChange {
                reloadWhenRulesChange = false
                reload()
                Diagnostics.log("page: reloaded under the new blocking rules")
            }
        }
        // A site's icon is fetched under the blocking its page loads under:
        // the lists where the site's protections are on (`installRules`).
        SiteIcons.shared.blocking = { [weak self] page in
            guard let self, let host = page.host(),
                  SiteRules(settings: model.settings).protectionsOn(for: host) else { return nil }
            return blocker.requests
        }
        // A private page's media stops as Sval loses focus, so iOS's Now
        // Playing never holds it while Sval isn't in front.
        audio.pages = { [weak self] in
            guard let self, keepPlaying else { return [] }
            // Lifting WebKit's suspension in the background would lift
            // Sval's own too.
            let shown = pages.values.filter { !$0.isPrivate && $0.suspensions.isEmpty }
            return stagedPages().compactMap { view in
                shown.first { $0.view === view }.map { (view: view, playing: $0.playing) }
            }
        }
        // While the private session is in front, its home with no tab
        // included, the screen is covered before iOS takes the app
        // switcher's snapshot, which it saves to disk.
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.saveLiveStates(on: name == UIApplication.willResignActiveNotification ? "losing focus" : "the background")
                    if let front = self?.currentTabId { self?.takePreview(front) }
                    if self?.inPrivate == true { PrivacyCover.show() }
                    if name == UIApplication.willResignActiveNotification {
                        self?.pausePrivateMedia()
                        self?.mediaLog("Sval lost focus")
                    } else {
                        self?.backgroundAt = .now
                        self?.mediaLog("Sval went to the background")
                        // The tab in front's paused media may sleep now.
                        if self?.media.isEmpty == false { self?.startMediaChecks() }
                    }
                }
            }
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.backgroundAt = nil
                self?.makeShownPages()
                PrivacyCover.hide()
                self?.unmutePrivateMedia()
                self?.mediaLog("Sval in front again")
            }
        }
        watchWindow()
        #if DEBUG
        Diagnostics.log("page states: \(offloaded.countOnDisk()) on disk at launch")
        #endif
        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                Task { await self.offload(self.pages.keys.filter { $0 != self.currentTabId }, why: "memory warning") }
            }
        }
        refreshBar()
    }

    /// Lets go of the pages of the workspaces the user left three hours ago
    /// or more. Called on each pass.
    func offloadHiddenWorkspaces() async {
        let current = workspaceId
        let now = Date.now
        let due = pages.keys.filter { id in
            guard let workspace = model.workspace(of: id) ?? Self.pinParts(id)?.workspace, workspace != current,
                  let left = leftAt[workspace] else { return false }
            return now.timeIntervalSince(left) >= Self.hiddenWorkspaceUnload
        }
        if !due.isEmpty {
            await offload(due, why: "hidden workspace")
        }
    }

    /// The most tabs' and pins' pages kept loaded. Each holds its document, scripts
    /// and pictures in memory, and iOS ends an app that holds too much.
    /// Ten covers a split's two panes, tabs playing behind, and the few a
    /// person moves between; a page let go loads again from its saved
    /// state when its tab is shown.
    static let livePages = 10

    /// Lets go of the pages of the tabs and pins least recently in front,
    /// past `livePages`. A pin's page comes back from its state where it
    /// was, its saved page kept (`pinPage`), since selecting a loaded pin
    /// never moves it (pins spec §5).
    private func trimPages() async {
        let over = Self.pastLimit(Array(pages.keys),
                                  counts: { self.model.row($0)?.kind == .tab || self.pin(for: $0) != nil },
                                  usedAt: { self.usedAt[$0] ?? self.pinUsedAt[$0] ?? 0 })
        guard !over.isEmpty else { return }
        await offload(over, why: "past the limit of live pages")
    }

    /// Of the pages `ids`, those `counts` takes that are past `livePages`,
    /// least recently in front first.
    static func pastLimit(_ ids: [String], counts: (String) -> Bool, usedAt: (String) -> Double) -> [String] {
        let counted = ids.filter(counts)
        guard counted.count > livePages else { return [] }
        return Array(counted.sorted { usedAt($0) < usedAt($1) }.dropLast(livePages))
    }

    /// When each pin's page was last brought to the front, by page key.
    /// `usedAt` keeps the tree's tabs alone, for the Launcher.
    @ObservationIgnored private var pinUsedAt: [String: Double] = [:]

    /// Lets go of the pages of `ids`, keeping each one's state, except those
    /// that would lose something by going.
    private func offload(_ ids: [String], why: String) async {
        // A page on screen is never let go: the pane beside the tab in
        // front and the pages kept behind it show too, and one let go
        // would load again as soon as the view asked for it.
        let shown = Set(stagedIds() + (splitInFront?.slots ?? []))
        var released = 0
        for id in ids where id != currentTabId && !shown.contains(id) {
            guard let page = pages[id], await !page.mustStay() else { continue }
            pages.removeValue(forKey: id)
            if let kept = page.keptState {
                keepOffloaded(id, state: kept.state, address: kept.address, from: page)
            }
            page.close()
            media[id] = nil
            held[id] = nil
            stopped.remove(id)
            released += 1
        }
        Diagnostics.log("tabs: \(why), let go of \(released) of \(ids.count) page(s)")
        makeShownPages()
    }

    /// Keeps the state of `id`'s page let go. A private tab's page is told
    /// by the session's ids or, once its tab has left them, by the page.
    func keepOffloaded(_ id: String, state: Any, address: String?, from page: Page? = nil) {
        offloaded.keep(id, state: state, address: address, isTab: model.row(id)?.kind == .tab,
                       isPrivate: model.isPrivate(id) || page?.isPrivate == true, savedPage: page?.savedPage)
    }

    /// Returns once every page state written so far is on disk.
    func statesWritten() async {
        await withCheckedContinuation { done in offloaded.whenWritten { done.resume() } }
    }

    /// What became of a live page's state asked to be written.
    private enum Saving { case written, unchanged, notATab, isPrivate, empty }

    /// Writes the state of tab `id`'s live page to disk, where it outlives
    /// the app.
    @discardableResult
    private func saveState(_ id: String) -> Saving {
        guard let page = pages[id], model.row(id)?.kind == .tab else { return .notATab }
        let isPrivate = model.isPrivate(id) || page.isPrivate
        if isPrivate { return .isPrivate }
        guard let kept = page.keptState else { return .empty }
        return offloaded.save(id, state: kept.state, address: kept.address, isTab: true, isPrivate: isPrivate)
            ? .written : .unchanged
    }

    /// Writes every live tab page's state as the app loses focus and as it
    /// goes to the background. Apple's guidance is to save user data on
    /// deactivation ("Preparing your UI to run in the background"): an app
    /// that runs in the background, as Sval does for audio, is generally
    /// not told when the user quits it (`applicationWillTerminate(_:)`), and
    /// iOS ends a suspended app without a word. The states go to disk off
    /// the main thread, under a background task
    /// (`beginBackgroundTask(withName:expirationHandler:)`) that keeps iOS
    /// from suspending the app before they land.
    private func saveLiveStates(on why: String) {
        let application = UIApplication.shared
        let task = BackgroundTask()
        task.id = application.beginBackgroundTask(withName: "Save the tabs' history") { task.end() }
        var counts: [Saving: Int] = [:]
        for id in pages.keys { counts[saveState(id), default: 0] += 1 }
        offloaded.whenWritten { task.end() }
        #if DEBUG
        Diagnostics.log("page states: on \(why), \(counts[.written] ?? 0) of \(pages.count) live pages written, \(counts[.unchanged] ?? 0) unchanged, \(counts[.isPrivate] ?? 0) private, \(counts[.empty] ?? 0) with nothing shown, \(counts[.notATab] ?? 0) pins or windows")
        #endif
    }

    /// The pages whose pictures `PagePreviews` keeps, by page key: the
    /// tree's tabs, for the grid and the tab scrub, and each Workspace's
    /// pins, for the scrub.
    static func pictured(_ rows: [OutlineRow], pins: [String: [PinRow]]) -> Set<String> {
        var keys = Set(rows.lazy.filter { $0.kind == .tab }.map(\.id))
        for (workspace, rows) in pins {
            for pin in rows where pin.kind == "favorite" { keys.insert(pinKey(pin.guid, in: workspace)) }
        }
        return keys
    }

    /// Takes the picture of `id`'s page, if it's a tab of the tree or a
    /// shown pin with a page here.
    func takePreview(_ id: String) {
        guard model.row(id)?.kind == .tab || pin(for: id) != nil, let page = pages[id] else { return }
        PagePreviews.shared.take(id, from: page.view, isPrivate: model.isPrivate(id))
    }

    /// The page for the tab in front, if it is loaded (`makeShownPages`).
    func currentPage() -> WKWebView? {
        pages[currentTabId ?? ""]?.view
    }

    func select(_ id: String) {
        if id != currentTabId, !media.isEmpty || pages.values.contains(where: { $0.inPictureInPicture }) {
            mediaLog("tab \(Self.tag(id)) to the front, from \(Self.tag(currentTabId))")
        }
        let previous = currentTabId.flatMap { model.workspace(of: $0) }
        let leaving = currentTabId.flatMap { $0 == id ? nil : pages[$0] }
        // Coming back to a stopped tab, its media counts again.
        if id != currentTabId { stopped.remove(id) }
        if let left = currentTabId, left != id { takePreview(left) }
        placeInSlot(id, replacing: currentTabId)
        let moved = id != currentTabId
        if moved, let left = currentTabId { media[left]?.leftFront = .now }
        media[id]?.leftFront = nil
        currentTabId = id
        // The tab that left the front may sleep, and the one in front may not.
        if moved, !media.isEmpty { startMediaChecks() }
        makeShownPages()
        if let page = pages[id] {
            audio.returned(page.view)
            if page.ended, let pin = pin(for: id), let saved = pin.url.flatMap(URL.init(string:)) {
                // A pin's page that went returns to its saved address, as
                // one Sval unloads after a long idle does (pins spec §5).
                Diagnostics.log("pins: a pin whose page ended is back at its saved address")
                page.returnToSaved(saved)
            } else if page.ended {
                Diagnostics.log("tabs: a tab whose page ended is loading again")
                page.reloadIfEnded(fallback: model.row(id).flatMap(Self.openable))
            }
        }
        // What a private tab is, or that one was in front, is never saved.
        let keeps = !model.isPrivate(id)
        if keeps { UserDefaults.standard.set(id, forKey: Self.currentKey) }
        if let split = model.row(id)?.parentId, model.row(split)?.kind == .split {
            splitFocus[split] = id
            UserDefaults.standard.set(splitFocus.filter { !model.isPrivate($0.key) }, forKey: Self.splitFocusKey)
        }
        usedAt[id] = Date.now.timeIntervalSince1970
        if pin(for: id) != nil { pinUsedAt[id] = usedAt[id] }
        let tabs = Set(model.rows.lazy.filter { $0.kind == .tab }.map(\.id))
        usedAt = usedAt.filter { tabs.contains($0.key) }
        UserDefaults.standard.set(usedAt.filter { !model.isPrivate($0.key) }, forKey: Self.usedKey)
        fold.foldBar(to: 0)
        if let workspace = model.workspace(of: id) ?? Self.pinParts(id)?.workspace {
            frontTabs[workspace] = id
            UserDefaults.standard.set(frontTabs.filter { !model.isPrivate($0.key) }, forKey: Self.frontKey)
            workspaceId = workspace
            if let previous, previous != workspace {
                leftAt[previous] = .now
            }
            leftAt[workspace] = nil
        }
        useTimer?.cancel()
        useTimer = Task { [weak self] in
            try? await Task.sleep(for: Self.useDwell)
            guard let self, !Task.isCancelled, currentTabId == id,
                  UIApplication.shared.applicationState == .active else { return }
            await model.markUsed(id)
        }
        refreshState()
        Task { await trimPages() }
    }

    /// Shows Workspace `id` with the tab it last had in front, or its first
    /// tab, or nothing when it has none.
    func showWorkspace(_ id: String) {
        guard id != workspaceId else { return }
        if let front = frontTabs[id], pin(for: front) != nil {
            select(front)
            return
        }
        let tabs = model.tabs(in: id)
        if let tab = frontTabs[id].flatMap({ front in tabs.first { $0.id == front } }) ?? tabs.first {
            select(tab.id)
            return
        }
        if let previous = workspaceId {
            leftAt[previous] = .now
        }
        currentTabId = nil
        UserDefaults.standard.removeObject(forKey: Self.currentKey)
        workspaceId = id
        fold.foldBar(to: 0)
        refreshState()
    }

    /// Opens `url` in the tab in front, or in a new tab when there is none.
    /// A pin keeps its site: another site opens in a new tab
    /// (`SvalLauncherEnter.whereToLoad`).
    func open(_ url: URL, transition: UInt32 = HistoryPage.link) async {
        // History and Favorites carry other devices' addresses, and the
        // phone opens the web alone (`openable`).
        guard AppModel.opensHere(url.absoluteString) else { return }
        if let id = currentTabId, let rules = pages[id]?.pinRules, let host = url.host(),
           (SiteRules.site(of: host) ?? host) != rules.site, let workspace = Self.pinParts(id)?.workspace {
            await openNewTab(url, in: workspace, transition: transition)
            return
        }
        if let id = currentTabId, let page = pages[id] {
            visitTransition[id] = transition
            page.load(url)
        } else if let parent = workspaceId ?? model.workspaces.first?.id {
            await openNewTab(url, in: parent, transition: transition)
        }
    }

    /// Opens `url` in a new tab in Workspace `workspace`: right after the
    /// tab in front, in its group, when that tab is in the Workspace.
    /// Opens the user's own new tab at the end of the Workspace's top level,
    /// where the desktop files a new tab it is not told where to put
    /// (`SvalTabs`' `#reconcile`, `atTop`).
    func openNewTab(_ url: URL, in workspace: String, transition: UInt32 = HistoryPage.link) async {
        guard AppModel.opensHere(url.absoluteString) else { return }
        let last = model.children(of: workspace).last?.id
        if let id = await model.addTab(to: workspace, url: url, after: last) {
            visitTransition[id] = transition
            Diagnostics.log("tabs: a new tab at the end of its Workspace, \(model.children(of: workspace).count) at the top level")
            select(id)
        }
    }

    /// A tab closed on this phone: what reopens it, with its page's back and
    /// forward history. The tree keeps nothing of a closed tab (engine rule
    /// 5), so this list is this phone's alone, as Firefox's recently closed
    /// tabs are each device's own.
    struct ClosedTab: Identifiable {
        let id = UUID()
        let row: OutlineRow
        let place: AppModel.Place?
        let workspace: String?
        let state: Any?
    }

    /// The tabs closed here, newest first.
    private(set) var recentlyClosed: [ClosedTab] = []
    static let recentlyClosedLimit = 10

    /// Closes a tab, keeping what reopens it. Returns the entry, or nil when
    /// the tab didn't close or was private: nothing reopens a private tab,
    /// which would otherwise outlive its session.
    @discardableResult
    func close(_ row: OutlineRow) async -> ClosedTab? {
        guard row.kind == .tab else { return nil }
        // Asked before the close, which drops the tab from the private
        // session's ids.
        let entry = model.isPrivate(row.id) ? nil : ClosedTab(
            row: row, place: model.closedPlace(of: row), workspace: model.workspace(of: row.id),
            state: pages[row.id]?.keptState?.state ?? offloaded.saved(row.id)?.state)
        guard await model.closeTab(row) else { return nil }
        offloaded.forget(row.id)
        if let entry, Self.openable(row) != nil {
            recentlyClosed.insert(entry, at: 0)
            recentlyClosed = Array(recentlyClosed.prefix(Self.recentlyClosedLimit))
        }
        return entry
    }

    /// A split closed on this phone: what reopens it, each pane with its
    /// page's history.
    struct ClosedSplit {
        let split: OutlineRow
        let panes: [OutlineRow]
        let states: [Any?]
        let place: AppModel.Place?
        let workspace: String?
        let focused: Int
    }

    /// Closes a split and every pane, keeping what reopens it. Returns the
    /// entry, or nil when the split didn't close or was private, as
    /// `close` does.
    func closeSplit(_ split: OutlineRow) async -> ClosedSplit? {
        guard !model.isPrivate(split.id) else {
            _ = await model.closeSplit(split)
            return nil
        }
        let panes = model.children(of: split.id).filter { $0.kind == .tab }
        let focus = focusedPane(of: split.id, among: panes.map(\.id))
        let entry = ClosedSplit(
            split: split, panes: panes,
            states: panes.map { pages[$0.id]?.keptState?.state ?? offloaded.saved($0.id)?.state },
            place: model.place(of: split), workspace: model.workspace(of: split.id),
            focused: panes.firstIndex { $0.id == focus } ?? 0)
        guard await model.closeSplit(split) else { return nil }
        return entry
    }

    /// Opens a closed split again where it was, and brings its focused
    /// pane to the front.
    func reopenSplit(_ entry: ClosedSplit) async {
        let place = entry.place ?? entry.workspace.map { AppModel.Place(parent: $0, previous: nil) }
        guard let place, let ids = await model.reopenSplit(entry.split, panes: entry.panes, at: place, workspace: entry.workspace),
              !ids.isEmpty else {
            Diagnostics.log("splits: a closed split could not reopen")
            return
        }
        for (index, id) in ids.enumerated() {
            if let state = entry.states[index] { keepOffloaded(id, state: state, address: entry.panes[index].url) }
        }
        Diagnostics.log("splits: a closed split of \(ids.count) reopened")
        select(ids[min(entry.focused, ids.count - 1)])
    }

    /// Opens a closed tab again where it was, its history with it, and
    /// brings it to the front.
    func reopen(_ entry: ClosedTab) async {
        recentlyClosed.removeAll { $0.id == entry.id }
        let place = entry.place ?? entry.workspace.map { AppModel.Place(parent: $0, previous: nil) }
        // `close` keeps no entry for a private tab.
        guard let place, let id = await model.reopen(entry.row, at: place, workspace: entry.workspace,
                                                     wasPrivate: false) else {
            Diagnostics.log("tabs: a closed tab could not reopen")
            return
        }
        if let state = entry.state {
            keepOffloaded(id, state: state, address: entry.row.url)
        }
        Diagnostics.log("tabs: a closed tab reopened, history \(entry.state == nil ? "lost" : "kept")")
        select(id)
    }

    /// Lets go of the pages of tabs that are gone, and moves off the tab in
    /// front if it went: to the tab before it in its workspace, or the first.
    func reconcile() {
        let tabs = Set(model.rows.filter { $0.kind == .tab }.map(\.id))
        // A pin's page lasts while the pin shows in its Workspace; unpinned,
        // deleted or limited elsewhere, it closes (pins spec §13).
        let live = { (id: String) in tabs.contains(id) || self.pin(for: id) != nil || self.windowsOpening[id] != nil }
        for id in pages.keys where !live(id) {
            pages.removeValue(forKey: id)?.close()
        }
        // Observed state is set only when something went, so a pass that
        // closed nothing redraws nothing.
        if media.keys.contains(where: { !live($0) }) { media = media.filter { live($0.key) } }
        if mediaRefused.keys.contains(where: { !live($0) }) { mediaRefused = mediaRefused.filter { live($0.key) } }
        if askClosed.contains(where: { !live($0) }) { askClosed = askClosed.filter(live) }
        held = held.filter { live($0.key) }
        stopped = stopped.filter(live)
        offloaded.keep(live: live, onDisk: { tabs.contains($0) }, tabs: tabs.count)
        visitTransition = visitTransition.filter { live($0.key) }
        restoring = restoring.filter(live)
        lastVisit = lastVisit.filter { live($0.key) }
        pinUsedAt = pinUsedAt.filter { live($0.key) }
        // Kept by Workspace or split: each goes with its row.
        let exists = { (id: String) in self.model.row(id) != nil }
        frontTabs = frontTabs.filter { exists($0.key) }
        leftAt = leftAt.filter { exists($0.key) }
        splitFocus = splitFocus.filter { exists($0.key) }
        if splitSlots.keys.contains(where: { !exists($0) }) { splitSlots = splitSlots.filter { exists($0.key) } }
        visits = visits.filter { live($0.key) }
        openers = openers.filter { live($0.key) }
        if let id = currentTabId, live(id) {
            if workspaceId == nil { workspaceId = model.workspace(of: id) }
            makeShownPages()
            return
        }
        // An empty Workspace stays shown, empty, for as long as it exists,
        // the private session's included, which `workspaces` leaves out.
        let shown = workspaceId.flatMap { id in model.row(id)?.kind == .workspace ? id : nil }
            ?? model.workspaces.first?.id
        if let next = model.tabs(in: shown).first {
            select(next.id)
        } else {
            currentTabId = nil
            UserDefaults.standard.removeObject(forKey: Self.currentKey)
            workspaceId = shown
            refreshState()
        }
    }

    /// Whether the page in front reloads once the blocking rules next change,
    /// after a change that rebuilds them.
    @ObservationIgnored var reloadWhenRulesChange = false

    /// The address of the page in front, as of the last `refreshState`,
    /// which every change of the page's address reaches.
    private(set) var currentURL: URL?

    /// What the bar shows, set only when it changes, so the bar redraws for
    /// what it shows alone. Every change of what it is worked out from
    /// calls `refreshBar` in the same turn: this type's own state as it is
    /// set, or by `select`, which places a split's panes; the page's in
    /// `refreshState`; and the model's settings, tree, pins and private
    /// session as they are set. An observation of those inputs would tell
    /// of a change before the new value is in place, and the facts would
    /// land a turn after the views that read the model directly.
    private(set) var bar = BarFacts()

    func refreshBar() {
        let facts = BarFacts(self, model)
        guard facts != bar else { return }
        bar = facts
        Signposts.bar.emitEvent("facts")
    }

    /// The title of the page in front, kept as it changes so the bar
    /// follows it.
    private(set) var currentTitle: String?

    func goBack() { step(-1) }
    func goForward() { step(1) }

    private func step(_ offset: Int) {
        guard let view = pages[currentTabId ?? ""]?.view else { return }
        pages[currentTabId ?? ""]?.lift([.hold])
        let list = view.backForwardList
        Diagnostics.log("nav: step \(offset) with \(list.backList.count) back, \(list.forwardList.count) forward")
        if offset < 0, view.canGoBack { view.goBack() }
        if offset > 0, view.canGoForward { view.goForward() }
    }
    /// Clear Browsing Data: every site's cookies, storage and cache in the
    /// store every tab but a private one uses, the sites' icons, the tabs'
    /// pictures and the tabs' saved page states. The tree, history and
    /// settings stay, and so does the private session, whose store is its
    /// own. A page still open keeps its history, and writes its state again
    /// as it next settles or the app leaves the front.
    func clearBrowsingData() async {
        await WKWebsiteDataStore.default().removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        SiteIcons.shared.forgetAll()
        PagePreviews.shared.forgetSaved()
        offloaded.forgetAll(keeping: model.isPrivate)
        Diagnostics.log("settings: browsing data cleared")
        if !privateInFront { reload() }
    }

    /// The page in front's zoom, from the site menu's zoom row.
    var currentZoom: Double {
        Double(currentPage()?.pageZoom ?? 1)
    }

    /// Zooms the page in front to `level`, and keeps it for its host.
    func setZoom(_ level: Double) {
        guard let view = currentPage(), let host = view.url?.host() else { return }
        view.pageZoom = level
        PageZoom.set(level, for: host, isPrivate: privateInFront)
    }

    /// Loads the page in front again. An empty page left by a failed load
    /// has nothing of its own to reload, so that load starts over.
    func reload() {
        guard let page = pages[currentTabId ?? ""] else { return }
        if let failure = page.failure {
            page.load(failure.url)
        } else {
            page.lift([.hold])
            page.view.reload()
        }
    }
    func stopLoading() { pages[currentTabId ?? ""]?.view.stopLoading() }

    /// Each tab's media, for tabs that have played.
    var media: [String: TabMedia] = [:] {
        didSet { refreshBar() }
    }
    /// Tabs whose media the user stopped. Their pages load again, and a
    /// player can start itself on the new page, as YouTube's does, so
    /// their reports are set aside until the user plays it with a tap or
    /// from Sval, or comes back to the tab.
    @ObservationIgnored var stopped: Set<String> = []
    /// Pages kept in the window until a given time: one played from the bar
    /// while it starts. A page out of the window has its media paused by
    /// WebKit.
    @ObservationIgnored var held: [String: Date] = [:]
    /// Moves on as each media deadline passes, so what depends on time
    /// redraws.
    var mediaClock = 0 {
        didSet { refreshBar() }
    }
    @ObservationIgnored var mediaLoop: Task<Void, Never>?

    /// Whether media keeps playing after the user leaves its tab or the app.
    /// This iPhone's own choice: the desktop has no such setting. Off, a
    /// tab left is let out of the window, where WebKit pauses its media,
    /// and so is every page when the app leaves the foreground.
    var keepPlaying: Bool = UserDefaults.standard.object(forKey: keepPlayingKey) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(keepPlaying, forKey: Self.keepPlayingKey)
            refreshBar()
            mediaLog("Keep playing turned \(keepPlaying ? "on" : "off")")
        }
    }
    /// The pages last kept in the window, to log each change.
    @ObservationIgnored var lastStaged: [String] = []

    /// When the app last went to the background, while it is there.
    @ObservationIgnored var backgroundAt: Date?

    /// Each tab's visit with media allowed, kept for its page's life and
    /// past it, so a page let go and made again keeps the visit.
    @ObservationIgnored var visits: [String: Page.Visit] = [:]

    /// The tabs whose page refused media, by the choice that refused it,
    /// until the tab's next load: Ask first's for the bar's ask, Always
    /// deny's for the shield's mark.
    var mediaRefused: [String: SiteRules.Media] = [:] {
        didSet { refreshBar() }
    }
    /// The tabs whose ask the user closed, until the tab's next load.
    var askClosed: Set<String> = [] {
        didSet { refreshBar() }
    }

    // MARK: Visits

    /// How the next page a tab loads was reached, when the user picked it
    /// in the Launcher or Favorites: Places' transition for its visit.
    @ObservationIgnored private var visitTransition: [String: UInt32] = [:]
    /// The tabs whose pages are being put back from their saved state,
    /// which is no visit.
    @ObservationIgnored var restoring: Set<String> = []
    /// The visit each page last recorded, so its title can follow.
    @ObservationIgnored private var lastVisit: [String: (url: String, id: String, at: Date, title: String)] = [:]

    /// `isPrivate` is the page's own, fixed when it was made: a closing
    /// private tab leaves the session's ids while its page still reports,
    /// and asking the model then would call it the user's.
    func navigated(tabId: String, url: URL, title: String, isPrivate: Bool, fromHistory: Bool) {
        if let opening = windowsOpening[tabId] {
            guard !opening.adding, AppModel.opensHere(url.absoluteString) else { return }
            addWindowTab(tabId, url: url)
            return
        }
        // The page has held this address for `Page.settle`, as the tree
        // takes it, so the state written matches the tab's address at the
        // next launch. A force quit or a crash gives no later chance.
        if saveState(tabId) == .written {
            #if DEBUG
            Diagnostics.log("page states: a live tab's state written after it settled")
            #endif
        }
        Task { await model.followNavigation(tabId: tabId, url: url, title: title, isPrivate: isPrivate) }
        // A private tab's pages are never history.
        guard !isPrivate else { return }
        Task { await recordVisit(tabId: tabId, url: url, title: title, fromHistory: fromHistory) }
    }

    /// A page at a new address is a visit, as Places records one; the same
    /// address with a new title updates that visit's title. Back and Forward
    /// record none, as Gecko adds no visit for a history load
    /// (`nsDocShell::ShouldUpdateGlobalHistory`).
    private func recordVisit(tabId: String, url: URL, title: String, fromHistory: Bool) async {
        if restoring.remove(tabId) != nil || fromHistory {
            lastVisit[tabId] = (url.absoluteString, "", .now, title)
            return
        }
        if let last = lastVisit[tabId], last.url == url.absoluteString {
            guard !last.id.isEmpty, !title.isEmpty, title != last.title else { return }
            lastVisit[tabId]?.title = title
            await model.setVisitTitle(last.id, url: last.url, title: title, at: last.at)
            return
        }
        let transition = visitTransition.removeValue(forKey: tabId) ?? HistoryPage.link
        let workspace = model.workspace(of: tabId) ?? Self.pinParts(tabId)?.workspace
        let at = Date.now
        guard let id = await model.recordVisit(url: url, title: title, transition: transition, workspace: workspace) else { return }
        lastVisit[tabId] = (url.absoluteString, id, at, title)
    }

    func refreshState() {
        let view = pages[currentTabId ?? ""]?.view
        canGoBack = view?.canGoBack ?? false
        canGoForward = view?.canGoForward ?? false
        loading = view?.isLoading ?? false
        progress = view?.estimatedProgress ?? 0
        let failure = pages[currentTabId ?? ""]?.failure
        if failure != loadFailure { loadFailure = failure }
        currentTitle = view?.title
        pinOffSaved = currentTabId.flatMap { pin(for: $0) == nil ? nil : pages[$0] }?.offSaved ?? false
        currentURL = view?.url
        refreshBar()
    }

    // MARK: Pins

    /// Whether the pin in front is off its saved page, which shows its
    /// Back button.
    private(set) var pinOffSaved = false
}

/// A background task begun as the app leaves the front, ended once, by
/// whichever comes first: its work done or its time out.
@MainActor
private final class BackgroundTask {
    var id = UIBackgroundTaskIdentifier.invalid

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
