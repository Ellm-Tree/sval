// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import Observation
import SwiftUI
import UIKit
import WebKit

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
    /// another choice asks for a new page (`applyMediaChoices`).
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
    /// A load that failed with no page to show in its place: where it was
    /// going, and the system's reason.
    struct LoadFailure: Equatable {
        let url: URL
        let reason: String
        /// Set when the page's web process kept ending (`Crashes`), which
        /// has no reason of the system's to give.
        var keepsClosing = false
    }

    /// The times the page's web process ended at one address, to stop
    /// loading again a page that ends it each time. Firefox for iOS stops
    /// at the third end in a row (`consecutiveCrashes` in its
    /// `webViewWebContentProcessDidTerminate`); the span keeps a page
    /// that ends once in a long while from counting toward it.
    struct Crashes {
        static let limit = 3
        static let span: TimeInterval = 60
        private var ends: [Date] = []
        private var url: URL?

        /// Notes an end at `url` at `now`, and returns whether the page
        /// has ended `limit` times there within `span`, which starts the
        /// count over.
        mutating func ended(at url: URL?, now: Date) -> Bool {
            if url != self.url {
                self.url = url
                ends = []
            }
            ends = ends.filter { now.timeIntervalSince($0) < Self.span } + [now]
            guard ends.count >= Self.limit else { return false }
            ends = []
            return true
        }
    }
    private var crashes = Crashes()
    /// The load that failed and left this page empty, until another starts.
    private(set) var failure: LoadFailure?
    /// Told when a load fails and leaves this page empty.
    var onFailure: (@MainActor () -> Void)?
    /// Told the system's reason when a load fails and the page it left
    /// still shows.
    var onFailedOverPage: (@MainActor (String) -> Void)?
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
        // A private tab signs in to Kagi with Privacy Pass (`KagiSpend`).
        if isPrivate {
            configuration.userContentController.addUserScript(WKUserScript(
                source: KagiSpend.pageScript, injectionTime: .atDocumentStart,
                forMainFrameOnly: false, in: .page))
            configuration.userContentController.addUserScript(WKUserScript(
                source: KagiSpend.bridgeScript, injectionTime: .atDocumentStart,
                forMainFrameOnly: false, in: .defaultClient))
        }
        // With the developer's launch option, every frame reports what its
        // media and scripts do, for the device's console. Never otherwise:
        // the reports name a page's elements and quote its errors.
        #if DEBUG
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
        #endif
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
        if isPrivate {
            configuration.userContentController.addScriptMessageHandler(
                KagiSpend.TokenReply(.shared), contentWorld: .defaultClient, name: KagiSpend.message)
        }
        if reportsTouch {
            configuration.userContentController.add(
                TouchReport(page: self), contentWorld: .defaultClient, name: Self.touchMessage)
        }
        #if DEBUG
        if Self.pageDiagnostics {
            configuration.userContentController.add(
                MediaReport(), contentWorld: .defaultClient, name: Self.mediaMessage)
            configuration.userContentController.add(
                MediaReport(), contentWorld: .page, name: Self.mediaMessage)
        }
        #endif
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
        #if DEBUG
        if Self.pageDiagnostics {
            observations.append(view.observe(\.fullscreenState) { view, _ in
                MainActor.assumeIsolated {
                    Diagnostics.log("page: full-screen state \(view.fullscreenState.rawValue)")
                }
            })
        }
        #endif
        for path in [\WKWebView.canGoBack, \WKWebView.canGoForward, \WKWebView.isLoading] {
            observations.append(view.observe(path) { _, _ in
                MainActor.assumeIsolated { onState() }
            })
        }
        observations.append(view.observe(\.estimatedProgress) { _, _ in
            MainActor.assumeIsolated { onState() }
        })
        // The bar folds as the user scrolls down and comes back as they
        // scroll up or reach the end (`BarFold.pageScrolled`). Offsets the
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
        let refresh = PullRefresh()
        refresh.addTarget(self, action: #selector(pulled(_:)), for: .valueChanged)
        view.scrollView.refreshControl = refresh
        // The spinner turns until the load it started ends.
        observations.append(view.observe(\.isLoading) { view, _ in
            MainActor.assumeIsolated {
                if !view.isLoading { view.scrollView.refreshControl?.endRefreshing() }
            }
        })
    }

    /// The Workspace's colour as its mark shows it on the page's
    /// background, which the spinner draws over, where it meets 3:1 there;
    /// otherwise, or with no colour, Sval's blue on a light page or its
    /// cyan on a dark one. A page sets its background as it loads, so the
    /// colour is chosen as a pull begins.
    private func spinnerColor() -> UIColor {
        let ground = view.underPageBackgroundColor.resolvedColor(with: view.traitCollection)
        let light = BarColors.readsDark(Color(ground), dark: false)
        if let tint = (view.scrollView.refreshControl as? PullRefresh)?.tint {
            let mark = UIColor(tint.swatch(dark: !light))
            if let ratio = DesktopColor.ratio(mark, on: ground), ratio >= 3 { return mark }
        }
        return light ? UIColor(Theme.blue) : UIColor(Color(hex: Palette.neon))
    }

    /// A load that never starts, as when the page has no address, never
    /// ends the spinner through `isLoading`.
    @objc private func pulled(_ refresh: UIRefreshControl) {
        reload()
        if !view.isLoading { refresh.endRefreshing() }
    }

    /// Loads the page again. An empty page left by a failed load has
    /// nothing of its own to reload, so that load starts over.
    func reload() {
        if let failure {
            load(failure.url)
        } else {
            lift([.hold])
            view.reload()
        }
    }

    /// A finger on the page, or lifted from it, which the bar's fold
    /// needs beside the offsets: a held finger keeps a part-folded bar
    /// where it is.
    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began:
            onScroll?(tabId, .touched)
            view.scrollView.refreshControl?.tintColor = spinnerColor()
        case .ended, .cancelled, .failed: onScroll?(tabId, .released)
        default: break
        }
    }

    /// Whether a load Sval started is under way in the top frame, until it
    /// commits or fails.
    private var appLoading = false

    /// Loads `url` for Sval: from the user's address, a tab's or a pin's.
    func load(_ url: URL) {
        if waitsForRules {
            waiting.append { [weak self] in self?.load(url) }
            return
        }
        appLoading = true
        restored = false
        failure = nil
        crashes = Crashes()
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
        if restored {
            restored = false
            if navigationAction.targetFrame?.isMainFrame == true, navigationAction.navigationType == .other,
               let step = restoredStep(to: navigationAction.request.url) {
                decisionHandler(.cancel, preferences)
                webView.go(to: step)
                return
            }
        }
        if let signedIn = signInToKagi(navigationAction) {
            decisionHandler(.cancel, preferences)
            signedIn()
            return
        }
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
            decisionHandler(allowing, preferences)
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
        decisionHandler(allowing, preferences)
    }

    /// What lets a load go on. On a plain allow WebKit first offers the
    /// address to an installed app that claims its link
    /// (`tryInterceptNavigation`), which would take a private page's
    /// address out of Sval. A private page answers with WebKit's
    /// `_WKNavigationActionPolicyAllowWithoutTryingAppLink`, which the SDK
    /// gives no name.
    private var allowing: WKNavigationActionPolicy {
        guard isPrivate else { return .allow }
        return WKNavigationActionPolicy(rawValue: WKNavigationActionPolicy.allow.rawValue + 2) ?? .allow
    }

    /// The token of the Kagi load Sval last started, and that load's
    /// address, so its answer can be followed (`kagiTokenRefused`).
    private var kagiToken: String?
    private var kagiAddress: URL?
    /// When this page last loaded again after Kagi refused a token.
    private var kagiRetried: Date?

    /// Signs a private tab's top-level load of one of Kagi's own pages in
    /// with a token, when the user or Kagi started it (`KagiSpend`): the
    /// load is cancelled, and started again with the token or, when this
    /// month's are used, with a local page in its place. Returns what
    /// starts that, run once the load is cancelled, or nil to let the load
    /// go on. A load already carrying the token Sval gave it
    /// goes on, and so do Back and Forward, which WebKit takes from its
    /// history. A POST goes signed out, since it can't be sent again
    /// unasked.
    private func signInToKagi(_ action: WKNavigationAction) -> (@MainActor () -> Void)? {
        guard isPrivate, action.targetFrame?.isMainFrame == true, let url = action.request.url,
              KagiSpend.isKagiPage(url), action.request.httpMethod ?? "GET" == "GET",
              action.navigationType != .backForward else { return nil }
        if KagiSpend.carries(action.request, token: kagiToken) {
            kagiToken = nil
            return nil
        }
        let byUser = appLoading && action.navigationType == .other
        // WebKit gives some loads no source frame, though Swift sees the
        // property as never nil.
        let source: WKFrameInfo? = action.sourceFrame
        guard byUser || source.map({ KagiSpend.isKagi($0.securityOrigin) }) == true else { return nil }
        let tokens = KagiPrivacyPass.shared
        switch tokens.state {
        case .ready:
            guard let token = tokens.take() else { return nil }
            Diagnostics.debug("kagi: a private load signed in with Privacy Pass, \(tokens.count) left")
            let asked = byUser || action.navigationType == .linkActivated
            return { [weak self] in
                guard let self else { return }
                kagiToken = token
                kagiAddress = url
                appLoading = asked
                view.load(KagiSpend.request(url, token: token))
            }
        case .out:
            Diagnostics.debug("kagi: a private load stopped, this month's tokens are used")
            let page = KagiSpend.outOfTokensPage(until: tokens.outUntil)
            return { [weak self] in self?.view.loadHTMLString(page, baseURL: nil) }
        case .unsupported, .signedOut:
            return nil
        }
    }

    /// Kagi answered a load that spent a token with 401, a token already
    /// spent: the load goes again with a fresh one, at most once a minute.
    /// Any other answer, a 403 included, is Kagi's page to show, as in
    /// Kagi's own extension (Kagi Privacy Pass spec).
    private func kagiTokenRefused(_ response: WKNavigationResponse) -> (@MainActor () -> Void)? {
        guard isPrivate, response.isForMainFrame, let url = kagiAddress,
              (response.response as? HTTPURLResponse)?.statusCode == 401,
              response.response.url == url else { return nil }
        kagiAddress = nil
        if let kagiRetried, Date.now.timeIntervalSince(kagiRetried) < 60 { return nil }
        let tokens = KagiPrivacyPass.shared
        guard tokens.state == .ready, let token = tokens.take() else { return nil }
        kagiRetried = .now
        Diagnostics.debug("kagi: a spent token was refused, loading again with another")
        return { [weak self] in
            guard let self else { return }
            kagiToken = token
            kagiAddress = url
            view.load(KagiSpend.request(url, token: token))
        }
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
    fileprivate func notePressed() {
        guard suspensions.contains(.hold) else { return }
        lift([.hold])
        log?("a touch in the page ended Sval's hold")
    }

    private static let typingMessage = "svalTyped"
    private static let playbackMessage = "svalPlayback"
    static let blockedMessage = "svalMediaBlocked"
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

    #if DEBUG
    static let pageDiagnostics = LaunchOption.given("-svalPageDiagnostics")
    #endif

    /// What Safari on this iOS adds after WebKit's part of its user agent.
    static let safariApplicationName: String = {
        let version = UIDevice.current.systemVersion.split(separator: ".").prefix(2).joined(separator: ".")
        return "Version/\(version) Mobile/15E148 Safari/604.1"
    }()
    private static let mediaMessage = "svalMedia"
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Diagnostics.log("page: a load failed: \(Diagnostics.name(error))")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        appLoading = false
        Diagnostics.log("page: a load failed to start: \(Diagnostics.name(error))")
        let error = error as NSError
        // A load the next one replaced, and a load that became a download
        // (WebKit's "Frame load interrupted", `WebKitErrorDomain` 102),
        // went nowhere wrong.
        let replaced = error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled
        let handedOn = error.domain == "WebKitErrorDomain" && error.code == 102
        guard !replaced, !handedOn else { return }
        if webView.url == nil, let url = error.userInfo[NSURLErrorFailingURLErrorKey] as? URL {
            failure = LoadFailure(url: url, reason: error.localizedDescription)
            onFailure?()
        } else {
            onFailedOverPage?(error.localizedDescription)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        failure = nil
    }

    /// iOS ends a page's web process under memory pressure, which leaves
    /// the page blank. The page in front loads again at once, and any other
    /// once it is shown (`Browser.select`), as Safari does. A page whose
    /// process keeps ending shows its failure, and Try Again loads it anew.
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
        if crashes.ended(at: webView.url, now: .now), let url = webView.url {
            // Shown again, an ended page loads again (`Browser.select`).
            ended = false
            failure = LoadFailure(url: url, reason: "", keepsClosing: true)
            Diagnostics.log("page: the web content process ended \(Crashes.limit) times within \(Int(Crashes.span)) s, not loading it again")
            onFailure?()
            return
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

    /// A response WebKit can't show, or one the site sends as an attachment,
    /// is downloaded. A PDF, which WebKit shows, stays in the tab.
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        if let again = kagiTokenRefused(navigationResponse) {
            decisionHandler(.cancel)
            again()
            return
        }
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

    /// A page that named no icon its document could show by the time it
    /// was parsed may have added one since. A page on screen gives the
    /// grid and the tab scrub its picture once loaded, a second on so its images have drawn;
    /// a page off screen has drawn nothing new to take.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if !isPrivate { SiteIcons.shared.learn(page: webView.url, named: nil) }
        Task { [tabId, isPrivate] in
            try? await Task.sleep(for: .seconds(1))
            guard webView.window != nil else { return }
            PagePreviews.shared.take(tabId, from: webView, isPrivate: isPrivate)
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
        failure = nil
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

    /// Puts back the state of a page let go (`WKWebView.interactionState`),
    /// which loads its page. `address` is where that state is.
    func restore(_ state: Any, at address: String?) {
        if waitsForRules {
            pendingRestore = (state, address)
            waiting.append { [weak self] in self?.restore(state, at: address) }
            return
        }
        pendingRestore = nil
        view.interactionState = state
        restored = true
    }

    /// Set by a restore until the page's next navigation or Sval's own
    /// next load. A state taken while a load was under way holds that
    /// load's address, and WebKit loads it afresh in place of going to the
    /// restored entry (`WebPageProxy::restoreFromSessionState`). For a Back
    /// or Forward still loading, that address is the entry it was going
    /// to, the one restored or its neighbour, and the fresh load would put
    /// a second copy of it where the forward history was.
    private var restored = false

    /// The restored entry at `url`, the one restored or either neighbour,
    /// that a Back or Forward under way was going to.
    private func restoredStep(to url: URL?) -> WKBackForwardListItem? {
        let list = view.backForwardList
        return [list.currentItem, list.backItem, list.forwardItem].lazy.compactMap { $0 }.first { $0.url == url }
    }

    /// The state a restore waits to put back, with its address.
    private var pendingRestore: (state: Any, address: String?)?

    /// The page's state to keep as it is let go or saved, with the address
    /// it is at: the state it waits to restore, or nil while it has shown
    /// nothing. The view's own state before then is an empty history,
    /// which would replace the one the tab had.
    var keptState: (state: Any, address: String?)? {
        if let pendingRestore { return pendingRestore }
        guard view.backForwardList.currentItem != nil, let state = view.interactionState else { return nil }
        return (state, view.url?.absoluteString)
    }

    /// Takes `blocker`'s rules. Until the blocker is `ready`, the page's
    /// loads and restores wait, in order: WebKit applies a rule list
    /// to what a page loads after the list is added.
    func loadsUnder(_ blocker: ContentBlocker) {
        useRules(blocker.rules)
        guard !blocker.ready else { return }
        waitsForRules = true
        Task { [weak self, weak blocker] in
            await blocker?.whenReady()
            guard let self, let blocker else { return }
            useRules(blocker.rules)
            waitsForRules = false
            let starts = waiting
            waiting = []
            for start in starts { start() }
        }
    }

    /// Whether the page's loads wait for the blocker (`loadsUnder`).
    private(set) var waitsForRules = false
    /// The loads and restores asked for while the page waits, in order.
    private var waiting: [@MainActor () -> Void] = []

    /// Blocks with `rules` in place of the rules the page had. A page applies
    /// them to what it loads next.
    func useRules(_ rules: ContentBlocker.Rules) {
        self.rules = rules
        installRules()
    }

    private(set) var rules = ContentBlocker.Rules()
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
        waiting = []
        pendingRestore = nil
        // A private page's Picture in Picture would outlive its tab.
        if isPrivate { view.closeAllMediaPresentations(completionHandler: nil) }
        view.pauseAllMediaPlayback()
        pending?.cancel()
        observations.removeAll()
        view.stopLoading()
        view.navigationDelegate = nil
        view.removeFromSuperview()
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

#if DEBUG
/// Writes a page's media and script reports to the device's console.
private final class MediaReport: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let fields = message.body as? [String: Any] else { return }
        let line = fields.keys.sorted().map { "\($0)=\(fields[$0] ?? "")" }.joined(separator: " ")
        Diagnostics.log("media: \(line)")
    }
}
#endif

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

/// Pull to refresh's control, which keeps the Workspace's colour apart
/// from the colour its spinner shows (`Page.spinnerColor`).
final class PullRefresh: UIRefreshControl {
    var tint: WorkspaceTint?
}
