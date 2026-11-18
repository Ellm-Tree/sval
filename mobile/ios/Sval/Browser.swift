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
    private(set) var currentTabId: String?
    /// The workspace the tab list shows. It follows the tab in front.
    private(set) var workspaceId: String? {
        didSet {
            if (oldValue.map(model.isPrivate) ?? false) != inPrivate { pauseOtherSide() }
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
    /// How far the bar has folded into its pill, from 0 (open) to 1,
    /// following the page as it scrolls (`pageScrolled`).
    private(set) var barFold = 0.0
    /// Whether the bar is folded, or past halfway. Setting it opens or
    /// folds the bar with the settling spring.
    var barCollapsed: Bool {
        get { barFold >= 0.5 }
        set { foldBar(to: newValue ? 1 : 0) }
    }
    /// The scroll so far toward folding or unfolding a bar at rest.
    @ObservationIgnored private var foldRun = 0.0
    /// Set when the bar is opened by a tap: the page's coasting leaves it
    /// open until a finger drags the page again.
    @ObservationIgnored private var foldHeldOpen = false
    @ObservationIgnored private var foldSettle: Task<Void, Never>?
    /// When the page counts as at rest, unless another report comes first.
    @ObservationIgnored private var foldSettleAt: ContinuousClock.Instant?

    @ObservationIgnored private var pages: [String: Page] = [:] {
        didSet { if Set(oldValue.keys) != Set(pages.keys) { pagesChanged += 1 } }
    }
    /// Counts the pages made and let go, so the window takes up a page made
    /// after it last drew: the tab in front's, at launch, is made once the
    /// window has drawn without it.
    private var pagesChanged = 0
    /// The tabs the user muted from their row.
    /// The state of each page let go, and the address it was at, by tab id.
    @ObservationIgnored private var offloaded: [String: (state: Any, address: String?)] = [:]
    @ObservationIgnored private let model: AppModel
    @ObservationIgnored let blocker = ContentBlocker()
    /// The files the pages download.
    let downloads = Downloads()
    @ObservationIgnored let audio = BackgroundAudio()
    @ObservationIgnored private var memoryWarning: NSObjectProtocol?
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
    private var privateStore: WKWebsiteDataStore {
        if let sessionStore { return sessionStore }
        let store = WKWebsiteDataStore.nonPersistent()
        sessionStore = store
        return store
    }

    /// Loads `html` into a tab's page, for the privacy check alone.
    func loadForCheck(_ id: String, html: String, base: URL) {
        model.row(id).map { page(for: $0) }?.view.loadHTMLString(html, baseURL: base)
    }

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
        let other = pages.filter { model.isPrivate($0.key) != inPrivate }
        for (id, page) in other {
            page.view.pauseAllMediaPlayback(completionHandler: nil)
            if page.playing || media[id] != nil {
                page.view.evaluateJavaScript(MediaInfo.holdScript, in: nil, in: .defaultClient)
            }
        }
        mediaLog("\(inPrivate ? "entered" : "left") the private session, \(other.count) page(s) of the other side paused")
    }

    /// Pauses every private page's media and holds it suspended until Sval
    /// is in front again, so iOS's Now Playing and lock screen get nothing
    /// of it. A suspended page's media is never theirs
    /// (`HTMLMediaElement::isNowPlayingEligible`), whatever its script
    /// does. It is muted as well, and held as a pause from Sval's controls
    /// holds it, once Sval is back, until the user next taps in the page.
    private func pausePrivateMedia() {
        let held = pages.filter { model.isPrivate($0.key) }
        guard !held.isEmpty else { return }
        for (id, page) in held {
            page.suspend(.privacy)
            if page.playing || media[id] != nil {
                page.view.evaluateJavaScript(MediaInfo.holdScript, in: nil, in: .defaultClient)
            }
            page.runInMediaFrames(MediaInfo.muteForPrivacy)
        }
        mediaLog("Sval lost focus, \(held.count) private page(s) paused, suspended and muted")
    }

    /// Unmutes what `pausePrivateMedia` muted, and lifts its suspension.
    private func unmutePrivateMedia() {
        for (id, page) in pages where model.isPrivate(id) {
            page.runInMediaFrames(MediaInfo.unmuteAfterPrivacy)
            page.lift([.privacy])
        }
    }

    /// Whether the tab in front is a private tab.
    var privateInFront: Bool { currentTabId.map(model.isPrivate) ?? false }

    /// Closes the private session's pages and drops its store, so nothing
    /// of the session stays, even in memory, and goes back to the user's
    /// Workspaces.
    func endPrivateSession(_ ids: Set<String>) {
        for id in ids {
            pages.removeValue(forKey: id)?.close()
            offloaded[id] = nil
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
    private func closeWindow(_ id: String) {
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
        let page = currentTabId == row.id ? currentURL ?? url : url
        guard let guid = await model.pinTab(row, url: page, title: row.title) else { return }
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

    /// How far the page scrolls one way before a resting bar starts to
    /// fold or unfold.
    static let foldStart = 100.0
    /// How far the page scrolls to fold the bar all the way, once started.
    static let foldDistance = 86.0

    /// Moves the bar's fold with the page in front: down folds it, up
    /// opens it, by the distance scrolled once past `foldStart`, so it
    /// stops when the finger stops and turns when the finger turns. Once
    /// the page comes to rest, a fold left partway finishes toward its
    /// nearer end.
    func pageScrolled(_ report: ScrollReport) {
        foldSettleAt = nil
        switch report {
        case .touched:
            foldHeldOpen = false
            return
        case .released:
            break
        case .atEnd:
            if !foldHeldOpen, barFold > 0 { foldBar(to: 0) }
            return
        case .moved(let delta, let atTop, let held):
            guard !foldHeldOpen else { return }
            var moved = delta
            if !atTop, barFold == 0 || barFold == 1 {
                let toward = barFold == 0 ? delta > 0 : delta < 0
                foldRun = toward && (foldRun == 0 || (foldRun > 0) == (delta > 0)) ? foldRun + delta : 0
                guard abs(foldRun) > Self.foldStart else { return }
                moved = foldRun - (foldRun > 0 ? Self.foldStart : -Self.foldStart)
                foldRun = 0
            }
            let next = atTop ? 0 : min(1, max(0, barFold + moved / Self.foldDistance))
            if next != barFold {
                var still = Transaction()
                still.disablesAnimations = true
                withTransaction(still) { barFold = next }
            }
            if held { return }
        }
        // Coasting reports keep coming; the page is at rest once they stop.
        // They come each frame, so one task waits out a deadline each
        // report moves on.
        foldSettleAt = .now + .milliseconds(120)
        guard foldSettle == nil else { return }
        foldSettle = Task { [weak self] in
            while let at = self?.foldSettleAt {
                try? await Task.sleep(until: at, clock: .continuous)
                guard let self else { return }
                guard let due = foldSettleAt else { break }
                if due > .now { continue }
                foldSettleAt = nil
                if barFold > 0, barFold < 1 { foldBar(to: barFold >= 0.5 ? 1 : 0) }
            }
            self?.foldSettle = nil
        }
    }

    /// Opens the bar from a tap on its pill. The page's coasting leaves
    /// it open until a finger drags the page again.
    func openBar() {
        foldHeldOpen = true
        foldBar(to: 0)
    }

    /// Puts the bar's fold back as it was, at once, as when a Workspace
    /// swipe ends on the bar that slid in.
    func keepFold(_ fold: Double) {
        foldRun = 0
        barFold = fold
    }

    private func foldBar(to end: Double) {
        foldRun = 0
        guard barFold != end else { return }
        // Under Reduce Motion the bar goes to its fold at once.
        withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .smooth(duration: 0.4)) { barFold = end }
    }

    /// When tab `id` was last brought to the front on this phone.
    func lastUsed(_ id: String) -> Double? { usedAt[id] }

    /// The tabs most recently brought to the front, newest first, across
    /// every Workspace, then the tabs never brought to the front here in
    /// the tree's order: the empty Launcher's list (`recentTabs`,
    /// `RECENT_TABS`).
    func recentTabs(limit: Int = 6) -> [OutlineRow] {
        model.rows
            .filter { $0.kind == "tab" && $0.id != currentTabId && Self.openable($0) != nil }
            // The private session and the user's Workspaces never see each
            // other's tabs.
            .filter { model.isPrivate($0.id) == inPrivate }
            .enumerated()
            .sorted { a, b in
                let (used, other) = (usedAt[a.element.id] ?? -1, usedAt[b.element.id] ?? -1)
                return used != other ? used > other : a.offset < b.offset
            }
            .prefix(limit)
            .map(\.element)
    }
    private static let frontKey = "frontTabs"

    /// The tab each Workspace last had in front, so switching back to a
    /// Workspace returns to it.
    @ObservationIgnored private var frontTabs: [String: String] =
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

    /// A message for the browser's toast from a view without one of its
    /// own, such as a pane's pick page.
    var toast: Toast?

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
        guard let parent = model.row(id)?.parentId, let split = model.row(parent), split.kind == "split" else { return nil }
        let panes = model.children(of: split.id).filter { $0.kind == "tab" }
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

    init(model: AppModel) {
        self.model = model
        currentTabId = UserDefaults.standard.string(forKey: Self.currentKey)
        workspaceId = UserDefaults.standard.string(forKey: Self.workspaceKey)
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
            let shown = pages.values.filter { !model.isPrivate($0.tabId) && $0.suspensions.isEmpty }
            return stagedPages().compactMap { view in
                shown.first { $0.view === view }.map { (view: view, playing: $0.playing) }
            }
        }
        // While a private tab is in front, the screen is covered before
        // iOS takes the app switcher's snapshot, which it saves to disk.
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    if let front = self?.currentTabId { self?.takePreview(front) }
                    if self?.privateInFront == true { PrivacyCover.show() }
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
        memoryWarning = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                Task { await self.offload(self.pages.keys.filter { $0 != self.currentTabId }, why: "memory warning") }
            }
        }
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

    /// The most tabs' pages kept loaded. Each holds its document, scripts
    /// and pictures in memory, and iOS ends an app that holds too much.
    /// Ten covers a split's two panes, tabs playing behind, and the few a
    /// person moves between; a page let go loads again from its saved
    /// state when its tab is shown.
    static let livePages = 10

    /// Lets go of the pages of the tabs least recently in front, past
    /// `livePages`. Pins' pages are left out: one let go would come back
    /// at its saved address, and selecting a loaded pin never moves it
    /// (pins spec §5).
    private func trimPages() async {
        let tabs = pages.keys.filter { model.row($0)?.kind == "tab" }
        guard tabs.count > Self.livePages else { return }
        let oldest = tabs.sorted { (usedAt[$0] ?? 0) < (usedAt[$1] ?? 0) }
        await offload(Array(oldest.dropLast(Self.livePages)), why: "past the limit of live pages")
    }

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
            if let state = page.view.interactionState {
                offloaded[id] = (state, page.view.url?.absoluteString)
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

    /// Takes the grid's picture of tab `id`'s page, if it's a tab of the
    /// tree with a page here.
    func takePreview(_ id: String) {
        guard model.row(id)?.kind == "tab", let page = pages[id] else { return }
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
        if let split = model.row(id)?.parentId, model.row(split)?.kind == "split" {
            splitFocus[split] = id
            UserDefaults.standard.set(splitFocus.filter { !model.isPrivate($0.key) }, forKey: Self.splitFocusKey)
        }
        usedAt[id] = Date.now.timeIntervalSince1970
        let tabs = Set(model.rows.lazy.filter { $0.kind == "tab" }.map(\.id))
        usedAt = usedAt.filter { tabs.contains($0.key) }
        UserDefaults.standard.set(usedAt.filter { !model.isPrivate($0.key) }, forKey: Self.usedKey)
        barCollapsed = false
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
        barCollapsed = false
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
    /// the tab didn't close.
    @discardableResult
    func close(_ row: OutlineRow) async -> ClosedTab? {
        guard row.kind == "tab" else { return nil }
        let entry = ClosedTab(
            row: row, place: model.closedPlace(of: row), workspace: model.workspace(of: row.id),
            state: pages[row.id]?.view.interactionState ?? offloaded[row.id]?.state)
        // Asked before the close: closing drops the tab from the private
        // session's ids, and the last tab ends the session.
        let wasPrivate = model.isPrivate(row.id)
        guard await model.closeTab(row) else { return nil }
        if Self.openable(row) != nil, !wasPrivate {
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

    /// Closes a split and every pane, keeping what reopens it.
    func closeSplit(_ split: OutlineRow) async -> ClosedSplit? {
        let panes = model.children(of: split.id).filter { $0.kind == "tab" }
        let focus = focusedPane(of: split.id, among: panes.map(\.id))
        let entry = ClosedSplit(
            split: split, panes: panes,
            states: panes.map { pages[$0.id]?.view.interactionState ?? offloaded[$0.id]?.state },
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
            if let state = entry.states[index] { offloaded[id] = (state, entry.panes[index].url) }
        }
        Diagnostics.log("splits: a closed split of \(ids.count) reopened")
        select(ids[min(entry.focused, ids.count - 1)])
    }

    /// Opens a closed tab again where it was, its history with it, and
    /// brings it to the front.
    func reopen(_ entry: ClosedTab) async {
        recentlyClosed.removeAll { $0.id == entry.id }
        let place = entry.place ?? entry.workspace.map { AppModel.Place(parent: $0, previous: nil) }
        guard let place, let id = await model.reopen(entry.row, at: place, workspace: entry.workspace) else {
            Diagnostics.log("tabs: a closed tab could not reopen")
            return
        }
        if let state = entry.state {
            offloaded[id] = (state, entry.row.url)
        }
        Diagnostics.log("tabs: a closed tab reopened, history \(entry.state == nil ? "lost" : "kept")")
        select(id)
    }

    /// Lets go of the pages of tabs that are gone, and moves off the tab in
    /// front if it went: to the tab before it in its workspace, or the first.
    func reconcile() {
        let tabs = Set(model.rows.filter { $0.kind == "tab" }.map(\.id))
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
        offloaded = offloaded.filter { live($0.key) }
        visitTransition = visitTransition.filter { live($0.key) }
        restoring = restoring.filter(live)
        lastVisit = lastVisit.filter { live($0.key) }
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
        let shown = workspaceId.flatMap { id in model.row(id)?.kind == "workspace" ? id : nil }
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

    /// The address of the page in front.
    var currentURL: URL? {
        pages[currentTabId ?? ""]?.view.url
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
    /// store every tab but a private one uses, the sites' icons and the
    /// tabs' pictures. The tree, history and settings stay, and so does the
    /// private session, whose store is its own.
    func clearBrowsingData() async {
        await WKWebsiteDataStore.default().removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        SiteIcons.shared.forgetAll()
        PagePreviews.shared.forgetSaved()
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

    func reload() {
        pages[currentTabId ?? ""]?.lift([.hold])
        pages[currentTabId ?? ""]?.view.reload()
    }
    func stopLoading() { pages[currentTabId ?? ""]?.view.stopLoading() }

    // MARK: Media
    //
    // Each tab's media state is whether its page has media playing, and
    // whether all of it is muted, as its
    // frames report on every change (`Page.reportPlayback`). All the rest
    // (which pages stay in the window, what the bar shows, when paused
    // media sleeps) follows from it.

    enum MediaState { case playing, paused }

    struct TabMedia {
        var state: MediaState
        /// When it last started playing, which orders the bar's choice.
        var startedAt: Date
        /// When it last paused, while it hasn't played since.
        var pausedAt: Date?
        /// When its tab last left the front, while it hasn't come back.
        var leftFront: Date?
        /// Whether all the media playing is muted, as YouTube's starts.
        var muted = false
    }

    /// Each tab's media, for tabs that have played.
    private(set) var media: [String: TabMedia] = [:]
    /// Tabs whose media the user stopped. Their pages load again, and a
    /// player can start itself on the new page, as YouTube's does, so
    /// their reports are set aside until the user plays it with a tap or
    /// from Sval, or comes back to the tab.
    @ObservationIgnored private var stopped: Set<String> = []
    /// Pages kept in the window until a given time: one played from the bar
    /// while it starts. A page out of the window has its media paused by
    /// WebKit.
    @ObservationIgnored private var held: [String: Date] = [:]
    /// Moves on as each media deadline passes, so what depends on time
    /// redraws.
    private(set) var mediaClock = 0
    @ObservationIgnored private var mediaLoop: Task<Void, Never>?

    /// Whether media keeps playing after the user leaves its tab or the app.
    /// This iPhone's own choice: the desktop has no such setting. Off, a
    /// tab left is let out of the window, where WebKit pauses its media,
    /// and so is every page when the app leaves the foreground.
    var keepPlaying: Bool = UserDefaults.standard.object(forKey: keepPlayingKey) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(keepPlaying, forKey: Self.keepPlayingKey)
            mediaLog("Keep playing turned \(keepPlaying ? "on" : "off")")
        }
    }
    private static let keepPlayingKey = "keepPlayingAfterLeaving"

    /// How long paused media keeps its place in the bar and its page in the
    /// window, so it can be played again from there.
    static let pausedShown: TimeInterval = 30
    /// How long paused media out of sight is kept before its page sleeps:
    /// let go with its history, which ends its media and clears it from
    /// the lock screen.
    static let pausedSleep: TimeInterval = 5 * 60

    /// The tabs whose media is playing.
    var playingTabs: Set<String> {
        Set(media.filter { $0.value.state == .playing }.keys)
    }

    /// Whether `id`'s media is playing, or paused recently enough to show.
    func mediaShown(_ id: String) -> Bool {
        _ = mediaClock
        // Picture in Picture's window shows the media already (6a).
        guard let entry = media[id], !inPictureInPicture(id) else { return false }
        if entry.state == .playing { return true }
        guard let paused = entry.pausedAt else { return false }
        return Date.now.timeIntervalSince(paused) < Self.pausedShown
    }

    /// Whether `id`'s video is in Picture in Picture, which keeps its page
    /// in the window and loaded, whatever else would let it go.
    func inPictureInPicture(_ id: String) -> Bool {
        _ = mediaClock
        return pages[id]?.inPictureInPicture ?? false
    }

    /// The tab whose media the bar shows outside the pill: of those shown,
    /// the last to start, other than the tab in front.
    var mediaTab: String? {
        guard keepPlaying else { return nil }
        return media.keys
            .filter { $0 != currentTabId && mediaShown($0) && model.isPrivate($0) == inPrivate }
            .max { media[$0]!.startedAt < media[$1]!.startedAt }
    }

    // MARK: Media log

    /// A tab's short id for the log: ids say nothing of what is browsed.
    private static func tag(_ id: String?) -> String { id.map { String($0.prefix(6)) } ?? "none" }

    /// Every media fact the bar and the window act on, in one line: the tab
    /// in front, the setting, the side, what the bar shows, the pages kept
    /// in the window, and each tab with media or a page reporting any.
    private func mediaSnapshot() -> String {
        let now = Date.now
        var parts = ["front \(Self.tag(currentTabId))", "keep playing \(keepPlaying ? "on" : "off")",
                     inPrivate ? "in private" : "out of private"]
        let front = currentTabId.flatMap { mediaShown($0) ? $0 : nil }
        parts.append("bar \(front.map { "front \(Self.tag($0))" } ?? mediaTab.map { "tab \(Self.tag($0))" } ?? "no media")"
                     + (frontAsks ? ", ask" : "") + (frontDenied ? ", denied mark" : ""))
        parts.append("window [\(stagedIds().map { Self.tag($0) }.joined(separator: " "))]")
        let ids = Set(media.keys).union(pages.filter {
            $0.value.playing || $0.value.inPictureInPicture || !$0.value.suspensions.isEmpty
        }.keys)
        for id in ids.sorted() {
            var bits: [String] = []
            if let entry = media[id] {
                bits.append(entry.state == .playing ? "playing"
                            : "paused \(Int(now.timeIntervalSince(entry.pausedAt ?? now)))s")
                if entry.muted { bits.append("muted") }
            }
            if let page = pages[id] {
                if page.playing != (media[id]?.state == .playing) { bits.append("page says \(page.playing ? "playing" : "silent")") }
                if page.inPictureInPicture { bits.append("PiP") }
                if !page.suspensions.isEmpty {
                    bits.append("suspended \(page.suspensions.sorted().map(\.rawValue).joined(separator: "+"))")
                }
            } else {
                bits.append("no page")
            }
            if model.isPrivate(id) { bits.append("private") }
            if stopped.contains(id) { bits.append("stopped") }
            if mediaShown(id) { bits.append("shown") }
            parts.append("\(Self.tag(id)) \(bits.joined(separator: " "))")
        }
        return parts.joined(separator: "; ")
    }

    /// Logs a media event with the whole media state after it.
    func mediaLog(_ event: String) {
        Diagnostics.log("media: \(event) | \(mediaSnapshot())")
    }

    /// The pages last kept in the window, to log each change.
    @ObservationIgnored private var lastStaged: [String] = []

    /// The tabs whose pages `stagedPages` keeps in the window, back to
    /// front.
    private func stagedIds() -> [String] {
        _ = mediaClock
        let now = Date.now
        let behind = pages.keys
            .filter { id in
                guard id != currentTabId else { return false }
                if inPictureInPicture(id) { return true }
                return keepPlaying && model.isPrivate(id) == inPrivate
                    && (mediaShown(id) || (held[id].map { $0 > now } ?? false))
            }
            .sorted { (media[$0]?.startedAt ?? .distantPast) < (media[$1]?.startedAt ?? .distantPast) }
        // A split in front shows its panes itself (`SplitStage`).
        if let split = splitInFront {
            return behind.filter { !split.slots.contains($0) }
        }
        return behind + [currentTabId].compactMap { $0 }
    }

    /// The pages to keep in the window, back to front: tabs whose media is
    /// shown or which are held, then the tab in front. A page out of the
    /// window is told it's hidden, which some sites answer by unloading
    /// their player, and its media is paused.
    func stagedPages() -> [WKWebView] {
        _ = pagesChanged
        let ids = stagedIds()
        let behind = ids.filter { $0 != currentTabId }.compactMap { pages[$0]?.view }
        if splitInFront != nil { return behind }
        return behind + [currentPage()].compactMap { $0 }
    }

    /// Follows the pages `stagedPages` keeps in the window, as the views
    /// do, outside any view's body: logs each change, and pauses the media
    /// of the pages it lets go of.
    private func watchWindow() {
        let ids = withObservationTracking {
            stagedIds()
        } onChange: { [weak self] in
            Task { @MainActor in self?.watchWindow() }
        }
        guard ids != lastStaged else { return }
        let left = lastStaged.filter { !ids.contains($0) }, joined = ids.filter { !lastStaged.contains($0) }
        lastStaged = ids
        mediaLog("the window changed: in \(joined.map { Self.tag($0) }), out \(left.map { Self.tag($0) })")
        // WebKit plays on in a page out of the window, so media the window
        // lets go of is paused here. Every page, as media a page's frames
        // don't report plays as well.
        for id in left where !inPictureInPicture(id) {
            guard let page = pages[id] else { continue }
            page.view.pauseAllMediaPlayback(completionHandler: nil)
            mediaLog("tab \(Self.tag(id)) paused: out of the window")
        }
    }

    /// Makes the pages the window shows that aren't loaded: the tab in
    /// front's and the split's panes. Called where what is shown changes,
    /// never from a view's body, so a page let go stays gone until it is
    /// shown again, and never while the app is in the background, where
    /// the tab in front's page sleeps with its paused media.
    private func makeShownPages() {
        guard let id = currentTabId, UIApplication.shared.applicationState != .background else { return }
        if let pin = pin(for: id) {
            _ = pinPage(id, pin)
        } else if let row = model.row(id) {
            _ = page(for: row)
        }
        for slot in splitInFront?.slots ?? [] where slot != id {
            if let row = model.row(slot) { _ = page(for: row) }
        }
    }

    /// The tabs whose playing media is all muted.
    var mutedTabs: Set<String> {
        Set(media.filter { $0.value.muted }.keys)
    }

    /// Takes a page's report on its media: whether it plays, whether it's
    /// muted, and whether a tap started it, which brings a stopped tab's
    /// media back.
    private func mediaReport(_ id: String, playing: Bool, muted: Bool, gesture: Bool) {
        if stopped.contains(id) {
            guard playing, gesture else { return }
            stopped.remove(id)
            mediaLog("stopped tab \(Self.tag(id)) played with a tap")
        }
        if playing {
            guard media[id]?.state != .playing else {
                media[id]?.muted = muted
                return
            }
            media[id] = TabMedia(state: .playing, startedAt: .now, pausedAt: nil, muted: muted)
            mediaLog("tab \(Self.tag(id)) started playing")
        } else {
            guard var entry = media[id], entry.state == .playing else { return }
            entry.state = .paused
            entry.pausedAt = .now
            media[id] = entry
            mediaLog("tab \(Self.tag(id)) paused")
        }
        startMediaChecks()
    }

    /// Sleeps until the media state next changes by itself: paused media's
    /// time in the bar running out, its page's time to sleep, or a page's
    /// hold on the window ending. Media playing needs no clock. Called
    /// again whenever what those times depend on changes, which starts
    /// over from the new state; it ends once nothing is left to wait for.
    private func startMediaChecks() {
        mediaLoop?.cancel()
        mediaLoop = Task { @MainActor [weak self] in
            var first = true
            while let self, !Task.isCancelled {
                let now = Date.now
                held = held.filter { $0.value > now }
                for id in media.keys where (sleepTime(id).map { $0 <= now } ?? false) {
                    await sleepMedia(id, why: "paused media out of sight")
                }
                guard !Task.isCancelled else { return }
                if !first { mediaClock += 1 }
                first = false
                guard let next = nextMediaDeadline(after: now) else { break }
                try? await Task.sleep(for: .seconds(next.timeIntervalSince(now)))
            }
            guard !Task.isCancelled else { return }
            self?.mediaLoop = nil
        }
    }

    /// When paused media's page sleeps, if it may: `pausedSleep` after it
    /// paused and went out of sight, whichever came later. A tab in front,
    /// or a pane of the split shown, is out of sight once the app is in the
    /// background.
    private func sleepTime(_ id: String) -> Date? {
        guard let entry = media[id], entry.state != .playing, let paused = entry.pausedAt else { return nil }
        let shown = id == currentTabId || splitInFront?.slots.contains(id) == true
        guard let hidden = shown ? backgroundAt : entry.leftFront ?? paused else { return nil }
        return max(paused, hidden) + Self.pausedSleep
    }

    /// When the app last went to the background, while it is there.
    @ObservationIgnored private var backgroundAt: Date?

    /// The next time after `now` the media state changes by itself.
    private func nextMediaDeadline(after now: Date) -> Date? {
        var times = Array(held.values)
        for (id, entry) in media where entry.state != .playing {
            if let paused = entry.pausedAt { times.append(paused + Self.pausedShown) }
            if let sleep = sleepTime(id) { times.append(sleep) }
        }
        return times.filter { $0 > now }.min()
    }

    /// Lets go of `id`'s page, keeping its history, so its media ends and
    /// leaves the lock screen. The tab in front goes too while the app is in
    /// the background; it loads again from its history when shown.
    func sleepMedia(_ id: String, why: String) async {
        guard let page = pages[id] else {
            media[id] = nil
            return
        }
        guard !page.playing, !page.inPictureInPicture, await !page.mustStay() else { return }
        if id == currentTabId && UIApplication.shared.applicationState != .background { return }
        pages.removeValue(forKey: id)
        if let state = page.view.interactionState {
            offloaded[id] = (state, page.view.url?.absoluteString)
        }
        page.close()
        media[id] = nil
        mediaLog("tab \(Self.tag(id)) slept: \(why)")
    }

    /// Ends a tab's media by loading its page again, which ends the page's
    /// media session, so it leaves Sval's controls and iOS's. Taking the
    /// media's source away isn't enough: a player such as YouTube's puts it
    /// back and plays on. The page stays loaded, with its history, and is
    /// let go as any tab is.
    ///
    /// The page in front, on screen, would start again as it loads, so it
    /// is paused and held until the user next taps or types in it
    /// (`MediaInfo.hold`), which a tap on its player ends.
    func stopMedia(_ id: String) async {
        guard let page = pages[id] else { return }
        media[id] = nil
        held[id] = nil
        // Picture in Picture's own Play is the user's, which a suspension
        // would refuse.
        if id == currentTabId, !page.inPictureInPicture {
            page.suspend(.hold)
        } else {
            await page.view.pauseAllMediaPlayback()
        }
        if id == currentTabId {
            _ = try? await page.view.evaluateJavaScript(MediaInfo.holdScript, in: nil, contentWorld: .defaultClient)
            mediaLog("tab \(Self.tag(id)) stopped in front, held until the next tap")
            return
        }
        stopped.insert(id)
        page.view.reload()
        mediaLog("tab \(Self.tag(id)) stopped behind, the page loads again")
    }

    /// Makes `id`'s page again for the video and audio choice of where it
    /// is, or of `url`, which it then loads, keeping its history. WebKit
    /// fixes a page's playback rule when it is made.
    func remake(_ id: String, loading url: URL?, why: String) {
        guard let site = url ?? pages[id]?.view.url, let old = pages.removeValue(forKey: id) else { return }
        let state = old.view.interactionState
        old.close()
        media[id] = nil
        let page = makePage(id, address: nil, opens: nil, pin: false, at: site)
        if let state {
            page.view.interactionState = state
            if url == nil { restoring.insert(id) }
        }
        if let url { page.load(url) }
        // The window asks for the tab's page again, which is this one.
        mediaClock += 1
        mediaLog("tab \(Self.tag(id)) page made again: \(why)")
    }

    /// Makes every page whose site's video and audio choice changed again,
    /// as the desktop's choice reaches its pages.
    func applyMediaChoices() {
        for (id, page) in pages where page.onRemake != nil {
            let rules = model.siteRules(private: page.isPrivate)
            guard let host = page.view.url?.host(), page.visit?.site != (SiteRules.site(of: host) ?? host),
                  rules.media(for: host) != page.media else { continue }
            remake(id, loading: nil, why: "the site's choice changed from \(page.media.words) to \(rules.media(for: host).words)")
        }
    }

    /// Each tab's visit with media allowed, kept for its page's life and
    /// past it, so a page let go and made again keeps the visit.
    @ObservationIgnored private var visits: [String: Page.Visit] = [:]

    /// The tabs whose page refused media, by the choice that refused it,
    /// until the tab's next load: Ask first's for the bar's ask, Always
    /// deny's for the shield's mark.
    private(set) var mediaRefused: [String: SiteRules.Media] = [:]
    /// The tabs whose ask the user closed, until the tab's next load.
    private(set) var askClosed: Set<String> = []

    /// Whether the bar asks to allow the page in front's media.
    var frontAsks: Bool {
        guard let id = currentTabId else { return false }
        return mediaRefused[id] == .ask && !askClosed.contains(id)
    }

    /// Whether Always deny refused the page in front's media.
    var frontDenied: Bool {
        currentTabId.map { mediaRefused[$0] == .block } ?? false
    }

    /// Closes the page in front's ask, allowing nothing.
    func closeAsk() {
        guard let id = currentTabId else { return }
        askClosed.insert(id)
        mediaLog("tab \(Self.tag(id)) ask closed")
    }

    /// Allows media on the page in front for this visit, as the desktop's
    /// media button does (decision 0132): the page is made again to play
    /// media, and saves nothing.
    func allowMediaForVisit() {
        guard let id = currentTabId, let host = pages[id]?.view.url?.host() else { return }
        visits[id] = Page.Visit(site: SiteRules.site(of: host) ?? host, since: .now)
        remake(id, loading: nil, why: "Allow Video and Audio")
    }

    /// Saves Always allow as the page in front's site's choice, which makes
    /// the page again to play media (`applyMediaChoices`).
    func alwaysAllowMedia() async {
        guard let id = currentTabId, let page = pages[id], let host = page.view.url?.host() else { return }
        let name = SiteRules.scope(of: host) ?? host
        // A private tab's choice stays in the session, as the desktop's
        // private window keeps it.
        if page.isPrivate {
            model.setPrivateMedia(name, to: .allow)
            return
        }
        let change = model.siteRules(private: false).mediaChange(for: name, to: .allow)
        await model.setSetting(change.key, to: change.value)
    }

    /// What `id`'s media is, for the media card.
    func mediaInfo(_ id: String) async -> MediaInfo? {
        guard let page = pages[id],
              let result = try? await page.view.evaluateJavaScript(MediaInfo.read, in: nil, contentWorld: .defaultClient),
              let fields = result as? [String: Any] else { return nil }
        return MediaInfo(fields)
    }

    /// Runs a media command on `id`'s page: "toggle", "skip" by `by`
    /// seconds, "seek" to `to`, "mute" or "pip".
    func media(_ id: String, _ command: String, value: Double = 0) {
        guard let page = pages[id] else {
            mediaLog("\(command) on tab \(Self.tag(id)) found no page")
            return
        }
        // WebKit plays nothing for a page out of the window, so one played
        // from the bar is held there while it starts.
        stopped.remove(id)
        if ["toggle", "pip"].contains(command) { page.lift([.hold]) }
        if id != currentTabId {
            held[id] = .now.addingTimeInterval(4)
            startMediaChecks()
        }
        mediaLog("\(command) on tab \(Self.tag(id)) from Sval's controls")
        let script = MediaInfo.command(command, value: value, mute: !(media[id]?.muted ?? false))
        Task { @MainActor in
            var outcome = (try? await page.view.callAsyncJavaScript(script, contentWorld: .defaultClient)) as? String
            // WebKit refuses play() while it holds the page's media
            // suspended, as after the app was in the background. A
            // suspension of Sval's own stays.
            if outcome?.hasSuffix("NotAllowedError") == true, page.suspensions.isEmpty {
                await page.view.setAllMediaPlaybackSuspended(false)
                outcome = (try? await page.view.callAsyncJavaScript(script, contentWorld: .defaultClient)) as? String
            }
            self.mediaLog("\(command) on tab \(Self.tag(id)): \(outcome ?? "the page didn't answer")")
        }
    }

    /// Mutes or unmutes every sound tab `id`'s page makes, from its row.
    func toggleMute(_ id: String) {
        media(id, "mute")
    }

    private func page(for row: OutlineRow) -> Page {
        if let page = pages[row.id] {
            return page
        }
        return makePage(row.id, address: row.url, opens: Self.openable(row), pin: false)
    }

    /// A page for `id`, put back as it was let go when it was at `address`,
    /// or else loading `opens`.
    private func makePage(_ id: String, address: String?, opens: URL?, pin: Bool, at site: URL? = nil,
                          privately: Bool? = nil, configuration: WKWebViewConfiguration? = nil) -> Page {
        let isPrivate = privately ?? model.isPrivate(id)
        let rules = model.siteRules(private: isPrivate)
        let host = site?.host() ?? offloaded[id]?.address.flatMap(URL.init(string:))?.host() ?? opens?.host()
        // A page made at another site than its tab's visit ends the visit.
        let visit = visits[id].flatMap { visit in host.map { SiteRules.site(of: $0) ?? $0 } == visit.site ? visit : nil }
        visits[id] = visit
        let page = Page(tabId: id, media: visit == nil ? rules.media(for: host) : .allow, visit: visit,
                        reportsTouch: pin,
                        privateStore: isPrivate ? privateStore : nil,
                        configuration: configuration) { [weak self] action, webView in
            JavaScriptRules.allowed(action, in: webView, settings: self?.model.settings ?? [:])
        } onNavigate: { [weak self] tabId, url, title, isPrivate, fromHistory in
            self?.navigated(tabId: tabId, url: url, title: title, isPrivate: isPrivate, fromHistory: fromHistory)
        } onState: { [weak self] in
            self?.refreshState()
        } onScroll: { [weak self] tabId, report in
            guard let self, tabId == currentTabId else { return }
            pageScrolled(report)
        }
        pages[id] = page
        page.mediaChoice = { [weak self] host in
            self?.model.siteRules(private: isPrivate).media(for: host) ?? SiteRules(settings: [:]).media(for: host)
        }
        // A pin's page stays the pin's (`pinRules`).
        if !pin {
            page.onRemake = { [weak self] url, why in self?.remake(id, loading: url, why: why) }
        }
        page.onBlocked = { [weak self, weak page] in
            guard let self, let page, pages[id] === page, mediaRefused[id] == nil else { return }
            mediaRefused[id] = page.guarding
            if page.guarding == .ask, id == currentTabId {
                AccessibilityNotification.Announcement("Video and audio blocked").post()
            }
        }
        // A tap on the player is consent, which ends the ask (17a).
        page.onGranted = { [weak self] in
            guard let self else { return }
            askClosed.insert(id)
            if mediaRefused[id] == .ask { mediaRefused[id] = nil }
        }
        page.onLoad = { [weak self, weak page] in
            guard let self else { return }
            mediaRefused[id] = nil
            askClosed.remove(id)
            // The new document has no media of its own yet. Media in Picture
            // in Picture keeps its entry, for its frames' reports to settle.
            if media[id] != nil, page?.inPictureInPicture != true {
                media[id] = nil
                mediaLog("tab \(Self.tag(id)) loaded a new document, its media gone")
            }
        }
        page.log = { [weak self] event in self?.mediaLog("tab \(Self.tag(id)) \(event)") }
        page.onVisitEnd = { [weak self, weak page] in
            guard let self, let page, pages[id] === page else { return }
            visits[id] = nil
            mediaLog("tab \(Self.tag(id)) visit with media allowed ended")
        }
        page.onPictureInPicture = { [weak self, weak page] in
            self?.mediaClock += 1
            // Media out of Picture in Picture may sleep.
            if self?.media[id] != nil { self?.startMediaChecks() }
            self?.mediaLog("tab \(Self.tag(id)) video \(page?.inPictureInPicture == true ? "went into" : "left") Picture in Picture")
        }
        page.onDownload = { [weak self] download, asked in self?.downloads.start(download, asked: asked) }
        page.onMedia = { [weak self] id, playing, muted, gesture in
            self?.mediaReport(id, playing: playing, muted: muted, gesture: gesture)
        }
        page.protectionsOn = { [weak self] host in
            self?.model.siteRules(private: isPrivate).protectionsOn(for: host) ?? true
        }
        page.protected = rules.protectionsOn(for: host ?? "")
        page.useRules(blocker.rules)
        page.onNewWindow = { [weak self] configuration, action in
            self?.openWindow(from: id, configuration: configuration, for: action)
        }
        page.onCloseWindow = { [weak self] in self?.closeWindow(id) }
        // Made while the view is drawn; the bar takes its state after.
        Task { @MainActor [weak self] in self?.refreshState() }
        // A page let go comes back as it was, unless another device has
        // since moved the tab to another address.
        guard !pin else { return page }
        if let saved = offloaded.removeValue(forKey: id), saved.address == address {
            page.view.interactionState = saved.state
            // Put back as it was: no new visit (`navigated`).
            restoring.insert(id)
        } else if let opens {
            page.load(opens)
        }
        return page
    }

    /// The tab's address, if this app opens it. An address another device
    /// wrote is opened only when it is a web page: the desktop refuses
    /// addresses that may not leave a device (decision 1372), and an iPhone
    /// opens nothing but the web.
    static func openable(_ row: OutlineRow) -> URL? {
        guard let address = row.url, let url = URL(string: address),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme)
        else { return nil }
        return url
    }

    // MARK: Visits

    /// How the next page a tab loads was reached, when the user picked it
    /// in the Launcher or Favorites: Places' transition for its visit.
    @ObservationIgnored private var visitTransition: [String: UInt32] = [:]
    /// The tabs whose pages are being put back from their saved state,
    /// which is no visit.
    @ObservationIgnored private var restoring: Set<String> = []
    /// The visit each page last recorded, so its title can follow.
    @ObservationIgnored private var lastVisit: [String: (url: String, id: String, at: Date, title: String)] = [:]

    /// `isPrivate` is the page's own, fixed when it was made: a closing
    /// private tab leaves the session's ids while its page still reports,
    /// and asking the model then would call it the user's.
    private func navigated(tabId: String, url: URL, title: String, isPrivate: Bool, fromHistory: Bool) {
        if let opening = windowsOpening[tabId] {
            guard !opening.adding, AppModel.opensHere(url.absoluteString) else { return }
            addWindowTab(tabId, url: url)
            return
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

    private func refreshState() {
        let view = pages[currentTabId ?? ""]?.view
        canGoBack = view?.canGoBack ?? false
        canGoForward = view?.canGoForward ?? false
        loading = view?.isLoading ?? false
        progress = view?.estimatedProgress ?? 0
        currentTitle = view?.title
        pinOffSaved = currentTabId.flatMap { pin(for: $0) == nil ? nil : pages[$0] }?.offSaved ?? false
    }

    // MARK: Pins

    /// Whether the pin in front is off its saved page, which shows its
    /// Back button.
    private(set) var pinOffSaved = false

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
        let state = page.view.interactionState
        let first = model.children(of: workspace).first?.id
        guard let id = await model.addTab(to: workspace, url: url, before: first) else { return nil }
        if let state { offloaded[id] = (state, url.absoluteString) }
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
        if let page = pages[tab.id], let state = page.view.interactionState {
            offloaded[key] = (state, page.view.url?.absoluteString)
        }
        frontTabs[workspace] = key
    }

    private func pinPage(_ key: String, _ pin: PinRow) -> Page {
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
        if let restored = offloaded.removeValue(forKey: key) {
            page.view.interactionState = restored.state
            page.startsSaved(restored.address.flatMap(URL.init(string:)))
        } else if let saved {
            page.load(saved)
        }
        return page
    }

    /// The desktop's synced setting for where a pin's link to another site
    /// opens: in Quick Peek, which a phone opens as a new tab, or in the pin.
    static let pinLinksKey = "browser.sval.pins.quickPeekLinks"
}

/// One tab's live page, and what it reports back: where it went, so the tree
/// follows, and whether it can go back or forward.
@MainActor
final class Page: NSObject, WKNavigationDelegate {
    /// Whether this is a private tab's page, which keeps nothing on disk.
    let isPrivate: Bool
    /// The view's UI delegate, which the view holds weakly.
    private let panels: PagePanels
    /// Makes the page for a window this page opens, or nil to open none.
    var onNewWindow: (@MainActor (WKWebViewConfiguration, WKNavigationAction) -> WKWebView?)? {
        get { panels.onNewWindow }
        set { panels.onNewWindow = newValue }
    }
    /// Told when a load becomes a download, and whether the user asked for
    /// it: a tap WebKit counts (`WKDownload.isUserInitiated`), or a load
    /// Sval started, such as a typed address, which WebKit doesn't count.
    var onDownload: (@MainActor (WKDownload, Bool) -> Void)?
    /// Told when the page closes its own window.
    var onCloseWindow: (@MainActor () -> Void)? {
        get { panels.onClose }
        set { panels.onClose = newValue }
    }
    let view: WKWebView
    let tabId: String
    /// The video and audio choice the page was made for. WebKit fixes a
    /// page's playback rule when it is made, so a load of a site with
    /// another choice asks for a new page (`onMediaChoice`).
    let media: SiteRules.Media
    /// The choice a site's page needs, and what makes a page for `URL` in
    /// this one's place when it differs.
    var mediaChoice: (@MainActor (String?) -> SiteRules.Media)?
    var onRemake: (@MainActor (URL, String) -> Void)?
    /// Media allowed for a visit, from the bar's Allow Video and Audio. As
    /// a desktop visit does (decision 0132, `SvalSiteControls`'
    /// `onStateChange`), it covers every page of its site the tab loads,
    /// and the first top-level load of another site ends it, as does the
    /// first load after its grant would have expired. It saves nothing.
    struct Visit {
        let site: String
        let since: Date

        /// Whether the visit covers a top-level load of a page of `host`
        /// at `now`: one of its site's, before its grant would have
        /// expired.
        func covers(_ host: String, at now: Date) -> Bool {
            (SiteRules.site(of: host) ?? host) == site && now.timeIntervalSince(since) < Page.visitLength
        }
    }
    private(set) var visit: Visit?
    /// Told when the page's visit ends.
    var onVisitEnd: (@MainActor () -> Void)?
    /// How long a desktop visit's grant lasts
    /// (`privacy.temporary_permission_expire_time_ms`).
    nonisolated static let visitLength: TimeInterval = 60 * 60
    /// The choice the page's documents are guarded by: Always allow while
    /// a visit covers them, else the site's of its last top-level load.
    private(set) var guarding: SiteRules.Media
    private var guardScript: WKUserScript

    /// Why Sval holds the page's media suspended. WebKit then refuses every
    /// play in the page, in any frame or world, the user's own included,
    /// until the suspension is lifted (`setAllMediaPlaybackSuspended`), and
    /// gives iOS's Now Playing nothing of it
    /// (`HTMLMediaElement::isNowPlayingEligible`). The page can neither see
    /// nor end it. WebKit keeps it across the page's loads.
    enum Suspension: String, Comparable {
        /// The site's choice is Always deny (protections spec §4.1).
        case deny
        /// The user stopped the page's media in front, until they next
        /// touch the page or press a key in it, or play it from Sval's
        /// controls or load a page in it from Sval.
        case hold
        /// A private page while Sval isn't the app in front.
        case privacy

        static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
    }

    /// The reasons the page's media is suspended. WebKit counts its
    /// suspensions and ends one per call, so it is told once as the first
    /// reason comes and once as the last goes.
    struct Suspensions {
        private(set) var reasons: Set<Suspension> = []

        /// Adds `why`. Returns whether WebKit is to suspend the media: no
        /// reason held it before.
        mutating func add(_ why: Suspension) -> Bool {
            let first = reasons.isEmpty
            return reasons.insert(why).inserted && first
        }

        /// Takes away each of `gone`. Returns whether WebKit is to end its
        /// suspension: one of them held it and none is left.
        mutating func remove(_ gone: Set<Suspension>) -> Bool {
            guard !reasons.isDisjoint(with: gone) else { return false }
            reasons.subtract(gone)
            return reasons.isEmpty
        }
    }
    private var held = Suspensions()
    var suspensions: Set<Suspension> { held.reasons }

    /// Suspends the page's media for `why`, on top of any other reason.
    func suspend(_ why: Suspension) {
        guard held.add(why) else { return }
        // Paused first, in the same order to the web process: as a
        // suspension ends, WebKit plays again what was playing as it began
        // (`PlatformMediaSession::endInterruption`).
        view.pauseAllMediaPlayback(completionHandler: nil)
        view.setAllMediaPlaybackSuspended(true, completionHandler: nil)
    }

    /// Ends the suspension for each of `reasons`, and WebKit's once none is
    /// left.
    func lift(_ reasons: Set<Suspension>) {
        if held.remove(reasons) { view.setAllMediaPlaybackSuspended(false, completionHandler: nil) }
    }

    /// Told when the page tried to play and Ask first or Always deny
    /// refused it.
    var onBlocked: (@MainActor () -> Void)?
    /// What the page's guard can say (`mediaGuard`).
    static let refusalReasons: Set<String> = ["granted", "deny", "tap off the player", "no tap", "autoplay",
                                              "held", "hold ended"]
    /// Where the page's media events go, with the browser's state.
    var log: (@MainActor (String) -> Void)?
    /// What the page's guard said since its last load, logged once each.
    private var refusalsLogged: Set<String> = []

    fileprivate func mediaRefusal(_ why: String, mainFrame: Bool) {
        // A refusal is logged once a load, as a page may retry in a loop; a
        // hold's work answers the user's own presses, so each is logged.
        if ["held", "hold ended"].contains(why) || refusalsLogged.insert(why).inserted {
            let what = switch why {
            case "granted": "a tap on the player allowed media"
            case "held": "a play was paused by Sval's hold"
            case "hold ended": "a play in the system player ended Sval's hold"
            default: "refused, \(why)"
            }
            log?("\(what) (\(guarding.words), \(mainFrame ? "top frame" : "a frame"))")
        }
        switch why {
        case "granted": onGranted?()
        case "held", "hold ended": break
        default: onBlocked?()
        }
    }
    /// Told when a tap on the page's player was taken as consent.
    var onGranted: (@MainActor () -> Void)?
    /// Told when the page commits a new document.
    var onLoad: (@MainActor () -> Void)?
    /// Whether the user has typed into the page since it last navigated.
    private(set) var typedInto = false
    /// Whether a load may run JavaScript.
    private let scriptAllowed: @MainActor (WKNavigationAction, WKWebView) -> Bool
    private var observations: [NSKeyValueObservation] = []
    private var pending: Task<Void, Never>?
    private var onScroll: (@MainActor (String, ScrollReport) -> Void)?

    /// How long a page's address and title must hold before the tree records
    /// them: a load passes through redirects and changes its title as it goes.
    static let settle: Duration = .seconds(1)

    init(
        tabId: String,
        media: SiteRules.Media,
        visit: Visit? = nil,
        reportsTouch: Bool = false,
        privateStore: WKWebsiteDataStore? = nil,
        configuration given: WKWebViewConfiguration? = nil,
        scriptAllowed: @escaping @MainActor (WKNavigationAction, WKWebView) -> Bool,
        onNavigate: @escaping @MainActor (String, URL, String, Bool, Bool) -> Void,
        onState: @escaping @MainActor () -> Void,
        onScroll: @escaping @MainActor (String, ScrollReport) -> Void
    ) {
        self.tabId = tabId
        self.media = media
        self.visit = visit
        self.scriptAllowed = scriptAllowed
        let configuration = given ?? WKWebViewConfiguration()
        // WebKit's configuration for a new window is a copy of the opener's,
        // which shares its content controller (`API::PageConfiguration::copy`),
        // and a handler added twice to one controller raises. The page gets
        // a controller of its own: WebKit checks only that the view is
        // related to its opener (`UIDelegate::UIClient::createNewPage`).
        if given != nil {
            configuration.userContentController = WKUserContentController()
            configuration.mediaTypesRequiringUserActionForPlayback =
                WKWebViewConfiguration().mediaTypesRequiringUserActionForPlayback
        }
        // A private tab keeps cookies, cache and site storage in the
        // session's store, in memory, which WebKit writes nowhere.
        isPrivate = privateStore != nil
        panels = isPrivate ? PrivatePagePanels() : PagePanels()
        if let privateStore { configuration.websiteDataStore = privateStore }
        configuration.allowsInlineMediaPlayback = true
        // A pinch zooms any page, whatever its viewport allows (decision
        // 12).
        configuration.ignoresViewportScaleLimits = true
        // Media plays by itself only where the site's choice is Always allow
        // (protections spec §4.1). Ask first plays on a tap, as the
        // desktop's press does, and Always deny refuses that too
        // (`mediaGuard`).
        if media != .allow { configuration.mediaTypesRequiringUserActionForPlayback = .all }
        guarding = media
        guardScript = Self.guardScript(media)
        configuration.userContentController.addUserScript(guardScript)
        // Safari's own ending to the user agent WebKit builds, so sites see
        // Safari: without it they see an in-app web view, which some treat
        // differently (YouTube takes its video out of Picture-in-Picture),
        // and one more way to tell this browser's users apart.
        configuration.applicationNameForUserAgent = Self.safariApplicationName
        // Any frame the user types into says so, once, every frame says
        // when its media starts or stops, with nothing about what it is,
        // and when the user touches it or presses a key.
        configuration.userContentController.addUserScript(WKUserScript(
            source: Self.reportTyping + Self.reportPlayback + Self.reportPressed, injectionTime: .atDocumentStart,
            forMainFrameOnly: false, in: .defaultClient))
        // With the developer's launch option, every frame reports what its
        // media and scripts do, for the device's console. Never otherwise:
        // the reports name a page's elements and quote its errors.
        // A pin's page says when the user first touches it, which fixes its
        // saved page (pins spec §5).
        if reportsTouch {
            configuration.userContentController.addUserScript(WKUserScript(
                source: Self.reportTouch, injectionTime: .atDocumentStart,
                forMainFrameOnly: false, in: .defaultClient))
        }
        // A private page's icon is never learned: the icon cache is on disk.
        if !isPrivate {
            configuration.userContentController.addUserScript(WKUserScript(
                source: SiteIcons.reportIcon, injectionTime: .atDocumentEnd,
                forMainFrameOnly: true, in: .defaultClient))
        }
        configuration.userContentController.addUserScript(WKUserScript(
            source: Self.keepPictureInPicture, injectionTime: .atDocumentStart,
            forMainFrameOnly: false, in: .page))
        configuration.userContentController.addUserScript(WKUserScript(
            source: Self.slowFailedFetch, injectionTime: .atDocumentStart,
            forMainFrameOnly: false, in: .page))
        configuration.userContentController.addUserScript(WKUserScript(
            source: BackgroundAudio.visibilityGuard, injectionTime: .atDocumentStart,
            forMainFrameOnly: true, in: .page))
        if Self.pageDiagnostics {
            configuration.userContentController.addUserScript(WKUserScript(
                source: Self.reportMedia, injectionTime: .atDocumentStart,
                forMainFrameOnly: false, in: .defaultClient))
            // The page's own calls that change how its video is shown, which
            // only a script in the page's world sees.
            configuration.userContentController.addUserScript(WKUserScript(
                source: Self.reportModeCalls, injectionTime: .atDocumentStart,
                forMainFrameOnly: false, in: .page))
        }
        view = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        configuration.userContentController.add(
            TypingReport(page: self), contentWorld: .defaultClient, name: Self.typingMessage)
        configuration.userContentController.add(
            PlaybackReport(page: self), contentWorld: .defaultClient, name: Self.playbackMessage)
        configuration.userContentController.add(
            PressedReport(page: self), contentWorld: .defaultClient, name: Self.pressedMessage)
        configuration.userContentController.add(
            BlockedReport(page: self), contentWorld: .page, name: Self.blockedMessage)
        if !isPrivate {
            configuration.userContentController.add(
                IconReport(), contentWorld: .defaultClient, name: SiteIcons.message)
        }
        if reportsTouch {
            configuration.userContentController.add(
                TouchReport(page: self), contentWorld: .defaultClient, name: Self.touchMessage)
        }
        if Self.pageDiagnostics {
            configuration.userContentController.add(
                MediaReport(), contentWorld: .defaultClient, name: Self.mediaMessage)
            configuration.userContentController.add(
                MediaReport(), contentWorld: .page, name: Self.mediaMessage)
        }
        view.navigationDelegate = self
        view.uiDelegate = panels
        view.allowsBackForwardNavigationGestures = true
        // The guard in the page's world can be got round, by a frame WebKit
        // gives no user script or by media no event reports, so Always deny
        // is WebKit's to enforce.
        if media == .block { suspend(.deny) }
        let changed: @MainActor () -> Void = { [weak self] in
            guard let self else { return }
            onState()
            pending?.cancel()
            pending = Task { [weak self] in
                try? await Task.sleep(for: Self.settle)
                guard !Task.isCancelled, let self, let url = view.url else { return }
                onNavigate(self.tabId, url, view.title ?? "", self.isPrivate, self.cameFromHistory(url))
            }
        }
        observations.append(view.observe(\.url) { _, _ in
            MainActor.assumeIsolated { changed() }
        })
        observations.append(view.observe(\.title) { _, _ in
            MainActor.assumeIsolated { changed() }
        })
        if Self.pageDiagnostics {
            observations.append(view.observe(\.fullscreenState) { view, _ in
                MainActor.assumeIsolated {
                    Diagnostics.log("page: full-screen state \(view.fullscreenState.rawValue)")
                }
            })
        }
        for path in [\WKWebView.canGoBack, \WKWebView.canGoForward, \WKWebView.isLoading] {
            observations.append(view.observe(path) { _, _ in
                MainActor.assumeIsolated { onState() }
            })
        }
        observations.append(view.observe(\.estimatedProgress) { _, _ in
            MainActor.assumeIsolated { onState() }
        })
        // The bar folds as the user scrolls down and comes back as they
        // scroll up or reach the end (`Browser.pageScrolled`). Offsets the
        // page sets itself, as a load or an anchor does, are left alone.
        observations.append(view.scrollView.observe(\.contentOffset, options: [.old, .new]) { [tabId] scroll, change in
            MainActor.assumeIsolated {
                guard scroll.isTracking || scroll.isDecelerating,
                      let old = change.oldValue?.y, let new = change.newValue?.y, new != old else { return }
                let end = scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height
                let top = -scroll.adjustedContentInset.top
                onScroll(tabId, new >= end - 1 ? .atEnd
                    : .moved(by: new - old, atTop: new <= top, held: scroll.isTracking))
            }
        })
        self.onScroll = onScroll
        // The bar floats over the page's foot: the 48pt capsules 24pt above
        // the screen's edge. WebKit keeps fixed and sticky elements clear
        // of it.
        view.obscuredContentInsets = UIEdgeInsets(top: 0, left: 0, bottom: Browser.barRoom, right: 0)
        view.scrollView.panGestureRecognizer.addTarget(self, action: #selector(panned(_:)))
    }

    /// A finger on the page, or lifted from it, which the bar's fold
    /// needs beside the offsets: a held finger keeps a part-folded bar
    /// where it is.
    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began: onScroll?(tabId, .touched)
        case .ended, .cancelled, .failed: onScroll?(tabId, .released)
        default: break
        }
    }

    /// Whether a load Sval started is under way in the top frame, until it
    /// commits or fails.
    private var appLoading = false

    /// Loads `url` for Sval: from the user's address, a tab's or a pin's.
    func load(_ url: URL) {
        appLoading = true
        lift([.hold])
        view.load(URLRequest(url: url))
    }

    /// A load takes its site's JavaScript rule. WebKit applies the top
    /// document's to the whole page, frames included, so the script rules
    /// (`ContentBlocker.Rules.scripts`) carry each frame's own site's rule
    /// to the scripts the frame loads. A changed rule reaches a page at its
    /// next load.
    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        preferences.allowsContentJavaScript = scriptAllowed(navigationAction, webView)
        // `<a download>` and a blob or data link marked to save.
        if navigationAction.shouldPerformDownload {
            if appLoading, navigationAction.targetFrame?.isMainFrame == true, navigationAction.navigationType == .other,
               let url = navigationAction.request.url {
                askedDownloads.insert(url)
            }
            decisionHandler(.download, preferences)
            return
        }
        // A link the user follows from a pin to another site leaves the pin,
        // so its icon always says what is behind it (pins spec §5). The
        // pin's own redirects, a login bounce, stay.
        if let rules = pinRules, navigationAction.navigationType == .linkActivated,
           navigationAction.targetFrame?.isMainFrame ?? true,
           let url = navigationAction.request.url, let host = url.host(),
           (SiteRules.site(of: host) ?? host) != rules.site, rules.leaveLinks() {
            decisionHandler(.cancel, preferences)
            rules.onLeave(url)
            return
        }
        // The rules go in before the document is asked for, so its own
        // requests and everything it loads take its site's protections.
        if navigationAction.targetFrame?.isMainFrame == true, let host = navigationAction.request.url?.host(),
           let on = protectionsOn?(host), on != protected {
            protected = on
            installRules()
        }
        // Only this page's own top frame: a load for a new window has no
        // target frame, and any other scheme is WebKit's to handle.
        guard navigationAction.targetFrame?.isMainFrame == true, let url = navigationAction.request.url,
              let host = url.host(), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let choice = mediaChoice?(host) else {
            decisionHandler(isPrivate ? Self.allowWithoutAppLink : .allow, preferences)
            return
        }
        var covered = false
        if let visit {
            covered = visit.covers(host, at: .now)
            if !covered { endVisit() }
        }
        switch Self.mediaLoad(navigationAction.navigationType, appLoading: appLoading,
                              method: navigationAction.request.httpMethod, covered: covered, choice: choice,
                              madeFor: media, canRemake: onRemake != nil) {
        case .remake:
            decisionHandler(.cancel, preferences)
            onRemake?(url, "a load needs \(choice.words)")
            return
        case .keep(let guarding):
            guardDocuments(guarding)
        }
        decisionHandler(isPrivate ? Self.allowWithoutAppLink : .allow, preferences)
    }

    /// What a top-level load does with the page, whose video and audio
    /// choice is `media`, for a site whose choice is `choice`.
    enum MediaLoad: Equatable {
        /// A new page made for the site's choice, in this one's place.
        case remake
        /// The page kept, its documents guarded by the choice given.
        case keep(SiteRules.Media)
    }

    /// A page of a site with another video and audio choice is made for it
    /// when the user asked for it: a link they followed, or Sval's own
    /// load. A load the page's script starts would be sent as the user's
    /// own, with the user's cookies for the site, so it keeps the page, as
    /// a reload, Back and Forward do, which a new page would turn into a
    /// new visit. A page kept is guarded by the site's choice, or by Always
    /// allow while a visit covers the load.
    static func mediaLoad(_ type: WKNavigationType, appLoading: Bool, method: String?, covered: Bool,
                          choice: SiteRules.Media, madeFor media: SiteRules.Media, canRemake: Bool) -> MediaLoad {
        let asked = type == .linkActivated || (appLoading && type == .other)
        if asked, method ?? "GET" == "GET", canRemake, !covered, choice != media { return .remake }
        return .keep(covered ? .allow : choice)
    }

    /// WebKit's `_WKNavigationActionPolicyAllowWithoutTryingAppLink`
    /// (`WKNavigationDelegatePrivate.h`, `WKNavigationActionPolicyAllow + 2`):
    /// a load that stays in the page, where `.allow` lets a universal link
    /// open its app. A private tab keeps its links inside Sval, so no other
    /// app learns what it opened. It is private API; removing it leaves
    /// private links opening apps as normal tabs do.
    private static let allowWithoutAppLink =
        WKNavigationActionPolicy(rawValue: WKNavigationActionPolicy.allow.rawValue + 2) ?? .allow

    /// What makes a page a pin's: its saved address's site, whether a link
    /// to another site leaves it, and where such a link goes.
    struct PinRules {
        let site: String
        let leaveLinks: @MainActor () -> Bool
        let onLeave: @MainActor (URL) -> Void
    }

    var pinRules: PinRules?

    /// A pin's saved page: where its saved address landed, redirects
    /// included, before the user first touched or typed in it (pins spec
    /// §5). What "off its saved page" compares against.
    private(set) var savedPage: URL?
    private var touched = false

    var offSaved: Bool {
        guard let savedPage, let url = view.url else { return false }
        return url != savedPage
    }

    /// Loads the pin's saved address afresh; where it lands is the saved
    /// page again.
    func returnToSaved(_ address: URL) {
        touched = false
        typedInto = false
        savedPage = nil
        ended = false
        load(address)
    }

    /// For a page handed over as it was: its saved page is where it is.
    func startsSaved(_ url: URL?) {
        touched = true
        savedPage = url
    }

    func noteTouch() {
        touched = true
    }

    private static let touchMessage = "svalTouched"
    private static let reportTouch = """
        addEventListener("pointerdown", function report(event) {
          if (!event.isTrusted) return;
          removeEventListener("pointerdown", report, true);
          webkit.messageHandlers.svalTouched.postMessage(1);
        }, true);
        """

    /// In the page's own world, in every frame (protections spec §4.1):
    /// - On Ask first (`ask`), media plays only from a tap on the player: a
    ///   play made while a tap's activation lasts, where the tap landed in
    ///   the media's box, or on a button when the media has none (audio).
    ///   VoiceOver's double tap and a key press count as a tap on the
    ///   element they press.
    ///   A phone counts every touch as a gesture, so any other tap would
    ///   start media the user never asked for. A refused play is stopped
    ///   before it starts, so it never shows as playing. WebKit's own rule
    ///   lets some through, muted video among them. A tap that plays is
    ///   consent for the rest of the page, as the desktop's press is.
    /// - On Always deny, nothing plays, a tap included.
    /// - Either way a refusal is reported, as is media marked to play by
    ///   itself that stays paused.
    /// - Media paused from Sval's controls stays paused until the user
    ///   next clicks or presses a key in the page, so a site can't start it
    ///   again as the user scrolls (`MediaInfo.hold`).
    static func mediaGuard(deny: Bool, ask: Bool) -> String {
        """
        (() => {
          const deny = \(deny), ask = \(ask);
          let granted = false;
          let touch = null;
          // A press reaches the page as a pointer, or from VoiceOver and a
          // keyboard as a click or key with no pointer, which is taken at
          // the middle of the element it lands on.
          const note = event => {
            if (!event.isTrusted) return;
            const target = event.target;
            if (event.type === "pointerdown" || (event.type === "click" && event.detail > 0)) {
              touch = { x: event.clientX, y: event.clientY, target };
              return;
            }
            const box = target instanceof Element ? target.getBoundingClientRect() : null;
            touch = box ? { x: box.left + box.width / 2, y: box.top + box.height / 2, target } : null;
          };
          for (const type of ["pointerdown", "click", "keydown"]) window.addEventListener(type, note, true);
          const tapped = () => !!(navigator.userActivation && navigator.userActivation.isActive);
          // Whether the last tap was on `media`'s player: in its box, or
          // in the smallest element holding both it and the tap, when that
          // is a player rather than most of the page (YouTube draws its play
          // button outside the video's box). Media with no box counts a tap
          // on a button.
          const inside = box => touch.x >= box.left && touch.x <= box.right
            && touch.y >= box.top && touch.y <= box.bottom;
          const onPlayer = media => {
            if (!touch) return false;
            const box = media.getBoundingClientRect();
            const target = touch.target instanceof Element ? touch.target : null;
            if (!(box.width > 0 && box.height > 0)) {
              return !!(target && target.closest("button, [role=button]"));
            }
            if (inside(box)) return true;
            let shared = media.parentElement;
            while (shared && target && !shared.contains(target)) shared = shared.parentElement;
            if (!shared || shared === document.body || shared === document.documentElement) return false;
            const around = shared.getBoundingClientRect();
            return inside(around) && around.width * around.height < innerWidth * innerHeight * 0.8;
          };
          // Says what was refused, or that a tap on the player was taken
          // as consent, with nothing about the page.
          const report = why => {
            try { window.webkit.messageHandlers.\(blockedMessage).postMessage(why); } catch (e) {}
          };
          const held = () => {
            try { return window.top.document.documentElement.hasAttribute("\(MediaInfo.hold)"); }
            catch (e) { return false; }
          };
          // Whether `media` may play now; a refusal is reported.
          const allowed = media => {
            if (!deny && (!ask || granted)) return true;
            const tap = tapped();
            if (!deny && tap && onPlayer(media)) { granted = true; report("granted"); return true; }
            report(deny ? "deny" : tap ? "tap off the player" : "no tap");
            return false;
          };
          const refused = () => Promise.reject(new DOMException("Media is blocked on this site.", "NotAllowedError"));
          // Media the page itself asked to play, which its "play" event
          // must not take for the system player's press.
          const scripted = new WeakSet();
          const play = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play = function () {
            if (!allowed(this)) return refused();
            scripted.add(this);
            return play.apply(this, arguments);
          };
          // A play in the system's own player, Picture in Picture or full
          // screen, that the page didn't ask for is the user's press on it,
          // which ends a hold.
          const inSystemPlayer = media => document.pictureInPictureElement === media
            || (media.webkitPresentationMode && media.webkitPresentationMode !== "inline");
          document.addEventListener("play", event => {
            const media = event.target;
            if (!(media instanceof HTMLMediaElement)) return;
            const byPage = scripted.delete(media);
            if (inSystemPlayer(media) && !byPage && !deny) {
              if (held()) report("hold ended");
              try { window.top.document.documentElement.removeAttribute("\(MediaInfo.hold)"); } catch (e) {}
              return;
            }
            if (held()) { report("held"); media.pause(); return; }
            if (!allowed(media)) media.pause();
          }, true);
          for (const type of ["click", "keydown"]) {
            window.addEventListener(type, () => {
              try { window.top.document.documentElement.removeAttribute("\(MediaInfo.hold)"); } catch (e) {}
            }, true);
          }
          if (deny) {
            for (const Context of [window.AudioContext, window.webkitAudioContext]) {
              if (Context) Context.prototype.resume = refused;
            }
          }
          if (!ask && !deny) return;
          // iOS loads no media before a tap, so no media event says that
          // one marked to play by itself didn't: it is looked for once the
          // page has had a moment to start it.
          // Sval acts on the first report alone, so the watch ends with it.
          let waiting = false;
          const watch = new MutationObserver(() => check());
          const check = () => {
            if (waiting || granted) return;
            waiting = true;
            setTimeout(() => {
              waiting = false;
              for (const media of document.querySelectorAll("video[autoplay], audio[autoplay]")) {
                if (media.paused) { report("autoplay"); watch.disconnect(); return; }
              }
            }, 1000);
          };
          if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", check);
          else check();
          watch.observe(document, { childList: true, subtree: true });
        })();
        """
    }

    /// A video already in Picture-in-Picture isn't full screen, so a page's
    /// call to leave full screen leaves it be. WebKit takes the call as
    /// leaving Picture-in-Picture as well, and YouTube's player makes it as
    /// soon as its video moves from full screen into Picture-in-Picture, so
    /// the video snapped straight back into the page. A page ends
    /// Picture-in-Picture with the calls made for it, which are untouched.
    private static let keepPictureInPicture = """
        (() => {
          const exit = HTMLVideoElement.prototype.webkitExitFullscreen;
          if (typeof exit !== "function") return;
          HTMLVideoElement.prototype.webkitExitFullscreen = function () {
            if (this.webkitPresentationMode === "picture-in-picture") return;
            return exit.apply(this, arguments);
          };
        })();
        """

    /// A failed fetch rejects no sooner than 50 ms after the call. WebKit
    /// rejects a request its content rules block within a millisecond, and
    /// some sites race on that: Figma's sign-in never draws when its
    /// blocked report fails that fast. 50 ms held for Figma with every list
    /// on, and 20 ms did not. A real network failure takes longer, and a
    /// fetch that answers is untouched. A proxy keeps `fetch` a native
    /// function to the page.
    static let slowFailedFetch = """
        (() => {
          const least = 50;
          window.fetch = new Proxy(window.fetch, {
            apply(target, self, args) {
              const start = performance.now();
              return Reflect.apply(target, self, args).catch(error => new Promise((_, reject) => {
                setTimeout(() => reject(error), Math.max(0, least - (performance.now() - start)));
              }));
            },
          });
        })();
        """

    private static let pressedMessage = "svalPressed"
    /// A touch or key press of the user's own in any frame, which ends a
    /// hold (`Suspension.hold`). A touch lifts it as it lands, so the
    /// tap's click finds the media free to play.
    private static let reportPressed = """
        for (const type of ["pointerdown", "keydown"]) {
          addEventListener(type, event => {
            if (event.isTrusted) webkit.messageHandlers.svalPressed.postMessage(1);
          }, true);
        }
        """

    fileprivate func notePressed() {
        guard suspensions.contains(.hold) else { return }
        lift([.hold])
        log?("a touch in the page ended Sval's hold")
    }

    private static let typingMessage = "svalTyped"
    private static let playbackMessage = "svalPlayback"
    static let blockedMessage = "svalMediaBlocked"
    /// Each frame says, on every change, whether any of its media plays,
    /// whether all of that is muted, and whether a tap started it
    /// (`userActivation`), which tells the user's play from a player
    /// starting itself. WebKit's own `requestMediaPlaybackState` can't say
    /// this: it answers "paused" while any of a page's media is paused
    /// (`MediaSessionManagerInterface::mediaPlaybackIsPaused`), which a page
    /// with a second, paused player, as YouTube's has, always is.
    private static let reportPlayback = """
        (() => {
          const frame = Math.random().toString(36).slice(2);
          // Media the frame has seen, held weakly; `seen` keeps each in
          // `known` once, as every event of the media passes here.
          const known = new Set();
          const seen = new WeakSet();
          // Whether each media element is drawn on the screen, as an
          // IntersectionObserver with the top-level viewport as its root
          // sees it: a frame under a `display: none` parent, or media off
          // the screen or a couple of pixels in size, is not. Media not yet
          // measured counts as shown.
          const shown = new WeakMap();
          const watch = new IntersectionObserver(entries => {
            for (const entry of entries) {
              const box = entry.boundingClientRect;
              shown.set(entry.target, entry.isIntersecting && box.width * box.height > 4);
            }
            report(false, false);
          });
          const keep = m => {
            if (seen.has(m)) return;
            seen.add(m);
            known.add(new WeakRef(m));
            watch.observe(m);
          };
          let last = null;
          const report = (gesture, force) => {
            for (const ref of known) if (!ref.deref()) known.delete(ref);
            const all = [...document.querySelectorAll("audio, video"), ...[...known].map(r => r.deref())];
            const live = all.filter(m => m && !m.paused && !m.ended);
            live.forEach(keep);
            const playing = live.length > 0;
            const silent = m => m.muted || m.volume === 0;
            const muted = playing && live.every(silent);
            // Media nobody can see or hear: every playing element is
            // silent and not drawn on the screen.
            const unseen = muted && live.every(m => shown.get(m) === false);
            const pip = !!document.pictureInPictureElement
              || all.some(m => m && m.webkitPresentationMode === "picture-in-picture");
            const state = playing + "/" + muted + "/" + unseen + "/" + pip;
            if (state === last && !force) return;
            last = state;
            webkit.messageHandlers.svalPlayback.postMessage({ frame, playing, muted, unseen, gesture, pip });
          };
          for (const type of ["playing", "pause", "ended", "emptied", "volumechange",
                              "enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged"]) {
            document.addEventListener(type, event => {
              const m = event.target;
              if (!(m instanceof HTMLMediaElement)) return;
              keep(m);
              if (type === "playing") window.__svalMedia = new WeakRef(m);
              const gesture = type === "playing" && !!(navigator.userActivation && navigator.userActivation.isActive);
              report(gesture, gesture);
            }, true);
          }
          addEventListener("pagehide", () => {
            if (last && last.startsWith("true")) {
              last = "false/false/false/false";
              webkit.messageHandlers.svalPlayback.postMessage({ frame, playing: false, muted: false, unseen: false, gesture: false, pip: false });
            }
          });
        })();
        """

    /// The page's frames with media playing; cleared when the page goes to
    /// another document.
    private var playingFrames = PlayingFrames()

    /// Told whether the page's media plays and whether it's all muted, when
    /// either changes or a tap starts it.
    var onMedia: (@MainActor (String, Bool, Bool, Bool) -> Void)?

    /// The page's frames with a video in Picture in Picture.
    private var pipFrames: Set<String> = []
    /// Whether a video of the page is in Picture in Picture, whose window
    /// closes if the page is let go.
    var inPictureInPicture: Bool { !pipFrames.isEmpty }
    /// Told when the page's video goes into or out of Picture in Picture.
    var onPictureInPicture: (@MainActor () -> Void)?

    fileprivate func mediaReport(frame: String, playing: Bool, muted: Bool, unseen: Bool, gesture: Bool, pip: Bool,
                                 mainFrame: Bool) {
        log?("\(mainFrame ? "top frame" : "frame") \(frame.prefix(4)) says \(playing ? "playing" : "silent")"
             + (muted ? ", muted" : "") + (unseen ? ", off the screen" : "") + (pip ? ", Picture in Picture" : "")
             + (gesture ? ", after a tap" : ""))
        let wasPiP = inPictureInPicture
        if pip { pipFrames.insert(frame) } else { pipFrames.remove(frame) }
        if inPictureInPicture != wasPiP { onPictureInPicture?() }
        let changed = playingFrames.report(frame, playing: playing, muted: muted, unseen: unseen)
        if changed || gesture {
            onMedia?(tabId, playingFrames.perceived, playingFrames.perceived && playingFrames.allMuted, gesture)
        }
    }

    static func describe(_ state: WKMediaPlaybackState) -> String {
        switch state {
        case .none: "none"
        case .playing: "playing"
        case .paused: "paused"
        case .suspended: "suspended"
        @unknown default: "unknown"
        }
    }

    private static let reportTyping = """
        addEventListener("input", function report(event) {
          if (!event.isTrusted) return;
          removeEventListener("input", report, true);
          webkit.messageHandlers.svalTyped.postMessage(1);
        }, true);
        """

    static let pageDiagnostics = LaunchOption.given("-svalPageDiagnostics")

    /// What Safari on this iOS adds after WebKit's part of its user agent.
    static let safariApplicationName: String = {
        let version = UIDevice.current.systemVersion.split(separator: ".").prefix(2).joined(separator: ".")
        return "Version/\(version) Mobile/15E148 Safari/604.1"
    }()
    private static let reportModeCalls = """
        (() => {
          const send = fields => window.webkit?.messageHandlers?.svalMedia?.postMessage({ world: "page", ...fields });
          const wrap = (target, name) => {
            const original = target?.[name];
            if (typeof original !== "function") return;
            target[name] = function (...args) {
              send({ event: "call:" + name, mode: String(args[0] ?? "") });
              return original.apply(this, args);
            };
          };
          wrap(HTMLVideoElement.prototype, "webkitSetPresentationMode");
          wrap(HTMLVideoElement.prototype, "requestPictureInPicture");
          wrap(HTMLVideoElement.prototype, "webkitExitFullscreen");
          wrap(HTMLVideoElement.prototype, "webkitEnterFullscreen");
          wrap(Document.prototype, "exitPictureInPicture");
          wrap(Document.prototype, "exitFullscreen");
          wrap(Document.prototype, "webkitExitFullscreen");
        })();
        """
    private static let mediaMessage = "svalMedia"
    /// Each media element's events, and the frame's script errors and blocked
    /// loads, without an address: one is replaced with `<address>`.
    private static let reportMedia = """
        (() => {
          const frame = window === window.top ? "main" : "frame";
          const send = fields => webkit.messageHandlers.svalMedia.postMessage({ frame, ...fields });
          const scrub = text => String(text ?? "").replace(/[a-z]+:\\/\\/\\S+/gi, "<address>").slice(0, 160);
          if (frame === "main") send({ event: "user-agent", detail: navigator.userAgent });
          for (const type of ["play", "playing", "pause", "waiting", "stalled", "error", "abort", "emptied"]) {
            document.addEventListener(type, event => {
              const media = event.target;
              if (!(media instanceof HTMLMediaElement)) return;
              send({ event: type, kind: media.tagName.toLowerCase(), code: media.error?.code ?? 0,
                     network: media.networkState, ready: media.readyState,
                     visibility: document.visibilityState });
              if (type === "playing") {
                // The video and the elements around it, with their sizes, to
                // see what keeps a playing video out of sight.
                const chain = [];
                for (let node = media; node instanceof Element && chain.length < 8; node = node.parentElement) {
                  const style = getComputedStyle(node);
                  const box = node.getBoundingClientRect();
                  chain.push(node.tagName.toLowerCase() + (node.id ? "#" + node.id : "") +
                    [...node.classList].slice(0, 3).map(name => "." + name).join("") +
                    "[" + Math.round(box.width) + "x" + Math.round(box.height) + " " + style.display +
                    (style.visibility === "visible" ? "" : " " + style.visibility) + "]");
                }
                send({ event: "media-layout", chain: chain.join(" < ") });
              }
            }, true);
          }
          for (const type of ["enterpictureinpicture", "leavepictureinpicture", "webkitpresentationmodechanged",
                              "webkitbeginfullscreen", "webkitendfullscreen", "fullscreenchange", "webkitfullscreenchange"]) {
            document.addEventListener(type, event => {
              const target = event.target;
              send({ event: type, kind: target?.tagName?.toLowerCase() ?? "?",
                     mode: target?.webkitPresentationMode ?? "", visibility: document.visibilityState });
            }, true);
          }
          addEventListener("error", event => {
            if (event.target instanceof HTMLMediaElement || event.target instanceof HTMLSourceElement) return;
            send({ event: "script-error", detail: scrub(event.message || event.target?.tagName) });
          }, true);
          addEventListener("unhandledrejection", event => {
            send({ event: "unhandled-rejection", detail: scrub(event.reason?.name + ": " + event.reason?.message) });
          });
          addEventListener("securitypolicyviolation", event => {
            send({ event: "csp-violation", detail: event.effectiveDirective });
          });
        })();
        """

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Diagnostics.log("page: a load failed: \(Diagnostics.name(error))")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        appLoading = false
        Diagnostics.log("page: a load failed to start: \(Diagnostics.name(error))")
    }

    /// iOS ends a page's web process under memory pressure, which leaves
    /// the page blank. The page in front loads again at once, and any other
    /// once it is shown (`Browser.select`), as Safari does.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ended = true
        // The process took the page's frames and their media with it, and
        // no frame is left to say so.
        typedInto = false
        mediaFrames.removeAll()
        if !pipFrames.isEmpty {
            pipFrames.removeAll()
            onPictureInPicture?()
        }
        if !playingFrames.isEmpty {
            playingFrames = PlayingFrames()
            onMedia?(tabId, false, false, false)
        }
        let shown = webView.window != nil && webView.isUserInteractionEnabled
        Diagnostics.log("page: the web content process ended\(shown ? ", loading it again" : "")")
        if shown { reloadIfEnded() }
    }

    /// Whether the page's web process ended since it last loaded.
    private(set) var ended = false

    /// Loads the page again if its web process ended, from its own address
    /// or else the tab's.
    func reloadIfEnded(fallback: URL? = nil) {
        guard ended else { return }
        ended = false
        if view.url != nil {
            view.reload()
        } else if let fallback {
            load(fallback)
        }
    }

    private func endVisit() {
        visit = nil
        onVisitEnd?()
    }

    /// Guards the documents the page loads from here by `choice`. The
    /// page's configuration keeps the choice it was made for, so Always
    /// deny is held by WebKit's suspension from the next document's
    /// commit, and a choice that allows lifts it then.
    private func guardDocuments(_ choice: SiteRules.Media) {
        guard choice != guarding else { return }
        log?("guarded by \(choice.words) from the next document, made for \(media.words)")
        let controller = view.configuration.userContentController
        let others = controller.userScripts.filter { $0 !== guardScript }
        controller.removeAllUserScripts()
        guarding = choice
        guardScript = Self.guardScript(choice)
        for script in [guardScript] + others { controller.addUserScript(script) }
    }

    private static func guardScript(_ choice: SiteRules.Media) -> WKUserScript {
        WKUserScript(source: mediaGuard(deny: choice == .block, ask: choice == .ask),
                     injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page)
    }

    /// A page that named no icon its document could show by the time it
    /// was parsed may have added one since. A page on screen gives the
    /// grid its picture once loaded, a second on so its images have drawn;
    /// a page off screen has drawn nothing new to take.
    /// A response WebKit can't show, or one the site sends as an attachment,
    /// is downloaded. A PDF, which WebKit shows, stays in the tab.
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?
            .value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
        let attachment = disposition.hasPrefix("attachment")
        let downloads = !navigationResponse.canShowMIMEType || attachment
        if downloads, appLoading, navigationResponse.isForMainFrame, let url = navigationResponse.response.url {
            askedDownloads.insert(url)
        }
        decisionHandler(downloads ? .download : .allow)
    }

    /// The addresses of Sval's own top-frame loads turned into downloads,
    /// taken as the decision is made: WebKit fails the load before it hands
    /// over the download, which ends `appLoading`. Each is used once, by
    /// the download of that same address.
    private var askedDownloads: Set<URL> = []

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        let asked = navigationAction.request.url.map { askedDownloads.remove($0) != nil } ?? false
        onDownload?(download, download.isUserInitiated || asked)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        let asked = navigationResponse.response.url.map { askedDownloads.remove($0) != nil } ?? false
        onDownload?(download, download.isUserInitiated || asked)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if !isPrivate { SiteIcons.shared.learn(page: webView.url, named: nil) }
        if Browser.pinParts(tabId) == nil {
            Task { [tabId, isPrivate] in
                try? await Task.sleep(for: .seconds(1))
                guard webView.window != nil else { return }
                PagePreviews.shared.take(tabId, from: webView, isPrivate: isPrivate)
            }
        }
        if pinRules != nil, !touched, !typedInto {
            savedPage = webView.url
        }
    }

    /// The page's history entries it has stood at, with the address each
    /// had then.
    private var entriesSeen: [(entry: WKBackForwardListItem, url: String)] = []

    /// Whether the page reached `url` through Back or Forward: an entry with
    /// entries after it, or one it stood at before with that address. A new
    /// load drops the entries after the one it leaves, and a page's own
    /// `replaceState` changes its entry's address.
    fileprivate func cameFromHistory(_ url: URL) -> Bool {
        let list = view.backForwardList
        guard let current = list.currentItem else { return false }
        let fromHistory = !list.forwardList.isEmpty
            || entriesSeen.contains { $0.entry === current && $0.url == url.absoluteString }
        let kept = list.backList + [current] + list.forwardList
        entriesSeen = entriesSeen.filter { seen in seen.entry !== current && kept.contains { $0 === seen.entry } }
        entriesSeen.append((current, url.absoluteString))
        return fromHistory
    }

    /// A page typed into keeps that until it goes to another page.
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        appLoading = false
        webView.pageZoom = webView.url?.host().map { PageZoom.level(for: $0, isPrivate: isPrivate) } ?? 1
        if guarding == .block { suspend(.deny) } else { lift([.deny]) }
        typedInto = false
        refusalsLogged.removeAll()
        onLoad?()
        // The old document's frames are gone, with their media.
        mediaFrames.removeAll()
        if !pipFrames.isEmpty {
            pipFrames.removeAll()
            onPictureInPicture?()
        }
        if !playingFrames.isEmpty {
            playingFrames = PlayingFrames()
            onMedia?(tabId, false, false, false)
        }
    }

    /// Every frame of the document that has reported media, by its token,
    /// so a script can reach media in another site's frame.
    var mediaFrames: [String: WKFrameInfo] = [:]

    /// Runs `script` in the top frame and in every frame with media.
    func runInMediaFrames(_ script: String) {
        view.evaluateJavaScript(script, in: nil, in: .defaultClient)
        for frame in mediaFrames.values where !frame.isMainFrame {
            view.evaluateJavaScript(script, in: frame, in: .defaultClient)
        }
    }

    /// Whether the page has media playing, as its frames last said.
    var playing: Bool { !playingFrames.isEmpty }

    fileprivate func noteTyping() {
        typedInto = true
    }

    /// Whether letting the page go would lose something the user would miss:
    /// what they typed, sound they can hear, or a call.
    func mustStay() async -> Bool {
        if typedInto || view.cameraCaptureState != .none || view.microphoneCaptureState != .none {
            return true
        }
        return playing || inPictureInPicture
    }

    /// Blocks with `rules` in place of the rules the page had. A page applies
    /// them to what it loads next.
    func useRules(_ rules: ContentBlocker.Rules) {
        self.rules = rules
        installRules()
    }

    private var rules = ContentBlocker.Rules()
    /// Whether the site of the page's top document has protections on, and
    /// so blocks with the lists. As the desktop's allow list does, the top
    /// document's site decides for every frame (`SvalSiteProtections`).
    var protected = true
    /// Whether a page of the host given has protections on.
    var protectionsOn: (@MainActor (String) -> Bool)?

    private func installRules() {
        let controller = view.configuration.userContentController
        controller.removeAllContentRuleLists()
        rules.installed(protected: protected).forEach(controller.add)
    }

    deinit {
        Diagnostics.log("tabs: a page was freed")
    }

    func close() {
        view.pauseAllMediaPlayback()
        pending?.cancel()
        observations.removeAll()
        view.stopLoading()
        view.navigationDelegate = nil
        view.removeFromSuperview()
    }
}

/// A page's alert, confirm and prompt panels, as the system's alert over
/// whatever is in front, titled with the host of the frame that asked, so
/// it's clear a site wrote the text. Without a delegate WebKit answers
/// every panel as dismissed, and the page never shows it. A page out of
/// view gets the answer a dismissed panel gives.
class PagePanels: NSObject, WKUIDelegate {
    var onNewWindow: (@MainActor (WKWebViewConfiguration, WKNavigationAction) -> WKWebView?)?
    var onClose: (@MainActor () -> Void)?

    /// Without this method WebKit opens no page for a link with a target
    /// or a script's `window.open` (`UIDelegate::UIClient::createNewPage`).
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        onNewWindow?(configuration, navigationAction)
    }

    func webViewDidClose(_ webView: WKWebView) {
        onClose?()
    }

    private func present(_ alert: UIAlertController, over webView: WKWebView) -> Bool {
        var controller = webView.window?.rootViewController
        while let next = controller?.presentedViewController { controller = next }
        guard let controller, !(controller is UIAlertController) else { return false }
        controller.present(alert, animated: true)
        return true
    }

    private func alert(_ message: String, frame: WKFrameInfo) -> UIAlertController {
        UIAlertController(title: frame.request.url?.host() ?? frame.securityOrigin.host, message: message,
                          preferredStyle: .alert)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let panel = alert(message, frame: frame)
        panel.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        if !present(panel, over: webView) { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let panel = alert(message, frame: frame)
        panel.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        panel.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        if !present(panel, over: webView) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let panel = alert(prompt, frame: frame)
        panel.addTextField { $0.text = defaultText }
        panel.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        panel.addAction(UIAlertAction(title: "OK", style: .default) { [weak panel] _ in
            completionHandler(panel?.textFields?.first?.text ?? "")
        })
        if !present(panel, over: webView) { completionHandler(nil) }
    }
}

/// A private page's panels, and its link menu without the preview. WebKit
/// builds a web link's preview outside the page, through Data Detectors
/// (`continueContextMenuInteractionWithDataDetectors`), and turning
/// `allowsLinkPreview` off takes the whole menu away
/// (`WKContentView._registerPreview`). A menu given here keeps WebKit's
/// own items, which it puts in place of the suggested actions
/// (`overrideSuggestedActionsForConfiguration`). A page of the user's own
/// keeps WebKit's menu, which a delegate without this method leaves it.
final class PrivatePagePanels: PagePanels {
    /// WebKit's Add to Reading List (`_WKElementAction`), which hands the
    /// address to Safari's Reading List.
    private static let readingList = "WKElementActionTypeAddToReadingList"

    func webView(_ webView: WKWebView, contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
                 completionHandler: @escaping @MainActor (UIContextMenuConfiguration?) -> Void) {
        completionHandler(UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { suggested in
            UIMenu(children: suggested.filter { ($0 as? UIAction)?.identifier.rawValue != Self.readingList })
        })
    }
}

/// What the user typed into the address bar, as somewhere to go: a web
/// address, or a search with the synced search engine. What counts as an
/// address follows Gecko's `URIFixup` for what the phone opens.
enum Address {
    static func resolve(_ text: String, settings: [String: Any]) -> URL? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return typed(text) ?? SearchEngine(settings: settings).search(text)
    }

    /// `text` as an address, fixed up as the address bar fixes it up, or
    /// nil for a search: what a typed favorite or pin address is saved as
    /// (the desktop's `SvalFavorites.addressOf`).
    static func typed(_ text: String) -> URL? {
        page(text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Whether `text` is a search rather than an address.
    static func isSearch(_ text: String) -> Bool {
        typed(text) == nil
    }

    /// The web address `text` names, or none when Gecko would search for
    /// it. A typed address without a scheme loads over HTTPS where Gecko's
    /// HTTPS-First tries HTTPS (`nsHTTPSOnlyUtils::ShouldUpgradeHttpsFirstRequest`),
    /// and over HTTP where it doesn't: a local address, a name without a
    /// known public suffix, a port of its own.
    static func page(_ text: String) -> URL? {
        if let url = URL(string: text), let scheme = url.scheme?.lowercased(),
           ["http", "https"].contains(scheme) {
            return url.host() != nil ? url : nil
        }
        // What starts with "?" is a search (`keywordURIFixup`). The phone
        // also searches for anything that holds a space.
        guard !text.hasPrefix("?"), !text.contains(where: \.isWhitespace) else { return nil }
        // `host:port` is an address; any other scheme is one the phone
        // doesn't open, which Gecko searches for (`possiblyHostPortRegex`).
        let hostPort = text.range(of: #"^[a-z0-9-]+(\.[a-z0-9-]+)*:[0-9]{1,5}([/?#]|$)"#,
                                  options: [.regularExpression, .caseInsensitive]) != nil
        if URL(string: text)?.scheme != nil, !hostPort { return nil }
        guard let url = URL(string: "http://\(text)"),
              let host = url.host(percentEncoded: false)?.lowercased(), !host.isEmpty else { return nil }
        let ip = isIP(host)
        let knownSuffix = !ip && host.contains(".") && !host.hasSuffix(".") && hasKnownPublicSuffix(host: host)
        let lastLabel = host.split(separator: ".").last.map(String.init) ?? ""
        let unknownSuffix = !ip && !knownSuffix && host.contains(".") && !host.hasSuffix(".")
            && host != "localhost" && !lastLabel.allSatisfy(\.isNumber)
        // A trailing slash insists on an address, as does `www.` and a name.
        let insisted = text.hasSuffix("/") || (host.hasPrefix("www.") && host.lastIndex(of: ".") == host.index(host.startIndex, offsetBy: 3))
        if !insisted, !ip {
            // `keywordURIFixup`: a known name, or one that looks like an
            // address, isn't searched for.
            let dottedName = host.hasSuffix(".") && host.firstIndex(of: ".") != host.index(before: host.endIndex)
            if !knownSuffix, host != "localhost", !dottedName, !looksLikeAddress(text, host: host) {
                return nil
            }
            if unknownSuffix { return nil }
        }
        let local = isLocal(host)
        let https = !local && (ip || knownSuffix) && (url.port == nil || url.port == 80)
        return https ? URL(string: "https://\(text)") : url
    }

    /// `isURILike`: a path followed by a query or fragment, or a port.
    private static func looksLikeAddress(_ text: String, host: String) -> Bool {
        if let slash = text.firstIndex(of: "/"),
           text[slash...].contains(where: { $0 == "?" || $0 == "#" }) {
            return true
        }
        let rest = text.lowercased().hasPrefix(host) ? String(text.dropFirst(host.count)) : text
        return rest.range(of: #"^:\d{1,5}([?#/]|$)"#, options: .regularExpression) != nil
    }

    private static func isIP(_ host: String) -> Bool {
        host.contains(":") || ipv4(host) != nil
    }

    private static func ipv4(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let numbers = parts.compactMap { Int($0) }.filter { (0...255).contains($0) }
        return numbers.count == 4 ? numbers : nil
    }

    /// Loopback and local addresses, which HTTPS-First leaves on HTTP
    /// (`LoopbackOrLocalException`, `NetAddr::IsIPAddrLocal`).
    private static func isLocal(_ host: String) -> Bool {
        if host == "localhost" { return true }
        if let ip = ipv4(host) {
            return ip[0] == 0 || ip[0] == 127 || ip[0] == 10 || (ip[0] == 172 && (16...31).contains(ip[1]))
                || (ip[0] == 192 && ip[1] == 168) || (ip[0] == 169 && ip[1] == 254)
        }
        guard host.contains(":") else { return false }
        let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if bare == "::1" || bare == "::" { return true }
        if bare.hasPrefix("::ffff:"), let mapped = ipv4(String(bare.dropFirst(7))) {
            return isLocal(mapped.map(String.init).joined(separator: "."))
        }
        guard let first = bare.split(separator: ":", omittingEmptySubsequences: false).first,
              let piece = UInt16(first, radix: 16) else { return false }
        return piece >> 9 == 0xFC >> 1 || piece >> 6 == 0xFE80 >> 6
    }
}

/// The search engine the desktop syncs (`SvalSettingsRegistry`'s
/// `SEARCH_ENGINE_KEY`), by its identifier in Sval's search configuration
/// (`SvalSearchConfig.sys.mjs`). An engine the phone doesn't know, such as
/// one the user added on a computer, searches with the default.
struct SearchEngine {
    static let key = "sval.search.engine"
    static let defaultId = "ddg"

    /// Each engine's search address and the parameter that takes the terms.
    static let engines: [String: (base: String, term: String)] = [
        "ddg": ("https://duckduckgo.com/", "q"),
        "startpage": ("https://www.startpage.com/sp/search", "query"),
        "brave": ("https://search.brave.com/search", "q"),
        "kagi": ("https://kagi.com/search", "q"),
        "google": ("https://www.google.com/search", "q"),
        "bing": ("https://www.bing.com/search", "q"),
        "ecosia": ("https://www.ecosia.org/search", "q"),
        "qwant": ("https://www.qwant.com/", "q"),
        "perplexity": ("https://www.perplexity.ai/search", "q"),
        "youtube": ("https://www.youtube.com/results", "search_query"),
        "github": ("https://github.com/search", "q"),
        "openstreetmap": ("https://www.openstreetmap.org/search", "query"),
        "wikipedia": ("https://en.wikipedia.org/wiki/Special:Search", "search"),
    ]

    let id: String

    init(settings: [String: Any]) {
        let synced = settings[Self.key] as? String ?? Self.defaultId
        id = Self.engines[synced] == nil ? Self.defaultId : synced
    }

    func search(_ terms: String) -> URL? {
        guard let engine = Self.engines[id], var search = URLComponents(string: engine.base) else { return nil }
        search.queryItems = [URLQueryItem(name: engine.term, value: terms)]
        return search.url
    }
}

/// Whether a page may run JavaScript, by the rules the desktop syncs
/// (`SvalJavascript.sys.mjs`): each rule is a setting under `siteBranch`,
/// named for a site or a host and holding `allow` or `block`, and the rule
/// for the most specific name covering the host wins (`siteNames`). With
/// none, `javascript.enabled` decides.
enum JavaScriptRules {
    static let siteBranch = "browser.sval.javascript.site."
    static let enabledKey = "javascript.enabled"

    static func allowed(host: String?, settings: [String: Any]) -> Bool {
        let fallback = settings[enabledKey] as? Bool ?? true
        for name in SiteRules.names(of: host ?? "") {
            if let rule = settings[siteBranch + name] as? String, rule == "allow" || rule == "block" {
                return rule == "allow"
            }
        }
        return fallback
    }

    /// Whether a load may run JavaScript. A web address takes its own host's
    /// rule. A frame loaded from anything else (`about:blank`, `data:`,
    /// `blob:`) takes the rule of the frame that made it, as it does on the
    /// desktop, where such a frame gets its creator's principal. One whose
    /// creator has no host of its own, such as a sandboxed frame, runs
    /// JavaScript only when both its page's rule and the default allow it.
    static func allowed(_ action: WKNavigationAction, in webView: WKWebView, settings: [String: Any]) -> Bool {
        if let url = action.request.url, let scheme = url.scheme?.lowercased(),
           ["http", "https"].contains(scheme) {
            return allowed(host: url.host(), settings: settings)
        }
        let origin = action.sourceFrame.securityOrigin.host
        if !origin.isEmpty {
            return allowed(host: origin, settings: settings)
        }
        return allowed(host: nil, settings: settings) && allowed(host: webView.url?.host(), settings: settings)
    }
}

/// Hands a page's typing report to it, without the content controller, which
/// holds its handlers strongly, keeping the page alive.
private final class TouchReport: NSObject, WKScriptMessageHandler {
    weak var page: Page?

    init(page: Page) {
        self.page = page
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { page?.noteTouch() }
    }
}

private final class TypingReport: NSObject, WKScriptMessageHandler {
    weak var page: Page?

    init(page: Page) {
        self.page = page
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { page?.noteTyping() }
    }
}

private final class PressedReport: NSObject, WKScriptMessageHandler {
    weak var page: Page?

    init(page: Page) {
        self.page = page
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { page?.notePressed() }
    }
}

/// Writes a page's media and script reports to the device's console.
private final class MediaReport: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let fields = message.body as? [String: Any] else { return }
        let line = fields.keys.sorted().map { "\($0)=\(fields[$0] ?? "")" }.joined(separator: " ")
        Diagnostics.log("media: \(line)")
    }
}

/// Hands the icon address a page names to `SiteIcons`.
private final class IconReport: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard message.frameInfo.isMainFrame else { return }
            SiteIcons.shared.learn(page: message.frameInfo.request.url, named: message.body as? String)
        }
    }
}

/// Hands a frame's media change to its page, as `TypingReport` does.
/// A page's word that Ask first refused its media. It says nothing more.
private final class BlockedReport: NSObject, WKScriptMessageHandler {
    weak var page: Page?

    init(page: Page) {
        self.page = page
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // The page's own world can post here too, so only the guard's words
        // reach the log (CONTRIBUTING.md rule 10).
        guard let why = message.body as? String, Page.refusalReasons.contains(why) else { return }
        let main = message.frameInfo.isMainFrame
        MainActor.assumeIsolated { page?.mediaRefusal(why, mainFrame: main) }
    }
}

private final class PlaybackReport: NSObject, WKScriptMessageHandler {
    weak var page: Page?

    init(page: Page) {
        self.page = page
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard let page, let fields = message.body as? [String: Any],
                  let frame = fields["frame"] as? String, let playing = fields["playing"] as? Bool else { return }
            page.mediaFrames[frame] = message.frameInfo
            page.mediaReport(frame: frame, playing: playing, muted: fields["muted"] as? Bool ?? false,
                             unseen: fields["unseen"] as? Bool ?? false, gesture: fields["gesture"] as? Bool ?? false, pip: fields["pip"] as? Bool ?? false,
                             mainFrame: message.frameInfo.isMainFrame)
        }
    }
}

/// A plain cover over the whole app while a private tab is in front and the
/// app is leaving the screen, so the snapshot iOS keeps for the app
/// switcher shows nothing private. A window of its own above the app's,
/// shown without becoming key, so the keyboard stays up (Firefox for iOS,
/// `PrivacyWindowHelper`).
@MainActor
enum PrivacyCover {
    private static var window: UIWindow?

    static func show() {
        guard window == nil, let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).first else { return }
        let cover = UIWindow(windowScene: scene)
        cover.windowLevel = .alert + 1
        cover.rootViewController = UIHostingController(rootView: PrivateCoverView())
        cover.isHidden = false
        window = cover
    }

    static func hide() {
        window?.isHidden = true
        window = nil
    }
}

/// What a page's scrolling tells the bar (`Browser.pageScrolled`).
enum ScrollReport {
    /// A finger came down on the page.
    case touched
    /// The finger lifted, perhaps leaving the page to coast.
    case released
    /// The page reached its end.
    case atEnd
    /// The page moved by `by` points, down when positive; `atTop` once
    /// back at its start, and `held` while a finger is on it.
    case moved(by: Double, atTop: Bool, held: Bool)
}

/// A page's frames with media playing, as each frame reports its own.
struct PlayingFrames {
    /// By a token each frame picks, whether that frame's media is all
    /// muted.
    private var muted: [String: Bool] = [:]
    /// The frames among `muted` whose media can be neither seen nor heard.
    /// They still play, so every pause and hold covers them, but they get
    /// no media controls: a site's hidden, muted background video is
    /// nothing the user knows of.
    private var unseen: Set<String> = []

    var isEmpty: Bool { muted.isEmpty }

    /// Whether the page has media playing that the user can see or hear.
    var perceived: Bool { muted.keys.contains { !unseen.contains($0) } }

    /// Whether every frame the user can see or hear plays muted.
    var allMuted: Bool { muted.filter { !unseen.contains($0.key) }.values.allSatisfy { $0 } }

    /// Notes what `frame` says of its media. Returns whether what the user
    /// can see or hear of the page changed.
    mutating func report(_ frame: String, playing: Bool, muted isMuted: Bool, unseen isUnseen: Bool) -> Bool {
        let was = (perceived, allMuted)
        muted[frame] = playing ? isMuted : nil
        if playing && isUnseen { unseen.insert(frame) } else { unseen.remove(frame) }
        return (perceived, allMuted) != was
    }
}
