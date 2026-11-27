// Kotlin reserves `in`, so the first segment of the package name (in.itfarmer.swachhsafar) has to be
// written escaped. The compiled package is the plain one the manifest and Capacitor expect.
package `in`.itfarmer.swachhsafar.files

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * Saves a report the page generated (Excel / PDF) where the user can find it, because a WebView cannot
 * follow a blob: download link. Android 10+: the public Downloads folder through MediaStore (no permission
 * needed). Android 8-9: the app's own Downloads folder, shared through the FileProvider. The file is then
 * opened with whatever app handles its type; if there is none it simply stays saved.
 */
@CapacitorPlugin(name = "SwachhFiles")
class SwachhFilesPlugin : Plugin() {

    @PluginMethod
    fun save(call: PluginCall) {
        val name = call.getString("name")?.replace(Regex("[\\\\/:*?\"<>|]"), "_")
        val mime = call.getString("mime") ?: "application/octet-stream"
        val data = call.getString("data")
        if (name.isNullOrBlank() || data == null) {
            call.reject("name and data are required")
            return
        }
        try {
            val bytes = Base64.decode(data, Base64.DEFAULT)
            val (uri, location) = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(MediaStore.MediaColumns.MIME_TYPE, mime)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/SwachhSafar")
                }
                val resolver = context.contentResolver
                val target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("Could not create the file in Downloads")
                resolver.openOutputStream(target)?.use { it.write(bytes) }
                    ?: throw IllegalStateException("Could not write the file")
                target to "Downloads/SwachhSafar/$name"
            } else {
                val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "SwachhSafar").apply { mkdirs() }
                val file = File(dir, name)
                file.writeBytes(bytes)
                FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file) to file.absolutePath
            }
            val opened = open(uri, mime)
            call.resolve(JSObject().apply {
                put("uri", uri.toString())
                put("location", location)
                put("opened", opened)
            })
        } catch (e: Exception) {
            call.reject(e.message ?: "Could not save the file", e)
        }
    }

    private fun open(uri: Uri, mime: String): Boolean {
        val view = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            activity.startActivity(Intent.createChooser(view, "Open with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }
}
