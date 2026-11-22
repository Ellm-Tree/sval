// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import UIKit

/// The document every screen shows: the `workspaces` document
/// (`SvalPanelModel.SYNC_DOCUMENT` on the desktop).
let workspacesDocument = "workspaces"

/// The synced settings (`SvalSettingsRegistry.SETTINGS_DOCUMENT`): the
/// phone reads its per-site JavaScript rules and blocking level from it.
let settingsDocument = "settings"

/// Favorites and pins (`SvalFavoritesStore`'s document).
let favoritesDocument = "favorites"

/// Sval's top directory in a shared folder and its mark: nothing is written
/// into a folder that does not hold it (`SvalEngine.TOP_DIR`).
let topDir = "sval"

/// The engine's passes for this device, as the desktop runs them
/// (local-copy spec §4.2): this device's own copy first, then the shared
/// folder, then the own copy again so it holds what the folder brought.
actor Syncer {
    /// The documents this device syncs, by name: the three every pass
    /// takes, the history index, and the history weeks loaded.
    private var documents: [String: SvalDocument] = [
        workspacesDocument: SvalDocument(), settingsDocument: SvalDocument(),
        favoritesDocument: SvalDocument(), HistoryWeeks.index: SvalDocument(),
    ]
    /// When this device last wrote each history week to the shared folder.
    private var publishedAt: [String: Date] = [:]
    /// What this device knows of the weeks, kept across launches under
    /// these keys.
    private var history = HistoryLedger()
    private static let mergedAtKey = "historyMergedAt"
    private static let unpublishedKey = "historyUnpublished"
    private static let deletionsKey = "historyDeletions"

    private nonisolated let deviceId: Data
    private let localKey: Data
    /// Every stamp this device's documents take (`docs/host-contract.md`
    /// §3).
    private var clock = StampClock()
    private let local: Folder

    init() throws {
        local = Folder(root: URL.applicationSupportDirectory)
        // No own copy yet, as on first run, after leaving the folder or after
        // the app is deleted and installed again. The Keychain's id outlives
        // the copy, and the phone keeps it (decision 2232).
        let fresh = !local.exists(topDir)
        deviceId = try Secrets.deviceId()
        if fresh { Diagnostics.log("sync: no own copy yet") }
        // What this device knows of the weeks goes with its own copy: a
        // fresh copy holds no week, and must load every one again.
        if fresh {
            UserDefaults.standard.removeObject(forKey: Self.mergedAtKey)
            UserDefaults.standard.removeObject(forKey: Self.unpublishedKey)
            UserDefaults.standard.removeObject(forKey: Self.deletionsKey)
        }
        history.mergedAt = UserDefaults.standard.dictionary(forKey: Self.mergedAtKey) as? [String: Double] ?? [:]
        history.unpublished = Set(UserDefaults.standard.stringArray(forKey: Self.unpublishedKey) ?? [])
        history.deletions = UserDefaults.standard.data(forKey: Self.deletionsKey)
            .flatMap { try? JSONDecoder().decode([HistoryLedger.Deletion].self, from: $0) } ?? []
        localKey = try Secrets.localKey()
        var refused = false
        for name in documents.keys {
            let report = try pass(name)
            refused = refused || report.refusesWrites
        }
        // The device id is a Keychain item that only a restore to another
        // phone leaves behind (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
        // An own copy restored beside it would be older than what the id
        // has published, and its first change would vouch for the gap as
        // seen, so peers would read what it lacks as deleted. Out of the
        // backup, a restored phone starts a fresh copy under a new id
        // (`docs/host-contract.md` §5).
        do {
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var copy = URL.applicationSupportDirectory.appending(path: topDir, directoryHint: .isDirectory)
            try copy.setResourceValues(values)
        } catch {
            Diagnostics.log("sync: the own copy is in the backup: \(Diagnostics.name(error))")
        }
        // The weeks this phone keeps that the index lists, and the current
        // week, which visits go into.
        let listed = Set(shards().map(\.name))
        for week in HistoryWeeks.window() where listed.contains(week) || week == HistoryWeeks.name(for: .now) {
            documents[week] = SvalDocument()
            refused = try pass(week).refusesWrites || refused
        }
        if refused { throw OwnCopyRefused() }
    }

    /// This device's syncer. An own copy holding a file that reads and does
    /// not open would refuse every later write to it, so changes made here
    /// would be lost at the next launch. The whole copy is set aside under
    /// `sval.damaged-<time>`, renamed and never deleted, and a fresh copy
    /// starts and takes everything back from the shared folder (decision
    /// 2232).
    static func make() throws -> Syncer {
        do {
            return try Syncer()
        } catch is OwnCopyRefused {
            let copy = URL.applicationSupportDirectory.appending(path: topDir, directoryHint: .isDirectory)
            let aside = URL.applicationSupportDirectory.appending(
                path: "\(topDir).damaged-\(Int64(Date.now.timeIntervalSince1970 * 1000))", directoryHint: .isDirectory)
            // `moveItem` stops when anything is at `aside`.
            try FileManager.default.moveItem(at: copy, to: aside)
            Diagnostics.log("sync: this device's own copy was set aside")
            return try Syncer()
        }
    }

    /// Loads document `name` from this device's own copy, once.
    private func open(_ name: String) throws {
        guard documents[name] == nil else { return }
        documents[name] = SvalDocument()
        _ = try pass(name)
    }

    /// The documents a pass runs, in order: the three every pass takes, the
    /// current week, the kept weeks whose index entry changed since this
    /// device merged them, at most `coldPerPass`, newest first, the weeks
    /// changed here and not yet written, at most `coldPerPass` weeks a
    /// Delete Page has not reached, and the index last, so it
    /// carries what the weeks' publishing touched (history-sync spec §4.1).
    private func passNames() throws -> [String] {
        let current = HistoryWeeks.name(for: .now)
        try open(current)
        let weeks = history.weeks(current: current, kept: Set(HistoryWeeks.window()), listed: shards())
        for week in weeks { try open(week) }
        return [workspacesDocument, settingsDocument, favoritesDocument, current] + weeks + [HistoryWeeks.index]
    }

    /// Carries every Delete Page that has not reached week `name` into it,
    /// once a pass has merged it. Its removals are written to the folder by
    /// a later pass.
    private func carryDeletions(into name: String) throws {
        guard !history.deletions.isEmpty else { return }
        for index in history.deletionsNotIn(name) {
            try removeVisits(to: history.deletions[index].url, in: name)
            history.deletions[index].done.append(name)
        }
        remember(try JSONEncoder().encode(history.deletions), forKey: Self.deletionsKey)
    }

    /// Removes the visits to `url` that week `name` holds, from every
    /// device, and returns how many went.
    @discardableResult
    private func removeVisits(to url: String, in name: String) throws -> Int {
        guard let document = documents[name] else { return 0 }
        let visits = ((try? document.visitsJson()).flatMap {
            try? JSONDecoder().decode([Visit].self, from: Data($0.utf8))
        } ?? []).filter { $0.url == url }
        guard !visits.isEmpty else { return 0 }
        let json = try JSONSerialization.data(withJSONObject: visits.map { ["kind": "remove", "id": $0.id] })
        try edit(name, opsJson: String(decoding: json, as: UTF8.self))
        publishedAt[name] = nil
        return visits.count
    }

    /// Whether this pass writes document `name` to the shared folder. The
    /// current week waits `publishEvery` between writes, the first after it
    /// loads aside; every other document is written each time it changes.
    private func publishes(_ name: String) -> Bool {
        guard name == HistoryWeeks.name(for: .now), let last = publishedAt[name] else { return true }
        return Date.now.timeIntervalSince(last) >= HistoryWeeks.publishEvery
    }

    /// Notes a pass that merged `name`, and, for a week it wrote, records
    /// in the index that this device wrote to it. `held` is a week that had
    /// something to write and waits its interval.
    private func passed(_ name: String, wrote: Bool, held: Bool) throws {
        let current = HistoryWeeks.name(for: .now)
        let saves = history.passed(name, held: held, current: current) { shards().map(\.name) }
        if saves.contains(.deletions) {
            remember(try JSONEncoder().encode(history.deletions), forKey: Self.deletionsKey)
        }
        if saves.contains(.unpublished) { remember(Array(history.unpublished), forKey: Self.unpublishedKey) }
        if saves.contains(.mergedAt) { remember(history.mergedAt, forKey: Self.mergedAtKey) }
        guard HistoryWeeks.isWeek(name) else { return }
        try carryDeletions(into: name)
        if history.unloads(name, window: HistoryWeeks.window(), current: current) {
            documents[name] = nil
        }
        guard wrote else { return }
        Diagnostics.log("history: wrote a week to the folder")
        publishedAt[name] = .now
        try edit(HistoryWeeks.index, opsJson: #"[{"kind":"touchShard","name":"\#(name)"}]"#)
    }

    /// One pass against the shared folder, between two passes of the own
    /// copy. Reading and writing the shared folder go over the network and
    /// can take seconds, so they run off the actor: it holds only the merge,
    /// and a change the user makes meanwhile never waits on the network.
    nonisolated func sync(shared: SharedFolder, syncKey: Data, starting: Bool = false) async throws -> SyncReport {
        // A folder this phone starts syncing in has no Sval data until its
        // first pass writes some.
        guard try starting || shared.exists(topDir) else {
            throw SyncError.notASvalFolder
        }
        // The Workspaces document's report is the one the app shows; the
        // others' problems are added to it.
        var report: SyncReport?
        do {
            for name in try await passNames() {
                try await syncDocument(name, shared: shared, syncKey: syncKey, into: &report)
            }
        } catch SyncError.ownFileUnreadable {
            throw SyncError.ownFileUnreadable
        } catch {
            // A pass that stops short saw no document's own file, and time
            // the folder is out of reach does not count (decision 1144).
            await clearOwnUnread(except: nil)
            throw error
        }
        return report!
    }

    /// One document's part of a pass, its problems added to `report`.
    private nonisolated func syncDocument(_ name: String, shared: SharedFolder, syncKey: Data,
                                          into report: inout SyncReport?) async throws {
        let read: Read
        do {
            read = try Self.read(name, in: shared, key: syncKey, deviceId: deviceId)
        } catch SyncError.ownFileUnreadable {
            // Only this document's own file was seen this pass.
            await clearOwnUnread(except: name)
            try await setAsideIfDue(name, in: shared, key: syncKey)
            throw SyncError.ownFileUnreadable
        }
        var (this, write) = try await merge(name, read: read, key: syncKey)
        let publish = await publishes(name)
        if let write, publish {
            try shared.write(write.path, write.bytes)
        }
        this.wrote = write != nil && publish
        try await passed(name, wrote: this.wrote, held: write != nil && !publish)
        if var first = report {
            first.errors += this.errors
            first.schemaTooNew += this.schemaTooNew
            first.unreadable += this.unreadable
            first.wrote = first.wrote || this.wrote
            report = first
        } else {
            report = this
        }
        if this.refusesWrites {
            try await setAsideIfDue(name, in: shared, key: syncKey)
        } else {
            await clearOwnUnread(name)
        }
    }

    /// How long each document's own file in the shared folder has been
    /// unreadable.
    private var ownUnread = OwnFileWatch()

    /// How long this device's own file may stay unreadable before it is
    /// set aside (`OWN_FILE_SET_ASIDE_MS`, decision 1144): the time covers
    /// a cloud provider still downloading it.
    static let ownFileSetAside: TimeInterval = 10 * 60

    private func clearOwnUnread(except name: String?) {
        ownUnread.clear(except: name)
    }

    private func clearOwnUnread(_ name: String) {
        ownUnread.clear(name)
    }

    /// Notes that document `name`'s own file is unreadable, and returns the
    /// stamp to set it aside under once it has been for `ownFileSetAside`.
    private func ownUnreadDue(_ name: String) -> Double? {
        guard ownUnread.unreadable(name, at: .now) else { return nil }
        return clock.now()
    }

    /// Renames this device's own file of document `name` to
    /// `<name>.damaged-<time>` once it has stayed unreadable for
    /// `ownFileSetAside`, so the next pass writes a fresh one from the own
    /// copy, which holds everything it did (decision 1144). Nothing is
    /// replaced or deleted, so each set-aside keeps a copy of its own. The
    /// name ends past the suffix every device file shares, so no pass reads
    /// it as a device's file. The user is told nothing: only Sval can
    /// repair it.
    private nonisolated func setAsideIfDue(_ name: String, in shared: SharedFolder, key: Data) async throws {
        guard let at = await ownUnreadDue(name) else { return }
        let own = try devicePath(key: key, workspace: name, deviceId: deviceId)
        do {
            try shared.move(own, to: "\(own).damaged-\(Int64(at))")
            await clearOwnUnread(name)
            Diagnostics.log("sync: this device's file in the folder was set aside")
        } catch {
            Diagnostics.log("sync: this device's file in the folder was not set aside: \(Diagnostics.name(error))")
        }
    }

    /// What one document's files in `folder` hold: every device's file that
    /// could be read, and the paths that couldn't.
    struct Read: Sendable {
        let files: [PeerFile]
        let unreadable: [String]
    }

    private nonisolated static func read(_ name: String, in folder: SharedFolder, key: Data, deviceId: Data) throws -> Read {
        let prefix = try syncPrefix(key: key, workspace: name)
        let own = try devicePath(key: key, workspace: name, deviceId: deviceId)
        var files: [PeerFile] = []
        var unreadable: [String] = []
        for path in try folder.list(prefix)
        where try isDeviceFile(key: key, workspace: name, path: path) {
            do {
                files.append(PeerFile(path: path, bytes: try folder.read(path)))
            } catch {
                // This device's own file that exists and cannot be read stops
                // the pass: merging without it would publish a state that has
                // lost what only it holds (`docs/host-contract.md` §1).
                if path == own {
                    // A folder out of reach says nothing of the file.
                    switch error as? ConnectorError {
                    case .Unreachable?, .DropboxUnreachable?: throw error
                    default: throw SyncError.ownFileUnreadable
                    }
                }
                unreadable.append(path)
            }
        }
        return Read(files: files, unreadable: unreadable)
    }

    /// The merge of a shared pass, between passes of the own copy, which is
    /// on this device's disk: what the folder's files bring, and the file to
    /// write back there, if any.
    private func merge(_ name: String, read: Read, key: Data) throws -> (SyncReport, (path: String, bytes: Data)?) {
        _ = try pass(name)
        history.merging(name)
        let result = try documents[name]!.sync(
            key: key, deviceId: deviceId, workspace: name,
            files: read.files, now: clock.now(), shared: true)
        var report = try JSONDecoder().decode(SyncReport.self, from: Data(result.reportJson.utf8))
        clock.atLeast(report.ownWatermark)
        report.unreadable = read.unreadable
        _ = try pass(name)
        guard let path = result.writePath, let bytes = result.writeBytes else { return (report, nil) }
        return (report, (path, bytes))
    }

    /// A pass against this device's own copy, on its own disk.
    private func pass(_ name: String) throws -> SyncReport {
        guard !left else {
            return SyncReport(merged: 0, errors: [], schemaTooNew: [], ownWatermark: 0, refusedWrite: false)
        }
        let read = try Self.read(name, in: local, key: localKey, deviceId: deviceId)
        let result = try documents[name]!.sync(
            key: localKey, deviceId: deviceId, workspace: name,
            files: read.files, now: clock.now(), shared: false)
        if let path = result.writePath, let bytes = result.writeBytes {
            try local.write(path, bytes)
        }
        var report = try JSONDecoder().decode(SyncReport.self, from: Data(result.reportJson.utf8))
        clock.atLeast(report.ownWatermark)
        report.unreadable = read.unreadable
        report.wrote = result.writePath != nil
        return report
    }

    /// Applies one change the user made here to document `name`, all of it
    /// or none, and saves the own copy at once. The shared folder gets it on
    /// the next pass.
    func edit(_ name: String, opsJson: String) throws {
        try open(name)
        try documents[name]!.applyBatch(
            opsJson: opsJson, deviceId: deviceId, now: clock.now())
        _ = try pass(name)
        if HistoryWeeks.isWeek(name) {
            if history.changed(name) {
                remember(Array(history.unpublished), forKey: Self.unpublishedKey)
            }
        }
    }

    /// The pins each of `workspaces` shows, by its id, in the row's order,
    /// and the favorites' revision they were read at.
    func pins(workspaces: [String]) -> (revision: UInt64, pins: [String: [PinRow]]) {
        let document = documents[favoritesDocument]!
        return (document.revision(), document.pinsAll(workspaces: workspaces))
    }

    /// The revision of each document a refresh reads.
    func revisions() -> Revisions {
        Revisions(workspaces: documents[workspacesDocument]!.revision(),
                  settings: documents[settingsDocument]!.revision(),
                  favorites: documents[favoritesDocument]!.revision())
    }

    /// The weeks the history index lists, newest first.
    private func shards() -> [HistoryShard] {
        guard let json = try? documents[HistoryWeeks.index]!.shardsJson() else { return [] }
        return (try? JSONDecoder().decode([HistoryShard].self, from: Data(json.utf8))) ?? []
    }

    /// The visits of each week loaded, each decoded once per listing.
    private var weekReads = WeekReads()

    /// Every week loaded, with its visits from every device.
    func weeks() -> [String: HistoryWeek] {
        var weeks: [String: HistoryWeek] = [:]
        for (name, document) in documents where HistoryWeeks.isWeek(name) {
            weeks[name] = weekReads.visits(of: name, in: document)
        }
        weekReads.keep(only: Set(weeks.keys))
        return weeks
    }

    /// Adds the visit this device made to `url`, into its week, and keeps
    /// this device's newest `visitsPerPage` visits to the page there,
    /// removing older ones, which reaches every device as their deletion
    /// (history-sync spec §4.1). Returns the visit's id.
    func addVisit(url: String, title: String, transition: UInt32, at: Date, workspace: String?) throws -> String {
        let week = HistoryWeeks.name(for: at)
        try open(week)
        let ms = (at.timeIntervalSince1970 * 1000).rounded()
        var op: [String: Any] = ["kind": "addVisit", "url": url, "title": title, "transition": transition, "visitedAt": ms]
        op["workspace"] = workspace
        let id = try visitId(deviceId: deviceId, url: url, visitedAt: ms)
        let own = deviceId.map { String(format: "%02x", $0) }.joined()
        let mine = weekReads.visits(of: week, in: documents[week]!).visits
            .filter { $0.url == url && $0.device == own && $0.id != id }
        let over = max(mine.count + 1 - HistoryWeeks.visitsPerPage, 0)
        let removals: [[String: Any]] = mine.prefix(over).map { ["kind": "remove", "id": $0.id] }
        let json = try JSONSerialization.data(withJSONObject: [op] + removals)
        try edit(week, opsJson: String(decoding: json, as: UTF8.self))
        return id
    }

    /// Deletes every visit to `url`, from every device, in the weeks loaded,
    /// and in every other week as passes merge it (history-sync spec §2,
    /// "Delete Page"). Each deletion reaches the other devices; a week it
    /// changes is written to the folder on the next pass, without waiting
    /// its interval. Returns how many visits went from the weeks loaded.
    func deleteVisits(to url: String) throws -> Int {
        var count = 0
        for name in documents.keys where HistoryWeeks.isWeek(name) {
            count += try removeVisits(to: url, in: name)
        }
        history.deletions.append(HistoryLedger.Deletion(url: url, done: []))
        remember(try JSONEncoder().encode(history.deletions), forKey: Self.deletionsKey)
        return count
    }

    /// Sets a visit's title, in the week it was made.
    func setVisitTitle(_ id: String, title: String, at: Date) throws {
        let json = try JSONSerialization.data(withJSONObject: [["kind": "setVisitTitle", "id": id, "title": title]])
        try edit(HistoryWeeks.name(for: at), opsJson: String(decoding: json, as: UTF8.self))
    }

    /// This device's id in hex, as settings and visits name a device.
    /// This device's id, which marks its own Workspace (decision 2254).
    nonisolated var device: Data { deviceId }

    nonisolated var deviceHex: String { deviceId.map { String(format: "%02x", $0) }.joined() }

    /// Every favorite, folder and separator, and the revision they were
    /// read at.
    func favorites() -> (revision: UInt64, favorites: [Favorite]) {
        let document = documents[favoritesDocument]!
        return (document.revision(), document.favoriteRows())
    }

    /// Set once this device leaves the folder. A change already waiting on
    /// this syncer then writes nothing: written after the copy went, it
    /// would be read by the next syncer as a peer's file under the same
    /// local key and carry this folder's data into the next one joined.
    private var left = false

    /// Leaves the folder: removes the own copy, and nothing this syncer
    /// holds reaches the disk after it.
    func leave() throws {
        left = true
        try Self.deleteLocalCopy()
    }

    /// Keeps a history bookmark for the next launch, while this syncer's
    /// own copy lasts.
    private func remember(_ value: Any, forKey key: String) {
        guard !left else { return }
        UserDefaults.standard.set(value, forKey: key)
    }

    /// Removes this device's own copy of every document.
    static func deleteLocalCopy() throws {
        let url = URL.applicationSupportDirectory.appending(path: topDir, directoryHint: .isDirectory)
        if FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) {
            try FileManager.default.removeItem(at: url)
        }
    }

    func outline() -> [OutlineRow] {
        documents[workspacesDocument]!.outline()
    }

    /// The tree's rows that changed after `revision`, or all of them.
    func treeRead(since revision: UInt64?) -> TreeRead {
        documents[workspacesDocument]!.treeRead(since: revision)
    }

    /// The synced settings, and the revision they were read at.
    func settings() -> (revision: UInt64, settings: [String: Any]) {
        let document = documents[settingsDocument]!
        return (document.revision(), document.syncedSettings())
    }
}

/// The fields of the engine's report this app shows (`docs/host-contract.md`
/// §7).
struct SyncReport: Decodable {
    var merged: Int
    var errors: [Problem]
    var schemaTooNew: [Problem]
    /// This device's own watermark once the pass is done, which its next
    /// stamps stay above (decision 1714).
    var ownWatermark: Double
    /// This device's own file exists and could not be read, so the pass
    /// wrote nothing over it.
    var refusedWrite: Bool
    /// The peer files that exist and could not be read.
    var unreadable: [String] = []
    var wrote = false

    /// Whether this device's own file reads and does not open, which the
    /// engine never writes over. One a newer build wrote is that build's
    /// to replace, and is left as it is.
    var refusesWrites: Bool {
        refusedWrite && !schemaTooNew.contains(where: \.own)
    }

    /// Every file this pass could not use.
    var problems: Set<String> {
        // This device's own file is set aside without a word (decision
        // 1144), so it is never one the user is told about.
        Set(errors.filter { !$0.own }.map(\.path) + schemaTooNew.map(\.path) + unreadable)
    }

    struct Problem: Decodable {
        var path: String
        /// Whether it is this device's own file.
        var own: Bool
    }

    enum CodingKeys: String, CodingKey {
        case merged, errors, schemaTooNew, ownWatermark, refusedWrite
    }
}

/// This device's own copy holds a file that reads and does not open.
private struct OwnCopyRefused: Error {}

enum SyncError: LocalizedError {
    case notASvalFolder
    case ownFileUnreadable

    var errorDescription: String? {
        switch self {
        case .notASvalFolder:
            return "This folder has no Sval data. Choose the folder your other devices sync through."
        case .ownFileUnreadable:
            // Read by AppModel alone, on the main actor.
            let device = MainActor.assumeIsolated { UIDevice.current.model }
            return "This \(device)'s own file in the folder can't be read yet. Sval will try again."
        }
    }
}

/// One favorite, folder or separator, as the engine's `favorites_json`
/// writes it.
struct Favorite: Decodable, Equatable, Identifiable {
    let id: String
    let kind: String
    let guid: String?
    let parent: String?
    let name: String
    let url: String?
    /// Whether it carries the pin flag pins had before the pins root
    /// (pins-root spec §8), which the pass that moves them clears.
    let marked: Bool
    /// Whether it's a pin: a node under the pins root, at any depth
    /// (pins-root spec §4). `AppModel` sets it once every row is read.
    var pinned = false
    /// The Workspaces a pin shows in, or nil for every one.
    let pinScope: [String]?
    let local: Bool
    /// When it was added, in milliseconds since the epoch, and when its
    /// content last changed, which stands in for a favorite with no date.
    let added: Double?
    let contentAt: Double

    private enum CodingKeys: String, CodingKey {
        case id, kind, guid, parent, name, url, pinScope, local, added, contentAt
        case marked = "pinned"
    }
}

/// What this device knows of the history weeks between passes, and which
/// weeks a pass loads, writes and lets go of from it: `Syncer`'s history
/// bookkeeping, apart from the documents and the disk.
struct HistoryLedger {
    /// The index's `changedAt` for each history week when this device last
    /// merged it from the shared folder, so a pass takes only the weeks
    /// whose entry differs. Each device stamps the entries it touches, so
    /// they are compared with each other, never with this phone's clock,
    /// which can be ahead of the device that wrote them.
    var mergedAt: [String: Double] = [:]
    /// Each week's `changedAt` as the pass in progress read the index.
    var listedAt: [String: Double] = [:]
    /// The weeks changed here and not yet written to the shared folder. A
    /// past week is passed only when another device touches it, so one
    /// this device changed, or one that stopped being current before its
    /// last visits were written, waits here until a pass writes it.
    var unpublished: Set<String> = []
    /// How many changes each week has taken here this run, and the count a
    /// pass's merge held, so a change made while the pass waits on the
    /// folder keeps its week unpublished.
    var changes: [String: Int] = [:]
    var changesMerged: [String: Int] = [:]
    /// Each Delete Page made here, until it has reached every week: the
    /// visits to its address can be in any week, and a week holds another
    /// device's visits only once a pass has merged it (`SvalHistorySync`'s
    /// deletions).
    var deletions: [Deletion] = []

    struct Deletion: Codable, Equatable {
        let url: String
        /// The weeks merged since, which it has reached.
        var done: [String]
    }

    /// What a pass changed that outlasts a launch.
    struct Saves: OptionSet {
        let rawValue: Int
        static let deletions = Saves(rawValue: 1)
        static let unpublished = Saves(rawValue: 2)
        static let mergedAt = Saves(rawValue: 4)
    }

    /// The weeks a pass takes after `current`, in order: the `kept` weeks
    /// whose index entry changed since this device merged them, at most
    /// `coldPerPass`, newest first, the weeks changed here and not yet
    /// written, and at most `coldPerPass` weeks a Delete Page has not
    /// reached. The index goes last, so it carries what the weeks'
    /// publishing touched (history-sync spec §4.1).
    mutating func weeks(current: String, kept: Set<String>, listed: [HistoryShard]) -> [String] {
        listedAt = Dictionary(listed.map { ($0.name, $0.changedAt) }, uniquingKeysWith: max)
        let cold = listed
            .filter { kept.contains($0.name) && $0.name != current && $0.changedAt != mergedAt[$0.name] }
            .prefix(HistoryWeeks.coldPerPass)
            .map(\.name)
        let changed = unpublished.subtracting(cold + [current]).sorted(by: >)
        let known = knownWeeks(listed: listed.map(\.name), current: current)
        let deleting = Set(deletions.flatMap { known.subtracting($0.done) })
            .subtracting(cold + changed + [current]).sorted(by: >)
            .prefix(HistoryWeeks.coldPerPass)
        return cold + changed + deleting
    }

    /// Every week a Delete Page must reach: the weeks any device has
    /// published, as the index lists them, those this device has changed
    /// and not written, and the current one. The index is another
    /// device's writing too, so only a week's name counts.
    func knownWeeks(listed: [String], current: String) -> Set<String> {
        Set(listed).union(unpublished).union([current]).filter(HistoryWeeks.isWeek)
    }

    /// Notes a change made here to week `name`. Returns whether the week
    /// had been written.
    mutating func changed(_ name: String) -> Bool {
        changes[name, default: 0] += 1
        return unpublished.insert(name).inserted
    }

    /// Notes that a pass's merge of `name` holds every change made so far.
    mutating func merging(_ name: String) {
        changesMerged[name] = changes[name]
    }

    /// Notes a pass that merged `name`. `held` is a week that had something
    /// to write and waits its interval. Each Delete Page that has reached
    /// every week goes once the pass has merged the index, since a week
    /// another device published is known only from then; `listed` reads
    /// the index's weeks.
    mutating func passed(_ name: String, held: Bool, current: String, listed: () -> [String]) -> Saves {
        var saves: Saves = []
        if name == HistoryWeeks.index, !deletions.isEmpty {
            let known = knownWeeks(listed: listed(), current: current)
            deletions.removeAll { known.isSubset(of: $0.done) }
            saves.insert(.deletions)
        }
        guard HistoryWeeks.isWeek(name) else { return saves }
        if !held, changes[name] == changesMerged[name], unpublished.remove(name) != nil {
            saves.insert(.unpublished)
        }
        // Merged as of the index this pass read: an entry another device
        // touches during the pass differs at the next one.
        if let at = listedAt[name] {
            mergedAt[name] = at
            saves.insert(.mergedAt)
        }
        return saves
    }

    /// The Delete Pages that have not reached week `name`, by index.
    func deletionsNotIn(_ name: String) -> [Int] {
        deletions.indices.filter { !deletions[$0].done.contains(name) }
    }

    /// Whether week `name`, outside the kept `window`, was loaded to write
    /// or delete in it and has nothing left to do there.
    func unloads(_ name: String, window: [String], current: String) -> Bool {
        !window.contains(name) && name != current && !unpublished.contains(name)
            && !deletions.contains(where: { !$0.done.contains(name) })
    }
}

/// When each document's own file in the shared folder was first seen
/// unreadable, while it has been on every pass since.
struct OwnFileWatch {
    private(set) var since: [String: Date] = [:]

    /// Notes that document `name`'s own file is unreadable at `now`, and
    /// returns whether it has been for `Syncer.ownFileSetAside`.
    mutating func unreadable(_ name: String, at now: Date) -> Bool {
        guard let first = since[name] else {
            since[name] = now
            return false
        }
        return now.timeIntervalSince(first) >= Syncer.ownFileSetAside
    }

    /// Forgets every document but `name`: a pass that saw only that one's
    /// own file, or none, says nothing of the others.
    mutating func clear(except name: String?) {
        since = since.filter { $0.key == name }
    }

    /// Forgets `name`, whose own file read or was set aside.
    mutating func clear(_ name: String) {
        since[name] = nil
    }
}
