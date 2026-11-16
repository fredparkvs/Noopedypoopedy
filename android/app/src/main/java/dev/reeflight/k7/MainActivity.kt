package dev.reeflight.k7

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader

class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private lateinit var bridge: LightBridge
    private var wifiCallback: ConnectivityManager.NetworkCallback? = null

    private var pendingSave: Pair<String, (Boolean, String?) -> Unit>? = null
    private var pendingOpen: ((String?, String?) -> Unit)? = null
    private var pendingPermission: ((Boolean) -> Unit)? = null

    private val createDoc = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val (text, cb) = pendingSave ?: return@registerForActivityResult
        pendingSave = null
        if (uri == null) return@registerForActivityResult cb(false, "cancelled")
        try {
            contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
            cb(true, null)
        } catch (e: Exception) {
            cb(false, e.message)
        }
    }

    private val openDoc = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val cb = pendingOpen ?: return@registerForActivityResult
        pendingOpen = null
        if (uri == null) return@registerForActivityResult cb(null, "cancelled")
        try {
            val text = contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
            cb(text, if (text == null) "Could not read the file" else null)
        } catch (e: Exception) {
            cb(null, e.message)
        }
    }

    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val cb = pendingPermission
        pendingPermission = null
        cb?.invoke(result.values.any { it })
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this)
        web.setBackgroundColor(0xFF0D1F2B.toInt())
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == APP_HOST) return false
                // links to anywhere else open in the browser, never inside the app
                try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) {}
                return true
            }
        }
        bridge = LightBridge(this, web)
        web.addJavascriptInterface(bridge, "NooNative")
        web.loadUrl(START_URL)

        onBackPressedDispatcher.addCallback(this) {
            web.evaluateJavascript("(window.__noo && window.__noo.back) ? window.__noo.back() : false") { handled ->
                if (handled != "true") finish()
            }
        }
        bindToWifi()
    }

    /**
     * When the phone is on a WiFi network without internet (the light's own
     * K7 hotspot), Android sends traffic over mobile data instead. Pin this
     * app to WiFi so it can always reach the light.
     */
    private fun bindToWifi() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val request = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { cm.bindProcessToNetwork(network) }
            override fun onLost(network: Network) { if (cm.boundNetworkForProcess == network) cm.bindProcessToNetwork(null) }
        }
        try {
            cm.registerNetworkCallback(request, cb)
            wifiCallback = cb
        } catch (_: Exception) { /* not fatal: default routing usually works on home WiFi */ }
    }

    fun withLocationPermission(cb: (Boolean) -> Unit) = runOnUiThread {
        val fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (fine) return@runOnUiThread cb(true)
        pendingPermission = cb
        permissions.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    fun saveDocument(filename: String, text: String, cb: (Boolean, String?) -> Unit) = runOnUiThread {
        pendingSave = text to cb
        createDoc.launch(filename)
    }

    fun openDocument(cb: (String?, String?) -> Unit) = runOnUiThread {
        pendingOpen = cb
        openDoc.launch(arrayOf("application/json", "text/plain", "application/octet-stream"))
    }

    override fun onPause() {
        super.onPause()
        inForeground = false
        web.onPause() // the page sees visibilitychange and frees the light after a while
    }

    override fun onResume() {
        super.onResume()
        inForeground = true
        web.onResume()
    }

    override fun onDestroy() {
        wifiCallback?.let { cb ->
            try { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) } catch (_: Exception) {}
        }
        bridge.shutdown()
        web.destroy()
        super.onDestroy()
    }

    companion object {
        /** The background job leaves the light alone while the app is open (the app holds its one connection). */
        @Volatile
        var inForeground = false
        private const val APP_HOST = "appassets.androidplatform.net"
        private val START_URL = Uri.parse("https://$APP_HOST/assets/www/index.html").toString()
    }
}
