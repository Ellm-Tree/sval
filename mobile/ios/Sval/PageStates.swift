// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// The state of each tab's page (`WKWebView.interactionState`: its back
/// and forward list, scroll position and form data), with the address it
/// was at, by page key. A page let go keeps its state here in memory. A
/// tab's state is also kept on disk, written as its page is let go, as it
/// settles at each new address and as the app leaves the front, so the tab
/// comes back with its history however the app ends: iOS ending it in the
/// background ends a suspended app without a word, and a crash or a force
/// quit gives no warning. A private tab's and a pin's are kept in memory
/// alone.
@MainActor
final class PageStates {
    struct Saved {
        let state: Any
        let address: String?
        /// A pin's saved page as its page was let go (`Page.savedPage`).
        var savedPage: URL?
    }

    /// The most tab states kept on disk, the oldest written going first:
    /// ten times the pages kept live (`Browser.livePages`), the tabs a
    /// person comes back to over days of use.
    nonisolated static let kept = 100

    /// Application Support, which the system never purges and the Files app
    /// never shows. Files take the app's default data protection, as its own
    /// copy of the shared folder does.
    nonisolated static let directory = URL.applicationSupportDirectory.appending(path: "PageStates", directoryHint: .isDirectory)

    private var held: [String: Saved] = [:]
    /// A digest of the state last written for each tab, so a page whose
    /// state has not changed since is not written again.
    private var written: [String: Int] = [:]
    private let disk: Disk

    init(directory: URL = PageStates.directory) {
        disk = Disk(directory: directory)
    }

    /// Keeps the state of a page let go for `id`, and on disk when it is a
    /// tab's that isn't private.
    func keep(_ id: String, state: Any, address: String?, isTab: Bool, isPrivate: Bool, savedPage: URL? = nil) {
        held[id] = Saved(state: state, address: address, savedPage: savedPage)
        guard let data = Self.onDisk(state, isTab: isTab, isPrivate: isPrivate) else {
            written[id] = nil
            disk.remove(id)
            return
        }
        write(id, data, address: address)
    }

    /// Writes the state of tab `id`'s live page, unless it is unchanged
    /// since its last write or kept off the disk. Returns whether it was
    /// written.
    @discardableResult
    func save(_ id: String, state: Any, address: String?, isTab: Bool, isPrivate: Bool) -> Bool {
        guard let data = Self.onDisk(state, isTab: isTab, isPrivate: isPrivate),
              written[id] != Self.digest(data) else { return false }
        write(id, data, address: address)
        return true
    }

    /// WebKit restores only the `Data` its own getter gives
    /// (`-[WKWebView setInteractionState:]`), so a state of any other type
    /// stays in memory, as a private tab's and a pin's do.
    private static func onDisk(_ state: Any, isTab: Bool, isPrivate: Bool) -> Data? {
        guard isTab, !isPrivate else { return nil }
        return state as? Data
    }

    private func write(_ id: String, _ data: Data, address: String?) {
        written[id] = Self.digest(data)
        disk.write(id, Disk.Stored(state: data, address: address))
    }

    private static func digest(_ data: Data) -> Int {
        var hasher = Hasher()
        data.withUnsafeBytes { hasher.combine(bytes: $0) }
        return hasher.finalize()
    }

    /// The state kept for `id`, from memory or disk.
    func saved(_ id: String) -> Saved? {
        if let saved = held[id] { return saved }
        return disk.read(id).map { Saved(state: $0.state, address: $0.address) }
    }

    /// The state kept for `id`, for a page made for it. The memory's copy
    /// is forgotten, as the page holds the state from there; the file stays
    /// until the page's own state replaces it, so the history survives the
    /// app ending before the page writes again.
    func take(_ id: String) -> Saved? {
        let saved = saved(id)
        held[id] = nil
        return saved
    }

    func forget(_ id: String) {
        held[id] = nil
        written[id] = nil
        disk.remove(id)
    }

    /// Forgets every state, on disk and in memory, but the in-memory
    /// states `keeping` names: what Clear Browsing Data clears. A write
    /// asked for before this call lands before it, and so goes with it.
    func forgetAll(keeping: (String) -> Bool) {
        held = held.filter { keeping($0.key) }
        written = [:]
        disk.removeAll()
    }

    /// Forgets every state but those `live` keeps in memory, and every file
    /// but the tabs' that `onDisk` keeps. `tabs` is how many tabs the tree
    /// holds, for the log.
    func keep(live: (String) -> Bool, onDisk: @escaping @Sendable (String) -> Bool, tabs: Int) {
        held = held.filter { live($0.key) }
        written = written.filter { onDisk($0.key) }
        disk.prune(keeping: onDisk, tabs: tabs)
    }

    /// How many states are on disk.
    func countOnDisk() -> Int { disk.count() }

    /// Runs `done` on the main thread once every write asked for so far has
    /// landed.
    func whenWritten(_ done: @escaping @MainActor @Sendable () -> Void) {
        disk.whenWritten(done)
    }
}

/// The files of `PageStates`, read and written on a queue of their own, in
/// the order asked: encoding and writing a state stays off the main
/// thread, and a read or a removal sees every write asked for before it.
private final class Disk: @unchecked Sendable {
    /// What one file holds.
    struct Stored: Codable {
        let state: Data
        let address: String?
    }

    private let directory: URL
    private let queue = DispatchQueue(label: "app.sval.ios.page-states", qos: .utility)

    init(directory: URL) {
        self.directory = directory
    }

    func write(_ id: String, _ stored: Stored) {
        queue.async { [self] in
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                var folder = directory
                try folder.setResourceValues(values)
                try PropertyListEncoder().encode(stored).write(to: file(id), options: .atomic)
            } catch {
                Diagnostics.log("tabs: a page's state was not saved: \(Diagnostics.name(error))")
                return
            }
            trim()
        }
    }

    func read(_ id: String) -> Stored? {
        queue.sync {
            guard let data = try? Data(contentsOf: file(id)) else { return nil }
            return try? PropertyListDecoder().decode(Stored.self, from: data)
        }
    }

    func remove(_ id: String) {
        queue.async { [self] in try? FileManager.default.removeItem(at: file(id)) }
    }

    func removeAll() {
        queue.async { [self] in
            let all = files()
            for (_, url) in all { try? FileManager.default.removeItem(at: url) }
            #if DEBUG
            Diagnostics.log("page states: cleared \(all.count) from disk")
            #endif
        }
    }

    func prune(keeping: @escaping @Sendable (String) -> Bool, tabs: Int) {
        queue.async { [self] in
            let all = files()
            let gone = all.filter { !($0.id.map(keeping) ?? false) }
            for (_, url) in gone { try? FileManager.default.removeItem(at: url) }
            #if DEBUG
            if !gone.isEmpty {
                Diagnostics.log("page states: \(gone.count) of \(all.count) removed, their tabs left the tree of \(tabs) tabs")
            }
            #endif
        }
    }

    func count() -> Int {
        queue.sync { files().count }
    }

    func whenWritten(_ done: @escaping @MainActor @Sendable () -> Void) {
        queue.async { DispatchQueue.main.async { done() } }
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

    /// Removes the oldest files past `PageStates.kept`.
    private func trim() {
        let all = files().map(\.url)
        guard all.count > PageStates.kept else { return }
        func written(_ url: URL) -> Date {
            (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
        }
        let past = all.sorted(by: { written($0) < written($1) }).dropLast(PageStates.kept)
        for url in past { try? FileManager.default.removeItem(at: url) }
        #if DEBUG
        Diagnostics.log("page states: \(past.count) past the bound of \(PageStates.kept) removed")
        #endif
    }
}
