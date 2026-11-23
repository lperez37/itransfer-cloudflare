package com.vivacityholding.itransfer

import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

internal const val PASSWORD_ITERATIONS = 600_000
private val challengeSalt = Regex("[0-9a-fA-F]{32}")
private const val HEX = "0123456789abcdef"

internal fun passwordProof(password: String, saltHex: String, iterations: Int): String {
    if (iterations != PASSWORD_ITERATIONS || !challengeSalt.matches(saltHex)) {
        throw TransferException("The server returned an unsupported sign-in challenge.")
    }
    val salt = ByteArray(16) { saltHex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    val chars = password.toCharArray()
    val spec = PBEKeySpec(chars, salt, PASSWORD_ITERATIONS, 256)
    chars.fill('\u0000')
    salt.fill(0)
    try {
        val proof = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        try {
            return buildString(proof.size * 2) {
                for (byte in proof) {
                    val value = byte.toInt() and 0xff
                    append(HEX[value ushr 4])
                    append(HEX[value and 0xf])
                }
            }
        } finally {
            proof.fill(0)
        }
    } finally {
        spec.clearPassword()
    }
}
