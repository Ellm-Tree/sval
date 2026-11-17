// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import XCTest
@testable import Sval

/// A shared folder held in memory, which notes every file read from it.
final class MemoryFolder: SharedFolder, @unchecked Sendable {
    var data: [String: Data] = [:]
    /// Each file's time, in milliseconds since the epoch.
    var modified: [String: Int64] = [:]
    private(set) var reads: [String] = []
    /// Set, every call throws it, as a folder out of reach does.
    var failure: Error?

    func list(_ directory: String) throws -> [String] {
        if let failure { throw failure }
        return data.keys.filter { ($0 as NSString).deletingLastPathComponent == directory }.sorted()
    }

    func files(_ directory: String) throws -> [FileEntry] {
        try list(directory).map { FileEntry(path: $0, size: UInt64(data[$0]!.count), modifiedMs: modified[$0] ?? 0) }
    }

    func exists(_ path: String) throws -> Bool {
        if let failure { throw failure }
        return data.keys.contains { $0 == path || $0.hasPrefix(path + "/") }
    }

    func read(_ path: String) throws -> Data {
        if let failure { throw failure }
        reads.append(path)
        guard let bytes = data[path] else { throw CocoaError(.fileReadNoSuchFile) }
        return bytes
    }

    func write(_ path: String, _ bytes: Data) throws {
        if let failure { throw failure }
        data[path] = bytes
    }

    func delete(_ path: String) throws {
        if let failure { throw failure }
        data[path] = nil
    }

    func move(_ from: String, to: String) throws {
        if let failure { throw failure }
        guard data[to] == nil, let bytes = data.removeValue(forKey: from) else { throw CocoaError(.fileWriteFileExists) }
        data[to] = bytes
    }
}

/// A directory of the test's own, removed when the test ends.
func temporaryDirectory(_ test: XCTestCase) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    test.addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    return url
}
