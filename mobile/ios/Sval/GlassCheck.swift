// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// A test bench for round 6's bar, opened with the `-svalGlassCheck` launch
/// option: the four capsules in one glass container, each over a layer of
/// the Workspace colour, collapsing to the pill as a page scrolls under
/// them. It answers Design's three questions on a device: seams while the
/// shapes merge, whether the colour tips the glass dark, and the frame rate.
enum GlassCheck {
    static let requested = LaunchOption.given("-svalGlassCheck")
}

@available(iOS 26, *)
struct GlassCheckView: View {
    enum Backdrop: String, CaseIterable, Identifiable {
        case white = "White", photo = "Photo", same = "Same", dark = "Dark"
        var id: String { rawValue }
    }

    /// Design's mid tones, then the palette's own swatches.
    static let tints: [(name: String, color: Color)] = [
        ("iPhone", Color(hex: 0x7C5CE0)), ("Reading", Color(hex: 0x2F6BEA)), ("Work", Color(hex: 0x2E9E58)),
        ("Travel", Color(hex: 0x0E9AA7)), ("Home", Color(hex: 0xE07A1F)), ("Music", Color(hex: 0x9B59D0)),
        ("Private", Color(hex: 0x8B6CFF)),
    ] + TintPreset.allCases.compactMap { preset in
        WorkspaceTint(rawValue: preset.rawValue).map { (preset.rawValue, $0.swatch(dark: false)) }
    }

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private let backdrop = Backdrop.photo
    private let tint = 0
    @State private var collapsed = false
    /// How far the bar has folded into the pill: 0 at rest, 1 folded.
    @State private var fold = 0.0
    @State private var lastOffset = 0.0
    /// Set by a tap on the pill: the page's coasting leaves the bar open
    /// until a finger drags the page again.
    @State private var heldOpen = false
    /// The scroll so far toward folding or unfolding a bar at rest.
    @State private var run = 0.0
    @State private var meter = FrameMeter()

    private var color: Color { Self.tints[tint].color }

    var body: some View {
        ZStack(alignment: .bottom) {
            page
            FoldingBar(progress: fold, color: color, reduceTransparency: reduceTransparency) {
                Diagnostics.log("glass check: pill tapped")
                if fold > 0 {
                    heldOpen = true
                    set(collapsed: false)
                }
            }
            .padding(.bottom, 24)
        }
        .ignoresSafeArea(edges: .bottom)
        .onAppear { meter.start() }
        .onDisappear { meter.stop() }
    }

    // MARK: The page

    private var page: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 13) {
                Text("A page under the bar")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(ink)
                    .padding(.top, 70)
                ForEach(0..<80, id: \.self) { line in
                    if backdrop == .photo && line % 20 == 8 {
                        LinearGradient(colors: [Color(hex: 0xF6C35B), Color(hex: 0xE8743B), Color(hex: 0xB8325A), Color(hex: 0x3B2466)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                            .frame(height: 320)
                            .clipShape(.rect(cornerRadius: 12))
                    }
                    Capsule()
                        .fill(ink.opacity(0.18))
                        .frame(width: 180 + CGFloat((line * 37) % 160), height: 9)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 140)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(paper)
        .onScrollGeometryChange(for: Double.self) { $0.contentOffset.y } action: { _, offset in
            scrolled(to: offset)
        }
        .onScrollPhaseChange { _, phase in
            if phase == .interacting { heldOpen = false }
            if phase == .idle { settle() }
        }
    }

    private var paper: Color {
        switch backdrop {
        case .white, .photo: .white
        case .same: color
        case .dark: Color(hex: 0x131418)
        }
    }

    private var ink: Color { backdrop == .dark || backdrop == .same ? .white : Color(hex: 0x22242B) }

    /// Collapses the bar going down the page and brings it back going up,
    /// as Safari does.
    /// How far the page scrolls to fold the bar all the way.
    private static let foldDistance = 86.0

    /// How far the page scrolls one way before a resting bar starts to
    /// fold or unfold.
    private static let startDistance = 100.0

    /// Moves the fold with the page: down folds it, up unfolds it, by the
    /// distance scrolled, so it stops when the finger stops. The top of the
    /// page always shows the full bar.
    private func scrolled(to offset: Double) {
        let delta = offset - lastOffset
        lastOffset = offset
        guard !heldOpen else { return }
        // From either end, the page has to travel `startDistance` one way
        // before the fold starts. Partway, it follows every point at once.
        var moved = delta
        if offset > 0, fold == 0 || fold == 1 {
            let towardOtherEnd = fold == 0 ? delta > 0 : delta < 0
            run = towardOtherEnd && (run == 0 || (run > 0) == (delta > 0)) ? run + delta : 0
            guard abs(run) > Self.startDistance else { return }
            moved = run - (run > 0 ? Self.startDistance : -Self.startDistance)
            run = 0
        }
        let next = offset <= 0 ? 0 : min(1, max(0, fold + moved / Self.foldDistance))
        guard next != fold else { return }
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) { fold = next }
        collapsed = next >= 0.5
    }

    /// Once the page stops, a fold left partway finishes toward its nearer
    /// end.
    private func settle() {
        guard fold > 0, fold < 1 else { return }
        set(collapsed: fold >= 0.5)
    }

    private func set(collapsed value: Bool) {
        meter.mark(value ? "collapse" : "expand")
        collapsed = value
        withAnimation(.smooth(duration: 0.4)) { fold = value ? 1 : 0 }
    }
}

/// The bar at any point of its fold into the pill, drawn frame by frame
/// from `progress`, so every part follows one value and an interrupted fold
/// turns around wherever it is. Positions and fades follow Glass Merging's
/// demo: `E` at rest, `C` folded, the buttons fading over the first third
/// (`ca`), the dot over the last (`cb`), and the colour layer fading out
/// as the shapes start to merge and back in under the pill as it settles.
@available(iOS 26, *)
private struct FoldingBar: View, Animatable {
    var progress: Double
    let color: Color
    let reduceTransparency: Bool
    let onTap: () -> Void

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    init(progress: Double, color: Color, reduceTransparency: Bool, onTap: @escaping () -> Void) {
        self.progress = progress
        self.color = color
        self.reduceTransparency = reduceTransparency
        self.onTap = onTap
    }

    private static func smooth(_ a: Double, _ b: Double, _ x: Double) -> Double {
        let u = min(1, max(0, (x - a) / (b - a)))
        return u * u * (3 - 2 * u)
    }

    private static func lerp(_ a: CGRect, _ b: CGRect, _ t: Double) -> CGRect {
        CGRect(x: a.minX + (b.minX - a.minX) * t, y: a.minY + (b.minY - a.minY) * t,
               width: a.width + (b.width - a.width) * t, height: a.height + (b.height - a.height) * t)
    }

    /// Each capsule at rest: Back and Forward, the address, then + and the
    /// Workspace button as 48pt circles, 8pt from the sides and 4pt apart.
    private static func rest(width: Double) -> [CGRect] {
        let address = width - 8 - 80 - 4 - 48 - 4 - 48 - 4 - 8
        return [CGRect(x: 8, y: 0, width: 80, height: 48), CGRect(x: 92, y: 0, width: address, height: 48),
                CGRect(x: 96 + address, y: 0, width: 48, height: 48), CGRect(x: 148 + address, y: 0, width: 48, height: 48)]
    }

    /// Each capsule folded: all four inside one 200 x 36 pill at the
    /// centre, Back and the address at its start, + and the Workspace
    /// button at its end.
    private static func folded(width: Double) -> [CGRect] {
        let x = (width - 200) / 2
        return [CGRect(x: x, y: 6, width: 36, height: 36), CGRect(x: x, y: 6, width: 200, height: 36),
                CGRect(x: x + 164, y: 6, width: 36, height: 36), CGRect(x: x + 164, y: 6, width: 36, height: 36)]
    }

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let t = min(1, max(0, progress))
            let at = zip(Self.rest(width: width), Self.folded(width: width)).map { Self.lerp($0, $1, t) }
            let pill = Self.folded(width: width)[1]
            let layers = 1 - Self.smooth(0, 0.22, t)
            let pillLayer = Self.smooth(0.82, 1, t)
            let icons = 1 - Self.smooth(0, 0.35, t)
            let dot = Self.smooth(0.65, 1, t)
            ZStack(alignment: .topLeading) {
                if reduceTransparency {
                    ForEach(at.indices, id: \.self) { index in
                        Capsule().fill(color)
                            .frame(width: at[index].width, height: at[index].height)
                            .offset(x: at[index].minX, y: at[index].minY)
                    }
                } else {
                    ForEach(at.indices, id: \.self) { index in
                        layer(at[index]).opacity(layers)
                    }
                    layer(pill).opacity(pillLayer)
                }
                GlassEffectContainer(spacing: 3) {
                    ZStack(alignment: .topLeading) {
                        ForEach(at.indices, id: \.self) { index in
                            Color.clear
                                .frame(width: at[index].width, height: at[index].height)
                                .glassEffect(.regular.interactive(), in: .capsule)
                                .offset(x: at[index].minX, y: at[index].minY)
                        }
                    }
                }
                buttons(at, icons: icons, dot: dot)
                // The address capsule, partway or fully folded, opens the
                // bar. A button on top, since the glass takes touches for
                // its own response.
                if t > 0 {
                    Button(action: onTap) {
                        Color.clear.contentShape(.capsule)
                    }
                    .buttonStyle(.plain)
                    .frame(width: at[1].width, height: at[1].height)
                    .offset(x: at[1].minX, y: at[1].minY)
                    .accessibilityLabel("Show the toolbar")
                }
            }
        }
        .frame(height: 48)
    }

    /// The colour under a capsule: the Workspace colour at 55%, in its
    /// shape and 2pt larger all round.
    private func layer(_ frame: CGRect) -> some View {
        Capsule().fill(color.opacity(0.55))
            .frame(width: frame.width + 4, height: frame.height + 4)
            .offset(x: frame.minX - 2, y: frame.minY - 2)
    }

    /// What the capsules hold. The shield and the address keep their place
    /// and size folded or not; the rest fade.
    private func buttons(_ at: [CGRect], icons: Double, dot: Double) -> some View {
        ZStack(alignment: .topLeading) {
            HStack(spacing: 0) {
                Image(systemName: "chevron.backward").frame(width: 40, height: 48)
                Image(systemName: "chevron.forward").frame(width: 40, height: 48).opacity(0.35)
            }
            .font(.system(size: 19, weight: .semibold))
            .offset(x: at[0].midX - 40, y: at[0].midY - 24)
            .opacity(icons)
            HStack(spacing: 6) {
                Image(systemName: "shield.fill")
                    .font(.system(size: 17))
                    .foregroundStyle(Color(hex: 0x1F6BFF))
                    .frame(width: 36, height: 36)
                Text("lerail.eu").font(.system(size: 15, weight: .semibold)).lineLimit(1)
            }
            .offset(x: 100, y: 6)
            Image(systemName: "arrow.clockwise").font(.system(size: 17, weight: .medium))
                .frame(width: 36, height: 36)
                .offset(x: at[1].maxX - 44, y: at[1].midY - 18)
                .opacity(icons)
            Image(systemName: "plus").font(.system(size: 20, weight: .medium))
                .frame(width: 48, height: 48)
                .offset(x: at[2].midX - 24, y: at[2].midY - 24)
                .opacity(icons)
            Text("📱").font(.system(size: 20))
                .frame(width: 48, height: 48)
                .offset(x: at[3].midX - 24, y: at[3].midY - 24)
                .opacity(icons)
            Circle().fill(color).frame(width: 24, height: 24)
                .overlay { Text("📱").font(.system(size: 12)) }
                .offset(x: at[1].maxX - 31, y: at[1].midY - 12)
                .opacity(dot)
        }
        .foregroundStyle(.primary)
    }
}

/// Counts the frames drawn, through a display link, and logs the slowest
/// second around each collapse and expand.
@MainActor
@Observable
final class FrameMeter {
    private(set) var summary = "fps –"
    @ObservationIgnored private var link: CADisplayLink?
    @ObservationIgnored private var frames = 0
    @ObservationIgnored private var windowStart = 0.0
    @ObservationIgnored private var longest = 0.0
    @ObservationIgnored private var last = 0.0
    @ObservationIgnored private var lowest = Double.infinity
    @ObservationIgnored private var event: String?

    func start() {
        let link = CADisplayLink(target: Ticker(self), selector: #selector(Ticker.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    func mark(_ name: String) { event = name }

    fileprivate func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        if last > 0 { longest = max(longest, now - last) }
        last = now
        frames += 1
        if windowStart == 0 { windowStart = now }
        guard now - windowStart >= 1 else { return }
        let fps = Double(frames) / (now - windowStart)
        lowest = min(lowest, fps)
        summary = String(format: "fps %.0f · lowest %.0f · longest frame %.0fms", fps, lowest, longest * 1000)
        Diagnostics.log(String(format: "glass check: %.0f fps, longest frame %.1fms%@", fps, longest * 1000,
                               event.map { " (\($0))" } ?? ""))
        frames = 0
        windowStart = now
        longest = 0
        event = nil
    }
}

/// The display link's target, which holds the meter weakly.
private final class Ticker: NSObject {
    weak var meter: FrameMeter?
    init(_ meter: FrameMeter) { self.meter = meter }
    @MainActor @objc func tick(_ link: CADisplayLink) { meter?.tick(link) }
}
