// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// The names downloaded files are saved under.
final class DownloadsTests: XCTestCase {
    func testASuggestedNameLosesAnyPath() {
        XCTAssertEqual(Downloads.safeName("report.pdf"), "report.pdf")
        XCTAssertEqual(Downloads.safeName("../../Library/report.pdf"), "report.pdf")
        XCTAssertEqual(Downloads.safeName("a:b.txt"), "a-b.txt")
    }

    func testANameThatNamesNothingIsDownload() {
        for name in ["", "  ", ".", "..", "/"] {
            XCTAssertEqual(Downloads.safeName(name), "Download", name)
        }
    }

    func testASecondDownloadOfAFileGetsTheNextNumber() {
        let folder = URL(fileURLWithPath: "/downloads")
        let taken: Set<String> = ["/downloads/report.pdf", "/downloads/report 2.pdf", "/downloads/notes"]
        let exists = { (url: URL) in taken.contains(url.path) }
        XCTAssertEqual(Downloads.unused(folder.appending(path: "new.pdf"), exists: exists).lastPathComponent, "new.pdf")
        XCTAssertEqual(Downloads.unused(folder.appending(path: "report.pdf"), exists: exists).lastPathComponent, "report 3.pdf")
        XCTAssertEqual(Downloads.unused(folder.appending(path: "notes"), exists: exists).lastPathComponent, "notes 2")
    }
}
