// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// What the split menu asks for, acting on the focused pane.
enum SplitAction {
    case move(Int)
    case separate
    case rename
    case closeTab
    case closeAll
}

/// The split drawn as its two panes in view sit: stacked while the phone
/// is upright, side by side while sideways, the focused one filled.
struct PaneMark: View {
    let split: Browser.SplitInFront
    let sideways: Bool
    let colors: BarColors

    var body: some View {
        let layout = sideways ? AnyLayout(HStackLayout(spacing: 2)) : AnyLayout(VStackLayout(spacing: 2))
        layout {
            ForEach(split.slots, id: \.self) { slot in
                let focused = slot == split.focused
                RoundedRectangle(cornerRadius: 3)
                    .fill(focused ? colors.accent : .clear)
                    .overlay {
                        if !focused { RoundedRectangle(cornerRadius: 3).strokeBorder(colors.muted, lineWidth: Stroke.ring) }
                    }
                    .frame(width: sideways ? 9 : 15, height: sideways ? 15 : 9)
            }
        }
        .accessibilityHidden(true)
    }
}

/// What the site menu's page group asks for (14d3).
enum PageAction {
    case move(OutlineRow)
    case pin(OutlineRow, URL)
    case moveToFavorites(PinRow)
    case star(StarAction)
    /// Remove from This Site: pick an element on the page to hide there.
    case removeElement
}

enum StarAction {
    case add(URL, title: String)
    case rename(Favorite)
    case move(Favorite)
    case remove(Favorite)
}

/// Whether the page in front is a favorite, as the star shows it
/// (`SvalFavorites.isCurrentFavorite`). A pin is no favorite, so a pin's
/// page shows whether its address is in Favorites (pins-root spec §6).
enum StarState {
    case none
    case add(URL, title: String)
    case favorite(Favorite)

    @MainActor init(_ model: AppModel) {
        let browser: Browser = model.browser
        // Favorites sync, so a private tab has no star, as on the desktop.
        if browser.privateInFront {
            self = .none
            return
        }
        guard let url = browser.currentURL, AppModel.opensHere(url.absoluteString) else {
            self = .none
            return
        }
        let matches = model.favorites(of: url)
        if let item = matches.first(where: { !$0.pinned }) {
            self = .favorite(item)
        } else {
            self = .add(url, title: browser.currentTitle ?? "")
        }
    }
}

/// What the shield says about the page in front, as the desktop's
/// protection button does. WebKit's content rule lists report nothing of
/// what they block, so the filled "something was blocked" shield has no
/// counterpart here.
enum ShieldState {
    case on, off, plain

    init(url: URL?, rules: SiteRules) {
        guard let url, let host = url.host(), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            self = .plain
            return
        }
        let blocking = rules.settings[ContentBlocker.levelKey] as? String ?? "balanced"
        self = blocking != "off" && rules.protectionsOn(for: host) ? .on : .off
    }

    var image: String {
        switch self {
        case .on: "pr-shield"
        case .off: "pr-shield-off"
        case .plain: "sc-shield-plain"
        }
    }
}
