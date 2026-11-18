// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// What Settings › Licenses lists: the bundled Licenses.json, which
/// scripts/generate-app-license.py --ios writes. Each license text is
/// stored once, and an entry names the texts that cover it by index.
struct Licenses: Decodable {
    struct Entry: Decodable, Identifiable {
        let name: String
        let version: String?
        let license: String?
        let source: String?
        let copyright: String?
        let description: String?
        let texts: [Int]

        var id: String { version.map { "\(name) \($0)" } ?? name }
    }

    let sval: [Entry]
    let components: [Entry]
    let data: [Entry]
    let texts: [String]

    static let bundled: Licenses? = Bundle.main.url(forResource: "Licenses", withExtension: "json")
        .flatMap { try? Data(contentsOf: $0) }
        .flatMap { try? JSONDecoder().decode(Licenses.self, from: $0) }
}

/// Sval's license and the notices of everything the app is built with and
/// carries, as the system's acknowledgements lists show them. A link to a
/// site opens in a new tab and closes the sheet, as a favorite does.
struct LicensesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    let onDone: () -> Void
    @State private var query = ""
    private let licenses = Licenses.bundled

    private static let source = URL(string: "https://gitlab.com/sval-browser/sval")!

    var body: some View {
        let theme = Theme(scheme, tint: sheetTint)
        List {
            if let licenses {
                let sval = licenses.sval.filter(matches)
                if query.isEmpty || !sval.isEmpty {
                    Section {
                        if query.isEmpty { intro(theme) }
                        ForEach(sval) { row($0, texts: licenses.texts, theme: theme) }
                    } header: {
                        SectionCaption("Sval", color: theme.muted)
                    }
                    .listRowBackground(theme.cell)
                }
                let components = licenses.components.filter(matches)
                if !components.isEmpty {
                    Section {
                        ForEach(components) { row($0, texts: licenses.texts, theme: theme) }
                    } header: {
                        SectionCaption("Components", color: theme.muted)
                    } footer: {
                        if query.isEmpty {
                            footnote("This app is built with these components. Each row names the component's licenses.", theme)
                        }
                    }
                    .listRowBackground(theme.cell)
                }
                let data = licenses.data.filter(matches)
                if !data.isEmpty {
                    Section {
                        ForEach(data) { row($0, texts: licenses.texts, theme: theme) }
                    } header: {
                        SectionCaption("Fonts and data", color: theme.muted)
                    } footer: {
                        if query.isEmpty {
                            footnote("This app includes these fonts and data. Each row opens the matching license.", theme)
                        }
                    }
                    .listRowBackground(theme.cell)
                }
            }
        }
        .foregroundStyle(theme.text)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
        .sheetGround(glass: true)
        .sheetPage("Licenses", onDone: onDone)
    }

    private func matches(_ entry: Licenses.Entry) -> Bool {
        query.isEmpty || entry.name.localizedCaseInsensitiveContains(query)
    }

    @ViewBuilder private func intro(_ theme: Theme) -> some View {
        Text("Sval is made by Ellm Tree, Inc. Sval's code is Copyright 2026 Ellm Tree, Inc. and Sval's contributors.")
        Text("Sval is free software. You can redistribute and modify Sval under the terms of the GNU Affero General Public License, version 3, with the Sval App Store Permission. Both licenses are listed below.")
        Button { open(Self.source) } label: {
            Text("Sval's source code is at \(Text("gitlab.com/sval-browser/sval").foregroundStyle(theme.action)).")
                .foregroundStyle(theme.text)
        }
        Text("Sval is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.")
    }

    private func row(_ entry: Licenses.Entry, texts: [String], theme: Theme) -> some View {
        NavigationLink {
            LicenseDetail(entry: entry, texts: entry.texts.map { texts[$0] }, open: open, onDone: onDone)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.id)
                if let license = entry.license {
                    Text(license)
                        .font(.subheadline)
                        .foregroundStyle(theme.muted)
                }
            }
        }
    }

    private func footnote(_ text: String, _ theme: Theme) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(theme.muted)
    }

    private func open(_ url: URL) {
        guard let workspace = model.browser.workspaceId else { return }
        Task { await model.browser.openNewTab(url, in: workspace) }
        onDone()
    }
}

/// One entry's notice: its copyright, what Sval changed, where its source
/// is, and the full text of each license file that covers it.
private struct LicenseDetail: View {
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    let entry: Licenses.Entry
    let texts: [String]
    let open: (URL) -> Void
    let onDone: () -> Void

    var body: some View {
        let theme = Theme(scheme, tint: sheetTint)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if let copyright = entry.copyright { Text(copyright) }
                if let description = entry.description { Text(description) }
                if let source = entry.source, let url = URL(string: source) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Source")
                            .font(.footnote)
                            .foregroundStyle(theme.muted)
                        Button(source) { open(url) }
                            .foregroundStyle(theme.action)
                    }
                }
                // A paragraph a view, so a long license lays out only what
                // is on screen.
                ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                    Text(paragraph)
                        .font(.footnote)
                }
            }
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .foregroundStyle(theme.text)
        .sheetGround(glass: true)
        .sheetPage(entry.id, onDone: onDone)
    }

    private var paragraphs: [String] {
        texts.flatMap { $0.components(separatedBy: "\n\n") }
            .map { $0.trimmingCharacters(in: .newlines) }
            .filter { !$0.isEmpty }
            .map(Self.reflow)
    }

    /// A paragraph rewrapped to the screen's width. License files break
    /// their lines near 80 characters, which a phone's width breaks again.
    /// A line ending well short of the paragraph's widest ends a heading
    /// or a list item, so the line after it keeps its own line, as a rule
    /// of dashes does.
    static func reflow(_ paragraph: String) -> String {
        let lines = paragraph.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        let width = lines.map(\.count).max() ?? 0
        let isRule = { (line: String) in !line.isEmpty && line.allSatisfy { "-=_*".contains($0) } }
        var out = ""
        var previous: String?
        for line in lines {
            if let previous {
                let joins = previous.count * 2 >= width && !isRule(previous) && !isRule(line)
                out += (joins ? " " : "\n") + line
            } else {
                out = line
            }
            previous = line
        }
        return out
    }
}
