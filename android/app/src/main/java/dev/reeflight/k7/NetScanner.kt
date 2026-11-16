package dev.reeflight.k7

import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Finds hosts on the local network that accept connections on the light's port. */
object NetScanner {

    /** Every address in the /24 around [ip] (or the real subnet when it is smaller), plus extras such as the gateway. */
    fun candidates(ip: String?, prefix: Int, extras: List<String> = emptyList()): List<String> {
        val out = LinkedHashSet<String>()
        extras.filter { it.isNotBlank() }.forEach { out.add(it) }
        val parts = ip?.split(".")?.mapNotNull { it.toIntOrNull() }
        if (parts != null && parts.size == 4) {
            val p = prefix.coerceIn(24, 30)
            val base = ((parts[0] shl 24) or (parts[1] shl 16) or (parts[2] shl 8) or parts[3]) and (-1 shl (32 - p))
            val count = 1 shl (32 - p)
            for (i in 1 until count - 1) {
                val a = base + i
                val s = "${(a ushr 24) and 255}.${(a ushr 16) and 255}.${(a ushr 8) and 255}.${a and 255}"
                if (s != ip) out.add(s)
            }
        }
        return out.toList()
    }

    fun isOpen(host: String, port: Int, timeoutMs: Int): Boolean = try {
        Socket().use { it.connect(InetSocketAddress(host, port), timeoutMs); true }
    } catch (_: Exception) {
        false
    }

    /** Hosts with [port] open, in the order of [hosts]. */
    fun scan(hosts: List<String>, port: Int, timeoutMs: Int, threads: Int = 48): List<String> {
        if (hosts.isEmpty()) return emptyList()
        val pool = Executors.newFixedThreadPool(threads.coerceAtMost(hosts.size))
        try {
            val futures = hosts.map { h -> pool.submit(Callable { if (isOpen(h, port, timeoutMs)) h else null }) }
            return futures.mapNotNull {
                try { it.get(timeoutMs * 4L + 2000, TimeUnit.MILLISECONDS) } catch (_: Exception) { null }
            }
        } finally {
            pool.shutdownNow()
        }
    }
}
