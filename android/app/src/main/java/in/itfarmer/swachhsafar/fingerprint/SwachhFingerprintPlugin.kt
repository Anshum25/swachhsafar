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
        const val VENDOR_ID = 0x34FC
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

        val l1Data: ACPL_L1_Data? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            data.getParcelableExtra("ACPL_L1_Data", ACPL_L1_Data::class.java)
        } else {
            @Suppress("DEPRECATION")
            data.getParcelableExtra("ACPL_L1_Data")
        }

        if (l1Data == null) {
            call.reject("Scanner returned empty result", "no_scanner")
            return
        }

        if (l1Data.errorCode != 0) {
            val msg = l1Data.status ?: "Capture failed with error code ${l1Data.errorCode}"
            call.reject(msg, "poor_quality")
            return
        }

        val template = l1Data.templateBase64 ?: l1Data.base64ISOTemplate
        if (template.isNullOrEmpty()) {
            call.reject("Scanner returned empty template", "poor_quality")
            return
        }

        val ret = JSObject().apply {
            put("template", template)
            put("format", "iso-19794-2")
            if (l1Data.nfiq > 0) {
                put("quality", l1Data.nfiq)
            }
        }
        call.resolve(ret)
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
            var bestScore = 0.0
            var bestFinger: String? = null

            for (i in 0 until candidatesArr.length()) {
                val obj = candidatesArr.getJSONObject(i)
                val finger = obj.optString("finger")
                val candB64 = obj.optString("template")
                if (!candB64.isNullOrEmpty()) {
                    val candBytes = Base64.decode(candB64, Base64.DEFAULT)
                    val score = IsoTemplateMatcher.match(probe, candBytes)
                    if (score > bestScore) {
                        bestScore = score
                        bestFinger = finger
                    }
                    // Early exit once a solid match is found
                    if (bestScore >= 60.0) {
                        break
                    }
                }
            }

            val ret = JSObject().apply {
                put("score", bestScore)
                bestFinger?.let { put("finger", it) }
                put("matcher", MATCHER_ID)
            }
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("Matching error: ${e.message}", "no_scanner")
        }
    }

    // =============================================================================================
    // Lifecycle
    // =============================================================================================

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        executor.shutdown()
    }
}
