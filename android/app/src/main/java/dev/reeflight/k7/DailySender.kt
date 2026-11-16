package dev.reeflight.k7

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException

/**
 * Sends one day's prepared SAVE frame to a light and checks it took. Plain
 * JVM code so it can be tested against a fake light.
 *
 * The frame is built by the app (natural.js) with the clock bytes left at
 * 00:00:00; they are filled in with the real time just before sending.
 */
object DailySender {

    data class Result(val sent: Boolean, val confirmed: Boolean, val message: String)

    private const val TIME_AT = 204 // h m s inside the 208-byte SAVE frame

    fun syncTimeFrame(h: Int, m: Int, s: Int): ByteArray =
        byteArrayOf(0xAA.toByte(), 0xA5.toByte(), 0x10, 0x03, h.toByte(), m.toByte(), s.toByte(), 0xBB.toByte())

    fun withTime(frame: ByteArray, h: Int, m: Int, s: Int): ByteArray {
        require(frame.size == 208 && frame[3] == 0x07.toByte()) { "not a SAVE frame" }
        return frame.copyOf().also { it[TIME_AT] = h.toByte(); it[TIME_AT + 1] = m.toByte(); it[TIME_AT + 2] = s.toByte() }
    }

    private val READ_ALL = byteArrayOf(0xAA.toByte(), 0xA5.toByte(), 0x10, 0x08, 0xBB.toByte())

    fun send(
        host: String,
        port: Int,
        frame: ByteArray,
        clock: Triple<Int, Int, Int>,
        newSocket: () -> Socket = { Socket() },
        timeoutMs: Int = 4000,
    ): Result {
        val (h, m, s) = clock
        val sock = newSocket()
        try {
            sock.connect(InetSocketAddress(host, port), timeoutMs)
            sock.soTimeout = 3000
            val out = sock.getOutputStream()
            val input = sock.getInputStream()
            out.write(syncTimeFrame(h, m, s)); out.flush()
            Thread.sleep(300)
            out.write(withTime(frame, h, m, s)); out.flush()
            Thread.sleep(500)
            drain(input)
            out.write(READ_ALL); out.flush()
            val status = readStatus(input)
            val confirmed = status != null && (11..202).all { status[it] == frame[it] }
            return Result(true, confirmed, if (confirmed) "sent and confirmed by the light" else "sent (the light did not confirm it)")
        } catch (e: IOException) {
            return Result(false, false, "could not reach the light at $host (${e.message ?: "no answer"})")
        } finally {
            try { sock.close() } catch (_: IOException) {}
        }
    }

    /** Throw away acks that are already waiting. */
    private fun drain(input: java.io.InputStream) {
        while (input.available() > 0) input.read(ByteArray(input.available()))
    }

    /** The status block (215+ bytes starting AB AA), or null if it does not come. */
    private fun readStatus(input: java.io.InputStream): ByteArray? {
        val buf = ByteArrayOutputStream()
        val chunk = ByteArray(512)
        val end = System.currentTimeMillis() + 3000
        try {
            while (System.currentTimeMillis() < end) {
                val n = input.read(chunk)
                if (n < 0) break
                buf.write(chunk, 0, n)
                val b = buf.toByteArray()
                val start = (0 until b.size - 1).firstOrNull { i ->
                    b[i] == 0xAB.toByte() && b[i + 1] == 0xAA.toByte() && !(i + 3 < b.size && b[i + 2] == 0xA5.toByte() && b[i + 3] == 0xA1.toByte())
                }
                if (start != null && b.size - start >= 215) return b.copyOfRange(start, b.size)
            }
        } catch (_: SocketTimeoutException) { }
        return null
    }
}
