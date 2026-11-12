package th.co.walkie.app;

import android.annotation.SuppressLint;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.os.Build;
import android.util.Log;

import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Half-duplex audio for the walkie-talkie:
 *  - playback: 16-bit mono PCM chunks from the server -> AudioTrack (own thread, small jitter cushion)
 *  - capture: AudioRecord 16 kHz mono PCM16, 40 ms chunks -> {@link Sink#onPcm}
 *  - beeps are synthesized into the same playback queue so they also play with the screen off.
 * Byte order is little-endian on both ends (same as the web client's Int16Array).
 */
final class AudioEngine {
    interface Sink {
        void onPcm(byte[] buf, int len);   // capture thread
        void onLevel(float peak);           // capture or playback thread
    }

    static final int MIC_RATE = 16000;
    private static final String TAG = "WalkieAudio";
    private static final int IDLE_PAUSE_MS = 1500;
    private static final int CUSHION_MS = 80;

    private static final class Chunk {
        final byte[] pcm;
        final int rate;
        final boolean beep;
        Chunk(byte[] pcm, int rate, boolean beep) { this.pcm = pcm; this.rate = rate; this.beep = beep; }
    }
    private static final Chunk STOP = new Chunk(new byte[0], 0, false);

    private final AudioManager am;
    private final Sink sink;
    private final LinkedBlockingQueue<Chunk> queue = new LinkedBlockingQueue<>();
    private final Thread playThread;
    private volatile int rxRate = MIC_RATE;
    private volatile int captureGen = 0;
    private AudioFocusRequest focusRequest; // API 26+
    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {};

    AudioEngine(Context ctx, Sink sink) {
        this.am = (AudioManager) ctx.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
        this.sink = sink;
        playThread = new Thread(this::playLoop, "walkie-play");
        playThread.start();
    }

    // ------------------------------------------------------------ playback

    /** Server said someone started talking; {@code rate} is the PCM sample rate they send. */
    void onRemoteTalkStart(int rate) {
        if (rate >= 8000 && rate <= 48000) rxRate = rate;
        beep(660, 60);
    }

    void playPcm(byte[] pcm) {
        int len = pcm.length & ~1; // whole 16-bit samples only
        if (len == 0) return;
        if (len != pcm.length) {
            byte[] t = new byte[len];
            System.arraycopy(pcm, 0, t, 0, len);
            pcm = t;
        }
        if (queue.size() > 200) queue.clear(); // >8 s behind: drop instead of lagging forever
        queue.offer(new Chunk(pcm, rxRate, false));
    }

    /** Short sine tone with decay, like the web version's beep(). */
    void beep(int freq, int ms) {
        int rate = rxRate;
        int n = rate * ms / 1000;
        byte[] b = new byte[n * 2];
        for (int i = 0; i < n; i++) {
            double t = (double) i / rate;
            double env = Math.exp(-5.0 * i / n) * Math.min(1.0, i / (rate * 0.003)); // 3 ms attack, decay
            short s = (short) (Math.sin(2 * Math.PI * freq * t) * env * 0.3 * Short.MAX_VALUE);
            b[2 * i] = (byte) (s & 0xff);
            b[2 * i + 1] = (byte) ((s >> 8) & 0xff);
        }
        queue.offer(new Chunk(b, rate, true));
    }

    private void playLoop() {
        AudioTrack track = null;
        int trackRate = 0;
        boolean playing = false;
        try {
            while (true) {
                Chunk c = queue.poll(IDLE_PAUSE_MS, TimeUnit.MILLISECONDS);
                if (c == STOP) break;
                if (c == null) {
                    if (playing && track != null) {
                        track.pause();
                        track.flush();
                        playing = false;
                        abandonFocus();
                    }
                    continue;
                }
                if (track == null || trackRate != c.rate) {
                    if (track != null) track.release();
                    track = createTrack(c.rate);
                    trackRate = c.rate;
                    playing = false;
                    if (track == null) continue;
                }
                if (!playing) {
                    requestFocus();
                    track.play();
                    playing = true;
                    track.write(new byte[c.rate * CUSHION_MS / 1000 * 2], 0, c.rate * CUSHION_MS / 1000 * 2);
                }
                track.write(c.pcm, 0, c.pcm.length);
                if (!c.beep) sink.onLevel(peak(c.pcm, c.pcm.length));
            }
        } catch (InterruptedException ignored) {
        } catch (Exception e) {
            Log.e(TAG, "playback stopped", e);
        } finally {
            if (track != null) {
                try { track.stop(); } catch (Exception ignored) {}
                track.release();
            }
            abandonFocus();
        }
    }

    private static AudioTrack createTrack(int rate) {
        try {
            int min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA) // loudspeaker / headset at media volume
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
            AudioFormat fmt = new AudioFormat.Builder()
                .setSampleRate(rate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .build();
            return new AudioTrack.Builder()
                .setAudioAttributes(attrs)
                .setAudioFormat(fmt)
                .setBufferSizeInBytes(Math.max(min, rate)) // ~500 ms of 16-bit audio
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
        } catch (Exception e) {
            Log.e(TAG, "AudioTrack create failed", e);
            return null;
        }
    }

    private void requestFocus() {
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest == null) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                    .setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build())
                    .setOnAudioFocusChangeListener(focusListener)
                    .build();
            }
            am.requestAudioFocus(focusRequest);
        } else {
            am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
        }
    }

    private void abandonFocus() {
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusRequest != null) am.abandonAudioFocusRequest(focusRequest);
        } else {
            am.abandonAudioFocus(focusListener);
        }
    }

    // ------------------------------------------------------------ capture

    boolean isCapturing() { return (captureGen & 1) == 1; }

    /** Starts the mic. Caller must hold RECORD_AUDIO (checked by the service). */
    @SuppressLint("MissingPermission")
    synchronized void startCapture() {
        if (isCapturing()) return;
        final int gen = ++captureGen; // odd = capturing
        Thread t = new Thread(() -> {
            AudioRecord rec = null;
            try {
                int min = AudioRecord.getMinBufferSize(MIC_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                rec = new AudioRecord(
                    MediaRecorder.AudioSource.VOICE_COMMUNICATION, // echo cancel + noise suppression on most phones
                    MIC_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    Math.max(min, MIC_RATE * 2 / 2) // >= 500 ms
                );
                if (rec.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("AudioRecord not initialized");
                rec.startRecording();
                byte[] buf = new byte[MIC_RATE * 2 * 40 / 1000]; // 40 ms = 1280 bytes
                while (captureGen == gen) {
                    int n = rec.read(buf, 0, buf.length);
                    if (n < 0) {
                        Log.w(TAG, "AudioRecord.read error " + n);
                        break;
                    }
                    if (n > 0 && captureGen == gen) {
                        sink.onPcm(buf, n);
                        sink.onLevel(peak(buf, n));
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "capture failed", e);
            } finally {
                if (rec != null) {
                    try { rec.stop(); } catch (Exception ignored) {}
                    rec.release();
                }
            }
        }, "walkie-rec");
        t.start();
    }

    synchronized void stopCapture() {
        if (isCapturing()) captureGen++; // even = stopped; the thread exits on next read
    }

    // ------------------------------------------------------------ misc

    void release() {
        stopCapture();
        queue.clear();
        queue.offer(STOP);
    }

    private static float peak(byte[] b, int len) {
        int max = 0;
        for (int i = 0; i + 1 < len; i += 2) {
            int s = (short) ((b[i] & 0xff) | (b[i + 1] << 8));
            if (s < 0) s = -s;
            if (s > max) max = s;
        }
        return max / 32768f;
    }
}
