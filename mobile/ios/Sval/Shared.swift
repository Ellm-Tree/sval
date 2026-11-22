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
        try Secrets.keychain.storeSmbPassword(Data(location.password.utf8))
    }

    static func load() -> SmbLocation? {
        guard let fields = UserDefaults.standard.dictionary(forKey: key) as? [String: String],
              let host = fields["host"], let share = fields["share"],
              let password = Secrets.keychain.smbPassword()
        else { return nil }
        return SmbLocation(
            host: host, share: share, path: fields["path"] ?? "",
            username: fields["username"] ?? "",
            password: String(decoding: password, as: UTF8.self))
    }

    static func forget() {
        UserDefaults.standard.removeObject(forKey: key)
        Secrets.keychain.forgetSmbPassword()
    }
}

/// One watch on a shared folder, through a Rust connector's watcher.
protocol ChangeWait: AnyObject, Sendable {
    /// Blocks until something in the folder changes, and returns the paths
    /// that changed, or none when the folder didn't say which. Nil once the
    /// watch is cancelled.
    func next() throws -> [String]?
    /// Ends the wait under way, as soon as the connector can, and every
    /// wait after it.
    func cancel()
}

extension SmbWatcher: ChangeWait {
    func next() throws -> [String]? {
        switch try wait() {
        case .changed(let paths): paths
        case .cancelled: nil
        }
    }
}

/// Reports changes to an SMB or Dropbox folder while the app is open, from a
/// thread of its own: the server holds a request until something below the
/// folder changes.
final class ChangeWatcher: @unchecked Sendable {
    private let name: String
    private let retry: TimeInterval
    private let open: @Sendable () throws -> ChangeWait?
    private let onChange: @MainActor ([String]) -> Void
    /// Guards `stopped` and `current`, and wakes the wait between watches.
    private let condition = NSCondition()
    private var stopped = false
    private var current: ChangeWait?

    /// `open` makes a watch, or nil when there is nothing to watch with.
    /// `retry` is how long to wait before watching again after a watch ends
    /// in an error, such as the phone leaving the network. `onChange` gets
    /// the paths that changed, or none when the folder didn't say which.
    init(
        name: String, retry: TimeInterval = 30,
        open: @escaping @Sendable () throws -> ChangeWait?,
        onChange: @escaping @MainActor ([String]) -> Void
    ) {
        self.name = name
        self.retry = retry
        self.open = open
        self.onChange = onChange
    }

    func start() {
        let thread = Thread { [self] in run() }
        thread.name = "\(name) watch"
        thread.start()
    }

    /// Cancels the watch, which ends its wait and closes its connection, and
    /// ends the wait between watches. A Dropbox long poll under way still
    /// runs out before its thread ends.
    func stop() {
        let watch = condition.withLock {
            stopped = true
            condition.broadcast()
            defer { current = nil }
            return current
        }
        watch?.cancel()
    }

    private var isStopped: Bool {
        condition.withLock { stopped }
    }

    /// Watches until `stop`. `start` runs it on a thread of its own.
    func run() {
        while true {
            do {
                guard let watch = try open() else { return }
                let adopted = condition.withLock {
                    if !stopped { current = watch }
                    return !stopped
                }
                guard adopted else {
                    watch.cancel()
                    return
                }
                Diagnostics.log("watch: \(name) watch started")
                while let paths = try watch.next(), !isStopped {
                    let onChange = onChange
                    Task { @MainActor in onChange(paths) }
                }
                Diagnostics.log("watch: \(name) watch stopped")
                return
            } catch {
                // A stop can end a wait with an error, which is no failure.
                guard !isStopped else { return }
                Diagnostics.log("watch: \(name) watch ended: \(Diagnostics.name(error))")
                guard !rest() else { return }
            }
        }
    }

    /// Waits `retry` seconds, or until `stop`, and says whether it stopped.
    private func rest() -> Bool {
        condition.withLock {
            let until = Date(timeIntervalSinceNow: retry)
            while !stopped, condition.wait(until: until) {}
            return stopped
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
        try Secrets.keychain.storeDropboxToken(token)
        UserDefaults.standard.set(root, forKey: key)
    }

    static func load() -> String? {
        guard Secrets.keychain.dropboxToken() != nil else { return nil }
        return UserDefaults.standard.string(forKey: key)
    }

    static func forget() {
        UserDefaults.standard.removeObject(forKey: key)
        Secrets.keychain.forgetDropboxToken()
    }
}

extension DropboxWatcher: ChangeWait {
    func next() throws -> [String]? {
        while true {
            switch try wait() {
            // Dropbox says that something changed, not what.
            case .changed: return []
            case .unchanged: continue
            case .cancelled: return nil
            }
        }
    }
}

/// A row is identified by its node id, so a sheet can present one.
extension OutlineRow: Identifiable {}
