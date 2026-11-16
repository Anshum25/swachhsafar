# Capacitor reaches plugin classes and their @PluginMethod methods by reflection, so R8 must not remove or
# rename them. Everything else in the app is web assets, which minification does not touch.
-keep public class in.itfarmer.swachhsafar.security.** { *; }
-keepclassmembers class in.itfarmer.swachhsafar.security.** { @com.getcapacitor.PluginMethod <methods>; }
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * { @com.getcapacitor.PluginMethod public <methods>; }
-keepclassmembers class * { @com.getcapacitor.PluginMethod <methods>; }

# Keep the JavaScript interface the bridge injects into the WebView.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
