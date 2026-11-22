// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// The state of each page let go (`WKWebView.interactionState`: its back
/// and forward list, scroll position and form data), with the address it
/// was at, by page key. A tab's state is also kept on disk, so a tab whose
/// page was let go comes back with its history after iOS ends the app; a
/// private tab's and a pin's are kept in memory alone.
@MainActor
final class PageStates {
    struct Saved {
        let state: Any
        let address: String?
        /// A pin's saved page as its page was let go (`Page.savedPage`).
        var savedPage: URL?
    }

    /// What one file holds.
    private struct Stored: Codable {
        let state: Data
        let address: String?
    }

    /// The most tab states kept on disk, the oldest written going first:
    /// ten times the pages kept live (`Browser.livePages`), the tabs a
    /// person comes back to over days of use.
    static let kept = 100

    private var held: [String: Saved] = [:]
    /// Application Support, which the system never purges and the Files app
    /// never shows. Files take the app's default data protection, as its own
    /// copy of the shared folder does.
    private let directory: URL

    init(directory: URL = URL.applicationSupportDirectory.appending(path: "PageStates", directoryHint: .isDirectory)) {
        self.directory = directory
    }

    /// Keeps `state` for `id`, and on disk when it is a tab's that isn't
    /// private. WebKit restores only the `Data` its own getter gives
    /// (`-[WKWebView setInteractionState:]`), so a state of any other type
    /// stays in memory.
    func keep(_ id: String, state: Any, address: String?, isTab: Bool, isPrivate: Bool, savedPage: URL? = nil) {
        held[id] = Saved(state: state, address: address, savedPage: savedPage)
        guard isTab, !isPrivate, let data = state as? Data else {
            remove(file(id))
            return
        }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var folder = directory
            try folder.setResourceValues(values)
            try PropertyListEncoder().encode(Stored(state: data, address: address))
                .write(to: file(id), options: .atomic)
        } catch {
            Diagnostics.log("tabs: a page's state was not saved: \(Diagnostics.name(error))")
            return
        }
        trim()
    }

    /// The state kept for `id`, from memory or disk.
    func saved(_ id: String) -> Saved? {
        if let saved = held[id] { return saved }
        guard let data = try? Data(contentsOf: file(id)),
              let stored = try? PropertyListDecoder().decode(Stored.self, from: data) else { return nil }
        return Saved(state: stored.state, address: stored.address)
    }

    /// The state kept for `id`, which is then forgotten: the page it is
    /// put back in has a state of its own from there.
    func take(_ id: String) -> Saved? {
        let saved = saved(id)
        forget(id)
        return saved
    }

    func forget(_ id: String) {
        held[id] = nil
        remove(file(id))
    }

    /// Forgets every state, on disk and in memory, but the in-memory
    /// states `keeping` names: what Clear Browsing Data clears.
    func forgetAll(keeping: (String) -> Bool) {
        held = held.filter { keeping($0.key) }
        for (_, url) in files() { remove(url) }
    }

    /// Forgets every state but those `live` keeps in memory, and every file
    /// but the tabs' that `onDisk` keeps.
    func keep(live: (String) -> Bool, onDisk: (String) -> Bool) {
        held = held.filter { live($0.key) }
        for (id, url) in files() where !(id.map(onDisk) ?? false) {
            remove(url)
        }
    }

    /// The files on disk, each with the page key it is named for.
    private func files() -> [(id: String?, url: URL)] {
        let urls = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        return urls.map { url in
            var name = url.lastPathComponent.replacingOccurrences(of: "-", with: "+")
                .replacingOccurrences(of: "_", with: "/")
            name += String(repeating: "=", count: (4 - name.count % 4) % 4)
            return (Data(base64Encoded: name).flatMap { String(data: $0, encoding: .utf8) }, url)
        }
    }

    /// The file named for `id`, in base64url, which a page key's `:` and
    /// `@` and any other character survive.
    private func file(_ id: String) -> URL {
        let name = Data(id.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return directory.appending(path: name)
    }

    private func remove(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    /// Removes the oldest files past `kept`.
    private func trim() {
        let all = files().map(\.url)
        guard all.count > Self.kept else { return }
        func written(_ url: URL) -> Date {
            (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
        }
        for url in all.sorted(by: { written($0) < written($1) }).dropLast(Self.kept) {
            remove(url)
        }
    }
}
