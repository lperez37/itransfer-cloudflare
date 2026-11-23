package com.vivacityholding.itransfer

import android.net.Uri
import java.io.File
import java.io.InputStream
import java.time.Instant

internal const val MAX_FILES = 100
internal const val PART_SIZE = 50L * 1024 * 1024
internal const val MULTIPART_THRESHOLD = 2 * PART_SIZE
internal const val MAX_FILE_SIZE = 10_000 * PART_SIZE
internal const val MAX_TRANSFER_EXPIRY_DAYS = 3650.0
internal const val MAX_EXACT_JSON_INTEGER = 9_007_199_254_740_991L

internal data class Account(
    val id: String,
    val name: String,
    val email: String,
    val passwordChangeRequired: Boolean,
    val sessionExpiresAt: Instant,
    val role: String,
) {
    val isAdmin: Boolean get() = role == "admin"
}

internal data class WorkspaceTarget(val id: String, val name: String, val email: String)

internal data class WorkspaceAccess(
    val credentials: SessionCredentials,
    val target: WorkspaceTarget? = null,
    val manage: Boolean = false,
) {
    val userId: String get() = target?.id ?: credentials.accountId
    val readOnly: Boolean get() = target != null && !manage
}

internal enum class ShareStatus { AVAILABLE, PAUSED, EXPIRED, LIMIT_REACHED, INACTIVE, UPLOADING }

internal data class Share(
    val id: String,
    val title: String,
    val link: String,
    val fileCount: Int,
    val totalBytes: Long,
    val expiresAt: Instant?,
    val downloads: Long,
    val active: Boolean = true,
    val paused: Boolean = false,
    val maxDownloads: Long? = null,
    val confirmed: Boolean = true,
    val createdAt: Instant? = null,
    val deactivatedAt: Instant? = null,
) {
    val status: ShareStatus
        get() = when {
            !active && !confirmed -> ShareStatus.UPLOADING
            !active && (deactivatedAt == null || expiresAt == null || deactivatedAt.isBefore(expiresAt)) -> ShareStatus.INACTIVE
            expiresAt != null && !expiresAt.isAfter(Instant.now()) -> ShareStatus.EXPIRED
            !active -> ShareStatus.INACTIVE
            paused -> ShareStatus.PAUSED
            maxDownloads != null && downloads >= maxDownloads -> ShareStatus.LIMIT_REACHED
            else -> ShareStatus.AVAILABLE
        }
}

internal data class TransferFile(
    val id: String,
    val name: String,
    val size: Long,
    val mimeType: String,
    val uri: Uri? = null,
    val stagedFile: File? = null,
    val open: () -> InputStream,
)

internal data class ShareOptions(
    val title: String,
    val expiryDays: Double,
    val password: String,
    val maxDownloads: Long? = null,
    val idFormat: String = "random",
    val idLength: Int = 16,
)

internal data class DownloadItem(val name: String, val size: Long, val url: String)

internal class DownloadTask(
    val suggestedName: String,
    val mimeType: String,
    val archive: Boolean,
    val load: suspend () -> List<DownloadItem>,
)

internal enum class UploadPhase { PREPARING, UPLOADING, CONFIRMING }

internal data class UploadProgress(
    val phase: UploadPhase,
    val sentBytes: Long,
    val totalBytes: Long,
    val currentFile: String? = null,
)

internal data class TransferUiState(
    val restoring: Boolean = true,
    val sessionError: String? = null,
    val account: Account? = null,
    val access: WorkspaceAccess? = null,
    val signingIn: Boolean = false,
    val authError: String? = null,
    val shares: List<Share> = emptyList(),
    val refreshing: Boolean = false,
    val sharesError: String? = null,
    val draftOpen: Boolean = false,
    val draftVersion: Int = 0,
    val files: List<TransferFile> = emptyList(),
    val importing: Boolean = false,
    val importError: String? = null,
    val upload: UploadProgress? = null,
    val uploadError: String? = null,
    val completed: Share? = null,
    val publicUrl: String? = null,
    val publicScreen: Boolean = false,
    val workspaceNotice: String? = null,
    val downloading: Boolean = false,
    val downloadNotice: String? = null,
)

internal class TransferException(message: String) : Exception(message)
