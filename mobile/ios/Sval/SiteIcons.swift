// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import CryptoKit
import Foundation
import ImageIO
import UIKit
import WebKit

/// Each site's icon, kept on this device as the desktop keeps a tab's
/// (`SvalFavoriteIcons`): learned when a page of the site finishes loading
/// here, and never synced. A tab nobody has opened on this phone shows its
/// letter until then, as a restored tab on the desktop shows no icon.
///
/// The icon is fetched from the address the page names, on any site, or
/// the site's `/favicon.ico`. As the desktop's `FaviconLoader` channel goes
/// through the page's blocking, each address the fetch reaches is checked
/// against the lists the page blocks with, and a blocked one is never
/// asked for. The fetch carries no cookies. Hosts are never logged
/// (`CONTRIBUTING.md` rule 10).
@MainActor
final class SiteIcons {
    static let shared = SiteIcons()

    /// What redraws a view when its own site's icon arrives, and no other
    /// view.
    private let marks = KeyMarks()
    private var icons: [String: UIImage] = [:]
    private var reading: Set<String> = []
    private var names: [String: String] = [:]
    /// The sites with an icon on disk, by file name, listed once.
    private lazy var onDisk: Set<String> = {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path())) ?? []
        return Set(names.compactMap { $0.hasSuffix(".png") ? String($0.dropLast(4)) : nil })
    }()
    private var fetching: Set<String> = []
    /// Sites that gave no icon this session, tried again only when a page
    /// names one.
    private var gaveNone: Set<String> = []
    private let session = URLSession(configuration: .ephemeral)
    /// The request blocking a page of the address given loads under, or
    /// none where nothing is blocked.
    var blocking: (@MainActor (URL) -> RequestBlocker?)?
    private let folder: URL = {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let folder = caches.appending(path: "SiteIcons", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    /// The icon kept for `host`. One on disk is read off the main thread,
    /// and the view asking is redrawn when it arrives.
    func icon(for host: String) -> UIImage? {
        marks.read(host)
        if let icon = icons[host] { return icon }
        guard known(host), !reading.contains(host) else { return nil }
        reading.insert(host)
        let file = file(host)
        Task.detached(priority: .userInitiated) {
            let image = (try? Data(contentsOf: file)).flatMap(UIImage.init(data:))?.preparingForDisplay()
            await MainActor.run {
                self.reading.remove(host)
                guard let image else { return }
                self.landed(host, image)
            }
        }
        return nil
    }

    /// Whether this phone has `host`'s icon, in memory or on disk.
    private func known(_ host: String) -> Bool {
        icons[host] != nil || onDisk.contains(fileName(host))
    }

    /// Learns the icon of the page at `page`, from the address the page
    /// named (`reportIcon`, sent once its document is parsed, before its
    /// images load), else `/favicon.ico`. A site already known is left
    /// alone.
    ///
    /// `page` is the address of the document that named the icon, taken
    /// from the message itself: by the time it arrives the view may show
    /// another site, whose icon this is not.
    func learn(page: URL?, named: String?) {
        guard let page, ["http", "https"].contains(page.scheme ?? ""), let host = page.host(),
              !known(host), !fetching.contains(host),
              named != nil || !gaveNone.contains(host) else { return }
        fetching.insert(host)
        let check = IconCheck(page: page, blocker: blocking?(page))
        let candidates = [named.flatMap { URL(string: $0, relativeTo: page)?.absoluteURL },
                          URL(string: "/favicon.ico", relativeTo: page)?.absoluteURL].compactMap { $0 }
        let file = file(host)
        Task {
            defer { fetching.remove(host) }
            if let image = await Self.download(candidates, check: check, session: session, to: file) {
                onDisk.insert(fileName(host))
                landed(host, image)
                return
            }
            gaveNone.insert(host)
            Diagnostics.log("icons: a site gave no icon iOS can draw")
        }
    }

    /// Forgets every icon, on disk and in memory, for Clear Browsing Data.
    func forgetAll() {
        icons = [:]
        gaveNone = []
        onDisk.removeAll()
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        for file in files { try? FileManager.default.removeItem(at: file) }
        marks.bumpAll()
    }

    /// Keeps `image` as `host`'s icon.
    func landed(_ host: String, _ image: UIImage) {
        icons[host] = image
        marks.bump(host)
    }

    /// The most an icon may weigh. A site's icon is a few kilobytes, and
    /// the fetch runs in the app's own process.
    nonisolated static let maxBytes = 1 << 20
    /// The largest side an icon is decoded at, past any size Sval draws one.
    nonisolated static let maxPixels = 256

    /// Fetches the first of `candidates` that `check` allows and that
    /// gives an image, and writes it to `file` as PNG. Runs off the main
    /// actor, since a page of a new site is drawing as its icon arrives.
    @concurrent
    nonisolated static func download(_ candidates: [URL], check: IconCheck, session: URLSession,
                                     to file: URL) async -> UIImage? {
        dispatchPrecondition(condition: .notOnQueue(.main))
        for url in candidates where check.allows(url) {
            guard let (data, response) = await fetch(url, check: check, session: session),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let image = decode(data), image.size.width >= 16,
                  let png = image.pngData() else { continue }
            try? png.write(to: file, options: .atomic)
            return image
        }
        return nil
    }

    /// `url`'s body, or nil once it passes `maxBytes`.
    nonisolated private static func fetch(_ url: URL, check: IconCheck,
                                          session: URLSession) async -> (Data, URLResponse)? {
        guard let (bytes, response) = try? await session.bytes(from: url, delegate: check),
              response.url.map(check.allows) == true,
              response.expectedContentLength <= maxBytes else { return nil }
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count > maxBytes { return nil }
            }
        } catch {
            return nil
        }
        return (data, response)
    }

    /// The icon in `data`, decoded no larger than `maxPixels` a side, so an
    /// image that claims huge dimensions is never drawn whole.
    nonisolated private static func decode(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxPixels,
              ] as CFDictionary)
        else { return nil }
        return UIImage(cgImage: image)
    }

    private func file(_ host: String) -> URL {
        folder.appending(path: fileName(host) + ".png")
    }

    /// A site's file name: the hash of its host, so any host makes a safe
    /// name.
    private func fileName(_ host: String) -> String {
        if let name = names[host] { return name }
        let name = SHA256.hash(data: Data(host.utf8)).map { String(format: "%02x", $0) }.joined()
        names[host] = name
        return name
    }

    /// Sends the page's own icon address once its document is parsed: its
    /// touch icon, else the largest `rel=icon` that isn't SVG, which
    /// `UIImage` can't read.
    static let message = "svalIcon"
    static let reportIcon = """
        webkit.messageHandlers.\(message).postMessage((() => {
          const size = l => Math.max(0, ...String(l.sizes?.value || "").split(/\\s+/).map(s => parseInt(s, 10) || 0));
          const touch = document.querySelector('link[rel~="apple-touch-icon"]');
          if (touch?.href) return touch.href;
          const icons = [...document.querySelectorAll('link[rel~="icon"]')]
            .filter(l => l.href && !/svg/i.test(l.type || "") && !/\\.svg(\\?|$)/i.test(l.href))
            .sort((a, b) => size(b) - size(a));
          return icons[0]?.href ?? null;
        })());
        """
}

/// What an icon fetch for one page may reach: a web address the page's
/// blocking lets through, the first address and each redirect alike.
final class IconCheck: NSObject, URLSessionTaskDelegate, Sendable {
    let page: URL
    let blocker: RequestBlocker?

    init(page: URL, blocker: RequestBlocker?) {
        self.page = page
        self.blocker = blocker
    }

    func allows(_ url: URL) -> Bool {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return false }
        return blocker?.blocksImage(url: url.absoluteString, page: page.absoluteString) != true
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        request.url.map(allows) == true ? request : nil
    }
}
