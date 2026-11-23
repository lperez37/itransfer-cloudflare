package com.vivacityholding.itransfer.ui

import android.text.format.Formatter
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableIntState
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.vivacityholding.itransfer.Account
import com.vivacityholding.itransfer.DownloadTask
import com.vivacityholding.itransfer.MAX_EXACT_JSON_INTEGER
import com.vivacityholding.itransfer.Share
import com.vivacityholding.itransfer.ShareOptions
import com.vivacityholding.itransfer.TransferFile
import com.vivacityholding.itransfer.TransferUiState
import com.vivacityholding.itransfer.TransferViewModel
import com.vivacityholding.itransfer.UploadPhase
import com.vivacityholding.itransfer.UploadProgress
import com.vivacityholding.itransfer.WorkspaceAccess
import com.vivacityholding.itransfer.WorkspaceIdFormat
import com.vivacityholding.itransfer.WorkspaceTarget
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

private val screenGutter = 20.dp
private val cardShape = RoundedCornerShape(22.dp)
private val actionShape = RoundedCornerShape(16.dp)
private const val MIN_SHARE_LINK_LENGTH = 4
private const val DEFAULT_SHARE_LINK_LENGTH = 16

private class DraftFields(
    title: MutableState<String>,
    val expiry: WorkspaceExpiryInput,
    password: MutableState<String>,
    showOptions: MutableState<Boolean>,
    downloadLimit: MutableState<String>,
    idFormat: MutableState<WorkspaceIdFormat>,
    idLength: MutableIntState,
) {
    var title by title
    var password by password
    var showOptions by showOptions
    var downloadLimit by downloadLimit
    var idFormat by idFormat
    var idLength by idLength
    val hasOptions get() = title.isNotBlank() || !expiry.isDefault || password.isNotEmpty() ||
        downloadLimit.isNotEmpty() || idFormat != WorkspaceIdFormat.ANIMALS

    val validDownloadLimit get() = downloadLimit.toLongOrNull()?.takeIf { it in 1..MAX_EXACT_JSON_INTEGER }

    fun options(): ShareOptions? {
        val days = expiry.days ?: return null
        val limit = if (downloadLimit.isBlank()) null else validDownloadLimit ?: return null
        return ShareOptions(title.trim(), days, password, limit, idFormat.value, idLength)
    }
}

private data class WorkspaceChange(val target: WorkspaceTarget?, val manage: Boolean)

@Composable
internal fun TransferApp(
    state: TransferUiState,
    model: TransferViewModel,
    chooseFiles: () -> Unit,
    copyLink: (String) -> Unit,
    shareLink: (String) -> Unit,
    openWebsite: () -> Unit,
    startDownload: (DownloadTask, WorkspaceAccess?) -> Unit,
) {
    val draftVersion = state.draftVersion
    val fields = DraftFields(
        title = rememberSaveable(draftVersion) { mutableStateOf("") },
        expiry = rememberWorkspaceExpiryInput(draftVersion),
        password = remember(draftVersion) { mutableStateOf("") },
        showOptions = rememberSaveable(draftVersion) { mutableStateOf(false) },
        downloadLimit = rememberSaveable(draftVersion) { mutableStateOf("") },
        idFormat = rememberSaveable(draftVersion) { mutableStateOf(WorkspaceIdFormat.ANIMALS) },
        idLength = rememberSaveable(draftVersion) { mutableIntStateOf(DEFAULT_SHARE_LINK_LENGTH) },
    )
    val hasDraft = state.files.isNotEmpty() || state.importing || fields.hasOptions
    val access = state.access
    val account = state.account
    var accountOpen by rememberSaveable(account?.id) { mutableStateOf(false) }
    var setupToken by remember { mutableStateOf<String?>(null) }
    var workspaceChange by remember { mutableStateOf<WorkspaceChange?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val workspaceHistory = rememberSaveableStateHolder()
    val switchWorkspace = { target: WorkspaceTarget?, manage: Boolean ->
        if (hasDraft && access?.userId != (target?.id ?: account?.id)) {
            workspaceChange = WorkspaceChange(target, manage)
        } else {
            model.selectWorkspace(target, manage)
            accountOpen = false
        }
    }
    LaunchedEffect(state.downloadNotice) {
        state.downloadNotice?.let { snackbar.showSnackbar(it) }
        model.clearDownloadNotice()
    }

    TransferTheme {
        Surface(Modifier.fillMaxSize(), color = Mocha.crust) {
            Box(
                modifier = Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding(),
                contentAlignment = Alignment.TopCenter,
            ) {
                val sessionError = state.sessionError
                val completed = state.completed
                Column(Modifier.widthIn(max = 580.dp).fillMaxWidth().fillMaxHeight()) {
                    if (state.downloading) {
                        LinearProgressIndicator(
                            modifier = Modifier.fillMaxWidth().semantics {
                                contentDescription = "Saving download"
                            },
                            trackColor = Mocha.surface,
                        )
                    }
                    when {
                        setupToken != null -> PasswordSetupScreen(
                            api = model.api,
                            token = checkNotNull(setupToken),
                            onBack = {
                                setupToken = null
                                model.closePublicLink()
                            },
                            onComplete = {
                                setupToken = null
                                model.passwordChanged()
                            },
                        )
                        state.publicScreen -> key(state.publicUrl) {
                            PublicLinkScreen(
                                api = model.api,
                                initialUrl = state.publicUrl,
                                onBack = model::closePublicLink,
                                onPasswordSetup = { setupToken = it },
                                startDownload = { startDownload(it, null) },
                            )
                        }
                        state.restoring -> SessionPanel(title = "Opening your workspace", loading = true)
                        sessionError != null -> SessionPanel(
                            title = "Workspace unavailable",
                            message = sessionError,
                            actionLabel = "Try again",
                            action = model::restoreSession,
                        )
                        account == null || access == null -> LoginScreen(state, model::signIn) { model.openPublicLink() }
                        account.passwordChangeRequired || (accountOpen && completed == null && !state.draftOpen) ->
                            AccountToolsScreen(
                                api = model.api,
                                account = account,
                                credentials = access.credentials,
                                onBack = { accountOpen = false },
                                onSignOut = model::signOut,
                                onPasswordChanged = model::passwordChanged,
                                onSelectWorkspace = switchWorkspace,
                                onSessionError = { model.onSessionError(access, it) },
                                copyLink = copyLink,
                                shareLink = shareLink,
                                openWebsite = openWebsite,
                            )
                        completed != null -> ResultScreen(completed, model::finishShare, copyLink, shareLink, model::openPublicLink)
                        state.draftOpen && !access.readOnly -> DraftScreen(state, model, chooseFiles, fields, hasDraft)
                        else -> {
                            workspaceHistory.SaveableStateProvider("${account.id}:${access.userId}:${access.manage}") {
                                WorkspaceScreen(
                                    api = model.api,
                                    access = access,
                                    shares = state.shares,
                                    refreshing = state.refreshing,
                                    sharesError = state.sharesError,
                                    onRefreshShares = model::refreshShares,
                                    draftAvailable = hasDraft,
                                    onNewShare = model::openDraft,
                                    onSessionError = { model.onSessionError(access, it) },
                                    copyLink = copyLink,
                                    shareLink = shareLink,
                                    openLink = model::openPublicLink,
                                    startDownload = { startDownload(it, access) },
                                    dashboardHeader = { BrandHeader(account, { model.openPublicLink() }) { accountOpen = true } },
                                    workspaceStatus = {
                                        access.target?.let { target ->
                                            WorkspaceBanner(target, access.manage, { switchWorkspace(null, false) }) {
                                                if (access.manage) switchWorkspace(target, false) else accountOpen = true
                                            }
                                        }
                                        (state.workspaceNotice ?: state.importError)?.let { notice ->
                                            Box(Modifier.padding(horizontal = screenGutter)) {
                                                Notice(notice, dismiss = {
                                                    model.clearWorkspaceNotice()
                                                    model.clearImportError()
                                                })
                                            }
                                        }
                                    },
                                )
                            }
                        }
                    }
                }
                SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(horizontal = screenGutter))
            }
            workspaceChange?.let { change ->
                AlertDialog(
                    onDismissRequest = { workspaceChange = null },
                    title = { Text("Switch workspace?") },
                    text = { Text("Switching workspaces will discard this share draft.") },
                    dismissButton = {
                        TextButton(onClick = { workspaceChange = null }) { Text("Keep draft") }
                    },
                    confirmButton = {
                        TextButton(onClick = {
                            model.selectWorkspace(change.target, change.manage)
                            workspaceChange = null
                            accountOpen = false
                        }) { Text("Switch and discard draft", color = Mocha.red) }
                    },
                )
            }
        }
    }
}

@Composable
private fun SessionPanel(
    title: String,
    message: String? = null,
    loading: Boolean = false,
    actionLabel: String? = null,
    action: () -> Unit = {},
) {
    BrandHeader()
    Column(
        modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(screenGutter),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Title(title)
        if (message != null) SupportingText(message)
        if (loading) CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
        if (actionLabel != null) PrimaryButton(actionLabel, action)
    }
}

@Composable
private fun LoginScreen(state: TransferUiState, signIn: (String, String) -> Unit, openPublicLink: () -> Unit) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val focus = LocalFocusManager.current
    val ready = email.isNotBlank() && password.isNotEmpty() && !state.signingIn
    val submit = {
        if (ready) {
            focus.clearFocus()
            signIn(email.trim(), password)
        }
    }

    BrandHeader()
    Column(
        modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(screenGutter),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        TransferArtwork(Modifier.align(Alignment.CenterHorizontally).size(170.dp, 116.dp))
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Title("Sign in to iTransfer")
            SupportingText("Use your existing iTransfer account.")
        }
        if (state.files.isNotEmpty()) {
            Notice("${fileCountText(state.files.size)} ready to share after sign-in.", error = false)
        }
        state.authError?.let { Notice(it) }
        Panel {
            OutlinedTextField(
                value = email,
                onValueChange = { email = it.take(254) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Email") },
                enabled = !state.signingIn,
                shape = actionShape,
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
            )
            PasswordField(
                value = password,
                onValueChange = { password = it.take(256) },
                label = "Password",
                enabled = !state.signingIn,
                done = submit,
            )
            PrimaryButton(if (state.signingIn) "Signing in…" else "Sign in", submit, enabled = ready)
        }
        OutlinedAction("Open a share or request link", openPublicLink, enabled = !state.signingIn)
    }
}

@Composable
private fun WorkspaceBanner(target: WorkspaceTarget, manage: Boolean, returnToOwn: () -> Unit, changeAccess: () -> Unit) {
    Surface(
        modifier = Modifier.padding(horizontal = screenGutter),
        shape = actionShape,
        color = Mocha.base,
        border = BorderStroke(1.dp, Mocha.border),
    ) {
        Column(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 12.dp)) {
            Text(if (manage) "Managing ${target.name}’s workspace" else "Viewing ${target.name}’s workspace", fontWeight = FontWeight.SemiBold)
            SupportingText(if (manage) "Changes apply to this workspace." else "Read-only access", small = true)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                TextButton(onClick = returnToOwn) { Text("My workspace") }
                TextButton(onClick = changeAccess) { Text(if (manage) "Read-only" else "Manage…") }
            }
        }
    }
}

@Composable
private fun DraftScreen(
    state: TransferUiState,
    model: TransferViewModel,
    chooseFiles: () -> Unit,
    fields: DraftFields,
    hasDraft: Boolean,
) {
    var confirmDraftExit by remember { mutableStateOf(false) }
    var confirmCancel by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current

    val upload = state.upload
    val shareOptions = fields.options()
    val confirming = upload?.phase == UploadPhase.CONFIRMING
    val canCancelUpload = upload != null && !confirming
    val close = {
        when {
            confirming -> Unit
            canCancelUpload -> confirmCancel = true
            hasDraft -> confirmDraftExit = true
            else -> model.closeDraft()
        }
    }
    LaunchedEffect(canCancelUpload) {
        if (!canCancelUpload) confirmCancel = false
    }
    BackHandler(onBack = close)
    ScreenHeader("New share", close, backEnabled = !confirming)

    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier.fillMaxWidth().weight(1f),
            verticalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding = PaddingValues(start = screenGutter, end = screenGutter, top = 14.dp, bottom = 18.dp),
        ) {
            if (upload != null) {
                item { UploadCard(upload) }
            } else {
                item {
                    ShareFilesPicker(state.files, state.importing, chooseFiles)
                }
                if (state.importError != null) {
                    item { Notice(state.importError, dismiss = model::clearImportError) }
                }
                if (state.uploadError != null) {
                    item { Notice(state.uploadError) }
                }
            }
            if (upload == null) {
                item {
                    OutlinedTextField(
                        value = fields.title,
                        onValueChange = { fields.title = it.take(256) },
                        modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                        label = { Text("Title (optional)") },
                        shape = actionShape,
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    )
                }
                item { WorkspaceExpiryFields(fields.expiry, enabled = true) }
                item {
                    TransferLinkFormatFields(
                        format = fields.idFormat,
                        onFormatChange = { fields.idFormat = it },
                        length = fields.idLength,
                        onLengthChange = { fields.idLength = it },
                        minLength = MIN_SHARE_LINK_LENGTH,
                    )
                }
            }
            if (state.files.isNotEmpty()) {
                items(state.files, key = { it.id }) { file ->
                    FileRow(file, canRemove = upload == null, onRemove = { model.removeFile(file.id) })
                }
            }
            if (upload == null) {
                item { ShareProtectionOptions(fields) }
            }
        }
        if (!confirming) {
            ComposerFooter {
                if (canCancelUpload) {
                    OutlinedAction("Cancel upload", { confirmCancel = true }, Icons.Rounded.Close)
                } else {
                    PrimaryButton(
                        "Create share",
                        {
                            focus.clearFocus()
                            shareOptions?.let(model::createShare)
                        },
                        icon = Icons.AutoMirrored.Rounded.Send,
                        enabled = state.files.isNotEmpty() && !state.importing && shareOptions != null,
                    )
                }
            }
        }
    }

    if (confirmDraftExit) {
        AlertDialog(
            onDismissRequest = { confirmDraftExit = false },
            title = { Text("Keep this draft?") },
            text = { Text("Keep your files and link options to finish later.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDraftExit = false
                    model.closeDraft()
                }) { Text("Keep draft") }
            },
            dismissButton = {
                TextButton(onClick = {
                    confirmDraftExit = false
                    model.discardDraft()
                }) { Text("Discard draft", color = Mocha.red) }
            },
        )
    }
    if (confirmCancel && canCancelUpload) {
        AlertDialog(
            onDismissRequest = { confirmCancel = false },
            title = { Text("Cancel upload?") },
            text = { Text("Your selected files will stay in this draft.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmCancel = false
                    model.cancelUpload()
                }) { Text("Cancel upload", color = Mocha.red) }
            },
            dismissButton = {
                TextButton(onClick = { confirmCancel = false }) { Text("Keep uploading") }
            },
        )
    }
}

@Composable
private fun ShareFilesPicker(files: List<TransferFile>, importing: Boolean, chooseFiles: () -> Unit) {
    Panel(padding = 12) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            FileTile(Mocha.mauve)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                WorkspaceSectionTitle("Files")
                SupportingText(
                    if (files.isEmpty()) "No files added" else "${fileCountText(files.size)} · ${byteSize(files.sumOf { it.size })}",
                    small = true,
                )
            }
            TextButton(onClick = chooseFiles, enabled = !importing, modifier = Modifier.heightIn(min = 48.dp)) {
                Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(17.dp))
                Text(if (importing) "Reading…" else "Add files", modifier = Modifier.padding(start = 4.dp))
            }
        }
    }
}

@Composable
private fun ShareProtectionOptions(fields: DraftFields) {
    TransferOptionalSettings(
        title = "Password and download limit",
        expanded = fields.showOptions,
        toggle = { fields.showOptions = !fields.showOptions },
    ) {
        PasswordField(fields.password, { fields.password = it.take(128) }, "Password (optional)")
        ShareNumberField(
            fields.downloadLimit, { fields.downloadLimit = it.take(16) }, "Maximum downloads",
            "Leave blank for unlimited downloads",
            fields.downloadLimit.isNotEmpty() && fields.validDownloadLimit == null,
        )
    }
}

@Composable
private fun ShareNumberField(value: String, update: (String) -> Unit, label: String, hint: String, invalid: Boolean) {
    OutlinedTextField(
        value = value,
        onValueChange = { typed -> update(typed.filter { it in '0'..'9' }) },
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        supportingText = { Text(hint) },
        isError = invalid,
        singleLine = true,
        shape = actionShape,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
    )
}

@Composable
private fun FileRow(file: TransferFile, canRemove: Boolean, onRemove: () -> Unit) {
    Surface(shape = actionShape, border = BorderStroke(1.dp, Mocha.border.copy(alpha = 0.72f))) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 12.dp, top = 6.dp, bottom = 6.dp, end = if (canRemove) 3.dp else 12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FileTile(Mocha.lavender)
            Column(Modifier.weight(1f)) {
                Text(file.name, maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
                SupportingText(byteSize(file.size), small = true)
            }
            if (canRemove) {
                IconButton(onClick = onRemove) {
                    Icon(Icons.Rounded.Close, contentDescription = "Remove ${file.name}", tint = Mocha.secondaryText)
                }
            }
        }
    }
}

@Composable
private fun UploadCard(progress: UploadProgress) {
    val fraction = if (progress.totalBytes > 0) {
        (progress.sentBytes.toDouble() / progress.totalBytes).coerceIn(0.0, 1.0).toFloat()
    } else {
        0f
    }
    val title = when (progress.phase) {
        UploadPhase.PREPARING -> "Preparing upload"
        UploadPhase.UPLOADING -> "Uploading files"
        UploadPhase.CONFIRMING -> "Creating your link"
    }
    val determinate = progress.phase == UploadPhase.UPLOADING && progress.totalBytes > 0
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                title,
                modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite },
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )
            if (determinate) {
                val percent = if (progress.sentBytes >= progress.totalBytes) 100 else (fraction * 100).toInt().coerceAtMost(99)
                Text("$percent%", color = Mocha.mauve, fontFamily = FontFamily.Monospace)
            }
        }
        if (determinate) {
            LinearProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxWidth(), trackColor = Mocha.surface)
            SupportingText("${byteSize(progress.sentBytes)} of ${byteSize(progress.totalBytes)}", small = true)
        } else {
            LinearProgressIndicator(Modifier.fillMaxWidth(), trackColor = Mocha.surface)
        }
        progress.currentFile?.let {
            Text(it, color = Mocha.secondaryText, overflow = TextOverflow.Ellipsis, maxLines = 2)
        }
    }
}

@Composable
private fun ResultScreen(
    share: Share,
    finish: () -> Unit,
    copyLink: (String) -> Unit,
    shareLink: (String) -> Unit,
    openLink: (String) -> Unit,
) {
    BackHandler(onBack = finish)
    ScreenHeader("Share created", finish)
    Column(
        modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(screenGutter),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        TransferLinkResult(
            share.link,
            "${fileCountText(share.fileCount)} · ${byteSize(share.totalBytes)}",
            copyLink,
            shareLink,
            openLink,
        )
        TextButton(onClick = finish, modifier = Modifier.align(Alignment.CenterHorizontally)) {
            Text("Done")
        }
    }
}

@Composable
private fun BrandHeader(account: Account? = null, openPublicLink: (() -> Unit)? = null, showAccount: () -> Unit = {}) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = screenGutter, end = screenGutter, top = 6.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        BrandMark()
        Text("iTransfer", modifier = Modifier.weight(1f), fontWeight = FontWeight.Bold, fontSize = 23.sp, letterSpacing = (-0.55).sp)
        if (openPublicLink != null) TransferIconButton(TransferIcons.Link, "Open link", openPublicLink, tint = Mocha.lavender)
        if (account != null) {
            val initials = account.name.split(Regex("\\s+")).filter(String::isNotBlank).take(2)
                .joinToString("") { it.take(1).uppercase() }.ifEmpty { account.email.take(1).uppercase() }
            Surface(
                onClick = showAccount,
                modifier = Modifier.size(48.dp).semantics { contentDescription = "Account for ${account.name}" },
                shape = CircleShape,
                color = Mocha.base,
                border = BorderStroke(1.dp, Mocha.border),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(initials, color = Mocha.mauve, fontWeight = FontWeight.Bold, maxLines = 1)
                }
            }
        }
    }
}

@Composable
internal fun ScreenHeader(
    title: String,
    back: () -> Unit,
    backEnabled: Boolean = true,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 8.dp, end = screenGutter, top = 6.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        IconButton(onClick = back, enabled = backEnabled) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back") }
        Text(
            title,
            modifier = Modifier.weight(1f).semantics { heading() },
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
        )
        actions()
    }
}

@Composable
internal fun Title(text: String) {
    Text(
        text,
        modifier = Modifier.semantics { heading() },
        style = MaterialTheme.typography.headlineMedium,
        fontWeight = FontWeight.Bold,
        letterSpacing = (-0.8).sp,
    )
}

@Composable
internal fun SupportingText(text: String, small: Boolean = false) {
    Text(text, color = Mocha.secondaryText, style = if (small) MaterialTheme.typography.bodySmall else MaterialTheme.typography.bodyMedium)
}

@Composable
internal fun Panel(padding: Int = 16, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = cardShape,
        border = BorderStroke(1.dp, Mocha.border.copy(alpha = 0.58f)),
        color = Mocha.mantle,
    ) {
        Column(Modifier.padding(padding.dp), verticalArrangement = Arrangement.spacedBy(if (padding == 0) 0.dp else 12.dp), content = content)
    }
}

@Composable
internal fun PrimaryButton(
    label: String,
    onClick: () -> Unit,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    modifier: Modifier = Modifier,
    accent: Color = Mocha.mauve,
) {
    Button(
        onClick = onClick,
        modifier = modifier.fillMaxWidth().heightIn(min = 52.dp),
        enabled = enabled,
        shape = actionShape,
        colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = Mocha.crust),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
    ) {
        if (icon != null) Icon(icon, contentDescription = null, modifier = Modifier.padding(end = 8.dp).size(20.dp))
        Text(label, fontWeight = FontWeight.Bold)
    }
}

@Composable
internal fun ComposerFooter(content: @Composable ColumnScope.() -> Unit) {
    HorizontalDivider(color = Mocha.border.copy(alpha = 0.55f))
    Column(
        Modifier.fillMaxWidth().padding(horizontal = screenGutter, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
    )
}

@Composable
internal fun OutlinedAction(label: String, onClick: () -> Unit, icon: ImageVector? = null, enabled: Boolean = true) {
    OutlinedButton(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        enabled = enabled,
        shape = actionShape,
        border = BorderStroke(1.dp, Mocha.border),
    ) {
        if (icon != null) Icon(icon, contentDescription = null, modifier = Modifier.padding(end = 8.dp).size(19.dp))
        Text(label, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
internal fun Notice(message: String, error: Boolean = true, success: Boolean = false, dismiss: (() -> Unit)? = null) {
    val (color, icon) = when {
        error -> Mocha.red to Icons.Rounded.Warning
        success -> Mocha.green to Icons.Rounded.CheckCircle
        else -> Mocha.lavender to Icons.Rounded.Info
    }
    Surface(shape = actionShape, color = color.copy(alpha = 0.09f), border = BorderStroke(1.dp, color.copy(alpha = 0.25f))) {
        Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, end = if (dismiss == null) 12.dp else 2.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(18.dp))
            Text(message, modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodyMedium)
            if (dismiss != null) IconButton(onClick = dismiss) { Icon(Icons.Rounded.Close, contentDescription = "Dismiss message") }
        }
    }
}

@Composable
internal fun PasswordField(value: String, onValueChange: (String) -> Unit, label: String, enabled: Boolean = true, done: (() -> Unit)? = null) {
    var visible by remember { mutableStateOf(false) }
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        enabled = enabled,
        shape = actionShape,
        singleLine = true,
        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { if (done != null) done() else defaultKeyboardAction(ImeAction.Done) }),
        trailingIcon = {
            IconButton(enabled = enabled, onClick = { visible = !visible }) {
                EyeGlyph(visible, if (visible) "Hide password" else "Show password")
            }
        },
    )
}

@Composable
internal fun FileTile(color: Color) {
    Box(Modifier.size(40.dp).background(color.copy(alpha = 0.12f), RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(20.dp)) {
            val unit = size.width / 20f
            val page = Path().apply {
                moveTo(5 * unit, 2 * unit)
                lineTo(11 * unit, 2 * unit)
                lineTo(16 * unit, 7 * unit)
                lineTo(16 * unit, 18 * unit)
                lineTo(5 * unit, 18 * unit)
                close()
            }
            drawPath(page, color, style = Stroke(1.4f * unit))
            drawLine(color, Offset(7.5f * unit, 10 * unit), Offset(13.5f * unit, 10 * unit), unit, StrokeCap.Round)
            drawLine(color, Offset(7.5f * unit, 13 * unit), Offset(12 * unit, 13 * unit), unit, StrokeCap.Round)
        }
    }
}

@Composable
private fun EyeGlyph(visible: Boolean, label: String) {
    Canvas(Modifier.size(22.dp).semantics { contentDescription = label }) {
        val unit = size.width / 22f
        val eye = Path().apply {
            moveTo(2 * unit, 11 * unit)
            quadraticTo(11 * unit, 1.5f * unit, 20 * unit, 11 * unit)
            quadraticTo(11 * unit, 20.5f * unit, 2 * unit, 11 * unit)
            close()
        }
        drawPath(eye, Mocha.secondaryText, style = Stroke(1.4f * unit))
        drawCircle(Mocha.secondaryText, radius = 2.4f * unit, center = Offset(11 * unit, 11 * unit))
        if (visible) drawLine(Mocha.secondaryText, Offset(4 * unit, 17.5f * unit), Offset(18 * unit, 4.5f * unit), 1.5f * unit, StrokeCap.Round)
    }
}

@Composable
internal fun LinkText(link: String) {
    Text(
        link,
        Modifier.fillMaxWidth().background(Mocha.crust, actionShape).padding(12.dp),
        color = Mocha.lavender,
        fontFamily = FontFamily.Monospace,
        style = MaterialTheme.typography.bodySmall,
    )
}

@Composable
internal fun byteSize(size: Long): String = Formatter.formatShortFileSize(LocalContext.current, size)

private fun fileCountText(count: Int): String = if (count == 1) "1 file" else "$count files"

internal fun formatDate(instant: Instant): String =
    DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withZone(ZoneId.systemDefault()).format(instant)
