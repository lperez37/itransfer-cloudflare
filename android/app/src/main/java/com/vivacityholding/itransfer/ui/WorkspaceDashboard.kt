package com.vivacityholding.itransfer.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
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
import androidx.compose.ui.graphics.Color
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
        ) {
            item(key = "workspace-start") {
                Box(Modifier.padding(bottom = 14.dp)) {
                    WorkspaceCover(tab, readOnly, tab == WorkspaceKind.SHARE && draftAvailable) {
                        state.exitSelection()
                        if (tab == WorkspaceKind.SHARE) newShare() else newRequest()
                    }
                }
            }
            item(key = "workspace-controls") {
                Column(Modifier.padding(bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val searchLabel = "Search ${tab.plural}"
                        TextField(
                            value = state.query,
                            onValueChange = {
                                state.query = it
                                state.selectedIds = emptySet()
                            },
                            modifier = Modifier.weight(1f).semantics { contentDescription = searchLabel },
                            placeholder = {
                                val hint = if (LocalDensity.current.fontScale > 1.1f) "Search" else searchLabel
                                Text(hint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            },
                            singleLine = true,
                            leadingIcon = { Icon(Icons.Rounded.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
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
                                focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                                unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
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
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
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
                                    containerColor = Color.Transparent,
                                    labelColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                    selectedContainerColor = MaterialTheme.colorScheme.onSurface,
                                    selectedLabelColor = MaterialTheme.colorScheme.surface,
                                ),
                            )
                        }
                    }
                }
            }
            loadError?.let { message ->
                item(key = "workspace-load-error") {
                    Column(Modifier.padding(bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Notice(message)
                        OutlinedAction("Try again", refresh, enabled = !loading)
                    }
                }
            }
            feedback?.let {
                item(key = "workspace-feedback") {
                    Box(Modifier.padding(bottom = 10.dp)) {
                        Notice(it.message, error = it.error, success = !it.error, dismiss = dismissFeedback)
                    }
                }
            }
            if (preparingDownload) {
                item(key = "workspace-download-progress") { WorkspaceLoading("Preparing download…") }
            }
            if (visible.isEmpty() && !loading && loadError == null) {
                item(key = "workspace-empty") {
                    Panel(padding = 22) {
                        val empty = entries.isEmpty() && query.isEmpty()
                        Icon(tab.icon, contentDescription = null, tint = accent, modifier = Modifier.size(28.dp))
                        WorkspaceSectionTitle(if (empty) "No ${tab.plural} yet" else "No matching ${tab.plural}")
                        if (empty && !readOnly && tab == WorkspaceKind.SHARE) {
                            SupportingText("Choose iTransfer from another app’s share menu to add files directly.")
                        }
                    }
                }
            }
            itemsIndexed(visible, key = { _, entry -> "entry:${entry.id}" }) { index, entry ->
                WorkspaceDashboardRow(
                    entry = entry,
                    first = index == 0,
                    last = index == visible.lastIndex,
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
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.58f))
            Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
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

private val WorkspaceKind.accent: Color
    @Composable get() = if (this == WorkspaceKind.SHARE) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.secondary

private val WorkspaceKind.icon get() = if (this == WorkspaceKind.SHARE) Icons.AutoMirrored.Rounded.Send else TransferIcons.Inbox
private val WorkspaceKind.tabLabel get() = if (this == WorkspaceKind.SHARE) "Shares" else "Requests"

@Composable
private fun WorkspaceDock(active: WorkspaceKind, select: (WorkspaceKind) -> Unit) {
    val colors = MaterialTheme.colorScheme
    HorizontalDivider(color = colors.outlineVariant.copy(alpha = 0.65f))
    NavigationBar(containerColor = colors.surface, tonalElevation = 0.dp, windowInsets = WindowInsets(0, 0, 0, 0)) {
        for (kind in WorkspaceKind.entries) {
            NavigationBarItem(
                selected = kind == active,
                onClick = { select(kind) },
                icon = { Icon(kind.icon, contentDescription = null, modifier = Modifier.size(22.dp)) },
                label = { Text(kind.tabLabel, style = MaterialTheme.typography.labelMedium) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = kind.accent,
                    selectedTextColor = kind.accent,
                    indicatorColor = if (kind == WorkspaceKind.SHARE) colors.primaryContainer else colors.secondaryContainer,
                    unselectedIconColor = colors.onSurfaceVariant,
                    unselectedTextColor = colors.onSurfaceVariant,
                ),
            )
        }
    }
}

@Composable
private fun WorkspaceCover(kind: WorkspaceKind, readOnly: Boolean, hasDraft: Boolean, create: () -> Unit) {
    TransferCover(kind.tabLabel, receiving = kind == WorkspaceKind.REQUEST) {
        if (!readOnly) {
            Button(
                onClick = create,
                colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Color(0xFF182135)),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
            ) {
                Icon(
                    if (hasDraft) Icons.AutoMirrored.Rounded.ArrowForward else Icons.Rounded.Add,
                    contentDescription = null, modifier = Modifier.size(17.dp),
                )
                Text(if (hasDraft) "Continue draft" else "New ${kind.singular}", modifier = Modifier.padding(start = 6.dp))
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WorkspaceDashboardRow(
    entry: WorkspaceEntry,
    first: Boolean,
    last: Boolean,
    selecting: Boolean,
    checked: Boolean,
    onSelect: ((Boolean) -> Unit)?,
    showDetails: () -> Unit,
    copyLink: () -> Unit,
    download: () -> Unit,
    downloadEnabled: Boolean,
    purge: (() -> Unit)?,
) {
    val colors = MaterialTheme.colorScheme
    val accent = entry.kind.accent
    val status = entry.status
    val top = if (first) 20.dp else 0.dp
    val bottom = if (last) 20.dp else 0.dp
    val shape = RoundedCornerShape(topStart = top, topEnd = top, bottomStart = bottom, bottomEnd = bottom)

    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = shape,
        color = if (checked) colors.primaryContainer else colors.surface,
    ) {
        Column {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val fontScale = LocalDensity.current.fontScale
                val showTile = maxWidth >= 300.dp && fontScale <= 1.35f
                val inlineCopy = status.showsLink && maxWidth >= 345.dp && fontScale <= 1.15f
                Row(Modifier.fillMaxWidth().padding(end = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    Row(
                        Modifier.weight(1f).combinedClickable(
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
                        }.padding(start = 14.dp, end = 2.dp, top = 14.dp, bottom = 14.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (selecting && onSelect != null) {
                            Checkbox(checked = checked, onCheckedChange = null)
                        } else if (showTile) {
                            if (entry.kind == WorkspaceKind.SHARE) FileTile(accent)
                            else Box(
                                Modifier.size(40.dp).background(colors.secondaryContainer, RoundedCornerShape(12.dp)),
                                contentAlignment = Alignment.Center,
                            ) { Icon(entry.kind.icon, null, Modifier.size(21.dp), tint = accent) }
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(entry.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            val size = entry.totalBytes?.let { " · ${byteSize(it)}" }.orEmpty()
                            val label = entry.kind.countLabel.lowercase().let {
                                if (entry.count == 1L && entry.limit == null) it.removeSuffix("s") else it
                            }
                            SupportingText("${workspaceFileCount(entry.fileCount)}$size · ${entry.countText} $label", small = true)
                            Row(
                                modifier = Modifier.padding(top = 2.dp),
                                horizontalArrangement = Arrangement.spacedBy(7.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                WorkspaceStatusBadge(status)
                                if (status != WorkspaceStatus.EXPIRED) {
                                    Text(expirySummary(entry.expiresAt), color = colors.onSurfaceVariant, style = MaterialTheme.typography.labelSmall)
                                }
                            }
                        }
                    }
                    if (!selecting) {
                        if (inlineCopy) TransferIconButton(TransferIcons.Copy, "Copy link", copyLink, tint = accent)
                        val menuCopy = status.showsLink && !inlineCopy
                        if (menuCopy || entry.canDownload || purge != null) {
                            EntryMenu(entry.title, if (menuCopy) copyLink else null, if (entry.canDownload) download else null, downloadEnabled, purge)
                        }
                    }
                }
            }
            if (!last) HorizontalDivider(Modifier.padding(horizontal = 14.dp), color = colors.outlineVariant.copy(alpha = 0.65f))
        }
    }
}

@Composable
private fun EntryMenu(title: String, copy: (() -> Unit)?, download: (() -> Unit)?, downloadEnabled: Boolean, purge: (() -> Unit)?) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        TransferIconButton(Icons.Rounded.MoreVert, "Actions for $title", { expanded = true })
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            if (copy != null) DropdownMenuItem(
                text = { Text("Copy link") }, leadingIcon = { Icon(TransferIcons.Copy, null) },
                onClick = {
                    expanded = false
                    copy()
                },
            )
            if (download != null) DropdownMenuItem(
                text = { Text("Download") }, leadingIcon = { Icon(TransferIcons.Download, null) },
                onClick = {
                    expanded = false
                    download()
                },
                enabled = downloadEnabled,
            )
            if (purge != null) DropdownMenuItem(
                text = { Text("Delete permanently", color = MaterialTheme.colorScheme.error) },
                leadingIcon = { Icon(Icons.Rounded.Delete, null, tint = MaterialTheme.colorScheme.error) },
                onClick = {
                    expanded = false
                    purge()
                },
            )
        }
    }
}

@Composable
internal fun WorkspaceStatusBadge(status: WorkspaceStatus) {
    val (label, color) = when (status) {
        WorkspaceStatus.AVAILABLE -> "Available" to MaterialTheme.colorScheme.secondary
        WorkspaceStatus.PAUSED -> "Paused" to MaterialTheme.colorScheme.tertiary
        WorkspaceStatus.UPLOADING -> "Uploading…" to MaterialTheme.colorScheme.primary
        WorkspaceStatus.LIMIT_REACHED -> "Limit reached" to MaterialTheme.colorScheme.tertiary
        WorkspaceStatus.EXPIRED -> "Expired" to MaterialTheme.colorScheme.onSurfaceVariant
        WorkspaceStatus.DELETED -> "Deleted" to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(6.dp).background(color, CircleShape))
        Text(label, color = color, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
    }
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
    TransferIconButton(Icons.Rounded.Delete, label, onClick, enabled = enabled, tint = MaterialTheme.colorScheme.error)
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
