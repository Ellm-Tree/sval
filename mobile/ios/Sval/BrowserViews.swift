// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import WebKit

/// The page in front, with the bar under it.
struct BrowserView: View {
    @Environment(AppModel.self) private var model
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
    @State private var notice: Toast?
    /// The tab whose media card is open.
    @State private var mediaCard: String?
    /// What the address field is open for: the tab in front or a new tab.
    @State private var entering: Entry?
    /// How far the bar has been swiped toward another Workspace.
    @State private var swipe: CGFloat = 0
    @State private var barHeight: CGFloat = 100
    @State private var barWidth: CGFloat = 393
    @State private var barFrame: CGRect = .zero
    @AppStorage(Walkthrough.doneKey) private var walkthroughDone = false
    /// The walkthrough's page, which the page and the bar's light share.
    @State private var walkthroughPage = 0
    /// Set by the Workspace sheet's New Tab, done once the sheet is gone.
    @State private var newTabAfterSheet = false
    /// What iOS keeps clear round the screen, as the browser's own
    /// geometry reports it.
    @State private var safeArea = EdgeInsets()
    /// The Workspace a finished swipe is sliding to.
    @State private var swipingTo: OutlineRow?
    /// How many swipes have switched Workspace, which taps as each does.
    @State private var swipes = 0
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

    private var browser: Browser { model.browser }
    private var workspace: OutlineRow? { browser.workspaceId.flatMap(model.row) }

    var body: some View {
        let token = model.tint(of: workspace)
        let theme = Theme(scheme, tint: token)
        ZStack(alignment: .bottom) {
            keyCommands
            // The page runs to the screen's foot, under the bar's glass.
            page(theme)
                .ignoresSafeArea(.container, edges: .bottom)
            VStack(spacing: 0) {
                BrowserBar(
                    workspace: workspace, colors: BarColors(token: model.tint(of: workspace), dark: scheme == .dark),
                    onSite: { showingSite = true },
                    onAddress: { enter(.current) },
                    onWorkspace: { showingTabs = true },
                    onNewTab: { enter(.newTab) },
                    mediaCard: mediaCard,
                    onMedia: { id in withAnimation(Motion.overlay) { mediaCard = mediaCard == id ? nil : id } },
                    onStar: star,
                    onSplit: splitAction,
                    onPrivate: { open in
                        Task {
                            if open {
                                if await model.showPrivateSession() { enter(.newTab) }
                            } else {
                                await model.endPrivateSession()
                                TopNotice.show(.privateClosed, token: model.tint(of: browser.workspaceId.flatMap(model.row)),
                                               scheme: scheme)
                            }
                        }
                    })
                    .padding(.horizontal, -sideInset)
                    // The Launcher's field grows out of the bar, which
                    // steps aside while it's open.
                    .opacity(entering == nil ? 1 : 0)
                    .offset(x: reduceMotion ? 0 : swipe)
                    .overlay {
                        // The next Workspace's bar, coming in beside this one.
                        if let target = swipeTarget, !reduceMotion {
                            BarPreview(workspace: target, fold: browser.barFold)
                                .offset(x: swipe + (swipe < 0 ? barWidth : -barWidth))
                        }
                    }
                    // Anywhere on the bar: a drag that moves sideways
                    // switches Workspace, and a touch that doesn't move
                    // stays a tap on the button under it.
                    .modifier(BarSwipe(gesture: workspaceSwipe, yields: trayInBar))
                    .sensoryFeedback(.selection, trigger: swipes)
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: {
                        barHeight = $0.height
                        barWidth = $0.width
                        barFrame = $0
                    }
            }
            // The walkthrough's light on the capsule its page names.
            if !walkthroughDone, let capsule = Walkthrough.capsule(on: walkthroughPage),
               browser.currentTabId == nil, workspace?.id == model.ownWorkspace?.id, entering == nil,
               verticalSize != .compact, browser.barFold == 0, barFrame.width > 0 {
                BarSpotlight(size: CGSize(width: barFrame.width, height: barHeight), capsule: capsule)
                    .transition(.opacity)
            }
            if let target = swipeTarget, abs(swipe) > 12 {
                let order = model.workspaces
                WorkspaceSwipeHUD(
                    target: target, index: order.firstIndex { $0.id == target.id } ?? 0, count: order.count)
                    .padding(.bottom, 164)
            }
            if let id = mediaCard {
                Color.black.opacity(0.001)
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
        .toast($notice, lift: barHeight, top: showingTabs)
        .renameFavoriteAlert($renamingFavorite)
        .renameSplitAlert($renamingSplit)
        // What went wrong says so as every notice over the page does,
        // which VoiceOver reads out as it shows.
        .onChange(of: model.message, initial: true) { _, message in
            guard let message else { return }
            notice = Toast(text: message, symbol: "exclamationmark.triangle.fill")
        }
        .onAppear {
            browser.downloads.onFailure = { [weak browser] name in
                browser?.toast = Toast(text: "Couldn’t download “\(name)”", symbol: "exclamationmark.triangle.fill")
            }
        }
        .onChange(of: browser.toast?.id) {
            guard let toast = browser.toast else { return }
            notice = toast
            browser.toast = nil
        }
        .sheet(item: $movingTab) { tab in
            MoveSheet(row: tab) { notice = $0 }
                .tintedSheet(token)
                .presentationDetents([.large])
        }
        .sheet(item: $movingFavorite) { item in
            FavoritesMoveSheet(item: item) { notice = $0 }
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
        .animation(reduceMotion ? .easeOut(duration: 0.12) : .easeOut(duration: 0.22), value: showingTabs && verticalSize == .compact)
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
                notice = Toast(text: text, icon: "pr-shield-off")
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

    /// What the site menu's page group asked for.
    private func page(_ action: PageAction) {
        switch action {
        case .move(let tab):
            movingTab = tab
        case .pin(let tab, let url):
            Task { await browser.pin(tab, url: url) }
        case .moveToFavorites(let pin):
            Task { notice = await model.moveToFavoritesKeepingPage(pin, title: pin.name.isEmpty ? pin.url ?? "" : pin.name) }
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
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
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
            notice = Toast(text: "Removed from \(place)", undo: {
                Task {
                    await model.setSetting(key, to: nil)
                    if let sheet { await pick.unhide(sheet) }
                }
            }, seconds: 8)
        }
    }

    /// What the address bar's star asked for. Each change shows at once,
    /// and a toast offers to move or put back what it changed.
    private func star(_ action: StarAction) {
        switch action {
        case .add(let url, let title):
            Task {
                guard let item = await model.addFavorite(url, title: title) else { return }
                notice = Toast(text: "Added to Favorites", undo: { movingFavorite = item }, action: "Move to…")
            }
        case .rename(let item):
            renamingFavorite = item
        case .move(let item):
            movingFavorite = item
        case .remove(let item):
            guard let url = item.url.flatMap(URL.init(string:)) else { return }
            Task {
                guard let undo = await model.removeFavorites(of: url) else { return }
                notice = Toast(text: "Removed from Favorites") { Task { await model.editFavorites(undo) } }
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
        case .closeTab:
            Task {
                guard let entry = await browser.close(pane) else { return }
                notice = .closed(1, title: pane.displayTitle) { Task { await browser.reopen(entry) } }
            }
        case .closeAll:
            let count = model.children(of: split.split.id).filter { $0.kind == "tab" }.count
            Task {
                guard let entry = await browser.closeSplit(split.split) else { return }
                notice = .closed(count) { Task { await browser.reopenSplit(entry) } }
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

    /// Closes the tab in front, with Undo, as its row's × does.
    private func closeFront() {
        guard let row = browser.currentTabId.flatMap(model.row), row.kind == "tab" else { return }
        let isPrivate = model.isPrivate(row.id)
        Task {
            guard let entry = await browser.close(row), !isPrivate else { return }
            notice = .closed(1, title: row.displayTitle) { Task { await browser.reopen(entry) } }
        }
    }


    @ViewBuilder private func page(_ theme: Theme) -> some View {
        ZStack {
            // Tabs playing behind stay in the window even with no tab in
            // front, so switching to an empty Workspace doesn't stop them.
            let split = browser.splitInFront
            WebContainer(pages: browser.stagedPages(), showsFront: split == nil,
                         bottomCover: verticalSize == .compact ? Browser.sidewaysBarRoom : Browser.barRoom)
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
            Image(systemName: "laptopcomputer")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(theme.body)
                .frame(width: 68, height: 68)
                .background(theme.well, in: .rect(cornerRadius: 20))
                .overlay { RoundedRectangle(cornerRadius: 20).strokeBorder(theme.divider, lineWidth: 1) }
                .accessibilityHidden(true)
            Text("Sval on \(UIDevice.current.model) can't open this tab")
                .font(SvalFont.outfit(22, .bold, relativeTo: .title2))
                .foregroundStyle(theme.text)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text("Sval on \(UIDevice.current.model) opens only web pages, and this tab's address isn't a web address. The tab stays in your Workspace and keeps syncing to your other devices.")
                .font(.system(.body))
                .foregroundStyle(theme.body)
                .multilineTextAlignment(.center)
            Text(address)
                .font(SvalFont.mono(13, relativeTo: .footnote))
                .foregroundStyle(theme.body)
                .lineLimit(3)
                .textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(theme.well, in: .rect(cornerRadius: 12))
            HStack(spacing: 10) {
                CopyButton(title: "Copy Address", text: address)
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

    /// The Workspace a swipe of the bar would switch to: the next one for a
    /// swipe left, the one before for a swipe right, wrapping at the ends as
    /// the desktop's panel swipe does.
    private var swipeTarget: OutlineRow? {
        if let swipingTo { return swipingTo }
        guard swipe != 0 else { return nil }
        let order = model.workspaces
        guard order.count > 1, let index = order.firstIndex(where: { $0.id == browser.workspaceId }) else { return nil }
        let step = swipe < 0 ? 1 : -1
        return order[(index + step + order.count) % order.count]
    }

    /// Whether the sideways bar holds a split's tray, whose own swipe the
    /// Workspace swipe must not take (12d).
    private var trayInBar: Bool {
        verticalSize == .compact && (browser.splitInFront?.run.count ?? 0) > 2
    }

    private var workspaceSwipe: some Gesture {
        DragGesture(minimumDistance: 14)
            .onChanged { drag in
                // The private session is one Workspace, so the swipe does
                // nothing there (13b).
                guard swipingTo == nil, !browser.privateInFront,
                      abs(drag.translation.width) > abs(drag.translation.height) else { return }
                swipe = drag.translation.width
            }
            .onEnded { drag in
                guard swipingTo == nil else { return }
                let far = abs(swipe) > barWidth * 0.3
                    || (abs(drag.predictedEndTranslation.width) > barWidth * 0.6
                        && drag.predictedEndTranslation.width.sign == swipe.sign)
                guard far, let target = swipeTarget else {
                    withAnimation(.smooth(duration: 0.2)) { swipe = 0 }
                    return
                }
                swipes += 1
                guard !reduceMotion else {
                    swipe = 0
                    browser.showWorkspace(target.id)
                    return
                }
                swipingTo = target
                withAnimation(.timingCurve(0.2, 0.8, 0.2, 1, duration: 0.22)) {
                    swipe = swipe < 0 ? -barWidth : barWidth
                } completion: {
                    var instant = Transaction()
                    instant.disablesAnimations = true
                    withTransaction(instant) {
                        // The bar that slid in is the one that stays.
                        let fold = browser.barFold
                        browser.showWorkspace(target.id)
                        browser.keepFold(fold)
                        swipe = 0
                        swipingTo = nil
                    }
                }
            }
    }
}

/// Shows a page that `Browser` owns. The page outlives this view, so it
/// keeps its place when the view is rebuilt.
struct WebContainer: UIViewRepresentable {
    /// Back to front; the last is the page in front. The others are tabs
    /// playing behind it (`Browser.stagedPages`): they stay in the window,
    /// hidden from VoiceOver and touch.
    let pages: [WKWebView]
    /// Whether the last page is the one in front. A split in front shows
    /// its panes itself, and every page here is behind it.
    var showsFront = true
    /// How much of the page's foot the bar covers.
    var bottomCover: CGFloat = Browser.barRoom

    func makeUIView(context: Context) -> PageStage {
        let stage = PageStage()
        updateUIView(stage, context: context)
        return stage
    }

    func updateUIView(_ stage: PageStage, context: Context) {
        if showsFront, let front = pages.last, front.obscuredContentInsets.bottom != bottomCover {
            front.obscuredContentInsets = UIEdgeInsets(top: 0, left: 0, bottom: bottomCover, right: 0)
        }
        stage.show(pages, showsFront: showsFront)
    }
}

/// The view `WebContainer` puts its pages in. A split's pane can take a
/// page from it as the split closes, when the pane is updated after the
/// page has come here, and nothing would put it back until the next
/// update: the stage takes back a page it still shows once the update is
/// over.
final class PageStage: UIView {
    private var pages: [WKWebView] = []
    private var showsFront = true
    private var arranging = false

    func show(_ pages: [WKWebView], showsFront: Bool) {
        self.pages = pages
        self.showsFront = showsFront
        arrange()
    }

    override func willRemoveSubview(_ subview: UIView) {
        super.willRemoveSubview(subview)
        guard !arranging, pages.contains(where: { $0 === subview }) else { return }
        DispatchQueue.main.async { [weak self] in self?.arrange() }
    }

    private func arrange() {
        guard subviews.map(ObjectIdentifier.init) != pages.map(ObjectIdentifier.init)
                || subviews.last?.isUserInteractionEnabled != showsFront else { return }
        arranging = true
        defer { arranging = false }
        if Page.pageDiagnostics {
            Diagnostics.log("tabs: the window shows \(pages.count) page(s), was \(subviews.count)")
        }
        for view in subviews where !pages.contains(where: { $0 === view }) {
            view.removeFromSuperview()
        }
        for (index, page) in pages.enumerated() {
            if page.superview !== self {
                place(page)
            }
            insertSubview(page, at: index)
            let inFront = showsFront && index == pages.count - 1
            page.accessibilityElementsHidden = !inFront
            page.isUserInteractionEnabled = inFront
        }
    }

    private func place(_ page: WKWebView) {
        page.removeFromSuperview()
        page.translatesAutoresizingMaskIntoConstraints = false
        addSubview(page)
        NSLayoutConstraint.activate([
            page.leadingAnchor.constraint(equalTo: leadingAnchor),
            page.trailingAnchor.constraint(equalTo: trailingAnchor),
            page.topAnchor.constraint(equalTo: topAnchor),
            page.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
}

/// The page's site: protections and JavaScript for it, and the blocking
/// level for every site, as the desktop's site controls set them. Each
/// change syncs, and the page reloads to take it.
struct SiteMenuView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    /// Told when protections go off for a site, so the browser can say so
    /// once the page has reloaded.
    var onProtectionsOff: (String) -> Void = { _ in }
    /// What the page group asks for, done once the menu has closed.
    var onPage: (PageAction) -> Void = { _ in }

    /// The page's zoom as the zoom row last set or found it.
    @State private var zoom: Double = 1
    @State private var rulesShown = false
    /// How many elements each hiding rule matches on the page, by line.
    @State private var ruleCounts: [String: Int?] = [:]

    private var theme: Theme { Theme(scheme, tint: sheetTint) }
    private var host: String? { model.browser.currentURL?.host() }
    private var rules: SiteRules { model.siteRules(private: inPrivate) }
    private var inPrivate: Bool { model.browser.privateInFront }

    var body: some View {
        let site = host.flatMap { host in
            SiteRules.scope(of: host).flatMap { scope in SiteRules.site(of: host).map { (host, scope, $0) } }
        }
        Form {
                pageGroup
                if let (host, scope, _) = site {
                    let protections = rules.protectionsOn(for: host)
                    let javaScript = rules.javaScriptEnabled(on: host)
                    Section {
                        toggleRow(
                            icon: "pr-shield", title: "Protections",
                            detail: protections ? "Blocks ads and trackers on this site." : "Protections are off, so ads and trackers load on this site.",
                            isOn: Binding(get: { protections }, set: { on in
                                if inPrivate {
                                    model.setPrivateProtections(scope, on: on)
                                    model.browser.reload()
                                } else {
                                    change(rules.protectionsChange(for: scope, on: on))
                                }
                                if !on { onProtectionsOff(scope) }
                            }))
                        toggleRow(
                            icon: "javascript", title: "JavaScript",
                            detail: javaScript ? "Lets this site run scripts." : "JavaScript is off, so this site's scripts don't run.",
                            isOn: Binding(get: { javaScript }, set: { on in
                                change(rules.javaScriptChange(for: scope, enabled: on))
                            }))
                            // The desktop's private window can't change it
                            // either (`SvalSiteControls`).
                            .disabled(inPrivate)
                        // Takes effect at the next link, so nothing reloads.
                        toggleRow(
                            icon: "sc-external", title: "Keep Links in This Tab",
                            detail: "Links between \(scope) pages can't open a new tab or window.",
                            isOn: Binding(get: { rules.keepLinks(on: host) }, set: { on in
                                let change = rules.keepLinksChange(for: scope, on: on)
                                Task { await model.setSetting(change.key, to: change.value) }
                            }))
                            .disabled(inPrivate)
                        // The site's video and audio choice, as the desktop's
                        // site menu sets it. The page is made again for it.
                        Picker(selection: Binding(get: { rules.media(for: host) }, set: { choice in
                            if inPrivate {
                                model.setPrivateMedia(scope, to: choice)
                                return
                            }
                            let change = rules.mediaChange(for: scope, to: choice)
                            Task { await model.setSetting(change.key, to: change.value) }
                        })) {
                            ForEach(SiteRules.Media.allCases) { Text($0.words).tag($0) }
                        } label: {
                            Label {
                                Text("Video and Audio")
                            } icon: {
                                Image("media").resizable().frame(width: 20, height: 20).foregroundStyle(theme.muted)
                            }
                        }
                        // A rule names the site and syncs, so a private
                        // page can't make one (element picker spec).
                        pageRow(icon: "eraser", title: "Remove from This Site",
                                detail: inPrivate ? "Off in private, because it saves a rule." : nil) {
                            act(.removeElement)
                        }
                        .disabled(inPrivate)
                        removalRules(on: host)
                    }
                    .listRowBackground(theme.cell)
                    Section {
                        zoomRow
                    } header: {
                        SectionCaption("Zoom", color: theme.muted)
                    }
                    .listRowBackground(theme.cell)
                }
        }
        .listSectionSpacing(.compact)
        // A bar keeps the rows' scroll edge effect under the header.
        .safeAreaBar(edge: .top) {
            header(title: site?.1 ?? "Sval", protections: site.map { rules.protectionsOn(for: $0.0) })
                .padding(.horizontal, 20)
                .padding(.top, 20)
                .padding(.bottom, 12)
        }
        .foregroundStyle(theme.text)
        .sheetGround()
    }

    /// The page's zoom on this iPhone, for its host (decision 12): − and +
    /// step along Firefox's zoom steps, and the level between them goes
    /// back to 100%.
    private var zoomRow: some View {
        HStack(spacing: 0) {
            Button { setZoom(PageZoom.step(zoom, by: -1)) } label: {
                Image(systemName: "minus").frame(maxWidth: .infinity, minHeight: 44)
            }
            .accessibilityLabel("Zoom Out")
            .disabled(zoom <= PageZoom.steps[0])
            Button { setZoom(1) } label: {
                Text("\(Int((zoom * 100).rounded()))%")
                    .monospacedDigit()
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .accessibilityLabel("Zoom")
            .accessibilityValue("\(Int((zoom * 100).rounded()))%")
            .accessibilityAdjustableAction { direction in
                setZoom(PageZoom.step(zoom, by: direction == .increment ? 1 : -1))
            }
            Button { setZoom(PageZoom.step(zoom, by: 1)) } label: {
                Image(systemName: "plus").frame(maxWidth: .infinity, minHeight: 44)
            }
            .accessibilityLabel("Zoom In")
            .disabled(zoom >= PageZoom.steps[PageZoom.steps.count - 1])
        }
        .buttonStyle(.borderless)
        .font(.system(.body, weight: .medium))
        .foregroundStyle(theme.text)
        .onAppear { zoom = model.browser.currentZoom }
    }

    private func setZoom(_ level: Double) {
        model.browser.setZoom(level)
        zoom = level
    }

    private func header(title: String, protections: Bool?) -> some View {
        HStack(spacing: 12) {
            Image(protections == false ? "pr-shield-off" : (protections == nil ? "sc-shield-plain" : "pr-shield"))
                .resizable()
                .frame(width: 22, height: 22)
                .foregroundStyle(protections == false ? theme.muted : theme.text)
                .frame(width: 46, height: 46)
                .background(theme.well, in: .rect(cornerRadius: 14))
                .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(theme.divider, lineWidth: 1) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(SvalFont.outfit(20, .bold, relativeTo: .title3))
                    .titleLines()
                Text(protections == nil ? "Not a website. Protections don't apply."
                     : (protections! ? "Protections on" : "Protections off for this site"))
                    .font(.system(.subheadline))
                    .foregroundStyle(theme.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            CloseCircle { dismiss() }
        }
    }

    private func toggleRow(icon: String, title: String, detail: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(.body))
                    Text(detail)
                        .font(.system(.footnote))
                        .foregroundStyle(theme.muted)
                }
            } icon: {
                Image(icon).resizable().frame(width: 20, height: 20).foregroundStyle(theme.muted)
            }
        }
        .tint(theme.action)
    }

    /// The page's own group (14d3): Move to Workspace…, Pin Tab or Move to
    /// Favorites, and Add to Favorites or where it is in Favorites. None of it
    /// applies to a private tab.
    @ViewBuilder private var pageGroup: some View {
        let browser: Browser = model.browser
        let tab = browser.currentTabId.flatMap(model.row).flatMap { $0.kind == "tab" ? $0 : nil }
        let star = StarState(model)
        if !browser.privateInFront, tab != nil || browser.currentPin != nil {
            Section {
                if let tab, let home = model.workspace(of: tab.id).flatMap(model.row) {
                    pageRow(icon: "folder", title: "Move to Workspace…", detail: "In \(WorkspaceTile.name(home))",
                            chevron: true) { act(.move(tab)) }
                }
                if let pin = browser.currentPin {
                    pageRow(icon: "star", title: "Move to Favorites") { act(.moveToFavorites(pin)) }
                } else if let tab, !model.isPane(tab), let url = browser.currentURL ?? tab.url.flatMap(URL.init(string:)),
                          AppModel.opensHere(url.absoluteString) {
                    pageRow(icon: "pin", title: "Pin Tab") { act(.pin(tab, url)) }
                }
                switch star {
                case .add(let url, let title):
                    pageRow(icon: "star", title: "Add to Favorites") { act(.star(.add(url, title: title))) }
                case .favorite(let item):
                    Menu {
                        Button("Rename…", systemImage: "pencil") { act(.star(.rename(item))) }
                        Button("Move to…", systemImage: "folder") { act(.star(.move(item))) }
                        Button("Remove from Favorites", systemImage: "star.slash", role: .destructive) {
                            act(.star(.remove(item)))
                        }
                    } label: {
                        pageLabel(icon: "star.fill", title: favoritePlace(item), detail: nil, chevron: false)
                    }
                case .none:
                    EmptyView()
                }
            }
            .listRowBackground(theme.cell)
        }
    }

    /// The site's removal rules, collapsed each time the menu opens, as
    /// the desktop's site menu lists them (element picker spec §6): a row
    /// for each line that removes something here, newest first. Its X
    /// takes this site out of the line; a private page lists them alone.
    @ViewBuilder private func removalRules(on host: String) -> some View {
        let removals = MyFilters.removals(on: host, settings: model.settings)
        if !removals.isEmpty {
            DisclosureGroup(isExpanded: $rulesShown) {
                ForEach(removals) { removal in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(removal.shown)
                                .font(.system(.footnote).monospaced())
                                .lineLimit(2)
                                .truncationMode(.middle)
                            Text(removalWords(removal))
                                .font(.system(.footnote))
                                .foregroundStyle(theme.muted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if !inPrivate {
                            Button { showAgain(removal) } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 20))
                                    .foregroundStyle(theme.muted)
                                    .frame(width: 44, height: 44)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Delete Rule")
                        }
                    }
                    .frame(minHeight: 44)
                }
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "list.bullet")
                        .font(.system(size: 17))
                        .foregroundStyle(theme.muted)
                        .frame(width: 20, height: 20)
                    Text("Removed from This Site").font(.system(.body))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text("\(removals.count)")
                        .monospacedDigit()
                        .foregroundStyle(theme.muted)
                }
                .frame(minHeight: 44)
            }
            .tint(theme.muted)
            .task(id: rulesShown ? removals.map(\.line) : []) {
                guard rulesShown, let view = model.browser.currentPage() else { return }
                let hiding = removals.filter { $0.kind == .hide }
                let found = await ElementPick.counts(hiding.map(\.shown), in: view)
                ruleCounts = Dictionary(zip(hiding.map(\.id), found), uniquingKeysWith: { a, _ in a })
            }
        }
    }

    /// What a rule's row says it does on this page.
    private func removalWords(_ removal: MyFilters.Removal) -> String {
        if removal.kind == .network { return "Stops a download" }
        guard let n = ruleCounts[removal.id] ?? nil else { return "" }
        return n == 0 ? "Not currently removing anything on this page"
            : "Removes \(n) \(n == 1 ? "element" : "elements") on this page"
    }

    /// Takes this site out of the rule, and shows what it hid in the open
    /// page where Remove hid it this visit.
    private func showAgain(_ removal: MyFilters.Removal) {
        let writes = MyFilters.showingAgain(removal, settings: model.settings)
        Task {
            await model.setSettings(writes.map { ($0.key, $0.value as Any?) })
            if removal.kind == .hide, let view = model.browser.currentPage() {
                await ElementPick.showAgain(removal.shown, in: view)
            }
        }
    }

    private func act(_ action: PageAction) {
        onPage(action)
        dismiss()
    }

    private func pageRow(icon: String, title: String, detail: String? = nil, chevron: Bool = false,
                         action: @escaping () -> Void) -> some View {
        Button(action: action) { pageLabel(icon: icon, title: title, detail: detail, chevron: chevron) }
            .buttonStyle(.plain)
    }

    private func pageLabel(icon: String, title: String, detail: String?, chevron: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 17))
                .foregroundStyle(theme.muted)
                .frame(width: 20, height: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(.body))
                if let detail {
                    Text(detail)
                        .font(.system(.footnote))
                        .foregroundStyle(theme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if chevron {
                Chevron(color: theme.muted)
            }
        }
        .foregroundStyle(theme.text)
        .frame(minHeight: 44)
        .contentShape(.rect)
    }

    /// "In Favorites", or "In Favorites › Travel" for one in a folder.
    private func favoritePlace(_ item: Favorite) -> String {
        guard let parent = item.parent, parent != model.favoritesRootId, let folder = model.favorite(parent) else {
            return "In Favorites"
        }
        return "In Favorites › \(FavoritesView.name(folder))"
    }

    /// Saves `setting` and reloads the page to take it, once the script
    /// rules a JavaScript choice changes are compiled.
    private func change(_ setting: (key: String, value: Any?)) {
        Task {
            await model.setSetting(setting.key, to: setting.value)
            await model.browser.blocker.scriptsApplied()
            model.browser.reload()
            Diagnostics.log("page: reloaded for a site setting")
        }
    }
}

/// The bar's Workspace swipe: ahead of the buttons under it, so a drag
/// that starts on one still switches, unless the bar holds a control
/// with a swipe of its own, which then goes first.
private struct BarSwipe<G: Gesture>: ViewModifier {
    let gesture: G
    let yields: Bool

    func body(content: Content) -> some View {
        if yields {
            content.gesture(gesture)
        } else {
            content.highPriorityGesture(gesture)
        }
    }
}
