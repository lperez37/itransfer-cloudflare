package com.vivacityholding.itransfer.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.vivacityholding.itransfer.ApiException
import com.vivacityholding.itransfer.DownloadTask
import com.vivacityholding.itransfer.Share
import com.vivacityholding.itransfer.TransferApi
import com.vivacityholding.itransfer.TransferException
import com.vivacityholding.itransfer.WorkspaceAccess
import com.vivacityholding.itransfer.WorkspaceDetail
import com.vivacityholding.itransfer.WorkspaceDownloadEvent
import com.vivacityholding.itransfer.WorkspaceEntry
import com.vivacityholding.itransfer.WorkspaceFile
import com.vivacityholding.itransfer.WorkspaceIdFormat
import com.vivacityholding.itransfer.WorkspaceKind
import com.vivacityholding.itransfer.WorkspaceTransferApi
import com.vivacityholding.itransfer.toWorkspaceEntry
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

internal data class WorkspaceFeedback(val message: String, val error: Boolean = true)

@Composable
internal fun WorkspaceScreen(
    api: TransferApi,
    access: WorkspaceAccess,
    shares: List<Share>,
    refreshing: Boolean,
    sharesError: String?,
    onRefreshShares: () -> Unit,
    draftAvailable: Boolean,
    onNewShare: () -> Unit,
    onSessionError: (Exception) -> Unit,
    copyLink: (String) -> Unit,
    shareLink: (String) -> Unit,
    openLink: (String) -> Unit,
    startDownload: (DownloadTask) -> Unit,
    dashboardHeader: @Composable () -> Unit,
    workspaceStatus: @Composable () -> Unit,
) {
    key(access.credentials.accountId, access.userId, access.readOnly) {
        val client = remember(api, access.credentials, access.userId, access.manage) { WorkspaceTransferApi(api, access) }
        val scope = rememberCoroutineScope()
        val sessionError by rememberUpdatedState(onSessionError)
        val launchDownload by rememberUpdatedState(startDownload)
        val refreshShares by rememberUpdatedState(onRefreshShares)
        val dashboard = rememberWorkspaceDashboardState()
        var requests by remember { mutableStateOf(emptyList<WorkspaceEntry>()) }
        var requestsLoading by remember { mutableStateOf(true) }
        var requestsError by remember { mutableStateOf<String?>(null) }
        var requestRefresh by remember { mutableIntStateOf(0) }
        var detailId by rememberSaveable { mutableStateOf<String?>(null) }
        var composingRequest by rememberSaveable { mutableStateOf(false) }
        var feedback by remember { mutableStateOf<WorkspaceFeedback?>(null) }
        var preparingDownload by remember { mutableStateOf(false) }
        var purgedIds by remember { mutableStateOf(emptySet<String>()) }
        var pendingPurge by remember { mutableStateOf<List<WorkspaceEntry>?>(null) }
        var purgeCompleted by remember { mutableStateOf<Int?>(null) }

        LaunchedEffect(client, requestRefresh) {
            requestsLoading = true
            requestsError = null
            try {
                requests = client.requests()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                sessionError(failure)
                requestsError = workspaceErrorMessage(failure, "Couldn't load file requests.")
            } finally {
                requestsLoading = false
            }
        }

        fun refresh(kind: WorkspaceKind) {
            if (kind == WorkspaceKind.SHARE) refreshShares() else requestRefresh++
        }

        fun download(entries: List<WorkspaceEntry>) {
            if (entries.isEmpty() || preparingDownload) return
            feedback = null
            if (entries.size > 1) {
                launchDownload(client.downloadSelected(entries.first().kind, entries))
                return
            }
            val entry = entries.single()
            if (entry.fileCount != 1 || entry.incremental) {
                launchDownload(client.downloadAll(entry))
                return
            }

            // Metadata supplies the filename for CreateDocument. Signing is deferred to DownloadTask.load.
            preparingDownload = true
            scope.launch {
                try {
                    val detail = client.detail(entry.kind, entry.id, entry)
                    if (dashboard.tab == entry.kind && detailId == null && !composingRequest && pendingPurge == null) {
                        if (detail.entry.canDownload) {
                            launchDownload(client.downloadAll(detail.entry, detail.files))
                        } else {
                            feedback = WorkspaceFeedback("No files are available to download.")
                        }
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Exception) {
                    sessionError(failure)
                    feedback = WorkspaceFeedback(workspaceErrorMessage(failure, "Couldn't prepare the download."))
                } finally {
                    preparingDownload = false
                }
            }
        }

        fun confirmPurge() {
            val entries = pendingPurge ?: return
            if (purgeCompleted != null || access.readOnly) return
            purgeCompleted = 0
            feedback = null
            scope.launch {
                val removed = mutableSetOf<String>()
                var firstError: String? = null
                val kind = entries.first().kind
                for ((index, entry) in entries.withIndex()) {
                    try {
                        client.purge(entry)
                        removed.add(entry.id)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (failure: Exception) {
                        sessionError(failure)
                        if (firstError == null) {
                            firstError = workspaceErrorMessage(failure, "Couldn't delete the ${kind.singular}.")
                        }
                        if (failure is ApiException && failure.status in setOf(401, 403)) break
                    }
                    purgeCompleted = index + 1
                }

                purgedIds = purgedIds + removed
                dashboard.selectedIds = dashboard.selectedIds - removed
                if (dashboard.selectedIds.isEmpty()) dashboard.exitSelection()
                if (detailId in removed) detailId = null
                val message = when {
                    firstError == null && entries.size == 1 -> "Permanently deleted the ${kind.singular}."
                    firstError == null -> "Permanently deleted ${removed.size} ${kind.plural}."
                    entries.size == 1 -> firstError
                    else -> "Deleted ${removed.size} of ${entries.size} ${kind.plural}. $firstError"
                }
                feedback = WorkspaceFeedback(message, error = firstError != null)
                pendingPurge = null
                purgeCompleted = null
                refresh(kind)
            }
        }

        val shareTab = dashboard.tab == WorkspaceKind.SHARE
        val entries = if (shareTab) {
            remember(shares, purgedIds) { shares.filterNot { it.id in purgedIds }.map(Share::toWorkspaceEntry) }
        } else {
            remember(requests, purgedIds) { requests.filterNot { it.id in purgedIds } }
        }
        val id = detailId
        Column(Modifier.fillMaxSize()) {
            if (id == null && !composingRequest) dashboardHeader()
            workspaceStatus()
            when {
                composingRequest && !access.readOnly -> WorkspaceRequestComposer(
                    client = client,
                    back = { composingRequest = false },
                    onCreated = {
                        dashboard.tab = WorkspaceKind.REQUEST
                        dashboard.query = ""
                        dashboard.filter = WorkspaceFilter.ACTIVE
                        dashboard.exitSelection()
                        dashboard.listState.requestScrollToItem(0)
                        refresh(WorkspaceKind.REQUEST)
                    },
                    onSessionError = sessionError,
                    copyLink = copyLink,
                    shareLink = shareLink,
                    openLink = openLink,
                )
                id != null -> WorkspaceDetails(
                    client = client,
                    kind = dashboard.tab,
                    id = id,
                    previous = entries.firstOrNull { it.id == id },
                    readOnly = access.readOnly,
                    feedback = feedback,
                    dismissFeedback = { feedback = null },
                    back = { detailId = null },
                    refreshList = { refresh(dashboard.tab) },
                    onSessionError = sessionError,
                    copyLink = copyLink,
                    shareLink = shareLink,
                    openLink = openLink,
                    startDownload = startDownload,
                    purge = { pendingPurge = listOf(it) },
                )
                else -> WorkspaceDashboard(
                    state = dashboard,
                    entries = entries,
                    loading = if (shareTab) refreshing else requestsLoading,
                    loadError = if (shareTab) sharesError else requestsError,
                    feedback = feedback,
                    dismissFeedback = { feedback = null },
                    readOnly = access.readOnly,
                    draftAvailable = draftAvailable,
                    preparingDownload = preparingDownload,
                    refresh = { refresh(dashboard.tab) },
                    newShare = onNewShare,
                    newRequest = {
                        feedback = null
                        composingRequest = true
                    },
                    showDetails = {
                        feedback = null
                        detailId = it.id
                    },
                    copyLink = copyLink,
                    download = ::download,
                    purge = { pendingPurge = it },
                )
            }
        }
        pendingPurge?.let { pending ->
            WorkspacePurgeDialog(pending, purgeCompleted, dismiss = { pendingPurge = null }, confirm = ::confirmPurge)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WorkspaceDetails(
    client: WorkspaceTransferApi,
    kind: WorkspaceKind,
    id: String,
    previous: WorkspaceEntry?,
    readOnly: Boolean,
    feedback: WorkspaceFeedback?,
    dismissFeedback: () -> Unit,
    back: () -> Unit,
    refreshList: () -> Unit,
    onSessionError: (Exception) -> Unit,
    copyLink: (String) -> Unit,
    shareLink: (String) -> Unit,
    openLink: (String) -> Unit,
    startDownload: (DownloadTask) -> Unit,
    purge: (WorkspaceEntry) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val sessionError by rememberUpdatedState(onSessionError)
    var detail by remember(client, kind, id) { mutableStateOf<WorkspaceDetail?>(null) }
    var refreshVersion by remember(client, kind, id) { mutableIntStateOf(0) }
    var refreshing by remember(client, kind, id) { mutableStateOf(true) }
    var updating by remember { mutableStateOf(false) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var updateError by remember { mutableStateOf<String?>(null) }
    var editExpiry by rememberSaveable { mutableStateOf(false) }
    var expiryError by remember { mutableStateOf<String?>(null) }
    val isShare = kind == WorkspaceKind.SHARE

    LaunchedEffect(client, kind, id, refreshVersion) {
        refreshing = true
        loadError = null
        try {
            detail = client.detail(kind, id, previous)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            sessionError(failure)
            if (failure is ApiException && failure.status == 404) detail = null
            loadError = workspaceErrorMessage(failure, "Couldn't load ${kind.singular} details.")
        } finally {
            refreshing = false
        }
    }

    fun update(expiryDays: Double? = null) {
        val current = detail ?: return
        val entry = current.entry
        if (readOnly || !entry.active || updating || refreshing) return
        updating = true
        updateError = null
        expiryError = null
        scope.launch {
            try {
                val updated = if (expiryDays == null) {
                    entry.copy(paused = client.setPaused(id, !entry.paused))
                } else {
                    entry.copy(expiresAt = client.changeExpiry(entry, expiryDays))
                }
                detail = current.copy(entry = updated)
                editExpiry = false
                refreshList()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                sessionError(failure)
                if (expiryDays == null) {
                    updateError = workspaceErrorMessage(failure, "Couldn't update the share.")
                } else {
                    expiryError = workspaceErrorMessage(failure, "Couldn't update the expiry.")
                }
            } finally {
                updating = false
            }
        }
    }

    val data = detail
    val entry = data?.entry?.let {
        if (!isShare && !it.active && previous?.reclaimedAtExpiry == true) it.copy(reclaimedAtExpiry = true) else it
    }

    BackHandler { if (!updating) back() }
    ScreenHeader(if (isShare) "Share details" else "Request details", back, backEnabled = !updating) {
        WorkspaceRefresh(
            "Refresh ${kind.singular} details",
            refreshing,
            { refreshVersion++ },
            enabled = !updating,
        )
        if (!readOnly && entry != null) {
            WorkspaceDeleteAction(
                "Delete ${entry.title} permanently",
                enabled = !updating && !refreshing,
            ) { purge(entry) }
        }
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = workspaceListPadding,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        feedback?.let { item { Notice(it.message, error = it.error, dismiss = dismissFeedback) } }
        loadError?.let { message ->
            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Notice(message)
                    if (data == null) OutlinedAction("Try again", { refreshVersion++ }, enabled = !refreshing)
                }
            }
        }
        updateError?.let { item { Notice(it, dismiss = { updateError = null }) } }
        if (data == null || entry == null) {
            if (refreshing) item { WorkspaceLoading("Loading ${kind.singular} details…") }
            return@LazyColumn
        }

        item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Title(entry.title)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(9.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    WorkspaceStatusBadge(entry.status)
                    Text(
                        entry.id,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.align(Alignment.CenterVertically),
                    )
                }
            }
        }
        if (entry.paused && entry.active) {
            item { Notice("This share is paused. Resume it to make the link available to recipients.", error = false) }
        }
        if (entry.status.showsLink) {
            item {
                Panel {
                    WorkspaceLinkActions(entry.link, copyLink, shareLink, openLink, accent = if (isShare) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.secondary)
                }
            }
        }
        item { WorkspaceDetailsSummary(entry, data) }
        if (!readOnly && entry.active) {
            item {
                Panel(padding = 12) {
                    WorkspaceSectionTitle("Settings")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (isShare) {
                            TextButton(onClick = { update() }, enabled = !updating && !refreshing) {
                                Text(if (entry.paused) "Resume share" else "Pause share")
                            }
                        }
                        TextButton(
                            onClick = {
                                expiryError = null
                                editExpiry = true
                            },
                            enabled = !updating && !refreshing,
                        ) { Text("Change expiry") }
                    }
                    if (updating && !editExpiry) WorkspaceLoading("Updating share…")
                }
            }
        }
        if (!isShare) {
            item { WorkspaceRequestSettings(data) }
        }
        item {
            Panel(padding = 12) {
                WorkspaceSectionTitle(if (isShare) "Files" else "Uploaded files")
                if (data.files.isEmpty()) {
                    SupportingText(if (isShare) "No files." else "No files have been uploaded.")
                } else if (entry.canDownload) {
                    OutlinedAction(
                        "Download all",
                        { startDownload(client.downloadAll(entry, data.files)) },
                        icon = TransferIcons.Download,
                    )
                }
            }
        }
        items(data.files, key = { "workspace-file:${it.id}" }) { file ->
            WorkspaceDetailFileRow(
                file,
                download = if (isShare && entry.active) {
                    { startDownload(client.downloadFile(entry.id, file)) }
                } else {
                    null
                },
            )
        }
        if (isShare) {
            item {
                Panel(padding = 12) {
                    WorkspaceSectionTitle("Download log")
                    SupportingText(
                        if (data.downloads.isEmpty()) {
                            "No downloads yet."
                        } else {
                            "Most recent download events. Each file logs separately."
                        },
                        small = true,
                    )
                }
            }
            items(data.downloads) { event -> WorkspaceDownloadLogRow(event) }
        }
    }
    if (editExpiry && entry?.active == true && !readOnly) {
        WorkspaceExpiryDialog(
            saving = updating,
            error = expiryError,
            dismiss = { editExpiry = false },
            save = { update(it) },
        )
    }
}

@Composable
private fun WorkspaceDetailsSummary(entry: WorkspaceEntry, detail: WorkspaceDetail) {
    val totalBytes = entry.totalBytes ?: detail.files.takeIf { files -> files.all { it.size != null } }
        ?.sumOf { it.size ?: 0 }
    val stats = listOf(
        "Files" to entry.fileCount.toString(),
        "Size" to (totalBytes?.let { byteSize(it) } ?: "Unknown"),
        entry.kind.countLabel to entry.countText,
        "Expires" to (entry.expiresAt?.let(::workspaceDateTime) ?: "No expiry"),
    ) + listOfNotNull(entry.createdAt?.let { "Created" to workspaceDateTime(it) })
    Panel(padding = 12) {
        stats.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { (label, value) ->
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        SupportingText(label, small = true)
                        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

@Composable
private fun WorkspaceRequestSettings(detail: WorkspaceDetail) {
    Panel(padding = 12) {
        WorkspaceSectionTitle("Upload settings")
        detail.message?.takeIf(String::isNotBlank)?.let { message ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                SupportingText("Message", small = true)
                Text(message)
            }
        }
        val size = detail.maxFileSize?.let { byteSize(it) } ?: "No limit"
        SupportingText("Max file size · $size")
        SupportingText("Max uploads · ${detail.entry.limit ?: "Unlimited"}")
        SupportingText("Incremental uploads · ${if (detail.entry.incremental) "On" else "Off"}")
        WorkspaceIdFormat.entries.firstOrNull { it.value == detail.idFormat }?.let {
            SupportingText("Link format · ${it.label}")
        }
    }
}

@Composable
private fun WorkspaceDetailFileRow(file: WorkspaceFile, download: (() -> Unit)?) {
    Panel(padding = 12) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            FileTile(MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(file.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                file.size?.let { SupportingText(byteSize(it), small = true) }
                file.createdAt?.let { SupportingText(workspaceDateTime(it), small = true) }
            }
            if (download != null) TransferIconButton(TransferIcons.Download, "Download ${file.name}", download)
        }
    }
}

@Composable
private fun WorkspaceDownloadLogRow(event: WorkspaceDownloadEvent) {
    Panel(padding = 12) {
        Text(event.time?.let(::workspaceDateTime) ?: "Time unavailable", style = MaterialTheme.typography.bodyMedium)
        event.fileName?.let { Text(it, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold) }
        event.ipAddress?.let { SupportingText("IP address · $it", small = true) }
        event.userAgent?.let { SupportingText(it, small = true) }
    }
}

@Composable
private fun WorkspaceLinkActions(
    link: String,
    copyLink: (String) -> Unit,
    shareLink: (String) -> Unit,
    openLink: (String) -> Unit,
    accent: Color,
) {
    LinkText(link)
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        PrimaryButton("Copy link", { copyLink(link) }, TransferIcons.Copy, modifier = Modifier.weight(1f), accent = accent)
        TransferIconButton(Icons.Rounded.Share, "Share link", { shareLink(link) }, tint = accent)
        TransferIconButton(TransferIcons.Link, "Open link", { openLink(link) }, tint = accent)
    }
}

@Composable
internal fun TransferLinkResult(
    link: String,
    summary: String,
    copyLink: (String) -> Unit,
    shareLink: (String) -> Unit,
    openLink: (String) -> Unit,
    accent: Color = MaterialTheme.colorScheme.primary,
) {
    Panel {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Icon(Icons.Rounded.CheckCircle, contentDescription = null, tint = MaterialTheme.colorScheme.secondary, modifier = Modifier.size(36.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Title("Link ready")
                SupportingText(summary)
            }
        }
        WorkspaceLinkActions(link, copyLink, shareLink, openLink, accent)
    }
}

@Composable
private fun WorkspacePurgeDialog(
    entries: List<WorkspaceEntry>,
    completed: Int?,
    dismiss: () -> Unit,
    confirm: () -> Unit,
) {
    val kind = entries.first().kind
    val single = entries.singleOrNull()
    val objectName = if (single == null) "${entries.size} ${kind.plural}" else "this ${kind.singular}"
    val records = if (kind == WorkspaceKind.SHARE) "files and download history" else "uploaded files"
    val description = if (single == null) {
        "The selected ${kind.plural} and their $records will be permanently deleted. Their links will stop working."
    } else {
        "“${single.title}” and its $records will be deleted. Its link will stop working."
    }
    AlertDialog(
        onDismissRequest = { if (completed == null) dismiss() },
        icon = { Icon(Icons.Rounded.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
        title = { Text("Permanently delete $objectName?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (completed == null) {
                    Text(description)
                } else {
                    Text("Processed $completed of ${entries.size}…")
                    LinearProgressIndicator(
                        progress = { completed.toFloat() / entries.size },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        },
        dismissButton = { TextButton(onClick = dismiss, enabled = completed == null) { Text("Cancel") } },
        confirmButton = {
            Button(
                onClick = confirm,
                enabled = completed == null,
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error, contentColor = MaterialTheme.colorScheme.onError),
            ) {
                Text(if (completed == null) "Delete permanently" else "Deleting…")
            }
        },
    )
}

private val workspaceTimeFormatter = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)

private fun workspaceDateTime(instant: Instant): String =
    "${formatDate(instant)} · ${workspaceTimeFormatter.withZone(ZoneId.systemDefault()).format(instant)}"

internal fun workspaceErrorMessage(error: Exception, fallback: String): String =
    if (error is ApiException || error is TransferException) error.message ?: fallback else fallback
