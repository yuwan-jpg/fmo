import type { IRecordingService, RecordingItem, RecordingStartOptions } from '../interfaces/IRecordingService'
import type { IAudioService } from '../interfaces/IAudioService'
import {
  RECORD_SAMPLE_RATE,
  VadSegmenter,
  WavSegmentRecorder,
  buildRecordingFileName
} from '../../core/recording'

const DB_NAME = 'fmo-recordings'
const DB_VERSION = 1
const STORE_META = 'meta'
const STORE_BLOBS = 'blobs'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * Web / Tauri 桌面端录音服务。
 *
 * 数据源：音频播放器（AudioStreamPlayer）收到的原始 PCM16 分片，
 * 经 WebAudioService.subscribeRawAudio 订阅。录制为 8kHz/单声道 WAV，
 * 以 Blob 形式存入 IndexedDB（跨 Tauri 窗口共享同一 origin），应用内列表 + 回放。
 *
 * 注意：需要音频播放器处于连接状态才有数据；静音播放不影响录制（旁路原始流）。
 */
export class WebRecordingService implements IRecordingService {
  private recorder: WavSegmentRecorder | null = null
  private recorderMeta: RecordingStartOptions | null = null
  private db: IDBDatabase | null = null
  private listeners = new Set<() => void>()

  // 回放
  private playingId: string | null = null
  private playAudio: HTMLAudioElement | null = null
  private playObjectUrl: string | null = null

  // 始终录制（VAD）
  private alwaysRecord = false
  private vad: VadSegmenter | null = null
  private labelProvider: (() => { callsign: string; serverName: string }) | null = null

  // 统一音频源订阅：持续维护预卷 + 驱动 VAD 分段 + 喂给活动录音（切段补头依赖它）
  private feedSubscribed = false
  private unsubFeed: (() => void) | null = null

  // 静音兜底：自动分段（source=auto）时若连续静音超过该时长仍未收到结束事件，
  // 主动收尾当前段，避免"发言人讲完了但下一位不说话"时一直录下去。
  private static readonly AUTO_STOP_SILENCE_MS = 4000

  // VAD 预卷缓冲：保留最近一段原始 PCM，语音触发时补到段首，避免截掉开头
  private preRoll: Int16Array[] = []
  private preRollSamples = 0
  private static readonly PRE_ROLL_SAMPLES = Math.round(RECORD_SAMPLE_RATE * 0.5) // 500ms @ 8kHz

  // 按呼号强制切段时给当前段保留的"尾音"时长：/events 换人事件往往先于音频流到达，
  // 立刻收尾会截掉发言人最后的话，先等这一小段把尾音完整录进本段。
  private static readonly FORCE_SPLIT_TAIL_MS = 150

  // 当前自动段的静音检测器（连续静音超时则自动收尾）
  private silenceVad: VadSegmenter | null = null

  private endedListeners = new Set<() => void>()

  constructor(private audioService?: IAudioService) {
    // 提前订阅音频源：让预卷始终热着，事件触发开段时能把话音开头补上
    this.ensureFeed()
  }

  private async ensureDb(): Promise<IDBDatabase> {
    if (this.db) return this.db
    this.db = await openDb()
    return this.db
  }

  onPlaybackEnded(cb: () => void): () => void {
    this.endedListeners.add(cb)
    return () => this.endedListeners.delete(cb)
  }

  private emitPlaybackEnded() {
    for (const cb of this.endedListeners) {
      try {
        cb()
      } catch {
        /* ignore */
      }
    }
  }

  isRecording(): boolean {
    return this.recorder !== null
  }

  async setAlwaysRecord(enabled: boolean): Promise<void> {
    if (this.alwaysRecord === enabled) return
    this.alwaysRecord = enabled
    if (enabled) {
      this.vad = new VadSegmenter()
      this.ensureFeed()
      this.emitChanged()
    } else {
      this.vad = null
      this.clearPreRoll()
      // 结束当前 VAD 触发的一段
      if (this.recorder && this.recorderMeta?.source === 'auto') {
        await this.stopRecording()
      }
      this.emitChanged()
    }
  }

  /** 统一音频源订阅（仅订阅一次）：预卷 + VAD + 活动录音采集 + 静音兜底 */
  private ensureFeed(): void {
    if (this.feedSubscribed) return
    if (!this.audioService || typeof this.audioService.subscribeRawAudio !== 'function') return
    this.feedSubscribed = true
    this.unsubFeed = this.audioService.subscribeRawAudio((int16) => {
      // 1. 始终维护滚动预卷，供切段/开段时补头
      this.pushPreRoll(int16)

      // 2. 始终录制（VAD）模式的分段
      let startedNow = false
      if (this.vad) {
        const action = this.vad.feed(int16)
        if (action === 'start') {
          const label = this.labelProvider
            ? this.labelProvider()
            : { callsign: '', serverName: '' }
          // startRecording 内部同步创建 recorder（成功与否看调用前是否已有录音）
          startedNow = this.recorder === null
          this.startRecording({
            callsign: label.callsign || '',
            serverName: label.serverName || '',
            source: 'auto'
          })
        } else if (action === 'stop') {
          this.clearPreRoll()
          this.stopRecording()
        }
      }

      // 3. 把音频喂给当前活动录音，并做静音兜底
      if (this.recorder && !startedNow) {
        this.recorder.feed(int16)
        this.trackSilence(int16)
      }
    })
  }

  /** 静音兜底：自动分段连续静音过久 → 主动收尾当前段 */
  private trackSilence(int16: Int16Array): void {
    if (!this.silenceVad) return
    const action = this.silenceVad.feed(int16)
    if (action === 'stop') {
      this.clearPreRoll()
      this.stopRecording()
    }
  }

  /** 维护滚动预卷缓冲，只保留最近 PRE_ROLL_SAMPLES 个样本 */
  private pushPreRoll(int16: Int16Array): void {
    if (!int16 || int16.length === 0) return
    this.preRoll.push(int16)
    this.preRollSamples += int16.length
    while (this.preRollSamples > WebRecordingService.PRE_ROLL_SAMPLES && this.preRoll.length) {
      const drop = this.preRoll[0]
      if (drop.length <= this.preRollSamples - WebRecordingService.PRE_ROLL_SAMPLES) {
        this.preRoll.shift()
        this.preRollSamples -= drop.length
      } else {
        const keep = this.preRollSamples - WebRecordingService.PRE_ROLL_SAMPLES
        const kept = drop.subarray(drop.length - keep)
        this.preRoll[0] = kept
        this.preRollSamples -= drop.length - keep
      }
    }
  }

  private clearPreRoll(): void {
    this.preRoll = []
    this.preRollSamples = 0
  }

  setSegmentLabelProvider(fn: (() => { callsign: string; serverName: string }) | null): void {
    this.labelProvider = fn
  }

  /**
   * 强制切段：结束当前自动（VAD）段并重置 VAD，使下一次发声作为新段开始。
   * 与 VAD 的静音切段互补：收到发言人呼号变化时调用，保证每段按发言人精确分割。
   */
  async forceSplitSegment(): Promise<void> {
    const rec = this.recorder
    if (rec && this.recorderMeta?.source === 'auto') {
      // 先清预卷：上一人（当前段）的尾音不能进到下一段的预卷里，否则会与上一条录音重复
      this.clearPreRoll()
      // 等一小段尾音窗口，把当前发言人最后的话完整录进本段，避免截断
      await new Promise((r) => setTimeout(r, WebRecordingService.FORCE_SPLIT_TAIL_MS))
      // 等待期间可能已被 VAD 自然切段或手动停止，只有仍是当前段才收尾
      if (this.recorder === rec) {
        await this.stopRecording()
      }
    }
    // 重置 VAD 状态机：让下一位发言人的声音作为新段开始（预卷会补上开头）
    if (this.vad) {
      this.vad.reset()
      this.clearPreRoll()
    }
  }

  async startRecording(opts: RecordingStartOptions): Promise<boolean> {
    if (this.recorder) return false
    this.recorder = new WavSegmentRecorder()
    this.recorderMeta = opts
    // 自动分段：把最近一段预卷补到段首，避免漏掉话音开头
    if (opts.source === 'auto' && this.preRoll.length) {
      this.recorder.prependInt16(this.preRoll)
    }
    this.clearPreRoll()
    // 静音兜底：自动分段开启连续静音检测（先有声音再静音超时才触发收尾）
    if (opts.source === 'auto') {
      this.silenceVad = new VadSegmenter({
        startHangMs: 300,
        stopHangMs: WebRecordingService.AUTO_STOP_SILENCE_MS,
        maxSegmentSec: 600
      })
    }
    this.ensureFeed()
    this.emitChanged()
    return true
  }

  async stopRecording(): Promise<RecordingItem | null> {
    const rec = this.recorder
    const opts = this.recorderMeta
    if (!rec) return null
    this.recorder = null
    this.recorderMeta = null
    this.silenceVad = null
    // 切段后清空预卷：下一段补头时不把上一段的尾音带进来（避免重复）
    this.clearPreRoll()
    this.emitChanged()
    if (rec.byteLength === 0) return null

    const now = rec.startedAtMs
    const item: RecordingItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fileName: buildRecordingFileName(opts?.callsign || '', opts?.serverName || '', now),
      callsign: opts?.callsign || '',
      serverName: opts?.serverName || '',
      startTime: now,
      durationSec: Math.round(rec.durationSec * 10) / 10,
      sizeBytes: rec.byteLength,
      source: opts?.source || 'manual'
    }
    const blob = rec.finish()
    if (!blob) return null
    try {
      const db = await this.ensureDb()
      await idbRequest(db.transaction(STORE_META, 'readwrite').objectStore(STORE_META).put(item))
      await idbRequest(
        db.transaction(STORE_BLOBS, 'readwrite').objectStore(STORE_BLOBS).put({ id: item.id, blob })
      )
    } catch (e) {
      console.warn('[Recording] 保存 IndexedDB 失败:', e)
      return null
    }
    this.emitChanged()
    return item
  }

  async listRecordings(): Promise<RecordingItem[]> {
    try {
      const db = await this.ensureDb()
      const all: RecordingItem[] = await idbRequest(
        db.transaction(STORE_META, 'readonly').objectStore(STORE_META).getAll()
      )
      return all.sort((a, b) => b.startTime - a.startTime)
    } catch (e) {
      console.warn('[Recording] list 失败:', e)
      return []
    }
  }

  async deleteRecording(id: string): Promise<void> {
    try {
      const db = await this.ensureDb()
      const tx = db.transaction([STORE_META, STORE_BLOBS], 'readwrite')
      tx.objectStore(STORE_META).delete(id)
      tx.objectStore(STORE_BLOBS).delete(id)
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => resolve()
      })
      if (this.playingId === id) await this.stopPlayback()
      this.emitChanged()
    } catch (e) {
      console.warn('[Recording] delete 失败:', e)
    }
  }

  async playRecording(id: string): Promise<void> {
    if (this.playingId === id) {
      await this.stopPlayback()
      return
    }
    await this.stopPlayback()
    try {
      const db = await this.ensureDb()
      const record = await idbRequest<{ id: string; blob: Blob } | undefined>(
        db.transaction(STORE_BLOBS, 'readonly').objectStore(STORE_BLOBS).get(id)
      )
      if (!record?.blob) return
      this.playingId = id
      this.playObjectUrl = URL.createObjectURL(record.blob)
      this.playAudio = new Audio(this.playObjectUrl)
      this.playAudio.onended = () => {
        this.playingId = null
        this.revokePlayUrl()
        this.playAudio = null
        this.emitChanged()
        this.emitPlaybackEnded()
      }
      this.playAudio.onerror = () => {
        this.playingId = null
        this.revokePlayUrl()
        this.playAudio = null
        this.emitChanged()
      }
      await this.playAudio.play()
      this.emitChanged()
    } catch (e) {
      console.warn('[Recording] play 失败:', e)
      await this.stopPlayback()
    }
  }

  async stopPlayback(): Promise<void> {
    if (this.playAudio) {
      try {
        this.playAudio.pause()
      } catch {
        /* ignore */
      }
      this.playAudio = null
    }
    this.playingId = null
    this.revokePlayUrl()
  }

  private revokePlayUrl() {
    if (this.playObjectUrl) {
      try {
        URL.revokeObjectURL(this.playObjectUrl)
      } catch {
        /* ignore */
      }
      this.playObjectUrl = null
    }
  }

  onRecordingChanged(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emitChanged() {
    for (const cb of this.listeners) {
      try {
        cb()
      } catch {
        /* ignore */
      }
    }
  }
}
