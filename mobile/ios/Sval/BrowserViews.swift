// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Observation
import SwiftUI
import WebKit

/// The page in front, with the bar under it.
struct BrowserView: View {
    @Environment(AppModel.self) private var model
    @Environment(Toasts.self) private var toasts
    @Environment(\.appearance) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.verticalSizeClass) private var verticalSize
    @Environment(\.horizontalSizeClass) private var horizontalSize
    @State private var showingTabs = false
    @State private var showingSite = false
    /// What to say once the site menu closes, after the page reloads.
    @State private var pendingNotice: String?
    /// What the site menu's page group asked for, done once it has closed.
    @State private var pendingPage: PageAction?
    /// The tab the site menu's Move to Workspace… is moving.
    @State private var movingTab: OutlineRow?
    /// The tab whose media card is open.
    @State private var mediaCard: String?
    /// What the address field is open for: the tab in front or a new tab.
    @State private var entering: Entry?
    /// The bar's swipe toward another Workspace.
    @State private var swipe = BarSwipeSession()
    @State private var barFrame: CGRect = .zero
    private var barHeight: CGFloat { barFrame.height }
    @AppStorage(Walkthrough.doneKey) private var walkthroughDone = false
    /// The walkthrough's page, which the page and the bar's light share.
    @State private var walkthroughPage = 0
    /// Set by the Workspace sheet's New Tab, done once the sheet is gone.
    @State private var newTabAfterSheet = false
    /// What iOS keeps clear round the screen, as the browser's own
    /// geometry reports it.
    @State private var safeArea = EdgeInsets()
    /// The scrub through the Workspace's tabs while the address is held,
    /// or through the Workspaces while the Workspace button is.
    @State private var scrubs = ScrubSession()
    /// Whether the Workspace shows as the upright sheet; sideways it is
    /// the panel.
    @State private var sheetShown = false
    /// Whether the Workspace shows as the popover from the bar's Workspace
    /// button, where the screen is regular both ways: an iPad's.
    @State private var popoverShown = false
    /// Set while the app itself takes the sheet away to show the panel.
    @State private var swappingSheet = false
    /// The room iOS keeps clear at each side of a sideways screen. Pages
    /// stay inside it; the bar runs through it, since the Dynamic Island
    /// sits at mid-height, clear of the bar.
    private var sideInset: CGFloat {
        verticalSize == .compact ? max(safeArea.leading, safeArea.trailing) : 0
    }
    /// The favorite the star's Rename is renaming.
    @State private var renamingFavorite: Favorite?
    /// The favorite the star's Move to… is moving.
    @State private var movingFavorite: Favorite?
    /// The split whose Rename Split card is open over the page.
    @State private var renamingSplit: OutlineRow?
    /// Remove from This Site, while the person picks an element.
    @State private var picking: ElementPick?

    private enum Entry { case current, newTab }

    /// What the bar's controls do. One instance for the view's life, so the
    /// bar's inputs compare equal across this view's redraws.
    @State private var barActions = BarActions()

    private var browser: Browser { model.browser }
    private var workspace: OutlineRow? { browser.workspaceId.flatMap(model.row) }

    /// What covers the main screen: the Workspace as sheet, panel or
    /// popover, or another sheet, setup's cover or a download's Quick Look.
    private var covering: ToastCover {
        if showingTabs { return .workspace }
        if movingTab != nil || movingFavorite != nil || showingSite || model.showsSetup
            || browser.downloads.preview != nil { return .other }
        return .none
    }

    var body: some View {
        let token = model.tint(of: workspace)
        let theme = Theme(scheme, tint: token)
        ZStack(alignment: .bottom) {
            keyCommands
            // The page runs to the screen's foot, under the bar's glass.
            page(theme)
                .ignoresSafeArea(.container, edges: .bottom)
                .overlay {
                    // The page steps back while the strip is up.
                    Color.black.opacity(scrubs.isOpen ? 0.25 : 0)
                        .ignoresSafeArea()
                        .allowsHitTesting(false)
                }
            VStack(spacing: 0) {
                BrowserBar(facts: browser.bar, colors: BarColors(token: model.tint(of: workspace), dark: scheme == .dark),
                           actions: bindBarActions(), mediaCard: mediaCard)
                    .padding(.horizontal, -sideInset)
                    // The Launcher's field grows out of the bar, which
                    // steps aside while it's open.
                    .opacity(entering == nil ? 1 : 0)
                    .modifier(SwipingBar(session: swipe, width: barFrame.width, gesture: workspaceSwipe, yields: trayInBar,
                                         isEnabled: !scrubs.isOpen))
                    .modifier(ScrubFeedback(session: scrubs))
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                        toasts.barHeight = $0.height
                        barFrame = $0
                    }
            }
            // The walkthrough's light on the capsule its page names.
            if !walkthroughDone, let capsule = Walkthrough.capsule(on: walkthroughPage),
               browser.currentTabId == nil, workspace?.id == model.ownWorkspace?.id, entering == nil,
               verticalSize != .compact, barFrame.width > 0 {
                OpenBarSpotlight(size: CGSize(width: barFrame.width, height: barHeight), capsule: capsule)
                    .transition(.opacity)
            }
            ScrubLayer(session: scrubs, theme: theme, colors: BarColors(token: token, dark: scheme == .dark),
                       sideInset: sideInset, barHeight: barHeight)
            SwipeHUDLayer(session: swipe)
            if let id = mediaCard {
                Color.clear
                    .contentShape(.rect)
                    .ignoresSafeArea()
                    .onTapGesture { withAnimation(Motion.overlay) { mediaCard = nil } }
                MediaCard(tabId: id) { withAnimation(Motion.overlay) { mediaCard = nil } }
                    // Over the page, as a sheet is: VoiceOver stays in it,
                    // and the escape gesture closes it.
                    .accessibilityAddTraits(.isModal)
                    .accessibilityAction(.escape) { withAnimation(Motion.overlay) { mediaCard = nil } }
                    .padding(.bottom, barHeight + 8)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
            }
            pickCard
            if let entering {
                AddressEntry(newTab: entering == .newTab) { enter(nil) }
                    // A dark keyboard in private, as Firefox's is.
                    .environment(\.colorScheme, browser.privateInFront ? .dark : scheme)
            }
        }
        // What covers the main screen decides where toasts show.
        .onChange(of: covering, initial: true) { toasts.covered(by: covering) }
        .onChange(of: token, initial: true) { toasts.tint = token }
        .onChange(of: scheme, initial: true) { toasts.dark = scheme == .dark }
        .renameFavoriteAlert($renamingFavorite)
        .renameSplitAlert($renamingSplit)
        // What went wrong says so as every notice over the page does,
        // which VoiceOver reads out as it shows.
        .onChange(of: model.message, initial: true) { _, message in
            guard let message else { return }
            toasts.show(Toast(text: message, symbol: "exclamationmark.triangle.fill"))
        }
        .onAppear {
            browser.downloads.onFailure = { [toasts] name in
                toasts.show(Toast(text: "Couldn’t download “\(name)”", symbol: "exclamationmark.triangle.fill"))
            }
        }
        .sheet(item: $movingTab) { tab in
            MoveSheet(row: tab)
                .tintedSheet(token)
                .presentationDetents([.large])
        }
        .sheet(item: $movingFavorite) { item in
            FavoritesMoveSheet(item: item)
                .tintedSheet(token)
                .presentationDetents([.large])
        }
        .onGeometryChange(for: EdgeInsets.self) { $0.safeAreaInsets } action: { safeArea = $0 }
        .ignoresSafeArea(.container, edges: .bottom)
        .overlay(alignment: .leading) {
            // Sideways, a sheet at 4/5 would leave the tree two rows, so the
            // Workspace opens as a panel from the leading edge (12f3).
            // The panel slides in; the scrim under it fades.
            ZStack(alignment: .leading) {
                if showingTabs && verticalSize == .compact {
                    theme.scrim
                        .ignoresSafeArea()
                        .onTapGesture { showingTabs = false }
                        .transition(.opacity)
                    WorkspaceSheet(onNewTab: { showingTabs = false; enter(.newTab) }, onClose: { showingTabs = false })
                        .accessibilityAddTraits(.isModal)
                        .accessibilityAction(.escape) { showingTabs = false }
                        .frame(width: 452)
                        .clipShape(UnevenRoundedRectangle(bottomTrailingRadius: 32, topTrailingRadius: 32))
                        // Glass, as the upright sheet is.
                        .background {
                            UnevenRoundedRectangle(bottomTrailingRadius: 32, topTrailingRadius: 32)
                                .fill(.clear)
                                .glassEffect(.regular, in: UnevenRoundedRectangle(bottomTrailingRadius: 32, topTrailingRadius: 32))
                        }
                        // The panel runs to the screen's edges but keeps
                        // clear of the keyboard.
                        .ignoresSafeArea(.container, edges: [.leading, .vertical])
                        .gesture(DragGesture(minimumDistance: 20).onEnded { drag in
                            if drag.translation.width < -60 { showingTabs = false }
                        })
                        .transition(reduceMotion ? .opacity : .move(edge: .leading))
                }
            }
        }
        .animation(reduceMotion ? Motion.reduced : .easeOut(duration: 0.22), value: showingTabs && verticalSize == .compact)
        // Turning the phone sideways swaps the sheet for the panel. That
        // close is the app's own, so it leaves the Workspace open; only the
        // user's closing the sheet closes it.
        .onChange(of: showingTabs) { placeWorkspace() }
        // Settings in the sideways panel is in no sheet, so setup opens at
        // once.
        .onChange(of: model.setUpRequested) {
            guard model.setUpRequested, !sheetShown, !popoverShown else { return }
            model.setUpRequested = false
            model.settingUp = true
        }
        .onChange(of: verticalSize) {
            placeWorkspace()
            logSides()
        }
        .onChange(of: horizontalSize) { placeWorkspace() }
        .sheet(isPresented: $sheetShown, onDismiss: {
            if swappingSheet { swappingSheet = false } else { showingTabs = false }
            workspaceSheetGone()
        }) {
            // A glass sheet inset from the screen's edges, which iOS draws
            // for a sheet short of full height (14b1).
            WorkspaceSheet(onNewTab: { newTabAfterSheet = true })
                .presentationDetents([.fraction(0.8)])
                .presentationDragIndicator(.hidden)
        }
        .overlayPreferenceValue(WorkspaceButtonBounds.self) { anchor in
            GeometryReader { proxy in
                if let anchor {
                    let button = proxy[anchor]
                    Color.clear
                        .popover(isPresented: $popoverShown, attachmentAnchor: .rect(.rect(button)), arrowEdge: .bottom) {
                            WorkspaceSheet(onNewTab: { newTabAfterSheet = true })
                                // The size the sheet has on the largest
                                // iPhone, 80% of its 956pt height, within
                                // the room above the button.
                                .frame(width: 440, height: min(765, button.minY - proxy.safeAreaInsets.top - 16))
                                .onDisappear(perform: workspaceSheetGone)
                        }
                }
            }
            .allowsHitTesting(false)
        }
        .onChange(of: popoverShown) {
            guard !popoverShown else { return }
            if swappingSheet { swappingSheet = false } else { showingTabs = false }
        }
        .sheet(isPresented: $showingSite, onDismiss: {
            if let text = pendingNotice {
                toasts.show(Toast(text: text, icon: "pr-shield-off"))
                pendingNotice = nil
            }
            if let action = pendingPage {
                pendingPage = nil
                page(action)
            }
        }) {
            SiteMenuView(onProtectionsOff: { site in pendingNotice = "Protections off for \(site)" },
                         onPage: { pendingPage = $0 })
                .tintedSheet(token)
                // A Form has no height of its own to fit a sheet to, so
                // the menu takes the system's heights.
                .presentationDetents([.medium, .large])
        }
        // What shows over the page and the sheets it opens take the
        // Workspace's colour, as the bar does.
        .environment(\.sheetTint, token)
    }

    /// Sets the bar's actions from this draw of the view, whose environment
    /// and state they read, and returns them.
    private func bindBarActions() -> BarActions {
        let actions = barActions
        actions.site = { showingSite = true }
        actions.address = { enter(.current) }
        actions.workspace = { showingTabs = true }
        actions.newTab = { enter(.newTab) }
        actions.media = { id in withAnimation(Motion.overlay) { mediaCard = mediaCard == id ? nil : id } }
        actions.split = splitAction
        actions.scrub = scrubbed
        actions.privateSession = { open in
            Task {
                if open {
                    if await model.showPrivateSession() { enter(.newTab) }
                } else {
                    await model.endPrivateSession()
                    toasts.show(.privateClosed)
                }
            }
        }
        return actions
    }

    /// What the site menu's page group asked for.
    private func page(_ action: PageAction) {
        switch action {
        case .move(let tab):
            movingTab = tab
        case .pin(let tab, let url):
            Task { await browser.pin(tab, url: url) }
        case .moveToFavorites(let pin):
            Task { toasts.show(await model.moveToFavoritesKeepingPage(pin, title: pin.name.isEmpty ? pin.url ?? "" : pin.name)) }
        case .star(let star):
            self.star(star)
        case .removeElement:
            picking = browser.currentPage().flatMap(ElementPick.init(view:))
            Diagnostics.log("picker: \(picking == nil ? "no page to pick on" : "open")")
        }
    }

    /// Remove from This Site's card, while the person picks.
    @ViewBuilder private var pickCard: some View {
        if let picking {
            PickCard(pick: picking, bottomRoom: barHeight, onCancel: { self.picking = nil }, onRemove: { remove(picking) })
        }
    }

    /// Saves the picked element's rule in My filters, hides it in the open
    /// page at once, and offers Undo, which takes out that line alone.
    private func remove(_ pick: ElementPick) {
        guard let stop = pick.stop, let line = pick.line,
              let (key, value) = MyFilters.adding(line, settings: model.settings) else { return }
        let place = pick.scope == pick.site && pick.hostScope != nil ? "all of \(pick.site)" : pick.scope
        picking = nil
        Task {
            await model.setSetting(key, to: value)
            let sheet = await pick.hide(stop.selector)
            Diagnostics.log("picker: saved a line at depth \(pick.depth), \(stop.count) match(es), hidden at once: \(sheet != nil)")
            toasts.show(Toast(text: "Removed from \(place)", undo: {
                Task {
                    await model.setSetting(key, to: nil)
                    if let sheet { await pick.unhide(sheet) }
                }
            }, seconds: 8))
        }
    }

    /// What the address bar's star asked for. Each change shows at once,
    /// and a toast offers to move or put back what it changed.
    private func star(_ action: StarAction) {
        switch action {
        case .add(let url, let title):
            Task {
                guard let item = await model.addFavorite(url, title: title) else { return }
                toasts.show(Toast(text: "Added to Favorites", undo: { movingFavorite = item }, action: "Move to…"))
            }
        case .rename(let item):
            renamingFavorite = item
        case .move(let item):
            movingFavorite = item
        case .remove(let item):
            guard let url = item.url.flatMap(URL.init(string:)) else { return }
            Task {
                guard let undo = await model.removeFavorites(of: url) else { return }
                toasts.show(Toast(text: "Removed from Favorites") { Task { await model.editFavorites(undo) } })
            }
        }
    }

    /// What the split menu asked for, on the split in front and its
    /// focused pane. Each is one write, shown at once.
    private func splitAction(_ action: SplitAction) {
        guard let split = browser.splitInFront, let pane = model.row(split.focused) else { return }
        switch action {
        case .move(let step):
            Task { await model.movePane(pane, by: step) }
        case .separate:
            Task { await model.separate(split.split) }
        case .rename:
            renamingSplit = split.split
        // A private pane or split closes with no entry, so with no Undo.
        case .closeTab:
            Task {
                guard let entry = await browser.close(pane) else { return }
                toasts.show(.closed(1, title: pane.displayTitle) { Task { await browser.reopen(entry) } })
            }
        case .closeAll:
            let count = model.children(of: split.split.id).filter { $0.kind == .tab }.count
            Task {
                guard let entry = await browser.closeSplit(split.split) else { return }
                toasts.show(.closed(count) { Task { await browser.reopenSplit(entry) } })
            }
        }
    }

    private func placeWorkspace() {
        let popover = showingTabs && horizontalSize == .regular && verticalSize == .regular
        let sheet = showingTabs && verticalSize != .compact && !popover
        if showingTabs && (sheetShown && !sheet || popoverShown && !popover) { swappingSheet = true }
        sheetShown = sheet
        popoverShown = popover
    }

    /// Once the Workspace's sheet or popover has gone: its New Tab opens
    /// the Launcher, so its leaving can't take the keyboard with it, and
    /// Settings' setup opens.
    private func workspaceSheetGone() {
        if newTabAfterSheet {
            newTabAfterSheet = false
            enter(.newTab)
        }
        if model.setUpRequested {
            model.setUpRequested = false
            model.settingUp = true
        }
    }

    /// What iOS keeps clear on each side, for the device log.
    private func logSides() {
        Diagnostics.log("layout: \(verticalSize == .compact ? "sideways" : "upright"), kept clear left \(Int(safeArea.leading)) right \(Int(safeArea.trailing)) top \(Int(safeArea.top)) bottom \(Int(safeArea.bottom))")
    }

    private func enter(_ entry: Entry?) {
        entering = entry
    }

    /// A hardware keyboard's commands, as Safari names and keys them. They
    /// draw nothing.
    private var keyCommands: some View {
        ZStack {
            Button("Open Location") { enter(.current) }.keyboardShortcut("l")
            Button("New Tab") { enter(.newTab) }.keyboardShortcut("t")
            Button("Close Tab", action: closeFront).keyboardShortcut("w")
            Button("Reload Page") { browser.reload() }.keyboardShortcut("r")
            Button("Back") { browser.goBack() }.keyboardShortcut("[")
            Button("Forward") { browser.goForward() }.keyboardShortcut("]")
        }
        .accessibilityElement(children: .ignore)
        .accessibilityHidden(true)
        .opacity(0)
        .frame(width: 0, height: 0)
    }

    /// Closes the tab in front, with Undo, as its row's × does. A private
    /// tab closes with no entry, so with no Undo.
    private func closeFront() {
        guard let row = browser.currentTabId.flatMap(model.row), row.kind == .tab else { return }
        Task {
            guard let entry = await browser.close(row) else { return }
            toasts.show(.closed(1, title: row.displayTitle) { Task { await browser.reopen(entry) } })
        }
    }

    @ViewBuilder private func page(_ theme: Theme) -> some View {
        ZStack {
            // Tabs playing behind stay in the window even with no tab in
            // front, so switching to an empty Workspace doesn't stop them.
            let split = browser.splitInFront
            WebContainer(pages: browser.stagedPages(), showsFront: split == nil,
                         bottomCover: verticalSize == .compact ? Browser.sidewaysBarRoom : Browser.barRoom,
                         tint: theme.tint)
            if let picking {
                PickSurface(pick: picking, tint: UIColor(theme.accent))
            }
            if let split {
                SplitStage(split: split)
            } else if browser.onPrivateHome {
                EmptyHome(workspace: workspace) { enter(.newTab) }
            } else if let id = browser.currentTabId, let file = browser.downloads.tabs[id],
                      let row = model.row(id), let address = row.url {
                DownloadPage(row: row, address: address, file: file, workspace: workspace)
            } else if let failure = browser.loadFailure {
                FailedPage(failure: failure, row: browser.currentTabId.flatMap(model.row), workspace: workspace)
            } else if let id = browser.currentTabId, let row = model.row(id),
                      let address = row.url, Browser.openable(row) == nil,
                      // A page that is loading or showing something is the
                      // tab's own: the tree's address catches up after.
                      browser.currentURL == nil {
                elsewhere(row, address: address, theme: theme)
            } else if browser.currentTabId == nil, workspace != nil, workspace?.id == model.ownWorkspace?.id {
                DeviceHome(workspace: workspace, done: $walkthroughDone, page: $walkthroughPage) { enter(.newTab) }
            } else if browser.currentTabId == nil {
                EmptyHome(workspace: workspace) { enter(.newTab) }
            }
        }
    }

    /// A tab whose address isn't http or https, which Sval on iPhone can't
    /// load, drawn as Sval's own page with the address to copy. The tree
    /// never brings one to the front; this shows only when one is already
    /// there, as when another device changed the front tab's address.
    private func elsewhere(_ row: OutlineRow, address: String, theme: Theme) -> some View {
        VStack(spacing: 16) {
            NoticeMark(symbol: "laptopcomputer", theme: theme)
            Text("Sval on \(UIDevice.current.model) can't open this tab")
                .font(SvalFont.outfit(22, .bold, relativeTo: .title2))
                .foregroundStyle(theme.text)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text("Sval on \(UIDevice.current.model) opens only web pages, and this tab's address isn't a web address. The tab stays in your Workspace and keeps syncing to your other devices.")
                .font(.system(.body))
                .foregroundStyle(theme.body)
                .multilineTextAlignment(.center)
            NoticeAddress(address: address, theme: theme)
            HStack(spacing: 10) {
                CopyButton(title: "Copy Address", text: address, localOnly: browser.inPrivate)
                    .foregroundStyle(theme.text)
                Button("Close Tab", systemImage: "xmark", role: .destructive) {
                    Task { await browser.close(row) }
                }
                .foregroundStyle(theme.dangerText)
            }
            .buttonStyle(.glass)
            .padding(.top, 4)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.sheet)
    }

    // MARK: Swiping between Workspaces

    /// Whether the sideways bar holds a split's tray, whose own swipe the
    /// Workspace swipe must not take (12d).
    private var trayInBar: Bool {
        verticalSize == .compact && (browser.splitInFront?.run.count ?? 0) > 2
    }

    // MARK: Scrubbing through tabs

    private func scrubbed(_ phase: ScrubPhase) {
        switch phase {
        case .began(let kind):
            guard !scrubs.isOpen, let workspace = browser.workspaceId else { return }
            let opened: TabScrub
            switch kind {
            case .tabs:
                let items = TabScrub.items(in: workspace, model: model)
                guard items.count > 1 || (items.count == 1 && !items[0].holds(browser.currentTabId)) else { return }
                opened = TabScrub(kind: kind, items: items,
                                  start: items.firstIndex { $0.holds(browser.currentTabId) } ?? 0)
            case .workspaces:
                // The private session is one Workspace, and the bar's swipe
                // passes it by (13b).
                let items = TabScrub.workspaces(model: model)
                guard !browser.privateInFront, items.count > 1 else { return }
                opened = TabScrub(kind: kind, items: items, start: items.firstIndex { $0.id == workspace } ?? 0)
            }
            withAnimation(reduceMotion ? Motion.reduced : .spring(duration: 0.3, bounce: 0.2)) {
                scrubs.open(opened)
            }
            runAtEdges()
        case .moved(let point):
            guard scrubs.isOpen else { return }
            if !scrubs.move(to: point) { endScrub(switching: false) }
        case .ended:
            endScrub(switching: true)
        }
    }

    /// Takes the strip away, going to the page or Workspace under the
    /// finger unless the scrub was let go.
    private func endScrub(switching: Bool) {
        scrubs.stopRun()
        guard let ended = scrubs.scrub else { return }
        let item = ended.items[ended.index]
        withAnimation(reduceMotion ? Motion.reduced : .smooth(duration: 0.22)) {
            scrubs.close()
            guard switching, !item.holds(browser.currentTabId) else { return }
            switch item {
            case .pin(let pin, _): browser.selectPin(pin)
            case .tab(let row, _): browser.select(row.id)
            case .split(let split, let panes, _):
                let ids = panes.map(\.id)
                if let id = browser.focusedPane(of: split.id, among: ids) ?? ids.first { browser.select(id) }
            case .workspace(let row): browser.showWorkspace(row.id)
            }
        }
    }

    /// While the finger rests near either edge of the screen, the strip runs
    /// on toward that end, faster the nearer the finger is to the edge, since
    /// the screen is narrower than a long Workspace's slide.
    private func runAtEdges() {
        scrubs.run?.cancel()
        scrubs.run = Task { @MainActor in
            let tick = 1.0 / 60
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(tick))
                guard !Task.isCancelled, scrubs.isOpen, let finger = scrubs.finger else { continue }
                let inLeft = (barFrame.minX + TabScrub.edge - finger.x) / TabScrub.edge
                let inRight = (finger.x - (barFrame.maxX - TabScrub.edge)) / TabScrub.edge
                let depth = min(max(inLeft, inRight, 0), 1)
                guard depth > 0 else { continue }
                let rate = TabScrub.slowest + (TabScrub.fastest - TabScrub.slowest) * Double(depth * depth)
                scrubs.runOn((inRight > 0 ? 1 : -1) * rate * tick)
            }
        }
    }

    private var workspaceSwipe: some Gesture {
        DragGesture(minimumDistance: 14)
            .onChanged { drag in
                // The private session is one Workspace, so the swipe does
                // nothing there (13b).
                guard swipe.swipingTo == nil, !browser.privateInFront,
                      abs(drag.translation.width) > abs(drag.translation.height) else { return }
                swipe.offset = drag.translation.width
            }
            .onEnded { drag in
                guard swipe.swipingTo == nil else { return }
                let far = BarSwipeSession.switches(offset: swipe.offset, predicted: drag.predictedEndTranslation.width,
                                                   width: barFrame.width)
                guard far, let target = swipe.target(in: model) else {
                    withAnimation(.smooth(duration: 0.2)) { swipe.offset = 0 }
                    return
                }
                swipe.swipes += 1
                guard !reduceMotion else {
                    swipe.offset = 0
                    browser.showWorkspace(target.id)
                    return
                }
                swipe.swipingTo = target
                withAnimation(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.22)) {
                    swipe.offset = swipe.offset < 0 ? -barFrame.width : barFrame.width
                } completion: {
                    var instant = Transaction()
                    instant.disablesAnimations = true
                    withTransaction(instant) {
                        // The bar that slid in is the one that stays.
                        browser.showWorkspace(target.id, openingBar: false)
                        swipe.offset = 0
                        swipe.swipingTo = nil
                    }
                }
            }
    }
}

/// The bar's Workspace swipe under way. The bar's offset, the next
/// Workspace's bar beside it and the swipe's indicator read it, so a touch
/// sample redraws them and leaves the screen around them be.
@MainActor
@Observable
final class BarSwipeSession {
    /// How far the bar has been swiped toward another Workspace.
    var offset: CGFloat = 0
    /// The Workspace a finished swipe is sliding to.
    var swipingTo: OutlineRow?
    /// How many swipes have switched Workspace, which taps as each does.
    var swipes = 0

    /// The Workspace the swipe would switch to, or the one a finished
    /// swipe is sliding to.
    func target(in model: AppModel) -> OutlineRow? {
        if let swipingTo { return swipingTo }
        guard offset != 0 else { return nil }
        return Self.next(in: model.workspaces, from: model.browser.workspaceId, offset: offset)
    }

    /// The Workspace a swipe of `offset` would switch to: the next one for
    /// a swipe left, the one before for a swipe right, wrapping at the ends
    /// as the desktop's panel swipe does.
    static func next(in order: [OutlineRow], from current: String?, offset: CGFloat) -> OutlineRow? {
        guard order.count > 1, let index = order.firstIndex(where: { $0.id == current }) else { return nil }
        let step = offset < 0 ? 1 : -1
        return order[(index + step + order.count) % order.count]
    }

    /// Whether a swipe let go at `offset`, and heading for `predicted`,
    /// switches: once past 30% of the bar's `width`, or a flick headed past
    /// 60% of it the same way.
    static func switches(offset: CGFloat, predicted: CGFloat, width: CGFloat) -> Bool {
        abs(offset) > width * 0.3 || (abs(predicted) > width * 0.6 && predicted.sign == offset.sign)
    }
}

/// The bar following a Workspace swipe, with the next Workspace's bar
/// coming in beside it. Anywhere on the bar, a drag that moves sideways
/// switches Workspace, and a touch that doesn't move stays a tap on the
/// button under it.
private struct SwipingBar<G: Gesture>: ViewModifier {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let session: BarSwipeSession
    let width: CGFloat
    let gesture: G
    let yields: Bool
    let isEnabled: Bool

    func body(content: Content) -> some View {
        content
            .offset(x: reduceMotion ? 0 : session.offset)
            .overlay {
                if let target = session.target(in: model), !reduceMotion {
                    BarPreview(workspace: target)
                        .offset(x: session.offset + (session.offset < 0 ? width : -width))
                }
            }
            .modifier(BarSwipe(gesture: gesture, yields: yields, isEnabled: isEnabled))
            .sensoryFeedback(.selection, trigger: session.swipes)
    }
}

/// While the bar is swiped, the Workspace the swipe would switch to.
private struct SwipeHUDLayer: View {
    @Environment(AppModel.self) private var model
    let session: BarSwipeSession

    var body: some View {
        if let target = session.target(in: model), abs(session.offset) > 12 {
            let order = model.workspaces
            WorkspaceSwipeHUD(
                target: target, index: order.firstIndex { $0.id == target.id } ?? 0, count: order.count)
                .padding(.bottom, 164)
        }
    }
}

/// The strip over the bar while a scrub is under way. It alone reads the
/// scrub's steps, so a step redraws it and leaves the screen be.
private struct ScrubLayer: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let session: ScrubSession
    let theme: Theme
    let colors: BarColors
    let sideInset: CGFloat
    let barHeight: CGFloat

    var body: some View {
        if let scrub = session.scrub {
            TabScrubStrip(scrub: scrub, theme: theme, colors: colors)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { session.stripFrame = $0 }
                .padding(.horizontal, 12 + sideInset)
                .padding(.bottom, barHeight + 8)
                .transition(reduceMotion ? .opacity
                    : .opacity.combined(with: .scale(scale: 0.4, anchor: .bottom)))
        }
    }
}

/// The walkthrough's light on the bar, while the bar is open. It reads
/// the fold's phase itself, so the screen around it never reads the fold.
private struct OpenBarSpotlight: View {
    @Environment(AppModel.self) private var model
    let size: CGSize
    let capsule: Int

    var body: some View {
        if model.browser.fold.phase == .open {
            BarSpotlight(size: size, capsule: capsule)
                .transition(.opacity)
        }
    }
}

/// The bar's Workspace swipe: ahead of the buttons under it, so a drag
/// that starts on one still switches, unless the bar holds a control
/// with a swipe of its own, which then goes first. Both attachments stay
/// in place and one is switched off, so the bar under them keeps its
/// identity, and its state, as a tray comes and goes.
private struct BarSwipe<G: Gesture>: ViewModifier {
    let gesture: G
    let yields: Bool
    /// Off while the address is held for a scrub, whose slide is its own.
    let isEnabled: Bool

    func body(content: Content) -> some View {
        content
            .highPriorityGesture(gesture, isEnabled: isEnabled && !yields)
            .gesture(gesture, isEnabled: isEnabled && yields)
    }
}
