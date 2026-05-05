import Foundation
import Security

// Secure storage for the workspace key and session metadata.
// The workspace key is stored with .whenUnlockedThisDeviceOnly so it is never
// synced to iCloud and is wiped on device transfer.

final class KeychainService {

    private enum Key {
        static let workspaceKey = "com.homeboundharmony.workspaceKey"
        static let pdkSalt     = "com.homeboundharmony.pdkSalt"
        static let userEmail   = "com.homeboundharmony.userEmail"
    }

    // MARK: - Workspace key (raw 32-byte AES-256 key)

    func saveWorkspaceKey(_ data: Data) {
        save(data, forKey: Key.workspaceKey, accessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly)
    }

    func loadWorkspaceKey() -> Data? {
        load(forKey: Key.workspaceKey)
    }

    func deleteWorkspaceKey() {
        delete(forKey: Key.workspaceKey)
    }

    // MARK: - PDK salt (base64, needed for unlock without TOTP)

    func savePdkSalt(_ salt: String) {
        guard let data = salt.data(using: .utf8) else { return }
        save(data, forKey: Key.pdkSalt, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
    }

    func loadPdkSalt() -> String? {
        guard let data = load(forKey: Key.pdkSalt) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: - User email (convenience, not secret)

    func saveUserEmail(_ email: String) {
        guard let data = email.data(using: .utf8) else { return }
        save(data, forKey: Key.userEmail, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
    }

    func loadUserEmail() -> String? {
        guard let data = load(forKey: Key.userEmail) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func deleteAll() {
        delete(forKey: Key.workspaceKey)
        delete(forKey: Key.pdkSalt)
        delete(forKey: Key.userEmail)
    }

    // MARK: - Primitive Keychain operations

    private func save(_ data: Data, forKey key: String, accessible: CFString) {
        var query: [CFString: Any] = [
            kSecClass:           kSecClassGenericPassword,
            kSecAttrAccount:     key,
            kSecAttrAccessible:  accessible,
            kSecValueData:       data,
        ]

        // Try update first; if not found, add.
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
        if status == errSecItemNotFound {
            SecItemAdd(query as CFDictionary, nil)
        }
        _ = query  // suppress unused warning
    }

    private func load(forKey key: String) -> Data? {
        let query: [CFString: Any] = [
            kSecClass:            kSecClassGenericPassword,
            kSecAttrAccount:      key,
            kSecReturnData:       true,
            kSecMatchLimit:       kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    private func delete(forKey key: String) {
        let query: [CFString: Any] = [
            kSecClass:        kSecClassGenericPassword,
            kSecAttrAccount:  key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
