package dev.reeflight.k7

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.concurrent.thread

/**
 * One TCP connection to a light (port 8266). Plain JVM code, no Android
 * classes, so it can be unit tested against a local server.
 *
 * Bytes are delivered raw as they arrive; reassembling replies is done by the
 * JavaScript side (see protocol.js Framer), because TCP may split them.
 */
class LightConnection(
    private val onData: (ByteArray) -> Unit,
    private val onClosed: (String) -> Unit,
) {
    @Volatile
    private var socket: Socket? = null

    val isConnected: Boolean get() = socket != null

    @Synchronized
    fun connect(host: String, port: Int, timeoutMs: Int) {
        close()
        val s = Socket()
        try {
            s.tcpNoDelay = true
            s.keepAlive = true
            s.connect(InetSocketAddress(host, port), timeoutMs)
        } catch (e: IOException) {
            try { s.close() } catch (_: IOException) {}
            throw IOException(friendly(e, host), e)
        }
        socket = s
        val input = s.getInputStream()
        thread(isDaemon = true, name = "light-reader") {
            val buf = ByteArray(2048)
            var reason = "the light closed the connection"
            try {
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (n > 0) onData(buf.copyOf(n))
                }
            } catch (e: IOException) {
                reason = e.message ?: "connection lost"
            }
            // only report drops we did not ask for
            if (dropIfCurrent(s)) onClosed(reason)
        }
    }

    @Synchronized
    private fun dropIfCurrent(s: Socket): Boolean {
        if (socket !== s) return false
        socket = null
        try { s.close() } catch (_: IOException) {}
        return true
    }

    fun send(bytes: ByteArray) {
        val s = socket ?: throw IOException("Not connected to a light")
        try {
            synchronized(this) {
                val out = s.getOutputStream()
                out.write(bytes)
                out.flush()
            }
        } catch (e: IOException) {
            if (dropIfCurrent(s)) onClosed("send failed: ${e.message}")
            throw e
        }
    }

    @Synchronized
    fun close() {
        val s = socket ?: return
        socket = null
        try { s.close() } catch (_: IOException) {}
    }

    private fun friendly(e: IOException, host: String): String = when {
        e is java.net.SocketTimeoutException -> "No answer from $host. Is the light on and on this WiFi?"
        e is java.net.ConnectException -> "$host refused the connection. Close the official app if it is open."
        e is java.net.NoRouteToHostException -> "Cannot reach $host from this network."
        else -> e.message ?: "Could not connect to $host"
    }
}
