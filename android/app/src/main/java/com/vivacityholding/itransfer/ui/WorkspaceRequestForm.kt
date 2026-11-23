package com.vivacityholding.itransfer.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowDropDown
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableIntState
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.vivacityholding.itransfer.MAX_EXACT_JSON_INTEGER
import com.vivacityholding.itransfer.MAX_TRANSFER_EXPIRY_DAYS
import com.vivacityholding.itransfer.WorkspaceIdFormat
import com.vivacityholding.itransfer.WorkspaceRequestOptions
import com.vivacityholding.itransfer.WorkspaceTransferApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.math.BigDecimal
import kotlin.math.roundToInt

private const val MIN_LINK_LENGTH = 9
internal const val MAX_LINK_LENGTH = 64

private enum class WorkspaceSizeUnit(val label: String, val bytes: Long) {
    MB("MB", 1024L * 1024),
    GB("GB", 1024L * 1024 * 1024),
}

private enum class WorkspaceTimeUnit(val label: String, val unitsPerDay: Double) {
    MINUTES("Minutes", 1440.0),
    HOURS("Hours", 24.0),
    DAYS("Days", 1.0),
}

private data class WorkspaceExpiryPreset(val label: String, val days: Double?)

private val workspaceExpiryPresets = listOf(
    WorkspaceExpiryPreset("5 minutes", 5.0 / 1440),
    WorkspaceExpiryPreset("15 minutes", 15.0 / 1440),
    WorkspaceExpiryPreset("30 minutes", 30.0 / 1440),
    WorkspaceExpiryPreset("1 hour", 1.0 / 24),
    WorkspaceExpiryPreset("24 hours", 1.0),
    WorkspaceExpiryPreset("7 days", 7.0),
    WorkspaceExpiryPreset("30 days", 30.0),
    WorkspaceExpiryPreset("90 days", 90.0),
    WorkspaceExpiryPreset("365 days", 365.0),
    WorkspaceExpiryPreset("Custom", null),
)

internal class WorkspaceExpiryInput(
    selection: MutableIntState,
    amount: MutableState<String>,
    unit: MutableIntState,
) {
    var selection by selection
    var amount by amount
    var unit by unit
    private val preset get() = workspaceExpiryPresets[selection]
    val custom: Boolean get() = preset.days == null
    val isDefault: Boolean get() = preset.days == 7.0
    val days: Double?
        get() = preset.days
            ?: amount.workspaceDecimal()?.toDouble()
                ?.div(WorkspaceTimeUnit.entries[unit].unitsPerDay)
                ?.takeIf { it > 0.0 && it <= MAX_TRANSFER_EXPIRY_DAYS }
}

@Composable
internal fun rememberWorkspaceExpiryInput(draftVersion: Int? = null): WorkspaceExpiryInput {
    val selection = rememberSaveable(draftVersion) {
        mutableIntStateOf(workspaceExpiryPresets.indexOfFirst { it.days == 7.0 })
    }
    val amount = rememberSaveable(draftVersion) { mutableStateOf("") }
    val unit = rememberSaveable(draftVersion) { mutableIntStateOf(WorkspaceTimeUnit.DAYS.ordinal) }
    return remember(selection, amount, unit) { WorkspaceExpiryInput(selection, amount, unit) }
}

@Composable
internal fun WorkspaceRequestComposer(
    client: WorkspaceTransferApi,
    back: () -> Unit,
    onCreated: () -> Unit,
    onSessionError: (Exception) -> Unit,
    copyLink: (String) -> Unit,
    shareLink: (String) -> Unit,
    openLink: (String) -> Unit,
) {
    var resultLink by rememberSaveable { mutableStateOf<String?>(null) }
    val link = resultLink
    if (link == null) {
        WorkspaceRequestForm(
            client = client,
            back = back,
            onSessionError = onSessionError,
            created = { createdLink ->
                resultLink = createdLink
                onCreated()
            },
        )
    } else {
        BackHandler(onBack = back)
        ScreenHeader("Request created", back)
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = workspaceListPadding,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                TransferLinkResult(
                    link,
                    "Recipients can upload files with this link.",
                    copyLink,
                    shareLink,
                    openLink,
                    accent = MaterialTheme.colorScheme.secondary,
                )
            }
            item { OutlinedAction("Create another request", { resultLink = null }) }
            item { TextButton(onClick = back, modifier = Modifier.fillMaxWidth()) { Text("Back to requests") } }
        }
    }
}

@Composable
private fun WorkspaceRequestForm(
    client: WorkspaceTransferApi,
    back: () -> Unit,
    created: (String) -> Unit,
    onSessionError: (Exception) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var title by rememberSaveable { mutableStateOf("") }
    var message by rememberSaveable { mutableStateOf("") }
    var maxUploads by rememberSaveable { mutableStateOf("") }
    var maxFileSize by rememberSaveable { mutableStateOf("") }
    var sizeUnit by rememberSaveable { mutableIntStateOf(WorkspaceSizeUnit.GB.ordinal) }
    var idFormat by rememberSaveable { mutableStateOf(WorkspaceIdFormat.ANIMALS) }
    var idLength by rememberSaveable { mutableIntStateOf(10) }
    var incremental by rememberSaveable { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var showOptions by rememberSaveable { mutableStateOf(false) }
    val expiry = rememberWorkspaceExpiryInput()
    val focus = LocalFocusManager.current
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun submit() {
        if (saving) return
        val requestTitle = title.trim()
        val requestMessage = message.trim()
        val expiryDays = expiry.days
        val uploadLimit = maxUploads.trim().toLongOrNull()?.takeIf { it in 1..MAX_EXACT_JSON_INTEGER }
        val fileSizeLimit = maxFileSize.workspaceDecimal()
            ?.multiply(BigDecimal.valueOf(WorkspaceSizeUnit.entries[sizeUnit].bytes))
            ?.takeIf { it >= BigDecimal.ONE && it <= BigDecimal.valueOf(MAX_EXACT_JSON_INTEGER) }
            ?.toLong()
        error = when {
            requestTitle.isEmpty() -> "Enter a title."
            requestTitle.length > 256 -> "Use 256 characters or fewer for the title."
            requestMessage.length > 2048 -> "Use 2,048 characters or fewer for the message."
            password.length > 128 -> "Use 128 characters or fewer for the password."
            expiryDays == null -> "Enter a positive expiry up to 3,650 days."
            maxUploads.isNotBlank() && uploadLimit == null -> "Enter a positive whole number for max uploads."
            maxFileSize.isNotBlank() && fileSizeLimit == null -> "Enter a valid positive maximum file size."
            else -> null
        }
        if (error != null || expiryDays == null) return
        val options = WorkspaceRequestOptions(
            title = requestTitle,
            message = requestMessage,
            expiryDays = expiryDays,
            password = password,
            idFormat = idFormat,
            idLength = idLength,
            maxUploads = uploadLimit,
            maxFileSize = fileSizeLimit,
            incremental = incremental,
        )
        focus.clearFocus()
        saving = true
        scope.launch {
            try {
                created(client.createRequest(options))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                onSessionError(failure)
                error = workspaceErrorMessage(failure, "Couldn't create the request.")
            } finally {
                saving = false
            }
        }
    }

    BackHandler { if (!saving) back() }
    ScreenHeader("New request", back, backEnabled = !saving)
    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            contentPadding = workspaceListPadding,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = { Text("Title") },
                    placeholder = { Text("Project deliverables") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    shape = workspaceShape,
                    enabled = !saving,
                )
            }
            item { WorkspaceExpiryFields(expiry, enabled = !saving) }
            item {
                TransferLinkFormatFields(
                    format = idFormat,
                    onFormatChange = { idFormat = it },
                    length = idLength,
                    onLengthChange = { idLength = it },
                    minLength = MIN_LINK_LENGTH,
                    enabled = !saving,
                    accent = MaterialTheme.colorScheme.secondary,
                )
            }
            item {
                OutlinedTextField(
                    value = message,
                    onValueChange = { message = it },
                    label = { Text("Message (optional)") },
                    placeholder = { Text("Instructions for the uploader") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                    maxLines = 6,
                    shape = workspaceShape,
                    enabled = !saving,
                )
            }
            item {
                TransferOptionalSettings(
                    title = "Password and upload limits",
                    expanded = showOptions,
                    toggle = { showOptions = !showOptions },
                    enabled = !saving,
                ) {
                    PasswordField(password, { password = it }, "Password (optional)", enabled = !saving)
                    OutlinedTextField(
                        value = maxUploads,
                        onValueChange = { maxUploads = it },
                        label = { Text("Max uploads (optional)") },
                        placeholder = { Text("Unlimited") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        shape = workspaceShape,
                        enabled = !saving,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    )
                    WorkspaceAmountField(
                        label = "Max file size (optional)",
                        placeholder = "No limit",
                        value = maxFileSize,
                        changeValue = { maxFileSize = it },
                        units = WorkspaceSizeUnit.entries.map { it.label },
                        unit = sizeUnit,
                        changeUnit = { sizeUnit = it },
                        enabled = !saving,
                    )
                    Row(
                        Modifier.fillMaxWidth().toggleable(
                            value = incremental,
                            enabled = !saving,
                            role = Role.Switch,
                            onValueChange = { incremental = it },
                        ).padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("Allow incremental uploads")
                            SupportingText("Uploaders can return to add more files.", small = true)
                        }
                        Switch(
                            checked = incremental,
                            onCheckedChange = null,
                            enabled = !saving,
                        )
                    }
                }
            }
        }
        ComposerFooter {
            error?.let { Notice(it, dismiss = { error = null }) }
            PrimaryButton(
                if (saving) "Creating…" else "Create request",
                ::submit,
                icon = TransferIcons.Inbox,
                enabled = !saving && title.isNotBlank(),
                accent = MaterialTheme.colorScheme.secondary,
            )
        }
    }
}

@Composable
internal fun TransferLinkFormatFields(
    format: WorkspaceIdFormat,
    onFormatChange: (WorkspaceIdFormat) -> Unit,
    length: Int,
    onLengthChange: (Int) -> Unit,
    minLength: Int,
    enabled: Boolean = true,
    accent: Color = MaterialTheme.colorScheme.primary,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        WorkspaceSectionTitle("Link format")
        Row(
            Modifier.fillMaxWidth().selectableGroup().background(MaterialTheme.colorScheme.surfaceContainerHigh, workspaceShape).padding(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            for (option in listOf(WorkspaceIdFormat.ANIMALS, WorkspaceIdFormat.RANDOM)) {
                val selected = option == format
                val animals = option == WorkspaceIdFormat.ANIMALS
                val tint = if (selected) accent else MaterialTheme.colorScheme.onSurfaceVariant
                Row(
                    Modifier.weight(1f).clip(RoundedCornerShape(12.dp))
                        .background(if (selected) MaterialTheme.colorScheme.surface else Color.Transparent)
                        .selectable(selected, enabled = enabled, role = Role.RadioButton, onClick = { onFormatChange(option) })
                        .heightIn(min = 48.dp).padding(horizontal = 6.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally),
                ) {
                    Icon(if (animals) TransferIcons.Cat else TransferIcons.Random, null, Modifier.size(20.dp), tint = tint)
                    Text(if (animals) "Animals" else "Random", color = tint, style = MaterialTheme.typography.labelLarge)
                }
            }
        }
        if (format == WorkspaceIdFormat.RANDOM) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                SupportingText("Link length", small = true)
                Text("$length characters", style = MaterialTheme.typography.labelMedium, color = accent)
            }
            Slider(
                value = length.toFloat(),
                onValueChange = { onLengthChange(it.roundToInt()) },
                valueRange = minLength.toFloat()..MAX_LINK_LENGTH.toFloat(),
                modifier = Modifier.semantics {
                    contentDescription = "Random link length"
                    stateDescription = "$length characters"
                },
                enabled = enabled,
                steps = MAX_LINK_LENGTH - minLength - 1,
                colors = SliderDefaults.colors(
                    thumbColor = accent,
                    activeTrackColor = accent,
                    activeTickColor = Color.Transparent,
                    inactiveTickColor = Color.Transparent,
                ),
            )
        } else {
            SupportingText("Three animal names · /otter-fox-cat", small = true)
        }
    }
}

@Composable
internal fun TransferOptionalSettings(
    title: String,
    expanded: Boolean,
    toggle: () -> Unit,
    enabled: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    Panel(padding = 0) {
        Row(
            modifier = Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = toggle)
                .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
                .heightIn(min = 52.dp).padding(horizontal = 14.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
            Icon(
                if (expanded) Icons.Rounded.KeyboardArrowUp else Icons.Rounded.KeyboardArrowDown,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (expanded) {
            Column(Modifier.padding(start = 14.dp, end = 14.dp, bottom = 14.dp), Arrangement.spacedBy(10.dp), content = content)
        }
    }
}

@Composable
internal fun WorkspaceExpiryDialog(
    saving: Boolean,
    error: String?,
    dismiss: () -> Unit,
    save: (Double) -> Unit,
) {
    val expiry = rememberWorkspaceExpiryInput()
    val days = expiry.days
    AlertDialog(
        onDismissRequest = { if (!saving) dismiss() },
        title = { Text("Change expiry") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SupportingText("Set a new expiry measured from now.")
                WorkspaceExpiryFields(expiry, enabled = !saving)
                error?.let { Notice(it) }
            }
        },
        dismissButton = { TextButton(onClick = dismiss, enabled = !saving) { Text("Cancel") } },
        confirmButton = {
            TextButton(onClick = { days?.let(save) }, enabled = !saving && days != null) {
                Text(if (saving) "Saving…" else "Save expiry")
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WorkspaceExpiryFields(expiry: WorkspaceExpiryInput, enabled: Boolean) {
    var expanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = enabled && it }) {
            OutlinedTextField(
                value = workspaceExpiryPresets[expiry.selection].label,
                onValueChange = {},
                modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled),
                readOnly = true,
                enabled = enabled,
                singleLine = true,
                label = { Text("Expires after") },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                shape = workspaceShape,
            )
            ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                workspaceExpiryPresets.forEachIndexed { index, preset ->
                    DropdownMenuItem(
                        text = { Text(preset.label) },
                        onClick = {
                            expiry.selection = index
                            expanded = false
                        },
                    )
                }
            }
        }
        if (expiry.custom) {
            WorkspaceAmountField(
                label = "Duration",
                value = expiry.amount,
                changeValue = { expiry.amount = it },
                units = WorkspaceTimeUnit.entries.map { it.label },
                unit = expiry.unit,
                changeUnit = { expiry.unit = it },
                enabled = enabled,
            )
            SupportingText("Up to 3,650 days", small = true)
        }
    }
}

@Composable
private fun WorkspaceAmountField(
    label: String,
    value: String,
    changeValue: (String) -> Unit,
    units: List<String>,
    unit: Int,
    changeUnit: (Int) -> Unit,
    enabled: Boolean,
    placeholder: String? = null,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = value,
            onValueChange = changeValue,
            label = { Text(label) },
            placeholder = { placeholder?.let { Text(it) } },
            modifier = Modifier.weight(1f),
            singleLine = true,
            shape = workspaceShape,
            enabled = enabled,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        )
        WorkspaceUnitChoice("$label unit", units, unit, changeUnit, enabled)
    }
}

@Composable
private fun WorkspaceUnitChoice(
    label: String,
    choices: List<String>,
    selected: Int,
    change: (Int) -> Unit,
    enabled: Boolean,
) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(
            onClick = { expanded = true },
            modifier = Modifier.semantics { contentDescription = label },
            enabled = enabled,
            shape = workspaceShape,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Text(choices[selected])
            Icon(Icons.Rounded.ArrowDropDown, contentDescription = null)
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            choices.forEachIndexed { index, choice ->
                DropdownMenuItem(
                    text = { Text(choice) },
                    onClick = {
                        change(index)
                        expanded = false
                    },
                )
            }
        }
    }
}

private val workspaceDecimalPattern = Regex("(?:[0-9]+(?:[.,][0-9]*)?|[.,][0-9]+)")

private fun String.workspaceDecimal(): BigDecimal? =
    trim().takeIf { it.length <= 32 && workspaceDecimalPattern.matches(it) }
        ?.replace(',', '.')?.toBigDecimalOrNull()
