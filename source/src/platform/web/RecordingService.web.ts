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
  private unsubRaw: (() => void) | null = null
  private db: IDBDatabase | null = null
  private listeners = new Set<() => void>()

  // 回放
  private playingId: string | null = null
  private playAudio: HTMLAudioElement | null = null
  private playObjectUrl: string | null = null

  // 始终录制（VAD）
  private alwaysRecord = false
  private vad: VadSegmenter | null = null
  private unsubVad: (() => void) | null = null
  private labelProvider: (() => { callsign: string; serverName: string }) | null = null

  // VAD 预卷缓冲：保留最近一段原始 PCM，语音触发时补到段首，避免截掉开头
  private preRoll: Int16Array[] = []
  private preRollSamples = 0
  private static readonly PRE_ROLL_SAMPLES = Math.round(RECORD_SAMPLE_RATE * 0.5) // 500ms @ 8kHz

  private endedListeners = new Set<() => void>()

  constructor(private audioService?: IAudioService) {}

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
      if (this.audioService && typeof this.audioService.subscribeRawAudio === 'function') {
        this.unsubVad = this.audioService.subscribeRawAudio((int16) => {
          if (!this.vad) return
          this.pushPreRoll(int16)
          const action = this.vad.feed(int16)
          if (action === 'start') {
            const label = this.labelProvider
              ? this.labelProvider()
              : { callsign: '', serverName: '' }
            this.startRecording({
              callsign: label.callsign || '',
              serverName: label.serverName || '',
              source: 'auto'
            })
            // 预卷补进段首（已喂入当前触发分片前，先补齐历史）
            if (this.recorder && this.preRoll.length) {
              this.recorder.prependInt16(this.preRoll)
            }
            this.clearPreRoll()
          } else if (action === 'stop') {
            this.clearPreRoll()
            this.stopRecording()
          }
        })
      }
      this.emitChanged()
    } else {
      if (this.unsubVad) {
        try {
          this.unsubVad()
        } catch {
          /* ignore */
        }
        this.unsubVad = null
      }
      this.vad = null
      this.clearPreRoll()
      // 结束当前 VAD 触发的一段
      if (this.recorder && this.recorderMeta?.source === 'auto') {
        await this.stopRecording()
      }
      this.emitChanged()
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
    const hadActive = this.recorder !== null
    if (hadActive && this.recorderMeta?.source === 'auto') {
      await this.stopRecording()
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
    if (this.audioService && typeof this.audioService.subscribeRawAudio === 'function') {
      this.unsubRaw = this.audioService.subscribeRawAudio((int16) => {
        if (this.recorder) this.recorder.feed(int16)
      })
    }
    this.emitChanged()
    return true
  }

  async stopRecording(): Promise<RecordingItem | null> {
    const rec = this.recorder
    const opts = this.recorderMeta
    if (!rec) return null
    this.recorder = null
    this.recorderMeta = null
    if (this.unsubRaw) {
      try {
        this.unsubRaw()
      } catch {
        /* ignore */
      }
      this.unsubRaw = null
    }
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
