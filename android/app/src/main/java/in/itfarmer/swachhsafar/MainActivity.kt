// Kotlin reserves `in`, so the first segment of the package name (in.itfarmer.swachhsafar) has to be
// written escaped. The compiled package is the plain one the manifest and Capacitor expect.
package `in`.itfarmer.swachhsafar

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import `in`.itfarmer.swachhsafar.security.SwachhSecurityPlugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(SwachhSecurityPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}

