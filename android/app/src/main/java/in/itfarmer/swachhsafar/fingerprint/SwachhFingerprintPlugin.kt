// Kotlin reserves `in`, so the first segment of the package name (in.itfarmer.swachhsafar) has to be
// written escaped. The compiled package is the plain one the manifest and Capacitor expect.
package `in`.itfarmer.swachhsafar.fingerprint

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Base64
import androidx.activity.result.ActivityResult
import com.acpl.ACPL_L1_Data
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Capacitor plugin that integrates the ACPL Access AST300 fingerprint scanner
 * with the web application layer using ACPL's "Scanner Support tools" companion app
 * (`com.acpl.fingerscannersupport`).
 *
 * Three methods — `status`, `capture`, `match` — follow the contract defined in
 * `docs/FINGERPRINT.md` and exercised by `tests/unit/fingerprintMatch.test.js`.
 *
 * **Templates only.** No fingerprint image is ever returned, stored, or logged.
 */
@CapacitorPlugin(name = "SwachhFingerprint")
class SwachhFingerprintPlugin : Plugin() {

    companion object {
        const val MATCHER_ID = "acpl_ast300"
        const val DEVICE_NAME = "Access AST300"
        const val ACPL_PACKAGE = "com.acpl.fingerscannersupport"
        const val ACTION_CAPTURE = "in.acpl.fp.capture"
        const val ACTION_MATCH = "in.acpl.fp.match"
        const val EXTRA_L1_DATA = "ACPL_L1_Data"
        const val VENDOR_ID = 0x34FC
        // Bumped with each matcher fix, and shown on screen when a template cannot be read, so it is
        // obvious whether the phone runs an APK that has the fix at all.
        const val MATCHER_BUILD = 3
    }

    private lateinit var executor: ExecutorService

    override fun load() {
        super.load()
        executor = Executors.newSingleThreadExecutor { r ->
            Thread(r, "SwachhFingerprint-IO").apply { isDaemon = true }
        }
    }

    // =============================================================================================
    // status() → { connected, device?, matcher?, reason? }
    // =============================================================================================

    @PluginMethod
    fun status(call: PluginCall) {
        val pm = context.packageManager
        val isAppInstalled = try {
            pm.getPackageInfo(ACPL_PACKAGE, 0)
            true
        } catch (_: Exception) {
            false
        }

        val ret = JSObject()
        if (!isAppInstalled) {
            ret.put("connected", false)
            ret.put("device", DEVICE_NAME)
            ret.put("matcher", MATCHER_ID)
            ret.put("reason", "Scanner Support tools not installed. Please install 'Scanner Support tools' for ACPL.")
        } else {
            // Check if USB device is attached
            val usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager
            val isScannerAttached = usbManager.deviceList.values.any { it.vendorId == VENDOR_ID } ||
                    usbManager.deviceList.isNotEmpty()

            // As long as the companion driver app is installed and scanner is attached (or available)
            ret.put("connected", isScannerAttached)
            ret.put("device", DEVICE_NAME)
            ret.put("matcher", MATCHER_ID)
            ret.put("reason", if (isScannerAttached) "ready" else "No fingerprint scanner is connected. Plug it in via USB OTG.")
        }

        call.resolve(ret)
    }

    // =============================================================================================
    // capture({ timeoutMs }) → { template, format, quality? }
    //   rejects with code: no_scanner | timeout | poor_quality | cancelled | permission
    // =============================================================================================

    @PluginMethod
    fun capture(call: PluginCall) {
        val pm = context.packageManager
        try {
            pm.getPackageInfo(ACPL_PACKAGE, 0)
        } catch (_: Exception) {
            call.reject("Scanner Support tools not installed", "no_scanner")
            return
        }

        val intent = Intent(ACTION_CAPTURE).apply {
            setPackage(ACPL_PACKAGE)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }

        // The companion app is installed, but that is no promise it answers to this action: an older
        // build, or a different edition of it, simply has no such activity. Launching it anyway throws,
        // and a throw here leaves the call unanswered -- which the web layer can only show as a spinner
        // that never stops. So the intent is checked first, and every failure answers the call.
        if (intent.resolveActivity(pm) == null) {
            call.reject(
                "Scanner Support tools is installed but does not accept $ACTION_CAPTURE. Update it from ACPL.",
                "no_scanner",
            )
            return
        }

        try {
            startActivityForResult(call, intent, "captureResultCallback")
        } catch (e: Exception) {
            call.reject(e.message ?: "The scanner app could not be opened.", "no_scanner")
        }
    }

    // Every path out of this callback answers the call -- resolve or reject, never neither. An unanswered
    // call is a promise that stays pending in the web layer for ever, so even an unexpected exception
    // (an ACPL_L1_Data the installed app marshals differently, say) is reported rather than thrown away.
    @ActivityCallback
    private fun captureResultCallback(call: PluginCall, result: ActivityResult) {
        try {
            captureResult(call, result)
        } catch (e: Exception) {
            call.reject(e.message ?: "The scanner's result could not be read.", "poor_quality")
        }
    }

    private fun captureResult(call: PluginCall, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_CANCELED) {
            call.reject("Scan cancelled", "cancelled")
            return
        }

        val data = result.data
        if (data == null) {
            call.reject("No data returned from scanner", "no_scanner")
            return
        }

        // The parcel names the class that wrote it and is read back with this app's classes, so the
        // reader has to be told which loader to use; without it the extras come back unparcelled.
        data.setExtrasClassLoader(ACPL_L1_Data::class.java.classLoader)

        val l1Data: ACPL_L1_Data? = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                data.getParcelableExtra(EXTRA_L1_DATA, ACPL_L1_Data::class.java)
            } else {
                @Suppress("DEPRECATION")
                data.getParcelableExtra(EXTRA_L1_DATA)
            }
        } catch (_: Exception) {
            // The installed companion app writes its fields in an order this app's copy of the class does
            // not expect. That is not a failed scan, and the extras are still there to be read directly.
            null
        }

        // A template found anywhere in the answer beats the error code: this app's copy of ACPL_L1_Data
        // mirrors the vendor's field order, and a copy that is out by one field reads a stray number as
        // errorCode and refuses a scan that is perfectly good. The error code is believed only when there
        // is no template to be had.
        val template = isoTemplate(l1Data?.templateBase64)
            ?: isoTemplate(l1Data?.base64ISOTemplate)
            ?: templateFromExtras(data)

        if (template == null) {
            val code = l1Data?.errorCode ?: 0
            val status = l1Data?.status
            val detail = when {
                !status.isNullOrBlank() -> status
                code != 0 -> "the scanner reported error $code"
                else -> "the scanner app answered with ${describeExtras(data)}"
            }
            call.reject("No fingerprint template in the scan: $detail", "poor_quality")
            return
        }

        val ret = JSObject().apply {
            put("template", template)
            put("format", "iso-19794-2")
            val nfiq = l1Data?.nfiq ?: 0
            if (nfiq > 0) put("quality", nfiq)
        }
        call.resolve(ret)
    }

    // An ISO/IEC 19794-2 template begins with the magic "FMR", which is "Rk1S" once base64-encoded. It is
    // what tells a template from the base64 of an image, and an image is the one thing that must never be
    // taken out of the scanner: see docs/FINGERPRINT.md.
    //
    // ACPL's companion app is shipped in more than one build, and they do not all hand the template back
    // the same way: base64 text, hex text ("464D52..."), or the raw bytes. Recognising only the first made
    // a perfectly good scan from the others read as "not clear enough", however clean the finger was.
    private fun isoTemplate(value: String?): String? {
        val v = value?.trim()?.replace("\n", "")?.replace("\r", "")?.replace(" ", "")
        if (v.isNullOrEmpty()) return null
        if (v.startsWith("Rk1S")) return v
        if (v.length >= 60 && v.length % 2 == 0 && v.startsWith("464D52", ignoreCase = true) &&
            v.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) {
            val bytes = ByteArray(v.length / 2) { i -> v.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
            return Base64.encodeToString(bytes, Base64.NO_WRAP)
        }
        return null
    }

    private fun isoTemplate(value: ByteArray?): String? =
        if (value != null && value.size >= 30 && value[0].toInt() == 0x46 && value[1].toInt() == 0x4D &&
            value[2].toInt() == 0x52) Base64.encodeToString(value, Base64.NO_WRAP) else null

    // The companion app's own extras, read directly. Used when the typed read gives nothing: the vendor
    // ships more than one build of that app and they do not all return the same shape.
    private fun templateFromExtras(data: Intent): String? {
        val extras = data.extras ?: return null
        for (key in extras.keySet()) {
            val found = try {
                @Suppress("DEPRECATION")
                when (val v = extras.get(key)) {
                    is String -> isoTemplate(v)
                    is ByteArray -> isoTemplate(v)
                    else -> null
                }
            } catch (_: Exception) {
                null
            }
            if (found != null) return found
        }
        return null
    }

    // What the scanner app actually sent, for an error a person can act on: the keys and the kind of value
    // under each. Never a value -- a template is biometric data and an image must not leave the scanner.
    private fun describeExtras(data: Intent): String {
        val extras = data.extras ?: return "no extras at all"
        val keys = extras.keySet()
        if (keys.isEmpty()) return "no extras at all"
        return keys.joinToString(", ") { key ->
            val kind = try {
                @Suppress("DEPRECATION")
                extras.get(key)?.javaClass?.simpleName ?: "null"
            } catch (_: Exception) {
                "unreadable"
            }
            "$key ($kind)"
        }
    }

    // =============================================================================================
    // match({ template, candidates, format }) → { score, finger?, matcher? }
    // =============================================================================================

    @PluginMethod
    fun match(call: PluginCall) {
        val templateB64 = call.getString("template")
        if (templateB64.isNullOrEmpty()) {
            call.reject("'template' is required", "no_scanner")
            return
        }

        val candidatesArr = call.getArray("candidates")
        if (candidatesArr == null || candidatesArr.length() == 0) {
            call.reject("'candidates' is required and must not be empty", "no_scanner")
            return
        }

        // Same rule as capture: the call is answered even if the worker cannot be queued at all (the
        // executor is shut down while the activity is going away), rather than left pending.
        try {
            executor.execute { matchOnWorker(call, candidatesArr, templateB64) }
        } catch (e: Exception) {
            call.reject(e.message ?: "The matcher is not available.", "no_scanner")
        }
    }

    private fun matchOnWorker(call: PluginCall, candidatesArr: JSArray, templateB64: String) {
        try {
            val probe = Base64.decode(templateB64, Base64.DEFAULT)
            // How many minutiae each side actually yielded. A score of zero means one of two completely
            // different things -- a different finger, or a template this app could not read -- and
            // without these the two are indistinguishable from the outside, which is how a parser that
            // read no minutiae at all went unnoticed behind "no match".
            val probeMinutiae = IsoTemplateMatcher.parseIso19794(probe).size
            var candidateMinutiae = 0
            var bestScore = 0.0
            var bestFinger: String? = null
            var firstCandidate: ByteArray? = null

            // A finger is registered from several presses, so each candidate carries a list of them and
            // the best one counts: the press being verified has to resemble only one of the impressions
            // taken at registration, not the single one that happened to be stored first.
            for (i in 0 until candidatesArr.length()) {
                val obj = candidatesArr.getJSONObject(i)
                val finger = obj.optString("finger")
                for (candB64 in templatesOf(obj)) {
                    val candBytes = Base64.decode(candB64, Base64.DEFAULT)
                    if (firstCandidate == null) firstCandidate = candBytes
                    candidateMinutiae = maxOf(candidateMinutiae, IsoTemplateMatcher.parseIso19794(candBytes).size)
                    val score = IsoTemplateMatcher.match(probe, candBytes)
                    if (score > bestScore) {
                        bestScore = score
                        bestFinger = finger
                    }
                    // Nothing is learned by comparing further once the match is beyond doubt.
                    if (bestScore >= 90.0) break
                }
                if (bestScore >= 90.0) break
            }

            val ret = JSObject().apply {
                put("score", bestScore)
                bestFinger?.let { put("finger", it) }
                put("matcher", MATCHER_ID)
                put("probeMinutiae", probeMinutiae)
                put("candidateMinutiae", candidateMinutiae)
                // Diagnostics for a template that still reads as empty: which matcher build this APK
                // carries (absent = an APK from before the fixes), and the first 24 bytes of each
                // record -- the header only (format, version, length, image size, resolution), which
                // ends before the first minutia, so no biometric data is exposed.
                put("matcherBuild", MATCHER_BUILD)
                put("probeHeader", headerHex(probe))
                firstCandidate?.let { put("candidateHeader", headerHex(it)) }
            }
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("Matching error: ${e.message}", "no_scanner")
        }
    }

    private fun headerHex(bytes: ByteArray): String =
        bytes.take(24).joinToString("") { "%02X".format(it.toInt() and 0xFF) }

    // The impressions stored for one finger: a "templates" list, or the single "template" an app built
    // before multi-press registration still sends.
    private fun templatesOf(obj: org.json.JSONObject): List<String> {
        val out = ArrayList<String>()
        val arr = obj.optJSONArray("templates")
        if (arr != null) {
            for (i in 0 until arr.length()) {
                val t = arr.optString(i)
                if (!t.isNullOrEmpty()) out.add(t)
            }
        }
        val single = obj.optString("template")
        if (out.isEmpty() && !single.isNullOrEmpty()) out.add(single)
        return out
    }

    // =============================================================================================
    // Lifecycle
    // =============================================================================================

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        executor.shutdown()
    }
}
