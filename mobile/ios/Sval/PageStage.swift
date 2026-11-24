// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import WebKit

/// Shows a page that `Browser` owns. The page outlives this view, so it
/// keeps its place when the view is rebuilt.
struct WebContainer: UIViewRepresentable {
    /// Back to front; the last is the page in front. The others are tabs
    /// playing behind it (`Browser.stagedPages`): they stay in the window,
    /// hidden from VoiceOver and touch.
    let pages: [WKWebView]
    /// Whether the last page is the one in front. A split in front shows
    /// its panes itself, and every page here is behind it.
    var showsFront = true
    /// How much of the page's foot the bar covers.
    var bottomCover: CGFloat = Browser.barRoom

    func makeUIView(context: Context) -> PageStage {
        let stage = PageStage()
        updateUIView(stage, context: context)
        return stage
    }

    func updateUIView(_ stage: PageStage, context: Context) {
        if showsFront, let front = pages.last, front.obscuredContentInsets.bottom != bottomCover {
            front.obscuredContentInsets = UIEdgeInsets(top: 0, left: 0, bottom: bottomCover, right: 0)
        }
        stage.show(pages, showsFront: showsFront)
    }
}

/// The view `WebContainer` puts its pages in. A split's pane can take a
/// page from it as the split closes, when the pane is updated after the
/// page has come here, and nothing would put it back until the next
/// update: the stage takes back a page it still shows once the update is
/// over.
final class PageStage: UIView {
    private var pages: [WKWebView] = []
    private var showsFront = true
    private var arranging = false

    func show(_ pages: [WKWebView], showsFront: Bool) {
        self.pages = pages
        self.showsFront = showsFront
        arrange()
    }

    override func willRemoveSubview(_ subview: UIView) {
        super.willRemoveSubview(subview)
        guard !arranging, pages.contains(where: { $0 === subview }) else { return }
        DispatchQueue.main.async { [weak self] in self?.arrange() }
    }

    private func arrange() {
        guard subviews.map(ObjectIdentifier.init) != pages.map(ObjectIdentifier.init)
                || subviews.last?.isUserInteractionEnabled != showsFront else { return }
        arranging = true
        defer { arranging = false }
        #if DEBUG
        if Page.pageDiagnostics {
            Diagnostics.log("tabs: the window shows \(pages.count) page(s), was \(subviews.count)")
        }
        #endif
        for view in subviews where !pages.contains(where: { $0 === view }) {
            view.removeFromSuperview()
        }
        for (index, page) in pages.enumerated() {
            if page.superview !== self {
                place(page)
            }
            insertSubview(page, at: index)
            let inFront = showsFront && index == pages.count - 1
            page.accessibilityElementsHidden = !inFront
            page.isUserInteractionEnabled = inFront
        }
    }

    private func place(_ page: WKWebView) {
        page.removeFromSuperview()
        page.translatesAutoresizingMaskIntoConstraints = false
        addSubview(page)
        NSLayoutConstraint.activate([
            page.leadingAnchor.constraint(equalTo: leadingAnchor),
            page.trailingAnchor.constraint(equalTo: trailingAnchor),
            page.topAnchor.constraint(equalTo: topAnchor),
            page.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
}
