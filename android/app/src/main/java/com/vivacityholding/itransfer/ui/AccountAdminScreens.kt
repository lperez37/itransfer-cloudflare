package com.vivacityholding.itransfer.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.vivacityholding.itransfer.Account
import com.vivacityholding.itransfer.AccountMailStatus
import com.vivacityholding.itransfer.AccountRole
import com.vivacityholding.itransfer.AccountSetupLink
import com.vivacityholding.itransfer.AccountStatus
import com.vivacityholding.itransfer.AccountUser
import com.vivacityholding.itransfer.SessionCredentials
import com.vivacityholding.itransfer.TransferApi
import com.vivacityholding.itransfer.WorkspaceTarget
import com.vivacityholding.itransfer.inviteAccountUser
import com.vivacityholding.itransfer.listAccountUsers
import com.vivacityholding.itransfer.resetAccountUserPassword
import com.vivacityholding.itransfer.revokeAccountUserSessions
import com.vivacityholding.itransfer.updateAccountUser

private sealed interface UserSection {
    data object List : UserSection
    data class Details(val user: AccountUser) : UserSection
    data class Editor(val user: AccountUser?) : UserSection
    data class Preferences(val user: AccountUser) : UserSection
    class Recovery(
        val link: AccountSetupLink,
        val email: String,
        val kind: AccountLinkKind,
        val returnTo: UserSection,
        val signsOut: Boolean = false,
    ) : UserSection
}

private enum class AccountLinkKind(val emailLabel: String, val issuedLabel: String) {
    WELCOME("Welcome", "Account created"),
    RESET("Password reset", "Password reset link issued"),
    REMINDER("Invitation reminder", "Invitation link issued"),
}

@Composable
internal fun AccountUsersScreen(
    api: TransferApi,
    account: Account,
    credentials: SessionCredentials,
    onBack: () -> Unit,
    onSignOut: () -> Unit,
    onOwnNameChanged: (String) -> Unit,
    onSelectWorkspace: (WorkspaceTarget, Boolean) -> Unit,
    onSessionError: (Exception) -> Unit,
    copyLink: (String) -> Unit,
    shareLink: (String) -> Unit,
) {
    var section by remember { mutableStateOf<UserSection>(UserSection.List) }
    var rows by remember { mutableStateOf(emptyList<AccountUser>()) }
    var loading by remember { mutableStateOf(true) }
    var reload by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf<AccountConfirmation?>(null) }

    LaunchedEffect(api, credentials, reload) {
        loading = true
        error = null
        try {
            rows = api.listAccountUsers(credentials)
        } catch (failure: Exception) {
            error = failure.accountFailureMessage("Could not load users.", onSessionError)
        } finally {
            loading = false
        }
    }

    fun showDetails(user: AccountUser) {
        notice = null
        section = UserSection.Details(user)
    }

    fun showUpdatedUser(previous: AccountUser, updated: AccountUser, message: String) {
        rows = rows.map { if (it.id == updated.id) updated else it }
        section = UserSection.Details(updated)
        notice = message
        if (updated.id == account.id) {
            if (updated.email != previous.email || updated.role != previous.role || updated.status != previous.status) {
                onSignOut()
            } else {
                onOwnNameChanged(updated.name)
            }
        }
    }

    when (val page = section) {
        UserSection.List -> {
            val search = query.trim()
            val results = if (loading) emptyList() else rows.filter { "${it.name} ${it.email}".contains(search, ignoreCase = true) }
            AccountPage("Users", onBack) {
                item {
                    PrimaryButton("Add user", { if (!loading) section = UserSection.Editor(null) }, icon = Icons.Rounded.Add, enabled = !loading)
                }
                item {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Find a user") },
                        placeholder = { Text("Name or email") },
                        leadingIcon = { Icon(Icons.Rounded.Search, contentDescription = null) },
                        singleLine = true,
                        shape = RoundedCornerShape(16.dp),
                    )
                }
                error?.let { message -> item { Notice(message) } }
                if (loading) item { AccountLoading("Loading users…") }
                else item {
                    OutlinedAction(if (error == null) "Refresh users" else "Retry", {
                        loading = true
                        reload++
                    })
                }
                if (!loading && error == null && results.isEmpty()) {
                    item { SupportingText(if (rows.isEmpty()) "No users yet." else "No users match your search.") }
                }
                items(results, key = { it.id }) { user ->
                    Panel(padding = 0) {
                        Row(
                            Modifier.fillMaxWidth().clickable { if (!loading) showDetails(user) }.padding(16.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text(
                                    if (user.id == account.id) "${user.name} (you)" else user.name,
                                    style = MaterialTheme.typography.titleMedium,
                                )
                                SupportingText(user.email, small = true)
                                AccountUserStatus(user)
                            }
                            Icon(Icons.AutoMirrored.Rounded.ArrowForward, contentDescription = null, tint = Mocha.secondaryText)
                        }
                    }
                }
            }
        }
        is UserSection.Details -> {
            val user = page.user
            val isSelf = user.id == account.id
            val disabled = user.status == AccountStatus.DISABLED
            AccountPage("User details", { section = UserSection.List }) {
                item {
                    Panel {
                        Title(if (isSelf) "${user.name} (you)" else user.name)
                        SupportingText(user.email)
                        AccountUserStatus(user)
                        SupportingText("Last sign-in: ${user.lastLoginAt?.let(::accountTimestamp) ?: "Never"}", small = true)
                    }
                }
                notice?.let { item { Notice(it, error = false) } }
                if (!isSelf) {
                    item {
                        Panel {
                            AccountHeading("Workspace")
                            OutlinedAction("View workspace (read-only)", { onSelectWorkspace(user.workspace, false) })
                            OutlinedAction("Manage workspace", {
                                confirmation = AccountConfirmation(
                                    "Manage ${user.name}’s workspace",
                                    "Confirm your password to open this workspace with permission to make changes.",
                                ) { onSelectWorkspace(user.workspace, true) }
                            })
                        }
                    }
                }
                item {
                    Panel {
                        AccountHeading("Account access")
                        OutlinedAction("Edit user", { section = UserSection.Editor(user) })
                        OutlinedAction(
                            if (user.status == AccountStatus.PENDING) "Email preferences and reminders" else "Email preferences",
                            { section = UserSection.Preferences(user) },
                        )
                        OutlinedAction("Reset password", {
                            confirmation = AccountConfirmation(
                                "Send password reset email",
                                "Email ${user.email} a single-use reset link. This replaces earlier setup links and signs " +
                                    (if (isSelf) "you out on every device." else "the user out on every device."),
                            ) {
                                val link = api.resetAccountUserPassword(credentials, user.id)
                                section = UserSection.Recovery(link, user.email, AccountLinkKind.RESET, page, signsOut = isSelf)
                            }
                        }, enabled = !disabled)
                        OutlinedAction("Force sign-out", {
                            confirmation = AccountConfirmation(
                                "Force sign-out",
                                if (isSelf) "End all of your sessions, including this one."
                                else "Sign ${user.email} out on every device.",
                            ) {
                                api.revokeAccountUserSessions(credentials, user.id)
                                if (isSelf) onSignOut() else notice = "All sessions revoked for ${user.email}."
                            }
                        })
                        OutlinedAction(if (disabled) "Enable account" else "Disable account", {
                            confirmation = AccountConfirmation(
                                if (disabled) "Enable account" else "Disable account",
                                if (disabled) "Restore access for ${user.email}."
                                else "Block sign-in and end every session for ${user.email}.",
                            ) {
                                val status = if (disabled) AccountStatus.ACTIVE else AccountStatus.DISABLED
                                val updated = api.updateAccountUser(credentials, user.id, status = status)
                                val message = when (updated.status) {
                                    AccountStatus.ACTIVE -> "Account enabled."
                                    AccountStatus.DISABLED -> "Account disabled."
                                    AccountStatus.PENDING -> "Account enabled. Issue a fresh setup link using Reset password."
                                }
                                showUpdatedUser(user, updated, message)
                            }
                        })
                    }
                }
            }
        }
        is UserSection.Editor -> {
            val user = page.user
            val returnTo = if (user == null) UserSection.List else UserSection.Details(user)
            key(user?.id) {
                AccountUserEditor(user, onBack = { section = returnTo }) { fields ->
                    confirmation = if (user == null) {
                        AccountConfirmation(
                            "Create user and send welcome email",
                            "Create an account for ${fields.email} with the ${fields.role.label} role and email a single-use setup link.",
                        ) {
                            val invite = api.inviteAccountUser(credentials, fields.name, fields.email, fields.role)
                            rows = rows + invite.user
                            section = UserSection.Recovery(invite.link, invite.user.email, AccountLinkKind.WELCOME, UserSection.List)
                        }
                    } else {
                        val name = fields.name.takeIf { it != user.name }
                        val email = fields.email.takeIf { it != user.email }
                        val role = fields.role.takeIf { it != user.role }
                        AccountConfirmation(
                            "Save user changes",
                            if (email != null || role != null) "Update ${user.email} and revoke their sessions and setup links."
                            else "Update the name for ${user.email}.",
                        ) {
                            val updated = api.updateAccountUser(credentials, user.id, name, email, role)
                            showUpdatedUser(user, updated, "User updated.")
                        }
                    }
                }
            }
        }
        is UserSection.Preferences -> key(page.user.id) {
            AccountEmailPreferencesScreen(
                api, account, credentials,
                onBack = { section = UserSection.Details(page.user) },
                onSessionError = onSessionError,
                target = page.user,
                onReminderIssued = { link ->
                    section = UserSection.Recovery(link, page.user.email, AccountLinkKind.REMINDER, page)
                },
            )
        }
        is UserSection.Recovery -> key(page) {
            AccountRecoveryScreen(
                page, copyLink, shareLink,
                onClose = { if (page.signsOut) onSignOut() else section = page.returnTo },
            )
        }
    }

    confirmation?.let { action ->
        key(action) {
            AccountConfirmationDialog(api, account, credentials, action, { confirmation = null }, onSessionError)
        }
    }
}

@Composable
private fun AccountUserStatus(user: AccountUser) {
    val color = when (user.status) {
        AccountStatus.ACTIVE -> Mocha.green
        AccountStatus.PENDING -> Mocha.yellow
        AccountStatus.DISABLED -> Mocha.secondaryText
    }
    Text("${user.role.label} · ${user.status.label}", color = color, style = MaterialTheme.typography.bodySmall)
}

private data class AccountUserFields(val name: String, val email: String, val role: AccountRole)

private val accountEmailPattern = Regex("[^\\s@]+@[^\\s@]+\\.[^\\s@]+")

@Composable
private fun AccountUserEditor(user: AccountUser?, onBack: () -> Unit, onReview: (AccountUserFields) -> Unit) {
    var name by remember { mutableStateOf(user?.name.orEmpty()) }
    var email by remember { mutableStateOf(user?.email.orEmpty()) }
    var role by remember { mutableStateOf(user?.role ?: AccountRole.USER) }
    var error by remember { mutableStateOf<String?>(null) }
    val fields = AccountUserFields(name.trim(), email.trim().lowercase(), role)
    val edited = user == null || fields != AccountUserFields(user.name, user.email, user.role)

    AccountPage(if (user == null) "Add user" else "Edit user", onBack) {
        item {
            Panel {
                OutlinedTextField(
                    name, {
                        name = it
                        error = null
                    },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Name") },
                    singleLine = true,
                    shape = RoundedCornerShape(16.dp),
                )
                OutlinedTextField(
                    email, {
                        email = it
                        error = null
                    },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Email") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    shape = RoundedCornerShape(16.dp),
                )
                AccountHeading("Role")
                Column(Modifier.selectableGroup()) {
                    AccountRole.entries.forEach { option ->
                        val selected = role == option
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(
                                selected = selected, onClick = { role = option }, role = Role.RadioButton,
                            ),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            RadioButton(selected, onClick = null)
                            Text(option.label)
                        }
                    }
                }
                if (role == AccountRole.ADMIN) {
                    SupportingText("Administrators can manage users and workspaces and view costs.", small = true)
                }
                error?.let { Notice(it) }
                PrimaryButton(
                    if (user == null) "Review invitation" else "Review changes",
                    {
                        error = when {
                            fields.name.length !in 1..100 -> "Enter a name up to 100 characters."
                            fields.email.length > 254 || !accountEmailPattern.matches(fields.email) -> "Enter a valid email address."
                            else -> null
                        }
                        if (error == null) onReview(fields)
                    },
                    enabled = edited && fields.name.isNotEmpty() && fields.email.isNotEmpty(),
                )
            }
        }
    }
}

@Composable
private fun AccountRecoveryScreen(
    recovery: UserSection.Recovery,
    copyLink: (String) -> Unit,
    shareLink: (String) -> Unit,
    onClose: () -> Unit,
) {
    val link = recovery.link
    val queued = link.mailStatus == AccountMailStatus.QUEUED
    val url = link.url
    var expanded by remember { mutableStateOf(!queued) }

    AccountPage("Account link", onClose) {
        item {
            Panel {
                AccountHeading(if (queued) "${recovery.kind.emailLabel} email queued" else recovery.kind.issuedLabel)
                SupportingText(recovery.email)
                SupportingText(
                    when (link.mailStatus) {
                        AccountMailStatus.QUEUED -> "The email provider accepted the message for sending."
                        AccountMailStatus.FAILED -> "Email submission failed. Share the existing link privately."
                        AccountMailStatus.NOT_CONFIGURED -> "Email is unavailable. Share the existing link privately."
                        AccountMailStatus.UNKNOWN -> "Email submission is unconfirmed. Share the existing link if needed."
                    },
                )
                if (recovery.signsOut) {
                    Notice("Your session was revoked. Copy the link before returning to sign-in.", error = false)
                }
            }
        }
        if (url == null) {
            item { Notice("The server did not return a usable private link.") }
        } else if (expanded) {
            item {
                Panel {
                    AccountHeading("Single-use link")
                    SupportingText("Share it privately with ${recovery.email}.", small = true)
                    link.expiresAt?.let { SupportingText("Expires ${accountTimestamp(it)}", small = true) }
                    LinkText(url)
                    OutlinedAction("Copy link", { copyLink(url) })
                    OutlinedAction("Share link", { shareLink(url) })
                }
            }
        } else {
            item { OutlinedAction("Show backup link", { expanded = true }) }
        }
        item { PrimaryButton(if (recovery.signsOut) "Continue to sign in" else "Done", onClose) }
    }
}
