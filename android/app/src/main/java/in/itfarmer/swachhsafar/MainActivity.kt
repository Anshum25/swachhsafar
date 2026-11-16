package in.itfarmer.swachhsafar

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import in.itfarmer.swachhsafar.security.SwachhSecurityPlugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(SwachhSecurityPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}

