// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import os
import UIKit

/// What the app did, in the system's log. A line carries counts and error
/// names only, never a name, address, code or key (CONTRIBUTING.md rule 10).
enum Diagnostics {
    private static let logger = Logger(subsystem: "app.sval.ios", category: "sync")

    static func log(_ line: String) {
        logger.notice("\(line, privacy: .public)")
        #if DEBUG
        file.append(line)
        #endif
    }

    /// A line only the private session or a private page causes, which
    /// tells when one ran. Logged at the debug level, which the system
    /// keeps in memory alone (Apple, "Generating log messages from your
    /// code"), and kept out of a Debug build's file.
    static func debug(_ line: String) {
        logger.debug("\(line, privacy: .public)")
    }

    #if DEBUG
    /// The lines `log` takes in a file in the app's caches, which a developer's Mac
    /// copies off the device (`mobile/ios/watch-log.sh`) without relaunching
    /// the app: reading a device's system log from a Mac takes root. The
    /// file stays readable while the device is locked, and starts again at
    /// each launch and past a megabyte.
    private static let file = LogFile()

    private final class LogFile: @unchecked Sendable {
        private let queue = DispatchQueue(label: "app.sval.ios.diagnostics")
        private let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appending(path: "diagnostics.log")
        private let stamp: DateFormatter = {
            let formatter = DateFormatter()
            formatter.dateFormat = "HH:mm:ss"
            return formatter
        }()
        /// Touched on `queue` alone.
        private var handle: FileHandle?
        private var size = 0

        /// Each launch starts the file afresh, so it holds this run alone.
        init() {
            queue.async { [self] in
                FileManager.default.createFile(
                    atPath: url.path(percentEncoded: false), contents: nil,
                    attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
                handle = try? FileHandle(forWritingTo: url)
            }
            // Lines are written off the main thread. Waiting for the queue
            // as the app leaves the front puts every line logged so far in
            // the file before iOS can suspend the app.
            for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
                NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [self] _ in
                    queue.sync {}
                }
            }
        }

        func append(_ line: String) {
            let now = Date.now
            queue.async { [self] in
                guard let handle else { return }
                let data = Data("\(stamp.string(from: now)) \(line)\n".utf8)
                if size > 1_000_000 {
                    try? handle.truncate(atOffset: 0)
                    size = 0
                }
                try? handle.write(contentsOf: data)
                size += data.count
            }
        }
    }
    #endif

    /// An error's type and case, without its message, which may hold a path.
    static func name(_ error: Error) -> String {
        if let error = error as? EngineError, case .Refused(let code, let reason, _) = error {
            return "EngineError.\(code)\(reason.map { "/\($0)" } ?? "")"
        }
        let nsError = error as NSError
        return "\(String(describing: type(of: error))) \(nsError.domain) \(nsError.code)"
    }
}
