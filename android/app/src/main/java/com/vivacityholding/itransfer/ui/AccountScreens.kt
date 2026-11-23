package com.vivacityholding.itransfer.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.vivacityholding.itransfer.Account
import com.vivacityholding.itransfer.AccountEmailPreference
import com.vivacityholding.itransfer.AccountSetupLink
import com.vivacityholding.itransfer.AccountStatus
import com.vivacityholding.itransfer.AccountUser
import com.vivacityholding.itransfer.ApiException
import com.vivacityholding.itransfer.SessionCredentials
import com.vivacityholding.itransfer.TransferApi
import com.vivacityholding.itransfer.TransferException
import com.vivacityholding.itransfer.WorkspaceTarget
import com.vivacityholding.itransfer.changeAccountPassword
import com.vivacityholding.itransfer.passwordSetupTokenPattern
import com.vivacityholding.itransfer.readAccountEmailPreferences
import com.vivacityholding.itransfer.reauthenticate
import com.vivacityholding.itransfer.remindAccountInvitation
import com.vivacityholding.itransfer.setupAccountPassword
import com.vivacityholding.itransfer.updateAccountEmailPreferences
import com.vivacityholding.itransfer.validateAccountPassword
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import org.json.JSONException
import java.io.IOException
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

private enum class AccountSection { PROFILE, PASSWORD, PREFERENCES, USERS, AUDIT, COSTS }

@Composable
internal fun AccountToolsScreen(
    api: TransferApi,
    account: Account,
    credentials: SessionCredentials,
    onBack: () -> Unit,
    onSignOut: () -> Unit,
    onPasswordChanged: () -> Unit,
    onSelectWorkspace: (WorkspaceTarget, Boolean) -> Unit,
    onSessionError: (Exception) -> Unit,
    copyLink: (String) -> Unit,
    shareLink: (String) -> Unit,
    openWebsite: () -> Unit,
) {
    key(api, credentials, account.id, account.isAdmin, account.passwordChangeRequired) {
        var section by remember { mutableStateOf(AccountSection.PROFILE) }
        var displayName by remember(account.name) { mutableStateOf(account.name) }
        val passwordRequired = account.passwordChangeRequired
        val returnToAccount = { section = AccountSection.PROFILE }

        LaunchedEffect(section) {
            if (section == AccountSection.PROFILE) {
                try {
                    displayName = api.restore(credentials).account.name
                } catch (failure: Exception) {
                    if (failure is CancellationException) throw failure
                    if (failure is ApiException && failure.status == 401) onSessionError(failure)
                }
            }
        }

        when {
            section == AccountSection.PREFERENCES -> AccountEmailPreferencesScreen(
                api, account, credentials, returnToAccount, onSessionError,
            )
            passwordRequired || section == AccountSection.PASSWORD -> AccountPasswordEditor(
                title = if (passwordRequired) "My Account" else "Change password",
                requiresCurrentPassword = true,
                onBack = if (passwordRequired) null else returnToAccount,
                onComplete = onPasswordChanged,
                onSessionError = onSessionError,
                savePassword = { current, replacement ->
                    api.changeAccountPassword(account, credentials, current, replacement)
                },
                beforeForm = if (passwordRequired) {
                    {
                        Notice("Update your password before using your workspace.", error = false)
                        AccountProfile(account, displayName)
                    }
                } else null,
                afterForm = if (passwordRequired) {
                    { enabled ->
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedAction("Email preferences", { section = AccountSection.PREFERENCES }, enabled = enabled)
                            OutlinedAction("Sign out", onSignOut, enabled = enabled)
                        }
                    }
                } else null,
            )
            account.isAdmin && section == AccountSection.USERS -> AccountUsersScreen(
                api = api,
                account = account,
                credentials = credentials,
                onBack = returnToAccount,
                onSignOut = onSignOut,
                onOwnNameChanged = { displayName = it },
                onSelectWorkspace = onSelectWorkspace,
                onSessionError = onSessionError,
                copyLink = copyLink,
                shareLink = shareLink,
            )
            account.isAdmin && section == AccountSection.AUDIT -> AccountAuditScreen(
                api, credentials, returnToAccount, onSessionError,
            )
            account.isAdmin && section == AccountSection.COSTS -> AccountCostsScreen(
                api, credentials, returnToAccount, onSessionError,
            )
            else -> AccountPage("My Account", onBack) {
                item { AccountProfile(account, displayName) }
                item {
                    Panel {
                        OutlinedAction("Change password", { section = AccountSection.PASSWORD })
                        OutlinedAction("Email preferences", { section = AccountSection.PREFERENCES })
                    }
                }
                if (account.isAdmin) {
                    item {
                        Panel {
                            AccountHeading("Administration")
                            OutlinedAction("Users", { section = AccountSection.USERS })
                            OutlinedAction("Account audit", { section = AccountSection.AUDIT })
                            OutlinedAction("Costs", { section = AccountSection.COSTS })
                        }
                    }
                }
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedAction("Open iTransfer website", openWebsite)
                        OutlinedAction("Sign out", onSignOut)
                    }
                }
            }
        }
    }
}

@Composable
private fun AccountProfile(account: Account, displayName: String) {
    Panel {
        Title(displayName)
        SupportingText(account.email)
        SupportingText(if (account.isAdmin) "Administrator" else "User", small = true)
        SupportingText("Session expires ${accountTimestamp(account.sessionExpiresAt)}", small = true)
    }
}

@Composable
internal fun PasswordSetupScreen(api: TransferApi, token: String, onBack: () -> Unit, onComplete: () -> Unit) {
    key(api, token) {
        if (!passwordSetupTokenPattern.matches(token)) {
            AccountPage("Set your password", onBack) {
                item {
                    Notice("This setup link is missing a valid token. Open the full link or ask your administrator for a new one.")
                }
            }
        } else {
            AccountPasswordEditor(
                title = "Set your password",
                requiresCurrentPassword = false,
                onBack = onBack,
                onComplete = onComplete,
                savePassword = { _, newPassword -> api.setupAccountPassword(token, newPassword) },
            )
        }
    }
}

@Composable
private fun AccountPasswordEditor(
    title: String,
    requiresCurrentPassword: Boolean,
    onBack: (() -> Unit)?,
    onComplete: () -> Unit,
    savePassword: suspend (String, String) -> Unit,
    onSessionError: ((Exception) -> Unit)? = null,
    beforeForm: (@Composable () -> Unit)? = null,
    afterForm: (@Composable (Boolean) -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    var current by remember { mutableStateOf("") }
    var replacement by remember { mutableStateOf("") }
    var repeat by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    val canSubmit = (!requiresCurrentPassword || current.isNotEmpty()) &&
        replacement.isNotEmpty() && repeat.isNotEmpty() && !busy
    val submit: () -> Unit = {
        if (canSubmit && !busy) {
            error = if (replacement != repeat) "The passwords do not match." else try {
                validateAccountPassword(replacement)
                null
            } catch (failure: TransferException) {
                failure.message
            }
            if (error == null) {
                val enteredCurrent = current
                val enteredReplacement = replacement
                focus.clearFocus()
                busy = true
                current = ""
                scope.launch {
                    try {
                        savePassword(enteredCurrent, enteredReplacement)
                        replacement = ""
                        repeat = ""
                        onComplete()
                    } catch (failure: Exception) {
                        error = if (!requiresCurrentPassword && failure is ApiException && failure.status == 400) {
                            "This setup link is invalid, expired, or already used. Ask your administrator for a new link."
                        } else failure.accountFailureMessage("Could not save your password.", onSessionError)
                    } finally {
                        busy = false
                    }
                }
            }
        }
    }

    AccountPage(title, onBack, backEnabled = !busy) {
        if (beforeForm != null) item { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) { beforeForm() } }
        item {
            Panel {
                SupportingText(
                    if (requiresCurrentPassword) "Changing your password signs you out on every device."
                    else "Choose a password to activate or recover your account. This link works once.",
                )
                if (requiresCurrentPassword) PasswordField(current, { current = it }, "Current password", enabled = !busy)
                PasswordField(replacement, { replacement = it }, "New password", enabled = !busy)
                SupportingText("Use 8 to 128 characters. A long, unique passphrase works well.", small = true)
                PasswordField(repeat, { repeat = it }, "Confirm new password", enabled = !busy, done = submit)
                error?.let { Notice(it) }
                PrimaryButton(
                    when {
                        busy -> "Saving password…"
                        requiresCurrentPassword -> "Change password and sign out"
                        else -> "Save password"
                    },
                    submit,
                    enabled = canSubmit,
                )
            }
        }
        if (afterForm != null) item { afterForm(!busy) }
    }
}

private data class EmailOption(val preference: AccountEmailPreference, val title: String, val detail: String? = null)

private val emailOptions = listOf(
    EmailOption(AccountEmailPreference.SHARE_DOWNLOADS, "Files downloaded"),
    EmailOption(AccountEmailPreference.REQUEST_UPLOADS, "Files received via requests"),
    EmailOption(AccountEmailPreference.PASSWORD_CHANGED, "Password changed"),
    EmailOption(AccountEmailPreference.EXPIRY_ALERTS, "Transfers expiring soon", "Sent within 24 hours of expiry."),
    EmailOption(
        AccountEmailPreference.INVITATION_REMINDERS, "Invitation reminders",
        "Allows an administrator to replace a pending account’s setup link and email a reminder.",
    ),
)

@Composable
internal fun AccountEmailPreferencesScreen(
    api: TransferApi,
    account: Account,
    credentials: SessionCredentials,
    onBack: () -> Unit,
    onSessionError: (Exception) -> Unit,
    target: AccountUser? = null,
    onReminderIssued: ((AccountSetupLink) -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    var saved by remember { mutableStateOf<Map<AccountEmailPreference, Boolean>?>(null) }
    var draft by remember { mutableStateOf(emptyMap<AccountEmailPreference, Boolean>()) }
    var reload by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var savedNotice by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmation by remember { mutableStateOf<AccountConfirmation?>(null) }
    val changes = saved?.let { baseline -> draft.filter { (option, enabled) -> baseline[option] != enabled } }.orEmpty()
    val targetId = target?.id

    LaunchedEffect(api, credentials, targetId, reload) {
        loading = true
        error = null
        try {
            val response = api.readAccountEmailPreferences(credentials, targetId)
            saved = response
            draft = response
        } catch (failure: Exception) {
            error = failure.accountFailureMessage("Could not load email preferences.", onSessionError)
        } finally {
            loading = false
        }
    }

    suspend fun saveChanges(patch: Map<AccountEmailPreference, Boolean>) {
        val response = api.updateAccountEmailPreferences(credentials, targetId, patch)
        saved = response
        draft = response
        savedNotice = true
    }

    val save: () -> Unit = {
        if (!busy && changes.isNotEmpty()) {
            error = null
            savedNotice = false
            if (target == null) {
                busy = true
                scope.launch {
                    try {
                        saveChanges(changes)
                    } catch (failure: Exception) {
                        error = failure.accountFailureMessage("Could not save email preferences.", onSessionError)
                    } finally {
                        busy = false
                    }
                }
            } else {
                confirmation = AccountConfirmation("Save email preferences", "Update optional emails for ${target.email}.") {
                    saveChanges(changes)
                }
            }
        }
    }

    AccountPage("Email preferences", onBack, backEnabled = !busy) {
        item {
            Panel {
                if (target != null) {
                    AccountHeading(target.name)
                    SupportingText(target.email)
                }
                AccountValue("Welcome email", "Always on")
                AccountValue("Password reset email", "Always on")
                if (target?.status == AccountStatus.DISABLED) {
                    SupportingText("Email delivery is paused while this account is disabled.", small = true)
                }
            }
        }
        error?.let { item { Notice(it) } }
        if (loading) item { AccountLoading("Loading email preferences…") }
        if (!loading && saved == null) item { OutlinedAction("Retry", { reload++ }) }
        if (saved != null) {
            item {
                Panel {
                    AccountHeading("Optional emails")
                    emailOptions.forEach { option ->
                        val checked = draft[option.preference] == true
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(
                                value = checked, enabled = !busy, role = Role.Switch,
                                onValueChange = { enabled ->
                                    draft = draft + (option.preference to enabled)
                                    savedNotice = false
                                },
                            ),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(option.title)
                                option.detail?.let { SupportingText(it, small = true) }
                            }
                            Switch(checked, onCheckedChange = null, enabled = !busy)
                        }
                    }
                    PrimaryButton(
                        if (busy) "Saving preferences…" else "Save email preferences",
                        save,
                        enabled = !busy && changes.isNotEmpty(),
                    )
                    if (savedNotice) Notice("Email preferences saved.", error = false)
                }
            }
            if (target?.status == AccountStatus.PENDING && onReminderIssued != null) {
                item {
                    Panel {
                        val reminderEnabled = saved?.get(AccountEmailPreference.INVITATION_REMINDERS) == true
                        if (!reminderEnabled) {
                            SupportingText("Enable and save invitation reminders to send a reminder.", small = true)
                        }
                        OutlinedAction(
                            "Send invitation reminder",
                            {
                                confirmation = AccountConfirmation(
                                    "Send invitation reminder",
                                    "Email ${target.email} a single-use setup link valid for 24 hours. This replaces the previous link.",
                                ) {
                                    onReminderIssued(api.remindAccountInvitation(credentials, target.id))
                                }
                            },
                            enabled = reminderEnabled && changes.isEmpty() && !busy,
                        )
                    }
                }
            }
        }
    }
    confirmation?.let { action ->
        key(action) {
            AccountConfirmationDialog(api, account, credentials, action, { confirmation = null }, onSessionError)
        }
    }
}

internal class AccountConfirmation(val title: String, val description: String, val execute: suspend () -> Unit)

@Composable
internal fun AccountConfirmationDialog(
    api: TransferApi,
    account: Account,
    credentials: SessionCredentials,
    confirmation: AccountConfirmation,
    onClose: () -> Unit,
    onSessionError: (Exception) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val submit: () -> Unit = {
        if (!busy && password.isNotEmpty()) {
            val entered = password
            password = ""
            focus.clearFocus()
            busy = true
            error = null
            scope.launch {
                var submitted = false
                try {
                    api.reauthenticate(account, credentials, entered)
                    currentCoroutineContext().ensureActive()
                    submitted = true
                    confirmation.execute()
                    onClose()
                } catch (failure: Exception) {
                    error = if (submitted && (failure is IOException || failure is JSONException)) {
                        "The result could not be confirmed. Check the account before trying again."
                    } else failure.accountFailureMessage("Could not complete the action.", onSessionError)
                } finally {
                    busy = false
                }
            }
        }
    }
    AlertDialog(
        onDismissRequest = { if (!busy) onClose() },
        title = { Text(confirmation.title) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                SupportingText(confirmation.description)
                PasswordField(password, { password = it }, "Your password", enabled = !busy, done = submit)
                error?.let { Notice(it) }
            }
        },
        confirmButton = { TextButton(submit, enabled = !busy && password.isNotEmpty()) { Text(if (busy) "Confirming…" else "Confirm") } },
        dismissButton = { TextButton(onClose, enabled = !busy) { Text("Cancel") } },
        containerColor = Mocha.base,
    )
}

@Composable
internal fun AccountPage(
    title: String,
    onBack: (() -> Unit)?,
    backEnabled: Boolean = true,
    content: LazyListScope.() -> Unit,
) {
    BackHandler { if (backEnabled) onBack?.invoke() }
    Column(Modifier.fillMaxSize()) {
        if (onBack == null) {
            Text(
                title,
                Modifier.padding(horizontal = 20.dp, vertical = 12.dp).semantics { heading() },
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )
        } else {
            ScreenHeader(title, back = onBack, backEnabled = backEnabled)
        }
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
    }
}

@Composable
internal fun AccountHeading(text: String) {
    Text(
        text,
        Modifier.semantics { heading() },
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
    )
}

@Composable
internal fun AccountLoading(label: String) {
    Row(Modifier.padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
        SupportingText(label)
    }
}

@Composable
internal fun AccountValue(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Text(value, color = Mocha.lavender, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

internal fun accountTimestamp(instant: Instant): String {
    val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault()).format(instant)
    return "${formatDate(instant)} at $time"
}

internal fun Exception.accountFailureMessage(defaultMessage: String, onSessionError: ((Exception) -> Unit)? = null): String {
    if (this is CancellationException) throw this
    if (this is ApiException && (status == 401 || code == "IDENTITY_MISMATCH")) onSessionError?.invoke(this)
    return when (this) {
        is ApiException, is TransferException -> message ?: defaultMessage
        is IOException -> "$defaultMessage Check your connection and try again."
        else -> defaultMessage
    }
}
