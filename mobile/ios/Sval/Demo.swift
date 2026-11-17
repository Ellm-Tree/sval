// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import Security

/// A set-up app with sample Workspaces, for the simulator's UI tests,
/// opened with the `-svalDemo` launch option: a folder in the app's own
/// container stands in for the shared folder, so no account or computer is
/// needed, and the first launch fills the tree.
enum Demo {
    static let requested = LaunchOption.given("-svalDemo")

    /// Starts the demo over, for a test that needs the tree as `fill`
    /// makes it: the app's own copies and the stand-in folder go, so the
    /// next launch reads nothing and fills the tree again.
    static func resetIfAsked() {
        guard requested, LaunchOption.given("-svalDemoFresh") else { return }
        let fm = FileManager.default
        for url in [URL.applicationSupportDirectory, URL.documentsDirectory.appending(path: "demo-shared")] {
            try? fm.removeItem(at: url)
        }
        UserDefaults.standard.removePersistentDomain(forName: Bundle.main.bundleIdentifier ?? "app.sval.ios")
    }

    /// Whether the demo opens on setup's pairing code: the folder chosen,
    /// with no sync key yet, as a phone joining another device's sync.
    static let joining = LaunchOption.given("-svalDemoJoin")
    /// Whether the demo opens on starting a sync: an empty folder chosen,
    /// with no sync key.
    static let starting = LaunchOption.given("-svalDemoStart")

    /// The stand-in shared folder, made with a sync key on first use.
    static func source() -> Source? {
        guard requested else { return nil }
        let url = URL.documentsDirectory.appending(path: "demo-shared", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        if joining || starting {
            Secrets.forgetSyncKey()
            // Joining needs a folder another device already syncs in.
            if joining {
                try? FileManager.default.createDirectory(at: url.appending(path: topDir), withIntermediateDirectories: true)
            }
            return .files(url)
        }
        if Secrets.syncKey() == nil {
            var key = Data(count: 32)
            _ = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
            try? Secrets.storeSyncKey(key)
        }
        return .files(url)
    }

    /// Fills an empty tree once: three Workspaces, one with a coloured
    /// group and a split, and a tab in the phone's own.
    @MainActor
    static func fill(_ model: AppModel) async {
        guard requested, model.workspaces.filter({ $0.device == nil }).isEmpty else { return }
        guard let reading = await model.addWorkspace(named: "Reading", emoji: "📚", color: "blue"),
              let work = await model.addWorkspace(named: "Work", emoji: "💼", color: "green"),
              await model.addWorkspace(named: "Travel", emoji: "✈️", color: "cyan") != nil
        else { return }
        for (name, url) in [("Night trains", "https://en.wikipedia.org/wiki/Night_train"),
                            ("Example", "https://example.com/")] {
            _ = await model.demoTab(name, url, in: reading)
        }
        if let group = await model.addGroup(named: "Pricing pages", emoji: nil, color: "orange", in: work) {
            for (name, url) in [("Apple", "https://www.apple.com/"), ("Wikipedia", "https://www.wikipedia.org/")] {
                _ = await model.demoTab(name, url, in: group)
            }
        }
        _ = await model.demoTab("Swift", "https://www.swift.org/", in: work)
        if let own = model.ownWorkspace?.id {
            _ = await model.demoTab("Rail transport", "https://en.wikipedia.org/wiki/Rail_transport", in: own)
        }
        Diagnostics.log("demo: tree filled")
    }
}
