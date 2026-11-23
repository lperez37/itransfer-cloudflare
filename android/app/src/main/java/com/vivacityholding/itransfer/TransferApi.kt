package com.vivacityholding.itransfer

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Cookie
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener
import java.io.IOException
import java.io.InterruptedIOException
import java.io.OutputStream
import java.time.Instant
import java.time.format.DateTimeParseException
import java.util.concurrent.TimeUnit

internal class ApiException(val status: Int, message: String, val code: String? = null) : Exception(message)

internal class StorageException(val status: Int) : Exception(
    when (status) {
        401, 403 -> "The upload link expired or storage denied access. Try again for a fresh link."
        else -> "File storage returned an error (HTTP $status)."
    }
)

private val jsonType = "application/json; charset=utf-8".toMediaType()

internal data class UploadPlan(val shareId: String, val files: List<UploadDestination>)
internal data class UploadDestination(val fileId: String, val url: String?, val multipart: MultipartDestination?)
internal data class MultipartDestination(val uploadId: String, val parts: List<UploadPart>)
internal data class UploadPart(val number: Int, val url: String)

internal class TransferApi(serverOrigin: String = BuildConfig.SERVER_ORIGIN) {
    private val origin = serverOrigin.toHttpUrl()
    private val originHeader = origin.toString().removeSuffix("/")
    private val localTest = BuildConfig.DEBUG && !origin.isHttps &&
        origin.host in setOf("10.0.2.2", "127.0.0.1", "localhost")
    private val client = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        // Allow fresh connections when a pooled socket has died. One-shot
        // bodies prevent OkHttp from replaying a mutation after sending it.
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(45, TimeUnit.SECONDS)
        .build()

    init {
        require(origin.isHttps || localTest)
    }

    suspend fun signIn(email: String, password: String): AccountSession {
        val challenge = readObject(
            "POST", "api/auth/password-challenge", body = JSONObject().put("email", email),
        )
        val proof = withContext(Dispatchers.Default) {
            passwordProof(password, challenge.getString("salt"), challenge.getInt("iterations"))
        }
        val body = JSONObject().put("email", email).put("proof", proof)
        if (challenge.getBoolean("bootstrap")) body.put("bootstrap_password", password)
        val request = apiRequest("POST", "api/auth/login", body = body)
        return client.call(request, 45) { response ->
            val data = response.jsonObject()
            val cookie = Cookie.parseAll(origin, response.headers).singleOrNull { it.name == SESSION_COOKIE }
            if (cookie == null || !cookie.hostOnly || cookie.domain != origin.host || cookie.path != "/" ||
                !cookie.httpOnly || !cookie.persistent || (!cookie.secure && !localTest) ||
                !sessionTokenPattern.matches(cookie.value) || cookie.expiresAt <= System.currentTimeMillis()
            ) {
                throw TransferException("iTransfer did not return a valid sign-in session.")
            }
            val account = data.toAccount(cookie.expiresAt)
            AccountSession(account, SessionCredentials(cookie.value, account.id, cookie.expiresAt))
        }
    }

    suspend fun restore(session: SessionCredentials): AccountSession {
        val account = readObject("GET", "api/auth/me", session).toAccount(session.expiresAt)
        if (account.id != session.accountId) throw ApiException(401, "Your signed-in account changed.")
        return AccountSession(account, session)
    }

    suspend fun signOut(session: SessionCredentials) {
        readObject("POST", "api/auth/logout", session)
    }

    suspend fun listShares(scope: WorkspaceAccess): List<Share> {
        val request = apiRequest("GET", "api/shares", scope = scope)
        return client.call(request, 45) { response ->
            val rows = response.jsonValue() as? JSONArray ?: throw unexpectedResponse()
            List(rows.length()) { index ->
                val row = rows.getJSONObject(index)
                val id = row.getString("id")
                if (!identifierPattern.matches(id)) throw unexpectedResponse()
                Share(
                    id = id,
                    title = row.optionalString("title")?.takeIf(String::isNotBlank) ?: id,
                    link = publicLink(id),
                    fileCount = row.getInt("file_count"),
                    totalBytes = row.getLong("total_size"),
                    expiresAt = row.optionalString("expires_at")?.let(::serverInstant),
                    downloads = row.getLong("download_count"),
                    active = row.getBoolean("is_active"),
                    paused = row.getBoolean("is_paused"),
                    maxDownloads = if (row.isNull("max_downloads")) null else row.getLong("max_downloads"),
                    confirmed = !row.isNull("confirmed_at"),
                    createdAt = row.optionalString("created_at")?.let(::serverInstant),
                    deactivatedAt = row.optionalString("deactivated_at")?.let(::serverInstant),
                )
            }
        }
    }

    suspend fun initialize(
        scope: WorkspaceAccess,
        files: List<TransferFile>,
        options: ShareOptions,
    ): UploadPlan {
        val body = JSONObject()
            .put("files", fileMetadata(files))
            .put("expiry_days", options.expiryDays)
            .put("id_format", options.idFormat)
        if (options.idFormat == "random") body.put("id_length", options.idLength)
        options.maxDownloads?.let { body.put("max_downloads", it) }
        if (options.title.isNotBlank()) body.put("title", options.title.trim())
        if (options.password.isNotEmpty()) body.put("password", options.password)
        val json = readObject("POST", "api/shares/init", body = body, scope = scope)
        return decodeUploadPlan(json.getString("share_id"), json, files)
    }

    fun fileMetadata(files: List<TransferFile>): JSONArray = JSONArray().apply {
        for (file in files) {
            put(JSONObject().put("filename", file.name).put("size", file.size).put("content_type", file.mimeType))
        }
    }

    fun decodeUploadPlan(id: String, json: JSONObject, files: List<TransferFile>): UploadPlan {
        val destinations = json.getJSONArray("files")
        if (!identifierPattern.matches(id) || destinations.length() != files.size) throw unexpectedResponse()
        return UploadPlan(id, files.mapIndexed { index, file -> destinations.getJSONObject(index).destination(file) })
    }

    suspend fun completeMultipart(
        scope: WorkspaceAccess,
        shareId: String,
        fileId: String,
        uploadId: String,
        etags: Map<Int, String>,
    ) {
        val parts = JSONArray()
        for ((number, etag) in etags.toSortedMap()) {
            parts.put(JSONObject().put("part_number", number).put("etag", etag))
        }
        val body = JSONObject().put("file_id", fileId).put("upload_id", uploadId).put("parts", parts)
        readObject("POST", "api/shares/$shareId/complete-multipart", body = body, scope = scope)
    }

    suspend fun confirm(scope: WorkspaceAccess, shareId: String) {
        readObject("POST", "api/shares/$shareId/confirm", scope = scope)
    }

    suspend fun put(url: String, body: RequestBody): String? {
        // Storage requests never receive account cookies or API headers.
        val request = Request.Builder().url(storageUrl(url)).put(body).build()
        return client.call(request) { response ->
            if (!response.isSuccessful) throw StorageException(response.code)
            response.header("ETag")?.takeIf(String::isNotBlank)
        }
    }

    fun publicLink(shareId: String): String = origin.newBuilder().addPathSegment(shareId).build().toString()

    fun downloadItems(json: JSONObject): List<DownloadItem> {
        val files = json.getJSONArray("files")
        return List(files.length()) { index ->
            val file = files.getJSONObject(index)
            val url = file.getString("download_url")
            storageUrl(url)
            DownloadItem(file.getString("filename"), file.getLong("size"), url)
        }
    }

    suspend fun streamDownload(item: DownloadItem, output: OutputStream) {
        val coroutine = currentCoroutineContext()
        val request = Request.Builder().url(storageUrl(item.url)).header("Accept-Encoding", "identity").build()
        client.call(request) { response ->
            if (response.code != 200) throw StorageException(response.code)
            val body = response.body ?: throw unexpectedResponse()
            val buffer = ByteArray(64 * 1024)
            var received = 0L
            body.byteStream().use { input ->
                while (true) {
                    if (!coroutine.isActive) throw InterruptedIOException("Download cancelled")
                    val count = input.read(buffer)
                    if (count < 0) break
                    received += count
                    if (received > item.size) throw TransferException("The file did not match its expected size.")
                    output.write(buffer, 0, count)
                }
            }
            if (received != item.size) throw TransferException("The file did not match its expected size.")
        }
    }

    private fun JSONObject.destination(file: TransferFile): UploadDestination {
        val fileId = getString("file_id")
        if (!identifierPattern.matches(fileId)) throw unexpectedResponse()
        val url = optionalString("upload_url")
        val multipart = optJSONObject("multipart")
        if (file.size <= MULTIPART_THRESHOLD) {
            if (url == null || multipart != null) throw unexpectedResponse()
            storageUrl(url)
            return UploadDestination(fileId, url, null)
        }
        if (multipart == null || url != null) throw unexpectedResponse()
        val uploadId = multipart.getString("upload_id")
        val parts = multipart.getJSONArray("parts")
        val partCount = ((file.size + PART_SIZE - 1) / PART_SIZE).toInt()
        if (uploadId.isBlank() || parts.length() != partCount) throw unexpectedResponse()
        val plan = List(parts.length()) { index ->
            val part = parts.getJSONObject(index)
            val uploadUrl = part.getString("upload_url")
            storageUrl(uploadUrl)
            UploadPart(part.getInt("part_number"), uploadUrl)
        }.sortedBy(UploadPart::number)
        if (plan.withIndex().any { (index, part) -> part.number != index + 1 }) throw unexpectedResponse()
        return UploadDestination(fileId, null, MultipartDestination(uploadId, plan))
    }

    private fun storageUrl(raw: String): HttpUrl {
        val url = raw.toHttpUrlOrNull() ?: throw unexpectedResponse()
        val isR2 = url.isHttps && url.port == 443 && url.host.endsWith(".r2.cloudflarestorage.com")
        val isLocal = localTest && url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
        if ((!isR2 && !isLocal) || url.username.isNotEmpty() || url.password.isNotEmpty() || url.fragment != null) {
            throw TransferException("The server returned an invalid storage destination.")
        }
        return url
    }

    suspend fun readObject(
        method: String,
        path: String,
        session: SessionCredentials? = null,
        body: JSONObject? = null,
        workspace: Boolean = false,
        scope: WorkspaceAccess? = null,
    ): JSONObject = client.call(apiRequest(method, path, session, body, workspace, scope), 45) { it.jsonObject() }

    suspend fun readArray(
        method: String,
        path: String,
        session: SessionCredentials? = null,
        body: JSONObject? = null,
        workspace: Boolean = false,
        scope: WorkspaceAccess? = null,
    ): JSONArray = client.call(apiRequest(method, path, session, body, workspace, scope), 45) {
        it.jsonValue() as? JSONArray ?: throw unexpectedResponse()
    }

    private fun apiRequest(
        method: String,
        path: String,
        session: SessionCredentials? = null,
        body: JSONObject? = null,
        workspace: Boolean = false,
        scope: WorkspaceAccess? = null,
    ): Request = Request.Builder()
        .url(origin.newBuilder().addPathSegments(path).build())
        .header("Accept", "application/json")
        .apply {
            if (method != "GET") header("Origin", originHeader)
            val credentials = scope?.credentials ?: session
            if (credentials != null) {
                header("Cookie", "$SESSION_COOKIE=${credentials.token}")
                header("X-Expected-User", credentials.accountId)
                if (scope != null) {
                    header("X-Workspace-User", scope.userId)
                    if (scope.target != null && scope.manage) header("X-Workspace-Mode", "manage")
                } else if (workspace) {
                    header("X-Workspace-User", credentials.accountId)
                }
            }
        }
        .method(method, if (method == "GET") null else JsonWriteBody(body))
        .build()
}

private class JsonWriteBody(body: JSONObject?) : RequestBody() {
    private val bytes = (body?.toString() ?: "{}").toByteArray(Charsets.UTF_8)

    override fun contentType() = jsonType
    override fun contentLength() = bytes.size.toLong()
    override fun isOneShot() = true
    override fun writeTo(sink: BufferedSink) {
        sink.write(bytes)
    }
}

private fun JSONObject.toAccount(expiresAt: Long): Account {
    val id = getString("id")
    if (!identifierPattern.matches(id)) throw unexpectedResponse()
    return Account(
        id, getString("name"), getString("email"), getBoolean("password_change_required"),
        Instant.ofEpochMilli(expiresAt), getString("role"),
    )
}

private fun JSONObject.optionalString(name: String): String? = if (isNull(name)) null else getString(name)

private fun Response.jsonObject(): JSONObject = jsonValue() as? JSONObject ?: throw unexpectedResponse()

private fun Response.jsonValue(): Any {
    val raw = body?.string().orEmpty()
    if (!isSuccessful) {
        val detail = try {
            JSONObject(raw).optString("detail").trim().take(240)
        } catch (_: JSONException) {
            ""
        }
        val message = when (code) {
            429 -> "Too many attempts. Wait a moment and try again."
            in 500..599 -> "iTransfer is temporarily unavailable (HTTP $code)."
            else -> detail.ifBlank { "iTransfer returned an error (HTTP $code)." }
        }
        val reason = when {
            header("X-Reauth-Required") == "1" -> "REAUTH_REQUIRED"
            header("X-Identity-Mismatch") == "1" -> "IDENTITY_MISMATCH"
            header("X-Password-Change-Required") == "1" -> "PASSWORD_CHANGE_REQUIRED"
            else -> null
        }
        throw ApiException(code, message, reason)
    }
    return JSONTokener(raw).nextValue()
}

private fun unexpectedResponse() = TransferException("The iTransfer server returned an unexpected response.")

// Legacy rows can carry SQLite timestamps. Current writes include an explicit UTC offset.
internal fun serverInstant(value: String): Instant = try {
    Instant.parse(value)
} catch (_: DateTimeParseException) {
    java.time.LocalDateTime.parse(value.replace(' ', 'T')).toInstant(java.time.ZoneOffset.UTC)
}

private suspend fun <T> OkHttpClient.call(
    request: Request,
    timeoutSeconds: Long = 0,
    read: (Response) -> T,
): T = suspendCancellableCoroutine { continuation ->
    val call = newCall(request)
    if (timeoutSeconds > 0) call.timeout().timeout(timeoutSeconds, TimeUnit.SECONDS)
    continuation.invokeOnCancellation { call.cancel() }
    call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
            continuation.resumeWith(Result.failure(e))
        }

        override fun onResponse(call: Call, response: Response) {
            val result = runCatching { response.use(read) }.recoverCatching { error ->
                if (error is JSONException || error is DateTimeParseException) throw unexpectedResponse()
                throw error
            }
            continuation.resumeWith(result)
        }
    })
}
