import Foundation
import CryptoKit

extension CryptoService {
    /// AES-GCM encrypt arbitrary JSON (matches web `encryptJson` for event payloads).
    func encryptJSONData(_ plaintext: Data, key: SymmetricKey) throws -> EncryptedBlob {
        do {
            let nonce = AES.GCM.Nonce()
            let sealed = try AES.GCM.seal(plaintext, using: key, nonce: nonce)
            let ivB64 = nonce.withUnsafeBytes { Data($0).base64EncodedString() }
            var ctTag = sealed.ciphertext
            ctTag.append(sealed.tag)
            return EncryptedBlob(ciphertext: ctTag.base64EncodedString(), iv: ivB64)
        } catch {
            throw CryptoError.sealFailed(error)
        }
    }

    func decryptJSONData(blob: EncryptedBlob, key: SymmetricKey) throws -> Data {
        guard
            let ivData = Data(base64Encoded: blob.iv),
            let ciphertextTag = Data(base64Encoded: blob.ciphertext),
            ciphertextTag.count >= 16
        else {
            throw CryptoError.invalidBase64
        }
        let tag = ciphertextTag.suffix(16)
        let ciphertext = ciphertextTag.dropLast(16)
        do {
            let nonce = try AES.GCM.Nonce(data: ivData)
            let sealed = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
            return try AES.GCM.open(sealed, using: key)
        } catch {
            throw CryptoError.openFailed(error)
        }
    }
}
