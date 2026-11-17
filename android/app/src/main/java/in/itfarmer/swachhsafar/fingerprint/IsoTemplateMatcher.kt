// Kotlin reserves `in`, so the first segment of the package name (in.itfarmer.swachhsafar) has to be
// written escaped. The compiled package is the plain one the manifest and Capacitor expect.
package `in`.itfarmer.swachhsafar.fingerprint

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.sin

/**
 * In-memory matcher for ISO/IEC 19794-2 fingerprint minutiae templates.
 *
 * Compares two ISO 19794-2 templates offline on the device without requiring
 * external server round-trips or proprietary SDK dependencies.
 */
object IsoTemplateMatcher {

    data class Minutia(
        val x: Int,
        val y: Int,
        val theta: Double, // in radians
        val type: Int,
        val quality: Int,
    )

    /**
     * Parses an ISO 19794-2 (2005 or compact) template into a list of Minutiae.
     */
    fun parseIso19794(bytes: ByteArray): List<Minutia> {
        if (bytes.size < 28) return emptyList()

        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)

        // Check for 'FMR\0' or 'FMR ' magic header
        val b0 = buf.get().toInt() and 0xFF
        val b1 = buf.get().toInt() and 0xFF
        val b2 = buf.get().toInt() and 0xFF
        val b3 = buf.get().toInt() and 0xFF

        var minutiaeStart = -1
        var count = 0

        if (b0 == 0x46 && b1 == 0x4D && b2 == 0x52) { // "FMR"
            // Standard ISO 19794-2:2005 format
            // Header is 24 bytes, followed by finger view header (4 bytes)
            // Minutiae count is at byte 27
            if (bytes.size >= 28) {
                count = bytes[27].toInt() and 0xFF
                minutiaeStart = 28
            }
        } else {
            // Raw minutiae block or proprietary wrapped minutiae: search for plausible minutiae count
            // Typically preceded by count byte
            count = min(bytes.size / 6, 128)
            minutiaeStart = 0
        }

        if (minutiaeStart < 0 || minutiaeStart + count * 6 > bytes.size) {
            count = min((bytes.size - maxOf(0, minutiaeStart)) / 6, 128)
        }

        val minutiae = ArrayList<Minutia>(count)
        buf.position(minutiaeStart)

        for (i in 0 until count) {
            if (buf.remaining() < 6) break

            val word1 = buf.short.toInt() and 0xFFFF
            val word2 = buf.short.toInt() and 0xFFFF
            val angleByte = buf.get().toInt() and 0xFF
            val qualityByte = buf.get().toInt() and 0xFF

            val type = (word1 shr 14) and 0x03
            val x = word1 and 0x3FFF
            val y = word2 and 0x3FFF
            val theta = (angleByte.toDouble() / 256.0) * 2.0 * Math.PI

            minutiae.add(Minutia(x, y, theta, type, qualityByte))
        }

        return minutiae
    }

    /**
     * Matches a probe template against an enrolled candidate template.
     * Returns a score from 0.0 to 100.0.
     */
    fun match(probeBytes: ByteArray, candidateBytes: ByteArray): Double {
        if (probeBytes.isEmpty() || candidateBytes.isEmpty()) return 0.0

        // Exact binary match (identical capture)
        if (probeBytes.contentEquals(candidateBytes)) return 100.0

        val probe = parseIso19794(probeBytes)
        val candidate = parseIso19794(candidateBytes)

        if (probe.isEmpty() || candidate.isEmpty()) return 0.0

        val distTolerance = 20.0
        val angleTolerance = Math.toRadians(30.0)

        var maxMatched = 0

        // Select candidate reference pairs (sample up to 10 candidate minutiae with high quality)
        val sampleSizeProbe = minOf(probe.size, 12)
        val sampleSizeCandidate = minOf(candidate.size, 12)

        for (pRefIdx in 0 until sampleSizeProbe) {
            val pRef = probe[pRefIdx]

            for (cRefIdx in 0 until sampleSizeCandidate) {
                val cRef = candidate[cRefIdx]

                // Rotation angle
                val dTheta = normalizeAngle(pRef.theta - cRef.theta)
                val cosTheta = cos(dTheta)
                val sinTheta = sin(dTheta)

                var matchedCount = 0
                val usedCandidates = BooleanArray(candidate.size)

                for (p in probe) {
                    // Translate relative to probe reference
                    val dx = (p.x - pRef.x).toDouble()
                    val dy = (p.y - pRef.y).toDouble()

                    // Rotate into candidate coordinate system
                    val rotX = dx * cosTheta - dy * sinTheta + cRef.x
                    val rotY = dx * sinTheta + dy * cosTheta + cRef.y
                    val rotTheta = normalizeAngle(p.theta - dTheta)

                    var bestMatchIdx = -1
                    var bestDist = Double.MAX_VALUE

                    for (cIdx in candidate.indices) {
                        if (usedCandidates[cIdx]) continue
                        val c = candidate[cIdx]

                        val dist = hypot(rotX - c.x, rotY - c.y)
                        if (dist <= distTolerance) {
                            val angleDiff = abs(normalizeAngle(rotTheta - c.theta))
                            if (angleDiff <= angleTolerance && dist < bestDist) {
                                bestDist = dist
                                bestMatchIdx = cIdx
                            }
                        }
                    }

                    if (bestMatchIdx != -1) {
                        usedCandidates[bestMatchIdx] = true
                        matchedCount++
                    }
                }

                if (matchedCount > maxMatched) {
                    maxMatched = matchedCount
                }
            }
        }

        val totalMinutiae = (probe.size + candidate.size).toDouble() / 2.0
        if (totalMinutiae <= 0.0) return 0.0

        // Score based on proportion of matched minutiae
        val matchRatio = maxMatched.toDouble() / totalMinutiae
        val score = minOf(100.0, matchRatio * 140.0)
        return kotlin.math.round(score * 10.0) / 10.0
    }

    private fun normalizeAngle(angle: Double): Double {
        var a = angle
        while (a > Math.PI) a -= 2.0 * Math.PI
        while (a < -Math.PI) a += 2.0 * Math.PI
        return a
    }
}

