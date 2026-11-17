// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// What sync is doing, as the desktop's footer says it (`syncIndicator`
/// in `SvalPanelModel.sys.mjs`): the moon's look, the line the footer
/// shows, and the longer line Settings shows.
struct SyncIndicator {
    enum Icon { case moon, syncing, offline, warning }

    let icon: Icon
    /// The footer's line.
    let line: String
    /// Settings' title and detail.
    let title: String
    let detail: String

    @MainActor
    init(_ model: AppModel, now: Date) {
        if let since = model.unreachableSince, now.timeIntervalSince(since) >= AppModel.unavailableAfter {
            let label = model.lastSynced.map { "Last synced \(Self.time($0, now: now))" } ?? "Not synced yet"
            icon = .offline
            line = label
            title = label
            detail = "Can't reach your sync folder"
        } else if let problem = model.message {
            icon = .warning
            line = "Sync problem"
            title = "Sync problem"
            detail = problem
        } else if model.lastSynced == nil {
            icon = .syncing
            line = "Syncing…"
            title = "Syncing…"
            detail = ""
        } else {
            let text = Self.lastSyncedText(model.lastSynced, now: now)
            icon = .moon
            line = text
            title = "Synced"
            detail = text
        }
    }

    /// `lastSyncedText` on the desktop.
    static func lastSyncedText(_ last: Date?, now: Date) -> String {
        guard let last else { return "Not synced yet" }
        let seconds = max(0, Int(now.timeIntervalSince(last).rounded()))
        if seconds < 60 { return "Synced just now" }
        let minutes = Int((Double(seconds) / 60).rounded())
        if minutes < 60 { return "Synced \(minutes) minute\(minutes == 1 ? "" : "s") ago" }
        let hours = Int((Double(minutes) / 60).rounded())
        if hours < 24 { return "Synced \(hours) hour\(hours == 1 ? "" : "s") ago" }
        let days = Int((Double(hours) / 24).rounded())
        return "Synced \(days) day\(days == 1 ? "" : "s") ago"
    }

    /// A time of day today, else a date with it.
    private static func time(_ date: Date, now: Date) -> String {
        Calendar.current.isDate(date, inSameDayAs: now)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(date: .abbreviated, time: .shortened)
    }
}

/// The desktop's sync moon (`sync-icons/`): the satellite circles it while
/// syncing, it dims with a pause badge offline, and a warning carries the
/// bang badge. Each badge is ringed in the surface under it.
struct SyncMoon: View {
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let icon: SyncIndicator.Icon
    var size: CGFloat = 24
    /// The surface the moon sits on, which rings its badge.
    let ring: Color

    var body: some View {
        let theme = Theme(scheme, tint: sheetTint)
        ZStack {
            MoonGlyph()
                .opacity(icon == .offline ? 0.5 : 1)
            if icon == .syncing {
                if reduceMotion {
                    Image("satellite").resizable()
                } else {
                    TimelineView(.animation) { context in
                        Image("satellite").resizable()
                            .rotationEffect(.degrees(context.date.timeIntervalSinceReferenceDate
                                .truncatingRemainder(dividingBy: 2.4) / 2.4 * 360))
                    }
                }
            }
        }
        .foregroundStyle(theme.text)
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            let badge = size * 0.6
            switch icon {
            case .offline:
                mark("badge-pause", fill: theme.muted, ink: ring, badge: badge)
            case .warning:
                mark("badge-bang", fill: theme.warning, ink: theme.warningInk, badge: badge)
            case .moon, .syncing:
                EmptyView()
            }
        }
        .accessibilityHidden(true)
    }

    private func mark(_ name: String, fill: Color, ink: Color, badge: CGFloat) -> some View {
        Badge(diameter: badge, fill: fill, ring: ring, ringWidth: badge * 0.0625) {
            Image(name).resizable()
                .foregroundStyle(ink)
                .frame(width: badge * 0.83, height: badge * 0.83)
        }
        .offset(x: badge * 0.25, y: badge * 0.25)
    }
}

/// Sval's moon, the disc with the S cut out of it, drawn from the geometry
/// of the desktop's `sync-icons/moon.svg`. The asset catalog draws that
/// file's mask at its 24pt size and scales the bitmap, which blurs it at
/// first run's 96pt; a canvas draws at any size. Filled in the foreground
/// style, as a template image is.
struct MoonGlyph: View {
    var body: some View {
        Canvas { context, size in
            context.scaleBy(x: size.width / 24, y: size.height / 24)
            context.fill(Path(ellipseIn: CGRect(x: 3.5, y: 3.5, width: 17, height: 17)), with: .foreground)
            var cut = context
            // The SVG's `translate(12 12) scale(0.021197) skewX(-6)
            // translate(-534 -525)`, applied right to left.
            cut.concatenate(
                CGAffineTransform(translationX: -534, y: -525)
                    .concatenating(CGAffineTransform(a: 1, b: 0, c: tan(-6 * .pi / 180), d: 1, tx: 0, ty: 0))
                    .concatenating(CGAffineTransform(scaleX: 0.021197, y: 0.021197))
                    .concatenating(CGAffineTransform(translationX: 12, y: 12)))
            cut.blendMode = .destinationOut
            cut.stroke(Self.s, with: .color(.black),
                       style: StrokeStyle(lineWidth: 94.353, lineCap: .round, lineJoin: .round))
        }
        .accessibilityHidden(true)
    }

    private static let s: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 700, y: 370))
        let curves: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] = [
            (670, 322, 614, 300, 542, 300),
            (452, 300, 394, 344, 394, 410),
            (394, 476, 454, 504, 540, 522),
            (636, 542, 696, 576, 696, 640),
            (696, 708, 632, 750, 536, 750),
            (456, 750, 398, 726, 368, 676),
        ]
        for (x1, y1, x2, y2, x, y) in curves {
            path.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: x1, y: y1), control2: CGPoint(x: x2, y: y2))
        }
        return path
    }()
}
