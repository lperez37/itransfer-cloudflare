package com.vivacityholding.itransfer

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.vivacityholding.itransfer.ui.TransferApp

class MainActivity : ComponentActivity() {
    private val model by viewModels<TransferViewModel>()
    private val documents = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) {
        model.addDocuments(it)
    }
    private val download = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        model.saveDownload(result.data?.data?.takeIf { result.resultCode == RESULT_OK })
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        if (savedInstanceState == null) receiveShare(intent)
        setContent {
            val state by model.state.collectAsStateWithLifecycle()
            TransferApp(
                state = state,
                model = model,
                chooseFiles = { documents.launch(arrayOf("*/*")) },
                copyLink = ::copyLink,
                shareLink = ::shareLink,
                openWebsite = { openLink(BuildConfig.SERVER_ORIGIN) },
                startDownload = ::startDownload,
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        receiveShare(intent)
    }

    private fun receiveShare(intent: Intent) {
        if (intent.action == Intent.ACTION_VIEW) {
            model.openPublicLink(intent.dataString)
            return
        }
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return
        val batch = try {
            intent.incomingBatch()
        } catch (_: RuntimeException) {
            IncomingBatch(emptyList())
        }
        if (batch != null) model.receive(batch)
    }

    private fun copyLink(url: String) {
        val clip = ClipData.newPlainText("iTransfer link", url)
        clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
        getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
        if (Build.VERSION.SDK_INT < 33) Toast.makeText(this, "Link copied", Toast.LENGTH_SHORT).show()
    }

    private fun shareLink(url: String) {
        val share = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url)
        startActivity(Intent.createChooser(share, "Share iTransfer link"))
    }

    private fun startDownload(task: DownloadTask, access: WorkspaceAccess?) {
        if (!model.prepareDownload(task, access)) return
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(task.mimeType)
            .putExtra(Intent.EXTRA_TITLE, safeDownloadName(task.suggestedName))
        try {
            download.launch(intent)
        } catch (_: ActivityNotFoundException) {
            model.saveDownload(null)
            Toast.makeText(this, "No file picker is available", Toast.LENGTH_SHORT).show()
        }
    }

    private fun openLink(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, url.toUri()))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "No browser is available", Toast.LENGTH_SHORT).show()
        }
    }
}
