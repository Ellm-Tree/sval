// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import Observation
import SwiftUI
import UIKit
import WebKit

extension Browser {
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

    static let keepPlayingKey = "keepPlayingAfterLeaving"

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
            .filter { $0 != currentTabId && mediaShown($0) && pages[$0]?.isPrivate == inPrivate }
            .max { media[$0]!.startedAt < media[$1]!.startedAt }
    }

    // MARK: Media log

    /// A tab's short id for the log: ids say nothing of what is browsed.
    static func tag(_ id: String?) -> String { id.map { String($0.prefix(6)) } ?? "none" }

    /// Every media fact the bar and the window act on, in one line: the tab
    /// in front, the setting, what the bar shows, the pages kept in the
    /// window, and each tab with media or a page reporting any. With
    /// `tagsPrivate`, the side in front and which pages are private too,
    /// for a line that stays in memory (`Diagnostics.debug`).
    private func mediaSnapshot(tagsPrivate: Bool) -> String {
        let now = Date.now
        var parts = ["front \(Self.tag(currentTabId))", "keep playing \(keepPlaying ? "on" : "off")"]
        if tagsPrivate { parts.append(inPrivate ? "in private" : "out of private") }
        let front = currentTabId.flatMap { mediaShown($0) ? $0 : nil }
        parts.append("bar \(front.map { "front \(Self.tag($0))" } ?? mediaTab.map { "tab \(Self.tag($0))" } ?? "no media")"
                     + (frontAsks ? ", ask" : "") + (frontDenied ? ", denied mark" : ""))
        parts.append("window [\(stagedIds().map { Self.tag($0) }.joined(separator: " "))]")
        // Only a private page is suspended for privacy, so the reason
        // tags its tab.
        let suspensions = { (page: Page) in page.suspensions.filter { tagsPrivate || $0 != .privacy } }
        let ids = Set(media.keys).union(pages.filter {
            $0.value.playing || $0.value.inPictureInPicture || !suspensions($0.value).isEmpty
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
                if !suspensions(page).isEmpty {
                    bits.append("suspended \(suspensions(page).sorted().map(\.rawValue).joined(separator: "+"))")
                }
                if tagsPrivate, page.isPrivate { bits.append("private") }
            } else {
                bits.append("no page")
            }
            if stopped.contains(id) { bits.append("stopped") }
            if mediaShown(id) { bits.append("shown") }
            parts.append("\(Self.tag(id)) \(bits.joined(separator: " "))")
        }
        return parts.joined(separator: "; ")
    }

    /// Logs a media event with the whole media state after it. An event
    /// only the private session or a private page causes is `privateOnly`,
    /// and stays in memory.
    func mediaLog(_ event: String, privateOnly: Bool = false) {
        let line = "media: \(event) | \(mediaSnapshot(tagsPrivate: privateOnly))"
        if privateOnly { Diagnostics.debug(line) } else { Diagnostics.log(line) }
    }

    /// The tabs whose pages `stagedPages` keeps in the window, back to
    /// front.
    func stagedIds() -> [String] {
        _ = mediaClock
        let now = Date.now
        let behind = pages
            .filter { id, page in
                guard id != currentTabId else { return false }
                if inPictureInPicture(id) { return true }
                return keepPlaying && page.isPrivate == inPrivate
                    && (mediaShown(id) || (held[id].map { $0 > now } ?? false))
            }
            .keys
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
    func watchWindow() {
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
    func makeShownPages() {
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
    func startMediaChecks() {
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
        if let kept = page.keptState {
            keepOffloaded(id, state: kept.state, address: kept.address, from: page)
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
        let kept = old.keptState
        old.close()
        media[id] = nil
        // The page's own privacy, fixed when it was made: the session's
        // ids no longer hold a tab that is closing.
        let page = makePage(id, address: nil, opens: nil, pin: false, at: site, privately: old.isPrivate)
        if let kept {
            page.restore(kept.state, at: kept.address)
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
    /// media button does: the page is made again to play
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

    func page(for row: OutlineRow) -> Page {
        if let page = pages[row.id] {
            return page
        }
        return makePage(row.id, address: row.url, opens: Self.openable(row), pin: false)
    }

    /// A page for `id`, put back as it was let go when it was at `address`,
    /// or else loading `opens`.
    func makePage(_ id: String, address: String?, opens: URL?, pin: Bool, at site: URL? = nil,
                          privately: Bool? = nil, configuration: WKWebViewConfiguration? = nil) -> Page {
        let isPrivate = privately ?? model.isPrivate(id)
        let rules = model.siteRules(private: isPrivate)
        let host = site?.host() ?? offloaded.saved(id)?.address.flatMap(URL.init(string:))?.host() ?? opens?.host()
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
            fold.pageScrolled(report)
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
        page.onFailure = { [weak self] in self?.refreshState() }
        page.onFailedOverPage = { [weak self] reason in
            guard let self, currentTabId == id else { return }
            model.toasts.show(Toast(text: reason, symbol: "exclamationmark.triangle.fill"))
        }
        page.onLoad = { [weak self, weak page] in
            guard let self else { return }
            downloads.forget(tab: id)
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
        // A load that became a download in a tab that had shown nothing
        // leaves the tab to show the file (`DownloadPage`).
        page.onDownload = { [weak self, weak page] download, asked in
            let empty = page?.view.backForwardList.currentItem == nil
            self?.downloads.start(download, asked: asked, tab: empty ? id : nil, isPrivate: isPrivate)
        }
        page.onMedia = { [weak self] id, playing, muted, gesture in
            self?.mediaReport(id, playing: playing, muted: muted, gesture: gesture)
        }
        page.protectionsOn = { [weak self] host in
            self?.model.siteRules(private: isPrivate).protectionsOn(for: host) ?? true
        }
        page.protected = rules.protectionsOn(for: host ?? "")
        page.loadsUnder(blocker)
        page.onNewWindow = { [weak self] configuration, action in
            self?.openWindow(from: id, configuration: configuration, for: action)
        }
        page.onCloseWindow = { [weak self] in self?.closeWindow(id) }
        // Made while the view is drawn; the bar takes its state after.
        Task { @MainActor [weak self] in self?.refreshState() }
        // A page let go comes back as it was. One whose tab is at another
        // address loads that address over its history: another device
        // moved the tab, or the app ended between the tree taking a new
        // address and the state's write landing.
        guard !pin else { return page }
        let saved = offloaded.take(id)
        if let saved, saved.address == address {
            page.restore(saved.state, at: saved.address)
            // Put back as it was: no new visit (`navigated`).
            restoring.insert(id)
        } else if let opens {
            if let saved { page.restore(saved.state, at: saved.address) }
            page.load(opens)
        }
        #if DEBUG
        let how = saved == nil ? "with no saved state" : saved?.address == address
            ? "from its saved state\(page.waitsForRules ? ", once the blocker is ready" : "")"
            : "from its saved state, then at its tab's other address"
        Diagnostics.log("tabs: a tab's page made \(how)")
        #endif
        return page
    }

    /// The tab's address, if this app opens it. An address another device
    /// wrote is opened only when it is a web page: the desktop refuses
    /// addresses that may not leave a device, and an iPhone
    /// opens nothing but the web.
    nonisolated static func openable(_ row: OutlineRow) -> URL? {
        guard let address = row.url, let url = URL(string: address),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme)
        else { return nil }
        return url
    }
}
