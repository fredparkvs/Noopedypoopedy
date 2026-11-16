package dev.reeflight.k7

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** A fake light: answers READ_ALL with a 221-byte status block in two pieces, acks everything else. */
class FakeLight {
    val server = ServerSocket(0)
    val port get() = server.localPort
    val received = LinkedBlockingQueue<ByteArray>()
    @Volatile var dropAfterNextFrame = false

    val status: ByteArray = ByteArray(221).also {
        it[0] = 0xAB.toByte(); it[1] = 0xAA.toByte(); it[10] = 0x18; it[203] = 1
        "K7_TEST0001".forEachIndexed { i, c -> it[204 + i] = c.code.toByte() }
    }

    init {
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val s = try { server.accept() } catch (_: IOException) { break }
                thread(isDaemon = true) {
                    s.use { sock ->
                        val input = sock.getInputStream()
                        val out = sock.getOutputStream()
                        val frame = ByteArrayOutputStream()
                        while (true) {
                            val b = input.read()
                            if (b < 0) break
                            frame.write(b)
                            if (b == 0xBB) {
                                val f = frame.toByteArray()
                                frame.reset()
                                received.add(f)
                                if (dropAfterNextFrame) { sock.close(); break }
                                if (f.size == 5 && f[3] == 0x08.toByte()) {
                                    out.write(status, 0, 100); out.flush()
                                    Thread.sleep(30)
                                    out.write(status, 100, status.size - 100); out.flush()
                                } else {
                                    out.write(byteArrayOf(0xAB.toByte(), 0xAA.toByte(), 0xA5.toByte(), 0xA1.toByte())); out.flush()
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    fun close() = server.close()
}

class LightConnectionTest {
    private lateinit var light: FakeLight
    private val incoming = ByteArrayOutputStream()
    private val closed = LinkedBlockingQueue<String>()
    private lateinit var conn: LightConnection

    @Before
    fun setUp() {
        light = FakeLight()
        conn = LightConnection(onData = { synchronized(incoming) { incoming.write(it) } }, onClosed = { closed.add(it) })
    }

    @After
    fun tearDown() {
        conn.close()
        light.close()
    }

    private fun waitForBytes(n: Int): ByteArray {
        val end = System.currentTimeMillis() + 3000
        while (System.currentTimeMillis() < end) {
            synchronized(incoming) { if (incoming.size() >= n) return incoming.toByteArray() }
            Thread.sleep(10)
        }
        fail("expected $n bytes, got ${incoming.size()}")
        throw IllegalStateException()
    }

    @Test
    fun readAllReturnsTheWholeStatusEvenWhenSplit() {
        conn.connect("127.0.0.1", light.port, 2000)
        conn.send(byteArrayOf(0xAA.toByte(), 0xA5.toByte(), 0x10, 0x08, 0xBB.toByte()))
        val got = waitForBytes(221)
        assertArrayEquals(light.status, got)
        assertArrayEquals(byteArrayOf(0xAA.toByte(), 0xA5.toByte(), 0x10, 0x08, 0xBB.toByte()), light.received.poll(1, TimeUnit.SECONDS))
    }

    @Test
    fun commandsAreAcked() {
        conn.connect("127.0.0.1", light.port, 2000)
        conn.send(byteArrayOf(0xAA.toByte(), 0xA5.toByte(), 0x10, 0x04, 0x01, 0xBB.toByte()))
        assertArrayEquals(byteArrayOf(0xAB.toByte(), 0xAA.toByte(), 0xA5.toByte(), 0xA1.toByte()), waitForBytes(4))
    }

    @Test
    fun aDropByTheLightIsReported() {
        conn.connect("127.0.0.1", light.port, 2000)
        light.dropAfterNextFrame = true
        conn.send(byteArrayOf(0xAA.toByte(), 0xA5.toByte(), 0x10, 0x08, 0xBB.toByte()))
        val reason = closed.poll(3, TimeUnit.SECONDS)
        assertTrue("drop reported", reason != null)
        assertFalse(conn.isConnected)
        try {
            conn.send(byteArrayOf(1))
            fail("send after drop should throw")
        } catch (_: IOException) { }
    }

    @Test
    fun closingOurselvesIsNotReportedAsADrop() {
        conn.connect("127.0.0.1", light.port, 2000)
        conn.close()
        assertEquals(null, closed.poll(500, TimeUnit.MILLISECONDS))
    }

    @Test
    fun reconnectingReplacesTheOldSocket() {
        conn.connect("127.0.0.1", light.port, 2000)
        conn.connect("127.0.0.1", light.port, 2000)
        conn.send(byteArrayOf(0xAA.toByte(), 0xA5.toByte(), 0x10, 0x04, 0x00, 0xBB.toByte()))
        waitForBytes(4)
        assertEquals(null, closed.poll(300, TimeUnit.MILLISECONDS))
    }

    @Test
    fun aHostWithNothingListeningGivesAFriendlyError() {
        val port = ServerSocket(0).use { it.localPort }
        try {
            conn.connect("127.0.0.1", port, 1000)
            fail("should not connect")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("127.0.0.1"))
        }
    }
}

class NetScannerTest {
    @Test
    fun candidatesCoverTheSubnetWithoutOurselves() {
        val c = NetScanner.candidates("192.168.1.20", 24, listOf("192.168.1.1", "192.168.4.1"))
        assertEquals("192.168.1.1", c[0])
        assertTrue(c.contains("192.168.4.1"))
        assertTrue(c.contains("192.168.1.254"))
        assertFalse(c.contains("192.168.1.20"))
        assertFalse(c.contains("192.168.1.0"))
        assertFalse(c.contains("192.168.1.255"))
        assertEquals(254, c.size) // 253 others in the /24 plus 192.168.4.1
    }

    @Test
    fun largeSubnetsAreLimitedToTheNearest24() {
        assertEquals(253, NetScanner.candidates("10.0.5.9", 16).size)
    }

    @Test
    fun scanFindsAnOpenPort() {
        val light = FakeLight()
        try {
            val found = NetScanner.scan(listOf("127.0.0.1", "127.0.0.2"), light.port, 300)
            assertTrue(found.contains("127.0.0.1"))
        } finally {
            light.close()
        }
    }
}
