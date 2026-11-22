// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import UIKit
import XCTest
@testable import Sval

/// A site's icon fetched, decoded and written off the main actor, from a
/// server of the test's own.
@MainActor
final class SiteIconsTests: XCTestCase {
    /// Answers `icon.png` with a 512px square PNG and every other address
    /// with a 404.
    private final class Server: URLProtocol {
        static let icon = UIGraphicsImageRenderer(size: CGSize(width: 512, height: 512),
                                                  format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }())
            .pngData { context in
                UIColor.orange.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 512, height: 512))
            }

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            guard let url = request.url else { return }
            let found = url.lastPathComponent == "icon.png"
            let response = HTTPURLResponse(url: url, statusCode: found ? 200 : 404, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": found ? "image/png" : "text/html"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: found ? Self.icon : Data("missing".utf8))
            client?.urlProtocolDidFinishLoading(self)
        }

        override func stopLoading() {}
    }

    private var file: URL!

    override func setUp() {
        file = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).png")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: file)
    }

    private var session: URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Server.self]
        return URLSession(configuration: configuration)
    }

    /// The first candidate answers 404, so the second gives the icon. The
    /// icon comes back no larger than `maxPixels` and is written as PNG. `download` refuses to run on
    /// the main queue, so a call from this main-actor test proves the
    /// work left it.
    func testDownloadDecodesAndWritesTheFirstIconThatLoads() async throws {
        let page = URL(string: "http://icons.test/")!
        let candidates = [URL(string: "http://icons.test/missing.png")!, URL(string: "http://icons.test/icon.png")!]
        let image = await SiteIcons.download(candidates, check: IconCheck(page: page, blocker: nil),
                                             session: session, to: file)
        let icon = try XCTUnwrap(image)
        XCTAssertEqual(icon.size.width * icon.scale, CGFloat(SiteIcons.maxPixels))
        let written = try XCTUnwrap(UIImage(data: Data(contentsOf: file)))
        XCTAssertEqual(written.size.width * written.scale, CGFloat(SiteIcons.maxPixels))
    }

    func testDownloadWritesNothingWhenNoCandidateLoads() async {
        let page = URL(string: "http://icons.test/")!
        let image = await SiteIcons.download([URL(string: "http://icons.test/missing.png")!],
                                             check: IconCheck(page: page, blocker: nil), session: session, to: file)
        XCTAssertNil(image)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path()))
    }
}
