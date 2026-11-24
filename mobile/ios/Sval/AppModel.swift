// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import AVFoundation
import Foundation
import Security
import Observation
import UIKit

/// What the app knows and shows: the folder, whether this device has the
/// sync key, and the workspaces from the last pass.
@MainActor
@Observable
final class AppModel {
    enum Stage {
        /// No shared folder: the phone browses on its own copy alone, and
        /// setup is an offer.
        case chooseFolder
        /// The folder has no Sval data: this phone can start syncing in it.
        case start
        case join
        case ready
    }

    private(set) var stage: Stage = .chooseFolder {
        didSet { if stage == .ready { settingUp = false } }
    }
    /// Whether the phone browses on its own copy: once it syncs, and before
    /// it has a folder at all. A default browser opens on a place to type
    /// an address (Apple's "Preparing your app to be the default browser"),
    /// so a phone with no folder browses too.
    var browsing: Bool { stage == .ready || stage == .chooseFolder }
    /// Whether the user has setup open. It opens by itself on the first
    /// launch alone, and from Settings after that.
    var settingUp = false {
        // Only closing setup counts as offering it: a launch with a folder,
        // or the demo's, leaves a later launch without one its first run.
        didSet { if oldValue, !settingUp { UserDefaults.standard.set(true, forKey: Self.offeredSetupKey) } }
    }
    private static let offeredSetupKey = "offeredSetup"
    /// Setup asked for from Settings, which opens once the sheet Settings
    /// is in has gone: one presentation can't open over another.
    var setUpRequested = false
    /// Whether setup shows over the browser: while the user has it open, on
    /// a folder chosen and not yet synced, and on the Workspaces arriving
    /// after a join.
    var showsSetup: Bool {
        welcoming || stage == .start || stage == .join || (settingUp && stage == .chooseFolder)
    }
    /// The tree as of the last refresh, with a box for each row.
    let treeStore = TreeStore()
    /// Every toast and notice the app shows.
    let toasts = Toasts()
    var rows: [OutlineRow] { treeStore.index.rows }
    /// `rows`' lookups, built once per change. Views read it on every
    /// frame the bar folds, where a walk of `rows` per lookup adds up.
    var tree: OutlineIndex { treeStore.index }
    /// The synced settings, as of the last pass or change.
    private(set) var settings: [String: Any] = [:] {
        didSet {
            launcherSettings = LauncherIndex.Settings(settings)
            myFilters = MyFilters.Lines(settings: settings)
            reindexLauncher()
            updateBlocker()
            browser?.refreshBar()
        }
    }
    /// My filters' lines, parsed once per change of `settings`.
    @ObservationIgnored private(set) var myFilters = MyFilters.Lines(settings: [:])
    /// The pages history holds, from every device, best first by frecency.
    private(set) var historyPages: [HistoryPage] = [] {
        didSet { reindexLauncher() }
    }
    /// Every favorite, folder and separator, from the favorites document.
    private(set) var favorites: [Favorite] = [] {
        didSet { if favorites != oldValue { reindexLauncher() } }
    }
    /// Each Workspace's pins, in the row's order (pins spec §4, §7).
    private(set) var pinsByWorkspace: [String: [PinRow]] = [:] {
        didSet {
            if pinsByWorkspace != oldValue { reindexLauncher() }
            browser?.refreshBar()
        }
    }
    /// What the Launcher searches, built from the rows, pins, Favorites,
    /// history and settings after each change to them.
    private(set) var launcherIndex = LauncherIndex.empty
    /// History's share of `launcherIndex`, prepared with `historyPages`.
    @ObservationIgnored private var launcherHistory = LauncherIndex.History.empty
    /// `historyPages` by address, as of the last read of the weeks.
    @ObservationIgnored private var historyStore = HistoryStore()
    /// The settings' share of `launcherIndex`, read with `settings`.
    @ObservationIgnored private var launcherSettings = LauncherIndex.Settings([:])
    /// The shares `launcherIndex` was last built from.
    @ObservationIgnored private var launcherParts = LauncherParts()
    @ObservationIgnored private var indexing: Task<Void, Never>?
    @ObservationIgnored private var indexBuilds = 0
    private(set) var lastSynced: Date?
    /// Read by `sync` alone, so no view observes it.
    @ObservationIgnored private(set) var syncing = false
    var message: String?
    /// The live pages. Made at the end of `init`, since it holds this model.
    @ObservationIgnored private(set) var browser: Browser!

    private var syncer: Syncer? {
        didSet { if syncer !== oldValue { marks = ReadMarks() } }
    }
    /// What the refresh last read of `syncer`'s documents beside the tree.
    @ObservationIgnored private var marks = ReadMarks()
    /// The engine's load at launch: its Keychain reads and the pass over
    /// each document's own copy run off the main thread, and what needs
    /// the engine waits for it (`loadedSyncer`).
    @ObservationIgnored private var loadingSyncer: Task<Syncer, Error>?
    private var source: Source? {
        didSet {
            // Runs from `init` too: `@Observable` makes the assignment there
            // go through the setter.
            guard source != oldValue else { return }
            open(previous: oldValue)
        }
    }
    private var watcher: FolderWatcher?
    /// The SMB or Dropbox folder's watcher.
    private var changeWatcher: ChangeWatcher?
    /// The connection to an SMB or Dropbox folder, made on first use and
    /// again after one fails.
    private var connected: SharedFolder?
    /// The files the last pass could not use.
    private var lastProblems: Set<String> = []
    /// When the folder stopped answering, while it hasn't since.
    private(set) var unreachableSince: Date?
    /// How long the folder may go unanswered before the app says so, as the
    /// desktop's `FOLDER_UNAVAILABLE_AFTER_MS` (decision 0032): blips are
    /// normal on every folder Sval supports.
    static let unavailableAfter: TimeInterval = 3 * 60
    /// Whether a change arrived during a pass, which then runs again.
    private var syncAgain = false
    private static let bookmarkKey = "sharedFolderBookmark"
    /// How often a pass runs while the app is open (`SHARED_INTERVAL_MS` on
    /// the desktop).
    static let interval: Duration = .seconds(30)

    /// What the model reaches outside the app's process through.
    struct Edges {
        /// The directory this device's own copy is in.
        let ownCopy: URL
        let secrets: Secrets
        /// The shared folder kept from an earlier launch, read once at
        /// launch.
        let source: @MainActor () -> Source?
        /// The folder a pass reads and writes for a folder picked in Files.
        let files: @Sendable (URL) -> SharedFolder
        let blocker: @MainActor () -> ContentBlocker
        /// The directory the tabs' page states are kept in (`PageStates`).
        let pageStates: URL

        /// The app's own: Application Support, the Keychain, the folder
        /// chosen at an earlier launch and the blocking lists' publishers.
        static var app: Edges {
            Edges(
                ownCopy: .applicationSupportDirectory, secrets: .keychain,
                source: {
                    #if DEBUG
                    let demo = Demo.source()
                    #else
                    let demo: Source? = nil
                    #endif
                    return demo ?? AppModel.resolveBookmark().map(Source.files)
                        ?? SmbSettings.load().map(Source.smb)
                        ?? DropboxSettings.load().map(Source.dropbox)
                },
                files: { Folder(shared: $0) },
                blocker: { ContentBlocker(formerStore: .default()) },
                pageStates: PageStates.directory)
        }
    }

    private let edges: Edges
    private var secrets: Secrets { edges.secrets }

    convenience init() {
        #if DEBUG
        Demo.resetIfAsked()
        #endif
        self.init(edges: .app)
    }

    init(edges: Edges) {
        self.edges = edges
        DesktopColor.warm()
        loadingSyncer = Task.detached(priority: .userInitiated) { [ownCopy = edges.ownCopy, secrets = edges.secrets] in
            try Syncer.make(ownCopy: ownCopy, secrets: secrets)
        }
        source = edges.source()
        if case .files(let url) = source, secrets.syncKey() == nil || keyUnconfirmed {
            stage = stage(holdsSval: Folder(shared: url).exists(topDir))
        } else {
            stage = source == nil ? .chooseFolder : (secrets.syncKey() == nil || keyUnconfirmed ? .join : .ready)
        }
        settingUp = stage == .chooseFolder && !UserDefaults.standard.bool(forKey: Self.offeredSetupKey)
        browser = Browser(model: self, blocker: edges.blocker(), states: PageStates(directory: edges.pageStates))
        KagiPrivacyPass.shared.start()
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.stopWatching()
                // iOS may end the app in the background without a word, so
                // held titles are written as it goes there, as a desktop
                // window writes its own as it closes.
                Task { await self?.writeHeldTitles() }
            }
        }
        TitleHold.shared.onDue = { [weak self] id in
            Task { await self?.writeHeldTitles([id]) }
        }
        visitTitleHold.onDue = { [weak self] url in
            guard let held = self?.heldVisitTitles.removeValue(forKey: url) else { return }
            Task { try? await self?.syncer?.setVisitTitle(held.id, title: held.title, at: held.at) }
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.startWatching()
                self?.updateBlocker(always: true)
            }
        }
        if LaunchOption.given("-svalPlaybackSession") {
            do {
                try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
                Diagnostics.log("launch: audio session set to playback")
            } catch {
                Diagnostics.log("launch: audio session refused: \(Diagnostics.name(error))")
            }
        }
        #if DEBUG
        let options = LaunchOption.all
        Diagnostics.log("launch: developer options \(options.isEmpty ? "none" : options.joined(separator: " "))")
        let missing = ["Outfit", "JetBrains Mono"].filter { UIFont.fontNames(forFamilyName: $0).isEmpty }
        Diagnostics.log("launch: fonts \(missing.isEmpty ? "loaded" : "missing \(missing.joined(separator: ", "))")")
        #endif
        Task {
            _ = await loadedSyncer()
            await refreshRows()
            updateBlocker()
            await keepOwnWorkspace()
            #if DEBUG
            await Demo.fill(self)
            #endif
            // Sval opens on this phone's own Workspace (round 6).
            if let own = ownWorkspace?.id { browser.showWorkspace(own) }
            await refreshHistory()
            await nameThisDevice()
            #if DEBUG
            if PrivacyCheck.requested { await PrivacyCheck.run(self) }
            #endif
        }
    }

    /// The engine, once its load at launch is done; nil when it failed.
    private func loadedSyncer() async -> Syncer? {
        if let syncer { return syncer }
        guard let loading = loadingSyncer else { return nil }
        do {
            let loaded = try await loading.value
            // Leaving the folder meanwhile made a new one.
            if syncer == nil { syncer = loaded }
        } catch {
            if syncer == nil { message = error.localizedDescription }
        }
        loadingSyncer = nil
        return syncer
    }

    // MARK: Launcher

    /// Builds `launcherIndex` again off the main thread. A pass sets several
    /// of its inputs in turn, and only the build after the last one lands.
    private func reindexLauncher() {
        indexing?.cancel()
        indexing = Task { [weak self] in
            await Task.yield()
            guard let self, !Task.isCancelled else { return }
            indexBuilds += 1
            let generation = indexBuilds
            let tabs = rows.filter { $0.kind == .tab }.map { row in
                LauncherIndex.TabInput(row: row, title: row.title, workspace: self.tree.workspace(of: row.id),
                                       isPrivate: self.isPrivate(row.id))
            }
            let pins = pinsByWorkspace
            let favorites = favorites
            let history = launcherHistory
            let settings = launcherSettings
            let before = launcherParts
            let (index, parts) = await Task.detached(priority: .userInitiated) {
                var parts = before
                let index = parts.index(generation: generation, tabs: tabs, pins: pins, favorites: favorites,
                                        history: history, settings: settings)
                return (index, parts)
            }.value
            guard !Task.isCancelled else { return }
            launcherParts = parts
            launcherIndex = index
        }
    }

    // MARK: Blocking

    /// The blocker's inputs as of its last check, nil before the first.
    @ObservationIgnored private var blockerInputs: BlockerInputs?

    /// Has the blocker check its rules when its inputs changed, or
    /// `always`, as on a return to the foreground, where a list may have
    /// fallen due. The blocker takes the synced settings, so it waits for
    /// the engine.
    private func updateBlocker(always: Bool = false) {
        guard syncer != nil else { return }
        let inputs = BlockerInputs(settings: settings)
        guard always || inputs != blockerInputs else { return }
        blockerInputs = inputs
        browser.blocker.update(inputs)
    }

    // MARK: History

    /// Reads history's pages again, after a pass or a visit made here.
    func refreshHistory() async {
        guard let syncer else { return }
        let refresh = Signposts.history.beginInterval("refreshHistory")
        let reading = Signposts.history.beginInterval("visits")
        let weeks = await syncer.weeks()
        Signposts.history.endInterval("visits", reading, "\(weeks.count) weeks")
        let ranking = Signposts.history.beginInterval("pages")
        let before = historyStore
        // Compared with what is shown, which a refresh that overlapped this
        // one may have set from other weeks.
        let shown = historyPages
        let (store, prepared) = await Task.detached(priority: .userInitiated) {
            var store = before
            store.update(weeks)
            return (store, store.pages != shown ? LauncherIndex.History(store.pages) : nil)
        }.value
        Signposts.history.endInterval("pages", ranking, "\(store.pages.count) pages")
        historyStore = store
        if let prepared, store.pages != historyPages {
            launcherHistory = prepared
            historyPages = store.pages
        }
        Signposts.history.endInterval("refreshHistory", refresh)
        Diagnostics.log("history: \(store.visitCount) visits, \(historyPages.count) pages")
    }

    /// Records a visit this phone made, in its week (history-sync spec
    /// §4.1), and returns its id, so a title that comes later can be set.
    func recordVisit(url: URL, title: String, transition: UInt32, workspace: String?) async -> String? {
        guard let syncer, Self.opensHere(url.absoluteString) else { return nil }
        do {
            let id = try await syncer.addVisit(
                url: url.absoluteString, title: title, transition: transition, at: .now, workspace: workspace)
            await refreshHistory()
            return id
        } catch {
            Diagnostics.log("history: a visit was not recorded: \(Diagnostics.name(error))")
            return nil
        }
    }

    /// Deletes a page from history, on every device.
    func deleteFromHistory(_ url: String) async {
        guard let syncer else { return }
        do {
            let count = try await syncer.deleteVisits(to: url)
            Diagnostics.log("history: deleted a page's \(count) visits")
            await refreshHistory()
            Task { await sync() }
        } catch {
            Diagnostics.log("history: a page was not deleted: \(Diagnostics.name(error))")
        }
    }

    /// Sets the title of visit `id` to `url`. A page's title set soon after
    /// the last one written waits for its hold, as `SvalHistorySync` holds
    /// them by address, and then writes its latest.
    func setVisitTitle(_ id: String, url: String, title: String, at: Date) async {
        guard visitTitleHold.admit(url, name: nil) else {
            heldVisitTitles[url] = (id, title, at)
            return
        }
        try? await syncer?.setVisitTitle(id, title: title, at: at)
    }

    @ObservationIgnored private let visitTitleHold = TitleHold()
    /// The latest title held back for each address, with its visit.
    @ObservationIgnored private var heldVisitTitles: [String: (id: String, title: String, at: Date)] = [:]

    /// Names this phone for the other devices, once: their History shows
    /// its visits under the name (history-sync spec §3.1). iOS gives apps
    /// the model's name, such as "iPhone".
    private func nameThisDevice() async {
        guard let syncer else { return }
        let key = "sval.device.name.\(syncer.deviceHex)"
        if settings[key] == nil {
            await setSetting(key, to: UIDevice.current.name)
        }
        // Whether this is a phone or a tablet, so every device draws its
        // Workspace with that device's mark.
        let kindKey = "sval.device.kind.\(syncer.deviceHex)"
        let kind = UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "phone"
        if settings[kindKey] as? String != kind {
            await setSetting(kindKey, to: kind)
        }
    }

    /// Opens the chosen folder, if there is one, and watches it for changes.
    /// A picked folder stays open to the app for as long as it is chosen.
    private func open(previous: Source?) {
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

    private func stopWatching() {
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
    private func startWatching() {
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
    private func sharedFolder() async throws -> SharedFolder {
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

    /// How long the folder must be quiet before a change starts a pass, and
    /// the longest a pass waits for that once a change has arrived. Saving a
    /// file is several changes within a fraction of a second, and a pass that
    /// runs before the last of them can find the file half-written.
    static let settle: Duration = .seconds(1)
    static let settleLimit: Duration = .seconds(5)
    private var firstChange: ContinuousClock.Instant?
    private var settling: Task<Void, Never>?

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

    var workspaces: [OutlineRow] {
        rows.filter { $0.depth == 0 && !privateIds.contains($0.id) }
    }

    /// The Workspaces as the Workspace sheet's strip shows them: this
    /// phone's own, the user's, other devices', then each agent's.
    var workspaceSections: WorkspaceSections {
        let agents = workspaces.filter { $0.agent != nil }
        var seen = Set<String>()
        let names = agents.compactMap(agentName).filter { seen.insert($0).inserted }
        return WorkspaceSections(
            own: ownWorkspace,
            people: workspaces.filter { $0.agent == nil && $0.device == nil },
            devices: workspaces.filter { $0.agent == nil && isOtherDevices($0) },
            agents: names.map { name in (name, agents.filter { agentName($0) == name }) })
    }

    // MARK: This device's Workspace

    /// This phone's own Workspace (decision 2254): where it opens, and
    /// where a new tab goes when another device's Workspace is in front.
    var ownWorkspace: OutlineRow? {
        guard let me = syncer?.device else { return nil }
        return workspaces.first { $0.device == me }
    }

    /// Whether tabs in this Workspace can be put in groups: every one but
    /// the private session's, a device's own Workspace included
    /// (decision 2254).
    func makesGroups(in workspace: String?) -> Bool {
        guard let workspace, row(workspace) != nil else { return false }
        return !isPrivate(workspace)
    }

    /// What an agent's Workspaces go under: the agent's label, then the
    /// device that paired the agent once its name has arrived, as the
    /// desktop's `agentLabelOf` reads for another device (agent-control spec
    /// §3.5). An agent pairs with a computer, so on the phone it is always
    /// another device. Nil for a Workspace that is no agent's.
    func agentName(_ row: OutlineRow) -> String? {
        guard let label = row.agent else { return nil }
        let name = label.trimmingCharacters(in: .whitespaces).isEmpty ? "An agent" : label
        guard let device = row.agentDevice,
              let other = settings["sval.device.name.\(device.map { String(format: "%02x", $0) }.joined())"] as? String,
              !other.isEmpty
        else { return name }
        return "\(name) · \(other)"
    }

    /// The mark a Workspace wears in place of an emoji, as on the desktop:
    /// an agent's app's mark, or the robot for an app Sval doesn't know, and
    /// a phone or a tablet for a device's own, as that device says it is.
    /// Nil for the user's own Workspaces.
    func markImage(_ row: OutlineRow) -> String? {
        if let label = row.agent { return AgentBrands.image(for: label) ?? "agent-robot" }
        guard let device = row.device else { return nil }
        let hex = device.map { String(format: "%02x", $0) }.joined()
        return settings["sval.device.kind.\(hex)"] as? String == "tablet" ? "device-tablet" : "device-phone"
    }

    /// Whether `row` is another device's own Workspace.
    func isOtherDevices(_ row: OutlineRow) -> Bool {
        guard let device = row.device else { return false }
        return device != syncer?.device
    }

    /// Where a new tab opens from the Workspace in front: there, unless
    /// it's another device's, when it opens in this phone's own.
    func newTabWorkspace(from id: String?) -> String? {
        if let id, let row = row(id), !isOtherDevices(row) { return id }
        return ownWorkspace?.id ?? workspaces.first?.id
    }

    #if DEBUG
    /// A tab at the end of `parent`, for the demo tree.
    func demoTab(_ name: String, _ url: String, in parent: String) async -> String? {
        let id = UUID().uuidString.lowercased()
        var op: [String: Any] = ["kind": "addTab", "parent": parent, "name": name, "url": url, "id": id]
        op["before"] = children(of: parent).last?.id
        return await edit([op]) ? id : nil
    }

    /// A split of `tabs`, each a name and an address, for the demo tree.
    func demoSplit(_ tabs: [(String, String)], in parent: String) async -> String? {
        let id = UUID().uuidString.lowercased()
        var split: [String: Any] = ["kind": "addSplit", "parent": parent, "name": "", "id": id]
        split["before"] = children(of: parent).last?.id
        var ops = [split]
        var previous: String?
        for (name, url) in tabs {
            let tab = UUID().uuidString.lowercased()
            var add: [String: Any] = ["kind": "addTab", "parent": id, "name": name, "url": url, "id": tab]
            add["before"] = previous
            ops.append(add)
            previous = tab
        }
        return await edit(ops) ? id : nil
    }
    #endif

    @ObservationIgnored private var makingOwnWorkspace = false

    /// Makes this phone's own Workspace when it has none: on first run, or
    /// after another device deleted it, when it comes back empty under a
    /// new id (decision 2254).
    private func keepOwnWorkspace() async {
        await foldOwnWorkspaces()
        guard browsing, syncer != nil, ownWorkspace == nil, !makingOwnWorkspace else { return }
        makingOwnWorkspace = true
        defer { makingOwnWorkspace = false }
        let id = UUID().uuidString.lowercased()
        if await edit([["kind": "addDeviceWorkspace", "name": UIDevice.current.name, "id": id]]) {
            Diagnostics.log("workspaces: made this device's own Workspace")
        }
    }

    /// Folds every Workspace of this phone's own into the first. A phone
    /// that starts over makes a fresh one before it joins again, and the
    /// folder then brings back the one its device id made before
    /// (decision 2232), where each phone keeps one (decision 2254).
    private func foldOwnWorkspaces() async {
        guard let me = syncer?.device else { return }
        let mine = workspaces.filter { $0.device == me }
        guard let keep = mine.first, mine.count > 1 else { return }
        if await edit(Self.foldOps(mine, in: tree)) {
            Diagnostics.log("workspaces: folded \(mine.count - 1) more of this device's own into one")
            if let shown = browser.workspaceId, mine.dropFirst().contains(where: { $0.id == shown }) {
                browser.showWorkspace(keep.id)
            }
        }
    }

    /// The edits that move what every Workspace after the first in `mine`
    /// holds to the end of the first, in order, and remove the others.
    nonisolated static func foldOps(_ mine: [OutlineRow], in tree: OutlineIndex) -> [[String: Any]] {
        guard let keep = mine.first else { return [] }
        var ops: [[String: Any]] = []
        var last = tree.children(of: keep.id).last?.id
        for extra in mine.dropFirst() {
            for child in tree.children(of: extra.id) {
                var move: [String: Any] = ["kind": "moveNode", "id": child.id, "newParent": keep.id]
                move["before"] = last
                ops.append(move)
                last = child.id
            }
            ops.append(["kind": "remove", "id": extra.id])
        }
        return ops
    }

    // MARK: Private session

    /// The private session's tree: one temporary Workspace, in an engine
    /// document held in memory alone. It is never passed to a pass, so it
    /// never reaches this device's copy or the shared folder (desktop
    /// private-windows spec, "What can never be written"). Nil while no
    /// session is open.
    @ObservationIgnored private var privateDocument: SvalDocument?
    /// The id it writes under, made for the session and never saved.
    @ObservationIgnored private var privateDevice = Data()
    /// The private session's stamps, which only move forward as every
    /// device's do (decision 1714).
    @ObservationIgnored private var privateClock = StampClock()
    /// The private session's Workspace.
    private(set) var privateWorkspace: String?
    /// Every node of the private session, which nothing may save.
    private(set) var privateIds: Set<String> = [] {
        didSet {
            if privateIds != oldValue { reindexLauncher() }
            browser?.refreshBar()
        }
    }
    /// The video and audio choices made in the private session, which
    /// apply to its tabs alone and go with it.
    private(set) var privateMedia: [String: SiteRules.Media] = [:]
    /// The protections choices made in the private session, kept as
    /// `privateMedia` is.
    private(set) var privateProtections: [String: String] = [:] {
        didSet { browser?.refreshBar() }
    }

    /// The site rules a tab's pages take: a private tab's carry the
    /// session's own choices.
    func siteRules(private isPrivate: Bool) -> SiteRules {
        SiteRules(settings: settings, session: isPrivate ? privateMedia : nil,
                  sessionProtections: isPrivate ? privateProtections : nil)
    }

    /// Turns protections `on` for `name` in the private session's tabs.
    func setPrivateProtections(_ name: String, on: Bool) {
        privateProtections = siteRules(private: true).sessionProtectionsChange(for: name, on: on)
    }

    /// Gives `name` the video and audio choice `choice` for the private
    /// session's tabs.
    func setPrivateMedia(_ name: String, to choice: SiteRules.Media) {
        privateMedia = siteRules(private: true).sessionMediaChange(for: name, to: choice)
        browser.applyMediaChoices()
    }

    /// The colour token a Workspace's surfaces take: the private palette
    /// for the private session's, else the Workspace's own colour.
    func tint(of workspace: OutlineRow?) -> String? {
        guard let workspace else { return nil }
        return privateIds.contains(workspace.id) ? Theme.privateToken : workspace.color
    }

    func isPrivate(_ id: String) -> Bool {
        privateIds.contains(id) || Browser.pinParts(id).map { privateIds.contains($0.workspace) } == true
    }

    /// Opens the private session, if none is open, and returns its
    /// Workspace.
    func openPrivateSession() async -> String? {
        if let privateWorkspace { return privateWorkspace }
        let document = SvalDocument()
        privateDevice = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        let id = UUID().uuidString.lowercased()
        let ops: [[String: Any]] = [["kind": "addWorkspace", "name": "Private", "id": id]]
        do {
            let json = try JSONSerialization.data(withJSONObject: ops)
            try document.applyBatch(opsJson: String(decoding: json, as: UTF8.self), deviceId: privateDevice,
                                    now: privateClock.now())
        } catch {
            Diagnostics.debug("private: the session did not open: \(Diagnostics.name(error))")
            return nil
        }
        privateDocument = document
        privateWorkspace = id
        Diagnostics.debug("private: a session opened")
        await refreshRows()
        return id
    }

    /// Shows the private session, opening it first if none is open. A
    /// session with no tabs shows the private home behind the bar, and its
    /// first tab is the first page opened from there.
    @discardableResult
    func showPrivateSession() async -> Bool {
        guard let workspace = await openPrivateSession() else { return false }
        browser.showWorkspace(workspace)
        return true
    }

    /// Ends the private session: its tree, its pages and its WebKit store
    /// go, and nothing of it remains.
    func endPrivateSession() async {
        guard privateWorkspace != nil else { return }
        browser.endPrivateSession(privateIds)
        privateDocument = nil
        privateWorkspace = nil
        privateDevice = Data()
        privateMedia = [:]
        privateProtections = [:]
        Diagnostics.debug("private: the session ended")
        await refreshRows()
    }

    /// Whether `ops` act on the private session's tree.
    private func touchesPrivate(_ ops: [[String: Any]]) -> Bool {
        ops.contains { op in
            ["id", "parent", "newParent"].contains { key in (op[key] as? String).map(privateIds.contains) == true }
        }
    }

    /// Applies a change to the private session's tree. Nothing is synced
    /// or saved. A change that would move anything between the session and
    /// the user's Workspaces is refused, as the desktop refuses moves
    /// between a private window and any other.
    private func editPrivate(_ ops: [[String: Any]]) async -> Bool {
        guard let privateDocument else { return false }
        // A node the user's Workspaces hold, named by a private change.
        let crosses = ops.contains { op in
            ["id", "parent", "newParent", "before", "after"].contains { key in
                (op[key] as? String).map { row($0) != nil && !privateIds.contains($0) } == true
            }
        }
        guard !crosses else {
            Diagnostics.debug("private: a change between the session and a Workspace was refused")
            return false
        }
        do {
            let json = try JSONSerialization.data(withJSONObject: ops)
            try privateDocument.applyBatch(opsJson: String(decoding: json, as: UTF8.self), deviceId: privateDevice,
                                           now: privateClock.now())
        } catch {
            Diagnostics.debug("private: a change was refused: \(Diagnostics.name(error))")
            return false
        }
        await refreshRows()
        return true
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

    func children(of id: String) -> [OutlineRow] {
        tree.children(of: id)
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

    /// Whether the kept sync key opens nothing in the folder chosen. The
    /// phone then joins the folder, as a backup key that doesn't match is
    /// refused, and the key stays in the Keychain, since choosing the
    /// wrong folder must not cost it. Kept across launches, so a relaunch
    /// never takes the key as ready for this folder. A key stored by a
    /// join or a start clears it.
    @ObservationIgnored private var keyUnconfirmed = UserDefaults.standard.bool(forKey: AppModel.keyUnconfirmedKey) {
        didSet { UserDefaults.standard.set(keyUnconfirmed, forKey: Self.keyUnconfirmedKey) }
    }
    private static let keyUnconfirmedKey = "syncKeyUnconfirmed"

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

    private func stage(holdsSval: Bool) -> Stage {
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

    /// The sync key this phone makes when it's the first device in a
    /// folder, until setup moves on from showing its backup.
    private(set) var startedKey: Data?
    /// Whether the next pass may make the folder's Sval data: this phone
    /// started syncing in the folder and no pass has written to it yet. It
    /// outlasts a relaunch, since every pass refuses a folder with no Sval
    /// data until one does.
    @ObservationIgnored private var starting = UserDefaults.standard.bool(forKey: AppModel.startingKey) {
        didSet { UserDefaults.standard.set(starting, forKey: Self.startingKey) }
    }
    private static let startingKey = "startingFolder"

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

    // MARK: Offering the sync key

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

    /// Why the last join failed, for the code screen to say.
    private(set) var joinFailure: JoinError?
    /// Whether first run's last step shows: the Workspaces arriving after a
    /// join, until the user opens one.
    var welcoming = false

    /// Whether a join is waiting for the other device's offer to arrive.
    private(set) var waitingForOffer = false
    private var joinTask: Task<Void, Never>?
    /// The wait between two looks for an offer, cut short when the folder
    /// changes.
    private var joinSleep: Task<Void, Error>?

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

    func sync() async {
        guard stage == .ready, let syncer = await loadedSyncer(), source != nil,
              let key = secrets.syncKey()
        else { return }
        guard !syncing else {
            syncAgain = true
            return
        }
        syncing = true
        defer {
            syncing = false
            if syncAgain {
                syncAgain = false
                Task { await sync() }
            }
        }
        // A pass that ends after the phone left the folder reports on a
        // folder it no longer uses.
        let from = source
        do {
            let report = try await syncer.sync(shared: sharedFolder(), syncKey: key, starting: starting)
            guard source == from else { return }
            if starting { starting = false }
            Diagnostics.log("sync: merged \(report.merged), errors \(report.errors.count), unreadable \(report.unreadable.count), wrote \(report.wrote)")
            lastSynced = .now
            unreachableSince = nil
            // A file caught mid-write fails once and is read on the next
            // pass, so only a file that fails twice running is reported.
            let lasting = report.problems.intersection(lastProblems)
            lastProblems = report.problems
            let problem = lasting.isEmpty ? nil : "\(lasting.count) file(s) in the folder couldn't be read."
            if problem != message { message = problem }
        } catch {
            guard source == from else { return }
            Diagnostics.log("sync: failed \(Diagnostics.name(error))")
            // A lost connection is made again on the next pass.
            if error is ConnectorError {
                connected = nil
            }
            let since = unreachableSince ?? .now
            unreachableSince = since
            let away = Date.now.timeIntervalSince(since)
            if away < 0 || away >= Self.unavailableAfter {
                message = error.localizedDescription
            }
        }
        // The tree as the pass left it, from the syncer in use once it is
        // read: leaving the folder meanwhile replaces it.
        var read: (Syncer, TreeRead)?
        if let current = self.syncer {
            let tree = await current.treeRead(since: treeStore.revision)
            if self.syncer === current { read = (current, tree) }
        }
        if let read { await keepTabsInFront(read.1) }
        await refreshRows(read)
        await keepOwnWorkspace()
        await refreshHistory()
    }

    /// Records a use of tab `id`, so a device that archives idle tabs keeps
    /// one used only here (idle-tab archive spec §4.1). The engine stamps a
    /// tab at most once an hour (`mark_used`), so this writes rarely, and
    /// the next pass carries it.
    func markUsed(_ id: String) async {
        guard let syncer, row(id)?.kind == .tab, !isPrivate(id) else { return }
        do {
            try await syncer.edit(workspacesDocument, opsJson: #"[{"kind":"markUsed","id":"\#(id)"}]"#)
        } catch {
            Diagnostics.log("edit: a tab's use was not recorded: \(Diagnostics.name(error))")
        }
    }

    /// Gives back each tab another device's close took while it is in
    /// front here, under its own id (decision 2237): at its parent when the
    /// tree still holds that in the tab's Workspace, beside it for a split,
    /// and at the top of the Workspace otherwise. Every peer reads the node
    /// as news, so the tab returns on the device that closed it. Run as the
    /// pass returns, while `rows` still shows the tree before it, and
    /// before `reconcile` lets the page go. A Workspace the pass deleted
    /// takes its tabs with it.
    private func keepTabsInFront(_ read: TreeRead) async {
        // A change of content alone leaves every row where it was, so no
        // tab left the tree.
        guard case .whole(_, let after) = read else { return }
        let ops = Self.keptInFrontOps(tree, after: after, privateIds: privateIds, inFront: browser.isInFront)
        guard !ops.isEmpty else { return }
        Diagnostics.log("sync: kept \(ops.filter { $0["kind"] as? String == "addTab" }.count) tab(s) in front that another device closed")
        await edit(ops)
    }

    /// The edits that give back each tab of `before` in front here, by
    /// `inFront`, that `after`, the outline a pass left, no longer holds
    /// (`keepTabsInFront`).
    nonisolated static func keptInFrontOps(_ before: OutlineIndex, after: [OutlineRow], privateIds: Set<String>,
                                           inFront: (String) -> Bool) -> [[String: Any]] {
        let now = Dictionary(after.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        func within(_ id: String, _ workspace: String) -> Bool {
            var node: String? = id
            for _ in 0..<64 {
                guard let at = node else { return false }
                if at == workspace { return true }
                node = now[at]?.parentId
            }
            return false
        }
        var ops: [[String: Any]] = []
        for tab in before.rows where tab.kind == .tab && now[tab.id] == nil && !privateIds.contains(tab.id) {
            guard inFront(tab.id), let url = tab.url, let home = before.workspace(of: tab.id), now[home] != nil
            else { continue }
            var former = tab.parentId
            var place = place(of: tab, in: before)
            if let parent = former, before.row(parent)?.kind == .split {
                former = before.row(parent)?.parentId
                place = closedPlace(of: tab, in: before)
            }
            var add: [String: Any] = ["kind": "addTab", "name": tab.name, "url": url, "id": tab.id, "local": tab.local]
            if let former, now[former] != nil, within(former, home) {
                add["parent"] = former
                add["before"] = place?.previous.flatMap { now[$0]?.parentId == former ? $0 : nil }
                add["after"] = place?.next.flatMap { now[$0]?.parentId == former ? $0 : nil }
            } else {
                add["parent"] = home
                add["after"] = after.first { $0.parentId == home }?.id
            }
            ops.append(add)
            if let label = tab.label { ops.append(["kind": "setLabel", "id": tab.id, "label": label]) }
        }
        return ops
    }

    /// Closes a tab. Only a tab closes this way: groups and Workspaces are
    /// deleted by name on the desktop (decision 0077).
    @discardableResult
    func closeTab(_ row: OutlineRow) async -> Bool {
        guard row.kind == .tab else { return false }
        let wasPrivate = isPrivate(row.id)
        // The page goes before the edit drops the tab from the session's
        // ids, so nothing it reports later can be taken for the user's.
        if wasPrivate { browser.closePage(row.id) }
        guard await edit([["kind": "remove", "id": row.id]] + splitShapeOps(leaving: row)) else { return false }
        TitleHold.shared.forget(row.id)
        return true
    }

    /// What keeps a split whole when `row` leaves it, as the desktop's
    /// panel writes it (`splitShapeOps`): a split left with one tab or none
    /// is separated, and one whose widths no longer fit goes back to equal
    /// widths.
    func splitShapeOps(leaving row: OutlineRow) -> [[String: Any]] {
        tree.splitShapeOps(leaving: row)
    }

    /// What keeps each split whole when `rows` leave it together: a split
    /// that itself leaves, or sits inside a row that does, goes with them.
    func splitShapeOps(leaving rows: [OutlineRow]) -> [[String: Any]] {
        tree.splitShapeOps(leaving: rows)
    }

    // MARK: Dragging in the Workspace sheet

    /// Whether `id` is `ancestor` or lies inside it.
    func isInside(_ id: String, _ ancestor: String) -> Bool {
        tree.isInside(id, ancestor)
    }

    // MARK: Splits

    /// Separate: the panes become tabs in the split's place, in order.
    func separate(_ split: OutlineRow) async {
        await edit(["kind": "removeKeepingChildren", "id": split.id])
    }

    /// Rename Split: an empty name clears it.
    func renameSplit(_ split: OutlineRow, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name != split.name else { return }
        await edit(["kind": "rename", "id": split.id, "name": name])
    }

    /// Moves `row` one place among its siblings, -1 back or 1 on, as the
    /// desktop's panel moves one (`moveTarget`): Move Pane Left and Right
    /// for a pane, Move Up and Down for any other row, which is what
    /// dragging it past its neighbour does.
    func movePane(_ pane: OutlineRow, by step: Int) async {
        guard canMove(pane, by: step), let split = pane.parentId else { return }
        let panes = children(of: split)
        guard let at = panes.firstIndex(where: { $0.id == pane.id }) else { return }
        let to = at + step
        let others = panes.filter { $0.id != pane.id }
        var op: [String: Any] = ["kind": "moveNode", "id": pane.id, "newParent": split]
        // `before` names the node it goes after, `after` the one it goes
        // before, as every placement op takes them.
        op["before"] = to > 0 ? others[to - 1].id : nil
        op["after"] = to < others.count ? others[to].id : nil
        await edit(op)
    }

    /// Whether `row` has a sibling `step` places along to move past.
    func canMove(_ row: OutlineRow, by step: Int) -> Bool {
        guard let parent = row.parentId, let at = children(of: parent).firstIndex(where: { $0.id == row.id })
        else { return false }
        return children(of: parent).indices.contains(at + step)
    }

    /// Sets the panes' widths, one percentage per pane, summing to 100.
    func setShares(_ split: OutlineRow, _ shares: [Double]) async {
        var op: [String: Any] = ["kind": "setContent", "id": split.id, "name": split.name, "shares": shares]
        op["url"] = split.url
        op["icon"] = split.icon
        await edit(op)
    }

    /// Close Both or Close All: the split and every pane, as one write.
    func closeSplit(_ split: OutlineRow) async -> Bool {
        await edit(["kind": "remove", "id": split.id])
    }

    /// Puts a closed split back where it was, with its name, widths and
    /// panes. Returns the panes' new ids, in order.
    func reopenSplit(_ split: OutlineRow, panes: [OutlineRow], at place: Place, workspace: String?) async -> [String]? {
        let parent = row(place.parent) != nil ? place.parent : workspace.flatMap { row($0) != nil ? $0 : nil }
        guard let parent else { return nil }
        let id = UUID().uuidString.lowercased()
        var add: [String: Any] = ["kind": "addSplit", "parent": parent, "name": split.name, "id": id]
        add["before"] = sibling(place.previous, in: parent)
        add["after"] = sibling(place.next, in: parent)
        var ops = [add]
        var ids: [String] = []
        for pane in panes {
            guard let url = pane.url else { continue }
            let tab = UUID().uuidString.lowercased()
            var addTab: [String: Any] = ["kind": "addTab", "parent": id, "name": pane.name, "url": url, "id": tab]
            addTab["before"] = ids.last
            ops.append(addTab)
            if let label = pane.label { ops.append(["kind": "setLabel", "id": tab, "label": label]) }
            ids.append(tab)
        }
        if let shares = split.shares, shares.count == ids.count {
            var content: [String: Any] = ["kind": "setContent", "id": id, "name": split.name, "shares": shares]
            content["url"] = split.url
            ops.append(content)
        }
        return await edit(ops) ? ids : nil
    }

    /// Fills a pane waiting for a pick with `tab`: the picker's tab goes,
    /// and `tab` moves into its place (split-view spec §5.2).
    /// Returns the change that takes the pick back: the tab to where it was,
    /// and a pane waiting for a pick in its place.
    func pick(_ tab: OutlineRow, for pane: OutlineRow) async -> [[String: Any]]? {
        guard let split = pane.parentId, let from = place(of: tab) else { return nil }
        let panes = children(of: split)
        guard let at = panes.firstIndex(where: { $0.id == pane.id }) else { return nil }
        var move: [String: Any] = ["kind": "moveNode", "id": tab.id, "newParent": split]
        move["before"] = at > 0 ? panes[at - 1].id : nil
        move["after"] = at + 1 < panes.count ? panes[at + 1].id : nil
        guard await edit([["kind": "remove", "id": pane.id], move]) else { return nil }
        var back: [String: Any] = ["kind": "moveNode", "id": tab.id, "newParent": from.parent]
        back["before"] = from.previous
        back["after"] = from.next
        // The picker's address stays on the device that writes it, so it
        // carries the mark the desktop gives every address it never syncs
        // (decision 1372, `markLocal`).
        var picker: [String: Any] = [
            "kind": "addTab", "parent": split, "name": "", "url": splitPickAddress, "id": UUID().uuidString.lowercased(),
            "local": true,
        ]
        picker["before"] = at > 0 ? panes[at - 1].id : nil
        return [back, picker]
    }

    /// Applies `ops` to the tree as one batch, as an Undo does.
    @discardableResult
    func editTree(_ ops: [[String: Any]]) async -> Bool {
        await edit(ops)
    }

    /// Renames a row. A tab's name is its label, which its navigations
    /// never touch, and an empty one takes the label away so the tab shows
    /// its page's title again, as on the desktop (spec §5.1). A Workspace or
    /// group keeps its name when given none.
    func rename(_ row: OutlineRow, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if row.kind == .tab {
            let label: String? = name.isEmpty ? nil : name
            guard label != row.label else { return }
            await edit(["kind": "setLabel", "id": row.id, "label": label ?? NSNull()])
            return
        }
        guard !name.isEmpty, name != row.name else { return }
        await edit(["kind": "rename", "id": row.id, "name": name])
    }

    /// Saves a Workspace's or group's name, emoji and colour from its Edit
    /// dialog, as one write. The appearance group is written whole
    /// (`setAppearance`), so the emoji and colour go together.
    /// A colour as `setAppearance` takes it: a preset's token as it is, and
    /// a custom colour, which rows carry as JSON, as the object it is.
    static func appearanceColor(_ color: String?) -> Any? {
        guard let color, color.hasPrefix("{") else { return color }
        return try? JSONSerialization.jsonObject(with: Data(color.utf8))
    }

    func saveLook(_ row: OutlineRow, name: String, emoji: String?, color: String?) async -> Bool {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return false }
        var ops: [[String: Any]] = []
        if name != row.name { ops.append(["kind": "rename", "id": row.id, "name": name]) }
        if emoji != row.emoji || color != row.color {
            var look: [String: Any] = ["kind": "setAppearance", "id": row.id]
            look["emoji"] = emoji
            look["color"] = Self.appearanceColor(color)
            // The op writes the whole group, so the window's transparency,
            // which the phone doesn't edit, goes back as it was.
            look["transparency"] = row.transparency
            ops.append(look)
        }
        return ops.isEmpty ? true : await edit(ops)
    }

    /// Adds a tab for `url` at the end of `parent`, named by its address
    /// until the page gives it a title, and returns its id: `id` when given,
    /// for a tab whose page is made ahead of its row.
    func addTab(to parent: String, url: URL, after previous: String? = nil, before next: String? = nil, name: String? = nil,
                id given: String? = nil) async -> String? {
        // The phone writes only web addresses into synced data: any other
        // stays on the device it was made on (decision 1372).
        guard Self.opensHere(url.absoluteString) else { return nil }
        let id = given ?? UUID().uuidString.lowercased()
        var op: [String: Any] = [
            "kind": "addTab", "parent": parent, "name": name ?? url.absoluteString,
            "url": url.absoluteString, "id": id,
        ]
        // The engine orders a node after `before` and ahead of `after`
        // (`tree::order_between`).
        op["before"] = previous
        op["after"] = next
        return await edit(op) ? id : nil
    }

    /// Where a row sits: its parent and the siblings either side of it,
    /// so an undo can put it back between the two, as the desktop's moves
    /// name both (`moveNode`'s `before` and `after`). With `previous` alone
    /// the engine orders it after that sibling and can pass the next one or
    /// tie with it (`tree::key_between`).
    struct Place {
        let parent: String
        let previous: String?
        var next: String? = nil
    }

    /// Where `row` sits. A sibling in `skipping` moves back with it, ahead
    /// of it in tree order, so the next sibling named is one that stays.
    func place(of row: OutlineRow, skipping: Set<String> = []) -> Place? {
        Self.place(of: row, in: tree, skipping: skipping)
    }

    nonisolated static func place(of row: OutlineRow, in tree: OutlineIndex, skipping: Set<String> = []) -> Place? {
        guard let parent = row.parentId else { return nil }
        let (previous, next) = neighbours(of: row.id, among: tree.children(of: parent).map(\.id), skipping: skipping)
        return Place(parent: parent, previous: previous, next: next)
    }

    /// `id` when it is still a child of `parent`: the engine orders by a
    /// neighbour's key wherever that neighbour sits (`tree::order_between`).
    func sibling(_ id: String?, in parent: String) -> String? {
        id.flatMap { row($0)?.parentId == parent ? $0 : nil }
    }

    /// The siblings either side of `id` in `siblings`: the one before it,
    /// and the first after it outside `skipping`.
    nonisolated static func neighbours(of id: String, among siblings: [String], skipping: Set<String> = [])
        -> (previous: String?, next: String?) {
        guard let index = siblings.firstIndex(of: id) else { return (nil, nil) }
        return (index > 0 ? siblings[index - 1] : nil,
                siblings[(index + 1)...].first { !skipping.contains($0) })
    }

    /// Whether `row` is a split's pane, which is never pinned on its own
    /// (the desktop's `canPin`, pins spec §8.1).
    func isPane(_ row: OutlineRow) -> Bool {
        row.parentId.flatMap(self.row)?.kind == .split
    }

    /// Where a closed tab goes back: where it was, or for a split's pane
    /// beside its split, since a tab joins a split only by the user
    /// splitting it (split-view spec §6.1, the desktop's `placeBeside`).
    func closedPlace(of row: OutlineRow) -> Place? {
        Self.closedPlace(of: row, in: tree)
    }

    nonisolated static func closedPlace(of row: OutlineRow, in tree: OutlineIndex) -> Place? {
        guard let parent = row.parentId, let split = tree.row(parent), split.kind == .split else {
            return place(of: row, in: tree)
        }
        return place(of: split, in: tree).map { Place(parent: $0.parent, previous: split.id, next: $0.next) }
    }

    /// Opens a closed tab again where it was, under its own id, as the
    /// desktop's undo close does: a closed tab leaves no record to restore
    /// (engine rule 5), and the id is the one way it comes back as itself.
    /// The tab goes back under its own name, with its label. A place
    /// another device has since deleted gives way to the end of its
    /// Workspace, or of the Workspace shown. A tab that was private goes
    /// back into its own session or nowhere: the Workspace shown may be
    /// one that syncs.
    func reopen(_ row: OutlineRow, at place: Place, workspace: String?, wasPrivate: Bool) async -> String? {
        guard let address = row.url, let url = URL(string: address) else { return nil }
        let parent: String
        let previous: String?
        var next: String?
        if self.row(place.parent) != nil {
            parent = place.parent
            previous = sibling(place.previous, in: parent)
            next = sibling(place.next, in: parent)
        } else if let home = [workspace, wasPrivate ? nil : browser.workspaceId].compactMap({ $0 })
                    .first(where: { self.row($0) != nil }) {
            parent = home
            previous = children(of: home).last?.id
        } else {
            return nil
        }
        let id = row.id
        var add: [String: Any] = ["kind": "addTab", "parent": parent, "name": row.name, "url": url.absoluteString, "id": id]
        add["before"] = previous
        add["after"] = next
        var ops = [add]
        if let label = row.label { ops.append(["kind": "setLabel", "id": id, "label": label]) }
        return await edit(ops) ? id : nil
    }

    /// Makes a workspace, last in the order, and returns its id.
    func addWorkspace(named name: String, emoji: String?, color: String?) async -> String? {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return nil }
        let id = UUID().uuidString.lowercased()
        var ops: [[String: Any]] = [["kind": "addWorkspace", "name": name, "id": id]]
        if emoji != nil || color != nil {
            var appearance: [String: Any] = ["kind": "setAppearance", "id": id]
            appearance["emoji"] = emoji
            appearance["color"] = Self.appearanceColor(color)
            ops.append(appearance)
        }
        return await edit(ops) ? id : nil
    }

    /// Makes a group in Workspace `parent` holding `members`, as one
    /// write, and returns its id. With members from that Workspace the
    /// group takes the first one's place (`groupSelectionTarget`); with
    /// none, or from elsewhere, it goes after the groups already in
    /// `parent` (`defaultSlot`), as the desktop places a new group.
    func addGroup(named name: String, emoji: String? = nil, color: String? = nil, in parent: String,
                  holding members: [OutlineRow] = []) async -> String? {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return nil }
        let members = outermost(members)
        let id = UUID().uuidString.lowercased()
        var home = parent
        var slot: (previous: String?, next: String?)
        // A pane's place is its split's: nothing but tabs goes in a split.
        if let first = members.first, workspace(of: first.id) == workspace(of: parent),
           let anchor = isPane(first) ? first.parentId : first.id, let at = row(anchor)?.parentId {
            home = at
            slot = Self.selectionSlot(among: children(of: at).map(\.id), anchor: anchor,
                                      members: Set(members.map(\.id)))
        } else {
            let placed = Self.moveIntoOrder(staying: children(of: parent).map { ($0.id, $0.kind == .group) },
                                            moving: [(id, true)])
            slot = (placed.first?.previous, placed.first?.next)
        }
        var ops: [[String: Any]] = [["kind": "addGroup", "parent": home, "name": name, "id": id]]
        if emoji != nil || color != nil {
            var look: [String: Any] = ["kind": "setAppearance", "id": id]
            look["emoji"] = emoji
            look["color"] = Self.appearanceColor(color)
            ops.append(look)
        }
        if slot.previous != nil || slot.next != nil {
            var place: [String: Any] = ["kind": "moveNode", "id": id, "newParent": home]
            place["before"] = slot.previous
            place["after"] = slot.next
            ops.append(place)
        }
        for (index, member) in members.enumerated() {
            var move: [String: Any] = ["kind": "moveNode", "id": member.id, "newParent": id]
            move["before"] = index > 0 ? members[index - 1].id : nil
            ops.append(move)
        }
        ops += splitShapeOps(leaving: members)
        return await edit(ops) ? id : nil
    }

    /// Where a new group holding `members` goes among `siblings`: the place
    /// of `anchor`, the first of them, among the siblings that stay
    /// (`groupSelectionTarget`).
    static func selectionSlot(among siblings: [String], anchor: String, members: Set<String>)
        -> (previous: String?, next: String?) {
        let staying = siblings.filter { !members.contains($0) }
        let at = siblings.prefix { $0 != anchor }.filter { !members.contains($0) }.count
        return (at > 0 ? staying[at - 1] : nil, at < staying.count ? staying[at] : nil)
    }

    /// Puts Workspace `id` between `before` and `after` in the order every
    /// device lists Workspaces (`tree::move_workspace`).
    func moveWorkspace(_ id: String, before: String?, after: String?) async {
        var op: [String: Any] = ["kind": "moveWorkspace", "id": id]
        op["before"] = before
        op["after"] = after
        await edit(op)
    }

    /// Moves a tab to the end of `parent`, a workspace or a group.
    @discardableResult
    func move(_ row: OutlineRow, to parent: String) async -> Bool {
        guard row.parentId != parent else { return false }
        let last = rows.last { $0.parentId == parent && $0.id != row.id }
        return await move(row.id, to: Place(parent: parent, previous: last?.id))
    }

    /// Moves `rows` into `parent`, as one write, each where the desktop's
    /// Move to puts it (`moveIntoTargets`): groups after the groups that
    /// stay, the rest at the end, in tree order. A row already in `parent`
    /// stays where it is, and one inside another of `rows` goes with it.
    /// Returns what puts them back where they were.
    func move(_ rows: [OutlineRow], to parent: String) async -> [[String: Any]]? {
        let moving = outermost(rows).filter { $0.parentId != parent && !isInside(parent, $0.id) }
        guard !moving.isEmpty else { return nil }
        let ids = Set(moving.map(\.id))
        let staying = children(of: parent).filter { !ids.contains($0.id) }
        let ops: [[String: Any]] = Self.moveIntoOrder(
            staying: staying.map { ($0.id, $0.kind == .group) }, moving: moving.map { ($0.id, $0.kind == .group) }
        ).map { slot in
            var op: [String: Any] = ["kind": "moveNode", "id": slot.id, "newParent": parent]
            op["before"] = slot.previous
            op["after"] = slot.next
            return op
        } + splitShapeOps(leaving: moving)
        let undo = returnOps(for: moving)
        return await edit(ops) ? undo : nil
    }

    /// `rows` in tree order, leaving out any inside another of them.
    func outermost(_ rows: [OutlineRow]) -> [OutlineRow] {
        let ids = Set(rows.map(\.id))
        let order = Dictionary(self.rows.enumerated().map { ($1.id, $0) }, uniquingKeysWith: min)
        return rows
            .filter { row in !ids.contains { $0 != row.id && isInside(row.id, $0) } }
            .sorted { (order[$0.id] ?? 0) < (order[$1.id] ?? 0) }
    }

    /// The moves that put `rows`, in tree order, back where they are.
    func returnOps(for rows: [OutlineRow]) -> [[String: Any]] {
        let ids = Set(rows.map(\.id))
        return rows.compactMap { row in
            guard let place = place(of: row, skipping: ids) else { return nil }
            var back: [String: Any] = ["kind": "moveNode", "id": row.id, "newParent": place.parent]
            back["before"] = place.previous
            back["after"] = place.next
            return back
        }
    }

    /// Where each of `moving` lands in a container holding `staying`, as
    /// the desktop orders a Move to (`moveIntoTargets`): groups after the
    /// last group that stays, everything else at the end, each in its
    /// order. Each lands after the one before it, which an earlier move in
    /// the batch has placed, and before the next that stays.
    static func moveIntoOrder(staying: [(id: String, group: Bool)], moving: [(id: String, group: Bool)])
        -> [(id: String, previous: String?, next: String?)] {
        let lastGroup = staying.lastIndex { $0.group }.map { $0 + 1 } ?? 0
        let final = staying[..<lastGroup].map(\.id) + moving.filter(\.group).map(\.id)
            + staying[lastGroup...].map(\.id) + moving.filter { !$0.group }.map(\.id)
        let movingIds = Set(moving.map(\.id))
        return final.enumerated().compactMap { index, id in
            guard movingIds.contains(id) else { return nil }
            return (id, index > 0 ? final[index - 1] : nil, final[(index + 1)...].first { !movingIds.contains($0) })
        }
    }

    /// Puts back rows `move(_:to:)` moved. A neighbour that has since
    /// left the place is dropped, unless an earlier move in the batch puts
    /// it back there.
    func moveBack(_ undo: [[String: Any]]) async {
        var placed: [String: String] = [:]
        let ops = undo.map { op in
            guard let parent = op["newParent"] as? String, let id = op["id"] as? String else { return op }
            var op = op
            for key in ["before", "after"] {
                if let near = op[key] as? String, placed[near] != parent, sibling(near, in: parent) == nil {
                    op[key] = nil
                }
            }
            placed[id] = parent
            return op
        }
        _ = await edit(ops)
    }

    /// Moves node `id` into `place`, after the sibling it names.
    @discardableResult
    func move(_ id: String, to place: Place) async -> Bool {
        var op: [String: Any] = ["kind": "moveNode", "id": id, "newParent": place.parent]
        op["before"] = sibling(place.previous, in: place.parent)
        op["after"] = sibling(place.next, in: place.parent)
        return await edit(op)
    }

    /// Deletes a group, its contents with it or moved up to its parent in
    /// their order (decision 0077, spec §5.4).
    func deleteGroup(_ row: OutlineRow, keepingContents: Bool) async {
        guard row.kind == .group else { return }
        await edit(["kind": keepingContents ? "removeKeepingChildren" : "remove", "id": row.id])
    }

    /// Makes deleted empty group `row` again where it was, under its own
    /// id, with its name and look: Undo of deleting it, which asks nothing.
    func reopenGroup(_ row: OutlineRow, at place: Place) async {
        guard self.row(place.parent) != nil else { return }
        var ops: [[String: Any]] = [["kind": "addGroup", "parent": place.parent, "name": row.name, "id": row.id]]
        if row.emoji != nil || row.color != nil {
            var look: [String: Any] = ["kind": "setAppearance", "id": row.id]
            look["emoji"] = row.emoji
            look["color"] = Self.appearanceColor(row.color)
            ops.append(look)
        }
        var move: [String: Any] = ["kind": "moveNode", "id": row.id, "newParent": place.parent]
        move["before"] = sibling(place.previous, in: place.parent)
        move["after"] = sibling(place.next, in: place.parent)
        ops.append(move)
        await edit(ops)
    }

    /// Deletes a workspace and everything in it (decision 0077), and shows
    /// the next Workspace in the order.
    func deleteWorkspace(_ id: String) async {
        guard row(id)?.parentId == nil else { return }
        let order = workspaces.map(\.id)
        let next = order.firstIndex(of: id).flatMap { index in
            order.indices.contains(index + 1) ? order[index + 1] : (index > 0 ? order[index - 1] : nil)
        }
        if await edit(["kind": "remove", "id": id]), let next {
            browser.showWorkspace(next)
        }
    }

    /// Records where a tab's page went, so every device shows the tab at its
    /// new address and title. A title the page sets soon after its last
    /// is held back (`TitleHold`).
    func followNavigation(tabId: String, url: URL, title: String, isPrivate pagePrivate: Bool) async {
        // A private page whose tab has left the session writes nowhere:
        // its address would otherwise go to the synced tree.
        if pagePrivate, !isPrivate(tabId) { return }
        guard let row = row(tabId), ["http", "https"].contains(url.scheme ?? ""),
              let name = Self.navigationName(row, url: url, title: title, holds: TitleHold.shared,
                                             holdsBack: !isPrivate(tabId)) else { return }
        await edit(Self.content(row, name: name, url: url.absoluteString))
    }

    /// The name tab `row` is written with now that its page is at `url`,
    /// titled `title`, or nil when nothing is written yet. `holdsBack` is
    /// false for the private session's tree, which is never written to the
    /// folder, so nothing of it is held.
    static func navigationName(_ row: OutlineRow, url: URL, title: String, holds: TitleHold,
                               holdsBack: Bool) -> String? {
        // A page reopened or put back from its saved state reports its
        // address before its title, and that empty title would replace the
        // name the tab had there.
        if title.isEmpty, row.url == url.absoluteString { return nil }
        let name = title.isEmpty ? url.absoluteString : title
        if row.url != url.absoluteString {
            // A new page's first title goes with its address at once.
            holds.forget(row.id)
        } else {
            guard name != (holds.pending[row.id] ?? row.name) else { return nil }
            if holdsBack, !holds.admit(row.id, name: name == row.name ? nil : name) { return nil }
            guard row.name != name else { return nil }
        }
        return name
    }

    /// A `setContent` op for tab `row`. The content group is written whole
    /// (`docs/host-contract.md` §3), so the icon and the local mark go back
    /// as the tree holds them.
    private static func content(_ row: OutlineRow, name: String, url: String) -> [String: Any] {
        var op: [String: Any] = ["kind": "setContent", "id": row.id, "name": name, "url": url, "local": row.local]
        if let icon = row.icon { op["icon"] = icon }
        return op
    }

    /// The ops writing the titles `TitleHold` held back for `ids`, or for
    /// every tab, taking them from it.
    private func heldTitleOps(_ ids: [String]? = nil) -> (ops: [[String: Any]], taken: [String: String]) {
        let taken = TitleHold.shared.take(ids)
        let ops = taken.compactMap { id, name -> [String: Any]? in
            guard let row = row(id), row.name != name, let url = row.url else { return nil }
            return Self.content(row, name: name, url: url)
        }
        return (ops, taken)
    }

    /// Writes the titles held back for `ids`, or for every tab.
    private func writeHeldTitles(_ ids: [String]? = nil) async {
        let (ops, taken) = heldTitleOps(ids)
        guard !ops.isEmpty else { return }
        if !(await edit(ops)) { TitleHold.shared.putBack(taken) }
    }

    func row(_ id: String) -> OutlineRow? {
        tree.row(id)
    }

    /// The workspace `id` is in, or is.
    func workspace(of id: String) -> String? {
        tree.workspace(of: id)
    }

    /// Whether `workspace` can be deleted from this phone: never the last
    /// one, and never the phone's own, which it would only make again
    /// (decision 2254). Another device can delete that one.
    func canDelete(workspace: OutlineRow) -> Bool {
        workspaces.count > 1 && workspace.id != ownWorkspace?.id
    }

    /// The tabs in `workspace`, in tree order.
    func tabs(in workspace: String?) -> [OutlineRow] {
        guard let workspace else { return [] }
        return tree.tabs(in: workspace)
    }

    /// Sets a synced setting to `value`, a string or a Boolean, or resets it
    /// to its default when `value` is nil, as the desktop's pref would be
    /// set or cleared (settings-sync spec §3).
    func setSetting(_ key: String, to value: Any?) async {
        await setSettings([(key, value)])
    }

    /// Sets several synced settings in one write, as `setSetting` sets one.
    func setSettings(_ changes: [(key: String, value: Any?)]) async {
        let ops = changes.map { key, value -> [String: Any] in
            var op: [String: Any] = ["kind": "setSetting", "key": key]
            if let value,
               let json = try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed) {
                op["valueJson"] = String(decoding: json, as: UTF8.self)
            }
            return op
        }
        await edit(ops, in: settingsDocument)
    }

    /// Opens a link another app hands Sval, as its default browser, in a new
    /// tab in front, over setup if it shows.
    func openIncoming(_ url: URL) async {
        guard Self.opensHere(url.absoluteString) else { return }
        settingUp = false
        _ = await loadedSyncer()
        await keepOwnWorkspace()
        guard let workspace = newTabWorkspace(from: browser.workspaceId) else { return }
        Diagnostics.log("links: a link from another app")
        await browser.openNewTab(url, in: workspace)
    }

    /// Whether the phone can open `url`: a web address.
    nonisolated static func opensHere(_ url: String) -> Bool {
        guard let scheme = URL(string: url)?.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    // MARK: Pins

    /// The Favorites root a favorite made here goes in
    /// (`SvalFavoritesStore`'s `FAVORITES_ROOT`).
    private static let favoritesRoot = "toolbar_____"

    /// A new favorite's guid: twelve characters, as Places mints them.
    static func mintGuid() -> String {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        return String((0..<12).map { _ in alphabet.randomElement()! })
    }

    /// The root pins live under, beside Favorites' (pins-root spec §4).
    static let pinsRoot = "pins________"

    /// Every root folder of the favorites document
    /// (`SvalFavoritesStore`'s `ROOT_GUIDS`).
    private static let rootGuids = [favoritesRoot, "menu________", "unfiled_____", pinsRoot]

    var pinsRootId: String? { favorites.first { $0.guid == Self.pinsRoot }?.id }

    /// The last item in `parent`, which a new one goes after.
    private func lastChild(of parent: String) -> String? {
        favorites.last { $0.parent == parent }?.id
    }

    /// Pins `url` at the end of the row, as a pin of its own and no
    /// favorite (pins-root spec §6), even where a pin of that address
    /// exists, as the desktop's `pinTab` adds one (`duplicate`). Returns
    /// the pin's guid.
    func pinTab(url: URL, title: String) async -> String? {
        let address = url.absoluteString
        guard Self.opensHere(address), let root = pinsRootId else { return nil }
        let guid = Self.mintGuid()
        var add: [String: Any] = [
            "kind": "addFavorite", "favoriteKind": "favorite", "guid": guid, "parent": root,
            "name": title.isEmpty ? address : title, "url": address,
        ]
        add["before"] = lastChild(of: root)
        return await editFavorites([add]) ? guid : nil
    }

    /// Where a pin sits, so Undo can put it back: its folder, the items
    /// either side of it there, and its Show in choices.
    struct PinPlace {
        let parent: String?
        let previous: String?
        let next: String?
        let scope: [String]?
    }

    func place(of pin: PinRow) -> PinPlace {
        let me = favorites.first { $0.id == pin.id }
        let siblings = favorites.filter { $0.parent == me?.parent }
        let index = siblings.firstIndex { $0.id == pin.id }
        return PinPlace(
            parent: me?.parent,
            previous: index.flatMap { $0 > 0 ? siblings[$0 - 1].id : nil },
            next: index.flatMap { $0 + 1 < siblings.count ? siblings[$0 + 1].id : nil },
            scope: pin.scope)
    }

    /// Puts a pin moved to Favorites back where it was in the row, with its
    /// Show in choices.
    func repin(_ pin: PinRow, at place: PinPlace, refolding: [[String: Any]] = []) async {
        guard let parent = place.parent ?? pinsRootId else { return }
        var move: [String: Any] = ["kind": "moveNode", "id": pin.id, "newParent": parent]
        move["before"] = place.previous
        move["after"] = place.next
        var ops = refolding + [move]
        if let scope = place.scope, !scope.isEmpty {
            ops.append(["kind": "setPinScope", "id": pin.id, "scope": scope])
        }
        await editFavorites(ops)
    }

    /// When moving `id` out of its pin folder leaves one pin there or
    /// none, the op that removes the pin folder, any pin left taking
    /// its place, and the ops that make it again round it.
    func dissolving(_ id: String, to newParent: String) -> (ops: [[String: Any]], undo: [[String: Any]])? {
        guard let folderId = favorites.first(where: { $0.id == id })?.parent, folderId != newParent,
              let folder = favorites.first(where: { $0.id == folderId }),
              folder.kind == "folder", folder.pinned, let parent = folder.parent, let guid = folder.guid
        else { return nil }
        let rest = favorites.filter { $0.parent == folderId && $0.id != id }
        guard rest.count <= 1 else { return nil }
        let siblings = favorites.filter { $0.parent == parent }
        let at = siblings.firstIndex { $0.id == folderId }
        var add: [String: Any] = [
            "kind": "addFavorite", "favoriteKind": "folder", "guid": guid, "parent": parent, "name": folder.name,
        ]
        add["before"] = at.flatMap { $0 > 0 ? siblings[$0 - 1].id : nil }
        add["after"] = at.flatMap { $0 + 1 < siblings.count ? siblings[$0 + 1].id : nil }
        var undo = [add] + rest.map { ["kind": "moveNode", "id": $0.id, "newParent": folderId] }
        if let scope = folder.pinScope, !scope.isEmpty {
            undo.append(["kind": "setPinScope", "id": folderId, "scope": scope])
        }
        return ([["kind": "removeKeepingChildren", "id": folderId]], undo)
    }

    /// Adds a deleted pin back where it was, under its guid: adding a
    /// deleted guid again is news to every device (`Document::add_favorite`).
    func restore(_ pin: PinRow, at place: PinPlace) async {
        guard let parent = place.parent, let url = pin.url else { return }
        var add: [String: Any] = [
            "kind": "addFavorite", "favoriteKind": "favorite", "guid": pin.guid, "parent": parent,
            "name": pin.name, "url": url,
        ]
        add["before"] = place.previous
        add["after"] = place.next
        var ops = [add]
        if let scope = place.scope, !scope.isEmpty {
            ops.append(["kind": "setPinScope", "id": pin.id, "scope": scope])
        }
        await editFavorites(ops)
    }

    /// Moves a pin or folder of pins to the end of Favorites and clears its
    /// Show in choices, as one change (pins-root spec §6).
    /// Returns the ops that make again a folder the move dissolved.
    @discardableResult
    func moveToFavorites(_ pin: PinRow) async -> [[String: Any]] {
        guard let root = favoritesRootId else { return [] }
        let dissolve = dissolving(pin.id, to: root)
        var ops: [[String: Any]] = []
        if pin.scope != nil {
            ops.append(["kind": "setPinScope", "id": pin.id])
        }
        var move: [String: Any] = ["kind": "moveNode", "id": pin.id, "newParent": root]
        move["before"] = lastChild(of: root)
        ops.append(move)
        ops += dissolve?.ops ?? []
        return await editFavorites(ops) ? dissolve?.undo ?? [] : []
    }

    /// Deletes the pin (pins-root spec §7).
    func deletePin(_ pin: PinRow) async {
        await editFavorites([["kind": "remove", "id": pin.id]])
    }

    func renamePin(_ pin: PinRow, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, name != pin.name else { return }
        var op: [String: Any] = ["kind": "setContent", "id": pin.id, "name": name]
        op["url"] = pin.url
        await editFavorites([op])
    }

    /// Sets the address a pin returns to.
    func setPinAddress(_ pin: PinRow, to url: URL) async {
        let address = Self.normalAddress(url)
        guard address != pin.url, Self.opensHere(address) else { return }
        await editFavorites([["kind": "setContent", "id": pin.id, "name": pin.name, "url": address]])
    }

    /// Shows a pin in `workspaces` alone, or in every Workspace when that is
    /// all of them, so it shows in ones made later too (pins spec §7).
    func setPinScope(_ pin: PinRow, to workspaces: Set<String>) async {
        let mine = Set(self.workspaces.filter { $0.agent == nil }.map(\.id))
        guard !workspaces.isEmpty else { return }
        var op: [String: Any] = ["kind": "setPinScope", "id": pin.id]
        op["scope"] = workspaces.isSuperset(of: mine) ? nil : Array(workspaces).sorted()
        await editFavorites([op])
    }

    // MARK: Favorites

    /// The top of Favorites, which the Favorites page opens on.
    var favoritesRootId: String? { favorites.first { $0.guid == Self.favoritesRoot }?.id }

    /// What a folder shows, in order: its favorites, folders and
    /// separators, without pins, which the pins row shows (pins spec §8.2).
    func favoriteItems(in parent: String) -> [Favorite] {
        favorites.filter { $0.parent == parent && !$0.pinned }
    }

    /// How many favorites a folder holds at any depth, as the desktop
    /// counts them (`SvalFavoritesStore.countIn`).
    func favoriteCount(in folder: String) -> Int {
        favoriteItems(in: folder).reduce(0) { count, item in
            switch item.kind {
            case "favorite": count + 1
            case "folder": count + favoriteCount(in: item.id)
            default: count
            }
        }
    }

    func favorite(_ id: String) -> Favorite? { favorites.first { $0.id == id } }

    /// Every favorite of `url` in Favorites, which the address bar's star
    /// fills for (`SvalFavoritesStore.favoritesWithUrl`): a pin is no
    /// favorite (decision 0137), nor is an item under another root.
    func favorites(of url: URL) -> [Favorite] {
        guard let root = favoritesRootId else { return [] }
        let address = Self.normalAddress(url)
        return favorites.filter { item in
            guard item.kind == "favorite", item.url == address else { return false }
            var parent = item.parent
            for _ in 0..<64 {
                guard let at = parent else { return false }
                if at == root { return true }
                parent = favorite(at)?.parent
            }
            return false
        }
    }

    /// The address a favorite or pin holds for `url`: parsed and written
    /// back, as the desktop stores one (`normalUrl`), so two spellings of
    /// one address are one favorite. A scheme and host take lower case, a
    /// scheme's default port goes, and an empty path is "/".
    static func normalAddress(_ url: URL) -> String {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.absoluteString }
        parts.scheme = parts.scheme?.lowercased()
        if let host = parts.host { parts.host = host.lowercased() }
        if (parts.scheme == "https" && parts.port == 443) || (parts.scheme == "http" && parts.port == 80) {
            parts.port = nil
        }
        if parts.host != nil, parts.path.isEmpty { parts.path = "/" }
        return parts.url?.absoluteString ?? url.absoluteString
    }

    /// Adds a page at the end of Favorites' top level, named with its
    /// title, as the desktop's star does (`SvalFavorites.addPage`).
    @discardableResult
    func addFavorite(_ url: URL, title: String) async -> Favorite? {
        let address = url.absoluteString
        guard Self.opensHere(address), let root = favoritesRootId else { return nil }
        let guid = Self.mintGuid()
        var add: [String: Any] = [
            "kind": "addFavorite", "favoriteKind": "favorite", "guid": guid, "parent": root,
            "name": title.isEmpty ? address : title, "url": address,
        ]
        add["before"] = favorites.last { $0.parent == root }?.id
        guard await editFavorites([add]) else { return nil }
        return favorite(favoriteId(guid: guid))
    }

    /// Makes an empty folder at the end of `parent`. Returns its id.
    func addFavoriteFolder(named name: String, in parent: String) async -> String? {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return nil }
        let guid = Self.mintGuid()
        var add: [String: Any] = [
            "kind": "addFavorite", "favoriteKind": "folder", "guid": guid, "parent": parent, "name": name,
        ]
        add["before"] = favorites.last { $0.parent == parent }?.id
        return await editFavorites([add]) ? favoriteId(guid: guid) : nil
    }

    func renameFavorite(_ item: Favorite, to name: String) async {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, name != item.name else { return }
        var op: [String: Any] = ["kind": "setContent", "id": item.id, "name": name]
        op["url"] = item.url
        await editFavorites([op])
    }

    func setFavoriteAddress(_ item: Favorite, to url: URL) async {
        let address = Self.normalAddress(url)
        guard address != item.url, Self.opensHere(address) else { return }
        await editFavorites([["kind": "setContent", "id": item.id, "name": item.name, "url": address]])
    }

    /// Where an item sits in its folder: what puts it back there.
    struct FavoritePlace {
        let parent: String?
        let previous: String?
        let next: String?
    }

    func place(of item: Favorite) -> FavoritePlace {
        let siblings = favorites.filter { $0.parent == item.parent }
        let at = siblings.firstIndex { $0.id == item.id }
        return FavoritePlace(
            parent: item.parent,
            previous: at.flatMap { $0 > 0 ? siblings[$0 - 1].id : nil },
            next: at.flatMap { $0 + 1 < siblings.count ? siblings[$0 + 1].id : nil })
    }

    /// Whether `folder` is `item` or inside it, where `item` can't move.
    func isWithin(_ folder: String, _ item: String) -> Bool {
        var node: String? = folder
        while let id = node {
            if id == item { return true }
            node = favorite(id)?.parent
        }
        return false
    }

    /// Moves an item to the end of `folder`. Returns where it was.
    func moveFavorite(_ item: Favorite, to folder: String) async -> FavoritePlace? {
        guard item.parent != folder, !isWithin(folder, item.id) else { return nil }
        let back = place(of: item)
        var op: [String: Any] = ["kind": "moveNode", "id": item.id, "newParent": folder]
        op["before"] = favorites.last { $0.parent == folder && $0.id != item.id }?.id
        return await editFavorites([op]) ? back : nil
    }

    func moveFavorite(_ id: String, back place: FavoritePlace) async {
        guard let parent = place.parent else { return }
        var op: [String: Any] = ["kind": "moveNode", "id": id, "newParent": parent]
        op["before"] = place.previous
        op["after"] = place.next
        await editFavorites([op])
    }

    /// Deletes items, each folder with everything in it, as one change. Returns the change that brings them all back
    /// where they were (`SvalFavoritesStore`'s `#deleteOps`): adding a
    /// deleted guid again is news to every device (`Document::add_favorite`).
    func deleteFavorites(_ items: [Favorite]) async -> [[String: Any]]? {
        let top = items.filter { item in !items.contains { $0.id != item.id && isWithin(item.parent ?? "", $0.id) } }
        guard !top.isEmpty else { return nil }
        var undo: [[String: Any]] = []
        func readd(_ item: Favorite, previous: String?, next: String?) {
            var add: [String: Any] = [
                "kind": "addFavorite", "favoriteKind": item.kind, "guid": item.guid ?? "", "name": item.name,
            ]
            add["parent"] = item.parent
            add["before"] = previous
            add["after"] = next
            add["url"] = item.url
            if item.local { add["local"] = true }
            undo.append(add)
            var last: String?
            for child in favorites where child.parent == item.id {
                readd(child, previous: last, next: nil)
                last = child.id
            }
        }
        for item in top {
            let at = place(of: item)
            readd(item, previous: at.previous, next: at.next)
        }
        guard await editFavorites(top.map { ["kind": "remove", "id": $0.id] }) else { return nil }
        return undo
    }

    /// Whether a pin already has `item`'s address, when Pin is not offered
    /// for it (pins-root spec §6).
    func hasPin(for item: Favorite) -> Bool {
        item.kind == "favorite" && favorites.contains { $0.pinned && $0.kind == "favorite" && $0.url == item.url }
    }

    /// Pins a favorite or folder: a copy of it, with new guids, at the end
    /// of the row, the favorite left where it is (pins-root spec §6). A
    /// bookmarklet inside a folder is copied too, and gets no tile.
    func pinFavorite(_ item: Favorite) async {
        guard let root = pinsRootId else { return }
        var ops: [[String: Any]] = []
        @discardableResult
        func copy(_ from: Favorite, into parent: String, after: String?) -> String? {
            guard from.kind != "separator" else { return nil }
            let guid = Self.mintGuid()
            var add: [String: Any] = [
                "kind": "addFavorite", "favoriteKind": from.kind, "guid": guid, "parent": parent, "name": from.name,
            ]
            add["before"] = after
            if let url = from.url {
                add["url"] = url
                if from.local { add["local"] = true }
            }
            ops.append(add)
            let id = favoriteId(guid: guid)
            var last: String?
            for child in favorites where child.parent == from.id {
                last = copy(child, into: id, after: last) ?? last
            }
            return id
        }
        copy(item, into: root, after: lastChild(of: root))
        await editFavorites(ops)
    }

    /// Applies `ops` to Favorites and pins as one batch.
    @discardableResult
    func editFavorites(_ ops: [[String: Any]]) async -> Bool {
        await edit(ops, in: favoritesDocument)
    }

    @discardableResult
    private func edit(_ op: [String: Any]) async -> Bool {
        await edit([op])
    }

    /// Every change the user makes, to any document, comes through here:
    /// applied as one batch, all of it or none, and shown at once. The pass
    /// that carries it to the shared folder runs behind it, since a pass can
    /// take seconds and nothing on screen waits for it.
    @discardableResult
    private func edit(_ ops: [[String: Any]], in document: String = workspacesDocument) async -> Bool {
        if document == workspacesDocument, touchesPrivate(ops) { return await editPrivate(ops) }
        guard let syncer = await loadedSyncer() else { return false }
        // Titles held back go out with any other change to the tree, as
        // the desktop's flush carries them, ahead of it so a tab the
        // change removes still takes its title first.
        let (held, taken) = document == workspacesDocument ? heldTitleOps() : ([], [:])
        let ops = held + ops
        let kind = ops.compactMap { $0["kind"] as? String }.joined(separator: "+")
        let started = ContinuousClock.now
        do {
            let json = try JSONSerialization.data(withJSONObject: ops)
            try await syncer.edit(document, opsJson: String(decoding: json, as: UTF8.self))
            Diagnostics.log("edit: \(document) \(kind) in \((ContinuousClock.now - started).components.attoseconds / 1_000_000_000_000_000 + (ContinuousClock.now - started).components.seconds * 1000) ms")
            if message != nil { message = nil }
        } catch {
            Diagnostics.log("edit: \(document) \(kind) failed \(Diagnostics.name(error))")
            message = error.localizedDescription
            TitleHold.shared.putBack(taken)
            return false
        }
        await refreshRows()
        Task { await sync() }
        return true
    }

    /// What a refresh began from: the syncer, its documents' revisions,
    /// and the private session's document and revision.
    private struct RefreshMark: Equatable {
        let syncer: ObjectIdentifier
        let revisions: Revisions
        let own: ObjectIdentifier?
        let ownRevision: UInt64?
    }

    @ObservationIgnored private let refreshes = Coalescing()
    /// What the latest refresh began from.
    @ObservationIgnored private var refreshedFrom: RefreshMark?

    private func refreshMark(_ syncer: Syncer) async -> RefreshMark {
        let revisions = await syncer.revisions()
        return RefreshMark(syncer: ObjectIdentifier(syncer), revisions: revisions,
                           own: privateDocument.map(ObjectIdentifier.init), ownRevision: privateDocument?.revision())
    }

    /// Reads the documents again and shows what changed. `read` is the
    /// tree as a pass's end already read it, and the syncer it came from.
    /// A refresh asked for while one runs waits for it, and runs again
    /// only if a document moved since that one began.
    private func refreshRows(_ read: (Syncer, TreeRead)? = nil) async {
        var waited = false
        await refreshes.run(isDue: {
            waited = true
            guard let syncer else { return false }
            return await refreshMark(syncer) != refreshedFrom
        }, { [weak self] in
            // A read taken before a refresh this one waited on is older
            // than what that refresh showed.
            await self?.refreshOnce(waited ? nil : read)
        })
    }

    private func refreshOnce(_ read: (Syncer, TreeRead)?) async {
        guard let syncer else { return }
        let refresh = Signposts.refresh.beginInterval("refreshRows")
        // A read from a syncer that was replaced meanwhile counts another
        // syncer's revisions.
        func current() -> Bool { self.syncer === syncer }
        let mark = await refreshMark(syncer)
        refreshedFrom = mark
        let revisions = mark.revisions
        let outlining = Signposts.outline.beginInterval("outline")
        // A pass reads the tree before this refresh takes its mark, and an
        // edit landing between the two is in the mark: a read without it
        // would stand for the mark, and the edit's own refresh, finding the
        // mark unmoved, would show nothing.
        var tree = read.flatMap { $0.0 === syncer ? $0.1.current(at: revisions.workspaces) : nil }
        if tree == nil { tree = await syncer.treeRead(since: treeStore.revision) }
        let own = privateDocument?.outline() ?? []
        Signposts.outline.endInterval("outline", outlining)
        let assigning = Signposts.outline.beginInterval("rows")
        // Set only when changed: every view reading them redraws on each
        // set, and a refresh often changes nothing.
        let ownIds = Set(own.map(\.id))
        if ownIds != privateIds { privateIds = ownIds }
        var treeChange = TreeStore.Change.none
        if current(), let tree { treeChange = treeStore.install(tree, own: own) }
        if treeChange != .none {
            reindexLauncher()
            browser.refreshBar()
        }
        Signposts.outline.endInterval("rows", assigning, "\(self.rows.count) rows")
        let reading = Signposts.refresh.beginInterval("settings")
        if marks.settingsDue(revisions) {
            let (revision, synced) = await syncer.settings()
            if current(), marks.keepSettings(at: revision), !NSDictionary(dictionary: synced).isEqual(to: settings) {
                settings = synced
                browser?.applyMediaChoices()
            }
        }
        Signposts.refresh.endInterval("settings", reading, "\(self.settings.count) settings")
        let favoring = Signposts.refresh.beginInterval("favorites")
        if marks.favoritesDue(revisions) {
            let (revision, read) = await syncer.favorites()
            let marked = Self.markingPins(read)
            if current(), marks.keepFavorites(at: revision), marked != favorites { favorites = marked }
        }
        await keepFavoriteRoots()
        Signposts.refresh.endInterval("favorites", favoring, "\(self.favorites.count) favorites")
        let pinning = Signposts.refresh.beginInterval("pins")
        var pinsChanged = false
        let listed = workspaces
        let shown = Dictionary(listed.map { ($0.id, $0.agent != nil) }, uniquingKeysWith: { a, _ in a })
        if marks.pinsDue(revisions, for: shown) {
            let (revision, all) = await syncer.pins(workspaces: listed.map(\.id))
            var pins: [String: [PinRow]] = [:]
            for workspace in listed where workspace.agent == nil {
                // The phone opens web addresses only, so another device's pin
                // at any other address gets no tile (pins spec §5, decision
                // 1372).
                pins[workspace.id] = all[workspace.id]?
                    .filter { $0.kind == "folder" || $0.url.map(Self.opensHere) ?? false }
            }
            if current(), marks.keepPins(at: revision, for: shown), pins != pinsByWorkspace {
                pinsByWorkspace = pins
                pinsChanged = true
            }
        }
        Signposts.refresh.endInterval("pins", pinning, "\(self.pinsByWorkspace.count) workspaces")
        let pages = Signposts.refresh.beginInterval("pages")
        // Which pages live follows the tree's tabs and the pins alone.
        if treeChange == .structure || pinsChanged {
            browser.reconcile()
            PagePreviews.shared.keep(only: Browser.pictured(rows, pins: pinsByWorkspace))
        }
        await browser.offloadHiddenWorkspaces()
        Signposts.refresh.endInterval("pages", pages)
        Signposts.refresh.endInterval("refreshRows", refresh, "\(self.rows.count) rows")
    }

    /// `rows` with each one under the pins root marked a pin.
    private static func markingPins(_ rows: [Favorite]) -> [Favorite] {
        guard let root = rows.first(where: { $0.guid == pinsRoot })?.id else { return rows }
        let parents = Dictionary(rows.map { ($0.id, $0.parent) }, uniquingKeysWith: { first, _ in first })
        func under(_ id: String) -> Bool {
            var at = parents[id] ?? nil
            for _ in 0..<rows.count {
                guard let parent = at else { return false }
                if parent == root { return true }
                at = parents[parent] ?? nil
            }
            return false
        }
        return rows.map { row in
            var row = row
            row.pinned = under(row.id)
            return row
        }
    }

    @ObservationIgnored private var keepingFavoriteRoots = false

    /// Makes any root folder the favorites document lacks, and moves pins
    /// still carrying the old pin flag into the pins root, as the desktop
    /// does on start (`SvalFavoritesStore.start`, pins-root spec §8). A
    /// phone that starts syncing a folder has no roots until it makes them.
    private func keepFavoriteRoots() async {
        guard browsing, !keepingFavoriteRoots else { return }
        let missing = Self.rootGuids.filter { guid in !favorites.contains { $0.guid == guid } }
        let marked = favorites.contains(where: \.marked)
        guard !missing.isEmpty || marked else { return }
        keepingFavoriteRoots = true
        defer { keepingFavoriteRoots = false }
        var ops: [[String: Any]] = missing.map {
            ["kind": "addFavorite", "favoriteKind": "folder", "guid": $0, "name": ""]
        }
        if marked { ops.append(["kind": "movePinsToRoot"]) }
        if await editFavorites(ops) {
            Diagnostics.log("favorites: made \(missing.count) roots\(marked ? ", moved pins to their root" : "")")
        }
    }

    private static func resolveBookmark() -> URL? {
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

/// The Workspace sheet's strip's runs of Workspaces (`AppModel.workspaceSections`).
struct WorkspaceSections {
    let own: OutlineRow?
    let people: [OutlineRow]
    let devices: [OutlineRow]
    let agents: [(name: String, rows: [OutlineRow])]

    /// Every Workspace, in the strip's order.
    var ordered: [OutlineRow] {
        (own.map { [$0] } ?? []) + people + devices + agents.flatMap(\.rows)
    }
}
