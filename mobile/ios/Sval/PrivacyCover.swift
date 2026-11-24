// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit

/// A plain cover over the whole app while the private session is in front
/// and the app is leaving the screen, so the snapshot iOS keeps for the app
/// switcher shows nothing private. A window of its own above the app's,
/// shown without becoming key, so the keyboard stays up (Firefox for iOS,
/// `PrivacyWindowHelper`).
@MainActor
enum PrivacyCover {
    private static var window: UIWindow?

    static func show() {
        guard window == nil, let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).first else { return }
        let cover = UIWindow(windowScene: scene)
        cover.windowLevel = .alert + 1
        cover.rootViewController = UIHostingController(rootView: PrivateCoverView())
        cover.isHidden = false
        window = cover
    }

    static func hide() {
        window?.isHidden = true
        window = nil
    }
}
