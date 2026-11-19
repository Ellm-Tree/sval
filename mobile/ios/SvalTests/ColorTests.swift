// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import XCTest
@testable import Sval

/// Every colour a Workspace or group can hold, in every appearance, gives
/// each surface its colour: the window (the sheet), the group block and
/// the bar's glass layer, which must be the colour's own hue.
@MainActor
final class ColorTests: XCTestCase {
    /// The presets and a Workspace's custom colours picked in each
    /// appearance.
    private var colours: [String] {
        TintPreset.allCases.map(\.rawValue) + [
            #"{"c":0.12,"h":250,"l":0.42,"mode":"dark"}"#,
            #"{"c":0.12,"h":250,"l":0.82,"mode":"light"}"#,
            #"{"c":0.15,"h":30,"l":0.55,"mode":"dark"}"#,
        ]
    }

    /// A group's custom colour, which has no lightness of its own.
    private let groupCustom = #"{"c":0.1,"h":145}"#

    func testEveryColourHasAWindowInBothAppearances() {
        for colour in colours {
            for dark in [false, true] {
                XCTAssertNotNil(DesktopColor.window(colour, dark: dark), "\(colour) has no window, dark \(dark)")
            }
        }
    }

    func testEveryColourHasGroupMembers() {
        for colour in colours + [groupCustom] {
            XCTAssertNotNil(DesktopColor.group(colour), "\(colour) has no group members")
        }
    }

    /// The bar's glass takes the colour the Workspace's sheet takes, with
    /// the sheet's ink, in either appearance.
    func testBarIsTheSheetsColour() {
        for colour in colours + [nil] {
            for dark in [false, true] {
                let bar = BarColors(token: colour, dark: dark)
                let sheet = Theme(dark ? .dark : .light, tint: colour)
                XCTAssertEqual(UIColor(bar.layer), UIColor(sheet.sheet), "\(colour ?? "none"): the bar's colour")
                XCTAssertEqual(bar.darkInk, !sheet.dark, "\(colour ?? "none"): the bar's ink")
            }
        }
    }

    /// A hue that rounds up to 360 is stored as 0, which the engine takes:
    /// it refuses a hue of 360.
    func testHueRoundingUpToAFullTurnIsStoredAsZero() throws {
        let stored = DesktopColor.Custom(h: 359.97, c: 0.1).json
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(stored.utf8)) as? [String: Any])
        XCTAssertEqual((value["h"] as? NSNumber)?.doubleValue, 0)
    }

    /// A swatch from the other row, tapped, shows as that swatch in both
    /// appearances. Yellow's dark version in light takes dark text, so it
    /// is stored with the other appearance's mode.
    func testEveryOtherRowSwatchReadsBackAsItself() throws {
        for dark in [false, true] {
            for preset in TintPreset.allCases {
                for (name, side) in [(preset.rawValue, "dark"), (preset == .black ? "white" : preset.rawValue, "light")] {
                    let stored = try XCTUnwrap(DesktopColor.presetVersion(name, side: side, dark: dark))
                    guard stored.hasPrefix("{") else { continue }
                    let found = try XCTUnwrap(ColorSection.presetSwatch(of: stored, dark: dark),
                                              "\(name), \(side) in dark \(dark) shows as Custom")
                    XCTAssertEqual(DesktopColor.presetVersion(found.name, side: found.side, dark: dark), stored)
                }
            }
        }
    }

    /// A group's Custom starts from the preset chosen: its block's hue and
    /// chroma, for every preset, as the desktop's picker starts it.
    func testGroupCustomStartsFromThePreset() throws {
        for preset in TintPreset.allCases {
            let members = try XCTUnwrap(DesktopColor.group(preset.rawValue))
            let custom = ColorSection.groupCustom(from: preset.rawValue)
            XCTAssertEqual(custom.h, members.h, "\(preset)")
            XCTAssertEqual(custom.c, min(members.bc, DesktopColor.chromaMax), "\(preset)")
            XCTAssertNil(custom.l)
        }
        XCTAssertEqual(ColorSection.groupCustom(from: groupCustom), DesktopColor.Custom(h: 145, c: 0.1))
    }

    /// Hue keeps a Workspace colour's shade: its band, so the text keeps
    /// its side wherever the hue has that band, and its place in it.
    func testHueKeepsTheShadesBandAndPlace() throws {
        let deep = DesktopColor.shades(h: 250, c: 0.12).deep
        XCTAssertGreaterThan(deep.count, 2)
        let shade = try XCTUnwrap(DesktopColor.shade(h: 250, c: 0.12, l: deep[deep.count / 2]))
        XCTAssertEqual(shade.band, "deep")
        XCTAssertEqual(DesktopColor.lightness(h: 250, c: 0.12, at: shade), deep[deep.count / 2])
        for h in stride(from: 0.0, to: 360, by: 30) {
            let band = DesktopColor.shades(h: h, c: 0.12).deep
            guard band.count > 1 else { continue }
            let l = try XCTUnwrap(DesktopColor.lightness(h: h, c: 0.12, at: shade))
            XCTAssertEqual(l, band[Int(((1 - shade.frac) * Double(band.count - 1)).rounded())], "hue \(h)")
        }
    }

    /// Every group colour has text solved on its block, in both
    /// appearances.
    func testEveryGroupColourHasInkOnItsBlock() {
        for dark in [false, true] {
            let surface = DesktopColor.surface(ofWorkspace: nil, dark: dark)
            for colour in TintPreset.allCases.map(\.rawValue) + [groupCustom] {
                XCTAssertNotNil(DesktopColor.groupInk(colour, on: surface), "\(colour), dark \(dark)")
            }
        }
    }

    /// Custom on a Workspace with No color starts from Sval's own window
    /// as it looks in the appearance on show (`customFrom`).
    func testWorkspaceCustomFromNoColorIsSvalsOwnWindow() throws {
        for (dark, own) in [(true, UInt32(0x0A1140)), (false, UInt32(0xEEF2FC))] {
            let custom = try XCTUnwrap(DesktopColor.customFrom(nil, dark: dark))
            XCTAssertEqual(custom.mode, dark ? "dark" : "light")
            let window = try XCTUnwrap(DesktopColor.swatch(custom.json, workspace: true, dark: dark))
            for shift in [16, 8, 0] {
                let a = Int((window >> UInt32(shift)) & 0xFF), b = Int((own >> UInt32(shift)) & 0xFF)
                XCTAssertLessThanOrEqual(abs(a - b), 3, "dark \(dark): \(String(window, radix: 16))")
            }
        }
    }

    /// Increase Contrast solves every colour for more contrast, as the
    /// desktop does under `prefers-contrast: more`: each still draws, and
    /// the window's muted text moves for at least one of them.
    func testMoreContrastResolvesEveryColour() {
        defer { DesktopColor.contrast.more = false }
        var moved = false
        for colour in colours {
            DesktopColor.contrast.more = false
            let standard = DesktopColor.window(colour, dark: true)
            DesktopColor.contrast.more = true
            let more = DesktopColor.window(colour, dark: true)
            XCTAssertNotNil(more, "\(colour) has no window with more contrast")
            if standard?.muted != more?.muted { moved = true }
        }
        XCTAssertTrue(moved, "more contrast changed no colour")
    }
}
