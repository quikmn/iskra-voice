import CryptoKit
import Foundation

/// Web Push message decryption (RFC 8291, "aes128gcm" from RFC 8188) with CryptoKit. The Iskra server encrypts each
/// push to this app's own P-256 key exactly as it does for a browser; the push relay and Apple only carry ciphertext.
/// Shared by the app and the Notification Service Extension. Checked against RFC 8291's example in CI (mobile/ios/Tests).
enum WebPushCrypto {
    enum Failure: Error {
        case malformed
        case padding
    }

    private static let saltLength = 16
    private static let headerLength = 16 + 4 + 1
    private static let pointLength = 65

    static func decrypt(_ message: Data, privateKey: P256.KeyAgreement.PrivateKey, auth: Data) throws -> Data {
        let bytes = [UInt8](message)
        guard bytes.count >= headerLength + pointLength + 17 else { throw Failure.malformed }
        let salt = Data(bytes[0..<saltLength])
        let recordSize = UInt32(bytes[16]) << 24 | UInt32(bytes[17]) << 16 | UInt32(bytes[18]) << 8 | UInt32(bytes[19])
        guard bytes[20] == pointLength else { throw Failure.malformed }
        let asPublicRaw = Data(bytes[headerLength..<(headerLength + pointLength)])
        let ciphertext = Data(bytes[(headerLength + pointLength)...])
        guard recordSize >= 18, ciphertext.count <= Int(recordSize), ciphertext.count > 16 else { throw Failure.malformed }

        let asPublic = try P256.KeyAgreement.PublicKey(x963Representation: asPublicRaw)
        let ecdh = try privateKey.sharedSecretFromKeyAgreement(with: asPublic).withUnsafeBytes { Data($0) }
        let uaPublic = privateKey.publicKey.x963Representation

        // RFC 8291 section 3.4: IKM from the ECDH secret and the auth secret, then RFC 8188's key and nonce.
        let prkKey = hmac(key: auth, data: ecdh)
        var keyInfo = Data("WebPush: info".utf8)
        keyInfo.append(0)
        keyInfo.append(uaPublic)
        keyInfo.append(asPublicRaw)
        keyInfo.append(1)
        let ikm = hmac(key: prkKey, data: keyInfo)
        let prk = hmac(key: salt, data: ikm)
        let cek = hmac(key: prk, data: Data("Content-Encoding: aes128gcm".utf8) + [0, 1]).prefix(16)
        let nonce = hmac(key: prk, data: Data("Content-Encoding: nonce".utf8) + [0, 1]).prefix(12)

        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: Data(nonce)),
            ciphertext: Data(ciphertext.prefix(ciphertext.count - 16)),
            tag: Data(ciphertext.suffix(16))
        )
        let padded = [UInt8](try AES.GCM.open(box, using: SymmetricKey(data: Data(cek))))
        guard let last = padded.lastIndex(where: { $0 != 0 }), padded[last] == 2 else { throw Failure.padding }
        return Data(padded[0..<last])
    }

    private static func hmac(key: Data, data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }
}
