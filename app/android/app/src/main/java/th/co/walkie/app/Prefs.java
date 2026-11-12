package th.co.walkie.app;

import android.content.Context;
import android.content.SharedPreferences;

/** Small persistent settings shared by the plugin and the service. */
final class Prefs {
    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences("walkie", Context.MODE_PRIVATE);
    }

    static void saveSession(Context c, String server, String name, String channel) {
        sp(c).edit().putString("server", server).putString("name", name).putString("channel", channel).putBoolean("active", true).apply();
    }

    static void saveChannel(Context c, String channel) { sp(c).edit().putString("channel", channel).apply(); }

    static void setActive(Context c, boolean active) { sp(c).edit().putBoolean("active", active).apply(); }

    static boolean isActive(Context c) { return sp(c).getBoolean("active", false); }

    static String server(Context c) { return sp(c).getString("server", null); }

    static String name(Context c) { return sp(c).getString("name", null); }

    static String channel(Context c) { return sp(c).getString("channel", null); }

    /** Headset play/pause button = push-to-talk. On by default. */
    static boolean headsetPtt(Context c) { return sp(c).getBoolean("headsetPtt", true); }

    /** Rugged-phone PTT broadcasts/keys. Off by default: any app could send those broadcasts. */
    static boolean ruggedPtt(Context c) { return sp(c).getBoolean("ruggedPtt", false); }

    static void setOptions(Context c, boolean headset, boolean rugged) {
        sp(c).edit().putBoolean("headsetPtt", headset).putBoolean("ruggedPtt", rugged).apply();
    }

    static String get(Context c, String key) { return sp(c).getString(key, ""); }

    static void put(Context c, String key, String value) { sp(c).edit().putString(key, value != null ? value : "").apply(); }

    static String pin(Context c, String key) { return sp(c).getString("pin:" + key, null); }

    static void setPin(Context c, String key, String sha256) {
        if (sha256 == null) sp(c).edit().remove("pin:" + key).apply();
        else sp(c).edit().putString("pin:" + key, sha256).apply();
    }
}
