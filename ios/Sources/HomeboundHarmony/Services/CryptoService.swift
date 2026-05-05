import Foundation
import CryptoKit
import RouteCareArgon2

// E2EE primitives matching src/lib/crypto.ts exactly.
//
// Key hierarchy (identical to the web app):
//   password ──Argon2id──▶ PDK ─unwrap──▶ WK ──AES-256-GCM──▶ workspace plaintext
//
// Wire formats:
//   wrappedWorkspaceKey  = base64( iv[12] || AES-GCM(PDK, rawWK)[48] )  → 60 raw → 80 b64
//   workspace ciphertext = base64( AES-GCM(WK, json)[n+16] )            // tag appended
//   workspace iv         = base64( nonce[12] )                           // separate field

enum CryptoError: LocalizedError {
    case invalidBase64
    case invalidKeyLength
    case argon2Failed(Error)
    case sealFailed(Error)
    case openFailed(Error)
    case decodingFailed(Error)
    case encodingFailed(Error)

    var errorDescription: String? {
        switch self {
        case .invalidBase64:     return "Invalid base64 data"
        case .invalidKeyLength:  return "Invalid key length"
        case .argon2Failed(let e): return "Key derivation failed: \(e.localizedDescription)"
        case .sealFailed(let e):   return "Encryption failed: \(e.localizedDescription)"
        case .openFailed(let e):   return "Decryption failed: \(e.localizedDescription)"
        case .decodingFailed(let e): return "JSON decode failed: \(e.localizedDescription)"
        case .encodingFailed(let e): return "JSON encode failed: \(e.localizedDescription)"
        }
    }
}

// Pair of base64 fields that the server stores for the workspace blob.
struct EncryptedBlob {
    let ciphertext: String  // base64(ciphertext || 16-byte tag)
    let iv: String          // base64(12-byte nonce)
}

// MARK: - CryptoService

final class CryptoService {

    // Must match the web app's constants.
    private let argon2Iterations:   UInt32 = 3
    private let argon2MemoryKiB:    UInt32 = 65536   // 64 MiB
    private let argon2Parallelism:  UInt32 = 1
    private let argon2KeyLength:    Int    = 32

    // MARK: - Argon2id key derivation (PDK)

    /// Derives a 256-bit symmetric key from `password` and a base64-encoded salt.
    /// This is run off the main thread by the caller — it takes ~0.5–2 s on device.
    func derivePDK(password: String, saltBase64: String) throws -> SymmetricKey {
        guard let saltData = Data(base64Encoded: saltBase64) else {
            throw CryptoError.invalidBase64
        }

        // Argon2id (PHC reference lib, pinned in RouteCareArgon2) — matches web `crypto.ts`.
        let keyData: Data
        do {
            keyData = try deriveArgon2idRaw(
                password: Data(password.utf8),
                salt: saltData,
                iterations: argon2Iterations,
                memoryKiB: argon2MemoryKiB,
                parallelism: argon2Parallelism,
                keyLength: argon2KeyLength
            )
        } catch {
            throw CryptoError.argon2Failed(error)
        }

        guard keyData.count >= argon2KeyLength else { throw CryptoError.invalidKeyLength }
        return SymmetricKey(data: keyData.prefix(argon2KeyLength))
    }

    // MARK: - Key wrapping (envelope = base64(iv || AES-GCM(wrappingKey, rawWK)))

    func unwrapWorkspaceKey(envelope: String, wrappingKey: SymmetricKey) throws -> SymmetricKey {
        guard let combined = Data(base64Encoded: envelope), combined.count > 28 else {
            throw CryptoError.invalidBase64
        }
        let iv             = combined.prefix(12)
        let ciphertextTag  = combined.dropFirst(12)
        guard ciphertextTag.count >= 16 else { throw CryptoError.invalidKeyLength }
        let tag        = ciphertextTag.suffix(16)
        let ciphertext = ciphertextTag.dropLast(16)

        do {
            let nonce     = try AES.GCM.Nonce(data: iv)
            let sealed    = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
            let rawKey    = try AES.GCM.open(sealed, using: wrappingKey)
            return SymmetricKey(data: rawKey)
        } catch {
            throw CryptoError.openFailed(error)
        }
    }

    func wrapWorkspaceKey(_ wk: SymmetricKey, wrappingKey: SymmetricKey) throws -> String {
        let rawWK = wk.withUnsafeBytes { Data($0) }
        do {
            let nonce  = AES.GCM.Nonce()
            let sealed = try AES.GCM.seal(rawWK, using: wrappingKey, nonce: nonce)
            var combined = nonce.withUnsafeBytes { Data($0) }
            combined.append(sealed.ciphertext)
            combined.append(sealed.tag)
            return combined.base64EncodedString()
        } catch {
            throw CryptoError.sealFailed(error)
        }
    }

    // MARK: - Workspace blob encrypt / decrypt

    func encryptWorkspace(_ workspace: Workspace, key: SymmetricKey) throws -> EncryptedBlob {
        let plaintext: Data
        do {
            plaintext = try JSONEncoder().encode(workspace)
        } catch {
            throw CryptoError.encodingFailed(error)
        }

        do {
            let nonce  = AES.GCM.Nonce()
            let sealed = try AES.GCM.seal(plaintext, using: key, nonce: nonce)
            let ivB64  = nonce.withUnsafeBytes { Data($0).base64EncodedString() }
            var ctTag  = sealed.ciphertext
            ctTag.append(sealed.tag)
            return EncryptedBlob(ciphertext: ctTag.base64EncodedString(), iv: ivB64)
        } catch {
            throw CryptoError.sealFailed(error)
        }
    }

    func decryptWorkspace(blob: EncryptedBlob, key: SymmetricKey) throws -> Workspace {
        guard
            let ivData          = Data(base64Encoded: blob.iv),
            let ciphertextTag   = Data(base64Encoded: blob.ciphertext),
            ciphertextTag.count >= 16
        else {
            throw CryptoError.invalidBase64
        }

        let tag        = ciphertextTag.suffix(16)
        let ciphertext = ciphertextTag.dropLast(16)

        let plaintext: Data
        do {
            let nonce  = try AES.GCM.Nonce(data: ivData)
            let sealed = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
            plaintext  = try AES.GCM.open(sealed, using: key)
        } catch {
            throw CryptoError.openFailed(error)
        }

        do {
            return try JSONDecoder().decode(Workspace.self, from: plaintext)
        } catch {
            throw CryptoError.decodingFailed(error)
        }
    }
}
