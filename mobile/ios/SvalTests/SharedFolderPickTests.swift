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

    /// A device that once misread the pick left `sval/ws` inside Sval's own
    /// directory. The pick is read by its name alone, so the phone still
    /// syncs where the other devices do, and the stray folder is left alone.
    func testAStraySvalFolderInsideTheInnerOneLeavesItTheSvalFolder() throws {
        let stray = top.appending(path: "Sval/sval/sval/ws/abc", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: stray, withIntermediateDirectories: true)
        try Data("old".utf8).write(to: stray.appending(path: "phone.json"))
        let inner = Folder(shared: top.appending(path: "Sval/sval", directoryHint: .isDirectory))
        try inner.write("\(topDir)/ws/abc/phone.json", Data("new".utf8))
        XCTAssertEqual(
            try Data(contentsOf: top.appending(path: "Sval/sval/ws/abc/phone.json")), Data("new".utf8),
            "the write lands where the desktop reads")
        XCTAssertEqual(
            try Data(contentsOf: stray.appending(path: "phone.json")), Data("old".utf8),
            "and the stray folder is untouched")
        let outer = Folder(shared: top.appending(path: "Sval", directoryHint: .isDirectory))
        XCTAssertEqual(try outer.list("\(topDir)/ws/abc"), ["\(topDir)/ws/abc/phone.json"])
    }

    /// An empty folder named `sval`, picked before anything synced into it,
    /// is Sval's own directory: its first files go straight into it.
    func testAnEmptyFolderNamedSvalReceivesSvalsFiles() throws {
        let fresh = top.appending(path: "New/sval", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: fresh, withIntermediateDirectories: true)
        let folder = Folder(shared: fresh)
        XCTAssertTrue(folder.exists(topDir), "the pick holds Sval's directory")
        try folder.write("\(topDir)/ws/abc/phone.json", Data("x".utf8))
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: fresh.appending(path: "ws/abc/phone.json").path(percentEncoded: false)))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: fresh.appending(path: "sval").path(percentEncoded: false)))
    }

    /// Either pick names the same shared folder, the one Settings shows and
    /// the desktop stores.
    func testBothPicksNameTheFolderThatHoldsSval() throws {
        let outer = top.appending(path: "Sval", directoryHint: .isDirectory)
        for picked in [
            outer,
            top.appending(path: "Sval/sval", directoryHint: .isDirectory),
            top.appending(path: "Sval/sval", directoryHint: .notDirectory),
            URL(fileURLWithPath: top.appending(path: "Sval/sval").path(percentEncoded: false) + "/"),
        ] {
            XCTAssertEqual(
                Folder(shared: picked).root.standardizedFileURL.pathComponents,
                outer.standardizedFileURL.pathComponents,
                picked.absoluteString)
        }
    }

    /// The user's own folders keep their names, whatever their case: Sval's
    /// directory is made inside them.
    func testAFolderNamedOtherwiseIsTheSharedFolder() throws {
        // Each in a parent of its own: `Sval` and `SVAL` are one folder on a
        // case-insensitive disk.
        for (index, name) in ["Sval", "SVAL", "sval backup", "Browsers"].enumerated() {
            let users = top.appending(path: "Other\(index)/\(name)", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: users, withIntermediateDirectories: true)
            let folder = Folder(shared: users)
            try folder.write("\(topDir)/ws/abc/phone.json", Data("x".utf8))
            XCTAssertTrue(FileManager.default.fileExists(
                atPath: users.appending(path: "sval/ws/abc/phone.json").path(percentEncoded: false)), name)
        }
    }

    /// The SMB and Dropbox paths the phone keeps, read by the same rule.
    func testARemotePathToSvalsDirectoryNamesTheFolderThatHoldsIt() {
        XCTAssertEqual(sharedRootOf(path: "/Sval/sval"), "/Sval")
        XCTAssertEqual(sharedRootOf(path: "Backups/sval/"), "Backups")
        XCTAssertEqual(sharedRootOf(path: "/Sval"), "/Sval")
        XCTAssertEqual(sharedRootOf(path: ""), "")
    }
}
