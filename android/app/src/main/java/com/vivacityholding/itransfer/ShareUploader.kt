package com.vivacityholding.itransfer

import android.os.SystemClock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody
import okio.BufferedSink
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.io.OutputStream
import java.security.MessageDigest
import kotlin.coroutines.CoroutineContext

private const val BUFFER_SIZE = 64 * 1024
private const val PUT_REUSE_WINDOW_MS = 55 * 60 * 1000L

internal class PendingUpload(
    val plan: UploadPlan,
    val accountId: String,
    val fileIds: List<String>,
    val options: ShareOptions,
    private val startedAt: Long = SystemClock.elapsedRealtime(),
) {
    val files = plan.files.map { FileUpload() }

    fun matches(account: String, ids: List<String>, options: ShareOptions): Boolean =
        account == accountId && ids == fileIds && options == this.options &&
            (files.all { it.bytesSent } || SystemClock.elapsedRealtime() - startedAt < PUT_REUSE_WINDOW_MS)

    class FileUpload {
        val parts = mutableMapOf<Int, PartReceipt>()
        var bytesSent = false
        var finished = false
    }

    class PartReceipt(val etag: String, val digest: ByteArray)
}

internal class ShareUploader(
    private val api: TransferApi,
    private val temporaryFile: () -> File,
) {
    suspend fun upload(
        scope: WorkspaceAccess,
        attempt: PendingUpload,
        files: List<TransferFile>,
        progress: (UploadProgress) -> Unit,
    ): Share {
        val id = attempt.plan.shareId
        uploadFiles(
            attempt, files,
            complete = { destination, etags ->
                api.completeMultipart(scope, id, destination.fileId, checkNotNull(destination.multipart).uploadId, etags)
            },
            confirm = { api.confirm(scope, id) },
            progress = progress,
        )
        return Share(
            id = id,
            title = attempt.options.title.trim().ifBlank { if (files.size == 1) files.single().name else "Shared files" },
            link = api.publicLink(id),
            fileCount = files.size,
            totalBytes = files.sumOf(TransferFile::size),
            expiresAt = null,
            downloads = 0,
            maxDownloads = attempt.options.maxDownloads,
        )
    }

    suspend fun uploadFiles(
        attempt: PendingUpload,
        files: List<TransferFile>,
        complete: suspend (UploadDestination, Map<Int, String>) -> Unit,
        confirm: suspend () -> Unit,
        progress: (UploadProgress) -> Unit,
    ) = withContext(Dispatchers.IO) {
        val reporter = ProgressReporter(files.sumOf(TransferFile::size), progress)
        val coroutine = currentCoroutineContext()
        var previousBytes = 0L

        for ((index, file) in files.withIndex()) {
            coroutine.ensureActive()
            val state = attempt.files[index]
            val destination = attempt.plan.files[index]
            val multipart = destination.multipart
            if (!state.finished) {
                reporter.sending(previousBytes, file.name, force = true)
                if (multipart == null) {
                    retry { api.put(checkNotNull(destination.url), file.requestBody(coroutine) { bytes ->
                        reporter.sending(previousBytes + bytes, file.name)
                    }) }
                    state.bytesSent = true
                    state.finished = true
                } else {
                    if (!state.bytesSent) {
                        sendParts(file, multipart, state, previousBytes, reporter, coroutine)
                        state.bytesSent = true
                    }
                    try {
                        complete(destination, state.parts.mapValues { (_, part) -> part.etag })
                        state.finished = true
                    } catch (error: Exception) {
                        // A lost response may mean R2 already stitched this file.
                        // Final confirmation checks every object before activating the share.
                        if (!error.isTransient()) throw error
                    }
                }
            }
            previousBytes += file.size
            reporter.sending(previousBytes, file.name, force = true)
        }

        reporter.confirming()
        retry { confirm() }
    }

    private suspend fun sendParts(
        file: TransferFile,
        destination: MultipartDestination,
        state: PendingUpload.FileUpload,
        previousBytes: Long,
        reporter: ProgressReporter,
        coroutine: CoroutineContext,
    ) {
        file.openReadable().use { source ->
            var offset = 0L
            for (part in destination.parts) {
                coroutine.ensureActive()
                val length = minOf(PART_SIZE, file.size - offset)
                val receipt = state.parts[part.number]
                if (receipt != null) {
                    val digest = source.copyPart(length, null, file.name, coroutine)
                    if (!digest.contentEquals(receipt.digest)) throw changedFile(file.name)
                } else {
                    val piece = temporaryFile()
                    try {
                        val digest = piece.outputStream().buffered().use { output ->
                            source.copyPart(length, output, file.name, coroutine)
                        }
                        if (part.number == destination.parts.size) source.checkEnd(file.name)
                        val etag = retry {
                            val body = ExactBody(length, null, piece::inputStream, file.name, coroutine) { bytes ->
                                reporter.sending(previousBytes + offset + bytes, file.name)
                            }
                            api.put(part.url, body) ?: throw TransferException("Storage did not acknowledge an upload part.")
                        }
                        state.parts[part.number] = PendingUpload.PartReceipt(etag, digest)
                    } finally {
                        piece.delete()
                    }
                }
                offset += length
                reporter.sending(previousBytes + offset, file.name, force = true)
            }
        }
    }
}

private class ProgressReporter(
    private val total: Long,
    private val publish: (UploadProgress) -> Unit,
) {
    private var lastUpdate = 0L

    @Synchronized
    fun sending(bytes: Long, file: String, force: Boolean = false) {
        val now = SystemClock.elapsedRealtime()
        if (force || now - lastUpdate >= 100) {
            lastUpdate = now
            publish(UploadProgress(UploadPhase.UPLOADING, bytes, total, file))
        }
    }

    fun confirming() = publish(UploadProgress(UploadPhase.CONFIRMING, total, total))
}

private fun TransferFile.requestBody(coroutine: CoroutineContext, progress: (Long) -> Unit): RequestBody =
    ExactBody(size, mimeType.toMediaTypeOrNull(), ::openReadable, name, coroutine, progress)

private class ExactBody(
    private val size: Long,
    private val type: MediaType?,
    private val open: () -> InputStream,
    private val name: String,
    private val coroutine: CoroutineContext,
    private val progress: (Long) -> Unit,
) : RequestBody() {
    override fun contentType(): MediaType? = type
    override fun contentLength(): Long = size
    override fun isOneShot(): Boolean = true

    override fun writeTo(sink: BufferedSink) {
        open().use { source ->
            val buffer = ByteArray(BUFFER_SIZE)
            var sent = 0L
            while (sent < size) {
                if (!coroutine.isActive) throw InterruptedIOException("Upload canceled")
                val count = source.readBuffer(buffer, minOf(buffer.size.toLong(), size - sent).toInt(), name)
                sink.write(buffer, 0, count)
                sent += count
                progress(sent)
            }
            source.checkEnd(name)
        }
    }
}

private class FileReadException(val displayMessage: String, cause: Exception? = null) : IOException(displayMessage, cause)

private fun changedFile(name: String, cause: Exception? = null) =
    FileReadException("“$name” changed since it was selected. Choose it again.", cause)

internal fun Exception.uploadMessage(): String = when (this) {
    is FileReadException -> displayMessage
    is ApiException, is StorageException, is TransferException -> message.orEmpty()
    is IOException -> "The connection or file access was interrupted. Try again."
    else -> "The share could not be created. Try again."
}

private fun TransferFile.openReadable(): InputStream = try {
    open()
} catch (error: IOException) {
    throw FileReadException("“$name” could not be opened. Choose it again.", error)
} catch (error: SecurityException) {
    throw FileReadException("Access to “$name” was lost. Choose it again.", error)
}

private fun InputStream.readBuffer(buffer: ByteArray, length: Int, name: String): Int {
    val count = try {
        read(buffer, 0, length)
    } catch (error: IOException) {
        throw FileReadException("“$name” could not be read. Choose it again.", error)
    } catch (error: SecurityException) {
        throw FileReadException("Access to “$name” was lost. Choose it again.", error)
    }
    if (count <= 0) throw changedFile(name, EOFException())
    return count
}

private fun InputStream.checkEnd(name: String) {
    val next = try {
        read()
    } catch (error: IOException) {
        throw FileReadException("“$name” could not be read. Choose it again.", error)
    } catch (error: SecurityException) {
        throw FileReadException("Access to “$name” was lost. Choose it again.", error)
    }
    if (next >= 0) throw changedFile(name)
}

private fun InputStream.copyPart(length: Long, output: OutputStream?, name: String, coroutine: CoroutineContext): ByteArray {
    val buffer = ByteArray(BUFFER_SIZE)
    val digest = MessageDigest.getInstance("SHA-256")
    var remaining = length
    while (remaining > 0) {
        coroutine.ensureActive()
        val count = readBuffer(buffer, minOf(buffer.size.toLong(), remaining).toInt(), name)
        digest.update(buffer, 0, count)
        output?.write(buffer, 0, count)
        remaining -= count
    }
    return digest.digest()
}

private fun Exception.isTransient(): Boolean = when (this) {
    is FileReadException -> false
    is IOException -> true
    is ApiException -> status in 500..599
    is StorageException -> status in 500..599 || status == 408 || status == 429
    else -> false
}

private suspend fun <T> retry(action: suspend () -> T): T {
    repeat(2) { attempt ->
        try {
            return action()
        } catch (error: Exception) {
            if (!error.isTransient()) throw error
            delay(500L * (attempt + 1))
        }
    }
    return action()
}
