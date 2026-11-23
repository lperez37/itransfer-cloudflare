package com.vivacityholding.itransfer

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.time.Instant
import java.time.format.DateTimeParseException

internal enum class WorkspaceKind(val singular: String, val plural: String, val countLabel: String) {
    SHARE("share", "shares", "Downloads"),
    REQUEST("request", "requests", "Uploads"),
}

internal enum class WorkspaceStatus {
    AVAILABLE, PAUSED, UPLOADING, LIMIT_REACHED, EXPIRED, DELETED;

    val inActiveFilter: Boolean get() = this != EXPIRED && this != DELETED
    val showsLink: Boolean get() = inActiveFilter && this != UPLOADING
}

internal data class WorkspaceEntry(
    val kind: WorkspaceKind,
    val id: String,
    val title: String,
    val link: String,
    val fileCount: Int,
    val expiresAt: Instant?,
    val createdAt: Instant?,
    val count: Long,
    val limit: Long?,
    val active: Boolean,
    val totalBytes: Long? = null,
    val paused: Boolean = false,
    val confirmed: Boolean = true,
    val reclaimedAtExpiry: Boolean = false,
    val incremental: Boolean = false,
) {
    val status: WorkspaceStatus
        get() = when {
            !active && !confirmed -> WorkspaceStatus.UPLOADING
            !active -> if (reclaimedAtExpiry) WorkspaceStatus.EXPIRED else WorkspaceStatus.DELETED
            expiresAt?.isAfter(Instant.now()) == false -> WorkspaceStatus.EXPIRED
            paused -> WorkspaceStatus.PAUSED
            limit != null && count >= limit -> WorkspaceStatus.LIMIT_REACHED
            else -> WorkspaceStatus.AVAILABLE
        }

    val canDownload: Boolean get() = active && fileCount > 0
    val countText: String get() = if (limit == null) count.toString() else "$count / $limit"
}

internal fun Share.toWorkspaceEntry() = WorkspaceEntry(
    kind = WorkspaceKind.SHARE,
    id = id,
    title = title.ifBlank { "Untitled share" },
    link = link,
    fileCount = fileCount,
    totalBytes = totalBytes,
    expiresAt = expiresAt,
    createdAt = createdAt,
    count = downloads,
    limit = maxDownloads,
    active = active,
    paused = paused,
    confirmed = confirmed,
    reclaimedAtExpiry = !active && status == ShareStatus.EXPIRED,
)

internal data class WorkspaceFile(
    val id: String,
    val name: String,
    val size: Long?,
    val mimeType: String?,
    val createdAt: Instant?,
)

internal data class WorkspaceDownloadEvent(
    val fileName: String?,
    val time: Instant?,
    val ipAddress: String?,
    val userAgent: String?,
)

internal data class WorkspaceDetail(
    val entry: WorkspaceEntry,
    val files: List<WorkspaceFile>,
    val downloads: List<WorkspaceDownloadEvent> = emptyList(),
    val message: String? = null,
    val maxFileSize: Long? = null,
    val idFormat: String? = null,
)

internal enum class WorkspaceIdFormat(val value: String, val label: String) {
    RANDOM("random", "Random"),
    ANIMALS("animals", "Animal combo"),
}

internal data class WorkspaceRequestOptions(
    val title: String,
    val message: String,
    val expiryDays: Double,
    val password: String,
    val idFormat: WorkspaceIdFormat,
    val idLength: Int,
    val maxUploads: Long?,
    val maxFileSize: Long?,
    val incremental: Boolean,
)

internal class WorkspaceTransferApi(private val api: TransferApi, private val access: WorkspaceAccess) {
    suspend fun requests(): List<WorkspaceEntry> = parse {
        api.readArray("GET", "api/requests", scope = access).mapObjects { row ->
            row.entry(WorkspaceKind.REQUEST, fileCount = row.getInt("file_count"))
        }
    }

    suspend fun detail(kind: WorkspaceKind, id: String, previous: WorkspaceEntry?): WorkspaceDetail = parse {
        val data = api.readObject("GET", path(kind, id), scope = access)
        val files = data.getJSONArray("files").mapObjects { row ->
            WorkspaceFile(
                id = row.getString("id").checkedId(),
                name = row.getString("original_filename"),
                size = row.nullableLong("file_size"),
                mimeType = row.nullableText("content_type"),
                createdAt = row.date("created_at"),
            )
        }
        val downloads = if (kind == WorkspaceKind.SHARE) {
            data.getJSONArray("downloads").mapObjects { row ->
                WorkspaceDownloadEvent(
                    fileName = row.nullableText("original_filename"),
                    time = row.date("downloaded_at"),
                    ipAddress = row.nullableText("ip_address"),
                    userAgent = row.nullableText("user_agent"),
                )
            }
        } else {
            emptyList()
        }
        WorkspaceDetail(
            entry = data.entry(kind, files.size, previous),
            files = files,
            downloads = downloads,
            message = data.nullableText("message"),
            maxFileSize = data.nullableLong("max_file_size"),
            idFormat = data.nullableText("id_format"),
        )
    }

    suspend fun createRequest(options: WorkspaceRequestOptions): String = parse {
        val body = JSONObject()
            .put("title", options.title)
            .put("expiry_days", options.expiryDays)
            .put("id_format", options.idFormat.value)
            .put("allow_incremental", options.incremental)
        if (options.message.isNotEmpty()) body.put("message", options.message)
        if (options.password.isNotEmpty()) body.put("password", options.password)
        if (options.idFormat == WorkspaceIdFormat.RANDOM) body.put("id_length", options.idLength)
        options.maxUploads?.let { body.put("max_uploads", it) }
        options.maxFileSize?.let { body.put("max_file_size", it) }
        val result = api.readObject("POST", "api/requests", body = body, scope = access)
        api.publicLink(result.getString("request_id").checkedId())
    }

    suspend fun setPaused(shareId: String, paused: Boolean): Boolean = parse {
        val body = JSONObject().put("is_paused", paused)
        api.readObject("PATCH", path(WorkspaceKind.SHARE, shareId), body = body, scope = access).getBoolean("is_paused")
    }

    suspend fun changeExpiry(entry: WorkspaceEntry, days: Double): Instant = parse {
        val body = JSONObject().put("expiry_days", days)
        api.readObject("PATCH", path(entry.kind, entry.id), body = body, scope = access).date("expires_at")
            ?: throw unexpectedWorkspaceResponse()
    }

    suspend fun purge(entry: WorkspaceEntry) {
        api.readObject("DELETE", "${path(entry.kind, entry.id)}/purge", scope = access)
    }

    fun downloadAll(entry: WorkspaceEntry, files: List<WorkspaceFile>? = null): DownloadTask {
        val single = files?.singleOrNull()?.takeUnless { entry.incremental }
        return DownloadTask(
            suggestedName = single?.name ?: "${entry.title}.zip",
            mimeType = single?.mimeType?.takeIf(String::isNotBlank)
                ?: if (single == null) "application/zip" else "application/octet-stream",
            archive = single == null,
            load = { signedFiles("${path(entry.kind, entry.id)}/download") },
        )
    }

    fun downloadFile(shareId: String, file: WorkspaceFile): DownloadTask = DownloadTask(
        suggestedName = file.name,
        mimeType = file.mimeType?.takeIf(String::isNotBlank) ?: "application/octet-stream",
        archive = false,
        load = { signedFiles("${path(WorkspaceKind.SHARE, shareId)}/files/${file.id.checkedId()}/download") },
    )

    fun downloadSelected(kind: WorkspaceKind, entries: List<WorkspaceEntry>): DownloadTask = DownloadTask(
        suggestedName = "iTransfer ${kind.plural}.zip",
        mimeType = "application/zip",
        archive = true,
        load = { entries.flatMap { signedFiles("${path(it.kind, it.id)}/download") } },
    )

    private suspend fun signedFiles(path: String): List<DownloadItem> = parse {
        api.downloadItems(api.readObject("POST", path, scope = access))
    }

    private fun JSONObject.entry(
        kind: WorkspaceKind,
        fileCount: Int,
        previous: WorkspaceEntry? = null,
    ): WorkspaceEntry {
        val id = getString("id").checkedId()
        val expiry = date("expires_at")
        val deactivated = date("deactivated_at")
        val reclaimed = if (deactivated != null && expiry != null) {
            !deactivated.isBefore(expiry)
        } else {
            // Request detail omits deactivated_at; retain the list's historical status.
            previous?.reclaimedAtExpiry == true
        }
        val share = kind == WorkspaceKind.SHARE
        return WorkspaceEntry(
            kind = kind,
            id = id,
            title = nullableText("title")?.takeIf(String::isNotBlank) ?: "Untitled ${kind.singular}",
            link = api.publicLink(id),
            fileCount = fileCount,
            totalBytes = nullableLong("total_size"),
            expiresAt = expiry,
            createdAt = date("created_at"),
            count = getLong(if (share) "download_count" else "upload_count"),
            limit = nullableLong(if (share) "max_downloads" else "max_uploads"),
            active = getBoolean("is_active"),
            paused = optBoolean("is_paused"),
            confirmed = !share || !isNull("confirmed_at"),
            reclaimedAtExpiry = reclaimed,
            incremental = optBoolean("allow_incremental"),
        )
    }

    private fun path(kind: WorkspaceKind, id: String) = "api/${kind.plural}/${id.checkedId()}"
}

private fun String.checkedId(): String {
    if (!identifierPattern.matches(this)) throw unexpectedWorkspaceResponse()
    return this
}

private fun JSONObject.nullableText(key: String): String? = if (isNull(key)) null else getString(key)

private fun JSONObject.nullableLong(key: String): Long? = if (isNull(key)) null else getLong(key)

private fun JSONObject.date(key: String): Instant? = nullableText(key)?.let(::serverInstant)

private inline fun <T> JSONArray.mapObjects(transform: (JSONObject) -> T): List<T> =
    List(length()) { index -> transform(getJSONObject(index)) }

private inline fun <T> parse(read: () -> T): T = try {
    read()
} catch (_: JSONException) {
    throw unexpectedWorkspaceResponse()
} catch (_: DateTimeParseException) {
    throw unexpectedWorkspaceResponse()
}

private fun unexpectedWorkspaceResponse() = TransferException("The iTransfer server returned an unexpected response.")
