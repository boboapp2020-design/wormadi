package th.co.walkie.app;

import android.Manifest;
import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;

/**
 * Bridge between the web UI (index.html) and {@link WalkieService}.
 * JS: window.Capacitor.Plugins.WalkieNative.<method>(), events on addListener('walkie', ...).
 * The WebSocket lives only in the service; this plugin never opens one.
 */
@CapacitorPlugin(
    name = "WalkieNative",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
    }
)
public class WalkiePlugin extends Plugin implements WalkieService.Listener {
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        WalkieService.setListener(this);
    }

    @Override
    protected void handleOnDestroy() {
        WalkieService.clearListener(this);
    }

    @Override
    public void onWalkieEvent(JSObject event) {
        notifyListeners("walkie", event);
    }

    // ------------------------------------------------------------ permissions

    @PluginMethod
    public void ensurePermissions(PluginCall call) {
        List<String> need = new ArrayList<>();
        if (getPermissionState("microphone") != PermissionState.GRANTED) need.add("microphone");
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) need.add("notifications");
        if (need.isEmpty()) {
            call.resolve(permissionResult());
        } else {
            requestPermissionForAliases(need.toArray(new String[0]), call, "permissionsDone");
        }
    }

    @PermissionCallback
    private void permissionsDone(PluginCall call) {
        call.resolve(permissionResult());
    }

    private JSObject permissionResult() {
        JSObject r = new JSObject();
        r.put("microphone", micGranted() ? "granted" : "denied");
        r.put("notifications", notificationsGranted() ? "granted" : "denied");
        return r;
    }

    private boolean micGranted() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private boolean notificationsGranted() {
        // Below Android 13 there is no runtime permission; the user can still turn notifications off.
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
    }

    // ------------------------------------------------------------ server setup

    @PluginMethod
    public void probe(PluginCall call) {
        String server = call.getString("server");
        execute(() -> {
            try {
                call.resolve(Net.probe(getContext(), server));
            } catch (Exception e) {
                call.reject(Net.friendly(e), "PROBE_FAILED");
            }
        });
    }

    /** Pin a self-signed certificate after the user compared its fingerprint. */
    @PluginMethod
    public void trustCert(PluginCall call) {
        String sha = call.getString("sha256");
        try {
            Net.ServerAddr a = Net.ServerAddr.parse(call.getString("server"));
            if (sha == null || sha.isEmpty()) throw new IllegalArgumentException("ไม่มีลายนิ้วมือใบรับรอง");
            Prefs.setPin(getContext(), a.pinKey(), sha);
            call.resolve();
        } catch (IllegalArgumentException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void forgetCert(PluginCall call) {
        try {
            Prefs.setPin(getContext(), Net.ServerAddr.parse(call.getString("server")).pinKey(), null);
            call.resolve();
        } catch (IllegalArgumentException e) {
            call.reject(e.getMessage());
        }
    }

    // ------------------------------------------------------------ session

    @PluginMethod
    public void join(PluginCall call) {
        String server = call.getString("server");
        String name = call.getString("name");
        String channel = call.getString("channel");
        if (server == null || name == null || name.trim().isEmpty()) {
            call.reject("ต้องมีที่อยู่เซิร์ฟเวอร์และชื่อ");
            return;
        }
        Context ctx = getContext();
        Intent i = new Intent(ctx, WalkieService.class)
            .setAction(WalkieService.ACTION_JOIN)
            .putExtra(WalkieService.EXTRA_SERVER, server)
            .putExtra(WalkieService.EXTRA_NAME, name.trim())
            .putExtra(WalkieService.EXTRA_CHANNEL, channel)
            .putExtra(WalkieService.EXTRA_CODE, call.getString("code", ""))
            .putExtra(WalkieService.EXTRA_DEPT, call.getString("dept", ""))
            .putExtra(WalkieService.EXTRA_UID, call.getString("uid", ""));
        try {
            // Called while the app is in the foreground, so the microphone FGS type is allowed.
            ContextCompat.startForegroundService(ctx, i);
            call.resolve();
        } catch (Exception e) {
            call.reject("เริ่มบริการเบื้องหลังไม่ได้: " + e.getMessage());
        }
    }

    @PluginMethod
    public void switchChannel(PluginCall call) {
        WalkieService s = WalkieService.get();
        String ch = call.getString("channel");
        if (s == null || ch == null) {
            call.reject("ยังไม่ได้เข้าช่อง");
            return;
        }
        s.requestSwitchChannel(ch);
        call.resolve();
    }

    /** Chat / reaction messages from the UI go out on the service's WebSocket (no second connection). */
    @PluginMethod
    public void send(PluginCall call) {
        WalkieService s = WalkieService.get();
        JSObject msg = call.getObject("msg");
        if (s == null || msg == null) {
            call.reject("ยังไม่ได้เข้าช่อง");
            return;
        }
        s.requestSend(msg);
        call.resolve();
    }

    @PluginMethod
    public void leave(PluginCall call) {
        WalkieService s = WalkieService.get();
        if (s != null) s.requestLeave();
        else Prefs.setActive(getContext(), false);
        call.resolve();
    }

    @PluginMethod
    public void pttDown(PluginCall call) {
        WalkieService s = WalkieService.get();
        if (s != null) s.requestPtt(true);
        call.resolve();
    }

    @PluginMethod
    public void pttUp(PluginCall call) {
        WalkieService s = WalkieService.get();
        if (s != null) s.requestPtt(false);
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        main.post(() -> {
            WalkieService s = WalkieService.get();
            JSObject r = s != null ? s.snapshot() : new JSObject();
            if (s == null) {
                r.put("active", false);
                r.put("conn", "offline");
                r.put("server", Prefs.server(getContext()));
                r.put("name", Prefs.name(getContext()));
                r.put("channel", Prefs.channel(getContext()));
            }
            r.put("options", options());
            call.resolve(r);
        });
    }

    // ------------------------------------------------------------ device settings

    @PluginMethod
    public void setOptions(PluginCall call) {
        Context ctx = getContext();
        boolean headset = call.getBoolean("headsetPtt", Prefs.headsetPtt(ctx));
        boolean rugged = call.getBoolean("ruggedPtt", Prefs.ruggedPtt(ctx));
        Prefs.setOptions(ctx, headset, rugged);
        WalkieService s = WalkieService.get();
        if (s != null) s.requestApplyOptions();
        call.resolve(options());
    }

    private JSObject options() {
        JSObject o = new JSObject();
        o.put("headsetPtt", Prefs.headsetPtt(getContext()));
        o.put("ruggedPtt", Prefs.ruggedPtt(getContext()));
        return o;
    }

    @PluginMethod
    public void getDeviceStatus(PluginCall call) {
        Context ctx = getContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        JSObject r = new JSObject();
        r.put("ignoringBattery", pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName()));
        r.put("backgroundRestricted", Build.VERSION.SDK_INT >= 28 && am != null && am.isBackgroundRestricted());
        r.put("manufacturer", Build.MANUFACTURER);
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("microphone", micGranted() ? "granted" : "denied");
        r.put("notifications", notificationsGranted() ? "granted" : "denied");
        r.put("options", options());
        call.resolve(r);
    }

    /** Opens the system dialog "Allow app to always run in background?" (falls back to the list screen). */
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        Context ctx = getContext();
        Intent direct = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.getPackageName()));
        Intent list = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
        startFirstAvailable(call, direct, list, appDetails());
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        startFirstAvailable(call, appDetails());
    }

    private Intent appDetails() {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
    }

    private void startFirstAvailable(PluginCall call, Intent... intents) {
        main.post(() -> {
            for (Intent i : intents) {
                try {
                    getActivity().startActivity(i);
                    call.resolve();
                    return;
                } catch (Exception ignored) {
                    // try the next one (some OEM builds remove the direct dialog)
                }
            }
            call.reject("เปิดหน้าตั้งค่าไม่ได้");
        });
    }
}
