// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Observation

/// One observed mark per key of a cache, so a view that read one key is
/// redrawn when that key's value changes, and no other view is. Only a
/// key some view has read has a mark.
@MainActor
final class KeyMarks {
    @Observable
    final class Mark {
        var version = 0
    }

    private var marks: [String: Mark] = [:]

    /// Makes the view drawing depend on `key`'s value.
    func read(_ key: String) {
        _ = mark(key).version
    }

    /// Redraws the views that read `key`.
    func bump(_ key: String) {
        marks[key]?.version += 1
    }

    /// Redraws every view that read any key.
    func bumpAll() {
        for mark in marks.values { mark.version += 1 }
    }

    /// Forgets the keys not in `keys`.
    func keep(only keys: Set<String>) {
        marks = marks.filter { keys.contains($0.key) }
    }

    private func mark(_ key: String) -> Mark {
        if let mark = marks[key] { return mark }
        let mark = Mark()
        marks[key] = mark
        return mark
    }
}
