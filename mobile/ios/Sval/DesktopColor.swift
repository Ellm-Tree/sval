// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import JavaScriptCore
import Observation

/// Every Workspace and group colour as the desktop draws it (decision
/// 0057), preset or custom. The desktop's `SvalColor.sys.mjs` is the one
/// place a colour becomes what is on screen, its inks solved to APCA and
/// WCAG targets. It is pure maths, so the app bundles it and runs it in
/// JavaScriptCore, and every colour reads the same on the phone as on the
/// desktop. A lock keeps the one context to one caller at a time, since a
/// view on any thread may draw a colour.
enum DesktopColor {
    /// A Workspace window's colours in one appearance (`windowLook`), each
    /// role solved on the window's colour.
    struct Window {
        let tint: UInt32
        /// Text that meets the body target at full strength.
        let strong: UInt32
        let body: UInt32
        let muted: UInt32
        let line: UInt32
        /// A field or a card on the window, and its text.
        let field: UInt32
        let fieldInk: UInt32
        let fieldMuted: UInt32
        /// A secondary button, and its text.
        let secondary: UInt32
        let secondaryInk: UInt32
        /// A focus ring, 3:1 on the window.
        let focus: UInt32
        /// Whether its text is dark: the window reads light.
        let darkInk: Bool
        /// The oklch lightness group blocks step from, and their direction.
        let lightness: Double
        let blockDir: Double
    }

    /// A group colour's members for its block, and its ink on a light and
    /// a dark surface (`groupMembers`).
    struct Group {
        let h: Double, bh: Double, bc: Double, bd: Double, bdd: Double, bdir: Double
        let base: UInt32
        let invert: UInt32
    }

    private static let lock = NSLock()

    /// Makes the JavaScript context away from the main thread, which reads
    /// and runs the desktop's colour module, so the first view to draw a
    /// colour doesn't wait for it.
    static func warm() {
        Task.detached(priority: .userInitiated) {
            lock.lock()
            defer { lock.unlock() }
            _ = context
        }
    }

    /// Whether the phone asks for more contrast, which the desktop's maths
    /// takes as `more` (`prefers-contrast: more`, Increase Contrast here).
    /// Each colour reads it, so a view that draws one redraws when it
    /// changes.
    static let contrast = Contrast()

    @Observable final class Contrast: @unchecked Sendable {
        var more = false
    }

    nonisolated(unsafe) private static let context: JSContext? = {
        guard let url = Bundle.main.url(forResource: "SvalColor.sys", withExtension: "mjs"),
              let module = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext()
        else { return nil }
        // A module's exports, read as a script's globals: JavaScriptCore
        // evaluates scripts, and the file imports nothing.
        let script = module.replacingOccurrences(of: "\nexport ", with: "\n")
        context.exceptionHandler = { _, error in
            Diagnostics.log("colour: the desktop's colours threw \(error?.toString() ?? "nothing")")
        }
        context.evaluateScript(script)
        context.evaluateScript(phone)
        return context
    }()

    /// What the phone's colour sheet asks of the desktop's maths, written
    /// with its own functions (round 8, 16b and 16e): the sheet's roles
    /// solved on a colour, and the colours along each slider's track.
    private static let phone = """
    function phoneSheet(color, kind, scheme, on, more) {
      const R = requirements(more);
      let tint = null;
      if (color && kind === "group") {
        tint = quantize(groupBlock(color, on, 1, { more }));
      } else if (color) {
        tint = quantize(windowTint(color, scheme, more));
      }
      const roles = rolesOf(tint ?? UNTINTED[scheme], more);
      const FS = roles.surfaces.field;
      const [, C, h] = roles.lch;
      const fieldSide = sideFor(FS, R.body);
      return {
        sheet: roles.tint, title: roles.strong, footer: roles.muted,
        cell: roles.field, cellText: roles.fieldInk, cellSecondary: roles.fieldMuted,
        ring: solveInk(h, Math.min(C, 0.06), FS, R.line, fieldSide),
        cancel: roles.secondary, cancelInk: roles.secondaryInk,
        danger: solveInk(25, 0.17, FS, R.body, fieldSide),
        side: roles.side,
      };
    }
    function phoneTrack(which, h, c, l, kind, on, more) {
      const at = (H, C) => kind === "group"
        ? groupBlock({ h: H, c: C }, on, 1, { more })
        : oklch(clampL(l, H, C, more), C, H);
      if (which === "hue") {
        return Array.from({ length: 37 }, (_, i) => at(i * 10, c));
      }
      if (which === "chroma") {
        return Array.from({ length: 21 }, (_, i) => at(h, i * CHROMA_MAX / 20));
      }
      const b = bands(h, c, more);
      return { deep: b.deep.map(L => oklch(L, c, h)), pale: b.pale.map(L => oklch(L, c, h)) };
    }
    function phoneShades(h, c, more) {
      const b = bands(h, c, more);
      return { deep: b.deep, pale: b.pale };
    }
    function phoneShadeOf(h, c, l, more) {
      const b = bands(h, c, more);
      let band = isDarkSurface(oklch(l, c, h), more) ? "deep" : "pale";
      if (!b[band].length) {
        band = band === "deep" ? "pale" : "deep";
      }
      const Ls = b[band];
      const i = nearestIndex(Ls, l);
      return { band, frac: Ls.length > 1 ? 1 - i / (Ls.length - 1) : 0 };
    }
    function phoneLightnessOf(h, c, band, frac, more) {
      const b = bands(h, c, more);
      const Ls = b[band].length ? b[band] : b[band === "pale" ? "deep" : "pale"];
      return Ls[Math.round((1 - frac) * (Ls.length - 1))];
    }
    """

    nonisolated(unsafe) private static var windows: [String: Window] = [:]
    /// The values the maths gave nothing for, so a view drawing one each
    /// frame doesn't ask again: marked before asking, cleared on an answer.
    nonisolated(unsafe) private static var refused: Set<String> = []
    nonisolated(unsafe) private static var groups: [String: Group] = [:]

    /// The window of the Workspace colour `stored`, a preset's token or a
    /// custom colour's JSON as the tree stores it, in the dark or light
    /// appearance; nil for a value this build can't draw.
    static func window(_ stored: String, dark: Bool) -> Window? {
        lock.lock()
        defer { lock.unlock() }
        let more = contrast.more
        let key = "\(stored)|\(dark)|\(more)"
        if let window = windows[key] { return window }
        guard !refused.contains("window|" + key) else { return nil }
        refused.insert("window|" + key)
        guard let context, let color = filtered(stored, kind: "workspace", in: context),
              let look = context.objectForKeyedSubscript("windowLook")?.call(withArguments: [
                  ["color": color, "transparency": 0], ["scheme": dark ? "dark" : "light", "more": more],
              ]), look.isObject,
              let tint = hex(look.forProperty("tint")), let strong = hex(look.forProperty("strong")),
              let body = hex(look.forProperty("body")), let muted = hex(look.forProperty("muted")),
              let line = hex(look.forProperty("line")), let field = hex(look.forProperty("field")),
              let fieldInk = hex(look.forProperty("fieldInk")), let fieldMuted = hex(look.forProperty("fieldMuted")),
              let secondary = hex(look.forProperty("secondary")),
              let secondaryInk = hex(look.forProperty("secondaryInk")), let focus = hex(look.forProperty("focus")),
              let block = look.forProperty("block"), block.isObject
        else { return nil }
        let window = Window(
            tint: tint, strong: strong, body: body, muted: muted, line: line, field: field, fieldInk: fieldInk,
            fieldMuted: fieldMuted, secondary: secondary, secondaryInk: secondaryInk, focus: focus,
            darkInk: look.forProperty("side")?.toString() == "dark",
            lightness: block.forProperty("l")?.toDouble() ?? 0.5,
            blockDir: block.forProperty("dir")?.toDouble() ?? 1)
        windows[key] = window
        refused.remove("window|" + key)
        return window
    }

    /// A group colour `stored`, a preset's token or a custom colour's JSON,
    /// as its block's members and inks; nil for a value this build can't
    /// draw.
    static func group(_ json: String) -> Group? {
        lock.lock()
        defer { lock.unlock() }
        if let group = groups[json] { return group }
        guard !refused.contains("group|" + json) else { return nil }
        refused.insert("group|" + json)
        guard let context,
              let color = filtered(json, kind: "group", in: context) ?? filtered(json, kind: "workspace", in: context),
              let m = context.objectForKeyedSubscript("groupMembers")?.call(withArguments: [color]), m.isObject,
              let base = rgb(m.forProperty("base")?.toString()), let invert = rgb(m.forProperty("invert")?.toString())
        else { return nil }
        func number(_ key: String) -> Double { m.forProperty(key)?.toDouble() ?? 0 }
        let group = Group(h: number("h"), bh: number("bh"), bc: number("bc"), bd: number("bd"),
                          bdd: number("bdd"), bdir: number("bdir"), base: base, invert: invert)
        groups[json] = group
        refused.remove("group|" + json)
        return group
    }

    nonisolated(unsafe) private static var blocks: [String: UInt32] = [:]

    /// A group's block on a surface (`groupBlock`): of oklch lightness
    /// `surface`, reading dark or light, stepping blocks `dir`.
    static func groupBlock(_ stored: String, surface: Double, surfaceDark: Bool, dir: Double, step: Double,
                           selected: Bool) -> UInt32? {
        lock.lock()
        defer { lock.unlock() }
        let more = contrast.more
        let key = "\(stored)|\(surface)|\(surfaceDark)|\(dir)|\(step)|\(selected)|\(more)"
        if let block = blocks[key] { return block }
        guard !refused.contains("block|" + key) else { return nil }
        refused.insert("block|" + key)
        guard let context,
              let color = filtered(stored, kind: "group", in: context),
              let value = context.objectForKeyedSubscript("groupBlock")?.call(withArguments: [
                  color, ["l": surface, "surfaceDark": surfaceDark, "dir": dir], step,
                  ["more": more, "selected": selected],
              ]), let block = hex(value)
        else { return nil }
        blocks[key] = block
        refused.remove("block|" + key)
        return block
    }

    nonisolated(unsafe) private static var inks: [String: (text: UInt32, muted: UInt32)] = [:]

    /// The text and muted text on a group's block, solved on the block's
    /// steps over `on` (`groupInk`).
    static func groupInk(_ stored: String, on: Surface) -> (text: UInt32, muted: UInt32)? {
        lock.lock()
        defer { lock.unlock() }
        let more = contrast.more
        let key = "\(stored)|\(on.l)|\(on.surfaceDark)|\(on.dir)|\(more)"
        if let ink = inks[key] { return ink }
        guard let context,
              let color = filtered(stored, kind: "group", in: context),
              let value = context.objectForKeyedSubscript("groupInk")?.call(withArguments: [color, on.js, more]),
              let text = rgb(value.forProperty("text")?.toString()), let muted = rgb(value.forProperty("muted")?.toString())
        else { return nil }
        inks[key] = (text, muted)
        return (text, muted)
    }

    /// A call of the picker's functions below. The maths is pure, so with
    /// `more` an answer kept is the answer the maths gives again.
    private enum Call: Hashable {
        case sheet(String?, Surface?, dark: Bool)
        case track(String, h: Double, c: Double, l: Double, Surface?)
        case shadeTrack(h: Double, c: Double)
        case shades(h: Double, c: Double)
        case shade(h: Double, c: Double, l: Double)
        case lightness(h: Double, c: Double, Shade)
        case presetVersion(String, side: String, dark: Bool)
        case customFrom(String?, dark: Bool)
        case swatch(String, workspace: Bool, dark: Bool)
    }

    private struct Asked: Hashable {
        let call: Call
        let more: Bool
    }

    /// The picker's answers. A slider's drag asks for a new colour on each
    /// move, so the table is emptied whole once it holds `kept`.
    nonisolated(unsafe) private static var answers: [Asked: Any] = [:]
    private static let kept = 2048
    /// Set by `uncached`, so each call asks the maths.
    nonisolated(unsafe) private static var bypass = false

    /// The answer kept for `call`, or `solve`'s, kept. Called with `lock`
    /// held.
    private static func answer<T>(_ call: Call, _ solve: (_ more: Bool) -> T) -> T {
        let asked = Asked(call: call, more: contrast.more)
        if !bypass, let found = answers[asked] { return found as! T }
        let answer = solve(asked.more)
        if bypass { return answer }
        if answers.count >= kept { answers.removeAll(keepingCapacity: true) }
        answers[asked] = answer
        return answer
    }

    /// `body`'s calls, each answered by the maths and none kept, for tests
    /// that compare kept answers with the maths'.
    static func uncached<T>(_ body: () -> T) -> T {
        lock.lock()
        bypass = true
        lock.unlock()
        defer {
            lock.lock()
            bypass = false
            lock.unlock()
        }
        return body()
    }

    /// The colours a sheet in a colour is drawn in (round 8, 16e), each
    /// solved on the colour, as gamma sRGB hex.
    struct Sheet: Equatable {
        let sheet: UInt32, title: UInt32, footer: UInt32
        let cell: UInt32, cellText: UInt32, cellSecondary: UInt32, ring: UInt32
        let cancel: UInt32, cancelInk: UInt32, danger: UInt32
        /// Whether its text is dark: the sheet reads light.
        let darkInk: Bool
    }

    /// A window or group's block, as the surface group blocks step from.
    struct Surface: Hashable {
        let l: Double, surfaceDark: Bool, dir: Double
        var js: [String: Any] { ["l": l, "surfaceDark": surfaceDark, "dir": dir] }
    }

    /// The surface a Workspace colour's window gives its group blocks, or
    /// Sval's own window's with none (`windowLook`, `untintedSurface`).
    static func surface(ofWorkspace stored: String?, dark: Bool) -> Surface {
        if let stored, let window = window(stored, dark: dark) {
            return Surface(l: window.lightness, surfaceDark: !window.darkInk, dir: window.blockDir)
        }
        return dark ? Surface(l: 0.215, surfaceDark: true, dir: 1) : Surface(l: 0.962, surfaceDark: false, dir: 1)
    }

    /// The sheet's colours for `stored`, a Workspace's or, with `on`, a
    /// group's colour; none gives Sval's own.
    static func sheet(_ stored: String?, group on: Surface?, dark: Bool) -> Sheet? {
        lock.lock()
        defer { lock.unlock() }
        return answer(.sheet(stored, on, dark: dark)) { more in
            guard let context else { return nil }
            let kind = on == nil ? "workspace" : "group"
            let color: Any = stored.flatMap { filtered($0, kind: kind, in: context) } ?? NSNull()
            guard let value = context.objectForKeyedSubscript("phoneSheet")?.call(withArguments: [
                color, kind, dark ? "dark" : "light", on?.js ?? NSNull(), more,
            ]), value.isObject else { return nil }
            func role(_ name: String) -> UInt32 { hex(value.forProperty(name)) ?? 0 }
            return Sheet(sheet: role("sheet"), title: role("title"), footer: role("footer"), cell: role("cell"),
                         cellText: role("cellText"), cellSecondary: role("cellSecondary"), ring: role("ring"),
                         cancel: role("cancel"), cancelInk: role("cancelInk"), danger: role("danger"),
                         darkInk: value.forProperty("side")?.toString() == "dark")
        }
    }

    /// The colours along a slider's track at the other two's values: hue
    /// round the circle, or chroma from none to `chromaMax`.
    ///
    /// The value a track runs along is left out of its call, since
    /// `phoneTrack` never reads it, so moving a slider keeps its own track.
    static func track(_ which: String, h: Double, c: Double, l: Double, group on: Surface?) -> [UInt32] {
        lock.lock()
        defer { lock.unlock() }
        let call = Call.track(which, h: which == "hue" ? 0 : h, c: which == "chroma" ? 0 : c, l: l, on)
        return answer(call) { more in
            guard let value = context?.objectForKeyedSubscript("phoneTrack")?.call(withArguments: [
                which, h, c, l, on == nil ? "workspace" : "group", on?.js ?? NSNull(), more,
            ]), value.isArray, let stops = value.toArray() as? [[NSNumber]] else { return [] }
            return stops.map { rgbHex($0.map(\.doubleValue)) }
        }
    }

    /// Shade's track: the deep band and the pale band, dark to light.
    static func shadeTrack(h: Double, c: Double) -> (deep: [UInt32], pale: [UInt32]) {
        lock.lock()
        defer { lock.unlock() }
        return answer(.shadeTrack(h: h, c: c)) { more in
            guard let value = context?.objectForKeyedSubscript("phoneTrack")?.call(withArguments: [
                "shade", h, c, 0, "workspace", NSNull(), more,
            ]), let object = value.toDictionary(),
                  let deep = object["deep"] as? [[NSNumber]], let pale = object["pale"] as? [[NSNumber]]
            else { return ([], []) }
            return (deep.map { rgbHex($0.map(\.doubleValue)) }, pale.map { rgbHex($0.map(\.doubleValue)) })
        }
    }

    /// The lightnesses text reads on at hue `h` and chroma `c`, split into
    /// the deep band, which takes light text, and the pale band (`bands`).
    static func shades(h: Double, c: Double) -> (deep: [Double], pale: [Double]) {
        lock.lock()
        defer { lock.unlock() }
        return answer(.shades(h: h, c: c)) { more in
            guard let object = context?.objectForKeyedSubscript("phoneShades")?.call(withArguments: [h, c, more]).toDictionary(),
                  let deep = object["deep"] as? [NSNumber], let pale = object["pale"] as? [NSNumber]
            else { return ([], []) }
            return (deep.map(\.doubleValue), pale.map(\.doubleValue))
        }
    }

    /// A Workspace custom colour's shade: its band, and its place there,
    /// 0 the band's lightest and 1 its darkest. Hue and Intensity keep it,
    /// so the text's side and the place hold wherever the colour allows
    /// (the desktop picker's `_shadeOf` and `lightnessOf`).
    struct Shade: Hashable {
        let band: String
        let frac: Double
    }

    /// The shade lightness `l` is at, for hue `h` and chroma `c`.
    static func shade(h: Double, c: Double, l: Double) -> Shade? {
        lock.lock()
        defer { lock.unlock() }
        return answer(.shade(h: h, c: c, l: l)) { more in
            guard let object = context?.objectForKeyedSubscript("phoneShadeOf")?.call(withArguments: [h, c, l, more]).toDictionary(),
                  let band = object["band"] as? String, let frac = (object["frac"] as? NSNumber)?.doubleValue
            else { return nil }
            return Shade(band: band, frac: frac)
        }
    }

    /// The lightness `shade` gives hue `h` and chroma `c`, or nil where
    /// text reads on none.
    static func lightness(h: Double, c: Double, at shade: Shade) -> Double? {
        lock.lock()
        defer { lock.unlock() }
        return answer(.lightness(h: h, c: c, shade)) { more in
            guard let value = context?.objectForKeyedSubscript("phoneLightnessOf")?
                      .call(withArguments: [h, c, shade.band, shade.frac, more]),
                  value.isNumber
            else { return nil }
            return value.toDouble()
        }
    }

    private static func rgbHex(_ channels: [Double]) -> UInt32 {
        channels.prefix(3).reduce(0) { ($0 << 8) | UInt32((min(1, max(0, $1)) * 255).rounded()) }
    }

    /// A custom colour, as the picker edits it: a Workspace's `l` and
    /// `mode` are nil for a group's.
    struct Custom: Equatable {
        var h: Double
        var c: Double
        var l: Double?
        var mode: String?

        /// The colour as the tree stores it (decision 0057), rounded as the
        /// desktop's picker rounds it. A hue that rounds up to 360 is 0: the
        /// engine refuses 360.
        var json: String {
            let hue = ((h * 10).rounded() / 10).truncatingRemainder(dividingBy: 360)
            var value: [String: Any] = ["h": hue, "c": (c * 1000).rounded() / 1000]
            if let l, let mode {
                value["l"] = (l * 1000).rounded() / 1000
                value["mode"] = mode
            }
            let data = (try? JSONSerialization.data(withJSONObject: value, options: .sortedKeys)) ?? Data()
            return String(decoding: data, as: UTF8.self)
        }

        init(h: Double, c: Double, l: Double? = nil, mode: String? = nil) {
            self.h = h; self.c = c; self.l = l; self.mode = mode
        }

        /// A stored custom colour, or nil for a preset or none.
        init?(_ stored: String?) {
            guard let stored, stored.hasPrefix("{"),
                  let value = try? JSONSerialization.jsonObject(with: Data(stored.utf8)) as? [String: Any],
                  let h = (value["h"] as? NSNumber)?.doubleValue, let c = (value["c"] as? NSNumber)?.doubleValue
            else { return nil }
            self.init(h: h, c: c, l: (value["l"] as? NSNumber)?.doubleValue, mode: value["mode"] as? String)
        }
    }

    /// The most chroma the picker offers (`CHROMA_MAX`).
    static let chromaMax = 0.25

    /// A Workspace preset's version for the dark or light row: the preset
    /// itself in the row that suits the appearance, or a custom colour
    /// (`presetVersion`). `name` may be "white". Stored form.
    static func presetVersion(_ name: String, side: String, dark: Bool) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return answer(.presetVersion(name, side: side, dark: dark)) { more in
            guard let context,
                  let value = context.objectForKeyedSubscript("presetVersion")?
                      .call(withArguments: [name, side, dark ? "dark" : "light", more])
            else { return nil }
            if value.isString { return value.toString() }
            guard value.isObject, let object = value.toDictionary(),
                  let h = (object["h"] as? NSNumber)?.doubleValue, let c = (object["c"] as? NSNumber)?.doubleValue
            else { return nil }
            return Custom(h: h, c: c, l: (object["l"] as? NSNumber)?.doubleValue, mode: object["mode"] as? String).json
        }
    }

    /// A Workspace colour as a custom one to start editing from in this
    /// appearance (`customFrom`): a preset, or one picked in the other
    /// appearance, as it looks now; none as Sval's own window looks.
    static func customFrom(_ stored: String?, dark: Bool) -> Custom? {
        lock.lock()
        defer { lock.unlock() }
        return answer(.customFrom(stored, dark: dark)) { more in
            guard let context else { return nil }
            let color: Any = stored.flatMap { stored -> Any? in
                stored.hasPrefix("{") ? try? JSONSerialization.jsonObject(with: Data(stored.utf8)) : stored
            } ?? NSNull()
            guard let value = context.objectForKeyedSubscript("customFrom")?
                      .call(withArguments: [color, dark ? "dark" : "light", more]),
                  let object = value.toDictionary(),
                  let h = (object["h"] as? NSNumber)?.doubleValue, let c = (object["c"] as? NSNumber)?.doubleValue
            else { return nil }
            return Custom(h: h, c: c, l: (object["l"] as? NSNumber)?.doubleValue, mode: object["mode"] as? String)
        }
    }

    /// A colour of the kind given as the picker's swatch shows it: a
    /// Workspace's window, or a group's block on Sval's own window
    /// (`swatchOf`).
    static func swatch(_ stored: String, workspace: Bool, dark: Bool) -> UInt32? {
        lock.lock()
        defer { lock.unlock() }
        return answer(.swatch(stored, workspace: workspace, dark: dark)) { more in
            guard let context else { return nil }
            let color: Any = stored.hasPrefix("{")
                ? (try? JSONSerialization.jsonObject(with: Data(stored.utf8))) ?? stored : stored
            guard let value = context.objectForKeyedSubscript("swatchOf")?.call(withArguments: [
                color, workspace ? "workspace" : "group", ["scheme": dark ? "dark" : "light", "more": more],
            ]) else { return nil }
            return rgb(value.toString())
        }
    }

    /// The colour in `stored` as `colorOf` accepts it for `kind`, or nil for
    /// one it refuses.
    private static func filtered(_ stored: String, kind: String, in context: JSContext) -> JSValue? {
        let parsed: Any = stored.hasPrefix("{")
            ? (try? JSONSerialization.jsonObject(with: Data(stored.utf8))) ?? NSNull() : stored
        guard let value = context.objectForKeyedSubscript("colorOf")?.call(withArguments: [parsed, kind]),
              value.isObject || value.isString
        else { return nil }
        return value
    }

    /// A gamma sRGB triple, each channel 0...1, as a hex colour.
    private static func hex(_ value: JSValue?) -> UInt32? {
        guard let value, value.isArray, let channels = value.toArray() as? [Double], channels.count == 3 else { return nil }
        return channels.reduce(0) { ($0 << 8) | UInt32((min(1, max(0, $1)) * 255).rounded()) }
    }

    /// A colour as `css` writes it, `rgb(r g b)`, or as the presets' table
    /// does, `#rrggbb`, as a hex colour.
    private static func rgb(_ css: String?) -> UInt32? {
        if let css, css.hasPrefix("#"), css.count == 7 { return UInt32(css.dropFirst(), radix: 16) }
        guard let css, css.hasPrefix("rgb(") else { return nil }
        let channels = css.dropFirst(4).split(whereSeparator: { $0 == " " || $0 == ")" }).prefix(3).compactMap { UInt32($0) }
        guard channels.count == 3 else { return nil }
        return channels.reduce(0) { ($0 << 8) | min(255, $1) }
    }
}
