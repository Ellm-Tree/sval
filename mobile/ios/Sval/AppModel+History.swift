// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import AVFoundation
import Foundation
import Security
import Observation
import UIKit

extension AppModel {
    /// Reads history's pages again, after a pass or a visit made here.
    func refreshHistory() async {
        guard let syncer else { return }
        let refresh = Signposts.history.beginInterval("refreshHistory")
        let reading = Signposts.history.beginInterval("visits")
        let weeks = await syncer.weeks()
        Signposts.history.endInterval("visits", reading, "\(weeks.count) weeks")
        let ranking = Signposts.history.beginInterval("pages")
        let before = historyStore
        // Compared with what is shown, which a refresh that overlapped this
        // one may have set from other weeks.
        let shown = historyPages
        let (store, prepared) = await Task.detached(priority: .userInitiated) {
            var store = before
            store.update(weeks)
            return (store, store.pages != shown ? LauncherIndex.History(store.pages) : nil)
        }.value
        Signposts.history.endInterval("pages", ranking, "\(store.pages.count) pages")
        historyStore = store
        if let prepared, store.pages != historyPages {
            launcherHistory = prepared
            historyPages = store.pages
        }
        Signposts.history.endInterval("refreshHistory", refresh)
        Diagnostics.log("history: \(store.visitCount) visits, \(historyPages.count) pages")
    }

    /// Records a visit this phone made, in its week (history-sync spec
    /// §4.1), and returns its id, so a title that comes later can be set.
    func recordVisit(url: URL, title: String, transition: UInt32, workspace: String?) async -> String? {
        guard let syncer, Self.opensHere(url.absoluteString) else { return nil }
        do {
            let id = try await syncer.addVisit(
                url: url.absoluteString, title: title, transition: transition, at: .now, workspace: workspace)
            await refreshHistory()
            return id
        } catch {
            Diagnostics.log("history: a visit was not recorded: \(Diagnostics.name(error))")
            return nil
        }
    }

    /// Deletes a page from history, on every device.
    func deleteFromHistory(_ url: String) async {
        guard let syncer else { return }
        do {
            let count = try await syncer.deleteVisits(to: url)
            Diagnostics.log("history: deleted a page's \(count) visits")
            await refreshHistory()
            Task { await sync() }
        } catch {
            Diagnostics.log("history: a page was not deleted: \(Diagnostics.name(error))")
        }
    }

    /// Sets the title of visit `id` to `url`. A page's title set soon after
    /// the last one written waits for its hold, as `SvalHistorySync` holds
    /// them by address, and then writes its latest.
    func setVisitTitle(_ id: String, url: String, title: String, at: Date) async {
        guard visitTitleHold.admit(url, name: nil) else {
            heldVisitTitles[url] = (id, title, at)
            return
        }
        try? await syncer?.setVisitTitle(id, title: title, at: at)
    }

    /// How long the folder must be quiet before a change starts a pass, and
    /// the longest a pass waits for that once a change has arrived. Saving a
    /// file is several changes within a fraction of a second, and a pass that
    /// runs before the last of them can find the file half-written.
    static let settle: Duration = .seconds(1)
    static let settleLimit: Duration = .seconds(5)
}
