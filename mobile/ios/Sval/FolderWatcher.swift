// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// Reports changes iCloud makes to the shared folder while the app is open.
/// iOS updates a picked folder's contents on its own schedule and offers no
/// call that forces a sync. A file presenter on the folder is told as soon as
/// iCloud writes into it, which a pass every 30 seconds would find late. A
/// metadata query over external documents finds nothing in a picked folder,
/// so it is not used.
@MainActor
final class FolderWatcher {
    private let root: URL
    private let onChange: @MainActor ([String]) -> Void
    private let presenter: Presenter
    private var scoped = false

    /// `onChange` gets the names of the files that changed, or none when the
    /// system didn't say which.
    init(root: URL, onChange: @escaping @MainActor ([String]) -> Void) {
        self.root = root
        self.onChange = onChange
        presenter = Presenter(url: root)
    }

    func start() {
        // The folder stays open to the app for as long as it is watched.
        scoped = root.startAccessingSecurityScopedResource()
        presenter.onChange = { [weak self] names in
            Task { @MainActor in self?.onChange(names) }
        }
        NSFileCoordinator.addFilePresenter(presenter)
    }

    func stop() {
        NSFileCoordinator.removeFilePresenter(presenter)
        presenter.onChange = nil
        if scoped {
            root.stopAccessingSecurityScopedResource()
            scoped = false
        }
    }

    /// The file presenter. It runs on its own queue, apart from the main
    /// actor the watcher lives on.
    private final class Presenter: NSObject, NSFilePresenter, @unchecked Sendable {
        let presentedItemURL: URL?
        let presentedItemOperationQueue = OperationQueue()
        var onChange: (([String]) -> Void)?

        init(url: URL) {
            presentedItemURL = url
            presentedItemOperationQueue.maxConcurrentOperationCount = 1
        }

        func presentedSubitemDidChange(at url: URL) {
            onChange?([url.lastPathComponent])
        }

        func presentedSubitemDidAppear(at url: URL) {
            onChange?([url.lastPathComponent])
        }

        func presentedItemDidChange() {
            onChange?([])
        }
    }
}
