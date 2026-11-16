package dev.reeflight.k7

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.util.concurrent.TimeUnit

class DailySenderTest {
    private lateinit var light: FakeLight

    /** A SAVE frame like the app prepares: clock bytes left at 00:00:00. */
    private fun saveFrame(): ByteArray {
        val b = mutableListOf(0xAA, 0xA5, 0x10, 0x07, 50, 50, 50, 50, 50, 50, 0x18)
        for (h in 0 until 24) b.addAll(listOf(h, if (h == 9) 30 else 0, h, h, h, h, h, 0))
        b.addAll(listOf(1, 0, 0, 0, 0xBB))
        return ByteArray(b.size) { b[it].toByte() }
    }

    @Before fun setUp() { light = FakeLight() }
    @After fun tearDown() { light.close() }

    @Test
    fun theClockIsFilledInJustBeforeSending() {
        val f = DailySender.withTime(saveFrame(), 7, 8, 9)
        assertEquals(208, f.size)
        assertArrayEquals(byteArrayOf(7, 8, 9), f.copyOfRange(204, 207))
        assertEquals(0xBB.toByte(), f[207])
        assertArrayEquals(saveFrame().copyOfRange(0, 204), f.copyOfRange(0, 204))
    }

    @Test(expected = IllegalArgumentException::class)
    fun onlySaveFramesAreAccepted() {
        DailySender.withTime(ByteArray(10), 1, 2, 3)
    }

    @Test
    fun sendsClockThenDayAndConfirmsItByReadingBack() {
        val r = DailySender.send("127.0.0.1", light.port, saveFrame(), Triple(6, 30, 0))
        assertTrue(r.message, r.sent)
        assertTrue(r.message, r.confirmed)
        val first = light.received.poll(1, TimeUnit.SECONDS)!!
        assertArrayEquals(DailySender.syncTimeFrame(6, 30, 0), first)
        val second = light.received.poll(1, TimeUnit.SECONDS)!!
        assertArrayEquals(DailySender.withTime(saveFrame(), 6, 30, 0), second)
        val third = light.received.poll(1, TimeUnit.SECONDS)!!
        assertEquals(0x08.toByte(), third[3])
    }

    @Test
    fun aLightThatDoesNotStoreItIsReportedAsUnconfirmed() {
        light.ignoreSave = true
        val r = DailySender.send("127.0.0.1", light.port, saveFrame(), Triple(6, 30, 0))
        assertTrue(r.sent)
        assertFalse(r.confirmed)
    }

    @Test
    fun noLightGivesAClearMessage() {
        val port = ServerSocket(0).use { it.localPort }
        val r = DailySender.send("127.0.0.1", port, saveFrame(), Triple(1, 2, 3), timeoutMs = 800)
        assertFalse(r.sent)
        assertTrue(r.message, r.message.startsWith("could not reach the light"))
    }
}
