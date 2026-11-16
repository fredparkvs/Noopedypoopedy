package dev.reeflight.k7

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.espressif.iot.esptouch.EsptouchTask
import com.espressif.iot.esptouch.IEsptouchTask
import com.espressif.iot.esptouch.util.ByteUtil
import com.espressif.iot.esptouch.util.TouchNetUtil
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.util.concurrent.Executors

/**
 * Exposed to the page as window.NooNative. Every call carries an id; the
 * result comes back through window.__noo.resolve(id, json) or reject(id, msg).
 * Incoming bytes and drops are pushed with window.__noo.event(json).
 */
class LightBridge(private val activity: MainActivity, private val web: WebView) {

    private val socketThread = Executors.newSingleThreadExecutor() // keeps connect/send/close in order
    private val work = Executors.newCachedThreadPool()
    private val hex = "0123456789abcdef".toCharArray()

    private val conn = LightConnection(
        onData = { bytes -> event(JSONObject().put("type", "data").put("hex", toHex(bytes))) },
        onClosed = { reason -> event(JSONObject().put("type", "closed").put("reason", reason)) },
        newSocket = { wifiSocket() },
    )

    private val cm get() = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    /**
     * The real WiFi network (the light's hotspot or your home WiFi). A VPN
     * also reports the WiFi transport of the network under it, so it has to
     * be excluded explicitly; mobile data is never where the light is.
     */
    private fun wifiNetwork(): android.net.Network? = cm.allNetworks.firstOrNull { n ->
        val c = cm.getNetworkCapabilities(n) ?: return@firstOrNull false
        c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !c.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
    }

    private fun vpnActive(): Boolean = cm.allNetworks.any {
        cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
    }

    /** A socket that goes out over WiFi, not through a VPN or mobile data. */
    private fun wifiSocket(): java.net.Socket =
        try { wifiNetwork()?.socketFactory?.createSocket() } catch (_: Exception) { null } ?: java.net.Socket()

    @Volatile
    private var espTask: IEsptouchTask? = null

    // ---- light connection --------------------------------------------------

    @JavascriptInterface
    fun connect(id: Int, host: String, port: Int, timeoutMs: Int) = socketThread.execute {
        try {
            conn.connect(host, port, timeoutMs)
            resolve(id, "true")
        } catch (e: Exception) {
            reject(id, e.message ?: "Could not connect")
        }
    }

    @JavascriptInterface
    fun send(id: Int, hexString: String) = socketThread.execute {
        try {
            conn.send(fromHex(hexString))
            resolve(id, "true")
        } catch (e: Exception) {
            reject(id, e.message ?: "Send failed")
        }
    }

    @JavascriptInterface
    fun close() = socketThread.execute { conn.close() }

    // ---- network -----------------------------------------------------------

    private data class Net(val ip: String?, val prefix: Int, val gateway: String?, val wifi: Boolean, val dhcpServer: String? = null)

    /**
     * On the light's own hotspot the light is the DHCP server; this is the
     * address the official app connects to in "AP connection" mode.
     */
    private fun dhcpServer(): String? = try {
        @Suppress("DEPRECATION")
        val a = (activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).dhcpInfo?.serverAddress ?: 0
        if (a == 0) null else "${a and 255}.${(a shr 8) and 255}.${(a shr 16) and 255}.${(a shr 24) and 255}"
    } catch (_: Exception) {
        null
    }

    private fun currentNet(): Net = netFromLinks().copy(dhcpServer = dhcpServer())

    private fun netFromLinks(): Net {
        val network = wifiNetwork() ?: return Net(null, 24, null, false)
        val lp: LinkProperties? = cm.getLinkProperties(network)
        val la = lp?.linkAddresses?.firstOrNull { it.address is Inet4Address }
        val gw = lp?.routes?.firstOrNull { it.isDefaultRoute && it.gateway is Inet4Address && !it.gateway!!.isAnyLocalAddress }
            ?.gateway?.hostAddress
        return Net(la?.address?.hostAddress, la?.prefixLength ?: 24, gw, true)
    }

    @JavascriptInterface
    fun netInfo(id: Int) = work.execute {
        val n = currentNet()
        resolve(id, JSONObject().put("ip", n.ip).put("prefix", n.prefix).put("gateway", n.gateway)
            .put("dhcpServer", n.dhcpServer).put("wifi", n.wifi).put("vpn", vpnActive()).toString())
    }

    @JavascriptInterface
    fun scan(id: Int, port: Int, timeoutMs: Int) = work.execute {
        try {
            val n = currentNet()
            if (n.ip == null) return@execute reject(id, "This phone is not on a WiFi network.")
            // the light's own hotspot hands out addresses with the light as gateway
            val extras = listOfNotNull(n.dhcpServer, n.gateway, "192.168.4.1")
            val hosts = NetScanner.candidates(n.ip, n.prefix, extras)
            resolve(id, JSONArray(NetScanner.scan(hosts, port, timeoutMs, newSocket = { wifiSocket() })).toString())
        } catch (e: Exception) {
            reject(id, e.message ?: "Scan failed")
        }
    }

    // ---- WiFi provisioning (EspTouch, as the official app does) -------------

    @SuppressLint("MissingPermission")
    @JavascriptInterface
    fun wifiInfo(id: Int) {
        activity.withLocationPermission { granted ->
            if (!granted) return@withLocationPermission reject(id, "Android only shares the WiFi name with apps that have location access. Allow it to set up a light.")
            work.execute {
                @Suppress("DEPRECATION")
                val info = (activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).connectionInfo
                @Suppress("DEPRECATION")
                val ssid = info?.ssid?.removeSurrounding("\"")
                if (ssid == null || ssid == "<unknown ssid>") {
                    reject(id, "Could not read the WiFi name. Turn on Location in quick settings and try again.")
                } else {
                    @Suppress("DEPRECATION")
                    resolve(id, JSONObject().put("ssid", ssid).put("bssid", info.bssid).put("frequency", info.frequency).toString())
                }
            }
        }
    }

    @JavascriptInterface
    fun provision(id: Int, ssid: String, bssid: String, password: String, count: Int) = work.execute {
        try {
            val task = EsptouchTask(
                ByteUtil.getBytesByString(ssid),
                TouchNetUtil.parseBssid2bytes(bssid),
                ByteUtil.getBytesByString(password),
                activity.applicationContext,
            )
            task.setPackageBroadcast(true)
            espTask = task
            val results = task.executeForResults(count.coerceAtLeast(1))
            espTask = null
            val ok = results.filter { it.isSuc && !it.isCancelled }
            if (task.isCancelled) return@execute reject(id, "Cancelled.")
            if (ok.isEmpty()) return@execute reject(id, "No light answered within a minute.")
            val arr = JSONArray()
            ok.forEach { arr.put(JSONObject().put("ip", it.inetAddress.hostAddress).put("bssid", it.bssid)) }
            resolve(id, arr.toString())
        } catch (e: Exception) {
            espTask = null
            reject(id, e.message ?: "Setup failed")
        }
    }

    @JavascriptInterface
    fun cancelProvision() {
        espTask?.interrupt()
    }

    // ---- files and clipboard -------------------------------------------------

    @JavascriptInterface
    fun saveText(id: Int, filename: String, text: String) {
        activity.saveDocument(filename, text) { ok, err -> if (ok) resolve(id, "true") else reject(id, err ?: "cancelled") }
    }

    @JavascriptInterface
    fun openText(id: Int) {
        activity.openDocument { text, err -> if (text != null) resolve(id, JSONObject.quote(text)) else reject(id, err ?: "cancelled") }
    }

    @JavascriptInterface
    fun copyText(id: Int, text: String) {
        activity.runOnUiThread {
            val cb = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cb.setPrimaryClip(ClipData.newPlainText("Reef Light", text))
            resolve(id, "true")
        }
    }

    // ---- plumbing ----------------------------------------------------------------

    fun shutdown() {
        espTask?.interrupt()
        socketThread.execute { conn.close() }
        socketThread.shutdown()
        work.shutdownNow()
    }

    private fun js(code: String) {
        web.post { web.evaluateJavascript(code, null) }
    }
    private fun resolve(id: Int, json: String) = js("window.__noo.resolve($id, ${JSONObject.quote(json)})")
    private fun reject(id: Int, msg: String) = js("window.__noo.reject($id, ${JSONObject.quote(msg)})")
    private fun event(o: JSONObject) = js("window.__noo.event(${JSONObject.quote(o.toString())})")

    private fun toHex(b: ByteArray): String {
        val out = CharArray(b.size * 2)
        b.forEachIndexed { i, v -> out[i * 2] = hex[(v.toInt() shr 4) and 15]; out[i * 2 + 1] = hex[v.toInt() and 15] }
        return String(out)
    }

    private fun fromHex(s: String): ByteArray {
        val clean = s.filter { it.isLetterOrDigit() }
        return ByteArray(clean.length / 2) { i -> clean.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }
}
