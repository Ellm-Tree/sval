// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UniformTypeIdentifiers

/// Settings › Sync with Another Device: this iPhone shows a code, and the
/// other device types it to take the sync key (spec §6.7), as the desktop's
/// "This device shows a code".
struct PairingSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    @State private var offer: Join.Offer?
    @State private var taken = false
    @State private var failure: String?

    /// How often the sheet looks for the offer's file gone
    /// (`CLAIM_POLL_MS`).
    static let poll: Duration = .seconds(5)

    var body: some View {
        let theme = Theme(scheme, tint: sheetTint)
        NavigationStack {
            Form {
                Group {
                    if taken {
                        Section {
                            Label("Your other device has the sync key", systemImage: "checkmark.circle.fill")
                        } footer: {
                            Text("That device syncs your Workspaces through this folder now.")
                        }
                    } else if let offer {
                        Section {
                            Text(offer.code)
                                .font(SvalFont.mono(32, .semibold, relativeTo: .largeTitle))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .textSelection(.enabled)
                                .accessibilityLabel("Pairing code, \(offer.code.map(String.init).joined(separator: " "))")
                            CopyButton(title: "Copy Code", text: offer.code, secret: true)
                        } header: {
                            SectionCaption("Type this code on the other device", color: theme.muted)
                        } footer: {
                            Text("On a computer, open Settings › Sync and devices › Sync with another device, then choose \"The other device shows a code\". On an iPhone or iPad, choose this folder when you first set up Sval. The code works until \(offer.expiresAt, style: .time).")
                        }
                    } else if let failure {
                        Section { Text(failure) }
                    } else {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
                .listRowBackground(theme.cell)
            }
            .foregroundStyle(theme.text)
            .sheetGround()
            .navigationTitle("Sync with Another Device")
            .sheetTitleMode("Sync with Another Device")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .close) { dismiss() }
                }
            }
        }
        .task {
            // The offer lives exactly as long as this task: the sheet
            // closing cancels it, and whatever ends it, cancelled while the
            // offer was being made included, takes the offer back unless the
            // other device took it.
            let offer: Join.Offer
            do {
                offer = try await model.offerPairing()
            } catch {
                if !(error is CancellationError) { failure = error.localizedDescription }
                return
            }
            self.offer = offer
            while !Task.isCancelled, Date.now < offer.expiresAt {
                try? await Task.sleep(for: Self.poll)
                if !Task.isCancelled, await model.offerTaken(offer) {
                    taken = true
                    Diagnostics.log("pair: offer taken")
                    return
                }
            }
            await model.withdraw(offer)
        }
    }
}

/// A button that copies `text`, and says so: its label turns to Copied with
/// a tick for a moment, with the system's success haptic.
struct CopyButton: View {
    let title: String
    let text: String
    /// Whether `text` unlocks the user's data, a backup key or a pairing
    /// code: it stays off Universal Clipboard and leaves the pasteboard
    /// after `secretLifetime`.
    var secret = false
    /// The address `text` spells, copied as a URL for apps that take one.
    var url: URL?
    /// Drawn as its glyph alone in a frame of this size, as in a bar.
    var glyphFrame: CGSize?
    @State private var copied = false

    static let secretLifetime: TimeInterval = 120

    var body: some View {
        Button {
            if secret {
                UIPasteboard.general.setItems(
                    [[UTType.utf8PlainText.identifier: text]],
                    options: [.localOnly: true, .expirationDate: Date.now.addingTimeInterval(Self.secretLifetime)])
            } else if let url {
                UIPasteboard.general.url = url
            } else {
                UIPasteboard.general.string = text
            }
            copied = true
        } label: {
            let label = Label(copied ? "Copied" : title, systemImage: copied ? "checkmark" : "doc.on.doc")
            if let glyphFrame {
                label.labelStyle(.iconOnly).frame(width: glyphFrame.width, height: glyphFrame.height).contentShape(.rect)
            } else {
                label
            }
        }
        .contentTransition(.symbolEffect(.replace))
        .sensoryFeedback(.success, trigger: copied) { _, now in now }
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }
}
