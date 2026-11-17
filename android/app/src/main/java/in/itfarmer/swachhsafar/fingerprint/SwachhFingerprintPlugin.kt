// Kotlin reserves `in`, so the first segment of the package name (in.itfarmer.swachhsafar) has to be
// written escaped. The compiled package is the plain one the manifest and Capacitor expect.
package `in`.itfarmer.swachhsafar.fingerprint

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Capacitor plugin that exposes the USB fingerprint scanner to the web layer.
 *
 * The JS side accesses it as `Capacitor.Plugins.SwachhFingerprint` via
 * `src/fingerprint/scanner.js`, which is the **only** file that talks to it.
 *
 * Three methods — `status`, `capture`, `match` — follow the contract defined in
 * `docs/FINGERPRINT.md` and exercised by `tests/unit/fingerprintMatch.test.js`.
 *
 * **Templates only.** No fingerprint image is ever returned, stored, or logged.
 */
@CapacitorPlugin(name = "SwachhFingerprint")
class SwachhFingerprintPlugin : Plugin() {

    private var driver: FingerprintDriver? = null

    /** Single-threaded executor for USB I/O and SDK calls that must not block the main thread. */
    private lateinit var executor: ExecutorService

    override fun load() {
        super.load()
        executor = Executors.newSingleThreadExecutor { r ->
            Thread(r, "SwachhFingerprint-IO").apply { isDaemon = true }
        }
        driver = AcplAst300Driver(context)
    }

    // =============================================================================================
    // status() → { connected, device?, matcher?, reason? }
    // =============================================================================================

    @PluginMethod
    fun status(call: PluginCall) {
        val d = driver
        if (d == null) {
            call.resolve(JSObject().apply {
                put("connected", false)
                put("reason", "driver_not_loaded")
            })
            return
        }

        val reason = d.disconnectReason()
        call.resolve(JSObject().apply {
            put("connected", reason == null)
            put("device", d.deviceName)
            put("matcher", d.matcherId)
            if (reason != null) put("reason", reason)
        })
    }

    // =============================================================================================
    // capture({ timeoutMs }) → { template, format, quality? }
    //   rejects with code: no_scanner | timeout | poor_quality | cancelled | permission
    // =============================================================================================

    @PluginMethod
    fun capture(call: PluginCall) {
        val d = driver
        if (d == null) {
            call.reject("Driver not loaded", "no_scanner")
            return
        }

        val timeoutMs = call.data.optLong("timeoutMs", 15_000L)

        executor.execute {
            try {
                val result = d.capture(timeoutMs)
                call.resolve(JSObject().apply {
                    put("template", result.template)
                    put("format", result.format)
                    result.quality?.let { put("quality", it) }
                })
            } catch (e: CaptureException) {
                call.reject(e.message ?: "Capture failed", e.code)
            } catch (e: Exception) {
                call.reject(e.message ?: "Capture failed", "no_scanner")
            }
        }
    }

    // =============================================================================================
    // match({ template, candidates, format }) → { score, finger?, matcher? }
    // =============================================================================================

    @PluginMethod
    fun match(call: PluginCall) {
        val d = driver
        if (d == null) {
            call.reject("Driver not loaded", "no_scanner")
            return
        }

        // --- Parse arguments ---

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

        val candidates = mutableListOf<CandidateTemplate>()
        try {
            for (i in 0 until candidatesArr.length()) {
                val obj = candidatesArr.getJSONObject(i)
                candidates.add(
                    CandidateTemplate(
                        finger = obj.getString("finger"),
                        template = obj.getString("template"),
                    )
                )
            }
        } catch (e: Exception) {
            call.reject("Invalid candidates format: ${e.message}", "no_scanner")
            return
        }

        val probe: ByteArray = try {
            Base64.decode(templateB64, Base64.DEFAULT)
        } catch (e: Exception) {
            call.reject("Invalid Base64 in 'template': ${e.message}", "no_scanner")
            return
        }

        // --- Run the matcher off the main thread ---

        executor.execute {
            try {
                val result = d.match(probe, candidates)
                call.resolve(JSObject().apply {
                    put("score", result.score)
                    result.finger?.let { put("finger", it) }
                    put("matcher", result.matcher)
                })
            } catch (e: Exception) {
                call.reject(e.message ?: "Match failed", "no_scanner")
            }
        }
    }

    // =============================================================================================
    // Lifecycle
    // =============================================================================================

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        driver?.release()
        driver = null
        executor.shutdown()
    }
}

