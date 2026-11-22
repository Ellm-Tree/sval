// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import WebKit

#if DEBUG
/// Checks, on the device, that a private session leaves nothing behind,
/// as the desktop's "Nothing on disk" tests do (private-windows spec): a
/// scripted session puts a random marker in a page's address, title,
/// cookie, local storage and IndexedDB, and in a group's name, then ends;
/// every file the app can reach is then searched for the marker. Run with
/// the launch option `-svalPrivacyCheck`; the result goes to the log, with
/// no marker and no page in it.
@MainActor
enum PrivacyCheck {
    static var requested: Bool { LaunchOption.given("-svalPrivacyCheck") }

    static func run(_ model: AppModel) async {
        let marker = "svalprivacy" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        Diagnostics.log("privacy check: started")
        guard let workspace = await model.openPrivateSession(),
              let url = URL(string: "https://privacy-check.sval.invalid/\(marker)?q=\(marker)"),
              let tab = await model.addTab(to: workspace, url: url, name: marker) else {
            Diagnostics.log("privacy check: FAIL, the session did not open")
            return
        }
        _ = await model.addGroup(named: marker, in: workspace)
        let browser: Browser = model.browser
        browser.select(tab)
        let html = """
        <title>\(marker)</title><p>\(marker)</p><script>
        document.cookie = "m=\(marker); max-age=86400";
        localStorage.setItem("m", "\(marker)");
        sessionStorage.setItem("m", "\(marker)");
        const open = indexedDB.open("m", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("s");
        open.onsuccess = () => open.result.transaction("s", "readwrite").objectStore("s").put("\(marker)", "k");
        </script>
        """
        browser.loadForCheck(tab, html: html, base: url)
        try? await Task.sleep(for: .seconds(6))
        await model.endPrivateSession()
        UserDefaults.standard.synchronize()
        try? await Task.sleep(for: .seconds(4))
        let found = await Task.detached { scan(for: Data(marker.utf8)) }.value
        if found.hits.isEmpty {
            Diagnostics.log("privacy check: PASS, \(found.files) files searched")
        } else {
            Diagnostics.log("privacy check: FAIL, the marker is in \(found.hits.count) file(s): \(found.hits.joined(separator: ", "))")
        }
        await control(html: html, base: url, marker: marker)
    }

    /// The same page in WebKit's saved store, outside any tab, must leave
    /// the marker on disk, or the search above proves nothing. What it
    /// saved is then removed.
    private static func control(html: String, base: URL, marker: String) async {
        let control = marker + "control"
        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        view.loadHTMLString(html.replacingOccurrences(of: marker, with: control), baseURL: base)
        try? await Task.sleep(for: .seconds(8))
        let found = await Task.detached { scan(for: Data(control.utf8)) }.value
        Diagnostics.log(found.hits.isEmpty
            ? "privacy check: control FAIL, a saved session's marker was not found, so the search can't see WebKit's files"
            : "privacy check: control PASS, a saved session's marker was found in \(found.hits.count) file(s)")
        let store = WKWebsiteDataStore.default()
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        let records = await store.dataRecords(ofTypes: types).filter { $0.displayName.contains("sval.invalid") }
        await store.removeData(ofTypes: types, for: records)
        _ = view
    }

    /// Every file under the app's container holding `marker`, by path
    /// inside the container.
    private nonisolated static func scan(for marker: Data) -> (files: Int, hits: [String]) {
        let root = URL(fileURLWithPath: NSHomeDirectory())
        var files = 0
        var hits: [String] = []
        let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey])
        while let file = walker?.nextObject() as? URL {
            guard (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true,
                  let data = try? Data(contentsOf: file, options: .mappedIfSafe) else { continue }
            files += 1
            if data.range(of: marker) != nil {
                hits.append(String(file.path.dropFirst(root.path.count)))
            }
        }
        return (files, hits)
    }
}
#endif
