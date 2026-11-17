// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// Taking another device's sync key, by the pairing code it shows
/// (spec §6.7, decision 0042) or by the key's backup (key-storage spec,
/// "Backup and recovery").
enum Join {
    /// Where offers live in a shared folder (`SvalPairing`'s `sval/pair`).
    static let pairDir = "\(topDir)/pair"

    /// The furthest ahead of now an offer's expiry may be and still count as
    /// one Sval wrote (`SvalPairing.isStale`).
    static let furthestExpiryMs = 60.0 * 60 * 1000

    /// How long an offer this phone makes stays open (`PAIRING_TTL_MS`).
    static let offerTtlMs = 60.0 * 60 * 1000

    /// The most an offer weighs (`OFFER_MAX_BYTES`): a few hundred bytes of
    /// JSON. A larger file is no offer and is never read.
    static let offerMaxBytes: UInt64 = 4096
    /// The most files one look reads, newest first. Each live one costs an
    /// Argon2id derivation of 64 MiB, and a look comes every few seconds,
    /// so a folder anyone can write to must not set how many there are.
    static let offersPerLook = 8

    /// An offer this phone made: the code it shows, and the file the other
    /// device takes.
    struct Offer: Equatable {
        let code: String
        let path: String
        let expiresAt: Date
    }

    /// Offers `key` to another device under a fresh code (`SvalPairing`'s
    /// `offer`). The file's name is random and owes nothing to the code: a
    /// name anyone could work out from a guess would let a folder listing
    /// test guesses for free (spec §6.7).
    static func offer(key: Data, in folder: SharedFolder) throws -> Offer {
        let code = try generatePairingCode()
        let now = Date.now.timeIntervalSince1970 * 1000
        let sealed = try sealPairing(key: key, code: code, now: now, ttlMs: offerTtlMs)
        // A random UUID's 122 random bits, as 32 hex digits.
        let name = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let path = "\(pairDir)/\(name).json"
        try folder.write(path, sealed)
        return Offer(code: code, path: path, expiresAt: Date(timeIntervalSince1970: (now + offerTtlMs) / 1000))
    }

    /// The sync key the offer in `folder` that `code` opens holds. The offer
    /// is left in place for the caller to delete once the key is stored.
    static func claim(code: String, in folder: SharedFolder) throws -> (key: Data, offer: String) {
        let now = Date.now.timeIntervalSince1970 * 1000
        var tried = false
        var expired: [Data] = []
        let files = try folder.files(pairDir)
        let offers = files.filter { $0.size <= offerMaxBytes }
            .sorted { $0.modifiedMs > $1.modifiedMs }
            .prefix(offersPerLook)
            .map(\.path)
        Diagnostics.log("join: \(files.count) file(s) in the pairing folder, \(offers.count) read")
        for path in offers {
            let bytes: Data
            do {
                bytes = try folder.read(path)
            } catch {
                // Unreadable, not an offer, or stale: no file, never a wrong
                // code (`SvalPairing`'s claim).
                Diagnostics.log("join: an offer is unreadable: \(Diagnostics.name(error))")
                continue
            }
            if let expiresAt = try? pairingExpiresAt(bytes: bytes), expiresAt <= now {
                expired.append(bytes)
                continue
            }
            guard let expiresAt = try? pairingExpiresAt(bytes: bytes),
                  expiresAt > now, expiresAt <= now + furthestExpiryMs
            else {
                Diagnostics.log("join: skipped a file of \(bytes.count) bytes that is not a live offer")
                continue
            }
            tried = true
            if let key = try? openPairing(bytes: bytes, code: Codes.bare(code)) {
                return (key, path)
            }
        }
        // An expired offer the code opens says why it fails better than
        // "doesn't match"; it is only opened to say so.
        if expired.contains(where: { (try? openPairing(bytes: $0, code: Codes.bare(code))) != nil }) {
            throw JoinError.expired
        }
        throw tried ? JoinError.wrongCode : JoinError.noOffer
    }

    /// Whether `key` names a document in `folder`: a backup for another
    /// folder names none.
    static func matches(key: Data, folder: SharedFolder) throws -> Bool {
        let prefix = try syncPrefix(key: key, workspace: workspacesDocument)
        return try folder.exists(prefix)
    }
}

enum JoinError: LocalizedError {
    case noOffer
    case wrongCode
    case expired
    case notACode
    case backupForAnotherFolder

    var errorDescription: String? {
        switch self {
        case .noOffer:
            return "No code from another device has reached this folder yet. Check that your other device shows a code, wait a moment, and try again."
        case .wrongCode:
            return "That code didn't work. Check the code on your other device and type it again."
        case .expired:
            return "That code expired. Show a new one on your other device and enter it here."
        case .notACode:
            return "Enter the 12-character code your other device shows, or your 52-character backup key."
        case .backupForAnotherFolder:
            return "That backup key is for a different folder."
        }
    }
}
