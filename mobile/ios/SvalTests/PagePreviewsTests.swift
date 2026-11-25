// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Observation
import UIKit
import WebKit
import XCTest
@testable import Sval

/// Each card's picture and each site's icon: what one arriving redraws,
/// which reads a card that left drops, and the picture's shape.
@MainActor
final class PagePreviewsTests: XCTestCase {
    /// How many times an observed read was invalidated.
    private final class Count: @unchecked Sendable {
        var value = 0
    }

    private func folder() -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "previews-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func picture() -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
    }

    func testAPictureRedrawsOnlyItsCard() {
        let previews = PagePreviews(folder: folder())
        let redrawn = Count()
        withObservationTracking { _ = previews.picture(for: "a") } onChange: { redrawn.value += 1 }
        previews.keep(picture(), for: "b", isPrivate: true)
        XCTAssertEqual(redrawn.value, 0, "another card's picture leaves this card alone")
        previews.keep(picture(), for: "a", isPrivate: true)
        XCTAssertEqual(redrawn.value, 1, "the card's own picture redraws it")
    }

    func testAnIconRedrawsOnlyItsSite() {
        let icons = SiteIcons()
        let redrawn = Count()
        withObservationTracking { _ = icons.icon(for: "a.example") } onChange: { redrawn.value += 1 }
        icons.landed("b.example", picture())
        XCTAssertEqual(redrawn.value, 0, "another site's icon leaves this tile alone")
        icons.landed("a.example", picture())
        XCTAssertEqual(redrawn.value, 1, "the site's own icon redraws it")
    }

    /// Three cards ask for their pictures and two leave before the reader
    /// gets to them: only the one still showing is decoded.
    func testAReadForACardThatLeftIsDropped() async throws {
        let dir = folder()
        let reader = DispatchQueue(label: "app.sval.tests.previews")
        let previews = PagePreviews(folder: dir, reader: reader)
        let jpeg = try XCTUnwrap(picture().jpegData(compressionQuality: 0.7))
        for id in ["a", "b", "c"] { try jpeg.write(to: dir.appending(path: previews.fileName(id) + ".jpg")) }
        reader.suspend()
        for id in ["a", "b", "c"] { XCTAssertNil(previews.picture(for: id), "nothing is in memory yet") }
        previews.cancel(["b", "c"])
        reader.resume()
        let deadline = Date.now.addingTimeInterval(10)
        while previews.cached("a") == nil, Date.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertNotNil(previews.cached("a"), "the card still showing gets its picture")
        reader.sync {}
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNil(previews.cached("b"), "a card that left is not decoded")
        XCTAssertNil(previews.cached("c"), "a card that left is not decoded")
    }
}
