package dev.kyuyoung.hongsi

import android.Manifest
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.net.toUri
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException

internal object PublicDownloads {
    private const val RELATIVE_PATH = "Download/홍시/"

    fun canWrite(context: Context): Boolean = Build.VERSION.SDK_INT >= 29 ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    @Suppress("DEPRECATION")
    private fun directory() = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "홍시").canonicalFile

    fun save(context: Context, path: String, name: String): String {
        val source = File(path).canonicalFile
        require(source.parentFile == File(context.cacheDir, "download-staging").canonicalFile && source.isFile)
        require(name.isNotBlank() && name != "." && name != ".." && '/' !in name && '\\' !in name)
        if (!canWrite(context)) throw SecurityException()
        return if (Build.VERSION.SDK_INT >= 29) saveMedia(context, source, name) else saveLegacy(context, source, name)
    }

    @RequiresApi(29)
    private fun saveMedia(context: Context, source: File, name: String): String {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, DownloadFiles.mime(File(name)))
            put(MediaStore.MediaColumns.RELATIVE_PATH, RELATIVE_PATH)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values)
            ?: throw IOException()
        try {
            val output = resolver.openOutputStream(uri, "w") ?: throw IOException()
            output.use { target -> source.inputStream().use { it.copyTo(target) } }
            val published = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            if (resolver.update(uri, published, null, null) != 1) throw IOException()
            return uri.toString()
        } catch (error: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw error
        }
    }

    private fun saveLegacy(context: Context, source: File, name: String): String {
        val dir = directory()
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException()
        val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
        var file = File(dir, name)
        var index = 0
        while (!file.createNewFile()) {
            index++
            file = File(dir, "${name.take(dot)} ($index)${name.substring(dot)}")
        }
        try {
            file.outputStream().use { target -> source.inputStream().use { it.copyTo(target) } }
        } catch (error: Exception) {
            file.delete()
            throw error
        }
        MediaScannerConnection.scanFile(context, arrayOf(file.path), arrayOf(DownloadFiles.mime(file)), null)
        return file.path
    }

    private fun checkedFile(context: Context, value: String): File {
        val file = File(value).canonicalFile
        val legacy = file.parentFile == DownloadFiles.directory(context)
        if (!legacy && (Build.VERSION.SDK_INT >= 29 || file.parentFile != directory())) throw FileNotFoundException()
        if (!legacy && !canWrite(context)) throw SecurityException()
        if (!file.isFile) throw FileNotFoundException()
        file.inputStream().use { }
        return file
    }

    @RequiresApi(29)
    private fun checkedMedia(context: Context, value: String): Uri {
        val uri = value.toUri()
        val parts = uri.pathSegments
        if (uri.scheme != "content" || uri.authority != MediaStore.AUTHORITY || uri.query != null || uri.fragment != null ||
            parts.size != 3 || parts[0] !in setOf(MediaStore.VOLUME_EXTERNAL_PRIMARY, MediaStore.VOLUME_EXTERNAL) ||
            parts[1] != "downloads" || parts[2].toLongOrNull()?.let { it > 0 } != true) throw FileNotFoundException()
        val columns = arrayOf(MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.MediaColumns.OWNER_PACKAGE_NAME)
        context.contentResolver.query(uri, columns, null, null, null).use { cursor ->
            if (cursor == null || !cursor.moveToFirst() || cursor.getString(0) != RELATIVE_PATH ||
                cursor.getString(1) != context.packageName) throw FileNotFoundException()
        }
        val descriptor = context.contentResolver.openFileDescriptor(uri, "r") ?: throw FileNotFoundException()
        descriptor.close()
        return uri
    }

    fun check(context: Context, value: String): String {
        return if (value.startsWith("content:") && Build.VERSION.SDK_INT >= 29) checkedMedia(context, value).toString()
            else checkedFile(context, value).path
    }

    fun open(context: Context, value: String): Intent {
        val uri: Uri
        val mime: String
        if (value.startsWith("content:") && Build.VERSION.SDK_INT >= 29) {
            uri = checkedMedia(context, value)
            mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
        } else {
            val file = checkedFile(context, value)
            uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
            mime = DownloadFiles.mime(file)
        }
        return Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    fun reveal(context: Context, value: String) {
        val reference = check(context, value)
        val legacy = !reference.startsWith("content:") && File(reference).parentFile == DownloadFiles.directory(context)
        if (!legacy) {
            val samsung = Intent("samsung.myfiles.intent.action.LAUNCH_MY_FILES")
                .setPackage("com.sec.android.app.myfiles")
                .putExtra("samsung.myfiles.intent.extra.START_PATH", directory().path)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                context.startActivity(samsung)
                return
            } catch (_: ActivityNotFoundException) { }
        }
        val uri = if (legacy) DocumentsContract.buildRootUri(DownloadFiles.authority(context), DownloadFiles.ROOT_ID)
            else DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:${RELATIVE_PATH.trimEnd('/')}")
        val mime = if (legacy) "vnd.android.document/root" else DocumentsContract.Document.MIME_TYPE_DIR
        val action = if (legacy && Build.VERSION.SDK_INT < 26) "android.provider.action.BROWSE" else Intent.ACTION_VIEW
        val view = Intent(action).setDataAndType(uri, mime)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(view)
        } catch (error: ActivityNotFoundException) {
            if (legacy) throw error
            context.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
}
