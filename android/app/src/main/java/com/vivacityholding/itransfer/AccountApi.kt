package com.vivacityholding.itransfer

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.URI
import java.net.URISyntaxException
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeParseException

internal enum class AccountRole(val value: String, val label: String) {
    USER("user", "User"),
    ADMIN("admin", "Administrator"),
}

internal enum class AccountStatus(val value: String, val label: String) {
    ACTIVE("active", "Active"),
    PENDING("pending", "Pending setup"),
    DISABLED("disabled", "Disabled"),
}

internal data class AccountUser(
    val workspace: WorkspaceTarget,
    val role: AccountRole,
    val status: AccountStatus,
    val lastLoginAt: Instant?,
) {
    val id get() = workspace.id
    val name get() = workspace.name
    val email get() = workspace.email
}

internal enum class AccountEmailPreference(val value: String) {
    SHARE_DOWNLOADS("share_downloads"),
    REQUEST_UPLOADS("request_uploads"),
    PASSWORD_CHANGED("password_changed"),
    EXPIRY_ALERTS("expiry_alerts"),
    INVITATION_REMINDERS("invitation_reminders"),
}

internal enum class AccountMailStatus { QUEUED, FAILED, NOT_CONFIGURED, UNKNOWN }

internal class AccountSetupLink(val url: String?, val expiresAt: Instant?, val mailStatus: AccountMailStatus)

internal class AccountInvitation(val user: AccountUser, val link: AccountSetupLink)

internal data class AccountAuditEvent(
    val id: Long,
    val actorId: String?,
    val targetId: String?,
    val action: String,
    val detail: String?,
    val createdAt: Instant,
)

internal data class AccountCostUsage(
    val storageBytes: Long,
    val files: Long,
    val writes: Long?,
    val reads: Long?,
)

internal data class AccountCostBreakdown(
    val storage: Double,
    val writes: Double,
    val reads: Double,
    val egress: Double,
)

internal data class AccountUserCost(
    val user: WorkspaceTarget,
    val usage: AccountCostUsage,
    val grossMonthlyUsd: Double,
)

internal data class AccountCosts(
    val usage: AccountCostUsage,
    val monthlyUsd: Double,
    val grossMonthlyUsd: Double?,
    val freeTierSavingsUsd: Double?,
    val shares: Long,
    val requests: Long,
    val downloads: Long,
    val windowDays: Int?,
    val breakdown: AccountCostBreakdown,
    val users: List<AccountUserCost>?,
    val estimateNote: String?,
)

internal val passwordSetupTokenPattern = Regex("[a-f0-9]{64}")

private val nonLetters = Regex("[^a-z]")
private val commonPassword = Regex(
    "(?:password|passwrd|letmein|welcome|qwerty|admin|administrator|changeme|iloveyou|" +
        "monkey|dragon|login|test|secret|abc|abcdefgh|asdfghjkl|correcthorsebatterystaple)+",
)
private val passwordNumbersAndSymbols = Regex(
    "[0-9!@#\$%^&*_.\\-\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A" +
        "\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+",
)
private val commonPasswordPrefix = Regex("^(?:1234567890|123456789|qwertyuiop|abcdefghijkl)")

internal fun validateAccountPassword(password: String) {
    if (password.length !in 8..128) throw TransferException("Use 8 to 128 characters for your new password.")
    val lower = password.lowercase()
    val simple = lower.replace(nonLetters, "")
    val leet = lower.replace('@', 'a').replace('4', 'a').replace('0', 'o')
        .replace('3', 'e').replace('$', 's').replace('5', 's').replace('1', 'i')
        .replace(nonLetters, "")
    val asciiPrefix = password.takeWhile { it.code < 128 }.lowercase()
    val first = password[0]
    val repeated = first !in "\n\r\u2028\u2029" && password.all { it == first }
    if (commonPassword.matches(simple) || commonPassword.matches(leet) ||
        passwordNumbersAndSymbols.matches(password) || repeated || commonPasswordPrefix.containsMatchIn(asciiPrefix)
    ) {
        throw TransferException("Choose a less common password.")
    }
}

internal suspend fun TransferApi.reauthenticate(account: Account, credentials: SessionCredentials, password: String) {
    val challenge = actorChallenge(account, credentials)
    val proof = challenge.derive(password)
    submitAuthenticatedProof("api/auth/reauth", credentials, JSONObject().put("proof", proof))
}

internal suspend fun TransferApi.changeAccountPassword(
    account: Account,
    credentials: SessionCredentials,
    currentPassword: String,
    newPassword: String,
) {
    validateAccountPassword(newPassword)
    val challenge = actorChallenge(account, credentials)
    val currentProof = challenge.derive(currentPassword)
    val newProof = challenge.derive(newPassword)
    submitAuthenticatedProof(
        "api/auth/password", credentials, JSONObject().put("current_proof", currentProof).put("new_proof", newProof),
    )
}

internal suspend fun TransferApi.setupAccountPassword(token: String, password: String) {
    if (!passwordSetupTokenPattern.matches(token)) throw TransferException("Invalid password setup link.")
    validateAccountPassword(password)
    val challenge = readAccountChallenge(JSONObject().put("token", token))
    val proof = challenge.derive(password)
    readObject("POST", "api/auth/setup-password", body = JSONObject().put("token", token).put("proof", proof))
}

private class AccountChallenge(val salt: String, val iterations: Int) {
    suspend fun derive(password: String): String = withContext(Dispatchers.Default) {
        passwordProof(password, salt, iterations)
    }
}

private suspend fun TransferApi.readAccountChallenge(body: JSONObject): AccountChallenge {
    val reply = readObject("POST", "api/auth/password-challenge", body = body)
    val salt = reply.opt("salt") as? String
    val iterations = reply.opt("iterations") as? Number
    if (salt == null || iterations?.toDouble() != PASSWORD_ITERATIONS.toDouble() || reply.opt("bootstrap") != false) {
        throw TransferException("The server returned an unsupported password challenge.")
    }
    return AccountChallenge(salt, PASSWORD_ITERATIONS)
}

private suspend fun TransferApi.actorChallenge(account: Account, credentials: SessionCredentials): AccountChallenge {
    if (account.id != credentials.accountId) throw accountIdentityMismatch()
    // Use the current session identity and email when requesting its salt.
    val email = verifiedActor(credentials).accountString("email")
    return readAccountChallenge(JSONObject().put("email", email))
}

private suspend fun TransferApi.verifiedActor(credentials: SessionCredentials): JSONObject {
    val actor = readObject("GET", "api/auth/me", session = credentials)
    if (actor.accountString("id") != credentials.accountId) throw accountIdentityMismatch()
    return actor
}

private fun accountIdentityMismatch() =
    ApiException(401, "Your signed-in account changed. Sign in again.", "IDENTITY_MISMATCH")

private suspend fun TransferApi.submitAuthenticatedProof(path: String, credentials: SessionCredentials, body: JSONObject) {
    try {
        readObject("POST", path, session = credentials, body = body)
    } catch (error: ApiException) {
        if (error.status != 401 || error.code == "IDENTITY_MISMATCH") throw error
        // A wrong current password also returns 401. Verify the session before
        // reporting an authentication failure to its owner.
        try {
            verifiedActor(credentials)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (probe: ApiException) {
            if (probe.status == 401) throw probe
        } catch (_: Exception) {
            // An inconclusive probe cannot invalidate a local session.
        }
        throw TransferException(error.message ?: "Invalid credentials.")
    }
}

internal suspend fun TransferApi.readAccountEmailPreferences(
    credentials: SessionCredentials,
    targetId: String? = null,
): Map<AccountEmailPreference, Boolean> =
    readObject("GET", emailPreferencesPath(targetId), session = credentials).toAccountEmailPreferences()

internal suspend fun TransferApi.updateAccountEmailPreferences(
    credentials: SessionCredentials,
    targetId: String?,
    changes: Map<AccountEmailPreference, Boolean>,
): Map<AccountEmailPreference, Boolean> {
    require(changes.isNotEmpty())
    val body = JSONObject()
    for ((preference, enabled) in changes) body.put(preference.value, enabled)
    return readObject("PATCH", emailPreferencesPath(targetId), session = credentials, body = body).toAccountEmailPreferences()
}

private fun emailPreferencesPath(targetId: String?): String =
    if (targetId == null) "api/auth/email-preferences" else "${accountUserPath(targetId)}/email-preferences"

private fun JSONObject.toAccountEmailPreferences(): Map<AccountEmailPreference, Boolean> =
    AccountEmailPreference.entries.associateWith { preference ->
        opt(preference.value) as? Boolean ?: throw invalidAccountResponse()
    }

internal suspend fun TransferApi.listAccountUsers(credentials: SessionCredentials): List<AccountUser> =
    readObject("GET", "api/users", session = credentials).accountRows("users", JSONObject::toAccountUser)

internal suspend fun TransferApi.inviteAccountUser(
    credentials: SessionCredentials,
    name: String,
    email: String,
    role: AccountRole,
): AccountInvitation {
    val body = JSONObject().put("name", name).put("email", email).put("role", role.value)
    val reply = readObject("POST", "api/users", session = credentials, body = body)
    return AccountInvitation(
        reply.optJSONObject("user")?.toAccountUser() ?: throw invalidAccountResponse(),
        reply.toAccountSetupLink(),
    )
}

internal suspend fun TransferApi.updateAccountUser(
    credentials: SessionCredentials,
    id: String,
    name: String? = null,
    email: String? = null,
    role: AccountRole? = null,
    status: AccountStatus? = null,
): AccountUser {
    require(status != AccountStatus.PENDING)
    val body = JSONObject().put("name", name).put("email", email).put("role", role?.value).put("status", status?.value)
    require(body.length() > 0)
    val user = readObject("PATCH", accountUserPath(id), session = credentials, body = body).toAccountUser()
    if (user.id != id) throw invalidAccountResponse()
    return user
}

internal suspend fun TransferApi.resetAccountUserPassword(credentials: SessionCredentials, id: String): AccountSetupLink =
    readObject("POST", "${accountUserPath(id)}/reset-password", session = credentials).toAccountSetupLink()

internal suspend fun TransferApi.remindAccountInvitation(credentials: SessionCredentials, id: String): AccountSetupLink =
    readObject("POST", "${accountUserPath(id)}/invitation", session = credentials).toAccountSetupLink()

internal suspend fun TransferApi.revokeAccountUserSessions(credentials: SessionCredentials, id: String) {
    readObject("POST", "${accountUserPath(id)}/revoke-sessions", session = credentials)
}

private fun accountUserPath(id: String): String {
    require(identifierPattern.matches(id))
    return "api/users/$id"
}

private fun JSONObject.toAccountUser() = AccountUser(
    workspace = toWorkspaceTarget("id"),
    role = AccountRole.entries.firstOrNull { it.value == accountString("role") } ?: throw invalidAccountResponse(),
    status = AccountStatus.entries.firstOrNull { it.value == accountString("status") } ?: throw invalidAccountResponse(),
    lastLoginAt = optionalAccountString("last_login_at")?.let(::parseAccountDate),
)

private fun JSONObject.toWorkspaceTarget(idField: String): WorkspaceTarget {
    val id = accountString(idField)
    if (!identifierPattern.matches(id)) throw invalidAccountResponse()
    return WorkspaceTarget(id, accountString("name"), accountString("email"))
}

private fun JSONObject.toAccountSetupLink(): AccountSetupLink {
    val mailStatus = when (optJSONObject("mail")?.optionalAccountString("status")) {
        "queued" -> AccountMailStatus.QUEUED
        "failed" -> AccountMailStatus.FAILED
        "not_configured" -> AccountMailStatus.NOT_CONFIGURED
        else -> AccountMailStatus.UNKNOWN
    }
    return AccountSetupLink(
        optionalAccountString("setup_url")?.let(::verifiedSetupLink),
        optionalAccountString("expires_at")?.let(::parseAccountDate),
        mailStatus,
    )
}

private fun verifiedSetupLink(value: String): String? {
    val uri = try {
        URI(value)
    } catch (_: URISyntaxException) {
        return null
    }
    val fragment = uri.rawFragment ?: return null
    if (!uri.scheme.equals("https", ignoreCase = true) || uri.host.isNullOrEmpty() ||
        uri.port !in -1..65535 ||
        uri.rawUserInfo != null || uri.rawPath != "/set-password" || uri.rawQuery != null ||
        !fragment.startsWith("token=") || !passwordSetupTokenPattern.matches(fragment.removePrefix("token="))
    ) return null
    return value
}

internal suspend fun TransferApi.readAccountAudit(credentials: SessionCredentials): List<AccountAuditEvent> =
    readObject("GET", "api/users/audit", session = credentials).accountRows("events") { row ->
        AccountAuditEvent(
            id = row.getLong("id"),
            actorId = row.optionalAccountString("actor_id"),
            targetId = row.optionalAccountString("target_id"),
            action = row.accountString("action"),
            detail = row.optionalAccountString("detail"),
            createdAt = parseAccountDate(row.accountString("created_at")) ?: throw invalidAccountResponse(),
        )
    }

internal suspend fun TransferApi.readAccountCosts(credentials: SessionCredentials): AccountCosts {
    val row = readObject("GET", "api/cost/estimate", session = credentials)
    val breakdown = row.getJSONObject("breakdown")
    return AccountCosts(
        usage = row.toAccountCostUsage(),
        monthlyUsd = row.getDouble("estimated_monthly_cost_usd"),
        grossMonthlyUsd = (row.opt("gross_monthly_cost_usd") as? Number)?.toDouble(),
        freeTierSavingsUsd = (row.opt("free_tier_savings_usd") as? Number)?.toDouble(),
        shares = row.getLong("active_shares"),
        requests = row.getLong("active_requests"),
        downloads = row.getLong("total_downloads"),
        windowDays = (row.opt("window_days") as? Number)?.toInt(),
        breakdown = AccountCostBreakdown(
            breakdown.getDouble("storage"), breakdown.getDouble("requests_put"),
            breakdown.getDouble("requests_get"), breakdown.getDouble("transfer"),
        ),
        users = if (row.isNull("users")) null else row.accountRows("users") { user ->
            AccountUserCost(
                user.toWorkspaceTarget("user_id"), user.toAccountCostUsage(), user.getDouble("gross_monthly_cost_usd"),
            )
        },
        estimateNote = row.optionalAccountString("estimate_note"),
    )
}

private fun JSONObject.toAccountCostUsage() = AccountCostUsage(
    storageBytes = getLong("total_storage_bytes"),
    files = getLong("total_files"),
    writes = (opt("class_a_ops_month") as? Number)?.toLong(),
    reads = (opt("class_b_ops_month") as? Number)?.toLong(),
)

private fun <T> JSONObject.accountRows(field: String, parse: (JSONObject) -> T): List<T> {
    val rows = getJSONArray(field)
    return List(rows.length()) { index -> parse(rows.getJSONObject(index)) }
}

private fun parseAccountDate(value: String): Instant? = try {
    Instant.parse(value)
} catch (_: DateTimeParseException) {
    // Older SQLite rows may omit the timezone. Those timestamps are UTC.
    try {
        LocalDateTime.parse(value.replace(' ', 'T')).toInstant(ZoneOffset.UTC)
    } catch (_: DateTimeParseException) {
        null
    }
}

private fun JSONObject.optionalAccountString(field: String): String? = opt(field) as? String

private fun JSONObject.accountString(field: String): String = optionalAccountString(field) ?: throw invalidAccountResponse()

private fun invalidAccountResponse() = TransferException("The iTransfer server returned an unexpected account response.")
