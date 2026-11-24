// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import AVFoundation
import Foundation
import Security
import Observation
import UIKit

extension AppModel {
    /// Offers this phone's sync key to another device in the shared folder.
    func offerPairing() async throws -> Join.Offer {
        guard let key = secrets.syncKey() else { throw SyncError.notASvalFolder }
        let folder = try await sharedFolder()
        let offer = try await Task.detached { try Join.offer(key: key, in: folder) }.value
        Diagnostics.log("pair: offered")
        return offer
    }

    /// Whether the other device has taken `offer`: it deletes the file once
    /// it holds the key (`SvalPairing`'s `stillOffered`).
    func offerTaken(_ offer: Join.Offer) async -> Bool {
        guard let folder = try? await sharedFolder() else { return false }
        let still = try? await Task.detached { try folder.exists(offer.path) }.value
        return still == false
    }

    /// Takes back an offer nobody took.
    func withdraw(_ offer: Join.Offer) async {
        guard let folder = try? await sharedFolder() else { return }
        try? await Task.detached { try folder.delete(offer.path) }.value
        Diagnostics.log("pair: offer withdrawn")
    }

    /// Leaves the folder. The phone keeps browsing on its own copy, and
    /// keeps the sync key, so choosing the folder again syncs on with it.
    /// `startOver` also removes the key and everything the phone took from
    /// the folder, so a later join can't publish that into another folder.
    /// A pass still running goes on against the folder alone: once the
    /// syncer has left, nothing it holds reaches the own copy
    /// (`Syncer.leave`), and `sync` drops the pass's result.
    func leaveFolder(startOver: Bool) {
        UserDefaults.standard.removeObject(forKey: Self.bookmarkKey)
        SmbSettings.forget()
        DropboxSettings.forget()
        source = nil
        stage = .chooseFolder
        starting = false
        guard startOver else { return }
        secrets.forgetSyncKey()
        // The old syncer removes its copy itself, so no change it is still
        // applying writes after. One still loading from launch is left by
        // the same route once it is ready.
        let old = syncer
        let loading = loadingSyncer
        syncer = nil
        loadingSyncer = nil
        treeStore.reset()
        reindexLauncher()
        browser.refreshBar()
        // The folder's tabs and pins go with it, and so do their pages and
        // the pictures of them kept on disk.
        pinsByWorkspace = [:]
        browser.reconcile()
        PagePreviews.shared.keep(only: [])
        lastSynced = nil
        Task {
            do {
                var leaving = old
                if leaving == nil { leaving = try? await loading?.value }
                if let leaving { try await leaving.leave() } else { try Syncer.deleteLocalCopy(at: edges.ownCopy) }
                syncer = try await Task.detached { [ownCopy = edges.ownCopy, secrets] in
                    try Syncer.make(ownCopy: ownCopy, secrets: secrets)
                }.value
                // The phone browses on, in a fresh Workspace of its own.
                await refreshRows()
                await keepOwnWorkspace()
                if let own = ownWorkspace?.id { browser.showWorkspace(own) }
            } catch {
                message = error.localizedDescription
            }
        }
    }

    /// How often a join looks for the offer again (`CLAIM_POLL_MS` on the
    /// desktop): a code is usually typed before the provider has delivered
    /// the file.
    static let claimInterval: Duration = .seconds(5)

    /// Takes the sync key from a pairing code or a backup, then syncs. A
    /// pairing code keeps looking until the offer arrives or the user
    /// cancels.
    func join(code: String) async {
        joinTask?.cancel()
        let task = Task { await runJoin(code: code) }
        joinTask = task
        await task.value
    }

    func cancelJoin() {
        joinTask?.cancel()
        joinSleep?.cancel()
        waitingForOffer = false
        message = nil
    }

    private func runJoin(code: String) async {
        guard source != nil else { return }
        message = nil
        joinFailure = nil
        defer { waitingForOffer = false }
        do {
            if Codes.isPairingCode(code) {
                while true {
                    do {
                        try await claim(code: code)
                        break
                    } catch JoinError.noOffer {
                        Diagnostics.log("join: no offer yet")
                        waitingForOffer = true
                        message = "Waiting for the code to reach this \(UIDevice.current.model). Keep Sval open."
                        let sleep = Task { try await Task.sleep(for: Self.claimInterval) }
                        joinSleep = sleep
                        _ = try? await sleep.value
                        try Task.checkCancellation()
                    }
                }
            } else if let key = Codes.syncKey(fromBackup: code) {
                let folder = try await sharedFolder()
                guard try await Task.detached(operation: { try Join.matches(key: key, folder: folder) }).value else {
                    throw JoinError.backupForAnotherFolder
                }
                try secrets.storeSyncKey(key)
            } else {
                throw JoinError.notACode
            }
            message = nil
            keyUnconfirmed = false
            welcoming = true
            stage = .ready
            Diagnostics.log("join: key stored")
            await sync()
        } catch is CancellationError {
            Diagnostics.log("join: cancelled")
        } catch {
            Diagnostics.log("join: failed \(Diagnostics.name(error))")
            joinFailure = error as? JoinError
            message = error.localizedDescription
        }
    }

    private func claim(code: String) async throws {
        let folder = try await sharedFolder()
        // Argon2id makes each try cost tens of milliseconds and 64 MiB, and an
        // SMB folder waits on the network, so it runs off the main actor.
        let claimed = try await Task.detached { try Join.claim(code: code, in: folder) }.value
        try secrets.storeSyncKey(claimed.key)
        // The offer goes only once the key is stored, so a join cut short
        // can be retried with the same code. On SMB and Dropbox the delete
        // waits on the network.
        let offer = claimed.offer
        try? await Task.detached { try folder.delete(offer) }.value
    }

    /// Opens the chosen folder, if there is one, and watches it for changes.
    /// A picked folder stays open to the app for as long as it is chosen.
    func open(previous: Source?) {
        stopWatching()
        connected = nil
        if case .files(let url) = previous {
            url.stopAccessingSecurityScopedResource()
        }
        if case .files(let url) = source {
            _ = url.startAccessingSecurityScopedResource()
        }
        startWatching()
    }

    func stopWatching() {
        watcher?.stop()
        watcher = nil
        changeWatcher?.stop()
        changeWatcher = nil
    }

    /// Watches the folder for changes while the app is in the foreground.
    /// In the background, a held connection or a long poll would run for
    /// as long as iOS lets the app, playing audio included, for passes
    /// nobody sees; coming back runs a pass (`RootView`) and watches again.
    /// A cold launch into the foreground calls this from `init` and again on
    /// `willEnterForegroundNotification`, which UIKit posts as the launching
    /// scene comes to the foreground, so a watch already running is kept.
    func startWatching() {
        guard watcher == nil, changeWatcher == nil else { return }
        guard UIApplication.shared.applicationState != .background else { return }
        switch source {
        case .files(let url):
            let watcher = FolderWatcher(root: url) { [weak self] in self?.folderChanged($0) }
            watcher.start()
            self.watcher = watcher
        case .smb(let location):
            let watcher = ChangeWatcher(name: "SMB", open: { SmbWatcher(location: location) }) { [weak self] in
                self?.folderChanged($0)
            }
            watcher.start()
            changeWatcher = watcher
        case .dropbox(let root):
            let watcher = ChangeWatcher(
                name: "Dropbox",
                open: { [secrets] in
                    guard let token = secrets.dropboxToken() else { return nil }
                    return try DropboxWatcher.watch(appKey: DropboxApp.key, refreshToken: token, root: root)
                }
            ) { [weak self] in
                self?.folderChanged($0)
            }
            watcher.start()
            changeWatcher = watcher
        case nil:
            break
        }
    }

    /// The shared folder, connecting to an SMB server or Dropbox first if
    /// need be.
    func sharedFolder() async throws -> SharedFolder {
        if case .files(let url) = source {
            return edges.files(url)
        }
        if let connected {
            return connected
        }
        switch source {
        case .smb(let location):
            let folder = try await Task.detached { try SmbShared(folder: SmbFolder.connect(location: location)) }.value
            connected = folder
            return folder
        case .dropbox(let root):
            guard let token = secrets.dropboxToken() else { throw ConnectorError.DropboxSignIn }
            let folder = try await Task.detached {
                try DropboxShared(folder: DropboxFolder.connect(appKey: DropboxApp.key, refreshToken: token, root: root))
            }.value
            connected = folder
            return folder
        case .files, nil:
            throw SyncError.notASvalFolder
        }
    }

    /// The names this device writes in the folder: its own file in each
    /// document (`own_device_path`), and the temporary file an SMB write
    /// renames into place. The device id is the syncer's, read from the
    /// Keychain as it was made: only the syncer writes the own file.
    private var ownName: String? {
        syncer.map { $0.deviceHex + ".json" }
    }

    private func isOwn(_ path: String) -> Bool {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        return name == ownName || (name.hasPrefix(".") && name.hasSuffix(".writing"))
    }

    /// A change the watcher reported. One that names only this device's own
    /// writes brings nothing new. Any other starts a pass once the folder has
    /// been quiet for `settle`, or `settleLimit` after the first change, so a
    /// steady stream of changes never holds a pass off.
    private func folderChanged(_ paths: [String]) {
        if !paths.isEmpty, paths.allSatisfy(isOwn) {
            return
        }
        let now = ContinuousClock.now
        let first = firstChange ?? now
        firstChange = first
        let deadline = min(now + Self.settle, first + Self.settleLimit)
        settling?.cancel()
        settling = Task { [weak self] in
            try? await Task.sleep(until: deadline, clock: .continuous)
            guard !Task.isCancelled, let self else { return }
            firstChange = nil
            Diagnostics.log("watch: the folder changed")
            if waitingForOffer {
                joinSleep?.cancel()
            } else if stage == .ready, UIApplication.shared.applicationState != .background {
                await sync()
            }
        }
    }

    /// Where the shared folder is, for Settings: a short path, the whole
    /// address, and the user name an SMB server is signed in with.
    var folderPlace: (short: String, full: String, user: String?)? {
        switch source {
        case .files(let picked):
            let url = Folder(shared: picked).root
            let parts = url.standardizedFileURL.pathComponents
            // iCloud Drive's folders live under this container on disk.
            if let cloud = parts.firstIndex(of: "com~apple~CloudDocs") {
                let inside = Array(parts[(cloud + 1)...])
                return ((["iCloud Drive"] + inside).joined(separator: " › "), url.path, nil)
            }
            return (url.lastPathComponent, url.path, nil)
        case .smb(let location):
            let folders = location.path.split(separator: "/").map(String.init)
            let short = ([location.host, location.share] + folders).joined(separator: " › ")
            let full = "smb://" + ([location.host, location.share] + folders).joined(separator: "/")
            return (short, full, location.username)
        case .dropbox(let root):
            let folders = root.split(separator: "/").map(String.init)
            return ((["Dropbox"] + folders).joined(separator: " › "), "Dropbox" + (root.isEmpty ? "" : root), nil)
        case nil:
            return nil
        }
    }

    func chooseFolder(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        // A file provider's folder may still be downloading, so it is read
        // off the main actor, as `connectSmb` reads a server's.
        let secrets = secrets
        let (holdsSval, opens, bookmark) = await Task.detached {
            let folder = Folder(shared: url)
            return (folder.exists(topDir), Self.keyOpens(folder, key: secrets.syncKey()),
                    Result { try url.bookmarkData() })
        }.value
        do {
            UserDefaults.standard.set(try bookmark.get(), forKey: Self.bookmarkKey)
        } catch {
            message = error.localizedDescription
            return
        }
        source = .files(url)
        message = nil
        settle(holdsSval: holdsSval, opens: opens)
    }

    /// Connects to a folder on an SMB share, and keeps it as the shared
    /// folder once it holds Sval's data.
    @discardableResult
    func connectSmb(_ picked: SmbLocation) async -> Error? {
        message = nil
        let secrets = secrets
        // A path to Sval's own directory names the folder that holds it
        // (spec §6.4), and that folder is what is kept and shown.
        var location = picked
        location.path = sharedRootOf(path: picked.path)
        do {
            let (folder, holdsSval, opens) = try await Task.detached {
                let folder = try SmbShared(folder: SmbFolder.connect(location: location))
                return (folder, try folder.exists(topDir), Self.keyOpens(folder, key: secrets.syncKey()))
            }.value
            try SmbSettings.save(location)
            source = .smb(location)
            connected = folder
            settle(holdsSval: holdsSval, opens: opens)
            Diagnostics.log("smb: connected")
            return nil
        } catch {
            Diagnostics.log("smb: connect failed \(Diagnostics.name(error))")
            message = error.localizedDescription
            return error
        }
    }

    /// Keeps `root`, a folder in the Dropbox `token` signs in to, as the
    /// shared folder once it holds Sval's data.
    @discardableResult
    func connectDropbox(root picked: String, token: String) async -> Error? {
        message = nil
        let secrets = secrets
        // As `connectSmb` keeps its path.
        let root = sharedRootOf(path: picked)
        do {
            let (folder, holdsSval, opens) = try await Task.detached {
                let folder = try DropboxShared(folder: DropboxFolder.connect(appKey: DropboxApp.key, refreshToken: token, root: root))
                return (folder, try folder.exists(topDir), Self.keyOpens(folder, key: secrets.syncKey()))
            }.value
            try DropboxSettings.save(root: root, token: token)
            source = .dropbox(root)
            connected = folder
            settle(holdsSval: holdsSval, opens: opens)
            Diagnostics.log("dropbox: connected")
            return nil
        } catch {
            Diagnostics.log("dropbox: connect failed \(Diagnostics.name(error))")
            return error
        }
    }

    /// Whether `key`, the sync key this phone holds, if any, opens the Sval data
    /// in `folder`. A key kept from another folder, or one this folder has
    /// since replaced, opens nothing there: syncing with it writes files no
    /// other device reads and shows none of theirs. A folder that can't be
    /// read is taken as opened, so a failed read never costs the key.
    nonisolated static func keyOpens(_ folder: SharedFolder, key: Data?) -> Bool {
        guard let key else { return true }
        return (try? Join.matches(key: key, folder: folder)) ?? true
    }

    /// Moves setup on once a folder is chosen.
    private func settle(holdsSval: Bool, opens: Bool) {
        noteKey(opens: opens)
        stage = stage(holdsSval: holdsSval)
        if stage == .ready { Task { await sync() } }
    }

    private func noteKey(opens: Bool) {
        guard secrets.syncKey() != nil else { return }
        keyUnconfirmed = !opens
        if !opens { Diagnostics.log("join: the kept sync key opens nothing in this folder") }
    }

    func stage(holdsSval: Bool) -> Stage {
        Self.stage(hasKey: secrets.syncKey() != nil, keyUnconfirmed: keyUnconfirmed, holdsSval: holdsSval)
    }

    /// Where setup goes once a folder is chosen: a folder with Sval's data
    /// is joined, and an empty one can be started, with a kept key too, as
    /// the desktop moves sync to another folder. The user confirms a start,
    /// since a cloud folder still downloading can look empty. A kept key the
    /// folder didn't confirm joins it.
    nonisolated static func stage(hasKey: Bool, keyUnconfirmed: Bool, holdsSval: Bool) -> Stage {
        guard holdsSval else { return .start }
        if hasKey { return keyUnconfirmed ? .join : .ready }
        return .join
    }

    /// Starts syncing in the chosen folder, which holds no Sval data: this
    /// phone makes the sync key, and its first pass writes the folder's.
    /// A phone that kept its sync key starts with that key: its backup
    /// still holds, and setup goes straight to the browser.
    func startSync() {
        if secrets.syncKey() != nil {
            keyUnconfirmed = false
            starting = true
            stage = .ready
            Diagnostics.log("start: the kept sync key used")
            Task { await sync() }
            return
        }
        var key = Data(count: 32)
        let made = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard made == errSecSuccess else {
            message = "This \(UIDevice.current.model) couldn't make a sync key. Try again."
            return
        }
        do {
            try secrets.storeSyncKey(key)
        } catch {
            message = error.localizedDescription
            return
        }
        startedKey = key
        keyUnconfirmed = false
        starting = true
        Diagnostics.log("start: a sync key made")
    }

    /// Leaves the backup key behind and opens the browser on the new sync.
    func finishStart() async {
        startedKey = nil
        welcoming = true
        stage = .ready
        await sync()
    }

    static func resolveBookmark() -> URL? {
        guard let data = UserDefaults.standard.data(forKey: bookmarkKey) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale) else {
            return nil
        }
        if stale, let fresh = try? url.bookmarkData() {
            UserDefaults.standard.set(fresh, forKey: bookmarkKey)
        }
        return url
    }
}
