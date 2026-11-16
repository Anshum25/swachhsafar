package in.itfarmer.swachhsafar.security

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource

@CapacitorPlugin(
    name = "SwachhSecurity",
    permissions = [
        Permission(
            alias = "location",
            strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION]
        )
    ]
)
class SwachhSecurityPlugin : Plugin() {

    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var connectivityManager: ConnectivityManager
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private val securePrefs by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        EncryptedSharedPreferences.create(
            context,
            "swachh_secure_vault",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    override fun load() {
        super.load()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(activity)
        connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        startNetworkMonitoring()
    }

    override fun handleOnResume() {
        super.handleOnResume()
        val ret = JSObject()
        ret.put("timestamp", System.currentTimeMillis())
        notifyListeners("appResume", ret)
    }

    // ---------------------------------------------------------------------------------------------
    // Location Methods
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    fun getLocationStatus(call: PluginCall) {
        val fineGranted = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        val permStatus = if (fineGranted) "granted" else "denied"

        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val gpsEnabled = lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)

        val ret = JSObject()
        ret.put("permission", permStatus)
        ret.put("servicesEnabled", gpsEnabled)
        call.resolve(ret)
    }

    @PluginMethod
    fun requestLocationPermission(call: PluginCall) {
        if (getPermissionState("location") == com.getcapacitor.PermissionState.GRANTED) {
            val ret = JSObject()
            ret.put("permission", "granted")
            call.resolve(ret)
        } else {
            requestPermissionForAlias("location", call, "locationPermCallback")
        }
    }

    @PermissionCallback
    private fun locationPermCallback(call: PluginCall) {
        val granted = getPermissionState("location") == com.getcapacitor.PermissionState.GRANTED
        val ret = JSObject()
        ret.put("permission", if (granted) "granted" else "denied")
        call.resolve(ret)
    }

    @PluginMethod
    fun getCurrentLocation(call: PluginCall) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Location permission not granted", "PERMISSION_DENIED")
            return
        }

        val cts = CancellationTokenSource()
        val priority = Priority.PRIORITY_HIGH_ACCURACY

        fusedLocationClient.getCurrentLocation(priority, cts.token)
            .addOnSuccessListener { loc: Location? ->
                if (loc != null) {
                    val isMock = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        loc.isMock
                    } else {
                        @Suppress("DEPRECATION")
                        loc.isFromMockProvider
                    }

                    val ret = JSObject().apply {
                        put("latitude", loc.latitude)
                        put("longitude", loc.longitude)
                        put("accuracy", loc.accuracy.toDouble())
                        put("time", loc.time)
                        put("provider", loc.provider ?: "fused")
                        put("mocked", isMock)
                    }
                    call.resolve(ret)
                } else {
                    call.reject("Could not acquire location fix", "UNAVAILABLE")
                }
            }
            .addOnFailureListener { exc ->
                call.reject("Location error: ${exc.message}", "ERROR")
            }
    }

    // ---------------------------------------------------------------------------------------------
    // Device integrity: Developer options and USB debugging. Read from Settings.Global, the only reliable
    // source (a browser/PWA cannot see these). The app refuses to open while Developer options are on.
    @PluginMethod
    fun getDeviceIntegrity(call: PluginCall) {
        val resolver = context.contentResolver
        val developer = Settings.Global.getInt(resolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) != 0
        val adb = Settings.Global.getInt(resolver, Settings.Global.ADB_ENABLED, 0) != 0
        val ret = JSObject()
        ret.put("developerMode", developer)
        ret.put("usbDebugging", adb)
        call.resolve(ret)
    }

    @PluginMethod
    fun openDeveloperSettings(call: PluginCall) {
        val dev = Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        try {
            context.startActivity(dev)
        } catch (e: Exception) {
            context.startActivity(Intent(Settings.ACTION_SETTINGS).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) })
        }
        call.resolve()
    }

    @PluginMethod
    fun openLocationSettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        context.startActivity(intent)
        call.resolve()
    }

    // ---------------------------------------------------------------------------------------------
    // Network & VPN Methods
    // ---------------------------------------------------------------------------------------------

    private fun readCurrentNetworkState(): JSObject {
        val activeNetwork = connectivityManager.activeNetwork
        val caps = connectivityManager.getNetworkCapabilities(activeNetwork)

        val isVpn = caps?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ?: false
        val isConnected = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)

        val transports = mutableListOf<String>()
        if (caps != null) {
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) transports.add("wifi")
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) transports.add("cellular")
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) transports.add("ethernet")
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) transports.add("vpn")
        }

        return JSObject().apply {
            put("vpn", isVpn)
            put("connected", isConnected)
            put("transports", JSArray(transports))
        }
    }

    @PluginMethod
    fun getNetworkState(call: PluginCall) {
        call.resolve(readCurrentNetworkState())
    }

    private fun startNetworkMonitoring() {
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
                notifyListeners("networkChange", readCurrentNetworkState())
            }

            override fun onLost(network: Network) {
                notifyListeners("networkChange", readCurrentNetworkState())
            }
        }

        try {
            connectivityManager.registerNetworkCallback(request, networkCallback!!)
        } catch (_: Exception) {}
    }

    // ---------------------------------------------------------------------------------------------
    // Secure Storage & Integrity Methods
    // ---------------------------------------------------------------------------------------------

    @PluginMethod
    fun secureGet(call: PluginCall) {
        val key = call.getString("key")
        if (key == null) {
            call.reject("Key is required")
            return
        }
        val value = securePrefs.getString(key, null)
        val ret = JSObject().apply {
            put("value", value)
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun secureSet(call: PluginCall) {
        val key = call.getString("key")
        val value = call.getString("value")
        if (key == null) {
            call.reject("Key is required")
            return
        }
        securePrefs.edit().putString(key, value).apply()
        call.resolve()
    }

    @PluginMethod
    fun getMonotonicTime(call: PluginCall) {
        val ret = JSObject().apply {
            put("elapsedRealtimeMs", SystemClock.elapsedRealtime())
            put("uptimeMs", SystemClock.uptimeMillis())
            put("wallTimeMs", System.currentTimeMillis())
        }
        call.resolve(ret)
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        networkCallback?.let {
            try {
                connectivityManager.unregisterNetworkCallback(it)
            } catch (_: Exception) {}
        }
    }
}

