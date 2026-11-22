// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Foundation
import Security

/// Where the keys and ids are kept, by account.
protocol KeyStore: Sendable {
    /// The item, nil when there is none, and an error for any other
    /// failure.
    func find(account: String) throws -> Data?
    func store(_ data: Data, account: String) throws
    func delete(account: String)
}

/// The keys and ids this device keeps, by what each is for.
struct Secrets: Sendable {
    let store: KeyStore

    /// This device's own, in its Keychain.
    static let keychain = Secrets(store: Keychain())

    /// The 16 bytes this device writes its file under. The item is this
    /// device's alone, so it outlasts the app's own copy and never reaches
    /// another device (`docs/host-contract.md` §5).
    func deviceId() throws -> Data {
        try existingOrNew(account: "device-id", count: 16)
    }

    /// The key this device's own copy of the document is sealed under.
    func localKey() throws -> Data {
        try existingOrNew(account: "local-key", count: 32)
    }

    func syncKey() -> Data? {
        read(account: "sync-key")
    }

    func storeSyncKey(_ key: Data) throws {
        try store.store(key, account: "sync-key")
    }

    func forgetSyncKey() {
        store.delete(account: "sync-key")
    }

    /// The password for the SMB share the shared folder is on.
    func smbPassword() -> Data? {
        read(account: "smb-password")
    }

    func storeSmbPassword(_ password: Data) throws {
        try store.store(password, account: "smb-password")
    }

    func forgetSmbPassword() {
        store.delete(account: "smb-password")
    }

    /// Dropbox's refresh token, from signing in to the Dropbox the shared
    /// folder is in.
    func dropboxToken() -> String? {
        read(account: "dropbox-token").map { String(decoding: $0, as: UTF8.self) }
    }

    func storeDropboxToken(_ token: String) throws {
        try store.store(Data(token.utf8), account: "dropbox-token")
    }

    func forgetDropboxToken() {
        store.delete(account: "dropbox-token")
    }

    /// Kagi's Privacy Pass tokens and their state (`KagiPrivacyPass`).
    func kagiPrivacyPass() -> Data? {
        read(account: "kagi-privacy-pass")
    }

    func storeKagiPrivacyPass(_ stock: Data) throws {
        try store.store(stock, account: "kagi-privacy-pass")
    }

    func forgetKagiPrivacyPass() {
        store.delete(account: "kagi-privacy-pass")
    }

    /// The item, or a new random one when the Keychain has none. Only a
    /// missing item makes a new one: a read that fails for another reason
    /// throws, since a new device id over a live own copy, or a new local
    /// key, which seals that copy, would cost what the copy holds.
    private func existingOrNew(account: String, count: Int) throws -> Data {
        if let data = try store.find(account: account) {
            return data
        }
        var bytes = Data(count: count)
        let status = bytes.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw SecretsError.status(status)
        }
        try store.store(bytes, account: account)
        return bytes
    }

    private func read(account: String) -> Data? {
        (try? store.find(account: account)) ?? nil
    }
}

/// The Keychain's items under the app's service, readable after first
/// unlock and never leaving the device: in neither iCloud Keychain nor a
/// backup (key-storage spec, "Keys on mobile").
struct Keychain: KeyStore {
    private static let service = "app.sval.ios"

    private func query(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account,
        ]
    }

    func find(account: String) throws -> Data? {
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

    func store(_ data: Data, account: String) throws {
        SecItemDelete(query(account: account) as CFDictionary)
        var item = query(account: account)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw SecretsError.status(status)
        }
    }

    func delete(account: String) {
        SecItemDelete(query(account: account) as CFDictionary)
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
