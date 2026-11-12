package th.co.walkie.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Log;
import android.view.KeyEvent;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.IntentCompat;

import com.getcapacitor.JSObject;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Foreground service (types microphone + mediaPlayback) that owns the single WebSocket to the
 * walkie server, plays incoming audio, records outgoing audio and keeps working with the screen
 * locked or the app swiped away. The web UI talks to it only through {@link WalkiePlugin}.
 *
 * Threading: all session state is touched on the main thread. OkHttp callbacks hop to the main
 * thread, except audio frames which go straight to the AudioEngine queue (ordering preserved
 * because OkHttp delivers messages of one socket sequentially on its reader thread).
 */
public class WalkieService extends Service {
    static final String ACTION_JOIN = "th.co.walkie.app.action.JOIN";
    static final String ACTION_LEAVE = "th.co.walkie.app.action.LEAVE";
    static final String ACTION_TOGGLE_TALK = "th.co.walkie.app.action.TOGGLE_TALK";
    static final String EXTRA_SERVER = "server";
    static final String EXTRA_NAME = "name";
    static final String EXTRA_CHANNEL = "channel";
    static final String EXTRA_CODE = "code";
    static final String EXTRA_DEPT = "dept";
    static final String EXTRA_UID = "uid";

    private static final String TAG = "WalkieService";
    private static final String NOTIF_CHANNEL = "walkie_live";
    private static final String ALERT_CHANNEL = "walkie_sos";      // เหตุฉุกเฉิน: ดังแม้จอล็อก
    private static final String INFO_CHANNEL = "walkie_info";      // งาน / ประกาศ
    private int alertSeq = 2000;
    private static final int NOTIF_ID = 1001;
    private static final long MAX_BACKOFF_MS = 30_000;
    private static final long TAP_TOGGLE_MS = 400;

    // Broadcasts sent by rugged phones' PTT keys (best effort, vendor specific).
    private static final String KNOX_HARD_KEY_REPORT = "com.samsung.android.knox.intent.action.HARD_KEY_REPORT";
    private static final String KNOX_EXTRA_REPORT_TYPE = "com.samsung.android.knox.intent.extra.KEY_REPORT_TYPE";
    private static final String SONIM_PTT_DOWN = "com.sonim.intent.action.PTT_KEY_DOWN";
    private static final String SONIM_PTT_UP = "com.sonim.intent.action.PTT_KEY_UP";
    private static final String GENERIC_PTT_DOWN = "android.intent.action.PTT.down";
    private static final String GENERIC_PTT_UP = "android.intent.action.PTT.up";
    /** Key codes some rugged phones deliver to the foreground app (Samsung XCover side/top key). */
    private static final int[] RUGGED_KEYCODES = { 1015, 1079 };

    /** Receives events for the web UI (set by the plugin while the WebView is alive). */
    interface Listener {
        void onWalkieEvent(JSObject event);
    }

    private static volatile WalkieService instance;
    private static volatile Listener listener;

    static WalkieService get() { return instance; }

    static void setListener(Listener l) { listener = l; }

    static void clearListener(Listener l) { if (listener == l) listener = null; }

    private final Handler main = new Handler(Looper.getMainLooper());
    private OkHttpClient wsBase;
    private AudioEngine audio;

    // session (main thread)
    private boolean active;
    private Net.ServerAddr addr;
    private String serverBase;
    private volatile String myName;
    private String wantChannel;
    private String accessCode = "", dept = "", uid = "";
    private volatile WebSocket ws;
    private volatile int gen;
    private boolean open;
    private int attempt;
    private Runnable reconnectTask;
    private String connState = "offline";
    private String connReason;
    private JSObject lastJoined, lastState;
    private String currentChannel, talker;
    private int userCount;
    private boolean micAllowed;

    // push-to-talk (main thread; talking is read by the capture thread)
    private boolean wantTalk;
    private volatile boolean talking;
    private boolean latched, ignoreNextUp;
    private long keyDownAt;
    private long lastLevelAt;

    // system hooks
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private MediaSession mediaSession;
    private BroadcastReceiver ruggedReceiver;
    private ConnectivityManager.NetworkCallback netCallback;

    // ================================================================ lifecycle

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createNotificationChannel();
        wsBase = new OkHttpClient.Builder()
            .connectTimeout(6, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .pingInterval(15, TimeUnit.SECONDS) // no pong within 15 s => onFailure => reconnect
            .build();
        audio = new AudioEngine(this, new AudioEngine.Sink() {
            @Override
            public void onPcm(byte[] buf, int len) {
                WebSocket w = ws;
                if (w != null && talking) w.send(ByteString.of(buf, 0, len));
            }

            @Override
            public void onLevel(float peak) {
                long now = SystemClock.uptimeMillis();
                if (listener == null || now - lastLevelAt < 120) return;
                lastLevelAt = now;
                main.post(() -> {
                    JSObject e = new JSObject();
                    e.put("v", peak);
                    emit("level", e);
                });
            }
        });
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        String server, name, channel;
        if (intent == null) {
            // Restarted by the system after being killed (START_STICKY): resume the last session.
            if (!Prefs.isActive(this) || Prefs.server(this) == null) {
                stopSelf();
                return START_NOT_STICKY;
            }
            action = ACTION_JOIN;
            server = Prefs.server(this);
            name = Prefs.name(this);
            channel = Prefs.channel(this);
            accessCode = Prefs.get(this, "code");
            dept = Prefs.get(this, "dept");
            uid = Prefs.get(this, "uid");
        } else {
            server = intent.getStringExtra(EXTRA_SERVER);
            name = intent.getStringExtra(EXTRA_NAME);
            channel = intent.getStringExtra(EXTRA_CHANNEL);
            if (ACTION_JOIN.equals(action)) {
                accessCode = nz(intent.getStringExtra(EXTRA_CODE));
                dept = nz(intent.getStringExtra(EXTRA_DEPT));
                uid = nz(intent.getStringExtra(EXTRA_UID));
                Prefs.put(this, "code", accessCode);
                Prefs.put(this, "dept", dept);
                Prefs.put(this, "uid", uid);
            }
        }

        if (ACTION_JOIN.equals(action)) {
            if (!goForeground()) {
                Log.w(TAG, "cannot enter foreground, stopping");
                Prefs.setActive(this, false);
                stopSelf();
                return START_NOT_STICKY;
            }
            startSession(server, name, channel);
        } else if (ACTION_LEAVE.equals(action)) {
            leaveAndStop();
            return START_NOT_STICKY;
        } else if (ACTION_TOGGLE_TALK.equals(action)) {
            if (active) toggleTalk();
        } else if (!active) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // App swiped away from recents: keep the radio running (this is the whole point).
        Log.i(TAG, "task removed, service keeps running");
    }

    @Override
    public void onDestroy() {
        if (active) teardown(false);
        if (audio != null) audio.release();
        main.removeCallbacksAndMessages(null);
        instance = null;
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }

    /** Enters the foreground. Microphone type only when RECORD_AUDIO is granted (Android 14 rule). */
    private boolean goForeground() {
        micAllowed = hasMicPermission();
        Notification n = buildNotification();
        // The microphone FGS type exists from Android 11 (API 30); older versions need no type for the mic.
        boolean micType = micAllowed && Build.VERSION.SDK_INT >= 30;
        int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        if (micType) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, n, type);
            return true;
        } catch (Exception e) {
            // e.g. restarted from the background: Android does not allow the microphone type then.
            Log.w(TAG, "startForeground(" + type + ") failed: " + e);
            if (micType) {
                try {
                    micAllowed = false;
                    ServiceCompat.startForeground(this, NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                    return true;
                } catch (Exception e2) {
                    Log.w(TAG, "startForeground(mediaPlayback) failed: " + e2);
                }
            }
            return false;
        }
    }

    private boolean hasMicPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    // ================================================================ session

    private void startSession(String server, String name, String channel) {
        Net.ServerAddr a;
        try {
            a = Net.ServerAddr.parse(server);
        } catch (IllegalArgumentException e) {
            emitToast(e.getMessage());
            leaveAndStop();
            return;
        }
        boolean sameServer = active && addr != null && a.base().equals(addr.base());
        addr = a;
        serverBase = a.base();
        myName = name != null ? name : "";
        wantChannel = channel;
        Prefs.saveSession(this, serverBase, myName, channel);

        if (!active) {
            active = true;
            acquireLocks();
            registerNetworkCallback();
            applyOptions();
        }
        if (sameServer && open) {
            sendJoin();
        } else {
            closeSocket();
            attempt = 0;
            connect();
        }
        updateNotification();
    }

    private void connect() {
        cancelReconnect();
        if (!active) return;
        final int g = ++gen;
        open = false;
        connReason = null;
        setConn("connecting");
        final Net.PinTrust tm;
        final OkHttpClient client;
        try {
            tm = new Net.PinTrust(Prefs.pin(this, addr.pinKey()));
            client = Net.withTrust(wsBase, tm).build();
        } catch (Exception e) {
            Log.e(TAG, "client setup failed", e);
            scheduleReconnect();
            return;
        }
        Request req = new Request.Builder().url(addr.wsUrl()).build();
        ws = client.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(@NonNull WebSocket w, @NonNull Response response) {
                main.post(() -> {
                    if (g != gen) return;
                    open = true;
                    sendJoin();
                });
            }

            @Override
            public void onMessage(@NonNull WebSocket w, @NonNull String text) {
                if (g != gen) return;
                JSONObject m;
                try {
                    m = new JSONObject(text);
                } catch (JSONException e) {
                    return;
                }
                String type = m.optString("type");
                // Audio-related cues go straight to the audio queue to stay in order with the PCM frames.
                if ("talk_start".equals(type)) {
                    audio.onRemoteTalkStart(m.optInt("rate", AudioEngine.MIC_RATE));
                } else if ("talk_end".equals(type) && !m.optString("name").equals(myName)) {
                    audio.beep(520, 100); // roger beep
                }
                main.post(() -> {
                    if (g == gen) onServerMessage(type, m);
                });
            }

            @Override
            public void onMessage(@NonNull WebSocket w, @NonNull ByteString bytes) {
                if (g == gen && !talking) audio.playPcm(bytes.toByteArray());
            }

            @Override
            public void onClosing(@NonNull WebSocket w, int code, @NonNull String reason) {
                w.close(1000, null);
            }

            @Override
            public void onClosed(@NonNull WebSocket w, int code, @NonNull String reason) {
                main.post(() -> onSocketDown(g, null));
            }

            @Override
            public void onFailure(@NonNull WebSocket w, @NonNull Throwable t, @Nullable Response response) {
                Log.w(TAG, "socket failure: " + t);
                final String reason = tm.untrusted ? "cert" : null;
                main.post(() -> onSocketDown(g, reason));
            }
        });
    }

    private void sendJoin() {
        JSObject j = new JSObject();
        j.put("type", "join");
        j.put("name", myName);
        if (wantChannel != null) j.put("channel", wantChannel);
        // extra fields for the Cloudflare server; the LAN server ignores them
        if (!accessCode.isEmpty()) j.put("code", accessCode);
        if (!dept.isEmpty()) j.put("dept", dept);
        if (!uid.isEmpty()) j.put("uid", uid);
        sendJson(j);
    }

    private void sendJson(JSONObject o) {
        WebSocket w = ws;
        if (w != null && open) w.send(o.toString());
    }

    private void onServerMessage(String type, JSONObject m) {
        switch (type) {
            case "joined":
                attempt = 0;
                lastJoined = copy(m);
                currentChannel = m.optString("channel");
                wantChannel = currentChannel;
                Prefs.saveChannel(this, currentChannel);
                setConn("online");
                break;
            case "state":
                lastState = copy(m);
                talker = m.isNull("talker") ? null : m.optString("talker", null);
                userCount = m.optJSONArray("users") != null ? m.optJSONArray("users").length() : 0;
                break;
            case "talk_granted":
                if (!wantTalk) { // released before the grant arrived
                    sendJson(msg("ptt_end"));
                    break;
                }
                talking = true;
                audio.beep(880, 80);
                vibrate(40);
                emitTalking();
                break;
            case "busy":
                wantTalk = false;
                latched = false;
                audio.stopCapture();
                audio.beep(220, 250);
                vibrate(60, 40, 60);
                emitTalking();
                break;
            case "talk_end":
                if (talking && myName.equals(m.optString("name"))) { // e.g. 60 s timeout
                    talking = false;
                    wantTalk = false;
                    latched = false;
                    audio.stopCapture();
                    emitTalking();
                }
                break;
            case "sos": {
                JSONObject sos = m.optJSONObject("sos");
                if (sos != null) {
                    String place = sos.optString("place");
                    postAlert(ALERT_CHANNEL, "🚨 แจ้งเหตุฉุกเฉิน: " + sos.optString("kind_name"),
                        sos.optString("reporter") + (place.isEmpty() ? "" : " · " + place) + (sos.optString("note").isEmpty() ? "" : "\n" + sos.optString("note")), true);
                    vibrate(600, 300, 600, 300, 600);
                }
                break;
            }
            case "notification": {
                JSONObject n = m.optJSONObject("notification");
                if (n != null) postAlert(INFO_CHANNEL, n.optString("title"), n.optString("body"), false);
                break;
            }
            case "error":
                if ("auth".equals(m.optString("code"))) { // wrong access code: stop instead of retrying forever
                    emit(type, m);
                    leaveAndStop();
                    return;
                }
                break;
            default:
                break;
        }
        emit(type, m);
        updateNotification();
    }

    private void onSocketDown(int g, String reason) {
        if (g != gen) return;
        open = false;
        ws = null;
        stopTalkingSilently();
        talker = null;
        if (!active) return;
        connReason = reason;
        scheduleReconnect();
    }

    private void scheduleReconnect() {
        cancelReconnect();
        if (!active) return;
        long base = Math.min(MAX_BACKOFF_MS, 1000L << Math.min(attempt, 5)); // 1,2,4,8,16,30 s
        long delay = (long) (base * (0.8 + Math.random() * 0.4));             // +-20 % jitter
        attempt++;
        reconnectTask = this::connect;
        main.postDelayed(reconnectTask, delay);
        JSObject e = new JSObject();
        e.put("nextMs", delay);
        e.put("attempt", attempt);
        setConn("reconnecting", e);
    }

    private void cancelReconnect() {
        if (reconnectTask != null) main.removeCallbacks(reconnectTask);
        reconnectTask = null;
    }

    private void closeSocket() {
        gen++;
        WebSocket w = ws;
        ws = null;
        open = false;
        if (w != null) w.cancel();
    }

    void requestSwitchChannel(String channel) {
        main.post(() -> {
            if (!active) return;
            stopTalkingSilently();
            wantChannel = channel;
            Prefs.saveChannel(this, channel);
            if (open) sendJoin();
        });
    }

    void requestLeave() { main.post(this::leaveAndStop); }

    /** Forwards a UI message (chat / react / roster) on the single WebSocket. */
    void requestSend(JSONObject msg) {
        main.post(() -> {
            String t = msg.optString("type");
            if (t.equals("chat") || t.equals("react") || t.equals("roster")) sendJson(msg);
        });
    }

    private static String nz(String s) { return s != null ? s : ""; }

    private void leaveAndStop() {
        if (active) {
            if (open) sendJson(msg("leave"));
            WebSocket w = ws;
            gen++;
            ws = null;
            open = false;
            if (w != null) w.close(1000, "leave");
            teardown(true);
        }
        Prefs.setActive(this, false);
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void teardown(boolean notifyUi) {
        active = false;
        cancelReconnect();
        stopTalkingSilently();
        closeSocket();
        unregisterNetworkCallback();
        releaseMediaSession();
        unregisterRugged();
        releaseLocks();
        lastJoined = null;
        lastState = null;
        talker = null;
        currentChannel = null;
        connState = "offline";
        if (notifyUi) emit("left", new JSObject());
    }

    // ================================================================ push-to-talk

    void requestPtt(boolean down) { main.post(() -> { if (down) pttDown(); else pttUp(); }); }

    private void pttDown() {
        if (wantTalk) return;
        if (!active || !open) {
            emitTalking(); // let the UI drop its "waiting" state
            return;
        }
        if (!micAllowed) {
            if (hasMicPermission()) goForeground(); // re-enter foreground with the microphone type
            if (!micAllowed) {
                audio.beep(220, 250);
                emitToast("ไม่มีสิทธิ์ใช้ไมโครโฟน: เปิดแอปแล้วอนุญาตไมโครโฟน จากนั้นเข้าช่องใหม่");
                return;
            }
        }
        wantTalk = true;
        audio.startCapture(); // start the mic now; frames are only sent after talk_granted
        JSObject m = msg("ptt_start");
        m.put("rate", AudioEngine.MIC_RATE);
        sendJson(m);
        emitTalking();
    }

    private void pttUp() {
        if (!wantTalk) return;
        wantTalk = false;
        latched = false;
        if (talking) {
            sendJson(msg("ptt_end"));
            audio.beep(440, 60);
        }
        talking = false;
        audio.stopCapture();
        emitTalking();
        updateNotification();
    }

    private void stopTalkingSilently() {
        if (!wantTalk && !talking) return;
        wantTalk = false;
        talking = false;
        latched = false;
        audio.stopCapture();
        emitTalking();
    }

    private void toggleTalk() {
        if (wantTalk) {
            pttUp();
        } else {
            pttDown();
            latched = wantTalk;
        }
        updateNotification();
    }

    /**
     * Hardware key (headset button or rugged PTT key), main thread.
     * Hold = talk while held. A short tap latches talking on until the next press,
     * which also suits Bluetooth headsets that only send a quick press+release.
     */
    void onHardKey(boolean down) {
        if (!active) return;
        long now = SystemClock.uptimeMillis();
        if (down) {
            if (latched) {
                latched = false;
                ignoreNextUp = true;
                pttUp();
                return;
            }
            keyDownAt = now;
            pttDown();
        } else {
            if (ignoreNextUp) {
                ignoreNextUp = false;
                return;
            }
            if (!wantTalk) return;
            if (now - keyDownAt < TAP_TOGGLE_MS) {
                latched = true;
                updateNotification();
            } else {
                pttUp();
            }
        }
    }

    static boolean isRuggedKeyCode(int code) {
        for (int c : RUGGED_KEYCODES) if (c == code) return true;
        return false;
    }

    static boolean isHeadsetKeyCode(int code) {
        return code == KeyEvent.KEYCODE_HEADSETHOOK
            || code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
            || code == KeyEvent.KEYCODE_MEDIA_PLAY
            || code == KeyEvent.KEYCODE_MEDIA_PAUSE;
    }

    boolean wantsKey(int code) {
        if (!active) return false;
        if (isHeadsetKeyCode(code)) return Prefs.headsetPtt(this);
        if (isRuggedKeyCode(code)) return Prefs.ruggedPtt(this);
        return false;
    }

    // ================================================================ options / hardware buttons

    void requestApplyOptions() { main.post(this::applyOptions); }

    private void applyOptions() {
        if (!active) return;
        if (Prefs.headsetPtt(this)) setupMediaSession(); else releaseMediaSession();
        if (Prefs.ruggedPtt(this)) registerRugged(); else unregisterRugged();
    }

    private void setupMediaSession() {
        if (mediaSession != null) return;
        mediaSession = new MediaSession(this, "WalkiePTT");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public boolean onMediaButtonEvent(@NonNull Intent intent) {
                KeyEvent ke = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_KEY_EVENT, KeyEvent.class);
                if (ke == null || !isHeadsetKeyCode(ke.getKeyCode())) return super.onMediaButtonEvent(intent);
                if (ke.getAction() == KeyEvent.ACTION_DOWN && ke.getRepeatCount() == 0) onHardKey(true);
                else if (ke.getAction() == KeyEvent.ACTION_UP) onHardKey(false);
                return true;
            }
        }, main);
        if (Build.VERSION.SDK_INT < 26) {
            //noinspection deprecation
            mediaSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        }
        // "Playing" state keeps media buttons routed to us while the screen is off.
        mediaSession.setPlaybackState(new PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE)
            .setState(PlaybackState.STATE_PLAYING, 0, 1f)
            .build());
        mediaSession.setActive(true);
    }

    private void releaseMediaSession() {
        if (mediaSession == null) return;
        mediaSession.setActive(false);
        mediaSession.release();
        mediaSession = null;
    }

    private void registerRugged() {
        if (ruggedReceiver != null) return;
        ruggedReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String a = intent.getAction();
                if (a == null) return;
                switch (a) {
                    case KNOX_HARD_KEY_REPORT: {
                        int t = intent.getIntExtra(KNOX_EXTRA_REPORT_TYPE, 0); // 1 = press, 2 = release
                        if (t == 1) onHardKey(true);
                        else if (t == 2) onHardKey(false);
                        break;
                    }
                    case SONIM_PTT_DOWN:
                    case GENERIC_PTT_DOWN:
                        onHardKey(true);
                        break;
                    case SONIM_PTT_UP:
                    case GENERIC_PTT_UP:
                        onHardKey(false);
                        break;
                    default:
                        break;
                }
            }
        };
        IntentFilter f = new IntentFilter();
        f.addAction(KNOX_HARD_KEY_REPORT);
        f.addAction(SONIM_PTT_DOWN);
        f.addAction(SONIM_PTT_UP);
        f.addAction(GENERIC_PTT_DOWN);
        f.addAction(GENERIC_PTT_UP);
        // Exported: these come from system/vendor components. That is why the option is off by default.
        ContextCompat.registerReceiver(this, ruggedReceiver, f, ContextCompat.RECEIVER_EXPORTED);
    }

    private void unregisterRugged() {
        if (ruggedReceiver == null) return;
        try {
            unregisterReceiver(ruggedReceiver);
        } catch (Exception ignored) {}
        ruggedReceiver = null;
    }

    // ================================================================ locks / network

    private void acquireLocks() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null && wakeLock == null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "walkie:link");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(); // held only while joined; released on leave
        }
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        if (wm != null && wifiLock == null) {
            // There is no "partial" Wi-Fi lock; HIGH_PERF keeps the radio awake with the screen off.
            //noinspection deprecation
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "walkie:link");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        }
    }

    private void releaseLocks() {
        if (wakeLock != null) {
            if (wakeLock.isHeld()) wakeLock.release();
            wakeLock = null;
        }
        if (wifiLock != null) {
            if (wifiLock.isHeld()) wifiLock.release();
            wifiLock = null;
        }
    }

    private void registerNetworkCallback() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm == null || netCallback != null) return;
        netCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                // Network is back: skip the remaining backoff and reconnect now.
                main.post(() -> {
                    if (active && reconnectTask != null) {
                        attempt = 0;
                        connect();
                    }
                });
            }

            @Override
            public void onLost(@NonNull Network network) {
                // The socket on the lost network is dead; fail fast instead of waiting for the ping.
                main.post(() -> {
                    if (active && ws != null) ws.cancel();
                });
            }
        };
        try {
            cm.registerDefaultNetworkCallback(netCallback);
        } catch (Exception e) {
            Log.w(TAG, "network callback failed: " + e);
            netCallback = null;
        }
    }

    private void unregisterNetworkCallback() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm != null && netCallback != null) {
            try {
                cm.unregisterNetworkCallback(netCallback);
            } catch (Exception ignored) {}
        }
        netCallback = null;
    }

    // ================================================================ notification

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel ch = new NotificationChannel(NOTIF_CHANNEL, "สถานะวอ (ทำงานเบื้องหลัง)", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("แสดงช่องที่เข้าอยู่และคนที่กำลังพูด");
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            nm.createNotificationChannel(ch);
            NotificationChannel sos = new NotificationChannel(ALERT_CHANNEL, "แจ้งเหตุฉุกเฉิน (SOS)", NotificationManager.IMPORTANCE_HIGH);
            sos.setDescription("เสียงเตือนเมื่อมีคนแจ้งเหตุฉุกเฉิน");
            sos.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            sos.enableVibration(true);
            sos.setVibrationPattern(new long[] { 0, 600, 300, 600, 300, 600 });
            sos.setSound(android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_ALARM),
                new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_ALARM).build());
            sos.setBypassDnd(true);
            nm.createNotificationChannel(sos);
            NotificationChannel info = new NotificationChannel(INFO_CHANNEL, "งานและประกาศ", NotificationManager.IMPORTANCE_DEFAULT);
            nm.createNotificationChannel(info);
        }
    }

    /** SOS / task / announcement notification (separate from the ongoing service notification). */
    private void postAlert(String channel, String title, String body, boolean urgent) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent open = PendingIntent.getActivity(this, 3, new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP), flags);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_stat_walkie)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(urgent ? NotificationCompat.PRIORITY_MAX : NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(urgent ? NotificationCompat.CATEGORY_ALARM : NotificationCompat.CATEGORY_MESSAGE);
        if (urgent) b.setColor(0xFFC81E1E).setFullScreenIntent(open, true);
        nm.notify(alertSeq++, b.build());
    }

    private Notification buildNotification() {
        String title = currentChannel != null ? currentChannel : (wantChannel != null ? wantChannel : "วอภายใน");
        String text;
        if ("online".equals(connState)) {
            if (talking) text = "🔴 คุณกำลังพูด" + (latched ? " (กดอีกครั้งเพื่อจบ)" : "");
            else if (talker != null) text = "🟢 " + talker + " กำลังพูด";
            else text = "พร้อมรับฟัง · " + userCount + " คนในช่อง";
        } else if ("cert".equals(connReason)) {
            text = "⚠️ ใบรับรองเซิร์ฟเวอร์ไม่ตรง เปิดแอปเพื่อตรวจสอบ";
        } else if ("reconnecting".equals(connState)) {
            text = "สัญญาณหลุด กำลังเชื่อมต่อใหม่…";
        } else {
            text = "กำลังเชื่อมต่อ…";
        }
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        Intent openApp = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentPi = PendingIntent.getActivity(this, 0, openApp, flags);
        PendingIntent leavePi = PendingIntent.getService(this, 1, new Intent(this, WalkieService.class).setAction(ACTION_LEAVE), flags);
        PendingIntent talkPi = PendingIntent.getService(this, 2, new Intent(this, WalkieService.class).setAction(ACTION_TOGGLE_TALK), flags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, NOTIF_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_walkie)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(contentPi)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        if (talking) b.setColor(0xFFC62828);
        else if (talker != null) b.setColor(0xFF1B7A43);
        if (open && micAllowed) b.addAction(0, wantTalk ? "หยุดพูด" : "กดพูด", talkPi);
        b.addAction(0, "ออกจากช่อง", leavePi);
        return b.build();
    }

    private void updateNotification() {
        if (!active) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIF_ID, buildNotification());
    }

    // ================================================================ events to the web UI

    private void setConn(String state) { setConn(state, new JSObject()); }

    private void setConn(String state, JSObject extra) {
        connState = state;
        extra.put("state", state);
        if (connReason != null) extra.put("reason", connReason);
        emit("conn", extra);
        updateNotification();
    }

    private void emitTalking() {
        JSObject e = new JSObject();
        e.put("talking", talking);
        e.put("want", wantTalk);
        e.put("latched", latched);
        emit("talking", e);
    }

    private void emitToast(String text) {
        JSObject e = new JSObject();
        e.put("text", text);
        emit("toast", e);
    }

    private void emit(String type, JSONObject payload) {
        Listener l = listener;
        if (l == null) return;
        JSObject e = copy(payload);
        e.put("type", type);
        l.onWalkieEvent(e);
    }

    /** Snapshot for the UI when it (re)opens while the service is running. Main thread. */
    JSObject snapshot() {
        JSObject s = new JSObject();
        s.put("active", active);
        s.put("conn", connState);
        if (connReason != null) s.put("reason", connReason);
        s.put("server", serverBase);
        s.put("name", myName);
        s.put("channel", currentChannel != null ? currentChannel : wantChannel);
        if (lastJoined != null) s.put("joined", lastJoined);
        if (lastState != null) s.put("state", lastState);
        s.put("talking", talking);
        s.put("want", wantTalk);
        s.put("micAllowed", micAllowed);
        return s;
    }

    void post(Runnable r) { main.post(r); }

    // ================================================================ helpers

    private static JSObject msg(String type) {
        JSObject o = new JSObject();
        o.put("type", type);
        return o;
    }

    private static JSObject copy(JSONObject o) {
        try {
            return JSObject.fromJSONObject(o);
        } catch (JSONException e) {
            return new JSObject();
        }
    }

    private void vibrate(long... pattern) {
        Vibrator v;
        if (Build.VERSION.SDK_INT >= 31) {
            VibratorManager vm = (VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE);
            v = vm != null ? vm.getDefaultVibrator() : null;
        } else {
            //noinspection deprecation
            v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        }
        if (v == null || !v.hasVibrator()) return;
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                if (pattern.length == 1) v.vibrate(VibrationEffect.createOneShot(pattern[0], VibrationEffect.DEFAULT_AMPLITUDE));
                else {
                    long[] p = new long[pattern.length + 1]; // leading 0 = start immediately
                    System.arraycopy(pattern, 0, p, 1, pattern.length);
                    v.vibrate(VibrationEffect.createWaveform(p, -1));
                }
            } else {
                //noinspection deprecation
                v.vibrate(pattern[0]);
            }
        } catch (Exception ignored) {}
    }
}
