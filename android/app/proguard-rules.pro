# Capacitor ships the rules that keep plugin classes, their @PluginMethod / @PermissionCallback methods and
# the annotations it reads by reflection (node_modules/@capacitor/android/capacitor/proguard-rules.pro, applied
# automatically as consumer rules), and SwachhSecurityPlugin extends com.getcapacitor.Plugin, so it is covered.
# Only what is ours and not covered by those belongs here.

# The bridge calls anything annotated for JavaScript by name.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# The scanner's result arrives as a Parcelable the ACPL companion app wrote, and a parcel carries the
# writer's class name as a string: reading it does Class.forName("com.acpl.ACPL_L1_Data") against this
# app's classes. R8 renaming or dropping that class (or its CREATOR, which is only ever reached
# reflectively) turns every scan into "the result could not be read" in release builds, while debug
# builds -- unminified -- work. Keep the class, its fields and its CREATOR exactly as written.
-keep class com.acpl.** { *; }
-keepclassmembers class * implements android.os.Parcelable {
    public static final ** CREATOR;
}
