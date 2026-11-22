// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import QuickLook
import SwiftUI
import WebKit

@main
struct SvalApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        // No navigation stack here: the Workspace panel's own stack would
        // nest in it, and SwiftUI gives a nested stack's bars to the outer.
        Group {
            // Setup covers the browser and never replaces it, so a link
            // from another app always has a browser to open in.
            BrowserView()
                .fullScreenCover(isPresented: Binding(
                    get: { model.showsSetup },
                    set: { if !$0 { model.settingUp = false } })) {
                    FirstRunView()
                }
        }
        // A finished download shows in Quick Look over everything, sheets
        // and setup included (`Downloads.preview`).
        .quickLookPreview(Binding(get: { model.browser.downloads.preview },
                                  set: { model.browser.downloads.preview = $0 }))
        // Sval is the default browser: a link another app opens comes here.
        .onOpenURL { url in Task { await model.openIncoming(url) } }
        .environment(\.appearance, systemScheme)
        .onChange(of: contrast, initial: true) { _, now in
            DesktopColor.contrast.more = now == .increased
        }
        .task(id: scenePhase) {
            // Passes run while the app is open: on opening, then on the
            // desktop's interval.
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await model.sync()
                try? await Task.sleep(for: AppModel.interval)
            }
        }
    }
}

extension OutlineRow {
    /// What a row is called wherever the app shows it: a tab's label, the
    /// name the user gave it, stands in for its page's title
    /// (`displayName` on the desktop, spec §5.1), and a title held back
    /// from the tree (`TitleHold`) stands in for the one written.
    @MainActor var title: String { label ?? TitleHold.shared.pending[id] ?? name }

    /// What a row reads as: its title, or for a row without one what the
    /// desktop's panel calls it (`_untitled`, `tabPlaceholder`). A tab
    /// reads as its host without `www.`, its whole address where it has no
    /// host, or New Tab for a blank page (`isBlankPageURL`).
    @MainActor var displayTitle: String {
        guard title.isEmpty else { return title }
        switch kind {
        case "workspace": return "Untitled Workspace"
        case "group": return "Untitled group"
        default:
            guard let url, !["about:blank", "about:home", "about:newtab"].contains(url) else { return "New Tab" }
            guard let host = URL(string: url)?.host(), !host.isEmpty else { return url }
            return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        }
    }
}
