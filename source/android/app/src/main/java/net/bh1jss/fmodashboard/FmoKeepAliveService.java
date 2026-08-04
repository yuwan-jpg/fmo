package net.bh1jss.fmodashboard;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * FmoKeepAliveService: 通用后台保活前台服务（SPECIAL_USE 类型）。
 *
 * 与 FmoAudioService（MEDIA_PLAYBACK）/ FmoLocationService（LOCATION）不同，
 * 本服务不承担具体业务，仅在 JS 侧请求"后台保活"时把进程挂到前台，
 * 避免息屏 / 切后台后被系统回收。持有 PARTIAL_WAKE_LOCK 防止 CPU 休眠
 * 导致 WebSocket / 定时器在 Doze 下被冻结。
 *
 * START_STICKY：进程被系统杀死后会自动重启，通知随之恢复。
 * 不依赖麦克风 / 通知权限，规避旧 background-mode 插件在 Android 14+
 * 上因 FOREGROUND_SERVICE_TYPE_MICROPHONE 崩溃、在未授予录音权限时
 * 静默不启动的问题。
 */
public class FmoKeepAliveService extends Service {

    private static final String TAG = "FmoKeepAliveService";
    public static final String CHANNEL_ID = "fmo_keepalive";
    public static final int NOTIFICATION_ID = 0x46_4D_4F_03;

    public static final String ACTION_START = "net.bh1jss.fmodashboard.FMO_KEEPALIVE_START";
    public static final String ACTION_STOP = "net.bh1jss.fmodashboard.FMO_KEEPALIVE_STOP";
    public static final String ACTION_UPDATE = "net.bh1jss.fmodashboard.FMO_KEEPALIVE_UPDATE";

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_TEXT = "text";

    private static volatile String sTitle = "FMO 运行中";
    private static volatile String sText = "保持后台连接";

    private static volatile FmoKeepAliveService sInstance;

    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        ensureChannel();
        acquireWakeLock();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        Log.i(TAG, "onStartCommand action=" + action);

        if (ACTION_UPDATE.equals(action) && intent != null) {
            applyExtras(intent);
            refreshNotification();
            return START_STICKY;
        }

        if (intent != null) applyExtras(intent);

        Notification notification = buildNotification(this, sTitle, sText);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        if (ACTION_STOP.equals(action)) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        if (sInstance == this) sInstance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void applyExtras(Intent intent) {
        String t = intent.getStringExtra(EXTRA_TITLE);
        String x = intent.getStringExtra(EXTRA_TEXT);
        if (t != null && !t.isEmpty()) sTitle = t;
        if (x != null) sText = x;
    }

    private void refreshNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(NOTIFICATION_ID, buildNotification(this, sTitle, sText));
        }
    }

    private static Notification buildNotification(Context ctx, String title, String text) {
        Intent launch = new Intent(ctx, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentPI = PendingIntent.getActivity(
                ctx, 0, launch,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(contentPI)
                .setOngoing(true)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setOnlyAlertOnce(true);
        return b.build();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "FMO 后台保活", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("保持 FMO 在后台持续运行");
                ch.setShowBadge(false);
                ch.setSound(null, null);
                ch.enableVibration(false);
                ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                nm.createNotificationChannel(ch);
            }
        }
    }

    /** PARTIAL_WAKE_LOCK：防止息屏 / Doze 时 CPU 休眠，冻结 WebSocket 与 JS 定时器。 */
    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            if (wakeLock != null && wakeLock.isHeld()) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FmoKeepAlive:wakelock");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(24 * 60 * 60 * 1000L); // 上限 24h，防止泄漏
            Log.i(TAG, "WakeLock acquired");
        } catch (Exception e) {
            Log.w(TAG, "WakeLock acquire failed", e);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
                Log.i(TAG, "WakeLock released");
            }
        } catch (Exception ignore) {}
        wakeLock = null;
    }

    // ---- 静态方法（供插件调用） ----

    public static void startService(Context ctx) {
        startService(ctx, null, null);
    }

    public static void startService(Context ctx, String title, String text) {
        if (title != null && !title.isEmpty()) sTitle = title;
        if (text != null) sText = text;
        Intent i = new Intent(ctx, FmoKeepAliveService.class).setAction(ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Exception e) {
            Log.w(TAG, "startService failed (app likely in background): " + e.getMessage());
        }
    }

    public static void stopService(Context ctx) {
        try {
            Intent i = new Intent(ctx, FmoKeepAliveService.class).setAction(ACTION_STOP);
            ctx.startService(i);
        } catch (Exception e) {
            Log.w(TAG, "stopService failed", e);
        }
    }

    /** 更新通知栏标题 / 文案。仅服务运行时生效；未运行时只写静态缓存。 */
    public static void updateNotification(Context ctx, String title, String text) {
        if (title != null && !title.isEmpty()) sTitle = title;
        if (text != null) sText = text;
        FmoKeepAliveService inst = sInstance;
        if (inst != null) {
            inst.refreshNotification();
        }
    }

    public static boolean isRunning() {
        return sInstance != null;
    }

    /** 服务运行中则立即重发一次通知（通知权限刚授予后调用，让通知立刻可见）。 */
    public static void refreshIfRunning(Context ctx) {
        FmoKeepAliveService inst = sInstance;
        if (inst != null) {
            inst.refreshNotification();
        }
    }
}
