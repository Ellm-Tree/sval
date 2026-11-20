// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// A directory Sval reads and writes: the shared folder the user picked, or
/// this app's own storage. Paths are relative to its root, as the engine
/// names them (`sval/ws/...`).
///
/// Every read and write is coordinated (`NSFileCoordinator`), which is what
/// makes a cloud provider download a file before it is read and upload one
/// after it is written.
struct Folder {
    let root: URL
    /// Where `topDir` and the paths under it live.
    private let svalDir: URL

    init(root: URL) {
        self.init(root: root, svalDir: root.appending(path: topDir, directoryHint: .isDirectory))
    }

    private init(root: URL, svalDir: URL) {
        self.root = root
        self.svalDir = svalDir
    }

    /// The shared folder the user picked. Sval's own directory inside it,
    /// picked in its place, serves as that directory: every path Sval reads
    /// and writes there is under `topDir`, and the picker grants nothing
    /// above the folder picked.
    init(shared url: URL) {
        if Self.isSvalDir(url) {
            self.init(root: url.deletingLastPathComponent(), svalDir: url)
        } else {
            self.init(root: url)
        }
    }

    /// Whether `url` is Sval's own directory in a shared folder, which
    /// holds the Workspaces, the pairing offers or the key backups, and no
    /// Sval directory of its own with Workspaces in it.
    static func isSvalDir(_ url: URL) -> Bool {
        guard url.lastPathComponent == topDir else { return false }
        let has = { (path: String) in
            FileManager.default.fileExists(atPath: url.appending(path: path).path(percentEncoded: false))
        }
        return !has("\(topDir)/ws") && (has("ws") || has("pair") || has("keys"))
    }

    private func fileURL(_ path: String) -> URL {
        if path == topDir { return svalDir }
        if path.hasPrefix("\(topDir)/") { return svalDir.appending(path: String(path.dropFirst(topDir.count + 1))) }
        return root.appending(path: path)
    }

    /// The files directly in `directory`, by path relative to the root. A
    /// directory that does not exist holds none.
    func list(_ directory: String) throws -> [String] {
        let url = fileURL(directory)
        var names: [String] = []
        var failure: Error?
        coordinate(reading: url) { url in
            do {
                names = try FileManager.default.contentsOfDirectory(atPath: url.path(percentEncoded: false))
            } catch CocoaError.fileReadNoSuchFile {
                names = []
            } catch {
                failure = error
            }
        }
        if let failure {
            throw failure
        }
        // A file iCloud has listed and not downloaded is asked for at once,
        // so that it is on the device by the time it is read.
        for name in names where Self.isPlaceholder(name) {
            if let real = Self.realName(name) {
                try? FileManager.default.startDownloadingUbiquitousItem(at: url.appending(path: real))
            }
        }
        return names.compactMap(Self.realName).map { "\(directory)/\($0)" }
    }

    /// The files `list` finds that are on this device, with their sizes
    /// and times. One iCloud has yet to download is left out until it is.
    func files(_ directory: String) throws -> [FileEntry] {
        try list(directory).compactMap { path in
            let url = fileURL(path)
            guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]),
                  values.isRegularFile == true, let size = values.fileSize else { return nil }
            let modified = values.contentModificationDate.map { Int64($0.timeIntervalSince1970 * 1000) } ?? 0
            return FileEntry(path: path, size: UInt64(size), modifiedMs: modified)
        }
    }

    func exists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: fileURL(path).path(percentEncoded: false))
    }

    func read(_ path: String) throws -> Data {
        let url = fileURL(path)
        var data: Data?
        var failure: Error?
        coordinate(reading: url) { url in
            do {
                data = try Data(contentsOf: url)
            } catch {
                failure = error
            }
        }
        if let failure {
            throw failure
        }
        return data ?? Data()
    }

    /// Writes `data` at `path` so that no reader sees half of it: a
    /// temporary file renamed over the old one (spec §6.3).
    func write(_ path: String, _ data: Data) throws {
        let url = fileURL(path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var failure: Error?
        var coordinationError: NSError?
        NSFileCoordinator().coordinate(
            writingItemAt: url, options: .forReplacing, error: &coordinationError
        ) { url in
            do {
                try data.write(to: url, options: .atomic)
            } catch {
                failure = error
            }
        }
        if let error = failure ?? coordinationError {
            throw error
        }
    }

    func delete(_ path: String) throws {
        let url = fileURL(path)
        var failure: Error?
        var coordinationError: NSError?
        NSFileCoordinator().coordinate(
            writingItemAt: url, options: .forDeleting, error: &coordinationError
        ) { url in
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                failure = error
            }
        }
        if let error = failure ?? coordinationError {
            throw error
        }
    }

    /// Renames the file at `from` to `to`. `FileManager.moveItem` stops
    /// when an item is at `to`, so nothing there is ever replaced.
    func move(_ from: String, to: String) throws {
        let source = fileURL(from)
        let target = fileURL(to)
        var failure: Error?
        var coordinationError: NSError?
        // The pairing `NSFileCoordinator.h` gives as the safe way to
        // coordinate a move.
        let coordinator = NSFileCoordinator()
        coordinator.coordinate(
            writingItemAt: source, options: .forMoving,
            writingItemAt: target, options: .forReplacing, error: &coordinationError
        ) { source, target in
            do {
                coordinator.item(at: source, willMoveTo: target)
                try FileManager.default.moveItem(at: source, to: target)
                coordinator.item(at: source, didMoveTo: target)
            } catch {
                failure = error
            }
        }
        if let error = failure ?? coordinationError {
            throw error
        }
    }

    private func coordinate(reading url: URL, _ body: (URL) -> Void) {
        var coordinationError: NSError?
        var ran = false
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) {
            ran = true
            body($0)
        }
        if !ran {
            body(url)
        }
    }

    /// A listed entry's real name. A file iCloud has not downloaded may be
    /// listed as `.<name>.icloud`; the coordinated read of `<name>` fetches it.
    private static func isPlaceholder(_ entry: String) -> Bool {
        entry.hasPrefix(".") && entry.hasSuffix(".icloud")
    }

    private static func realName(_ entry: String) -> String? {
        if isPlaceholder(entry) {
            return String(entry.dropFirst().dropLast(".icloud".count))
        }
        if entry.hasPrefix(".") {
            return nil
        }
        return entry
    }
}
