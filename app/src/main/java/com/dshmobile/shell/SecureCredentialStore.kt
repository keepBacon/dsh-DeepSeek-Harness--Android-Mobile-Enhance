package com.dshmobile.shell

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small Android-keystore backed credential store used only for plugin transports.
 * Secrets never enter the DSH profile files or shell scripts; helpers read them
 * from the child-process environment for the duration of a plugin operation.
 */
object SecureCredentialStore {
  data class GitCredential(val host: String, val username: String, val token: String)

  private const val PREFS = "dsh-secure-credentials"
  private const val KEY_ALIAS = "dsh-mobile-plugin-credentials-v1"
  private const val GIT_HOST = "git-host"
  private const val GIT_USER = "git-user"
  private const val GIT_TOKEN = "git-token"
  private const val SSH_PASSPHRASE = "ssh-passphrase"

  private fun prefs(context: Context) = context.applicationContext
    .getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun secretKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true)
        .build(),
    )
    return generator.generateKey()
  }

  private fun encrypt(value: String): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
    val body = Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
    return "v1:$iv:$body"
  }

  private fun decrypt(value: String?): String? {
    if (value.isNullOrBlank()) return null
    return try {
      val parts = value.split(':', limit = 3)
      if (parts.size != 3 || parts[0] != "v1") return null
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(
        Cipher.DECRYPT_MODE,
        secretKey(),
        GCMParameterSpec(128, Base64.decode(parts[1], Base64.NO_WRAP)),
      )
      String(cipher.doFinal(Base64.decode(parts[2], Base64.NO_WRAP)), Charsets.UTF_8)
    } catch (_: Throwable) {
      null
    }
  }

  private fun normalizeGitHost(value: String): String {
    val raw = value.trim()
    require(raw.isNotBlank() && raw.length <= 512 && !raw.any { it.isWhitespace() }) { "Git 主机名无效" }
    val uri = try {
      java.net.URI(if (raw.contains("://")) raw else "https://$raw")
    } catch (_: Throwable) {
      throw IllegalArgumentException("Git 主机名无效")
    }
    require(uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank()) { "Git 主机名无效" }
    require(uri.rawUserInfo == null && (uri.path.isNullOrEmpty() || uri.path == "/") && uri.rawQuery == null && uri.rawFragment == null) {
      "这里只填写 Git HTTPS 主机，不要包含仓库路径、用户信息或参数"
    }
    return uri.host.lowercase()
  }

  fun saveGitCredential(context: Context, host: String, username: String, token: String) {
    val cleanHost = normalizeGitHost(host)
    val cleanUser = username.trim().ifBlank { "x-access-token" }
    require(cleanUser.length <= 256 && !cleanUser.contains('\n') && !cleanUser.contains('\r')) { "Git 用户名无效" }
    require(token.isNotBlank() && token.length <= 16 * 1024 && !token.contains('\n') && !token.contains('\r')) { "Git Token 无效" }
    prefs(context).edit()
      .putString(GIT_HOST, cleanHost)
      .putString(GIT_USER, cleanUser)
      .putString(GIT_TOKEN, encrypt(token))
      .apply()
  }

  fun gitCredential(context: Context): GitCredential? {
    val p = prefs(context)
    val host = p.getString(GIT_HOST, null)?.trim().orEmpty()
    val user = p.getString(GIT_USER, null)?.trim().orEmpty()
    val token = decrypt(p.getString(GIT_TOKEN, null)).orEmpty()
    if (host.isBlank() || user.isBlank() || token.isBlank()) return null
    return GitCredential(host, user, token)
  }

  fun clearGitCredential(context: Context) {
    prefs(context).edit().remove(GIT_HOST).remove(GIT_USER).remove(GIT_TOKEN).apply()
  }

  fun saveSshPassphrase(context: Context, passphrase: String?) {
    val p = prefs(context)
    if (passphrase.isNullOrEmpty()) {
      p.edit().remove(SSH_PASSPHRASE).apply()
      return
    }
    require(passphrase.length <= 16 * 1024 && !passphrase.contains('\u0000')) { "SSH 口令无效" }
    p.edit().putString(SSH_PASSPHRASE, encrypt(passphrase)).apply()
  }

  fun sshPassphrase(context: Context): String? = decrypt(prefs(context).getString(SSH_PASSPHRASE, null))

  fun clearSshPassphrase(context: Context) {
    prefs(context).edit().remove(SSH_PASSPHRASE).apply()
  }
}
