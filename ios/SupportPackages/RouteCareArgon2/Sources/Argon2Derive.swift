import Foundation
import argon2

public enum RouteCareArgon2Error: Error, Sendable {
    case saltTooShort
    case derivationFailed(code: Int32)
}

/// Derives raw bytes with Argon2id (RFC 9106), matching typical web `argon2id` settings.
public func deriveArgon2idRaw(
    password: Data,
    salt: Data,
    iterations: UInt32,
    memoryKiB: UInt32,
    parallelism: UInt32,
    keyLength: Int
) throws -> Data {
    guard salt.count >= 8 else {
        throw RouteCareArgon2Error.saltTooShort
    }
    var output = [UInt8](repeating: 0, count: keyLength)
    let code: Int32 = password.withUnsafeBytes { pwdBuf in
        salt.withUnsafeBytes { saltBuf in
            guard let pwdBase = pwdBuf.bindMemory(to: UInt8.self).baseAddress,
                  let saltBase = saltBuf.bindMemory(to: UInt8.self).baseAddress
            else {
                return Int32(ARGON2_PWD_TOO_SHORT.rawValue)
            }
            return argon2id_hash_raw(
                iterations,
                memoryKiB,
                parallelism,
                pwdBase,
                password.count,
                saltBase,
                salt.count,
                &output,
                keyLength
            )
        }
    }
    guard code == Int32(ARGON2_OK.rawValue) else {
        throw RouteCareArgon2Error.derivationFailed(code: code)
    }
    return Data(output)
}
