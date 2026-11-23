package com.vivacityholding.itransfer.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp
import kotlin.math.min

internal object Mocha {
    val crust = Color(0xFF11111B)
    val mantle = Color(0xFF181825)
    val base = Color(0xFF1E1E2E)
    val surface = Color(0xFF313244)
    val border = Color(0xFF45475A)
    val outline = Color(0xFF6C7086)
    val text = Color(0xFFCDD6F4)
    val secondaryText = Color(0xFFA6ADC8)
    val mauve = Color(0xFFCBA6F7)
    val lavender = Color(0xFFB4BEFE)
    val green = Color(0xFFA6E3A1)
    val teal = Color(0xFF94E2D5)
    val yellow = Color(0xFFF9E2AF)
    val red = Color(0xFFF38BA8)
}

private val colors = darkColorScheme(
    primary = Mocha.mauve,
    onPrimary = Mocha.crust,
    primaryContainer = Mocha.surface,
    onPrimaryContainer = Mocha.mauve,
    secondary = Mocha.lavender,
    onSecondary = Mocha.crust,
    tertiary = Mocha.teal,
    onTertiary = Mocha.crust,
    background = Mocha.crust,
    onBackground = Mocha.text,
    surface = Mocha.mantle,
    onSurface = Mocha.text,
    surfaceVariant = Mocha.surface,
    onSurfaceVariant = Mocha.secondaryText,
    surfaceContainer = Mocha.base,
    surfaceContainerHigh = Mocha.surface,
    outline = Mocha.outline,
    outlineVariant = Mocha.border,
    error = Mocha.red,
    onError = Mocha.crust,
    errorContainer = Mocha.red.copy(alpha = 0.1f),
    onErrorContainer = Mocha.red,
)

@Composable
internal fun TransferTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colors, content = content)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TransferIconButton(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    tint: Color = Mocha.secondaryText,
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
    val shape = RoundedCornerShape(14.dp)
    Box(
        modifier = Modifier
            .size(42.dp)
            .background(Mocha.mauve.copy(alpha = 0.13f), shape)
            .border(1.dp, Mocha.mauve.copy(alpha = 0.2f), shape),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(29.dp)) {
            val factor = size.width / 48f
            withTransform({ scale(factor, factor, Offset.Zero) }) {
                drawCircle(Mocha.mauve, 3.5f, Offset(14f, 10f))
                drawRoundRect(Mocha.mauve, Offset(8f, 18f), Size(32f, 5f), CornerRadius(2.5f))
                drawRoundRect(Mocha.mauve, Offset(11f, 22f), Size(6f, 18f), CornerRadius(3f))
                drawRoundRect(Mocha.mauve, Offset(21f, 22f), Size(6f, 18f), CornerRadius(3f))
            }
        }
    }
}

@Composable
internal fun TransferArtwork(modifier: Modifier, complete: Boolean = false) {
    Canvas(modifier) {
        val factor = min(size.width / 152f, size.height / 124f)
        withTransform({
            translate((size.width - 152f * factor) / 2, (size.height - 124f * factor) / 2)
            scale(factor, factor, Offset.Zero)
        }) {
            val accent = if (complete) Mocha.green else Mocha.lavender
            drawCircle(
                Brush.radialGradient(
                    listOf(accent.copy(alpha = 0.2f), Color.Transparent),
                    center = Offset(77f, 62f),
                    radius = 66f,
                ),
                radius = 66f,
                center = Offset(77f, 62f),
            )
            rotate(-22f, Offset(76f, 63f)) {
                drawOval(
                    accent.copy(alpha = 0.22f),
                    topLeft = Offset(4f, 36f),
                    size = Size(144f, 54f),
                    style = Stroke(width = 1f),
                )
                drawCircle(accent, radius = 2.2f, center = Offset(28f, 83f))
            }
            drawSpark(Offset(28f, 33f), Mocha.mauve, 4f)
            drawSpark(Offset(125f, 88f), accent, 5f)
            drawCircle(Mocha.mauve.copy(alpha = 0.55f), radius = 1.6f, center = Offset(111f, 22f))

            if (complete) {
                drawCircle(Mocha.base, radius = 33f, center = Offset(76f, 62f))
                drawCircle(Mocha.green.copy(alpha = 0.2f), radius = 33f, center = Offset(76f, 62f))
                drawCircle(Mocha.green.copy(alpha = 0.5f), radius = 33f, center = Offset(76f, 62f), style = Stroke(1f))
                val check = Path().apply {
                    moveTo(60f, 62f)
                    lineTo(71f, 72f)
                    lineTo(92f, 51f)
                }
                drawPath(check, Mocha.green, style = Stroke(width = 4f, cap = StrokeCap.Round))
            } else {
                rotate(-16f, Offset(67f, 62f)) {
                    drawRoundRect(Mocha.surface, Offset(41f, 29f), Size(53f, 68f), CornerRadius(12f))
                    drawRoundRect(Mocha.border, Offset(41f, 29f), Size(53f, 68f), CornerRadius(12f), style = Stroke(1f))
                }
                rotate(8f, Offset(74f, 65f)) {
                    drawRoundRect(Mocha.base, Offset(49f, 29f), Size(53f, 69f), CornerRadius(12f))
                    drawRoundRect(Mocha.mauve.copy(alpha = 0.65f), Offset(49f, 29f), Size(53f, 69f), CornerRadius(12f), style = Stroke(1f))
                    drawRoundRect(Mocha.mauve.copy(alpha = 0.3f), Offset(59f, 40f), Size(15f, 15f), CornerRadius(5f))
                    drawLine(Mocha.lavender.copy(alpha = 0.75f), Offset(60f, 65f), Offset(85f, 65f), 2.5f, StrokeCap.Round)
                    drawLine(Mocha.border, Offset(60f, 73f), Offset(77f, 73f), 2.5f, StrokeCap.Round)
                    drawLine(Mocha.border, Offset(60f, 81f), Offset(70f, 81f), 2.5f, StrokeCap.Round)
                }
                val plane = Path().apply {
                    moveTo(87f, 58f)
                    lineTo(139f, 40f)
                    lineTo(121f, 84f)
                    lineTo(111f, 69f)
                    close()
                }
                drawPath(plane, Brush.linearGradient(listOf(Mocha.mauve, Mocha.lavender), Offset(91f, 59f), Offset(134f, 55f)))
                drawLine(Mocha.base.copy(alpha = 0.6f), Offset(111f, 69f), Offset(132f, 46f), 1.5f, StrokeCap.Round)
            }
        }
    }
}

private fun DrawScope.drawSpark(center: Offset, color: Color, radius: Float) {
    drawLine(color, center.copy(x = center.x - radius), center.copy(x = center.x + radius), 1f, StrokeCap.Round)
    drawLine(color, center.copy(y = center.y - radius), center.copy(y = center.y + radius), 1f, StrokeCap.Round)
}
