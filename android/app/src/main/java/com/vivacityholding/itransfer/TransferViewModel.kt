package com.vivacityholding.itransfer

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

internal class TransferViewModel(application: Application) : AndroidViewModel(application) {
    val api = TransferApi()
    private val sessions = SessionStore(application)
    private val incomingFiles = IncomingFiles(application)
    private val uploader = ShareUploader(api, incomingFiles::temporaryFile)
    private val _state = MutableStateFlow(TransferUiState())
    val state = _state.asStateFlow()

    private var session: AccountSession? = null
    private var restoreJob: Job? = null
    private var signInJob: Job? = null
    private var refreshJob: Job? = null
    private var uploadJob: Job? = null
    private var downloadJob: Job? = null
    private var queuedDownload: QueuedDownload? = null
    private var pendingUpload: PendingUpload? = null
    private var draftOwner: String? = null

    private data class QueuedBatch(val batch: IncomingBatch, val version: Int)
    private data class QueuedDownload(val task: DownloadTask, val access: WorkspaceAccess?)

    private val batches = Channel<QueuedBatch>(capacity = 4)
    private var pendingBatches = 0

    init {
        viewModelScope.launch {
            withContext(Dispatchers.IO) { incomingFiles.clearStagedFiles() }
            for ((batch, version) in batches) {
                try {
                    if (version == _state.value.draftVersion) importFiles(batch, version)
                } finally {
                    pendingBatches--
                    _state.update { it.copy(importing = pendingBatches > 0) }
                }
            }
        }
        restoreSession()
    }

    fun restoreSession() {
        if (restoreJob?.isActive == true || session != null || _state.value.signingIn) return
        _state.update { it.copy(restoring = true, sessionError = null) }
        restoreJob = viewModelScope.launch {
            try {
                val stored = withContext(Dispatchers.IO) { sessions.read() }
                if (stored == null) {
                    _state.update { it.copy(restoring = false) }
                } else {
                    showAccount(api.restore(stored))
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (error is ApiException && error.status == 401) {
                    showExpiredSession()
                } else {
                    _state.update { it.copy(restoring = false, sessionError = error.accountMessage()) }
                }
            }
        }
    }

    fun signIn(email: String, password: String) {
        val current = _state.value
        if (current.restoring || current.signingIn || session != null) return
        val address = email.trim()
        if (address.isBlank() || password.isEmpty()) {
            _state.update { it.copy(authError = "Enter your iTransfer email and password.") }
            return
        }
        _state.update { it.copy(signingIn = true, authError = null, sessionError = null) }
        signInJob = viewModelScope.launch {
            try {
                val signedIn = api.signIn(address, password)
                withContext(Dispatchers.IO) { sessions.write(signedIn.credentials) }
                showAccount(signedIn)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _state.update { it.copy(signingIn = false, authError = error.accountMessage()) }
            }
        }
    }

    fun signOut() {
        if (session == null || _state.value.upload != null) return
        endSession(message = null)
    }

    fun passwordChanged() {
        endSession(message = "Password saved. Sign in with your new password.")
    }

    private fun endSession(message: String?) {
        val signedIn = session
        session = null
        restoreJob?.cancel()
        signInJob?.cancel()
        refreshJob?.cancel()
        uploadJob?.cancel()
        downloadJob?.cancel()
        queuedDownload = null
        resetDraft()
        _state.update {
            it.copy(
                account = null, access = null, restoring = true, shares = emptyList(), refreshing = false,
                sharesError = null, authError = null, sessionError = null, signingIn = false,
                publicScreen = false, publicUrl = null, workspaceNotice = null,
                upload = null, downloading = false, downloadNotice = null,
            )
        }
        viewModelScope.launch {
            signInJob?.join()
            val erased = eraseSavedSession()
            _state.update { it.copy(restoring = false, authError = if (erased) message else savedSessionError) }
            // Local sign-out works offline. Invalidate the server session when reachable.
            if (signedIn != null) {
                try {
                    api.signOut(signedIn.credentials)
                } catch (error: CancellationException) {
                    throw error
                } catch (_: Exception) {
                    // The local credential has already been removed.
                }
            }
        }
    }

    fun selectWorkspace(target: WorkspaceTarget?, manage: Boolean = false) {
        val signedIn = session ?: return
        val current = _state.value
        if (current.upload != null || current.importing ||
            (target != null && (!signedIn.account.isAdmin || target.id == signedIn.account.id))
        ) return
        val access = WorkspaceAccess(signedIn.credentials, target, manage && target != null)
        if (current.access == access) return
        refreshJob?.cancel()
        downloadJob?.cancel()
        queuedDownload = null
        val changedOwner = current.access?.userId != access.userId
        if (changedOwner) resetDraft()
        _state.update {
            it.copy(
                access = access, shares = emptyList(), refreshing = false, sharesError = null,
                workspaceNotice = null, downloading = false, downloadNotice = null,
            )
        }
        refreshShares()
    }

    fun refreshShares() {
        val signedIn = session ?: return
        val access = _state.value.access ?: return
        if (signedIn.account.passwordChangeRequired || _state.value.refreshing) return
        _state.update { it.copy(refreshing = true, sharesError = null) }
        refreshJob = viewModelScope.launch {
            try {
                val shares = api.listShares(access)
                if (session === signedIn && _state.value.access == access) {
                    _state.update { it.copy(shares = shares, refreshing = false) }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (session === signedIn && _state.value.access == access && !expireIfUnauthorized(signedIn, error)) {
                    _state.update { it.copy(refreshing = false, sharesError = error.accountMessage()) }
                }
            }
        }
    }

    fun addDocuments(uris: List<Uri>) {
        if (uris.isNotEmpty()) receive(IncomingBatch(uris.take(MAX_FILES + 1).distinct()), fromAnotherApp = false)
    }

    fun receive(batch: IncomingBatch, fromAnotherApp: Boolean = true) {
        var current = _state.value
        if (current.upload != null || current.completed != null) {
            _state.update { it.copy(importError = "Finish this share, then send the next files to iTransfer.") }
            return
        }
        if (current.access?.target != null && fromAnotherApp) {
            if (current.files.isNotEmpty() || current.draftOpen || current.importing) {
                _state.update { it.copy(importError = "Finish or discard this workspace’s draft before importing another share.") }
                return
            }
            selectWorkspace(null)
            current = _state.value
        }
        if (current.access?.readOnly == true) return
        closePublicLink()
        openDraft()
        if (batch.uris.isEmpty() && batch.text == null) {
            _state.update { it.copy(importError = "This share contained no readable files or text.") }
            return
        }
        pendingBatches++
        _state.update { it.copy(importing = true, importError = null) }
        if (batches.trySend(QueuedBatch(batch, current.draftVersion)).isFailure) {
            pendingBatches--
            _state.update {
                it.copy(
                    importing = pendingBatches > 0,
                    importError = "Wait for the current files to finish opening, then try again.",
                )
            }
        }
    }

    fun openDraft() {
        if (_state.value.access?.readOnly == true) return
        draftOwner = session?.account?.id ?: draftOwner
        _state.update { it.copy(draftOpen = true) }
    }

    fun closeDraft() {
        if (_state.value.upload == null) _state.update { it.copy(draftOpen = false) }
    }

    fun discardDraft() {
        if (_state.value.upload == null) resetDraft()
    }

    fun removeFile(id: String) {
        val current = _state.value
        if (current.upload != null) return
        val removed = current.files.firstOrNull { it.id == id } ?: return
        deleteStaged(listOf(removed))
        pendingUpload = null
        _state.update { it.copy(files = it.files.filterNot { file -> file.id == id }, uploadError = null) }
    }

    fun clearImportError() = _state.update { it.copy(importError = null) }

    fun createShare(options: ShareOptions) {
        val signedIn = session ?: return
        val current = _state.value
        val access = current.access ?: return
        if (access.readOnly || signedIn.account.passwordChangeRequired || current.upload != null || current.importing ||
            current.files.isEmpty() || current.completed != null
        ) return
        if (options.title.length > 256 || options.password.length > 128 ||
            options.expiryDays !in Double.MIN_VALUE..MAX_TRANSFER_EXPIRY_DAYS ||
            (options.maxDownloads != null && options.maxDownloads !in 1..MAX_EXACT_JSON_INTEGER) ||
            options.idFormat !in setOf("random", "animals") || options.idLength !in 4..64
        ) {
            _state.update { it.copy(uploadError = "Check the share title, expiry and link options.") }
            return
        }
        val files = current.files
        val title = options.title.trim().ifBlank {
            (files.singleOrNull()?.name ?: "${files.size} files").take(256).trimEnd { Character.isHighSurrogate(it) }
        }
        val normalized = options.copy(title = title)
        val fileIds = files.map(TransferFile::id)
        _state.update {
            it.copy(upload = UploadProgress(UploadPhase.PREPARING, 0, files.sumOf(TransferFile::size)), uploadError = null)
        }

        uploadJob = viewModelScope.launch {
            val job = currentCoroutineContext()[Job]
            try {
                val accountId = access.userId
                val attempt = pendingUpload?.takeIf { it.matches(accountId, fileIds, normalized) }
                    ?: PendingUpload(api.initialize(access, files, normalized), accountId, fileIds, normalized)
                        .also { pendingUpload = it }
                val share = uploader.upload(access, attempt, files) { progress ->
                    _state.update {
                        if (job?.isActive == true && it.account?.id == signedIn.account.id && it.upload != null) {
                            it.copy(upload = progress)
                        } else it
                    }
                }
                if (session !== signedIn) return@launch
                pendingUpload = null
                deleteStaged(files)
                refreshJob?.cancel()
                _state.update {
                    it.copy(
                        upload = null, completed = share, files = emptyList(), draftVersion = it.draftVersion + 1, refreshing = false,
                        shares = listOf(share) + it.shares.filterNot { row -> row.id == share.id },
                    )
                }
                refreshShares()
            } catch (error: CancellationException) {
                if (session === signedIn) _state.update { it.copy(upload = null, uploadError = "Upload canceled.") }
                throw error
            } catch (error: Exception) {
                if (session !== signedIn) return@launch
                if (error is StorageException && error.status in setOf(401, 403) ||
                    error is ApiException && error.status in setOf(404, 410)
                ) pendingUpload = null
                if (!expireIfUnauthorized(signedIn, error)) {
                    _state.update { it.copy(upload = null, uploadError = error.uploadMessage()) }
                    downgradeIfReauthRequired(access, error)
                }
            }
        }
    }

    fun cancelUpload() {
        if (_state.value.upload?.phase != UploadPhase.CONFIRMING) uploadJob?.cancel()
    }

    fun finishShare() {
        _state.update { it.copy(completed = null, draftOpen = false) }
    }

    fun openPublicLink(url: String? = null) {
        if (_state.value.upload != null) return
        _state.update { it.copy(publicScreen = true, publicUrl = url) }
    }

    fun closePublicLink() {
        _state.update { it.copy(publicScreen = false, publicUrl = null) }
    }

    fun onSessionError(access: WorkspaceAccess, error: Exception) {
        val signedIn = session ?: return
        if (signedIn.credentials !== access.credentials) return
        viewModelScope.launch {
            if (!expireIfUnauthorized(signedIn, error)) downgradeIfReauthRequired(access, error)
        }
    }

    fun clearWorkspaceNotice() = _state.update { it.copy(workspaceNotice = null) }

    fun prepareDownload(task: DownloadTask, access: WorkspaceAccess?): Boolean {
        if (queuedDownload != null || downloadJob?.isActive == true) return false
        if (access != null && access != _state.value.access) return false
        queuedDownload = QueuedDownload(task, access)
        return true
    }

    fun saveDownload(uri: Uri?) {
        val queued = queuedDownload
        queuedDownload = null
        if (uri == null) return
        if (queued == null) {
            viewModelScope.launch(Dispatchers.IO) {
                runCatching { android.provider.DocumentsContract.deleteDocument(getApplication<Application>().contentResolver, uri) }
            }
            return
        }
        val (task, access) = queued
        _state.update { it.copy(downloading = true, downloadNotice = null) }
        downloadJob = viewModelScope.launch {
            try {
                saveTransfer(getApplication<Application>().contentResolver, uri, api, task)
                _state.update { it.copy(downloadNotice = "Download saved.") }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                _state.update {
                    it.copy(downloadNotice = if (error is IOException) "Could not save the download. Try again." else error.accountMessage())
                }
                access?.let { onSessionError(it, error) }
            } finally {
                _state.update { it.copy(downloading = false) }
            }
        }
    }

    fun clearDownloadNotice() = _state.update { it.copy(downloadNotice = null) }

    private fun downgradeIfReauthRequired(access: WorkspaceAccess, error: Exception) {
        if (error !is ApiException || error.code != "REAUTH_REQUIRED" || !access.manage || _state.value.access != access) return
        pendingUpload = null
        _state.update {
            it.copy(
                access = access.copy(manage = false), draftOpen = false,
                workspaceNotice = "Management access expired. Confirm your password to manage this workspace again.",
            )
        }
    }

    private suspend fun importFiles(batch: IncomingBatch, version: Int) {
        val current = _state.value
        val existingUris = current.files.mapNotNull(TransferFile::uri).toSet()
        val remaining = MAX_FILES - current.files.size
        val uris = batch.uris.filterNot(existingUris::contains)
        val imported = mutableListOf<TransferFile>()
        val errors = mutableListOf<String>()
        try {
            withContext(Dispatchers.IO) {
                for (uri in uris.take(remaining)) {
                    try {
                        imported += incomingFiles.read(uri)
                    } catch (error: CancellationException) {
                        throw error
                    } catch (error: TransferException) {
                        errors += error.message.orEmpty()
                    } catch (_: Exception) {
                        errors += "A selected file could not be opened. Choose it from Files and try again."
                    }
                }
                if (batch.text != null && remaining > 0) {
                    try {
                        imported += incomingFiles.readText(batch.text)
                    } catch (error: TransferException) {
                        errors += error.message.orEmpty()
                    }
                }
            }
        } catch (error: CancellationException) {
            imported.forEach { it.stagedFile?.delete() }
            throw error
        }
        if (_state.value.draftVersion != version) {
            deleteStaged(imported)
            return
        }
        if (uris.size > remaining || (batch.text != null && remaining == 0)) {
            errors += "A share can contain up to $MAX_FILES files."
        }
        if (imported.isNotEmpty()) pendingUpload = null
        _state.update {
            it.copy(
                files = it.files + imported,
                importError = errors.distinct().take(2).joinToString(" ").ifBlank { it.importError },
                uploadError = if (imported.isEmpty()) it.uploadError else null,
            )
        }
    }

    private fun showAccount(signedIn: AccountSession) {
        if (draftOwner != null && draftOwner != signedIn.account.id) resetDraft()
        session = signedIn
        if (_state.value.draftOpen) draftOwner = signedIn.account.id
        _state.update {
            it.copy(
                account = signedIn.account, access = WorkspaceAccess(signedIn.credentials),
                restoring = false, signingIn = false, authError = null, sessionError = null,
            )
        }
        refreshShares()
    }

    private suspend fun expireIfUnauthorized(signedIn: AccountSession, error: Exception): Boolean {
        if (error !is ApiException || error.status != 401) return false
        if (session !== signedIn) return true
        session = null
        if (_state.value.access?.target != null) resetDraft()
        downloadJob?.cancel()
        queuedDownload = null
        pendingUpload = null
        _state.update {
            it.copy(
                account = null, access = null, shares = emptyList(), refreshing = false, sharesError = null, restoring = true,
                upload = null, uploadError = null, completed = null, workspaceNotice = null,
            )
        }
        val caller = currentCoroutineContext()[Job]
        if (refreshJob != caller) refreshJob?.cancel()
        if (uploadJob != caller) uploadJob?.cancelAndJoin()
        showExpiredSession()
        return true
    }

    private suspend fun showExpiredSession() {
        val erased = eraseSavedSession()
        _state.update {
            it.copy(restoring = false, authError = if (erased) "Your session expired. Sign in again." else savedSessionError)
        }
    }

    private suspend fun eraseSavedSession(): Boolean = withContext(Dispatchers.IO) {
        runCatching { sessions.clear() }.isSuccess
    }

    private fun resetDraft() {
        pendingUpload = null
        draftOwner = null
        deleteStaged(_state.value.files)
        _state.update {
            it.copy(
                draftOpen = false, draftVersion = it.draftVersion + 1, files = emptyList(),
                importError = null, uploadError = null, completed = null,
            )
        }
    }

    private fun deleteStaged(files: List<TransferFile>) {
        val cached = files.mapNotNull(TransferFile::stagedFile)
        if (cached.isNotEmpty()) viewModelScope.launch(Dispatchers.IO) { cached.forEach { it.delete() } }
    }
}

private const val savedSessionError = "The saved session could not be removed from this device."

private fun Exception.accountMessage(): String = when (this) {
    is ApiException, is TransferException -> message.orEmpty()
    is IOException -> "Could not connect to iTransfer. Check your connection and try again."
    else -> "iTransfer could not complete this request. Try again."
}
