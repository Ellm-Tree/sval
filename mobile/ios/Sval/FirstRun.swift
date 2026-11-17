// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import AuthenticationServices
import SwiftUI
import UniformTypeIdentifiers

/// First run on the night sky, as the desktop's first run and home page
/// draw it: the folder, then the code, then the Workspaces arriving. The
/// main button stays at the bottom, in reach of the thumb.
struct FirstRunView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            NightSky()
            switch model.stage {
            case .chooseFolder: FolderSteps()
            case .start: StartStep()
            case .join: CodeStep()
            case .ready: ArrivalStep()
            }
        }
        .foregroundStyle(.white)
        .preferredColorScheme(.dark)
    }
}

/// The night sky first run is drawn on: Sval's navy, lighter toward the
/// top, under the home page's stars.
struct NightSky: View {
    var body: some View {
        RadialGradient(
            colors: [Color(hex: 0x13328F), Color(hex: 0x060A2E)],
            center: UnitPoint(x: 0.5, y: 0.22), startRadius: 0, endRadius: 520)
            .overlay {
                Image("starfield").resizable().scaledToFill().opacity(0.7)
            }
            .ignoresSafeArea()
            .accessibilityHidden(true)
    }
}

/// First run's parts, in its type and colours. First run is always dark,
/// so it takes the dark theme's tokens, and its own field and well, which
/// sit deeper than the sheet's.
enum FirstRunStyle {
    private static let theme = Theme(.dark)
    static var lead: Color { theme.body }
    static var muted: Color { theme.muted }
    static var cyan: Color { theme.accent }
    static let field = Color(hex: 0x0C1446)
    static let well = Color(hex: 0x03051A)
    static var line: Color { theme.divider }
    static var warning: Color { theme.warning }
    static var danger: Color { theme.dangerText }

    static func headline(_ text: String, size: CGFloat = 30) -> some View {
        Text(text)
            .font(SvalFont.outfit(size, .heavy, relativeTo: .largeTitle))
            .tracking(-0.035 * size)
            .lineSpacing(-4)
    }

    /// The primary button at the foot of each step.
    static func primary(_ title: String, busy: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if busy { ProgressView().tint(.white) }
                Text(title)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .controlSize(.extraLarge)
    }
}

/// Back, and dots for where the user is in the three steps.
private struct StepBar: View {
    let step: Int
    let onBack: (() -> Void)?

    var body: some View {
        ZStack {
            PageDots(count: 3, current: step, on: FirstRunStyle.cyan, off: Color(hex: 0xA6E8FF, opacity: 0.3),
                     height: 6, wide: 20, through: true)
            .accessibilityElement()
            .accessibilityLabel("Step \(step + 1) of 3")
            if let onBack {
                HStack {
                    Button(action: onBack) {
                        HStack(spacing: 2) {
                            Image(systemName: "chevron.left").font(.system(.title3, weight: .semibold))
                            Text("Back").font(.system(.body))
                        }
                        .foregroundStyle(FirstRunStyle.cyan)
                        .frame(minHeight: 44)
                    }
                    Spacer()
                }
            }
        }
        .padding(.horizontal, 8)
        .frame(minHeight: 44)
        // Back as a navigation bar's is: VoiceOver's escape gesture takes it.
        .accessibilityAction(.escape) { onBack?() }
    }
}

// MARK: The folder

private struct FolderSteps: View {
    @Environment(AppModel.self) private var model
    enum Step { case welcome, choose, dropbox, server }
    @State private var step: Step = .welcome
    @State private var picking = false

    var body: some View {
        Group {
            switch step {
            case .welcome: welcome
            case .choose: choose
            case .dropbox: DropboxStep { step = .choose }
            case .server: ServerStep { step = .choose }
            }
        }
        .animation(.easeOut(duration: 0.2), value: step)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.folder]) { result in
            switch result {
            case .success(let url): model.chooseFolder(url)
            case .failure(let error): model.message = error.localizedDescription
            }
        }
    }

    private var welcome: some View {
        VStack(spacing: 0) {
            VStack(spacing: 28) {
                Image("app-icon")
                    .resizable()
                    .frame(width: 112, height: 112)
                    .clipShape(.rect(cornerRadius: 26))
                    .shadow(color: Color(hex: 0x5CF2FF, opacity: 0.35), radius: 30)
                    .accessibilityHidden(true)
                VStack(spacing: 0) {
                    FirstRunStyle.headline("Your Workspaces.", size: 40)
                    FirstRunStyle.headline("Now in your pocket.", size: 40)
                        .foregroundStyle(LinearGradient(
                            colors: [.white, Color(hex: 0x5CF2FF), Color(hex: 0x0AA0FF)],
                            startPoint: .top, endPoint: .bottom))
                }
                .multilineTextAlignment(.center)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                Text("Sval syncs through a folder you already have, with no account and no Sval cloud.")
                    .font(.system(.body))
                    .foregroundStyle(FirstRunStyle.lead)
                    .multilineTextAlignment(.center)
            }
            .frame(maxHeight: .infinity)
            VStack(spacing: 14) {
                FirstRunStyle.primary("Choose Your Folder") { step = .choose }
                Text("Choose the folder your other devices sync to, or an empty folder to start syncing from this iPhone.")
                    .font(.system(.footnote))
                    .foregroundStyle(FirstRunStyle.muted)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 20)
    }

    private var choose: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepBar(step: 0) { step = .welcome }
            FirstRunStyle.headline("Where's your Sval folder?")
                .padding(.horizontal, 4)
                .padding(.top, 24)
                .accessibilityAddTraits(.isHeader)
            Text("Pick the folder your computer syncs to.")
                .font(.system(.body))
                .foregroundStyle(FirstRunStyle.lead)
                .padding(.horizontal, 4)
                .padding(.bottom, 14)
            List {
                Section {
                    option(icon: "icloud", title: "iCloud Drive", detail: "A folder in your iCloud Drive") { picking = true }
                    option(icon: "shippingbox", title: "Dropbox", detail: "A folder in your Dropbox") {
                        step = .dropbox
                    }
                    option(icon: "server.rack", title: "A server on your network", detail: "A shared folder on a Mac, PC, or NAS") {
                        step = .server
                    }
                }
                .listRowBackground(FirstRunStyle.field)
            }
            .scrollContentBackground(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            if let message = model.message {
                WarningBox(title: message, detail: "")
            }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
    }

    private func option(icon: String, title: String, detail: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(LinearGradient(colors: [Color(hex: 0x2FD0FF), Color(hex: 0x1557E0)],
                                               startPoint: .top, endPoint: .bottom),
                                in: .rect(cornerRadius: 14))
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(.body, weight: .semibold))
                    Text(detail)
                        .font(.system(.subheadline))
                        .foregroundStyle(FirstRunStyle.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Chevron(color: FirstRunStyle.muted)
            }
            .padding(.vertical, 6)
            .contentShape(.rect)
        }
        .foregroundStyle(.white)
    }
}

/// The server's address and sign-in. A field that likely needs fixing gets
/// the warning ring, and nothing typed is cleared.
private struct ServerStep: View {
    @Environment(AppModel.self) private var model
    let onBack: () -> Void

    @State private var host = ""
    @State private var share = ""
    @State private var path = ""
    @State private var username = ""
    @State private var password = ""
    @State private var working = false
    @State private var failure: Error?
    @State private var triedHost = ""
    /// The Server field, which takes the keyboard as the step opens.
    @FocusState private var serverFocused: Bool

    private enum Ring { case none, host, signIn, folder }

    private var ring: Ring {
        switch failure {
        case is ConnectorError:
            switch failure as! ConnectorError {
            case .Unreachable: .host
            case .SignIn: .signIn
            case .NotFound, .AccessDenied: .folder
            case .Other, .DropboxSignIn, .DropboxUnreachable: .none
            }
        case let error as SyncError where error == .notASvalFolder: .folder
        default: .none
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepBar(step: 1, onBack: onBack)
            Form {
                Section {
                    FirstRunStyle.headline("Connect to your server")
                        .padding(.top, 24)
                        .accessibilityAddTraits(.isHeader)
                    if let failure { problem(failure) }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
                Section {
                    field("Server", "192.168.1.20", text: $host, mono: true, ringed: ring == .host)
                        .keyboardType(.URL)
                        .focused($serverFocused)
                    field("Share", "Home", text: $share, ringed: ring == .folder)
                    field("Folder", "Optional", text: $path, ringed: ring == .folder)
                } header: {
                    caption("Server")
                }
                .listRowBackground(FirstRunStyle.field)
                Section {
                    field("User name", "", text: $username, ringed: ring == .signIn)
                        .textContentType(.username)
                    SecureField("", text: $password)
                        .textContentType(.password)
                        .modifier(FieldRow(label: "Password", ringed: ring == .signIn))
                } header: {
                    caption("Sign in")
                } footer: {
                    Text("Sval connects over SMB. The password stays in this iPhone's Keychain.")
                        .font(.system(.footnote))
                        .foregroundStyle(FirstRunStyle.muted)
                }
                .listRowBackground(FirstRunStyle.field)
            }
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .scrollEdgeFade()
            FirstRunStyle.primary(failure == nil ? "Connect" : "Try Again", busy: working, action: connect)
                .disabled(working || host.trimmingCharacters(in: .whitespaces).isEmpty || share.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
        .onAppear { if host.isEmpty { serverFocused = true } }
    }

    private func caption(_ title: String) -> some View {
        SectionCaption(title, color: FirstRunStyle.muted)
    }

    private func field(_ label: String, _ prompt: String, text: Binding<String>, mono: Bool = false, ringed: Bool) -> some View {
        TextField("", text: text, prompt: Text(prompt).foregroundStyle(FirstRunStyle.muted.opacity(0.7)))
            .font(mono ? SvalFont.mono(16, relativeTo: .body) : .system(.body))
            .modifier(FieldRow(label: label, ringed: ringed))
    }

    private func problem(_ error: Error) -> some View {
        let (title, detail): (String, String) = switch ring {
        case .host: ("Can't reach \(triedHost)", "Check that the server is on, and that this iPhone is on the same network.")
        case .signIn: ("\(triedHost) didn't accept that user name and password.", "")
        default: (error.localizedDescription, "")
        }
        return WarningBox(title: title, detail: detail)
    }

    private func connect() {
        working = true
        triedHost = host.trimmingCharacters(in: .whitespaces)
        Task {
            failure = await model.connectSmb(SmbLocation(
                host: triedHost,
                share: share.trimmingCharacters(in: .whitespaces),
                path: path.trimmingCharacters(in: .whitespaces),
                username: username, password: password))
            model.message = nil
            working = false
        }
    }
}

/// Signs in to Dropbox, then lists the user's Dropbox folders to choose the
/// one their computers sync through. Sval reaches Dropbox through Dropbox's
/// API, so any folder the desktop picked can be chosen.
private struct DropboxStep: View {
    @Environment(AppModel.self) private var model
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    let onBack: () -> Void

    @State private var token: String?
    @State private var browser: DropboxFolder?
    /// The folder shown, by Dropbox path. Empty is the root.
    @State private var path = ""
    @State private var folders: [String] = []
    @State private var working = false
    @State private var failure: Error?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepBar(step: 1, onBack: back)
            if browser == nil { signIn } else { chooser }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
    }

    private var signIn: some View {
        VStack(alignment: .leading, spacing: 12) {
            FirstRunStyle.headline("Sign in to Dropbox")
                .padding(.horizontal, 4)
                .padding(.top, 24)
                .accessibilityAddTraits(.isHeader)
            Text("Dropbox asks you to let Sval read and change your files. Sval reads and writes only the folder you choose next.")
                .font(.system(.body))
                .foregroundStyle(FirstRunStyle.lead)
                .padding(.horizontal, 4)
            if let failure { problem(failure) }
            Spacer()
            FirstRunStyle.primary("Sign In to Dropbox", busy: working, action: startSignIn)
                .disabled(working)
        }
    }

    private var chooser: some View {
        VStack(alignment: .leading, spacing: 12) {
            FirstRunStyle.headline("Choose your Sval folder")
                .padding(.horizontal, 4)
                .padding(.top, 24)
                .accessibilityAddTraits(.isHeader)
            Text((["Dropbox"] + path.split(separator: "/").map(String.init)).joined(separator: " › "))
                .font(.system(.subheadline, weight: .medium))
                .foregroundStyle(FirstRunStyle.lead)
                .padding(.horizontal, 4)
            if let failure { problem(failure) }
            List {
                Section {
                    if folders.isEmpty && !working {
                        Text("No folders here")
                            .font(.system(.subheadline))
                            .foregroundStyle(FirstRunStyle.muted)
                            .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    ForEach(folders, id: \.self) { folder in
                        Button { open(folder) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "folder")
                                    .font(.system(size: 17))
                                    .foregroundStyle(FirstRunStyle.cyan)
                                Text(folder.split(separator: "/").last.map(String.init) ?? folder)
                                    .font(.system(.body))
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Chevron(color: FirstRunStyle.muted)
                            }
                            .frame(minHeight: 44)
                            .contentShape(.rect)
                        }
                    }
                }
                .listRowBackground(FirstRunStyle.field)
            }
            .scrollContentBackground(.hidden)
            .scrollEdgeFade()
            FirstRunStyle.primary("Use This Folder", busy: working, action: choose)
                .disabled(working)
        }
    }

    private func problem(_ error: Error) -> some View {
        WarningBox(title: error.localizedDescription, detail: "")
    }

    /// Back goes up a folder while there is one to go up to.
    private func back() {
        if browser != nil, !path.isEmpty {
            load(String(path[..<(path.lastIndex(of: "/") ?? path.startIndex)]))
        } else {
            onBack()
        }
    }

    private func startSignIn() {
        working = true
        failure = nil
        Task {
            defer { working = false }
            let begun = dropboxSignIn(appKey: DropboxApp.key, redirect: DropboxApp.redirect)
            do {
                guard let url = URL(string: begun.url) else { return }
                let back = try await webAuthenticationSession.authenticate(
                    using: url, callbackURLScheme: DropboxApp.scheme)
                let items = URLComponents(url: back, resolvingAgainstBaseURL: false)?.queryItems ?? []
                guard let code = items.first(where: { $0.name == "code" })?.value else {
                    Diagnostics.log("dropbox: sign-in returned no code")
                    return
                }
                let token = try await Task.detached {
                    try dropboxFinishSignIn(appKey: DropboxApp.key, verifier: begun.verifier, code: code, redirect: DropboxApp.redirect)
                }.value
                let folder = try await Task.detached {
                    try DropboxFolder.connect(appKey: DropboxApp.key, refreshToken: token, root: "")
                }.value
                self.token = token
                browser = folder
                Diagnostics.log("dropbox: signed in")
                load("")
            } catch ASWebAuthenticationSessionError.canceledLogin {
                Diagnostics.log("dropbox: sign-in cancelled")
            } catch {
                Diagnostics.log("dropbox: sign-in failed \(Diagnostics.name(error))")
                failure = error
            }
        }
    }

    private func open(_ folder: String) {
        load(folder)
    }

    private func load(_ directory: String) {
        guard let browser else { return }
        working = true
        failure = nil
        Task {
            defer { working = false }
            do {
                folders = try await Task.detached { try browser.folders(directory: directory) }.value
                path = directory
            } catch {
                Diagnostics.log("dropbox: listing failed \(Diagnostics.name(error))")
                failure = error
            }
        }
    }

    private func choose() {
        guard let token else { return }
        working = true
        Task {
            failure = await model.connectDropbox(root: path, token: token)
            working = false
        }
    }
}

/// A labelled row of the server form, ringed in the warning colour when the
/// last try points at it.
private struct FieldRow: ViewModifier {
    let label: String
    let ringed: Bool

    func body(content: Content) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .font(.system(.body))
                .foregroundStyle(FirstRunStyle.lead)
                .frame(width: 92, alignment: .leading)
            content
                .foregroundStyle(.white)
                .tint(FirstRunStyle.cyan)
        }
        .frame(minHeight: 44)
        .listRowBackground(ringed ? FirstRunStyle.warning.opacity(0.18) : FirstRunStyle.field)
        .accessibilityElement(children: .combine)
    }
}

// MARK: Starting a sync

/// The chosen folder holds no Sval data: this iPhone can be the first
/// device in it. Once started, the sync key's backup shows, to keep.
private struct StartStep: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let key = model.startedKey {
            BackupStep(backup: Codes.backup(of: key))
        } else {
            start
        }
    }

    private var start: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepBar(step: 2) { model.forgetFolder() }
            FirstRunStyle.headline("Start syncing here")
                .padding(.horizontal, 4)
                .padding(.top, 24)
                .accessibilityAddTraits(.isHeader)
            Text("This folder doesn't hold any Sval Workspaces yet. Sval on this iPhone can start syncing to this folder. Your other devices can then join this folder.")
                .font(.system(.subheadline))
                .foregroundStyle(FirstRunStyle.lead)
                .padding(.horizontal, 4)
            if let message = model.message {
                WarningBox(title: message, detail: "")
            }
            Spacer()
            FirstRunStyle.primary("Start Syncing") { model.startSync() }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
    }
}

/// The new sync key's backup (key-storage spec, "Backup and recovery"),
/// as the desktop shows it when it starts a sync.
private struct BackupStep: View {
    @Environment(AppModel.self) private var model
    let backup: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepBar(step: 2, onBack: nil)
            FirstRunStyle.headline("Back up your sync key")
                .padding(.horizontal, 4)
                .padding(.top, 24)
                .accessibilityAddTraits(.isHeader)
            Text("Keep it in your password manager. With this key, a new device can open your Workspaces in this folder, even if you lose this iPhone.")
                .font(.system(.subheadline))
                .foregroundStyle(FirstRunStyle.lead)
                .padding(.horizontal, 4)
            Text(backup)
                .font(SvalFont.mono(17, .medium, relativeTo: .body))
                .textSelection(.enabled)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(FirstRunStyle.well, in: .rect(cornerRadius: 16))
                .accessibilityLabel("Backup key")
            HStack(spacing: 10) {
                CopyButton(title: "Copy", text: backup, secret: true)
                ShareLink(item: backup) { Label("Save…", systemImage: "square.and.arrow.up") }
            }
            .buttonStyle(.glass)
            .padding(.top, 4)
            Spacer()
            FirstRunStyle.primary("Continue") { Task { await model.finishStart() } }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
    }
}

// MARK: The code

private struct CodeStep: View {
    @Environment(AppModel.self) private var model
    @State private var code = ""
    @State private var selection: TextSelection?
    @State private var backup = false
    @State private var working = false
    @FocusState private var focused: Bool

    private var failure: JoinError? { working ? nil : model.joinFailure }

    var body: some View {
        if working {
            JoiningView(waiting: model.waitingForOffer) {
                model.cancelJoin()
                working = false
            }
        } else {
            entry
        }
    }

    private var entry: some View {
        VStack(alignment: .leading, spacing: 12) {
            StepBar(step: 2) { model.forgetFolder() }
            FirstRunStyle.headline(backup ? "Enter the backup key" : "Enter the pairing code")
                .padding(.horizontal, 4)
                .padding(.top, 24)
                .accessibilityAddTraits(.isHeader)
            Text(backup
                 ? "Type the 52-character key you saved when you set up sync. Spaces and dashes don't matter."
                 : "On your computer, open Settings › Sync and devices › Sync with another device › This device shows a code.")
                .font(.system(.subheadline))
                .foregroundStyle(FirstRunStyle.lead)
                .padding(.horizontal, 4)
            if backup { keyField } else { codeField }
            if let failure, let message = failure.errorDescription {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 15))
                        .foregroundStyle(FirstRunStyle.danger)
                    Text(message)
                        .font(.system(.subheadline))
                }
                .padding(.horizontal, 4)
                .accessibilityElement(children: .combine)
            }
            Button(backup ? "Use a Pairing Code Instead" : "Use the Backup Key Instead") {
                backup.toggle()
                code = ""
                focused = true
            }
            .font(.system(.subheadline, weight: .semibold))
            .foregroundStyle(FirstRunStyle.cyan)
            .padding(.horizontal, 4)
            .padding(.top, 4)
            Spacer()
            FirstRunStyle.primary("Join", action: join)
                .disabled(!ready)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
        .onAppear { focused = true }
    }

    private var bare: String { Codes.bare(code) }
    private var ready: Bool { backup ? bare.count == 52 : bare.count == 12 }

    /// The pairing code in one field, grouped in fours with dashes as the
    /// desktop shows it (`groupCodeEntry`), the caret kept after the
    /// character it followed.
    private var codeField: some View {
        TextField("", text: $code, selection: $selection,
                  prompt: Text("XXXX-XXXX-XXXX").foregroundStyle(FirstRunStyle.muted.opacity(0.5)))
            .font(SvalFont.mono(22, .semibold, relativeTo: .title3))
            .multilineTextAlignment(.center)
            .keyboardType(.asciiCapable)
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .submitLabel(.join)
            .onSubmit { if ready { join() } }
            .focused($focused)
            .tint(FirstRunStyle.cyan)
            .onChange(of: code) { _, new in group(new) }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(FirstRunStyle.well, in: .rect(cornerRadius: 16))
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(failure != nil ? FirstRunStyle.danger : FirstRunStyle.cyan, lineWidth: 2)
            }
            .accessibilityLabel("Pairing code")
            .padding(.top, 12)
    }

    /// Regroups the code as typed or pasted: whatever dashes and spaces it
    /// holds go, and one dash goes between each group of four, up to
    /// twelve characters.
    private func group(_ text: String) {
        let caret: String.Index? = switch selection?.indices {
        case .selection(let range): range.upperBound
        default: nil
        }
        let before = caret.map { Codes.bare(String(text[..<$0])).count } ?? Codes.bare(text).count
        let kept = Array(Codes.bare(text).prefix(12))
        let grouped = stride(from: 0, to: kept.count, by: 4)
            .map { String(kept[$0..<min($0 + 4, kept.count)]) }
            .joined(separator: "-")
        guard grouped != text else { return }
        code = grouped
        let at = min(before, kept.count)
        // Each full group before the caret adds its dash, except a group
        // the caret ends, whose dash is still to come.
        let offset = at + max(0, (at + 3) / 4 - 1)
        let index = grouped.index(grouped.startIndex, offsetBy: min(offset, grouped.count))
        selection = TextSelection(insertionPoint: index)
    }

    /// The backup key in groups of four as it's typed, with a count.
    private var keyField: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("", text: $code, axis: .vertical)
                .font(SvalFont.mono(17, .medium, relativeTo: .body))
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .submitLabel(.join)
                .focused($focused)
                .tint(FirstRunStyle.cyan)
                .onChange(of: code) { _, new in
                    let grouped = stride(from: 0, to: Codes.bare(new).count, by: 4).map { start -> String in
                        let characters = Array(Codes.bare(new))
                        return String(characters[start..<min(start + 4, characters.count)])
                    }.joined(separator: " ")
                    if grouped != new { code = grouped }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .background(FirstRunStyle.well, in: .rect(cornerRadius: 16))
                .overlay {
                    RoundedRectangle(cornerRadius: 16)
                        .strokeBorder(failure != nil ? FirstRunStyle.danger : FirstRunStyle.cyan, lineWidth: 2)
                }
                .accessibilityLabel("Backup key")
            Text("\(bare.count) of 52")
                .font(.system(.footnote))
                .foregroundStyle(FirstRunStyle.muted)
                .padding(.horizontal, 4)
        }
        .padding(.top, 8)
    }

    private func join() {
        working = true
        focused = false
        Task {
            await model.join(code: code)
            working = false
        }
    }
}

/// While the code is tried: the moon with the satellite circling it, and
/// the steps as they pass.
private struct JoiningView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let waiting: Bool
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 26) {
            Spacer()
            ZStack {
                MoonGlyph()
                if reduceMotion {
                    Image("satellite").resizable().foregroundStyle(FirstRunStyle.cyan)
                } else {
                    TimelineView(.animation) { context in
                        Image("satellite").resizable()
                            .foregroundStyle(FirstRunStyle.cyan)
                            .rotationEffect(.degrees(context.date.timeIntervalSinceReferenceDate
                                .truncatingRemainder(dividingBy: 2.4) / 2.4 * 360))
                    }
                }
            }
            .frame(width: 96, height: 96)
            .accessibilityHidden(true)
            FirstRunStyle.headline("Joining your folder", size: 28)
                .accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 2) {
                line("Folder found", done: true)
                line(waiting ? "Waiting for your computer's code to reach the folder" : "Checking the code", done: false)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if waiting {
                Text("Keep Sval open. Your computer's code reaches this iPhone through your folder.")
                    .font(.system(.subheadline))
                    .foregroundStyle(FirstRunStyle.muted)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            Button("Cancel", action: onCancel)
                .font(.system(.body, weight: .semibold))
                .foregroundStyle(FirstRunStyle.cyan)
                .frame(minHeight: 44)
        }
        .padding(.horizontal, 36)
        .padding(.bottom, 20)
    }

    private func line(_ text: String, done: Bool) -> some View {
        HStack(spacing: 12) {
            if done {
                Image(systemName: "checkmark")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(Color(hex: 0x5EE08A))
                    .frame(width: 20)
            } else {
                ProgressView().tint(FirstRunStyle.cyan).frame(width: 20)
            }
            Text(text)
                .font(.system(.body))
                .foregroundStyle(done ? .white : FirstRunStyle.lead)
        }
        .frame(minHeight: 44)
    }
}

// MARK: Arrival

/// The Workspaces as they're read, with Open for the one to start in. It
/// works before every Workspace has arrived.
private struct ArrivalStep: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let workspaces = model.workspaces.filter { $0.agent == nil }
        VStack(alignment: .leading, spacing: 10) {
            FirstRunStyle.headline("You're in.", size: 40)
                .padding(.horizontal, 4)
                .padding(.top, 60)
                .accessibilityAddTraits(.isHeader)
            Text(workspaces.isEmpty ? "Reading your Workspaces from the folder…" : "Your Workspaces are arriving from the folder.")
                .font(.system(.body))
                .foregroundStyle(FirstRunStyle.lead)
                .padding(.horizontal, 4)
                .padding(.bottom, 12)
            if workspaces.isEmpty {
                ProgressView().tint(FirstRunStyle.cyan).frame(maxWidth: .infinity)
            } else {
                List {
                    Section {
                        ForEach(workspaces, id: \.id) { workspace in
                            row(workspace)
                        }
                    }
                    .listRowBackground(FirstRunStyle.field)
                }
                .scrollContentBackground(.hidden)
                    .scrollEdgeFade()
            }
            Spacer()
            // Sval starts on this phone's own Workspace, made once the
            // folder is read (14l, decision 2254).
            FirstRunStyle.primary("Start Browsing") {
                if let own = model.ownWorkspace { model.browser.showWorkspace(own.id) }
                model.welcoming = false
            }
            .disabled(model.ownWorkspace == nil)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 20)
    }

    private func row(_ workspace: OutlineRow) -> some View {
        let count = model.tabs(in: workspace.id).count
        return HStack(spacing: 12) {
            WorkspaceTile(workspace: workspace, size: 36, radius: 10)
            Text(WorkspaceTile.name(workspace))
                .font(.system(.body, weight: .medium))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(count == 1 ? "1 tab" : "\(count) tabs")
                .font(.system(.subheadline))
                .monospacedDigit()
                .foregroundStyle(FirstRunStyle.muted)
            Image(systemName: "checkmark")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(Color(hex: 0x5EE08A))
        }
        .frame(minHeight: 50)
        .accessibilityElement(children: .combine)
    }
}

/// What went wrong on a first run step: its title, and what to try.
private struct WarningBox: View {
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 15))
                .foregroundStyle(FirstRunStyle.warning)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(.subheadline, weight: .semibold))
                if !detail.isEmpty {
                    Text(detail)
                        .font(.system(.subheadline))
                        .foregroundStyle(FirstRunStyle.lead)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(FirstRunStyle.warning.opacity(0.10), in: .rect(cornerRadius: 14))
        .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(FirstRunStyle.warning.opacity(0.30), lineWidth: 1) }
        .accessibilityElement(children: .combine)
    }
}
