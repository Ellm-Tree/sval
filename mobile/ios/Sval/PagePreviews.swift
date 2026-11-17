// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import CryptoKit
import Foundation
import Observation
import UIKit
import WebKit

/// A picture of each tab's page, for the Workspace sheet's grid: taken here
/// when the tab leaves the front or the app goes to the background, and
/// never synced. A tab this phone hasn't shown has none.
///
/// A private tab's picture stays in memory and goes with the session.
/// Every other picture is kept in the app's caches, which iOS may empty,
/// and is deleted once its tab leaves the tree.
@MainActor
@Observable
final class PagePreviews {
    static let shared = PagePreviews()

    /// The pictures' width in points, a card's in the grid's two columns,
    /// and their shape: the top of the page, cropped to the card's picture
    /// (15b).
    static let width: CGFloat = 180
    static let aspect: CGFloat = 140 / 171

    /// Counts the pictures taken or read, so a card drawing one is redrawn
    /// when its picture arrives. The caches below change while views draw,
    /// so they are kept out of observation.
    private var taken = 0
    /// Each picture is about a megabyte decoded, so only the last few
    /// dozen drawn stay in memory; the rest are read again from disk.
    @ObservationIgnored private let pictures: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 30
        return cache
    }()
    /// A private tab's pictures, which have no copy on disk to read again.
    @ObservationIgnored private var privatePictures: [String: UIImage] = [:]
    @ObservationIgnored private var reading: Set<String> = []
    @ObservationIgnored private var names: [String: String] = [:]
    @ObservationIgnored private var kept: Set<String> = []
    /// The tabs with a picture on disk, by file name, read once at start.
    @ObservationIgnored private lazy var onDisk: Set<String> = {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path())) ?? []
        return Set(names.compactMap { $0.hasSuffix(".jpg") ? String($0.dropLast(4)) : nil })
    }()
    @ObservationIgnored private let folder: URL = {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let folder = caches.appending(path: "PagePreviews", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    init() {
        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.pictures.removeAllObjects() }
        }
    }

    /// The picture of tab `id`'s page. One on disk is read off the main
    /// thread, and the card asking is redrawn when it arrives.
    func picture(for id: String) -> UIImage? {
        _ = taken
        if let picture = privatePictures[id] ?? pictures.object(forKey: id as NSString) { return picture }
        let name = fileName(id)
        guard onDisk.contains(name), !reading.contains(id) else { return nil }
        reading.insert(id)
        let file = folder.appending(path: name + ".jpg")
        Task.detached(priority: .userInitiated) {
            // Decoded here, so drawing it on the main thread doesn't.
            let image = (try? Data(contentsOf: file)).flatMap(UIImage.init(data:))?.preparingForDisplay()
            await MainActor.run {
                self.reading.remove(id)
                guard let image else { return }
                self.pictures.setObject(image, forKey: id as NSString)
                self.taken += 1
            }
        }
        return nil
    }

    /// Takes the picture of tab `id`'s page as `view` last drew it. A page
    /// that hasn't drawn anything yet gives none, and the last picture
    /// stays.
    func take(_ id: String, from view: WKWebView, isPrivate: Bool) {
        guard view.url != nil, view.bounds.width > 0 else { return }
        let configuration = WKSnapshotConfiguration()
        configuration.snapshotWidth = NSNumber(value: Double(Self.width))
        configuration.afterScreenUpdates = false
        view.takeSnapshot(with: configuration) { [weak self] image, _ in
            guard let self, let image else { return }
            let crop = CGSize(width: image.size.width, height: min(image.size.height, image.size.width * Self.aspect))
            let top = UIGraphicsImageRenderer(size: crop, format: image.imageRendererFormat).image { _ in
                image.draw(at: .zero)
            }
            MainActor.assumeIsolated { self.keep(top, for: id, isPrivate: isPrivate) }
        }
    }

    private func keep(_ image: UIImage, for id: String, isPrivate: Bool) {
        taken += 1
        if isPrivate {
            privatePictures[id] = image
            return
        }
        pictures.setObject(image, forKey: id as NSString)
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
        taken += 1
    }

    /// Deletes the pictures of every tab not in `tabs`, the tree's tabs,
    /// private ones included.
    func keep(only tabs: Set<String>) {
        guard tabs != kept else { return }
        kept = tabs
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
    private func fileName(_ id: String) -> String {
        if let name = names[id] { return name }
        let name = SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined()
        names[id] = name
        return name
    }
}
