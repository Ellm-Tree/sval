// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import CryptoKit
import Foundation
import Synchronization
import UIKit
import WebKit

/// A picture of each tab's and pin's page, by page key, for the Workspace
/// sheet's grid and the tab scrub: taken here when the page leaves the
/// front or the app goes to the background, and never synced. A page this
/// phone hasn't shown has none.
///
/// A private page's picture stays in memory and goes with the session.
/// Every other picture is kept in the app's caches, which iOS may empty,
/// and is deleted once its tab leaves the tree or its pin its Workspace.
@MainActor
final class PagePreviews {
    static let shared = PagePreviews()

    /// The pictures' width in points, a card's in the grid's two columns,
    /// and their shape: the top of the page, cropped to the card's picture
    /// (15b).
    static let width: CGFloat = 180
    static let aspect: CGFloat = 140 / 171

    /// What redraws a card when its own picture arrives, and no other card.
    private let marks = KeyMarks()
    /// Each picture is about a megabyte decoded, so only the last few
    /// dozen drawn stay in memory; the rest are read again from disk.
    private let pictures: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 30
        return cache
    }()
    /// A private tab's pictures, which have no copy on disk to read again.
    private var privatePictures: [String: UIImage] = [:]
    /// Reads pictures from disk one at a time: decoding a collection
    /// view's images on a concurrent queue asks for too many threads
    /// (`UIImage.preparingForDisplay()`).
    private let reader: DispatchQueue
    /// The pictures asked for and not yet read. A card that leaves the
    /// screen takes its id out, and the reader skips it.
    private let wanted = Wanted()
    private var names: [String: String] = [:]
    private var kept: Set<String> = []
    /// The tabs with a picture on disk, by file name, read once at start.
    private lazy var onDisk: Set<String> = {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path())) ?? []
        return Set(names.compactMap { $0.hasSuffix(".jpg") ? String($0.dropLast(4)) : nil })
    }()
    private let folder: URL

    init(folder: URL? = nil, reader: DispatchQueue = DispatchQueue(label: "app.sval.previews", qos: .userInitiated)) {
        self.reader = reader
        self.folder = folder ?? {
            let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            return caches.appending(path: "PagePreviews", directoryHint: .isDirectory)
        }()
        try? FileManager.default.createDirectory(at: self.folder, withIntermediateDirectories: true)
        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.pictures.removeAllObjects() }
        }
    }

    /// The picture of tab `id`'s page. One on disk is read off the main
    /// thread, and the card asking is redrawn when it arrives.
    func picture(for id: String) -> UIImage? {
        marks.read(id)
        if let picture = cached(id) { return picture }
        read(id)
        return nil
    }

    /// The picture of `id` already in memory.
    func cached(_ id: String) -> UIImage? {
        privatePictures[id] ?? pictures.object(forKey: id as NSString)
    }

    /// Whether tab `id` has a picture, in memory or on disk.
    func has(_ id: String) -> Bool {
        cached(id) != nil || onDisk.contains(fileName(id))
    }

    /// Starts reading the pictures of cards about to show
    /// (`UICollectionViewDataSourcePrefetching`).
    func prefetch(_ ids: [String]) {
        for id in ids where cached(id) == nil { read(id) }
    }

    /// Drops the reads of cards no longer about to show, before they
    /// decode.
    func cancel(_ ids: [String]) {
        wanted.ids.withLock { $0.subtract(ids) }
    }

    private func read(_ id: String) {
        let name = fileName(id)
        guard onDisk.contains(name), wanted.ids.withLock({ $0.insert(id).inserted }) else { return }
        let file = folder.appending(path: name + ".jpg")
        reader.async { [wanted, weak self] in
            guard wanted.ids.withLock({ $0.contains(id) }) else { return }
            // Decoded here, so drawing it on the main thread doesn't.
            let image = (try? Data(contentsOf: file)).flatMap(UIImage.init(data:))?.preparingForDisplay()
            Task { @MainActor in self?.landed(id, image) }
        }
    }

    private func landed(_ id: String, _ image: UIImage?) {
        wanted.ids.withLock { _ = $0.remove(id) }
        guard let image else { return }
        pictures.setObject(image, forKey: id as NSString)
        marks.bump(id)
    }

    /// Takes the picture of tab `id`'s page as `view` last drew it. A page
    /// that hasn't drawn anything yet gives none, and the last picture
    /// stays.
    func take(_ id: String, from view: WKWebView, isPrivate: Bool) {
        Self.snapshot(view) { [weak self] image in self?.keep(image, for: id, isPrivate: isPrivate) }
    }

    /// The top of `view`'s page, `width` across and cut to `aspect`,
    /// cropped by the snapshot itself.
    static func snapshot(_ view: WKWebView, then done: @escaping @MainActor (UIImage) -> Void) {
        guard view.url != nil, view.bounds.width > 0 else { return }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = CGRect(x: 0, y: 0, width: view.bounds.width,
                                    height: min(view.bounds.height, view.bounds.width * aspect))
        configuration.snapshotWidth = NSNumber(value: Double(width))
        configuration.afterScreenUpdates = false
        view.takeSnapshot(with: configuration) { image, _ in
            guard let image else { return }
            MainActor.assumeIsolated { done(image) }
        }
    }

    /// Keeps `image` as tab `id`'s picture.
    func keep(_ image: UIImage, for id: String, isPrivate: Bool) {
        if isPrivate {
            privatePictures[id] = image
            marks.bump(id)
            return
        }
        pictures.setObject(image, forKey: id as NSString)
        marks.bump(id)
        let name = fileName(id)
        Task.detached(priority: .utility) { [folder] in
            guard let data = image.jpegData(compressionQuality: 0.7) else { return }
            try? data.write(to: folder.appending(path: name + ".jpg"), options: .atomic)
        }
        onDisk.insert(name)
    }

    /// Deletes every picture but the private session's, for Clear Browsing
    /// Data, which leaves the session alone.
    func forgetSaved() {
        pictures.removeAllObjects()
        let files = onDisk.map { folder.appending(path: $0 + ".jpg") }
        onDisk.removeAll()
        // The next `keep(only:)` runs in full, whatever it was given last.
        kept = []
        Task.detached(priority: .utility) {
            for file in files { try? FileManager.default.removeItem(at: file) }
        }
        marks.bumpAll()
    }

    /// Deletes the pictures of every page not in `tabs`
    /// (`Browser.pictured`), private ones included.
    func keep(only tabs: Set<String>) {
        guard tabs != kept else { return }
        kept = tabs
        marks.keep(only: tabs)
        for id in privatePictures.keys where !tabs.contains(id) { privatePictures[id] = nil }
        for id in names.keys where !tabs.contains(id) {
            pictures.removeObject(forKey: id as NSString)
            names[id] = nil
        }
        let gone = onDisk.subtracting(tabs.lazy.map(fileName))
        guard !gone.isEmpty else { return }
        onDisk.subtract(gone)
        let files = gone.map { folder.appending(path: $0 + ".jpg") }
        Task.detached(priority: .utility) {
            for file in files { try? FileManager.default.removeItem(at: file) }
        }
        Diagnostics.log("previews: deleted \(gone.count) of closed tabs")
    }

    /// A tab's file name: the hash of its id, so any id makes a safe name.
    func fileName(_ id: String) -> String {
        if let name = names[id] { return name }
        let name = SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined()
        names[id] = name
        return name
    }
}

/// The ids a reader still wants, shared between the main actor and the
/// reader's queue.
private final class Wanted: Sendable {
    let ids = Mutex<Set<String>>([])
}
