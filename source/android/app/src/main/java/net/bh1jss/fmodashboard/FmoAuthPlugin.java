package net.bh1jss.fmodashboard;

import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.HttpAuthHandler;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebViewDatabase;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * FmoAuth: 在 WebView 内自动完成 HTTP Basic Auth 认证。
 * <p>
 * 背景：浏览器/WebView 的 WebSocket 无法携带 Authorization 头或 URL userinfo，
 * 只能依赖"WebView 的认证缓存"。Android WebView 的认证缓存由
 * {@link WebViewClient#onReceivedHttpAuthRequest} 填充 —— 前端提供凭据后，
 * 原生层在收到 401 挑战时自动 {@link HttpAuthHandler#proceed}，凭据进入缓存，
 * 之后同 origin 的 JS WebSocket 握手会自动携带。
 * <p>
 * 同时把凭据写入 {@link WebViewDatabase}，供原生 OkHttp 请求
 * （音频/APRS 等，见 {@link WebViewAuthHelper}）提取复用。
 */
@CapacitorPlugin(name = "FmoAuth")
public class FmoAuthPlugin extends Plugin {

    private static final String TAG = "FmoAuthPlugin";

    /** host → {username, password}。host 同时记录带端口与不带端口两种 key。 */
    private static final Map<String, String[]> AUTH_CACHE = new ConcurrentHashMap<>();

    private static volatile boolean handlerInstalled = false;

    /**
     * provide({ host, username, password })：
     * 记录凭据、允许混合内容（https 页面连 ws:// / http:// 必需）、
     * 安装认证处理器并写入 WebViewDatabase。
     */
    @PluginMethod
    public void provide(PluginCall call) {
        String host = call.getString("host", "");
        String username = call.getString("username", "");
        String password = call.getString("password", "");
        if (host.isEmpty() || username.isEmpty()) {
            call.reject("invalid params");
            return;
        }
        try {
            String hostNoPort = host.contains(":") ? host.substring(0, host.indexOf(':')) : host;
            String[] creds = { username, password };
            AUTH_CACHE.put(host, creds);
            AUTH_CACHE.put(hostNoPort, creds);

            WebView wv = bridge.getWebView();
            if (wv != null) {
                // 允许混合内容：app 页面是 https://localhost，需连接 ws:// / http:// 的 FMO
                try {
                    WebSettings settings = wv.getSettings();
                    if (settings != null) {
                        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                    }
                } catch (Throwable e) {
                    Log.w(TAG, "setMixedContentMode failed: " + e.getMessage());
                }
                installHandler(wv);
            }

            // 写入 WebViewDatabase，供原生 OkHttp（WebViewAuthHelper）提取
            try {
                WebViewDatabase db = WebViewDatabase.getInstance(getContext());
                if (db != null) {
                    for (String realm : new String[] { "", "FMO", "FMO Restricted Area" }) {
                        db.setHttpAuthUsernamePassword(hostNoPort, realm, username, password);
                    }
                }
            } catch (Throwable e) {
                Log.w(TAG, "WebViewDatabase write failed: " + e.getMessage());
            }

            Log.i(TAG, "provide auth host=" + host);
            call.resolve(new JSObject().put("ok", true));
        } catch (Throwable e) {
            Log.w(TAG, "provide failed: " + e.getMessage(), e);
            call.reject("provide failed: " + e.getMessage());
        }
    }

    private void installHandler(WebView wv) {
        if (handlerInstalled) return;
        try {
            WebViewClient current = wv.getWebViewClient();
            if (!(current instanceof AuthDelegatingWebViewClient)) {
                wv.setWebViewClient(new AuthDelegatingWebViewClient(current));
            }
            handlerInstalled = true;
        } catch (Throwable e) {
            Log.w(TAG, "installHandler failed: " + e.getMessage(), e);
        }
    }

    /**
     * authenticate({ host, username, password })：
     * 用独立的隐藏 WebView 做一次"主 frame 导航"到带凭据的地址，
     * 可靠触发 {@link WebViewClient#onReceivedHttpAuthRequest} 并自动认证，
     * 把凭据写入同进程共享的 WebView 认证缓存。之后应用主 WebView 的
     * JS WebSocket 握手会自动携带凭据。
     * <p>
     * 为什么不用 iframe：Android WebView 对 subframe 的 401 不保证触发
     * onReceivedHttpAuthRequest，主 frame 导航才可靠。
     */
    @PluginMethod
    public void authenticate(PluginCall call) {
        String host = call.getString("host", "");
        String username = call.getString("username", "");
        String password = call.getString("password", "");
        if (host.isEmpty() || username.isEmpty()) {
            call.reject("invalid params");
            return;
        }
        try {
            String hostNoPort = host.contains(":") ? host.substring(0, host.indexOf(':')) : host;
            AUTH_CACHE.put(host, new String[] { username, password });
            AUTH_CACHE.put(hostNoPort, new String[] { username, password });
            try {
                WebViewDatabase db = WebViewDatabase.getInstance(getContext());
                if (db != null) {
                    for (String realm : new String[] { "", "FMO", "FMO Restricted Area" }) {
                        db.setHttpAuthUsernamePassword(hostNoPort, realm, username, password);
                    }
                }
            } catch (Throwable e) {
                Log.w(TAG, "WebViewDatabase write failed: " + e.getMessage());
            }
        } catch (Throwable e) {
            Log.w(TAG, "auth cache init failed: " + e.getMessage(), e);
        }

        final String finalHost = host;
        getActivity().runOnUiThread(() -> {
            try {
                final WebView view = new WebView(getContext());
                WebSettings settings = view.getSettings();
                settings.setJavaScriptEnabled(false);
                try {
                    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                } catch (Throwable e) {
                    Log.w(TAG, "setMixedContentMode failed: " + e.getMessage());
                }

                final boolean[] settled = { false };
                view.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onReceivedHttpAuthRequest(WebView v, HttpAuthHandler handler, String h, String realm) {
                        Log.i(TAG, "auth view challenge host=" + h + " realm=" + realm);
                        handler.proceed(username, password);
                    }

                    @Override
                    public void onPageFinished(WebView v, String url) {
                        Log.i(TAG, "auth view finished: " + url);
                        if (!settled[0]) {
                            settled[0] = true;
                            try {
                                v.destroy();
                            } catch (Throwable e) {
                                // 忽略
                            }
                            call.resolve(new JSObject().put("ok", true));
                        }
                    }

                    @Override
                    @SuppressWarnings("deprecation")
                    public void onReceivedError(WebView v, int errorCode, String description, String failingUrl) {
                        Log.w(TAG, "auth view error " + errorCode + " " + failingUrl);
                        if (!settled[0]) {
                            settled[0] = true;
                            try {
                                v.destroy();
                            } catch (Throwable e) {
                                // 忽略
                            }
                            call.resolve(new JSObject().put("ok", errorCode == -2 || errorCode == 401));
                        }
                    }
                });

                String url = "http://" + finalHost + "/?_t=" + System.currentTimeMillis();
                Log.i(TAG, "auth view load: " + url);
                view.loadUrl(url);

                // 兜底超时
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    if (!settled[0]) {
                        settled[0] = true;
                        try {
                            view.destroy();
                        } catch (Throwable e) {
                            // 忽略
                        }
                        call.resolve(new JSObject().put("ok", false));
                    }
                }, 12000);
            } catch (Throwable e) {
                Log.w(TAG, "authenticate failed: " + e.getMessage(), e);
                call.reject("authenticate failed: " + e.getMessage());
            }
        });
    }

    private static String[] lookup(String host) {
        String[] c = host == null ? null : AUTH_CACHE.get(host);
        if (c != null) return c;
        if (host != null && host.contains(":")) {
            return AUTH_CACHE.get(host.substring(0, host.indexOf(':')));
        }
        return null;
    }

    /**
     * 委托 Capacitor 的 BridgeWebViewClient，并额外处理 HTTP Basic Auth。
     */
    static final class AuthDelegatingWebViewClient extends WebViewClient {
        private final WebViewClient delegate;

        AuthDelegatingWebViewClient(WebViewClient delegate) {
            this.delegate = delegate;
        }

        @Override
        public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
            String[] creds = lookup(host);
            if (creds != null) {
                Log.i(TAG, "auto auth host=" + host + " realm=" + realm);
                handler.proceed(creds[0], creds[1]);
                return;
            }
            if (delegate != null) {
                try {
                    delegate.onReceivedHttpAuthRequest(view, handler, host, realm);
                    return;
                } catch (Throwable e) {
                    // 忽略
                }
            }
            handler.cancel();
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return delegate != null && delegate.shouldOverrideUrlLoading(view, request);
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (delegate != null) delegate.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (delegate != null) delegate.onPageFinished(view, url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (delegate != null) delegate.onReceivedError(view, request, error);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
            if (delegate != null) delegate.onReceivedHttpError(view, request, errorResponse);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            return delegate != null && delegate.onRenderProcessGone(view, detail);
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            if (delegate != null) delegate.onPageCommitVisible(view, url);
        }
    }
}
