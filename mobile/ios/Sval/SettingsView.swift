// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// Sync and blocking for this iPhone, pushed onto the Workspace sheet.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    /// Closes the sheet Settings was pushed onto.
    var onDone: (() -> Void)?
    @State private var leaving = false
    @State private var pairing = false
    @State private var clearing = false
    @AppStorage(TabLayout.key) private var layout = TabLayout.list

    private var theme: Theme { Theme(scheme, tint: sheetTint) }

    var body: some View {
        VStack(spacing: 0) {
            Form {
                // A sync problem is what the Settings button's badge
                // pointed at, so it comes first.
                if syncProblem { syncSection }
                Section {
                    Picker("Show Tabs As", selection: $layout) {
                        ForEach(TabLayout.allCases, id: \.self) { $0.label.tag($0) }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } header: {
                    caption("Show Tabs As")
                } footer: {
                    footnote("Your choice applies only to this \(UIDevice.current.model).")
                }
                .listRowBackground(theme.cell)
                Section {
                    BlockingLevelPicker()
                        .padding(.vertical, 4)
                } header: {
                    caption("Ad and Tracker Blocking")
                } footer: {
                    footnote("The level applies to every site with Protections on. A new level takes a moment to start working.")
                }
                .listRowBackground(theme.cell)
                Section {
                    // The choice for every site without one of its own, as
                    // the desktop's Settings › Sites sets it; it syncs.
                    Picker("All sites", selection: Binding(
                        get: { SiteRules(settings: model.settings).mediaDefault },
                        set: { choice in
                            let change = SiteRules.mediaDefaultChange(to: choice)
                            Task { await model.setSetting(change.key, to: change.value) }
                        })) {
                        ForEach(SiteRules.Media.allCases) { Text($0.words).tag($0) }
                    }
                    Toggle(isOn: Binding(get: { model.browser.keepPlaying }, set: { model.browser.keepPlaying = $0 })) {
                        Text("Keep playing after you leave a tab")
                            .font(.system(.body))
                    }
                    .tint(theme.action)
                    let sites = SiteRules(settings: model.settings).namesWithMediaChoice.count
                    if sites > 0 {
                        NavigationLink {
                            SitesView(onDone: onDone ?? { dismiss() })
                        } label: {
                            LabeledContent("Sites", value: "\(sites)")
                        }
                        .font(.system(.body))
                    }
                } header: {
                    caption("Video and Audio")
                }
                .listRowBackground(theme.cell)
                Section {
                    Button("Clear Browsing Data…") { clearing = true }
                }
                .listRowBackground(theme.cell)
                if model.stage == .ready {
                    if !syncProblem { syncSection }
                } else {
                    Section {
                        Button("Set Up Sync…") {
                            model.setUpRequested = true
                            (onDone ?? { dismiss() })()
                        }
                        .font(.system(.body))
                    } header: {
                        caption("Sync")
                    } footer: {
                        footnote("Your devices share your Workspaces through one folder in iCloud Drive, Dropbox, or on your network.")
                    }
                    .listRowBackground(theme.cell)
                }
                Section {
                    NavigationLink("Licenses") {
                        LicensesView(onDone: onDone ?? { dismiss() })
                    }
                    .font(.system(.body))
                    Button("Privacy Policy") { openPrivacyPolicy() }
                        .font(.system(.body))
                        .foregroundStyle(theme.text)
                }
                .listRowBackground(theme.cell)
            }
        }
        .foregroundStyle(theme.text)
        .sheetGround(glass: true)
        .sheetPage("Settings", onDone: onDone ?? { dismiss() })
        .sheet(isPresented: $pairing) { PairingSheet().tintedSheet(sheetTint) }
        .confirmationDialog("Leave This Folder?", isPresented: $leaving, titleVisibility: .visible) {
            Button("Keep Workspaces on This \(UIDevice.current.model)") {
                model.leaveFolder(startOver: false)
                (onDone ?? { dismiss() })()
            }
            Button("Start Over", role: .destructive) {
                model.leaveFolder(startOver: true)
                // First run opens as on a first launch, once the sheet
                // Settings is in has gone.
                model.setUpRequested = true
                (onDone ?? { dismiss() })()
            }
        } message: {
            Text("This \(UIDevice.current.model) stops syncing with the folder, and your other devices keep syncing through the folder. Start Over also removes your Workspaces and sync key from this \(UIDevice.current.model).")
        }
        .confirmationDialog("Clear Browsing Data?", isPresented: $clearing, titleVisibility: .visible) {
            Button("Clear Browsing Data", role: .destructive) {
                Task { await model.browser.clearBrowsingData() }
            }
        } message: {
            Text("Sval deletes cookies, site data, cached files, site icons, and tab pictures from this \(UIDevice.current.model). Sval keeps your tabs, history, and settings.")
        }
    }

    private var syncProblem: Bool { model.stage == .ready && SyncIndicator(model, now: .now).icon == .warning }

    private func openPrivacyPolicy() {
        guard let workspace = model.browser.workspaceId else { return }
        Task { await model.browser.openNewTab(Self.privacyPolicy, in: workspace) }
        (onDone ?? { dismiss() })()
    }

    private static let privacyPolicy = URL(string: "https://sval.app/privacy/")!

    private var syncSection: some View {
        Section {
            syncRow
            if let place = model.folderPlace {
                NavigationLink {
                    FolderDetail(place: place, onDone: onDone ?? { dismiss() })
                } label: {
                    LabeledContent {
                        Text(place.short)
                            .lineLimit(1)
                            .truncationMode(.head)
                    } label: {
                        Text("Folder")
                    }
                    .font(.system(.body))
                }
            }
            Button("Sync with Another Device") { pairing = true }
                .font(.system(.body))
            Button("Leave This Folder", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { leaving = true }
                .font(.system(.body))
                .foregroundStyle(theme.dangerText)
        } header: {
            caption("Sync")
        }
        .listRowBackground(theme.cell)
    }

    private var syncRow: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let sync = SyncIndicator(model, now: context.date)
            HStack(alignment: .top, spacing: Space.rowGap) {
                SyncMoon(icon: sync.icon, size: Tile.row, ring: theme.cell)
                VStack(alignment: .leading, spacing: Space.lines) {
                    Text(sync.title)
                        .font(.system(.body, weight: .semibold))
                    if !sync.detail.isEmpty {
                        Text(sync.detail)
                            .font(.system(.subheadline))
                            .foregroundStyle(theme.body)
                    }
                    if sync.icon == .offline || sync.icon == .warning {
                        Button("Try Again") { Task { await model.sync() } }
                            .foregroundStyle(theme.text)
                            .buttonStyle(.glass)
                            .padding(.top, 8)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 4)
        }
    }

    private func caption(_ text: String) -> some View {
        SectionCaption(text, color: theme.muted)
    }

    private func footnote(_ text: String) -> some View {
        Text(text)
            .font(.system(.footnote))
            .foregroundStyle(theme.muted)
    }
}

/// A sheet's own top row, drawn in place of the navigation bar so a pushed
/// page lays out once: the bar a pushed page gains while the sheet's root
/// hides it arrives only once the push ends. Back on the left, the title,
/// and Done on the right.
/// A page pushed in a sheet: the system's navigation bar, with its back
/// button and, where the page closes the sheet, Done.
private struct SheetPageBar: ViewModifier {
    let title: String
    let onDone: (() -> Void)?

    func body(content: Content) -> some View {
        content
            .navigationTitle(title)
            .sheetTitleMode(title)
            .toolbar {
                if let onDone {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(role: .close, action: onDone)
                    }
                }
            }
    }
}

extension View {
    func sheetPage(_ title: String, onDone: (() -> Void)? = nil) -> some View {
        modifier(SheetPageBar(title: title, onDone: onDone))
    }
}

/// The sync folder's whole address, and who it signs in as.
private struct FolderDetail: View {
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    let place: (short: String, full: String, user: String?)
    /// Closes the sheet the page was pushed onto, as Settings' Done does.
    let onDone: () -> Void

    var body: some View {
        let theme = Theme(scheme, tint: sheetTint)
        Form {
            Section {
                Text(place.full)
                    .font(SvalFont.code(.callout))
                    .textSelection(.enabled)
            } header: {
                SectionCaption("Address", color: theme.muted)
            }
            .listRowBackground(theme.cell)
            if let user = place.user {
                Section {
                    Text(user).textSelection(.enabled)
                } header: {
                    SectionCaption("User name", color: theme.muted)
                }
                .listRowBackground(theme.cell)
            }
        }
        .foregroundStyle(theme.text)
        .sheetGround(glass: true)
        .sheetPage("Folder", onDone: onDone)
    }
}

/// Every site's blocking level, Off, Balanced or Strict, which syncs. While
/// a new level's rules compile, the note says so; open pages reload once
/// they're ready.
struct BlockingLevelPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint

    private var level: String {
        model.settings[ContentBlocker.levelKey] as? String ?? "balanced"
    }

    var body: some View {
        let theme = Theme(scheme, tint: sheetTint)
        VStack(alignment: .leading, spacing: 10) {
            Picker("Ad and Tracker Blocking", selection: Binding(
                get: { level },
                set: { picked in
                    Task {
                        model.browser.reloadWhenRulesChange = true
                        await model.setSetting(ContentBlocker.levelKey, to: picked)
                    }
                })) {
                Text("Off").tag("off")
                Text("Balanced").tag("balanced")
                Text("Strict").tag("strict")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if model.browser.blocker.applying {
                    ProgressView().controlSize(.mini)
                }
                Text(note)
                    .font(.system(.footnote))
                    .foregroundStyle(theme.muted)
            }
        }
    }

    /// The desktop's description of each level (`settings-blocking.js`).
    private var note: String {
        let name = ["off": "Off", "balanced": "Balanced", "strict": "Strict"][level] ?? "Balanced"
        if model.browser.blocker.applying {
            return "Applying \(name) takes a moment, and goes on if you close this. Open pages reload when \(name) is ready."
        }
        return switch level {
        case "off": "Nothing is blocked."
        case "strict": "Adds lists that block more, including trackers in links, social widgets, and scam sites. Some sites may break."
        case "custom": "Your computer is set to Custom, with lists this \(UIDevice.current.model) doesn't have. This \(UIDevice.current.model) uses Balanced."
        default: "Blocks ads and trackers with lists that rarely break sites."
        }
    }
}
