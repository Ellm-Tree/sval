// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import UIKit
import WebKit

/// Keeps every playing tab playing when the app goes to the background:
/// the tab in front, and those playing behind it (`Browser.stagedPages`),
/// which keep playing in the foreground by staying in the window.
///
/// WebKit suspends a web view's media when its app leaves the foreground,
/// and many sites pause themselves when their page turns hidden. So, as
/// Firefox for iOS does (`BackgroundAudioHelper`): as the app leaves the
/// foreground, the media playing in the tab in front is marked; once in the
/// background, WebKit's suspension is lifted, the page is told it is still
/// visible, and the marked media plays again. The page learns the truth when
/// the app comes back. The app declares background audio (`Info.plist`), and
/// WebKit keeps its processes running while a page makes sound.
///
/// What was playing is kept in Sval's own script world, out of the page's
/// reach, and only pages whose frames said they were playing as the app
/// left are played again.
@MainActor
final class BackgroundAudio {
    /// The pages in the window: those playing behind, then the tab in
    /// front, each with whether its media plays.
    var pages: (@MainActor () -> [(view: WKWebView, playing: Bool)])?
    private var observers: [NSObjectProtocol] = []
    /// The pages marked as the app left the foreground.
    private var marked: Set<ObjectIdentifier> = []

    private static let markPlaying = """
        window.__svalResume = new WeakSet();
        for (const media of document.querySelectorAll("audio, video")) {
          if (!media.paused && !media.ended) window.__svalResume.add(media);
        }
        """

    /// In the page's world from each document's start: while
    /// `stayVisible`'s properties are on the document, the page hears no
    /// change of visibility. Held in this closure, with no name the page
    /// could look up.
    static let visibilityGuard = """
        (() => {
          const own = Object.getOwnPropertyDescriptor;
          addEventListener("visibilitychange", event => {
            if (own(document, "visibilityState")) event.stopImmediatePropagation();
          }, true);
        })();
        """

    private static let stayVisible = """
        Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
        Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
        """

    private static let resumeMarked = """
        const marked = window.__svalResume;
        window.__svalResume = null;
        if (marked) {
          for (const media of document.querySelectorAll("audio, video")) {
            if (marked.has(media)) media.play().catch(() => {});
          }
        }
        """

    private static let beVisibleAgain = """
        delete document.hidden;
        delete document.visibilityState;
        """

    init() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.mark()
                }
            },
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.keepPlaying() }
            },
            center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.cameBack() }
            },
        ]
    }

    /// Stops answering the app's notifications (`AppModel.stopObserving`).
    func stopObserving() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
    }

    private func mark() {
        let pages = pages?() ?? []
        let playing = pages.filter(\.playing).map(\.view)
        marked = Set(playing.map(ObjectIdentifier.init))
        for page in playing {
            page.evaluateJavaScript(Self.markPlaying, in: nil, in: .defaultClient)
        }
        Diagnostics.log("audio: leaving the foreground with \(pages.count) page(s) in the window, \(playing.count) playing")
    }

    private func cameBack() {
        marked = []
        for page in pages?() ?? [] {
            page.view.evaluateJavaScript(Self.beVisibleAgain, in: nil, in: .page)
        }
    }

    private func keepPlaying() {
        let pages = (pages?() ?? []).map(\.view).filter { marked.contains(ObjectIdentifier($0)) }
        marked = []
        for page in pages {
            page.evaluateJavaScript(Self.stayVisible, in: nil, in: .page)
            page.setAllMediaPlaybackSuspended(false) {
                page.evaluateJavaScript(Self.resumeMarked, in: nil, in: .defaultClient)
            }
        }
        Diagnostics.log("audio: \(pages.count) page(s) kept playing into the background")
    }

    /// Tells `page` the truth about its visibility once it is in front again.
    func returned(_ page: WKWebView) {
        page.evaluateJavaScript(Self.beVisibleAgain, in: nil, in: .page)
    }
}
