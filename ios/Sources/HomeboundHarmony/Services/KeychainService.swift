import Foundation
import Security

// Secure storage for non-secret session hints (email). Cookies hold the real session.

final class KeychainService {

    private enum Key {
        static let userEmail = "com.homeboundharmony.userEmail"
    }

    func saveUserEmail(_ email: String) {
        guard let data = email.data(using: .utf8) else { return }
        save(data, forKey: Key.userEmail, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
    }

    func loadUserEmail() -> String? {
        guard let data = load(forKey: Key.userEmail) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private enum LegacyKey {
        static let workspaceKey = "com.homeboundharmony.workspaceKey"
        static let pdkSalt = "com.homeboundharmony.pdkSalt"
    }

    /// Removes pre–multi-tenant E2EE key material left in Keychain after upgrade.
    func deleteLegacyCryptoItems() {
        delete(forKey: LegacyKey.workspaceKey)
        delete(forKey: LegacyKey.pdkSalt)
    }

    func deleteAll() {
        delete(forKey: Key.userEmail)
        deleteLegacyCryptoItems()
    }

    // MARK: - Primitive Keychain operations

    private func save(_ data: Data, forKey key: String, accessible: CFString) {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: key,
            kSecAttrAccessible: accessible,
            kSecValueData: data,
        ]

        let status = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
        if status == errSecItemNotFound {
            SecItemAdd(query as CFDictionary, nil)
        }
        _ = query
    }

    private func load(forKey key: String) -> Data? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: key,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    private func delete(forKey key: String) {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
