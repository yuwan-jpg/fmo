<template>
  <header class="header">
    <button
      class="brand-home"
      type="button"
      :title="t('header.backDashboard', '返回仪表盘')"
      @click="router.push('/dashboard')"
    >
      <img src="/app-icon-384.png" alt="" class="header-logo" />
      <span>{{ t("app.name", "FMO 仪表盘") }}</span>
    </button>

    <div class="header-stats">
      <span
        class="header-stat total-today-stat"
        :title="`${t('header.total', '总通联数量')} / ${t('header.today', '今日通联数量')}`"
      >
        <span class="stat-icon" aria-hidden="true">✨</span>
        {{ totalLogs }}<small>/{{ todayLogs }}</small>
      </span>
      <span
        class="header-stat friend-stat"
        :title="t('header.friends', '好友数量')"
      >
        <span class="stat-icon" aria-hidden="true">👥</span>
        {{ uniqueCallsigns }}
      </span>
    </div>

    <div class="header-actions">
      <label
        class="voice-select-wrap"
        :title="t('header.broadcastMode', '播报模式')"
      >
        <span class="voice-dot"></span>
        <select
          :value="voiceMode"
          :aria-label="t('header.broadcastMode', '播报模式')"
          @change="$emit('update-voice-mode', $event.target.value)"
        >
          <option value="alert">
            {{ t("header.newCallsignAlert", "新呼号提醒") }}
          </option>
          <option value="radio">
            {{ t("header.contactBroadcast", "通联播报") }}
          </option>
          <option value="off">
            {{ t("header.broadcastOff", "关闭所有播报") }}
          </option>
        </select>
      </label>

      <button class="tool-btn theme-btn" type="button" @click="toggleTheme">
        <span>{{ isDarkTheme ? "☾" : "☀" }}</span>
        <span
          >{{ t("header.theme", "主题") }}
          {{
            isDarkTheme ? t("header.dark", "深") : t("header.light", "浅")
          }}</span
        >
      </button>

      <button
        class="tool-btn icon-btn"
        type="button"
        :title="t('common.language', '语言：简体中文')"
        @click="toggleLocale"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
        </svg>
      </button>

      <button
        class="tool-btn icon-btn"
        type="button"
        :title="
          isFullscreen
            ? t('header.exitFullscreen', '退出全屏')
            : t('header.fullscreen', '全屏')
        "
        @click="toggleFullscreen"
      >
        <svg v-if="isFullscreen" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"
          />
        </svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"
          />
        </svg>
      </button>

      <button
        class="tool-btn rec-btn"
        :class="{ recording: isRecording || recording.platformRecording }"
        type="button"
        :title="
          isRecording
            ? activeSource === 'manual'
              ? '停止录音'
              : '自动录音中，点击可停止'
            : recording.platformRecording
              ? '正在录制，点击可关闭始终录制'
              : recording.alwaysRecordEnabled
                ? '始终录制（待机），点击可关闭'
                : '录制电台音频'
        "
        @click="handleRecordClick"
      >
        <span class="rec-icon"></span>
        <span class="rec-label">{{
          isRecording
            ? activeSource === "manual"
              ? "停止录音"
              : "自动录音中"
            : recording.platformRecording
              ? "录制中"
              : recording.alwaysRecordEnabled
                ? "始终录制"
                : "录制电台音频"
        }}</span>
        <span
          v-if="isRecording || recording.platformRecording"
          class="rec-dot"
        ></span>
      </button>

      <button
        class="tool-btn icon-btn"
        type="button"
        :title="t('header.recordList', '录音文件')"
        @click="router.push('/recordings')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 6h13" />
          <path d="M8 12h13" />
          <path d="M8 18h13" />
          <path d="M3 6h.01" />
          <path d="M3 12h.01" />
          <path d="M3 18h.01" />
        </svg>
      </button>

      <button
        class="tool-btn icon-btn"
        type="button"
        :title="t('common.settings', '设置')"
        @click="router.push('/settings')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5v.2h-4v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1-2.8-2.8.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3v-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1 2.8-2.8.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3h4v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1h.2v4h-.2a1.7 1.7 0 0 0-1.4 1Z"
          />
        </svg>
      </button>
    </div>
  </header>
</template>

<script setup>
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { useLocale } from "../../composables/useLocale";
import { useFullscreen } from "../../composables/useFullscreen";
import { useRecordingStore } from "../../stores/recordingStore";
import { useThemeStore } from "../../stores/themeStore";

const router = useRouter();
const { t, toggleLocale } = useLocale();
const { isFullscreen, toggleFullscreen } = useFullscreen();
const recording = useRecordingStore();
const { isRecording, activeSource } = storeToRefs(recording);
const theme = useThemeStore();
const { isDarkTheme } = storeToRefs(theme);

async function handleRecordClick() {
  if (isRecording.value) {
    if (activeSource.value === "manual") {
      await recording.stopManual();
    } else {
      await recording.setAutoEnabled(false);
    }
    return;
  }
  if (recording.alwaysRecordEnabled) {
    await recording.setAlwaysRecord(false);
    return;
  }
  const ok = await recording.startManual();
  if (!ok) router.push("/recordings");
}

defineProps({
  todayLogs: { type: Number, default: 0 },
  totalLogs: { type: Number, default: 0 },
  uniqueCallsigns: { type: Number, default: 0 },
  currentSpeaker: { type: String, default: "" },
  ownCallsign: { type: String, default: "" },
  selectedFromCallsign: { type: String, default: "" },
  voiceMode: { type: String, default: "off" },
});

defineEmits(["update-voice-mode"]);

function toggleTheme() {
  theme.toggleDark();
}
</script>

<style scoped>
.header {
  z-index: 100;
  display: flex;
  min-width: 0;
  min-height: 3.9rem;
  flex-shrink: 0;
  align-items: center;
  gap: 0.8rem;
  padding: 0.7rem 1rem;
  border-bottom: 1px solid
    color-mix(in srgb, var(--border-light) 80%, var(--color-primary));
  background: var(--bg-header);
  box-sizing: border-box;
}

.brand-home,
.header-stats,
.header-actions,
.header-stats span,
.voice-select-wrap,
.tool-btn {
  display: flex;
  align-items: center;
}

.brand-home {
  gap: 0.55rem;
  min-width: 0;
  padding: 0;
  border: 0;
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  font-size: 1rem;
  font-weight: 750;
  white-space: nowrap;
  cursor: pointer;
}

.brand-home span {
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-logo {
  width: 2.25rem;
  height: 2.25rem;
  border: 1px solid var(--color-primary);
  border-radius: 7px;
  flex-shrink: 0;
}

.voice-dot {
  width: 0.5rem;
  height: 0.5rem;
  flex-shrink: 0;
  border-radius: 50%;
}

.header-stats {
  gap: 0.55rem;
}

.header-stat {
  gap: 0.18rem;
  color: var(--text-secondary);
  font-size: 0.86rem;
  font-weight: 800;
  letter-spacing: 0;
  white-space: nowrap;
}

.header-stat small {
  color: var(--text-secondary);
  font-size: 0.76em;
  font-weight: 800;
}

.stat-icon {
  font-size: 0.8rem;
  line-height: 1;
}

.header-actions {
  gap: 0.5rem;
  margin-left: auto;
}

.voice-select-wrap,
.tool-btn {
  height: 2.25rem;
  border: 1px solid var(--border-light);
  border-radius: 7px;
  color: var(--text-secondary);
  background: var(--bg-table-stripe);
  box-sizing: border-box;
}

.voice-select-wrap {
  gap: 0.35rem;
  padding-left: 0.6rem;
}

.voice-dot {
  background: var(--color-primary);
}

.voice-select-wrap select {
  width: 7.5rem;
  height: 100%;
  padding: 0 1.15rem 0 0;
  border: 0;
  outline: 0;
  color: var(--text-primary);
  background: transparent;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 700;
  cursor: pointer;
}

.tool-btn {
  justify-content: center;
  gap: 0.35rem;
  padding: 0 0.65rem;
  font: inherit;
  font-size: 0.76rem;
  font-weight: 700;
  cursor: pointer;
}

.theme-btn {
  width: 2.25rem;
  padding: 0;
}

.theme-btn span:last-child {
  display: none;
}

.tool-btn:hover,
.brand-home:hover {
  color: var(--color-primary);
}

.icon-btn {
  width: 2.25rem;
  padding: 0;
}

.icon-btn svg {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 录音按钮 */
.rec-btn {
  position: relative;
  gap: 0.4rem;
  color: var(--color-danger);
  border-color: color-mix(
    in srgb,
    var(--color-danger) 45%,
    var(--border-light)
  );
}

.rec-btn:hover {
  color: var(--color-danger);
  border-color: var(--color-danger);
}

.rec-btn .rec-icon {
  width: 0.85rem;
  height: 0.85rem;
  border-radius: 50%;
  border: 2px solid currentColor;
  box-sizing: border-box;
  flex-shrink: 0;
}

.rec-btn .rec-label {
  font-size: 0.76rem;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}

.rec-btn.recording {
  color: #fff;
  background: var(--color-danger);
  border-color: var(--color-danger);
}

.rec-btn.recording .rec-icon {
  background: currentColor;
  border-radius: 3px;
  animation: rec-pulse 1.1s ease-in-out infinite;
}

.rec-btn .rec-dot {
  position: absolute;
  top: 0.25rem;
  right: 0.3rem;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-danger);
}

@keyframes rec-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

@media (min-width: 769px) and (max-width: 1000px) {
  .header {
    gap: 0.45rem;
    padding-inline: 0.55rem;
  }

  .brand-home {
    gap: 0.35rem;
  }

  .brand-home {
    font-size: 0.82rem;
  }

  .header-stats {
    gap: 0.3rem;
  }

  .header-stat {
    font-size: 0.68rem;
  }

  .theme-btn {
    padding: 0 0.45rem;
  }

  .voice-select-wrap select {
    width: 6.8rem;
  }
}

@media (max-width: 768px) {
  .header {
    min-height: 3.4rem;
    gap: 0.45rem;
    padding: 0.5rem 0.55rem;
  }

  .brand-home {
    flex: 0 0 auto;
    gap: 0;
  }

  .header-stats {
    min-width: 0;
    gap: 0.35rem;
  }

  .header-stat {
    font-size: 0.82rem;
  }

  .header-actions {
    gap: 0.35rem;
  }

  .brand-home span,
  .voice-select-wrap {
    display: none;
  }

  .rec-btn {
    width: 2.25rem;
    padding: 0;
  }

  .rec-btn .rec-label {
    display: none;
  }

  .header-logo {
    width: 2rem;
    height: 2rem;
  }
}
</style>
