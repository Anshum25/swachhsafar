// Kotlin reserves `in`, so the first segment of the package name (in.itfarmer.swachhsafar) has to be
// written escaped. The compiled package is the plain one the manifest and Capacitor expect.
package `in`.itfarmer.swachhsafar.fingerprint

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Base64
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * [FingerprintDriver] for the Access Computech (ACPL / Startek) AST300 scanner over USB OTG.
 *
 * **USB detection works without the vendor SDK** — the device is identified by its USB Vendor ID
 * (`0x34FC` / 13561). Capture and match require the vendor's **non-Aadhaar** Android SDK: drop the
 * `.aar` or `.jar` into `android/app/libs` and implement the two clearly marked integration points
 * in [captureWithSdk] and [matchWithSdk].
 *
 * The UIDAI RD Service (`com.acpl.registersdk_l1`) cannot be used here — it returns a PID block
 * encrypted for UIDAI, so nothing can be stored or compared locally. See `docs/FINGERPRINT.md`.
 */
class AcplAst300Driver(private val context: Context) : FingerprintDriver {

    companion object {
        private const val TAG = "AcplAst300"

        /** USB Vendor ID for Access Computech Ltd. — `0x34FC` (13561 decimal). */
        const val VENDOR_ID = 0x34FC

        /** Consistent matcher identifier stored with every enrollment and match result. */
        const val MATCHER = "acpl_ast300"

        /** Human-readable device name shown in status. */
        const val DEVICE = "Access AST300"

        /** Broadcast action for the USB permission request PendingIntent. */
        private const val ACTION_USB_PERMISSION =
            "in.itfarmer.swachhsafar.fingerprint.USB_PERMISSION"

        // -----------------------------------------------------------------------------------------
        // Vendor SDK entry-point class name.
        //
        // Replace this constant with the actual fully-qualified class name from the ACPL
        // non-Aadhaar SDK once it is received from the vendor. The driver checks for this
        // class at runtime so the app compiles and runs without the SDK present.
        // -----------------------------------------------------------------------------------------
        private const val SDK_CLASS = "com.acpl.devicesdk.ACPLDeviceScanner"
    }

    override val matcherId: String = MATCHER
    override val deviceName: String = DEVICE

    private val usbManager: UsbManager =
        context.getSystemService(Context.USB_SERVICE) as UsbManager

    // =============================================================================================
    // USB device detection (works without the vendor SDK)
    // =============================================================================================

    /** Find the first attached ACPL scanner by vendor ID, or `null`. */
    private fun findDevice(): UsbDevice? =
        usbManager.deviceList.values.firstOrNull { it.vendorId == VENDOR_ID }

    override fun isConnected(): Boolean = findDevice() != null && sdkAvailable()

    override fun disconnectReason(): String? {
        if (findDevice() == null) return "disconnected"
        if (!sdkAvailable()) return "sdk_not_installed"
        return null
    }

    // =============================================================================================
    // USB permission — synchronous wait on a background thread
    // =============================================================================================

    /**
     * Request USB host permission for [device] and block until the user responds or [timeoutMs]
     * elapses. Must be called from a background thread (the plugin executor ensures this).
     */
    private fun ensureUsbPermission(device: UsbDevice, timeoutMs: Long): Boolean {
        if (usbManager.hasPermission(device)) return true

        val granted = AtomicBoolean(false)
        val latch = CountDownLatch(1)

        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                if (intent.action == ACTION_USB_PERMISSION) {
                    granted.set(
                        intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    )
                    latch.countDown()
                }
            }
        }

        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT

        val pendingIntent = PendingIntent.getBroadcast(
            context, 0, Intent(ACTION_USB_PERMISSION), flags
        )

        val filter = IntentFilter(ACTION_USB_PERMISSION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(receiver, filter)
        }

        try {
            usbManager.requestPermission(device, pendingIntent)
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } finally {
            try {
                context.unregisterReceiver(receiver)
            } catch (_: Exception) {
                // Already unregistered or never registered — harmless.
            }
        }

        return granted.get()
    }

    // =============================================================================================
    // SDK availability
    // =============================================================================================

    /** `true` when the vendor SDK class is on the classpath (the .aar / .jar is in `app/libs`). */
    private fun sdkAvailable(): Boolean = try {
        Class.forName(SDK_CLASS)
        true
    } catch (_: ClassNotFoundException) {
        false
    }

    // =============================================================================================
    // Capture
    // =============================================================================================

    override fun capture(timeoutMs: Long): CaptureResult {
        val device = findDevice()
            ?: throw CaptureException("no_scanner", "No fingerprint scanner is connected.")

        if (!ensureUsbPermission(device, minOf(timeoutMs, 10_000L))) {
            throw CaptureException(
                "permission", "Permission to use the fingerprint scanner was refused."
            )
        }

        if (!sdkAvailable()) {
            throw CaptureException(
                "no_scanner",
                "Scanner hardware detected but the ACPL SDK is not installed. " +
                    "Place the vendor .aar in android/app/libs and rebuild."
            )
        }

        return captureWithSdk(device, timeoutMs)
    }

    /**
     * **Vendor SDK integration point — capture.**
     *
     * Replace the body of this method with calls to the ACPL non-Aadhaar SDK's capture API
     * once the `.aar` is received from Access Computech. The SDK must return an ISO 19794-2
     * minutiae template — **never a fingerprint image**.
     *
     * Example (pseudo-code — adapt to the actual ACPL API):
     * ```kotlin
     * val scanner = ACPLDeviceScanner.getInstance(context)
     * val conn = usbManager.openDevice(device)
     * scanner.init(conn)
     * try {
     *     val result = scanner.captureISOTemplate(timeoutMs.toInt())
     *     if (result == null || result.quality < MIN_QUALITY) {
     *         throw CaptureException("poor_quality", "Scan quality too low.")
     *     }
     *     return CaptureResult(
     *         template = Base64.encodeToString(result.isoTemplate, Base64.NO_WRAP),
     *         quality  = result.quality,
     *     )
     * } finally {
     *     scanner.release()
     *     conn.close()
     * }
     * ```
     *
     * Map SDK errors to [CaptureException] codes:
     * | SDK situation                | Code             |
     * |-----------------------------|------------------|
     * | No finger placed in time    | `"timeout"`      |
     * | Quality below SDK threshold | `"poor_quality"` |
     * | User cancelled the dialog   | `"cancelled"`    |
     * | USB communication failure   | `"no_scanner"`   |
     */
    private fun captureWithSdk(device: UsbDevice, timeoutMs: Long): CaptureResult {
        // ──────────────────────────────────────────────────────────────────────────────────────────
        // TODO: Replace this block with actual ACPL SDK capture calls.
        //
        // The SDK class is confirmed on the classpath (checked by the caller). Open the USB
        // device, capture a minutiae template (NOT an image), and return it Base64-encoded.
        // ──────────────────────────────────────────────────────────────────────────────────────────
        Log.w(TAG, "captureWithSdk: SDK integration not yet implemented")
        throw CaptureException(
            "no_scanner",
            "ACPL SDK integration pending. See AcplAst300Driver.captureWithSdk()."
        )
    }

    // =============================================================================================
    // Match
    // =============================================================================================

    override fun match(probe: ByteArray, candidates: List<CandidateTemplate>): MatchResult {
        if (!sdkAvailable()) {
            throw IllegalStateException(
                "ACPL SDK not installed. Place the vendor .aar in android/app/libs and rebuild."
            )
        }
        return matchWithSdk(probe, candidates)
    }

    /**
     * **Vendor SDK integration point — match.**
     *
     * Replace the body of this method with calls to the ACPL non-Aadhaar SDK's matcher API
     * once the `.aar` is received from Access Computech.
     *
     * Iterate over [candidates], decode each Base64 template, and compare against the [probe]
     * using the SDK matcher. Return the highest score and which finger produced it.
     *
     * Example (pseudo-code):
     * ```kotlin
     * val matcher = ACPLMatcher.getInstance()
     * var bestScore = 0.0
     * var bestFinger: String? = null
     *
     * for (candidate in candidates) {
     *     val enrolled = Base64.decode(candidate.template, Base64.DEFAULT)
     *     val score = matcher.matchISO(probe, enrolled).toDouble()
     *     if (score > bestScore) {
     *         bestScore = score
     *         bestFinger = candidate.finger
     *     }
     * }
     *
     * return MatchResult(score = bestScore, finger = bestFinger, matcher = matcherId)
     * ```
     *
     * The score is the SDK's own value on its own scale. It is stored as-is in the attendance
     * record and compared against the division's configured `fingerprint_match_score` threshold.
     */
    private fun matchWithSdk(probe: ByteArray, candidates: List<CandidateTemplate>): MatchResult {
        // ──────────────────────────────────────────────────────────────────────────────────────────
        // TODO: Replace this block with actual ACPL SDK match calls.
        //
        // Iterate over candidates, decode each Base64 template to raw bytes, and use the SDK's
        // matcher to compare against the probe bytes. Return the highest-scoring result.
        // ──────────────────────────────────────────────────────────────────────────────────────────
        Log.w(TAG, "matchWithSdk: SDK integration not yet implemented")
        throw IllegalStateException(
            "ACPL SDK matching pending. See AcplAst300Driver.matchWithSdk()."
        )
    }

    // =============================================================================================
    // Lifecycle
    // =============================================================================================

    override fun release() {
        // Release any SDK handles here when the vendor integration is complete.
        Log.d(TAG, "Driver released")
    }
}

