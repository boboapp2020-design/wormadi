package th.co.walkie.app;

import android.content.Context;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.UnknownHostException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Server address parsing, TLS with trust-on-first-use certificate pinning (for self-signed
 * wss inside the LAN) and the "probe" request used by the setup screen.
 */
final class Net {
    private Net() {}

    // ---------------------------------------------------------------- address

    static final class ServerAddr {
        final boolean secure;
        final boolean explicitScheme;
        final String host;
        final int port;

        ServerAddr(boolean secure, boolean explicitScheme, String host, int port) {
            this.secure = secure;
            this.explicitScheme = explicitScheme;
            this.host = host;
            this.port = port;
        }

        ServerAddr withSecure(boolean s) { return new ServerAddr(s, explicitScheme, host, port); }

        String hostPort() { return (host.contains(":") ? "[" + host + "]" : host) + ":" + port; }

        /** Canonical form stored by the app, e.g. https://192.168.1.10:3000 */
        String base() { return (secure ? "https://" : "http://") + hostPort(); }

        String wsUrl() { return (secure ? "wss://" : "ws://") + hostPort() + "/"; }

        /** Key used for the pinned certificate. */
        String pinKey() { return hostPort().toLowerCase(Locale.ROOT); }

        /**
         * Accepts "192.168.1.10:3000", "walkie.local", "wss://10.0.0.5:3000", "https://host" ...
         * Without a scheme the default port is 3000 (the demo server's default) and the probe
         * tries https first, then http.
         */
        static ServerAddr parse(String input) {
            if (input == null) throw new IllegalArgumentException("ยังไม่ได้ใส่ที่อยู่เซิร์ฟเวอร์");
            String s = input.trim();
            if (s.isEmpty()) throw new IllegalArgumentException("ยังไม่ได้ใส่ที่อยู่เซิร์ฟเวอร์");
            boolean explicit = false, secure = true;
            String lower = s.toLowerCase(Locale.ROOT);
            String[][] schemes = { { "wss://", "1" }, { "https://", "1" }, { "ws://", "0" }, { "http://", "0" } };
            for (String[] sc : schemes) {
                if (lower.startsWith(sc[0])) {
                    explicit = true;
                    secure = sc[1].equals("1");
                    s = s.substring(sc[0].length());
                    break;
                }
            }
            URI uri;
            try {
                uri = URI.create("x://" + s);
            } catch (IllegalArgumentException e) {
                throw new IllegalArgumentException("ที่อยู่เซิร์ฟเวอร์ไม่ถูกต้อง");
            }
            String host = uri.getHost();
            if (host == null || host.isEmpty()) throw new IllegalArgumentException("ที่อยู่เซิร์ฟเวอร์ไม่ถูกต้อง");
            if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
            int port = uri.getPort();
            if (port <= 0) port = explicit ? (secure ? 443 : 80) : 3000;
            return new ServerAddr(secure, explicit, host, port);
        }
    }

    // ---------------------------------------------------------------- TLS

    static String sha256(X509Certificate cert) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(cert.getEncoded());
            StringBuilder sb = new StringBuilder(d.length * 3);
            for (int i = 0; i < d.length; i++) {
                if (i > 0) sb.append(':');
                sb.append(String.format(Locale.ROOT, "%02X", d[i] & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    static X509TrustManager systemTrustManager() {
        try {
            TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init((KeyStore) null);
            for (TrustManager tm : tmf.getTrustManagers()) {
                if (tm instanceof X509TrustManager) return (X509TrustManager) tm;
            }
        } catch (Exception ignored) {}
        throw new IllegalStateException("no system trust manager");
    }

    /**
     * Accepts a certificate if it is trusted by the system OR its SHA-256 equals the pin the user
     * confirmed earlier. Records what it saw so the UI can show the fingerprint.
     */
    static final class PinTrust implements X509TrustManager {
        private final X509TrustManager system;
        final String pin; // may be null
        volatile String seenSha;
        volatile String seenSubject;
        volatile boolean untrusted;
        volatile boolean pinMatched;

        PinTrust(String pin) {
            this.system = systemTrustManager();
            this.pin = pin;
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            system.checkClientTrusted(chain, authType);
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0) throw new CertificateException("empty certificate chain");
            seenSha = sha256(chain[0]);
            seenSubject = chain[0].getSubjectX500Principal().getName();
            if (pin != null && pin.equalsIgnoreCase(seenSha)) {
                pinMatched = true;
                return;
            }
            try {
                system.checkServerTrusted(chain, authType);
            } catch (CertificateException e) {
                untrusted = true;
                throw e;
            }
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return system.getAcceptedIssuers();
        }
    }

    /** Derives a client that uses {@code tm}. A pinned cert also skips hostname checks (the pin is stronger). */
    static OkHttpClient.Builder withTrust(OkHttpClient base, PinTrust tm) throws Exception {
        SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[] { tm }, null);
        return base
            .newBuilder()
            .sslSocketFactory(ctx.getSocketFactory(), tm)
            .hostnameVerifier((host, session) -> {
                if (tm.pin != null) {
                    try {
                        Certificate[] certs = session.getPeerCertificates();
                        if (certs.length > 0 && certs[0] instanceof X509Certificate && tm.pin.equalsIgnoreCase(sha256((X509Certificate) certs[0]))) {
                            return true;
                        }
                    } catch (SSLPeerUnverifiedException ignored) {}
                }
                return HttpsURLConnection.getDefaultHostnameVerifier().verify(host, session);
            });
    }

    // ---------------------------------------------------------------- probe

    private static volatile OkHttpClient probeBase;

    private static OkHttpClient probeBase() {
        if (probeBase == null) {
            probeBase = new OkHttpClient.Builder()
                .connectTimeout(4, TimeUnit.SECONDS)
                .readTimeout(4, TimeUnit.SECONDS)
                .callTimeout(8, TimeUnit.SECONDS)
                .build();
        }
        return probeBase;
    }

    private static final class PlainHttpServer extends Exception {}

    /** Blocking. Fetches /api/channels and reports TLS status. Run off the main thread. */
    static JSObject probe(Context ctx, String input) throws Exception {
        ServerAddr a = ServerAddr.parse(input);
        if (a.explicitScheme) return probeOnce(ctx, a);
        try {
            return probeOnce(ctx, a.withSecure(true));
        } catch (PlainHttpServer e) {
            return probeOnce(ctx, a.withSecure(false));
        }
    }

    private static JSObject probeOnce(Context ctx, ServerAddr a) throws Exception {
        PinTrust tm = new PinTrust(Prefs.pin(ctx, a.pinKey()));
        OkHttpClient client = withTrust(probeBase(), tm).build();
        Request req = new Request.Builder().url(a.base() + "/api/channels").build();
        JSObject out = new JSObject();
        out.put("base", a.base());
        out.put("secure", a.secure);
        try (Response resp = client.newCall(req).execute()) {
            if (!resp.isSuccessful()) throw new IOException("เซิร์ฟเวอร์ตอบกลับ HTTP " + resp.code() + " (ใช่เซิร์ฟเวอร์วอหรือไม่?)");
            ResponseBody body = resp.body();
            JSONArray list = new JSONArray(body != null ? body.string() : "[]");
            JSArray channels = new JSArray();
            for (int i = 0; i < list.length(); i++) {
                JSONObject c = list.getJSONObject(i);
                JSObject o = new JSObject();
                o.put("name", c.optString("name"));
                o.put("users", c.optInt("users"));
                channels.put(o);
            }
            out.put("ok", true);
            out.put("channels", channels);
            if (a.secure) {
                out.put("cert", tm.pinMatched ? "pinned" : "system");
                out.put("sha256", tm.seenSha);
            }
            return out;
        } catch (IOException e) {
            if (hasCause(e, SSLException.class)) {
                if (tm.untrusted && tm.seenSha != null) {
                    out.put("ok", false);
                    out.put("needTrust", true);
                    out.put("sha256", tm.seenSha);
                    out.put("subject", tm.seenSubject);
                    out.put("pinChanged", tm.pin != null);
                    return out;
                }
                // TLS handshake failed before any certificate: it's a plain http server.
                if (a.secure && tm.seenSha == null && !a.explicitScheme) throw new PlainHttpServer();
            }
            throw e;
        }
    }

    static boolean hasCause(Throwable t, Class<? extends Throwable> type) {
        for (int i = 0; t != null && i < 8; i++, t = t.getCause()) {
            if (type.isInstance(t)) return true;
        }
        return false;
    }

    /** Short Thai message for the UI. */
    static String friendly(Throwable e) {
        if (e instanceof IllegalArgumentException) return e.getMessage();
        if (hasCause(e, UnknownHostException.class)) return "ไม่พบเครื่องเซิร์ฟเวอร์ ตรวจที่อยู่อีกครั้ง";
        if (hasCause(e, ConnectException.class)) return "เชื่อมต่อไม่ได้ (เซิร์ฟเวอร์ไม่ได้เปิด หรือพอร์ตไม่ถูก)";
        if (hasCause(e, SocketTimeoutException.class)) return "หมดเวลาเชื่อมต่อ (อยู่คนละ Wi-Fi หรือไฟร์วอลล์บล็อก?)";
        if (hasCause(e, SSLException.class)) return "เชื่อมต่อแบบเข้ารหัสไม่สำเร็จ: " + e.getMessage();
        if (e instanceof org.json.JSONException) return "ข้อมูลจากเซิร์ฟเวอร์ไม่ถูกต้อง (ใช่เซิร์ฟเวอร์วอหรือไม่?)";
        String m = e.getMessage();
        return m != null ? m : e.getClass().getSimpleName();
    }
}
