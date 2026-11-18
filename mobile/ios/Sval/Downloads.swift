// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Observation
import SwiftUI
import WebKit

/// Files the pages download. Each goes to Downloads in the app's Documents,
/// which the Files app shows under On My iPhone › Sval
/// (`UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace`), and opens
/// in Quick Look once it has arrived. A private tab's download is kept the
/// same way, since the user asked for the file, and nothing records it.
@MainActor
@Observable
final class Downloads: NSObject, WKDownloadDelegate {
    struct Item: Identifiable {
        let id = UUID()
        let download: WKDownload
        var name: String
        var fraction: Double = 0
        var destination: URL?
    }

    /// The downloads under way, oldest first.
    private(set) var items: [Item] = []
    @ObservationIgnored private var watches: [ObjectIdentifier: NSKeyValueObservation] = [:]
    /// The file just downloaded, which shows in Quick Look, the system's
    /// viewer with Share, Save to Files and Markup (`BrowserView`).
    var preview: URL?
    /// Told when a download fails, with the file's name.
    @ObservationIgnored var onFailure: ((String) -> Void)?

    static var folder: URL { URL.documentsDirectory.appending(path: "Downloads", directoryHint: .isDirectory) }

    /// Saves `download` when the user `asked` for it. A page's script could
    /// otherwise save file after file, each opening over the page.
    func start(_ download: WKDownload, asked: Bool) {
        guard asked else {
            download.cancel(nil)
            Diagnostics.log("downloads: refused one the user didn't start")
            return
        }
        download.delegate = self
        let name = download.originalRequest?.url?.lastPathComponent ?? ""
        items.append(Item(download: download, name: name))
        let key = ObjectIdentifier(download)
        watches[key] = download.progress.observe(\.fractionCompleted) { [weak self] progress, _ in
            let fraction = progress.fractionCompleted
            Task { @MainActor in self?.update(key) { $0.fraction = fraction } }
        }
        Diagnostics.log("downloads: started, \(items.count) under way")
    }

    func cancel(_ item: Item) {
        item.download.cancel(nil)
        finish(ObjectIdentifier(item.download))
        Diagnostics.log("downloads: cancelled")
    }

    // MARK: WKDownloadDelegate

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping @MainActor (URL?) -> Void) {
        do {
            try FileManager.default.createDirectory(at: Self.folder, withIntermediateDirectories: true)
            let destination = Self.unused(Self.folder.appending(path: Self.safeName(suggestedFilename)))
            update(ObjectIdentifier(download)) {
                $0.name = destination.lastPathComponent
                $0.destination = destination
            }
            completionHandler(destination)
        } catch {
            Diagnostics.log("downloads: no folder: \(Diagnostics.name(error))")
            completionHandler(nil)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        let key = ObjectIdentifier(download)
        let destination = items.first { ObjectIdentifier($0.download) == key }?.destination
        finish(key)
        Diagnostics.log("downloads: finished")
        if let destination { preview = destination }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let key = ObjectIdentifier(download)
        let name = items.first { ObjectIdentifier($0.download) == key }?.name ?? ""
        finish(key)
        Diagnostics.log("downloads: failed: \(Diagnostics.name(error))")
        onFailure?(name)
    }

    // MARK: Parts

    private func update(_ key: ObjectIdentifier, _ change: (inout Item) -> Void) {
        guard let index = items.firstIndex(where: { ObjectIdentifier($0.download) == key }) else { return }
        change(&items[index])
    }

    private func finish(_ key: ObjectIdentifier) {
        watches.removeValue(forKey: key)?.invalidate()
        items.removeAll { ObjectIdentifier($0.download) == key }
    }

    /// `name` as a file name in the folder: no path, and a name for none.
    nonisolated static func safeName(_ name: String) -> String {
        let last = (name as NSString).lastPathComponent
            .replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return ["", ".", "..", "/"].contains(last) ? "Download" : last
    }

    /// `url`, or the first of `name 2.ext`, `name 3.ext`… that is free, so
    /// a second download of a file never replaces the first.
    nonisolated static func unused(_ url: URL, exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> URL {
        guard exists(url) else { return url }
        let folder = url.deletingLastPathComponent()
        let ext = url.pathExtension
        let stem = url.deletingPathExtension().lastPathComponent
        var number = 2
        while true {
            let name = ext.isEmpty ? "\(stem) \(number)" : "\(stem) \(number).\(ext)"
            let candidate = folder.appending(path: name)
            if !exists(candidate) { return candidate }
            number += 1
        }
    }
}

/// The downloads under way, as a glass capsule above the bar, as the ask
/// for video and audio is drawn (`MediaAsk`): the file's name with its
/// progress, and × to cancel.
struct DownloadCapsule: View {
    @Environment(AppModel.self) private var model
    let colors: BarColors

    var body: some View {
        let downloads = model.browser.downloads
        if let item = downloads.items.last {
            HStack(spacing: 0) {
                HStack(spacing: 10) {
                    Gauge(value: item.fraction) { EmptyView() }
                        .gaugeStyle(.accessoryCircularCapacity)
                        .tint(colors.ink)
                        .scaleEffect(0.4)
                        .frame(width: 22, height: 22)
                    Text(downloads.items.count > 1 ? "\(item.name) and \(downloads.items.count - 1) more" : item.name)
                        .font(.system(.subheadline, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .padding(.leading, 14)
                .padding(.trailing, 10)
                .frame(minHeight: 44)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Downloading \(item.name)")
                .accessibilityValue(Text(item.fraction, format: .percent.precision(.fractionLength(0))))
                colors.rule.frame(width: 1, height: 22)
                Button { downloads.cancel(item) } label: {
                    Label("Cancel Download", systemImage: "xmark")
                        .labelStyle(.iconOnly)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(colors.ink.opacity(0.75))
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
            }
            .buttonStyle(.plain)
            .padding(.trailing, 4)
            .foregroundStyle(colors.ink)
            .glassCapsule(colors.layer)
            .frame(maxWidth: 360)
        }
    }
}
