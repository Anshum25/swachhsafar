// Kotlin reserves `in`, so the first segment of the package name has to be written escaped.
package `in`.itfarmer.swachhsafar.fingerprint

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

/**
 * What this matcher has to get right is the difference between two people.
 *
 * An earlier version scored `matched / average_count * 150` with a 20-pixel, 25-degree tolerance and no
 * floor on how few points could be called a match. A colleague's finger was accepted for someone else's
 * attendance. These tests hold the line that was put in afterwards: a point counts only when it lands
 * where the alignment says it should, and fewer than twelve of them is not a match at any score.
 */
class IsoTemplateMatcherTest {

    private enum class Dialect { ISO_2005, ANSI_378, ISO_2011, VENDOR_28, VENDOR_32 }

    private fun put16(out: ByteArray, at: Int, v: Int) { out[at] = (v shr 8).toByte(); out[at + 1] = v.toByte() }

    private fun putMinutiae(out: ByteArray, at: Int, minutiae: List<Triple<Int, Int, Double>>, stride: Int,
                            angleSteps: Int = 256) {
        var i = at
        for ((x, y, angle) in minutiae) {
            val turns = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI)
            val a = (turns * angleSteps).toInt() % angleSteps
            out[i++] = ((x shr 8) and 0x3F).toByte(); out[i++] = (x and 0xFF).toByte()
            out[i++] = ((y shr 8) and 0x3F).toByte(); out[i++] = (y and 0xFF).toByte()
            out[i++] = a.toByte()
            if (stride == 6) out[i++] = 80.toByte()
        }
    }

    /**
     * Builds a finger minutiae record byte for byte as the standard lays it out -- in particular with the
     * scanner's resolution (197 px/cm, i.e. 500 dpi) where it really is. An earlier version of these tests
     * put the image size where the resolution goes, the same mistake the parser made, so they proved only
     * that the two agreed with each other while every real template parsed to nothing.
     */
    private fun template(minutiae: List<Triple<Int, Int, Double>>, dialect: Dialect = Dialect.ISO_2005): ByteArray {
        val n = minutiae.size
        fun magic(out: ByteArray, version: String) {
            out[0] = 0x46; out[1] = 0x4D; out[2] = 0x52; out[3] = 0x00                // "FMR\0"
            version.forEachIndexed { k, c -> out[4 + k] = c.code.toByte() }
        }
        fun view(out: ByteArray, at: Int) { out[at] = 1; out[at + 1] = 0; out[at + 2] = 60; out[at + 3] = n.toByte() }
        return when (dialect) {
            Dialect.ISO_2005 -> ByteArray(24 + 4 + n * 6 + 2).also { out ->
                magic(out, " 20\u0000")
                put16(out, 10, out.size)                                                  // record length (4 bytes at 8)
                put16(out, 14, 1000); put16(out, 16, 1000)                                // image size
                put16(out, 18, 197); put16(out, 20, 197)                                  // resolution, px/cm
                out[22] = 1                                                               // one finger view
                view(out, 24); putMinutiae(out, 28, minutiae, 6)
            }
            Dialect.ANSI_378 -> ByteArray(26 + 4 + n * 6 + 2).also { out ->
                magic(out, " 20\u0000")
                put16(out, 8, out.size)                                                   // record length (2 bytes)
                put16(out, 16, 1000); put16(out, 18, 1000)                                // image size
                put16(out, 20, 197); put16(out, 22, 197)                                  // resolution
                out[24] = 1
                view(out, 26); putMinutiae(out, 30, minutiae, 6, angleSteps = 180) // ANSI: 2-degree units
            }
            Dialect.ISO_2011 -> ByteArray(52 + n * 6).also { out ->
                magic(out, "030\u0000")
                put16(out, 12, 1)                                                         // one representation
                out[33] = 1                                                               // one quality block (34..38)
                out[39] = 1                                                               // finger position
                put16(out, 41, 197); put16(out, 43, 197)                                  // sampling rates
                put16(out, 46, 1000); put16(out, 48, 1000)                                // image size
                out[50] = 0x61                                                            // 6-byte minutiae
                out[51] = n.toByte()
                putMinutiae(out, 52, minutiae, 6)
            }
            Dialect.VENDOR_28, Dialect.VENDOR_32 -> {
                val vh = if (dialect == Dialect.VENDOR_28) 28 else 32
                ByteArray(vh + 4 + n * 6 + 2).also { out ->
                    magic(out, " 20\u0000")
                    view(out, vh); putMinutiae(out, vh + 4, minutiae, 6)
                }
            }
        }
    }

    private fun randomFinger(seed: Int, count: Int = 32): List<Triple<Int, Int, Double>> {
        val rnd = Random(seed)
        return (0 until count).map {
            Triple(rnd.nextInt(40, 460), rnd.nextInt(40, 460), rnd.nextDouble(0.0, 2 * Math.PI))
        }
    }

    /**
     * The same finger pressed again, turned [rotation] radians counter-clockwise as seen on screen, moved,
     * with a few points lost -- written the way a real scanner writes it: Y grows DOWN, angles count
     * counter-clockwise. An earlier version rotated with Y growing up, the same mistake the matcher made,
     * so a matcher that turned real presses the wrong way passed every test and scored 0 on the device.
     */
    private fun pressedAgain(points: List<Triple<Int, Int, Double>>, rotation: Double, dx: Int, dy: Int,
                             keep: Int, seed: Int): List<Triple<Int, Int, Double>> {
        val rnd = Random(seed)
        val cosR = cos(rotation)
        val sinR = sin(rotation)
        return points.take(keep).map { (x, y, a) ->
            val nx = (x * cosR + y * sinR).toInt() + dx + rnd.nextInt(-2, 3)
            val ny = (-x * sinR + y * cosR).toInt() + dy + rnd.nextInt(-2, 3)
            Triple(nx.coerceIn(1, 4000), ny.coerceIn(1, 4000), (a + rotation) % (2 * Math.PI))
        }
    }

    @Test
    fun `the same finger pressed again matches well above the default threshold`() {
        val enrolled = randomFinger(seed = 7)
        val again = pressedAgain(enrolled, rotation = 0.20, dx = 25, dy = -15, keep = 26, seed = 11)
        val score = IsoTemplateMatcher.match(template(again), template(enrolled))
        assertTrue("a genuine press scored only $score", score >= 40.0)
    }

    @Test
    fun `a different person's finger does not reach the threshold`() {
        // Many pairs, because one lucky pair proves nothing either way.
        var worst = 0.0
        for (seed in 1..40) {
            val mine = template(randomFinger(seed))
            val theirs = template(randomFinger(seed + 500))
            val score = IsoTemplateMatcher.match(theirs, mine)
            if (score > worst) worst = score
        }
        assertTrue("another finger scored $worst, at or above the 40 that would admit them", worst < 40.0)
    }

    @Test
    fun `too few matching points is no match at all, whatever the proportion`() {
        // Two tiny prints that happen to share most of their points still fall under the forensic floor.
        val few = listOf(Triple(100, 100, 0.0), Triple(150, 160, 1.0), Triple(200, 210, 2.0))
        assertEquals(0.0, IsoTemplateMatcher.match(template(few), template(few + Triple(300, 310, 3.0))), 0.001)
    }

    @Test
    fun `bytes that are not an ISO record are refused rather than guessed at`() {
        val notATemplate = ByteArray(240) { (it * 7).toByte() }
        val alsoNot = ByteArray(240) { (it * 11).toByte() }
        assertEquals(0.0, IsoTemplateMatcher.match(notATemplate, alsoNot), 0.001)
        assertTrue(IsoTemplateMatcher.parseIso19794(notATemplate).isEmpty())
    }

    // The failure this was found by: every comparison scored 0, for every pair of people, because the
    // count was read from the reserved byte -- always zero -- and the record parsed to no minutiae at all.
    @Test
    fun `the minutiae are found in every dialect the scanner may emit`() {
        for (dialect in Dialect.values()) {
            val points = randomFinger(seed = 5)
            val parsed = IsoTemplateMatcher.parseIso19794(template(points, dialect))
            assertEquals("$dialect", points.size, parsed.size)
        }
    }

    // The failure seen on phones: "registered in a form this scanner cannot read" for everyone. An ISO
    // 2005 record carries its resolution (197 px/cm) where the parser looked for the image size, so every
    // minutia beyond 197 px was "outside the image" and the record parsed to nothing.
    @Test
    fun `minutiae beyond the resolution value are not mistaken for points outside the image`() {
        val points = randomFinger(seed = 8).map { (x, y, a) -> Triple(x + 250, y + 250, a) }
        assertTrue(points.all { it.first > 197 })
        assertEquals("every minutia read", points.size, IsoTemplateMatcher.parseIso19794(template(points)).size)
        val again = pressedAgain(points, rotation = 0.1, dx = 10, dy = 5, keep = 28, seed = 3)
        assertTrue(IsoTemplateMatcher.match(template(again), template(points)) >= 40.0)
    }

    @Test
    fun `a record whose minutiae were never read scores nothing rather than guessing`() {
        // "FMR", and nothing after it that is a finger view: not a template this matcher can use.
        val empty = ByteArray(64).also { it[0] = 0x46; it[1] = 0x4D; it[2] = 0x52 }
        assertTrue(IsoTemplateMatcher.parseIso19794(empty).isEmpty())
        assertEquals(0.0, IsoTemplateMatcher.match(empty, template(randomFinger(1))), 0.001)
    }

    @Test
    fun `the same finger still matches when the two records are in different dialects`() {
        val enrolled = randomFinger(seed = 9)
        val again = pressedAgain(enrolled, rotation = 0.15, dx = 12, dy = -8, keep = 27, seed = 13)
        val score = IsoTemplateMatcher.match(template(again, Dialect.ANSI_378), template(enrolled, Dialect.ISO_2005))
        assertTrue("a genuine press across dialects scored only $score", score >= 40.0)
    }

    // The failure seen on the AST300: a genuine press scored 0. Larger twists than a person usually makes,
    // both ways, in both standard dialects.
    @Test
    fun `a genuine press turned either way matches, as the scanner records it`() {
        val enrolled = randomFinger(seed = 31).map { (x, y, a) -> Triple(x + 200, y + 200, a) }
        for (dialect in listOf(Dialect.ISO_2005, Dialect.ANSI_378)) {
            for (deg in listOf(-25.0, -10.0, 5.0, 15.0, 25.0)) {
                val again = pressedAgain(enrolled, Math.toRadians(deg), dx = 20, dy = -12, keep = 24, seed = 41)
                val score = IsoTemplateMatcher.match(template(again, dialect), template(enrolled, dialect))
                assertTrue("$dialect, turned $deg degrees, scored only $score", score >= 40.0)
            }
        }
    }

    @Test
    fun `an identical capture is a perfect score`() {
        val t = template(randomFinger(3))
        assertEquals(100.0, IsoTemplateMatcher.match(t, t), 0.001)
    }

    @Test
    fun `a score is a percentage, never more`() {
        val enrolled = randomFinger(seed = 21)
        val again = pressedAgain(enrolled, rotation = 0.05, dx = 3, dy = 3, keep = 30, seed = 22)
        val score = IsoTemplateMatcher.match(template(again), template(enrolled))
        assertTrue("score $score is outside 0-100", score in 0.0..100.0)
    }
}
