// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import XCTest
@testable import Sval

/// The folder picked as the shared folder: the user's own, or Sval's
/// directory inside it, which serves as that directory.
final class SharedFolderPickTests: XCTestCase {
    private var top: URL!

    override func setUpWithError() throws {
        top = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: top.appending(path: "Sval/sval/pair"), withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: top)
    }

    func testTheInnerSvalFolderReadsWhatTheUsersFolderHolds() throws {
        try Data("offer".utf8).write(to: top.appending(path: "Sval/sval/pair/a.json"))
        let inner = Folder(shared: top.appending(path: "Sval/sval", directoryHint: .isDirectory))
        XCTAssertEqual(try inner.list(Join.pairDir), ["\(Join.pairDir)/a.json"])
        XCTAssertEqual(try inner.read("\(Join.pairDir)/a.json"), Data("offer".utf8))
    }

    func testTheInnerSvalFolderWritesWhereTheUsersFolderReads() throws {
        let inner = Folder(shared: top.appending(path: "Sval/sval", directoryHint: .isDirectory))
        try inner.write("\(Join.pairDir)/b.json", Data("offer".utf8))
        let users = Folder(shared: top.appending(path: "Sval", directoryHint: .isDirectory))
        XCTAssertEqual(try users.read("\(Join.pairDir)/b.json"), Data("offer".utf8))
    }

    func testAnEmptySvalFolderInsideTheInnerOneLeavesItTheSvalFolder() throws {
        try FileManager.default.createDirectory(at: top.appending(path: "Sval/sval/sval"), withIntermediateDirectories: true)
        XCTAssertTrue(Folder.isSvalDir(top.appending(path: "Sval/sval", directoryHint: .isDirectory)))
    }

    func testAUsersFolderNamedSvalIsTheSharedFolder() throws {
        let users = top.appending(path: "Other/sval", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: users.appending(path: "sval/ws"), withIntermediateDirectories: true)
        XCTAssertFalse(Folder.isSvalDir(users))
    }
}
