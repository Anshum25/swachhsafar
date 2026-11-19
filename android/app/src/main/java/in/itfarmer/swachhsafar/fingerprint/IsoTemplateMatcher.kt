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

    /**
     * The standard record layouts: where the header declares the image size, and where the 4-byte finger
     * view header (whose last byte is the minutiae count) sits.
     *
     *  - ISO/IEC 19794-2:2005: 4-byte record length; size at 14/16, resolution at 18/20, view header at 24.
     *  - ANSI/INCITS 378-2004: 2-byte record length + 4-byte CBEFF id; size at 16/18, view header at 26.
     *  - ANSI/INCITS 378-2004 with the 6-byte long-record length: everything 4 bytes later.
     *
     * An earlier version read the image size from 18/20 for every dialect. In an ISO 2005 record that is
     * the *resolution* (about 197 pixels/cm), so every real minutia beyond 197 px was taken as lying
     * outside the image, the record was discarded, and every comparison reported no minutiae at all --
     * "registered in a form this scanner cannot read", for every employee, however often re-registered.
     */
    private val STANDARD_LAYOUTS = listOf(
        14 to 24, // ISO 19794-2:2005
        16 to 26, // ANSI 378-2004
        20 to 30, // ANSI 378-2004, long record length
    )

    /** Vendor variants that do not follow a standard header. No size is trusted from these. */
    private val FALLBACK_VIEW_HEADERS = intArrayOf(28, 32, 34)

    /** Minutiae coordinates are 14-bit, and no sensor is anywhere near this wide. */
    private const val MAX_COORD = 16_383

    /** A record with a header and one minutia cannot be shorter than this. */
    private const val MIN_RECORD_BYTES = 30

    data class Minutia(
        val x: Double,
        val y: Double,
        val theta: Double, // in radians
        val type: Int,
        val quality: Int,
    )

    /**
     * Parses a finger minutiae record into its minutiae, or returns none when the bytes are not one.
     *
     * The record begins "FMR", and somewhere after that comes a 4-byte finger view header whose last
     * byte is the number of minutiae, followed by 6 bytes per minutia (type + x, reserved + y, angle,
     * quality). Where exactly depends on the dialect ([STANDARD_LAYOUTS], plus ISO 19794-2:2011), and
     * this app does not get to choose which one the scanner's SDK emits.
     *
     * So the block is located rather than assumed. An earlier version assumed offset 28 and read the
     * count from byte 27 -- the reserved byte, which is zero -- so every template parsed to no minutiae
     * at all and every comparison scored 0.
     */
    fun parseIso19794(bytes: ByteArray): List<Minutia> {
        if (bytes.size < MIN_RECORD_BYTES) return emptyList()
        // "FMR". Without it these are not finger minutiae bytes, and nothing read out of them would mean
        // what it means in a real record.
        if (bytes[0].toInt() != 0x46 || bytes[1].toInt() != 0x4D || bytes[2].toInt() != 0x52) return emptyList()

        // ISO/IEC 19794-2:2011 ("030") has a different header altogether; it is recognised by its version.
        if (bytes[4].toInt() == 0x30 && bytes[5].toInt() == 0x33 && bytes[6].toInt() == 0x30) {
            parse2011(bytes)?.let { return it.sortedByDescending { m -> m.quality } }
        }

        // Each standard layout with the size its own header declares, then the vendor variants with no
        // size trusted at all. An exact fit -- the minutiae ending the record, bar the 2-byte extended
        // data length -- is the layout this record is actually in; anything else is only a candidate.
        var best: List<Minutia> = emptyList()
        val attempts = STANDARD_LAYOUTS.map { (sizeAt, view) -> Triple(view, read16(bytes, sizeAt), read16(bytes, sizeAt + 2)) } +
            FALLBACK_VIEW_HEADERS.map { Triple(it, -1, -1) }
        for ((viewHeader, w, h) in attempts) {
            val (minutiae, fits) = tryView(bytes, viewHeader, w, h) ?: continue
            if (fits) return minutiae.sortedByDescending { it.quality }
            if (minutiae.size > best.size) best = minutiae
        }
        // Strongest first: those are the ones used as alignment anchors.
        return best.sortedByDescending { it.quality }
    }

    /** The minutiae under the view header at [viewHeader], and whether they end the record exactly. */
    private fun tryView(bytes: ByteArray, viewHeader: Int, declaredW: Int, declaredH: Int): Pair<List<Minutia>, Boolean>? {
        val countAt = viewHeader + 3
        val start = viewHeader + 4
        if (start >= bytes.size) return null
        val count = bytes[countAt].toInt() and 0xFF
        if (count < 1) return null
        val end = start + count * 6
        if (end > bytes.size) return null
        val minutiae = readMinutiae(bytes, start, count, 6)
        if (!plausible(minutiae, count, declaredW, declaredH)) return null
        return minutiae to (bytes.size - end in 0..2)
    }

    /**
     * ISO/IEC 19794-2:2011: a 15-byte general header, then a representation header of variable length
     * (quality blocks, optional certification blocks) before the finger's own fields, and minutiae of 5
     * or 6 bytes as the record declares.
     */
    private fun parse2011(bytes: ByteArray): List<Minutia>? {
        if (bytes.size < 15 + 20) return null
        val certified = bytes[14].toInt() != 0
        var i = 15 + 4 + 9 + 1 + 2 + 2 // representation length, capture time, technology, vendor, device type
        if (i >= bytes.size) return null
        i += 1 + (bytes[i].toInt() and 0xFF) * 5 // quality blocks
        if (certified) {
            if (i >= bytes.size) return null
            i += 1 + (bytes[i].toInt() and 0xFF) * 3 // certification blocks
        }
        i += 1 + 1 + 2 + 2 + 1 // finger position, representation number, sampling rates, impression type
        val w = read16(bytes, i)
        val h = read16(bytes, i + 2)
        i += 4
        if (i + 1 >= bytes.size) return null
        val fieldByte = bytes[i].toInt() and 0xFF
        val stride = listOf(fieldByte shr 4, fieldByte and 0x0F).firstOrNull { it == 5 || it == 6 } ?: 6
        val count = bytes[i + 1].toInt() and 0xFF
        val start = i + 2
        if (count < 1 || start + count * stride > bytes.size) return null
        val minutiae = readMinutiae(bytes, start, count, stride)
        return if (plausible(minutiae, count, w, h)) minutiae else null
    }

    /** Every point inside the image the header describes (when it describes one), and not all the same
     *  point: both are what a layout read at the wrong offset looks like. */
    private fun plausible(minutiae: List<Minutia>, count: Int, declaredW: Int, declaredH: Int): Boolean {
        if (minutiae.size != count) return false
        val maxX = if (declaredW in 1..MAX_COORD) declaredW else MAX_COORD
        val maxY = if (declaredH in 1..MAX_COORD) declaredH else MAX_COORD
        if (minutiae.any { it.x > maxX || it.y > maxY }) return false
        return minutiae.distinctBy { it.x to it.y }.size >= (count + 1) / 2
    }

    private fun read16(bytes: ByteArray, at: Int): Int =
        if (at + 1 < bytes.size) ((bytes[at].toInt() and 0xFF) shl 8) or (bytes[at + 1].toInt() and 0xFF) else -1

    private fun readMinutiae(bytes: ByteArray, start: Int, count: Int, stride: Int): List<Minutia> {
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        buf.position(start)
        val minutiae = ArrayList<Minutia>(count)
        for (i in 0 until count) {
            if (buf.remaining() < stride) break
            val word1 = buf.short.toInt() and 0xFFFF
            val word2 = buf.short.toInt() and 0xFFFF
            val angleByte = buf.get().toInt() and 0xFF
            val qualityByte = if (stride >= 6) buf.get().toInt() and 0xFF else 0

            val type = (word1 shr 14) and 0x03
            val x = (word1 and 0x3FFF).toDouble()
            val y = (word2 and 0x3FFF).toDouble()
            val theta = (angleByte.toDouble() / 256.0) * (2.0 * Math.PI)
            minutiae.add(Minutia(x, y, theta, type, qualityByte))
        }
        return minutiae
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
