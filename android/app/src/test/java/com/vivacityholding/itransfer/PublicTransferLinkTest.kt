package com.vivacityholding.itransfer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PublicTransferLinkTest {
    private val server = "https://files.example.test"

    @Test
    fun acceptsConfiguredOriginAndKeepsIdCase() {
        val link = parsePublicLink(" HTTPS://FILES.EXAMPLE.TEST:443/Fox_Cat-123 \n", server)
        assertEquals("Fox_Cat-123", (link as? PublicLinkTarget.Transfer)?.id)
    }

    @Test
    fun limitsAliasesToTheConfiguredDeployment() {
        val alias = "files-alt.example.test"
        val aliases = setOf(alias)
        assertEquals("share-id", (parsePublicLink("https://$alias/share-id", server, aliases) as? PublicLinkTarget.Transfer)?.id)
        assertNull(parsePublicLink("https://$alias/share-id", server))
        assertNull(parsePublicLink("https://$alias/share-id", "$server:8443", aliases))

        val debug = "http://10.0.2.2:14587"
        val localLink = parsePublicLink("http://localhost:14587/request-id", debug)
        assertEquals("request-id", (localLink as? PublicLinkTarget.Transfer)?.id)
        assertNull(parsePublicLink("http://localhost:8000/request-id", debug))
        assertNull(parsePublicLink("$server/share-id", debug, aliases))
    }

    @Test
    fun rejectsUrlsWithAnyExtraPathOrOriginComponents() {
        val invalid = listOf(
            "share-id",
            "//files.example.test/share-id",
            "http://files.example.test/share-id",
            "https://files.example.test:444/share-id",
            "https://files.example.test.other.test/share-id",
            "https://files.example.test@other.test/share-id",
            "https://user@files.example.test/share-id",
            "https://@files.example.test/share-id",
            "$server/",
            "$server/share-id/",
            "$server/share-id/next",
            "$server//share-id",
            "$server/folder/../share-id",
            "$server/%2e%2e/share-id",
            "$server/share%2Fid",
            "$server/share%5Cid",
            "$server/share-id?password=value",
            "$server/share-id#token=value",
        )
        invalid.forEach { assertNull(it, parsePublicLink(it, server)) }
    }

    @Test
    fun acceptsOnlyACompletePasswordSetupFragment() {
        val token = "a1".repeat(32)
        val setup = parsePublicLink("$server/set-password#token=$token", server)
        assertEquals(token, (setup as? PublicLinkTarget.PasswordSetup)?.token)

        val invalid = listOf(
            "$server/set-password",
            "$server/set-password?token=$token",
            "$server/set-password/#token=$token",
            "$server/set-password#token=short",
            "$server/set-password#token=${"x".repeat(64)}",
            "$server/set-password#token=$token&token=$token",
            "$server/set-password?next=another#token=$token",
            "https://other.test/set-password#token=$token",
        )
        invalid.forEach { assertNull(it, parsePublicLink(it, server)) }
    }
}
