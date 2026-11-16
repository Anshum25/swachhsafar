# Capacitor ships the rules that keep plugin classes, their @PluginMethod / @PermissionCallback methods and
# the annotations it reads by reflection (node_modules/@capacitor/android/capacitor/proguard-rules.pro, applied
# automatically as consumer rules), and SwachhSecurityPlugin extends com.getcapacitor.Plugin, so it is covered.
# Only what is ours and not covered by those belongs here.

# The bridge calls anything annotated for JavaScript by name.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
