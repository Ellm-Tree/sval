// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// Media on the page in front is marked inside the address pill, because it
/// belongs to that address; media on another tab outside it, with that
/// tab's icon, because it belongs to the Workspace (design handoff 6).

/// The speaker in the pill for media on the page in front: lit while it
/// plays or its card is open, muted for a while after it pauses.
struct PillSpeaker: View {
    @Environment(AppModel.self) private var model
    let colors: BarColors
    let frame: CGSize
    let disc: CGFloat
    let glyph: CGFloat
    let open: Bool
    let onTap: () -> Void

    var body: some View {
        let browser: Browser = model.browser
        let playing = browser.currentTabId.map { browser.playingTabs.contains($0) } ?? false
        let muted = browser.currentTabId.map { browser.mutedTabs.contains($0) } ?? false
        let accent = colors.accent
        Button(action: onTap) {
            Image(systemName: muted ? "speaker.slash.fill" : (playing ? "speaker.wave.2.fill" : "speaker.fill"))
                .font(.system(size: glyph, weight: .medium))
                .foregroundStyle(open ? colors.onAccent : (playing ? accent : colors.muted))
                .frame(width: disc, height: disc)
                .background(open ? accent : (playing ? accent.opacity(0.16) : .clear), in: .circle)
                .frame(width: frame.width, height: frame.height)
                .contentShape(.rect)
        }
        .accessibilityLabel("Video and Audio")
        .accessibilityValue(playing ? "Playing" : "Paused")
    }
}

/// Another tab's media, outside the pill: that tab's icon with a speaker at
/// the corner. It opens the same card as the pill's speaker.
struct CompactMediaButton: View {
    @Environment(AppModel.self) private var model
    let tabId: String
    let colors: BarColors
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Group {
                if let row = model.row(tabId) {
                    SiteTile(row: row, size: 28)
                        .overlay { RoundedRectangle(cornerRadius: 7).strokeBorder(colors.edge, lineWidth: 1) }
                        .overlay(alignment: .bottomTrailing) { MediaBadge(colors: colors).offset(x: 5, y: 5) }
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(.rect)
        }
        .accessibilityLabel("Video and Audio")
    }
}

/// The speaker badge on a tab icon, on the glass.
private struct MediaBadge: View {
    let colors: BarColors

    var body: some View {
        Badge(diameter: 16, fill: colors.badge, ring: colors.badge, ringWidth: 1) {
            Image(systemName: "speaker.wave.2.fill")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(colors.accent)
        }
        .accessibilityHidden(true)
    }
}

/// Where a tab's media plays: its site, or its Workspace when that isn't
/// the one shown.
enum MediaPlace {
    @MainActor
    static func text(of tabId: String, model: AppModel) -> String {
        let row = model.row(tabId)
        let host = row?.url.flatMap { URL(string: $0)?.host() }.map { SiteRules.site(of: $0) ?? $0 } ?? ""
        guard let workspace = model.workspace(of: tabId), workspace != model.browser.workspaceId,
              let home = model.row(workspace) else { return host }
        return "In " + [home.emoji, WorkspaceTile.name(home)].compactMap { $0 }.joined(separator: " ")
    }
}

/// The one place to control media from the bar: play or pause, skip,
/// the position, mute, Picture in Picture, Stop, and for a tab behind, Go
/// to Tab. A card above the bar, on the bar's glass in the Workspace's
/// colour; a tap outside closes it.
struct MediaCard: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.scenePhase) private var scenePhase
    let tabId: String
    let onClose: () -> Void

    @State private var info: MediaInfo?
    @State private var scrubbing: Double?

    private var browser: Browser { model.browser }
    /// The Workspace's glass, as the bar under the card wears it.
    private var colors: BarColors {
        BarColors(token: model.tint(of: browser.workspaceId.flatMap(model.row)), dark: scheme == .dark)
    }
    private var accent: Color { colors.accent }

    var body: some View {
        let row = model.row(tabId)
        let front = tabId == browser.currentTabId
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                // Another tab's media: its title goes to that tab.
                Button {
                    onClose()
                    browser.select(tabId)
                } label: {
                    HStack(spacing: 12) {
                        if let row { SiteTile(row: row, size: 44) }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(title(row))
                                .font(.system(.body, weight: .semibold))
                                .lineLimit(1)
                            Text(MediaPlace.text(of: tabId, model: model))
                                .font(.system(.footnote))
                                .foregroundStyle(colors.muted)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .allowsHitTesting(!front)
                CloseCircle(diameter: 32, glass: workspaceGlass(colors.layer), action: onClose)
            }
            position
            controls(front: front)
        }
        .foregroundStyle(colors.ink)
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .glassEffect(workspaceGlass(colors.layer, interactive: false), in: .rect(cornerRadius: Radius.card))
        .padding(.horizontal, 10)
        // Read only while the app is in front, where the card shows.
        .task(id: scenePhase == .active ? tabId : nil) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                info = await browser.mediaInfo(tabId)
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
    }

    private func title(_ row: OutlineRow?) -> String {
        if let title = info?.title, !title.isEmpty { return title }
        return row.map { $0.title.isEmpty ? ($0.url ?? "") : $0.title } ?? ""
    }

    @ViewBuilder private var position: some View {
        if let info, let duration = info.duration, duration > 0 {
            VStack(spacing: 2) {
                Slider(value: Binding(
                    get: { scrubbing ?? info.time },
                    set: { scrubbing = $0 }), in: 0...duration) { editing in
                    if !editing, let to = scrubbing {
                        browser.media(tabId, "seek", value: to)
                        scrubbing = nil
                    }
                }
                .tint(accent)
                .accessibilityLabel("Position")
                HStack {
                    Text(MediaInfo.clock(scrubbing ?? info.time))
                    Spacer()
                    Text(MediaInfo.clock(duration))
                }
                .font(SvalFont.mono(11, relativeTo: .caption2))
                .foregroundStyle(colors.muted)
            }
        } else if info?.live == true {
            HStack(spacing: 8) {
                Capsule().fill(accent).frame(height: 4)
                Text("LIVE")
                    .font(.system(.caption2, weight: .bold))
                    .foregroundStyle(accent)
            }
            .frame(minHeight: 28)
        }
    }

    private func controls(front: Bool) -> some View {
        let paused = info?.paused ?? !browser.playingTabs.contains(tabId)
        let live = info?.live ?? false
        let video = info?.video ?? false
        let muted = info?.muted ?? browser.mutedTabs.contains(tabId)
        return HStack(spacing: 0) {
            control("gobackward.15", "Back 15 Seconds", enabled: !live) { browser.media(tabId, "skip", value: -15) }
            Spacer(minLength: 0)
            Button { browser.media(tabId, "toggle") } label: {
                Image(systemName: paused ? "play.fill" : "pause.fill")
                    .font(.system(size: 26))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.glassProminent)
            .buttonBorderShape(.circle)
            .accessibilityLabel(paused ? "Play" : "Pause")
            Spacer(minLength: 0)
            control("goforward.15", "Forward 15 Seconds", enabled: !live) { browser.media(tabId, "skip", value: 15) }
            control("stop.fill", "Stop", enabled: true) {
                onClose()
                Task { await browser.stopMedia(tabId) }
            }
            colors.rule.frame(width: 1, height: 28).padding(.horizontal, 6)
            control(muted ? "speaker.slash.fill" : "speaker.wave.2.fill", muted ? "Unmute" : "Mute", enabled: true) {
                browser.media(tabId, "mute")
            }
            control("pip.enter", "Picture in Picture", enabled: video) {
                onClose()
                browser.media(tabId, "pip")
            }
        }
    }

    private func control(_ symbol: String, _ label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 20))
                .frame(width: 44, height: 44)
                .contentShape(.rect)
        }
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
        .accessibilityLabel(label)
    }
}

/// Media playing, in this tab or another, as a glass capsule 8pt above the
/// bar (14k4, 17c): the tab's icon with a speaker, the media's title and
/// where it plays, which open its card, then Pause and Stop.
struct NowPlayingCapsule: View {
    @Environment(AppModel.self) private var model
    let tabId: String
    let colors: BarColors
    let onOpen: () -> Void

    /// The page's Media Session title, read when its media starts or stops.
    @State private var sessionTitle = ""

    var body: some View {
        let browser: Browser = model.browser
        let row = model.row(tabId)
        let playing = browser.playingTabs.contains(tabId)
        let title = sessionTitle.isEmpty ? row.map { $0.title.isEmpty ? ($0.url ?? "") : $0.title } ?? "" : sessionTitle
        HStack(spacing: 10) {
            Button(action: onOpen) {
                HStack(spacing: 10) {
                    if let row {
                        SiteTile(row: row, size: 32)
                            .overlay(alignment: .bottomTrailing) { MediaBadge(colors: colors).offset(x: 4, y: 4) }
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(title)
                            .font(.system(.subheadline, weight: .semibold))
                            .lineLimit(1)
                        Text(MediaPlace.text(of: tabId, model: model))
                            .font(.system(.caption))
                            .foregroundStyle(colors.muted)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            Button { browser.media(tabId, "toggle") } label: {
                Image(systemName: playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 18))
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(playing ? "Pause" : "Play")
            Button { Task { await browser.stopMedia(tabId) } } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop")
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .frame(minHeight: 52)
        .foregroundStyle(colors.ink)
        .glassCapsule(colors.layer)
        .task(id: "\(tabId) \(playing)") {
            sessionTitle = await browser.mediaInfo(tabId)?.title ?? ""
        }
    }
}

/// The ask: the page in front tried to play on Ask first. A glass capsule
/// above the bar (17b) whose tap allows media for the page and reloads it;
/// its long-press menu also saves Always allow for the site. × closes it
/// for the page and allows nothing.
struct MediaAsk: View {
    @Environment(AppModel.self) private var model
    let colors: BarColors

    var body: some View {
        let browser: Browser = model.browser
        HStack(spacing: 0) {
            Menu {
                Button("Allow Video and Audio", systemImage: "speaker.wave.2") { browser.allowMediaForVisit() }
                Button("Always Allow on This Site", systemImage: "checkmark.circle") {
                    Task { await browser.alwaysAllowMedia() }
                }
            } label: {
                Label("Allow Video and Audio", systemImage: "speaker.slash")
                    .font(.system(.subheadline, weight: .semibold))
                    .padding(.leading, 14)
                    .padding(.trailing, 10)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
            } primaryAction: {
                browser.allowMediaForVisit()
            }
            .accessibilityAction(named: "Always Allow on This Site") {
                Task { await browser.alwaysAllowMedia() }
            }
            colors.rule.frame(width: 1, height: 22)
            Button { browser.closeAsk() } label: {
                Label("Close", systemImage: "xmark")
                    .labelStyle(.iconOnly)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(colors.ink.opacity(0.75))
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
        }
        .buttonStyle(.plain)
        .padding(.trailing, 4)
        .foregroundStyle(colors.ink)
        .glassCapsule(colors.layer)
    }
}
