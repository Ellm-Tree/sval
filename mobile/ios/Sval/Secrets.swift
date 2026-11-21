// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import Security

/// The keys and ids this device keeps in its Keychain, readable after first
/// unlock and never leaving the device: in neither iCloud Keychain nor a
/// backup (key-storage spec, "Keys on mobile").
enum Secrets {
    private static let service = "app.sval.ios"

    /// The 16 bytes this device writes its file under. The item is this
    /// device's alone, so it outlasts the app's own copy and never reaches
    /// another device (`docs/host-contract.md` §5).
    static func deviceId() throws -> Data {
        try existingOrNew(account: "device-id", count: 16)
    }

    /// The key this device's own copy of the document is sealed under.
    static func localKey() throws -> Data {
        try existingOrNew(account: "local-key", count: 32)
    }

    static func syncKey() -> Data? {
        read(account: "sync-key")
    }

    static func storeSyncKey(_ key: Data) throws {
        try store(key, account: "sync-key")
    }

    static func forgetSyncKey() {
        SecItemDelete(query(account: "sync-key") as CFDictionary)
    }

    /// The password for the SMB share the shared folder is on.
    static func smbPassword() -> Data? {
        read(account: "smb-password")
    }

    static func storeSmbPassword(_ password: Data) throws {
        try store(password, account: "smb-password")
    }

    static func forgetSmbPassword() {
        SecItemDelete(query(account: "smb-password") as CFDictionary)
    }

    /// Dropbox's refresh token, from signing in to the Dropbox the shared
    /// folder is in.
    static func dropboxToken() -> String? {
        read(account: "dropbox-token").map { String(decoding: $0, as: UTF8.self) }
    }

    static func storeDropboxToken(_ token: String) throws {
        try store(Data(token.utf8), account: "dropbox-token")
    }

    static func forgetDropboxToken() {
        SecItemDelete(query(account: "dropbox-token") as CFDictionary)
    }

    /// Kagi's Privacy Pass tokens and their state (`KagiPrivacyPass`).
    static func kagiPrivacyPass() -> Data? {
        read(account: "kagi-privacy-pass")
    }

    static func storeKagiPrivacyPass(_ stock: Data) throws {
        try store(stock, account: "kagi-privacy-pass")
    }

    static func forgetKagiPrivacyPass() {
        SecItemDelete(query(account: "kagi-privacy-pass") as CFDictionary)
    }

    /// The item, or a new random one when the Keychain has none. Only a
    /// missing item makes a new one: a read that fails for another reason
    /// throws, since a new device id over a live own copy, or a new local
    /// key, which seals that copy, would cost what the copy holds.
    private static func existingOrNew(account: String, count: Int) throws -> Data {
        if let data = try find(account: account) {
            return data
        }
        var bytes = Data(count: count)
        let status = bytes.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw SecretsError.status(status)
        }
        try store(bytes, account: account)
        return bytes
    }

    private static func query(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func read(account: String) -> Data? {
        (try? find(account: account)) ?? nil
    }

    /// The item, nil when there is none, and an error for any other
    /// failure.
    private static func find(account: String) throws -> Data? {
        var request = query(account: account)
        request[kSecReturnData as String] = true
        var result: AnyObject?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw SecretsError.status(status)
        }
        return data
    }

    private static func store(_ data: Data, account: String) throws {
        SecItemDelete(query(account: account) as CFDictionary)
        var item = query(account: account)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw SecretsError.status(status)
        }
    }
}

enum SecretsError: LocalizedError {
    case status(OSStatus)

    var errorDescription: String? {
        switch self {
        case .status(let status):
            return "The Keychain refused the request (\(status))."
        }
    }
}
