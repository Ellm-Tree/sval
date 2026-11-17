// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// The developer's launch options (`-sval…`), read in a Debug build alone.
/// They switch blocking off, write page text to the log and delete the
/// app's data, so a build anyone else runs must not answer to them. The UI
/// tests launch a Debug build with them.
enum LaunchOption {
    static func given(_ name: String) -> Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains(name)
        #else
        false
        #endif
    }

    /// Every option given, for the log.
    static var all: [String] {
        #if DEBUG
        ProcessInfo.processInfo.arguments.dropFirst().filter { $0.hasPrefix("-sval") }
        #else
        []
        #endif
    }
}
