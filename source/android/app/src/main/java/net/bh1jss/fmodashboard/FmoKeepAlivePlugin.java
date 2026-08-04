package net.bh1jss.fmodashboard;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * FmoKeepAlive: 通用后台保活前台服务插件。
 *
 * 调用 FmoKeepAliveService（SPECIAL_USE 前台服务）将应用挂到前台保活，
 * 替代依赖麦克风权限的第三方 background-mode 插件。JS 侧 enable/disable
 * 采用引用计数，允许多个调用方（音频播放、events 连接）同时启用保活。
 *
 * Android 13+（含 Android 16）：POST_NOTIFICATIONS 为运行时权限，默认未授予。
 * 未授予时前台服务照常运行，但通知不会出现在通知栏。因此每次 enable 时
 * 若未授权则主动弹出系统授权框，并在授权后刷新通知。
 */
@CapacitorPlugin(name = "FmoKeepAlive")
public class FmoKeepAlivePlugin extends Plugin {

    private static final String TAG = "FmoKeepAlivePlugin";
    private static final int PERM_REQ_NOTIFICATION = 3001;

    @PluginMethod
    public void enable(PluginCall call) {
        String title = call.getString("title");
        String text = call.getString("text");
        // Android 13+：先确保通知权限（未授予则弹系统授权框），否则通知栏不显示
        ensureNotificationPermission();
        Context ctx = getContext();
        if (ctx != null) {
            FmoKeepAliveService.startService(ctx, title, text);
        }
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        Context ctx = getContext();
        if (ctx != null) {
            FmoKeepAliveService.stopService(ctx);
        }
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        String title = call.getString("title");
        String text = call.getString("text");
        Context ctx = getContext();
        if (ctx != null) {
            FmoKeepAliveService.updateNotification(ctx, title, text);
        }
        call.resolve();
    }

    @PluginMethod
    public void isActive(PluginCall call) {
        JSObject res = new JSObject();
        res.put("active", FmoKeepAliveService.isRunning());
        call.resolve(res);
    }

    /** 主动请求通知权限（Android 13+）；已授权则直接返回。供冷启动提前授权使用。 */
    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        ensureNotificationPermission();
        call.resolve();
    }

    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        final Activity act = getActivity();
        if (act == null) return;
        if (ContextCompat.checkSelfPermission(act, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        // requestPermissions 必须在 UI 线程调用，@PluginMethod 默认在后台线程
        act.runOnUiThread(() -> {
            try {
                ActivityCompat.requestPermissions(
                        act,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        PERM_REQ_NOTIFICATION);
            } catch (Exception e) {
                Log.w(TAG, "requestPermissions failed", e);
            }
        });
    }

    @Override
    protected void handleRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.handleRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERM_REQ_NOTIFICATION) {
            // 授权后立即刷新保活通知：服务若已运行，通知会立刻出现在通知栏
            Context ctx = getContext();
            if (ctx != null) FmoKeepAliveService.refreshIfRunning(ctx);
        }
    }
}
