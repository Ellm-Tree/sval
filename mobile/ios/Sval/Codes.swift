// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation

/// The codes a person types to join: a pairing code another device shows, or
/// a sync key's backup. Both follow the desktop's `SvalPanelModel`
/// (`normalizeCode`, `fromBackupCode`), so a code that works there works here.
enum Codes {
    /// Spec §6.7's alphabet in the order a backup's characters index.
    static let backupAlphabet = Array("ABCDEFGHJKMNPQRSTVWXYZ0123456789")

    /// What the user typed, without spaces or dashes, uppercased, with the
    /// letters the alphabet leaves out for looking like digits read as them.
    static func bare(_ text: String) -> String {
        String(
            text.uppercased()
                .filter { !$0.isWhitespace && $0 != "-" }
                .map { character -> Character in
                    switch character {
                    case "I", "L": return "1"
                    case "O": return "0"
                    default: return character
                    }
                })
    }

    static func isPairingCode(_ text: String) -> Bool {
        let bare = bare(text)
        return bare.count == 12 && bare.allSatisfy(backupAlphabet.contains)
    }

    /// A sync key as its backup shows it, in groups of four (`backupCode`,
    /// key-storage spec, "Backup and recovery").
    static func backup(of key: Data) -> String {
        var out = ""
        var bits = 0
        var value = 0
        for byte in key {
            value = (value << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                out.append(backupAlphabet[(value >> (bits - 5)) & 31])
                bits -= 5
            }
            value &= (1 << bits) - 1
        }
        if bits > 0 { out.append(backupAlphabet[(value << (5 - bits)) & 31]) }
        return stride(from: 0, to: out.count, by: 4).map { start -> String in
            let characters = Array(out)
            return String(characters[start..<min(start + 4, characters.count)])
        }.joined(separator: "-")
    }

    /// The 32-byte sync key a 52-character backup holds, or nil.
    static func syncKey(fromBackup text: String) -> Data? {
        let bare = bare(text)
        guard bare.count == 52 else {
            return nil
        }
        var bytes = [UInt8]()
        var bits = 0
        var value = 0
        for character in bare {
            guard let digit = backupAlphabet.firstIndex(of: character) else {
                return nil
            }
            value = (value << 5) | digit
            bits += 5
            if bits >= 8 {
                bytes.append(UInt8((value >> (bits - 8)) & 255))
                bits -= 8
                value &= (1 << bits) - 1
            }
        }
        // The last character carries four bits past the key, zero in a code
        // the desktop wrote.
        guard bytes.count == 32, value == 0 else {
            return nil
        }
        return Data(bytes)
    }
}
