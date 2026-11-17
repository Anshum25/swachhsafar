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

    /**
     * Builds a finger minutiae record the way a scanner's SDK does.
     *
     * `viewHeader` is where the 4-byte finger view header sits: 28 is ISO/IEC 19794-2:2005, and the other
     * values are dialects of the same record that vendors ship. The minutiae count is the LAST byte of
     * that header, not the reserved byte before it -- an earlier version of these tests built the record
     * with the same mistake the parser made, so they proved only that the two agreed with each other.
     */
    private fun template(minutiae: List<Triple<Int, Int, Double>>, viewHeader: Int = 28): ByteArray {
        val out = ByteArray(viewHeader + 4 + minutiae.size * 6 + 2)
        out[0] = 0x46; out[1] = 0x4D; out[2] = 0x52; out[3] = 0x00  // "FMR\0"
        out[4] = 0x32; out[5] = 0x30; out[6] = 0x00                 // version "20"
        out[18] = 0x02; out[19] = 0x00                              // image size X = 512
        out[20] = 0x02; out[21] = 0x00                              // image size Y = 512
        out[26] = 1                                                 // one finger view
        out[viewHeader] = 1                                         // finger position
        out[viewHeader + 1] = 0                                     // view number / impression type
        out[viewHeader + 2] = 60                                    // finger quality
        out[viewHeader + 3] = minutiae.size.toByte()                // number of minutiae
        var i = viewHeader + 4
        for ((x, y, angle) in minutiae) {
            val a = ((angle / (2 * Math.PI)) * 256).toInt() and 0xFF
            out[i++] = ((x shr 8) and 0x3F).toByte(); out[i++] = (x and 0xFF).toByte()
            out[i++] = ((y shr 8) and 0x3F).toByte(); out[i++] = (y and 0xFF).toByte()
            out[i++] = a.toByte()
            out[i++] = 80.toByte()
        }
        return out
    }

    private fun randomFinger(seed: Int, count: Int = 32): List<Triple<Int, Int, Double>> {
        val rnd = Random(seed)
        return (0 until count).map {
            Triple(rnd.nextInt(40, 460), rnd.nextInt(40, 460), rnd.nextDouble(0.0, 2 * Math.PI))
        }
    }

    /** The same finger, pressed at a different angle and position, with a few points missing or added. */
    private fun pressedAgain(points: List<Triple<Int, Int, Double>>, rotation: Double, dx: Int, dy: Int,
                             keep: Int, seed: Int): List<Triple<Int, Int, Double>> {
        val rnd = Random(seed)
        val cosR = cos(rotation)
        val sinR = sin(rotation)
        return points.take(keep).map { (x, y, a) ->
            val nx = (x * cosR - y * sinR).toInt() + dx + rnd.nextInt(-2, 3)
            val ny = (x * sinR + y * cosR).toInt() + dy + rnd.nextInt(-2, 3)
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
    fun `the minutiae are found, not assumed to start at one fixed offset`() {
        for (viewHeader in listOf(28, 26, 30, 32)) {
            val points = randomFinger(seed = 5)
            val parsed = IsoTemplateMatcher.parseIso19794(template(points, viewHeader))
            assertEquals("view header at $viewHeader", points.size, parsed.size)
        }
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
        val score = IsoTemplateMatcher.match(template(again, 26), template(enrolled, 28))
        assertTrue("a genuine press across dialects scored only $score", score >= 40.0)
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
