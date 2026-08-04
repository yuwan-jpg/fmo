<template>
  <div class="recording-view">
    <div class="section-title">电台录音</div>

    <!-- 控制区 -->
    <div class="card control-card">
      <div class="row">
        <button
          type="button"
          class="record-btn"
          :class="{ recording: isRecording && activeSource === 'manual' }"
          :disabled="isRecording && activeSource !== 'manual'"
          @click="toggleManual()"
        >
          <span
            v-if="isRecording && activeSource === 'manual'"
            class="dot red"
          ></span>
          <span v-else class="dot"></span>
          <span class="btn-label">
            {{
              isRecording && activeSource === "manual"
                ? "停止录音"
                : isRecording
                  ? "自动录音中"
                  : "开始录音"
            }}
          </span>
        </button>
        <div v-if="isRecording && activeSource === 'manual'" class="rec-timer">
          <span class="live-badge">● 录音中</span>
          <span>{{ elapsedText }}</span>
          <span v-if="activeCallsign" class="rec-cs">{{ activeCallsign }}</span>
        </div>
        <div
          v-else-if="isRecording && activeSource === 'auto'"
          class="rec-timer"
        >
          <span class="live-badge auto">● 自动录音</span>
          <span v-if="activeCallsign" class="rec-cs">{{ activeCallsign }}</span>
        </div>
      </div>

      <div v-if="needsAudioToRecord" class="hint warn">
        自动/手动录音需要先播放音频（数据源为正在收听的电台音频流）。
      </div>

      <div class="row toggle-row">
        <div class="toggle-text">
          <div class="toggle-title">始终录制（有声音就录）</div>
          <div class="toggle-desc">
            检测到电台有声音自动分段录制，静音后保存
          </div>
        </div>
        <button
          type="button"
          class="switch"
          :class="{ on: alwaysRecordEnabled }"
          role="switch"
          :aria-checked="alwaysRecordEnabled"
          @click="setAlwaysRecord(!alwaysRecordEnabled)"
        >
          <span class="knob"></span>
        </button>
      </div>

      <div class="row toggle-row">
        <div class="toggle-text">
          <div class="toggle-title">按发言人自动分段</div>
          <div class="toggle-desc">
            发言开始录制、停止发言保存（呼号 + 服务器名）
          </div>
        </div>
        <button
          type="button"
          class="switch"
          :class="{ on: autoRecordEnabled }"
          role="switch"
          :aria-checked="autoRecordEnabled"
          @click="setAutoEnabled(!autoRecordEnabled)"
        >
          <span class="knob"></span>
        </button>
      </div>

      <div class="hint">
        录音文件保存在本地设备（桌面 IndexedDB / Android 应用目录
        Recordings/）。
      </div>
    </div>

    <!-- 录音列表 -->
    <div class="card list-card">
      <div class="list-header">
        <span class="section-title">录音文件</span>
        <div class="list-header-right">
          <select
            v-if="serverOptions.length > 0"
            v-model="serverFilter"
            class="server-filter"
            title="按服务器筛选"
          >
            <option value="">全部服务器（{{ recordings.length }}）</option>
            <option v-for="name in serverOptions" :key="name" :value="name">
              {{ name }}（{{
                recordings.filter((r) => r.serverName === name).length
              }}）
            </option>
          </select>
          <button
            type="button"
            class="refresh-btn"
            title="刷新"
            @click="refreshList()"
          >
            ⟳
          </button>
        </div>
      </div>

      <div v-if="recordings.length === 0" class="empty">暂无录音</div>
      <div v-else-if="filteredRecordings.length === 0" class="empty">
        该服务器暂无录音
      </div>

      <ul v-else class="rec-list">
        <li v-for="r in filteredRecordings" :key="r.id" class="rec-item">
          <div class="rec-main">
            <div class="rec-line1">
              <span class="rec-callsign">{{ r.callsign || "未知呼号" }}</span>
              <span class="source-badge" :class="r.source">{{
                r.source === "auto" ? "自动" : "手动"
              }}</span>
              <span v-if="playingId === r.id" class="playing">♪ 播放中</span>
            </div>
            <div class="rec-line2">
              <span class="rec-server">{{ r.serverName || "-" }}</span>
              <span>{{ formatDurationSec(r.durationSec) }}</span>
              <span>{{ formatStartTime(r.startTime) }}</span>
              <span>{{ formatSize(r.sizeBytes) }}</span>
            </div>
          </div>
          <div class="rec-actions">
            <button
              type="button"
              class="action-btn play"
              :title="playingId === r.id ? '停止播放' : '播放'"
              @click="togglePlay(r)"
            >
              {{ playingId === r.id ? "■" : "▶" }}
            </button>
            <button
              type="button"
              class="action-btn del"
              :class="{ armed: pendingDeleteId === r.id }"
              :title="pendingDeleteId === r.id ? '再次点击确认删除' : '删除'"
              @click="deleteWithConfirm(r)"
            >
              {{ pendingDeleteId === r.id ? "确认" : "🗑" }}
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useRecordingStore } from "../stores/recordingStore";
import { formatDurationSec } from "../core/recording";
import toast from "../composables/useToast";

const recording = useRecordingStore();
const {
  recordings,
  isRecording,
  autoRecordEnabled,
  alwaysRecordEnabled,
  activeSource,
  activeCallsign,
  recordingStartedAt,
  playingId,
} = storeToRefs(recording);

const needsAudioToRecord = computed(() => recording.needsAudioToRecord());

// 服务器筛选：默认显示全部，可按服务器过滤
const serverFilter = ref("");
const serverOptions = computed(() => {
  const set = new Set();
  for (const r of recordings.value) {
    if (r.serverName) set.add(r.serverName);
  }
  return [...set].sort();
});
const filteredRecordings = computed(() => {
  if (!serverFilter.value) return recordings.value;
  return recordings.value.filter((r) => r.serverName === serverFilter.value);
});

function refreshList() {
  recording.refreshList();
}

async function togglePlay(r) {
  try {
    await recording.togglePlay(r);
  } catch (e) {
    console.warn("[Recording] 播放失败:", e);
    toast.error("播放失败，录音文件可能为空或损坏");
  }
}

const nowMs = ref(Date.now());
let timer = null;

const elapsedText = computed(() => {
  if (!isRecording.value || !recordingStartedAt.value) return "00:00";
  const sec = Math.max(
    0,
    Math.floor((nowMs.value - recordingStartedAt.value) / 1000),
  );
  return formatDurationSec(sec);
});

function formatStartTime(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function toggleManual() {
  if (isRecording.value && activeSource.value === "manual") {
    recording.stopManual();
    return;
  }
  if (alwaysRecordEnabled.value) {
    toast.warning("始终录制已开启，手动录制不可用，请先关闭始终录制");
    return;
  }
  if (needsAudioToRecord.value) {
    toast.warning("请先播放音频再录音（数据源为正在收听的电台音频流）");
    return;
  }
  recording.startManual();
}

function setAlwaysRecord(v) {
  recording.setAlwaysRecord(v);
}

function setAutoEnabled(v) {
  recording.setAutoEnabled(v);
}

const pendingDeleteId = ref("");
let deleteTimer = null;

function deleteWithConfirm(r) {
  if (pendingDeleteId.value !== r.id) {
    // 第一次点击：进入待确认状态
    pendingDeleteId.value = r.id;
    if (deleteTimer) clearTimeout(deleteTimer);
    deleteTimer = setTimeout(() => {
      pendingDeleteId.value = "";
    }, 3000);
    return;
  }
  if (deleteTimer) clearTimeout(deleteTimer);
  pendingDeleteId.value = "";
  recording.remove(r);
}

onMounted(() => {
  recording.init();
  timer = setInterval(() => {
    nowMs.value = Date.now();
  }, 500);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
  if (deleteTimer) clearTimeout(deleteTimer);
});
</script>

<style scoped>
.recording-view {
  height: 100%;
  overflow-y: auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.section-title {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text-primary);
}

.card {
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 10px;
  padding: 1rem 1.25rem;
}

.control-card {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.row {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}

.record-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.6rem 1.1rem;
  border: 1px solid var(--color-danger);
  border-radius: 999px;
  background: rgba(248, 113, 113, 0.08);
  color: var(--color-danger);
  font-size: 0.95rem;
  cursor: pointer;
  transition: all 0.2s;
}

.record-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.record-btn.recording {
  background: var(--color-danger);
  color: #fff;
}

.record-btn .dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid currentColor;
  box-sizing: border-box;
}

.record-btn.recording .dot.red {
  background: currentColor;
}

.rec-timer {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  font-variant-numeric: tabular-nums;
  font-size: 0.95rem;
  color: var(--text-primary);
}

.live-badge {
  color: var(--color-danger);
  font-weight: 700;
  font-size: 0.8rem;
  animation: blink 1.2s ease-in-out infinite;
}

.live-badge.auto {
  color: var(--color-warning);
}

@keyframes blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.rec-cs {
  font-weight: 700;
  color: var(--color-primary);
}

.hint {
  font-size: 0.78rem;
  color: var(--text-tertiary);
}

.hint.warn {
  color: var(--color-warning);
}

.toggle-row {
  justify-content: space-between;
  padding: 0.25rem 0;
  border-top: 1px solid var(--border-light);
  padding-top: 0.9rem;
}

.toggle-text {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.toggle-title {
  font-size: 0.95rem;
  color: var(--text-primary);
}

.toggle-desc {
  font-size: 0.78rem;
  color: var(--text-tertiary);
}

.switch {
  position: relative;
  width: 48px;
  height: 26px;
  border-radius: 999px;
  border: none;
  background: var(--bg-input);
  cursor: pointer;
  transition: background 0.2s;
  flex-shrink: 0;
}

.switch.on {
  background: var(--color-success);
}

.switch .knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.2s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}

.switch.on .knob {
  left: 25px;
}

.list-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding-bottom: 1rem;
}

.list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  flex-wrap: wrap;
}

.list-header-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.server-filter {
  min-height: 2rem;
  max-width: 16rem;
  border: 1px solid var(--border-light);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 0.8rem;
  padding: 0.2rem 0.4rem;
  cursor: pointer;
}

.refresh-btn {
  border: 1px solid var(--border-light);
  background: var(--bg-input);
  color: var(--text-secondary);
  border-radius: 6px;
  padding: 0.2rem 0.6rem;
  cursor: pointer;
  font-size: 0.9rem;
}

.empty {
  color: var(--text-tertiary);
  text-align: center;
  padding: 1.5rem 0;
  font-size: 0.85rem;
}

.rec-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.rec-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem 0.8rem;
  border: 1px solid var(--border-light);
  border-radius: 8px;
  background: var(--bg-table-stripe);
}

.rec-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.rec-line1 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.rec-callsign {
  font-weight: 700;
  color: var(--text-primary);
}

.source-badge {
  font-size: 0.68rem;
  padding: 0 0.35rem;
  border-radius: 4px;
  border: 1px solid var(--border-light);
  color: var(--text-secondary);
}

.source-badge.auto {
  color: var(--color-warning);
  border-color: var(--color-warning);
}

.playing {
  font-size: 0.72rem;
  color: var(--color-success);
  font-weight: 700;
}

.rec-line2 {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.75rem;
  color: var(--text-tertiary);
  flex-wrap: wrap;
}

.rec-server {
  color: var(--text-secondary);
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rec-actions {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}

.action-btn {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: 1px solid var(--border-light);
  background: var(--bg-input);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.85rem;
}

.action-btn.play:hover {
  color: var(--color-success);
  border-color: var(--color-success);
}

.action-btn.del:hover {
  color: var(--color-danger);
  border-color: var(--color-danger);
}

.action-btn.del.armed {
  color: #fff;
  background: var(--color-danger);
  border-color: var(--color-danger);
}

/* 移动端 */
@media (max-width: 768px) {
  .recording-view {
    padding: 1rem;
    padding-bottom: calc(
      5rem + var(--safe-inset-bottom, env(safe-area-inset-bottom, 0px))
    );
  }
}
</style>
