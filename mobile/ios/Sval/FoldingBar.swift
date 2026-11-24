// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// The upright bar at its fold: the one view of the bar that reads the
/// fold's value, which changes with each scroll report. It places the
/// controls `BrowserBar` built, so a page's scrolling runs neither
/// `BrowserBar`'s body nor its builders.
struct FoldingBar<Nav: View, Row: View, NewTab: View, WorkspaceButton: View, WorkspaceLabel: View, OtherMedia: View>: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let facts: BarFacts
    let colors: BarColors
    /// What is held for a scrub: the address or the Workspace button.
    let scrubbing: ScrubKind?
    /// Back and Forward.
    let nav: Nav
    /// The shield, the pane mark, the JavaScript-off mark and the address.
    let row: Row
    let newTab: NewTab
    let workspaceButton: WorkspaceButton
    /// The Workspace button's label, lifted while it is held for a scrub.
    let workspaceLabel: WorkspaceLabel
    /// Another tab's media, beside the folded pill.
    let otherMedia: OtherMedia?
    /// The media playing, in this tab or another, above the open bar.
    let rider: NowPlayingCapsule?
    /// The page in front's media, in the folded pill.
    let speaker: PillSpeaker?
    let progress: ProgressLine
    let openBar: () -> Void

    /// The Workspace colour the capsules' glass is tinted with.
    private var layer: Color { colors.layer }

    var body: some View {
        let fold = model.browser.fold.value
        GlassFold(progress: fold) { at, t, shape in
            capsules(at, t, shape)
        }
        // Above the full bar and the folded pill alike, and above
        // another tab's now-playing capsule while that shows.
        .overlay(alignment: .top) {
            BarNotices(colors: colors, asks: facts.asks)
                .offset(y: facts.otherMedia != nil && fold < 1 ? -112 : -52)
        }
    }

    /// The upright bar at fold `t`, its capsules at `at`: Back and Forward,
    /// the address, New Tab and the Workspace button (14a1). Folded, they
    /// slide into one pill holding the shield, the address and a dot in the
    /// Workspace colour (14i5). The shield and the address stay as they
    /// are; the rest fade over the first third of the fold, and the dot
    /// over the last.
    private func capsules(_ at: [CGRect], _ t: Double, _ shape: BarShape) -> some View {
        let k = shape.scale
        let buttons = 1 - foldStep(0, 0.35, t)
        let dot = foldStep(0.65, 1, t)
        let address = at[1]
        // Each capsule's controls are its glass's own content, so they move
        // with the glass when it answers a touch.
        return ZStack(alignment: .topLeading) {
            GlassEffectContainer(spacing: 3) {
                ZStack(alignment: .topLeading) {
                    // Folded, Back, New Tab and the Workspace button lie
                    // inside the pill's ends, where their glass would show
                    // at its edge and answer a touch meant for the pill;
                    // they go once the fold is done, and their glass stops
                    // answering touches once it starts.
                    if t < 1 {
                        capsule(at[0], interactive: t == 0) {
                            nav
                                .opacity(buttons)
                                .allowsHitTesting(t == 0)
                                .accessibilityHidden(t > 0)
                        }
                    }
                    capsule(address) { addressCapsule(address, t: t, buttons: buttons, dot: dot, scale: k) }
                    if t < 1 {
                        capsule(at[2], interactive: t == 0) {
                            newTab
                                .opacity(buttons)
                                .allowsHitTesting(t == 0)
                                .accessibilityHidden(t > 0)
                        }
                        // Held for a scrub, its glass stays still under the
                        // lifted button, which would show it swelling and
                        // following the finger past its edge.
                        capsule(at[3], interactive: t == 0 && scrubbing != .workspaces) {
                            workspaceButton
                                .opacity(buttons)
                                .allowsHitTesting(t == 0)
                                .accessibilityHidden(t > 0)
                        }
                    }
                }
            }
            if scrubbing == .tabs && t == 0 {
                liftedAddress(address, t: t, buttons: buttons, dot: dot, scale: k)
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.87).combined(with: .opacity))
            }
            if scrubbing == .workspaces && t == 0 {
                liftedWorkspaceButton(at[3])
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.87).combined(with: .opacity))
            }
            // Media playing, in this tab or another, rides above the bar in
            // its own capsule (14k4, 17c). Folded, the page in front's is the
            // speaker in the pill, and another tab's is its icon beside it.
            if let rider {
                rider
                    .frame(width: at[3].maxX - 8)
                    .offset(x: 8, y: -60)
                    .opacity(buttons)
                    .allowsHitTesting(t == 0)
                    .accessibilityHidden(t > 0)
            }
            if let otherMedia {
                otherMedia
                    .offset(x: address.maxX + 6, y: address.minY)
                    .opacity(dot)
                    .allowsHitTesting(t == 1)
                    .accessibilityHidden(t < 1)
            }
        }
        .foregroundStyle(colors.ink)
        .animation(.spring(duration: 0.35, bounce: 0.2), value: scrubbing)
    }

    /// One capsule: its content centred in its frame, on glass of the
    /// frame's shape, at its place in the fold.
    private func capsule<Content: View>(_ frame: CGRect, interactive: Bool = true,
                                        @ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(width: frame.width, height: frame.height)
            .glassEffect(workspaceGlass(layer, interactive: interactive), in: .capsule)
            .glassEffectTransition(.identity)
            .offset(x: frame.minX, y: frame.minY)
    }

    /// The address lifted over the bar while it is held for a scrub, grown
    /// past the buttons beside it. It is drawn outside the bar's glass
    /// container, which would merge its glass with theirs where they
    /// overlap, and it takes no touches, so the hold under it carries on.
    private func liftedAddress(_ address: CGRect, t: Double, buttons: Double, dot: Double, scale k: Double) -> some View {
        let grown: CGFloat = 1.15
        let lifted = address.insetBy(dx: -address.width * (grown - 1) / 2, dy: -address.height * (grown - 1) / 2)
        return addressCapsule(address, t: t, buttons: buttons, dot: dot, scale: k)
            .scaleEffect(grown)
            .frame(width: lifted.width, height: lifted.height)
            .glassEffect(workspaceGlass(layer, interactive: false), in: .capsule)
            .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
            .offset(x: lifted.minX, y: lifted.minY)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    /// The Workspace button lifted over the bar while it is held for a
    /// scrub, drawn as `liftedAddress` is.
    private func liftedWorkspaceButton(_ frame: CGRect) -> some View {
        let grown: CGFloat = 1.15
        let lifted = frame.insetBy(dx: -frame.width * (grown - 1) / 2, dy: -frame.height * (grown - 1) / 2)
        return workspaceLabel
            .scaleEffect(grown)
            .frame(width: lifted.width, height: lifted.height)
            .glassEffect(workspaceGlass(layer, interactive: false), in: .capsule)
            .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
            .offset(x: lifted.minX, y: lifted.minY)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    /// The address capsule's content. The shield and the address hold their
    /// place, 36pt tall on the capsule's midline, as it shrinks to the pill;
    /// Reload fades at its end, where the Workspace's dot fades in. Partway
    /// or folded, a tap anywhere on it brings the full bar back.
    private func addressCapsule(_ address: CGRect, t: Double, buttons: Double, dot: Double, scale k: Double) -> some View {
        let height = address.height - 12
        let inset = 4 * (1 - t)
        // With no page there is nothing to reload, and the address takes
        // Reload's room.
        let reloads = facts.reloads
        let room = address.width - inset - ((reloads ? 40 * k : 8) * (1 - t) + (speaker != nil ? 60 : 30) * t)
        return ZStack(alignment: .leading) {
            row
                .frame(width: max(0, room), height: height, alignment: .leading)
                .padding(.leading, inset)
                // Partway or folded, the pill is one button.
                .allowsHitTesting(t == 0)
                .accessibilityHidden(t > 0)
            ReloadButton(reloads: reloads, scale: k).frame(width: 36 * k, height: 44)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, 4)
                .opacity(reloads ? buttons : 0)
                .allowsHitTesting(t == 0)
                .accessibilityHidden(t > 0)
            workspaceDot
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, 6)
                .opacity(dot)
            if t > 0 {
                Button(action: openBar) { Color.clear.contentShape(.capsule) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Show the toolbar")
            }
            if let speaker {
                speaker
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.trailing, 32)
                    .opacity(dot)
                    .allowsHitTesting(t == 1)
                    .accessibilityHidden(t < 1)
            }
        }
        .frame(width: address.width, height: address.height)
        .overlay(alignment: .bottom) { progress.padding(.bottom, 1) }
    }

    /// The folded pill's dot: the Workspace colour, solid, with its emoji.
    private var workspaceDot: some View {
        Circle()
            .fill(layer)
            .frame(width: 24, height: 24)
            .overlay {
                WorkspaceMark(workspace: facts.workspace, isPrivate: facts.isPrivateSession, size: 13)
                    .foregroundStyle(BarColors.ink(on: layer, dark: scheme == .dark))
            }
            .accessibilityHidden(true)
    }
}

/// Reload, which turns while the page loads, as the desktop's does
/// (`sval-busy-turn`); a tap then stops the load. Under Reduce Motion the
/// stop glyph shows for the whole load instead.
struct ReloadButton: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Whether the page in front has an address to reload.
    let reloads: Bool
    var scale: Double = 1

    var body: some View {
        let browser = model.browser!
        let k = scale
        Button {
            browser.loading ? browser.stopLoading() : browser.reload()
        } label: {
            Group {
                if browser.loading && reduceMotion {
                    Image("stop").resizable()
                } else if browser.loading {
                    TimelineView(.animation) { context in
                        Image("reload").resizable()
                            .rotationEffect(.degrees(context.date.timeIntervalSinceReferenceDate
                                .truncatingRemainder(dividingBy: 1) * 360))
                    }
                } else {
                    Image("reload").resizable()
                }
            }
            .frame(width: 19 * k, height: 19 * k)
            .frame(width: 46, height: 44)
            .contentShape(.rect)
        }
        .disabled(!reloads)
        .accessibilityLabel(browser.loading ? "Stop" : "Reload")
        .accessibilityShowsLargeContentViewer()
    }
}

/// The page's load under the address: a line in the Workspace's accent.
struct ProgressLine: View {
    @Binding var line: Double
    @Binding var shown: Bool
    let colors: BarColors

    var body: some View {
        GeometryReader { geometry in
            Capsule()
                .fill(colors.accent)
                .frame(width: geometry.size.width * line, height: 3)
        }
        .frame(height: 3)
        .padding(.horizontal, 20)
        .opacity(shown ? 1 : 0)
        .accessibilityHidden(true)
    }
}

/// Moves the progress line with the page in front's load: it eases toward
/// the load's progress, then runs to the end and fades once the load is
/// done. It draws nothing.
struct ProgressFollower: View {
    @Environment(AppModel.self) private var model
    @Binding var line: Double
    @Binding var shown: Bool

    var body: some View {
        let browser = model.browser!
        Color.clear
            .onChange(of: browser.progress, initial: true) { _, progress in
                guard browser.loading else { return }
                if !shown {
                    line = 0
                    shown = true
                }
                withAnimation(.easeOut(duration: 0.3)) { line = max(line, progress) }
            }
            .onChange(of: browser.loading) { _, loading in
                guard !loading, shown else { return }
                withAnimation(Motion.overlay) { line = 1 } completion: {
                    withAnimation(Motion.overlay) { shown = false }
                }
            }
    }
}
