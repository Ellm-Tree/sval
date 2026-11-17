// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import XCTest
@testable import Sval

/// Which files in the pairing folder a join reads, as the desktop's
/// `SvalPairing` claim reads them: a folder anyone can write to must not
/// set how much work a look costs.
final class JoinOfferTests: XCTestCase {
    private let key = Data(repeating: 3, count: 32)

    private func joinError(_ code: String, in folder: SharedFolder) -> JoinError? {
        do {
            _ = try Join.claim(code: code, in: folder)
            return nil
        } catch {
            return error as? JoinError
        }
    }

    func testTheCodeAnOfferShowsGivesItsKey() throws {
        let folder = MemoryFolder()
        let offer = try Join.offer(key: key, in: folder)
        let claimed = try Join.claim(code: offer.code, in: folder)
        XCTAssertEqual(claimed.key, key)
        XCTAssertEqual(claimed.offer, offer.path)
    }

    func testAnotherCodeIsTheWrongCode() throws {
        let folder = MemoryFolder()
        let offer = try Join.offer(key: key, in: folder)
        var other = try generatePairingCode()
        while other == offer.code { other = try generatePairingCode() }
        XCTAssertEqual(joinError(other, in: folder), .wrongCode)
    }

    func testAnExpiredOfferSaysItExpired() throws {
        let folder = MemoryFolder()
        let code = try generatePairingCode()
        let now = Date.now.timeIntervalSince1970 * 1000
        try folder.write("\(Join.pairDir)/old.json",
                         try sealPairing(key: key, code: code, now: now - 2 * Join.offerTtlMs, ttlMs: Join.offerTtlMs))
        XCTAssertEqual(joinError(code, in: folder), .expired)
    }

    func testAFileOverFourKilobytesIsNeverRead() {
        let folder = MemoryFolder()
        folder.data["\(Join.pairDir)/large.json"] = Data(count: 4097)
        folder.data["\(Join.pairDir)/small.json"] = Data(count: 4096)
        XCTAssertEqual(joinError("ABCD-EFGH-JKMN", in: folder), .noOffer)
        XCTAssertEqual(folder.reads, ["\(Join.pairDir)/small.json"])
    }

    func testALookReadsTheEightNewestFilesNewestFirst() {
        let folder = MemoryFolder()
        for at in 1...10 {
            let path = "\(Join.pairDir)/\(at).json"
            folder.data[path] = Data("{}".utf8)
            folder.modified[path] = Int64(at)
        }
        XCTAssertEqual(joinError("ABCD-EFGH-JKMN", in: folder), .noOffer)
        XCTAssertEqual(folder.reads, (3...10).reversed().map { "\(Join.pairDir)/\($0).json" })
    }

    /// iCloud lists a file it hasn't downloaded under a placeholder's name.
    /// The look asks for the file and leaves it until it is on the phone.
    func testAnOfferICloudHasNotDownloadedIsLeftForALaterLook() throws {
        let folder = Folder(root: try temporaryDirectory(self))
        try folder.write("\(Join.pairDir)/.offer.json.icloud", Data("{}".utf8))
        XCTAssertEqual(try folder.list(Join.pairDir), ["\(Join.pairDir)/offer.json"])
        XCTAssertEqual(try folder.files(Join.pairDir), [])
        XCTAssertEqual(joinError("ABCD-EFGH-JKMN", in: folder), .noOffer)
    }
}
