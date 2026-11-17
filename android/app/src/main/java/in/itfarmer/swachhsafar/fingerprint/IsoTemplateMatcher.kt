// Kotlin reserves `in`, so the first segment of the package name (in.itfarmer.swachhsafar) has to be
// written escaped. The compiled package is the plain one the manifest and Capacitor expect.
package `in`.itfarmer.swachhsafar.fingerprint

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * Matcher for ISO/IEC 19794-2 minutiae templates.
 *
 * What this has to get right is not speed but the difference between two people. Comparing fingerprints
 * means counting minutiae -- ridge endings and bifurcations -- that line up once one print is rotated
 * onto the other. Two different fingers always line up somewhat: the looser the tolerance and the fewer
 * the points demanded, the more of other people's fingers are accepted as yours. So this matcher:
 *
 * - demands a real ISO record. Bytes that are not one are refused rather than guessed at: minutiae
 *   invented from arbitrary bytes line up with other invented minutiae about as readily as a finger does
 *   with itself.
 * - accepts a point only within [DIST_TOLERANCE_PX] and [ANGLE_TOLERANCE_DEG] of where the alignment puts
 *   it, which is tight enough that an impostor's points mostly miss.
 * - scores nothing at all below [MIN_MATCHED_MINUTIAE] matched points, the long-standing forensic floor
 *   for calling two prints the same finger.
 * - scores the proportion of the smaller print that matched, 0-100, with no multiplier. A score then
 *   reads as the percentage it is, and a threshold means what the administrator setting it thinks.
 */
object IsoTemplateMatcher {

    /** How far a rotated probe minutia may sit from a candidate's and still be taken as the same point. */
    const val DIST_TOLERANCE_PX = 12.0

    /** How far its ridge direction may differ. */
    const val ANGLE_TOLERANCE_DEG = 15.0

    /** Fewer matched points than this is not evidence of anything, whatever proportion it works out to. */
    const val MIN_MATCHED_MINUTIAE = 12

    data class Minutia(
        val x: Double,
        val y: Double,
        val theta: Double, // in radians
        val type: Int,
        val quality: Int,
    )

    /**
     * Parses an ISO/IEC 19794-2 record into its minutiae, or returns none when the bytes are not one.
     *
     * Layout: a 24-byte record header beginning "FMR", then a 4-byte finger view header whose last byte
     * is the number of minutiae, then 6 bytes per minutia (type + x, reserved + y, angle, quality).
     */
    fun parseIso19794(bytes: ByteArray): List<Minutia> {
        if (bytes.size < 28) return emptyList()
        // "FMR". Without it these are not ISO 19794-2 bytes, and nothing read out of them would mean what
        // it means in a real record.
        if (bytes[0].toInt() != 0x46 || bytes[1].toInt() != 0x4D || bytes[2].toInt() != 0x52) return emptyList()

        var count = bytes[27].toInt() and 0xFF
        val minutiaeStart = 28
        if (minutiaeStart + count * 6 > bytes.size) {
            count = (bytes.size - minutiaeStart) / 6
        }
        if (count <= 0) return emptyList()

        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        buf.position(minutiaeStart)
        val minutiae = ArrayList<Minutia>(count)
        for (i in 0 until count) {
            if (buf.remaining() < 6) break
            val word1 = buf.short.toInt() and 0xFFFF
            val word2 = buf.short.toInt() and 0xFFFF
            val angleByte = buf.get().toInt() and 0xFF
            val qualityByte = buf.get().toInt() and 0xFF

            val type = (word1 shr 14) and 0x03
            val x = (word1 and 0x3FFF).toDouble()
            val y = (word2 and 0x3FFF).toDouble()
            val theta = (angleByte.toDouble() / 256.0) * (2.0 * Math.PI)
            minutiae.add(Minutia(x, y, theta, type, qualityByte))
        }
        // Strongest first: those are the ones used as alignment anchors.
        return minutiae.sortedByDescending { it.quality }
    }

    /**
     * Compares a probe with an enrolled candidate. Returns 0.0-100.0: the proportion of the smaller print
     * whose minutiae matched, or 0.0 when too few matched for the result to mean anything.
     */
    fun match(probeBytes: ByteArray, candidateBytes: ByteArray): Double {
        if (probeBytes.isEmpty() || candidateBytes.isEmpty()) return 0.0
        if (probeBytes.contentEquals(candidateBytes)) return 100.0

        val probe = parseIso19794(probeBytes)
        val candidate = parseIso19794(candidateBytes)
        if (probe.isEmpty() || candidate.isEmpty()) return 0.0

        val distToleranceSq = DIST_TOLERANCE_PX * DIST_TOLERANCE_PX
        val angleTolerance = Math.toRadians(ANGLE_TOLERANCE_DEG)
        // The smaller print is the ceiling: a partial press cannot be asked to match points it never
        // recorded, and dividing by the larger would punish it for the other print being fuller.
        val comparable = min(probe.size, candidate.size)
        if (comparable <= 0) return 0.0

        // Every pair of strong minutiae is tried as the alignment anchor, and the best alignment wins.
        val numAnchorsProbe = min(probe.size, 8)
        val numAnchorsCand = min(candidate.size, 8)
        var maxMatched = 0
        val usedCandidates = BooleanArray(candidate.size)

        outer@ for (pRefIdx in 0 until numAnchorsProbe) {
            val pRef = probe[pRefIdx]
            for (cRefIdx in 0 until numAnchorsCand) {
                val cRef = candidate[cRefIdx]
                val dTheta = normalizeAngle(pRef.theta - cRef.theta)
                val cosTheta = cos(dTheta)
                val sinTheta = sin(dTheta)

                usedCandidates.fill(false)
                var matchedCount = 0
                for (p in probe) {
                    val dx = p.x - pRef.x
                    val dy = p.y - pRef.y
                    // The probe is turned BACK by dTheta -- it is the one that was pressed at a
                    // different angle, so undoing that angle is what puts its points where the
                    // candidate's are. Turning it forward instead (rotating by +dTheta) scatters the
                    // points and leaves the count measuring coincidence rather than agreement, which is
                    // how a colleague's finger came to score as well as the right one.
                    val rotX = dx * cosTheta + dy * sinTheta + cRef.x
                    val rotY = -dx * sinTheta + dy * cosTheta + cRef.y
                    val rotTheta = normalizeAngle(p.theta - dTheta)

                    var bestMatchIdx = -1
                    var bestDistSq = Double.MAX_VALUE
                    for (cIdx in candidate.indices) {
                        if (usedCandidates[cIdx]) continue
                        val c = candidate[cIdx]
                        val dX = rotX - c.x
                        val dY = rotY - c.y
                        val dSq = dX * dX + dY * dY
                        if (dSq <= distToleranceSq && dSq < bestDistSq) {
                            if (abs(normalizeAngle(rotTheta - c.theta)) <= angleTolerance) {
                                bestDistSq = dSq
                                bestMatchIdx = cIdx
                            }
                        }
                    }
                    if (bestMatchIdx != -1) {
                        usedCandidates[bestMatchIdx] = true
                        matchedCount++
                    }
                }
                if (matchedCount > maxMatched) maxMatched = matchedCount
                // Nothing can beat matching the whole of the smaller print, so there is nothing left to try.
                if (maxMatched >= comparable) break@outer
            }
        }

        if (maxMatched < MIN_MATCHED_MINUTIAE) return 0.0
        val score = min(100.0, (maxMatched.toDouble() / comparable.toDouble()) * 100.0)
        return kotlin.math.round(score * 10.0) / 10.0
    }

    private fun normalizeAngle(angle: Double): Double {
        var a = angle
        while (a > Math.PI) a -= 2.0 * Math.PI
        while (a < -Math.PI) a += 2.0 * Math.PI
        return a
    }
}
