// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// The upright bar, open or folded: the one view of the bar that reads the
/// fold. It places the controls `BrowserBar` built, so a fold runs neither
/// `BrowserBar`'s body nor its builders.
struct FoldingBar<Nav: View, Row: View, NewTab: View, WorkspaceButton: View, WorkspaceLabel: View, OtherMedia: View>: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The capsules' glass identities, by which the fold morphs them into
    /// the pill and back.
    @Namespace private var glassSpace

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
    /// How far the rider stands above the bar's top.
    private static var riderRise: CGFloat { NowPlayingCapsule.height + Browser.overBarGap }

    var body: some View {
        let folded = model.browser.fold.folded
        GlassFold(folded: folded) { at, folded, shape in
            capsules(at, folded, shape)
        }
        // Above the full bar and the folded pill alike, and above
        // another tab's now-playing capsule while that shows.
        .overlay(alignment: .top) {
            BarNotices(colors: colors, asks: facts.asks)
                .offset(y: facts.otherMedia != nil && !folded ? BarNotices.rise - Self.riderRise : BarNotices.rise)
        }
    }

    /// The upright bar, its capsules at `at`: Back and Forward, the
    /// address, New Tab and the Workspace button (14a1). Folded, they go
    /// into one pill holding the shield, the address and a dot in the
    /// Workspace colour (14i5). The shield and the address stay as they
    /// are.
    ///
    /// Back, New Tab and the Workspace button leave the bar as it folds,
    /// and their glass is drawn from the nearby pill's as they go and come
    /// back (`matchedGeometry`). Apple says that applies to a shape "within
    /// the spacing" of another, so the container's spacing is the 6pt gap
    /// between the capsules.
    private func capsules(_ at: [CGRect], _ folded: Bool, _ shape: BarShape) -> some View {
        let k = shape.scale
        let address = at[1]
        // Each capsule's controls are its glass's own content, so they move
        // with the glass when it answers a touch.
        return ZStack(alignment: .topLeading) {
            GlassEffectContainer(spacing: 6) {
                ZStack(alignment: .topLeading) {
                    // Folded, the pill is one button, and the other
                    // capsules' glass would answer a touch meant for it.
                    if !folded {
                        capsule(at[0], id: 0) { nav }
                    }
                    capsule(address, id: 1) {
                        addressCapsule(address, folded: folded, shape: shape)
                    }
                    if !folded {
                        capsule(at[2], id: 2) { newTab }
                        // Held for a scrub, its glass stays still under the
                        // lifted button, which would show it swelling and
                        // following the finger past its edge.
                        capsule(at[3], interactive: scrubbing != .workspaces, id: 3) { workspaceButton }
                    }
                }
            }
            if scrubbing == .tabs && !folded {
                lifted(address) { addressCapsule(address, folded: false, shape: shape) }
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.87).combined(with: .opacity))
            }
            if scrubbing == .workspaces && !folded {
                lifted(at[3]) { workspaceLabel }
                    .transition(reduceMotion ? .opacity : .scale(scale: 0.87).combined(with: .opacity))
            }
            // Media playing, in this tab or another, rides above the bar in
            // its own capsule (14k4, 17c). Folded, the page in front's is the
            // speaker in the pill, and another tab's is its icon beside it.
            if let rider, !folded {
                rider
                    .frame(width: at[3].maxX - 8)
                    .offset(x: 8, y: -Self.riderRise)
            }
            if let otherMedia, folded {
                otherMedia
                    .offset(x: address.maxX + BarShape.gap, y: address.minY)
            }
        }
        .foregroundStyle(colors.ink)
        .animation(.spring(duration: 0.35, bounce: 0.2), value: scrubbing)
    }

    /// One capsule: its content centred in its frame, on glass of the
    /// frame's shape, at its place in the fold.
    private func capsule<Content: View>(_ frame: CGRect, interactive: Bool = true, id: Int,
                                        @ViewBuilder content: () -> Content) -> some View {
        content()
            .frame(width: frame.width, height: frame.height)
            .glassEffect(workspaceGlass(layer, interactive: interactive), in: .capsule)
            .glassEffectID(id, in: glassSpace)
            .glassEffectTransition(.matchedGeometry)
            .offset(x: frame.minX, y: frame.minY)
    }

    /// The address, or the Workspace button, lifted over the bar while it
    /// is held for a scrub, grown past the buttons beside it from its
    /// capsule at `frame`. It is drawn outside the bar's glass container,
    /// which would merge its glass with theirs where they overlap, and it
    /// takes no touches, so the hold under it carries on.
    private func lifted<Content: View>(_ frame: CGRect, @ViewBuilder content: () -> Content) -> some View {
        let grown: CGFloat = 1.15
        let lifted = frame.insetBy(dx: -frame.width * (grown - 1) / 2, dy: -frame.height * (grown - 1) / 2)
        return content()
            .scaleEffect(grown)
            .frame(width: lifted.width, height: lifted.height)
            .glassEffect(workspaceGlass(layer, interactive: false), in: .capsule)
            .shadow(color: .black.opacity(0.35), radius: 14, y: 6)
            .offset(x: lifted.minX, y: lifted.minY)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    /// The address capsule's content. The shield and the address hold their
    /// place and their size on the capsule's midline as it shrinks to the
    /// pill; Reload shows at its end open, and the Workspace's dot folded. Folded, a tap anywhere on it brings the
    /// full bar back.
    private func addressCapsule(_ address: CGRect, folded: Bool, shape: BarShape) -> some View {
        let k = shape.scale
        let tall = shape.tall
        // The folded pill's marks, smaller with it.
        let s = folded && !tall ? BarShape.pillScale : 1
        let inset: Double = folded ? 0 : 4
        // With no page there is nothing to reload, and the address takes
        // Reload's room.
        let reloads = facts.reloads
        let room = address.width - inset - (folded ? (speaker != nil ? 60 : 30) * s : (reloads ? 40 * k : 8))
        return ZStack(alignment: .leading) {
            row
                // Built at the open address's height less its 6pt margins.
                .frame(width: max(0, room), height: shape.address - 12, alignment: .leading)
                .padding(.leading, inset)
                // Folded, the pill is one button.
                .allowsHitTesting(!folded)
                .accessibilityHidden(folded)
            if folded {
                workspaceDot(scale: s)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.trailing, 6 * s)
                // The pill is shorter than a touch target, so its tap
                // reaches past its edges to 44pt tall.
                Button(action: openBar) { Color.clear.contentShape(Capsule().inset(by: min(0, address.height - 44) / 2)) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Show the toolbar")
                if let speaker {
                    speaker
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.trailing, 32 * s)
                }
            } else {
                ReloadButton(reloads: reloads, scale: k).frame(width: 36 * k, height: 44)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.trailing, 4)
                    .opacity(reloads ? 1 : 0)
            }
        }
        .frame(width: address.width, height: address.height)
        .overlay(alignment: .bottom) { progress.padding(.bottom, 1) }
    }

    /// The folded pill's dot: the Workspace colour, solid, with its emoji.
    private func workspaceDot(scale s: Double) -> some View {
        Circle()
            .fill(layer)
            .frame(width: 24 * s, height: 24 * s)
            .overlay {
                WorkspaceMark(workspace: facts.workspace, isPrivate: facts.isPrivateSession, size: 13 * s)
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
        ProgressView(value: line)
            .progressViewStyle(.linear)
            .tint(colors.accent)
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
