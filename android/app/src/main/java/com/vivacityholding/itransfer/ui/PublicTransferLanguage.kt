package com.vivacityholding.itransfer.ui

import android.content.Context
import android.content.res.Configuration
import android.icu.text.PluralRules
import android.text.format.Formatter
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.edit
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

private val publicLanguages = linkedMapOf(
    "en" to "English",
    "es" to "Español",
    "fr" to "Français",
    "pt" to "Português",
    "nl" to "Nederlands",
    "it" to "Italiano",
    "ca" to "Català",
    "pl" to "Polski",
    "da" to "Dansk",
    "sv" to "Svenska",
)

internal class PublicLanguage(
    context: Context,
    configuration: Configuration,
    val tag: String,
    private val translated: JSONObject,
    private val english: JSONObject,
) {
    private val displayLocale = Locale.forLanguageTag(tag)
    private val rules = PluralRules.forLocale(displayLocale)
    private val numbers = NumberFormat.getIntegerInstance(displayLocale)
    private val dates = DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)
        .withLocale(displayLocale)
        .withZone(ZoneId.systemDefault())
    private val formattingContext = context.createConfigurationContext(
        Configuration(configuration).apply { setLocale(displayLocale) },
    )

    fun text(key: String, vararg arguments: Pair<String, String>): String =
        interpolate(translated.message(key) ?: english.message(key) ?: key, arguments)

    fun plural(key: String, count: Long, vararg arguments: Pair<String, String>): String {
        val suffix = rules.select(count.toDouble())
        val template = translated.message("${key}_$suffix") ?: translated.message("${key}_other")
            ?: english.message(if (count == 1L) "${key}_one" else "${key}_other")
            ?: key
        return interpolate(template, arrayOf("count" to numbers.format(count), *arguments))
    }

    fun date(instant: Instant): String = dates.format(instant)

    fun size(bytes: Long): String = Formatter.formatShortFileSize(formattingContext, bytes)

    private fun JSONObject.message(key: String): String? = optString(key).takeIf(String::isNotEmpty)

    private fun interpolate(template: String, arguments: Array<out Pair<String, String>>): String =
        arguments.fold(template) { text, (name, value) -> text.replace("{{$name}}", value) }
}

private class PublicLanguageChoice(val language: PublicLanguage, val select: (String) -> Unit)

private val LocalPublicLanguage = staticCompositionLocalOf<PublicLanguageChoice> {
    error("Public link screens require a language provider")
}

@Composable
internal fun currentPublicLanguage(): PublicLanguage = LocalPublicLanguage.current.language

@Composable
internal fun PublicLanguageProvider(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val preferences = remember(context) { context.getSharedPreferences("public_display", Context.MODE_PRIVATE) }
    var selected by remember(preferences) {
        mutableStateOf(preferences.getString("language", null)?.takeIf(publicLanguages::containsKey))
    }
    val tag = selected ?: configuration.locales[0]?.language?.takeIf(publicLanguages::containsKey) ?: "en"
    val english = remember(context) { context.publicMessages("en") }
    val language = remember(context, configuration, tag) {
        PublicLanguage(context, configuration, tag, if (tag == "en") english else context.publicMessages(tag), english)
    }
    CompositionLocalProvider(LocalPublicLanguage provides PublicLanguageChoice(language) { choice ->
        selected = choice
        preferences.edit { putString("language", choice) }
    }, content = content)
}

@Composable
internal fun PublicLanguageMenu() {
    val choice = LocalPublicLanguage.current
    val language = choice.language
    var expanded by remember { mutableStateOf(false) }
    Box(Modifier.padding(end = 8.dp)) {
        val label = language.text("language.label")
        val selected = publicLanguages.getValue(language.tag)
        TextButton(
            onClick = { expanded = true },
            modifier = Modifier.semantics { contentDescription = "$label, $selected" },
        ) {
            Text(selected)
            Icon(Icons.Rounded.KeyboardArrowDown, contentDescription = null)
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for ((tag, name) in publicLanguages) {
                DropdownMenuItem(
                    text = { Text(name, color = if (tag == language.tag) Mocha.mauve else Mocha.text) },
                    onClick = {
                        expanded = false
                        choice.select(tag)
                    },
                )
            }
        }
    }
}

private fun Context.publicMessages(tag: String): JSONObject = try {
    assets.open("$tag.json").bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
} catch (_: IOException) {
    JSONObject()
} catch (_: JSONException) {
    JSONObject()
}
