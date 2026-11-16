package dev.reeflight.k7

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import java.net.Socket

/** The phone's real WiFi network (never a VPN or mobile data), shared by the app and the background job. */
object WifiNet {

    private fun cm(ctx: Context) = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    /** A VPN also reports the WiFi transport of the network under it, so it is excluded explicitly. */
    fun network(ctx: Context): Network? = cm(ctx).let { cm ->
        cm.allNetworks.firstOrNull { n ->
            val c = cm.getNetworkCapabilities(n) ?: return@firstOrNull false
            c.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !c.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        }
    }

    fun vpnActive(ctx: Context): Boolean = cm(ctx).let { cm ->
        cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true }
    }

    /** On the light's own hotspot the light is the DHCP server (the official app's "AP connection" address). */
    fun dhcpServer(ctx: Context): String? = try {
        @Suppress("DEPRECATION")
        val a = (ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).dhcpInfo?.serverAddress ?: 0
        if (a == 0) null else "${a and 255}.${(a shr 8) and 255}.${(a shr 16) and 255}.${(a shr 24) and 255}"
    } catch (_: Exception) {
        null
    }

    /** A socket that goes out over WiFi. */
    fun socket(ctx: Context): Socket =
        try { network(ctx)?.socketFactory?.createSocket() } catch (_: Exception) { null } ?: Socket()
}
