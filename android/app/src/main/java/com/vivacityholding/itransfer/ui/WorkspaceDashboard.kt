package com.vivacityholding.itransfer.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.vivacityholding.itransfer.WorkspaceEntry
import com.vivacityholding.itransfer.WorkspaceKind
import com.vivacityholding.itransfer.WorkspaceStatus
import java.time.Duration
import java.time.Instant
import kotlin.math.ceil

internal val workspaceGutter = 20.dp
internal val workspaceShape = RoundedCornerShape(16.dp)
internal val workspaceListPadding = PaddingValues(start = workspaceGutter, end = workspaceGutter, top = 12.dp, bottom = 24.dp)

internal enum class WorkspaceFilter(val label: String) {
    ACTIVE("Active"), EXPIRED("Expired"), DELETED("Deleted"), ALL("All");

    fun matches(status: WorkspaceStatus): Boolean = when (this) {
        ACTIVE -> status.inActiveFilter
        EXPIRED -> status == WorkspaceStatus.EXPIRED
        DELETED -> status == WorkspaceStatus.DELETED
        ALL -> true
    }
}

internal class WorkspaceDashboardState(
    tabState: MutableState<WorkspaceKind>,
    filterState: MutableState<WorkspaceFilter>,
    queryState: MutableState<String>,
    val listState: LazyListState,
) {
    var tab by tabState
    var filter by filterState
    var query by queryState
    var selecting by mutableStateOf(false)
    var selectedIds by mutableStateOf(emptySet<String>())

    fun exitSelection() {
        selecting = false
        selectedIds = emptySet()
    }
}

@Composable
internal fun rememberWorkspaceDashboardState(): WorkspaceDashboardState {
    val tab = rememberSaveable { mutableStateOf(WorkspaceKind.SHARE) }
    val filter = rememberSaveable { mutableStateOf(WorkspaceFilter.ACTIVE) }
    val query = rememberSaveable { mutableStateOf("") }
    val listState = rememberLazyListState()
    return remember(tab, filter, query, listState) { WorkspaceDashboardState(tab, filter, query, listState) }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun WorkspaceDashboard(
    state: WorkspaceDashboardState,
    entries: List<WorkspaceEntry>,
    loading: Boolean,
    loadError: String?,
    feedback: WorkspaceFeedback?,
    dismissFeedback: () -> Unit,
    readOnly: Boolean,
    draftAvailable: Boolean,
    preparingDownload: Boolean,
    refresh: () -> Unit,
    newShare: () -> Unit,
    newRequest: () -> Unit,
    showDetails: (WorkspaceEntry) -> Unit,
    copyLink: (String) -> Unit,
    download: (List<WorkspaceEntry>) -> Unit,
    purge: (List<WorkspaceEntry>) -> Unit,
) {
    val tab = state.tab
    val query = state.query.trim()
    val visible = entries.filter {
        state.filter.matches(it.status) &&
            (it.title.contains(query, ignoreCase = true) || it.id.contains(query, ignoreCase = true))
    }
    val selectable = if (readOnly) visible.filter { it.canDownload } else visible
    val selected = selectable.filter { it.id in state.selectedIds }
    val downloadable = selected.filter { it.canDownload }
    val accent = tab.accent

    BackHandler(enabled = state.selecting, onBack = state::exitSelection)

    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            state = state.listState,
            modifier = Modifier.fillMaxWidth().weight(1f),
            contentPadding = workspaceListPadding,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (!readOnly) {
                item(key = "workspace-start") {
                    WorkspaceCreateAction(
                        kind = tab,
                        hasDraft = tab == WorkspaceKind.SHARE && draftAvailable,
                        create = {
                            state.exitSelection()
                            if (tab == WorkspaceKind.SHARE) newShare() else newRequest()
                        },
                    )
                }
            }
            item(key = "workspace-controls") {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val searchLabel = "Search ${tab.plural}"
                        TextField(
                            value = state.query,
                            onValueChange = {
                                state.query = it
                                state.selectedIds = emptySet()
                            },
                            modifier = Modifier.weight(1f).semantics { contentDescription = searchLabel },
                            placeholder = { Text(searchLabel) },
                            singleLine = true,
                            leadingIcon = { Icon(Icons.Rounded.Search, contentDescription = null, tint = Mocha.secondaryText) },
                            trailingIcon = if (state.query.isNotEmpty()) {
                                {
                                    IconButton(onClick = {
                                        state.query = ""
                                        state.selectedIds = emptySet()
                                    }) {
                                        Icon(Icons.Rounded.Close, contentDescription = "Clear search")
                                    }
                                }
                            } else {
                                null
                            },
                            shape = workspaceShape,
                            colors = TextFieldDefaults.colors(
                                focusedContainerColor = Mocha.base,
                                unfocusedContainerColor = Mocha.mantle,
                                focusedIndicatorColor = Color.Transparent,
                                unfocusedIndicatorColor = Color.Transparent,
                            ),
                        )
                        TransferIconButton(
                            TransferIcons.Selection,
                            "Select ${tab.plural}",
                            { state.selecting = true },
                            enabled = !state.selecting && selectable.isNotEmpty(),
                        )
                        WorkspaceRefresh("Refresh ${tab.plural}", loading, refresh)
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        WorkspaceFilter.entries.forEach { filter ->
                            val count = entries.count { filter.matches(it.status) }
                            FilterChip(
                                selected = state.filter == filter,
                                onClick = {
                                    if (state.filter != filter) {
                                        state.filter = filter
                                        state.selectedIds = emptySet()
                                    }
                                },
                                label = { Text("${filter.label} $count") },
                                shape = RoundedCornerShape(50),
                                border = null,
                                colors = FilterChipDefaults.filterChipColors(
                                    containerColor = Mocha.mantle,
                                    labelColor = Mocha.secondaryText,
                                    selectedContainerColor = accent.copy(alpha = 0.16f),
                                    selectedLabelColor = accent,
                                ),
                            )
                        }
                    }
                }
            }
            loadError?.let { message ->
                item(key = "workspace-load-error") {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Notice(message)
                        OutlinedAction("Try again", refresh, enabled = !loading)
                    }
                }
            }
            feedback?.let {
                item(key = "workspace-feedback") {
                    Notice(it.message, error = it.error, success = !it.error, dismiss = dismissFeedback)
                }
            }
            if (preparingDownload) {
                item(key = "workspace-download-progress") { WorkspaceLoading("Preparing download…") }
            }
            if (visible.isEmpty() && !loading && loadError == null) {
                item(key = "workspace-empty") {
                    Panel {
                        val empty = entries.isEmpty() && query.isEmpty()
                        Icon(tab.icon, contentDescription = null, tint = accent, modifier = Modifier.size(28.dp))
                        WorkspaceSectionTitle(if (empty) "No ${tab.plural} yet" else "No matching ${tab.plural}")
                        if (empty && !readOnly && tab == WorkspaceKind.SHARE) {
                            SupportingText("Choose iTransfer from another app’s share menu to add files directly.")
                        }
                    }
                }
            }
            items(visible, key = { "entry:${it.id}" }) { entry ->
                WorkspaceDashboardRow(
                    entry = entry,
                    selecting = state.selecting,
                    checked = entry.id in state.selectedIds,
                    onSelect = if (!readOnly || entry.canDownload) {
                        { checked ->
                            state.selecting = true
                            state.selectedIds = if (checked) state.selectedIds + entry.id else state.selectedIds - entry.id
                        }
                    } else {
                        null
                    },
                    showDetails = { showDetails(entry) },
                    copyLink = { copyLink(entry.link) },
                    download = { download(listOf(entry)) },
                    downloadEnabled = !preparingDownload,
                    purge = if (readOnly) null else { { purge(listOf(entry)) } },
                )
            }
        }
        if (state.selecting) {
            HorizontalDivider(color = Mocha.border.copy(alpha = 0.58f))
            Surface(color = Mocha.base, modifier = Modifier.fillMaxWidth()) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TransferIconButton(Icons.Rounded.Close, "Exit selection", state::exitSelection)
                    WorkspaceSectionTitle(
                        "${selected.size} selected",
                        Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    TextButton(
                        onClick = { state.selectedIds = selectable.map { it.id }.toSet() },
                        enabled = selected.size < selectable.size,
                        colors = ButtonDefaults.textButtonColors(contentColor = accent),
                    ) { Text("Select all") }
                    if (downloadable.isNotEmpty()) {
                        val description = if (downloadable.size == selected.size) {
                            "Download ${downloadable.size} selected ${tab.plural}"
                        } else {
                            "Download ${downloadable.size} of ${selected.size} selected ${tab.plural}"
                        }
                        TransferIconButton(
                            TransferIcons.Download,
                            description,
                            { download(downloadable) },
                            enabled = !preparingDownload,
                            tint = accent,
                        )
                    }
                    if (!readOnly) {
                        WorkspaceDeleteAction("Permanently delete ${selected.size} selected ${tab.plural}", enabled = selected.isNotEmpty()) {
                            purge(selected)
                        }
                    }
                }
            }
        }
        WorkspaceDock(tab) { kind ->
            if (tab != kind) {
                state.exitSelection()
                state.tab = kind
                state.listState.requestScrollToItem(0)
            }
        }
    }
}

private val WorkspaceKind.accent get() = if (this == WorkspaceKind.SHARE) Mocha.mauve else Mocha.teal
private val WorkspaceKind.icon get() = if (this == WorkspaceKind.SHARE) Icons.AutoMirrored.Rounded.Send else TransferIcons.Inbox

@Composable
private fun WorkspaceDock(active: WorkspaceKind, select: (WorkspaceKind) -> Unit) {
    Surface(Modifier.fillMaxWidth(), color = Mocha.mantle) {
        Column {
            HorizontalDivider(color = Mocha.border.copy(alpha = 0.58f))
            Row(
                Modifier.fillMaxWidth().selectableGroup().padding(horizontal = workspaceGutter, vertical = 7.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                for (kind in WorkspaceKind.entries) {
                    val selected = kind == active
                    val tint by animateColorAsState(if (selected) kind.accent else Mocha.secondaryText, label = "Dock content")
                    val container by animateColorAsState(
                        if (selected) kind.accent.copy(alpha = 0.15f) else Color.Transparent,
                        label = "Dock selection",
                    )
                    Row(
                        Modifier.weight(1f).clip(workspaceShape).background(container)
                            .selectable(selected, role = Role.Tab, onClick = { select(kind) })
                            .heightIn(min = 50.dp).padding(horizontal = 8.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(kind.icon, contentDescription = null, tint = tint, modifier = Modifier.size(19.dp))
                        Text(
                            if (kind == WorkspaceKind.SHARE) "Shares" else "Requests",
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                            color = tint,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun WorkspaceCreateAction(kind: WorkspaceKind, hasDraft: Boolean, create: () -> Unit) {
    val accent = kind.accent
    Surface(
        onClick = create,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        color = Mocha.mantle,
        border = BorderStroke(1.dp, accent.copy(alpha = 0.32f)),
    ) {
        Row(
            Modifier.fillMaxWidth()
                .background(Brush.horizontalGradient(listOf(accent.copy(alpha = 0.16f), Color.Transparent)))
                .heightIn(min = 68.dp).padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier.size(38.dp).background(accent.copy(alpha = 0.2f), RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (hasDraft) Icons.AutoMirrored.Rounded.ArrowForward else Icons.Rounded.Add,
                    contentDescription = null,
                    tint = accent,
                    modifier = Modifier.size(22.dp),
                )
            }
            Text(
                if (hasDraft) "Continue draft" else "New ${kind.singular}",
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
            if (LocalDensity.current.fontScale < 1.45f) {
                TransferArtwork(Modifier.size(width = 84.dp, height = 49.dp))
            }
            Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, contentDescription = null, tint = accent)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WorkspaceDashboardRow(
    entry: WorkspaceEntry,
    selecting: Boolean,
    checked: Boolean,
    onSelect: ((Boolean) -> Unit)?,
    showDetails: () -> Unit,
    copyLink: () -> Unit,
    download: () -> Unit,
    downloadEnabled: Boolean,
    purge: (() -> Unit)?,
) {
    val status = entry.status
    val accent = entry.kind.accent
    val showActions = !selecting && (status.showsLink || entry.canDownload || purge != null)
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = workspaceShape,
        color = if (checked) accent.copy(alpha = 0.1f) else Mocha.mantle,
        border = BorderStroke(1.dp, if (checked) accent.copy(alpha = 0.5f) else Mocha.border.copy(alpha = 0.55f)),
    ) {
        Column {
            Row(
                Modifier.fillMaxWidth().combinedClickable(
                    enabled = !selecting || onSelect != null,
                    onClickLabel = when {
                        !selecting -> "Open ${entry.kind.singular} details"
                        checked -> "Deselect ${entry.title}"
                        else -> "Select ${entry.title}"
                    },
                    onLongClickLabel = "Select ${entry.title}",
                    onLongClick = if (!selecting && onSelect != null) { { onSelect(true) } } else null,
                    role = Role.Button,
                    onClick = { if (selecting) onSelect?.invoke(!checked) else showDetails() },
                ).semantics {
                    if (selecting && onSelect != null) stateDescription = if (checked) "Selected" else "Unselected"
                }.heightIn(min = 62.dp).padding(start = 12.dp, end = 8.dp, top = 9.dp, bottom = 7.dp),
                horizontalArrangement = Arrangement.spacedBy(9.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (selecting && onSelect != null) {
                    Checkbox(
                        checked = checked,
                        onCheckedChange = null,
                    )
                } else if (LocalDensity.current.fontScale < 1.45f) {
                    if (entry.kind == WorkspaceKind.SHARE) {
                        FileTile(accent)
                    } else {
                        Box(
                            Modifier.size(40.dp).background(accent.copy(alpha = 0.12f), RoundedCornerShape(12.dp)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(entry.kind.icon, contentDescription = null, tint = accent, modifier = Modifier.size(20.dp))
                        }
                    }
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(
                        entry.title,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    val size = entry.totalBytes?.let { " · ${byteSize(it)}" }.orEmpty()
                    val count = "${entry.countText} ${entry.kind.countLabel.lowercase()}"
                    SupportingText("${workspaceFileCount(entry.fileCount)}$size · $count", small = true)
                }
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    WorkspaceStatusBadge(status)
                    if (status != WorkspaceStatus.EXPIRED) {
                        Text(expirySummary(entry.expiresAt), color = Mocha.secondaryText, style = MaterialTheme.typography.labelSmall)
                    }
                }
                if (!selecting && LocalDensity.current.fontScale < 1.45f) {
                    Icon(
                        Icons.AutoMirrored.Rounded.KeyboardArrowRight,
                        contentDescription = null,
                        modifier = Modifier.size(17.dp),
                        tint = Mocha.secondaryText,
                    )
                }
            }
            if (showActions) {
                BoxWithConstraints(Modifier.fillMaxWidth().padding(start = 10.dp, end = 4.dp, bottom = 4.dp)) {
                    val showLabels = maxWidth >= 312.dp && LocalDensity.current.fontScale <= 1.25f
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        if (status.showsLink) {
                            WorkspaceCardAction(TransferIcons.Copy, "Copy link", showLabels, copyLink, accent = accent)
                        }
                        if (entry.canDownload) {
                            WorkspaceCardAction(TransferIcons.Download, "Download", showLabels, download, enabled = downloadEnabled)
                        }
                        Spacer(Modifier.weight(1f))
                        if (purge != null) {
                            WorkspaceDeleteAction("Permanently delete ${entry.title}", onClick = purge)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun WorkspaceCardAction(
    icon: ImageVector,
    label: String,
    showLabel: Boolean,
    onClick: () -> Unit,
    enabled: Boolean = true,
    accent: Color? = null,
) {
    if (!showLabel) {
        TransferIconButton(icon, label, onClick, enabled, tint = accent ?: Mocha.secondaryText)
        return
    }
    val padding = PaddingValues(horizontal = 10.dp, vertical = 7.dp)
    val content: @Composable RowScope.() -> Unit = {
        Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp))
        Text(label, modifier = Modifier.padding(start = 6.dp))
    }
    if (accent != null) {
        FilledTonalButton(
            onClick = onClick,
            enabled = enabled,
            colors = ButtonDefaults.filledTonalButtonColors(containerColor = accent.copy(alpha = 0.13f), contentColor = accent),
            contentPadding = padding,
            content = content,
        )
    } else {
        TextButton(
            onClick = onClick,
            enabled = enabled,
            colors = ButtonDefaults.textButtonColors(contentColor = Mocha.secondaryText),
            contentPadding = padding,
            content = content,
        )
    }
}

@Composable
internal fun WorkspaceStatusBadge(status: WorkspaceStatus) {
    val (label, color) = when (status) {
        WorkspaceStatus.AVAILABLE -> "Available" to Mocha.green
        WorkspaceStatus.PAUSED -> "Paused" to Mocha.yellow
        WorkspaceStatus.UPLOADING -> "Uploading…" to Mocha.lavender
        WorkspaceStatus.LIMIT_REACHED -> "Limit reached" to Mocha.yellow
        WorkspaceStatus.EXPIRED -> "Expired" to Mocha.secondaryText
        WorkspaceStatus.DELETED -> "Deleted" to Mocha.secondaryText
    }
    Text(
        label,
        modifier = Modifier.background(color.copy(alpha = 0.13f), RoundedCornerShape(8.dp))
            .padding(horizontal = 7.dp, vertical = 3.dp),
        color = color,
        style = MaterialTheme.typography.labelSmall,
    )
}

@Composable
internal fun WorkspaceSectionTitle(title: String, modifier: Modifier = Modifier) {
    Text(
        title,
        modifier = modifier.semantics { heading() },
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
    )
}

@Composable
internal fun WorkspaceRefresh(label: String, loading: Boolean, refresh: () -> Unit, enabled: Boolean = true) {
    if (loading) {
        Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(19.dp), strokeWidth = 2.dp)
        }
    } else {
        TransferIconButton(Icons.Rounded.Refresh, label, refresh, enabled = enabled)
    }
}

@Composable
internal fun WorkspaceLoading(message: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        SupportingText(message)
    }
}

@Composable
internal fun WorkspaceDeleteAction(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    TransferIconButton(Icons.Rounded.Delete, label, onClick, enabled = enabled, tint = Mocha.red)
}

internal fun workspaceFileCount(count: Int): String = if (count == 1) "1 file" else "$count files"

private fun expirySummary(expiry: Instant?): String {
    if (expiry == null) return "No expiry"
    val now = Instant.now()
    if (!expiry.isAfter(now)) return "Expired"
    val remaining = Duration.between(now, expiry).toMillis()
    val days = ceil(remaining / 86_400_000.0).toLong()
    return when {
        remaining < 60_000 -> "Under 1 min left"
        remaining < 3_600_000 -> "${ceil(remaining / 60_000.0).toLong()} min left"
        days <= 1 -> "${ceil(remaining / 3_600_000.0).toLong()} hr left"
        days <= 2 -> "Expires tomorrow"
        days < 30 -> "$days days left"
        else -> formatDate(expiry)
    }
}
