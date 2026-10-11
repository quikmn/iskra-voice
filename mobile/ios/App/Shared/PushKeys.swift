import CryptoKit
import Foundation
import Security

/// This install's Web Push keys: a P-256 key pair and a 16-byte auth secret, like a browser's push subscription.
/// In the keychain, in an access group shared with the Notification Service Extension (which decrypts pushes),
/// readable after the first unlock and never synced or backed up to another device.
struct PushKeys {
    let privateKey: P256.KeyAgreement.PrivateKey
    let auth: Data

    var p256dh: String { Self.b64u(privateKey.publicKey.x963Representation) }
    var authSecret: String { Self.b64u(auth) }

    private static let service = "foo.iskra.app.push"
    private static let account = "web-push-keys"

    /// "$(AppIdentifierPrefix)foo.iskra.app.shared", from Info.plist (IskraKeychainGroup).
    private static var accessGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "IskraKeychainGroup") as? String
    }

    private static func query() -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let group = accessGroup { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    static func load() -> PushKeys? {
        var q = query()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data, data.count == 48,
              let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: data.prefix(32)) else { return nil }
        return PushKeys(privateKey: key, auth: Data(data.suffix(16)))
    }

    static func loadOrCreate() throws -> PushKeys {
        if let existing = load() { return existing }
        let key = P256.KeyAgreement.PrivateKey()
        var auth = Data(count: 16)
        let status = auth.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        var add = query()
        add[kSecValueData as String] = key.rawRepresentation + auth
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemDelete(query() as CFDictionary)
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(added)) }
        return PushKeys(privateKey: key, auth: auth)
    }

    static func b64u(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Decrypts the `e` field of a push from the relay (base64 of the server's aes128gcm body).
    static func open(_ encrypted: Any?) -> PushPayload? {
        guard let text = encrypted as? String, let body = Data(base64Encoded: text), let keys = load(),
              let plain = try? WebPushCrypto.decrypt(body, privateKey: keys.privateKey, auth: keys.auth) else { return nil }
        return PushPayload.parse(plain)
    }
}
