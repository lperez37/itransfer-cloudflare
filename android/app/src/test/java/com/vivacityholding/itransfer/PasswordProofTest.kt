package com.vivacityholding.itransfer

import org.junit.Assert.assertEquals
import org.junit.Test

class PasswordProofTest {
    @Test
    fun matchesTheWebProtocolForUnicodePasswords() {
        assertEquals(
            "8597d009d8e3d95112da2adb430860a6f2128877ea84a480bb1d6a28b243d8a0",
            passwordProof("naïve 🔑 café", "0123456789abcdef0011223344556677", 600000),
        )
    }

    @Test(expected = TransferException::class)
    fun rejectsUnexpectedChallengeIterations() {
        passwordProof("unused", "0123456789abcdef0011223344556677", 1)
    }
}
