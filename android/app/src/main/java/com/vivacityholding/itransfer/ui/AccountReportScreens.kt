package com.vivacityholding.itransfer.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.vivacityholding.itransfer.AccountCostUsage
import com.vivacityholding.itransfer.AccountCosts
import com.vivacityholding.itransfer.SessionCredentials
import com.vivacityholding.itransfer.TransferApi
import com.vivacityholding.itransfer.listAccountUsers
import com.vivacityholding.itransfer.readAccountAudit
import com.vivacityholding.itransfer.readAccountCosts
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import java.text.NumberFormat
import java.util.Locale

@Composable
internal fun AccountAuditScreen(
    api: TransferApi,
    credentials: SessionCredentials,
    onBack: () -> Unit,
    onSessionError: (Exception) -> Unit,
) {
    AccountReport(
        title = "Account audit",
        onBack = onBack,
        onSessionError = onSessionError,
        load = {
            coroutineScope {
                val users = async { api.listAccountUsers(credentials).associate { it.id to it.email } }
                val events = api.readAccountAudit(credentials)
                events to users.await()
            }
        },
    ) { (events, users) ->
        item { SupportingText("Latest account and workspace activity, up to 200 events.") }
        if (events.isEmpty()) item { SupportingText("No events recorded.") }
        items(events, key = { it.id }) { event ->
            Panel {
                AccountHeading(event.action)
                SupportingText(accountTimestamp(event.createdAt), small = true)
                SelectionContainer {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        val actor = event.actorId?.let { users[it] ?: it } ?: "Unauthenticated"
                        SupportingText("Actor: $actor", small = true)
                        event.targetId?.let { target ->
                            SupportingText("Target: ${users[target] ?: target}", small = true)
                        }
                        event.detail?.let { SupportingText(it, small = true) }
                    }
                }
            }
        }
    }
}

@Composable
internal fun AccountCostsScreen(
    api: TransferApi,
    credentials: SessionCredentials,
    onBack: () -> Unit,
    onSessionError: (Exception) -> Unit,
) {
    AccountReport(
        title = "Costs",
        onBack = onBack,
        onSessionError = onSessionError,
        load = { api.readAccountCosts(credentials) },
    ) { costs ->
        item {
            Panel {
                AccountHeading("Estimated monthly R2 cost")
                Text(
                    usd(costs.monthlyUsd), style = MaterialTheme.typography.headlineLarge,
                    color = Mocha.mauve, fontWeight = FontWeight.Bold,
                )
                Text("All workspaces after the shared free tier", style = MaterialTheme.typography.bodyMedium)
                costs.grossMonthlyUsd?.let { AccountValue("Before free tier", usd(it)) }
                costs.freeTierSavingsUsd?.let { AccountValue("Free tier savings", usd(it)) }
            }
        }
        item {
            Panel {
                AccountHeading("Usage")
                costs.windowDays?.let { SupportingText("Operations cover the last $it days.", small = true) }
                AccountCostUsageValues(costs.usage)
                AccountValue("Active shares", count(costs.shares))
                AccountValue("Active requests", count(costs.requests))
                AccountValue("Total downloads", count(costs.downloads))
            }
        }
        item { AccountCostBreakdownPanel(costs) }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                AccountHeading("Cost by user")
                SupportingText("Gross estimates before the shared free tier.", small = true)
            }
        }
        val users = costs.users
        if (users == null) item { SupportingText("Per-user costs are unavailable.") }
        else if (users.isEmpty()) item { SupportingText("No user usage recorded.") }
        else items(users, key = { it.user.id }) { row ->
            Panel {
                AccountHeading(row.user.name)
                SupportingText(row.user.email, small = true)
                AccountCostUsageValues(row.usage)
                AccountValue("Gross monthly cost", usd(row.grossMonthlyUsd))
            }
        }
        costs.estimateNote?.let { note -> item { SupportingText(note, small = true) } }
    }
}

@Composable
private fun AccountCostUsageValues(usage: AccountCostUsage) {
    AccountValue("Storage", byteSize(usage.storageBytes))
    AccountValue("Files", count(usage.files))
    usage.writes?.let { AccountValue("Writes (Class A)", count(it)) }
    usage.reads?.let { AccountValue("Reads (Class B)", count(it)) }
}

@Composable
private fun AccountCostBreakdownPanel(costs: AccountCosts) {
    val breakdown = costs.breakdown
    val lines = listOf(
        CostLine("Storage", breakdown.storage, costs.usage.storageBytes, 10L * 1024 * 1024 * 1024, "10 GB"),
        CostLine("Writes (Class A)", breakdown.writes, costs.usage.writes, 1_000_000, "1 million"),
        CostLine("Reads (Class B)", breakdown.reads, costs.usage.reads, 10_000_000, "10 million"),
        CostLine("Egress", breakdown.egress),
    )
    Panel {
        AccountHeading("Monthly cost breakdown")
        for (line in lines) {
            AccountValue(line.label, usd(line.monthlyUsd))
            if (line.used != null && line.freeAllowance != null) {
                val fraction = line.used.toDouble() / line.freeAllowance
                LinearProgressIndicator(
                    progress = { fraction.toFloat().coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth(),
                    trackColor = Mocha.surface,
                )
                val percent = NumberFormat.getPercentInstance().apply { maximumFractionDigits = 1 }.format(fraction)
                SupportingText("$percent of the ${line.freeLabel} free allowance", small = true)
            }
        }
    }
}

private data class CostLine(
    val label: String,
    val monthlyUsd: Double,
    val used: Long? = null,
    val freeAllowance: Long? = null,
    val freeLabel: String? = null,
)

@Composable
private fun <T : Any> AccountReport(
    title: String,
    onBack: () -> Unit,
    onSessionError: (Exception) -> Unit,
    load: suspend () -> T,
    content: LazyListScope.(T) -> Unit,
) {
    var result by remember { mutableStateOf<T?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(reload) {
        loading = true
        error = null
        try {
            result = load()
        } catch (failure: Exception) {
            error = failure.accountFailureMessage("Could not load this report.", onSessionError)
        } finally {
            loading = false
        }
    }

    AccountPage(title, onBack) {
        error?.let { message -> item { Notice(message) } }
        if (loading) item { AccountLoading("Loading…") }
        else item { OutlinedAction(if (error == null) "Refresh" else "Retry", { reload++ }) }
        result?.let { content(it) }
    }
}

private fun count(value: Long): String = NumberFormat.getIntegerInstance().format(value)

private fun usd(value: Double): String =
    if (value > 0.0 && value < 0.01) "< \$0.01" else NumberFormat.getCurrencyInstance(Locale.US).format(value)
