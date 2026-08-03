package net.bh1jss.fmodashboard;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * FmoWavRecorder: 接收音频流（8kHz/16bit/单声道 PCM）的 WAV 录制器。
 *
 * 数据由 FmoAudioPlugin.handlePcm 在收到音频分片时喂入（与是否静音无关，
 * 静音只是播放输出置零，原始流仍可录制）。手动/自动分段共用同一台录音机。
 * 文件保存在应用外部目录 Recordings/ 下，元数据写入 SharedPreferences 索引。
 */
public final class FmoWavRecorder {

    private static final String TAG = "FmoWavRecorder";
    private static final int SAMPLE_RATE = 8000;
    private static final String PREFS_NAME = "fmo_recordings";
    private static final String KEY_INDEX = "recordings";
    private static final String DIR_NAME = "Recordings";

    // 始终录制（有声音就录）VAD 参数
    private static final double VAD_THRESHOLD = 200;
    private static final long VAD_START_HANG_MS = 400;
    private static final long VAD_STOP_HANG_MS = 1500;

    private static volatile FmoWavRecorder sInstance;

    private Context appCtx;
    private FileOutputStream fos;
    private File currentFile;
    private String callsign = "";
    private String serverName = "";
    private String source = "manual";
    private long startTime;
    private long dataBytes;

    // VAD 状态
    private volatile boolean alwaysRecordMode = false;
    private boolean vadActive = false;
    private long soundMs = 0;
    private long silenceMs = 0;

    public static FmoWavRecorder get() {
        if (sInstance == null) sInstance = new FmoWavRecorder();
        return sInstance;
    }

    public static File getRecordingsDir(Context ctx) {
        File base = ctx.getExternalFilesDir(null);
        if (base == null) base = ctx.getFilesDir();
        File dir = new File(base, DIR_NAME);
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    public synchronized boolean isActive() {
        return fos != null;
    }

    /** 开启/关闭"始终录制（有声音就录）"。关闭时结束当前 VAD 段并保存。 */
    public synchronized void setAlwaysRecordMode(boolean on) {
        alwaysRecordMode = on;
        if (!on) {
            RecordingItem item = stopInternal();
            if (item != null && appCtx != null) addToIndex(appCtx, item);
        } else {
            vadActive = false;
            soundMs = 0;
            silenceMs = 0;
        }
        Log.i(TAG, "setAlwaysRecordMode -> " + on);
    }

    public synchronized void start(Context ctx, String cs, String sn, String src) {
        stopInternal(); // 若上次未正常结束，先收尾
        startInternal(ctx.getApplicationContext(), cs, sn, src);
    }

    private void startInternal(Context ctx, String cs, String sn, String src) {
        appCtx = ctx;
        File dir = getRecordingsDir(ctx);
        File f = new File(dir, buildFileName(cs, sn, System.currentTimeMillis()));
        try {
            fos = new FileOutputStream(f);
            fos.write(new byte[44]); // 占位 WAV 头
            currentFile = f;
            callsign = cs == null ? "" : cs;
            serverName = sn == null ? "" : sn;
            source = src == null ? "manual" : src;
            startTime = System.currentTimeMillis();
            dataBytes = 0;
            Log.i(TAG, "start -> " + f.getAbsolutePath());
        } catch (Exception e) {
            Log.w(TAG, "start failed", e);
            fos = null;
            currentFile = null;
        }
    }

    public synchronized void feed(byte[] pcm, int len) {
        if (len <= 0) return;
        // 录音中：写入数据
        if (fos != null) {
            try {
                fos.write(pcm, 0, len);
                dataBytes += len;
            } catch (Exception e) {
                Log.w(TAG, "feed failed", e);
            }
        }
        // 始终录制模式：VAD 自动开始/结束分段
        if (alwaysRecordMode && fos == null) {
            long now = System.currentTimeMillis();
            long chunkMs = Math.max(1, (long) ((len / 2.0) * 1000.0 / SAMPLE_RATE));
            if (rms(pcm, len) >= VAD_THRESHOLD) {
                soundMs += chunkMs;
                silenceMs = 0;
            } else {
                silenceMs += chunkMs;
                soundMs = 0;
            }
            if (!vadActive && soundMs >= VAD_START_HANG_MS) {
                vadActive = true;
                silenceMs = 0;
                String[] label = FmoEventsPlugin.getRecordingLabel();
                startInternal(appCtx, label[0], label[1], "auto");
            } else if (vadActive && silenceMs >= VAD_STOP_HANG_MS) {
                vadActive = false;
                soundMs = 0;
                RecordingItem item = stopInternal();
                if (item != null && appCtx != null) addToIndex(appCtx, item);
            }
        }
    }

    /** 计算一段 16bit PCM 的 RMS（用于 VAD） */
    private static double rms(byte[] pcm, int len) {
        int n = len / 2;
        if (n <= 0) return 0;
        long sum = 0;
        for (int i = 0; i < n; i++) {
            short s = (short) (((pcm[i * 2 + 1] & 0xff) << 8) | (pcm[i * 2] & 0xff));
            sum += (long) s * s;
        }
        return Math.sqrt(sum / (double) n);
    }

    /** 停止并返回录音元信息；无进行中录音返回 null */
    public synchronized RecordingItem stop() {
        RecordingItem item = stopInternal();
        if (item != null && appCtx != null) {
            addToIndex(appCtx, item);
        }
        return item;
    }

    private RecordingItem stopInternal() {
        if (fos == null) return null;
        try { fos.flush(); } catch (Exception ignore) {}
        try { fos.close(); } catch (Exception ignore) {}
        fos = null;
        long bytes = dataBytes;
        long started = startTime;
        String cs = callsign;
        String sn = serverName;
        String src = source;
        File f = currentFile;
        currentFile = null;
        callsign = "";
        serverName = "";
        source = "manual";
        if (f != null && f.exists()) {
            patchHeader(f, (int) Math.min(bytes, Integer.MAX_VALUE));
            RecordingItem item = new RecordingItem();
            item.id = f.getName();
            item.fileName = f.getName();
            item.callsign = cs;
            item.serverName = sn;
            item.startTime = started;
            item.durationSec = Math.round((bytes / (double) (SAMPLE_RATE * 2)) * 10) / 10.0;
            item.sizeBytes = f.length();
            item.source = src;
            Log.i(TAG, "stop -> " + f.getName() + " bytes=" + bytes + " dur=" + item.durationSec);
            return item;
        }
        return null;
    }

    private static void patchHeader(File f, int dataSize) {
        try (RandomAccessFile raf = new RandomAccessFile(f, "rw")) {
            raf.seek(0);
            raf.writeBytes("RIFF");
            raf.writeInt(Integer.reverseBytes(36 + dataSize));
            raf.writeBytes("WAVE");
            raf.writeBytes("fmt ");
            raf.writeInt(Integer.reverseBytes(16));
            raf.writeShort(Short.reverseBytes((short) 1));       // PCM
            raf.writeShort(Short.reverseBytes((short) 1));       // mono
            raf.writeInt(Integer.reverseBytes(SAMPLE_RATE));
            raf.writeInt(Integer.reverseBytes(SAMPLE_RATE * 2)); // byte rate
            raf.writeShort(Short.reverseBytes((short) 2));       // block align
            raf.writeShort(Short.reverseBytes((short) 16));      // bits per sample
            raf.writeBytes("data");
            raf.writeInt(Integer.reverseBytes(dataSize));
        } catch (Exception e) {
            Log.w(TAG, "patchHeader failed", e);
        }
    }

    private static String buildFileName(String cs, String sn, long ts) {
        java.util.function.UnaryOperator<String> safe = (String s) -> {
            String r = s == null ? "" : s;
            r = r.replaceAll("[\\\\/:*?\"<>|\\s]+", "_").replaceAll("_+", "_");
            r = r.replaceAll("^_+|_+$", "");
            return r.length() > 40 ? r.substring(0, 40) : r;
        };
        String c = safe.apply(cs);
        if (c.isEmpty()) c = "UNKNOWN";
        String n = safe.apply(sn);
        if (n.isEmpty()) n = "FMO";
        SimpleDateFormat sdf = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault());
        return c + "_" + n + "_" + sdf.format(new Date(ts)) + ".wav";
    }

    // ---- 元数据索引（SharedPreferences JSON 数组） ----

    public static List<RecordingItem> list(Context ctx) {
        List<RecordingItem> out = new ArrayList<>();
        SharedPreferences sp = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String json = sp.getString(KEY_INDEX, "[]");
        try {
            JSONArray arr = new JSONArray(json);
            File dir = getRecordingsDir(ctx);
            for (int i = 0; i < arr.length(); i++) {
                RecordingItem item = RecordingItem.fromJson(arr.getJSONObject(i));
                if (item == null) continue;
                if (!new File(dir, item.fileName).exists()) continue; // 文件已被外部删除则跳过
                out.add(item);
            }
        } catch (Exception e) {
            Log.w(TAG, "list failed", e);
        }
        out.sort((a, b) -> Long.compare(b.startTime, a.startTime));
        return out;
    }

    public static void delete(Context ctx, String id) {
        File dir = getRecordingsDir(ctx);
        File f = new File(dir, id);
        if (f.exists()) f.delete();
        SharedPreferences sp = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String json = sp.getString(KEY_INDEX, "[]");
        try {
            JSONArray arr = new JSONArray(json);
            JSONArray out = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                if (!id.equals(o.optString("fileName"))) out.put(o);
            }
            sp.edit().putString(KEY_INDEX, out.toString()).apply();
        } catch (Exception ignore) {}
    }

    public static File findFile(Context ctx, String id) {
        File dir = getRecordingsDir(ctx);
        File f = new File(dir, id);
        return f.exists() ? f : null;
    }

    private void addToIndex(Context ctx, RecordingItem item) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String json = sp.getString(KEY_INDEX, "[]");
        try {
            JSONArray arr = new JSONArray(json);
            arr.put(item.toJson());
            sp.edit().putString(KEY_INDEX, arr.toString()).apply();
        } catch (Exception e) {
            Log.w(TAG, "addToIndex failed", e);
        }
    }

    /** 录音元信息（与前端 RecordingItem 对齐） */
    public static class RecordingItem {
        public String id;
        public String fileName;
        public String callsign;
        public String serverName;
        public long startTime;
        public double durationSec;
        public long sizeBytes;
        public String source;

        public JSObject toJson() {
            try {
                JSObject o = new JSObject();
                o.put("id", id == null ? "" : id);
                o.put("fileName", fileName == null ? "" : fileName);
                o.put("callsign", callsign == null ? "" : callsign);
                o.put("serverName", serverName == null ? "" : serverName);
                o.put("startTime", startTime);
                o.put("durationSec", durationSec);
                o.put("sizeBytes", sizeBytes);
                o.put("source", source == null ? "manual" : source);
                return o;
            } catch (Exception e) {
                return new JSObject();
            }
        }

        public static RecordingItem fromJson(JSONObject o) {
            try {
                RecordingItem item = new RecordingItem();
                item.id = o.optString("id", "");
                item.fileName = o.optString("fileName", "");
                item.callsign = o.optString("callsign", "");
                item.serverName = o.optString("serverName", "");
                item.startTime = o.optLong("startTime", 0);
                item.durationSec = o.optDouble("durationSec", 0);
                item.sizeBytes = o.optLong("sizeBytes", 0);
                item.source = o.optString("source", "manual");
                return item;
            } catch (Exception e) {
                return null;
            }
        }
    }
}
