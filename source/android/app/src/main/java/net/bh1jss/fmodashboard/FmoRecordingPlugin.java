package net.bh1jss.fmodashboard;

import android.content.Context;
import android.media.MediaPlayer;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

import net.bh1jss.fmodashboard.FmoWavRecorder.RecordingItem;

/**
 * FmoRecording: 电台音频流录音插件。
 *
 * 录制数据来自 FmoAudioPlugin 收到的原始 PCM 流（FmoWavRecorder 单例），
 * 本插件只负责 JS 桥：start/stop/list/delete/play/stopPlayback。
 * 无需 RECORD_AUDIO 权限（录制的是接收到的音频流，不是麦克风）。
 */
@CapacitorPlugin(name = "FmoRecording")
public class FmoRecordingPlugin extends Plugin {

    private static final String TAG = "FmoRecordingPlugin";

    private MediaPlayer mediaPlayer;
    private volatile boolean playing = false;

    @PluginMethod
    public void start(PluginCall call) {
        String callsign = call.getString("callsign", "");
        String serverName = call.getString("serverName", "");
        String source = call.getString("source", "manual");
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("context unavailable");
            return;
        }
        FmoWavRecorder.get().start(ctx, callsign, serverName, source);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        RecordingItem item = FmoWavRecorder.get().stop();
        if (item == null) {
            call.resolve();
            return;
        }
        notifyListeners("recordingChanged", new JSObject());
        call.resolve(item.toJson());
    }

    @PluginMethod
    public void isActive(PluginCall call) {
        JSObject res = new JSObject();
        res.put("active", FmoWavRecorder.get().isActive());
        call.resolve(res);
    }

    @PluginMethod
    public void setAlwaysRecord(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        FmoWavRecorder.get().setAlwaysRecordMode(enabled);
        call.resolve();
    }

    @PluginMethod
    public void list(PluginCall call) {
        Context ctx = getContext();
        JSArray arr = new JSArray();
        if (ctx != null) {
            for (RecordingItem item : FmoWavRecorder.list(ctx)) {
                arr.put(item.toJson());
            }
        }
        JSObject res = new JSObject();
        res.put("recordings", arr);
        call.resolve(res);
    }

    @PluginMethod
    public void delete(PluginCall call) {
        String id = call.getString("id");
        Context ctx = getContext();
        if (ctx != null && id != null) {
            FmoWavRecorder.delete(ctx, id);
            notifyListeners("recordingChanged", new JSObject());
        }
        call.resolve();
    }

    @PluginMethod
    public void play(PluginCall call) {
        String id = call.getString("id");
        Context ctx = getContext();
        if (ctx == null || id == null) {
            call.reject("invalid params");
            return;
        }
        File f = FmoWavRecorder.findFile(ctx, id);
        if (f == null) {
            call.reject("file not found");
            return;
        }
        stopPlaybackInternal();
        MediaPlayer mp = new MediaPlayer();
        try {
            mp.setDataSource(f.getAbsolutePath());
            mp.setOnCompletionListener(mp2 -> {
                playing = false;
                releasePlayer();
                notifyListeners("playbackChanged", new JSObject());
                notifyListeners("playbackEnded", new JSObject());
            });
            mp.setOnErrorListener((mp3, what, extra) -> {
                playing = false;
                releasePlayer();
                notifyListeners("playbackChanged", new JSObject());
                notifyListeners("playbackEnded", new JSObject());
                return true;
            });
            mp.prepare();
            mp.start();
            mediaPlayer = mp;
            playing = true;
            call.resolve();
        } catch (Exception e) {
            Log.w(TAG, "play failed", e);
            releasePlayer();
            call.reject("play failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopPlayback(PluginCall call) {
        stopPlaybackInternal();
        call.resolve();
    }

    private void stopPlaybackInternal() {
        playing = false;
        releasePlayer();
    }

    private void releasePlayer() {
        MediaPlayer mp = mediaPlayer;
        mediaPlayer = null;
        if (mp != null) {
            try {
                if (mp.isPlaying()) mp.stop();
            } catch (Exception ignore) {}
            try { mp.release(); } catch (Exception ignore) {}
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopPlaybackInternal();
        super.handleOnDestroy();
    }
}
