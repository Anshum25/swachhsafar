// Kotlin reserves `in`, so the first segment of the package name (in.itfarmer.swachhsafar) has to be
// written escaped. The compiled package is the plain one the manifest and Capacitor expect.
package `in`.itfarmer.swachhsafar.fingerprint

/**
 * Abstraction over a USB fingerprint scanner's vendor SDK.
 *
 * The Capacitor plugin ([SwachhFingerprintPlugin]) delegates to this interface; a concrete
 * implementation wraps the vendor's native library. When the vendor's non-Aadhaar SDK
 * (.aar / .jar) is placed in `android/app/libs`, it hooks into the concrete driver's
 * [capture] and [match] methods without touching the plugin.
 *
 * **Templates only.** No implementation may produce, store, or log a fingerprint image anywhere.
 * An image is what would let someone forge a finger; a minutiae template is far less useful to
 * a thief.
 */
interface FingerprintDriver {

    /** Unique identifier for this driver's scoring scale (e.g. `"acpl_ast300"`).
     *  Stored with every enrollment and match so scores are never read on the wrong scale. */
    val matcherId: String

    /** Human-readable device name (e.g. `"Access AST300"`). */
    val deviceName: String

    /** Whether the physical scanner is connected via USB and the driver is ready to operate. */
    fun isConnected(): Boolean

    /** Why the scanner is not connected, or `null` when it is. */
    fun disconnectReason(): String?

    /**
     * Capture a single fingerprint and return an ISO 19794-2 minutiae template.
     *
     * Never returns a fingerprint image — only the opaque template bytes encoded as Base64.
     *
     * @param timeoutMs maximum time to wait for a finger, in milliseconds.
     * @throws CaptureException on failure (the [CaptureException.code] maps to the JS error codes).
     */
    fun capture(timeoutMs: Long): CaptureResult

    /**
     * Compare a freshly captured [probe] template against a list of enrolled [candidates]
     * using the vendor's local matcher algorithm. The score is the SDK's own scale.
     *
     * @param probe raw bytes of the captured ISO 19794-2 template.
     * @param candidates the employee's enrolled finger templates.
     * @return the best match result; score is on the vendor's scale.
     */
    fun match(probe: ByteArray, candidates: List<CandidateTemplate>): MatchResult

    /** Release any SDK handles. Called when the plugin is destroyed. */
    fun release()
}

// -------------------------------------------------------------------------------------------------
// Data classes shared by every driver
// -------------------------------------------------------------------------------------------------

/** Successful capture result — a minutiae template, never an image. */
data class CaptureResult(
    /** Base64-encoded ISO 19794-2 minutiae template. */
    val template: String,
    /** Always `"iso-19794-2"`. */
    val format: String = "iso-19794-2",
    /** SDK-reported quality score, if available. */
    val quality: Int? = null,
)

/** One enrolled finger that the matcher will compare against. */
data class CandidateTemplate(
    /** Finger identifier (e.g. `"right_index"`, `"left_thumb"`). */
    val finger: String,
    /** Base64-encoded ISO 19794-2 minutiae template. */
    val template: String,
)

/** Best match result from the vendor's matcher. */
data class MatchResult(
    /** The vendor matcher's score on its own scale. */
    val score: Double,
    /** Which candidate finger was the best match, or `null` when no candidate scored. */
    val finger: String? = null,
    /** The matcher identifier — same as [FingerprintDriver.matcherId]. */
    val matcher: String,
)

/**
 * Capture failure, mapped to the error codes the JS layer expects:
 * `no_scanner`, `timeout`, `poor_quality`, `cancelled`, `permission`.
 */
class CaptureException(
    val code: String,
    message: String,
) : Exception(message)

