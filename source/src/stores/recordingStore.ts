import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useSpeakingStatusStore } from './speakingStore'
import { useAudioPlayerStore } from './audioPlayerStore'
import { getPlatform } from '../platform'
import type { RecordingItem } from '../platform/interfaces/IRecordingService'

const AUTO_RECORD_KEY = 'fmo_auto_record'
const ALWAYS_RECORD_KEY = 'fmo_always_record'

/**
 * 录音 store。
 *
 * - 手动：用户点开始/停止，录制接收到的电台音频流为一段 WAV。
 * - 自动（按发言人分段）：events 检测到主服务器当前发言人变化时，
 *   开始录一段（文件名含呼号+服务器名），停止发言时保存。
 * - 始终录制（有声音就录）：按音频电平 VAD 自动开始/结束分段，
 *   无需 events，只要有声音就录。
 * 录音数据源为接收到的电台音频流，需音频播放中。
 */
export const useRecordingStore = defineStore('recording', () => {
  const recordings = ref<RecordingItem[]>([])
  const isRecording = ref(false)
  const autoRecordEnabled = ref(false)
  const alwaysRecordEnabled = ref(false)
  const activeSource = ref<'manual' | 'auto' | ''>('')
  const activeCallsign = ref('')
  const recordingStartedAt = ref(0)
  const playingId = ref('')
  /** 平台层实际录制中（含"始终录制"VAD 正在录的一段，跟随发言/声音） */
  const platformRecording = ref(false)

  const speaking = useSpeakingStatusStore()
  const audioPlayer = useAudioPlayerStore()

  let unsubChanged: (() => void) | null = null
  let unsubEnded: (() => void) | null = null
  let initialized = false
  // 自动分段代次：关闭自动录音 / 切换始终录制时自增，用于让正在异步等待的自动分段
  // 续体失效，避免"关闭自动录音后仍在录"（关闭开关的瞬间恰好处于换人间隔 / 收尾上一段）。
  let autoSegmentSeq = 0

  const needsAudioToRecord = (): boolean => !audioPlayer.isPlaying

  // ========== 列表 / 生命周期 ==========

  async function refreshList() {
    try {
      recordings.value = await getPlatform().recording.listRecordings()
      if (playingId.value && !recordings.value.some((r) => r.id === playingId.value)) {
        playingId.value = ''
      }
    } catch (e) {
      console.warn('[Recording] refreshList 失败:', e)
    }
  }

  async function init() {
    if (initialized) return
    initialized = true
    try {
      const [v1, v2] = await Promise.all([
        getPlatform().storage.get(AUTO_RECORD_KEY),
        getPlatform().storage.get(ALWAYS_RECORD_KEY)
      ])
      autoRecordEnabled.value = v1 === '1'
      alwaysRecordEnabled.value = v2 === '1'
    } catch {
      /* ignore */
    }
    if (alwaysRecordEnabled.value) {
      getPlatform().recording.setSegmentLabelProvider?.(() => ({
        callsign: speaking.currentSpeaker || '',
        serverName: speaking.primaryServerInfo?.name || ''
      }))
      getPlatform()
        .recording.setAlwaysRecord(true)
        .catch(() => {})
    }
    await refreshList()
    unsubChanged = getPlatform().recording.onRecordingChanged(() => {
      try {
        platformRecording.value = getPlatform().recording.isRecording()
      } catch {
        platformRecording.value = false
      }
      // 服务端（Web 静音兜底）可能自行结束了一段自动分段：同步 store 状态，
      // 否则下一段开段 / 停止判断会用陈旧状态错乱
      if (!platformRecording.value && isRecording.value && activeSource.value === 'auto') {
        isRecording.value = false
        activeSource.value = ''
        activeCallsign.value = ''
        recordingStartedAt.value = 0
      }
      refreshList()
    })
    // 连续播放：一段播完自动播列表中的下一条
    unsubEnded = getPlatform().recording.onPlaybackEnded(() => {
      const curId = playingId.value
      if (!curId) return
      const list = recordings.value
      const idx = list.findIndex((r) => r.id === curId)
      if (idx >= 0 && idx + 1 < list.length) {
        const next = list[idx + 1]
        playingId.value = next.id
        getPlatform()
          .recording.playRecording(next.id)
          .catch(() => {})
      } else {
        playingId.value = ''
      }
    })
  }

  // ========== 手动录制 ==========

  async function toggleManual(): Promise<boolean> {
    if (isRecording.value && activeSource.value === 'manual') {
      await stopManual()
      return true
    }
    return startManual()
  }

  async function startManual(): Promise<boolean> {
    if (isRecording.value) return false
    if (alwaysRecordEnabled.value) return false // 始终录制已接管录音机
    if (needsAudioToRecord()) return false
    const cs = speaking.currentSpeaker || ''
    const serverName = speaking.primaryServerInfo?.name || ''
    const ok = await getPlatform().recording.startRecording({
      callsign: cs,
      serverName,
      source: 'manual'
    })
    if (ok) {
      isRecording.value = true
      activeSource.value = 'manual'
      activeCallsign.value = cs
      recordingStartedAt.value = Date.now()
      platformRecording.value = true
    }
    return ok
  }

  async function stopManual() {
    if (!isRecording.value || activeSource.value !== 'manual') return
    const item = await getPlatform().recording.stopRecording()
    isRecording.value = false
    activeSource.value = ''
    activeCallsign.value = ''
    recordingStartedAt.value = 0
    platformRecording.value = false
    if (item) await refreshList()
  }

  // ========== 自动录制（按发言人分段） ==========

  async function saveFlag() {
    try {
      await getPlatform().storage.set(AUTO_RECORD_KEY, autoRecordEnabled.value ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  async function stopAutoSegment() {
    if (!isRecording.value || activeSource.value !== 'auto') return
    const item = await getPlatform().recording.stopRecording()
    isRecording.value = false
    activeSource.value = ''
    recordingStartedAt.value = 0
    platformRecording.value = false
    if (item) await refreshList()
  }

  async function setAutoEnabled(v: boolean) {
    autoSegmentSeq++ // 使进行中的自动分段异步续体失效
    autoRecordEnabled.value = v
    await saveFlag()
    if (alwaysRecordEnabled.value) return // 始终录制优先，按发言人自动分段不重复接管
    if (!v) {
      await stopAutoSegment()
      activeCallsign.value = ''
      return
    }
    // 开启瞬间若正有人发言，立即开始录这一段
    const cs = speaking.currentSpeaker
    if (cs && !needsAudioToRecord() && !isRecording.value) {
      activeCallsign.value = cs
      const serverName = speaking.primaryServerInfo?.name || ''
      const ok = await getPlatform().recording.startRecording({
        callsign: cs,
        serverName,
        source: 'auto'
      })
      if (ok) {
        isRecording.value = true
        activeSource.value = 'auto'
        recordingStartedAt.value = Date.now()
      }
    }
  }

  /** 始终录制（有声音就录）：开启/关闭 VAD 自动分段 */
  async function setAlwaysRecord(v: boolean) {
    autoSegmentSeq++ // 使进行中的自动分段异步续体失效
    alwaysRecordEnabled.value = v
    try {
      await getPlatform().storage.set(ALWAYS_RECORD_KEY, v ? '1' : '0')
    } catch {
      /* ignore */
    }
    if (v) {
      // 手动/按发言人自动录制与始终录制互斥：先停掉当前段
      await stopManual()
      await stopAutoSegment()
      activeCallsign.value = ''
      getPlatform().recording.setSegmentLabelProvider?.(() => ({
        callsign: speaking.currentSpeaker || '',
        serverName: speaking.primaryServerInfo?.name || ''
      }))
    }
    await getPlatform()
      .recording.setAlwaysRecord(v)
      .catch((e) => console.warn('[Recording] setAlwaysRecord 失败:', e))
    if (v) {
      await refreshList()
    }
  }

  // 自动模式：跟随主服务器当前发言人（始终录制开启时不接管）
  //
  // 边界处理（针对"截断不完整 / 只录很短 / 与上一条重复"）：
  // - 停止发言时先等一小段"尾音窗口"，把发言人最后的话完整录进本段再保存，
  //   避免 /events 的停止事件先于音频流到达而把结尾截断。
  // - 换人（A→B）时不再等待 350ms 空窗：上一段收尾后立即开新段，
  //   避免两段之间出现音频空洞（上一段尾音 / 下一段开头丢失）。
  //   上一人的尾音已在尾音窗口内录进上一段，不会混入新段开头造成重复。
  const AUTO_SEGMENT_STOP_TAIL_MS = 150

  watch(
    () => speaking.currentSpeaker,
    async (cs) => {
      if (!autoRecordEnabled.value || alwaysRecordEnabled.value) return
      if (needsAudioToRecord()) return
      const mySeq = autoSegmentSeq
      const normalized = String(cs || '').trim()
      if (normalized) {
        // 有人发言：新发言人（或从无到有）时开新段
        if (normalized !== activeCallsign.value) {
          // 上一段还在录：先等尾音窗口，把上一人的结尾音录进上一段，避免截断
          if (activeCallsign.value) {
            await new Promise((r) => setTimeout(r, AUTO_SEGMENT_STOP_TAIL_MS))
            if (autoSegmentSeq !== mySeq) return
            // 等待期间发言人又变了，放弃开这一段（交给新一轮事件处理）
            if (String(speaking.currentSpeaker || '').trim() !== normalized) return
          }
          // 收尾上一段后立即开新段，不做额外间隔，避免音频空洞
          await stopAutoSegment()
          if (autoSegmentSeq !== mySeq) return
          activeCallsign.value = normalized
          // 开段前再次确认自动录音仍开启
          if (!autoRecordEnabled.value || alwaysRecordEnabled.value) return
          const serverName = speaking.primaryServerInfo?.name || ''
          const ok = await getPlatform().recording.startRecording({
            callsign: normalized,
            serverName,
            source: 'auto'
          })
          if (ok) {
            isRecording.value = true
            activeSource.value = 'auto'
            recordingStartedAt.value = Date.now()
          }
        }
        // 同一呼号继续发言（重复事件），保持当前段不变
      } else if (activeCallsign.value) {
        // 停止发言 → 等尾音窗口确保结尾不截断，再保存当前段
        await new Promise((r) => setTimeout(r, AUTO_SEGMENT_STOP_TAIL_MS))
        if (autoSegmentSeq !== mySeq) return
        // 等待期间又开始新发言，交给上面"有人发言"分支处理
        if (String(speaking.currentSpeaker || '').trim()) return
        activeCallsign.value = ''
        await stopAutoSegment()
      }
    }
  )

  // 始终录制开启时：发言人呼号变化 → 强制切段，避免上一人结尾混入下一段
  watch(
    () => speaking.currentSpeaker,
    async (cs, prev) => {
      if (!alwaysRecordEnabled.value) return
      const cur = String(cs || '').trim()
      const old = String(prev || '').trim()
      if (cur && old && cur !== old) {
        await getPlatform()
          .recording.forceSplitSegment?.()
          .catch((e) => console.warn('[Recording] 按呼号切段失败:', e))
      }
    }
  )

  // ========== 回放 ==========

  async function togglePlay(item: RecordingItem) {
    if (playingId.value === item.id) {
      await getPlatform().recording.stopPlayback()
      playingId.value = ''
      return
    }
    await getPlatform().recording.stopPlayback()
    playingId.value = item.id
    try {
      await getPlatform().recording.playRecording(item.id)
    } catch (e) {
      playingId.value = ''
      throw e
    }
  }

  async function stopPlayback() {
    await getPlatform().recording.stopPlayback()
    playingId.value = ''
  }

  async function remove(item: RecordingItem) {
    await getPlatform().recording.deleteRecording(item.id)
    if (playingId.value === item.id) playingId.value = ''
    await refreshList()
  }

  return {
    // state
    recordings,
    isRecording,
    autoRecordEnabled,
    alwaysRecordEnabled,
    activeSource,
    activeCallsign,
    recordingStartedAt,
    playingId,
    platformRecording,
    // getters
    needsAudioToRecord,
    // actions
    init,
    refreshList,
    toggleManual,
    startManual,
    stopManual,
    setAutoEnabled,
    setAlwaysRecord,
    togglePlay,
    stopPlayback,
    remove
  }
})
