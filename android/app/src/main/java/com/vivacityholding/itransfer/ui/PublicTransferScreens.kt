package com.vivacityholding.itransfer.ui

import android.content.ActivityNotFoundException
import android.content.ClipboardManager
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.vivacityholding.itransfer.ApiException
import com.vivacityholding.itransfer.DownloadItem
import com.vivacityholding.itransfer.DownloadTask
import com.vivacityholding.itransfer.IncomingFiles
import com.vivacityholding.itransfer.MAX_FILES
import com.vivacityholding.itransfer.MAX_FILE_SIZE
import com.vivacityholding.itransfer.MAX_PUBLIC_LINK_LENGTH
import com.vivacityholding.itransfer.PendingUpload
import com.vivacityholding.itransfer.PublicLinkTarget
import com.vivacityholding.itransfer.PublicTransfer
import com.vivacityholding.itransfer.PublicTransferApi
import com.vivacityholding.itransfer.PublicTransferFile
import com.vivacityholding.itransfer.ShareOptions
import com.vivacityholding.itransfer.ShareUploader
import com.vivacityholding.itransfer.StorageException
import com.vivacityholding.itransfer.TransferApi
import com.vivacityholding.itransfer.TransferException
import com.vivacityholding.itransfer.TransferFile
import com.vivacityholding.itransfer.UploadPhase
import com.vivacityholding.itransfer.UploadProgress
import com.vivacityholding.itransfer.uploadMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.time.Duration
import java.time.Instant

private const val REQUEST_PASSWORD_LENGTH = 128
private const val REQUEST_MESSAGE_LENGTH = 2048
private const val INVALID_LINK = "Enter a complete link for this iTransfer server."
private const val UNAVAILABLE_LINK = "notFound.description"
private const val DOWNLOAD_LIMIT = "share.downloadLimit"
private const val UPLOAD_LIMIT = "request.uploadLimit"
private val downloadNameCharacters = Regex("[<>:\"/\\\\|?*\\p{Cntrl}]")
private val mimeType = Regex("[A-Za-z0-9!#\$&^_.+-]+/[A-Za-z0-9!#\$&^_.+-]+")

@Composable
internal fun PublicLinkScreen(
    api: TransferApi,
    initialUrl: String?,
    onBack: () -> Unit,
    onPasswordSetup: (String) -> Unit,
    startDownload: (DownloadTask) -> Unit,
) {
    PublicLanguageProvider {
        PublicLinkContent(api, initialUrl, onBack, onPasswordSetup, startDownload)
    }
}

@Composable
private fun PublicLinkContent(
    api: TransferApi,
    initialUrl: String?,
    onBack: () -> Unit,
    onPasswordSetup: (String) -> Unit,
    startDownload: (DownloadTask) -> Unit,
) {
    val publicApi = remember(api) { PublicTransferApi(api) }
    val initialTarget = remember(publicApi, initialUrl) { initialUrl?.let(publicApi::parseLink) }
    val initialTransferId = (initialTarget as? PublicLinkTarget.Transfer)?.id
    var id by remember(publicApi, initialUrl) { mutableStateOf(initialTransferId) }
    var entry by remember(publicApi, initialUrl) { mutableStateOf("") }
    var entryError by remember(publicApi, initialUrl) {
        mutableStateOf(if (initialUrl != null && initialTarget == null) INVALID_LINK else null)
    }
    val setup by rememberUpdatedState(onPasswordSetup)
    LaunchedEffect(initialTarget) {
        if (initialTarget is PublicLinkTarget.PasswordSetup) setup(initialTarget.token)
    }

    val transferId = id
    if (transferId != null) {
        ResolvedPublicLink(publicApi, api, transferId, {
            if (initialTransferId == transferId) onBack() else id = null
        }, startDownload)
    } else {
        val context = LocalContext.current
        val focusManager = LocalFocusManager.current
        val changeEntry: (String) -> Unit = {
            entry = if (it.length <= MAX_PUBLIC_LINK_LENGTH) it else ""
            entryError = if (it.length <= MAX_PUBLIC_LINK_LENGTH) null else INVALID_LINK
        }
        fun openLink() {
            when (val target = publicApi.parseLink(entry)) {
                is PublicLinkTarget.Transfer -> {
                    entry = ""
                    entryError = null
                    focusManager.clearFocus()
                    id = target.id
                }
                is PublicLinkTarget.PasswordSetup -> {
                    entry = ""
                    entryError = null
                    focusManager.clearFocus()
                    onPasswordSetup(target.token)
                }
                null -> entryError = INVALID_LINK
            }
        }
        PublicPage("Open a link", onBack) {
            item {
                Panel {
                    SupportingText("Open shared files or respond to a file request.")
                    OutlinedTextField(
                        value = entry,
                        onValueChange = changeEntry,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("iTransfer link") },
                        shape = RoundedCornerShape(16.dp),
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(
                            autoCorrectEnabled = false,
                            keyboardType = KeyboardType.Uri,
                            imeAction = ImeAction.Go,
                        ),
                        keyboardActions = KeyboardActions(onGo = { openLink() }),
                    )
                    entryError?.let { Notice(it) }
                    PrimaryButton("Open link", ::openLink, enabled = entry.isNotBlank())
                    OutlinedAction("Paste link", {
                        val clipboard = context.getSystemService(ClipboardManager::class.java)
                        val clip = clipboard?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)
                        val pasted = clip?.text?.toString() ?: clip?.uri?.toString()
                        if (pasted.isNullOrBlank()) entryError = "Copy an iTransfer link before pasting."
                        else changeEntry(pasted)
                    })
                }
            }
        }
    }
}

private sealed interface PublicResolution {
    data object Loading : PublicResolution
    data class Ready(val transfer: PublicTransfer) : PublicResolution
    data class Failed(val status: Int?) : PublicResolution
}

@Composable
private fun ResolvedPublicLink(
    publicApi: PublicTransferApi,
    api: TransferApi,
    id: String,
    onBack: () -> Unit,
    startDownload: (DownloadTask) -> Unit,
) {
    val language = currentPublicLanguage()
    var retry by remember(publicApi, id) { mutableIntStateOf(0) }
    var result by remember(publicApi, id, retry) { mutableStateOf<PublicResolution>(PublicResolution.Loading) }
    LaunchedEffect(publicApi, id, retry) {
        result = try {
            PublicResolution.Ready(publicApi.resolve(id))
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            PublicResolution.Failed((error as? ApiException)?.status)
        }
    }
    when (val resolved = result) {
        PublicResolution.Loading -> PublicPage("Opening link", onBack) {
            item {
                Box(Modifier.fillMaxWidth().padding(top = 20.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
        }
        is PublicResolution.Ready -> when (val transfer = resolved.transfer) {
            is PublicTransfer.Share -> PublicShareScreen(publicApi, transfer, onBack, startDownload)
            is PublicTransfer.Request -> PublicRequestScreen(publicApi, api, transfer, onBack)
        }
        is PublicResolution.Failed -> PublicPage("iTransfer link", onBack) {
            item {
                Panel {
                    when (resolved.status) {
                        404 -> {
                            Title(language.text("notFound.title"))
                            SupportingText(language.text(UNAVAILABLE_LINK))
                        }
                        410 -> Title(language.text(DOWNLOAD_LIMIT))
                        else -> {
                            Title(language.text("loadError.title"))
                            SupportingText(
                                if (resolved.status == 429) "Too many requests. Wait a moment before trying again."
                                else language.text("loadError.description"),
                            )
                            PrimaryButton(language.text("loadError.retry"), { retry++ })
                        }
                    }
                }
            }
        }
    }
}

private data class PublicShareAccess(val remaining: Long?, val problem: String? = null)

@Composable
private fun PublicShareScreen(
    api: PublicTransferApi,
    share: PublicTransfer.Share,
    onBack: () -> Unit,
    startDownload: (DownloadTask) -> Unit,
) {
    val language = currentPublicLanguage()
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current
    var password by remember(share) { mutableStateOf("") }
    var unlockedFiles by remember(share) { mutableStateOf<List<PublicTransferFile>?>(null) }
    var unlocking by remember(share) { mutableStateOf(false) }
    var unlockError by remember(share) { mutableStateOf<String?>(null) }
    var selection by remember(share) { mutableStateOf(emptySet<String>()) }
    val accessState = remember(share) { MutableStateFlow(PublicShareAccess(share.downloadsRemaining)) }
    val access by accessState.collectAsState()
    val expired = publicLinkExpired(share.expiresAt)
    val unavailable = access.problem ?: when {
        expired -> "share.expired"
        access.remaining == 0L -> DOWNLOAD_LIMIT
        else -> null
    }
    val needsPassword = share.passwordRequired && unlockedFiles == null
    val files = if (share.passwordRequired) unlockedFiles.orEmpty() else share.files
    val activeFiles = if (selection.isEmpty()) files else files.filter { it.id in selection }
    val title = share.title?.takeIf(String::isNotBlank) ?: language.text("share.defaultTitle")
    val totalBytes = files.sumOf { it.size ?: 0L }

    fun unlock() {
        if (!needsPassword || unlocking || password.isEmpty() || unavailable != null) return
        focusManager.clearFocus()
        unlocking = true
        unlockError = null
        scope.launch {
            try {
                unlockedFiles = api.unlock(share.id, password)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                when ((error as? ApiException)?.status) {
                    401, 403 -> unlockError = "share.wrongPassword"
                    404 -> accessState.update { it.copy(problem = UNAVAILABLE_LINK) }
                    410 -> accessState.update { it.copy(remaining = 0L) }
                    429 -> unlockError = "share.tooManyAttempts"
                    else -> unlockError = "share.unlockFailed"
                }
            } finally {
                unlocking = false
            }
        }
    }

    fun saveFiles() {
        if (activeFiles.isEmpty() || unavailable != null || needsPassword) return
        val downloadPassword = password.takeIf { share.passwordRequired }
        val archive = activeFiles.size > 1
        val suggestedName = if (archive) "${safeSuggestedName(title, "Shared files")}.zip"
        else safeSuggestedName(activeFiles.single().name, "Shared file")
        val contentType = if (archive) "application/zip"
        else activeFiles.single().mimeType?.takeIf(mimeType::matches) ?: "application/octet-stream"
        val selectedIndices = files.indices.filter { index -> selection.isEmpty() || files[index].id in selection }
        startDownload(DownloadTask(suggestedName, contentType, archive) {
            val downloads = try {
                api.download(share.id, downloadPassword)
            } catch (error: ApiException) {
                when (error.status) {
                    404 -> accessState.update { it.copy(problem = UNAVAILABLE_LINK) }
                    410 -> accessState.update { it.copy(remaining = 0L) }
                }
                throw error
            }
            accessState.update { current -> current.copy(remaining = current.remaining?.let { (it - 1).coerceAtLeast(0) }) }
            selectShareDownloads(files, selectedIndices, downloads)
        })
    }

    val footer: (@Composable () -> Unit)? = if (!needsPassword && unavailable == null && files.isNotEmpty()) {
        {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val label = when {
                    files.size == 1 -> language.text("share.downloadAll")
                    selection.isEmpty() -> "${language.text("share.downloadAll")} (.zip)"
                    activeFiles.size == 1 -> "Save selected file"
                    else -> "Save ${activeFiles.size} files as ZIP"
                }
                PrimaryButton(label, ::saveFiles, enabled = activeFiles.isNotEmpty())
                if (selection.isNotEmpty()) OutlinedAction("Clear selection", { selection = emptySet() })
            }
        }
    } else null
    PublicPage("Share", onBack, footer = footer) {
        item {
            Panel {
                Title(title)
                val details = listOfNotNull(
                    if (needsPassword) null else language.plural("share.fileCount", files.size.toLong()),
                    if (totalBytes > 0) language.size(totalBytes) else null,
                    access.remaining?.let { language.plural("share.downloadsLeft", it) },
                    share.expiresAt?.let { language.text("share.expires", "date" to language.date(it)) },
                )
                if (details.isNotEmpty()) SupportingText(details.joinToString(" · "))
                unavailable?.let { Notice(language.text(it)) }
                if (needsPassword) SupportingText(language.plural("share.lockedFiles", share.fileCount.toLong()))
                if (needsPassword && unavailable == null) {
                    unlockError?.let { Notice(language.text(it)) }
                    PublicPasswordField(password, {
                        password = it
                        unlockError = null
                    }, "share.password", "share.passwordPlaceholder", enabled = !unlocking, done = ::unlock)
                    PrimaryButton(
                        language.text(if (unlocking) "share.verifying" else "share.unlock"),
                        ::unlock,
                        enabled = !unlocking && password.isNotEmpty(),
                    )
                }
                if (!needsPassword && unavailable == null) {
                    when {
                        files.isEmpty() -> Notice("No files are available in this share.")
                        files.size > 1 -> SupportingText("Select files below to save a subset.", small = true)
                    }
                }
            }
        }
        items(files, key = { it.id }) { file ->
            PublicFileRow(
                file.name,
                file.size,
                selected = if (files.size > 1 && unavailable == null) file.id in selection else null,
                onSelect = { checked -> selection = if (checked) selection + file.id else selection - file.id },
            )
        }
    }
}

private fun safeSuggestedName(name: String, fallback: String): String = name
    .replace(downloadNameCharacters, "_")
    .trim().take(255).trimEnd { it == '.' || Character.isHighSurrogate(it) }
    .ifBlank { fallback }

private fun selectShareDownloads(
    files: List<PublicTransferFile>,
    selectedIndices: List<Int>,
    downloads: List<DownloadItem>,
): List<DownloadItem> {
    // Both endpoints return the same file order. Download responses omit file IDs.
    if (downloads.size != files.size || files.indices.any { index ->
            val file = files[index]
            val download = downloads[index]
            file.name != download.name || (file.size != null && file.size != download.size)
        }
    ) throw TransferException("The share changed. Reopen the link before downloading.")
    return selectedIndices.map(downloads::get)
}

private sealed interface PublicRequestIssue {
    data class Text(val message: String) : PublicRequestIssue
    data class Localized(val key: String) : PublicRequestIssue
    data class Import(val oversized: Int, val sizeLimit: Long, val errors: List<String>) : PublicRequestIssue

    fun message(language: PublicLanguage): String = when (this) {
        is Text -> message
        is Localized -> language.text(key)
        is Import -> {
            val sizeError = if (oversized == 0) null else language.plural(
                "request.filesTooLarge",
                oversized.toLong(),
                "size" to language.size(sizeLimit),
            )
            (listOfNotNull(sizeError) + errors).joinToString(" ")
        }
    }
}

@Composable
private fun PublicRequestScreen(
    api: PublicTransferApi,
    transferApi: TransferApi,
    initial: PublicTransfer.Request,
    onBack: () -> Unit,
) {
    val language = currentPublicLanguage()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val focusManager = LocalFocusManager.current
    val incoming = remember(context) { IncomingFiles(context.applicationContext) }
    val uploader = remember(transferApi, incoming) { ShareUploader(transferApi, incoming::temporaryFile) }
    var request by remember(initial) { mutableStateOf(initial) }
    var files by remember(initial) { mutableStateOf(emptyList<TransferFile>()) }
    var password by remember(initial) { mutableStateOf("") }
    var message by remember(initial) { mutableStateOf("") }
    var importing by remember(initial) { mutableStateOf(false) }
    var refreshing by remember(initial) { mutableStateOf(false) }
    var issue by remember(initial) { mutableStateOf<PublicRequestIssue?>(null) }
    var terminalProblem by remember(initial) { mutableStateOf<String?>(null) }
    var confirmedCount by remember(initial) { mutableIntStateOf(0) }
    var pending by remember(initial) { mutableStateOf<PendingUpload?>(null) }
    var confirmationPending by remember(initial) { mutableStateOf(false) }
    var uploadJob by remember(initial) { mutableStateOf<Job?>(null) }
    val progressState = remember(initial) { MutableStateFlow<UploadProgress?>(null) }
    val progress by progressState.collectAsState()
    val listState = rememberLazyListState()
    val uploading = progress != null
    LaunchedEffect(uploading) {
        if (uploading) listState.scrollToItem(0)
    }
    val expired = publicLinkExpired(request.expiresAt)
    val unavailable = terminalProblem?.let { language.text(it) } ?: when {
        expired -> "This file request has expired."
        request.uploadsRemaining == 0L && (confirmedCount == 0 || request.allowIncremental) -> language.text(UPLOAD_LIMIT)
        else -> null
    }
    val sizeLimit = minOf(request.maxFileSize ?: MAX_FILE_SIZE, MAX_FILE_SIZE)
    val sizeLimitLabel = language.size(sizeLimit)
    val fieldError = when {
        password.length > REQUEST_PASSWORD_LENGTH -> "Use $REQUEST_PASSWORD_LENGTH characters or fewer for the password."
        message.length > REQUEST_MESSAGE_LENGTH -> "Use $REQUEST_MESSAGE_LENGTH characters or fewer for the message."
        else -> null
    }
    DisposableEffect(initial, incoming) {
        onDispose { files.forEach { it.stagedFile?.delete() } }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty() || importing || refreshing || confirmationPending || confirmedCount > 0 ||
            progressState.value != null || unavailable != null
        ) return@rememberLauncherForActivityResult
        importing = true
        issue = null
        val existing = files.mapNotNull(TransferFile::uri).toSet()
        val candidates = uris.distinct().filterNot(existing::contains)
        val remaining = MAX_FILES - files.size
        scope.launch {
            val imported = mutableListOf<TransferFile>()
            try {
                val result = importPublicRequestFiles(incoming, candidates, remaining, sizeLimit, imported)
                if (imported.isNotEmpty()) {
                    files = files + imported
                    pending = null
                    imported.clear()
                }
                issue = result.takeIf { it.oversized > 0 || it.errors.isNotEmpty() }
            } finally {
                imported.forEach { it.stagedFile?.delete() }
                importing = false
            }
        }
    }

    fun beginUpload() {
        if (unavailable != null || importing || refreshing || progressState.value != null || files.isEmpty() ||
            fieldError != null || (request.passwordRequired && password.isEmpty())
        ) return
        focusManager.clearFocus()
        val selected = files
        val requestId = request.id
        val uploadMessage = message
        val uploadPassword = password.takeIf { request.passwordRequired }.orEmpty()
        // The request ID and form fields identify a retry of the same upload.
        val options = ShareOptions(title = uploadMessage, expiryDays = 0.0, password = uploadPassword)
        val ids = selected.map(TransferFile::id)
        issue = null
        progressState.value = UploadProgress(UploadPhase.PREPARING, 0, selected.sumOf(TransferFile::size))
        uploadJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            val job = coroutineContext.job
            try {
                val attempt = pending?.takeIf { it.matches(requestId, ids, options) }
                    ?: PendingUpload(api.prepareUpload(requestId, selected, uploadMessage, uploadPassword), requestId, ids, options)
                        .also { pending = it }
                uploader.uploadFiles(
                    attempt,
                    selected,
                    complete = { file, parts -> api.completeMultipart(requestId, file, parts) },
                    confirm = { api.confirmUpload(requestId, attempt.plan, uploadMessage) },
                    progress = { next -> progressState.update { current -> if (job.isActive && current != null) next else current } },
                )
                val uploaded = attempt.plan.files.zip(selected) { target, local ->
                    PublicTransferFile(target.fileId, local.name, local.size, local.mimeType)
                }
                val uploadedIds = uploaded.map(PublicTransferFile::id).toSet()
                request = request.copy(
                    uploadsRemaining = if (request.allowIncremental) request.uploadsRemaining?.let { (it - 1).coerceAtLeast(0) }
                    else 0L,
                    files = if (request.allowIncremental) request.files.filterNot { it.id in uploadedIds } + uploaded else emptyList(),
                )
                pending = null
                confirmationPending = false
                selected.forEach { it.stagedFile?.delete() }
                files = emptyList()
                message = ""
                if (!request.allowIncremental || request.uploadsRemaining == 0L) password = ""
                confirmedCount = selected.size
            } catch (canceled: CancellationException) {
                issue = PublicRequestIssue.Text("Upload canceled. Your selected files are ready to retry.")
                throw canceled
            } catch (error: Exception) {
                if (error is StorageException && error.status in setOf(401, 403)) pending = null
                val status = (error as? ApiException)?.status
                val wasConfirming = progressState.value?.phase == UploadPhase.CONFIRMING
                confirmationPending = (confirmationPending || wasConfirming) &&
                    (status == null || status == 408 || status == 429 || status >= 500)
                when (status) {
                    401, 403 -> issue = if (request.passwordRequired) PublicRequestIssue.Localized("request.wrongPassword")
                    else PublicRequestIssue.Text(error.publicUploadMessage())
                    404 -> terminalProblem = UNAVAILABLE_LINK
                    410 -> terminalProblem = UPLOAD_LIMIT
                    429 -> issue = if (request.passwordRequired) PublicRequestIssue.Localized("request.tooManyAttempts")
                    else PublicRequestIssue.Text("Too many attempts. Wait before trying again.")
                    else -> issue = PublicRequestIssue.Text(
                        if (confirmationPending) "Could not verify delivery. Retry to check this upload."
                        else error.publicUploadMessage(),
                    )
                }
                if (terminalProblem != null) {
                    pending = null
                    selected.forEach { it.stagedFile?.delete() }
                    files = emptyList()
                    password = ""
                    message = ""
                }
            } finally {
                progressState.value = null
            }
        }
    }

    val cancelUpload: () -> Unit = {
        if (progressState.value?.phase != UploadPhase.CONFIRMING) uploadJob?.cancel()
    }
    fun uploadMore() {
        confirmedCount = 0
        issue = null
        refreshing = true
        scope.launch {
            try {
                request = api.request(request.id)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                when ((error as? ApiException)?.status) {
                    404 -> terminalProblem = UNAVAILABLE_LINK
                    410 -> terminalProblem = UPLOAD_LIMIT
                    else -> issue = PublicRequestIssue.Localized("request.loadError")
                }
            } finally {
                refreshing = false
            }
        }
    }

    val editEnabled = !refreshing && !confirmationPending
    val footer: (@Composable () -> Unit)? = if (!uploading && confirmedCount == 0 && unavailable == null && files.isNotEmpty()) {
        {
            val canUpload = !importing && !refreshing && fieldError == null &&
                (!request.passwordRequired || password.isNotEmpty())
            val label = when {
                confirmationPending -> "Retry confirmation"
                pending != null && issue != null -> language.text("loadError.retry")
                else -> language.plural("request.uploadButton", files.size.toLong())
            }
            PrimaryButton(label, ::beginUpload, enabled = canUpload)
        }
    } else null
    PublicPage(
        "File request",
        onBack = { if (progressState.value == null) onBack() else cancelUpload() },
        backEnabled = progress?.phase != UploadPhase.CONFIRMING,
        listState = listState,
        footer = footer,
    ) {
        item {
            Panel {
                Title(request.title)
                request.message?.takeIf(String::isNotBlank)?.let { SupportingText(it) }
                SupportingText(
                    listOfNotNull(
                        request.expiresAt?.let { language.text("request.expires", "date" to language.date(it)) },
                        if (!request.allowIncremental && request.uploadsRemaining != 0L) "One upload per link"
                        else request.uploadsRemaining?.let { language.plural("request.uploadsRemaining", it) },
                        language.text("request.maxFileSize", "size" to sizeLimitLabel),
                    ).joinToString(" · "),
                )
                unavailable?.let { Notice(it) }
            }
        }
        val activeProgress = progress
        when {
            activeProgress != null -> item { PublicUploadProgress(activeProgress, cancelUpload) }
            confirmedCount > 0 -> item {
                Panel {
                    Text(
                        language.text("request.filesUploaded"),
                        color = Mocha.green,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    SupportingText(language.text("request.filesDelivered"))
                    if (request.allowIncremental && unavailable == null) {
                        PrimaryButton(language.text("request.uploadMore"), ::uploadMore)
                    }
                }
            }
            unavailable == null -> {
                item {
                    Panel {
                        if (request.passwordRequired) PublicPasswordField(password, {
                            password = it
                            issue = null
                        }, "request.passwordRequired", "request.passwordPlaceholder", enabled = editEnabled)
                        OutlinedTextField(
                            value = message,
                            onValueChange = { message = it },
                            modifier = Modifier.fillMaxWidth(),
                            label = { Text("${language.text("request.message")} ${language.text("request.messageOptional")}") },
                            placeholder = { Text(language.text("request.messagePlaceholder")) },
                            enabled = editEnabled,
                            isError = message.length > REQUEST_MESSAGE_LENGTH,
                            shape = RoundedCornerShape(16.dp),
                            minLines = 2,
                            maxLines = 5,
                        )
                        fieldError?.let { Notice(it) }
                        issue?.let { Notice(it.message(language), dismiss = { issue = null }) }
                        OutlinedAction(
                            when {
                                refreshing -> "Refreshing request…"
                                importing -> "Reading selected files…"
                                else -> "Choose files"
                            },
                            {
                                try {
                                    picker.launch(arrayOf("*/*"))
                                } catch (_: ActivityNotFoundException) {
                                    issue = PublicRequestIssue.Text("No document picker is available on this device.")
                                }
                            },
                            enabled = editEnabled && !importing && files.size < MAX_FILES,
                        )
                        if (files.size == MAX_FILES) SupportingText("You can upload up to $MAX_FILES files at once.", small = true)
                    }
                }
                items(files, key = { "local-${it.id}" }) { file ->
                    val canRemove = editEnabled && !importing
                    PublicFileRow(file.name, file.size, onRemove = if (!canRemove) null else {
                        {
                            file.stagedFile?.delete()
                            pending = null
                            files = files.filterNot { it.id == file.id }
                        }
                    })
                }
            }
        }
        if (request.files.isNotEmpty()) {
            item {
                Text(
                    language.text("request.previousFiles"),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.semantics { heading() },
                )
            }
            items(request.files, key = { "remote-${it.id}" }) { PublicFileRow(it.name, it.size) }
        }
    }
}

private suspend fun importPublicRequestFiles(
    incoming: IncomingFiles,
    candidates: List<Uri>,
    capacity: Int,
    sizeLimit: Long,
    imported: MutableList<TransferFile>,
): PublicRequestIssue.Import = withContext(Dispatchers.IO) {
    val errors = mutableListOf<String>()
    var oversized = 0
    if (candidates.size > capacity) errors += "You can upload up to $MAX_FILES files at once."
    for (uri in candidates.take(capacity)) {
        try {
            val file = incoming.read(uri)
            if (file.size > sizeLimit) {
                file.stagedFile?.delete()
                oversized++
            } else {
                imported += file
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: TransferException) {
            errors += error.message.orEmpty()
        } catch (_: Exception) {
            errors += "A selected file could not be opened. Choose it from Files and try again."
        }
    }
    PublicRequestIssue.Import(oversized, sizeLimit, errors.distinct().take(3))
}

private fun Exception.publicUploadMessage(): String = when (this) {
    is ApiException, is StorageException, is TransferException, is IOException -> uploadMessage()
    else -> "Could not upload the selected files. Try again."
}

@Composable
private fun PublicUploadProgress(progress: UploadProgress, cancel: () -> Unit) {
    val language = currentPublicLanguage()
    val label = when (progress.phase) {
        UploadPhase.PREPARING -> "Preparing upload"
        UploadPhase.UPLOADING -> language.text("request.uploading")
        UploadPhase.CONFIRMING -> "Confirming delivery"
    }
    Panel {
        Text(
            label,
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        if (progress.phase == UploadPhase.UPLOADING && progress.totalBytes > 0L) {
            val fraction = (progress.sentBytes.toDouble() / progress.totalBytes).coerceIn(0.0, 1.0).toFloat()
            LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth(), trackColor = Mocha.surface)
            SupportingText("${language.size(progress.sentBytes)} / ${language.size(progress.totalBytes)}", small = true)
            progress.currentFile?.let { Text(it, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        } else {
            LinearProgressIndicator(Modifier.fillMaxWidth(), trackColor = Mocha.surface)
        }
        SupportingText(language.text("request.keepOpen"), small = true)
        if (progress.phase != UploadPhase.CONFIRMING) OutlinedAction("Cancel upload", cancel)
    }
}

@Composable
private fun PublicPage(
    title: String,
    onBack: () -> Unit,
    backEnabled: Boolean = true,
    listState: LazyListState = rememberLazyListState(),
    footer: (@Composable () -> Unit)? = null,
    content: LazyListScope.() -> Unit,
) {
    BackHandler(onBack = onBack)
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { ScreenHeader(title, onBack, backEnabled = backEnabled) }
            PublicLanguageMenu()
        }
        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f),
            state = listState,
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
        if (footer != null) Box(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 16.dp)) {
            footer()
        }
    }
}

@Composable
private fun PublicPasswordField(
    value: String,
    onValueChange: (String) -> Unit,
    labelKey: String,
    placeholderKey: String,
    enabled: Boolean,
    done: (() -> Unit)? = null,
) {
    val language = currentPublicLanguage()
    var visible by remember { mutableStateOf(false) }
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(language.text(labelKey)) },
        placeholder = { Text(language.text(placeholderKey)) },
        enabled = enabled,
        shape = RoundedCornerShape(16.dp),
        singleLine = true,
        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { if (done != null) done() else defaultKeyboardAction(ImeAction.Done) }),
        trailingIcon = {
            TextButton(onClick = { visible = !visible }, enabled = enabled) {
                val key = if (visible) "common.hidePassword" else "common.showPassword"
                Text(language.text(key), style = MaterialTheme.typography.labelSmall)
            }
        },
    )
}

@Composable
private fun PublicFileRow(
    name: String,
    size: Long?,
    selected: Boolean? = null,
    onSelect: (Boolean) -> Unit = {},
    onRemove: (() -> Unit)? = null,
) {
    val language = currentPublicLanguage()
    val selectable = if (selected == null) Modifier else Modifier.toggleable(selected, role = Role.Checkbox, onValueChange = onSelect)
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = Mocha.mantle,
        border = BorderStroke(1.dp, if (selected == true) Mocha.lavender else Mocha.border),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().then(selectable).padding(horizontal = 14.dp, vertical = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (selected != null) Checkbox(checked = selected, onCheckedChange = null)
            Column(Modifier.weight(1f)) {
                Text(name.ifBlank { "File" }, maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
                size?.let { SupportingText(language.size(it), small = true) }
            }
            if (onRemove != null) IconButton(onClick = onRemove) {
                Icon(Icons.Rounded.Close, contentDescription = "Remove $name", tint = Mocha.secondaryText)
            }
        }
    }
}

@Composable
private fun publicLinkExpired(expiresAt: Instant?): Boolean {
    var expired by remember(expiresAt) { mutableStateOf(expiresAt?.isAfter(Instant.now()) == false) }
    LaunchedEffect(expiresAt) {
        expiresAt ?: return@LaunchedEffect
        while (!expired) {
            val remaining = Duration.between(Instant.now(), expiresAt)
            if (remaining.isNegative || remaining.isZero) expired = true
            else delay(minOf(remaining, Duration.ofMinutes(1)).toMillis().coerceAtLeast(1))
        }
    }
    return expired
}
