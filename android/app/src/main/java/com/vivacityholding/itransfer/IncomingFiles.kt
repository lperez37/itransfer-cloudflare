package com.vivacityholding.itransfer

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import android.provider.OpenableColumns
import androidx.core.content.IntentCompat
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.io.File
import java.io.IOException
import java.util.UUID

private val mimeTypePattern = Regex("[!-~]+/[!-~]+")
private val controlCharacters = Regex("[\\x00-\\x1f\\x7f]")

internal class IncomingFiles(private val context: Context) {
    private val directory = File(context.cacheDir, "transfer-input")
    private val resolver = context.contentResolver

    fun clearStagedFiles() {
        directory.listFiles()?.forEach { it.delete() }
    }

    suspend fun read(uri: Uri): TransferFile {
        if (uri.scheme != "content" || uri.authority.isNullOrBlank() ||
            context.checkUriPermission(
                uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION,
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            throw TransferException("iTransfer could not read this file. Choose it again or share it from Files.")
        }

        val metadata = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
            ?.use { cursor ->
                if (!cursor.moveToFirst()) return@use null
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                cursor.takeIf { nameIndex >= 0 }?.getString(nameIndex) to
                    cursor.takeIf { sizeIndex >= 0 && !it.isNull(sizeIndex) }?.getLong(sizeIndex)
            }
        val name = safeName(metadata?.first)
        val type = resolver.getType(uri)?.takeIf { it.length <= 256 && mimeTypePattern.matches(it) }
            ?: "application/octet-stream"
        val declaredSize = metadata?.second
        val id = UUID.randomUUID().toString()
        val open = { resolver.openInputStream(uri) ?: throw IOException("Content stream unavailable") }
        if (declaredSize != null && declaredSize > 0) {
            checkFileSize(name, declaredSize)
            return TransferFile(id, name, declaredSize, type, uri, open = open)
        }

        // Some document providers only offer a stream. The API needs an exact size
        // to sign a PUT, so spool these streams to app-private cache before creating a share.
        val staged = temporaryFile()
        try {
            val coroutine = currentCoroutineContext()
            var size = 0L
            open().use { input ->
                staged.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        coroutine.ensureActive()
                        val count = input.read(buffer)
                        if (count < 0) break
                        size += count
                        checkFileSize(name, size)
                        output.write(buffer, 0, count)
                    }
                }
            }
            checkFileSize(name, size)
            return TransferFile(id, name, size, type, uri, staged, staged::inputStream)
        } catch (error: Exception) {
            staged.delete()
            throw error
        }
    }

    fun readText(text: CharSequence): TransferFile {
        if (text.length > 256 * 1024) throw TransferException("Shared text is too long. Share it as a file instead.")
        val bytes = text.toString().toByteArray(Charsets.UTF_8)
        return TransferFile(UUID.randomUUID().toString(), "shared-text.txt", bytes.size.toLong(), "text/plain") {
            bytes.inputStream()
        }
    }

    fun temporaryFile(): File {
        directory.mkdirs()
        return File.createTempFile("transfer-", ".bin", directory)
    }

    private fun checkFileSize(name: String, size: Long) {
        if (size <= 0) throw TransferException("“$name” is empty.")
        if (size > MAX_FILE_SIZE) throw TransferException("“$name” exceeds the server’s file size limit.")
    }

    private fun safeName(displayName: String?): String = displayName.orEmpty()
        .substringAfterLast('/').substringAfterLast('\\')
        .replace(controlCharacters, "").trim().trimStart('.')
        .take(511).trimEnd { Character.isHighSurrogate(it) }
        .ifBlank { "Shared file" }
}

internal data class IncomingBatch(val uris: List<Uri>, val text: CharSequence? = null)

internal fun Intent.incomingBatch(): IncomingBatch? {
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null
    val streams: List<*> = when (action) {
        Intent.ACTION_SEND -> listOfNotNull(IntentCompat.getParcelableExtra(this, Intent.EXTRA_STREAM, Uri::class.java))
        else -> IntentCompat.getParcelableArrayListExtra(this, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
    }
    val clipped = clipData?.let { clip ->
        List(minOf(clip.itemCount, MAX_FILES + 1)) { clip.getItemAt(it).uri }.filterNotNull()
    }.orEmpty()
    val uris = (streams.take(MAX_FILES + 1).filterIsInstance<Uri>() + clipped).distinct()
    val text = if (uris.isEmpty()) getCharSequenceExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() } else null
    return IncomingBatch(uris, text)
}
