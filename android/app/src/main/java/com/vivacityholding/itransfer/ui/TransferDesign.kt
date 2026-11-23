package com.vivacityholding.itransfer.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val cobalt = Color(0xFF294AC6)
private val jade = Color(0xFF126958)
private val ink = Color(0xFF182135)
private val paper = Color(0xFFF6F6F2)
private val midnight = Color(0xFF111722)

private val dayColors = lightColorScheme(
    primary = cobalt, onPrimary = Color.White,
    primaryContainer = Color(0xFFE4E9FF), onPrimaryContainer = Color(0xFF243E96),
    secondary = jade, onSecondary = Color.White,
    secondaryContainer = Color(0xFFD9F1E9), onSecondaryContainer = Color(0xFF155344),
    tertiary = Color(0xFF84510E), onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFFEAC9), onTertiaryContainer = Color(0xFF5A380D),
    background = paper, onBackground = ink,
    surface = Color.White, onSurface = ink,
    surfaceVariant = Color(0xFFEBEDF1), onSurfaceVariant = Color(0xFF515C6C),
    surfaceContainerLowest = Color.White, surfaceContainerLow = Color(0xFFFAFAF8),
    surfaceContainer = Color(0xFFF0F1F3), surfaceContainerHigh = Color(0xFFE7E9EE),
    surfaceContainerHighest = Color(0xFFDFE3E9),
    outline = Color(0xFF778190), outlineVariant = Color(0xFFD2D6DC),
    error = Color(0xFFAD3541), onError = Color.White,
    errorContainer = Color(0xFFFFDCE0), onErrorContainer = Color(0xFF721F29),
    inverseSurface = ink, inverseOnSurface = Color.White, inversePrimary = Color(0xFFB4C4FF),
    surfaceTint = cobalt,
)

private val nightColors = darkColorScheme(
    primary = Color(0xFFAFBFFF), onPrimary = midnight,
    primaryContainer = Color(0xFF2B3C6E), onPrimaryContainer = Color(0xFFDCE3FF),
    secondary = Color(0xFF88DCC1), onSecondary = midnight,
    secondaryContainer = Color(0xFF203F39), onSecondaryContainer = Color(0xFFBCF2DF),
    tertiary = Color(0xFFF2C378), onTertiary = midnight,
    tertiaryContainer = Color(0xFF4E3D26), onTertiaryContainer = Color(0xFFFFDEAB),
    background = midnight, onBackground = Color(0xFFEFF2FA),
    surface = Color(0xFF1C2532), onSurface = Color(0xFFEFF2FA),
    surfaceVariant = Color(0xFF293342), onSurfaceVariant = Color(0xFFB4BFCE),
    surfaceContainerLowest = Color(0xFF0D131B), surfaceContainerLow = Color(0xFF19202C),
    surfaceContainer = Color(0xFF222C3A), surfaceContainerHigh = Color(0xFF2B3747),
    surfaceContainerHighest = Color(0xFF364252),
    outline = Color(0xFF8290A3), outlineVariant = Color(0xFF3E4B5C),
    error = Color(0xFFFFAEB2), onError = midnight,
    errorContainer = Color(0xFF57323A), onErrorContainer = Color(0xFFFFD9DC),
    inverseSurface = Color(0xFFE1E6F0), inverseOnSurface = ink, inversePrimary = cobalt,
    surfaceTint = Color(0xFFAFBFFF),
)

private val baseType = Typography()
private val transferType = Typography(
    headlineLarge = baseType.headlineLarge.copy(fontSize = 38.sp, lineHeight = 43.sp, fontWeight = FontWeight.Bold, letterSpacing = (-1.5).sp),
    headlineMedium = baseType.headlineMedium.copy(fontWeight = FontWeight.Bold, letterSpacing = (-0.9).sp),
    titleLarge = baseType.titleLarge.copy(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.6).sp),
    titleMedium = baseType.titleMedium.copy(fontSize = 17.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.25).sp),
    bodySmall = baseType.bodySmall.copy(fontSize = 13.sp, lineHeight = 18.sp, letterSpacing = 0.sp),
    labelLarge = baseType.labelLarge.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.sp),
)

@Composable
internal fun TransferTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) nightColors else dayColors, typography = transferType, content = content)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TransferIconButton(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    TooltipBox(
        positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
        tooltip = { PlainTooltip { Text(label) } },
        state = rememberTooltipState(),
    ) {
        IconButton(
            onClick = onClick,
            modifier = Modifier.size(48.dp),
            enabled = enabled,
            colors = IconButtonDefaults.iconButtonColors(contentColor = tint),
        ) {
            Icon(icon, contentDescription = label, modifier = Modifier.size(21.dp))
        }
    }
}

internal object TransferIcons {
    val Chart = outline("Chart") {
        moveTo(4f, 4f)
        verticalLineTo(20f)
        horizontalLineTo(21f)
        moveTo(9f, 16f)
        verticalLineTo(11f)
        moveTo(14f, 16f)
        verticalLineTo(6f)
        moveTo(19f, 16f)
        verticalLineTo(9f)
    }

    val Copy = outline("Copy") {
        moveTo(10f, 8f)
        horizontalLineTo(19f)
        quadTo(21f, 8f, 21f, 10f)
        verticalLineTo(19f)
        quadTo(21f, 21f, 19f, 21f)
        horizontalLineTo(10f)
        quadTo(8f, 21f, 8f, 19f)
        verticalLineTo(10f)
        quadTo(8f, 8f, 10f, 8f)
        close()
        moveTo(4f, 16f)
        quadTo(3f, 16f, 3f, 14f)
        verticalLineTo(5f)
        quadTo(3f, 3f, 5f, 3f)
        horizontalLineTo(14f)
        quadTo(16f, 3f, 16f, 5f)
    }

    val Download = outline("Download") {
        moveTo(12f, 3f)
        verticalLineTo(15f)
        moveTo(7.5f, 10.5f)
        lineTo(12f, 15f)
        lineTo(16.5f, 10.5f)
        moveTo(4f, 15f)
        verticalLineTo(19f)
        quadTo(4f, 21f, 6f, 21f)
        horizontalLineTo(18f)
        quadTo(20f, 21f, 20f, 19f)
        verticalLineTo(15f)
    }

    val Link = outline("Link") {
        moveTo(10f, 13.5f)
        lineTo(14f, 9.5f)
        moveTo(11f, 7.5f)
        lineTo(14f, 4.5f)
        curveTo(18f, 0.5f, 23.5f, 6f, 19.5f, 10f)
        lineTo(16.5f, 13f)
        moveTo(7.5f, 11f)
        lineTo(4.5f, 14f)
        curveTo(0.5f, 18f, 6f, 23.5f, 10f, 19.5f)
        lineTo(13f, 16.5f)
    }

    val Inbox = outline("Inbox") {
        moveTo(3f, 12f)
        lineTo(5.5f, 5f)
        horizontalLineTo(18.5f)
        lineTo(21f, 12f)
        verticalLineTo(18f)
        quadTo(21f, 20f, 19f, 20f)
        horizontalLineTo(5f)
        quadTo(3f, 20f, 3f, 18f)
        verticalLineTo(12f)
        horizontalLineTo(8f)
        lineTo(10f, 15f)
        horizontalLineTo(14f)
        lineTo(16f, 12f)
        horizontalLineTo(21f)
    }

    val Selection = outline("Selection") {
        moveTo(10f, 4f)
        horizontalLineTo(19f)
        quadTo(20f, 4f, 20f, 5f)
        verticalLineTo(19f)
        quadTo(20f, 20f, 19f, 20f)
        horizontalLineTo(5f)
        quadTo(4f, 20f, 4f, 19f)
        verticalLineTo(12f)
        moveTo(4f, 7f)
        lineTo(7f, 10f)
        lineTo(12f, 5f)
        moveTo(8f, 15f)
        horizontalLineTo(15f)
    }

    val Cat = outline("Cat") {
        moveTo(4f, 13f)
        verticalLineTo(5f)
        lineTo(9f, 8f)
        quadTo(12f, 7f, 15f, 8f)
        lineTo(20f, 5f)
        verticalLineTo(13f)
        curveTo(22f, 23f, 2f, 23f, 4f, 13f)
        close()
        moveTo(8f, 13.5f)
        lineTo(8.1f, 13.5f)
        moveTo(15.9f, 13.5f)
        lineTo(16f, 13.5f)
        moveTo(11f, 16f)
        lineTo(12f, 17f)
        lineTo(13f, 16f)
    }

    val Random = outline("Random") {
        moveTo(3f, 7f)
        horizontalLineTo(6f)
        curveTo(10f, 7f, 14f, 17f, 18f, 17f)
        horizontalLineTo(21f)
        moveTo(18f, 14f)
        lineTo(21f, 17f)
        lineTo(18f, 20f)
        moveTo(3f, 17f)
        horizontalLineTo(6f)
        quadTo(8f, 17f, 10f, 14f)
        moveTo(14f, 10f)
        quadTo(16f, 7f, 18f, 7f)
        horizontalLineTo(21f)
        moveTo(18f, 4f)
        lineTo(21f, 7f)
        lineTo(18f, 10f)
    }

    private fun outline(name: String, draw: PathBuilder.() -> Unit): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).path(
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 1.7f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
            pathBuilder = draw,
        ).build()
}

@Composable
internal fun BrandMark() {
    Box(
        modifier = Modifier.size(36.dp).background(cobalt, RoundedCornerShape(11.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(29.dp)) {
            val factor = size.width / 48f
            withTransform({ scale(factor, factor, Offset.Zero) }) {
                drawCircle(Color.White, 3.5f, Offset(14f, 10f))
                drawRoundRect(Color.White, Offset(8f, 18f), Size(32f, 5f), CornerRadius(2.5f))
                drawRoundRect(Color.White, Offset(11f, 22f), Size(6f, 18f), CornerRadius(3f))
                drawRoundRect(Color.White, Offset(21f, 22f), Size(6f, 18f), CornerRadius(3f))
            }
        }
    }
}
