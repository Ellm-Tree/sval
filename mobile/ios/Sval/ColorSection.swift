// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit

/// The Color section of the Workspace and group sheets (round 8, 16a–16f):
/// No color, the presets and one custom colour, each drawn its own way, and
/// the custom colour's Hue, Intensity and Shade in the same Form. Every
/// colour in it comes from the desktop's maths ([`DesktopColor`]).
struct ColorSection: View {
    @Environment(\.appearance) private var scheme

    /// The stored colour: a preset's token, a custom colour's JSON, or nil.
    @Binding var color: String?
    /// The one custom colour, kept while No color is chosen, so tapping
    /// Custom again brings it back.
    @Binding var custom: DesktopColor.Custom?
    let isWorkspace: Bool
    /// The surface a group's blocks step from: its Workspace's window.
    let surface: DesktopColor.Surface
    let sheet: DesktopColor.Sheet
    /// Called on a colour tap, so the name field gives up the keyboard.
    var onPick: () -> Void = {}

    /// Custom was tapped in this sheet. A custom colour made from a preset
    /// starts as that preset's value, which the grid would read as the
    /// preset (16c), so the choice is kept until a swatch or No color.
    @State private var customChosen = false
    /// The shade Hue, Intensity or Shade last set, and the colour it was
    /// set for: while the colour is that one, its shade is this one.
    @State private var shade: (shade: DesktopColor.Shade, of: DesktopColor.Custom)?

    private var dark: Bool { scheme == .dark }
    private var mode: String { dark ? "dark" : "light" }

    var body: some View {
        Section {
            noColorRow
            grid
            customRow
            if isCustom { sliders }
        } header: {
            SectionCaption("Color", color: Color(hex: sheet.footer))
        } footer: {
            if let footer {
                Text(footer)
                    .foregroundStyle(Color(hex: sheet.footer))
            }
        }
        .listRowBackground(Color(hex: sheet.cell))
        .listRowSeparatorTint(Color(hex: sheet.ring).opacity(0.4))
        .animation(Motion.overlay, value: isCustom)
        .onAppear {
            // A stored custom colour that no swatch picks is the custom slot.
            if custom == nil, isCustom { custom = DesktopColor.Custom(color) }
        }
    }

    // MARK: What is chosen

    /// A preset swatch: its name and row, and the colour it stores here.
    private struct Swatch: Identifiable {
        let name: String
        /// "dark" or "light" for a Workspace's two rows; nil for a group's.
        let side: String?
        var id: String { name + (side ?? "") }
    }

    /// What the colour is: a preset swatch, the custom colour, or none. A
    /// custom colour that is a preset's version, as one picked in the other
    /// appearance is stored, is that preset's swatch (16c). The version is
    /// the one this appearance's swatch stores, as the desktop compares
    /// (`_chosenSlot`): a version's `mode` is the side its surface suits,
    /// which for Yellow's dark row is the other appearance.
    private var chosenSwatch: Swatch? {
        guard let color else { return nil }
        if let preset = TintPreset(rawValue: color) {
            guard isWorkspace else { return Swatch(name: preset.rawValue, side: nil) }
            return Swatch(name: preset.rawValue, side: preset == .black ? "dark" : mode)
        }
        guard isWorkspace, let found = Self.presetSwatch(of: color, dark: dark) else { return nil }
        return Swatch(name: found.name, side: found.side)
    }

    /// The Workspace swatch, by preset name and row, whose version in this
    /// appearance is the custom colour `stored`, if any.
    static func presetSwatch(of stored: String, dark: Bool) -> (name: String, side: String)? {
        guard let custom = DesktopColor.Custom(stored) else { return nil }
        for preset in TintPreset.allCases {
            for (name, side) in [(preset.rawValue, "dark"), (preset == .black ? "white" : preset.rawValue, "light")]
            where DesktopColor.Custom(DesktopColor.presetVersion(name, side: side, dark: dark)) == custom {
                return (name, side)
            }
        }
        return nil
    }

    private var isCustom: Bool { color != nil && (customChosen || chosenSwatch == nil) }

    private func value(of swatch: Swatch) -> String? {
        guard let side = swatch.side else { return swatch.name }
        return DesktopColor.presetVersion(swatch.name, side: side, dark: dark)
    }

    // MARK: Rows

    /// A row's leading column, a fifth of the row, where No color's circle
    /// and Custom's capsule line up with the grid's first column.
    private func row<Mark: View, Label: View>(_ selected: Bool, action: @escaping () -> Void,
                                              @ViewBuilder mark: () -> Mark, @ViewBuilder label: () -> Label) -> some View {
        let mark = mark()
        let label = label()
        return Button(action: action) {
            GeometryReader { geometry in
                HStack(spacing: 0) {
                    mark.frame(width: geometry.size.width / 5)
                    label
                    Spacer(minLength: 0)
                }
                .frame(maxHeight: .infinity)
            }
            .frame(minHeight: 56)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var noColorRow: some View {
        let selected = color == nil
        return row(selected, action: { pick(nil) }) {
            ZStack {
                Circle().strokeBorder(Color(hex: sheet.ring), lineWidth: 1.5)
                Rectangle()
                    .fill(Color(hex: sheet.ring))
                    .frame(width: 1.5, height: 36)
                    .rotationEffect(.degrees(45))
            }
            .frame(width: 36, height: 36)
            .clipShape(.circle)
            .modifier(Chosen(selected: selected, shape: Circle(), sheet: sheet))
        } label: {
            Text("No color").foregroundStyle(Color(hex: sheet.cellText))
        }
        .accessibilityLabel("No color")
    }

    private var customRow: some View {
        let selected = isCustom
        let fill = custom.flatMap { DesktopColor.swatch($0.json, workspace: isWorkspace, dark: dark) }
        return row(selected, action: chooseCustom) {
            Group {
                if let fill {
                    Capsule().fill(Color(hex: fill))
                        .overlay { Capsule().strokeBorder(Color(hex: sheet.ring), lineWidth: 1.5) }
                } else {
                    Capsule()
                        .strokeBorder(Color(hex: sheet.cellSecondary), style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                        .overlay {
                            Image(systemName: "plus")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color(hex: sheet.cellSecondary))
                        }
                }
            }
            .frame(width: 52, height: 32)
            .modifier(Chosen(selected: selected, shape: Capsule(), sheet: sheet))
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text("Custom").foregroundStyle(Color(hex: sheet.cellText))
                if custom == nil {
                    Text("Choose hue, intensity and shade")
                        .font(.system(.footnote))
                        .foregroundStyle(Color(hex: sheet.cellSecondary))
                }
            }
        }
        .accessibilityLabel("Custom color")
        .accessibilityValue(custom.map(describe) ?? "")
    }

    // MARK: The grid

    private var grid: some View {
        let presets = TintPreset.allCases.map(\.rawValue)
        let blocks = [Array(presets.prefix(5)), Array(presets.suffix(5))]
        return VStack(spacing: 14) {
            ForEach(blocks.indices, id: \.self) { b in
                VStack(spacing: 2) {
                    if isWorkspace {
                        swatchRow(blocks[b].map { Swatch(name: $0, side: "dark") })
                        swatchRow(blocks[b].map { Swatch(name: $0 == "black" ? "white" : $0, side: "light") })
                    } else {
                        swatchRow(blocks[b].map { Swatch(name: $0, side: nil) })
                    }
                }
            }
        }
        .padding(EdgeInsets(top: 12, leading: 0, bottom: 14, trailing: 0))
    }

    private func swatchRow(_ swatches: [Swatch]) -> some View {
        HStack(spacing: 0) {
            ForEach(swatches) { swatch in
                swatchButton(swatch).frame(maxWidth: .infinity)
            }
        }
    }

    private func swatchButton(_ swatch: Swatch) -> some View {
        let selected = !customChosen && chosenSwatch?.id == swatch.id
        let stored = value(of: swatch)
        let fill = stored.flatMap { DesktopColor.swatch($0, workspace: isWorkspace, dark: dark) }
        return Button { pick(stored) } label: {
            Circle()
                .fill(fill.map { Color(hex: $0) } ?? .clear)
                .overlay { Circle().strokeBorder(Color(hex: sheet.ring), lineWidth: 1.5) }
                .frame(width: 36, height: 36)
                .modifier(Chosen(selected: selected, shape: Circle(), sheet: sheet))
                .frame(width: 66, height: 46)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label(of: swatch))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func label(of swatch: Swatch) -> String {
        if swatch.name == "white" { return "White" }
        let name = swatch.name.capitalized
        guard let side = swatch.side, swatch.name != "black" else { return name }
        return "\(name), \(side)"
    }

    // MARK: Custom

    /// The custom colour to edit in this appearance: one saved in the other
    /// appearance starts from how it looks now (`customFrom`).
    private var editable: DesktopColor.Custom {
        if let custom, !isWorkspace || custom.mode == mode { return custom }
        if isWorkspace, let now = DesktopColor.customFrom(custom?.json ?? color ?? "blue", dark: dark) { return now }
        return custom ?? DesktopColor.Custom(h: 262, c: 0.1)
    }

    private func chooseCustom() {
        onPick()
        // Custom starts from the colour on show (`_chooseSwatch`). A
        // Workspace with No color shows Sval's own window; a group with
        // none brings back the custom colour kept, or starts from Blue.
        let next = isCustom ? editable : !isWorkspace && color == nil ? custom ?? rebased : rebased
        customChosen = true
        custom = next
        color = next.json
    }

    /// A custom colour made from the colour chosen now: with none, a
    /// Workspace's from Sval's own window and a group's from Blue (16a,
    /// `rebase`).
    private var rebased: DesktopColor.Custom {
        guard isWorkspace else { return Self.groupCustom(from: color ?? "blue") }
        return DesktopColor.customFrom(color, dark: dark)
            ?? DesktopColor.Custom(h: 262, c: 0.1, l: 0.4, mode: mode)
    }

    /// A group's custom colour that starts from `stored`: a custom
    /// colour's hue and chroma, or a preset's block hue and chroma
    /// (`_groupCustomFrom`).
    static func groupCustom(from stored: String) -> DesktopColor.Custom {
        if let custom = DesktopColor.Custom(stored) { return DesktopColor.Custom(h: custom.h, c: custom.c) }
        guard let members = DesktopColor.group(stored) else { return DesktopColor.Custom(h: 262, c: 0.1) }
        return DesktopColor.Custom(h: members.h, c: min(members.bc, DesktopColor.chromaMax))
    }

    private func set(_ next: DesktopColor.Custom) {
        custom = next
        color = next.json
    }

    @ViewBuilder private var sliders: some View {
        let current = editable
        let l = current.l ?? 0.5
        let on: DesktopColor.Surface? = isWorkspace ? nil : surface
        SliderRow(label: "Hue", sheet: sheet,
                  value: current.h / 360,
                  track: .gradient(DesktopColor.track("hue", h: current.h, c: current.c, l: l, group: on)),
                  accessibilityValue: describe(current),
                  step: 10.0 / 360) { x in
            setHueChroma(h: x * 360, c: current.c, from: current)
        }
        SliderRow(label: "Intensity", sheet: sheet,
                  value: current.c / DesktopColor.chromaMax,
                  track: .gradient(DesktopColor.track("chroma", h: current.h, c: current.c, l: l, group: on)),
                  accessibilityValue: "\(Int((current.c / DesktopColor.chromaMax * 100).rounded())) percent",
                  step: 0.1) { x in
            setHueChroma(h: current.h, c: x * DesktopColor.chromaMax, from: current)
        }
        if isWorkspace { shadeRow(current) }
    }

    /// A new hue and chroma for the custom colour, rounded as the desktop
    /// rounds them, at the shade it has (`_setHueChroma`).
    private func setHueChroma(h: Double, c: Double, from current: DesktopColor.Custom) {
        let h = ((h * 10).rounded() / 10).truncatingRemainder(dividingBy: 360)
        let c = (min(max(c, 0), DesktopColor.chromaMax) * 1000).rounded() / 1000
        guard isWorkspace else {
            set(DesktopColor.Custom(h: h, c: c))
            return
        }
        guard let place = shade(of: current), let l = DesktopColor.lightness(h: h, c: c, at: place) else { return }
        let next = DesktopColor.Custom(h: h, c: c, l: l, mode: mode)
        set(next)
        shade = (place, next)
    }

    /// The custom colour's shade: the one last set while the colour is the
    /// one it was set for, or else the colour's own.
    private func shade(of current: DesktopColor.Custom) -> DesktopColor.Shade? {
        if let shade, shade.of == current { return shade.shade }
        return DesktopColor.shade(h: current.h, c: current.c, l: current.l ?? 0.5)
    }

    /// Shade: only the lightnesses text reads on, the deep band then the
    /// pale one with a gap where the text flips (16b). The value snaps to
    /// the nearest one.
    @ViewBuilder private func shadeRow(_ current: DesktopColor.Custom) -> some View {
        let bands = DesktopColor.shades(h: current.h, c: current.c)
        let all = bands.deep + bands.pale
        if all.count > 1 {
            let l = current.l ?? 0.5
            let index = all.indices.min { abs(all[$0] - l) < abs(all[$1] - l) } ?? 0
            let track = DesktopColor.shadeTrack(h: current.h, c: current.c)
            let light = index >= bands.deep.count
            SliderRow(label: "Shade", sheet: sheet,
                      value: Double(index) / Double(all.count - 1),
                      track: .bands(track.deep, track.pale),
                      accessibilityValue: "\(Int((Double(index) / Double(all.count - 1) * 100).rounded())) percent",
                      step: 0.1) { x in
                let i = min(all.count - 1, max(0, Int((x * Double(all.count - 1)).rounded())))
                let next = DesktopColor.Custom(h: current.h, c: current.c, l: all[i], mode: mode)
                set(next)
                let deep = i < bands.deep.count
                let band = deep ? bands.deep : bands.pale
                let at = deep ? i : i - bands.deep.count
                shade = (DesktopColor.Shade(band: deep ? "deep" : "pale",
                                            frac: band.count > 1 ? 1 - Double(at) / Double(band.count - 1) : 0), next)
            }
            .sensoryFeedback(.selection, trigger: light)
        }
    }

    /// The colour in words, for VoiceOver: the nearest preset's name, deep
    /// or pale by the Shade band its lightness is in (`bands`).
    private func describe(_ custom: DesktopColor.Custom) -> String {
        let hues: [(Double, String)] = [(25, "red"), (55, "orange"), (95, "yellow"), (150, "green"), (210, "teal"),
                                        (262, "blue"), (305, "violet"), (350, "pink"), (385, "red")]
        let name = custom.c < 0.03 ? "gray"
            : hues.min { abs($0.0 - custom.h) < abs($1.0 - custom.h) }?.1 ?? "colour"
        guard let l = custom.l else { return name }
        let deepest = DesktopColor.shades(h: custom.h, c: custom.c).deep.last ?? 0.6
        return (l <= deepest ? "deep " : "pale ") + name
    }

    private func pick(_ stored: String?) {
        onPick()
        customChosen = false
        color = stored
    }

    /// Only a group with No color says where its colours come from.
    private var footer: String? {
        !isWorkspace && color == nil ? "The group takes the Workspace's colors." : nil
    }
}

/// The ring a chosen swatch, No color or Custom wears: a ring in the
/// cell's text colour outside a 3pt gap in the cell's colour (16a).
private struct Chosen<S: InsettableShape>: ViewModifier {
    let selected: Bool
    let shape: S
    let sheet: DesktopColor.Sheet

    func body(content: Content) -> some View {
        content.background {
            if selected {
                shape.inset(by: -5.5).fill(Color(hex: sheet.cellText))
                    .overlay { shape.inset(by: -3).fill(Color(hex: sheet.cell)) }
            }
        }
    }
}

/// A Form row of a label and a slider whose whole track shows what it
/// gives (16b).
private struct SliderRow: View {
    let label: String
    let sheet: DesktopColor.Sheet
    let value: Double
    let track: TrackSlider.Track
    let accessibilityValue: String
    /// How far one VoiceOver swipe moves it.
    let step: Double
    let onChange: (Double) -> Void

    var body: some View {
        HStack(spacing: 0) {
            Text(label)
                .foregroundStyle(Color(hex: sheet.cellText))
                .frame(minWidth: 76, alignment: .leading)
                .fixedSize()
            TrackSlider(value: value, track: track, ring: sheet.ring, step: step, onChange: onChange)
                .accessibilityLabel(label)
                .accessibilityValue(accessibilityValue)
        }
        .frame(minHeight: 56)
    }
}

/// The system slider, with a track image of our own as both its minimum
/// and maximum track, so the whole track is the gradient (16b). SwiftUI's
/// `Slider` takes no track image. It has no step, so it draws no ticks.
private struct TrackSlider: UIViewRepresentable {
    enum Track: Equatable {
        case gradient([UInt32])
        /// Shade's two bands, with a gap where the text flips.
        case bands([UInt32], [UInt32])
    }

    let value: Double
    let track: Track
    let ring: UInt32
    let step: Double
    let onChange: (Double) -> Void

    func makeUIView(context: Context) -> Slider {
        let slider = Slider()
        slider.minimumValue = 0
        slider.maximumValue = 1
        slider.isContinuous = true
        slider.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .valueChanged)
        return slider
    }

    func updateUIView(_ slider: Slider, context: Context) {
        context.coordinator.onChange = onChange
        slider.step = step
        if !slider.isTracking { slider.value = Float(value) }
        if context.coordinator.track != track || context.coordinator.ring != ring {
            context.coordinator.track = track
            context.coordinator.ring = ring
            let image = Self.image(track, ring: ring)
            slider.setMinimumTrackImage(image, for: .normal)
            slider.setMaximumTrackImage(image, for: .normal)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(onChange: onChange) }

    final class Coordinator: NSObject {
        var onChange: (Double) -> Void
        var track: Track?
        var ring: UInt32?
        init(onChange: @escaping (Double) -> Void) { self.onChange = onChange }
        @objc func changed(_ slider: UISlider) { onChange(Double(slider.value)) }
    }

    /// A slider VoiceOver moves by `step` a swipe.
    final class Slider: UISlider {
        var step = 0.1
        override func accessibilityIncrement() {
            value = min(1, value + Float(step))
            sendActions(for: .valueChanged)
        }
        override func accessibilityDecrement() {
            value = max(0, value - Float(step))
            sendActions(for: .valueChanged)
        }
    }

    /// The track: 10pt tall, fully rounded, with a 1px inset ring. A wide
    /// image, stretched only in its middle, so its ends keep their round.
    static func image(_ track: Track, ring: UInt32) -> UIImage {
        let size = CGSize(width: 300, height: 10)
        let image = UIGraphicsImageRenderer(size: size).image { context in
            let cg = context.cgContext
            func gradient(_ stops: [UInt32], in rect: CGRect) {
                guard !stops.isEmpty else { return }
                let colors = stops.map { UIColor(Color(hex: $0)).cgColor } as CFArray
                let locations = stops.indices.map { CGFloat($0) / CGFloat(max(stops.count - 1, 1)) }
                guard let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors,
                                         locations: locations) else { return }
                cg.saveGState()
                cg.addPath(UIBezierPath(roundedRect: rect, cornerRadius: rect.height / 2).cgPath)
                cg.clip()
                cg.drawLinearGradient(g, start: CGPoint(x: rect.minX, y: 0), end: CGPoint(x: rect.maxX, y: 0), options: [])
                cg.restoreGState()
                UIColor(Color(hex: ring, opacity: 0.4)).setStroke()
                let edge = UIBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), cornerRadius: rect.height / 2)
                edge.lineWidth = 1
                edge.stroke()
            }
            let whole = CGRect(origin: .zero, size: size)
            switch track {
            case .gradient(let stops):
                gradient(stops, in: whole)
            case .bands(let deep, let pale):
                let gap: CGFloat = 3
                let total = CGFloat(max(deep.count + pale.count, 1))
                let deepWidth = deep.isEmpty ? 0 : (size.width - (pale.isEmpty ? 0 : gap)) * CGFloat(deep.count) / total
                gradient(deep, in: CGRect(x: 0, y: 0, width: deepWidth, height: size.height))
                let paleX = deep.isEmpty ? 0 : deepWidth + gap
                gradient(pale, in: CGRect(x: paleX, y: 0, width: size.width - paleX, height: size.height))
            }
        }
        return image.resizableImage(withCapInsets: UIEdgeInsets(top: 0, left: 5, bottom: 0, right: 5), resizingMode: .stretch)
    }
}
