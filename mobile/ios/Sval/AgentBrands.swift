// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import JavaScriptCore

/// Which known app an agent's label names, so its Workspace wears that
/// app's mark as it does on the desktop (agent-control spec §6). The
/// desktop's `SvalAgentBrands.sys.mjs` holds the rules and imports nothing,
/// so the app bundles it and runs it in JavaScriptCore, as `DesktopColor`
/// runs the colour maths. A lock keeps the one context to one caller at a
/// time, since a view on any thread may draw a mark.
enum AgentBrands {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var answers: [String: String?] = [:]

    nonisolated(unsafe) private static let context: JSContext? = {
        guard let url = Bundle.main.url(forResource: "SvalAgentBrands.sys", withExtension: "mjs"),
              let module = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext()
        else { return nil }
        // A module's exports, read as a script's globals: JavaScriptCore
        // evaluates scripts.
        let script = module.replacingOccurrences(of: "\nexport ", with: "\n")
        context.exceptionHandler = { _, error in
            Diagnostics.log("agent brands: the desktop's rules threw \(error?.toString() ?? "nothing")")
        }
        context.evaluateScript(script)
        return context
    }()

    /// The asset an agent's Workspace wears for `label`: its app's mark, or
    /// nil for an app the rules don't know, which wears the robot.
    static func image(for label: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        if let known = answers[label] { return known }
        let slug = context?.objectForKeyedSubscript("agentBrandOf")?.call(withArguments: [label])
        let answer = slug.flatMap { $0.isString ? "agent-brand-\($0.toString()!)" : nil }
        answers[label] = answer
        return answer
    }
}
