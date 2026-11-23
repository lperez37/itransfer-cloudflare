package com.vivacityholding.itransfer

import android.annotation.SuppressLint
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONException
import org.json.JSONObject

internal const val SESSION_COOKIE = "itransfer_session"
internal val sessionTokenPattern = Regex("[a-f0-9]{64}")
internal val identifierPattern = Regex("[a-zA-Z0-9_-]{1,128}")

internal class SessionCredentials(val token: String, val accountId: String, val expiresAt: Long)
internal class AccountSession(val account: Account, val credentials: SessionCredentials)

// The KTX preference editor does not return the disk commit result.
@SuppressLint("UseKtx")
internal class SessionStore(context: Context) {
    private val preferences = context.getSharedPreferences("account_session", Context.MODE_PRIVATE)
    private val keyAlias = "itransfer-session-v1"
    private val origin = BuildConfig.SERVER_ORIGIN.toByteArray(Charsets.UTF_8)

    fun read(): SessionCredentials? {
        val stored = preferences.getString("session", null) ?: return null
        val session = try {
            val parts = stored.split('.', limit = 2)
            require(parts.size == 2)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            val key = loadKey() ?: throw GeneralSecurityException("Session key unavailable")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            cipher.updateAAD(origin)
            val decoded = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP))
            try {
                val json = JSONObject(decoded.toString(Charsets.UTF_8))
                SessionCredentials(json.getString("token"), json.getString("account_id"), json.getLong("expires_at"))
            } finally {
                decoded.fill(0)
            }
        } catch (_: GeneralSecurityException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        } catch (_: JSONException) {
            null
        }

        if (session == null || session.expiresAt <= System.currentTimeMillis() ||
            !sessionTokenPattern.matches(session.token) || !identifierPattern.matches(session.accountId)
        ) {
            clear()
            return null
        }
        return session
    }

    fun write(session: SessionCredentials) {
        val key = loadKey() ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            )
            generateKey()
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        // A debug build can change servers while keeping its package and data.
        cipher.updateAAD(origin)
        val plaintext = JSONObject()
            .put("token", session.token)
            .put("account_id", session.accountId)
            .put("expires_at", session.expiresAt)
            .toString().toByteArray(Charsets.UTF_8)
        val encrypted = try {
            cipher.doFinal(plaintext)
        } finally {
            plaintext.fill(0)
        }
        val encoded = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + "." +
            Base64.encodeToString(encrypted, Base64.NO_WRAP)
        check(preferences.edit().putString("session", encoded).commit())
    }

    fun clear() {
        if (!preferences.edit().remove("session").commit()) {
            loadKeyStore().deleteEntry(keyAlias)
        }
    }

    private fun loadKey(): SecretKey? = loadKeyStore().getKey(keyAlias, null) as? SecretKey

    private fun loadKeyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
}
