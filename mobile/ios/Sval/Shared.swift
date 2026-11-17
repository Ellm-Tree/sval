// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// The shared folder a pass reads and writes, wherever it is: a folder the
/// user picked in Files, a folder on an SMB share, or a folder in the user's
/// Dropbox (mobile spec §8.1).
/// Paths are relative to it, as the engine names them (`sval/ws/...`).
protocol SharedFolder: Sendable {
    /// The entries directly in `directory`. A directory that does not exist
    /// holds none.
    func list(_ directory: String) throws -> [String]
    /// The files directly in `directory`, with their sizes and times, for a
    /// caller that decides what to read before reading it.
    func files(_ directory: String) throws -> [FileEntry]
    /// Whether `path` exists. A folder it can't reach throws, so that is
    /// never taken for a folder without Sval's data.
    func exists(_ path: String) throws -> Bool
    func read(_ path: String) throws -> Data
    /// Writes so that no reader sees half of it.
    func write(_ path: String, _ data: Data) throws
    func delete(_ path: String) throws
    /// Renames the file at `from` to `to`, and refuses when anything is at
    /// `to`, so nothing is ever replaced.
    func move(_ from: String, to: String) throws
}

extension Folder: SharedFolder {}

/// Where the shared folder is.
enum Source: Equatable {
    case files(URL)
    case smb(SmbLocation)
    /// A folder in the user's Dropbox, by its Dropbox path (`/Sval`).
    case dropbox(String)
}

/// A folder on an SMB share, through the Rust connector. Each call blocks on
/// the network, so none is made on the main actor.
struct SmbShared: SharedFolder {
    let folder: SmbFolder

    func list(_ directory: String) throws -> [String] {
        try folder.list(directory: directory)
    }

    func files(_ directory: String) throws -> [FileEntry] {
        try folder.files(directory: directory)
    }

    func exists(_ path: String) throws -> Bool {
        try folder.exists(path: path)
    }

    func read(_ path: String) throws -> Data {
        try folder.read(path: path)
    }

    func write(_ path: String, _ data: Data) throws {
        try folder.write(path: path, bytes: data)
    }

    func delete(_ path: String) throws {
        try folder.delete(path: path)
    }

    func move(_ from: String, to: String) throws {
        try folder.moveFile(from: from, to: to)
    }
}

/// Where an SMB folder is, kept between launches. The password is kept in the
/// Keychain, apart from the rest.
enum SmbSettings {
    private static let key = "smbLocation"

    static func save(_ location: SmbLocation) throws {
        let fields = [
            "host": location.host, "share": location.share,
            "path": location.path, "username": location.username,
        ]
        UserDefaults.standard.set(fields, forKey: key)
        try Secrets.storeSmbPassword(Data(location.password.utf8))
    }

    static func load() -> SmbLocation? {
        guard let fields = UserDefaults.standard.dictionary(forKey: key) as? [String: String],
              let host = fields["host"], let share = fields["share"],
              let password = Secrets.smbPassword()
        else { return nil }
        return SmbLocation(
            host: host, share: share, path: fields["path"] ?? "",
            username: fields["username"] ?? "",
            password: String(decoding: password, as: UTF8.self))
    }

    static func forget() {
        UserDefaults.standard.removeObject(forKey: key)
        Secrets.forgetSmbPassword()
    }
}

/// Reports changes to an SMB folder while the app is open: the server holds a
/// change-notify request until something below the folder changes.
final class SmbChangeWatcher: @unchecked Sendable {
    private let location: SmbLocation
    private let onChange: @MainActor ([String]) -> Void
    private let lock = NSLock()
    private var stopped = false

    /// How long to wait before watching again after a watch ends in an error,
    /// such as the phone leaving the network.
    private static let retry: TimeInterval = 30

    /// `onChange` gets the paths that changed, or none when the server didn't
    /// say which.
    init(location: SmbLocation, onChange: @escaping @MainActor ([String]) -> Void) {
        self.location = location
        self.onChange = onChange
    }

    func start() {
        let thread = Thread { [self] in run() }
        thread.name = "SMB watch"
        thread.start()
    }

    func stop() {
        lock.withLock { stopped = true }
    }

    private var isStopped: Bool {
        lock.withLock { stopped }
    }

    private func run() {
        while !isStopped {
            do {
                let watcher = try SmbWatcher.watch(location: location)
                Diagnostics.log("watch: SMB watch started")
                while !isStopped {
                    let paths = try watcher.wait()
                    guard !isStopped else { return }
                    let onChange = onChange
                    Task { @MainActor in onChange(paths) }
                }
            } catch {
                Diagnostics.log("watch: SMB watch ended: \(Diagnostics.name(error))")
                Thread.sleep(forTimeInterval: Self.retry)
            }
        }
    }
}

/// Sval's app on Dropbox. The key is public: the app signs in with PKCE and
/// holds no secret.
enum DropboxApp {
    static let key = "94ncbej3k9vjzo7"
    /// Dropbox sends a phone app back through `db-<app key>`, as its own
    /// SDK does: a redirect it accepts without listing it on the app, which
    /// otherwise takes only HTTPS. The sign-in sheet catches it, so no other
    /// app is asked to open it.
    static let scheme = "db-\(key)"
    static let redirect = "db-\(key)://2/token"
}

/// A folder in the user's Dropbox, through the Rust connector. Each call
/// blocks on the network, so none is made on the main actor.
struct DropboxShared: SharedFolder {
    let folder: DropboxFolder

    func list(_ directory: String) throws -> [String] {
        try folder.list(directory: directory)
    }

    func files(_ directory: String) throws -> [FileEntry] {
        try folder.files(directory: directory)
    }

    func exists(_ path: String) throws -> Bool {
        try folder.exists(path: path)
    }

    func read(_ path: String) throws -> Data {
        try folder.read(path: path)
    }

    func write(_ path: String, _ data: Data) throws {
        try folder.write(path: path, bytes: data)
    }

    func delete(_ path: String) throws {
        try folder.delete(path: path)
    }

    func move(_ from: String, to: String) throws {
        try folder.moveFile(from: from, to: to)
    }
}

/// Which Dropbox folder is the shared folder, kept between launches. The
/// sign-in is kept in the Keychain, apart from it.
enum DropboxSettings {
    private static let key = "dropboxFolder"

    static func save(root: String, token: String) throws {
        try Secrets.storeDropboxToken(token)
        UserDefaults.standard.set(root, forKey: key)
    }

    static func load() -> String? {
        guard Secrets.dropboxToken() != nil else { return nil }
        return UserDefaults.standard.string(forKey: key)
    }

    static func forget() {
        UserDefaults.standard.removeObject(forKey: key)
        Secrets.forgetDropboxToken()
    }
}

/// Reports changes to a Dropbox folder while the app is open: Dropbox holds a
/// long-poll request until something below the folder changes.
final class DropboxChangeWatcher: @unchecked Sendable {
    private let root: String
    private let onChange: @MainActor ([String]) -> Void
    private let lock = NSLock()
    private var stopped = false

    /// How long to wait before watching again after a watch ends in an error,
    /// such as the phone going offline.
    private static let retry: TimeInterval = 30

    init(root: String, onChange: @escaping @MainActor ([String]) -> Void) {
        self.root = root
        self.onChange = onChange
    }

    func start() {
        let thread = Thread { [self] in run() }
        thread.name = "Dropbox watch"
        thread.start()
    }

    func stop() {
        lock.withLock { stopped = true }
    }

    private var isStopped: Bool {
        lock.withLock { stopped }
    }

    private func run() {
        while !isStopped {
            do {
                guard let token = Secrets.dropboxToken() else { return }
                let watcher = try DropboxWatcher.watch(appKey: DropboxApp.key, refreshToken: token, root: root)
                Diagnostics.log("watch: Dropbox watch started")
                while !isStopped {
                    guard try watcher.wait(), !isStopped else { continue }
                    // Dropbox says that something changed, not what.
                    let onChange = onChange
                    Task { @MainActor in onChange([]) }
                }
            } catch {
                Diagnostics.log("watch: Dropbox watch ended: \(Diagnostics.name(error))")
                Thread.sleep(forTimeInterval: Self.retry)
            }
        }
    }
}

/// A row is identified by its node id, so a sheet can present one.
extension OutlineRow: Identifiable {}
