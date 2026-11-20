// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// Every site with a video and audio choice of its own, as the desktop's
/// Settings › Sites lists them (17d), pushed from Settings. Use Default
/// takes the choice away, and the site off the list.
struct SitesView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    let onDone: () -> Void
    @State private var query = ""

    var body: some View {
        let theme = Theme(scheme, tint: sheetTint)
        let rules = SiteRules(settings: model.settings)
        let names = rules.namesWithMediaChoice.filter {
            query.isEmpty || $0.localizedCaseInsensitiveContains(query)
        }
        List {
            Section {
                ForEach(names, id: \.self) { name in
                    Picker(selection: Binding(get: { rules.media(for: name) }, set: { choice in
                        let change = rules.mediaChange(for: name, to: choice)
                        Task { await model.setSetting(change.key, to: change.value) }
                    })) {
                        ForEach(SiteRules.Media.allCases) { Text($0.words).tag($0) }
                    } label: {
                        Label {
                            Text(name).lineLimit(1).truncationMode(.middle)
                        } icon: {
                            SiteTile(url: nil, name: name, size: 28)
                        }
                    }
                    .swipeActions {
                        Button("Use Default") {
                            let change = rules.mediaClear(for: name)
                            Task { await model.setSetting(change.key, to: change.value) }
                        }
                    }
                }
                .listRowBackground(theme.cell)
            } header: {
                if !names.isEmpty { SectionCaption("Sites", color: theme.muted) }
            }
        }
        .overlay {
            if names.isEmpty && !query.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
        .foregroundStyle(theme.text)
        .searchable(text: $query)
        .sheetGround(glass: true)
        .sheetPage("Video and Audio", onDone: onDone)
    }
}
