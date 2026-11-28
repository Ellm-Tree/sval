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

    var stage: Stage = .chooseFolder {
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
    var settings: [String: Any] = [:] {
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
    var historyPages: [HistoryPage] = [] {
        didSet { reindexLauncher() }
    }
    /// Every favorite, folder and separator, from the favorites document.
    var favorites: [Favorite] = [] {
        didSet { if favorites != oldValue { reindexLauncher() } }
    }
    /// Each Workspace's pins, in the row's order (pins spec §4, §7).
    var pinsByWorkspace: [String: [PinRow]] = [:] {
        didSet {
            if pinsByWorkspace != oldValue { reindexLauncher() }
            browser?.refreshBar()
        }
    }
    /// What the Launcher searches, built from the rows, pins, Favorites,
    /// history and settings after each change to them.
    private(set) var launcherIndex = LauncherIndex.empty
    /// History's share of `launcherIndex`, prepared with `historyPages`.
    @ObservationIgnored var launcherHistory = LauncherIndex.History.empty
    /// `historyPages` by address, as of the last read of the weeks.
    @ObservationIgnored var historyStore = HistoryStore()
    /// The settings' share of `launcherIndex`, read with `settings`.
    @ObservationIgnored private var launcherSettings = LauncherIndex.Settings([:])
    /// The shares `launcherIndex` was last built from.
    @ObservationIgnored private var launcherParts = LauncherParts()
    @ObservationIgnored private var indexing: Task<Void, Never>?
    @ObservationIgnored private var indexBuilds = 0
    var lastSynced: Date?
    /// Read by `sync` alone, so no view observes it.
    @ObservationIgnored var syncing = false
    var message: String?
    /// The live pages. Made at the end of `init`, since it holds this model.
    @ObservationIgnored private(set) var browser: Browser!
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    var syncer: Syncer? {
        didSet { if syncer !== oldValue { marks = ReadMarks() } }
    }
    /// What the refresh last read of `syncer`'s documents beside the tree.
    @ObservationIgnored var marks = ReadMarks()
    /// The engine's load at launch: its Keychain reads and the pass over
    /// each document's own copy run off the main thread, and what needs
    /// the engine waits for it (`loadedSyncer`).
    @ObservationIgnored var loadingSyncer: Task<Syncer, Error>?
    var source: Source? {
        didSet {
            // Runs from `init` too: `@Observable` makes the assignment there
            // go through the setter.
            guard source != oldValue else { return }
            open(previous: oldValue)
        }
    }
    var watcher: FolderWatcher?
    /// The SMB or Dropbox folder's watcher.
    var changeWatcher: ChangeWatcher?
    /// The connection to an SMB or Dropbox folder, made on first use and
    /// again after one fails.
    var connected: SharedFolder?
    /// The files the last pass could not use.
    var lastProblems: Set<String> = []
    /// When the folder stopped answering, while it hasn't since.
    var unreachableSince: Date?
    /// How long the folder may go unanswered before the app says so, as the
    /// desktop's `FOLDER_UNAVAILABLE_AFTER_MS`: blips are
    /// normal on every folder Sval supports.
    static let unavailableAfter: TimeInterval = 3 * 60
    /// Whether a change arrived during a pass, which then runs again.
    var syncAgain = false
    static let bookmarkKey = "sharedFolderBookmark"
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

    let edges: Edges
    var secrets: Secrets { edges.secrets }

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
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.stopWatching()
                // iOS may end the app in the background without a word, so
                // held titles are written as it goes there, as a desktop
                // window writes its own as it closes.
                Task { await self?.writeHeldTitles() }
            }
        })
        TitleHold.shared.onDue = { [weak self] id in
            Task { await self?.writeHeldTitles([id]) }
        }
        visitTitleHold.onDue = { [weak self] url in
            guard let held = self?.heldVisitTitles.removeValue(forKey: url) else { return }
            Task { try? await self?.syncer?.setVisitTitle(held.id, title: held.title, at: held.at) }
        }
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.startWatching()
                self?.updateBlocker(always: true)
            }
        })
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

    /// Stops this model and its browser answering the app's notifications,
    /// as an app that ends does. The model and its browser hold each other,
    /// so a model dropped without this keeps answering, and in a process
    /// that makes models one after another, each `didBecomeActive` reaches
    /// every model made before.
    func stopObserving() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        browser.stopObserving()
    }

    /// The engine, once its load at launch is done; nil when it failed.
    func loadedSyncer() async -> Syncer? {
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
    func reindexLauncher() {
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

    @ObservationIgnored let visitTitleHold = TitleHold()
    /// The latest title held back for each address, with its visit.
    @ObservationIgnored var heldVisitTitles: [String: (id: String, title: String, at: Date)] = [:]

    var firstChange: ContinuousClock.Instant?
    var settling: Task<Void, Never>?

    @ObservationIgnored var makingOwnWorkspace = false

    // MARK: Private session

    /// The private session's tree: one temporary Workspace, in an engine
    /// document held in memory alone. It is never passed to a pass, so it
    /// never reaches this device's copy or the shared folder (desktop
    /// private-windows spec, "What can never be written"). Nil while no
    /// session is open.
    @ObservationIgnored var privateDocument: SvalDocument?
    /// The id it writes under, made for the session and never saved.
    @ObservationIgnored var privateDevice = Data()
    /// The private session's stamps, which only move forward as every
    /// device's do.
    @ObservationIgnored var privateClock = StampClock()
    /// The private session's Workspace.
    var privateWorkspace: String?
    /// Every node of the private session, which nothing may save.
    var privateIds: Set<String> = [] {
        didSet {
            if privateIds != oldValue { reindexLauncher() }
            browser?.refreshBar()
        }
    }
    /// The video and audio choices made in the private session, which
    /// apply to its tabs alone and go with it.
    var privateMedia: [String: SiteRules.Media] = [:]
    /// The protections choices made in the private session, kept as
    /// `privateMedia` is.
    var privateProtections: [String: String] = [:] {
        didSet { browser?.refreshBar() }
    }

    /// Whether the kept sync key opens nothing in the folder chosen. The
    /// phone then joins the folder, as a backup key that doesn't match is
    /// refused, and the key stays in the Keychain, since choosing the
    /// wrong folder must not cost it. Kept across launches, so a relaunch
    /// never takes the key as ready for this folder. A key stored by a
    /// join or a start clears it.
    @ObservationIgnored var keyUnconfirmed = UserDefaults.standard.bool(forKey: AppModel.keyUnconfirmedKey) {
        didSet { UserDefaults.standard.set(keyUnconfirmed, forKey: Self.keyUnconfirmedKey) }
    }
    /// The sync key this phone makes when it's the first device in a
    /// folder, until setup moves on from showing its backup.
    var startedKey: Data?
    /// Whether the next pass may make the folder's Sval data: this phone
    /// started syncing in the folder and no pass has written to it yet. It
    /// outlasts a relaunch, since every pass refuses a folder with no Sval
    /// data until one does.
    @ObservationIgnored var starting = UserDefaults.standard.bool(forKey: AppModel.startingKey) {
        didSet { UserDefaults.standard.set(starting, forKey: Self.startingKey) }
    }
    /// Why the last join failed, for the code screen to say.
    var joinFailure: JoinError?
    /// Whether first run's last step shows: the Workspaces arriving after a
    /// join, until the user opens one.
    var welcoming = false

    /// Whether a join is waiting for the other device's offer to arrive.
    var waitingForOffer = false
    var joinTask: Task<Void, Never>?
    /// The wait between two looks for an offer, cut short when the folder
    /// changes.
    var joinSleep: Task<Void, Error>?

    @ObservationIgnored let refreshes = Coalescing()
    /// What the latest refresh began from.
    @ObservationIgnored var refreshedFrom: RefreshMark?

    @ObservationIgnored var keepingFavoriteRoots = false
}

/// The Workspace sheet's strip's runs of Workspaces (`AppModel.workspaceSections`).
struct WorkspaceSections {
    let own: OutlineRow?
    let people: [OutlineRow]
    let devices: [OutlineRow]
    let agents: [(name: String, rows: [OutlineRow])]

    /// Every Workspace, in the strip's order.
    var ordered: [OutlineRow] {
        swipes + agents.flatMap(\.rows)
    }

    /// The Workspaces the bar's swipe steps through: the strip's order
    /// without the agents', which are each agent's to drive.
    var swipes: [OutlineRow] {
        (own.map { [$0] } ?? []) + people + devices
    }
}
