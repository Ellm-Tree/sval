// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import Security

#if DEBUG
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

    /// Whether the demo fills the tree for the App Store's screenshots:
    /// Workspaces a person might keep, on pages that show without a login.
    static let showroom = LaunchOption.given("-svalDemoShowroom")

    /// The stand-in shared folder, made with a sync key on first use.
    static func source() -> Source? {
        guard requested else { return nil }
        let url = URL.documentsDirectory.appending(path: "demo-shared", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        if joining || starting {
            Secrets.keychain.forgetSyncKey()
            // Joining needs a folder another device already syncs in.
            if joining {
                try? FileManager.default.createDirectory(at: url.appending(path: topDir), withIntermediateDirectories: true)
            }
            return .files(url)
        }
        if Secrets.keychain.syncKey() == nil {
            var key = Data(count: 32)
            _ = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
            try? Secrets.keychain.storeSyncKey(key)
        }
        return .files(url)
    }

    /// Fills an empty tree once: three Workspaces, one with a coloured
    /// group and a split, and a tab in the phone's own. A started sync
    /// stays empty, as a new sync's tree is, so its tests load no page they
    /// did not open.
    @MainActor
    static func fill(_ model: AppModel) async {
        guard requested, !starting, model.workspaces.filter({ $0.device == nil }).isEmpty else { return }
        if showroom { return await fillShowroom(model) }
        guard let reading = await model.addWorkspace(named: "Reading", emoji: "📚", color: "cyan"),
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

    @MainActor
    private static func fillShowroom(_ model: AppModel) async {
        guard let trip = await model.addWorkspace(named: "Road Trip", emoji: "🏞️", color: "blue"),
              let work = await model.addWorkspace(named: "Work", emoji: "💼", color: "green"),
              let music = await model.addWorkspace(named: "Listening", emoji: "🎧", color: "purple"),
              await model.addWorkspace(named: "Reading", emoji: "📚", color: "cyan") != nil
        else { return }
        let parks = "https://www.nps.gov/"
        if let utah = await model.addGroup(named: "Utah", emoji: "🌵", color: "orange", in: trip) {
            for (name, park) in [("Zion", "zion"), ("Arches", "arch"), ("Bryce Canyon", "brca")] {
                _ = await model.demoTab(name, parks + park + "/index.htm", in: utah)
            }
        }
        for (name, park) in [("Grand Canyon", "grca"), ("Yosemite", "yose"), ("Death Valley", "deva")] {
            _ = await model.demoTab(name, parks + park + "/index.htm", in: trip)
        }
        _ = await model.demoTab("Fastmail", "https://www.fastmail.com/", in: work)
        _ = await model.demoSplit([("Swift", "https://www.swift.org/"), ("WebKit", "https://webkit.org/")], in: work)
        _ = await model.demoTab("Roon", "https://roon.app/", in: music)
        if let own = model.ownWorkspace?.id {
            _ = await model.demoTab("WebKit blog", "https://webkit.org/blog/", in: own)
        }
        Diagnostics.log("demo: showroom tree filled")
    }
}
#endif
