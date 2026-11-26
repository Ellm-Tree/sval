// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// The walkthrough this phone's own Workspace shows while it has no tabs,
/// until it is finished or skipped: what the Workspace is for, then each
/// of the bar's capsules in turn, lit by `BarSpotlight`, then New Tab.
enum Walkthrough {
    /// Set once the walkthrough is finished or skipped.
    static let doneKey = "deviceWalkthroughDone"
    /// The welcome, a page for each capsule but Back and Forward, and New Tab.
    static let pages = 5

    /// The capsule a page lights, as `GlassFold.rest` orders them.
    static func capsule(on page: Int) -> Int? {
        (1...3).contains(page) ? page : nil
    }
}

/// The page this phone's own Workspace shows while it has no tabs, on the
/// night sky first run is drawn on.
struct DeviceHome: View {
    let workspace: OutlineRow?
    @Binding var done: Bool
    @Binding var page: Int
    let onNewTab: () -> Void

    var body: some View {
        ZStack {
            NightSky()
            if done {
                DeviceHomeRest(workspace: workspace, onNewTab: onNewTab)
            } else {
                WalkthroughPages(page: $page, onSkip: finish) {
                    finish()
                    onNewTab()
                }
            }
        }
        .foregroundStyle(.white)
        .environment(\.colorScheme, .dark)
    }

    private func finish() {
        withAnimation(Motion.overlay) { done = true }
    }
}

/// The Workspace's name and what it is for, over New Tab, once the
/// walkthrough is over.
private struct DeviceHomeRest: View {
    let workspace: OutlineRow?
    let onNewTab: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: NoticePage.spacing) {
                WorkspaceTile(workspace: workspace, size: 64)
                FirstRunStyle.headline("Your \(UIDevice.current.model)'s Workspace")
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text(WalkthroughPages.purpose)
                    .font(.system(.body))
                    .foregroundStyle(FirstRunStyle.lead)
                    .multilineTextAlignment(.center)
                Button(action: onNewTab) {
                    Label("New Tab", systemImage: "plus")
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .padding(.top, 8)
            }
            .padding(.horizontal, NoticePage.side)
            .padding(.vertical, 72)
            .frame(maxWidth: NoticePage.width)
            .frame(maxWidth: .infinity)
            .containerRelativeFrame(.vertical, alignment: .center)
        }
        .scrollBounceBehavior(.basedOnSize)
    }
}

/// The walkthrough's pages, swiped through or stepped with Next, with Skip
/// at the top until the last.
private struct WalkthroughPages: View {
    @Binding var page: Int
    let onSkip: () -> Void
    let onNewTab: () -> Void
    @Environment(\.verticalSizeClass) private var verticalSize

    static var purpose: String {
        "Tabs opened here sync to your other devices as a new “\(UIDevice.current.model)” Workspace. You can rename and recolor the Workspace."
    }

    private var last: Bool { page == Walkthrough.pages - 1 }
    /// Where the pages are scrolled to, and where they last came to rest:
    /// the mark is pulled by the difference while they move.
    @State private var offset: CGFloat = 0
    @State private var rest: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                if !last {
                    Button("Skip", action: onSkip)
                        .font(.system(.body, weight: .semibold))
                        .foregroundStyle(FirstRunStyle.cyan)
                        .frame(minWidth: RowMetrics.target, minHeight: RowMetrics.target)
                }
            }
            .frame(minHeight: RowMetrics.target)
            .padding(.horizontal, 20)
            WalkthroughMark(pull: offset - rest)
                .padding(.top, 60)
            ScrollView(.horizontal) {
                LazyHStack(spacing: 0) {
                    ForEach(0..<Walkthrough.pages, id: \.self) { index in
                        content(index)
                            .padding(.horizontal, NoticePage.side)
                            .frame(maxWidth: NoticePage.width)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .containerRelativeFrame([.horizontal, .vertical])
                            .id(index)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollIndicators(.hidden)
            .scrollPosition(id: Binding(get: { page }, set: { if let new = $0 { page = new } }))
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.x } action: { _, x in offset = x }
            .onScrollPhaseChange { _, phase in
                if phase == .idle { rest = offset }
            }
            footer
                .padding(.horizontal, NoticePage.side)
                .padding(.top, 12)
                .padding(.bottom, 24)
                .frame(maxWidth: NoticePage.width)
        }
        // The bar covers the page's foot.
        .padding(.bottom, verticalSize == .compact ? Browser.sidewaysBarRoom : Browser.barRoom)
    }

    @ViewBuilder private func content(_ index: Int) -> some View {
        switch index {
        case 0:
            VStack(alignment: .leading, spacing: 16) {
                FirstRunStyle.headline("Your \(UIDevice.current.model)'s Workspace")
                    .accessibilityAddTraits(.isHeader)
                lead(Self.purpose)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case 1:
            step("The Launcher", "Search the web or open an address in the current tab. The shield opens the site's settings.")
        case 2:
            step("New Tab", "Open the Launcher for a new tab.")
        case 3:
            step("Your Workspace", "See this Workspace's tabs and your other Workspaces.")
        default:
            VStack(alignment: .leading, spacing: 16) {
                FirstRunStyle.headline("You're All Set")
                    .accessibilityAddTraits(.isHeader)
                lead("We hope you enjoy Sval.")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// A capsule's page: its words low on the screen, near the capsule.
    private func step(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Spacer(minLength: 0)
            FirstRunStyle.headline(title, size: 26)
                .accessibilityAddTraits(.isHeader)
            lead(text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func lead(_ text: String) -> some View {
        Text(text)
            .font(.system(.body))
            .foregroundStyle(FirstRunStyle.lead)
            .lineSpacing(Space.noticeLeading)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var footer: some View {
        HStack(spacing: 16) {
            PageDots(count: Walkthrough.pages, current: page, on: FirstRunStyle.cyan,
                     off: Color(hex: Palette.ice, opacity: 0.3), height: 6, wide: 20, through: true)
                .accessibilityElement()
                .accessibilityLabel("Page \(page + 1) of \(Walkthrough.pages)")
            Spacer()
            if last {
                Button("Start Browsing", action: onNewTab)
                    .buttonStyle(.glassProminent)
                    .controlSize(.large)
            } else {
                Button("Next") {
                    withAnimation(Motion.overlay) { page += 1 }
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
            }
        }
    }
}

/// Sval's mark over the walkthrough, pulled sideways with the pages as
/// they move and springing back once they rest.
private struct WalkthroughMark: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// How far the pages have moved since they last rested.
    let pull: CGFloat

    var body: some View {
        // The pull eases off toward 36pt however far the pages go.
        let shift = reduceMotion ? 0 : -36 * tanh(pull / 240)
        Image("mark").resizable().scaledToFit()
            .frame(width: 144, height: 144)
            .shadow(color: Color(hex: Palette.navy).opacity(0.6), radius: 20)
            .shadow(color: .black.opacity(0.65), radius: 28, y: 22)
            .offset(x: shift)
            .animation(.bouncy(duration: 0.5, extraBounce: 0.25), value: shift)
            .accessibilityHidden(true)
    }
}

/// Dims the open bar but for the capsule a walkthrough page names, and
/// rings that one, at its place in `GlassFold`'s layout. The bar stays
/// live under it.
struct BarSpotlight: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .subheadline) private var line: CGFloat = BarShape.line
    let size: CGSize
    let capsule: Int
    @State private var pulsing = false

    var body: some View {
        let capsules = GlassFold<EmptyView>.rest(width: size.width, shape: BarShape(typeSize, line: line))
        let hole = capsules[capsule].insetBy(dx: -4, dy: -4)
        let ring = FirstRunStyle.cyan
        ZStack(alignment: .topLeading) {
            SpotlightShape(hole: hole)
                .fill(Color.black.opacity(0.55), style: FillStyle(eoFill: true))
            Capsule()
                .stroke(ring, lineWidth: 2)
                .shadow(color: ring, radius: 8)
                .frame(width: hole.width, height: hole.height)
                .offset(x: hole.minX, y: hole.minY)
            if !reduceMotion {
                Capsule()
                    .stroke(ring.opacity(pulsing ? 0 : 0.7), lineWidth: 2)
                    .frame(width: hole.width, height: hole.height)
                    .scaleEffect(pulsing ? 1.25 : 1)
                    .offset(x: hole.minX, y: hole.minY)
                    .animation(.easeOut(duration: 1.4).repeatForever(autoreverses: false), value: pulsing)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .animation(reduceMotion ? nil : Motion.glide, value: capsule)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { pulsing = true }
    }
}

/// A rectangle with a capsule cut from it, the cut moving smoothly from
/// one capsule to the next.
private struct SpotlightShape: Shape {
    var hole: CGRect

    var animatableData: CGRect.AnimatableData {
        get { hole.animatableData }
        set { hole.animatableData = newValue }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path(rect)
        path.addRoundedRect(in: hole, cornerSize: CGSize(width: hole.height / 2, height: hole.height / 2))
        return path
    }
}
