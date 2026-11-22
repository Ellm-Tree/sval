// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import os

/// The intervals Instruments shows for a refresh and its parts, the history
/// read and the blocker's check, and the events for the bar's facts, under
/// the subsystem `app.sval.ios`. A
/// signpost's message carries counts alone, never an address, a title or a
/// name (CONTRIBUTING.md rule 10).
enum Signposts {
    static let refresh = OSSignposter(subsystem: "app.sval.ios", category: "refresh")
    static let outline = OSSignposter(subsystem: "app.sval.ios", category: "outline")
    static let history = OSSignposter(subsystem: "app.sval.ios", category: "history")
    static let blocker = OSSignposter(subsystem: "app.sval.ios", category: "blocker")
    static let bar = OSSignposter(subsystem: "app.sval.ios", category: "bar")
}
