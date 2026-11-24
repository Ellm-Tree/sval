// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import UIKit
import WebKit

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
