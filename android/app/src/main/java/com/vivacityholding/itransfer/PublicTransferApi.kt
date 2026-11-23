package com.vivacityholding.itransfer

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.net.URI
import java.net.URISyntaxException
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.Locale

internal const val MAX_PUBLIC_LINK_LENGTH = 2048

internal sealed interface PublicLinkTarget {
    class Transfer(val id: String) : PublicLinkTarget
    class PasswordSetup(val token: String) : PublicLinkTarget
}

private val localHostAliases = setOf("10.0.2.2", "127.0.0.1", "localhost")

internal fun parsePublicLink(
    raw: String,
    serverOrigin: String = BuildConfig.SERVER_ORIGIN,
    publicLinkAliases: Set<String> = emptySet(),
): PublicLinkTarget? {
    if (raw.length > MAX_PUBLIC_LINK_LENGTH) return null
    val link = parsePublicUri(raw.trim()) ?: return null
    val server = parsePublicUri(serverOrigin) ?: return null
    val scheme = link.scheme?.lowercase(Locale.ROOT)
    if (link.rawUserInfo != null || link.rawQuery != null || scheme !in setOf("https", "http") ||
        !link.scheme.equals(server.scheme, ignoreCase = true) || link.effectivePort() != server.effectivePort()
    ) return null

    val host = link.host?.lowercase(Locale.ROOT) ?: return null
    val serverHost = server.host?.lowercase(Locale.ROOT) ?: return null
    val aliases = when {
        scheme == "https" && server.effectivePort() == 443 -> publicLinkAliases + serverHost
        scheme == "http" && serverHost in localHostAliases -> localHostAliases
        else -> setOf(serverHost)
    }
    if (host !in aliases) return null

    val path = link.rawPath ?: return null
    if (path == "/set-password") {
        val fragment = link.rawFragment ?: return null
        if (!fragment.startsWith("token=")) return null
        val token = fragment.removePrefix("token=")
        return token.takeIf(sessionTokenPattern::matches)?.let { PublicLinkTarget.PasswordSetup(it) }
    }
    if (link.rawFragment != null || !path.startsWith('/')) return null
    val id = path.substring(1)
    return id.takeIf(identifierPattern::matches)?.let { PublicLinkTarget.Transfer(it) }
}

private fun parsePublicUri(value: String): URI? = try {
    URI(value).parseServerAuthority()
} catch (_: URISyntaxException) {
    null
}

private fun URI.effectivePort(): Int = if (port != -1) port else if (scheme.equals("https", true)) 443 else 80

internal data class PublicTransferFile(val id: String, val name: String, val size: Long?, val mimeType: String?)

internal sealed interface PublicTransfer {
    data class Share(
        val id: String,
        val title: String?,
        val expiresAt: Instant?,
        val passwordRequired: Boolean,
        val downloadsRemaining: Long?,
        val fileCount: Int,
        val files: List<PublicTransferFile>,
    ) : PublicTransfer

    data class Request(
        val id: String,
        val title: String,
        val message: String?,
        val expiresAt: Instant?,
        val passwordRequired: Boolean,
        val uploadsRemaining: Long?,
        val maxFileSize: Long?,
        val allowIncremental: Boolean,
        val files: List<PublicTransferFile>,
    ) : PublicTransfer
}

internal class PublicTransferApi(private val api: TransferApi) {
    private val aliases = BuildConfig.PUBLIC_LINK_ALIASES.split(',')
        .filter(String::isNotBlank).map { it.lowercase(Locale.ROOT) }.toSet()

    fun parseLink(raw: String): PublicLinkTarget? = parsePublicLink(raw, api.publicLink("link"), aliases)

    suspend fun resolve(id: String): PublicTransfer {
        val share = try {
            api.readObject("GET", endpoint("shares", id))
        } catch (error: ApiException) {
            if (error.status != 404) throw error
            return request(id)
        }
        return decodePublicResponse {
            share.checkId(id)
            val protected = share.getBoolean("password_required")
            PublicTransfer.Share(
                id = id,
                title = share.stringOrNull("title"),
                expiresAt = share.expiry(),
                passwordRequired = protected,
                downloadsRemaining = share.nonNegativeLong("downloads_remaining"),
                fileCount = share.getInt("file_count").also { if (it < 0) throw invalidPublicResponse() },
                files = if (protected) emptyList() else share.files(),
            )
        }
    }

    suspend fun request(id: String): PublicTransfer.Request {
        val data = api.readObject("GET", endpoint("requests", id))
        return decodePublicResponse {
            data.checkId(id)
            val incremental = data.getBoolean("allow_incremental")
            PublicTransfer.Request(
                id = id,
                title = data.getString("title"),
                message = data.stringOrNull("message"),
                expiresAt = data.expiry(),
                passwordRequired = data.getBoolean("password_required"),
                uploadsRemaining = data.nonNegativeLong("remaining_uploads"),
                maxFileSize = data.nonNegativeLong("max_file_size"),
                allowIncremental = incremental,
                files = if (incremental) data.files() else emptyList(),
            )
        }
    }

    suspend fun unlock(id: String, password: String): List<PublicTransferFile> {
        val data = api.readObject("POST", endpoint("shares", id, "/unlock"), body = JSONObject().put("password", password))
        return decodePublicResponse { data.files() }
    }

    suspend fun download(id: String, password: String?): List<DownloadItem> {
        val body = JSONObject().apply { if (password != null) put("password", password) }
        val data = api.readObject("POST", endpoint("shares", id, "/download"), body = body)
        return decodePublicResponse { api.downloadItems(data) }
    }

    suspend fun prepareUpload(id: String, files: List<TransferFile>, message: String, password: String): UploadPlan {
        val body = JSONObject().put("files", api.fileMetadata(files)).apply {
            if (message.isNotEmpty()) put("message", message)
            if (password.isNotEmpty()) put("password", password)
        }
        val data = api.readObject("POST", endpoint("requests", id, "/upload"), body = body)
        return decodePublicResponse {
            val plan = api.decodeUploadPlan(id, data, files)
            if (plan.files.distinctBy(UploadDestination::fileId).size != files.size) throw invalidPublicResponse()
            plan
        }
    }

    suspend fun completeMultipart(id: String, file: UploadDestination, etags: Map<Int, String>) {
        val multipart = file.multipart ?: throw invalidPublicResponse()
        val parts = JSONArray()
        for ((number, etag) in etags.toSortedMap()) {
            parts.put(JSONObject().put("part_number", number).put("etag", etag))
        }
        val body = JSONObject().put("file_id", file.fileId).put("upload_id", multipart.uploadId).put("parts", parts)
        api.readObject("POST", endpoint("requests", id, "/complete-multipart"), body = body)
    }

    suspend fun confirmUpload(id: String, plan: UploadPlan, message: String) {
        val fileIds = JSONArray(plan.files.map(UploadDestination::fileId))
        val body = JSONObject().put("file_ids", fileIds).apply { if (message.isNotEmpty()) put("message", message) }
        api.readObject("POST", endpoint("requests", id, "/confirm"), body = body)
    }

    private fun endpoint(kind: String, id: String, action: String = ""): String {
        require(identifierPattern.matches(id))
        return "api/public/$kind/$id$action"
    }
}

private fun JSONObject.checkId(id: String) {
    if (getString("id") != id) throw invalidPublicResponse()
}

private fun JSONObject.stringOrNull(name: String): String? = if (isNull(name)) null else getString(name)

private fun JSONObject.nonNegativeLong(name: String): Long? = if (isNull(name)) null else getLong(name).also {
    if (it < 0) throw invalidPublicResponse()
}

private fun JSONObject.expiry(): Instant? = stringOrNull("expires_at")?.let(::serverInstant)

private fun JSONObject.files(): List<PublicTransferFile> {
    val array = getJSONArray("files")
    val files = List(array.length()) { index ->
        val file = array.getJSONObject(index)
        val id = file.getString("id")
        val filename = file.stringOrNull("original_filename")
        if (!identifierPattern.matches(id) || filename.isNullOrEmpty()) throw invalidPublicResponse()
        PublicTransferFile(id, filename, file.nonNegativeLong("file_size"), file.stringOrNull("content_type"))
    }
    if (files.distinctBy(PublicTransferFile::id).size != files.size) throw invalidPublicResponse()
    return files
}

private inline fun <T> decodePublicResponse(block: () -> T): T = try {
    block()
} catch (_: JSONException) {
    throw invalidPublicResponse()
} catch (_: DateTimeParseException) {
    throw invalidPublicResponse()
}

private fun invalidPublicResponse() = TransferException("The iTransfer server returned an unexpected response.")
