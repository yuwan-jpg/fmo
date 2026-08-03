<template>
  <div class="float-panel" @click="closeCtx" @contextmenu.prevent="openCtx">
    <header class="float-header">
      <span class="status-dot" :class="statusKind"></span>
      <span class="station-name" data-tauri-drag-region>{{ statusText }}</span>
      <div class="header-actions">
        <button type="button" title="返回主窗口" @click="exitFloatMode()">
          ⤢
        </button>
        <button type="button" title="隐藏浮窗" @click="hideFloat()">—</button>
        <button type="button" class="danger" title="退出" @click="quitApp()">
          ✕
        </button>
      </div>
    </header>

    <section class="now">
      <div class="now-label">
        {{ isLive ? "当前呼叫" : displayCallsign ? "最后发言" : "无人发言" }}
        <span v-if="isLive" class="live-badge">LIVE</span>
      </div>
      <div class="callsign" :class="{ live: isLive }">
        {{ displayCallsign || "---" }}
      </div>
    </section>

    <section class="meta">
      <span>{{ currentRelayName || "-" }}</span>
      <span>{{ modeText }}</span>
    </section>

    <section class="recent">
      <div class="recent-title">最近通联</div>
      <ul v-if="recentList.length" class="recent-list">
        <li v-for="r in recentList" :key="r.rowId" @dblclick="exitFloatMode()">
          <span class="rc-call">{{ r.toCallsign }}</span>
          <span class="rc-relay">{{ r.relayName || "-" }}</span>
          <span class="rc-time">{{ clockText(r.timestamp) }}</span>
        </li>
      </ul>
      <div v-else class="recent-empty">
        {{ loading ? "加载中..." : "暂无最近通联" }}
      </div>
    </section>

    <div
      v-if="ctxMenu.visible"
      class="ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
    >
      <button type="button" @click="ctxAction(showMain)">显示主窗口</button>
      <button type="button" @click="ctxAction(hideFloat)">隐藏浮窗</button>
      <button type="button" class="danger" @click="ctxAction(quitApp)">
        退出
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useSettingsStore } from "../stores/settingsStore";
import { useSpeakingStatusStore } from "../stores/speakingStore";
import { FmoApiClient } from "../services/fmoApi";
import { isTauriDesktop } from "../utils/desktopBridge";
import {
  exitFloatMode,
  hideFloatWindow,
  showFloatWindow,
} from "../utils/floatWindow";

const settings = useSettingsStore();
const speaking = useSpeakingStatusStore();

const stationName = ref("");
const records = ref([]);
const connected = ref(false);
const loading = ref(true);

// 浮窗配置：主窗口通过 fmo:config 事件推送（跨窗口不共享 IndexedDB），
// 或从共享存储读取兜底。
const config = ref(null);

let refreshTimer = null;
let unlisteners = [];

const speakingHistory = computed(() => speaking.speakingHistory);

const currentSpeakingRecord = computed(
  () =>
    [...speakingHistory.value]
      .filter((h) => !h.endTime && h.callsign)
      .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))[0] || null,
);

const lastEndedRecord = computed(
  () =>
    [...speakingHistory.value]
      .filter((h) => h.endTime && h.callsign)
      .sort((a, b) => (b.endTime || 0) - (b.startTime || 0))[0] || null,
);

const isLive = computed(() => Boolean(currentSpeakingRecord.value));
const displayCallsign = computed(() =>
  String(
    currentSpeakingRecord.value?.callsign ||
      lastEndedRecord.value?.callsign ||
      "",
  )
    .trim()
    .toUpperCase(),
);

/** 当前（或最近）发言所在服务器/中继名，优先取发言记录上的 serverName */
const currentRelayName = computed(() => {
  const rec = currentSpeakingRecord.value || lastEndedRecord.value;
  if (rec?.serverName) return rec.serverName;
  return stationName.value || "";
});

const statusKind = computed(() => {
  if (!config.value?.host) return "idle";
  return connected.value ? "ok" : "error";
});

const statusText = computed(() => {
  if (!config.value?.host) return "未配置 FMO";
  if (connected.value && stationName.value) return stationName.value;
  if (connected.value) return "已连接";
  return "连接中...";
});

const modeText = computed(() => {
  const first =
    records.value.find((r) => r.mode && r.mode !== "FMO") || records.value[0];
  return first?.mode || "FMO";
});

/**
 * 最近通联记录：来自实时 events 发言历史（与主窗口一致），
 * 记录所有呼号（不限于本人）及发言时所在服务器名称，按最近时间倒序、去重。
 * 通联记录轮询（getQsoList）只返回日志库，不包含实时发言，故不再作为数据源。
 */
const recentList = computed(() => {
  const seen = new Set();
  const out = [];
  const sorted = [...speakingHistory.value]
    .filter((h) => h.callsign)
    .sort(
      (a, b) =>
        (b.endTime || b.startTime || 0) - (a.endTime || a.startTime || 0),
    );
  for (const h of sorted) {
    const cs = String(h.callsign || "").toUpperCase();
    if (!cs || seen.has(cs)) continue;
    seen.add(cs);
    out.push({
      rowId: `live-${cs}-${h.startTime}`,
      toCallsign: cs,
      relayName: h.serverName || "",
      timestamp: Math.floor((h.endTime || h.startTime) / 1000),
    });
    if (out.length >= 8) break;
  }
  return out;
});

function clockText(timestamp) {
  if (!timestamp) return "-";
  const d = new Date(timestamp * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildBaseUrl() {
  const c = config.value;
  if (!c?.host) return "";
  const proto = c.protocol || "ws";
  if (c.username) {
    return `${proto}://${encodeURIComponent(c.username)}:${encodeURIComponent(
      c.password || "",
    )}@${c.host}`;
  }
  return `${proto}://${c.host}`;
}

async function refresh() {
  const c = config.value;
  if (!c?.host) {
    connected.value = false;
    loading.value = false;
    return;
  }
  const api = new FmoApiClient(buildBaseUrl());
  try {
    const [station, qso] = await Promise.all([
      api.getCurrentStation().catch(() => null),
      api.getQsoList(0, 12, c.ownCallsign || "").catch(() => ({ list: [] })),
    ]);
    if (station && station.name) stationName.value = station.name;
    records.value = qso.list || [];
    connected.value = true;
  } catch {
    connected.value = false;
  } finally {
    loading.value = false;
    api.close();
  }
}

function applyConfig(cfg) {
  if (!cfg || !cfg.host) return;
  const prevHost = config.value?.host;
  config.value = {
    host: cfg.host,
    protocol: cfg.protocol || "ws",
    username: cfg.username || "",
    password: cfg.password || "",
    ownCallsign: cfg.ownCallsign || "",
  };
  if (prevHost && prevHost !== config.value.host) {
    try {
      speaking.disconnectEventWs("single");
    } catch {
      /* ignore */
    }
  }
  speaking.connectEventWs(config.value.host, config.value.protocol);
  refresh();
}

async function init() {
  // 1) 先注册配置事件监听（必须等监听就绪再请求，否则主窗口的回包会丢失）
  await bindConfigEvents();

  // 2) 尝试直接从共享存储读取（若两窗口共享存储则立即可用）
  let has = false;
  try {
    has = await settings.initFmoAddress();
  } catch {
    has = false;
  }
  if (has && settings.fmoAddress.value) {
    const active = settings.activeAddress.value;
    applyConfig({
      host: settings.fmoAddress.value,
      protocol: settings.protocol.value,
      username: active?.username || "",
      password: active?.password || "",
      ownCallsign: active?.userInfo?.callsign || "",
    });
  }
  // 3) 向主窗口请求配置；未拿到则自动重试几次（避免事件时序竞态丢包）
  await requestConfigWithRetry();
  refresh();
  refreshTimer = setInterval(refresh, 12000);
}

async function requestConfigWithRetry() {
  if (config.value) return;
  for (let i = 0; i < 5; i++) {
    emitRequestConfig();
    // 等待配置到达或超时
    await new Promise((r) => setTimeout(r, 1200));
    if (config.value) return;
  }
}

function hideFloat() {
  hideFloatWindow();
}

async function quitApp() {
  if (!isTauriDesktop()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("fmo:quit-app");
  } catch {
    /* 忽略 */
  }
}

// ========== 自定义右键菜单 ==========
const ctxMenu = ref({ visible: false, x: 0, y: 0 });

function openCtx(e) {
  const maxX = window.innerWidth - 140;
  const maxY = window.innerHeight - 120;
  ctxMenu.value = {
    visible: true,
    x: Math.min(e.clientX, maxX),
    y: Math.min(e.clientY, maxY),
  };
}

function closeCtx() {
  ctxMenu.value.visible = false;
}

function ctxAction(fn) {
  closeCtx();
  fn();
}

function showMain() {
  exitFloatMode();
}

// ========== 桌面端事件（托盘 + 配置推送） ==========
async function bindConfigEvents() {
  if (!isTauriDesktop()) return;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlisteners.push(
      await listen("fmo:tray-show-float", () => showFloatWindow()),
    );
    unlisteners.push(
      await listen("fmo:tray-hide-float", () => hideFloatWindow()),
    );
    unlisteners.push(
      await listen("fmo:config", (e) => applyConfig(e?.payload)),
    );
  } catch {
    /* 忽略 */
  }
}

async function emitRequestConfig() {
  if (!isTauriDesktop()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("fmo:request-config");
  } catch {
    /* 忽略 */
  }
}

onMounted(() => {
  init();
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  for (const un of unlisteners) {
    try {
      un();
    } catch {
      /* 忽略 */
    }
  }
});
</script>

<style scoped>
.float-panel {
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 0.6rem;
  background: linear-gradient(
    160deg,
    rgba(24, 30, 48, 0.96),
    rgba(14, 18, 30, 0.96)
  );
  border: 1px solid rgba(100, 150, 255, 0.35);
  border-radius: 10px;
  color: #e8eef7;
  font-size: 13px;
  user-select: none;
  overflow: hidden;
}

.float-header {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-height: 1.6rem;
  cursor: move;
}

.status-dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  flex-shrink: 0;
  background: #6b7280;
}

.status-dot.ok {
  background: #4ade80;
  box-shadow: 0 0 0 3px rgba(74, 222, 128, 0.18);
}

.status-dot.error {
  background: #f87171;
  box-shadow: 0 0 0 3px rgba(248, 113, 113, 0.18);
}

.station-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
  color: #c9d4e6;
}

.header-actions {
  display: flex;
  gap: 0.2rem;
}

.header-actions button {
  width: 1.55rem;
  height: 1.4rem;
  border: 0;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.08);
  color: #c9d4e6;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.header-actions button:hover {
  background: rgba(255, 255, 255, 0.18);
}

.header-actions button.danger:hover {
  background: rgba(248, 113, 113, 0.35);
  color: #fff;
}

.now {
  text-align: center;
  padding: 0.15rem 0 0.3rem;
}

.now-label {
  font-size: 11px;
  color: #8b98ab;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
}

.live-badge {
  color: #4ade80;
  border: 1px solid rgba(74, 222, 128, 0.5);
  border-radius: 3px;
  padding: 0 0.25rem;
  font-weight: 800;
  font-size: 10px;
}

.callsign {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: 0.02em;
  line-height: 1.15;
  color: #b9c6db;
  overflow-wrap: anywhere;
}

.callsign.live {
  color: #6fe08b;
  text-shadow: 0 0 14px rgba(74, 222, 128, 0.45);
}

.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  padding: 0.3rem 0.45rem;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: #9aa7bb;
  font-size: 11px;
}

.recent {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.recent-title {
  font-size: 11px;
  color: #8b98ab;
  margin-bottom: 0.25rem;
}

.recent-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}

.recent-list li {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.28rem 0.4rem;
  border-radius: 5px;
  cursor: default;
}

.recent-list li:nth-child(odd) {
  background: rgba(255, 255, 255, 0.04);
}

.recent-list li:hover {
  background: rgba(120, 160, 255, 0.14);
}

.rc-call {
  font-weight: 700;
  color: #dfe7f4;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rc-relay {
  color: #9aa7bb;
  max-width: 7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rc-time {
  color: #6f7c90;
  font-size: 11px;
  flex-shrink: 0;
}

.recent-empty {
  color: #6f7c90;
  font-size: 11px;
  text-align: center;
  padding: 0.6rem 0;
}

.ctx-menu {
  position: fixed;
  z-index: 999;
  min-width: 120px;
  display: flex;
  flex-direction: column;
  padding: 0.25rem;
  border: 1px solid rgba(120, 160, 255, 0.35);
  border-radius: 7px;
  background: #1b2133;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
}

.ctx-menu button {
  border: 0;
  border-radius: 5px;
  padding: 0.42rem 0.6rem;
  background: transparent;
  color: #dfe7f4;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.ctx-menu button:hover {
  background: rgba(120, 160, 255, 0.16);
}

.ctx-menu button.danger {
  color: #f87171;
}

.ctx-menu button.danger:hover {
  background: rgba(248, 113, 113, 0.2);
}

::-webkit-scrollbar {
  width: 6px;
}

::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
  border-radius: 3px;
}
</style>
