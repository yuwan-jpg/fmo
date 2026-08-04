import {
  buildWebSocketUrl,
  ensureBasicAuthCached,
  getLocalMdnsTroubleshootingMessage,
  isValidHostAddress,
  normalizeHost,
  parseAddressWithAuth,
} from "../utils/urlUtils";

function formatWebSocketCreateError(error, wsUrl) {
  const message = error?.message || String(error);
  if (/insecure WebSocket|loaded over HTTPS/i.test(message)) {
    return `当前页面被浏览器按 HTTPS 处理，不能直接连接 ${wsUrl}。请用 http://fmo.bh1jss.net/ 打开网页后再同步；如果浏览器自动跳到 HTTPS，请换用本地版、Android/Win64 版，或关闭浏览器的“始终使用安全连接”。`;
  }
  const mdnsMessage = getLocalMdnsTroubleshootingMessage(wsUrl);
  if (mdnsMessage) return mdnsMessage;
  return message || `WebSocket connection failed: ${wsUrl}`;
}

function formatWebSocketConnectionError(wsUrl, hasAuth = false) {
  const mdnsMessage = getLocalMdnsTroubleshootingMessage(wsUrl);
  if (mdnsMessage) return mdnsMessage;
  const authSuffix = hasAuth
    ? "（如该地址需要账号密码，请确认 用户名:密码@ 部分填写正确）"
    : "";
  return `WebSocket connection failed: ${wsUrl}${authSuffix}`;
}

export class FmoApiClient {
  constructor(baseUrl) {
    // 兼容两种 baseUrl：
    //  1) 基础地址，如 'wss://host'           → 自动拼 /ws
    //  2) 完整地址，如 'wss://host/ws'        → 直接使用，避免拼成 /ws/ws
    //  3) 带认证地址，如 'ws://user:pass@host:port' → 拆出凭据用于预认证
    const parsed = parseAddressWithAuth(baseUrl);
    this.baseUrl = baseUrl;
    this.host = parsed.host;
    this.username = parsed.username;
    this.password = parsed.password;
    this.httpProtocol = parsed.httpProtocol;
    this.socket = null;
    this.pendingRequests = new Map();
    this.connectPromise = null;
  }

  // 检查是否为有效的IP地址或域名（可带端口号）
  isValidAddress(address) {
    return isValidHostAddress(address);
  }

  async connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
      return this.connectPromise;
    }

    let host = this.host || normalizeHost(this.baseUrl);
    const protocol = this.baseUrl.startsWith("wss") ? "wss" : "ws";
    // 兼容两种 baseUrl：
    //  1) 基础地址，如 'wss://host'           → 自动拼 /ws
    //  2) 完整地址，如 'wss://host/ws'        → 直接使用，避免拼成 /ws/ws
    const wsUrl = host.endsWith("/ws")
      ? buildWebSocketUrl(host.replace(/\/ws$/i, ""), protocol, "/ws")
      : buildWebSocketUrl(host, protocol, "/ws");

    // 带 Basic Auth 的地址：先预认证，让浏览器缓存凭据，
    // 后续同 origin 的 WebSocket 握手自动携带 Authorization。
    if (this.username) {
      await ensureBasicAuthCached(
        this.host,
        this.username,
        this.password,
        this.httpProtocol,
      );
    }

    this.connectPromise = new Promise((resolve, reject) => {
      console.log(`Connecting to FMO: ${wsUrl}`);
      try {
        this.socket = new WebSocket(wsUrl);
      } catch (error) {
        this.connectPromise = null;
        reject(new Error(formatWebSocketCreateError(error, wsUrl)));
        return;
      }

      // 内网穿透/移动网络下 WebSocket 握手偶尔会超过 5 秒，放宽一点减少误判。
      const connectTimeout = setTimeout(() => {
        console.error("FMO WebSocket connection timeout");
        this.connectPromise = null;
        if (this.socket) {
          this.socket.close();
          this.socket = null;
        }
        reject(
          new Error(formatWebSocketConnectionError(wsUrl, !!this.username)),
        );
      }, 10000);

      this.socket.onopen = () => {
        clearTimeout(connectTimeout);
        console.log("FMO WebSocket connected");
        this.connectPromise = null;
        resolve();
      };

      this.socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (err) {
          console.error("Failed to parse FMO message:", err);
        }
      };

      this.socket.onerror = (error) => {
        clearTimeout(connectTimeout);
        console.error("FMO WebSocket error:", error);
        this.connectPromise = null;
        reject(
          new Error(formatWebSocketConnectionError(wsUrl, !!this.username)),
        );
      };

      this.socket.onclose = () => {
        clearTimeout(connectTimeout);
        console.log("FMO WebSocket closed");
        this.connectPromise = null;
      };
    });

    return this.connectPromise;
  }

  handleMessage(message) {
    const { type, subType, code, data } = message;
    // 简单的响应匹配逻辑：getList -> getListResponse, getDetail -> getDetailResponse
    let requestSubType = subType.replace("Response", "");

    // 特殊处理：station API 的 getListRange 请求返回 getListResponse
    if (type === "station" && requestSubType === "getList") {
      requestSubType = "getListRange";
    }

    const key = `${type}:${requestSubType}`;

    const pending = this.pendingRequests.get(key);
    if (pending && pending.length > 0) {
      // 同一键允许多个在途请求（如轮询与手动调用并发），按 FIFO 结算最早发出的
      const item = pending.shift();
      if (pending.length === 0) this.pendingRequests.delete(key);

      // 清理对应的超时定时器
      if (item.timeoutId) {
        clearTimeout(item.timeoutId);
      }

      if (code === 0) {
        item.resolve(data);
      } else {
        item.reject(new Error(`FMO API Error: code ${code}`));
      }
    }
  }

  async sendRequest(type, subType, data = {}, options = {}) {
    const retries = options.retries || 0;
    const retryDelayMs = options.retryDelayMs || 450;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.sendRequestOnce(type, subType, data, options);
      } catch (err) {
        lastError = err;
        if (attempt >= retries) break;
        this.resetSocketAfterFailure();
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelayMs * (attempt + 1)),
        );
      }
    }

    throw lastError;
  }

  async sendRequestOnce(type, subType, data = {}, options = {}) {
    await this.connect();

    return new Promise((resolve, reject) => {
      const key = `${type}:${subType}`;
      const item = { resolve, reject, timeoutId: null };
      let pending = this.pendingRequests.get(key);
      if (!pending) {
        pending = [];
        this.pendingRequests.set(key, pending);
      }
      pending.push(item);

      const removeItem = () => {
        const idx = pending.indexOf(item);
        if (idx >= 0) pending.splice(idx, 1);
        if (pending.length === 0) this.pendingRequests.delete(key);
      };

      const message = {
        type,
        subType,
        data,
      };

      const payload = JSON.stringify(message);
      console.log(`[FmoApi] 发送数据 (${type}:${subType}):`, message);
      try {
        this.socket.send(payload);
      } catch (err) {
        // 发送失败（如 socket 处于 CONNECTING/CLOSED）时清理条目，避免泄漏
        removeItem();
        reject(err);
        return;
      }

      // 设置超时
      item.timeoutId = setTimeout(() => {
        // 若该请求已被响应结算（从 pending 移除），忽略陈旧超时，
        // 避免误触发 resetSocketAfterFailure 杀死其他在途请求
        if (pending.indexOf(item) < 0) return;
        removeItem();
        this.resetSocketAfterFailure();
        reject(new Error(`Request timeout: ${key}`));
      }, options.timeoutMs || 15000);
    });
  }

  async trySendRequest(type, subType, data = {}, timeoutMs = 2500) {
    return this.sendRequest(type, subType, data, { timeoutMs });
  }

  async getQsoList(page = 0, pageSize = 20, fromCallsign = "") {
    const params = { page, pageSize };
    if (fromCallsign) {
      params.fromCallsign = fromCallsign;
    }
    return this.sendRequest("qso", "getList", params, {
      retries: 2,
      timeoutMs: 18000,
    });
  }

  async getQsoDetail(logId) {
    return this.sendRequest(
      "qso",
      "getDetail",
      { logId },
      { retries: 2, timeoutMs: 18000 },
    );
  }

  // Station 相关方法
  async getStationList(start = 0, count = 10) {
    return this.sendRequest(
      "station",
      "getListRange",
      { start, count },
      {
        retries: 1,
        timeoutMs: 12000,
      },
    );
  }

  async getAllStations() {
    const all = [];
    let start = 0;
    const count = 20;
    while (true) {
      const result = await this.getStationList(start, count);
      all.push(...result.list);
      if (result.list.length < count) break;
      start += count;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return all;
  }

  async getPinnedList(start = 0, count = 10) {
    return this.sendRequest(
      "station",
      "getPinnedList",
      { start, count },
      {
        retries: 1,
        timeoutMs: 12000,
      },
    );
  }

  async getAllPinnedStations() {
    const all = [];
    let start = 0;
    const count = 10;
    while (true) {
      const result = await this.getPinnedList(start, count);
      all.push(...result.list);
      if (result.list.length < count) break;
      start += count;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return all;
  }

  async addPinnedStation(uid) {
    const candidates = [
      ["addPinned", { uid }],
      ["setPinned", { uid, isPinned: true }],
    ];

    let lastError = null;
    for (const [subType, data] of candidates) {
      try {
        return await this.trySendRequest("station", subType, data, 2500);
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error("FMO 未返回收藏接口响应");
  }

  async getCurrentStation() {
    return this.sendRequest(
      "station",
      "getCurrent",
      {},
      { retries: 1, timeoutMs: 12000 },
    );
  }

  async setCurrentStation(uid) {
    return this.sendRequest("station", "setCurrent", { uid });
  }

  async nextStation() {
    return this.sendRequest("station", "next", {});
  }

  async prevStation() {
    return this.sendRequest("station", "prev", {});
  }

  async getUserInfo() {
    return this.sendRequest("user", "getInfo", {});
  }

  // Config 相关方法
  async getCoordinate() {
    return this.sendRequest(
      "config",
      "getCordinate",
      {},
      { retries: 1, timeoutMs: 12000 },
    );
  }

  async setCoordinate(latitude, longitude) {
    return this.sendRequest("config", "setCordinate", { latitude, longitude });
  }

  close() {
    // 清理连接 Promise
    this.connectPromise = null;

    // 拒绝所有在途请求，避免调用方（如同步任务）永久挂起
    for (const [, pending] of this.pendingRequests.entries()) {
      for (const item of pending) {
        if (item.timeoutId) clearTimeout(item.timeoutId);
        item.reject(new Error("connection closed"));
      }
    }
    this.pendingRequests.clear();

    // 关闭 WebSocket
    if (this.socket) {
      try {
        // 只关闭处于 OPEN 或 CONNECTING 状态的连接
        if (
          this.socket.readyState === WebSocket.OPEN ||
          this.socket.readyState === WebSocket.CONNECTING
        ) {
          this.socket.close();
        }
      } catch (err) {
        console.error("关闭 WebSocket 失败:", err);
      }
      this.socket = null;
    }
  }

  resetSocketAfterFailure() {
    this.connectPromise = null;

    // 拒绝所有在途请求，避免 Promise 永久挂起（各自超时兜底可能已被跳过）
    for (const [, pending] of this.pendingRequests.entries()) {
      for (const item of pending) {
        if (item.timeoutId) clearTimeout(item.timeoutId);
        item.reject(new Error("WebSocket 连接重置"));
      }
    }
    this.pendingRequests.clear();

    if (!this.socket) return;
    try {
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.close();
      }
    } catch (err) {
      console.error("重置 WebSocket 失败:", err);
    }
    this.socket = null;
  }
}
