// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import XCTest
@testable import Sval

/// A key store held in memory, which stands in for the Keychain.
final class MemoryKeys: KeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]

    func find(account: String) throws -> Data? {
        lock.withLock { items[account] }
    }

    func store(_ data: Data, account: String) throws {
        lock.withLock { items[account] = data }
    }

    func delete(account: String) {
        lock.withLock { items[account] = nil }
    }
}

/// `MemoryFolder` behind a lock: the model's passes and the other device's
/// run on threads of their own.
final class LockedFolder: SharedFolder, @unchecked Sendable {
    private let lock = NSLock()
    private let folder = MemoryFolder()

    /// Cuts the folder off, as one out of reach: every call throws.
    func cutOff() {
        lock.withLock { folder.failure = ConnectorError.Unreachable(message: "") }
    }

    func list(_ directory: String) throws -> [String] { try lock.withLock { try folder.list(directory) } }
    func files(_ directory: String) throws -> [FileEntry] { try lock.withLock { try folder.files(directory) } }
    func exists(_ path: String) throws -> Bool { try lock.withLock { try folder.exists(path) } }
    func read(_ path: String) throws -> Data { try lock.withLock { try folder.read(path) } }
    func write(_ path: String, _ data: Data) throws { try lock.withLock { try folder.write(path, data) } }
    func delete(_ path: String) throws { try lock.withLock { try folder.delete(path) } }
    func move(_ from: String, to: String) throws { try lock.withLock { try folder.move(from, to: to) } }
}

/// A real `AppModel`, with its real `Syncer`, engine and `Browser`, over a
/// shared folder in memory, a key store in memory, an own copy in a
/// directory of the test's own and a network that answers nothing, beside
/// a second device: a real `Syncer` on the same folder.
@MainActor
final class AppHarness {
    let folder = LockedFolder()
    let keys = MemoryKeys()
    let syncKey = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    /// The phone's own copy.
    let ownCopy: URL
    /// The folder the phone picked in Files, which the model watches. Its
    /// passes go to `folder`.
    let picked: URL
    /// Where the phone's blocker keeps the lists it downloaded.
    let lists: URL
    /// Where the phone keeps its tabs' page states, across launches.
    let pageStates: URL
    /// The other device.
    let peer: Syncer
    private(set) var model: AppModel!

    init(_ test: XCTestCase) throws {
        ownCopy = try temporaryDirectory(test)
        picked = try temporaryDirectory(test)
        lists = try temporaryDirectory(test)
        pageStates = try temporaryDirectory(test).appending(path: "PageStates", directoryHint: .isDirectory)
        try keys.store(syncKey, account: "sync-key")
        peer = try Syncer.make(ownCopy: try temporaryDirectory(test), secrets: Secrets(store: MemoryKeys()))
    }

    /// The other device's edit to `document`, and its pass, which writes it
    /// to the folder. Its first pass makes the folder's Sval data.
    func peerEdits(_ ops: [[String: Any]], in document: String = workspacesDocument) async throws {
        let json = try JSONSerialization.data(withJSONObject: ops)
        try await peer.edit(document, opsJson: String(decoding: json, as: UTF8.self))
        try await peerSyncs()
    }

    func peerSyncs() async throws {
        _ = try await peer.sync(shared: folder, syncKey: syncKey, starting: true)
    }

    /// Launches the phone, as `init()` does with the app's own edges, and
    /// waits until `ready`. By default that is the end of a first launch:
    /// it opens on this phone's own Workspace, and the last thing it does
    /// is name this device's kind for the others. `made` sees the model
    /// before its launch runs.
    @discardableResult
    func launch(_ made: (AppModel) -> Void = { _ in },
                ready: ((AppModel) -> Bool)? = nil) async throws -> AppModel {
        let folder = folder, lists = lists, picked = picked, keys = keys, pageStates = pageStates
        let model = AppModel(edges: AppModel.Edges(
            ownCopy: ownCopy, secrets: Secrets(store: keys),
            source: { .files(picked) },
            files: { _ in folder },
            blocker: { ContentBlocker(directory: lists, download: { _, _ in .failed }) },
            pageStates: pageStates))
        self.model = model
        made(model)
        // Read only once the syncer has made it: asking `Secrets` for it
        // first would race the syncer's load to make one.
        let kindKnown = {
            guard let id = try? keys.find(account: "device-id") else { return false }
            return model.settings["sval.device.kind.\(id.map { String(format: "%02x", $0) }.joined())"] != nil
        }
        let launched = ready ?? { model in
            kindKnown() && model.ownWorkspace != nil && model.browser.workspaceId == model.ownWorkspace?.id
        }
        try await until("the launch ran: kind \(kindKnown()), own \(model.ownWorkspace?.id ?? "none"), shown \(model.browser.workspaceId ?? "none"), in front \(model.browser.currentTabId ?? "none")") {
            launched(model)
        }
        await pass()
        await model.browser.blocker.settled()
        return model
    }

    /// Lets go of the model once no pass of its runs. A pass a change
    /// queued starts later, and finds the folder out of reach before it
    /// reads or writes anything, as a pass does (`Syncer.sync`).
    func quit() async throws {
        guard let model else { return }
        // The model lives on past its quit, so a write it had queued would
        // land after the next launch read the folder. An app that ends
        // lands nothing after.
        await model.browser.statesWritten()
        // The model and its browser hold each other, so without this the
        // pages outlive the quit, each with its web content process, and
        // those of every earlier test pile up through a run. An app that
        // ends frees its pages.
        for page in model.browser.pages.values { page.close() }
        model.browser.pages.removeAll()
        folder.cutOff()
        try await until("the passes end") { !model.syncing }
        self.model = nil
    }

    /// One whole pass of the phone's, begun after any pass already running
    /// ends, so it reads what the folder holds now.
    func pass() async {
        try? await until("the pass under way ends") { !self.model.syncing }
        await model.sync()
    }

    /// The tree as the phone's own copy holds it, read whole by a document
    /// of its own.
    func savedRows() throws -> [OutlineRow] {
        let local = Folder(root: ownCopy)
        let key = try XCTUnwrap(try keys.find(account: "local-key"))
        let prefix = try syncPrefix(key: key, workspace: workspacesDocument)
        let files = try local.list(prefix)
            .filter { try isDeviceFile(key: key, workspace: workspacesDocument, path: $0) }
            .map { PeerFile(path: $0, bytes: try local.read($0)) }
        let document = SvalDocument()
        _ = try document.sync(key: key, deviceId: Data(repeating: 0xEE, count: 16), workspace: workspacesDocument,
                              files: files, now: Date.now.timeIntervalSince1970 * 1000, shared: false)
        return document.outline()
    }

    /// Returns once `condition` holds, and fails the test when it hasn't
    /// within `limit`. It checks every few milliseconds and sleeps between,
    /// so the main thread and a core stay free for the work it waits on:
    /// web processes launching, and the replies the main thread handles.
    func until(_ what: @autoclosure () -> String, limit: Duration = .seconds(10),
               _ condition: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + limit
        while !condition() {
            guard ContinuousClock.now < deadline else {
                XCTFail("timed out: \(what())")
                throw CancellationError()
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    nonisolated static func id() -> String { UUID().uuidString.lowercased() }
}

/// Each test starts from an empty standard defaults domain, as a fresh
/// install does, and gives back the one it found: the model, its browser,
/// its syncer and its blocker keep their state there.
@MainActor
class AppModelTestCase: XCTestCase {
    private var savedDefaults: [String: Any]?
    private let domain = Bundle.main.bundleIdentifier ?? "app.sval.ios"
    var harness: AppHarness!

    override func setUp() async throws {
        savedDefaults = UserDefaults.standard.persistentDomain(forName: domain)
        UserDefaults.standard.removePersistentDomain(forName: domain)
        let harness = try AppHarness(self)
        self.harness = harness
        // Teardown blocks run last added first, so the model stops before
        // the harness's directories go.
        addTeardownBlock { @MainActor in try? await harness.quit() }
    }

    override func tearDown() async throws {
        harness = nil
        UserDefaults.standard.setPersistentDomain(savedDefaults ?? [:], forName: domain)
    }
}
