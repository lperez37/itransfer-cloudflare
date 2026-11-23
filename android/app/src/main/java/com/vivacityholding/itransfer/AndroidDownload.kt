package com.vivacityholding.itransfer

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

internal fun safeDownloadName(name: String): String = name
    .substringAfterLast('/').substringAfterLast('\\')
    .filterNot { it.isISOControl() }
    .trim().trimStart('.').take(220).trimEnd { Character.isHighSurrogate(it) }
    .ifBlank { "iTransfer download" }

internal suspend fun saveTransfer(
    resolver: ContentResolver,
    uri: Uri,
    api: TransferApi,
    task: DownloadTask,
) = withContext(Dispatchers.IO) {
    var saved = false
    try {
        val files = task.load()
        if (files.isEmpty()) throw TransferException("There are no files to download.")
        if (!task.archive && files.size != 1) throw TransferException("Choose a ZIP archive to save several files.")
        val output = resolver.openOutputStream(uri, "wt") ?: throw IOException("Document is unavailable")
        output.buffered().use { buffer ->
            if (task.archive) {
                val names = mutableSetOf<String>()
                ZipOutputStream(buffer).use { zip ->
                    for (file in files) {
                        zip.putNextEntry(ZipEntry(uniqueEntryName(file.name, names)))
                        api.streamDownload(file, zip)
                        zip.closeEntry()
                    }
                }
            } else {
                api.streamDownload(files.single(), buffer)
            }
        }
        saved = true
    } finally {
        if (!saved) withContext(NonCancellable) {
            runCatching { DocumentsContract.deleteDocument(resolver, uri) }
        }
    }
}

private fun uniqueEntryName(raw: String, names: MutableSet<String>): String {
    val name = safeDownloadName(raw)
    if (names.add(name)) return name
    val extensionIndex = name.lastIndexOf('.')
    val stem = if (extensionIndex > 0) name.substring(0, extensionIndex) else name
    val extension = if (extensionIndex > 0) name.substring(extensionIndex) else ""
    var number = 2
    while (true) {
        val candidate = "$stem ($number)$extension"
        if (names.add(candidate)) return candidate
        number++
    }
}
