/**
 * 从地址中解析 userinfo(user:pass@) 前的部分。
 * 支持 http:// 形式的完整地址或裸 host。
 * @returns {{ host: string, username: string, password: string }}
 */
export function parseAuthInfo(address) {
  const empty = { host: "", username: "", password: "" };
  if (!address) return empty;
  let value = String(address)
    .trim()
    .replace(/：/g, ":")
    .replace(/^(https?|wss?):?\/\//i, "");

  const atIndex = value.lastIndexOf("@");
  if (atIndex === -1) {
    return { host: normalizeHost(value), username: "", password: "" };
  }

  const userinfo = value.slice(0, atIndex);
  const host = normalizeHost(value.slice(atIndex + 1));
  let username = "";
  let password = "";
  const colon = userinfo.indexOf(":");
  if (colon === -1) {
    username = safeDecode(userinfo);
  } else {
    username = safeDecode(userinfo.slice(0, colon));
    password = safeDecode(userinfo.slice(colon + 1));
  }
  return { host, username, password };
}

/**
 * 解析带认证的地址，返回干净的 host、凭据和推导出的协议。
 * @returns {{ host: string, username: string, password: string, protocol: string, httpProtocol: string }}
 */
export function parseAddressWithAuth(address) {
  const raw = String(address || "").trim();
  const protocol = getProtocolFromAddress(raw);
  const { host, username, password } = parseAuthInfo(raw);
  return {
    host,
    username,
    password,
    protocol,
    httpProtocol: protocol === "wss" ? "https" : "http",
  };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 标准化地址，移除协议前缀、尾部斜杠和 userinfo(user:pass@)
 * @param {string} address - 原始地址
 * @returns {string} - 标准化后的主机名
 */
export function normalizeHost(address) {
  if (!address) return "";
  let value = String(address)
    .trim()
    .replace(/：/g, ":")
    .replace(/^(https?|wss?):?\/\//i, "")
    .replace(/\/+$/, "");

  value = value.replace(/[?#].*$/, "");
  value = value.replace(/\/(ws|events)\/?$/i, "");
  value = value.replace(/\/.*$/, "");
  // 剥离 userinfo(user:pass@)
  const atIndex = value.lastIndexOf("@");
  if (atIndex !== -1) value = value.slice(atIndex + 1);
  return value;
}

/**
 * 检查是否为有效的 IPv4 或域名地址（可带端口号）。
 * 允许 DDNS 常见的短标签域名，例如 a.example.com、x.yz.net。
 * 支持带 Basic Auth 的 user:pass@host 形式。
 */
export function isValidHostAddress(address) {
  if (!address) return false;

  let value = String(address).trim().replace(/：/g, ":");

  // 分离 userinfo。带 @ 时必须为 user:pass@ 形式（无冒号视为非法域名）
  const atIndex = value.lastIndexOf("@");
  if (atIndex !== -1) {
    const userinfo = value.slice(0, atIndex);
    if (!userinfo.includes(":")) return false;
    value = value.slice(atIndex + 1);
    if (!value) return false;
  }

  let host = normalizeHost(value);
  let port = null;

  const portMatch = host.match(/^(.+):(\d+)$/);
  if (portMatch) {
    host = portMatch[1];
    port = parseInt(portMatch[2], 10);

    if (port < 1 || port > 65535) {
      return false;
    }
  }

  const ipv4Regex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  if (ipv4Regex.test(host)) return true;

  // DDNS 厂商和自建网关偶尔会使用下划线或单标签内网主机名。
  // 这里仍拒绝空白、协议残片和明显的 URL 分隔符，但不再强制按公网 DNS 标签规则卡死。
  if (
    host.length <= 253 &&
    !/\s/.test(host) &&
    !/[/?#@]/.test(host) &&
    /^[a-zA-Z0-9._-]+$/.test(host) &&
    /^[a-zA-Z0-9]/.test(host) &&
    /[a-zA-Z0-9]$/.test(host)
  ) {
    return true;
  }

  const labels = host.split(".");
  return labels.every((label) => {
    return (
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)
    );
  });
}

export function getProtocolFromAddress(address, fallback = "ws") {
  const value = String(address || "").trim();
  if (/^(wss|https):\/\//i.test(value)) return "wss";
  if (/^(ws|http):\/\//i.test(value)) return "ws";
  return fallback === "wss" || fallback === "https" ? "wss" : "ws";
}

export function getEffectiveWebSocketProtocol(host, protocol = "ws") {
  return protocol === "wss" || protocol === "https" ? "wss" : "ws";
}

export function buildWebSocketUrl(host, protocol = "ws", path = "/ws") {
  const normalizedHost = normalizeHost(host);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const wsProtocol = getEffectiveWebSocketProtocol(normalizedHost, protocol);
  return `${wsProtocol}://${normalizedHost}${normalizedPath}`;
}

export function isLocalMdnsHost(host) {
  const normalizedHost = normalizeHost(host).replace(/:\d+$/, "").toLowerCase();
  return normalizedHost === "fmo.local" || normalizedHost.endsWith(".local");
}

export function getLocalMdnsTroubleshootingMessage(host) {
  if (!isLocalMdnsHost(host)) return "";
  return "Windows 桌面版可能无法解析 fmo.local 这类 .local 地址。请在 FMO 设备或路由器里查看局域网 IP，例如 192.168.x.x，然后在地址里填写这个 IP。";
}

export function getBlockedInsecureWebSocketMessage(host, protocol = "ws") {
  const normalizedProtocol =
    protocol === "wss" || protocol === "https" ? "wss" : "ws";
  if (
    typeof window !== "undefined" &&
    window.location?.protocol === "https:" &&
    normalizedProtocol === "ws"
  ) {
    return "当前页面是 HTTPS，浏览器不能连接 ws:// 地址。请改用 http://fmo.bh1jss.net/ 或本地版本访问普通 ws:// FMO；只有目标已配置 TLS WebSocket 时才选择 wss://。";
  }
  return "";
}

// ========== HTTP Basic Auth 支持 ==========

function utf8ToBase64(str) {
  const btoaFn = globalThis.btoa;
  const encoder = globalThis.TextEncoder;
  if (typeof btoaFn === "function" && typeof encoder !== "undefined") {
    const bytes = new encoder().encode(str);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoaFn(binary);
  }
  // 旧运行时兜底（不含中文时也能用）
  if (typeof globalThis.unescape === "function") {
    return btoaFn(unescape(encodeURIComponent(str)));
  }
  return btoaFn(encodeURIComponent(str));
}

/**
 * 生成 Basic Auth 的 Authorization 请求头值。
 * 使用 UTF-8 编码，支持中文密码（不能直接用 btoa）。
 * @returns {string} 如 `Basic dXNlcjpwYXNz`
 */
export function buildBasicAuthHeader(username, password) {
  return `Basic ${utf8ToBase64(`${username || ""}:${password || ""}`)}`;
}

/**
 * 构造带 userinfo 的 HTTP URL（用于浏览器网络栈完成 Basic Auth 挑战）。
 */
export function buildAuthUrl(host, username, password, httpProtocol = "http") {
  const clean = normalizeHost(host);
  const protocol = httpProtocol === "https" ? "https" : "http";
  const u = encodeURIComponent(username || "");
  const p = encodeURIComponent(password || "");
  return `${protocol}://${u}:${p}@${clean}`;
}

/**
 * 界面展示用：隐藏密码，如 `user:***@fmo.example.net:40088`。
 */
export function formatAddressForDisplay(host, username) {
  const clean = normalizeHost(host);
  if (username) return `${username}:***@${clean}`;
  return clean;
}

// 记录已完成预认证的 origin，避免重复请求
const authCache = new Map();

// 等待认证窗口完成登录挑战的时间（毫秒）
const AUTH_WINDOW_SETTLE_MS = 5000;
// 认证弹窗等待设备可达/加载完成的兜底超时（毫秒）
const AUTH_CONNECT_TIMEOUT_MS = 25000;

/**
 * 预认证：让浏览器/WebView 对目标 origin 完成一次 HTTP Basic Auth 认证，
 * 把凭据写入该会话的认证缓存；之后同 origin 的 WebSocket 握手会自动携带凭据。
 *
 * 为什么必须用"顶层导航"：现代 Chromium 中：
 * - fetch 禁止使用带 userinfo 的 URL；
 * - <img>/<iframe> 等子资源请求不会把 URL userinfo 转成 Authorization 头，
 *   也不会填充可供 WebSocket 复用的认证缓存；
 * - 只有"顶层导航"(window.open / 新窗口 / 地址栏)才会用 URL userinfo 完成
 *   Basic Auth 挑战，并把凭据写入会话认证缓存。
 *
 * 实现分层：
 * - Tauri 桌面版：用 @tauri-apps/api/window 创建隐藏的 WebviewWindow，
 *   与主窗口共享 WebView2 profile（认证缓存共享），认证后自动关闭。
 * - 浏览器/网页版：window.open 新标签页（需在用户手势上下文内调用，
 *   否则可能被弹窗拦截返回 null）。
 * - 非浏览器环境（如 Node 测试）：尽力用 fetch，失败忽略。
 *
 * @param {string} host - 干净 host（可含端口）
 * @param {string} username
 * @param {string} password
 * @param {string} [httpProtocol='http'] - 'http' 或 'https'
 */
export function ensureBasicAuthCached(
  host,
  username,
  password,
  httpProtocol = "http",
) {
  const clean = normalizeHost(host);
  if (!clean || !username) return Promise.resolve();
  const protocol = httpProtocol === "https" ? "https" : "http";
  const key = `${protocol}://${clean}`;
  if (authCache.has(key)) return authCache.get(key);

  const task = (async () => {
    const authUrl = buildAuthUrl(clean, username, password, protocol);

    if (typeof window !== "undefined") {
      const isTauri = Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
      // Capacitor 原生端(Android/iOS)：WebView 内认证，
      // 由原生 FmoAuthPlugin 在 onReceivedHttpAuthRequest 中自动带凭据。
      const isNativeCapacitor =
        typeof window.Capacitor !== "undefined" &&
        typeof window.Capacitor.isNativePlatform === "function" &&
        window.Capacitor.isNativePlatform();

      if (isNativeCapacitor && !isTauri) {
        // 原生隐藏 WebView 主导航认证（可靠触发 onReceivedHttpAuthRequest）
        try {
          const FmoAuth = window.Capacitor.Plugins?.FmoAuth;
          if (FmoAuth && typeof FmoAuth.authenticate === "function") {
            await FmoAuth.authenticate({ host: clean, username, password });
            return;
          }
        } catch {
          /* 忽略，走 iframe 兜底 */
        }
        // 兜底：provide 凭据 + iframe 触发认证
        try {
          const FmoAuth = window.Capacitor.Plugins?.FmoAuth;
          if (FmoAuth && typeof FmoAuth.provide === "function") {
            await FmoAuth.provide({ host: clean, username, password });
          }
        } catch {
          /* 忽略 */
        }
        // 触发一次到该 origin 的请求，让 WebView 收到 401 挑战，
        // 原生层自动 proceed 并把凭据写入认证缓存，之后同源 WebSocket 复用。
        await new Promise((resolve) => {
          if (typeof document === "undefined") {
            resolve();
            return;
          }
          const f = document.createElement("iframe");
          f.style.display = "none";
          f.src = `${protocol}://${clean}/?_t=${Date.now()}`;
          document.body.appendChild(f);
          setTimeout(() => {
            try {
              f.remove();
            } catch {
              /* 忽略 */
            }
            resolve();
          }, 3000);
        });
        return;
      }

      if (isTauri) {
        // Tauri：原生多窗口认证（共享 WebView2 profile 的认证缓存）。
        // 注意：窗口必须可见 WebView2 才会加载页面并完成认证挑战，
        // 隐藏窗口可能不加载页面导致认证不生效。
        try {
          const { WebviewWindow } =
            await import("@tauri-apps/api/webviewWindow");
          const { listen } = await import("@tauri-apps/api/event");
          const label = `fmo-auth-${Math.random().toString(36).slice(2, 8)}`;
          const win = new WebviewWindow(label, {
            url: authUrl,
            width: 500,
            height: 400,
            visible: true,
          });
          // 等 Rust 侧通知「设备页面已加载」（设备可达且认证完成）后再关闭弹窗，
          // 避免设备响应较慢时弹窗过早关闭导致认证缓存未就绪。
          await new Promise((resolve) => {
            let settled = false;
            let unlisten = null;
            const finish = () => {
              if (settled) return;
              settled = true;
              if (typeof unlisten === "function") unlisten();
              resolve();
            };
            listen("fmo-auth-loaded", () => finish())
              .then((u) => {
                unlisten = u;
              })
              .catch(() => {});
            // 兜底超时：设备长时间不可达时也关闭弹窗
            setTimeout(finish, AUTH_CONNECT_TIMEOUT_MS);
          });
          // 优先强制销毁，避免 FMO 页面拦截正常关闭
          try {
            await win.destroy();
          } catch {
            try {
              await win.close();
            } catch {
              /* 忽略 */
            }
          }
          return;
        } catch {
          // 回退到 window.open
        }
      }

      // 浏览器/网页版：window.open 顶层导航认证
      let win = null;
      try {
        win = window.open(authUrl, "_blank");
      } catch {
        win = null;
      }
      if (!win) {
        // 弹窗被拦截：移除缓存，允许下次调用重试
        authCache.delete(key);
      }
      await new Promise((r) => setTimeout(r, AUTH_WINDOW_SETTLE_MS));
      try {
        if (win) win.close();
      } catch {
        /* 忽略 */
      }
      return;
    }

    // 非浏览器环境（Node 测试等）：尽力而为，失败忽略
    try {
      if (typeof fetch === "function") {
        await fetch(authUrl, {
          method: "GET",
          mode: "no-cors",
          cache: "no-store",
        });
      }
    } catch {
      /* 忽略 */
    }
  })();
  authCache.set(key, task);
  return task;
}
