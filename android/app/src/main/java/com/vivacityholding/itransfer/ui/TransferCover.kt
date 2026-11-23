package com.vivacityholding.itransfer.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlin.math.min

@Composable
internal fun TransferCover(
    title: String,
    receiving: Boolean = false,
    content: @Composable ColumnScope.() -> Unit = {},
) {
    val color = if (receiving) Color(0xFF14594F) else Color(0xFF2947AF)
    BoxWithConstraints(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(color)) {
        val textWidth = 160.dp * LocalDensity.current.fontScale
        val spaceForArt = maxWidth - 34.dp - textWidth
        val artWidth = if (spaceForArt >= 96.dp) minOf(spaceForArt, maxWidth * 0.43f, 180.dp) else 0.dp
        if (artWidth > 0.dp) {
            PostArtwork(receiving, Modifier.align(Alignment.CenterEnd).size(artWidth, 132.dp))
        }
        Column(
            Modifier.fillMaxWidth().heightIn(min = 132.dp).padding(start = 22.dp, end = artWidth + 12.dp, top = 16.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp, Alignment.CenterVertically),
        ) {
            Text(title, Modifier.semantics { heading() }, color = Color.White, style = MaterialTheme.typography.headlineLarge)
            content()
        }
    }
}

@Composable
private fun PostArtwork(receiving: Boolean, modifier: Modifier) {
    Canvas(modifier) {
        val scale = min(size.width / 174f, size.height / 132f)
        withTransform({
            translate((size.width - 174f * scale) / 2f, (size.height - 132f * scale) / 2f)
            scale(scale, scale, Offset.Zero)
        }) {
            // Postmark rings and a short flight path are printed behind the folded paper.
            for (radius in listOf(46f, 57f, 68f)) {
                drawCircle(Color.White.copy(alpha = 0.11f), radius, Offset(152f, 4f), style = Stroke(0.9f))
            }
            val trail = Path().apply {
                moveTo(-4f, 113f)
                cubicTo(29f, 123f, 63f, 103f, 45f, 93f)
                cubicTo(31f, 87f, 28f, 111f, 56f, 105f)
                quadraticTo(65f, 103f, 76f, 94f)
            }
            drawPath(trail, Color.White.copy(alpha = 0.57f), style = Stroke(
                width = 1.5f, cap = StrokeCap.Round, pathEffect = PathEffect.dashPathEffect(floatArrayOf(3f, 5f)),
            ))
            if (receiving) {
                rotate(-10f, Offset(97f, 67f)) {
                    val left = Offset(44f, 57f)
                    val right = Offset(147f, 57f)
                    val bottomLeft = Offset(44f, 103f)
                    val bottomRight = Offset(147f, 103f)
                    val lining = Color(0xFF7BBEAA)
                    fold(lining, left, Offset(96f, 19f), right)
                    drawRect(lining, left, Size(103f, 46f))
                    drawRoundRect(Color(0xFFFFF7E5), Offset(57f, 36f), Size(78f, 51f), CornerRadius(3f))
                    drawRoundRect(Color(0xFFE9AA63), Offset(116f, 42f), Size(11f, 12f), CornerRadius(1f))
                    drawLine(Color(0xFF819D99), Offset(65f, 50f), Offset(92f, 50f), 2f, StrokeCap.Round)
                    drawLine(Color(0xFFA6BAB1), Offset(65f, 56f), Offset(84f, 56f), 2f, StrokeCap.Round)
                    fold(Color(0xFFAFE2CE), left, Offset(96f, 81f), bottomLeft)
                    fold(Color(0xFFBFEBD9), right, bottomRight, Offset(96f, 81f))
                    fold(Color(0xFFE2F3E8), bottomLeft, Offset(96f, 72f), bottomRight)
                }
            } else {
                val tip = Offset(157f, 22f)
                val crease = Offset(72f, 72f)
                val tail = Offset(75f, 99f)
                fold(Color(0xFFFBF6E6), Offset(15f, 54f), tip, crease)
                fold(Color(0xFF91B1EA), crease, tip, tail)
                fold(Color(0xFF617FC2), tail, tip, Offset(92f, 81f))
                fold(Color(0xFFDCE8FF), Offset(83f, 77f), tip, Offset(125f, 108f))
                drawLine(Color.White.copy(alpha = 0.68f), Offset(83f, 77f), tip, 0.9f)
            }
        }
    }
}

private fun DrawScope.fold(color: Color, first: Offset, second: Offset, third: Offset) {
    drawPath(Path().apply {
        moveTo(first.x, first.y)
        lineTo(second.x, second.y)
        lineTo(third.x, third.y)
        close()
    }, color)
}
